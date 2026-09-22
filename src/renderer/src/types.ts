import type { AgentBridgeEvent } from '../../shared/agent-bridge-event'
import type { ContinuityEvent, OrchestrationRole, OrchestrationState } from '../../shared/orchestration-continuity'
import type { AuditSnapshot } from '../../shared/audit-contract'
import type { DiagnosticProcessRequest, DiagnosticProcessResult } from '../../shared/diagnostic-process'
import type { TelemetrySpanView } from '../../shared/telemetry-contract'
import type { HybridMemoryKind, HybridMemoryView, HybridMemoryWrite } from '../../shared/hybrid-memory-contract'
import type { LlmCompletionRequestView, LlmRouteView } from '../../shared/llm-contract'
import type { EvolutionRecord } from '../../shared/evolution-history'
import type { TextSearchRequest, TextSearchResult } from '../../shared/text-search-contract'
import type { CustomTerminalPreset } from '../../shared/terminal-presets'
export type { CustomTerminalPreset }
import type { UsageShareState } from '../../shared/usage-contract'

export interface TechStack {
  id: string
  label: string
  color: string
}

export interface GitStatus {
  isRepo: boolean
  branch: string
  ahead: number
  behind: number
  hasChanges: boolean
  modifiedCount: number
  untrackedCount: number
  lastSyncTime?: string
  statusMessage?: string
}

export interface GitBranch {
  name: string
  isCurrent: boolean
  isRemote: boolean
  upstream?: string
  commit?: string
}

export interface Project {
  id: string
  name: string
  path: string
  parentDir: string
  lastModified: number
  techs: TechStack[]
  packageManager?: string
  scripts?: string[]
  git: GitStatus
  /** Metadata retained when the local working copy is released. */
  remoteUrl?: string
  parentPath?: string
  lifecycle?: 'local' | 'archived'
}

export interface ManagedProject {
  id: string
  name: string
  parentPath: string
  folderName: string
  remoteUrl: string
  branch: string
  registeredAt: string
}

export interface OtherDir {
  name: string
  path: string
  parentDir: string
}

export interface ProjectFileEntry {
  path: string
  name: string
  kind: 'file' | 'directory'
  size?: number
  editable?: boolean
}

export interface ProjectFileTree {
  entries: ProjectFileEntry[]
  truncated: boolean
}

export interface ProjectFileContent {
  path: string
  content: string
  size: number
}

export interface CodexTerminalStartResult {
  success: boolean
  id?: string
  pid?: number
  needsAuth?: boolean
  account?: 'account1' | 'account2'
  message?: string
}

export interface AgentTerminalStartResult extends CodexTerminalStartResult {
  provider?: AgentProviderId
  command?: string
  tier?: 'fast' | 'deep'
  model?: string
}

export interface AgentTurnAttempt {
  provider: AgentProviderId
  ok: boolean
  error?: string
}

export interface AgentTurnResult {
  success: boolean
  provider: AgentProviderId
  model: string
  tier: 'fast' | 'deep'
  result?: string
  blocked?: string
  attempts: AgentTurnAttempt[]
  message?: string
}

export type PendingCreationKind = 'agent' | 'squad' | 'terminal'

export interface PendingCreationPayload {
  projectId: string
  kind: PendingCreationKind
  nonce: number
}

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

export interface AutomationConfig {
  /** Executor padrão para nós novos e nós antigos sem provider explícito. */
  defaultExecutor?: AgentProviderId
  /** Conta Codex padrão quando o executor padrão é o Codex. */
  defaultCodexAccount?: 'account1' | 'account2'
  /** Inicia o executor padrão automaticamente ao abrir o terminal primário. */
  autoStartExecutor?: boolean
  /** Reabre o workspace configurado na inicialização do app. */
  restoreWorkspace?: boolean
  /** Projeto restaurado quando restoreWorkspace está ativo. */
  restoreProjectId?: string
}

/**
 * Nomes das chaves BYOK. A lista é a fonte única para config (armazenamento
 * seguro), validação e UI. Os valores NUNCA devem ser enviados ao renderer.
 */
export const MODEL_ROUTING_SECRET_KEYS = [
  'openaiApiKey',
  'anthropicApiKey',
  'geminiApiKey',
  'deepseekApiKey',
  'glmApiKey',
  'kimiApiKey',
  'minimaxApiKey',
  'vllmApiKey',
] as const

export type ModelRoutingSecretKey = (typeof MODEL_ROUTING_SECRET_KEYS)[number]

/** URLs base opcionais por provedor (não são segredos e podem ir ao renderer). */
export const MODEL_ROUTING_BASE_URL_KEYS = [
  'openaiBaseUrl',
  'anthropicBaseUrl',
  'geminiBaseUrl',
  'deepseekBaseUrl',
  'glmBaseUrl',
  'kimiBaseUrl',
  'minimaxBaseUrl',
  'ollamaBaseUrl',
  'vllmBaseUrl',
] as const

export type ModelRoutingBaseUrlKey = (typeof MODEL_ROUTING_BASE_URL_KEYS)[number]

/**
 * Credenciais BYOK. Preenchidas apenas no processo main (decifradas do
 * armazenamento seguro) e nunca devolvidas ao renderer.
 */
export interface ModelRoutingSecrets {
  openaiApiKey?: string
  anthropicApiKey?: string
  geminiApiKey?: string
  deepseekApiKey?: string
  glmApiKey?: string
  kimiApiKey?: string
  minimaxApiKey?: string
  vllmApiKey?: string
}

export interface ModelRoutingConfig extends ModelRoutingSecrets {
  fastModel?: string
  deepModel?: string
  openaiBaseUrl?: string
  anthropicBaseUrl?: string
  geminiBaseUrl?: string
  deepseekBaseUrl?: string
  glmBaseUrl?: string
  kimiBaseUrl?: string
  minimaxBaseUrl?: string
  ollamaBaseUrl?: string
  vllmBaseUrl?: string
  /** Visão segura: indica que há chave configurada sem revelar o valor. */
  hasOpenaiKey?: boolean
  hasAnthropicKey?: boolean
  hasGeminiKey?: boolean
  hasDeepseekKey?: boolean
  hasGlmKey?: boolean
  hasKimiKey?: boolean
  hasMinimaxKey?: boolean
  hasVllmKey?: boolean
}

export interface AppConfig {
  projectDirs: string[]
  managedProjects: ManagedProject[]
  projectAccounts: Record<string, 'account1' | 'account2'>
  activeChatGptAccount: 'account1' | 'account2'
  chatGptAccount1Name: string
  chatGptAccount2Name: string
  customPaths: {
    brave?: string
    chrome?: string
    mimo?: string
    agy?: string
    codex?: string
    opencode?: string
    claude?: string
    gemini?: string
    aider?: string
    customAgent?: string
    vscode?: string
    wt?: string
  }
  modelRouting?: ModelRoutingConfig
  automation?: AutomationConfig
  /** Presets de terminal personalizados criados pelo usuário (Smart Terminals). */
  terminalPresets?: CustomTerminalPreset[]
}

export interface SyncResult {
  success: boolean
  message: string
  output?: string
  commitCreated?: boolean
}

export interface GitChange {
  /** Relative path reported by Git and safe to send back as a pathspec. */
  path: string
  /** Two-character porcelain status, for example ` M` or `??`. */
  status: string
  /** Related paths for rename/copy entries, when Git reports more than one. */
  stagingPaths?: string[]
}

export type GitPushOptions = {
  /** Paths explicitly reviewed by the user before creating a commit. */
  selectedPaths?: string[]
}

export interface GitFileDiff {
  path: string
  status: string
  headExists: boolean
  worktreeExists: boolean
  binary: boolean
  truncated: boolean
  diff: string
  headContent: string
  worktreeContent: string
  message: string
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

export type IpcInvokeChannel =
  | 'devorbit:getProjects' | 'devorbit:refreshProjects' | 'devorbit:getOtherDirs'
  | 'devorbit:listProjectFiles' | 'devorbit:readProjectFile' | 'devorbit:saveProjectFile'
  | 'devorbit:createProjectFile' | 'devorbit:createProjectDirectory' | 'devorbit:moveProjectEntry' | 'devorbit:deleteProjectEntry'
  | 'devorbit:syncGit' | 'devorbit:getGitBranches' | 'devorbit:switchGitBranch'
  | 'devorbit:stashSyncGit' | 'devorbit:stashSwitchGitBranch' | 'devorbit:pushGit'
  | 'devorbit:getGitChanges' | 'devorbit:getGitFileDiff' | 'devorbit:syncAllGit' | 'devorbit:getGitInitPreview'
  | 'devorbit:initGitRepository' | 'devorbit:cloneGitRepository' | 'devorbit:restoreManagedProject'
  | 'devorbit:finalizeManagedProject' | 'devorbit:startTerminal' | 'devorbit:startCodexTerminal'
  | 'devorbit:startAgentTerminal'
  | 'devorbit:createAgentWorktree'
  | 'devorbit:integrateAgentWorktree'
  | 'devorbit:resizeTerminal' | 'devorbit:writeTerminal' | 'devorbit:stopTerminal'
  | 'devorbit:pipeTerminals' | 'devorbit:sendAgentTurn'
  | 'devorbit:navigateWeb' | 'devorbit:getWebState' | 'devorbit:goBackWeb'
  | 'devorbit:goForwardWeb' | 'devorbit:reloadWeb' | 'devorbit:setWebVisible'
  | 'devorbit:disposeWebPanel' | 'devorbit:setWebBounds' | 'devorbit:launchTool'
  | 'devorbit:copyProjectContext' | 'devorbit:getConfig' | 'devorbit:getUpdateState'
  | 'devorbit:downloadUpdate' | 'devorbit:installUpdate' | 'devorbit:saveConfig'
  | 'devorbit:exportConfig' | 'devorbit:importConfig' | 'devorbit:selectDirectory'
  | 'devorbit:testToolPath' | 'devorbit:getToolHealth' | 'devorbit:getCodexAuthStatus'
  | 'devorbit:startCodexLogin' | 'devorbit:cancelCodexLogin' | 'devorbit:getProjectMemory'
  | 'devorbit:saveProjectMemory' | 'devorbit:generateMemoryFromGit'
  | 'devorbit:getRealUsage' | 'devorbit:getProjectAudit' | 'devorbit:getHitlRequests'
  | 'devorbit:approveHitl' | 'devorbit:rejectHitl'
  | 'devorbit:runDiagnostic'
  | 'devorbit:getTelemetrySpans'
  | 'devorbit:getHybridMemory' | 'devorbit:rememberHybridMemory' | 'devorbit:searchHybridMemory'
  | 'devorbit:completeLlm'
  | 'devorbit:getEvolutionHistory'
  | 'devorbit:searchProjectText'
  | 'devorbit:getOrchestrationState'
  | 'devorbit:setOrchestrationContinuity'
  | 'devorbit:upsertOrchestrationSeat'
  | 'devorbit:removeOrchestrationSeat'
  | 'devorbit:assignOrchestrationRole'
  | 'devorbit:reportOrchestrationTurn'
  | 'devorbit:reportOrchestrationQuota'
  | 'devorbit:getUsageShare' | 'devorbit:refreshUsage'

export type IpcEventChannel =
  | 'devorbit:syncProgress' | 'devorbit:terminalEvent' | 'devorbit:webEvent'
  | 'devorbit:updateStatus' | 'devorbit:codexAuthProgress' | 'devorbit:companionEvent'
  | 'devorbit:agentBridgeEvent' | 'devorbit:hitlEvent' | 'devorbit:orchestrationEvent'

export type IpcSendChannel = 'devorbit:windowControl'

export interface SyncProgress {
  path: string
  done: number
  total: number
}

export interface GitCloneResult extends SyncResult {
  path?: string
}

export interface GitCloneInput {
  parentDir: string
  folderName: string
  remoteUrl: string
}

export interface ToolPathCheck {
  path: string
  ok: boolean
  message: string
}

export type ToolHealthState = 'ready' | 'fallback' | 'missing'

export type AgentProviderId = 'codex' | 'opencode' | 'claude' | 'gemini' | 'aider' | 'agy' | 'custom'

export interface AgentProvider {
  id: AgentProviderId
  label: string
  command: string
  state: ToolHealthState
  path?: string
  message: string
  configuredPath?: string
  effectivePath?: string
  isConfigured?: boolean
}

export interface ToolHealth {
  id: 'terminal' | 'vscode' | 'codex' | 'opencode' | 'claude' | 'gemini' | 'aider' | 'agy' | 'custom' | 'brave' | 'chrome' | 'mimo'
  label: string
  state: ToolHealthState
  path?: string
  message: string
  configuredPath?: string
  effectivePath?: string
  isConfigured?: boolean
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

export interface GitInitPreview {
  path: string
  canInitialize: boolean
  isRepository: boolean
  branch: string
  fileCount: number
  files: string[]
  truncated: boolean
  fingerprint: string
  message: string
}

export interface GitInitOptions {
  branch?: string
  remoteUrl?: string
  initialCommit?: boolean
  commitMessage?: string
  push?: boolean
  confirmAllFiles?: boolean
  previewFingerprint?: string
}

export interface GitInitResult {
  success: boolean
  initialized: boolean
  commitCreated: boolean
  pushed: boolean
  branch: string
  remoteUrl?: string
  preview: GitInitPreview
  message: string
  output?: string
}

export type CodexAccountId = 'account1' | 'account2'

export interface CodexAccountInfo {
  id: CodexAccountId
  connected: boolean
  label: string
  path: string
  browserOk: boolean
  browserPath: string
  active?: boolean
  hasAuthFile?: boolean
}

export interface CodexAccountStatus {
  account1: CodexAccountInfo
  account2: CodexAccountInfo
  activeAccount?: CodexAccountId
  accounts?: CodexAccountInfo[]
}

export interface CodexAuthProgress {
  account: 'account1' | 'account2'
  status: 'idle' | 'starting' | 'code_generated' | 'success' | 'error' | 'cancelled'
  code?: string
  verificationUrl?: string
  message?: string
}

export interface ProjectMemory {
  content: string
  lastUpdated?: string
  exists: boolean
  path: string
  stale?: boolean | 'unknown'
  sourceCommit?: string
  generatedAt?: string
}

export type RealUsageStatus = 'ready' | 'not_configured' | 'error'

export interface RealUsageMetric {
  id: string
  label: string
  percent?: number
  resetAt?: number
  windowSeconds?: number
  value?: string
  detail?: string
}

export interface RealAccountUsage {
  account: 'account1' | 'account2'
  status: RealUsageStatus
  plan?: string
  metrics: RealUsageMetric[]
  fetchedAt?: string
  message?: string
}

export interface RealUsageState {
  source: 'codex-oauth'
  fetchedAt: string
  accounts: {
    account1: RealAccountUsage
    account2: RealAccountUsage
  }
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

export interface DevOrbitAPI {
  getProjects: () => Promise<Project[]>
  refreshProjects: () => Promise<Project[]>
  getOtherDirs: () => Promise<OtherDir[]>
  listProjectFiles: (projectPath: string, relativeDirectory?: string) => Promise<ProjectFileTree>
  readProjectFile: (projectPath: string, relativePath: string) => Promise<ProjectFileContent>
  saveProjectFile: (projectPath: string, relativePath: string, content: string) => Promise<ProjectFileContent>
  createProjectFile: (projectPath: string, relativePath: string) => Promise<ProjectFileContent>
  createProjectDirectory: (projectPath: string, relativePath: string) => Promise<ProjectFileEntry>
  moveProjectEntry: (projectPath: string, sourcePath: string, destinationPath: string) => Promise<{ from: string; path: string }>
  deleteProjectEntry: (projectPath: string, relativePath: string, options?: { recursive: boolean }) => Promise<{ path: string }>
  syncGit: (projectPath: string) => Promise<SyncResult>
  getGitBranches: (projectPath: string, refreshRemote?: boolean) => Promise<GitBranch[]>
  switchGitBranch: (projectPath: string, branch: string) => Promise<SyncResult>
  stashSyncGit: (projectPath: string) => Promise<SyncResult>
  stashSwitchGitBranch: (projectPath: string, branch: string) => Promise<SyncResult>
  pushGit: (projectPath: string, commitMessage?: string, options?: GitPushOptions) => Promise<SyncResult>
  getGitChanges: (projectPath: string) => Promise<GitChange[]>
  getGitFileDiff: (projectPath: string, relativePath: string) => Promise<GitFileDiff>
  syncAllGit: () => Promise<{ [projectPath: string]: SyncResult }>
  onSyncProgress: (callback: (progress: SyncProgress) => void) => () => void
  getGitInitPreview: (projectPath: string, branch?: string) => Promise<GitInitPreview>
  initGitRepository: (projectPath: string, options?: GitInitOptions) => Promise<GitInitResult>
  cloneGitRepository: (input: GitCloneInput) => Promise<GitCloneResult>
  restoreManagedProject: (projectPath: string) => Promise<GitCloneResult>
  finalizeManagedProject: (projectPath: string, options?: { allowRecreatableIgnored?: boolean }) => Promise<SyncResult>
  createAgentWorktree: (projectPath: string, agentId: string) => Promise<{ path: string; branch: string }>
  integrateAgentWorktree: (projectPath: string, branch: string, worktreePath: string) => Promise<SyncResult>
  startTerminal: (
    id: string,
    projectPath: string,
    cols?: number,
    rows?: number,
    options?: { command?: string; args?: string[]; cwd?: string },
  ) => Promise<{ id: string; pid: number | undefined }>
  startCodexTerminal: (
    id: string,
    projectPath: string,
    account: 'account1' | 'account2',
    cols?: number,
    rows?: number,
  ) => Promise<CodexTerminalStartResult>
  startAgentTerminal: (
    id: string,
    projectPath: string,
    provider: AgentProviderId,
    cols?: number,
    rows?: number,
    task?: string,
  ) => Promise<AgentTerminalStartResult>
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<{ success: boolean }>
  writeTerminal: (id: string, input: string) => Promise<{ success: boolean }>
  stopTerminal: (id: string) => Promise<{ success: boolean }>
  pipeTerminals: (fromId: string, toId: string | null) => Promise<{ success: boolean }>
  sendAgentTurn: (
    terminalId: string,
    provider: AgentProviderId,
    projectPath: string,
    prompt: string,
    timeouts?: { idleMs?: number; overallMs?: number },
  ) => Promise<AgentTurnResult>
  onTerminalEvent: (callback: (event: TerminalEvent) => void) => () => void
  onCompanionEvent: (callback: (summary: CompanionSummary) => void) => () => void
  onAgentBridgeEvent: (callback: (event: AgentBridgeEvent) => void) => () => void
  onHitlEvent: (callback: (request: HitlRequestView) => void) => () => void
  navigateWeb: (url: string) => Promise<{ success: boolean; url?: string; message?: string }>
  getWebState: () => Promise<WebPanelEvent>
  goBackWeb: () => Promise<{ success: boolean }>
  goForwardWeb: () => Promise<{ success: boolean }>
  reloadWeb: () => Promise<{ success: boolean }>
  setWebVisible: (visible: boolean) => Promise<{ success: boolean }>
  disposeWebPanel: () => Promise<{ success: boolean }>
  setWebBounds: (bounds: WebPanelBounds) => Promise<{ success: boolean }>
  onWebEvent: (callback: (event: WebPanelEvent) => void) => () => void
  launchTool: (
    tool:
      | 'agy'
      | 'mimo'
      | 'brave'
      | 'chrome'
      | 'codex-desktop'
      | 'codex-cli'
      | 'vscode'
      | 'terminal'
      | 'folder',
    projectPath: string,
    options?: { account?: 'account1' | 'account2'; url?: string }
  ) => Promise<{ success: boolean; message?: string; needsAuth?: boolean; account?: string }>
  copyProjectContext: (projectPath: string) => Promise<{ success: boolean; context: string }>
  getConfig: () => Promise<AppConfig>
  getUpdateState: () => Promise<UpdateState>
  downloadUpdate: () => Promise<UpdateState>
  installUpdate: () => Promise<{ success: boolean }>
  onUpdateStatus: (callback: (state: UpdateState) => void) => () => void
  saveConfig: (config: Partial<AppConfig>) => Promise<AppConfig>
  exportConfig: () => Promise<SyncResult>
  importConfig: () => Promise<SyncResult>
  selectDirectory: () => Promise<string | null>
  testToolPath: (toolPath: string) => Promise<ToolPathCheck>
  getToolHealth: () => Promise<ToolHealth[]>
  windowControl: (action: 'minimize' | 'maximize' | 'close') => void
  getCodexAuthStatus: () => Promise<CodexAccountStatus>
  startCodexLogin: (account: 'account1' | 'account2') => Promise<{ success: boolean }>
  cancelCodexLogin: () => Promise<{ success: boolean }>
  onCodexAuthProgress: (callback: (progress: CodexAuthProgress) => void) => () => void
  getProjectMemory: (projectPath: string) => Promise<ProjectMemory>
  saveProjectMemory: (
    projectPath: string,
    content: string
  ) => Promise<{ success: boolean; message?: string }>
  generateMemoryFromGit: (projectPath: string) => Promise<string>
  getRealUsage: (force?: boolean) => Promise<RealUsageState>
  getProjectAudit: (projectPath: string) => Promise<AuditSnapshot>
  getHitlRequests: () => Promise<HitlRequestView[]>
  approveHitl: (id: string, reason?: string) => Promise<HitlRequestView>
  rejectHitl: (id: string, reason?: string) => Promise<HitlRequestView>
  runDiagnostic: (request: DiagnosticProcessRequest) => Promise<DiagnosticProcessResult>
  getTelemetrySpans: (limit?: number) => Promise<TelemetrySpanView[]>
  getHybridMemory: (projectPath: string, kind?: HybridMemoryKind) => Promise<HybridMemoryView[]>
  rememberHybridMemory: (projectPath: string, input: HybridMemoryWrite) => Promise<HybridMemoryView>
  searchHybridMemory: (projectPath: string, query: string, limit?: number) => Promise<Array<{ entry: HybridMemoryView; score: number; matchedTerms: string[] }>>
  completeLlm: (request: LlmCompletionRequestView) => Promise<LlmRouteView>
  getEvolutionHistory: (limit?: number) => Promise<EvolutionRecord[]>
  searchProjectText: (request: TextSearchRequest) => Promise<TextSearchResult>
  getOrchestrationState: (projectPath: string) => Promise<OrchestrationState | null>
  setOrchestrationContinuity: (projectPath: string, enabled: boolean) => Promise<OrchestrationState | null>
  upsertOrchestrationSeat: (projectPath: string, input: {
    id: string
    provider: AgentProviderId
    role: OrchestrationRole
    account?: 'account1' | 'account2'
    model?: string
    tier?: 'fast' | 'deep'
  }) => Promise<OrchestrationState | null>
  removeOrchestrationSeat: (projectPath: string, seatId: string) => Promise<OrchestrationState | null>
  assignOrchestrationRole: (projectPath: string, role: OrchestrationRole, seatId?: string) => Promise<OrchestrationState | null>
  reportOrchestrationTurn: (projectPath: string, input: {
    seatId: string
    role?: OrchestrationRole
    outcome: 'completed' | 'blocked' | 'failed'
    summary?: string
    transient?: boolean
    branch?: string
    commit?: string
  }) => Promise<OrchestrationState | null>
  reportOrchestrationQuota: (projectPath: string, seatId: string, percent?: number) => Promise<OrchestrationState | null>
  onOrchestrationEvent: (callback: (event: ContinuityEvent) => void) => () => void
  /** Uso agregado por modelo (participação, tokens reais e quota). */
  getUsageShare: () => Promise<UsageShareState>
  /** Força uma varredura dos adaptadores locais antes de responder. */
  refreshUsage: () => Promise<UsageShareState>
}

declare global {
  interface Window {
    devorbit: DevOrbitAPI
  }
}
