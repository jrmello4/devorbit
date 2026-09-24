import { spawn as spawnProcess, type SpawnOptions } from 'node:child_process'
import { spawn as spawnPty, type IPty } from 'node-pty'
import { clearPipesFor, PTY_PIPE_MAX_CHUNK, resetPipes } from './pty-pipe'
import { finalizeAiMemorySession, drainPendingAiMemoryFinalizations } from './ai-memory-launcher'

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

/**
 * Coalescing de chunks de saída do PTY: bursts de output viram poucos eventos
 * `data` (concatenados, ordem preservada) em vez de um IPC por chunk.
 *
 * Janela: chunks que chegam até TERMINAL_DATA_FLUSH_MS depois do primeiro
 * chunk bufferizado saem juntos. O PRIMEIRO chunk de uma rajada sai síncrono:
 * mantém a latência de eco/tecla em zero e evita atrasar o pontapé da janela.
 */
export const TERMINAL_DATA_FLUSH_MS = 16
/** Teto do buffer pendente: passar disso, flush imediato. */
const TERMINAL_DATA_FLUSH_BYTES = 64_000

interface PendingTerminalData {
  parts: string[]
  length: number
  timer: NodeJS.Timeout | undefined
}

const pendingDataByTerminal = new Map<string, PendingTerminalData>()

/**
 * Emite o buffer pendente como evento(s) `data` únicos(s). Fatias maiores que
 * PTY_PIPE_MAX_CHUNK são divididas: o encaminhamento por cabos (pty-pipe)
 * trunca cada evento nessa fatia, então emitir acima disso perderia dados.
 */
function flushPendingData(id: string): void {
  const pending = pendingDataByTerminal.get(id)
  if (!pending) return
  pendingDataByTerminal.delete(id)
  if (pending.timer !== undefined) clearTimeout(pending.timer)
  if (pending.parts.length === 0) return
  const data = pending.parts.join('')
  for (let offset = 0; offset < data.length; offset += PTY_PIPE_MAX_CHUNK) {
    emit({ id, type: 'data', data: data.slice(offset, offset + PTY_PIPE_MAX_CHUNK) })
  }
}

function appendTerminalData(id: string, data: string): void {
  const pending = pendingDataByTerminal.get(id)
  if (!pending) {
    // Primeiro chunk da rajada sai na hora; a janela abre para os próximos.
    emit({ id, type: 'data', data })
    const next: PendingTerminalData = { parts: [], length: 0, timer: undefined }
    next.timer = setTimeout(() => flushPendingData(id), TERMINAL_DATA_FLUSH_MS)
    if (typeof next.timer.unref === 'function') next.timer.unref()
    pendingDataByTerminal.set(id, next)
    return
  }
  pending.parts.push(data)
  pending.length += data.length
  if (pending.length >= TERMINAL_DATA_FLUSH_BYTES) flushPendingData(id)
}

/**
 * Segredos que nunca podem ser herdados por um PTY/agente. O updater e o
 * main autenticam por headers; o token do GitHub não deve vazar para CLIs.
 */
export const PTY_SCRUBBED_ENV_VARIABLES = ['GH_TOKEN', 'GITHUB_TOKEN'] as const

function buildTerminalEnv(optionsEnv: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...optionsEnv,
    TERM: process.env.TERM || 'xterm-256color',
  }
  for (const name of PTY_SCRUBBED_ENV_VARIABLES) delete env[name]
  return env
}

interface TerminalRecord {
  terminal: IPty
  cols: number
  rows: number
}

const sessions = new Map<string, TerminalRecord>()
const listeners = new Set<(event: TerminalEvent) => void>()
const startListeners = new Set<(id: string) => void>()

function emitStart(id: string): void {
  for (const listener of startListeners) {
    try {
      listener(id)
    } catch {
      // Um listener com defeito nunca pode derrubar o start do PTY.
    }
  }
}

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

/** Notifica todo start de PTY (inclusive restart com o mesmo id). */
export function onTerminalStart(listener: (id: string) => void): () => void {
  startListeners.add(listener)
  return () => startListeners.delete(listener)
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
  // Restart interno (mesmo id): preserva as arestas — o cabo visual continua
  // desenhado e o piping volta a valer na nova sessão. stopTerminal limpa.
  stopTerminal(id, { keepPipes: true })
  const { cols, rows } = clampDimensions(options.cols, options.rows)
  const command = options.command || (process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || 'bash'))
  if (typeof command !== 'string' || !command.trim()) throw new Error('Comando do terminal inválido.')
  const args = Array.isArray(options.args) ? options.args : []

  let terminal: IPty
  try {
    terminal = spawnPty(command, args, {
      cwd,
      env: buildTerminalEnv(options.env),
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
  emitStart(id)

  terminal.onData((data) => {
    if (isCurrent(id, terminal)) appendTerminalData(id, data)
  })
  terminal.onExit(({ exitCode }) => {
    if (!isCurrent(id, terminal)) return
    // Saída pendente vai ANTES do exit: ordem dos eventos é preservada.
    flushPendingData(id)
    sessions.delete(id)
    emit({ id, type: 'exit', code: exitCode })
    void finalizeAiMemorySession({ terminalId: id })
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
  // Dados pendentes saem antes do resize: ordem dos eventos é preservada.
  flushPendingData(id)
  emit({ id, type: 'resize', cols: next.cols, rows: next.rows })
  return true
}

export interface TerminateProcessTreeFailure {
  pid: number
  reason: string
}

export interface TerminateProcessTreeDeps {
  platform?: NodeJS.Platform
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => {
    unref?: () => void
    on?: (event: 'error', listener: (error: Error) => void) => void
  }
  onFailure?: (failure: TerminateProcessTreeFailure) => void
}

/** Motivo curto e sem dados sensíveis (apenas código de erro, se houver). */
function safeFailureReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (typeof code === 'string' && code.length > 0 && code.length <= 64) return code
  return 'spawn-failed'
}

/** Encerra a árvore de processos no Windows sem passar por shell. */
export function terminateProcessTree(pid: number, deps: TerminateProcessTreeDeps = {}): boolean {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return false
  if (!Number.isInteger(pid) || pid <= 0) return false
  const spawnImpl = deps.spawnImpl ?? spawnProcess
  try {
    const child = spawnImpl('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
    })
    child.on?.('error', (error) => {
      deps.onFailure?.({ pid, reason: safeFailureReason(error) })
    })
    child.unref?.()
    return true
  } catch (error) {
    deps.onFailure?.({ pid, reason: safeFailureReason(error) })
    return false
  }
}

export function stopTerminal(id: string, options?: { keepPipes?: boolean }): void {
  const record = sessions.get(id)
  // Limpeza bidirecional por padrão: remove cabos que saem E que chegam neste
  // terminal. Restart interno usa keepPipes para preservar o grafo visual.
  if (!options?.keepPipes) clearPipesFor(id)
  if (!record) return
  // Saída pendente do PTY que está morrendo vai antes de qualquer teardown:
  // nunca depois (o PTY morreu) nem descartada.
  flushPendingData(id)
  sessions.delete(id)
  void finalizeAiMemorySession({ terminalId: id })
  terminateProcessTree(record.terminal.pid, {
    onFailure: ({ pid, reason }) => {
      emit({ id, type: 'error', data: `Falha ao encerrar a árvore do processo ${pid}: ${reason}` })
    },
  })
  try {
    record.terminal.kill()
  } catch {
    // O processo já pode ter terminado; a sessão já foi removida.
  }
}

export function stopAllTerminals(): void {
  for (const id of Array.from(sessions.keys())) stopTerminal(id)
  resetPipes()
}

/**
 * Encerra um terminal ativo e aguarda de forma bounded a finalização da sua sessão ai-memory.
 */
export async function stopTerminalAsync(
  id: string,
  options?: { keepPipes?: boolean; timeoutMs?: number }
): Promise<{ finalized: boolean; message?: string }> {
  const record = sessions.get(id)
  if (!options?.keepPipes) clearPipesFor(id)
  if (!record) return { finalized: false, message: 'Nenhum terminal ativo para encerrar.' }

  flushPendingData(id)
  sessions.delete(id)
  const finalizationPromise = finalizeAiMemorySession({ terminalId: id })

  terminateProcessTree(record.terminal.pid, {
    onFailure: ({ pid, reason }) => {
      emit({ id, type: 'error', data: `Falha ao encerrar a árvore do processo ${pid}: ${reason}` })
    },
  })
  try {
    record.terminal.kill()
  } catch {
    // O processo já pode ter terminado; a sessão já foi removida.
  }

  const timeoutMs = options?.timeoutMs ?? 5_000
  let timer: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<{ timeout: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timeout: true }), timeoutMs)
  })

  try {
    const outcome = await Promise.race([
      finalizationPromise.then((res) => ({ timeout: false as const, result: res })),
      timeoutPromise,
    ])

    if (outcome.timeout) {
      console.warn(`[DevOrbit terminal-session] Timeout (${timeoutMs}ms) ao aguardar finalização do terminal ${id}.`)
      return { finalized: false, message: `Timeout de ${timeoutMs}ms atingido durante a finalização.` }
    }

    return outcome.result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { finalized: false, message: `Falha na finalização: ${msg}` }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Encerra todos os terminais ativos e aguarda de forma bounded a conclusão de todas
 * as finalizações de sessões pendentes que necessitam do sidecar ai-memory antes do desligamento.
 */
export async function stopAllTerminalsAsync(options: { timeoutMs?: number } = {}): Promise<{
  stopped: number
  completed: boolean
}> {
  const terminalIds = Array.from(sessions.keys())
  const stopped = terminalIds.length

  for (const id of terminalIds) {
    stopTerminal(id)
  }
  resetPipes()

  const drainResult = await drainPendingAiMemoryFinalizations({ timeoutMs: options.timeoutMs })
  return { stopped, completed: drainResult.drained }
}

export { drainPendingAiMemoryFinalizations as drainTerminalFinalizations }
