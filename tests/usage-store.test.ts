import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({
  default: {
    app: {
      getPath: () => {
        throw new Error('electron indisponível nos testes')
      },
    },
  },
}))

import { createUsageStore, type UsageStore } from '../src/main/usage-store'
import type {
  UsageAdapterStatus,
  UsageEvent,
  UsageQuotaEvent,
  UsageScanResult,
  UsageScanState,
  UsageSessionEvent,
  UsageTokenEvent,
  UsageTurnEvent,
} from '../src/shared/usage-contract'

const temporaryDirectories: string[] = []

beforeEach(async () => {
  temporaryDirectories.push(await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-usage-store-')))
})

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

// Meio-dia UTC fixo: "hoje" cai na janela day em qualquer fuso, 3 dias atrás
// só na week e 30 dias atrás só na all.
const FIXED_NOW = Date.parse('2026-09-21T12:00:00.000Z')
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

function turnEvent(overrides: Partial<UsageTurnEvent> = {}): UsageTurnEvent {
  return {
    kind: 'turn',
    at: new Date(FIXED_NOW).toISOString(),
    terminalId: 'terminal-1',
    provider: 'opencode',
    model: 'model-x',
    outcome: 'completed',
    ...overrides,
  }
}

function sessionEvent(overrides: Partial<UsageSessionEvent> = {}): UsageSessionEvent {
  return {
    kind: 'session',
    at: new Date(FIXED_NOW).toISOString(),
    terminalId: 'terminal-1',
    provider: 'codex',
    durationMs: 1000,
    ...overrides,
  }
}

function tokenEvent(overrides: Partial<UsageTokenEvent> = {}): UsageTokenEvent {
  return {
    kind: 'tokens',
    at: new Date(FIXED_NOW).toISOString(),
    source: 'llm-router',
    provider: 'glm',
    model: 'glm-4-flash',
    inputTokens: 100,
    outputTokens: 50,
    dedupeKey: 'dedupe-1',
    ...overrides,
  }
}

function quotaEvent(overrides: Partial<UsageQuotaEvent> = {}): UsageQuotaEvent {
  return {
    kind: 'quota',
    at: new Date(FIXED_NOW).toISOString(),
    provider: 'codex',
    accountId: 'account1',
    windows: [{ id: 'primary', label: 'Janela de 5h', percent: 42 }],
    ...overrides,
  }
}

function createTempStore(options: { maxEvents?: number } = {}): UsageStore {
  const [directory] = temporaryDirectories.slice(-1)
  return createUsageStore({
    directory,
    now: () => FIXED_NOW,
    ...(options.maxEvents !== undefined ? { maxEvents: options.maxEvents } : {}),
  })
}

function findModel(state: Awaited<ReturnType<UsageStore['getUsageShare']>>, window: 'day' | 'week' | 'all', provider: string, model: string) {
  return state.windows[window].models.find((entry) => entry.provider === provider && entry.model === model)
}

describe('usage store', () => {
  it('aggregates turn, token and session events into day/week/all windows', async () => {
    const store = createTempStore()
    await store.recordUsageEvents([
      turnEvent({ provider: 'opencode', model: 'model-x', durationMs: 1200 }),
      tokenEvent({ provider: 'opencode', model: 'model-x', inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, dedupeKey: 'k1' }),
      // Sessão não tem modelo no contrato: cai na linha do provider com model ''.
      sessionEvent({ provider: 'opencode', durationMs: 4000 }),
      turnEvent({ at: new Date(FIXED_NOW - 3 * DAY_MS).toISOString(), provider: 'codex', model: 'model-y' }),
      tokenEvent({ at: new Date(FIXED_NOW - 30 * DAY_MS).toISOString(), provider: 'glm', model: 'glm-old', dedupeKey: 'k2' }),
    ])

    const state = await store.getUsageShare()

    // Janela day: só os eventos de hoje.
    const today = findModel(state, 'day', 'opencode', 'model-x')
    expect(today).toMatchObject({ turns: 1, sessions: 0, activeMs: 1200, inputTokens: 100, outputTokens: 50, cacheTokens: 15, totalTokens: 165 })
    const sessionRow = findModel(state, 'day', 'opencode', '')
    expect(sessionRow).toMatchObject({ turns: 0, sessions: 1, activeMs: 4000, totalTokens: 0 })
    expect(state.windows.day.totalTokens).toBe(165)
    expect(state.windows.day.totalTurns).toBe(1)
    expect(state.windows.day.models).toHaveLength(2)

    // Janela week: hoje + 3 dias atrás.
    expect(state.windows.week.totalTurns).toBe(2)
    expect(findModel(state, 'week', 'codex', 'model-y')?.turns).toBe(1)
    expect(findModel(state, 'week', 'glm', 'glm-old')).toBeUndefined()

    // Janela all: tudo, com modelos ordenados por totalTokens desc.
    expect(state.windows.all.models.map((entry) => entry.model)).toEqual(['model-x', 'glm-old', 'model-y', ''])
    expect(state.windows.all.totalTurns).toBe(2)
    expect(state.generatedAt).toBe(new Date(FIXED_NOW).toISOString())
    expect(state.windows.day.window).toBe('day')

    await store.close()
  })

  it('keeps the latest quota snapshot per provider+account', async () => {
    const store = createTempStore()
    await store.recordUsageEvents([
      quotaEvent({ at: new Date(FIXED_NOW - 2 * HOUR_MS).toISOString(), windows: [{ id: 'primary', label: 'Janela de 5h', percent: 10 }] }),
      quotaEvent({ at: new Date(FIXED_NOW - 1 * HOUR_MS).toISOString(), accountId: 'account2', windows: [{ id: 'primary', label: 'Janela de 5h', percent: 77 }] }),
      quotaEvent({ at: new Date(FIXED_NOW).toISOString(), windows: [{ id: 'primary', label: 'Janela de 5h', percent: 88 }, { id: 'secondary', label: 'Janela semanal', percent: 12.5, resetAt: new Date(FIXED_NOW + DAY_MS).toISOString() }] }),
    ])

    const state = await store.getUsageShare()
    expect(state.quota).toHaveLength(2)
    const account1 = state.quota.find((entry) => entry.accountId === 'account1')
    expect(account1?.provider).toBe('codex')
    expect(account1?.windows).toEqual([
      { id: 'primary', label: 'Janela de 5h', percent: 88 },
      { id: 'secondary', label: 'Janela semanal', percent: 12.5, resetAt: new Date(FIXED_NOW + DAY_MS).toISOString() },
    ])
    const account2 = state.quota.find((entry) => entry.accountId === 'account2')
    expect(account2?.windows[0].percent).toBe(77)

    await store.close()
  })

  it('drops invalid events without throwing and counts them', async () => {
    const store = createTempStore()
    const invalidEvents: unknown[] = [
      null,
      { kind: 'unknown' },
      { kind: 'turn', at: 'não é data', terminalId: 't', provider: 'p', model: 'm', outcome: 'completed' },
      { kind: 'turn', at: new Date(FIXED_NOW).toISOString(), terminalId: '', provider: 'p', model: 'm', outcome: 'completed' },
      { kind: 'turn', at: new Date(FIXED_NOW).toISOString(), terminalId: 't', provider: 'p', model: 'm', outcome: 'explodiu' },
      { kind: 'tokens', at: new Date(FIXED_NOW).toISOString(), source: 'queixo', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1, dedupeKey: 'k' },
      { kind: 'tokens', at: new Date(FIXED_NOW).toISOString(), source: 'llm-router', provider: 'p', model: 'm', inputTokens: -1, outputTokens: 1, dedupeKey: 'k' },
      { kind: 'tokens', at: new Date(FIXED_NOW).toISOString(), source: 'llm-router', provider: 'p', model: 'm', inputTokens: 1e12 + 1, outputTokens: 0, dedupeKey: 'k' },
      { kind: 'tokens', at: new Date(FIXED_NOW).toISOString(), source: 'llm-router', provider: '', model: 'm', inputTokens: 1, outputTokens: 0, dedupeKey: 'k' },
      { kind: 'tokens', at: new Date(FIXED_NOW).toISOString(), source: 'llm-router', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 0, dedupeKey: 'x'.repeat(257) },
      { kind: 'session', at: new Date(FIXED_NOW).toISOString(), terminalId: 't', provider: 'p', durationMs: -5 },
      { kind: 'quota', at: new Date(FIXED_NOW).toISOString(), provider: 'codex', windows: [{ id: 'primary' }] },
      { kind: 'quota', at: new Date(FIXED_NOW).toISOString(), provider: 'codex', windows: 'não é lista' },
    ]

    await store.recordUsageEvents(invalidEvents as UsageEvent[])
    await store.recordUsageEvents([turnEvent({ model: 'model-válido' })])

    expect(store.stats().droppedInvalid).toBe(invalidEvents.length)
    const state = await store.getUsageShare()
    expect(state.windows.all.totalTurns).toBe(1)
    expect(state.windows.all.models.map((entry) => entry.model)).toEqual(['model-válido'])

    await store.close()
  })

  it('deduplicates token events by dedupeKey in-session and across restarts', async () => {
    const store = createTempStore()
    await store.recordUsageEvents([tokenEvent({ inputTokens: 10, outputTokens: 0, dedupeKey: 'mesmo-key' })])
    await store.recordUsageEvents([tokenEvent({ inputTokens: 999, outputTokens: 0, dedupeKey: 'mesmo-key' })])
    await store.recordUsageEvents([tokenEvent({ inputTokens: 10, outputTokens: 0, dedupeKey: 'mesmo-key' })])

    expect(store.stats().duplicates).toBe(2)
    const state = await store.getUsageShare()
    expect(findModel(state, 'all', 'glm', 'glm-4-flash')?.inputTokens).toBe(10)
    await store.close()

    // Reabertura: a chave sobrevive enquanto o evento estiver retido no arquivo.
    const reopened = createTempStore()
    await reopened.recordUsageEvents([tokenEvent({ inputTokens: 777, outputTokens: 0, dedupeKey: 'mesmo-key' })])
    expect(reopened.stats().duplicates).toBe(1)
    const reopenedState = await reopened.getUsageShare()
    expect(findModel(reopenedState, 'all', 'glm', 'glm-4-flash')?.inputTokens).toBe(10)
    await reopened.close()
  })

  it('trims the JSONL to the event cap on load and keeps the newest events', async () => {
    const store = createTempStore({ maxEvents: 5 })
    const events: UsageEvent[] = []
    for (let index = 0; index < 8; index += 1) {
      events.push(turnEvent({ at: new Date(FIXED_NOW - (8 - index) * HOUR_MS).toISOString(), model: `model-${index}` }))
    }
    await store.recordUsageEvents(events)
    await store.close()

    const reopened = createTempStore({ maxEvents: 5 })
    const state = await reopened.getUsageShare()
    expect(state.windows.all.totalTurns).toBe(5)
    expect(state.windows.all.models.map((entry) => entry.model)).toEqual(['model-3', 'model-4', 'model-5', 'model-6', 'model-7'])

    const raw = await fs.readFile(reopened.eventsFilePath, 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(5)
    expect(JSON.parse(raw.trim().split('\n')[0])).toMatchObject({ model: 'model-3' })
    await reopened.close()
  })

  it('persists and reloads the scanner state', async () => {
    const store = createTempStore()
    await store.saveScanState({ offsets: { 'claude.jsonl': 120, 'rollouts/a.jsonl': 7 } })
    expect(await store.loadScanState()).toEqual({ offsets: { 'claude.jsonl': 120, 'rollouts/a.jsonl': 7 } })
    await store.close()

    const reopened = createTempStore()
    expect(await reopened.loadScanState()).toEqual({ offsets: { 'claude.jsonl': 120, 'rollouts/a.jsonl': 7 } })
    await expect(reopened.saveScanState({ offsets: { ruim: -1 } })).rejects.toThrow()
    await reopened.close()
  })

  it('refreshNow with a registered scanner records events, statuses and merged offsets', async () => {
    const store = createTempStore()
    await store.saveScanState({ offsets: { 'claude.jsonl': 100 } })
    const scanner = vi.fn(async (): Promise<UsageScanResult> => ({
      events: [tokenEvent({ source: 'claude-transcripts', provider: 'anthropic', model: 'claude-haiku', inputTokens: 20, outputTokens: 5, dedupeKey: 'scan-1' })],
      state: { offsets: { 'claude.jsonl': 250, 'rollouts/a.jsonl': 9 } },
      statuses: [
        { source: 'claude-transcripts', status: 'ok', lastScanAt: new Date(FIXED_NOW).toISOString() },
        // Entrada inválida do scanner é filtrada antes de virar status.
        { source: 'sem-role', status: 'ok' } as unknown as UsageAdapterStatus,
      ],
    }))
    store.setUsageScanner(scanner)

    const refreshed = await store.refreshNow()
    expect(scanner).toHaveBeenCalledOnce()
    expect(findModel(refreshed, 'all', 'anthropic', 'claude-haiku')?.totalTokens).toBe(25)
    expect(refreshed.adapters).toEqual([
      { source: 'claude-transcripts', status: 'ok', lastScanAt: new Date(FIXED_NOW).toISOString() },
    ])
    expect(await store.loadScanState()).toEqual({ offsets: { 'claude.jsonl': 250, 'rollouts/a.jsonl': 9 } })

    // Sem novo scan, getUsageShare mantém o último status conhecido.
    store.setUsageScanner(null)
    const current = await store.getUsageShare()
    expect(current.adapters).toHaveLength(1)
    expect(current.adapters[0].source).toBe('claude-transcripts')

    await store.close()

    // Estado e eventos sobrevivem ao reinício (offsets persistidos no disco).
    const reopened = createTempStore()
    expect(await reopened.loadScanState()).toEqual({ offsets: { 'claude.jsonl': 250, 'rollouts/a.jsonl': 9 } })
    const persistedState = await reopened.getUsageShare()
    expect(findModel(persistedState, 'all', 'anthropic', 'claude-haiku')?.totalTokens).toBe(25)
    await reopened.close()
  })

  it('refreshNow without a scanner returns the current state and merges nothing', async () => {
    const store = createTempStore()
    await store.recordUsageEvents([turnEvent()])
    const state = await store.refreshNow()
    expect(state.windows.all.totalTurns).toBe(1)
    expect(state.adapters).toEqual([])
    expect(state.generatedAt).toBe(new Date(FIXED_NOW).toISOString())
    await store.close()
  })

  it('scanner recebe o estado anterior e a quota extra entra no share do MESMO refresh', async () => {
    const store = createTempStore()
    await store.saveScanState({ offsets: { 'rollouts/a.jsonl': 42 } })
    let receivedPrevious: unknown
    const scanner = vi.fn(async (previous: UsageScanState) => {
      receivedPrevious = previous
      return {
        events: [] as UsageTokenEvent[],
        state: { offsets: { 'rollouts/a.jsonl': 77 } },
        statuses: [{ source: 'codex-rollouts', status: 'empty', lastScanAt: new Date(FIXED_NOW).toISOString() }] as UsageAdapterStatus[],
        quota: [{
          kind: 'quota' as const,
          at: new Date(FIXED_NOW).toISOString(),
          provider: 'claude',
          windows: [{ id: 'five_hour', label: '5 horas', percent: 12 }],
        }],
      }
    })
    store.setUsageScanner(scanner)

    const refreshed = await store.refreshNow()
    expect(receivedPrevious).toEqual({ offsets: { 'rollouts/a.jsonl': 42 } })
    expect(refreshed.quota).toEqual([{
      provider: 'claude',
      at: new Date(FIXED_NOW).toISOString(),
      windows: [{ id: 'five_hour', label: '5 horas', percent: 12 }],
    }])
    expect(await store.loadScanState()).toEqual({ offsets: { 'rollouts/a.jsonl': 77 } })
    await store.close()
  })

  it('scanner que reentra na fila do store NÃO trava o refresh (regressão do deadlock)', async () => {
    const store = createTempStore()
    const scanner = vi.fn(async (): Promise<UsageScanResult> => {
      // Uso incorreto deliberado: gravar dentro do scanner. Com o scanner
      // rodando fora da fila, isso enfileira e resolve — nunca deadlocka.
      await store.recordUsageEvents([turnEvent()])
      return { events: [], state: { offsets: {} }, statuses: [] }
    })
    store.setUsageScanner(scanner)

    const refreshed = await Promise.race([
      store.refreshNow(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('deadlock')), 2_000)),
    ])
    expect(refreshed.windows.all.totalTurns).toBe(1)
    await store.close()
  })

  it('reloads previously recorded events from disk', async () => {
    const store = createTempStore()
    await store.recordUsageEvents([tokenEvent({ dedupeKey: 'persist-1' }), sessionEvent({ provider: 'codex' })])
    await store.close()

    const reopened = createTempStore()
    const state = await reopened.getUsageShare()
    expect(findModel(state, 'day', 'glm', 'glm-4-flash')?.totalTokens).toBe(150)
    expect(findModel(state, 'day', 'codex', 'model-x')).toBeUndefined()
    expect(state.windows.day.totalTurns).toBe(0)
    await reopened.close()
  })
})
