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

export interface TerminalEvent {
  id: string
  type: 'data' | 'exit' | 'error'
  data?: string
  code?: number | null
}

export interface WebPanelEvent {
  type: 'loading' | 'loaded' | 'navigated' | 'error'
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
    vscode?: string
    wt?: string
  }
}

export interface SyncResult {
  success: boolean
  message: string
  output?: string
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

export type IpcInvokeChannel =
  | 'devorbit:getProjects' | 'devorbit:refreshProjects' | 'devorbit:getOtherDirs'
  | 'devorbit:listProjectFiles' | 'devorbit:readProjectFile' | 'devorbit:saveProjectFile'
  | 'devorbit:syncGit' | 'devorbit:getGitBranches' | 'devorbit:switchGitBranch'
  | 'devorbit:stashSyncGit' | 'devorbit:stashSwitchGitBranch' | 'devorbit:pushGit'
  | 'devorbit:getGitChanges' | 'devorbit:syncAllGit' | 'devorbit:getGitInitPreview'
  | 'devorbit:initGitRepository' | 'devorbit:cloneGitRepository' | 'devorbit:restoreManagedProject'
  | 'devorbit:finalizeManagedProject' | 'devorbit:startTerminal' | 'devorbit:startCodexTerminal'
  | 'devorbit:resizeTerminal' | 'devorbit:writeTerminal' | 'devorbit:stopTerminal'
  | 'devorbit:navigateWeb' | 'devorbit:getWebState' | 'devorbit:goBackWeb'
  | 'devorbit:goForwardWeb' | 'devorbit:reloadWeb' | 'devorbit:setWebVisible'
  | 'devorbit:disposeWebPanel' | 'devorbit:setWebBounds' | 'devorbit:launchTool'
  | 'devorbit:copyProjectContext' | 'devorbit:getConfig' | 'devorbit:getUpdateState'
  | 'devorbit:downloadUpdate' | 'devorbit:installUpdate' | 'devorbit:saveConfig'
  | 'devorbit:exportConfig' | 'devorbit:importConfig' | 'devorbit:selectDirectory'
  | 'devorbit:testToolPath' | 'devorbit:getToolHealth' | 'devorbit:getCodexAuthStatus'
  | 'devorbit:startCodexLogin' | 'devorbit:cancelCodexLogin' | 'devorbit:getProjectMemory'
  | 'devorbit:saveProjectMemory' | 'devorbit:generateMemoryFromGit' | 'devorbit:getUsageState'
  | 'devorbit:getRealUsage' | 'devorbit:incrementUsage' | 'devorbit:decrementUsage'
  | 'devorbit:resetUsage' | 'devorbit:updateUsageLimits'

export type IpcEventChannel =
  | 'devorbit:syncProgress' | 'devorbit:terminalEvent' | 'devorbit:webEvent'
  | 'devorbit:updateStatus' | 'devorbit:codexAuthProgress'

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

export interface ToolHealth {
  id: 'terminal' | 'vscode' | 'codex' | 'agy' | 'brave' | 'chrome' | 'mimo'
  label: string
  state: ToolHealthState
  path?: string
  message: string
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

export interface CodexAccountStatus {
  account1: {
    connected: boolean
    label: string
    path: string
    browserOk: boolean
    browserPath: string
  }
  account2: {
    connected: boolean
    label: string
    path: string
    browserOk: boolean
    browserPath: string
  }
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

export interface AccountUsage {
  used: number
  limit: number
  windowStart?: number
  windowDurationHours: number
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

export interface UsageTrackerState {
  account1: AccountUsage
  account2: AccountUsage
  antigravity: {
    sessionCount: number
  }
}

export interface DevOrbitAPI {
  getProjects: () => Promise<Project[]>
  refreshProjects: () => Promise<Project[]>
  getOtherDirs: () => Promise<OtherDir[]>
  listProjectFiles: (projectPath: string, relativeDirectory?: string) => Promise<ProjectFileTree>
  readProjectFile: (projectPath: string, relativePath: string) => Promise<ProjectFileContent>
  saveProjectFile: (projectPath: string, relativePath: string, content: string) => Promise<ProjectFileContent>
  syncGit: (projectPath: string) => Promise<SyncResult>
  getGitBranches: (projectPath: string, refreshRemote?: boolean) => Promise<GitBranch[]>
  switchGitBranch: (projectPath: string, branch: string) => Promise<SyncResult>
  stashSyncGit: (projectPath: string) => Promise<SyncResult>
  stashSwitchGitBranch: (projectPath: string, branch: string) => Promise<SyncResult>
  pushGit: (projectPath: string, commitMessage?: string, options?: GitPushOptions) => Promise<SyncResult>
  getGitChanges: (projectPath: string) => Promise<GitChange[]>
  syncAllGit: () => Promise<{ [projectPath: string]: SyncResult }>
  onSyncProgress: (callback: (progress: SyncProgress) => void) => () => void
  getGitInitPreview: (projectPath: string, branch?: string) => Promise<GitInitPreview>
  initGitRepository: (projectPath: string, options?: GitInitOptions) => Promise<GitInitResult>
  cloneGitRepository: (input: GitCloneInput) => Promise<GitCloneResult>
  restoreManagedProject: (projectPath: string) => Promise<GitCloneResult>
  finalizeManagedProject: (projectPath: string, options?: { allowRecreatableIgnored?: boolean }) => Promise<SyncResult>
  startTerminal: (id: string, projectPath: string) => Promise<{ id: string; pid: number | undefined }>
  startCodexTerminal: (
    id: string,
    projectPath: string,
    account: 'account1' | 'account2',
    cols?: number,
    rows?: number,
  ) => Promise<CodexTerminalStartResult>
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<{ success: boolean }>
  writeTerminal: (id: string, input: string) => Promise<{ success: boolean }>
  stopTerminal: (id: string) => Promise<{ success: boolean }>
  onTerminalEvent: (callback: (event: TerminalEvent) => void) => () => void
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
  getUsageState: () => Promise<UsageTrackerState>
  getRealUsage: (force?: boolean) => Promise<RealUsageState>
  incrementUsage: (
    target: 'account1' | 'account2' | 'antigravity'
  ) => Promise<UsageTrackerState>
  decrementUsage: (target: 'account1' | 'account2') => Promise<UsageTrackerState>
  resetUsage: (target: 'account1' | 'account2') => Promise<UsageTrackerState>
  updateUsageLimits: (
    account: 'account1' | 'account2',
    limit: number,
    windowHours?: number
  ) => Promise<UsageTrackerState>
}

declare global {
  interface Window {
    devorbit: DevOrbitAPI
  }
}
