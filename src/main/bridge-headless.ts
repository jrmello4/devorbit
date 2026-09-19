import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { AgentProviderId } from '../renderer/src/types'
import { parseAgentResultLine, type AgentResultOutcome } from '../shared/agent-result'
import { stripAnsiEscapes } from '../shared/ansi'

export const HEADLESS_MAX_OUTPUT_BYTES = 512 * 1024
export const HEADLESS_DEFAULT_TIMEOUT_MS = 5 * 60_000
export const HEADLESS_MAX_TIMEOUT_MS = 60 * 60_000
export const HEADLESS_MAX_PROMPT_CHARS = 16 * 1024
export const HEADLESS_MAX_SUMMARY_CHARS = 1_000
export const HEADLESS_MAX_ARTIFACTS = 16
export const HEADLESS_ARTIFACT_MAX_CHARS = 240

export type HeadlessStatus = AgentResultOutcome

export interface HeadlessOutcome {
  status: HeadlessStatus
  summary: string
  artifacts?: string[]
}

export interface HeadlessInvocation {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** O prompt vai por stdin: nunca entra no argv (evita injeção de shell). */
  stdin: string
  /**
   * Windows: a linha já vem citada para o `cmd /s /c`; impede o Node de
   * re-escapar as aspas (o que quebraria caminhos com espaço).
   */
  windowsVerbatimArguments?: boolean
}

export interface HeadlessInvocationOptions {
  prompt: string
  model?: string
  mode?: string
  effort?: string
  agent?: string
  env?: NodeJS.ProcessEnv
}

export interface HeadlessTurnInput extends HeadlessInvocationOptions {
  provider: AgentProviderId
  commandPath?: string
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Contexto da delegação pai, repassado ao cliente bridge do filho. */
  origin?: string
  depth?: number
  visited?: string[]
}

export interface HeadlessRunnerDependencies {
  resolveCommand?: (provider: AgentProviderId) => Promise<string | null | undefined>
  spawnImpl?: typeof spawn
  /** Injetável para testes; default encerra a árvore (taskkill /T no Windows). */
  killTreeImpl?: HeadlessKillTree
}

export type HeadlessTurnRunner = (input: HeadlessTurnInput) => Promise<HeadlessOutcome>

const OPTION_TOKEN = /^[\w][\w.:+-]{0,199}$/u

/** Provedores com turno não-interativo (print mode) implementado no bridge. */
export const HEADLESS_PROVIDERS: readonly AgentProviderId[] = ['agy']

export function isHeadlessProvider(provider: AgentProviderId): boolean {
  return HEADLESS_PROVIDERS.includes(provider)
}

function assertOption(value: string | undefined, field: string): void {
  if (value !== undefined && !OPTION_TOKEN.test(value)) {
    throw Object.assign(new Error(`Opção ${field} do turno não-interativo é inválida.`), { code: 'HEADLESS_INVALID_OPTION' })
  }
}

function assertCommandPath(commandPath: string): void {
  if (
    typeof commandPath !== 'string' ||
    commandPath.trim().length === 0 ||
    commandPath.length > 4096 ||
    /[%!"\r\n\0]/u.test(commandPath)
  ) {
    throw Object.assign(new Error('Caminho do CLI não-interativo inválido.'), { code: 'HEADLESS_INVALID_COMMAND' })
  }
}

/**
 * Constrói o argv do agy em modo print. O modelo/modo/effort/agent são
 * validados como tokens; o prompt é entregue separadamente por stdin.
 */
export function buildAgyHeadlessInvocation(
  commandPath: string,
  options: HeadlessInvocationOptions,
): HeadlessInvocation {
  assertCommandPath(commandPath)
  assertOption(options.model, 'model')
  assertOption(options.mode, 'mode')
  assertOption(options.effort, 'effort')
  assertOption(options.agent, 'agent')
  if (typeof options.prompt !== 'string' || options.prompt.trim().length === 0 || options.prompt.length > HEADLESS_MAX_PROMPT_CHARS) {
    throw Object.assign(new Error('Prompt do turno não-interativo inválido.'), { code: 'HEADLESS_INVALID_PROMPT' })
  }

  const flags: string[] = ['--print', '--output-format', 'json']
  if (options.model) flags.push('--model', options.model)
  if (options.mode) flags.push('--mode', options.mode)
  if (options.effort) flags.push('--effort', options.effort)
  if (options.agent) flags.push('--agent', options.agent)

  const env = composeHeadlessEnv(options.env)
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(commandPath)) {
    // Wrapper .cmd: linha citada UMA vez e passada verbatim para
    // `cmd /d /s /c ""<cmd>" <flags>"`. Sem o quoting verbatim o Node
    // escaparia as aspas com `\` e caminhos com espaço quebrariam. O prompt
    // continua fora do argv.
    const line = `"${commandPath}" ${flags.join(' ')}`
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      env,
      stdin: options.prompt,
      windowsVerbatimArguments: true,
    }
  }

  return {
    command: commandPath,
    args: flags,
    env,
    stdin: options.prompt,
  }
}

/**
 * Compõe `process.env` (autenticação/perfis herdados) com o overlay de
 * provider/config e de bridge. Valores `undefined` no overlay não apagam nada.
 */
export function composeHeadlessEnv(overlay?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (overlay) {
    for (const [key, value] of Object.entries(overlay)) {
      if (value !== undefined) env[key] = value
    }
  }
  return env
}

function bounded(text: string, max = HEADLESS_MAX_SUMMARY_CHARS): string {
  const normalized = stripAnsiEscapes(text).replace(/\s+/gu, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
}

function sanitizeArtifacts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const artifacts: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = stripAnsiEscapes(entry).replace(/\s+/gu, ' ').trim().slice(0, HEADLESS_ARTIFACT_MAX_CHARS)
    if (trimmed) artifacts.push(trimmed)
    if (artifacts.length >= HEADLESS_MAX_ARTIFACTS) break
  }
  return artifacts.length > 0 ? artifacts : undefined
}

const STATUS_ALIASES: Readonly<Record<string, HeadlessStatus>> = {
  completed: 'completed',
  success: 'completed',
  ok: 'completed',
  done: 'completed',
  blocked: 'blocked',
  failed: 'failed',
  failure: 'failed',
  error: 'failed',
}

function outcomeFrom(value: unknown): HeadlessStatus | undefined {
  if (typeof value !== 'string') return undefined
  return STATUS_ALIASES[value.trim().toLowerCase()]
}

function summaryFromEnvelope(record: Record<string, unknown>): string | undefined {
  for (const key of ['summary', 'response', 'result', 'text', 'content', 'message', 'output']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim()) return bounded(candidate)
  }
  return undefined
}

/**
 * Interpreta a saída do CLI em print mode: primeiro o contrato
 * `DEVORBIT_RESULT:`, depois JSON (`--output-format json`) e por fim texto.
 */
export function parseHeadlessOutput(input: { stdout: string; stderr?: string; code: number | null }): HeadlessOutcome {
  const stdout = input.stdout ?? ''
  for (const line of stripAnsiEscapes(stdout).split(/\r?\n/u)) {
    const parsed = parseAgentResultLine(line)
    if (parsed.kind !== 'result') continue
    return {
      status: parsed.result.outcome,
      summary: bounded(parsed.result.summary),
    }
  }

  const trimmed = stripAnsiEscapes(stdout).trim()
  if (trimmed) {
    const jsonText = trimmed.startsWith('{') || trimmed.startsWith('[') ? trimmed : undefined
    if (jsonText) {
      try {
        const value: unknown = JSON.parse(jsonText)
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const record = value as Record<string, unknown>
          const status = outcomeFrom(record.status) ?? outcomeFrom(record.outcome) ?? (input.code === 0 ? 'completed' : 'failed')
          const summary = summaryFromEnvelope(record) ?? bounded(jsonText)
          const artifacts = sanitizeArtifacts(record.artifacts)
          return { status, summary, ...(artifacts ? { artifacts } : {}) }
        }
      } catch {
        // Não era JSON: cai no tratamento textual abaixo.
      }
    }
    const summary = bounded(trimmed)
    if (summary) return { status: input.code === 0 ? 'completed' : 'failed', summary }
  }

  const stderr = bounded(input.stderr ?? '')
  return {
    status: 'failed',
    summary: stderr || `O turno não-interativo terminou com código ${String(input.code ?? 'desconhecido')}.`,
  }
}

export type HeadlessKillTree = (pid: number | undefined, child: ChildProcess) => Promise<void>

/**
 * Encerra a ÁRVORE do processo (wrapper `.cmd` → filho real) e só resolve
 * quando o término é confirmado (ou após um teto de segurança). No Windows usa
 * `taskkill /T /F`; no POSIX mata o grupo (o filho é spawnado `detached`).
 */
export function terminateProcessTree(pid: number | undefined, child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, 5_000)

    if (!pid || pid <= 0) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Processo já encerrado.
      }
      finish()
      return
    }

    if (process.platform === 'win32') {
      let killer: ChildProcess
      try {
        killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } catch {
        try {
          child.kill()
        } catch {
          // Processo já encerrado.
        }
        finish()
        return
      }
      killer.once('close', finish)
      killer.once('error', finish)
      return
    }

    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // Processo já encerrado.
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      finish()
      return
    }
    child.once('close', finish)
  })
}

interface RunInvocationOptions {
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
  spawnImpl?: typeof spawn
  killTreeImpl?: HeadlessKillTree
}

export function runHeadlessInvocation(invocation: HeadlessInvocation, options: RunInvocationOptions): Promise<HeadlessOutcome> {
  return new Promise<HeadlessOutcome>((resolve, reject) => {
    const timeoutMs = Math.min(
      Math.max(options.timeoutMs ?? HEADLESS_DEFAULT_TIMEOUT_MS, 1_000),
      HEADLESS_MAX_TIMEOUT_MS,
    )
    const factory = options.spawnImpl ?? spawn
    const killTree = options.killTreeImpl ?? terminateProcessTree
    const child: ChildProcess = factory(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: invocation.env,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Grupo próprio no POSIX permite matar a árvore inteira.
      ...(process.platform === 'win32' ? {} : { detached: true }),
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const cleanup = (): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const settle = (value: HeadlessOutcome): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const killAndThen = (callback: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      // Resolve/rejeita somente DEPOIS de confirmar o término da árvore.
      void killTree(child.pid, child).then(callback, callback)
    }
    const onAbort = (): void => killAndThen(() => reject(
      Object.assign(new Error('O turno não-interativo foi cancelado.'), { code: 'HEADLESS_ABORTED' }),
    ))
    const timer = setTimeout(() => {
      killAndThen(() => resolve({ status: 'failed', summary: 'O turno não-interativo excedeu o tempo limite.' }))
    }, timeoutMs)

    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) {
      onAbort()
      return
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < HEADLESS_MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < HEADLESS_MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(Object.assign(new Error(`Falha ao iniciar ${invocation.command}: ${error.message}`), { code: 'HEADLESS_SPAWN_ERROR' }))
    })
    child.on('close', (code) => {
      if (settled) return
      settle(parseHeadlessOutput({ stdout, stderr, code }))
    })

    try {
      // `end()` pode falhar assincronamente (EPIPE quando o CLI fecha stdin
      // cedo). O close do filho continua sendo a fonte do resultado.
      child.stdin?.once?.('error', () => undefined)
      child.stdin?.end(`${invocation.stdin}\n`)
    } catch {
      // Se o stdin fechar, o close do processo ainda resolve.
    }
  })
}

export function createHeadlessTurnRunner(dependencies: HeadlessRunnerDependencies = {}): HeadlessTurnRunner {
  return async (input) => {
    if (!isHeadlessProvider(input.provider)) {
      throw Object.assign(new Error(`${input.provider} não suporta turno não-interativo.`), { code: 'HEADLESS_UNSUPPORTED' })
    }
    const commandPath = input.commandPath || (dependencies.resolveCommand ? await dependencies.resolveCommand(input.provider) : undefined)
    if (!commandPath) {
      throw Object.assign(new Error(`Binário de ${input.provider} não encontrado.`), { code: 'HEADLESS_COMMAND_MISSING' })
    }
    const invocation = buildAgyHeadlessInvocation(commandPath, {
      prompt: input.prompt,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
    })
    return await runHeadlessInvocation(invocation, {
      cwd: input.cwd,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(dependencies.spawnImpl !== undefined ? { spawnImpl: dependencies.spawnImpl } : {}),
      ...(dependencies.killTreeImpl !== undefined ? { killTreeImpl: dependencies.killTreeImpl } : {}),
    })
  }
}
