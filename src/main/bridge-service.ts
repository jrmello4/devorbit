import { createAgentBridgeRuntime, type AgentBridgeRuntime } from './agent-bridge-runtime'
import { BridgeTaskCycles } from './bridge-task-cycles'
import type { ResultWaitPromise, TurnWaiter } from './agent-turn'
import type { AgentProviderId } from '../renderer/src/types'
import type { AgentBridgeEvent } from '../shared/agent-bridge-event'

export interface BridgeAgentRegistration {
  provider: AgentProviderId
  model: string
  projectPath: string
}

export interface BridgeAgentView extends BridgeAgentRegistration {
  id: string
  status: 'active' | 'stopped'
}

export interface BridgeServiceDependencies {
  cliDirectory: string
  hasTerminal: (id: string) => boolean
  writeTerminal: (id: string, input: string) => boolean
  waitTurnResult: (id: string, timeouts: { idleMs: number; overallMs: number }) => ResultWaitPromise
  onEvent: (event: AgentBridgeEvent) => void
  onReflection?: (target: string, outcome: { status: string; summary: string }) => void
}

export interface BridgeServiceOptions {
  sendIdleMs?: number
  sendOverallMs?: number
  askTimeoutMs?: number
}

export interface BridgeService {
  readonly runtime: AgentBridgeRuntime
  registerAgent(id: string, agent: BridgeAgentRegistration): void
  unregisterAgent(id: string): void
  cancelTarget(id: string): void
  listAgents(): BridgeAgentView[]
}

const DEFAULT_SEND_IDLE_MS = 5 * 60_000
const DEFAULT_SEND_OVERALL_MS = 30 * 60_000
const DEFAULT_ASK_TIMEOUT_MS = 5 * 60_000

export function createBridgeService(
  dependencies: BridgeServiceDependencies,
  options: BridgeServiceOptions = {},
): BridgeService {
  const sendIdleMs = options.sendIdleMs ?? DEFAULT_SEND_IDLE_MS
  const sendOverallMs = options.sendOverallMs ?? DEFAULT_SEND_OVERALL_MS
  const askTimeoutMs = options.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS
  const agents = new Map<string, BridgeAgentRegistration>()
  const targetLocks = new Map<string, Promise<unknown>>()
  const cycles = new BridgeTaskCycles<ResultWaitPromise>()

  const runTargetSerial = <T>(target: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const previous = targetLocks.get(target) || Promise.resolve()
    const current = previous.catch(() => undefined).then(() => {
      if (signal?.aborted) throw new Error('A solicitação da ponte foi cancelada.')
      return task()
    })
    targetLocks.set(target, current)
    return current.finally(() => {
      if (targetLocks.get(target) === current) targetLocks.delete(target)
    })
  }

  const resolveTarget = (target: string): string => {
    if (dependencies.hasTerminal(target)) return target
    const matches = Array.from(agents.entries())
      .filter(([id, agent]) => agent.provider === target && dependencies.hasTerminal(id))
      .map(([id]) => id)
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) throw new Error(`O alvo ${target} é ambíguo; use o id do terminal.`)
    throw new Error(`Agente ${target} não está ativo.`)
  }

  const outcomeFrom = (waiter: TurnWaiter): { status: 'completed' | 'blocked' | 'failed'; summary: string } => {
    if (waiter.result) return { status: 'completed', summary: waiter.result }
    if (waiter.blocked) return { status: 'blocked', summary: waiter.blocked }
    if (waiter.error) return { status: 'failed', summary: waiter.error }
    return { status: 'failed', summary: 'O agente terminou sem um resultado estruturado.' }
  }

  const trackCycle = (id: string, generation: number, promise: ResultWaitPromise, persistent: boolean, reflectOnComplete: boolean): void => {
    cycles.setPending(id, generation, promise, { cancel: () => promise.cancel() }, persistent)
    void promise.then((waiter) => {
      const outcome = outcomeFrom(waiter)
      cycles.complete(id, generation, outcome)
      if (reflectOnComplete) reflect(id, outcome)
    }).catch(() => undefined)
  }

  const awaitResult = async (
    entry: { promise: ResultWaitPromise; persistent: boolean },
    signal?: AbortSignal,
  ): Promise<TurnWaiter> => {
    if (!signal) return entry.promise
    if (signal.aborted) {
      if (!entry.persistent) entry.promise.cancel()
      return { error: 'A espera da ponte foi cancelada.' }
    }
    if (entry.persistent) {
      return await Promise.race([
        entry.promise,
        new Promise<TurnWaiter>((resolve) => signal.addEventListener('abort', () => resolve({ error: 'A espera da ponte foi cancelada.' }), { once: true })),
      ])
    }
    const onAbort = (): void => entry.promise.cancel()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await entry.promise
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  const reflect = (target: string, outcome: { status: string; summary: string }): void => {
    dependencies.onReflection?.(target, outcome)
  }

  const runtime = createAgentBridgeRuntime({
    cliDirectory: dependencies.cliDirectory,
    onEvent: dependencies.onEvent,
    handlers: {
      list: async () => Array.from(agents.entries()).map(([id, agent]) => ({
        id,
        provider: agent.provider,
        model: agent.model,
        projectPath: agent.projectPath,
        status: dependencies.hasTerminal(id) ? 'active' : 'stopped',
      })),
      send: async (request, context) => {
        const id = resolveTarget(request.target)
        return runTargetSerial(id, async () => {
          if (cycles.hasPending(id)) throw new Error('O terminal já possui uma tarefa aguardando resultado.')
          const generation = cycles.begin(id)
          const pending = dependencies.waitTurnResult(id, { idleMs: sendIdleMs, overallMs: sendOverallMs })
          trackCycle(id, generation, pending, true, true)
          if (!dependencies.writeTerminal(id, request.prompt + '\r')) {
            cycles.cancelPending(id)
            throw new Error('O terminal recusou a delegação.')
          }
          return { accepted: true, target: id }
        }, context?.signal)
      },
      wait: async (request, context) => {
        const id = resolveTarget(request.target)
        return runTargetSerial(id, async () => {
          const cached = cycles.cachedOutcome(id)
          if (cached) return cached
          const generation = cycles.generation(id)
          const existing = cycles.pendingFor(id, generation)
          const entry = existing
            ? { promise: existing.payload, persistent: existing.persistent }
            : { promise: dependencies.waitTurnResult(id, { idleMs: request.timeoutMs, overallMs: request.timeoutMs }), persistent: false }
          if (!existing) trackCycle(id, generation, entry.promise, entry.persistent, false)
          const outcome = outcomeFrom(await awaitResult(entry, context?.signal))
          if (!context?.signal?.aborted && !existing) {
            cycles.cacheOutcome(id, generation, outcome)
          }
          reflect(id, outcome)
          return outcome
        }, context?.signal)
      },
      ask: async (request, context) => {
        const id = resolveTarget(request.target)
        return runTargetSerial(id, async () => {
          if (cycles.hasPending(id)) throw new Error('O terminal já possui uma tarefa aguardando resultado.')
          const generation = cycles.begin(id)
          const pending = dependencies.waitTurnResult(id, {
            idleMs: request.timeoutMs || askTimeoutMs,
            overallMs: request.timeoutMs || askTimeoutMs,
          })
          if (!dependencies.writeTerminal(id, request.prompt + '\r')) {
            pending.cancel()
            throw new Error('O terminal recusou a delegação.')
          }
          const outcome = outcomeFrom(await awaitResult({ promise: pending, persistent: false }, context?.signal))
          if (!context?.signal?.aborted) cycles.cacheOutcome(id, generation, outcome)
          reflect(id, outcome)
          return outcome
        }, context?.signal)
      },
    },
  })

  return {
    runtime,
    registerAgent: (id, agent) => {
      agents.set(id, agent)
    },
    unregisterAgent: (id) => {
      agents.delete(id)
    },
    cancelTarget: (id) => {
      cycles.cancelPending(id)
    },
    listAgents: () => Array.from(agents.entries()).map(([id, agent]) => ({
      id,
      provider: agent.provider,
      model: agent.model,
      projectPath: agent.projectPath,
      status: dependencies.hasTerminal(id) ? 'active' : 'stopped',
    })),
  }
}
