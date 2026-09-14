import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface TerminalEvent {
  id: string
  type: 'data' | 'exit' | 'error'
  data?: string
  code?: number | null
}

const sessions = new Map<string, ChildProcessWithoutNullStreams>()
const listeners = new Set<(event: TerminalEvent) => void>()

function emit(event: TerminalEvent): void {
  for (const listener of listeners) listener(event)
}

function isCurrent(id: string, child: ChildProcessWithoutNullStreams): boolean {
  return sessions.get(id) === child
}

export function onTerminalEvent(listener: (event: TerminalEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function startTerminal(id: string, cwd: string): Promise<{ id: string; pid: number | undefined }> {
  stopTerminal(id)
  const shell = process.env.ComSpec || 'cmd.exe'
  const child = spawn(shell, ['/d', '/q', '/k'], {
    cwd,
    env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
    stdio: 'pipe',
    windowsHide: true,
  })
  sessions.set(id, child)

  child.stdout.on('data', (chunk: Buffer) => {
    if (isCurrent(id, child)) emit({ id, type: 'data', data: chunk.toString('utf8') })
  })
  child.stderr.on('data', (chunk: Buffer) => {
    if (isCurrent(id, child)) emit({ id, type: 'data', data: chunk.toString('utf8') })
  })
  child.once('error', (error) => {
    if (isCurrent(id, child)) emit({ id, type: 'error', data: error.message })
  })
  child.once('exit', (code) => {
    if (!isCurrent(id, child)) return
    sessions.delete(id)
    emit({ id, type: 'exit', code })
  })

  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', reject)
  })
  return { id, pid: child.pid }
}

export function writeTerminal(id: string, input: string): boolean {
  const child = sessions.get(id)
  if (!child?.stdin?.writable || typeof input !== 'string' || input.length > 64_000) return false
  child.stdin.write(input)
  return true
}

export function stopTerminal(id: string): void {
  const child = sessions.get(id)
  if (!child) return
  sessions.delete(id)
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.once('error', () => child.kill())
  } else {
    child.kill()
  }
}

export function stopAllTerminals(): void {
  for (const id of Array.from(sessions.keys())) stopTerminal(id)
}