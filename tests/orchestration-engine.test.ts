import { describe, expect, it } from 'vitest'
import {
  createEmptyOrchestrationState,
  type OrchestrationState,
} from '../src/shared/orchestration-continuity'
import {
  assignRole,
  electSubstitute,
  planHandoff,
  recordCheckpoint,
  reportSeatFailure,
  reportSeatSuccess,
  setEnabled,
  updateQuota,
  upsertSeat,
  type EngineContext,
  type SeatInput,
} from '../src/main/orchestration-engine'

function makeContext(now: number, ready: (provider: string) => boolean = () => true): EngineContext {
  let sequence = 0
  return {
    now,
    id: () => `evt-${++sequence}`,
    isProviderReady: (provider) => ready(provider),
  }
}

function seed(): OrchestrationState {
  const ctx = makeContext(1_000)
  let state = createEmptyOrchestrationState('proj', new Date(1_000).toISOString())
  const seats: SeatInput[] = [
    { id: 'coord-codex-1', provider: 'codex', account: 'account1', role: 'coordinator' },
    { id: 'impl-codex-2', provider: 'codex', account: 'account2', role: 'implementer' },
    { id: 'review-agy', provider: 'agy', role: 'reviewer' },
    { id: 'test-opencode', provider: 'opencode', role: 'tester' },
  ]
  for (const seat of seats) state = upsertSeat(state, seat, ctx).state
  state = assignRole(state, 'coordinator', 'coord-codex-1', ctx).state
  state = assignRole(state, 'implementer', 'impl-codex-2', ctx).state
  state = assignRole(state, 'reviewer', 'review-agy', ctx).state
  state = assignRole(state, 'tester', 'test-opencode', ctx).state
  return state
}

function exhaust(state: OrchestrationState, seatId: string, now: number): OrchestrationState {
  const ctx = makeContext(now)
  return updateQuota(state, seatId, { status: 'exhausted', source: 'codex-oauth', observedAt: new Date(now).toISOString(), percent: 99 }, ctx).state
}

describe('orchestration engine · opt-in e eleição determinística', () => {
  it('não faz handoff enquanto a continuidade está desligada (opt-in)', () => {
    const state = exhaust(seed(), 'coord-codex-1', 2_000)
    const result = planHandoff(state, 'coord-codex-1', makeContext(2_000))
    expect(result.blocked).toBe('disabled')
    expect(result.handoff).toBeUndefined()
    expect(result.state.roles.coordinator.seatId).toBe('coord-codex-1')
  })

  it('esgota o coordenador Codex e promove o implementador Codex (mesmo papel)', () => {
    let state = setEnabled(seed(), true, makeContext(1_500)).state
    state = exhaust(state, 'coord-codex-1', 2_000)
    const result = planHandoff(state, 'coord-codex-1', makeContext(2_000))

    expect(result.handoff).toMatchObject({
      role: 'coordinator',
      fromSeatId: 'coord-codex-1',
      toSeatId: 'impl-codex-2',
      vacatedRole: 'implementer',
    })
    expect(result.state.roles.coordinator.seatId).toBe('impl-codex-2')
    expect(result.state.seats['impl-codex-2'].role).toBe('coordinator')
    // O papel anterior fica vago; nenhum agente ativo é encerrado.
    expect(result.state.roles.implementer.seatId).toBeUndefined()
    expect(result.state.roles.implementer.state).toBe('unassigned')
    // Agentes que não trocaram preservam papel/estado.
    expect(result.state.seats['review-agy'].role).toBe('reviewer')
    expect(result.state.seats['test-opencode'].role).toBe('tester')
    expect(result.state.events.at(-1)).toMatchObject({ type: 'role.handoff', toSeatId: 'impl-codex-2' })
  })

  it('sintetiza nextAction a partir do checkpoint quando não há prompt explícito', () => {
    let state = setEnabled(seed(), true, makeContext(1_500)).state
    state = recordCheckpoint(state, {
      at: new Date(1_600).toISOString(),
      role: 'coordinator',
      summary: 'Plano inicial validado',
    }, makeContext(1_600)).state
    state = exhaust(state, 'coord-codex-1', 2_000)
    const result = planHandoff(state, 'coord-codex-1', makeContext(2_000))
    expect(result.handoff?.nextAction?.prompt).toContain('Plano inicial validado')
    expect(result.state.nextAction?.prompt).toContain('Plano inicial validado')
    expect(result.state.nextAction?.role).toBe('coordinator')
  })

  it('a eleição é determinística (mesmo estado -> mesmo assento)', () => {
    const state = setEnabled(seed(), true, makeContext(1_500)).state
    const first = electSubstitute(state, 'coordinator', makeContext(2_000), 'coord-codex-1')
    const second = electSubstitute(state, 'coordinator', makeContext(2_000), 'coord-codex-1')
    expect(first.seat?.id).toBe('impl-codex-2')
    expect(second.seat?.id).toBe(first.seat?.id)
  })

  it('ignora candidatos com provider indisponível ou quota esgotada', () => {
    let state = setEnabled(seed(), true, makeContext(1_500)).state
    state = exhaust(state, 'impl-codex-2', 2_000)
    const election = electSubstitute(state, 'coordinator', makeContext(2_000), 'coord-codex-1')
    // Codex esgotado; sobra agy (reviewer) por escalonamento.
    expect(election.seat?.id).toBe('review-agy')

    const noProvider = makeContext(2_000, (provider) => provider !== 'agy')
    const blocked = electSubstitute(state, 'coordinator', noProvider, 'coord-codex-1')
    expect(blocked.seat?.id).toBe('test-opencode')
  })
})

describe('orchestration engine · limites, cooldown e circuit breaker', () => {
  it('bloqueia handoff dentro do cooldown do papel', () => {
    let state = setEnabled(seed(), true, makeContext(1_500)).state
    state = exhaust(state, 'coord-codex-1', 2_000)
    const first = planHandoff(state, 'coord-codex-1', makeContext(2_000))
    expect(first.handoff).toBeDefined()
    state = first.state
    // O novo coordenador também esgota imediatamente: cooldown bloqueia.
    state = exhaust(state, 'impl-codex-2', 2_100)
    const second = planHandoff(state, 'impl-codex-2', makeContext(2_100))
    expect(second.blocked).toBe('cooldown')
  })

  it('respeita o limite de handoffs por hora', () => {
    let state = setEnabled(seed(), true, makeContext(1_500)).state
    state = { ...state, policy: { ...state.policy, cooldownMs: 0, maxHandoffsPerHour: 1 } }
    state = exhaust(state, 'coord-codex-1', 2_000)
    state = planHandoff(state, 'coord-codex-1', makeContext(2_000)).state
    state = exhaust(state, 'impl-codex-2', 2_100)
    const blocked = planHandoff(state, 'impl-codex-2', makeContext(2_100))
    expect(blocked.blocked).toBe('max-handoffs')
  })

  it('abre circuit breaker após falhas e recupera após cooldown', () => {
    const ctx = makeContext(1_000)
    let state = seed()
    state = setEnabled(state, true, makeContext(1_500)).state
    for (let index = 0; index < state.policy.failureThreshold; index += 1) {
      state = reportSeatFailure(state, 'impl-codex-2', makeContext(2_000 + index)).state
    }
    expect(state.seats['impl-codex-2'].state).toBe('exhausted')
    expect(state.seats['impl-codex-2'].circuitOpenUntil).toBeDefined()

    const electionDuringOpen = electSubstitute(state, 'coordinator', makeContext(2_500), 'coord-codex-1')
    expect(electionDuringOpen.seat?.id).not.toBe('impl-codex-2')

    // Recuperação: sucesso limpa o breaker e quota ok reativa o assento.
    state = reportSeatSuccess(state, 'impl-codex-2').state
    state = updateQuota(state, 'impl-codex-2', { status: 'ok', source: 'manual', observedAt: new Date(3_000).toISOString(), percent: 10 }, makeContext(3_000)).state
    expect(state.seats['impl-codex-2'].state).toBe('active')
    expect(state.seats['impl-codex-2'].circuitOpenUntil).toBeUndefined()
    expect(ctx.now).toBe(1_000)
  })
})
