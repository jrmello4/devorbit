export type PendingCanvasNodeKind = 'note' | 'agent'

export interface PendingCanvasNode {
  projectId: string
  kind: PendingCanvasNodeKind
  nonce: number
}

export function buildPendingCanvasNode(projectId: string, kind: PendingCanvasNodeKind): PendingCanvasNode {
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
