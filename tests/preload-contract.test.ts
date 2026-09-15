import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const contextBridgeExpose = vi.hoisted(() => vi.fn())
const ipcInvoke = vi.hoisted(() => vi.fn(async () => undefined))
const ipcSend = vi.hoisted(() => vi.fn())
const ipcOn = vi.hoisted(() => vi.fn())
const ipcRemoveListener = vi.hoisted(() => vi.fn())

vi.mock('electron', () => {
  const electron = {
    contextBridge: { exposeInMainWorld: contextBridgeExpose },
    ipcRenderer: {
      invoke: ipcInvoke,
      send: ipcSend,
      on: ipcOn,
      removeListener: ipcRemoveListener,
    },
  }
  return { default: electron, ...electron }
})

const expectedApiKeys = [
  'getProjects',
  'refreshProjects',
  'getOtherDirs',
  'listProjectFiles',
  'readProjectFile',
  'saveProjectFile',
  'createProjectFile',
  'createProjectDirectory',
  'moveProjectEntry',
  'deleteProjectEntry',
  'syncGit',
  'getGitBranches',
  'switchGitBranch',
  'stashSyncGit',
  'stashSwitchGitBranch',
  'pushGit',
  'getGitChanges',
  'syncAllGit',
  'onSyncProgress',
  'getGitInitPreview',
  'initGitRepository',
  'cloneGitRepository',
  'restoreManagedProject',
  'finalizeManagedProject',
  'startTerminal',
  'startCodexTerminal',
  'resizeTerminal',
  'writeTerminal',
  'stopTerminal',
  'onTerminalEvent',
  'navigateWeb',
  'getWebState',
  'goBackWeb',
  'goForwardWeb',
  'reloadWeb',
  'setWebVisible',
  'disposeWebPanel',
  'setWebBounds',
  'onWebEvent',
  'launchTool',
  'copyProjectContext',
  'getConfig',
  'getUpdateState',
  'downloadUpdate',
  'installUpdate',
  'onUpdateStatus',
  'saveConfig',
  'exportConfig',
  'importConfig',
  'selectDirectory',
  'testToolPath',
  'getToolHealth',
  'windowControl',
  'getCodexAuthStatus',
  'startCodexLogin',
  'cancelCodexLogin',
  'onCodexAuthProgress',
  'getProjectMemory',
  'saveProjectMemory',
  'generateMemoryFromGit',
  'getUsageState',
  'getRealUsage',
  'incrementUsage',
  'decrementUsage',
  'resetUsage',
  'updateUsageLimits',
]

let exposedApiObject: Record<string, (...args: any[]) => unknown>
const exposedApi = () => exposedApiObject

describe('preload IPC contract', () => {
  beforeAll(async () => {
    await import('../src/preload/index')
    exposedApiObject = contextBridgeExpose.mock.calls[0][1] as Record<string, (...args: any[]) => unknown>
  })

  beforeEach(() => {
    ipcInvoke.mockClear()
    ipcSend.mockClear()
    ipcOn.mockClear()
    ipcRemoveListener.mockClear()
  })

  it('exposes exactly the renderer API surface', () => {
    expect(Object.keys(exposedApi())).toEqual(expectedApiKeys)
  })

  it('forwards invoke channels and arguments without reshaping them', async () => {
    const api = exposedApi()
    const calls: Array<[string, ...unknown[]]> = [
      ['devorbit:getProjects'],
      ['devorbit:refreshProjects'],
      ['devorbit:getOtherDirs'],
      ['devorbit:listProjectFiles', 'project'],
      ['devorbit:readProjectFile', 'project', 'README.md'],
      ['devorbit:saveProjectFile', 'project', 'README.md', 'content'],
      ['devorbit:createProjectFile', 'project', 'notes.md'],
      ['devorbit:createProjectDirectory', 'project', 'notes'],
      ['devorbit:moveProjectEntry', 'project', 'notes.md', 'notes/todo.md'],
      ['devorbit:deleteProjectEntry', 'project', 'notes', { recursive: true }],
      ['devorbit:syncGit', 'project'],
      ['devorbit:getGitBranches', 'project', true],
      ['devorbit:switchGitBranch', 'project', 'feature/test'],
      ['devorbit:stashSyncGit', 'project'],
      ['devorbit:stashSwitchGitBranch', 'project', 'main'],
      ['devorbit:pushGit', 'project', 'commit'],
      ['devorbit:getGitChanges', 'project'],
      ['devorbit:syncAllGit'],
      ['devorbit:getGitInitPreview', 'project', 'main'],
      ['devorbit:initGitRepository', 'project', { branch: 'main' }],
      ['devorbit:cloneGitRepository', { parentDir: 'parent', folderName: 'repo', remoteUrl: 'https://example.com/repo.git' }],
      ['devorbit:restoreManagedProject', 'project'],
      ['devorbit:finalizeManagedProject', 'project', { allowRecreatableIgnored: true }],
      ['devorbit:startTerminal', 'terminal-1', 'project'],
      ['devorbit:startCodexTerminal', 'terminal-1', 'project', 'account1', 120, 40],
      ['devorbit:resizeTerminal', 'terminal-1', 120, 40],
      ['devorbit:writeTerminal', 'terminal-1', 'ls\n'],
      ['devorbit:stopTerminal', 'terminal-1'],
      ['devorbit:navigateWeb', 'https://example.com/'],
      ['devorbit:getWebState'],
      ['devorbit:goBackWeb'],
      ['devorbit:goForwardWeb'],
      ['devorbit:reloadWeb'],
      ['devorbit:setWebVisible', true],
      ['devorbit:disposeWebPanel'],
      ['devorbit:setWebBounds', { x: 1, y: 2, width: 3, height: 4 }],
      ['devorbit:launchTool', 'vscode', 'project', { account: 'account1' }],
      ['devorbit:copyProjectContext', 'project'],
      ['devorbit:getConfig'],
      ['devorbit:getUpdateState'],
      ['devorbit:downloadUpdate'],
      ['devorbit:installUpdate'],
      ['devorbit:saveConfig', { projectDirs: ['project'] }],
      ['devorbit:exportConfig'],
      ['devorbit:importConfig'],
      ['devorbit:selectDirectory'],
      ['devorbit:testToolPath', 'tool.exe'],
      ['devorbit:getToolHealth'],
      ['devorbit:getCodexAuthStatus'],
      ['devorbit:startCodexLogin', 'account1'],
      ['devorbit:cancelCodexLogin'],
      ['devorbit:getProjectMemory', 'project'],
      ['devorbit:saveProjectMemory', 'project', 'memory'],
      ['devorbit:generateMemoryFromGit', 'project'],
      ['devorbit:getUsageState'],
      ['devorbit:getRealUsage', true],
      ['devorbit:incrementUsage', 'account1'],
      ['devorbit:decrementUsage', 'account1'],
      ['devorbit:resetUsage', 'account1'],
      ['devorbit:updateUsageLimits', 'account1', 100, 24],
    ]

    const methodNames = [
      'getProjects', 'refreshProjects', 'getOtherDirs', 'listProjectFiles', 'readProjectFile',
      'saveProjectFile', 'createProjectFile', 'createProjectDirectory', 'moveProjectEntry',
      'deleteProjectEntry', 'syncGit', 'getGitBranches', 'switchGitBranch', 'stashSyncGit',
      'stashSwitchGitBranch', 'pushGit', 'getGitChanges', 'syncAllGit', 'getGitInitPreview',
      'initGitRepository', 'cloneGitRepository', 'restoreManagedProject', 'finalizeManagedProject',
      'startTerminal', 'startCodexTerminal', 'resizeTerminal', 'writeTerminal', 'stopTerminal',
      'navigateWeb', 'getWebState', 'goBackWeb', 'goForwardWeb', 'reloadWeb', 'setWebVisible',
      'disposeWebPanel', 'setWebBounds', 'launchTool', 'copyProjectContext', 'getConfig',
      'getUpdateState', 'downloadUpdate', 'installUpdate', 'saveConfig', 'exportConfig',
      'importConfig', 'selectDirectory', 'testToolPath', 'getToolHealth', 'getCodexAuthStatus',
      'startCodexLogin', 'cancelCodexLogin', 'getProjectMemory', 'saveProjectMemory',
      'generateMemoryFromGit', 'getUsageState', 'getRealUsage', 'incrementUsage', 'decrementUsage',
      'resetUsage', 'updateUsageLimits',
    ]

    for (const [index, methodName] of methodNames.entries()) await api[methodName](...calls[index].slice(1))

    expect(ipcInvoke.mock.calls).toEqual(calls)
  })

  it('uses send for window controls', () => {
    exposedApi().windowControl('maximize')
    expect(ipcSend).toHaveBeenCalledWith('devorbit:windowControl', 'maximize')
    expect(ipcInvoke).not.toHaveBeenCalled()
  })

  it('forwards the reviewed Git push selection as a separate option', async () => {
    await exposedApi().pushGit('project', 'chore: selected', {
      selectedPaths: ['src/app.ts'],
    })
    expect(ipcInvoke).toHaveBeenCalledWith(
      'devorbit:pushGit',
      'project',
      'chore: selected',
      { selectedPaths: ['src/app.ts'] },
    )
  })

  it.each([
    ['onSyncProgress', 'devorbit:syncProgress', { path: 'project', done: 1, total: 2 }],
    ['onTerminalEvent', 'devorbit:terminalEvent', { type: 'data', id: 'terminal-1' }],
    ['onWebEvent', 'devorbit:webEvent', { type: 'loaded', url: 'https://example.com/' }],
    ['onUpdateStatus', 'devorbit:updateStatus', { status: 'idle' }],
    ['onCodexAuthProgress', 'devorbit:codexAuthProgress', { account: 'account1' }],
  ])('registers and unsubscribes %s', (methodName, channel, payload) => {
    const callback = vi.fn()
    const unsubscribe = exposedApi()[methodName](callback) as () => void
    expect(ipcOn).toHaveBeenCalledOnce()
    const [registeredChannel, handler] = ipcOn.mock.calls[0]
    expect(registeredChannel).toBe(channel)

    handler({}, payload)
    expect(callback).toHaveBeenCalledWith(payload)

    unsubscribe()
    expect(ipcRemoveListener).toHaveBeenCalledWith(channel, handler)
  })
})
