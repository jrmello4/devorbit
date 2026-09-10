import electron from 'electron'
const { contextBridge, ipcRenderer } = electron
import type { DevOrbitAPI, AppConfig, SyncResult } from '../renderer/src/types'

const api: DevOrbitAPI = {
  getProjects: () => ipcRenderer.invoke('devorbit:getProjects'),
  refreshProjects: () => ipcRenderer.invoke('devorbit:refreshProjects'),
  syncGit: (projectPath: string) => ipcRenderer.invoke('devorbit:syncGit', projectPath),
  syncAllGit: () => ipcRenderer.invoke('devorbit:syncAllGit'),
  launchTool: (tool, projectPath, options) =>
    ipcRenderer.invoke('devorbit:launchTool', tool, projectPath, options),
  copyProjectContext: (projectPath) =>
    ipcRenderer.invoke('devorbit:copyProjectContext', projectPath),
  getConfig: () => ipcRenderer.invoke('devorbit:getConfig'),
  saveConfig: (config: Partial<AppConfig>) => ipcRenderer.invoke('devorbit:saveConfig', config),
  selectDirectory: () => ipcRenderer.invoke('devorbit:selectDirectory'),
  windowControl: (action: 'minimize' | 'maximize' | 'close') =>
    ipcRenderer.send('devorbit:windowControl', action),
}

contextBridge.exposeInMainWorld('devorbit', api)
