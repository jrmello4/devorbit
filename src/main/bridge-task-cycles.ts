export type BridgeCycleStatus = 'completed' | 'blocked' | 'failed'

export interface BridgeCycleOutcome {
  status: BridgeCycleStatus
  summary: string
}

export interface BridgeCycleHandle {
  cancel(): void
}

export interface BridgeCyclePending<T> {
  generation: number
  payload: T
  persistent: boolean
  handle: BridgeCycleHandle
}

interface CachedOutcome {
  outcome: BridgeCycleOutcome
  generation: number
  expiresAt: number
}

export interface BridgeTaskCyclesOptions {
  ttlMs?: number
  maxEntries?: number
  now?: () => number
}

const DEFAULT_TTL_MS = 60 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 128

export class BridgeTaskCycles<T> {
  private readonly generations = new Map<string, number>()
  private readonly pending = new Map<string, BridgeCyclePending<T>>()
  private readonly cache = new Map<string, CachedOutcome>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: BridgeTaskCyclesOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.now = options.now ?? Date.now
  }

  generation(id: string): number {
    return this.generations.get(id) ?? 0
  }

  begin(id: string): number {
    const next = this.generation(id) + 1
    this.generations.set(id, next)
    this.cache.delete(id)
    return next
  }

  hasPending(id: string): boolean {
    return this.pending.has(id)
  }

  setPending(id: string, generation: number, payload: T, handle: BridgeCycleHandle, persistent: boolean): void {
    this.pending.set(id, { generation, payload, handle, persistent })
  }

  pendingFor(id: string, generation: number): BridgeCyclePending<T> | undefined {
    const entry = this.pending.get(id)
    return entry && entry.generation === generation ? entry : undefined
  }

  complete(id: string, generation: number, outcome: BridgeCycleOutcome): boolean {
    const entry = this.pending.get(id)
    if (entry && entry.generation === generation) this.pending.delete(id)
    if (this.generation(id) !== generation) return false
    this.cacheOutcome(id, generation, outcome)
    return true
  }

  cacheOutcome(id: string, generation: number, outcome: BridgeCycleOutcome): boolean {
    if (this.generation(id) !== generation) return false
    this.cache.set(id, { outcome, generation, expiresAt: this.now() + this.ttlMs })
    this.prune()
    return true
  }

  cachedOutcome(id: string): BridgeCycleOutcome | undefined {
    const entry = this.cache.get(id)
    if (!entry) return undefined
    if (entry.generation !== this.generation(id) || entry.expiresAt <= this.now()) {
      this.cache.delete(id)
      return undefined
    }
    return entry.outcome
  }

  cancelPending(id: string): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    entry.handle.cancel()
    return true
  }

  pendingIds(): string[] {
    return [...this.pending.keys()]
  }

  private prune(): void {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next()
      if (oldest.done) return
      this.cache.delete(oldest.value)
    }
  }
}
