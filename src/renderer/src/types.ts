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

export interface DevOrbitAPI {
  getProjects: () => Promise<Project[]>
  refreshProjects: () => Promise<Project[]>
  syncGit: (projectPath: string) => Promise<SyncResult>
  pushGit: (projectPath: string, commitMessage?: string) => Promise<SyncResult>
  getGitChanges: (projectPath: string) => Promise<string[]>
  syncAllGit: () => Promise<{ [projectPath: string]: SyncResult }>
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
    options?: { account?: 'account1' | 'account2' }
  ) => Promise<{ success: boolean; message?: string }>
  copyProjectContext: (projectPath: string) => Promise<{ success: boolean; context: string }>
  getConfig: () => Promise<AppConfig>
  saveConfig: (config: Partial<AppConfig>) => Promise<AppConfig>
  selectDirectory: () => Promise<string | null>
  windowControl: (action: 'minimize' | 'maximize' | 'close') => void
}

declare global {
  interface Window {
    devorbit: DevOrbitAPI
  }
}
