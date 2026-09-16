/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
'use strict'

const { contextBridge } = require('electron')

// This preload intentionally contains no filesystem, process-launching, auth,
// or Git implementation. It gives the renderer a deterministic local fixture
// API so this check can exercise the UI in isolation from user state.
const baseTime = Date.UTC(2026, 8, 11, 12, 0, 0)
const calls = []
const webListeners = new Set()
const terminalListeners = new Set()

const record = (name, ...args) => {
  calls.push({ name, args })
}

const copy = (value) => JSON.parse(JSON.stringify(value))

const technologies = [
  { id: 'react', label: 'React', color: '#61dafb' },
  { id: 'typescript', label: 'TypeScript', color: '#3178c6' },
  { id: 'rust', label: 'Rust', color: '#ce422b' },
  { id: 'node', label: 'Node.js', color: '#68a063' },
]

const statusFixtures = [
  {
    suffix: 'Clean main',
    git: {
      isRepo: true,
      branch: 'main',
      ahead: 0,
      behind: 0,
      hasChanges: false,
      modifiedCount: 0,
      untrackedCount: 0,
      statusMessage: 'Working tree limpo',
    },
  },
  {
    suffix: 'Pull pending develop',
    git: {
      isRepo: true,
      branch: 'develop',
      ahead: 0,
      behind: 3,
      hasChanges: false,
      modifiedCount: 0,
      untrackedCount: 0,
      statusMessage: '3 commits para receber',
    },
  },
  {
    suffix: 'Local changes feature ui',
    git: {
      isRepo: true,
      branch: 'feature/ui-polish',
      ahead: 0,
      behind: 0,
      hasChanges: true,
      modifiedCount: 4,
      untrackedCount: 1,
      statusMessage: 'Alterações locais',
    },
  },
  {
    suffix: 'Ahead push release',
    git: {
      isRepo: true,
      branch: 'release/candidate',
      ahead: 2,
      behind: 0,
      hasChanges: false,
      modifiedCount: 0,
      untrackedCount: 0,
      statusMessage: '2 commits para enviar',
    },
  },
  {
    suffix: 'No Git folder',
    git: {
      isRepo: false,
      branch: '',
      ahead: 0,
      behind: 0,
      hasChanges: false,
      modifiedCount: 0,
      untrackedCount: 0,
      statusMessage: 'Sem repositório',
    },
  },
]

const projects = Array.from({ length: 36 }, (_, index) => {
  const fixture = statusFixtures[index % statusFixtures.length]
  const number = String(index + 1).padStart(2, '0')
  const longTail = index === 35
    ? ' — Extremely Long Project Name For Desktop Truncation And Layout Verification'
    : ''
  return {
    id: `fixture-${number}`,
    name: `Fixture ${number} · ${fixture.suffix}${longTail}`,
    path: `C:\\DevOrbit Fixture Workspace\\teams\\long-team-name-${number}\\fixture-${number}`,
    parentDir: `team-${number}-workspace`,
    lastModified: baseTime - index * 86_400_000,
    techs: [technologies[index % technologies.length], technologies[(index + 1) % technologies.length]],
    packageManager: index % 2 === 0 ? 'pnpm' : 'npm',
    scripts: ['dev', 'build', 'test'],
    git: copy(fixture.git),
  }
})

let config = {
  projectDirs: ['C:\\DevOrbit Fixture Workspace\\teams'],
  projectAccounts: {},
  activeChatGptAccount: 'account1',
  chatGptAccount1Name: 'Codex Primary Desktop Fixture',
  chatGptAccount2Name: 'Codex Secondary Desktop Fixture',
  customPaths: {
    brave: 'C:\\Fixture\\Brave\\brave.exe',
    chrome: 'C:\\Fixture\\Chrome\\chrome.exe',
    mimo: 'C:\\Fixture\\MiMo\\mimo.exe',
    agy: 'C:\\Fixture\\Antigravity\\agy.exe',
    codex: 'C:\\Fixture\\Codex\\codex.exe',
    vscode: 'C:\\Fixture\\VSCode\\code.exe',
    wt: 'C:\\Fixture\\Terminal\\wt.exe',
  },
}

let writeTerminalFailure = false

let usage = {
  account1: {
    used: 32,
    limit: 40,
    windowStart: baseTime - 45 * 60_000,
    windowDurationHours: 3,
  },
  account2: {
    used: 14,
    limit: 40,
    windowStart: baseTime - 30 * 60_000,
    windowDurationHours: 3,
  },
  antigravity: { sessionCount: 2 },
}

const realUsage = {
  source: 'codex-oauth',
  fetchedAt: new Date(baseTime).toISOString(),
  accounts: {
    account1: {
      account: 'account1',
      status: 'ready',
      plan: 'Plus',
      metrics: [
        { id: 'five-hour', label: 'Janela de 5 horas', percent: 64, resetAt: baseTime + 90 * 60_000 },
        { id: 'weekly', label: 'Limite semanal', percent: 42, resetAt: baseTime + 2 * 86_400_000 },
      ],
      fetchedAt: new Date(baseTime).toISOString(),
    },
    account2: {
      account: 'account2',
      status: 'not_configured',
      metrics: [],
      message: 'Fixture: esta conta exige login inicial.',
      fetchedAt: new Date(baseTime).toISOString(),
    },
  },
}

const authStatus = {
  account1: {
    connected: true,
    label: 'Codex Primary Desktop Fixture',
    path: 'C:\\Fixture\\Codex\\account1',
    browserOk: true,
    browserPath: 'C:\\Fixture\\Chrome\\chrome.exe',
  },
  account2: {
    connected: false,
    label: 'Codex Secondary Desktop Fixture',
    path: 'C:\\Fixture\\Codex\\account2',
    browserOk: false,
    browserPath: 'C:\\Fixture\\Brave\\missing.exe',
  },
}

const otherDirs = [
  { name: 'stray-notes', path: 'C:\\DevOrbit Fixture Workspace\\teams\\stray-notes', parentDir: 'teams' },
  { name: 'empty-draft', path: 'C:\\DevOrbit Fixture Workspace\\teams\\empty-draft', parentDir: 'teams' },
]

const syncResult = (message = 'Fixture operation completed') => ({
  success: true,
  message,
  output: 'verify-ui fixture',
})

const api = {
  getProjects: async () => {
    record('getProjects')
    return copy(projects)
  },
  refreshProjects: async () => {
    record('refreshProjects')
    return copy(projects)
  },
  syncGit: async (projectPath) => {
    record('syncGit', projectPath)
    return syncResult('Fixture sync')
  },
  stashSyncGit: async (projectPath) => {
    record('stashSyncGit', projectPath)
    return syncResult('Fixture stash sync')
  },
  stashSwitchGitBranch: async (projectPath, branch) => {
    record('stashSwitchGitBranch', projectPath, branch)
    return syncResult('Fixture stash switch')
  },
  cloneGitRepository: async (input) => {
    record('cloneGitRepository', input)
    return { ...syncResult('Fixture clone'), path: `C:\\DevOrbit Fixture Workspace\\teams\\${input?.folderName || 'cloned'}` }
  },
  getOtherDirs: async () => {
    record('getOtherDirs')
    return copy(otherDirs)
  },
  onSyncProgress: () => () => {},
  getGitBranches: async (projectPath) => {
    record('getGitBranches', projectPath)
    return [
      { name: 'main', isCurrent: true, isRemote: false, commit: 'fixture-a1b2c3d' },
      { name: 'develop', isCurrent: false, isRemote: false, commit: 'fixture-d4e5f6a' },
      { name: 'origin/main', isCurrent: false, isRemote: true, upstream: 'origin/main' },
    ]
  },
  switchGitBranch: async (projectPath, branch) => {
    record('switchGitBranch', projectPath, branch)
    return syncResult('Fixture branch switch')
  },
  pushGit: async (projectPath, commitMessage, options) => {
    record('pushGit', projectPath, commitMessage, options)
    return syncResult('Fixture push')
  },
  getGitChanges: async (projectPath) => {
    record('getGitChanges', projectPath)
    return [
      { path: 'src/fixture.ts', status: ' M' },
      { path: 'README.md', status: '??' },
    ]
  },
  syncAllGit: async () => {
    record('syncAllGit')
    return Object.fromEntries(projects.filter((project) => project.git.isRepo).map((project) => [project.path, syncResult('Fixture sync all')]))
  },
  getGitInitPreview: async (projectPath, branch = 'main') => {
    record('getGitInitPreview', projectPath, branch)
    return {
      path: projectPath,
      canInitialize: true,
      isRepository: false,
      branch,
      fileCount: 2,
      files: ['README.md', 'package.json'],
      truncated: false,
      fingerprint: 'fixture-fingerprint',
      message: 'Fixture preview',
    }
  },
  initGitRepository: async (projectPath, options) => {
    record('initGitRepository', projectPath, options)
    return {
      success: true,
      initialized: true,
      commitCreated: Boolean(options?.initialCommit),
      pushed: Boolean(options?.push),
      branch: options?.branch || 'main',
      preview: await api.getGitInitPreview(projectPath, options?.branch || 'main'),
      message: 'Fixture init',
    }
  },
  listProjectFiles: async (projectPath, relativeDirectory) => {
    record('listProjectFiles', projectPath, relativeDirectory)
    const entries = relativeDirectory === 'src'
      ? [{ path: 'src\\fixture.ts', name: 'fixture.ts', kind: 'file', size: 28, editable: true }]
      : [
        { path: 'src', name: 'src', kind: 'directory' },
        { path: 'README.md', name: 'README.md', kind: 'file', size: 18, editable: true },
      ]
    return { entries, truncated: false }
  },
  readProjectFile: async (projectPath, relativePath) => {
    record('readProjectFile', projectPath, relativePath)
    return { path: relativePath, content: relativePath === 'README.md' ? '# Fixture workspace\\n' : 'export const fixture = true\\n', size: 24 }
  },
  saveProjectFile: async (projectPath, relativePath, content) => {
    record('saveProjectFile', projectPath, relativePath, content)
    return { path: relativePath, content, size: content.length }
  },
  createProjectFile: async (projectPath, relativePath) => {
    record('createProjectFile', projectPath, relativePath)
    return { path: relativePath, content: '', size: 0 }
  },
  createProjectDirectory: async (projectPath, relativePath) => {
    record('createProjectDirectory', projectPath, relativePath)
    return { path: relativePath, name: relativePath.split(/[\\/]/).pop(), kind: 'directory' }
  },
  moveProjectEntry: async (projectPath, sourcePath, destinationPath) => {
    record('moveProjectEntry', projectPath, sourcePath, destinationPath)
    return { from: sourcePath, path: destinationPath }
  },
  deleteProjectEntry: async (projectPath, relativePath, options) => {
    record('deleteProjectEntry', projectPath, relativePath, options)
    return { path: relativePath }
  },
  startTerminal: async (id, projectPath) => {
    record('startTerminal', id, projectPath)
    return { id, pid: 1234 }
  },
  startCodexTerminal: async (id, projectPath, account, cols, rows) => {
    record('startCodexTerminal', id, projectPath, account, cols, rows)
    return { success: true, id, pid: 1235, account, message: 'Fixture Codex connected' }
  },
  startAgentTerminal: async (id, projectPath, provider, cols, rows) => {
    record('startAgentTerminal', id, projectPath, provider, cols, rows)
    return { success: true, id, pid: 1236, provider, message: 'Fixture local agent connected' }
  },
  resizeTerminal: async (id, cols, rows) => {
    record('resizeTerminal', id, cols, rows)
    return { success: true }
  },
  writeTerminal: async (id, input) => {
    record('writeTerminal', id, input)
    return { success: !writeTerminalFailure }
  },
  stopTerminal: async (id) => {
    record('stopTerminal', id)
    return { success: true }
  },
  onTerminalEvent: (callback) => {
    terminalListeners.add(callback)
    return () => terminalListeners.delete(callback)
  },
  navigateWeb: async (url) => {
    record('navigateWeb', url)
    for (const listener of webListeners) listener({ type: 'navigated', url, title: url })
    return { success: true, url }
  },
  getWebState: async () => ({
    type: 'navigated',
    url: 'https://www.google.com/',
    title: 'Google',
  }),
  goBackWeb: async () => ({ success: true }),
  goForwardWeb: async () => ({ success: true }),
  reloadWeb: async () => ({ success: true }),
  setWebVisible: async (visible) => {
    record('setWebVisible', visible)
    return { success: true }
  },
  setWebBounds: async (bounds) => {
    record('setWebBounds', bounds)
    return { success: true }
  },
  onWebEvent: (callback) => {
    webListeners.add(callback)
    return () => webListeners.delete(callback)
  },
  launchTool: async (tool, projectPath, options) => {
    record('launchTool', tool, projectPath, options)
    return { success: true, message: `Fixture launch: ${tool}` }
  },
  getToolHealth: async () => {
    record('getToolHealth')
    return [
      { id: 'terminal', label: 'Terminal', state: 'ready', path: 'C:\\Fixture\\Terminal\\wt.exe', message: 'Windows Terminal pronto.' },
      { id: 'vscode', label: 'VS Code', state: 'ready', path: 'C:\\Fixture\\VSCode\\code.exe', message: 'Editor pronto.' },
      { id: 'codex', label: 'Codex CLI', state: 'ready', path: 'C:\\Fixture\\Codex\\codex.exe', message: 'CLI pronto.' },
      { id: 'opencode', label: 'OpenCode', state: 'ready', path: 'C:\\Fixture\\OpenCode\\opencode.cmd', message: 'CLI pronto.' },
      { id: 'claude', label: 'Claude Code', state: 'ready', path: 'C:\\Fixture\\Claude\\claude.cmd', message: 'CLI pronto.' },
      { id: 'gemini', label: 'Gemini CLI', state: 'missing', message: 'Gemini CLI não foi encontrado.' },
      { id: 'aider', label: 'Aider', state: 'missing', message: 'Aider não foi encontrado.' },
      { id: 'agy', label: 'Antigravity', state: 'missing', message: 'Antigravity não foi encontrado.' },
      { id: 'brave', label: 'Brave', state: 'ready', path: 'C:\\Fixture\\Brave\\brave.exe', message: 'Navegador pronto.' },
      { id: 'chrome', label: 'Chrome', state: 'ready', path: 'C:\\Fixture\\Chrome\\chrome.exe', message: 'Navegador pronto.' },
      { id: 'mimo', label: 'MiMo AI', state: 'fallback', path: 'C:\\Fixture\\MiMo\\mimo.exe', message: 'Alternativa disponível.' },
      { id: 'custom', label: 'Outro CLI', state: 'missing', message: 'Configure um caminho para o agente personalizado.' },
    ]
  },
  copyProjectContext: async (projectPath) => {
    record('copyProjectContext', projectPath)
    return { success: true, context: 'Fixture project context' }
  },
  getConfig: async () => {
    record('getConfig')
    return copy(config)
  },
  getUpdateState: async () => {
    record('getUpdateState')
    return { supported: false, status: 'unavailable', distribution: 'dev' }
  },
  downloadUpdate: async () => {
    record('downloadUpdate')
    return { supported: false, status: 'unavailable', distribution: 'dev' }
  },
  installUpdate: async () => {
    record('installUpdate')
    return { success: false }
  },
  onUpdateStatus: () => () => {},
  saveConfig: async (updates) => {
    record('saveConfig', updates)
    config = { ...config, ...copy(updates) }
    return copy(config)
  },
  selectDirectory: async () => {
    record('selectDirectory')
    return null
  },
  testToolPath: async (toolPath) => {
    record('testToolPath', toolPath)
    return { path: toolPath, ok: true, message: 'Fixture tool found' }
  },
  exportConfig: async () => {
    record('exportConfig')
    return { success: true, message: 'Fixture export' }
  },
  importConfig: async () => {
    record('importConfig')
    return { success: true, message: 'Fixture import' }
  },
  windowControl: (action) => {
    record('windowControl', action)
  },
  getCodexAuthStatus: async () => {
    record('getCodexAuthStatus')
    return copy(authStatus)
  },
  startCodexLogin: async (account) => {
    record('startCodexLogin', account)
    return { success: true }
  },
  cancelCodexLogin: async () => {
    record('cancelCodexLogin')
    return { success: true }
  },
  onCodexAuthProgress: () => () => {},
  getProjectMemory: async (projectPath) => {
    record('getProjectMemory', projectPath)
    return { content: 'Fixture memory', lastUpdated: new Date(baseTime).toISOString(), exists: true, path: `${projectPath}\\.devorbit\\MEMORY.md`, stale: false }
  },
  saveProjectMemory: async (projectPath, content) => {
    record('saveProjectMemory', projectPath, content)
    return { success: true, message: 'Fixture memory saved' }
  },
  generateMemoryFromGit: async (projectPath) => {
    record('generateMemoryFromGit', projectPath)
    return 'Fixture generated memory'
  },
  getUsageState: async () => {
    record('getUsageState')
    return copy(usage)
  },
  getRealUsage: async () => {
    record('getRealUsage')
    return copy(realUsage)
  },
  incrementUsage: async (target) => {
    record('incrementUsage', target)
    if (target === 'antigravity') usage.antigravity.sessionCount += 1
    else usage[target].used += 1
    return copy(usage)
  },
  decrementUsage: async (target) => {
    record('decrementUsage', target)
    usage[target].used = Math.max(0, usage[target].used - 1)
    return copy(usage)
  },
  resetUsage: async (target) => {
    record('resetUsage', target)
    usage[target].used = 0
    usage[target].windowStart = undefined
    return copy(usage)
  },
  updateUsageLimits: async (account, limit, windowHours) => {
    record('updateUsageLimits', account, limit, windowHours)
    usage[account].limit = limit
    if (windowHours !== undefined) usage[account].windowDurationHours = windowHours
    return copy(usage)
  },
}

contextBridge.exposeInMainWorld('devorbit', api)
contextBridge.exposeInMainWorld('__devorbitVerifyFixture', {
  getCalls: () => copy(calls),
  resetCalls: () => {
    calls.length = 0
  },
  emitTerminalEvent: (event) => {
    for (const listener of terminalListeners) listener(copy(event))
  },
  setWriteTerminalFailure: (value) => {
    writeTerminalFailure = Boolean(value)
  },
})
