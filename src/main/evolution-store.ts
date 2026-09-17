import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AsyncDisposable, Disposable } from '../shared/disposable'
import { recoverFileFromBackup, restoreFileFromBackup, writeFileAtomically } from './atomic-file'
import {
  copyEvolutionRecord,
  createEvolutionRecord,
  EVOLUTION_HISTORY_VERSION,
  isEvolutionRecordKind,
  redactEvolutionObject,
  type EvolutionInputObject,
  type EvolutionJsonObject,
  type EvolutionRecord,
  type EvolutionRecordInput,
  type EvolutionRecordKind,
  type EvolutionRecordOptions,
  type EvolutionReadOptions,
} from '../shared/evolution-history'

export * from '../shared/evolution-history'

export interface EvolutionStoreOptions {
  readonly [key: string]: unknown
  readonly directory?: string
  readonly dataDirectory?: string
  readonly filePath?: string
  readonly path?: string
  readonly fileName?: string
  readonly maxRecords?: number
  readonly maxEntries?: number
  readonly maxReadRecords?: number
  readonly maxReadEntries?: number
  readonly clock?: () => number
  readonly idFactory?: () => string
}

interface StoredEvolutionHistory {
  readonly version: typeof EVOLUTION_HISTORY_VERSION
  readonly records: readonly PersistedEvolutionRecord[]
}

interface PersistedEvolutionRecord {
  readonly version: typeof EVOLUTION_HISTORY_VERSION
  readonly id: string
  readonly kind: EvolutionRecordKind
  readonly recordedAt: string
  readonly data: EvolutionJsonObject
  readonly telemetry?: EvolutionJsonObject
  readonly metadata?: EvolutionJsonObject
}

const DEFAULT_FILE_NAME = 'evolution-history.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertPositiveLimit(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer.`)
}

function assertReadLimit(value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError('Evolution read limit must be a non-negative integer.')
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} is required.`)
}

function resolveFilePath(directory: string, fileName: string): string {
  assertNonEmptyString(fileName, 'Evolution history file name')
  if (path.isAbsolute(fileName)) throw new RangeError('Evolution history file name must be relative.')
  const root = path.resolve(directory)
  const candidate = path.resolve(root, fileName)
  const relative = path.relative(root, candidate)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new RangeError('Evolution history file must stay under its directory.')
  }
  return candidate
}

function inputData(input: EvolutionRecordInput): EvolutionInputObject {
  const reserved = new Set(['id', 'kind', 'type', 'recordedAt', 'timestamp', 'data', 'payload', 'telemetry', 'metadata'])
  const extra = Object.fromEntries(Object.entries(input).filter(([key]) => !reserved.has(key)))
  const data = input.data ?? {}
  const payload = input.payload ?? {}
  return { ...extra, ...payload, ...data }
}

function normalizeKinds(value: EvolutionReadOptions['kind'] | EvolutionReadOptions['type']): readonly EvolutionRecordKind[] | undefined {
  if (value === undefined) return undefined
  return typeof value === 'string' ? [value] : value
}

function persistedRecord(record: EvolutionRecord): PersistedEvolutionRecord {
  return {
    version: EVOLUTION_HISTORY_VERSION,
    id: record.id,
    kind: record.kind,
    recordedAt: record.recordedAt,
    data: record.data,
    ...(record.telemetry === undefined ? {} : { telemetry: record.telemetry }),
    ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
  }
}

function parseRecord(value: unknown): EvolutionRecord | undefined {
  if (!isRecord(value)) return undefined
  const kind = value.kind ?? value.type
  const recordedAt = value.recordedAt ?? value.timestamp
  const data = value.data ?? value.payload ?? {}
  if (value.version !== EVOLUTION_HISTORY_VERSION
    || typeof value.id !== 'string'
    || value.id.trim().length === 0
    || !isEvolutionRecordKind(kind)
    || typeof recordedAt !== 'string'
    || recordedAt.trim().length === 0
    || !isRecord(data)) {
    return undefined
  }

  const telemetry = value.telemetry
  const metadata = value.metadata
  if ((telemetry !== undefined && !isRecord(telemetry)) || (metadata !== undefined && !isRecord(metadata))) return undefined

  return createEvolutionRecord({
    version: EVOLUTION_HISTORY_VERSION,
    id: value.id,
    kind,
    recordedAt,
    data: redactEvolutionObject(data),
    ...(telemetry === undefined ? {} : { telemetry: redactEvolutionObject(telemetry) }),
    ...(metadata === undefined ? {} : { metadata: redactEvolutionObject(metadata) }),
  })
}

function parseHistory(value: unknown): EvolutionRecord[] {
  if (!isRecord(value) || value.version !== EVOLUTION_HISTORY_VERSION || !Array.isArray(value.records)) {
    throw new Error('Invalid evolution history file.')
  }
  return value.records.flatMap((item) => {
    const record = parseRecord(item)
    return record ? [record] : []
  })
}

export class EvolutionStore implements Disposable, AsyncDisposable {
  readonly directory: string
  readonly filePath: string

  private readonly maxRecords: number
  private readonly maxReadRecords: number
  private readonly clock: () => number
  private readonly idFactory: () => string
  private readonly records: EvolutionRecord[] = []
  private pending: Promise<void> = Promise.resolve()
  private loading?: Promise<void>
  private loaded = false
  private closed = false

  constructor(directory: string, options?: Omit<EvolutionStoreOptions, 'directory' | 'dataDirectory' | 'filePath' | 'path'>)
  constructor(options: EvolutionStoreOptions)
  constructor(directoryOrOptions: string | EvolutionStoreOptions, options: EvolutionStoreOptions = {}) {
    const configured: EvolutionStoreOptions = typeof directoryOrOptions === 'string'
      ? { ...options, directory: directoryOrOptions }
      : directoryOrOptions
    const explicitFilePath = configured.filePath ?? configured.path
    const configuredDirectory = configured.directory ?? configured.dataDirectory
    const hasExplicitFilePath = configured.filePath !== undefined || configured.path !== undefined

    if (!hasExplicitFilePath && configuredDirectory === undefined) {
      throw new TypeError('Evolution store directory is required.')
    }

    if (hasExplicitFilePath) {
      assertNonEmptyString(explicitFilePath, 'Evolution history file path')
      this.filePath = path.resolve(explicitFilePath)
    } else {
      assertNonEmptyString(configuredDirectory, 'Evolution store directory')
      this.filePath = resolveFilePath(path.resolve(configuredDirectory), configured.fileName ?? DEFAULT_FILE_NAME)
    }
    this.directory = path.dirname(this.filePath)

    this.maxRecords = configured.maxRecords ?? configured.maxEntries ?? 100
    assertPositiveLimit(this.maxRecords, 'Evolution store maxRecords')
    const requestedReadLimit = configured.maxReadRecords ?? configured.maxReadEntries ?? this.maxRecords
    assertPositiveLimit(requestedReadLimit, 'Evolution store maxReadRecords')
    this.maxReadRecords = Math.min(requestedReadLimit, this.maxRecords)
    this.clock = configured.clock ?? Date.now
    this.idFactory = configured.idFactory ?? randomUUID
  }

  get isClosed(): boolean {
    return this.closed
  }

  record(input: EvolutionRecordInput): Promise<EvolutionRecord> {
    try {
      this.validateInput(input)
    } catch (error) {
      return Promise.reject(error)
    }

    return this.enqueue(async () => {
      await this.ensureLoaded()
      const kind = input.kind ?? input.type
      const recordedAt = input.recordedAt ?? input.timestamp ?? new Date(this.clock()).toISOString()
      const record = createEvolutionRecord({
        version: EVOLUTION_HISTORY_VERSION,
        id: input.id ?? this.idFactory(),
        kind: kind as EvolutionRecordKind,
        recordedAt,
        data: redactEvolutionObject(inputData(input)),
        ...(input.telemetry === undefined ? {} : { telemetry: redactEvolutionObject(input.telemetry) }),
        ...(input.metadata === undefined ? {} : { metadata: redactEvolutionObject(input.metadata) }),
      })
      const previous = this.records.slice()
      this.records.push(record)
      this.trimRecords()
      try {
        await this.persist()
      } catch (error) {
        this.records.splice(0, this.records.length, ...previous)
        throw error
      }
      return copyEvolutionRecord(record)
    })
  }

  append(input: EvolutionRecordInput): Promise<EvolutionRecord> {
    return this.record(input)
  }

  add(input: EvolutionRecordInput): Promise<EvolutionRecord> {
    return this.record(input)
  }

  recordBaseline(data: EvolutionInputObject, options: EvolutionRecordOptions = {}): Promise<EvolutionRecord> {
    return this.record({ ...options, kind: 'baseline', data })
  }

  recordRemediation(data: EvolutionInputObject, options: EvolutionRecordOptions = {}): Promise<EvolutionRecord> {
    return this.record({ ...options, kind: 'remediation', data })
  }

  recordGain(data: EvolutionInputObject, options: EvolutionRecordOptions = {}): Promise<EvolutionRecord> {
    return this.record({ ...options, kind: 'gain', data })
  }

  recordAgentReflection(data: EvolutionInputObject, options: EvolutionRecordOptions = {}): Promise<EvolutionRecord> {
    return this.record({ ...options, kind: 'agent-reflection', data })
  }

  agentReflection(data: EvolutionInputObject, options: EvolutionRecordOptions = {}): Promise<EvolutionRecord> {
    return this.recordAgentReflection(data, options)
  }

  recordReflection(data: EvolutionInputObject, options: EvolutionRecordOptions = {}): Promise<EvolutionRecord> {
    return this.record({ ...options, kind: 'reflection', data })
  }

  baseline(data: EvolutionInputObject, options: EvolutionRecordOptions = {}): Promise<EvolutionRecord> {
    return this.recordBaseline(data, options)
  }

  remediation(data: EvolutionInputObject, options: EvolutionRecordOptions = {}): Promise<EvolutionRecord> {
    return this.recordRemediation(data, options)
  }

  gain(data: EvolutionInputObject, options: EvolutionRecordOptions = {}): Promise<EvolutionRecord> {
    return this.recordGain(data, options)
  }

  reflection(data: EvolutionInputObject, options: EvolutionRecordOptions = {}): Promise<EvolutionRecord> {
    return this.recordAgentReflection(data, options)
  }

  async read(options: EvolutionReadOptions | number = {}): Promise<EvolutionRecord[]> {
    await this.pending
    await this.ensureLoaded()
    const requestedLimit = typeof options === 'number' ? options : options.limit
    const limit = requestedLimit ?? this.maxReadRecords
    assertReadLimit(limit)
    const boundedLimit = Math.min(limit, this.maxReadRecords)
    if (boundedLimit === 0) return []

    const kinds = normalizeKinds(typeof options === 'number' ? undefined : options.kind ?? options.type)
    const retained: EvolutionRecord[] = []
    for (const record of this.records) {
      if (kinds && !kinds.includes(record.kind)) continue
      retained.push(record)
      if (retained.length > boundedLimit) retained.shift()
    }
    return retained.map(copyEvolutionRecord)
  }

  latest(limit = this.maxReadRecords): Promise<EvolutionRecord[]> {
    return this.read({ limit })
  }

  list(options: EvolutionReadOptions | number = {}): Promise<EvolutionRecord[]> {
    return this.read(options)
  }

  flush(): Promise<void> {
    return this.pending
  }

  async close(): Promise<void> {
    await this.pending
    this.closed = true
  }

  dispose(): void {
    this.closed = true
  }

  async disposeAsync(): Promise<void> {
    await this.close()
  }

  private validateInput(input: EvolutionRecordInput): void {
    if (!isRecord(input)) throw new TypeError('Evolution record input is required.')
    const kind = input.kind ?? input.type
    if (!isEvolutionRecordKind(kind)) throw new TypeError('Evolution record kind is required.')
    if (input.kind !== undefined && input.type !== undefined && input.kind !== input.type) {
      throw new TypeError('Evolution record kind and type must match.')
    }
    if (input.id !== undefined) assertNonEmptyString(input.id, 'Evolution record id')
    if (input.recordedAt !== undefined) assertNonEmptyString(input.recordedAt, 'Evolution record timestamp')
    if (input.timestamp !== undefined) assertNonEmptyString(input.timestamp, 'Evolution record timestamp')
    if (input.data !== undefined && !isRecord(input.data)) throw new TypeError('Evolution record data must be an object.')
    if (input.payload !== undefined && !isRecord(input.payload)) throw new TypeError('Evolution record payload must be an object.')
    if (input.telemetry !== undefined && !isRecord(input.telemetry)) throw new TypeError('Evolution record telemetry must be an object.')
    if (input.metadata !== undefined && !isRecord(input.metadata)) throw new TypeError('Evolution record metadata must be an object.')
  }

  private trimRecords(): void {
    while (this.records.length > this.maxRecords) this.records.shift()
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (!this.loading) {
      this.loading = (async () => {
        let content: string | undefined
        try {
          content = await readFile(this.filePath, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          if (await recoverFileFromBackup(this.filePath)) content = await readFile(this.filePath, 'utf8')
        }
        if (content && content.trim().length > 0) {
          try {
            const history = parseHistory(JSON.parse(content) as unknown)
            this.records.splice(0, this.records.length, ...history.slice(-this.maxRecords))
          } catch (error) {
            const restored = await restoreFileFromBackup(this.filePath, { overwrite: true })
            if (!restored) throw error
            const recovered = await readFile(this.filePath, 'utf8')
            const history = parseHistory(JSON.parse(recovered) as unknown)
            this.records.splice(0, this.records.length, ...history.slice(-this.maxRecords))
          }
        }
        this.loaded = true
      })()
    }
    try {
      await this.loading
    } finally {
      this.loading = undefined
    }
  }

  private async persist(): Promise<void> {
    const stored: StoredEvolutionHistory = {
      version: EVOLUTION_HISTORY_VERSION,
      records: this.records.map(persistedRecord),
    }
    await writeFileAtomically(this.filePath, `${JSON.stringify(stored)}\n`)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Evolution store is closed.'))
    const current = this.pending.then(async () => {
      if (this.closed) throw new Error('Evolution store is closed.')
      return operation()
    })
    this.pending = current.then(() => undefined, () => undefined)
    return current
  }
}

export { EvolutionStore as EvolutionHistoryStore }

export function createEvolutionStore(options: string | EvolutionStoreOptions): EvolutionStore {
  return typeof options === 'string' ? new EvolutionStore(options) : new EvolutionStore(options)
}
