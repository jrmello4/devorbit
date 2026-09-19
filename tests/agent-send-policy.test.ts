import { describe, expect, it } from 'vitest'
import { agentSendPolicy, type AgentSendPolicyInput } from '../src/renderer/src/components/agent-send-policy'

const base: AgentSendPolicyInput = {
  configured: true,
  configuredMessage: '',
  orchestrationActive: false,
  noteCount: 1,
  progressState: null,
}

describe('agent send policy', () => {
  it('enables the send control only for a configured agent with a connected note', () => {
    expect(agentSendPolicy(base)).toEqual({ disabled: false, reason: '' })
  })

  it('explains the missing configuration instead of silently disabling', () => {
    expect(agentSendPolicy({ ...base, configured: false, configuredMessage: 'Configure provider e conta.' })).toEqual({
      disabled: true,
      reason: 'Configure provider e conta.',
      blocker: 'configured',
    })
  })

  it('disables while a task for the same agent is queued or running', () => {
    for (const progressState of ['queued', 'running'] as const) {
      const policy = agentSendPolicy({ ...base, progressState })
      expect(policy.disabled).toBe(true)
      expect(policy.reason).toContain('em andamento')
    }
    expect(agentSendPolicy({ ...base, progressState: 'completed' }).disabled).toBe(false)
    expect(agentSendPolicy({ ...base, progressState: 'blocked' }).disabled).toBe(false)
  })

  it('disables during orchestration and explains the wait', () => {
    const policy = agentSendPolicy({ ...base, orchestrationActive: true })
    expect(policy.disabled).toBe(true)
    expect(policy.reason).toContain('orquestração')
  })

  it('requires a connected note with content', () => {
    const policy = agentSendPolicy({ ...base, noteCount: 0 })
    expect(policy.disabled).toBe(true)
    expect(policy.reason).toContain('nota')
  })

  it('exposes o bloqueio para a UI decidir entre desativar e avisar', () => {
    expect(agentSendPolicy({ ...base, configured: false }).blocker).toBe('configured')
    expect(agentSendPolicy({ ...base, orchestrationActive: true }).blocker).toBe('orchestration')
    expect(agentSendPolicy({ ...base, progressState: 'running' }).blocker).toBe('progress')
    expect(agentSendPolicy({ ...base, noteCount: 0 }).blocker).toBe('note')
    expect(agentSendPolicy(base).blocker).toBeUndefined()
  })

  it('prioritizes configuration over the other blockers', () => {
    const policy = agentSendPolicy({
      ...base,
      configured: false,
      configuredMessage: 'Configure provider e conta.',
      orchestrationActive: true,
      noteCount: 0,
    })
    expect(policy.reason).toBe('Configure provider e conta.')
  })
})
