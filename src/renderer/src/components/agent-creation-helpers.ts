import type { AgentProvider, AgentProviderId, CodexAccountStatus } from '../types'

/**
 * Papéis built-in têm semântica de orquestração (Coordenador dispara o fluxo;
 * Implementação/Revisão/Testes ordenam a fila). Qualquer outro texto é papel
 * custom: participa como especialista neutro, nunca vira Coordenador e nunca
 * é reescrito para "Implementação".
 */
export const BUILT_IN_AGENT_ROLES = ['Coordenador', 'Implementação', 'Revisão', 'Testes'] as const
export type BuiltInAgentRole = (typeof BUILT_IN_AGENT_ROLES)[number]
export type AgentCreationRole = string
export type AgentAccountId = 'account1' | 'account2'

export const AGENT_ROLE_MAX_LENGTH = 40
export const DEFAULT_AGENT_ROLE = 'Implementação'

export function isBuiltInAgentRole(value: unknown): value is BuiltInAgentRole {
  return typeof value === 'string' && (BUILT_IN_AGENT_ROLES as readonly string[]).includes(value)
}

export function isCoordinatorRole(role: unknown): boolean {
  return role === 'Coordenador'
}

/** Papel de nó: string livre saneada; vazio vira o default built-in. */
export function sanitizeAgentRole(value: unknown, fallback: string = DEFAULT_AGENT_ROLE): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim().slice(0, AGENT_ROLE_MAX_LENGTH)
  return trimmed || fallback
}

export interface AgentCreationSpec {
  role: AgentCreationRole
  provider: AgentProviderId | null
  account: AgentAccountId | null
  /** Nome opcional do cartão; default derivado do papel. */
  title?: string
}

export interface SquadCreationSpec {
  title: string
  objective?: string
  participants: AgentCreationSpec[]
  /**
   * Índice do participante que coordena o squad. `undefined` preserva o
   * default legado (0) para chamadas antigas; `null` cria o squad SEM
   * coordenador (função explicitamente vazia, configurável depois). O
   * coordenador nunca é inferido por papel nem promovido automaticamente.
   */
  coordinatorIndex?: number | null
}

export type SquadCoordinatorResolution =
  | { valid: true; index: number | null }
  | { valid: false }

export function resolveSquadCoordinator(spec: SquadCreationSpec): SquadCoordinatorResolution {
  if (spec.participants.length === 0) return { valid: false }
  if (spec.coordinatorIndex === null) return { valid: true, index: null }
  const raw = spec.coordinatorIndex ?? 0
  if (!Number.isInteger(raw) || raw < 0 || raw >= spec.participants.length) return { valid: false }
  return { valid: true, index: raw }
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
  if (!spec.role.trim()) return false
  if (!isReadyProvider(providers, spec.provider)) return false
  return !requiresCodexAccount(spec.provider) || spec.account !== null
}

/**
 * Squad exige título, ao menos um participante, coordenador explícito em
 * índice válido e configuração completa de cada membro. Sem teto artificial
 * de membros (2, 3, 5+ valem igual).
 */
export function canSubmitSquadCreation(
  spec: SquadCreationSpec,
  providers: readonly AgentProvider[],
): boolean {
  const title = spec.title.trim()
  if (!title || spec.participants.length === 0) return false
  if (!resolveSquadCoordinator(spec).valid) return false
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

