import { describe, expect, it } from 'vitest'
import {
  McpHttpSecurity,
  SlidingWindowRateLimiter,
  constantTimeEqual,
  extractBearerToken,
  isMcpHttpTokenAuthorized,
  isOriginAllowed,
} from '../src/main/mcp/security'

describe('MCP HTTP security', () => {
  it('accepts an allowlisted Origin and rejects an unlisted Origin', () => {
    const allowedOrigins = ['http://localhost:5173', 'null']

    expect(isOriginAllowed('http://localhost:5173', allowedOrigins)).toBe(true)
    expect(isOriginAllowed('null', allowedOrigins)).toBe(true)
    expect(isOriginAllowed(undefined, allowedOrigins)).toBe(true)
    expect(isOriginAllowed('https://attacker.example', allowedOrigins)).toBe(false)
  })

  it('accepts Bearer and x-devorbit-token credentials with constant-time equality semantics', () => {
    expect(extractBearerToken('Bearer mcp-secret')).toBe('mcp-secret')
    expect(extractBearerToken('bearer mcp-secret')).toBe('mcp-secret')
    expect(extractBearerToken('Basic mcp-secret')).toBeUndefined()

    expect(constantTimeEqual('mcp-secret', 'mcp-secret')).toBe(true)
    expect(constantTimeEqual('mcp-secret', 'other-secret')).toBe(false)
    expect(constantTimeEqual('mcp-secret', 'mcp-secret-extra')).toBe(false)
    expect(isMcpHttpTokenAuthorized({ authorization: 'Bearer mcp-secret' }, 'mcp-secret')).toBe(true)
    expect(isMcpHttpTokenAuthorized({ 'x-devorbit-token': 'mcp-secret' }, 'mcp-secret')).toBe(true)
    expect(isMcpHttpTokenAuthorized({ authorization: 'Bearer wrong' }, 'mcp-secret')).toBe(false)
    expect(isMcpHttpTokenAuthorized({ 'x-devorbit-token': 'wrong' }, 'mcp-secret')).toBe(false)
  })

  it('combines Origin, token, and per-client rate-limit decisions', () => {
    let now = 1_000
    const security = new McpHttpSecurity({
      allowedOrigins: ['http://localhost:5173'],
      authToken: 'mcp-secret',
      rateLimit: { limit: 2, windowMs: 1_000, clock: () => now },
    })

    expect(security.authorize({
      clientId: 'client-a',
      origin: 'http://localhost:5173',
      authorization: 'Bearer mcp-secret',
    })).toMatchObject({ allowed: true, rateLimit: { remaining: 1 } })

    expect(security.authorize({
      clientId: 'client-a',
      origin: 'http://localhost:5173',
      'x-devorbit-token': 'mcp-secret',
    })).toMatchObject({ allowed: true, rateLimit: { remaining: 0 } })

    expect(security.authorize({
      clientId: 'client-a',
      origin: 'http://localhost:5173',
      authorization: 'Bearer mcp-secret',
    })).toMatchObject({ allowed: false, reason: 'rate-limit', rateLimit: { retryAfterMs: 1_000 } })

    expect(security.authorize({
      clientId: 'client-b',
      origin: 'https://attacker.example',
      authorization: 'Bearer mcp-secret',
    })).toEqual({ allowed: false, reason: 'origin' })

    expect(security.authorize({
      clientId: 'client-b',
      origin: 'http://localhost:5173',
      authorization: 'Bearer wrong',
    })).toEqual({ allowed: false, reason: 'token' })

    expect(security.authorize({
      clientId: 'client-b',
      origin: 'http://localhost:5173',
      authorization: 'Bearer mcp-secret',
    })).toMatchObject({ allowed: true, rateLimit: { remaining: 1 } })

    now += 1_000
    expect(security.authorize({
      clientId: 'client-a',
      origin: 'http://localhost:5173',
      authorization: 'Bearer mcp-secret',
    })).toMatchObject({ allowed: true, rateLimit: { remaining: 1 } })
  })
})

describe('SlidingWindowRateLimiter', () => {
  it('cleans expired client windows and keeps clients isolated', () => {
    let now = 0
    const limiter = new SlidingWindowRateLimiter({ limit: 1, windowMs: 100, clock: () => now })

    expect(limiter.consume('client-a')).toMatchObject({ allowed: true, remaining: 0 })
    expect(limiter.consume('client-a')).toMatchObject({ allowed: false, retryAfterMs: 100 })
    expect(limiter.consume('client-b')).toMatchObject({ allowed: true, remaining: 0 })
    expect(limiter.clientCount).toBe(2)

    now = 100
    expect(limiter.cleanup()).toBe(2)
    expect(limiter.clientCount).toBe(0)
    expect(limiter.consume('client-a')).toMatchObject({ allowed: true, remaining: 0 })
  })

  it('rejects invalid limiter configuration and client identifiers', () => {
    expect(() => new SlidingWindowRateLimiter({ limit: 0, windowMs: 100 })).toThrow(RangeError)
    expect(() => new SlidingWindowRateLimiter({ limit: 1, windowMs: 0 })).toThrow(RangeError)

    const limiter = new SlidingWindowRateLimiter({ limit: 1, windowMs: 100 })
    expect(() => limiter.consume('')).toThrow(TypeError)
  })
})
