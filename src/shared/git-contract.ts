/**
 * Contrato Git compartilhado (fonte única main ↔ renderer): status, branches,
 * sync/push, diffs e inicialização/clone de repositórios.
 */

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

export interface GitCloneResult extends SyncResult {
  path?: string
}

export interface GitCloneInput {
  parentDir: string
  folderName: string
  remoteUrl: string
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
