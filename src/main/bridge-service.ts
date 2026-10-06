import { createAgentBridgeRuntime, type AgentBridgeRuntime, type AgentBridgeRuntimeOptions } from './agent-bridge-runtime'
import { BridgeTaskCycles } from './bridge-task-cycles'
import { buildDelegationAudit, evaluateDelegationGuard, type AgentBridgeRunRequest } from './agent-bridge'
import { withAgentResultProtocol } from '../shared/agent-result'
import { randomUUID } from 'node:crypto'
import { stripAnsiEscapes } from '../shared/ansi'
import { bridgeTurnContent, createBridgeTurn, hasProviderModelFailure, type BridgeTurnDiagnostic, type BridgeTurnErrorCode } from './bridge-turn'
import type { AgentInstructionEvent } from '../shared/agent-instruction-contract'
import type { TerminalEvent } from './terminal-session'
import type { HeadlessOutcome } from './bridge-headless'
import type { ResultWaitPromise, TurnWaiter } from './agent-turn'
import type { AgentProviderId } from '../shared/agent-provider-contract'
import type { AgentBridgeEvent } from '../shared/agent-bridge-event'

export interface BridgeAgentRegistration {
  provider: AgentProviderId
  model: string
  projectPath: string
}

export type AgentStartupFailureCode =
  | 'AGENT_STARTUP_TIMEOUT'
  | 'AGENT_STARTUP_PROVIDER_ERROR'
  | 'AGENT_STARTUP_CONFIGURATION_INVALID'
  | 'AGENT_STARTUP_AUTH_FAILED'
  | 'AGENT_STARTUP_CLI_NOT_FOUND'

export interface BridgeAgentView extends BridgeAgentRegistration {
  id: string
  status: 'starting' | 'ready' | 'busy' | 'failed' | 'stopped'
  terminalExists: boolean
  operational: boolean
  /** True only when the authenticated caller maps to this terminal id. */
  self: boolean
  /** A caller may delegate only to a ready, non-self terminal. */
  delegable: boolean
  reason?: 'model_configuration_error' | 'provider_startup_error'
  failureCode?: AgentStartupFailureCode
}

export type BridgeDelegationStatus = 'completed' | 'blocked' | 'failed'

/** Retorno estruturado e auditável de uma delegação (origem/destino/resultado). */
export interface BridgeDelegationOutcome {
  errorCode?: BridgeTurnErrorCode
  diagnostic?: BridgeTurnDiagnostic
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
  /** Authenticated caller terminal id, or `devorbit` for legacy callers. */
  source: string
  target: string
  /** projectPath do agente registrado no alvo, para escopo ai-memory. */
  projectPath?: string
  status: BridgeDelegationStatus
  summary: string
  artifacts?: string[]
}

/** Entrada da submissão centralizada do Bridge (delega a sendAgentInstruction). */
export interface BridgeInstructionInput {
  onPhase?: (event: AgentInstructionEvent) => void
  isResultReady?: () => boolean
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
  errorCode?: BridgeTurnErrorCode
  acked: boolean
  attempts: number
  error?: string
  /** true = envio interrompido pelo signal (fase `cancelled`, não `failed`). */
  cancelled?: boolean
}

export interface BridgeServiceDependencies {
  subscribe?: (listener: (event: TerminalEvent) => void) => () => void
  /** The same PTY readiness detector used by instruction delivery. */
  waitAgentReady: (id: string, options: { timeoutMs: number; since?: number }) => Promise<{ timedOut: boolean }>
  onDiagnostic?: (event: BridgeTurnDiagnostic) => void
  onMcpHandshake?: AgentBridgeRuntimeOptions['onMcpHandshake']
  /** Validates that a caller launch is still the current accepted launch. */
  isCurrentLaunch?: (terminalId: string, launchId: string) => boolean
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
  startupTimeoutMs?: number
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
const DEFAULT_AGENT_STARTUP_TIMEOUT_MS = 30_000

export function createBridgeService(
  dependencies: BridgeServiceDependencies,
  options: BridgeServiceOptions = {},
): BridgeService {
  const sendIdleMs = options.sendIdleMs ?? DEFAULT_SEND_IDLE_MS
  const sendOverallMs = options.sendOverallMs ?? DEFAULT_SEND_OVERALL_MS
  const askTimeoutMs = options.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS
  const headlessTimeoutMs = options.headlessTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_AGENT_STARTUP_TIMEOUT_MS
  const allowedTargets = options.allowedTargets
  const agents = new Map<string, BridgeAgentRegistration>()
  const states = new Map<string, Pick<BridgeAgentView, 'status' | 'reason' | 'failureCode'>>()
  const startupOutput = new Map<string, string>()
  const startupChecks = new Map<string, object>()
  const currentTurns = new Map<string, string>()
  const activeTurns = new Map<string, { controller: AbortController; pending: ResultWaitPromise }>()
  type CallerRequest = {
    origin?: string
    originTerminalId?: string
    originLaunchId?: string
  }
  type CallerIdentity = { terminalId: string; launchId: string }
  // The MCP handshake is the admission point for caller identity. Keeping the
  // accepted launch nonce here prevents a stale managed process from claiming
  // a newly reused terminal id between health updates.
  const acceptedCallers = new Map<string, string>()
  const acceptedMcpHandshake: AgentBridgeRuntimeOptions['onMcpHandshake'] = (input) => {
    const accepted = dependencies.onMcpHandshake?.(input)
    if (accepted === false) {
      return false
    }
    acceptedCallers.set(input.terminalId, input.launchId)
    return accepted
  }
  const startReadinessCheck = (id: string, since?: number): void => {
    if (!agents.has(id)) return
    const attempt = {}
    startupChecks.set(id, attempt)
    void dependencies.waitAgentReady(id, { timeoutMs: startupTimeoutMs, ...(since !== undefined ? { since } : {}) }).then((result) => {
      if (startupChecks.get(id) !== attempt || !agents.has(id)) return
      startupChecks.delete(id)
      if (states.get(id)?.status !== 'starting') return
      setState(id, result.timedOut
        ? { status: 'failed', reason: 'provider_startup_error', failureCode: 'AGENT_STARTUP_TIMEOUT' }
        : { status: 'ready' })
    }).catch(() => {
      if (startupChecks.get(id) !== attempt || !agents.has(id)) return
      startupChecks.delete(id)
      if (states.get(id)?.status === 'starting') {
        setState(id, { status: 'failed', reason: 'provider_startup_error', failureCode: 'AGENT_STARTUP_PROVIDER_ERROR' })
      }
    })
  }
  const setState = (id: string, state: Pick<BridgeAgentView, 'status' | 'reason' | 'failureCode'>) => {
    if (!agents.has(id)) return
    const previousStatus = states.get(id)?.status
    states.set(id, state)
    dependencies.onRegistryChanged?.()
    if (state.status === 'starting') {
      // A known PTY event (or a just-finished turn) is the output anchor for
      // revalidation; initial registration intentionally has no anchor and
      // therefore still requires the first provider output.
      startReadinessCheck(id, previousStatus && previousStatus !== 'starting' ? Date.now() : undefined)
    }
    else startupChecks.delete(id)
  }
  const startupFailure = (text: string): Pick<BridgeAgentView, 'reason' | 'failureCode'> | undefined => {
    if (hasProviderModelFailure(text)) {
      return { reason: 'model_configuration_error', failureCode: 'AGENT_STARTUP_CONFIGURATION_INVALID' }
    }
    if (/(?:authentication failed|authentication required|unauthorized|not authenticated|not logged in|login required|please\s+(?:log\s+in|sign\s+in|authenticate)|(?:api|access) key\s+(?:is\s+)?(?:invalid|missing|not set))/iu.test(text)) {
      return { reason: 'provider_startup_error', failureCode: 'AGENT_STARTUP_AUTH_FAILED' }
    }
    if (/(?:spawn\s+)?(?:enoent|command not found|executable not found|is not recognized as an internal or external command)/iu.test(text)) {
      return { reason: 'provider_startup_error', failureCode: 'AGENT_STARTUP_CLI_NOT_FOUND' }
    }
    if (/(?:invalid provider configuration|provider configuration is invalid|configuration error)/iu.test(text)) {
      return { reason: 'provider_startup_error', failureCode: 'AGENT_STARTUP_CONFIGURATION_INVALID' }
    }
    return undefined
  }
  // The shared terminal readiness detector publishes the same quiet-output
  // decision used by sendAgentInstruction into the Bridge registry.
  dependencies.subscribe?.((event) => {
    if (!agents.has(event.id)) return
    if (event.type === 'exit') {
      const failureCode = states.get(event.id)?.failureCode
      setState(event.id, { status: 'stopped', ...(failureCode ? { failureCode } : {}) })
      startupOutput.delete(event.id)
      return
    }
    if (event.type === 'error') {
      const failure = startupFailure(event.data ?? '')
      setState(event.id, { status: 'failed', reason: failure?.reason ?? 'provider_startup_error', failureCode: failure?.failureCode ?? 'AGENT_STARTUP_PROVIDER_ERROR' })
      return
    }
    if (event.type !== 'data') return
    if (states.get(event.id)?.status === 'ready') {
      // PTY output invalidates the exact cache the instruction layer uses.
      // Mirror that invalidation, then let the shared waiter publish ready
      // again after this output settles.
      startupOutput.delete(event.id)
      setState(event.id, { status: 'starting' })
    }
    if (states.get(event.id)?.status !== 'starting') return
    const text = (startupOutput.get(event.id) ?? '') + stripAnsiEscapes(event.data ?? '')
    startupOutput.set(event.id, text.slice(-8192))
    const failure = startupFailure(text)
    if (failure) {
      setState(event.id, { status: 'failed', ...failure })
      startupOutput.delete(event.id)
    }
  })
  const callerIdentityOf = (request: CallerRequest): CallerIdentity | undefined => {
    const terminalId = request.originTerminalId
    const launchId = request.originLaunchId
    if (terminalId === undefined && launchId === undefined) return undefined
    if (
      terminalId === undefined ||
      launchId === undefined ||
      acceptedCallers.get(terminalId) !== launchId ||
      (dependencies.isCurrentLaunch !== undefined && !dependencies.isCurrentLaunch(terminalId, launchId))
    ) {
      throw Object.assign(new Error('The managed caller launch is stale.'), { code: 'CALLER_IDENTITY_STALE' })
    }
    return { terminalId, launchId }
  }
  const listAgents = (request?: CallerRequest): BridgeAgentView[] => {
    const caller = request === undefined ? undefined : callerIdentityOf(request)
    return Array.from(agents.entries()).map(([id, agent]) => {
    const terminalExists = dependencies.hasTerminal(id)
    const registeredState = states.get(id) ?? { status: 'starting' as const }
    const state = terminalExists || registeredState.status === 'failed' || registeredState.status === 'stopped'
      ? registeredState
      : { status: 'stopped' as const }
      const self = caller?.terminalId === id
      return {
        id,
        ...agent,
        ...state,
        terminalExists,
        operational: state.status === 'ready' || state.status === 'busy',
        self,
        delegable: state.status === 'ready' && terminalExists && !self,
      }
    })
  }
  const targetLocks = new Map<string, Promise<unknown>>()
  const cycles = new BridgeTaskCycles<ResultWaitPromise>()
  /** Sequência de ciclos one-shot `run` (taskId estável por chamada). */
  let runSequence = 0

  const originOf = (request: CallerRequest): string => callerIdentityOf(request)?.terminalId || request.origin?.trim() || 'devorbit'

  const assertNotSelf = (targetId: string, request: CallerRequest): void => {
    const caller = callerIdentityOf(request)
    if (caller?.terminalId === targetId) {
      throw Object.assign(new Error('Delegation to the calling agent is not allowed.'), { code: 'SELF_DELEGATION_NOT_ALLOWED' })
    }
  }

  const finalize = (
    base: { status: BridgeDelegationStatus; summary: string; errorCode?: BridgeTurnErrorCode; diagnostic?: BridgeTurnDiagnostic },
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
      ...(base.errorCode ? { errorCode: base.errorCode } : {}),
      ...(base.diagnostic ? { diagnostic: base.diagnostic } : {}),
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
      if (signal?.aborted) throw Object.assign(new Error('A solicitação da ponte foi cancelada.'), { code: 'CANCELLED' })
      return task()
    })
    targetLocks.set(target, current)
    return current.finally(() => {
      if (targetLocks.get(target) === current) targetLocks.delete(target)
    })
  }

  const resolveTarget = (target: string): string => {
    // Registered ids win when a provider shares the same spelling. Resolve
    // provider aliases before the legacy unregistered-id fallback so a broad
    // hasTerminal implementation cannot bypass the self guard.
    if (agents.has(target)) return target
    const matches = Array.from(agents.entries())
      .filter(([id, agent]) => agent.provider === target && dependencies.hasTerminal(id))
      .map(([id]) => id)
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) throw new Error(`O alvo ${target} é ambíguo; use o id do terminal.`)
    const registeredMatches = Array.from(agents.entries())
      .filter(([, agent]) => agent.provider === target)
      .map(([id]) => id)
    if (registeredMatches.length === 1) return registeredMatches[0]
    if (registeredMatches.length > 1) throw new Error(`O alvo ${target} é ambíguo; use o id do terminal.`)
    if (dependencies.hasTerminal(target)) return target
    throw Object.assign(new Error('O agente solicitado não está disponível.'), { code: 'AGENT_NOT_READY' })
  }

  const assertAgentReady = (id: string, requestId?: string): void => {
    const agent = agents.get(id)
    const registeredState = states.get(id) ?? { status: 'starting' as const }
    const status = !dependencies.hasTerminal(id) && registeredState.status !== 'failed' && registeredState.status !== 'stopped'
      ? 'stopped'
      : registeredState.status
    if (status === 'ready') return
    const startupFailed = status === 'failed' || registeredState.failureCode !== undefined
    const code = startupFailed ? 'AGENT_STARTUP_FAILED' : 'AGENT_NOT_READY'
    const message = startupFailed ? 'The agent failed during startup.' : 'The agent is not ready.'
    throw Object.assign(new Error(message), {
      code,
      bridgeData: {
        phase: 'target_validation',
        ...(requestId ? { requestId } : {}),
        agentId: id,
        provider: agent?.provider ?? 'unknown',
        status,
        operational: status === 'busy',
        turnCreated: false,
        ...(registeredState.failureCode ? { failureCode: registeredState.failureCode } : {}),
      },
    })
  }

  const outcomeFrom = (waiter: TurnWaiter): { status: BridgeDelegationStatus; summary: string; errorCode?: BridgeTurnErrorCode; diagnostic?: BridgeTurnDiagnostic } => {
    const metadata = waiter.diagnostic ? { diagnostic: waiter.diagnostic } : {}
    if (waiter.result) return { status: 'completed', summary: waiter.result, ...metadata }
    if (waiter.blocked) return { status: 'blocked', summary: waiter.blocked, ...metadata }
    const cancelled = waiter.error?.startsWith('A espera da ponte foi cancelada') || waiter.error?.startsWith('A espera do resultado foi cancelada')
    const errorCode = waiter.errorCode ?? (cancelled ? 'CANCELLED' : waiter.invalidResult ? 'RESULT_PARSE_FAILED'
      : waiter.timedOut ? 'RESULT_TIMEOUT' : waiter.code !== undefined ? 'TERMINAL_EXITED'
        : waiter.error ? 'INSTRUCTION_DELIVERY_FAILED' : 'RESULT_MARKER_MISSING')
    const messages: Record<BridgeTurnErrorCode, string> = {
      AGENT_NOT_READY: 'O agente não está pronto.', PROVIDER_STARTUP_FAILED: 'O provider falhou ao iniciar.',
      INSTRUCTION_DELIVERY_FAILED: 'A instrução não foi entregue.', INSTRUCTION_ACK_TIMEOUT: 'A submissão não foi confirmada.',
      RESULT_TIMEOUT: 'O prazo de espera do resultado expirou.', TERMINAL_EXITED: 'O terminal encerrou antes do resultado.',
      RESULT_MARKER_MISSING: 'Houve saída sem resultado válido deste turno.', RESULT_PARSE_FAILED: 'O resultado estruturado é inválido.',
      ECHO_ONLY: 'Foi observado apenas eco da instrução.', CANCELLED: 'A espera do resultado foi cancelada.',
      AGENT_REPORTED_FAILURE: 'O agente reportou falha neste turno.',
    }
    return { status: 'failed', summary: messages[errorCode], errorCode, ...metadata }
  }

  const prepareTurn = (id: string, prompt: string, turnId: string, idleMs: number, overallMs: number) => {
    const provider = agents.get(id)?.provider ?? 'unknown'
    const status = states.get(id)?.status
    if (status !== 'ready') {
      assertAgentReady(id)
    }
    const content = dependencies.subscribe ? bridgeTurnContent(prompt, turnId) : withAgentResultProtocol(prompt)
    const trace = (event: BridgeTurnDiagnostic) => {
      try { dependencies.onDiagnostic?.(event) } catch { /* Telemetry is isolated. */ }
    }
    const turn = dependencies.subscribe ? createBridgeTurn({ terminalId: id, turnId, provider, content, idleMs, overallMs,
      subscribe: dependencies.subscribe, onDiagnostic: trace }) : undefined
    for (const phase of ['target_resolved', 'target_state_checked', 'instruction_prepared']) {
      trace({ agentId: id, terminalId: id, turnId, provider, phase, elapsedMs: 0,
        ...(phase === 'instruction_prepared' ? { contentLength: content.length } : {}) })
    }
    const pending = turn?.pending ?? dependencies.waitTurnResult(id, { idleMs, overallMs })
    const deliveryController = new AbortController()
    activeTurns.set(id, { controller: deliveryController, pending })
    let turnFailure: ReturnType<typeof outcomeFrom> | undefined
    setState(id, { status: 'busy' })
    currentTurns.set(id, turnId)
    void pending.then((waiter) => {
      const outcome = outcomeFrom(waiter)
      if (outcome.status === 'failed') {
        // A result/ready deadline can win while the central instruction
        // delivery is still waiting. Abort that delivery so it cannot write
        // into a turn that has already failed.
        turnFailure = outcome
        deliveryController.abort()
      }
      // A parser failure is not evidence that the provider failed to start.
      if (states.get(id)?.status !== 'busy' || currentTurns.get(id) !== turnId) return
      setState(id, waiter.errorCode === 'PROVIDER_STARTUP_FAILED'
        ? { status: 'failed', reason: waiter.diagnostic?.reason ?? 'provider_startup_error' }
        : { status: waiter.result || waiter.blocked ? 'ready' : 'starting' })
    })
    return {
      pending,
      content,
      provider,
      onPhase: turn?.instruction,
      isResultReady: turn?.isResultReady,
      fail: turn?.fail,
      deliveryController,
      dispose: () => {
        if (activeTurns.get(id)?.controller === deliveryController) activeTurns.delete(id)
      },
      failure: () => turnFailure,
    }
  }

  const linkAbortSignal = (source: AbortSignal | undefined, target: AbortController): (() => void) => {
    if (!source) return () => undefined
    if (source.aborted) {
      target.abort()
      return () => undefined
    }
    const onAbort = (): void => target.abort()
    source.addEventListener('abort', onAbort, { once: true })
    return () => source.removeEventListener('abort', onAbort)
  }

  const turnFailureError = (failure: ReturnType<typeof outcomeFrom>): Error =>
    Object.assign(new Error(failure.summary), { code: failure.errorCode ?? 'INSTRUCTION_DELIVERY_FAILED' })

  /**
   * Erro de delegação cancelada (code `cancelled`): distinto de falha — o
   * ciclo é cancelado (waiter descartado, nada pendente). Cancelamento não
   * cacheia outcome nem reflete na evolution store (ver `trackCycle`).
   */
  const delegationCancelledError = (): Error =>
    Object.assign(new Error('Delegação cancelada.'), { code: 'CANCELLED' })

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
    source = 'devorbit',
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
        source,
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

  const trackCycle = (
    id: string,
    generation: number,
    promise: ResultWaitPromise,
    persistent: boolean,
    reflectOnComplete: boolean,
    source = 'devorbit',
  ): void => {
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
      emitOutcomeOnce(id, `${id}#${generation}`, outcome, source)
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
      let onAbort: (() => void) | undefined
      const aborted = new Promise<TurnWaiter>((resolve) => {
        onAbort = () => resolve({ error: 'A espera da ponte foi cancelada.' })
        signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        return await Promise.race([entry.promise, aborted])
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort)
      }
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
    onMcpHandshake: acceptedMcpHandshake,
    onEvent: dependencies.onEvent,
    handlers: {
      list: async (request) => listAgents(request),
      send: async (request, context) => {
        const id = resolveTarget(request.target)
        assertNotSelf(id, request)
        assertAllowed(id, request)
        assertAgentReady(id, request.id)
        const origin = originOf(request)
        return runTargetSerial(id, async () => {
          if (cycles.hasPending(id)) throw new Error('O terminal já possui uma tarefa aguardando resultado.')
          const generation = cycles.begin(id)
          const turnId = `bridge_${id}_${generation}_${randomUUID().replaceAll('-', '')}`
          // Waiter armado ANTES do sendInstruction: o ack (eco/redraw) e o
          // DEVORBIT_RESULT são observadores independentes sobre o MESMO
          // barramento do PTY, e o resultado pode chegar no mesmo ciclo de
          // eventos do ack (mesmo padrão do sendAgentTurn).
          const turn = prepareTurn(id, request.prompt, turnId, sendIdleMs, sendOverallMs)
          const pending = turn.pending
          trackCycle(id, generation, pending, true, true, origin)
          // Submissão centralizada (sendAgentInstruction): espera prontidão REAL
          // — timeout falha SEM escrever —, conteúdo verbatim + UM Enter, ack e
          // retry que re-envia apenas o Enter. Nunca escreve às cegas.
          const provider = agents.get(id)?.provider
          // Contrato DEVORBIT_RESULT instruído automaticamente: o waiter do
          // resultado só resolve no marcador; sem a instrução, projetos sem
          // AGENTS/.codex respondem texto puro e o ciclo expira. A tarefa
          // (request.prompt) permanece íntegra após a instrução.
          let instruction: Awaited<ReturnType<typeof dependencies.sendInstruction>>
          const unlinkAbort = linkAbortSignal(context?.signal, turn.deliveryController)
          try {
            instruction = await dependencies.sendInstruction({
              terminalId: id,
              turnId,
              content: turn.content,
              onPhase: turn.onPhase,
              isResultReady: turn.isResultReady,
              ...(provider !== undefined ? { provider } : {}),
              since: Date.now(),
              // context.signal flui até sendAgentInstruction: abort para de
              // escrever/reenviar e devolve cancelled em vez de falha.
              signal: turn.deliveryController.signal,
            })
          } catch (error) {
            unlinkAbort()
            // Defensivo: a implementação atual não lança, mas se lançar o ciclo
            // armado não pode ficar pendente travando o terminal.
            const failure = turn.failure()
            if (failure) {
              cycles.cancelPending(id)
              setState(id, { status: 'starting' })
              throw turnFailureError(failure)
            }
            turn.fail?.(context?.signal?.aborted ? 'CANCELLED' : 'INSTRUCTION_DELIVERY_FAILED')
            cycles.cancelPending(id)
            setState(id, { status: 'starting' })
            throw error
          }
          unlinkAbort()
          const failure = turn.failure()
          if (failure) {
            cycles.cancelPending(id)
            setState(id, { status: 'starting' })
            throw turnFailureError(failure)
          }
          if (!instruction.acked) {
            // Nada foi entregue: cancela o ciclo armado e propaga o erro
            // explícito em vez de deixar a tarefa pendente. Cancelamento é
            // estado próprio (code `cancelled`), não falha de entrega.
            turn.fail?.(instruction.cancelled ? 'CANCELLED' : instruction.errorCode ?? 'INSTRUCTION_DELIVERY_FAILED')
            cycles.cancelPending(id)
            setState(id, { status: 'starting' })
            if (instruction.cancelled) throw delegationCancelledError()
            throw Object.assign(new Error('A instrução não foi confirmada.'), { code: instruction.errorCode ?? 'INSTRUCTION_DELIVERY_FAILED' })
          }
          return { accepted: true, target: id, origin, destination: id }
        }, context?.signal)
      },
      wait: async (request, context) => {
        const id = resolveTarget(request.target)
        assertNotSelf(id, request)
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
          if (!existing) trackCycle(id, generation, entry.promise, entry.persistent, false, origin)
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
        assertNotSelf(id, request)
        assertAllowed(id, request)
        assertAgentReady(id, request.id)
        const origin = originOf(request)
        return runTargetSerial(id, async () => {
          if (cycles.hasPending(id)) throw new Error('O terminal já possui uma tarefa aguardando resultado.')
          const generation = cycles.begin(id)
          const turnId = `bridge_${id}_${generation}_${randomUUID().replaceAll('-', '')}`
          const turn = prepareTurn(id, request.prompt, turnId, request.timeoutMs || askTimeoutMs, request.timeoutMs || askTimeoutMs)
          const pending = turn.pending
          // Mesmo padrão do send: waiter armado antes da submissão centralizada;
          // sem ack, o waiter é cancelado e o erro explícito é propagado.
          const provider = agents.get(id)?.provider
          let instruction: Awaited<ReturnType<typeof dependencies.sendInstruction>>
          const unlinkAbort = linkAbortSignal(context?.signal, turn.deliveryController)
          try {
            instruction = await dependencies.sendInstruction({
              terminalId: id,
              turnId,
              content: turn.content,
              onPhase: turn.onPhase,
              isResultReady: turn.isResultReady,
              ...(provider !== undefined ? { provider } : {}),
              since: Date.now(),
              // context.signal flui até sendAgentInstruction (mesmo caminho do send).
              signal: turn.deliveryController.signal,
            })
          } catch (error) {
            unlinkAbort()
            // Simetria com o send: se a instrução lançar, o waiter armado não
            // fica órfão subscrito no barramento até o próprio timeout.
            const failure = turn.failure()
            if (failure) {
              pending.cancel()
              setState(id, { status: 'starting' })
              throw turnFailureError(failure)
            }
            turn.fail?.(context?.signal?.aborted ? 'CANCELLED' : 'INSTRUCTION_DELIVERY_FAILED')
            pending.cancel()
            setState(id, { status: 'starting' })
            throw error
          }
          unlinkAbort()
          const failure = turn.failure()
          if (failure) {
            pending.cancel()
            setState(id, { status: 'starting' })
            throw turnFailureError(failure)
          }
          if (!instruction.acked) {
            turn.fail?.(instruction.cancelled ? 'CANCELLED' : instruction.errorCode ?? 'INSTRUCTION_DELIVERY_FAILED')
            pending.cancel()
            setState(id, { status: 'starting' })
            if (instruction.cancelled) throw delegationCancelledError()
            throw Object.assign(new Error('A instrução não foi confirmada.'), { code: instruction.errorCode ?? 'INSTRUCTION_DELIVERY_FAILED' })
          }
          const outcome = outcomeFrom(await awaitResult({ promise: pending, persistent: false }, context?.signal))
          if (!context?.signal?.aborted) cycles.cacheOutcome(id, generation, outcome)
          reflect(id, outcome)
          emitOutcomeOnce(id, `${id}#${generation}`, outcome, origin)
          return finalize(outcome, origin, id)
        }, context?.signal)
      },
      ...(dependencies.runHeadlessTurn
        ? {
            run: async (request: AgentBridgeRunRequest, context) => {
              const id = resolveTarget(request.target)
              assertNotSelf(id, request)
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
                emitOutcomeOnce(id, `${id}#run#${++runSequence}`, { status: outcome.status, summary: outcome.summary, ...(outcome.artifacts?.length ? { artifacts: outcome.artifacts } : {}) }, origin)
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
      startupChecks.delete(id)
      states.delete(id)
      startupOutput.delete(id)
      currentTurns.delete(id)
      setState(id, { status: 'starting' })
    },
    unregisterAgent: (id) => {
      startupChecks.delete(id)
      activeTurns.get(id)?.controller.abort()
      activeTurns.get(id)?.pending.cancel()
      activeTurns.delete(id)
      cycles.cancelPending(id)
      agents.delete(id)
      states.delete(id)
      startupOutput.delete(id)
      currentTurns.delete(id)
      dependencies.onRegistryChanged?.()
    },
    cancelTarget: (id) => {
      cycles.cancelPending(id)
    },
    listAgents,
  }
}
