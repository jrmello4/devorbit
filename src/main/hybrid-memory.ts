import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { recoverFileFromBackup, restoreFileFromBackup, writeFileAtomically } from './atomic-file'

export type HybridMemoryKind = 'operational' | 'episodic' | 'reflexive'
export type HybridJsonValue = string | number | boolean | null | HybridJsonValue[] | { [key: string]: HybridJsonValue }

export interface HybridMemoryInput {
  id?: string
  kind: HybridMemoryKind
  content: string
  tags?: readonly string[]
  metadata?: Record<string, unknown>
}

export interface HybridMemoryEntry {
  id: string
  kind: HybridMemoryKind
  content: string
  tags: string[]
  metadata?: Record<string, HybridJsonValue>
  createdAt: string
  updatedAt: string
}

export interface HybridMemorySearchOptions {
  kind?: HybridMemoryKind
  limit?: number
}

export interface HybridMemorySearchResult {
  entry: HybridMemoryEntry
  score: number
  matchedTerms: string[]
}

export interface HybridMemoryOptions {
  filePath?: string
  path?: string
  clock?: () => number
  idFactory?: () => string
  maxEntries?: number
}

interface StoredMemory {
  version: 1
  entries: HybridMemoryEntry[]
}

function isKind(value: unknown): value is HybridMemoryKind {
  return value === 'operational' || value === 'episodic' || value === 'reflexive'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonValue(value: unknown, seen: WeakSet<object>, depth: number): HybridJsonValue {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined') return null
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  if (depth > 8) return '[TRUNCATED]'
  if (value instanceof Date) return value.toISOString()
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, seen, depth + 1))
  const output: Record<string, HybridJsonValue> = {}
  for (const [key, item] of Object.entries(value)) output[key] = jsonValue(item, seen, depth + 1)
  return output
}

function normalizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, HybridJsonValue> | undefined {
  if (metadata === undefined) return undefined
  return jsonValue(metadata, new WeakSet<object>(), 0) as Record<string, HybridJsonValue>
}

function copyEntry(entry: HybridMemoryEntry): HybridMemoryEntry {
  return {
    ...entry,
    tags: [...entry.tags],
    ...(entry.metadata ? { metadata: JSON.parse(JSON.stringify(entry.metadata)) as Record<string, HybridJsonValue> } : {}),
  }
}

function normalizeText(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase()
}

function terms(value: string): string[] {
  return [...new Set(normalizeText(value).split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 0))]
}

function assertLimit(value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError('Hybrid memory limit must be positive.')
}

function parseStored(value: unknown): StoredMemory {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) {
    throw new Error('Invalid hybrid memory file.')
  }
  const entries: HybridMemoryEntry[] = []
  for (const item of value.entries) {
    if (!isRecord(item) || typeof item.id !== 'string' || !isKind(item.kind) || typeof item.content !== 'string'
      || !Array.isArray(item.tags) || !item.tags.every((tag) => typeof tag === 'string')
      || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string') {
      throw new Error('Invalid hybrid memory entry.')
    }
    entries.push({
      id: item.id,
      kind: item.kind,
      content: item.content,
      tags: [...item.tags] as string[],
      ...(isRecord(item.metadata) ? { metadata: item.metadata as Record<string, HybridJsonValue> } : {}),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })
  }
  return { version: 1, entries }
}

export class HybridMemory {
  readonly filePath: string
  private readonly clock: () => number
  private readonly idFactory: () => string
  private readonly maxEntries?: number
  private readonly entries = new Map<string, HybridMemoryEntry>()
  private loaded = false
  private loading?: Promise<void>
  private pending: Promise<void> = Promise.resolve()

  constructor(filePathOrOptions: string | HybridMemoryOptions, options: HybridMemoryOptions = {}) {
    const configured = typeof filePathOrOptions === 'string'
      ? { ...options, filePath: filePathOrOptions }
      : filePathOrOptions
    const filePath = configured.filePath ?? configured.path
    if (!filePath || filePath.trim().length === 0) throw new TypeError('Hybrid memory file path is required.')
    if (configured.maxEntries !== undefined) assertLimit(configured.maxEntries)
    this.filePath = path.resolve(filePath)
    this.clock = configured.clock ?? Date.now
    this.idFactory = configured.idFactory ?? randomUUID
    this.maxEntries = configured.maxEntries
  }

  async add(input: HybridMemoryInput): Promise<HybridMemoryEntry> {
    return this.mutate(async () => {
      this.assertInput(input)
      const now = new Date(this.clock()).toISOString()
      const id = input.id ?? this.idFactory()
      if (this.entries.has(id)) throw new Error(`Hybrid memory entry already exists: ${id}`)
      const entry: HybridMemoryEntry = {
        id,
        kind: input.kind,
        content: input.content,
        tags: [...(input.tags ?? [])],
        ...(normalizeMetadata(input.metadata) ? { metadata: normalizeMetadata(input.metadata) } : {}),
        createdAt: now,
        updatedAt: now,
      }
      this.entries.set(id, entry)
      this.trimEntries()
      await this.persist()
      return copyEntry(entry)
    })
  }

  remember(kind: HybridMemoryKind, content: string, options: Omit<HybridMemoryInput, 'kind' | 'content'> = {}): Promise<HybridMemoryEntry> {
    return this.add({ ...options, kind, content })
  }

  operational(content: string, options: Omit<HybridMemoryInput, 'kind' | 'content'> = {}): Promise<HybridMemoryEntry> {
    return this.remember('operational', content, options)
  }

  episodic(content: string, options: Omit<HybridMemoryInput, 'kind' | 'content'> = {}): Promise<HybridMemoryEntry> {
    return this.remember('episodic', content, options)
  }

  reflexive(content: string, options: Omit<HybridMemoryInput, 'kind' | 'content'> = {}): Promise<HybridMemoryEntry> {
    return this.remember('reflexive', content, options)
  }

  async upsert(input: HybridMemoryInput): Promise<HybridMemoryEntry> {
    return this.mutate(async () => {
      this.assertInput(input)
      const now = new Date(this.clock()).toISOString()
      const id = input.id ?? this.idFactory()
      const previous = this.entries.get(id)
      const entry: HybridMemoryEntry = {
        id,
        kind: input.kind,
        content: input.content,
        tags: [...(input.tags ?? [])],
        ...(normalizeMetadata(input.metadata) ? { metadata: normalizeMetadata(input.metadata) } : {}),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      }
      this.entries.set(id, entry)
      this.trimEntries()
      await this.persist()
      return copyEntry(entry)
    })
  }

  async get(id: string): Promise<HybridMemoryEntry | undefined> {
    await this.pending
    await this.ensureLoaded()
    const entry = this.entries.get(id)
    return entry ? copyEntry(entry) : undefined
  }

  async list(kind?: HybridMemoryKind): Promise<HybridMemoryEntry[]> {
    await this.pending
    await this.ensureLoaded()
    return [...this.entries.values()]
      .filter((entry) => !kind || entry.kind === kind)
      .map(copyEntry)
  }

  async remove(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const removed = this.entries.delete(id)
      if (removed) await this.persist()
      return removed
    })
  }

  async search(query: string, options: HybridMemorySearchOptions = {}): Promise<HybridMemorySearchResult[]> {
    await this.pending
    await this.ensureLoaded()
    const queryTerms = terms(query)
    if (queryTerms.length === 0) return []
    const results: HybridMemorySearchResult[] = []
    for (const entry of this.entries.values()) {
      if (options.kind && entry.kind !== options.kind) continue
      const corpus = normalizeText(`${entry.content} ${entry.tags.join(' ')} ${entry.kind}`)
      const matchedTerms: string[] = []
      let score = 0
      for (const term of queryTerms) {
        const occurrences = corpus.split(term).length - 1
        if (occurrences > 0) {
          matchedTerms.push(term)
          score += occurrences
        }
      }
      if (matchedTerms.length > 0) results.push({ entry: copyEntry(entry), score, matchedTerms })
    }
    results.sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt) || left.entry.id.localeCompare(right.entry.id))
    const limit = options.limit ?? results.length
    if (!Number.isInteger(limit) || limit < 0) throw new RangeError('Hybrid memory search limit must be non-negative.')
    return results.slice(0, limit)
  }

  flush(): Promise<void> {
    return this.pending
  }

  private assertInput(input: HybridMemoryInput): void {
    if (!isKind(input.kind)) throw new TypeError('Hybrid memory kind is invalid.')
    if (typeof input.content !== 'string' || input.content.trim().length === 0) throw new TypeError('Hybrid memory content is required.')
    if (input.id !== undefined && (typeof input.id !== 'string' || input.id.trim().length === 0)) throw new TypeError('Hybrid memory id is invalid.')
  }

  private trimEntries(): void {
    if (!this.maxEntries) return
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) return
      this.entries.delete(oldest.value)
    }
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
          let stored: StoredMemory
          try {
            stored = parseStored(JSON.parse(content) as unknown)
          } catch (error) {
            const restored = await restoreFileFromBackup(this.filePath, { overwrite: true })
            if (!restored) throw error
            stored = parseStored(JSON.parse(await readFile(this.filePath, 'utf8')) as unknown)
          }
          this.entries.clear()
          for (const entry of stored.entries) this.entries.set(entry.id, entry)
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
    const payload: StoredMemory = { version: 1, entries: [...this.entries.values()].map(copyEntry) }
    await writeFileAtomically(this.filePath, `${JSON.stringify(payload)}\n`)
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.pending.then(async () => {
      await this.ensureLoaded()
      return operation()
    })
    this.pending = current.then(() => undefined, () => undefined)
    return current
  }
}

export { HybridMemory as HybridMemoryStore }

export function createHybridMemory(options: string | HybridMemoryOptions): HybridMemory {
  return new HybridMemory(options)
}
