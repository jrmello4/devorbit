/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
'use strict'

const { contextBridge } = require('electron')

// This preload intentionally contains no filesystem, process-launching, auth,
// or Git implementation. It gives the renderer a deterministic local fixture
// API so this check can exercise the UI in isolation from user state.
const baseTime = Date.UTC(2026, 8, 11, 12, 0, 0)
const calls = []

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
    git: copy(fixture.git),
  }
})

let config = {
  projectDirs: ['C:\\DevOrbit Fixture Workspace\\teams'],
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
  },
  account2: {
    connected: false,
    label: 'Codex Secondary Desktop Fixture',
    path: 'C:\\Fixture\\Codex\\account2',
  },
}

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
  pushGit: async (projectPath, commitMessage) => {
    record('pushGit', projectPath, commitMessage)
    return syncResult('Fixture push')
  },
  getGitChanges: async (projectPath) => {
    record('getGitChanges', projectPath)
    return ['src/fixture.ts', 'README.md']
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
  launchTool: async (tool, projectPath, options) => {
    record('launchTool', tool, projectPath, options)
    return { success: true, message: `Fixture launch: ${tool}` }
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
    return { supported: false, status: 'unavailable' }
  },
  downloadUpdate: async () => {
    record('downloadUpdate')
    return { supported: false, status: 'unavailable' }
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
})
