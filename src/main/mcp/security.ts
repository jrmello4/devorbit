import { timingSafeEqual } from 'node:crypto'

export const DEFAULT_MCP_HTTP_RATE_LIMIT = 60
export const DEFAULT_MCP_HTTP_RATE_WINDOW_MS = 60_000

export interface McpHttpAuthHeaders {
  readonly authorization?: string
  readonly 'x-devorbit-token'?: string
}

export interface McpHttpSecurityRequest extends McpHttpAuthHeaders {
  readonly clientId: string
  readonly origin?: string
}

export interface SlidingWindowRateLimiterOptions {
  readonly limit: number
  readonly windowMs: number
  readonly clock?: () => number
}

export interface SlidingWindowRateLimitResult {
  readonly allowed: boolean
  readonly limit: number
  readonly remaining: number
  readonly resetAt: number
  readonly retryAfterMs: number
}

export interface McpHttpSecurityOptions {
  readonly allowedOrigins: readonly string[]
  readonly authToken: string
  readonly rateLimit?: SlidingWindowRateLimiterOptions
}

export type McpHttpSecurityFailureReason = 'origin' | 'token' | 'rate-limit'

export interface McpHttpSecurityDecision {
  readonly allowed: boolean
  readonly reason?: McpHttpSecurityFailureReason
  readonly rateLimit?: SlidingWindowRateLimitResult
}

function validateClockValue(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError('Rate limiter clock must return a finite number.')
  return value
}

function validateClientId(clientId: string): string {
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new TypeError('Rate limiter client id is required.')
  }
  return clientId
}

function oldestTimestamp(timestamps: readonly number[]): number {
  let oldest = timestamps[0] as number
  for (const timestamp of timestamps) {
    if (timestamp < oldest) oldest = timestamp
  }
  return oldest
}

export function isOriginAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  return origin === undefined || allowedOrigins.includes(origin)
}

export function extractBearerToken(authorization: string | undefined): string | undefined {
  const prefix = 'Bearer '
  if (typeof authorization !== 'string' || authorization.length <= prefix.length) return undefined
  if (authorization.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return undefined
  return authorization.slice(prefix.length)
}

export function constantTimeEqual(actual: string | undefined, expected: string): boolean {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  if (actualBytes.length !== expectedBytes.length) return false
  return timingSafeEqual(actualBytes, expectedBytes)
}

export function isMcpHttpTokenAuthorized(
  headers: McpHttpAuthHeaders,
  expectedToken: string,
): boolean {
  if (typeof expectedToken !== 'string' || expectedToken.length === 0) return false

  const bearerMatches = constantTimeEqual(extractBearerToken(headers.authorization), expectedToken)
  const headerMatches = constantTimeEqual(headers['x-devorbit-token'], expectedToken)
  return bearerMatches || headerMatches
}

export class SlidingWindowRateLimiter {
  readonly limit: number
  readonly windowMs: number
  private readonly clock: () => number
  private readonly windows = new Map<string, number[]>()

  constructor(options: SlidingWindowRateLimiterOptions) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new RangeError('Rate limiter limit must be a positive integer.')
    }
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
      throw new RangeError('Rate limiter window must be a positive number.')
    }
    this.limit = options.limit
    this.windowMs = options.windowMs
    this.clock = options.clock ?? Date.now
  }

  get clientCount(): number {
    return this.windows.size
  }

  consume(clientId: string, now = this.clock()): SlidingWindowRateLimitResult {
    validateClientId(clientId)
    const timestamp = validateClockValue(now)
    this.cleanup(timestamp)

    const timestamps = this.windows.get(clientId) ?? []
    if (timestamps.length >= this.limit) {
      const resetAt = oldestTimestamp(timestamps) + this.windowMs
      return {
        allowed: false,
        limit: this.limit,
        remaining: 0,
        resetAt,
        retryAfterMs: Math.max(0, resetAt - timestamp),
      }
    }

    timestamps.push(timestamp)
    this.windows.set(clientId, timestamps)
    const resetAt = oldestTimestamp(timestamps) + this.windowMs
    return {
      allowed: true,
      limit: this.limit,
      remaining: this.limit - timestamps.length,
      resetAt,
      retryAfterMs: 0,
    }
  }

  cleanup(now = this.clock()): number {
    const timestamp = validateClockValue(now)
    const cutoff = timestamp - this.windowMs
    let removed = 0

    for (const [clientId, timestamps] of this.windows) {
      const recent = timestamps.filter((entry) => entry > cutoff)
      if (recent.length === 0) {
        this.windows.delete(clientId)
        removed += 1
      } else if (recent.length !== timestamps.length) {
        this.windows.set(clientId, recent)
      }
    }

    return removed
  }

  clear(): void {
    this.windows.clear()
  }
}

export class McpHttpSecurity {
  readonly rateLimiter: SlidingWindowRateLimiter
  private readonly allowedOrigins: ReadonlySet<string>
  private readonly authToken: string

  constructor(options: McpHttpSecurityOptions) {
    if (typeof options.authToken !== 'string' || options.authToken.length === 0) {
      throw new TypeError('MCP HTTP auth token is required.')
    }
    this.authToken = options.authToken
    this.allowedOrigins = new Set(options.allowedOrigins)
    this.rateLimiter = new SlidingWindowRateLimiter(options.rateLimit ?? {
      limit: DEFAULT_MCP_HTTP_RATE_LIMIT,
      windowMs: DEFAULT_MCP_HTTP_RATE_WINDOW_MS,
    })
  }

  authorize(request: McpHttpSecurityRequest): McpHttpSecurityDecision {
    if (request.origin !== undefined && !this.allowedOrigins.has(request.origin)) {
      return { allowed: false, reason: 'origin' }
    }
    if (!isMcpHttpTokenAuthorized(request, this.authToken)) {
      return { allowed: false, reason: 'token' }
    }

    const rateLimit = this.rateLimiter.consume(request.clientId)
    if (!rateLimit.allowed) {
      return { allowed: false, reason: 'rate-limit', rateLimit }
    }
    return { allowed: true, rateLimit }
  }
}

export function createMcpHttpSecurity(options: McpHttpSecurityOptions): McpHttpSecurity {
  return new McpHttpSecurity(options)
}

export function createSlidingWindowRateLimiter(
  options: SlidingWindowRateLimiterOptions,
): SlidingWindowRateLimiter {
  return new SlidingWindowRateLimiter(options)
}
