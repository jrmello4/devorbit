import {
  ensureAccountDirectories,
  getAccountLabel,
  getCodexAccountEnvironment,
  hasValidCodexAuth,
  resolveCodexCommand,
} from '../account-profiles'
import { prepareDevOrbitCodexLaunch } from '../codex-mcp-launch'
import type { CodexBridgeHealthStore } from '../codex-bridge-health'
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
  resolveProviderInstructionHints,
} from '../agent-providers'
import { sendAgentTurn, spawnAgentProviderTerminal, TURN_MAX_PROMPT_CHARS, TURN_READY_QUIET_MS, TURN_READY_TIMEOUT_MS, type ResultWaitPromise, type TerminalReadyOptions, type TerminalReadyResult } from '../agent-turn'
import { sendAgentInstruction } from '../agent-instruction'
import { createTerminalPasteMode } from '../terminal-paste-mode'
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
  onTerminalEvent,
  resizeTerminal,
  startTerminal,
  stopTerminal,
  writeTerminal,
} from '../terminal-session'
import { validateAgentProvider, validateCodexAccount, validateFiniteNumber, validateTerminalStartOptions } from '../validation'
import { resolveWindowsScriptLaunch } from '../terminal-launch'
import type { UsageEvent } from '../../shared/usage-contract'
import type { IpcRegistrar } from './registrar'
import type { AgentProviderId } from '../../shared/agent-provider-contract'

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
  waitTerminalReady: (id: string, options?: TerminalReadyOptions) => Promise<TerminalReadyResult>
  /** Main-process store for managed Codex MCP launch health. */
  codexBridgeHealth?: CodexBridgeHealthStore
  usage?: UsageRecorder
}

function assertTerminalId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(id)) throw new Error('Identificador de terminal inválido.')
}

/**
 * O canvas monta o prompt a partir das notas conectadas e pode exceder o teto
 * do turno. A fronteira IPC trunca no mesmo limite que `agent-turn` aplica
 * (64 KiB — protege contra acidentes, não contra handoffs completos), em vez
 * de rejeitar a tarefa inteira.
 */
export function normalizeAgentTurnPrompt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Prompt do turno inválido.')
  return value.slice(0, TURN_MAX_PROMPT_CHARS)
}

/** Payload do canal `devorbit:submitAgentInstruction` (renderer → main). */
export interface AgentInstructionPayload {
  turnId: string
  content: string
}

/**
 * Capability dinâmica de bracketed paste (ESC[?2004h/l) observada no barramento
 * PTY — instância única do processo main, compartilhada pelos caminhos de
 * instrução deste módulo (Canvas + canal do Codex) e pelo Bridge (index.ts).
 * Só rastreia terminais de AGENTE (sessão de turno registrada em
 * registerTerminalIpc): em shell, o usuário pode `cat`/`type` um arquivo com
 * os bytes 2004h/l e o eco seria confundido com anúncio da TUI.
 */
let shouldTrackPasteMode: (id: string) => boolean = () => false
export const terminalPasteMode = createTerminalPasteMode(onTerminalEvent, (id) => shouldTrackPasteMode(id))

const MAX_AGENT_TURN_ID_CHARS = 128

/**
 * Valida o payload da submissão centralizada: turnId curto para telemetria e
 * conteúdo limitado ao mesmo teto do turno. Multiline chega verbatim.
 */
export function normalizeAgentInstructionPayload(value: unknown): AgentInstructionPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Instrução do agente inválida.')
  }
  const raw = value as Record<string, unknown>
  if (typeof raw.turnId !== 'string' || !raw.turnId.trim()) throw new Error('turnId da instrução inválido.')
  if (typeof raw.content !== 'string' || !raw.content.trim()) throw new Error('Conteúdo da instrução inválido.')
  return {
    turnId: raw.turnId.trim().slice(0, MAX_AGENT_TURN_ID_CHARS),
    content: raw.content.slice(0, TURN_MAX_PROMPT_CHARS),
  }
}

function isManagedCodexCommand(command: string): boolean {
  const leaf = command.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() || ''
  const stem = leaf.replace(/\.(?:cmd|bat|exe)$/i, '')
  return stem === 'codex' || /(?:^[-_.]|[-_.])codex(?:[-_.]|$)/i.test(stem)
}

async function validateCodexBaseArgs(value: unknown): Promise<string[]> {
  if (value === undefined || value === null) return []
  const options = await validateTerminalStartOptions({ args: value })
  return options ? [...(options.args || [])] : []
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
  const terminalLaunchAttempts = new Map<string, symbol>()
  const beginTerminalLaunch = (id: string): symbol => {
    const attempt = Symbol(id)
    terminalLaunchAttempts.set(id, attempt)
    return attempt
  }
  const isCurrentTerminalLaunch = (id: string, attempt: symbol, generation: number): boolean => {
    if (terminalLaunchAttempts.get(id) !== attempt) return false
    try {
      dependencies.assertTerminalLifecycle(generation)
      return true
    } catch {
      return false
    }
  }
  const assertCurrentTerminalLaunch = (id: string, attempt: symbol, generation: number): void => {
    if (!isCurrentTerminalLaunch(id, attempt, generation)) {
      throw Object.assign(new Error('O lançamento do terminal foi cancelado ou substituído.'), { code: 'TERMINAL_LAUNCH_CANCELLED' })
    }
  }
  const codexLaunchLockTails = new Map<string, Promise<void>>()
  const acquireCodexLaunchLock = async (id: string): Promise<() => void> => {
    const previous = codexLaunchLockTails.get(id) ?? Promise.resolve()
    let unlockCurrent!: () => void
    const held = new Promise<void>((resolve) => { unlockCurrent = resolve })
    const tail = previous.catch(() => undefined).then(() => held)
    codexLaunchLockTails.set(id, tail)
    await previous.catch(() => undefined)
    return () => {
      unlockCurrent()
      if (codexLaunchLockTails.get(id) === tail) codexLaunchLockTails.delete(id)
    }
  }

  // Bracketed paste só é observado em terminais de agente (com sessão de
  // turno); shell comum não é rastreado (evita falso 2004h/l ecoado).
  shouldTrackPasteMode = (id) => dependencies.turnSessions.has(id)
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
    const attempt = beginTerminalLaunch(id)
    const safePath = await validateProjectPath(projectPath)
    assertCurrentTerminalLaunch(id, attempt, generation)
    const startOptions = await validateTerminalStartOptions(options)
    assertCurrentTerminalLaunch(id, attempt, generation)
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
    if (startOptions?.command !== undefined && isManagedCodexCommand(startOptions.command)) {
      throw new Error('O Codex usa o lançador gerenciado por conta; use o terminal Codex da conta selecionada.')
    }
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
    assertCurrentTerminalLaunch(id, attempt, generation)
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
    baseArgs?: unknown,
  ) => {
    assertTerminalId(id)
    const generation = dependencies.getTerminalLifecycleGeneration()
    const safeAccount = validateCodexAccount(account)
    const attempt = beginTerminalLaunch(id)
    const isCurrentLaunch = (): boolean => {
      return isCurrentTerminalLaunch(id, attempt, generation)
    }
    const assertCurrentLaunch = (): void => {
      if (!isCurrentLaunch()) {
        throw Object.assign(new Error('O lançamento Codex foi cancelado ou substituído.'), { code: 'CODEX_LAUNCH_CANCELLED' })
      }
    }
    const safePath = await validateProjectPath(projectPath)
    assertCurrentLaunch()
    const safeBaseArgs = await validateCodexBaseArgs(baseArgs)
    assertCurrentLaunch()
    const config = await loadConfig()
    assertCurrentLaunch()
    const { codexHome } = await ensureAccountDirectories(safeAccount)
    assertCurrentLaunch()
    const accountLabel = getAccountLabel(safeAccount, {
      account1: config.chatGptAccount1Name,
      account2: config.chatGptAccount2Name,
    })
    const hasAuth = await hasValidCodexAuth(codexHome)
    assertCurrentLaunch()
    if (!hasAuth) {
      if (terminalLaunchAttempts.get(id) === attempt) terminalLaunchAttempts.delete(id)
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
    assertCurrentLaunch()
    if (/[%!]/.test(codexCommand)) {
      if (terminalLaunchAttempts.get(id) === attempt) terminalLaunchAttempts.delete(id)
      return { success: false, fallback: false, account: safeAccount, message: 'O caminho configurado do Codex contém caracteres que o terminal não pode executar com segurança.' }
    }
    const isScript = /\.(?:cmd|bat)$/i.test(codexCommand)
    // The managed wrapper uses cmd /c so a failed Codex process cannot leave
    // an idle shell in the registered PTY.
    assertCurrentLaunch()
    beginCompanionTerminalStart(id)
    const bridgeHealth = dependencies.codexBridgeHealth
    const accountEnvironment = getCodexAccountEnvironment(safeAccount)
    const bridgeEnvironment = dependencies.bridgeEnv()
    const runtimeArgs = (prepared: ReturnType<typeof prepareDevOrbitCodexLaunch>): { command: string; args: string[] } => {
      if (!isScript) return { command: codexCommand, args: prepared.args }
      // Keep each config override as a node-pty argument. Embedded TOML
      // quotes must reach `cmd /c call` unchanged.
      const wrapped = resolveWindowsScriptLaunch(codexCommand, prepared.args, { allowQuotedArguments: true, keepShellOpen: false })
      return { command: wrapped.command, args: wrapped.args }
    }
    const prepareLaunch = () => prepareDevOrbitCodexLaunch({
      accountEnvironment,
      bridgeEnv: bridgeEnvironment,
      terminalId: id,
      baseArgs: safeBaseArgs,
    })
    const configureHealth = (prepared: ReturnType<typeof prepareDevOrbitCodexLaunch>): void => {
      bridgeHealth?.configure(id, prepared.mcp.launchId, prepared.env.DEVORBIT_SESSION_ID || '')
    }
    const markConnecting = (prepared: ReturnType<typeof prepareDevOrbitCodexLaunch>): void => {
      bridgeHealth?.connecting(id, prepared.mcp.launchId)
    }
    const markStartFailure = (prepared: ReturnType<typeof prepareDevOrbitCodexLaunch>): void => {
      bridgeHealth?.fail(id, 'MCP_STARTUP_FAILED', prepared.mcp.launchId)
    }

    let prepared = prepareLaunch()
    configureHealth(prepared)
    let direct: { command: string; args: string[] }
    let launchPlan: Awaited<ReturnType<typeof prepareAiMemoryLaunch>>
    let releaseLaunchLock: (() => void) | undefined = await acquireCodexLaunchLock(id)
    const unlockLaunch = (): void => {
      const release = releaseLaunchLock
      releaseLaunchLock = undefined
      release?.()
    }
    try {
    try {
      assertCurrentLaunch()
      direct = runtimeArgs(prepared)
      launchPlan = await prepareAiMemoryLaunch({
        provider: 'codex',
        resolvedCommand: codexCommand,
        // ai-memory invokes the same Codex argv after `--` as direct execution.
        originalArgs: prepared.args,
        env: prepared.env,
        cwd: safePath,
        terminalId: id,
        reservationId: prepared.mcp.launchId,
        account: safeAccount,
      })
      assertCurrentLaunch()
    } catch (error) {
      // No PTY exists yet. Release only the pending scope reservation and
      // leave any older active ai-memory session untouched.
      releaseAiMemoryReservation(id, prepared.mcp.launchId)
      if (isCurrentLaunch()) markStartFailure(prepared)
      unlockLaunch()
      throw error
    }

    let result: { id: string; pid: number | undefined }
    let usedWrapper = false
    if (launchPlan.wrapped) {
      try {
        usedWrapper = true
        result = await startTerminal(id, safePath, {
          command: launchPlan.command,
          args: launchPlan.args,
          env: launchPlan.env,
          cols: safeCols,
          rows: safeRows,
        })
        assertCurrentLaunch()
        // Após o spawn: o flush da sessão antiga cai fora da janela
        // 'connecting' — saída velha nunca é atribuída à saúde do launch novo.
        markConnecting(prepared)
        if (launchPlan.metadata) {
          if (!hasTerminal(id)) {
            rollbackAiMemoryLaunch(id, prepared.mcp.launchId)
          } else {
            registerActiveAiMemorySession(launchPlan.metadata)
          }
        }
        // The process and ai-memory registration are now established. Let a
        // newer start proceed while this MCP waits for its own handshake.
        unlockLaunch()
        // A successful ai-memory spawn does not prove the MCP loaded.  A
        // controlled early exit is recovered by a direct launch below.
        if (bridgeHealth) {
          await bridgeHealth.waitConnected(id)
          assertCurrentLaunch()
        }
      } catch (error) {
        // Stop/reopen or a newer launch owns this id now. Never stop its PTY
        // and never fallback from the older wrapper.
        if (!isCurrentLaunch()) {
          unlockLaunch()
          throw error
        }
        if (!releaseLaunchLock) releaseLaunchLock = await acquireCodexLaunchLock(id)
        assertCurrentLaunch()
        rollbackAiMemoryLaunch(id, prepared.mcp.launchId)
        stopTerminal(id)
        // A launch id is single-use; late handshakes from the failed wrapper
        // must never mark the direct retry as connected.
        prepared = prepareLaunch()
        configureHealth(prepared)
        console.warn('[DevOrbit] Wrapper ai-memory do Codex falhou antes do MCP; usando execução direta.')
        try {
          const fallback = runtimeArgs(prepared)
          result = await startTerminal(id, safePath, {
            command: fallback.command,
            args: fallback.args,
            env: prepared.env,
            cols: safeCols,
            rows: safeRows,
          })
          assertCurrentLaunch()
          markConnecting(prepared)
          unlockLaunch()
        } catch (fallbackError) {
          if (isCurrentLaunch()) markStartFailure(prepared)
          throw fallbackError
        }
      }
    } else {
      try {
        result = await startTerminal(id, safePath, {
          command: direct.command,
          args: direct.args,
          env: prepared.env,
          cols: safeCols,
          rows: safeRows,
        })
        assertCurrentLaunch()
        // Após o spawn: flush da sessão antiga fora da janela 'connecting'.
        markConnecting(prepared)
        if (launchPlan.metadata) {
          if (!hasTerminal(id)) rollbackAiMemoryLaunch(id, prepared.mcp.launchId)
          else registerActiveAiMemorySession(launchPlan.metadata)
        }
        unlockLaunch()
      } catch (error) {
        releaseAiMemoryReservation(id, prepared.mcp.launchId)
        if (isCurrentLaunch()) markStartFailure(prepared)
        throw error
      }
    }
    assertCurrentLaunch()
    unlockLaunch()
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
      bridgeHealth: bridgeHealth?.get(id),
      message: usedWrapper && bridgeHealth?.get(id)?.state === 'connected'
        ? 'Codex conectado no terminal interno (' + accountLabel + ').'
        : 'Codex iniciado no terminal interno (' + accountLabel + '); aguardando MCP DevOrbit.',
    }
    } finally {
      unlockLaunch()
    }
  })

  register('devorbit:getCodexBridgeHealth', (_event, id: unknown) => {
    assertTerminalId(id)
    return dependencies.codexBridgeHealth?.get(id)
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
    const generation = dependencies.getTerminalLifecycleGeneration()
    const attempt = beginTerminalLaunch(id)
    const assertCurrentAgentLaunch = (): void => assertCurrentTerminalLaunch(id, attempt, generation)
    const safePath = await validateProjectPath(projectPath)
    assertCurrentAgentLaunch()
    const config = await loadConfig()
    assertCurrentAgentLaunch()
    const turn = await resolveAgentTurn(config, safeProvider, safeTask)
    assertCurrentAgentLaunch()
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
      assertCurrentAgentLaunch()
      const spawned = await spawnAgentProviderTerminal(
        {
          resolveWithFallback: resolveAgentProviderWithFallback,
          startTerminal: (spawnId, options) => {
            assertCurrentAgentLaunch()
            return startTerminal(spawnId, options.cwd ?? safePath, {
              ...options,
              env: { ...options.env, ...dependencies.bridgeEnv() },
            })
          },
          assertLive: assertCurrentAgentLaunch,
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
      assertCurrentAgentLaunch()
      return { started: spawned.started, provider: spawned.provider, command: spawned.command }
    })
    assertCurrentAgentLaunch()
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
    terminalLaunchAttempts.delete(id)
    // O stop mata o PTY antes do onExit registrar (sessions.delete precede o
    // kill), então fechamos a sessão de uso aqui para não perder a duração.
    dependencies.usage?.endUsageSession(id)
    stopTerminal(id)
    dependencies.codexBridgeHealth?.stop(id)
    // Capability dinâmica morre com o PTY (exit/error também limpam; o stop
    // pode preceder o evento de exit).
    terminalPasteMode.reset(id)
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
    turnId?: unknown,
  ) => {
    assertTerminalId(terminalId)
    const safeProvider = validateAgentProvider(provider)
    if (safeProvider === 'codex') {
      throw new Error('O Codex usa o fluxo de conta do DevOrbit; use startCodexTerminal.')
    }
    const safePrompt = normalizeAgentTurnPrompt(prompt)
    // turnId do renderer (payload do preload): propaga para telemetria/logs de
    // orquestração; ausente → o próprio turno gera um default.
    const safeTurnId = turnId === undefined || turnId === null
      ? undefined
      : String(turnId).trim().slice(0, 128) || undefined
    let idleMs: number | undefined
    let overallMs: number | undefined
    if (timeouts !== undefined && timeouts !== null) {
      if (typeof timeouts !== 'object' || Array.isArray(timeouts)) throw new Error('Timeouts do turno inválidos.')
      const raw = timeouts as Record<string, unknown>
      if (raw.idleMs !== undefined) idleMs = validateFiniteNumber(raw.idleMs, 'Timeout de ociosidade', { minimum: 1000, maximum: 600_000, integer: true })
      if (raw.overallMs !== undefined) overallMs = validateFiniteNumber(raw.overallMs, 'Timeout total', { minimum: 5000, maximum: 1800_000, integer: true })
    }
    const generation = dependencies.getTerminalLifecycleGeneration()
    // Turnos são serializados por sendAgentTurn. Enfileirar o próximo turno
    // não é um novo lançamento e não deve cancelar aquele que está rodando.
    // Um start/reopen explícito ainda troca o token e cancela os turnos antigos.
    const attempt = terminalLaunchAttempts.get(terminalId) ?? beginTerminalLaunch(terminalId)
    const assertCurrentTurn = (): void => assertCurrentTerminalLaunch(terminalId, attempt, generation)
    const safePath = await validateProjectPath(projectPath)
    assertCurrentTurn()
    const turnStartedAt = Date.now()
    let outcome: Awaited<ReturnType<typeof sendAgentTurn>>
    try {
      outcome = await sendAgentTurn(
      {
        getSession: (id) => {
          assertCurrentTurn()
          return dependencies.turnSessions.get(id)
        },
        setSession: (id, session) => {
          assertCurrentTurn()
          dependencies.turnSessions.set(id, session)
        },
        clearSession: (id) => {
          if (isCurrentTerminalLaunch(id, attempt, generation)) dependencies.turnSessions.delete(id)
        },
        hasTerminal: (id) => {
          assertCurrentTurn()
          return hasTerminal(id)
        },
        spawn: async (id, turn) => {
          assertCurrentTurn()
          const turnConfig = await loadConfig()
          assertCurrentTurn()
          beginCompanionTerminalStart(id)
          const spawned = await spawnAgentProviderTerminal(
            {
              resolveWithFallback: resolveAgentProviderWithFallback,
              startTerminal: async (spawnId, options) => {
                assertCurrentTurn()
                const started = await startTerminal(spawnId, options.cwd ?? safePath, {
                  ...options,
                  env: { ...options.env, ...dependencies.bridgeEnv() },
                })
                assertCurrentTurn()
                return started
              },
              assertLive: assertCurrentTurn,
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
          assertCurrentTurn()
          registerCompanionTerminal(id, { projectPath: safePath })
          dependencies.registerBridgeAgent(id, {
            provider: spawned.provider,
            model: turn.model,
            projectPath: safePath,
          })
          return { provider: spawned.provider }
        },
        write: (id, input) => {
          assertCurrentTurn()
          return writeTerminal(id, input)
        },
        sendInstruction: (input) => sendAgentInstruction(
          {
            hasTerminal: (id) => {
              assertCurrentTurn()
              return hasTerminal(id)
            },
            waitReady: dependencies.waitTerminalReady,
            write: (id, content) => {
              assertCurrentTurn()
              return writeTerminal(id, content)
            },
            subscribe: onTerminalEvent,
            now: () => Date.now(),
            isBracketedPasteEnabled: terminalPasteMode.isBracketedPasteEnabled,
          },
          // Hints do provider efetivo do turno (catálogo em agent-providers):
          // 'unknown'/sem hints → undefined (heurística default).
          { ...input, hints: resolveProviderInstructionHints(input.provider) }
        ),
        waitResult: (id, options) => {
          assertCurrentTurn()
          return dependencies.waitTurnResult(id, options)
        },
        waitReady: async (id, options) => {
          assertCurrentTurn()
          const ready = await dependencies.waitTerminalReady(id, options)
          assertCurrentTurn()
          return ready
        },
        resolveTurn: async (candidate, taskPrompt) => {
          assertCurrentTurn()
          const turnConfig = await loadConfig()
          assertCurrentTurn()
          const resolved = await resolveAgentTurn(turnConfig, candidate, taskPrompt)
          assertCurrentTurn()
          return resolved
        },
        orderProviders: orderProvidersForTask,
        readyProviders: async () => {
          assertCurrentTurn()
          const turnConfig = await loadConfig()
          assertCurrentTurn()
          const providers = await getAgentProviderHealth(turnConfig)
          assertCurrentTurn()
          return providers.filter((item) => item.state === 'ready').map((item) => item.id)
        },
      },
      {
        terminalId,
        provider: safeProvider,
        prompt: safePrompt,
        ...(safeTurnId !== undefined ? { turnId: safeTurnId } : {}),
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

  // Submissão centralizada da instrução para o caminho Codex gerenciado no
  // renderer: o Enter é enviado por `sendAgentInstruction` (prontidão por
  // turno + ack), nunca por writeTerminal espalhado.
  register('devorbit:submitAgentInstruction', async (
    _event,
    terminalId: unknown,
    payload: unknown,
  ) => {
    assertTerminalId(terminalId)
    const instruction = normalizeAgentInstructionPayload(payload)
    // A Codex PTY is not ready merely because the process spawned.  Require
    // the managed MCP handshake and an active Bridge registration before the
    // first instruction reaches the terminal.
    if (dependencies.codexBridgeHealth) await dependencies.codexBridgeHealth.waitReady(terminalId)
    const result = await sendAgentInstruction(
      {
        hasTerminal,
        waitReady: dependencies.waitTerminalReady,
        write: writeTerminal,
        subscribe: onTerminalEvent,
        now: () => Date.now(),
        isBracketedPasteEnabled: terminalPasteMode.isBracketedPasteEnabled,
      },
      {
        terminalId,
        turnId: instruction.turnId,
        content: instruction.content,
        provider: 'codex',
        // Hints do provider fixo deste canal (resolução O(1) no catálogo).
        hints: resolveProviderInstructionHints('codex'),
        quietMs: TURN_READY_QUIET_MS,
        timeoutMs: TURN_READY_TIMEOUT_MS,
      }
    )
    return { success: result.acked, ...result }
  })
}
