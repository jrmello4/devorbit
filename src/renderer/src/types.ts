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

export interface Project {
  id: string
  name: string
  path: string
  parentDir: string
  lastModified: number
  techs: TechStack[]
  git: GitStatus
}

export interface AppConfig {
  projectDirs: string[]
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
  }
  account2: {
    connected: boolean
    label: string
    path: string
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
  syncGit: (projectPath: string) => Promise<SyncResult>
  pushGit: (projectPath: string, commitMessage?: string) => Promise<SyncResult>
  getGitChanges: (projectPath: string) => Promise<string[]>
  syncAllGit: () => Promise<{ [projectPath: string]: SyncResult }>
  getGitInitPreview: (projectPath: string, branch?: string) => Promise<GitInitPreview>
  initGitRepository: (projectPath: string, options?: GitInitOptions) => Promise<GitInitResult>
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
  saveConfig: (config: Partial<AppConfig>) => Promise<AppConfig>
  selectDirectory: () => Promise<string | null>
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
