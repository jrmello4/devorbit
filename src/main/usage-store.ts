/**
 * Store append-only de eventos de uso por modelo (usage por modelo).
 *
 * Persistência em userData/usage/:
 * - usage-events.jsonl: append-only, podado para as últimas N linhas no load.
 * - scan-state.json: estado incremental dos adaptadores (offsets por arquivo).
 *
 * Padrões herdados do EvolutionStore/AuditLedger: gravação atômica via
 * atomic-file, fila de escrita serializada (padrão enqueue do config.ts) e
 * fallback de caminho no homedir quando o userData ainda não existe.
 * Eventos inválidos são descartados silenciosamente (com contador) — registro
 * de uso nunca pode derrubar o caminho que o gerou.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import electron from 'electron'
const { app } = electron
import { writeFileAtomically } from './atomic-file'
import type {
  UsageAdapterStatus,
  UsageEvent,
  UsageModelShare,
  UsageQuotaEvent,
  UsageQuotaSnapshotView,
  UsageScanResult,
  UsageScanState,
  UsageSessionEvent,
  UsageShareState,
  UsageShareWindow,
  UsageShareWindowId,
  UsageTokenEvent,
  UsageTurnEvent,
} from '../shared/usage-contract'

const EVENTS_FILE_NAME = 'usage-events.jsonl'
const SCAN_STATE_FILE_NAME = 'scan-state.json'

/** Scanner dos adaptadores locais. Roda FORA da fila do store: não pode
 * chamar métodos do store (reentrância na fila serial travaria o refresh). */
export type UsageScanner = (
  previous: UsageScanState,
) => Promise<UsageScanResult & { quota?: UsageQuotaEvent[] }>

/** Teto de linhas no JSONL; o excedente mais antigo é podado no load. */
export const USAGE_STORE_MAX_EVENTS = 50_000
/** Teto do anel de dedupe em memória para eventos de tokens. */
export const USAGE_STORE_MAX_DEDUPE_KEYS = 20_000

const MAX_TOKEN_VALUE = 1e12
const MAX_DURATION_MS = 1e12
const MAX_WINDOWS_PER_QUOTA_EVENT = 64
const MAX_ADAPTER_STATUSES = 32

const TOKEN_SOURCES = new Set<string>(['claude-transcripts', 'codex-rollouts', 'opencode-storage', 'gemini-local', 'llm-router'])
const ADAPTER_STATUSES = new Set<string>(['ok', 'empty', 'error', 'missing'])
const TURN_OUTCOMES = new Set<string>(['completed', 'blocked', 'failed'])

export interface UsageStoreOptions {
  /** Diretório base (default: userData/usage); ignorado se os caminhos vieram explícitos. */
  readonly directory?: string
  readonly eventsFilePath?: string
  readonly scanStateFilePath?: string
  readonly maxEvents?: number
  readonly maxDedupeKeys?: number
  /** Relógio injetável para janelas (day/week) e generatedAt — testes. */
  readonly now?: () => number
}

export interface UsageStoreStats {
  events: number
  droppedInvalid: number
  duplicates: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, minLength: number, maxLength: number): value is string {
  return typeof value === 'string' && value.length >= minLength && value.length <= maxLength
}

function isIsoTimestamp(value: unknown): value is string {
  return boundedString(value, 4, 40) && Number.isFinite(Date.parse(value))
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_TOKEN_VALUE
}

function isDurationMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_DURATION_MS
}

function isPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
}

function validateTurnEvent(value: Record<string, unknown>): UsageTurnEvent | undefined {
  if (value.kind !== 'turn') return undefined
  if (!isIsoTimestamp(value.at) || !boundedString(value.terminalId, 1, 64)) return undefined
  if (!boundedString(value.provider, 1, 120) || !boundedString(value.model, 1, 120)) return undefined
  if (value.tier !== undefined && !boundedString(value.tier, 1, 120)) return undefined
  if (typeof value.outcome !== 'string' || !TURN_OUTCOMES.has(value.outcome)) return undefined
  if (value.durationMs !== undefined && !isDurationMs(value.durationMs)) return undefined
  return {
    kind: 'turn',
    at: value.at,
    terminalId: value.terminalId,
    provider: value.provider,
    model: value.model,
    ...(value.tier !== undefined ? { tier: value.tier } : {}),
    outcome: value.outcome as UsageTurnEvent['outcome'],
    ...(value.durationMs !== undefined ? { durationMs: value.durationMs } : {}),
  }
}

function validateSessionEvent(value: Record<string, unknown>): UsageSessionEvent | undefined {
  if (value.kind !== 'session') return undefined
  if (!isIsoTimestamp(value.at) || !boundedString(value.terminalId, 1, 64)) return undefined
  if (!boundedString(value.provider, 1, 120)) return undefined
  if (value.presetId !== undefined && !boundedString(value.presetId, 1, 120)) return undefined
  if (!isDurationMs(value.durationMs)) return undefined
  return {
    kind: 'session',
    at: value.at,
    terminalId: value.terminalId,
    provider: value.provider,
    ...(value.presetId !== undefined ? { presetId: value.presetId } : {}),
    durationMs: value.durationMs,
  }
}

function validateTokenEvent(value: Record<string, unknown>): UsageTokenEvent | undefined {
  if (value.kind !== 'tokens') return undefined
  if (!isIsoTimestamp(value.at)) return undefined
  if (typeof value.source !== 'string' || !TOKEN_SOURCES.has(value.source)) return undefined
  if (!boundedString(value.provider, 1, 120) || !boundedString(value.model, 1, 120)) return undefined
  if (!isTokenCount(value.inputTokens) || !isTokenCount(value.outputTokens)) return undefined
  if (value.cacheReadTokens !== undefined && !isTokenCount(value.cacheReadTokens)) return undefined
  if (value.cacheWriteTokens !== undefined && !isTokenCount(value.cacheWriteTokens)) return undefined
  if (!boundedString(value.dedupeKey, 1, 256)) return undefined
  return {
    kind: 'tokens',
    at: value.at,
    source: value.source as UsageTokenEvent['source'],
    provider: value.provider,
    model: value.model,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    ...(value.cacheReadTokens !== undefined ? { cacheReadTokens: value.cacheReadTokens } : {}),
    ...(value.cacheWriteTokens !== undefined ? { cacheWriteTokens: value.cacheWriteTokens } : {}),
    dedupeKey: value.dedupeKey,
  }
}

function validateQuotaEvent(value: Record<string, unknown>): UsageQuotaEvent | undefined {
  if (value.kind !== 'quota') return undefined
  if (!isIsoTimestamp(value.at) || !boundedString(value.provider, 1, 120)) return undefined
  if (value.accountId !== undefined && !boundedString(value.accountId, 1, 120)) return undefined
  if (!Array.isArray(value.windows) || value.windows.length > MAX_WINDOWS_PER_QUOTA_EVENT) return undefined
  const windows = []
  for (const raw of value.windows) {
    if (!isRecord(raw)) return undefined
    if (!boundedString(raw.id, 1, 120) || !boundedString(raw.label, 1, 200)) return undefined
    if (raw.percent !== undefined && !isPercent(raw.percent)) return undefined
    if (raw.resetAt !== undefined && !isIsoTimestamp(raw.resetAt)) return undefined
    windows.push({
      id: raw.id,
      label: raw.label,
      ...(raw.percent !== undefined ? { percent: raw.percent } : {}),
      ...(raw.resetAt !== undefined ? { resetAt: raw.resetAt } : {}),
    })
  }
  return {
    kind: 'quota',
    at: value.at,
    provider: value.provider,
    ...(value.accountId !== undefined ? { accountId: value.accountId } : {}),
    windows,
  }
}

/** Validação de fronteira: devolve um evento normalizado ou undefined para descartar. */
export function validateUsageEvent(value: unknown): UsageEvent | undefined {
  if (!isRecord(value)) return undefined
  return validateTurnEvent(value) ?? validateSessionEvent(value) ?? validateTokenEvent(value) ?? validateQuotaEvent(value)
}

function isValidScanState(value: unknown): value is UsageScanState {
  if (!isRecord(value) || !isRecord(value.offsets)) return false
  return Object.values(value.offsets).every((offset) => typeof offset === 'number' && Number.isFinite(offset) && offset >= 0)
}

/** Carimbos mtime são best-effort: entrada inválida é descartada, não o estado. */
function sanitizeScanMtimes(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined
  const output: Record<string, number> = {}
  for (const [key, mtime] of Object.entries(value)) {
    if (typeof mtime === 'number' && Number.isFinite(mtime) && mtime >= 0) output[key] = mtime
  }
  return Object.keys(output).length > 0 ? output : undefined
}

function isValidAdapterStatus(value: unknown): value is UsageAdapterStatus {
  return isRecord(value)
    && typeof value.source === 'string' && TOKEN_SOURCES.has(value.source)
    && typeof value.status === 'string' && ADAPTER_STATUSES.has(value.status)
    && (value.lastScanAt === undefined || isIsoTimestamp(value.lastScanAt))
    && (value.message === undefined || boundedString(value.message, 1, 500))
}

function defaultDirectory(): string {
  try {
    return path.join(app.getPath('userData'), 'usage')
  } catch {
    return path.join(os.homedir(), '.devorbit-usage')
  }
}

const EMPTY_SCAN_STATE: UsageScanState = { offsets: {} }

export class UsageStore {
  readonly eventsFilePath: string
  readonly scanStateFilePath: string

  private readonly maxEvents: number
  private readonly maxDedupeKeys: number
  private readonly now: () => number
  private readonly events: UsageEvent[] = []
  private readonly dedupeKeys = new Set<string>()
  private scanState: UsageScanState = EMPTY_SCAN_STATE
  private lastStatuses: UsageAdapterStatus[] = []
  private scanner: UsageScanner | null = null
  private droppedInvalid = 0
  private duplicates = 0
  private pending: Promise<void> = Promise.resolve()
  private loading?: Promise<void>
  private loaded = false
  private closed = false

  constructor(options: UsageStoreOptions = {}) {
    const directory = options.directory !== undefined ? path.resolve(options.directory) : defaultDirectory()
    this.eventsFilePath = path.resolve(options.eventsFilePath ?? path.join(directory, EVENTS_FILE_NAME))
    this.scanStateFilePath = path.resolve(options.scanStateFilePath ?? path.join(directory, SCAN_STATE_FILE_NAME))
    this.maxEvents = options.maxEvents ?? USAGE_STORE_MAX_EVENTS
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 1) throw new RangeError('Usage store maxEvents deve ser um inteiro positivo.')
    this.maxDedupeKeys = options.maxDedupeKeys ?? USAGE_STORE_MAX_DEDUPE_KEYS
    if (!Number.isInteger(this.maxDedupeKeys) || this.maxDedupeKeys < 1) throw new RangeError('Usage store maxDedupeKeys deve ser um inteiro positivo.')
    this.now = options.now ?? Date.now
  }

  /**
   * Registra um lote de eventos. Eventos inválidos e duplicados (tokens por
   * dedupeKey) são descartados silenciosamente; erro de I/O propaga para o
   * chamador, que deve tratar com best-effort.
   */
  recordUsageEvents(events: UsageEvent[]): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded()
      await this.appendBatchLocked(Array.isArray(events) ? events : [])
    })
  }

  /** Agrega os eventos em memória nas janelas day/week/all + quota + adapters. */
  async getUsageShare(adapters?: UsageAdapterStatus[]): Promise<UsageShareState> {
    await this.pending
    await this.ensureLoaded()
    return this.buildShareState(adapters)
  }

  /**
   * Ponto de injeção do scanner dos adaptadores locais (Camada B). Recebe o
   * estado incremental anterior e devolve o resultado do scan (eventos de
   * tokens podem vir acompanhados de `quota` extra, gravada antes do share).
   *
   * O scanner roda FORA da fila serial do store: NUNCA chame métodos deste
   * store dentro dele (reentrância na fila serializa e trava o refresh).
   * `null` desregistra; sem scanner, refreshNow devolve só o estado atual.
   */
  setUsageScanner(scanner: UsageScanner | null): void {
    this.scanner = scanner
  }

  /** Roda o scanner registrado (se houver), grava eventos/estado e devolve o share fresco. */
  refreshNow(): Promise<UsageShareState> {
    const scanner = this.scanner
    if (!scanner) return this.getUsageShare()
    const run = async (): Promise<UsageShareState> => {
      await this.pending
      await this.ensureLoaded()
      const previous: UsageScanState = {
        offsets: { ...this.scanState.offsets },
        ...(this.scanState.mtimes ? { mtimes: { ...this.scanState.mtimes } } : {}),
      }
      // Fora da fila de propósito: o scan pode demorar e o scanner não pode
      // reentrar na fila (ver JSDoc de setUsageScanner).
      const result = await scanner(previous)
      if (this.closed) throw new Error('Usage store is closed.')
      const events: UsageEvent[] = [
        ...(Array.isArray(result?.events) ? result.events : []),
        ...(Array.isArray(result?.quota) ? result.quota : []),
      ]
      return this.enqueue(async () => {
        if (this.closed) throw new Error('Usage store is closed.')
        await this.appendBatchLocked(events)
        if (isValidScanState(result?.state)) {
          const nextMtimes = {
            ...this.scanState.mtimes,
            ...sanitizeScanMtimes(result.state.mtimes),
          }
          this.scanState = {
            offsets: { ...this.scanState.offsets, ...result.state.offsets },
            ...(Object.keys(nextMtimes).length > 0 ? { mtimes: nextMtimes } : {}),
          }
          await this.persistScanStateLocked()
        }
        const statuses = Array.isArray(result?.statuses) ? result.statuses.filter(isValidAdapterStatus).slice(0, MAX_ADAPTER_STATUSES) : []
        if (statuses.length > 0) this.lastStatuses = statuses
        return this.buildShareState()
      })
    }
    return run()
  }

  /** Estado incremental persistido (para o scanner retomar de onde parou). */
  async loadScanState(): Promise<UsageScanState> {
    await this.enqueue(async () => {
      await this.ensureLoaded()
    })
    return {
      offsets: { ...this.scanState.offsets },
      ...(this.scanState.mtimes ? { mtimes: { ...this.scanState.mtimes } } : {}),
    }
  }

  async saveScanState(state: UsageScanState): Promise<void> {
    await this.enqueue(async () => {
      if (!isValidScanState(state)) throw new TypeError('Estado de scan inválido.')
      const mtimes = sanitizeScanMtimes(state.mtimes)
      this.scanState = {
        offsets: { ...state.offsets },
        ...(mtimes ? { mtimes: { ...mtimes } } : {}),
      }
      await this.persistScanStateLocked()
    })
  }

  stats(): UsageStoreStats {
    return { events: this.events.length, droppedInvalid: this.droppedInvalid, duplicates: this.duplicates }
  }

  flush(): Promise<void> {
    return this.pending
  }

  async close(): Promise<void> {
    await this.pending
    this.closed = true
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Usage store is closed.'))
    const current = this.pending.then(async () => {
      if (this.closed) throw new Error('Usage store is closed.')
      return operation()
    })
    this.pending = current.then(() => undefined, () => undefined)
    return current
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (!this.loading) {
      this.loading = this.loadLocked()
    }
    try {
      await this.loading
    } finally {
      this.loading = undefined
    }
  }

  private async loadLocked(): Promise<void> {
    await fs.mkdir(path.dirname(this.eventsFilePath), { recursive: true })
    await fs.mkdir(path.dirname(this.scanStateFilePath), { recursive: true })

    let content: string | undefined
    try {
      content = await fs.readFile(this.eventsFilePath, 'utf8')
    } catch {
      content = undefined
    }
    if (content !== undefined) {
      const loaded: UsageEvent[] = []
      for (const line of content.split('\n')) {
        if (line.trim().length === 0) continue
        try {
          const event = validateUsageEvent(JSON.parse(line) as unknown)
          if (event) loaded.push(event)
        } catch {
          // Linha corrompida (escrita interrompida): descarta só essa linha.
        }
      }
      // Poda as linhas mais antigas além do teto e regrava atomicamente.
      const retained = loaded.length > this.maxEvents ? loaded.slice(loaded.length - this.maxEvents) : loaded
      this.events.splice(0, this.events.length, ...retained)
      if (retained.length !== loaded.length) {
        await writeFileAtomically(this.eventsFilePath, `${retained.map((event) => JSON.stringify(event)).join('\n')}\n`)
      }
      // Dedupe entre reinícios é best-effort: chaves dos eventos ainda retidos.
      for (const event of retained) {
        if (event.kind === 'tokens') this.rememberDedupeKeyLocked(event.dedupeKey)
      }
    }

    let stateContent: string | undefined
    try {
      stateContent = await fs.readFile(this.scanStateFilePath, 'utf8')
    } catch {
      stateContent = undefined
    }
    if (stateContent !== undefined) {
      try {
        const parsed: unknown = JSON.parse(stateContent)
        if (isValidScanState(parsed)) {
          const mtimes = sanitizeScanMtimes(parsed.mtimes)
          this.scanState = {
            offsets: { ...parsed.offsets },
            ...(mtimes ? { mtimes } : {}),
          }
        }
      } catch {
        // Estado de scan corrompido: recomeça do zero (adaptadores relem tudo).
      }
    }

    this.loaded = true
  }

  /** Anexa os eventos válidos na memória e persiste o lote em uma linha por evento. */
  private async appendBatchLocked(events: readonly UsageEvent[]): Promise<void> {
    const previousLength = this.events.length
    const appended = this.appendEventsLocked(events)
    if (appended.length === 0) return
    try {
      const lines = appended.map((event) => JSON.stringify(event))
      await fs.appendFile(this.eventsFilePath, `${lines.join('\n')}\n`, 'utf8')
    } catch (error) {
      // Falha de I/O: reverte a memória para manter evento e arquivo coerentes.
      if (this.events.length > previousLength) this.events.splice(previousLength, this.events.length - previousLength)
      for (const event of appended) {
        if (event.kind === 'tokens') this.dedupeKeys.delete(event.dedupeKey)
      }
      throw error
    }
  }

  /** Anexa os eventos válidos; devolve exatamente os que entraram na memória. */
  private appendEventsLocked(events: readonly UsageEvent[]): UsageEvent[] {
    const appended: UsageEvent[] = []
    for (const raw of events) {
      const event = validateUsageEvent(raw)
      if (!event) {
        this.droppedInvalid += 1
        continue
      }
      if (event.kind === 'tokens') {
        if (this.dedupeKeys.has(event.dedupeKey)) {
          this.duplicates += 1
          continue
        }
        this.rememberDedupeKeyLocked(event.dedupeKey)
      }
      this.events.push(event)
      appended.push(event)
    }
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents)
    }
    return appended
  }

  private rememberDedupeKeyLocked(key: string): void {
    this.dedupeKeys.add(key)
    while (this.dedupeKeys.size > this.maxDedupeKeys) {
      const oldest = this.dedupeKeys.values().next()
      if (oldest.done === true) break
      this.dedupeKeys.delete(oldest.value)
    }
  }

  private async persistScanStateLocked(): Promise<void> {
    await writeFileAtomically(this.scanStateFilePath, `${JSON.stringify(this.scanState)}\n`)
  }

  private buildShareState(adapters?: UsageAdapterStatus[]): UsageShareState {
    const nowMs = this.now()
    const nowDate = new Date(nowMs)
    const windowsSince: Record<UsageShareWindowId, number> = {
      day: new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime(),
      week: nowMs - 7 * 24 * 60 * 60 * 1000,
      all: 0,
    }

    const windowIds = Object.keys(windowsSince) as UsageShareWindowId[]
    const aggregates = new Map<UsageShareWindowId, Map<string, Map<string, UsageModelShare>>>()
    const totalTurns: Record<UsageShareWindowId, number> = { day: 0, week: 0, all: 0 }
    const latestQuota = new Map<string, UsageQuotaEvent>()

    for (const event of this.events) {
      const atMs = Date.parse(event.at)
      if (event.kind === 'quota') {
        const key = `${event.provider}|${event.accountId ?? ''}`
        const current = latestQuota.get(key)
        if (!current || atMs >= Date.parse(current.at)) latestQuota.set(key, event)
        continue
      }
      for (const id of windowIds) {
        if (atMs < windowsSince[id]) continue
        // Sessão não tem modelo no contrato (UsageSessionEvent): entra em uma
        // linha própria do provider com model vazio, carregando sessions/activeMs.
        const modelKey = event.kind === 'session' ? '' : event.model
        let byProvider = aggregates.get(id)
        if (!byProvider) {
          byProvider = new Map<string, Map<string, UsageModelShare>>()
          aggregates.set(id, byProvider)
        }
        let byModel = byProvider.get(event.provider)
        if (!byModel) {
          byModel = new Map<string, UsageModelShare>()
          byProvider.set(event.provider, byModel)
        }
        let entry = byModel.get(modelKey)
        if (!entry) {
          entry = {
            provider: event.provider,
            model: modelKey,
            inputTokens: 0,
            outputTokens: 0,
            cacheTokens: 0,
            totalTokens: 0,
            turns: 0,
            sessions: 0,
            activeMs: 0,
          }
          byModel.set(modelKey, entry)
        }
        if (event.kind === 'turn') {
          entry.turns += 1
          totalTurns[id] += 1
          entry.activeMs += event.durationMs ?? 0
        } else if (event.kind === 'session') {
          entry.sessions += 1
          entry.activeMs += event.durationMs
        } else {
          const cache = (event.cacheReadTokens ?? 0) + (event.cacheWriteTokens ?? 0)
          entry.inputTokens += event.inputTokens
          entry.outputTokens += event.outputTokens
          entry.cacheTokens += cache
          entry.totalTokens += event.inputTokens + event.outputTokens + cache
        }
      }
    }

    const windows = {} as Record<UsageShareWindowId, UsageShareWindow>
    for (const id of windowIds) {
      const byProvider = aggregates.get(id) ?? new Map<string, Map<string, UsageModelShare>>()
      const models = [...byProvider.values()].flatMap((byModel) => [...byModel.values()])
      models.sort((a, b) => b.totalTokens - a.totalTokens || b.turns - a.turns || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
      windows[id] = {
        window: id,
        since: new Date(windowsSince[id]).toISOString(),
        totalTokens: models.reduce((total, model) => total + model.totalTokens, 0),
        totalTurns: totalTurns[id],
        models,
      }
    }

    const quota: UsageQuotaSnapshotView[] = [...latestQuota.values()]
      .map((event) => ({
        provider: event.provider,
        ...(event.accountId !== undefined ? { accountId: event.accountId } : {}),
        at: event.at,
        windows: event.windows.map((window) => ({ ...window })),
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider) || (a.accountId ?? '').localeCompare(b.accountId ?? ''))

    return {
      windows,
      quota,
      adapters: (adapters ?? this.lastStatuses).map((status) => ({ ...status })),
      generatedAt: new Date(nowMs).toISOString(),
    }
  }
}

export function createUsageStore(options?: UsageStoreOptions): UsageStore {
  return new UsageStore(options)
}
