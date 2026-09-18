import { describe, expect, it } from 'vitest'
import type { AgentProvider } from '../src/renderer/src/types'
import {
  agentNodeBlockers,
  agentNodeSetupMessage,
  canSubmitAgentCreation,
  canSubmitSquadCreation,
  isAgentNodeConfigured,
  isReadyProvider,
  requiresCodexAccount,
  resolveAgentProvider,
  type AgentCreationSpec,
} from '../src/renderer/src/components/agent-creation-helpers'

const providers: AgentProvider[] = [
  { id: 'codex', label: 'Codex', command: 'codex', state: 'ready', message: '' },
  { id: 'claude', label: 'Claude', command: 'claude', state: 'missing', message: '' },
]

const spec = (provider: AgentCreationSpec['provider'], account: AgentCreationSpec['account'] = null): AgentCreationSpec => ({
  role: 'Implementação',
  provider,
  account,
})

describe('explicit agent creation', () => {
  it('requires a ready provider and an account for Codex', () => {
    expect(isReadyProvider(providers, 'codex')).toBe(true)
    expect(isReadyProvider(providers, 'claude')).toBe(false)
    expect(requiresCodexAccount('codex')).toBe(true)
    expect(canSubmitAgentCreation(spec('codex'), providers)).toBe(false)
    expect(canSubmitAgentCreation(spec('codex', 'account1'), providers)).toBe(true)
  })

  it('does not accept an empty or unavailable selection', () => {
    expect(canSubmitAgentCreation(spec(null), providers)).toBe(false)
    expect(canSubmitAgentCreation(spec('claude'), providers)).toBe(false)
  })
})

describe('explicit squad creation', () => {
  it('requires a title and valid selection for every participant', () => {
    expect(canSubmitSquadCreation({ title: 'Squad', participants: [spec('codex', 'account1')] }, providers)).toBe(true)
    expect(canSubmitSquadCreation({ title: ' ', participants: [spec('codex', 'account1')] }, providers)).toBe(false)
    expect(canSubmitSquadCreation({ title: 'Squad', participants: [spec('codex')] }, providers)).toBe(false)
    expect(canSubmitSquadCreation({ title: 'Squad', participants: [spec('codex', 'account1'), spec('claude')] }, providers)).toBe(false)
  })
})

const claudeReady: AgentProvider[] = [
  ...providers.filter((provider) => provider.id !== 'claude'),
  { id: 'claude', label: 'Claude', command: 'claude', state: 'ready', message: '' },
]

describe('inert agent nodes without explicit configuration', () => {
  it('never infers a provider or a default account', () => {
    expect(agentNodeBlockers({}, providers)).toEqual(['provider-missing'])
    expect(agentNodeBlockers({ provider: 'codex' }, providers)).toEqual(['account-missing'])
    expect(agentNodeBlockers({ provider: 'codex', account: null }, providers)).toEqual(['account-missing'])
    expect(agentNodeBlockers({ provider: null, account: 'account1' }, providers)).toEqual(['provider-missing'])
    expect(agentNodeBlockers({ provider: 'claude' }, providers)).toEqual(['provider-not-ready'])
    expect(agentNodeBlockers({ provider: 'codex', account: 'account1' }, providers)).toEqual([])
    expect(agentNodeBlockers({ provider: 'claude' }, claudeReady)).toEqual([])
  })

  it('treats only fully configured nodes as runnable', () => {
    expect(isAgentNodeConfigured({}, providers)).toBe(false)
    expect(isAgentNodeConfigured({ provider: 'codex' }, providers)).toBe(false)
    expect(isAgentNodeConfigured({ provider: 'claude' }, providers)).toBe(false)
    expect(isAgentNodeConfigured({ provider: 'codex', account: 'account2' }, providers)).toBe(true)
    expect(isAgentNodeConfigured({ provider: 'claude' }, claudeReady)).toBe(true)
  })

  it('guides the user to configure both provider and account', () => {
    expect(agentNodeSetupMessage({}, providers)).toBe('Configure o provider e a conta Codex deste agente para ativá-lo.')
    expect(agentNodeSetupMessage({ provider: null }, providers)).toContain('provider')
    expect(agentNodeSetupMessage({ provider: 'codex' }, providers)).toBe('Configure a conta Codex deste agente para ativá-lo.')
    expect(agentNodeSetupMessage({ provider: 'claude' }, providers)).toContain('não está pronto')
    expect(agentNodeSetupMessage({ provider: 'claude' }, claudeReady)).toBe('')
    expect(agentNodeSetupMessage({ provider: 'codex', account: 'account2' }, providers)).toBe('')
  })
})

describe('resolveAgentProvider', () => {
  it('keeps explicit choices and fills only agent nodes without provider', () => {
    expect(resolveAgentProvider('claude', undefined, 'agent', 'opencode')).toBe('claude')
    expect(resolveAgentProvider('invalid', 'gemini', 'agent', 'opencode')).toBe('gemini')
    expect(resolveAgentProvider(undefined, undefined, 'agent', 'opencode')).toBe('opencode')
    expect(resolveAgentProvider(null, null, 'agent', 'agy')).toBe('agy')
    expect(resolveAgentProvider(undefined, undefined, 'note', 'opencode')).toBeUndefined()
    expect(resolveAgentProvider(undefined, undefined, 'workbench', 'opencode')).toBeUndefined()
    expect(resolveAgentProvider(undefined, undefined, 'agent', null)).toBeUndefined()
  })
})

