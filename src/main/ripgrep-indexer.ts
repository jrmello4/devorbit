import type { Disposable } from '../shared/disposable'
import { ProcessRunner } from './process-runner'

export const DEFAULT_RIPGREP_MAX_RESULTS = 200
export const DEFAULT_RIPGREP_TIMEOUT_MS = 20_000

export interface RipgrepIndexerOptions {
  command?: string
  argsPrefix?: readonly string[]
  runner?: ProcessRunner
  maxResults?: number
  timeoutMs?: number
  maxOutputBytes?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface RipgrepSearchOptions {
  root: string
  query: string
  fixedStrings?: boolean
  ignoreCase?: boolean
  globs?: readonly string[]
  maxResults?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export interface RipgrepMatch {
  path: string
  line: number
  column: number
  text: string
}

export type RipgrepSearchStatus = 'ok' | 'truncated' | 'cancelled' | 'timed-out' | 'failed'

export interface RipgrepSearchResult {
  root: string
  query: string
  status: RipgrepSearchStatus
  matches: RipgrepMatch[]
  truncated: boolean
  exitCode: number | null
  error?: string
}

interface RipgrepJsonSubmatch {
  start?: unknown
}

interface RipgrepJsonData {
  path?: { text?: unknown }
  lines?: { text?: unknown }
  line_number?: unknown
  submatches?: unknown
}

interface RipgrepJsonMessage {
  type?: unknown
  data?: RipgrepJsonData
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function parseMatchLine(line: string): RipgrepMatch | undefined {
  let message: RipgrepJsonMessage
  try {
    message = JSON.parse(line) as RipgrepJsonMessage
  } catch {
    return undefined
  }
  if (!message || message.type !== 'match' || !message.data) return undefined
  const path = message.data.path?.text
  const lineNumber = message.data.line_number
  const text = message.data.lines?.text
  if (
    typeof path !== 'string' ||
    !path ||
    typeof text !== 'string' ||
    typeof lineNumber !== 'number' ||
    !Number.isInteger(lineNumber) ||
    lineNumber < 1
  ) {
    return undefined
  }
  const submatches = Array.isArray(message.data.submatches)
    ? (message.data.submatches as RipgrepJsonSubmatch[])
    : []
  const firstStart = submatches.length > 0 ? submatches[0]?.start : undefined
  const column = typeof firstStart === 'number' && Number.isInteger(firstStart) && firstStart >= 0
    ? firstStart + 1
    : 1
  return {
    path,
    line: lineNumber,
    column,
    text: text.replace(/\r?\n$/, ''),
  }
}

function failureDetail(stderr: string, fallback: string): string {
  const detail = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0]
  return detail ? detail.slice(0, 300) : fallback
}

export class RipgrepIndexer implements Disposable {
  private readonly runner: ProcessRunner
  private readonly ownsRunner: boolean
  private readonly command: string
  private readonly argsPrefix: readonly string[]
  private readonly maxResults: number
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number | undefined
  private readonly cwd: string | undefined
  private readonly env: NodeJS.ProcessEnv | undefined
  private isDisposed = false

  constructor(options: RipgrepIndexerOptions = {}) {
    this.runner = options.runner ?? new ProcessRunner()
    this.ownsRunner = options.runner === undefined
    this.command = options.command?.trim() || 'rg'
    this.argsPrefix = options.argsPrefix ?? []
    this.maxResults = positiveInteger(options.maxResults, DEFAULT_RIPGREP_MAX_RESULTS)
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_RIPGREP_TIMEOUT_MS)
    this.maxOutputBytes = typeof options.maxOutputBytes === 'number' && Number.isFinite(options.maxOutputBytes) && options.maxOutputBytes > 0
      ? Math.floor(options.maxOutputBytes)
      : undefined
    this.cwd = options.cwd
    this.env = options.env
  }

  get disposed(): boolean {
    return this.isDisposed
  }

  async search(options: RipgrepSearchOptions): Promise<RipgrepSearchResult> {
    if (this.isDisposed) throw new Error('RipgrepIndexer indisponível.')
    const root = typeof options.root === 'string' ? options.root.trim() : ''
    if (!root) throw new Error('Raiz de busca inválida.')
    const query = options.query
    if (typeof query !== 'string' || query.length === 0) throw new Error('Consulta inválida.')
    const maxResults = positiveInteger(options.maxResults ?? this.maxResults, DEFAULT_RIPGREP_MAX_RESULTS)
    const timeoutMs = positiveInteger(options.timeoutMs ?? this.timeoutMs, DEFAULT_RIPGREP_TIMEOUT_MS)
    const globs = Array.isArray(options.globs) ? options.globs.map((glob) => String(glob)) : []

    const args = [
      ...this.argsPrefix,
      '--json',
      '--no-messages',
      ...(options.fixedStrings ? ['--fixed-strings'] : []),
      ...(options.ignoreCase ? ['--ignore-case'] : []),
      ...globs.flatMap((glob) => ['--glob', glob]),
      '--',
      query,
      root,
    ]

    const run = await this.runner.run({
      command: this.command,
      args,
      cwd: this.cwd,
      env: this.env,
      timeoutMs,
      ...(this.maxOutputBytes === undefined ? {} : { maxOutputBytes: this.maxOutputBytes }),
      signal: options.signal,
    })

    const matches: RipgrepMatch[] = []
    let matched = 0
    for (const line of run.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue
      const match = parseMatchLine(line)
      if (!match) continue
      matched += 1
      if (matches.length < maxResults) matches.push(match)
    }
    const truncatedByResults = matched > matches.length

    if (run.status === 'timed-out') {
      return {
        root,
        query,
        status: 'timed-out',
        matches,
        truncated: run.truncated || truncatedByResults,
        exitCode: run.code,
      }
    }
    if (run.status === 'cancelled') {
      return {
        root,
        query,
        status: 'cancelled',
        matches,
        truncated: run.truncated || truncatedByResults,
        exitCode: run.code,
      }
    }
    if (run.status === 'output-limit' || truncatedByResults) {
      return {
        root,
        query,
        status: 'truncated',
        matches,
        truncated: true,
        exitCode: run.code,
      }
    }
    if (run.status === 'spawn-failed') {
      return {
        root,
        query,
        status: 'failed',
        matches,
        truncated: run.truncated,
        exitCode: run.code,
        error: run.error || 'Não foi possível executar o ripgrep.',
      }
    }
    if (run.code !== 0 && run.code !== 1) {
      return {
        root,
        query,
        status: 'failed',
        matches,
        truncated: run.truncated,
        exitCode: run.code,
        error: failureDetail(run.stderr, `Ripgrep terminou com código ${run.code ?? 'desconhecido'}.`),
      }
    }
    return {
      root,
      query,
      status: 'ok',
      matches,
      truncated: run.truncated,
      exitCode: run.code,
    }
  }

  dispose(): void {
    if (this.isDisposed) return
    this.isDisposed = true
    if (this.ownsRunner) this.runner.dispose()
  }
}

export async function searchWithRipgrep(
  options: RipgrepSearchOptions,
  indexerOptions: RipgrepIndexerOptions = {},
): Promise<RipgrepSearchResult> {
  const indexer = new RipgrepIndexer(indexerOptions)
  try {
    return await indexer.search(options)
  } finally {
    indexer.dispose()
  }
}
