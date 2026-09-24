import {
  ensureAccountDirectories,
  getAccountLabel,
  getCodexAccountEnvironment,
  hasValidCodexAuth,
  resolveCodexCommand,
} from '../account-profiles'
import {
  prepareAiMemoryLaunch,
  registerActiveAiMemorySession,
  releaseAiMemoryReservation,
  rollbackAiMemoryLaunch,
} from '../ai-memory-launcher'
import {
  executeExplicitAgentTurn,
  getAgentProviderHealth,
  orderProvidersForTask,
  resolveAgentProviderWithFallback,
  resolveAgentTurn,
} from '../agent-providers'
import { sendAgentTurn, spawnAgentProviderTerminal, TURN_MAX_PROMPT_CHARS, type ResultWaitPromise, type TerminalReadyOptions } from '../agent-turn'
import {
  beginCompanionTerminalStart,
  registerCompanionTerminal,
  unregisterCompanionTerminal,
} from '../companion'
import { loadConfig } from '../config'
import { clearPipe, clearPipesFor, setPipe } from '../pty-pipe'
import { validateProjectPath } from '../project-paths'
import {
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
  hasTerminal,
  resizeTerminal,
  startTerminal,
  stopTerminal,
  writeTerminal,
} from '../terminal-session'
import { validateAgentProvider, validateCodexAccount, validateFiniteNumber, validateTerminalStartOptions } from '../validation'
import { resolveWindowsScriptLaunch } from '../terminal-launch'
import type { UsageEvent } from '../../shared/usage-contract'
import type { IpcRegistrar } from './registrar'
import type { AgentProviderId } from '../../renderer/src/types'

/** Ponto de injeção do registro de uso (turnos e sessões) — opcional e best-effort. */
export interface UsageRecorder {
  recordUsageEvents: (events: UsageEvent[]) => Promise<void>
  beginUsageSession: (terminalId: string, provider: string) => void
  endUsageSession: (terminalId: string) => void
}

export interface TerminalIpcDependencies {
  getTerminalLifecycleGeneration: () => number
  assertTerminalLifecycle: (generation: number) => void
  bridgeEnv: () => NodeJS.ProcessEnv
  registerBridgeAgent: (id: string, agent: { provider: AgentProviderId; model: string; projectPath: string }) => void
  cancelBridgeTarget: (id: string) => void
  turnSessions: Map<string, { provider: AgentProviderId; model: string }>
  waitTurnResult: (id: string, timeouts: { idleMs: number; overallMs: number }) => ResultWaitPromise
  waitTerminalReady: (id: string, options?: TerminalReadyOptions) => Promise<void>
  usage?: UsageRecorder
}

function assertTerminalId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(id)) throw new Error('Identificador de terminal inválido.')
}

/**
 * O canvas monta o prompt a partir das notas conectadas e pode exceder o teto
 * do turno. A fronteira IPC trunca no mesmo limite que `agent-turn` aplica,
 * em vez de rejeitar a tarefa inteira.
 */
export function normalizeAgentTurnPrompt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Prompt do turno inválido.')
  return value.slice(0, TURN_MAX_PROMPT_CHARS)
}

/**
 * Registro do turno no store de uso — sempre best-effort: falha alguma aqui
 * pode quebrar o caminho do turno (o resultado segue intacto para a UI).
 */
function recordTurnUsage(
  usage: UsageRecorder | undefined,
  terminalId: string,
  outcome: { provider: string; model: string; tier?: unknown; result?: string; blocked?: string },
  durationMs: number,
  forcedOutcome?: 'failed',
): void {
  if (!usage) return
  try {
    const event: UsageEvent = {
      kind: 'turn',
      at: new Date().toISOString(),
      terminalId,
      provider: outcome.provider,
      model: outcome.model,
      ...(typeof outcome.tier === 'string' && outcome.tier ? { tier: outcome.tier } : {}),
      outcome: forcedOutcome ?? (outcome.result ? 'completed' : outcome.blocked ? 'blocked' : 'failed'),
      durationMs: Math.max(0, durationMs),
    }
    void usage.recordUsageEvents([event]).catch(() => undefined)
  } catch {
    // Uso é telemetria: nunca propaga erro para o chamador do turno.
  }
}

export function registerTerminalIpc(register: IpcRegistrar, dependencies: TerminalIpcDependencies): void {
  register('devorbit:startTerminal', async (
    _event,
    id: unknown,
    projectPath: string,
    cols?: unknown,
    rows?: unknown,
    options?: unknown,
  ) => {
    assertTerminalId(id)
    const generation = dependencies.getTerminalLifecycleGeneration()
    const safePath = await validateProjectPath(projectPath)
    const startOptions = await validateTerminalStartOptions(options)
    dependencies.assertTerminalLifecycle(generation)
    const safeCols = cols === undefined ? undefined : validateFiniteNumber(cols, 'Colunas do terminal', { minimum: TERMINAL_MIN_COLS, maximum: TERMINAL_MAX_COLS, integer: true })
    const safeRows = rows === undefined ? undefined : validateFiniteNumber(rows, 'Linhas do terminal', { minimum: TERMINAL_MIN_ROWS, maximum: TERMINAL_MAX_ROWS, integer: true })
    // O comando do Smart Terminal roda no diretório próprio quando definido;
    // sem comando/cwd o comportamento é exatamente o do shell antigo.
    const effectiveCwd = startOptions?.cwd ?? safePath
    if (startOptions?.cwd !== undefined) {
      console.log(`[DevOrbit terminal] ${id} iniciado fora da pasta do projeto em ${effectiveCwd}.`)
    }
    // .cmd/.bat não executa direto pelo node-pty: passa pelo cmd.exe; o helper
    // rejeita metacaracteres do cmd no caminho embrulhado (defesa extra —
    // %/! e controles já caíram no validador).
    const launch = startOptions?.command !== undefined
      ? resolveWindowsScriptLaunch(startOptions.command, startOptions.args ?? [])
      : undefined
    beginCompanionTerminalStart(id)
    const started = await startTerminal(id, effectiveCwd, {
      ...(launch ? { command: launch.command, args: launch.args } : {}),
      env: dependencies.bridgeEnv(),
      ...(safeCols !== undefined ? { cols: safeCols } : {}),
      ...(safeRows !== undefined ? { rows: safeRows } : {}),
    })
    registerCompanionTerminal(id, { projectPath: safePath })
    return started
  })

  register('devorbit:startCodexTerminal', async (
    _event,
    id: unknown,
    projectPath: string,
    account: unknown,
    cols?: unknown,
    rows?: unknown,
  ) => {
    assertTerminalId(id)
    const generation = dependencies.getTerminalLifecycleGeneration()
    const safeAccount = validateCodexAccount(account)
    const safePath = await validateProjectPath(projectPath)
    const config = await loadConfig()
    dependencies.assertTerminalLifecycle(generation)
    const { codexHome } = await ensureAccountDirectories(safeAccount)
    const accountLabel = getAccountLabel(safeAccount, {
      account1: config.chatGptAccount1Name,
      account2: config.chatGptAccount2Name,
    })
    if (!(await hasValidCodexAuth(codexHome))) {
      return {
        success: false,
        needsAuth: true,
        fallback: false,
        account: safeAccount,
        message: accountLabel + ' ainda não está conectada. Conecte a conta e tente novamente.',
      }
    }

    const safeCols = cols === undefined ? 120 : validateFiniteNumber(cols, 'Colunas do terminal', { minimum: TERMINAL_MIN_COLS, maximum: TERMINAL_MAX_COLS, integer: true })
    const safeRows = rows === undefined ? 32 : validateFiniteNumber(rows, 'Linhas do terminal', { minimum: TERMINAL_MIN_ROWS, maximum: TERMINAL_MAX_ROWS, integer: true })
    const codexCommand = await resolveCodexCommand(config.customPaths.codex)
    dependencies.assertTerminalLifecycle(generation)
    if (/[%!]/.test(codexCommand)) {
      return { success: false, fallback: false, account: safeAccount, message: 'O caminho configurado do Codex contém caracteres que o terminal não pode executar com segurança.' }
    }
    const isScript = /\.(?:cmd|bat)$/i.test(codexCommand)
    const command = isScript ? (process.env.ComSpec || 'cmd.exe') : codexCommand
    // `call` e o caminho separados: arg único com aspas vira \" no node-pty
    // (literal para o cmd — shim "não reconhecido").
    const args = isScript ? ['/d', '/q', '/k', 'call', codexCommand] : []
    dependencies.assertTerminalLifecycle(generation)
    beginCompanionTerminalStart(id)
    const initialEnv = { ...getCodexAccountEnvironment(safeAccount), ...dependencies.bridgeEnv() }

    const launchPlan = await prepareAiMemoryLaunch({
      provider: 'codex',
      resolvedCommand: codexCommand,
      originalArgs: [],
      env: initialEnv,
      cwd: safePath,
      terminalId: id,
      account: safeAccount,
    })

    let result: { id: string; pid: number | undefined }
    if (launchPlan.wrapped) {
      try {
        result = await startTerminal(id, safePath, {
          command: launchPlan.command,
          args: launchPlan.args,
          env: launchPlan.env,
          cols: safeCols,
          rows: safeRows,
        })
        if (launchPlan.metadata) {
          if (!hasTerminal(id)) {
            rollbackAiMemoryLaunch(id)
          } else {
            registerActiveAiMemorySession(launchPlan.metadata)
          }
        }
      } catch (error) {
        rollbackAiMemoryLaunch(id)
        console.warn('[DevOrbit] Falha ao iniciar Codex com wrapper ai-memory; fallback direto:', error)
        result = await startTerminal(id, safePath, {
          command,
          args,
          env: initialEnv,
          cols: safeCols,
          rows: safeRows,
        })
      }
    } else {
      result = await startTerminal(id, safePath, {
        command,
        args,
        env: initialEnv,
        cols: safeCols,
        rows: safeRows,
      })
    }
    registerCompanionTerminal(id, { projectPath: safePath })
    dependencies.registerBridgeAgent(id, {
      provider: 'codex',
      model: config.modelRouting?.fastModel || 'codex',
      projectPath: safePath,
    })
    // Sessão com provider: a duração é fechada no exit do PTY (ou no stop).
    dependencies.usage?.beginUsageSession(id, 'codex')
    return {
      success: true,
      ...result,
      account: safeAccount,
      fallback: false,
      message: 'Codex conectado no terminal interno (' + accountLabel + ').',
    }
  })

  register('devorbit:startAgentTerminal', async (
    _event,
    id: unknown,
    projectPath: string,
    provider: unknown,
    cols?: unknown,
    rows?: unknown,
    task?: unknown,
  ) => {
    assertTerminalId(id)
    const generation = dependencies.getTerminalLifecycleGeneration()
    const safeProvider = validateAgentProvider(provider)
    if (safeProvider === 'codex') {
      return {
        success: false,
        provider: safeProvider,
        message: 'O Codex usa o fluxo de conta do DevOrbit; selecione uma conta Codex ou outro provedor.',
      }
    }
    const safeTask = task === undefined || task === null ? undefined : String(task).slice(0, TURN_MAX_PROMPT_CHARS)
    if (task !== undefined && task !== null && typeof task !== 'string') throw new Error('Tarefa do turno inválida.')
    const safePath = await validateProjectPath(projectPath)
    const config = await loadConfig()
    dependencies.assertTerminalLifecycle(generation)
    const turn = await resolveAgentTurn(config, safeProvider, safeTask)
    if (!turn.available) {
      return {
        success: false,
        provider: turn.provider,
        code: turn.error?.code || 'provider-not-ready',
        fallback: false,
        message: turn.reason,
      }
    }
    const safeCols = cols === undefined ? 120 : validateFiniteNumber(cols, 'Colunas do terminal', { minimum: TERMINAL_MIN_COLS, maximum: TERMINAL_MAX_COLS, integer: true })
    const safeRows = rows === undefined ? 32 : validateFiniteNumber(rows, 'Linhas do terminal', { minimum: TERMINAL_MIN_ROWS, maximum: TERMINAL_MAX_ROWS, integer: true })
    beginCompanionTerminalStart(id)
    const execution = await executeExplicitAgentTurn(turn.provider, async (candidate) => {
      const spawned = await spawnAgentProviderTerminal(
        {
          resolveWithFallback: resolveAgentProviderWithFallback,
          startTerminal: (spawnId, options) => startTerminal(spawnId, options.cwd ?? safePath, {
            ...options,
            env: { ...options.env, ...dependencies.bridgeEnv() },
          }),
          assertLive: () => dependencies.assertTerminalLifecycle(generation),
          hasTerminal,
        },
        {
          id,
          candidate,
          model: turn.model,
          tier: turn.tier,
          routing: config.modelRouting,
          cols: safeCols,
          rows: safeRows,
          cwd: safePath,
        },
        config
      )
      return { started: spawned.started, provider: spawned.provider, command: spawned.command }
    })
    registerCompanionTerminal(id, { projectPath: safePath })
    const effectiveProvider = execution.result.provider ?? execution.provider
    dependencies.registerBridgeAgent(id, {
      provider: effectiveProvider,
      model: turn.model,
      projectPath: safePath,
    })
    // Registra a sessão do turno para que o primeiro sendAgentTurn com o mesmo
    // provedor/modelo reutilize este PTY em vez de reiniciar o executor.
    dependencies.turnSessions.set(id, { provider: effectiveProvider, model: turn.model })
    // Sessão com provider: a duração é fechada no exit do PTY (ou no stop).
    dependencies.usage?.beginUsageSession(id, effectiveProvider)
    return {
      success: true,
      ...execution.result.started,
      provider: effectiveProvider,
      command: execution.result.command,
      tier: turn.tier,
      model: turn.model,
      fallback: false,
      message: effectiveProvider + ' iniciado no terminal interno. Se precisar, autentique pelo próprio CLI.',
    }
  })

  register('devorbit:resizeTerminal', (_event, id: unknown, cols: unknown, rows: unknown) => {
    assertTerminalId(id)
    const safeCols = validateFiniteNumber(cols, 'Colunas do terminal', { minimum: TERMINAL_MIN_COLS, maximum: TERMINAL_MAX_COLS, integer: true })
    const safeRows = validateFiniteNumber(rows, 'Linhas do terminal', { minimum: TERMINAL_MIN_ROWS, maximum: TERMINAL_MAX_ROWS, integer: true })
    return { success: resizeTerminal(id, safeCols, safeRows) }
  })

  register('devorbit:writeTerminal', (_event, id: unknown, input: unknown) => {
    assertTerminalId(id)
    if (typeof input !== 'string' || input.length > 64_000) throw new Error('Entrada de terminal inválida.')
    return { success: writeTerminal(id, input) }
  })

  register('devorbit:stopTerminal', (_event, id: unknown) => {
    assertTerminalId(id)
    // O stop mata o PTY antes do onExit registrar (sessions.delete precede o
    // kill), então fechamos a sessão de uso aqui para não perder a duração.
    dependencies.usage?.endUsageSession(id)
    stopTerminal(id)
    clearPipesFor(id)
    dependencies.turnSessions.delete(id)
    dependencies.cancelBridgeTarget(id)
    unregisterCompanionTerminal(id)
    return { success: true }
  })

  register('devorbit:pipeTerminals', (_event, fromId: unknown, toId: unknown) => {
    assertTerminalId(fromId)
    if (toId === null || toId === undefined) {
      clearPipe(fromId)
      return { success: true }
    }
    if (typeof toId !== 'string') throw new Error('Identificador de terminal inválido.')
    setPipe(fromId, toId)
    return { success: true }
  })

  register('devorbit:sendAgentTurn', async (
    _event,
    terminalId: unknown,
    provider: unknown,
    projectPath: string,
    prompt: unknown,
    timeouts?: unknown,
  ) => {
    assertTerminalId(terminalId)
    const safeProvider = validateAgentProvider(provider)
    if (safeProvider === 'codex') {
      throw new Error('O Codex usa o fluxo de conta do DevOrbit; use startCodexTerminal.')
    }
    const safePath = await validateProjectPath(projectPath)
    const safePrompt = normalizeAgentTurnPrompt(prompt)
    let idleMs: number | undefined
    let overallMs: number | undefined
    if (timeouts !== undefined && timeouts !== null) {
      if (typeof timeouts !== 'object' || Array.isArray(timeouts)) throw new Error('Timeouts do turno inválidos.')
      const raw = timeouts as Record<string, unknown>
      if (raw.idleMs !== undefined) idleMs = validateFiniteNumber(raw.idleMs, 'Timeout de ociosidade', { minimum: 1000, maximum: 600_000, integer: true })
      if (raw.overallMs !== undefined) overallMs = validateFiniteNumber(raw.overallMs, 'Timeout total', { minimum: 5000, maximum: 1800_000, integer: true })
    }
    const generation = dependencies.getTerminalLifecycleGeneration()
    const turnStartedAt = Date.now()
    let outcome: Awaited<ReturnType<typeof sendAgentTurn>>
    try {
      outcome = await sendAgentTurn(
      {
        getSession: (id) => dependencies.turnSessions.get(id),
        setSession: (id, session) => dependencies.turnSessions.set(id, session),
        clearSession: (id) => dependencies.turnSessions.delete(id),
        hasTerminal,
        spawn: async (id, turn) => {
          const turnConfig = await loadConfig()
          beginCompanionTerminalStart(id)
          const spawned = await spawnAgentProviderTerminal(
            {
              resolveWithFallback: resolveAgentProviderWithFallback,
              startTerminal: (spawnId, options) => startTerminal(spawnId, options.cwd ?? safePath, {
                ...options,
                env: { ...options.env, ...dependencies.bridgeEnv() },
              }),
              assertLive: () => dependencies.assertTerminalLifecycle(generation),
            },
            {
              id,
              candidate: turn.provider,
              model: turn.model,
              tier: turn.tier,
              routing: turnConfig.modelRouting,
              cols: 120,
              rows: 32,
              cwd: safePath,
            },
            turnConfig
          )
          registerCompanionTerminal(id, { projectPath: safePath })
          dependencies.registerBridgeAgent(id, {
            provider: spawned.provider,
            model: turn.model,
            projectPath: safePath,
          })
          return { provider: spawned.provider }
        },
        write: writeTerminal,
        waitResult: dependencies.waitTurnResult,
        waitReady: dependencies.waitTerminalReady,
        resolveTurn: async (candidate, taskPrompt) => {
          const turnConfig = await loadConfig()
          return resolveAgentTurn(turnConfig, candidate, taskPrompt)
        },
        orderProviders: orderProvidersForTask,
        readyProviders: async () => (await getAgentProviderHealth(await loadConfig()))
          .filter((item) => item.state === 'ready')
          .map((item) => item.id),
      },
      {
        terminalId,
        provider: safeProvider,
        prompt: safePrompt,
        ...(idleMs !== undefined || overallMs !== undefined
          ? { timeouts: { ...(idleMs !== undefined ? { idleMs } : {}), ...(overallMs !== undefined ? { overallMs } : {}) } }
          : {}),
      }
    )
      recordTurnUsage(dependencies.usage, terminalId, outcome, Date.now() - turnStartedAt)
      return { success: true, ...outcome }
    } catch (error) {
      // Turno que lança (timeout, spawn falho, resultado inválido) também é
      // uso: registra 'failed' com o provider pedido, sem mudar o erro.
      recordTurnUsage(dependencies.usage, terminalId, {
        provider: safeProvider,
        model: 'unknown',
      }, Date.now() - turnStartedAt, 'failed')
      throw error
    }
  })
}
