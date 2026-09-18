import type { PendingCreationPayload, PendingCreationKind } from '../types'

export type PendingCanvasNodeKind = 'note' | PendingCreationKind

export interface PendingCanvasNode extends Omit<PendingCreationPayload, 'kind'> {
  projectId: string
  kind: PendingCanvasNodeKind
}

export function buildPendingCanvasNode(projectId: string, kind: PendingCanvasNodeKind): PendingCanvasNode {
  return { projectId, kind, nonce: Date.now() + Math.floor(Math.random() * 1000) }
}

export function buildPendingCreation(projectId: string, kind: PendingCreationKind): PendingCreationPayload {
  return { projectId, kind, nonce: Date.now() + Math.floor(Math.random() * 1000) }
}

export function isPendingNodeForProject(
  pending: PendingCanvasNode | null,
  projectId: string,
): pending is PendingCanvasNode {
  return Boolean(pending && pending.projectId === projectId)
}

export interface WorkspaceUiRequest {
  projectId: string
  forceCanvas: boolean
  showTerminal: boolean
  nonce: number
}

export function buildWorkspaceUiRequest(
  projectId: string,
  options: { forceCanvas: boolean; showTerminal: boolean },
): WorkspaceUiRequest {
  return { projectId, ...options, nonce: Date.now() + Math.floor(Math.random() * 1000) }
}

export interface WorkspaceUiState {
  isCanvas: boolean
  terminalVisible: boolean
}

export function applyWorkspaceUiRequest(
  current: WorkspaceUiState,
  request: WorkspaceUiRequest | null,
  projectId: string,
): WorkspaceUiState {
  if (!request || request.projectId !== projectId) return current
  return {
    isCanvas: request.forceCanvas ? true : current.isCanvas,
    terminalVisible: request.showTerminal ? true : current.terminalVisible,
  }
}

export interface WebSuppressionParams {
  workspaceView: string
  settingsOpen: boolean
  toolHealthOpen: boolean
  authOpen: boolean
  memoryOpen: boolean
  paletteOpen: boolean
  updateModalOpen: boolean
}

/**
 * O WebContentsView nativo é irmão acima do DOM: qualquer overlay (paleta,
 * settings, etc.) precisa ocultar a view nativa para ficar clicável.
 * Ocultar preserva URL, histórico e sessão — só alterna visibilidade.
 */
export function computeWebSuppressed(params: WebSuppressionParams): boolean {
  if (params.workspaceView !== 'workspace') return true
  return Boolean(
    params.settingsOpen ||
    params.toolHealthOpen ||
    params.authOpen ||
    params.memoryOpen ||
    params.paletteOpen ||
    params.updateModalOpen
  )
}

export interface PipeSyncPlan {
  clearSources: string[]
  addEdges: Array<{ from: string; to: string }>
}

/**
 * Política do canvas: cabos são relações visuais e de orquestração estruturada.
 * Canalização bruta de PTY (stdout -> stdin) não é instalada implicitamente
 * porque espelharia a digitação e a saída de TUI do usuário entre terminais.
 * O mecanismo explícito continua disponível pelo IPC `devorbit:pipeTerminals`.
 */
export function computeStreamingPipeEdges(
  _nodeKinds: ReadonlyMap<string, string>,
  _connections: readonly { from: string; to: string }[],
): Array<{ from: string; to: string }> {
  return []
}

export interface SquadNodeLike {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface SquadLike {
  id: string
  title: string
  coordinatorNodeId: string
  memberNodeIds: readonly string[]
}

export interface SquadRegion {
  id: string
  title: string
  coordinatorNodeId: string
  x: number
  y: number
  width: number
  height: number
}

export function computeSquadRegions(
  squads: readonly SquadLike[],
  nodes: readonly SquadNodeLike[],
  padding = 24,
): SquadRegion[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const regions: SquadRegion[] = []
  for (const squad of squads) {
    const members = squad.memberNodeIds
      .map((id) => byId.get(id))
      .filter((node): node is SquadNodeLike => Boolean(node))
    if (members.length === 0) continue
    const minX = Math.min(...members.map((node) => node.x))
    const minY = Math.min(...members.map((node) => node.y))
    const maxX = Math.max(...members.map((node) => node.x + node.width))
    const maxY = Math.max(...members.map((node) => node.y + node.height))
    regions.push({
      id: squad.id,
      title: squad.title,
      coordinatorNodeId: squad.coordinatorNodeId,
      x: minX - padding,
      y: minY - padding,
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2,
    })
  }
  return regions.sort((left, right) => left.y - right.y || left.x - right.x || left.id.localeCompare(right.id))
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false
  for (const entry of left) {
    if (!right.has(entry)) return false
  }
  return true
}

/**
 * Reconciliação determinística cabo visual -> piping: por origem, em ordem
 * alfabética; origens cujo conjunto mudou são limpas e recriadas. Arestas que
 * formariam ciclo são rejeitadas pelo main na ordem aplicada (primeira vence).
 */
export function computePipeSync(
  applied: ReadonlyMap<string, ReadonlySet<string>>,
  desired: ReadonlyMap<string, ReadonlySet<string>>
): PipeSyncPlan {
  const clearSources: string[] = []
  const addEdges: Array<{ from: string; to: string }> = []
  const sources = new Set<string>([...applied.keys(), ...desired.keys()])
  for (const from of [...sources].sort()) {
    const current = applied.get(from) || new Set<string>()
    const next = desired.get(from) || new Set<string>()
    if (sameStringSet(current, next)) continue
    if (current.size > 0) clearSources.push(from)
    for (const to of [...next].sort()) addEdges.push({ from, to })
  }
  return { clearSources, addEdges }
}

export interface GraphLink {
  from: string
  to: string
}

/**
 * Detecta se a aresta agente->agente `from -> to` fecharia um ciclo no
 * subgrafo de agentes (qualquer comprimento, inclusive A->B->A). Só arestas
 * agente-agente importam: notas não participam do piping.
 */
export function createsAgentCycle(
  connections: readonly GraphLink[],
  agentIds: ReadonlySet<string>,
  from: string,
  to: string
): boolean {
  if (!agentIds.has(from) || !agentIds.has(to)) return false
  if (from === to) return true
  const outgoing = new Map<string, string[]>()
  for (const connection of connections) {
    if (!agentIds.has(connection.from) || !agentIds.has(connection.to)) continue
    const list = outgoing.get(connection.from) || []
    list.push(connection.to)
    outgoing.set(connection.from, list)
  }
  const visited = new Set<string>([to])
  const pending = [to]
  while (pending.length > 0) {
    const current = pending.pop() as string
    for (const next of outgoing.get(current) || []) {
      if (next === from) return true
      if (!visited.has(next)) {
        visited.add(next)
        pending.push(next)
      }
    }
  }
  return false
}

/**
 * Saneia conexões persistidas/carregadas: percorre na ordem armazenada e
 * descarta arestas agente-agente que fechariam ciclo. Determinístico: a
 * primeira aresta conflitante é descartada, as demais permanecem.
 */
export function sanitizeAgentCycles<T extends GraphLink>(
  connections: readonly T[],
  agentIds: ReadonlySet<string>
): T[] {
  const kept: T[] = []
  for (const connection of connections) {
    if (createsAgentCycle(kept, agentIds, connection.from, connection.to)) continue
    kept.push(connection)
  }
  return kept
}
