import { describe, expect, it } from 'vitest'
import {
  MAX_AGENT_BRIDGE_DEPTH,
  buildDelegationAudit,
  evaluateDelegationGuard,
  isTargetAllowListed,
  validateAgentBridgeRequest,
} from '../src/main/agent-bridge'

const credentials = { token: 'test-token', sessionId: 'session-1' }

describe('delegation guardrails', () => {
  it('bloqueia profundidade e ciclos', () => {
    const deep = evaluateDelegationGuard('agy', { depth: MAX_AGENT_BRIDGE_DEPTH })
    expect(deep).toMatchObject({ allowed: false, code: 'CYCLE_BLOCKED' })

    const cycle = evaluateDelegationGuard('agy', { visited: ['agy'] })
    expect(cycle).toMatchObject({ allowed: false, code: 'CYCLE_BLOCKED' })
  })

  it('bloqueia alvos fora da allow-list e libera os permitidos', () => {
    expect(isTargetAllowListed('agy', [])).toBe(true)
    expect(isTargetAllowListed('agy', ['agy', 'opencode'])).toBe(true)
    expect(isTargetAllowListed('claude', ['agy'])).toBe(false)

    const blocked = evaluateDelegationGuard('claude', { allowedTargets: ['agy'] })
    expect(blocked).toMatchObject({ allowed: false, code: 'TARGET_NOT_ALLOWED', target: 'claude' })

    const allowed = evaluateDelegationGuard('agy', { allowedTargets: ['agy'], depth: 1, visited: ['opencode'] })
    expect(allowed).toMatchObject({ allowed: true, target: 'agy', depth: 1, visited: ['opencode'] })
  })

  it('produz um registro de auditoria serializável', () => {
    const decision = evaluateDelegationGuard('claude', { allowedTargets: ['agy'], depth: 2 })
    const audit = buildDelegationAudit(decision, { requestId: 'req-1', origin: 'agent-0', at: 123 })
    expect(audit).toEqual({
      kind: 'delegation.guard',
      allowed: false,
      target: 'claude',
      depth: 2,
      visited: [],
      code: 'TARGET_NOT_ALLOWED',
      reason: 'Target claude is not in the delegation allow-list.',
      allowedTargets: ['agy'],
      requestId: 'req-1',
      origin: 'agent-0',
      at: 123,
    })
  })
})

describe('agent bridge run request', () => {
  it('parseia a operação run com opções de print mode e origem', () => {
    const request = validateAgentBridgeRequest({
      type: 'run',
      ...credentials,
      target: 'agy',
      prompt: 'refatore o módulo',
      origin: 'agent-coordenador',
      model: 'gemini-2.0-flash',
      mode: 'accept-edits',
      effort: 'high',
      agent: 'reviewer',
      timeoutMs: '5m',
    })
    expect(request).toMatchObject({
      type: 'run',
      target: 'agy',
      prompt: 'refatore o módulo',
      origin: 'agent-coordenador',
      model: 'gemini-2.0-flash',
      mode: 'accept-edits',
      effort: 'high',
      agent: 'reviewer',
      timeoutMs: 300_000,
    })
  })

  it('rejeita opções de run inseguras', () => {
    expect(() => validateAgentBridgeRequest({
      type: 'run',
      ...credentials,
      target: 'agy',
      prompt: 'x',
      model: 'bad model',
    })).toThrow(/model/i)
    expect(() => validateAgentBridgeRequest({
      type: 'run',
      ...credentials,
      target: 'agy',
      prompt: 'x',
      origin: 'bad\u0007origin',
    })).toThrow(/Target/i)
  })
})
