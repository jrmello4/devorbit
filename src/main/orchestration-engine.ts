import { randomUUID } from 'node:crypto'
import type { AgentProviderId } from '../renderer/src/types'
import {
  CONTINUITY_MAX_EVENTS,
  CONTINUITY_MAX_PROMPT_CHARS,
  CONTINUITY_MAX_SUMMARY_CHARS,
  ORCHESTRATION_ROLES,
  type ContinuityCheckpoint,
  type ContinuityEvent,
  type ContinuityEventType,
  type ContinuityNextAction,
  type ContinuityQuota,
  type ContinuitySeat,
  type ContinuitySeatState,
  type OrchestrationRole,
  type OrchestrationState,
  sanitizeContinuityText,
} from '../shared/orchestration-continuity'

export interface EngineContext {
  now: number
  id?: () => string
  /** Saúde do provider; ausente = todos prontos (útil em testes puros). */
  isProviderReady?: (provider: AgentProviderId) => boolean
}

export interface EngineResult {
  state: OrchestrationState
  events: ContinuityEvent[]
}

export interface SeatInput {
  id: string
  provider: AgentProviderId
  role: OrchestrationRole
  account?: 'account1' | 'account2'
  model?: string
  tier?: 'fast' | 'deep'
}

export type HandoffBlockedReason =
  | 'disabled'
  | 'cooldown'
  | 'max-handoffs'
  | 'no-candidate'
  | 'escalation-blocked'

export interface HandoffPlan {
  role: OrchestrationRole
  fromSeatId: string
  toSeatId: string
  vacatedRole?: OrchestrationRole
  nextAction?: ContinuityNextAction
}

export interface HandoffResult extends EngineResult {
  handoff?: HandoffPlan
  blocked?: HandoffBlockedReason
}

function eventId(ctx: EngineContext): string {
  return ctx.id ? ctx.id() : randomUUID()
}

function nowIso(ctx: EngineContext): string {
  return new Date(ctx.now).toISOString()
}

function appendEvents(state: OrchestrationState, additions: ContinuityEvent[]): ContinuityEvent[] {
  if (additions.length === 0) return []
  state.events = [...state.events, ...additions].slice(-CONTINUITY_MAX_EVENTS)
  return additions
}

function commit(state: OrchestrationState, additions: ContinuityEvent[], ctx: EngineContext): EngineResult {
  const events = appendEvents(state, additions)
  state.generation += 1
  state.updatedAt = nowIso(ctx)
  return { state, events }
}

function makeEvent(
  type: ContinuityEventType,
  reason: string,
  ctx: EngineContext,
  extra: Partial<Pick<ContinuityEvent, 'role' | 'fromSeatId' | 'toSeatId' | 'nextAction'>> = {},
): ContinuityEvent {
  return {
    id: eventId(ctx),
    at: nowIso(ctx),
    type,
    reason: sanitizeContinuityText(reason) || type,
    ...extra,
  }
}

function cloneSeat(seat: ContinuitySeat): ContinuitySeat {
  return { ...seat, quota: { ...seat.quota } }
}

function cloneState(state: OrchestrationState): OrchestrationState {
  return {
    ...state,
    policy: { ...state.policy, ...(state.policy.eligibleProviders ? { eligibleProviders: { ...state.policy.eligibleProviders } } : {}) },
    roles: { ...state.roles, coordinator: { ...state.roles.coordinator }, implementer: { ...state.roles.implementer }, reviewer: { ...state.roles.reviewer }, tester: { ...state.roles.tester } },
    seats: Object.fromEntries(Object.entries(state.seats).map(([id, seat]) => [id, cloneSeat(seat)])),
    handoffCooldowns: { ...state.handoffCooldowns },
    events: state.events.slice(),
  }
}

function providerAllowed(state: OrchestrationState, role: OrchestrationRole, provider: AgentProviderId): boolean {
  const list = state.policy.eligibleProviders?.[role]
  return !list || list.includes(provider)
}

function circuitOpen(seat: ContinuitySeat, now: number): boolean {
  if (!seat.circuitOpenUntil) return false
  const until = Date.parse(seat.circuitOpenUntil)
  return Number.isFinite(until) && until > now
}

function isReady(ctx: EngineContext, provider: AgentProviderId): boolean {
  return ctx.isProviderReady ? ctx.isProviderReady(provider) : true
}

export function roleSeat(state: OrchestrationState, role: OrchestrationRole): ContinuitySeat | undefined {
  const seatId = state.roles[role].seatId
  return seatId ? state.seats[seatId] : undefined
}

function eligibleSeats(
  state: OrchestrationState,
  role: OrchestrationRole,
  ctx: EngineContext,
  excludeSeatId?: string,
): ContinuitySeat[] {
  return Object.values(state.seats).filter((seat) => {
    if (seat.id === excludeSeatId) return false
    if (seat.quota.status === 'exhausted') return false
    if (circuitOpen(seat, ctx.now)) return false
    if (!isReady(ctx, seat.provider)) return false
    if (!providerAllowed(state, role, seat.provider)) return false
    if (seat.role !== role) {
      // Trocar de papel exige escalonamento explícito.
      if (!state.policy.allowRoleEscalation) return false
    }
    return true
  })
}

/** Ordenação determinística de elegibilidade. */
function rankSeats(seats: ContinuitySeat[], exhausted: ContinuitySeat): ContinuitySeat[] {
  return [...seats].sort((left, right) => {
    const sameProvider = Number(left.provider === exhausted.provider) - Number(right.provider === exhausted.provider)
    if (sameProvider !== 0) return -sameProvider
    const otherAccountLeft = left.provider === exhausted.provider && left.account !== exhausted.account ? 0 : 1
    const otherAccountRight = right.provider === exhausted.provider && right.account !== exhausted.account ? 0 : 1
    if (otherAccountLeft !== otherAccountRight) return otherAccountLeft - otherAccountRight
    const activeLeft = left.state === 'active' ? 0 : 1
    const activeRight = right.state === 'active' ? 0 : 1
    if (activeLeft !== activeRight) return activeLeft - activeRight
    if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? -1 : 1
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

export function electSubstitute(
  state: OrchestrationState,
  role: OrchestrationRole,
  ctx: EngineContext,
  excludeSeatId?: string,
): { seat?: ContinuitySeat; rationale: string; blocked?: HandoffBlockedReason } {
  const all = Object.values(state.seats)
  const candidates = eligibleSeats(state, role, ctx, excludeSeatId)
  if (candidates.length === 0) {
    const anyHealthy = all.some((seat) => seat.id !== excludeSeatId && seat.quota.status !== 'exhausted' && !circuitOpen(seat, ctx.now) && isReady(ctx, seat.provider))
    return { rationale: anyHealthy ? 'sem candidato elegível para o papel' : 'todos os assentos esgotados ou em circuit breaker', blocked: 'no-candidate' }
  }
  const [best] = rankSeats(candidates, state.seats[excludeSeatId ?? ''] ?? candidates[0])
  return { seat: best, rationale: `assento ${best.id} (${best.provider}${best.account ? ':' + best.account : ''}) eleito para ${role}` }
}

function handoffsInLastHour(state: OrchestrationState, role: OrchestrationRole, now: number): number {
  const cutoff = now - 60 * 60_000
  return state.events.filter((event) => event.type === 'role.handoff' && event.role === role && Date.parse(event.at) >= cutoff).length
}

export function setEnabled(state: OrchestrationState, enabled: boolean, ctx: EngineContext): EngineResult {
  const next = cloneState(state)
  next.policy.enabled = enabled === true
  return commit(next, [makeEvent(enabled ? 'continuity.enabled' : 'continuity.disabled', enabled ? 'Continuidade habilitada.' : 'Continuidade desabilitada.', ctx)], ctx)
}

export function upsertSeat(state: OrchestrationState, input: SeatInput, ctx: EngineContext): EngineResult {
  const next = cloneState(state)
  const existing = next.seats[input.id]
  const role = input.role
  if (existing) {
    const roleChanged = existing.role !== role
    existing.provider = input.provider
    existing.role = role
    existing.updatedAt = nowIso(ctx)
    if (input.account) existing.account = input.account
    if (input.model) existing.model = input.model
    if (input.tier) existing.tier = input.tier
    return commit(next, roleChanged
      ? [makeEvent('seat.role.changed', `Assento ${input.id} agora é ${role}.`, ctx, { role, toSeatId: input.id })]
      : [], ctx)
  }
  next.seats[input.id] = {
    id: input.id,
    provider: input.provider,
    role,
    state: 'active',
    quota: { status: 'unknown', source: 'manual', observedAt: nowIso(ctx) },
    failures: 0,
    updatedAt: nowIso(ctx),
    ...(input.account ? { account: input.account } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.tier ? { tier: input.tier } : {}),
  }
  return commit(next, [makeEvent('seat.registered', `Assento ${input.id} registrado para ${role}.`, ctx, { role, toSeatId: input.id })], ctx)
}

export function removeSeat(state: OrchestrationState, seatId: string, ctx: EngineContext): EngineResult {
  const next = cloneState(state)
  const seat = next.seats[seatId]
  if (!seat) return { state: next, events: [] }
  delete next.seats[seatId]
  const events = [makeEvent('seat.unregistered', `Assento ${seatId} removido.`, ctx, { role: seat.role, fromSeatId: seatId })]
  for (const role of ORCHESTRATION_ROLES) {
    if (next.roles[role].seatId === seatId) {
      next.roles[role] = { role, state: 'unassigned', since: nowIso(ctx) }
      events.push(makeEvent('role.vacated', `Papel ${role} ficou vago.`, ctx, { role, fromSeatId: seatId }))
    }
  }
  return commit(next, events, ctx)
}

export function assignRole(state: OrchestrationState, role: OrchestrationRole, seatId: string | undefined, ctx: EngineContext): EngineResult {
  const next = cloneState(state)
  if (seatId && !next.seats[seatId]) return { state: next, events: [] }
  const previous = next.roles[role].seatId
  next.roles[role] = { role, state: seatId ? 'active' : 'unassigned', since: nowIso(ctx), ...(seatId ? { seatId } : {}) }
  if (seatId) next.seats[seatId].role = role
  return commit(next, [makeEvent('seat.role.changed', `Papel ${role} atribuído a ${seatId ?? 'ninguém'}.`, ctx, {
    role,
    ...(previous ? { fromSeatId: previous } : {}),
    ...(seatId ? { toSeatId: seatId } : {}),
  })], ctx)
}

export function updateQuota(state: OrchestrationState, seatId: string, quota: ContinuityQuota, ctx: EngineContext): EngineResult {
  const next = cloneState(state)
  const seat = next.seats[seatId]
  if (!seat) return { state: next, events: [] }
  seat.quota = quota
  seat.updatedAt = nowIso(ctx)
  if (quota.status === 'exhausted') seat.state = 'exhausted'
  else if (seat.state === 'exhausted') seat.state = 'active'
  return commit(next, [makeEvent('quota.updated', `Quota de ${seatId}: ${quota.status}${quota.percent !== undefined ? ` (${quota.percent}%)` : ''}.`, ctx, { role: seat.role, fromSeatId: seatId })], ctx)
}

export function recordCheckpoint(state: OrchestrationState, checkpoint: ContinuityCheckpoint, ctx: EngineContext): EngineResult {
  const next = cloneState(state)
  next.checkpoint = {
    at: checkpoint.at,
    role: checkpoint.role,
    summary: sanitizeContinuityText(checkpoint.summary, CONTINUITY_MAX_SUMMARY_CHARS) || 'sem resumo',
    ...(checkpoint.branch ? { branch: checkpoint.branch.slice(0, 200) } : {}),
    ...(checkpoint.commit ? { commit: checkpoint.commit.slice(0, 200) } : {}),
  }
  return commit(next, [], ctx)
}

export function setNextAction(state: OrchestrationState, nextAction: ContinuityNextAction | undefined, ctx: EngineContext): EngineResult {
  const next = cloneState(state)
  if (!nextAction || !nextAction.prompt.trim()) {
    delete next.nextAction
    return commit(next, [], ctx)
  }
  next.nextAction = {
    role: nextAction.role,
    prompt: sanitizeContinuityText(nextAction.prompt, CONTINUITY_MAX_PROMPT_CHARS),
    createdAt: nextAction.createdAt || nowIso(ctx),
  }
  return commit(next, [makeEvent('next-action.updated', `Próxima ação registrada para ${nextAction.role}.`, ctx, { role: nextAction.role, nextAction: { role: nextAction.role, prompt: next.nextAction.prompt } })], ctx)
}

export function reportSeatFailure(state: OrchestrationState, seatId: string, ctx: EngineContext): EngineResult {
  const next = cloneState(state)
  const seat = next.seats[seatId]
  if (!seat) return { state: next, events: [] }
  seat.failures += 1
  seat.updatedAt = nowIso(ctx)
  if (seat.failures >= next.policy.failureThreshold) {
    seat.circuitOpenUntil = new Date(ctx.now + next.policy.cooldownMs).toISOString()
    seat.state = 'exhausted'
    return commit(next, [makeEvent('seat.circuit.open', `Assento ${seatId} entrou em circuit breaker após ${seat.failures} falhas.`, ctx, { role: seat.role, fromSeatId: seatId })], ctx)
  }
  return commit(next, [], ctx)
}

export function reportSeatSuccess(state: OrchestrationState, seatId: string): EngineResult {
  const next = cloneState(state)
  const seat = next.seats[seatId]
  if (!seat) return { state: next, events: [] }
  if (seat.failures !== 0 || seat.circuitOpenUntil) {
    seat.failures = 0
    delete seat.circuitOpenUntil
  }
  return { state: next, events: [] }
}

function vacateUnassigned(next: OrchestrationState): void {
  for (const role of ORCHESTRATION_ROLES) {
    const seatId = next.roles[role].seatId
    if (seatId && !next.seats[seatId]) {
      next.roles[role] = { role, state: 'unassigned', since: next.updatedAt }
    }
  }
}

/**
 * Sem prompt explícito, o handoff retoma a partir do checkpoint registrado
 * (última tarefa concluída). Garante que o evento carregue um prompt acionável.
 */
function synthesizeNextAction(
  state: OrchestrationState,
  role: OrchestrationRole,
  ctx: EngineContext,
): ContinuityNextAction | undefined {
  const summary = sanitizeContinuityText(state.checkpoint?.summary, CONTINUITY_MAX_SUMMARY_CHARS)
  if (!summary) return undefined
  const prompt = sanitizeContinuityText(
    `Retome o papel ${role} a partir do checkpoint. Resumo: ${summary}`,
    CONTINUITY_MAX_PROMPT_CHARS,
  )
  if (!prompt) return undefined
  return { role, prompt, createdAt: new Date(ctx.now).toISOString() }
}

/**
 * Planeja o handoff de um assento esgotado para o MESMO papel. Nunca encerra
 * agentes: apenas atualiza estado, papéis e emite eventos auditáveis.
 */
export function planHandoff(state: OrchestrationState, exhaustedSeatId: string, ctx: EngineContext): HandoffResult {
  if (!state.policy.enabled) return { state, events: [], blocked: 'disabled' }
  const exhausted = state.seats[exhaustedSeatId]
  if (!exhausted) return { state, events: [], blocked: 'no-candidate' }
  const role = exhausted.role

  const cooldownUntil = state.handoffCooldowns[role]
  if (cooldownUntil && Date.parse(cooldownUntil) > ctx.now) {
    const next = cloneState(state)
    return { ...commit(next, [makeEvent('handoff.blocked', `Handoff de ${role} em cooldown até ${cooldownUntil}.`, ctx, { role, fromSeatId: exhaustedSeatId })], ctx), blocked: 'cooldown' }
  }
  if (handoffsInLastHour(state, role, ctx.now) >= state.policy.maxHandoffsPerHour) {
    const next = cloneState(state)
    return { ...commit(next, [makeEvent('handoff.blocked', `Limite de handoffs por hora para ${role} atingido.`, ctx, { role, fromSeatId: exhaustedSeatId })], ctx), blocked: 'max-handoffs' }
  }

  const election = electSubstitute(state, role, ctx, exhaustedSeatId)
  if (!election.seat) {
    const next = cloneState(state)
    next.seats[exhaustedSeatId].state = 'exhausted'
    next.seats[exhaustedSeatId].quota = { ...next.seats[exhaustedSeatId].quota, status: 'exhausted' }
    return { ...commit(next, [makeEvent('handoff.blocked', election.rationale, ctx, { role, fromSeatId: exhaustedSeatId })], ctx), blocked: election.blocked ?? 'no-candidate' }
  }

  const substitute = election.seat
  const next = cloneState(state)
  const exhaustedNext = next.seats[exhaustedSeatId]
  exhaustedNext.state = 'exhausted'
  exhaustedNext.quota = { ...exhaustedNext.quota, status: 'exhausted' }

  const events: ContinuityEvent[] = []
  const substituteNext = next.seats[substitute.id]
  const vacatedRole = substituteNext.role !== role ? substituteNext.role : undefined
  const explicitNextAction = next.nextAction && next.nextAction.role === role ? next.nextAction : undefined
  const nextAction = explicitNextAction ?? synthesizeNextAction(next, role, ctx)
  if (nextAction) next.nextAction = nextAction

  substituteNext.role = role
  substituteNext.state = 'active'
  substituteNext.failures = 0
  delete substituteNext.circuitOpenUntil
  substituteNext.updatedAt = nowIso(ctx)

  next.roles[role] = { role, seatId: substitute.id, state: 'active', since: nowIso(ctx) }
  if (vacatedRole) {
    next.roles[vacatedRole] = { role: vacatedRole, state: 'unassigned', since: nowIso(ctx) }
    events.push(makeEvent('role.vacated', `Papel ${vacatedRole} liberado por escalonamento de ${substitute.id}.`, ctx, { role: vacatedRole, fromSeatId: substitute.id }))
  }

  next.handoffCooldowns[role] = new Date(ctx.now + next.policy.cooldownMs).toISOString()
  events.push(makeEvent('role.handoff', `${election.rationale}. ${next.policy.preserveActiveAgents ? 'Nenhum agente ativo foi encerrado.' : ''}`.trim(), ctx, {
    role,
    fromSeatId: exhaustedSeatId,
    toSeatId: substitute.id,
    ...(nextAction ? { nextAction: { role, prompt: nextAction.prompt } } : {}),
  }))

  vacateUnassigned(next)
  const committed = commit(next, events, ctx)
  return {
    ...committed,
    handoff: { role, fromSeatId: exhaustedSeatId, toSeatId: substitute.id, ...(vacatedRole ? { vacatedRole } : {}), ...(nextAction ? { nextAction } : {}) },
  }
}

export function seatStateForQuota(state: OrchestrationState, percent: number): ContinuitySeatState {
  if (percent >= state.policy.quotaExhaustedPercent) return 'exhausted'
  return 'active'
}
