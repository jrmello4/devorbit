import type { AgentProviderId, RealUsageState } from '../renderer/src/types'
import {
  type ContinuityEvent,
  type ContinuityQuota,
  type OrchestrationRole,
  type OrchestrationState,
} from '../shared/orchestration-continuity'
import {
  assignRole,
  planHandoff,
  recordCheckpoint,
  removeSeat,
  reportSeatFailure,
  reportSeatSuccess,
  setEnabled,
  updateQuota,
  upsertSeat,
  type EngineContext,
  type EngineResult,
  type HandoffPlan,
  type SeatInput,
} from './orchestration-engine'
import { readOrchestrationState, writeOrchestrationState } from './orchestration-store'

export interface OrchestrationServiceDependencies {
  onEvent: (event: ContinuityEvent, state: OrchestrationState) => void
  isProviderReady?: (provider: AgentProviderId) => boolean
  now?: () => number
  id?: () => string
  /** Injetável para testes; por padrão usa o store em `.devorbit/orchestration.json`. */
  readState?: (projectPath: string) => Promise<OrchestrationState>
  writeState?: (projectPath: string, state: OrchestrationState) => Promise<void>
  /** Observa handoffs planejados sem executar nada (o renderer despacha). */
  onHandoff?: (handoff: HandoffPlan, state: OrchestrationState) => void
}

export interface TurnResultInput {
  seatId: string
  role?: OrchestrationRole
  outcome: 'completed' | 'blocked' | 'failed'
  summary?: string
  branch?: string
  commit?: string
  /** Sinal transitório (rate limit/quota) detectado no turno. */
  transient?: boolean
}

export interface OrchestrationService {
  bindProject(projectPath: string | null): Promise<OrchestrationState | null>
  getState(): OrchestrationState | null
  setEnabled(enabled: boolean): Promise<OrchestrationState | null>
  upsertSeat(input: SeatInput): Promise<OrchestrationState | null>
  removeSeat(seatId: string): Promise<OrchestrationState | null>
  assignRole(role: OrchestrationRole, seatId: string | undefined): Promise<OrchestrationState | null>
  reportQuota(seatId: string, quota: ContinuityQuota, options?: { autoHandoff?: boolean }): Promise<OrchestrationState | null>
  reportTurnResult(input: TurnResultInput): Promise<OrchestrationState | null>
  reportCodexUsage(usage: RealUsageState): Promise<OrchestrationState | null>
  reportSeatFailure(seatId: string): Promise<OrchestrationState | null>
  reportSeatSuccess(seatId: string): Promise<OrchestrationState | null>
  stop(): void
}

function maxMetricPercent(usage: { metrics: Array<{ percent?: number }> }): number | undefined {
  let max: number | undefined
  for (const metric of usage.metrics) {
    if (typeof metric.percent !== 'number' || !Number.isFinite(metric.percent)) continue
    max = max === undefined ? metric.percent : Math.max(max, metric.percent)
  }
  return max
}

function quotaFor(state: OrchestrationState, percent: number, source: ContinuityQuota['source'], observedAt: string, reason?: string): ContinuityQuota {
  const status = percent >= state.policy.quotaExhaustedPercent
    ? 'exhausted'
    : percent >= state.policy.quotaWarningPercent
      ? 'warning'
      : 'ok'
  return { status, source, percent, observedAt, ...(reason ? { reason } : {}) }
}

export function createOrchestrationService(dependencies: OrchestrationServiceDependencies): OrchestrationService {
  const now = dependencies.now ?? (() => Date.now())
  const readState = dependencies.readState ?? readOrchestrationState
  // Persistência ATIVA por padrão: o estado vive em `.devorbit/orchestration.json`.
  // Testes podem injetar um store em memória.
  const writeState = dependencies.writeState ?? writeOrchestrationState
  let projectPath: string | null = null
  let cache: OrchestrationState | null = null
  let queue: Promise<unknown> = Promise.resolve()

  const engineContext = (): EngineContext => ({
    now: now(),
    ...(dependencies.id ? { id: dependencies.id } : {}),
    ...(dependencies.isProviderReady ? { isProviderReady: dependencies.isProviderReady } : {}),
  })

  function emit(events: readonly ContinuityEvent[], state: OrchestrationState): void {
    for (const event of events) {
      try {
        dependencies.onEvent(event, state)
      } catch {
        // Observadores nunca quebram a continuidade.
      }
    }
  }

  function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const current = queue.catch(() => undefined).then(operation)
    queue = current.then(() => undefined, () => undefined)
    return current
  }

  async function persist(next: OrchestrationState, events: readonly ContinuityEvent[]): Promise<OrchestrationState> {
    if (projectPath) await writeState(projectPath, next)
    cache = next
    emit(events, next)
    return next
  }

  async function persistResult(result: EngineResult): Promise<OrchestrationState> {
    return await persist(result.state, result.events)
  }

  async function load(): Promise<OrchestrationState | null> {
    if (!projectPath) return null
    if (cache) return cache
    cache = await readState(projectPath)
    return cache
  }

  /** Aplica um handoff planejado, emitindo eventos e notificando observadores. */
  async function applyHandoff(planned: EngineResult & { handoff?: HandoffPlan }): Promise<OrchestrationState> {
    const next = await persistResult(planned)
    if (planned.handoff) {
      try {
        dependencies.onHandoff?.(planned.handoff, next)
      } catch {
        // Observadores nunca quebram o handoff.
      }
    }
    return next
  }

  async function mutate(mutator: (state: OrchestrationState) => EngineResult): Promise<OrchestrationState | null> {
    if (!projectPath) return null
    return await runExclusive(async () => {
      const state = await load()
      if (!state) return null
      return await persistResult(mutator(state))
    })
  }

  return {
    async bindProject(nextProjectPath) {
      projectPath = nextProjectPath
      cache = null
      return await load()
    },

    getState() {
      return cache
    },

    async setEnabled(enabled) {
      return await mutate((state) => setEnabled(state, enabled, engineContext()))
    },

    async upsertSeat(input) {
      return await mutate((state) => upsertSeat(state, input, engineContext()))
    },

    async removeSeat(seatId) {
      return await mutate((state) => removeSeat(state, seatId, engineContext()))
    },

    async assignRole(role, seatId) {
      return await mutate((state) => assignRole(state, role, seatId, engineContext()))
    },

    async reportQuota(seatId, quota, options = {}) {
      if (!projectPath) return null
      return await runExclusive(async () => {
        const state = await load()
        if (!state) return null
        const updated = await persistResult(updateQuota(state, seatId, quota, engineContext()))
        if (options.autoHandoff !== false && quota.status === 'exhausted' && updated.policy.enabled) {
          const planned = planHandoff(updated, seatId, engineContext())
          return await applyHandoff(planned)
        }
        return updated
      })
    },

    async reportTurnResult(input) {
      if (!projectPath) return null
      return await runExclusive(async () => {
        let state = await load()
        if (!state) return null
        const ctx = engineContext()
        const collected: ContinuityEvent[] = []
        const seat = state.seats[input.seatId]

        if (seat && input.role) {
          const assigned = assignRole(state, input.role, input.seatId, ctx)
          state = assigned.state
          collected.push(...assigned.events)
        }

        const summary = input.summary ?? ''
        if (summary) {
          const checkpoint = recordCheckpoint(state, {
            at: new Date(ctx.now).toISOString(),
            role: input.role ?? seat?.role ?? 'implementer',
            summary,
            ...(input.branch ? { branch: input.branch } : {}),
            ...(input.commit ? { commit: input.commit } : {}),
          }, ctx)
          state = checkpoint.state
          collected.push(...checkpoint.events)
        }

        if (input.outcome === 'failed' && input.transient) {
          const failure = reportSeatFailure(state, input.seatId, ctx)
          state = failure.state
          collected.push(...failure.events)
          const exhausted = updateQuota(state, input.seatId, {
            status: 'exhausted',
            source: 'cli-signal',
            observedAt: new Date(ctx.now).toISOString(),
            reason: 'Limite/quota reportado pelo CLI.',
          }, ctx)
          state = exhausted.state
          collected.push(...exhausted.events)
          const persisted = await persist(state, collected)
          if (persisted.policy.enabled) {
            return await applyHandoff(planHandoff(persisted, input.seatId, engineContext()))
          }
          return persisted
        }

        if (input.outcome === 'completed' || input.outcome === 'blocked') {
          const cleared = reportSeatSuccess(state, input.seatId)
          state = cleared.state
          collected.push(...cleared.events)
        }

        return await persist(state, collected)
      })
    },

    async reportCodexUsage(usage) {
      if (!projectPath) return null
      return await runExclusive(async () => {
        let state = await load()
        if (!state) return null
        const ctx = engineContext()
        const collected: ContinuityEvent[] = []
        for (const account of ['account1', 'account2'] as const) {
          const accountUsage = usage.accounts[account]
          if (!accountUsage || accountUsage.status !== 'ready') continue
          const percent = maxMetricPercent(accountUsage)
          if (percent === undefined) continue
          const quota = quotaFor(state, percent, 'codex-oauth', new Date(ctx.now).toISOString())
          for (const seat of Object.values(state.seats)) {
            if (seat.account !== account || seat.provider !== 'codex') continue
            const updated = updateQuota(state, seat.id, quota, ctx)
            state = updated.state
            collected.push(...updated.events)
          }
        }
        return await persist(state, collected)
      })
    },

    async reportSeatFailure(seatId) {
      return await mutate((state) => reportSeatFailure(state, seatId, engineContext()))
    },

    async reportSeatSuccess(seatId) {
      return await mutate((state) => reportSeatSuccess(state, seatId))
    },

    stop() {
      projectPath = null
      cache = null
    },
  }
}

export type { EngineResult, HandoffPlan, SeatInput }
