import { randomUUID } from 'node:crypto'

export type HitlState = 'pending' | 'approved' | 'rejected' | 'expired'
export type HitlTerminalState = Exclude<HitlState, 'pending'>

export interface HitlRequestInput {
  id?: string
  prompt: string
  context?: unknown
  metadata?: Record<string, unknown>
  ttlMs?: number
}

export interface HitlDecisionInput {
  state: 'approved' | 'rejected'
  reason?: string
  decidedBy?: string
}

export interface HitlDecision {
  state: HitlTerminalState
  decidedAt: number
  reason?: string
  decidedBy?: string
}

export interface HitlRequest {
  id: string
  prompt: string
  state: HitlState
  createdAt: number
  expiresAt: number
  context?: unknown
  metadata?: Record<string, unknown>
  decision?: HitlDecision
}

export interface HitlOptions {
  defaultTtlMs?: number
  clock?: () => number
  idFactory?: () => string
  onChange?: (request: HitlRequest) => void
}

export class HitlNotFoundError extends Error {
  readonly code = 'HITL_NOT_FOUND'

  constructor(id: string) {
    super(`HITL request not found: ${id}`)
    this.name = 'HitlNotFoundError'
  }
}

export class HitlDecisionError extends Error {
  readonly code = 'HITL_DECISION_UNSAFE'

  constructor(id: string, state: HitlState) {
    super(`HITL request ${id} cannot transition from ${state}.`)
    this.name = 'HitlDecisionError'
  }
}

export class HitlWaitTimeoutError extends Error {
  readonly code = 'HITL_WAIT_TIMEOUT'

  constructor(id: string) {
    super(`Waiting for HITL request timed out: ${id}`)
    this.name = 'HitlWaitTimeoutError'
  }
}

interface PendingWaiter {
  resolve: (request: HitlRequest) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

interface StoredRequest extends HitlRequest {
  expirationTimer?: ReturnType<typeof setTimeout>
  waiters: Set<PendingWaiter>
}

function assertTtl(value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError('HITL TTL must be a finite non-negative number.')
  }
}

function cloneValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    const output: unknown[] = []
    seen.set(value, output)
    for (const item of value) output.push(cloneValue(item, seen))
    return output
  }
  const output: Record<string, unknown> = {}
  seen.set(value, output)
  for (const [key, item] of Object.entries(value)) output[key] = cloneValue(item, seen)
  return output
}

function copyRequest(request: StoredRequest): HitlRequest {
  return {
    id: request.id,
    prompt: request.prompt,
    state: request.state,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    ...(request.context !== undefined ? { context: cloneValue(request.context) } : {}),
    ...(request.metadata !== undefined ? { metadata: cloneValue(request.metadata) as Record<string, unknown> } : {}),
    ...(request.decision ? { decision: { ...request.decision } } : {}),
  }
}

export class HITLManager {
  private readonly defaultTtlMs: number
  private readonly clock: () => number
  private readonly idFactory: () => string
  private readonly onChange?: (request: HitlRequest) => void
  private readonly requests = new Map<string, StoredRequest>()

  constructor(options: HitlOptions = {}) {
    const defaultTtlMs = options.defaultTtlMs ?? 5 * 60_000
    assertTtl(defaultTtlMs)
    this.defaultTtlMs = defaultTtlMs
    this.clock = options.clock ?? Date.now
    this.idFactory = options.idFactory ?? randomUUID
    this.onChange = options.onChange
  }

  createRequest(input: HitlRequestInput): HitlRequest {
    if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
      throw new TypeError('HITL prompt is required.')
    }
    const ttlMs = input.ttlMs ?? this.defaultTtlMs
    assertTtl(ttlMs)
    const id = input.id ?? this.idFactory()
    if (typeof id !== 'string' || id.trim().length === 0) throw new TypeError('HITL request id is required.')
    if (this.requests.has(id)) throw new Error(`HITL request already exists: ${id}`)
    const createdAt = this.clock()
    const request: StoredRequest = {
      id,
      prompt: input.prompt,
      state: 'pending',
      createdAt,
      expiresAt: createdAt + ttlMs,
      ...(input.context !== undefined ? { context: cloneValue(input.context) } : {}),
      ...(input.metadata !== undefined ? { metadata: cloneValue(input.metadata) as Record<string, unknown> } : {}),
      waiters: new Set(),
    }
    request.expirationTimer = setTimeout(() => {
      this.expire(id)
    }, ttlMs)
    request.expirationTimer.unref?.()
    this.requests.set(id, request)
    const copy = copyRequest(request)
    this.emit(copy)
    if (ttlMs === 0) this.expire(id)
    return copy
  }

  create(input: HitlRequestInput): HitlRequest {
    return this.createRequest(input)
  }

  request(input: HitlRequestInput): Promise<HitlRequest> {
    const request = this.createRequest(input)
    return this.waitForDecision(request.id)
  }

  requestApproval(input: HitlRequestInput): Promise<HitlRequest> {
    return this.request(input)
  }

  getRequest(id: string): HitlRequest | undefined {
    const request = this.requests.get(id)
    if (!request) return undefined
    this.expireIfDue(request)
    return copyRequest(request)
  }

  get(id: string): HitlRequest | undefined {
    return this.getRequest(id)
  }

  listRequests(state?: HitlState): HitlRequest[] {
    const output: HitlRequest[] = []
    for (const request of this.requests.values()) {
      this.expireIfDue(request)
      if (!state || request.state === state) output.push(copyRequest(request))
    }
    return output
  }

  pending(): HitlRequest[] {
    return this.listRequests('pending')
  }

  decide(id: string, decision: HitlDecisionInput | HitlDecisionInput['state']): HitlRequest {
    const request = this.requests.get(id)
    if (!request) throw new HitlNotFoundError(id)
    this.expireIfDue(request)
    if (request.state !== 'pending') throw new HitlDecisionError(id, request.state)
    const normalized: HitlDecisionInput = typeof decision === 'string' ? { state: decision } : decision
    if (normalized.state !== 'approved' && normalized.state !== 'rejected') {
      throw new TypeError('HITL decision must be approved or rejected.')
    }
    if (normalized.reason !== undefined && typeof normalized.reason !== 'string') {
      throw new TypeError('HITL decision reason must be a string.')
    }
    if (normalized.decidedBy !== undefined && typeof normalized.decidedBy !== 'string') {
      throw new TypeError('HITL decision decidedBy must be a string.')
    }
    request.state = normalized.state
    request.decision = {
      state: normalized.state,
      decidedAt: this.clock(),
      ...(normalized.reason !== undefined ? { reason: normalized.reason } : {}),
      ...(normalized.decidedBy !== undefined ? { decidedBy: normalized.decidedBy } : {}),
    }
    this.clearExpiration(request)
    this.resolveWaiters(request)
    const copy = copyRequest(request)
    this.emit(copy)
    return copy
  }

  approve(id: string, options: Omit<HitlDecisionInput, 'state'> = {}): HitlRequest {
    return this.decide(id, { ...options, state: 'approved' })
  }

  reject(id: string, options: Omit<HitlDecisionInput, 'state'> = {}): HitlRequest {
    return this.decide(id, { ...options, state: 'rejected' })
  }

  tryDecide(id: string, decision: HitlDecisionInput | HitlDecisionInput['state']): boolean {
    try {
      this.decide(id, decision)
      return true
    } catch (error) {
      if (error instanceof HitlDecisionError || error instanceof HitlNotFoundError) return false
      throw error
    }
  }

  expire(id: string): HitlRequest | undefined {
    const request = this.requests.get(id)
    if (!request) return undefined
    if (request.state !== 'pending') return copyRequest(request)
    request.state = 'expired'
    request.decision = { state: 'expired', decidedAt: this.clock() }
    this.clearExpiration(request)
    this.resolveWaiters(request)
    const copy = copyRequest(request)
    this.emit(copy)
    return copy
  }

  expireDue(): number {
    const now = this.clock()
    let expired = 0
    for (const request of this.requests.values()) {
      if (request.state === 'pending' && request.expiresAt <= now) {
        this.expire(request.id)
        expired += 1
      }
    }
    return expired
  }

  waitForDecision(id: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<HitlRequest> {
    const request = this.requests.get(id)
    if (!request) return Promise.reject(new HitlNotFoundError(id))
    this.expireIfDue(request)
    if (request.state !== 'pending') return Promise.resolve(copyRequest(request))
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
      return Promise.reject(new RangeError('HITL wait timeout must be a finite non-negative number.'))
    }
    if (options.signal?.aborted) return Promise.reject(new Error('HITL wait was aborted.'))
    return new Promise<HitlRequest>((resolve, reject) => {
      const waiter: PendingWaiter = { resolve, reject, signal: options.signal }
      waiter.onAbort = () => {
        this.removeWaiter(request, waiter)
        reject(new Error('HITL wait was aborted.'))
      }
      options.signal?.addEventListener('abort', waiter.onAbort, { once: true })
      if (options.timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          this.removeWaiter(request, waiter)
          reject(new HitlWaitTimeoutError(id))
        }, options.timeoutMs)
        waiter.timer.unref?.()
      }
      request.waiters.add(waiter)
    })
  }

  clear(): void {
    for (const request of this.requests.values()) {
      this.clearExpiration(request)
      const waiters = [...request.waiters]
      request.waiters.clear()
      for (const waiter of waiters) {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer)
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
        waiter.reject(new HitlNotFoundError(request.id))
      }
    }
    this.requests.clear()
  }

  private expireIfDue(request: StoredRequest): void {
    if (request.state === 'pending' && request.expiresAt <= this.clock()) this.expire(request.id)
  }

  private clearExpiration(request: StoredRequest): void {
    if (request.expirationTimer !== undefined) clearTimeout(request.expirationTimer)
    request.expirationTimer = undefined
  }

  private resolveWaiters(request: StoredRequest): void {
    const waiters = [...request.waiters]
    request.waiters.clear()
    const copy = copyRequest(request)
    for (const waiter of waiters) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer)
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.resolve(copy)
    }
  }

  private removeWaiter(request: StoredRequest, waiter: PendingWaiter): void {
    request.waiters.delete(waiter)
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
  }

  private emit(request: HitlRequest): void {
    try {
      this.onChange?.(request)
    } catch {
      return
    }
  }
}

export { HITLManager as HitlManager }
export { HITLManager as HITLController, HITLManager as HITL }

export function createHITLManager(options: HitlOptions = {}): HITLManager {
  return new HITLManager(options)
}

export const createHitlManager = createHITLManager
