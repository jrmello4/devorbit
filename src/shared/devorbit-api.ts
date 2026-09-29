/**
 * Contrato da bridge `window.devorbit` (fonte única main ↔ preload ↔ renderer).
 *
 * A interface DevOrbitAPI é o que o preload expõe via contextBridge e o
 * renderer consome. Tipos de suporte que só existem para esta API (explorador
 * de arquivos do projeto, start de terminais/agentes, contas Codex, memória
 * de projeto) também moram aqui.
 */
import type { AgentProviderId } from './agent-provider-contract'
import type { CodexAccountId } from './codex-session'
import type { AppConfig, OtherDir, Project } from './app-config'
import type {
  GitBranch,
  GitChange,
  GitCloneInput,
  GitCloneResult,
  GitFileDiff,
  GitInitOptions,
  GitInitPreview,
  GitInitResult,
  GitPushOptions,
  SyncResult,
} from './git-contract'
import type {
  CodexAuthProgress,
  CompanionSummary,
  HitlRequestView,
  SyncProgress,
  TerminalEvent,
  UpdateState,
  WebPanelBounds,
  WebPanelEvent,
} from './app-events'
import type { RealUsageState } from './usage-real-contract'
import type { ToolHealth, ToolPathCheck } from './tool-health-contract'
import type { AgentBridgeEvent } from './agent-bridge-event'
import type { AuditSnapshot } from './audit-contract'
import type { DiagnosticProcessRequest, DiagnosticProcessResult } from './diagnostic-process'
import type { TelemetrySpanView } from './telemetry-contract'
import type { HybridMemoryKind, HybridMemoryView, HybridMemoryWrite } from './hybrid-memory-contract'
import type { LlmCompletionRequestView, LlmRouteView } from './llm-contract'
import type { EvolutionRecord } from './evolution-history'
import type { TextSearchRequest, TextSearchResult } from './text-search-contract'
import type { ContinuityEvent, OrchestrationRole, OrchestrationState } from './orchestration-continuity'
import type { UsageShareState } from './usage-contract'
import type {
  AiMemoryEnableProjectRequest,
  AiMemoryEnableProjectResult,
  AiMemoryIpcResult,
  AiMemoryMigrationOutcomeView,
  AiMemoryMigrationStatusResult,
  AiMemoryProjectRef,
  AiMemoryProjectStatusRequest,
  AiMemoryProjectStatusResult,
  AiMemoryQueryRequest,
  AiMemoryRecentRequest,
  AiMemorySquadSnapshotView,
  AiMemoryStatus,
  AiMemoryTakeoverPlanView,
  AiMemoryTakeoverRequest,
} from './ai-memory-ipc-contract'
import type { AiUsagebarDetectReport, AiUsagebarSnapshot } from './ai-usagebar-contract'
import type {
  AiUsagebarApiKeyRequest,
  AiUsagebarIpcResult,
  AiUsagebarProviderChangeRequest,
} from './ai-usagebar-ipc-contract'

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

export interface ProjectMemory {
  content: string
  lastUpdated?: string
  exists: boolean
  path: string
  stale?: boolean | 'unknown'
  sourceCommit?: string
  generatedAt?: string
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
    turnId?: string,
  ) => Promise<AgentTurnResult>
  /** Submissão centralizada (prontidão por turno + UM Enter + ack) — o Enter nunca é montado no renderer. */
  submitAgentInstruction: (
    terminalId: string,
    instruction: { turnId: string; content: string },
  ) => Promise<{ success: boolean; acked: boolean; attempts: number; error?: string }>
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
  /** Status do serviço ai-memory (FASE 3). */
  aiMemoryStatus: () => Promise<AiMemoryIpcResult<AiMemoryStatus>>
  /** Diagnóstico do sidecar ai-memory. */
  aiMemoryDoctor: () => Promise<AiMemoryIpcResult<{ ok: boolean; message?: string }>>
  /** Consulta à memória do projeto. */
  aiMemoryQuery: (request: AiMemoryQueryRequest) => Promise<AiMemoryIpcResult<unknown>>
  /** Briefing consolidado do projeto. */
  aiMemoryBriefing: (request: AiMemoryProjectRef) => Promise<AiMemoryIpcResult<unknown>>
  /** Handoffs recentes do projeto. */
  aiMemoryRecent: (request: AiMemoryRecentRequest) => Promise<AiMemoryIpcResult<unknown>>
  /** Lista de handoffs abertos do projeto. */
  aiMemoryHandoffs: (request: AiMemoryProjectRef) => Promise<AiMemoryIpcResult<unknown>>
  /** Habilita/desabilita um projeto no ai-memory. */
  aiMemoryEnableProject: (request: AiMemoryEnableProjectRequest) => Promise<AiMemoryIpcResult<AiMemoryEnableProjectResult>>
  /** Migra dados legados para o ai-memory. */
  aiMemoryMigrateLegacy: (request: AiMemoryProjectRef) => Promise<AiMemoryIpcResult<AiMemoryMigrationOutcomeView>>
  /** Status da migração legado. */
  aiMemoryMigrationStatus: (request: AiMemoryProjectRef) => Promise<AiMemoryIpcResult<AiMemoryMigrationStatusResult>>
  /** Status do projeto para dashboard: opt-in + serviço + migração. */
  getProjectStatus: (request: AiMemoryProjectStatusRequest) => Promise<AiMemoryIpcResult<AiMemoryProjectStatusResult>>
  /** Takeover de sessão squad. */
  aiMemoryTakeover: (request: AiMemoryTakeoverRequest) => Promise<AiMemoryIpcResult<AiMemoryTakeoverPlanView | null>>
  /** Publica snapshot do squad no ai-memory. */
  aiMemoryPublishSquadState: (request: { projectPath: string; snapshot: AiMemorySquadSnapshotView }) => Promise<AiMemoryIpcResult<{ path: string; published: boolean }>>
  /** Snapshot em cache do catálogo e quotas externas, sem credenciais. */
  aiUsagebarSnapshot: () => Promise<AiUsagebarIpcResult<AiUsagebarSnapshot>>
  /** Atualiza a consulta consolidada de quotas. */
  aiUsagebarRefresh: () => Promise<AiUsagebarIpcResult<AiUsagebarSnapshot>>
  /** Ação explícita: o comando upstream pode alterar o config.toml. */
  aiUsagebarDetect: () => Promise<AiUsagebarIpcResult<AiUsagebarDetectReport>>
  aiUsagebarSetProvider: (request: AiUsagebarProviderChangeRequest) => Promise<AiUsagebarIpcResult<AiUsagebarSnapshot>>
  aiUsagebarSetApiKey: (request: AiUsagebarApiKeyRequest) => Promise<AiUsagebarIpcResult<AiUsagebarSnapshot>>
  aiUsagebarRemoveApiKey: (request: Pick<AiUsagebarApiKeyRequest, 'vendorId'>) => Promise<AiUsagebarIpcResult<AiUsagebarSnapshot>>
}
