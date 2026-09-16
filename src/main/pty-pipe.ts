import type { TerminalEvent } from './terminal-session'

/**
 * Canalização de PTY entre nós do canvas (FASE 3, padrão Maestri): a saída de
 * um terminal (stdout) pode ser encaminhada para a entrada de outro (stdin)
 * via cabos do canvas (ex.: Explorador -> Programador -> Testador).
 *
 * Política do grafo:
 * - fanout suportado: um terminal pode alimentar vários destinos;
 * - ciclos (A->B->A, de qualquer comprimento) são rejeitados em `setPipe`;
 * - cada cabo visual corresponde a exatamente uma aresta ativa, aplicada em
 *   ordem determinística (origem e destino ordenados);
 * - chunks limitados e teto de encaminhamentos por segundo por aresta evitam
 *   loops e tempestades de saída.
 *
 * Segurança: ids validados pelo chamador (IPC), sem ciclos diretos.
 */
export const PTY_PIPE_MAX_CHUNK = 16_000
export const PTY_PIPE_MAX_FORWARDS_PER_SECOND = 100

export interface PtyPipeDependencies {
  subscribe: (listener: (event: TerminalEvent) => void) => () => void
  write: (id: string, input: string) => boolean
  exists: (id: string) => boolean
}

export interface PipeEdge {
  from: string
  to: string
}

interface EdgeWindow {
  forwardedInWindow: number
  windowStartedAt: number
}

const edges = new Map<string, Set<string>>()
const windows = new Map<string, EdgeWindow>()
let unsubscribe: (() => void) | null = null
let now: () => number = () => Date.now()

function edgeKey(from: string, to: string): string {
  return `${from}>${to}`
}

function isValidTerminalId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9_-]{1,64}$/i.test(id)
}

/** Caminha o grafo a partir de `start` procurando `target` (detecção de ciclo). */
function reaches(start: string, target: string): boolean {
  const visited = new Set<string>([start])
  const pending = [start]
  while (pending.length > 0) {
    const current = pending.pop() as string
    for (const next of edges.get(current) || []) {
      if (next === target) return true
      if (!visited.has(next)) {
        visited.add(next)
        pending.push(next)
      }
    }
  }
  return false
}

export function setPipe(fromId: string, toId: string): void {
  if (!isValidTerminalId(fromId) || !isValidTerminalId(toId)) {
    throw new Error('Identificador de terminal inválido.')
  }
  if (fromId === toId) throw new Error('Um terminal não pode canalizar para si mesmo.')
  if (reaches(toId, fromId)) {
    throw new Error('Cabo recusado: criaria um ciclo de canalização.')
  }
  const destinations = edges.get(fromId) || new Set<string>()
  destinations.add(toId)
  edges.set(fromId, destinations)
}

/** Remove todos os cabos que SAEM de `fromId`. Retorna quantos existiam. */
export function clearPipe(fromId: string): number {
  const destinations = edges.get(fromId)
  if (!destinations) return 0
  for (const to of destinations) windows.delete(edgeKey(fromId, to))
  edges.delete(fromId)
  return destinations.size
}

/** Remove cabos onde `id` é origem OU destino (limpeza bidirecional). */
export function clearPipesFor(id: string): number {
  let removed = 0
  removed += clearPipe(id)
  for (const [from, destinations] of Array.from(edges.entries())) {
    if (destinations.delete(id)) {
      windows.delete(edgeKey(from, id))
      removed += 1
      if (destinations.size === 0) edges.delete(from)
    }
  }
  return removed
}

export function listPipes(): PipeEdge[] {
  const result: PipeEdge[] = []
  for (const [from, destinations] of edges) {
    for (const to of destinations) result.push({ from, to })
  }
  result.sort((left, right) =>
    left.from === right.from ? (left.to < right.to ? -1 : 1) : left.from < right.from ? -1 : 1
  )
  return result
}

export function resetPipes(): void {
  edges.clear()
  windows.clear()
}

/** Substitui o relógio (testes). */
export function __setPipeClock(clock: () => number): void {
  now = clock
}

function forwardTo(edge: PipeEdge, data: string, deps: PtyPipeDependencies): void {
  if (!deps.exists(edge.to)) return
  const key = edgeKey(edge.from, edge.to)
  const timestamp = now()
  const window = windows.get(key) || { forwardedInWindow: 0, windowStartedAt: timestamp }
  if (timestamp - window.windowStartedAt >= 1000) {
    window.windowStartedAt = timestamp
    window.forwardedInWindow = 0
  }
  if (window.forwardedInWindow >= PTY_PIPE_MAX_FORWARDS_PER_SECOND) {
    windows.set(key, window)
    return
  }
  window.forwardedInWindow += 1
  windows.set(key, window)
  deps.write(edge.to, data.slice(0, PTY_PIPE_MAX_CHUNK))
}

function handleEvent(event: TerminalEvent, deps: PtyPipeDependencies): void {
  if (event.type !== 'data' || typeof event.data !== 'string' || !event.data) return
  const destinations = edges.get(event.id)
  if (!destinations || destinations.size === 0) return
  const ordered = Array.from(destinations).sort()
  for (const to of ordered) {
    forwardTo({ from: event.id, to }, event.data, deps)
  }
}

/** Instala o encaminhamento uma única vez; retorna como desinstalar. */
export function installPtyPipe(deps: PtyPipeDependencies): () => void {
  uninstallPtyPipe()
  unsubscribe = deps.subscribe((event) => handleEvent(event, deps))
  return uninstallPtyPipe
}

export function uninstallPtyPipe(): void {
  if (unsubscribe) {
    try {
      unsubscribe()
    } catch {
      // Desinstalação é idempotente por construção.
    }
    unsubscribe = null
  }
}
