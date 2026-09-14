import electron from 'electron'
const { contextBridge, ipcRenderer } = electron
import type { DevOrbitAPI, AppConfig, SyncResult } from '../renderer/src/types'

const api: DevOrbitAPI = {
  getProjects: () => ipcRenderer.invoke('devorbit:getProjects'),
  refreshProjects: () => ipcRenderer.invoke('devorbit:refreshProjects'),
  getOtherDirs: () => ipcRenderer.invoke('devorbit:getOtherDirs'),
  listProjectFiles: (projectPath: string) => ipcRenderer.invoke('devorbit:listProjectFiles', projectPath),
  readProjectFile: (projectPath: string, relativePath: string) => ipcRenderer.invoke('devorbit:readProjectFile', projectPath, relativePath),
  saveProjectFile: (projectPath: string, relativePath: string, content: string) => ipcRenderer.invoke('devorbit:saveProjectFile', projectPath, relativePath, content),
  syncGit: (projectPath: string) => ipcRenderer.invoke('devorbit:syncGit', projectPath),
  getGitBranches: (projectPath: string, refreshRemote?: boolean) =>
    ipcRenderer.invoke('devorbit:getGitBranches', projectPath, refreshRemote),
  switchGitBranch: (projectPath: string, branch: string) =>
    ipcRenderer.invoke('devorbit:switchGitBranch', projectPath, branch),
  stashSyncGit: (projectPath: string) =>
    ipcRenderer.invoke('devorbit:stashSyncGit', projectPath),
  stashSwitchGitBranch: (projectPath: string, branch: string) =>
    ipcRenderer.invoke('devorbit:stashSwitchGitBranch', projectPath, branch),
  pushGit: (projectPath: string, commitMessage?: string) =>
    ipcRenderer.invoke('devorbit:pushGit', projectPath, commitMessage),
  getGitChanges: (projectPath: string) =>
    ipcRenderer.invoke('devorbit:getGitChanges', projectPath),
  syncAllGit: () => ipcRenderer.invoke('devorbit:syncAllGit'),
  onSyncProgress: (callback) => {
    const handler = (_event: any, progress: any) => callback(progress)
    ipcRenderer.on('devorbit:syncProgress', handler)
    return () => ipcRenderer.removeListener('devorbit:syncProgress', handler)
  },
  getGitInitPreview: (projectPath: string, branch?: string) =>
    ipcRenderer.invoke('devorbit:getGitInitPreview', projectPath, branch),
  initGitRepository: (projectPath, options) =>
    ipcRenderer.invoke('devorbit:initGitRepository', projectPath, options),
  cloneGitRepository: (input) =>
    ipcRenderer.invoke('devorbit:cloneGitRepository', input),
  restoreManagedProject: (projectPath: string) =>
    ipcRenderer.invoke('devorbit:restoreManagedProject', projectPath),
  finalizeManagedProject: (projectPath: string, options?: { allowRecreatableIgnored?: boolean }) =>
    ipcRenderer.invoke('devorbit:finalizeManagedProject', projectPath, options),
  startTerminal: (id: string, projectPath: string) =>
    ipcRenderer.invoke('devorbit:startTerminal', id, projectPath),
  writeTerminal: (id: string, input: string) =>
    ipcRenderer.invoke('devorbit:writeTerminal', id, input),
  stopTerminal: (id: string) =>
    ipcRenderer.invoke('devorbit:stopTerminal', id),
  onTerminalEvent: (callback) => {
    const handler = (_event: any, terminalEvent: any) => callback(terminalEvent)
    ipcRenderer.on('devorbit:terminalEvent', handler)
    return () => ipcRenderer.removeListener('devorbit:terminalEvent', handler)
  },
  navigateWeb: (url: string) =>
    ipcRenderer.invoke('devorbit:navigateWeb', url),
  getWebState: () =>
    ipcRenderer.invoke('devorbit:getWebState'),
  setWebVisible: (visible: boolean) =>
    ipcRenderer.invoke('devorbit:setWebVisible', visible),
  disposeWebPanel: () => ipcRenderer.invoke('devorbit:disposeWebPanel'),
  setWebBounds: (bounds) =>
    ipcRenderer.invoke('devorbit:setWebBounds', bounds),
  onWebEvent: (callback) => {
    const handler = (_event: any, webEvent: any) => callback(webEvent)
    ipcRenderer.on('devorbit:webEvent', handler)
    return () => ipcRenderer.removeListener('devorbit:webEvent', handler)
  },
  launchTool: (tool, projectPath, options) =>
    ipcRenderer.invoke('devorbit:launchTool', tool, projectPath, options),
  copyProjectContext: (projectPath) =>
    ipcRenderer.invoke('devorbit:copyProjectContext', projectPath),
  getConfig: () => ipcRenderer.invoke('devorbit:getConfig'),
  getUpdateState: () => ipcRenderer.invoke('devorbit:getUpdateState'),
  downloadUpdate: () => ipcRenderer.invoke('devorbit:downloadUpdate'),
  installUpdate: () => ipcRenderer.invoke('devorbit:installUpdate'),
  onUpdateStatus: (callback) => {
    const handler = (_event: any, state: any) => callback(state)
    ipcRenderer.on('devorbit:updateStatus', handler)
    return () => ipcRenderer.removeListener('devorbit:updateStatus', handler)
  },
  saveConfig: (config: Partial<AppConfig>) => ipcRenderer.invoke('devorbit:saveConfig', config),
  exportConfig: () => ipcRenderer.invoke('devorbit:exportConfig'),
  importConfig: () => ipcRenderer.invoke('devorbit:importConfig'),
  selectDirectory: () => ipcRenderer.invoke('devorbit:selectDirectory'),
  testToolPath: (toolPath: string) => ipcRenderer.invoke('devorbit:testToolPath', toolPath),
  getToolHealth: () => ipcRenderer.invoke('devorbit:getToolHealth'),
  windowControl: (action: 'minimize' | 'maximize' | 'close') =>
    ipcRenderer.send('devorbit:windowControl', action),
  getCodexAuthStatus: () => ipcRenderer.invoke('devorbit:getCodexAuthStatus'),
  startCodexLogin: (account) => ipcRenderer.invoke('devorbit:startCodexLogin', account),
  cancelCodexLogin: () => ipcRenderer.invoke('devorbit:cancelCodexLogin'),
  onCodexAuthProgress: (callback) => {
    const handler = (_event: any, progress: any) => callback(progress)
    ipcRenderer.on('devorbit:codexAuthProgress', handler)
    return () => {
      ipcRenderer.removeListener('devorbit:codexAuthProgress', handler)
    }
  },
  getProjectMemory: (projectPath) =>
    ipcRenderer.invoke('devorbit:getProjectMemory', projectPath),
  saveProjectMemory: (projectPath, content) =>
    ipcRenderer.invoke('devorbit:saveProjectMemory', projectPath, content),
  generateMemoryFromGit: (projectPath) =>
    ipcRenderer.invoke('devorbit:generateMemoryFromGit', projectPath),
  getUsageState: () => ipcRenderer.invoke('devorbit:getUsageState'),
  getRealUsage: (force?: boolean) => ipcRenderer.invoke('devorbit:getRealUsage', force),
  incrementUsage: (target) => ipcRenderer.invoke('devorbit:incrementUsage', target),
  decrementUsage: (target) => ipcRenderer.invoke('devorbit:decrementUsage', target),
  resetUsage: (target) => ipcRenderer.invoke('devorbit:resetUsage', target),
  updateUsageLimits: (account, limit, windowHours) =>
    ipcRenderer.invoke('devorbit:updateUsageLimits', account, limit, windowHours),
}

contextBridge.exposeInMainWorld('devorbit', api)
