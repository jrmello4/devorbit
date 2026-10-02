import { createAgentBridgeRuntime, type AgentBridgeRuntime, type AgentBridgeRuntimeOptions } from './agent-bridge-runtime'
import { BridgeTaskCycles } from './bridge-task-cycles'
import { buildDelegationAudit, evaluateDelegationGuard, type AgentBridgeRunRequest } from './agent-bridge'
import { withAgentResultProtocol } from '../shared/agent-result'
import type { HeadlessOutcome } from './bridge-headless'
import type { ResultWaitPromise, TurnWaiter } from './agent-turn'
import type { AgentProviderId } from '../shared/agent-provider-contract'
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

export type BridgeDelegationStatus = 'completed' | 'blocked' | 'failed'

/** Retorno estruturado e auditável de uma delegação (origem/destino/resultado). */
export interface BridgeDelegationOutcome {
  status: BridgeDelegationStatus
  summary: string
  origin: string
  destination: string
  result: {
    outcome: BridgeDelegationStatus
    summary: string
    artifacts?: string[]
  }
  artifacts?: string[]
}

export interface HeadlessTurnRequest {
  prompt: string
  model?: string
  mode?: string
  effort?: string
  agent?: string
  timeoutMs?: number
  signal: AbortSignal
  origin: string
  depth: number
  visited: string[]
}

/**
 * Outcome consolidado de UM ciclo lógico de delegação, emitido exatamente uma
 * vez por `taskId` estável (`<target>#<generation>` ou run one-shot). O evento
 * externo de `send` termina apenas em `{accepted:true}`; o resultado real
 * chega pelo waiter do ciclo — este callback é o ponto único de persistência,
 * imune a duplicação entre send+wait e waits repetidos em cache.
 */
export interface BridgeCycleOutcome {
  /** ID estável do ciclo lógico; a mesma tarefa nunca é emitida duas vezes. */
  taskId: string
  target: string
  /** projectPath do agente registrado no alvo, para escopo ai-memory. */
  projectPath?: string
  status: BridgeDelegationStatus
  summary: string
  artifacts?: string[]
}

/** Entrada da submissão centralizada do Bridge (delega a sendAgentInstruction). */
export interface BridgeInstructionInput {
  terminalId: string
  /** Turno determinístico do ciclo (`bridge_<terminal>_<generation>`), só para logs. */
  turnId: string
  /** Conteúdo enviado VERBATIM; o Enter de submissão é responsabilidade do módulo. */
  content: string
  provider?: string
  /** Âncora de prontidão (epoch ms) do ciclo do Bridge. */
  since?: number
  /**
   * Cancelamento cooperativo (context.signal da requisição): flui para
   * sendAgentInstruction, que para de escrever/reenviar e devolve
   * `{ cancelled: true }` em vez de falha.
   */
  signal?: AbortSignal
}

export interface BridgeInstructionResult {
  acked: boolean
  attempts: number
  error?: string
  /** true = envio interrompido pelo signal (fase `cancelled`, não `failed`). */
  cancelled?: boolean
}

export interface BridgeServiceDependencies {
  onMcpHandshake?: AgentBridgeRuntimeOptions['onMcpHandshake']
  onRegistryChanged?: () => void
  cliDirectory: string
  hasTerminal: (id: string) => boolean
  waitTurnResult: (id: string, timeouts: { idleMs: number; overallMs: number }) => ResultWaitPromise
  /**
   * Submissão centralizada da tarefa — a MESMA infraestrutura do Canvas
   * (sendAgentInstruction): espera prontidão real (timeout falha SEM escrever),
   * escreve o conteúdo verbatim + UM Enter, espera ack de saída do terminal e,
   * sem ack, re-envia APENAS o Enter (máx. 2 tentativas).
   */
  sendInstruction: (input: BridgeInstructionInput) => Promise<BridgeInstructionResult>
  onEvent: (event: AgentBridgeEvent) => void
  onReflection?: (target: string, outcome: { status: string; summary: string }) => void
  /** Outcome consolidado por ciclo lógico; falha do consumidor nunca quebra o Bridge. */
  onOutcome?: (outcome: BridgeCycleOutcome) => void
  /**
   * Turno não-interativo (print mode) para orquestração. Injetado pelo app;
   * quando ausente a operação `run` responde NOT_IMPLEMENTED.
   */
  runHeadlessTurn?: (target: string, agent: BridgeAgentRegistration, input: HeadlessTurnRequest) => Promise<HeadlessOutcome>
  /** Auditoria de um bloqueio de guardrail (allow-list). Nunca deve lançar. */
  onGuard?: (audit: Record<string, unknown>) => void
}

export interface BridgeServiceOptions {
  sendIdleMs?: number
  sendOverallMs?: number
  askTimeoutMs?: number
  headlessTimeoutMs?: number
  /** Allow-list de ids de terminal permitidos para delegação. Vazio = todos. */
  allowedTargets?: readonly string[]
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
  const headlessTimeoutMs = options.headlessTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS
  const allowedTargets = options.allowedTargets
  const agents = new Map<string, BridgeAgentRegistration>()
  const targetLocks = new Map<string, Promise<unknown>>()
  const cycles = new BridgeTaskCycles<ResultWaitPromise>()
  /** Sequência de ciclos one-shot `run` (taskId estável por chamada). */
  let runSequence = 0

  const originOf = (request: { origin?: string }): string => request.origin?.trim() || 'devorbit'

  const finalize = (
    base: { status: BridgeDelegationStatus; summary: string },
    origin: string,
    destination: string,
    artifacts?: string[],
  ): BridgeDelegationOutcome => {
    const boundedArtifacts = artifacts && artifacts.length > 0 ? artifacts.slice(0, 16) : undefined
    return {
      status: base.status,
      summary: base.summary,
      origin,
      destination,
      result: {
        outcome: base.status,
        summary: base.summary,
        ...(boundedArtifacts ? { artifacts: boundedArtifacts } : {}),
      },
      ...(boundedArtifacts ? { artifacts: boundedArtifacts } : {}),
    }
  }

  const assertAllowed = (
    id: string,
    request: { id?: string; origin?: string; depth?: number; visited?: string[] },
  ): void => {
    const decision = evaluateDelegationGuard(id, {
      depth: request.depth,
      visited: request.visited,
      allowedTargets,
    })
    if (decision.allowed) return
    try {
      dependencies.onGuard?.(buildDelegationAudit(decision, { requestId: request.id, origin: request.origin }))
    } catch {
      // Auditoria nunca pode quebrar uma requisição.
    }
    throw Object.assign(new Error(decision.reason || 'A delegação foi bloqueada.'), {
      code: decision.code || 'DELEGATION_BLOCKED',
    })
  }

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

  /**
   * Erro de delegação cancelada (code `cancelled`): distinto de falha — o
   * ciclo é cancelado (waiter descartado, nada pendente). Cancelamento não
   * cacheia outcome nem reflete na evolution store (ver `trackCycle`).
   */
  const delegationCancelledError = (): Error =>
    Object.assign(new Error('Delegação cancelada.'), { code: 'cancelled' })

  /** Cancelamentos de espera não são outcome de delegação: nunca persistir. */
  const cancellationSummaryPrefixes = [
    'a espera da ponte foi cancelada',
    // Mensagem do cancel() do waiter real (createResultWaiter em agent-turn).
    'a espera do resultado foi cancelada',
  ]
  const isCancellationOutcome = (outcome: { summary: string }): boolean => {
    const summary = outcome.summary.trim().toLowerCase()
    return cancellationSummaryPrefixes.some((prefix) => summary.startsWith(prefix))
  }

  /** Emissão de outcome uma única vez por ciclo lógico (taskId estável). */
  const emittedCycles = new Set<string>()
  const emitOutcomeOnce = (
    id: string,
    cycleKey: string,
    outcome: { status: BridgeDelegationStatus; summary: string; artifacts?: string[] },
  ): void => {
    if (!dependencies.onOutcome) return
    if (isCancellationOutcome(outcome)) return
    if (emittedCycles.has(cycleKey)) return
    emittedCycles.add(cycleKey)
    // Bounded: ciclos antigos saem em FIFO para o Set não crescer sem limite.
    if (emittedCycles.size > 512) {
      const oldest = emittedCycles.keys().next()
      if (!oldest.done) emittedCycles.delete(oldest.value)
    }
    const projectPath = agents.get(id)?.projectPath
    try {
      dependencies.onOutcome({
        taskId: cycleKey,
        target: id,
        ...(projectPath !== undefined ? { projectPath } : {}),
        status: outcome.status,
        summary: outcome.summary,
        ...(outcome.artifacts && outcome.artifacts.length > 0
          ? { artifacts: outcome.artifacts.slice(0, 16) }
          : {}),
      })
    } catch {
      // Persistência nunca quebra o Bridge.
    }
  }

  const trackCycle = (id: string, generation: number, promise: ResultWaitPromise, persistent: boolean, reflectOnComplete: boolean): void => {
    cycles.setPending(id, generation, promise, { cancel: () => promise.cancel() }, persistent)
    void promise.then((waiter) => {
      const outcome = outcomeFrom(waiter)
      // Migração da pendência do AbortSignal: cancelamento NÃO cacheia outcome
      // (um `wait` seguinte não recebe "tarefa cancelada" como resultado) NEM
      // reflete na evolution store — apenas limpa o ciclo pendente.
      if (isCancellationOutcome(outcome)) {
        cycles.cancelPending(id)
        return
      }
      cycles.complete(id, generation, outcome)
      if (reflectOnComplete) reflect(id, outcome)
      // Ponto ÚNICO de emissão para ciclos rastreados: send cria o ciclo e o
      // outcome real chega aqui; wait acoplado ao MESMO ciclo não reemite.
      emitOutcomeOnce(id, `${id}#${generation}`, outcome)
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
    onMcpHandshake: dependencies.onMcpHandshake,
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
        assertAllowed(id, request)
        const origin = originOf(request)
        return runTargetSerial(id, async () => {
          if (cycles.hasPending(id)) throw new Error('O terminal já possui uma tarefa aguardando resultado.')
          const generation = cycles.begin(id)
          const turnId = `bridge_${id}_${generation}`
          // Waiter armado ANTES do sendInstruction: o ack (eco/redraw) e o
          // DEVORBIT_RESULT são observadores independentes sobre o MESMO
          // barramento do PTY, e o resultado pode chegar no mesmo ciclo de
          // eventos do ack (mesmo padrão do sendAgentTurn).
          const pending = dependencies.waitTurnResult(id, { idleMs: sendIdleMs, overallMs: sendOverallMs })
          trackCycle(id, generation, pending, true, true)
          // Submissão centralizada (sendAgentInstruction): espera prontidão REAL
          // — timeout falha SEM escrever —, conteúdo verbatim + UM Enter, ack e
          // retry que re-envia apenas o Enter. Nunca escreve às cegas.
          const provider = agents.get(id)?.provider
          // Contrato DEVORBIT_RESULT instruído automaticamente: o waiter do
          // resultado só resolve no marcador; sem a instrução, projetos sem
          // AGENTS/.codex respondem texto puro e o ciclo expira. A tarefa
          // (request.prompt) permanece íntegra após a instrução.
          let instruction: Awaited<ReturnType<typeof dependencies.sendInstruction>>
          try {
            instruction = await dependencies.sendInstruction({
              terminalId: id,
              turnId,
              content: withAgentResultProtocol(request.prompt),
              ...(provider !== undefined ? { provider } : {}),
              since: Date.now(),
              // context.signal flui até sendAgentInstruction: abort para de
              // escrever/reenviar e devolve cancelled em vez de falha.
              ...(context?.signal !== undefined ? { signal: context.signal } : {}),
            })
          } catch (error) {
            // Defensivo: a implementação atual não lança, mas se lançar o ciclo
            // armado não pode ficar pendente travando o terminal.
            cycles.cancelPending(id)
            throw error
          }
          if (!instruction.acked) {
            // Nada foi entregue: cancela o ciclo armado e propaga o erro
            // explícito em vez de deixar a tarefa pendente. Cancelamento é
            // estado próprio (code `cancelled`), não falha de entrega.
            cycles.cancelPending(id)
            if (instruction.cancelled) throw delegationCancelledError()
            throw new Error(instruction.error || 'A tarefa não foi entregue ao agente.')
          }
          return { accepted: true, target: id, origin, destination: id }
        }, context?.signal)
      },
      wait: async (request, context) => {
        const id = resolveTarget(request.target)
        assertAllowed(id, request)
        const origin = originOf(request)
        return runTargetSerial(id, async () => {
          const cached = cycles.cachedOutcome(id)
          if (cached) return finalize(cached, origin, id)
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
          return finalize(outcome, origin, id)
        }, context?.signal)
      },
      ask: async (request, context) => {
        const id = resolveTarget(request.target)
        assertAllowed(id, request)
        const origin = originOf(request)
        return runTargetSerial(id, async () => {
          if (cycles.hasPending(id)) throw new Error('O terminal já possui uma tarefa aguardando resultado.')
          const generation = cycles.begin(id)
          const turnId = `bridge_${id}_${generation}`
          const pending = dependencies.waitTurnResult(id, {
            idleMs: request.timeoutMs || askTimeoutMs,
            overallMs: request.timeoutMs || askTimeoutMs,
          })
          // Mesmo padrão do send: waiter armado antes da submissão centralizada;
          // sem ack, o waiter é cancelado e o erro explícito é propagado.
          const provider = agents.get(id)?.provider
          let instruction: Awaited<ReturnType<typeof dependencies.sendInstruction>>
          try {
            instruction = await dependencies.sendInstruction({
              terminalId: id,
              turnId,
              content: withAgentResultProtocol(request.prompt),
              ...(provider !== undefined ? { provider } : {}),
              since: Date.now(),
              // context.signal flui até sendAgentInstruction (mesmo caminho do send).
              ...(context?.signal !== undefined ? { signal: context.signal } : {}),
            })
          } catch (error) {
            // Simetria com o send: se a instrução lançar, o waiter armado não
            // fica órfão subscrito no barramento até o próprio timeout.
            pending.cancel()
            throw error
          }
          if (!instruction.acked) {
            pending.cancel()
            if (instruction.cancelled) throw delegationCancelledError()
            throw new Error(instruction.error || 'A tarefa não foi entregue ao agente.')
          }
          const outcome = outcomeFrom(await awaitResult({ promise: pending, persistent: false }, context?.signal))
          if (!context?.signal?.aborted) cycles.cacheOutcome(id, generation, outcome)
          reflect(id, outcome)
          emitOutcomeOnce(id, `${id}#${generation}`, outcome)
          return finalize(outcome, origin, id)
        }, context?.signal)
      },
      ...(dependencies.runHeadlessTurn
        ? {
            run: async (request: AgentBridgeRunRequest, context) => {
              const id = resolveTarget(request.target)
              assertAllowed(id, request)
              const origin = originOf(request)
              return runTargetSerial(id, async () => {
                const agent = agents.get(id)
                if (!agent) throw new Error(`Agente ${id} não está ativo.`)
                if (cycles.hasPending(id)) {
                  throw new Error('O terminal já possui uma tarefa aguardando resultado.')
                }
                const visited = [...(request.visited ?? []), id]
                const outcome = await dependencies.runHeadlessTurn!(id, agent, {
                  prompt: request.prompt,
                  ...(request.model !== undefined ? { model: request.model } : {}),
                  ...(request.mode !== undefined ? { mode: request.mode } : {}),
                  ...(request.effort !== undefined ? { effort: request.effort } : {}),
                  ...(request.agent !== undefined ? { agent: request.agent } : {}),
                  timeoutMs: request.timeoutMs ?? headlessTimeoutMs,
                  signal: context?.signal ?? new AbortController().signal,
                  origin: id,
                  depth: (request.depth ?? 0) + 1,
                  visited,
                })
                // run é um ciclo one-shot: taskId único por chamada.
                emitOutcomeOnce(id, `${id}#run#${++runSequence}`, { status: outcome.status, summary: outcome.summary, ...(outcome.artifacts?.length ? { artifacts: outcome.artifacts } : {}) })
                return finalize({ status: outcome.status, summary: outcome.summary }, origin, id, outcome.artifacts)
              }, context?.signal)
            },
          }
        : {}),
    },
  })

  return {
    runtime,
    registerAgent: (id, agent) => {
      agents.set(id, agent)
      dependencies.onRegistryChanged?.()
    },
    unregisterAgent: (id) => {
      agents.delete(id)
      dependencies.onRegistryChanged?.()
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
