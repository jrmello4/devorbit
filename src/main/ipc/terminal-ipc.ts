import {
  ensureAccountDirectories,
  getAccountLabel,
  getCodexAccountEnvironment,
  hasValidCodexAuth,
  resolveCodexCommand,
} from '../account-profiles'
import {
  executeExplicitAgentTurn,
  getAgentProviderHealth,
  orderProvidersForTask,
  resolveAgentProviderWithFallback,
  resolveAgentTurn,
} from '../agent-providers'
import { sendAgentTurn, spawnAgentProviderTerminal, type ResultWaitPromise } from '../agent-turn'
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
import { validateAgentProvider, validateCodexAccount, validateFiniteNumber } from '../validation'
import type { IpcRegistrar } from './registrar'
import type { AgentProviderId } from '../../renderer/src/types'

export interface TerminalIpcDependencies {
  getTerminalLifecycleGeneration: () => number
  assertTerminalLifecycle: (generation: number) => void
  bridgeEnv: () => NodeJS.ProcessEnv
  registerBridgeAgent: (id: string, agent: { provider: AgentProviderId; model: string; projectPath: string }) => void
  cancelBridgeTarget: (id: string) => void
  turnSessions: Map<string, { provider: AgentProviderId; model: string }>
  waitTurnResult: (id: string, timeouts: { idleMs: number; overallMs: number }) => ResultWaitPromise
}

function assertTerminalId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(id)) throw new Error('Identificador de terminal inválido.')
}

export function registerTerminalIpc(register: IpcRegistrar, dependencies: TerminalIpcDependencies): void {
  register('devorbit:startTerminal', async (_event, id: unknown, projectPath: string, cols?: unknown, rows?: unknown) => {
    assertTerminalId(id)
    const generation = dependencies.getTerminalLifecycleGeneration()
    const safePath = await validateProjectPath(projectPath)
    dependencies.assertTerminalLifecycle(generation)
    const safeCols = cols === undefined ? undefined : validateFiniteNumber(cols, 'Colunas do terminal', { minimum: TERMINAL_MIN_COLS, maximum: TERMINAL_MAX_COLS, integer: true })
    const safeRows = rows === undefined ? undefined : validateFiniteNumber(rows, 'Linhas do terminal', { minimum: TERMINAL_MIN_ROWS, maximum: TERMINAL_MAX_ROWS, integer: true })
    beginCompanionTerminalStart(id)
    const started = await startTerminal(id, safePath, {
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
    const args = isScript ? ['/d', '/q', '/k', 'call "' + codexCommand + '"'] : []
    dependencies.assertTerminalLifecycle(generation)
    beginCompanionTerminalStart(id)
    const result = await startTerminal(id, safePath, {
      command,
      args,
      env: { ...getCodexAccountEnvironment(safeAccount), ...dependencies.bridgeEnv() },
      cols: safeCols,
      rows: safeRows,
    })
    registerCompanionTerminal(id, { projectPath: safePath })
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
    const safeTask = task === undefined || task === null ? undefined : String(task).slice(0, 8000)
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
          startTerminal: (spawnId, options) => startTerminal(spawnId, safePath, {
            ...options,
            env: { ...options.env, ...dependencies.bridgeEnv() },
          }),
          assertLive: () => dependencies.assertTerminalLifecycle(generation),
        },
        {
          id,
          candidate,
          model: turn.model,
          tier: turn.tier,
          routing: config.modelRouting,
          cols: safeCols,
          rows: safeRows,
        },
        config
      )
      return { started: spawned.started, provider: spawned.provider, command: spawned.command }
    })
    registerCompanionTerminal(id, { projectPath: safePath })
    dependencies.registerBridgeAgent(id, {
      provider: execution.result.provider ?? execution.provider,
      model: turn.model,
      projectPath: safePath,
    })
    return {
      success: true,
      ...execution.result.started,
      provider: execution.result.provider ?? execution.provider,
      command: execution.result.command,
      tier: turn.tier,
      model: turn.model,
      fallback: false,
      message: (execution.result.provider ?? execution.provider) + ' iniciado no terminal interno. Se precisar, autentique pelo próprio CLI.',
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
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000) throw new Error('Prompt do turno inválido.')
    let idleMs: number | undefined
    let overallMs: number | undefined
    if (timeouts !== undefined && timeouts !== null) {
      if (typeof timeouts !== 'object' || Array.isArray(timeouts)) throw new Error('Timeouts do turno inválidos.')
      const raw = timeouts as Record<string, unknown>
      if (raw.idleMs !== undefined) idleMs = validateFiniteNumber(raw.idleMs, 'Timeout de ociosidade', { minimum: 1000, maximum: 600_000, integer: true })
      if (raw.overallMs !== undefined) overallMs = validateFiniteNumber(raw.overallMs, 'Timeout total', { minimum: 5000, maximum: 1800_000, integer: true })
    }
    const generation = dependencies.getTerminalLifecycleGeneration()
    const outcome = await sendAgentTurn(
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
              startTerminal: (spawnId, options) => startTerminal(spawnId, safePath, {
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
        prompt,
        ...(idleMs !== undefined || overallMs !== undefined
          ? { timeouts: { ...(idleMs !== undefined ? { idleMs } : {}), ...(overallMs !== undefined ? { overallMs } : {}) } }
          : {}),
      }
    )
    return { success: true, ...outcome }
  })
}
