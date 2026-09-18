import type { AgentProvider, AgentProviderId, CodexAccountStatus } from '../types'

export type AgentCreationRole = 'Coordenador' | 'Implementação' | 'Revisão' | 'Testes'
export type AgentAccountId = 'account1' | 'account2'

export interface AgentCreationSpec {
  role: AgentCreationRole
  provider: AgentProviderId | null
  account: AgentAccountId | null
}

export interface SquadCreationSpec {
  title: string
  participants: AgentCreationSpec[]
}

const AGENT_PROVIDER_IDS: readonly AgentProviderId[] = ['codex', 'opencode', 'claude', 'gemini', 'aider', 'agy', 'custom']

function isAgentProvider(value: unknown): value is AgentProviderId {
  return typeof value === 'string' && (AGENT_PROVIDER_IDS as readonly string[]).includes(value)
}

/**
 * Provider efetivo de um nó: escolha explícita vence, fallback do nó hidratado
 * vem depois, e o executor padrão só preenche nó de agente sem provider —
 * nunca sobrescreve uma escolha existente.
 */
export function resolveAgentProvider(
  explicit: unknown,
  fallback: unknown,
  kind: string,
  defaultProvider: AgentProviderId | null,
): AgentProviderId | undefined {
  if (isAgentProvider(explicit)) return explicit
  if (isAgentProvider(fallback)) return fallback
  return kind === 'agent' && defaultProvider ? defaultProvider : undefined
}

export function isReadyProvider(
  providers: readonly AgentProvider[],
  provider: AgentProviderId | null,
): boolean {
  return Boolean(provider && providers.some((item) => item.id === provider && item.state === 'ready'))
}

export function requiresCodexAccount(provider: AgentProviderId | null): boolean {
  return provider === 'codex'
}

export function isCodexAccountConnected(
  status: CodexAccountStatus | null | undefined,
  account: AgentAccountId | null,
): boolean {
  return Boolean(account && status?.[account]?.connected)
}

export function canSubmitAgentCreation(
  spec: AgentCreationSpec,
  providers: readonly AgentProvider[],
): boolean {
  if (!isReadyProvider(providers, spec.provider)) return false
  return !requiresCodexAccount(spec.provider) || spec.account !== null
}

export function canSubmitSquadCreation(
  spec: SquadCreationSpec,
  providers: readonly AgentProvider[],
): boolean {
  const title = spec.title.trim()
  if (!title || spec.participants.length === 0) return false
  return spec.participants.every((participant) => canSubmitAgentCreation(participant, providers))
}

export interface AgentNodeConfiguration {
  provider?: AgentProviderId | null
  account?: AgentAccountId | null
}

export type AgentNodeBlocker = 'provider-missing' | 'provider-not-ready' | 'account-missing'

export const agentNodeBlockedLabel = 'Configure provider e conta'

export function agentNodeBlockers(
  node: AgentNodeConfiguration,
  providers: readonly AgentProvider[],
): AgentNodeBlocker[] {
  const blockers: AgentNodeBlocker[] = []
  if (!node.provider) blockers.push('provider-missing')
  else if (!isReadyProvider(providers, node.provider)) blockers.push('provider-not-ready')
  if (requiresCodexAccount(node.provider ?? null) && !node.account) blockers.push('account-missing')
  return blockers
}

export function isAgentNodeConfigured(
  node: AgentNodeConfiguration,
  providers: readonly AgentProvider[],
): boolean {
  return agentNodeBlockers(node, providers).length === 0
}

export function agentNodeSetupMessage(
  node: AgentNodeConfiguration,
  providers: readonly AgentProvider[],
): string {
  const blockers = agentNodeBlockers(node, providers)
  if (!blockers.length) return ''
  if (blockers.includes('provider-missing')) {
    return 'Configure o provider e a conta Codex deste agente para ativá-lo.'
  }
  if (blockers.includes('provider-not-ready')) {
    return 'O provider selecionado não está pronto. Escolha um provider disponível para ativar este agente.'
  }
  return 'Configure a conta Codex deste agente para ativá-lo.'
}

