import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Disposable } from '../shared/disposable'

export const DEFAULT_PROCESS_TIMEOUT_MS = 30_000
export const DEFAULT_PROCESS_MAX_OUTPUT_BYTES = 1_000_000
export const PROCESS_TERMINATION_GRACE_MS = 250

export type ProcessRunStatus =
  | 'completed'
  | 'timed-out'
  | 'cancelled'
  | 'output-limit'
  | 'spawn-failed'

export interface ProcessRunnerDefaults {
  timeoutMs?: number
  maxOutputBytes?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface ProcessRunOptions extends ProcessRunnerDefaults {
  command: string
  args?: readonly string[]
  signal?: AbortSignal
}

export interface ProcessRunResult {
  command: string
  args: string[]
  status: ProcessRunStatus
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  truncated: boolean
  durationMs: number
  error?: string
}

function quoteWindowsCommandLineArg(value: string): string {
  if (value.length === 0) return '""'
  const needsQuotes = /[ \t"&|<>^()]/u.test(value)
  if (!needsQuotes) return value
  const escaped = value.replace(/"/g, '""').replace(/(\\+)$/u, '$1$1')
  return `"${escaped}"`
}

function npmCliScriptName(tool: string): string | undefined {
  if (tool === 'npm') return 'npm-cli.js'
  if (tool === 'npx') return 'npx-cli.js'
  return undefined
}

function resolveNpmCli(tool: string): string | undefined {
  const scriptName = npmCliScriptName(tool)
  if (!scriptName) return undefined
  const execPath = process.env.npm_execpath
  if (execPath && path.basename(execPath).toLowerCase() === scriptName && existsSync(execPath)) {
    return execPath
  }
  const searchDirectories = [
    path.dirname(process.execPath),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean),
  ]
  for (const directory of [...new Set(searchDirectories)]) {
    const candidate = path.join(directory, 'node_modules', 'npm', 'bin', scriptName)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export function resolveProcessInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (platform !== 'win32') {
    return { command, args: [...args], windowsVerbatimArguments: false }
  }
  const tool = /^(npm|npx)(?:\.(?:cmd|exe))?$/iu.exec(command)?.[1]?.toLowerCase()
  let resolvedCommand = command
  if (tool) {
    const cliScript = resolveNpmCli(tool)
    if (cliScript) {
      return { command: process.execPath, args: [cliScript, ...args], windowsVerbatimArguments: false }
    }
    resolvedCommand = `${tool}.cmd`
  }
  if (/\.(?:cmd|bat)$/iu.test(resolvedCommand)) {
    const commandLine = [resolvedCommand, ...args].map(quoteWindowsCommandLineArg).join(' ')
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', `"${commandLine}"`],
      windowsVerbatimArguments: true,
    }
  }
  return { command: resolvedCommand, args: [...args], windowsVerbatimArguments: false }
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function terminateChild(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill('SIGTERM')
  } catch (error) {
    void error
  }
  const escalation = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch (error) {
      void error
    }
  }, PROCESS_TERMINATION_GRACE_MS)
  escalation.unref()
  child.once('close', () => clearTimeout(escalation))
}

export class ProcessRunner implements Disposable {
  private readonly children = new Set<ChildProcess>()
  private readonly controller = new AbortController()
  private readonly defaults: ProcessRunnerDefaults
  private isDisposed = false

  constructor(defaults: ProcessRunnerDefaults = {}) {
    this.defaults = defaults
  }

  get disposed(): boolean {
    return this.isDisposed
  }

  run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    if (this.isDisposed) return Promise.reject(new Error('ProcessRunner indisponível.'))
    const command = typeof options.command === 'string' ? options.command.trim() : ''
    if (!command) return Promise.reject(new Error('Comando inválido.'))
    const args = Array.isArray(options.args) ? options.args.map((value) => String(value)) : []
    const timeoutMs = positiveInteger(
      options.timeoutMs ?? this.defaults.timeoutMs,
      DEFAULT_PROCESS_TIMEOUT_MS,
    )
    const maxOutputBytes = positiveInteger(
      options.maxOutputBytes ?? this.defaults.maxOutputBytes,
      DEFAULT_PROCESS_MAX_OUTPUT_BYTES,
    )
    const cwd = options.cwd ?? this.defaults.cwd
    const env = options.env ?? this.defaults.env ?? process.env
    const startedAt = Date.now()

    return new Promise<ProcessRunResult>((resolve) => {
      const outChunks: Buffer[] = []
      const errChunks: Buffer[] = []
      let outBytes = 0
      let errBytes = 0
      let child: ChildProcess | null = null
      let settled = false
      let failure: 'timed-out' | 'cancelled' | 'output-limit' | null = null
      let spawnError: string | undefined
      let truncated = false

      const settle = (
        status: ProcessRunStatus,
        code: number | null,
        signal: NodeJS.Signals | null,
      ): void => {
        if (settled) return
        settled = true
        clearTimeout(timeoutTimer)
        options.signal?.removeEventListener('abort', onAbort)
        this.controller.signal.removeEventListener('abort', onAbort)
        if (child) this.children.delete(child)
        resolve({
          command,
          args,
          status,
          code,
          signal,
          stdout: Buffer.concat(outChunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
          stdoutBytes: outBytes,
          stderrBytes: errBytes,
          truncated,
          durationMs: Date.now() - startedAt,
          ...(spawnError === undefined ? {} : { error: spawnError }),
        })
      }

      const markFailure = (status: 'timed-out' | 'cancelled' | 'output-limit'): void => {
        if (!failure) failure = status
        terminateChild(child)
      }

      const onAbort = (): void => {
        markFailure('cancelled')
      }

      const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
        if (settled || chunk.length === 0) return
        const remaining = maxOutputBytes - outBytes - errBytes
        const slice = chunk.length > remaining ? chunk.subarray(0, Math.max(0, remaining)) : chunk
        if (target === 'stdout') {
          outChunks.push(slice)
          outBytes += slice.length
        } else {
          errChunks.push(slice)
          errBytes += slice.length
        }
        if (slice.length < chunk.length) {
          truncated = true
          markFailure('output-limit')
        }
      }

      const timeoutTimer = setTimeout(() => markFailure('timed-out'), timeoutMs)

      if (options.signal?.aborted || this.controller.signal.aborted) {
        settle('cancelled', null, null)
        return
      }

      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.controller.signal.addEventListener('abort', onAbort, { once: true })

      try {
        const invocation = resolveProcessInvocation(command, args)
        child = spawn(invocation.command, invocation.args, {
          cwd,
          env,
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        spawnError = error instanceof Error ? error.message : String(error)
        settle('spawn-failed', null, null)
        return
      }

      this.children.add(child)
      child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk))
      child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk))
      child.once('error', (error) => {
        if (failure) {
          settle(failure, null, null)
          return
        }
        spawnError = error.message
        settle('spawn-failed', null, null)
      })
      child.once('close', (code, signal) => {
        settle(failure ?? 'completed', code, signal)
      })
    })
  }

  dispose(): void {
    if (this.isDisposed) return
    this.isDisposed = true
    this.controller.abort()
    for (const child of Array.from(this.children)) terminateChild(child)
    this.children.clear()
  }
}

export function runProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  const runner = new ProcessRunner()
  return runner.run(options).finally(() => runner.dispose())
}
