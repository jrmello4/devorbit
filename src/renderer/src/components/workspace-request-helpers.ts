import type { PendingCreationPayload, PendingCreationKind } from '../types'
import { defaultCanvasEdgeKind, isOrderingEdgeKind, type CanvasEdgeKind } from './terminal-node-helpers'

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
  coordinatorNodeId?: string
  memberNodeIds: readonly string[]
  collapsed?: boolean
}

export interface SquadRegion {
  id: string
  title: string
  coordinatorNodeId?: string
  x: number
  y: number
  width: number
  height: number
  collapsed: boolean
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
      collapsed: squad.collapsed === true,
    })
  }
  return regions.sort((left, right) => left.y - right.y || left.x - right.x || left.id.localeCompare(right.id))
}

/**
 * Forma editável de squad. Deliberadamente idêntica à `CanvasSquad` do canvas
 * (mesmos campos e mutabilidade), para os helpers serem assignáveis nos dois
 * sentidos sem casts genéricos.
 */
export interface EditableSquad {
  id: string
  title: string
  objective?: string
  /** Ausente = squad sem coordenador; nunca promovido automaticamente. */
  coordinatorNodeId?: string
  memberNodeIds: string[]
  collapsed?: boolean
}

/** Adiciona um membro sem duplicar e sem mover nenhum nó existente. */
export function addSquadMember(squad: EditableSquad, nodeId: string): EditableSquad {
  if (!nodeId || squad.memberNodeIds.includes(nodeId)) return squad
  return { ...squad, memberNodeIds: [...squad.memberNodeIds, nodeId] }
}

/**
 * Remove um membro. Se o coordenador sair, o squad continua existindo sem
 * coordenador (a orquestração fica indisponível até a escolha explícita de
 * outro membro) — nunca promove substituto automaticamente.
 */
export function removeSquadMember(squad: EditableSquad, nodeId: string): EditableSquad {
  if (!squad.memberNodeIds.includes(nodeId)) return squad
  const { coordinatorNodeId, ...rest } = squad
  return {
    ...rest,
    memberNodeIds: squad.memberNodeIds.filter((id) => id !== nodeId),
    ...(coordinatorNodeId && coordinatorNodeId !== nodeId ? { coordinatorNodeId } : {}),
  }
}

/** Coordenador só pode ser um membro; `null` limpa a função explicitamente. */
export function setSquadCoordinator(squad: EditableSquad, nodeId: string | null): EditableSquad {
  if (nodeId === null) {
    const { coordinatorNodeId: _removed, ...rest } = squad
    return rest
  }
  if (!squad.memberNodeIds.includes(nodeId)) return squad
  return { ...squad, coordinatorNodeId: nodeId }
}

export function renameSquad(squad: EditableSquad, title: string): EditableSquad {
  const next = title.trim().slice(0, 80)
  return next ? { ...squad, title: next } : squad
}

export function setSquadObjective(squad: EditableSquad, objective: string): EditableSquad {
  return { ...squad, objective: objective.slice(0, 2000) }
}

export function toggleSquadCollapsed(squad: EditableSquad): EditableSquad {
  return { ...squad, collapsed: !squad.collapsed }
}

export function squadForNode(
  squads: readonly EditableSquad[],
  nodeId: string,
): EditableSquad | undefined {
  return squads.find((squad) => squad.memberNodeIds.includes(nodeId))
}

export function squadCoordinatedBy(
  squads: readonly EditableSquad[],
  nodeId: string,
): EditableSquad | undefined {
  return squads.find((squad) => squad.coordinatorNodeId === nodeId)
}

export interface CanvasFocusState {
  active: boolean
  selectedIds: readonly string[]
  relatedIds: ReadonlySet<string>
}

/**
 * Focus de múltipla seleção: com 2+ nós selecionados, a seleção e seus
 * relacionados diretos (1 salto por qualquer aresta) permanecem visíveis; o
 * resto é atenuado. A saída é simples: qualquer seleção com menos de 2 nós
 * desliga o focus.
 */
export function computeCanvasFocus(
  selected: readonly string[],
  connections: readonly GraphLink[],
): CanvasFocusState {
  const active = selected.length > 1
  const relatedIds = new Set<string>(selected)
  if (active) {
    const selectedSet = new Set(selected)
    for (const connection of connections) {
      if (selectedSet.has(connection.from)) relatedIds.add(connection.to)
      if (selectedSet.has(connection.to)) relatedIds.add(connection.from)
    }
  }
  return { active, selectedIds: selected, relatedIds }
}

export function isCanvasNodeDimmed(nodeId: string, focus: CanvasFocusState): boolean {
  return focus.active && !focus.relatedIds.has(nodeId)
}

export interface CanvasNodeSlotState {
  /** Colapsado = oculto, porém SEMPRE montado (sessão de terminal preservada). */
  hidden: boolean
  dimmed: boolean
  mounted: true
}

/**
 * Estado de apresentação de um cartão: squad recolhido apenas oculta o cartão
 * (nunca desmonta), e o focus de múltipla seleção apenas atenua os não
 * relacionados. `mounted` é invariante — o terminal/agente dentro do cartão
 * continua vivo durante collapse e Inspector.
 */
export function resolveCanvasNodeSlot(
  nodeId: string,
  collapsedMemberIds: ReadonlySet<string>,
  focus: CanvasFocusState,
): CanvasNodeSlotState {
  const hidden = collapsedMemberIds.has(nodeId)
  return {
    hidden,
    dimmed: !hidden && isCanvasNodeDimmed(nodeId, focus),
    mounted: true,
  }
}

export interface CanvasViewportSize {
  width: number
  height: number
}

/**
 * Viewport que centraliza um conjunto de nós com padding, respeitando os
 * limites de zoom do canvas. Usado pelo botão Foco do toolbar.
 */
export function computeFocusViewport(
  nodes: readonly SquadNodeLike[],
  viewport: CanvasViewportSize,
  options: { padding?: number; minZoom?: number; maxZoom?: number } = {},
): { x: number; y: number; zoom: number } | null {
  if (nodes.length === 0 || viewport.width <= 0 || viewport.height <= 0) return null
  const padding = options.padding ?? 120
  const minZoom = options.minZoom ?? 0.08
  const maxZoom = options.maxZoom ?? 1.6
  const minX = Math.min(...nodes.map((node) => node.x))
  const minY = Math.min(...nodes.map((node) => node.y))
  const maxX = Math.max(...nodes.map((node) => node.x + node.width))
  const maxY = Math.max(...nodes.map((node) => node.y + node.height))
  const zoom = Math.min(
    maxZoom,
    Math.max(
      minZoom,
      Math.min(
        viewport.width / Math.max(1, maxX - minX + padding * 2),
        viewport.height / Math.max(1, maxY - minY + padding * 2),
      ),
    ),
  )
  return {
    zoom,
    x: viewport.width / 2 - ((minX + maxX) / 2) * zoom,
    y: viewport.height / 2 - ((minY + maxY) / 2) * zoom,
  }
}

/** Níveis discretos de zoom do canvas (roda/atalhos/botões passam por eles). */
export const CANVAS_ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.25, 1.5] as const

export function stepZoomLevel(current: number, direction: 1 | -1): number {
  const levels = CANVAS_ZOOM_LEVELS
  if (direction > 0) {
    for (const level of levels) {
      if (level > current + 1e-6) return level
    }
    return levels[levels.length - 1]
  }
  for (let index = levels.length - 1; index >= 0; index -= 1) {
    if (levels[index] < current - 1e-6) return levels[index]
  }
  return levels[0]
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

export interface TypedGraphLink extends GraphLink {
  kind?: CanvasEdgeKind
  label?: string
}

/** Prefixo do endpoint-âncora de squad (a aresta não aponta para um nó). */
export const SQUAD_ANCHOR_PREFIX = 'squad:'

export function squadAnchorId(squadId: string): string {
  return SQUAD_ANCHOR_PREFIX + squadId
}

export function parseSquadAnchorId(id: string): string | null {
  return id.startsWith(SQUAD_ANCHOR_PREFIX) ? id.slice(SQUAD_ANCHOR_PREFIX.length) : null
}

export function collectSquadAnchorIds(squads: readonly { id: string }[]): Set<string> {
  return new Set(squads.map((squad) => squadAnchorId(squad.id)))
}

/**
 * Aresta criada pela UI: agente→agente nasce 'delegation' (ordenação/guarda
 * de ciclo); qualquer outra combinação nasce 'context' (relação semântica).
 * Arestas antigas sem tipo continuam 'flow' via defaultCanvasEdgeKind.
 */
export function inferCanvasEdgeKind(fromKind: string, toKind: string): CanvasEdgeKind {
  return fromKind === 'agent' && toKind === 'agent' ? 'delegation' : 'context'
}

/**
 * Saneia arestas persistidas/carregadas: descarta pontas inexistentes e
 * self-loops; aceita endpoints que são nós OU âncoras de squad
 * (`squad:<id>`), preservando o vínculo Nota→Squad; tipo ausente/inválido
 * vira 'flow' (comportamento v2–v4); o guarda de ciclo vale apenas para
 * arestas de ordenação agente→agente, sem bloquear arestas semânticas.
 */
export function sanitizeCanvasEdges<T extends TypedGraphLink>(
  connections: readonly T[],
  nodeIds: ReadonlySet<string>,
  agentIds: ReadonlySet<string>,
  squadAnchorIds: ReadonlySet<string> = new Set<string>(),
): T[] {
  const kept: T[] = []
  const orderingLinks: T[] = []
  for (const connection of connections) {
    if (!connection || connection.from === connection.to) continue
    const fromOk = nodeIds.has(connection.from) || squadAnchorIds.has(connection.from)
    const toOk = nodeIds.has(connection.to) || squadAnchorIds.has(connection.to)
    if (!fromOk || !toOk) continue
    const kind = defaultCanvasEdgeKind(connection.kind)
    if (isOrderingEdgeKind(kind) && createsAgentCycle(orderingLinks, agentIds, connection.from, connection.to)) continue
    const next = { ...connection, kind } as T
    kept.push(next)
    if (isOrderingEdgeKind(kind)) orderingLinks.push(next)
  }
  return kept
}
