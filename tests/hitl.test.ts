import { describe, expect, it } from 'vitest'
import { HITLManager, HitlDecisionError } from '../src/main/hitl'

describe('HITLManager', () => {
  it('allows one safe terminal decision and resolves waiters', async () => {
    const manager = new HITLManager({ defaultTtlMs: 1_000, idFactory: () => 'approval-1' })
    const created = manager.createRequest({ prompt: 'Deploy release?', metadata: { source: 'test' } })
    const waiting = manager.waitForDecision(created.id)
    const approved = manager.approve(created.id, { decidedBy: 'reviewer' })

    expect(approved.state).toBe('approved')
    expect((await waiting).decision?.decidedBy).toBe('reviewer')
    expect(() => manager.reject(created.id)).toThrow(HitlDecisionError)
    expect(manager.tryDecide(created.id, 'rejected')).toBe(false)
  })

  it('expires pending requests and rejects decisions after expiry', () => {
    let now = 10_000
    const manager = new HITLManager({ clock: () => now, defaultTtlMs: 100, idFactory: () => 'approval-2' })
    const created = manager.createRequest({ prompt: 'Run migration?' })
    now += 101
    expect(manager.getRequest(created.id)?.state).toBe('expired')
    expect(manager.pending()).toHaveLength(0)
    expect(() => manager.approve(created.id)).toThrow(HitlDecisionError)
  })

  it('returns an already terminal request immediately', async () => {
    const manager = new HITLManager({ idFactory: () => 'approval-3' })
    const created = manager.create({ prompt: 'Allow operation?' })
    manager.reject(created.id, { reason: 'Denied by policy' })
    expect((await manager.waitForDecision(created.id)).decision?.reason).toBe('Denied by policy')
  })

  it('rejects malformed decision payloads without changing the request', () => {
    const manager = new HITLManager({ idFactory: () => 'approval-4' })
    const created = manager.createRequest({ prompt: 'Allow risky operation?' })

    expect(() => manager.decide(created.id, { state: 'approved', reason: 42 as never })).toThrow(TypeError)
    expect(() => manager.decide(created.id, { state: 'approved', decidedBy: { user: 'x' } as never })).toThrow(TypeError)
    expect(manager.getRequest(created.id)?.state).toBe('pending')

    manager.approve(created.id)
    expect(manager.getRequest(created.id)?.state).toBe('approved')
  })
})
