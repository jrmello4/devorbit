/**
 * Contratos de eventos push main → renderer (fonte única).
 *
 * Cargas úteis dos canais IpcEventChannel: terminal, web panel, updater,
 * login Codex, companion, HITL e progresso de sync.
 */

export interface TerminalEvent {
  id: string
  type: 'data' | 'exit' | 'error' | 'resize'
  data?: string
  code?: number | null
  cols?: number
  rows?: number
}

export interface WebPanelEvent {
  type: 'loading' | 'loaded' | 'navigated' | 'error' | 'palette-shortcut'
  url: string
  title?: string
  message?: string
}

export interface WebPanelBounds {
  x: number
  y: number
  width: number
  height: number
  contentX?: number
  contentY?: number
  contentWidth?: number
  contentHeight?: number
}

export interface SyncProgress {
  path: string
  done: number
  total: number
}

export type CompanionOutcome = 'completed' | 'blocked' | 'failed'

export interface CompanionAction {
  id: 'view-workspace' | 'dismiss'
  label: string
}

export interface CompanionSummary {
  terminalId: string
  projectPath?: string
  outcome: CompanionOutcome
  title: string
  message: string
  suggestion: string
  code?: number | null
  actions: CompanionAction[]
}

export type UpdateStatus = 'unavailable' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'

export type UpdateDistribution = 'installed' | 'portable' | 'dev'

export interface UpdateState {
  supported: boolean
  status: UpdateStatus
  distribution: UpdateDistribution
  version?: string
  progress?: number
  message?: string
}

export interface CodexAuthProgress {
  account: 'account1' | 'account2'
  status: 'idle' | 'starting' | 'code_generated' | 'success' | 'error' | 'cancelled'
  code?: string
  verificationUrl?: string
  message?: string
}

export interface HitlRequestView {
  id: string
  prompt: string
  state: 'pending' | 'approved' | 'rejected' | 'expired'
  createdAt: number
  expiresAt: number
  context?: unknown
  metadata?: Record<string, unknown>
  decision?: { state: 'approved' | 'rejected' | 'expired'; decidedAt: number; reason?: string; decidedBy?: string }
}
