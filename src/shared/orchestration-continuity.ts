import type { AgentProviderId } from '../renderer/src/types'

/**
 * Contrato de continuidade multi-provedor do canvas.
 *
 * O estado é por projeto, persistido em `.devorbit/orchestration.json`, e
 * descreve papéis, assentos (provider/conta), checkpoint, próxima ação e o
 * histórico auditável de handoffs. A eleição de substituto é determinística e
 * NUNCA encerra um agente ativo: o handoff é uma decisão de estado/evento.
 */
export const ORCHESTRATION_ROLES = ['coordinator', 'implementer', 'reviewer', 'tester'] as const

export type OrchestrationRole = (typeof ORCHESTRATION_ROLES)[number]

export const ORCHESTRATION_ROLE_ORDER: readonly OrchestrationRole[] = [
  'coordinator',
  'implementer',
  'reviewer',
  'tester',
]

export const ORCHESTRATION_ROLE_LABELS: Record<OrchestrationRole, string> = {
  coordinator: 'Coordenador',
  implementer: 'Implementador',
  reviewer: 'Revisor',
  tester: 'Testes',
}

export const CONTINUITY_SEAT_STATES = ['active', 'handoff', 'exhausted', 'unassigned'] as const

export type ContinuitySeatState = (typeof CONTINUITY_SEAT_STATES)[number]

export const CONTINUITY_QUOTA_STATUSES = ['unknown', 'ok', 'warning', 'exhausted'] as const

export type ContinuityQuotaStatus = (typeof CONTINUITY_QUOTA_STATUSES)[number]

export type ContinuityQuotaSource = 'codex-oauth' | 'cli-signal' | 'manual'

export interface ContinuityQuota {
  status: ContinuityQuotaStatus
  source: ContinuityQuotaSource
  percent?: number
  resetAt?: string
  observedAt: string
  reason?: string
}

export interface ContinuitySeat {
  id: string
  provider: AgentProviderId
  account?: 'account1' | 'account2'
  model?: string
  tier?: 'fast' | 'deep'
  role: OrchestrationRole
  state: ContinuitySeatState
  quota: ContinuityQuota
  /** Falhas consecutivas de handoff (circuit breaker por assento). */
  failures: number
  circuitOpenUntil?: string
  updatedAt: string
}

export interface ContinuityRoleAssignment {
  role: OrchestrationRole
  seatId?: string
  state: ContinuitySeatState
  since: string
}

export interface ContinuityCheckpoint {
  at: string
  role: OrchestrationRole
  summary: string
  branch?: string
  commit?: string
}

export interface ContinuityNextAction {
  role: OrchestrationRole
  prompt: string
  createdAt: string
}

export const CONTINUITY_EVENT_TYPES = [
  'continuity.enabled',
  'continuity.disabled',
  'seat.registered',
  'seat.unregistered',
  'seat.role.changed',
  'quota.updated',
  'seat.circuit.open',
  'role.handoff',
  'role.vacated',
  'next-action.updated',
  'handoff.blocked',
] as const

export type ContinuityEventType = (typeof CONTINUITY_EVENT_TYPES)[number]

export interface ContinuityEvent {
  id: string
  at: string
  type: ContinuityEventType
  role?: OrchestrationRole
  fromSeatId?: string
  toSeatId?: string
  reason: string
  /** Ação a ser retomada pelo novo assento do papel. */
  nextAction?: { role: OrchestrationRole; prompt: string }
}

export interface ContinuityPolicy {
  /** Opt-in: desligado por padrão (kill switch). */
  enabled: boolean
  /** Invariante rígida: handoff nunca encerra PTY ativo. */
  preserveActiveAgents: true
  /** Ao esgotar, elege substituto para o MESMO papel. */
  escalateOnExhaustion: boolean
  /** Permite promover um assento que já ocupa outro papel (ex.: impl -> coord). */
  allowRoleEscalation: boolean
  cooldownMs: number
  maxHandoffsPerHour: number
  failureThreshold: number
  quotaWarningPercent: number
  quotaExhaustedPercent: number
  /** Providers elegíveis por papel; ausente = qualquer provider pronto. */
  eligibleProviders?: Partial<Record<OrchestrationRole, readonly AgentProviderId[]>>
}

export interface OrchestrationState {
  version: 1
  projectId: string
  updatedAt: string
  generation: number
  policy: ContinuityPolicy
  roles: Record<OrchestrationRole, ContinuityRoleAssignment>
  seats: Record<string, ContinuitySeat>
  checkpoint?: ContinuityCheckpoint
  nextAction?: ContinuityNextAction
  handoffCooldowns: Partial<Record<OrchestrationRole, string>>
  events: ContinuityEvent[]
}

export const CONTINUITY_MAX_EVENTS = 200
export const CONTINUITY_MAX_REASON_CHARS = 300
export const CONTINUITY_MAX_SUMMARY_CHARS = 1_000
export const CONTINUITY_MAX_PROMPT_CHARS = 8_000
export const CONTINUITY_MAX_SEATS = 64
export const CONTINUITY_DEFAULT_COOLDOWN_MS = 5 * 60_000
export const CONTINUITY_DEFAULT_MAX_HANDOFFS_PER_HOUR = 6
export const CONTINUITY_DEFAULT_FAILURE_THRESHOLD = 3
export const CONTINUITY_DEFAULT_WARNING_PERCENT = 80
export const CONTINUITY_DEFAULT_EXHAUSTED_PERCENT = 95

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/** Texto de evento/checkpoint: sem controles e limitado. */
export function sanitizeContinuityText(value: unknown, maxChars = CONTINUITY_MAX_REASON_CHARS): string {
  if (typeof value !== 'string') return ''
  const normalized = value.replace(/[\r\n\t]+/gu, ' ').trim()
  if (!normalized || hasControlCharacters(normalized)) {
    const stripped = [...normalized].filter((character) => {
      const code = character.charCodeAt(0)
      return code > 0x1f && code !== 0x7f
    }).join('')
    return stripped.slice(0, maxChars)
  }
  return normalized.slice(0, maxChars)
}

function isRole(value: unknown): value is OrchestrationRole {
  return typeof value === 'string' && (ORCHESTRATION_ROLES as readonly string[]).includes(value)
}

function isSeatState(value: unknown): value is ContinuitySeatState {
  return typeof value === 'string' && (CONTINUITY_SEAT_STATES as readonly string[]).includes(value)
}

function isQuotaStatus(value: unknown): value is ContinuityQuotaStatus {
  return typeof value === 'string' && (CONTINUITY_QUOTA_STATUSES as readonly string[]).includes(value)
}

function isEventType(value: unknown): value is ContinuityEventType {
  return typeof value === 'string' && (CONTINUITY_EVENT_TYPES as readonly string[]).includes(value)
}

function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined
}

function boundedPercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10))
}

export function defaultContinuityPolicy(): ContinuityPolicy {
  return {
    enabled: false,
    preserveActiveAgents: true,
    escalateOnExhaustion: true,
    allowRoleEscalation: true,
    cooldownMs: CONTINUITY_DEFAULT_COOLDOWN_MS,
    maxHandoffsPerHour: CONTINUITY_DEFAULT_MAX_HANDOFFS_PER_HOUR,
    failureThreshold: CONTINUITY_DEFAULT_FAILURE_THRESHOLD,
    quotaWarningPercent: CONTINUITY_DEFAULT_WARNING_PERCENT,
    quotaExhaustedPercent: CONTINUITY_DEFAULT_EXHAUSTED_PERCENT,
  }
}

function emptyRole(role: OrchestrationRole, now: string): ContinuityRoleAssignment {
  return { role, state: 'unassigned', since: now }
}

export function createEmptyOrchestrationState(projectId: string, now = new Date().toISOString()): OrchestrationState {
  return {
    version: 1,
    projectId,
    updatedAt: now,
    generation: 0,
    policy: defaultContinuityPolicy(),
    roles: {
      coordinator: emptyRole('coordinator', now),
      implementer: emptyRole('implementer', now),
      reviewer: emptyRole('reviewer', now),
      tester: emptyRole('tester', now),
    },
    seats: {},
    handoffCooldowns: {},
    events: [],
  }
}

function unknownQuota(now: string): ContinuityQuota {
  return { status: 'unknown', source: 'manual', observedAt: now }
}

function parseQuota(value: unknown, now: string): ContinuityQuota {
  if (!isRecord(value)) return unknownQuota(now)
  const status = isQuotaStatus(value.status) ? value.status : 'unknown'
  const source = value.source === 'codex-oauth' || value.source === 'cli-signal' || value.source === 'manual'
    ? value.source
    : 'manual'
  const percent = boundedPercent(value.percent)
  const resetAt = isoOrUndefined(value.resetAt)
  const reason = sanitizeContinuityText(value.reason)
  return {
    status,
    source,
    observedAt: isoOrUndefined(value.observedAt) ?? now,
    ...(percent !== undefined ? { percent } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(reason ? { reason } : {}),
  }
}

function parseSeat(value: unknown, now: string): ContinuitySeat | undefined {
  if (!isRecord(value)) return undefined
  const id = typeof value.id === 'string' ? value.id.trim().slice(0, 128) : ''
  const provider = typeof value.provider === 'string' ? value.provider.trim().slice(0, 64) : ''
  if (!id || !provider) return undefined
  const role = isRole(value.role) ? value.role : 'implementer'
  const state = isSeatState(value.state) ? value.state : 'unassigned'
  const account = value.account === 'account1' || value.account === 'account2' ? value.account : undefined
  const model = typeof value.model === 'string' && value.model.trim() ? value.model.trim().slice(0, 200) : undefined
  const tier = value.tier === 'fast' || value.tier === 'deep' ? value.tier : undefined
  const circuitOpenUntil = isoOrUndefined(value.circuitOpenUntil)
  const failures = typeof value.failures === 'number' && Number.isInteger(value.failures) && value.failures >= 0
    ? Math.min(value.failures, 1_000)
    : 0
  return {
    id,
    provider: provider as AgentProviderId,
    role,
    state,
    quota: parseQuota(value.quota, now),
    failures,
    updatedAt: isoOrUndefined(value.updatedAt) ?? now,
    ...(account ? { account } : {}),
    ...(model ? { model } : {}),
    ...(tier ? { tier } : {}),
    ...(circuitOpenUntil ? { circuitOpenUntil } : {}),
  }
}

function parseEvent(value: unknown, now: string): ContinuityEvent | undefined {
  if (!isRecord(value) || !isEventType(value.type)) return undefined
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim().slice(0, 80) : ''
  if (!id) return undefined
  const role = isRole(value.role) ? value.role : undefined
  const fromSeatId = typeof value.fromSeatId === 'string' ? value.fromSeatId.slice(0, 128) : undefined
  const toSeatId = typeof value.toSeatId === 'string' ? value.toSeatId.slice(0, 128) : undefined
  const reason = sanitizeContinuityText(value.reason) || 'evento'
  const nextActionRaw = isRecord(value.nextAction) ? value.nextAction : undefined
  const nextAction = nextActionRaw && isRole(nextActionRaw.role)
    ? { role: nextActionRaw.role, prompt: sanitizeContinuityText(nextActionRaw.prompt, CONTINUITY_MAX_PROMPT_CHARS) }
    : undefined
  return {
    id,
    at: isoOrUndefined(value.at) ?? now,
    type: value.type,
    reason,
    ...(role ? { role } : {}),
    ...(fromSeatId ? { fromSeatId } : {}),
    ...(toSeatId ? { toSeatId } : {}),
    ...(nextAction && nextAction.prompt ? { nextAction } : {}),
  }
}

/**
 * Normaliza o JSON persistido. Estado malformado vira estado vazio; o opt-in
 * (`policy.enabled`) só é preservado quando explicitamente `true`.
 */
export function parseOrchestrationState(input: unknown, projectId: string, now = new Date().toISOString()): OrchestrationState {
  const base = createEmptyOrchestrationState(projectId, now)
  if (!isRecord(input) || input.version !== 1 || typeof input.projectId !== 'string') return base
  if (input.projectId !== projectId) return base

  const policyInput = isRecord(input.policy) ? input.policy : {}
  const numeric = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
  const policy: ContinuityPolicy = {
    enabled: policyInput.enabled === true,
    preserveActiveAgents: true,
    escalateOnExhaustion: policyInput.escalateOnExhaustion !== false,
    allowRoleEscalation: policyInput.allowRoleEscalation !== false,
    cooldownMs: numeric(policyInput.cooldownMs, base.policy.cooldownMs, 0, 24 * 60 * 60_000),
    maxHandoffsPerHour: Math.floor(numeric(policyInput.maxHandoffsPerHour, base.policy.maxHandoffsPerHour, 0, 100)),
    failureThreshold: Math.floor(numeric(policyInput.failureThreshold, base.policy.failureThreshold, 1, 100)),
    quotaWarningPercent: numeric(policyInput.quotaWarningPercent, base.policy.quotaWarningPercent, 0, 100),
    quotaExhaustedPercent: numeric(policyInput.quotaExhaustedPercent, base.policy.quotaExhaustedPercent, 0, 100),
  }
  if (isRecord(policyInput.eligibleProviders)) {
    const eligible: Partial<Record<OrchestrationRole, readonly AgentProviderId[]>> = {}
    for (const role of ORCHESTRATION_ROLES) {
      const list = policyInput.eligibleProviders[role]
      if (!Array.isArray(list)) continue
      const providers = list
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim().slice(0, 64) as AgentProviderId)
        .slice(0, 16)
      if (providers.length > 0) eligible[role] = providers
    }
    if (Object.keys(eligible).length > 0) policy.eligibleProviders = eligible
  }

  const seats: Record<string, ContinuitySeat> = {}
  if (isRecord(input.seats)) {
    for (const entry of Object.values(input.seats).slice(0, CONTINUITY_MAX_SEATS)) {
      const seat = parseSeat(entry, now)
      if (seat) seats[seat.id] = seat
    }
  }

  const roles = { ...base.roles }
  if (isRecord(input.roles)) {
    for (const role of ORCHESTRATION_ROLES) {
      const raw = input.roles[role]
      if (!isRecord(raw)) continue
      const state = isSeatState(raw.state) ? raw.state : 'unassigned'
      const seatId = typeof raw.seatId === 'string' && seats[raw.seatId] ? raw.seatId : undefined
      roles[role] = { role, state, since: isoOrUndefined(raw.since) ?? now, ...(seatId ? { seatId } : {}) }
    }
  }

  const checkpointRaw = isRecord(input.checkpoint) ? input.checkpoint : undefined
  const checkpoint: ContinuityCheckpoint | undefined = checkpointRaw && isRole(checkpointRaw.role)
    ? {
        at: isoOrUndefined(checkpointRaw.at) ?? now,
        role: checkpointRaw.role,
        summary: sanitizeContinuityText(checkpointRaw.summary, CONTINUITY_MAX_SUMMARY_CHARS) || 'sem resumo',
        ...(typeof checkpointRaw.branch === 'string' ? { branch: checkpointRaw.branch.slice(0, 200) } : {}),
        ...(typeof checkpointRaw.commit === 'string' ? { commit: checkpointRaw.commit.slice(0, 200) } : {}),
      }
    : undefined

  const nextRaw = isRecord(input.nextAction) ? input.nextAction : undefined
  const nextAction: ContinuityNextAction | undefined = nextRaw && isRole(nextRaw.role)
    ? {
        role: nextRaw.role,
        prompt: sanitizeContinuityText(nextRaw.prompt, CONTINUITY_MAX_PROMPT_CHARS),
        createdAt: isoOrUndefined(nextRaw.createdAt) ?? now,
      }
    : undefined

  const handoffCooldowns: Partial<Record<OrchestrationRole, string>> = {}
  if (isRecord(input.handoffCooldowns)) {
    for (const role of ORCHESTRATION_ROLES) {
      const value = isoOrUndefined(input.handoffCooldowns[role])
      if (value) handoffCooldowns[role] = value
    }
  }

  const events: ContinuityEvent[] = []
  if (Array.isArray(input.events)) {
    for (const entry of input.events.slice(-CONTINUITY_MAX_EVENTS)) {
      const event = parseEvent(entry, now)
      if (event) events.push(event)
    }
  }

  return {
    version: 1,
    projectId,
    updatedAt: isoOrUndefined(input.updatedAt) ?? now,
    generation: typeof input.generation === 'number' && Number.isInteger(input.generation) && input.generation >= 0
      ? input.generation
      : 0,
    policy,
    roles,
    seats,
    handoffCooldowns,
    events,
    ...(checkpoint ? { checkpoint } : {}),
    ...(nextAction && nextAction.prompt ? { nextAction } : {}),
  }
}
