export interface InitDockState {
  canInitialize: boolean
  truncated: boolean
  fingerprint?: string
  isLoading: boolean
  isBusy: boolean
  initialCommit: boolean
  commitMessage: string
  confirmed: boolean
  push: boolean
  remoteUrl: string
}

export function isInitPushAvailable(remoteUrl: string, initialCommit: boolean): boolean {
  return initialCommit && remoteUrl.trim().length > 0
}

export function canSubmitInitDock(state: InitDockState): boolean {
  if (!state.canInitialize || state.isLoading || state.isBusy) return false
  if (state.initialCommit) {
    if (!state.confirmed) return false
    if (!state.commitMessage.trim()) return false
    if (state.truncated) return false
    if (!state.fingerprint) return false
  }
  if (state.push && !state.remoteUrl.trim()) return false
  return true
}

export type DiffTone = 'add' | 'del' | 'hunk' | 'meta' | 'context'

export function classifyDiffLine(line: string): DiffTone {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

export function splitPreviewLines(content: string, maxLines = 400): { lines: string[]; truncated: boolean } {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return { lines, truncated: false }
  return { lines: lines.slice(0, maxLines), truncated: true }
}
