import { spawn as spawnPty, type IPty } from 'node-pty'

export interface TerminalEvent {
  id: string
  type: 'data' | 'exit' | 'error' | 'resize'
  data?: string
  code?: number | null
  cols?: number
  rows?: number
}

export interface TerminalStartOptions {
  command?: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  cols?: number
  rows?: number
}

export interface TerminalDimensions {
  cols: number
  rows: number
}

export const TERMINAL_MIN_COLS = 20
export const TERMINAL_MAX_COLS = 400
export const TERMINAL_MIN_ROWS = 5
export const TERMINAL_MAX_ROWS = 200
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 32
const MAX_WRITE_LENGTH = 64_000

interface TerminalRecord {
  terminal: IPty
  cols: number
  rows: number
}

const sessions = new Map<string, TerminalRecord>()
const listeners = new Set<(event: TerminalEvent) => void>()

function emit(event: TerminalEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // Um listener com defeito nunca pode derrubar o barramento PTY.
    }
  }
}

function isCurrent(id: string, terminal: IPty): boolean {
  return sessions.get(id)?.terminal === terminal
}

function clampDimensions(cols: number | undefined, rows: number | undefined): TerminalDimensions {
  const safeCols = Number.isFinite(cols)
    ? Math.max(TERMINAL_MIN_COLS, Math.min(TERMINAL_MAX_COLS, Math.floor(cols as number)))
    : DEFAULT_COLS
  const safeRows = Number.isFinite(rows)
    ? Math.max(TERMINAL_MIN_ROWS, Math.min(TERMINAL_MAX_ROWS, Math.floor(rows as number)))
    : DEFAULT_ROWS
  return { cols: safeCols, rows: safeRows }
}

function isValidId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9_-]{1,64}$/i.test(id)
}

export function onTerminalEvent(listener: (event: TerminalEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getTerminalDimensions(id: string): TerminalDimensions | undefined {
  const record = sessions.get(id)
  return record ? { cols: record.cols, rows: record.rows } : undefined
}

export function hasTerminal(id: string): boolean {
  return sessions.has(id)
}

export async function startTerminal(
  id: string,
  cwd: string,
  options: TerminalStartOptions = {},
): Promise<{ id: string; pid: number | undefined }> {
  if (!isValidId(id)) throw new Error('Identificador de terminal inválido.')
  if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('Diretório do terminal inválido.')
  stopTerminal(id)
  const { cols, rows } = clampDimensions(options.cols, options.rows)
  const command = options.command || (process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || 'bash'))
  if (typeof command !== 'string' || !command.trim()) throw new Error('Comando do terminal inválido.')
  const args = Array.isArray(options.args) ? options.args : []

  let terminal: IPty
  try {
    terminal = spawnPty(command, args, {
      cwd,
      env: { ...process.env, ...options.env, TERM: process.env.TERM || 'xterm-256color' },
      name: 'xterm-256color',
      cols,
      rows,
      ...(process.platform === 'win32' ? { useConpty: true } : {}),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({ id, type: 'error', data: message })
    throw error instanceof Error ? error : new Error(message)
  }

  sessions.set(id, { terminal, cols, rows })

  terminal.onData((data) => {
    if (isCurrent(id, terminal)) emit({ id, type: 'data', data })
  })
  terminal.onExit(({ exitCode }) => {
    if (!isCurrent(id, terminal)) return
    sessions.delete(id)
    emit({ id, type: 'exit', code: exitCode })
  })

  return { id, pid: terminal.pid }
}

export function writeTerminal(id: string, input: string): boolean {
  const record = sessions.get(id)
  if (!record || typeof input !== 'string' || input.length === 0 || input.length > MAX_WRITE_LENGTH) return false
  try {
    // O node-pty faz write síncrono; fatiar evita perda em payloads grandes.
    const CHUNK = 16_000
    for (let offset = 0; offset < input.length; offset += CHUNK) {
      record.terminal.write(input.slice(offset, offset + CHUNK))
    }
    return true
  } catch {
    return false
  }
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const record = sessions.get(id)
  if (!record || !Number.isFinite(cols) || !Number.isFinite(rows)) return false
  const next = clampDimensions(cols, rows)
  if (next.cols === record.cols && next.rows === record.rows) return true
  try {
    record.terminal.resize(next.cols, next.rows)
  } catch {
    return false
  }
  record.cols = next.cols
  record.rows = next.rows
  emit({ id, type: 'resize', cols: next.cols, rows: next.rows })
  return true
}

export function stopTerminal(id: string): void {
  const record = sessions.get(id)
  if (!record) return
  sessions.delete(id)
  try {
    record.terminal.kill()
  } catch {
    // O processo já pode ter terminado; a sessão já foi removida.
  }
}

export function stopAllTerminals(): void {
  for (const id of Array.from(sessions.keys())) stopTerminal(id)
}
