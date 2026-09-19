import electron from 'electron'
import type { IpcRendererEvent } from 'electron'
const { contextBridge, ipcRenderer } = electron
import type {
  AppConfig,
  CompanionSummary,
  DevOrbitAPI,
  IpcEventChannel,
  IpcInvokeChannel,
  IpcSendChannel,
  SyncProgress,
  TerminalEvent,
  WebPanelEvent,
  UpdateState,
  CodexAuthProgress,
  HitlRequestView,
} from '../renderer/src/types'
import type { AgentBridgeEvent } from '../shared/agent-bridge-event'
import type { DiagnosticProcessRequest, DiagnosticProcessResult } from '../shared/diagnostic-process'
import type { TelemetrySpanView } from '../shared/telemetry-contract'
import type { HybridMemoryKind, HybridMemoryView, HybridMemoryWrite } from '../shared/hybrid-memory-contract'
import type { LlmCompletionRequestView, LlmRouteView } from '../shared/llm-contract'
import type { EvolutionRecord } from '../shared/evolution-history'
import type { TextSearchRequest, TextSearchResult } from '../shared/text-search-contract'
import type { ContinuityEvent, OrchestrationState } from '../shared/orchestration-continuity'

const invoke = <T>(channel: IpcInvokeChannel, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

function subscribe<T>(channel: IpcEventChannel, callback: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const send = (channel: IpcSendChannel, ...args: unknown[]): void => {
  ipcRenderer.send(channel, ...args)
}

const api: DevOrbitAPI = {
  getProjects: () => invoke('devorbit:getProjects'),
  refreshProjects: () => invoke('devorbit:refreshProjects'),
  getOtherDirs: () => invoke('devorbit:getOtherDirs'),
  listProjectFiles: (projectPath: string, relativeDirectory?: string) => relativeDirectory === undefined
    ? invoke('devorbit:listProjectFiles', projectPath)
    : invoke('devorbit:listProjectFiles', projectPath, relativeDirectory),
  readProjectFile: (projectPath: string, relativePath: string) => invoke('devorbit:readProjectFile', projectPath, relativePath),
  saveProjectFile: (projectPath: string, relativePath: string, content: string) => invoke('devorbit:saveProjectFile', projectPath, relativePath, content),
  createProjectFile: (projectPath: string, relativePath: string) => invoke('devorbit:createProjectFile', projectPath, relativePath),
  createProjectDirectory: (projectPath: string, relativePath: string) => invoke('devorbit:createProjectDirectory', projectPath, relativePath),
  moveProjectEntry: (projectPath: string, sourcePath: string, destinationPath: string) => invoke('devorbit:moveProjectEntry', projectPath, sourcePath, destinationPath),
  deleteProjectEntry: (projectPath: string, relativePath: string, options?: { recursive: boolean }) => invoke('devorbit:deleteProjectEntry', projectPath, relativePath, options),
  syncGit: (projectPath: string) => invoke('devorbit:syncGit', projectPath),
  getGitBranches: (projectPath: string, refreshRemote?: boolean) =>
    invoke('devorbit:getGitBranches', projectPath, refreshRemote),
  switchGitBranch: (projectPath: string, branch: string) =>
    invoke('devorbit:switchGitBranch', projectPath, branch),
  stashSyncGit: (projectPath: string) =>
    invoke('devorbit:stashSyncGit', projectPath),
  stashSwitchGitBranch: (projectPath: string, branch: string) =>
    invoke('devorbit:stashSwitchGitBranch', projectPath, branch),
  pushGit: (projectPath: string, commitMessage?: string, options?) => options === undefined
    ? invoke('devorbit:pushGit', projectPath, commitMessage)
    : invoke('devorbit:pushGit', projectPath, commitMessage, options),
  getGitChanges: (projectPath: string) =>
    invoke('devorbit:getGitChanges', projectPath),
  getGitFileDiff: (projectPath: string, relativePath: string) =>
    invoke('devorbit:getGitFileDiff', projectPath, relativePath),
  syncAllGit: () => invoke('devorbit:syncAllGit'),
  onSyncProgress: (callback) => {
    return subscribe<SyncProgress>('devorbit:syncProgress', callback)
  },
  getGitInitPreview: (projectPath: string, branch?: string) =>
    invoke('devorbit:getGitInitPreview', projectPath, branch),
  initGitRepository: (projectPath, options) =>
    invoke('devorbit:initGitRepository', projectPath, options),
  cloneGitRepository: (input) =>
    invoke('devorbit:cloneGitRepository', input),
  restoreManagedProject: (projectPath: string) =>
    invoke('devorbit:restoreManagedProject', projectPath),
  finalizeManagedProject: (projectPath: string, options?: { allowRecreatableIgnored?: boolean }) =>
    invoke('devorbit:finalizeManagedProject', projectPath, options),
  createAgentWorktree: (projectPath: string, agentId: string) =>
    invoke('devorbit:createAgentWorktree', projectPath, agentId),
  integrateAgentWorktree: (projectPath: string, branch: string, worktreePath: string) =>
    invoke('devorbit:integrateAgentWorktree', projectPath, branch, worktreePath),
  startTerminal: (id: string, projectPath: string, cols?: number, rows?: number) =>
    cols === undefined && rows === undefined
      ? invoke('devorbit:startTerminal', id, projectPath)
      : invoke('devorbit:startTerminal', id, projectPath, cols, rows),
  startCodexTerminal: (id, projectPath, account, cols, rows) =>
    invoke('devorbit:startCodexTerminal', id, projectPath, account, cols, rows),
  startAgentTerminal: (id, projectPath, provider, cols, rows, task) =>
    task === undefined
      ? invoke('devorbit:startAgentTerminal', id, projectPath, provider, cols, rows)
      : invoke('devorbit:startAgentTerminal', id, projectPath, provider, cols, rows, task),
  resizeTerminal: (id, cols, rows) =>
    invoke('devorbit:resizeTerminal', id, cols, rows),
  writeTerminal: (id: string, input: string) =>
    invoke('devorbit:writeTerminal', id, input),
  stopTerminal: (id: string) =>
    invoke('devorbit:stopTerminal', id),
  pipeTerminals: (fromId: string, toId: string | null) =>
    invoke('devorbit:pipeTerminals', fromId, toId),
  sendAgentTurn: (terminalId, provider, projectPath, prompt, timeouts) =>
    timeouts === undefined
      ? invoke('devorbit:sendAgentTurn', terminalId, provider, projectPath, prompt)
      : invoke('devorbit:sendAgentTurn', terminalId, provider, projectPath, prompt, timeouts),
  onTerminalEvent: (callback) => {
    return subscribe<TerminalEvent>('devorbit:terminalEvent', callback)
  },
  onCompanionEvent: (callback) => {
    return subscribe<CompanionSummary>('devorbit:companionEvent', callback)
  },
  onAgentBridgeEvent: (callback) => {
    return subscribe<AgentBridgeEvent>('devorbit:agentBridgeEvent', callback)
  },
  onHitlEvent: (callback) => {
    return subscribe<HitlRequestView>('devorbit:hitlEvent', callback)
  },
  navigateWeb: (url: string) =>
    invoke('devorbit:navigateWeb', url),
  getWebState: () =>
    invoke('devorbit:getWebState'),
  goBackWeb: () => invoke('devorbit:goBackWeb'),
  goForwardWeb: () => invoke('devorbit:goForwardWeb'),
  reloadWeb: () => invoke('devorbit:reloadWeb'),
  setWebVisible: (visible: boolean) =>
    invoke('devorbit:setWebVisible', visible),
  disposeWebPanel: () => invoke('devorbit:disposeWebPanel'),
  setWebBounds: (bounds) =>
    invoke('devorbit:setWebBounds', bounds),
  onWebEvent: (callback) => {
    return subscribe<WebPanelEvent>('devorbit:webEvent', callback)
  },
  launchTool: (tool, projectPath, options) =>
    invoke('devorbit:launchTool', tool, projectPath, options),
  copyProjectContext: (projectPath) =>
    invoke('devorbit:copyProjectContext', projectPath),
  getConfig: () => invoke('devorbit:getConfig'),
  getUpdateState: () => invoke('devorbit:getUpdateState'),
  downloadUpdate: () => invoke('devorbit:downloadUpdate'),
  installUpdate: () => invoke('devorbit:installUpdate'),
  onUpdateStatus: (callback) => {
    return subscribe<UpdateState>('devorbit:updateStatus', callback)
  },
  saveConfig: (config: Partial<AppConfig>) => invoke('devorbit:saveConfig', config),
  exportConfig: () => invoke('devorbit:exportConfig'),
  importConfig: () => invoke('devorbit:importConfig'),
  selectDirectory: () => invoke('devorbit:selectDirectory'),
  testToolPath: (toolPath: string) => invoke('devorbit:testToolPath', toolPath),
  getToolHealth: () => invoke('devorbit:getToolHealth'),
  windowControl: (action: 'minimize' | 'maximize' | 'close') =>
    send('devorbit:windowControl', action),
  getCodexAuthStatus: () => invoke('devorbit:getCodexAuthStatus'),
  startCodexLogin: (account) => invoke('devorbit:startCodexLogin', account),
  cancelCodexLogin: () => invoke('devorbit:cancelCodexLogin'),
  onCodexAuthProgress: (callback) => {
    return subscribe<CodexAuthProgress>('devorbit:codexAuthProgress', callback)
  },
  getProjectMemory: (projectPath) =>
    invoke('devorbit:getProjectMemory', projectPath),
  saveProjectMemory: (projectPath, content) =>
    invoke('devorbit:saveProjectMemory', projectPath, content),
  generateMemoryFromGit: (projectPath) =>
    invoke('devorbit:generateMemoryFromGit', projectPath),
  getRealUsage: (force?: boolean) => invoke('devorbit:getRealUsage', force),
  getProjectAudit: (projectPath: string) => invoke('devorbit:getProjectAudit', projectPath),
  getHitlRequests: () => invoke('devorbit:getHitlRequests'),
  approveHitl: (id: string, reason?: string) => reason === undefined
    ? invoke('devorbit:approveHitl', id)
    : invoke('devorbit:approveHitl', id, reason),
  rejectHitl: (id: string, reason?: string) => reason === undefined
    ? invoke('devorbit:rejectHitl', id)
    : invoke('devorbit:rejectHitl', id, reason),
  runDiagnostic: (request: DiagnosticProcessRequest): Promise<DiagnosticProcessResult> =>
    invoke('devorbit:runDiagnostic', request),
  getTelemetrySpans: (limit?: number): Promise<TelemetrySpanView[]> =>
    limit === undefined ? invoke('devorbit:getTelemetrySpans') : invoke('devorbit:getTelemetrySpans', limit),
  getHybridMemory: (projectPath: string, kind?: HybridMemoryKind): Promise<HybridMemoryView[]> =>
    kind === undefined ? invoke('devorbit:getHybridMemory', projectPath) : invoke('devorbit:getHybridMemory', projectPath, kind),
  rememberHybridMemory: (projectPath: string, input: HybridMemoryWrite): Promise<HybridMemoryView> =>
    invoke('devorbit:rememberHybridMemory', projectPath, input),
  searchHybridMemory: (projectPath: string, query: string, limit?: number) =>
    limit === undefined ? invoke('devorbit:searchHybridMemory', projectPath, query) : invoke('devorbit:searchHybridMemory', projectPath, query, limit),
  completeLlm: (request: LlmCompletionRequestView): Promise<LlmRouteView> => invoke('devorbit:completeLlm', request),
  getEvolutionHistory: (limit?: number): Promise<EvolutionRecord[]> =>
    limit === undefined ? invoke('devorbit:getEvolutionHistory') : invoke('devorbit:getEvolutionHistory', limit),
  searchProjectText: (request: TextSearchRequest): Promise<TextSearchResult> => invoke('devorbit:searchProjectText', request),
  getOrchestrationState: (projectPath: string): Promise<OrchestrationState | null> => invoke('devorbit:getOrchestrationState', projectPath),
  setOrchestrationContinuity: (projectPath: string, enabled: boolean): Promise<OrchestrationState | null> => invoke('devorbit:setOrchestrationContinuity', projectPath, enabled),
  upsertOrchestrationSeat: (projectPath: string, input): Promise<OrchestrationState | null> => invoke('devorbit:upsertOrchestrationSeat', projectPath, input),
  removeOrchestrationSeat: (projectPath: string, seatId: string): Promise<OrchestrationState | null> => invoke('devorbit:removeOrchestrationSeat', projectPath, seatId),
  assignOrchestrationRole: (projectPath: string, role, seatId?): Promise<OrchestrationState | null> => seatId === undefined
    ? invoke('devorbit:assignOrchestrationRole', projectPath, role)
    : invoke('devorbit:assignOrchestrationRole', projectPath, role, seatId),
  reportOrchestrationTurn: (projectPath: string, input): Promise<OrchestrationState | null> => invoke('devorbit:reportOrchestrationTurn', projectPath, input),
  reportOrchestrationQuota: (projectPath: string, seatId: string, percent?: number): Promise<OrchestrationState | null> => percent === undefined
    ? invoke('devorbit:reportOrchestrationQuota', projectPath, seatId)
    : invoke('devorbit:reportOrchestrationQuota', projectPath, seatId, percent),
  onOrchestrationEvent: (callback: (event: ContinuityEvent) => void): (() => void) => {
    return subscribe<ContinuityEvent>('devorbit:orchestrationEvent', callback)
  },
}

contextBridge.exposeInMainWorld('devorbit', api)
