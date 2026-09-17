export interface SemaphoreOptions {
  limit?: number
  maxConcurrency?: number
  defaultTimeoutMs?: number
}

export interface SemaphoreAcquireOptions {
  timeoutMs?: number
  timeout?: number
  signal?: AbortSignal
}

export interface SemaphorePermit {
  (): void
  readonly acquiredAt: number
  readonly release: () => void
}

export class SemaphoreTimeoutError extends Error {
  readonly code = 'SEMAPHORE_TIMEOUT'

  constructor(message = 'Semaphore acquisition timed out.') {
    super(message)
    this.name = 'TimeoutError'
  }
}

export class SemaphoreAbortError extends Error {
  readonly code = 'SEMAPHORE_ABORTED'

  constructor(message = 'Semaphore acquisition was aborted.') {
    super(message)
    this.name = 'AbortError'
  }
}

export class SemaphoreClosedError extends Error {
  readonly code = 'SEMAPHORE_CLOSED'

  constructor(message = 'Semaphore is closed.') {
    super(message)
    this.name = 'SemaphoreClosedError'
  }
}

interface Waiter {
  settled: boolean
  resolve: (permit: SemaphorePermit) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
  timer?: ReturnType<typeof setTimeout>
}

function assertTimeout(value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError('Semaphore timeout must be a finite non-negative number.')
  }
}

function assertLimit(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError('Semaphore limit must be a positive integer.')
  }
}

export class Semaphore {
  readonly limit: number
  private readonly defaultTimeoutMs?: number
  private active = 0
  private readonly waiters: Waiter[] = []
  private closed = false

  constructor(limitOrOptions: number | SemaphoreOptions) {
    const options = typeof limitOrOptions === 'number'
      ? { limit: limitOrOptions }
      : limitOrOptions
    const limit = options.limit ?? options.maxConcurrency
    if (limit === undefined) throw new TypeError('Semaphore limit is required.')
    assertLimit(limit)
    assertTimeout(options.defaultTimeoutMs)
    this.limit = limit
    this.defaultTimeoutMs = options.defaultTimeoutMs
  }

  get activeCount(): number {
    return this.active
  }

  get pendingCount(): number {
    return this.waiters.length
  }

  get available(): number {
    return Math.max(0, this.limit - this.active)
  }

  get isClosed(): boolean {
    return this.closed
  }

  acquire(options: SemaphoreAcquireOptions = {}): Promise<SemaphorePermit> {
    if (this.closed) return Promise.reject(new SemaphoreClosedError())
    const timeoutMs = options.timeoutMs ?? options.timeout ?? this.defaultTimeoutMs
    assertTimeout(timeoutMs)
    if (options.signal?.aborted) return Promise.reject(new SemaphoreAbortError())

    return new Promise<SemaphorePermit>((resolve, reject) => {
      const waiter: Waiter = {
        settled: false,
        resolve,
        reject,
        signal: options.signal,
      }
      waiter.onAbort = () => {
        this.rejectWaiter(waiter, new SemaphoreAbortError())
      }
      options.signal?.addEventListener('abort', waiter.onAbort, { once: true })

      if (this.active < this.limit && this.waiters.length === 0) {
        this.grant(waiter)
        return
      }

      this.waiters.push(waiter)
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          this.rejectWaiter(waiter, new SemaphoreTimeoutError())
        }, timeoutMs)
        waiter.timer.unref?.()
      }
      this.pump()
    })
  }

  tryAcquire(): SemaphorePermit | undefined {
    if (this.closed || this.active >= this.limit || this.waiters.length > 0) return undefined
    const waiter: Waiter = {
      settled: false,
      resolve: () => undefined,
      reject: () => undefined,
    }
    return this.grant(waiter)
  }

  async runExclusive<T>(
    task: () => T | Promise<T>,
    options: SemaphoreAcquireOptions = {},
  ): Promise<T> {
    const permit = await this.acquire(options)
    try {
      return await task()
    } finally {
      permit.release()
    }
  }

  close(error = new SemaphoreClosedError()): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      if (waiter) this.rejectWaiter(waiter, error)
    }
  }

  private grant(waiter: Waiter): SemaphorePermit {
    waiter.settled = true
    this.cleanupWaiter(waiter)
    this.active += 1
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.active = Math.max(0, this.active - 1)
      this.pump()
    }
    const permit = (() => release()) as SemaphorePermit
    Object.defineProperty(permit, 'acquiredAt', {
      configurable: false,
      enumerable: true,
      value: Date.now(),
      writable: false,
    })
    Object.defineProperty(permit, 'release', {
      configurable: false,
      enumerable: true,
      value: release,
      writable: false,
    })
    waiter.resolve(permit)
    return permit
  }

  private rejectWaiter(waiter: Waiter, error: Error): void {
    if (waiter.settled) return
    waiter.settled = true
    const index = this.waiters.indexOf(waiter)
    if (index >= 0) this.waiters.splice(index, 1)
    this.cleanupWaiter(waiter)
    waiter.reject(error)
    this.pump()
  }

  private cleanupWaiter(waiter: Waiter): void {
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
    waiter.timer = undefined
    waiter.onAbort = undefined
  }

  private pump(): void {
    while (!this.closed && this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      if (!waiter || waiter.settled) continue
      this.grant(waiter)
    }
  }
}

export function createSemaphore(options: number | SemaphoreOptions): Semaphore {
  return new Semaphore(options)
}
