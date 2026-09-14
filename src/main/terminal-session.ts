import { spawn as spawnPty, type IPty } from 'node-pty'

export interface TerminalEvent {
  id: string
  type: 'data' | 'exit' | 'error'
  data?: string
  code?: number | null
}

export interface TerminalStartOptions {
  command?: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  cols?: number
  rows?: number
}

const sessions = new Map<string, IPty>()
const listeners = new Set<(event: TerminalEvent) => void>()

function emit(event: TerminalEvent): void {
  for (const listener of listeners) listener(event)
}

function isCurrent(id: string, terminal: IPty): boolean {
  return sessions.get(id) === terminal
}

export function onTerminalEvent(listener: (event: TerminalEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function startTerminal(
  id: string,
  cwd: string,
  options: TerminalStartOptions = {},
): Promise<{ id: string; pid: number | undefined }> {
  stopTerminal(id)
  const command = options.command || (process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || 'bash'))
  const args = options.args || (process.platform === 'win32' ? ['/d', '/q', '/k'] : [])
  const terminal = spawnPty(command, args, {
    cwd,
    env: { ...process.env, ...options.env, TERM: process.env.TERM || 'xterm-256color' },
    name: 'xterm-256color',
    cols: Math.max(40, Math.min(240, options.cols || 120)),
    rows: Math.max(12, Math.min(100, options.rows || 32)),
    ...(process.platform === 'win32' ? { useConpty: true } : {}),
  })
  sessions.set(id, terminal)

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
  const terminal = sessions.get(id)
  if (!terminal || typeof input !== 'string' || input.length > 64_000) return false
  terminal.write(input)
  return true
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const terminal = sessions.get(id)
  if (!terminal || !Number.isFinite(cols) || !Number.isFinite(rows)) return false
  const safeCols = Math.max(40, Math.min(240, Math.floor(cols)))
  const safeRows = Math.max(12, Math.min(100, Math.floor(rows)))
  terminal.resize(safeCols, safeRows)
  return true
}

export function stopTerminal(id: string): void {
  const terminal = sessions.get(id)
  if (!terminal) return
  sessions.delete(id)
  terminal.kill()
}

export function stopAllTerminals(): void {
  for (const id of Array.from(sessions.keys())) stopTerminal(id)
}