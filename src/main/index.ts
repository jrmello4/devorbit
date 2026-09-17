import electron, { type BrowserWindow as BrowserWindowType } from 'electron'
const { app, BrowserWindow, ipcMain, dialog } = electron
if (process.argv.includes('--disable-gpu')) app.disableHardwareAcceleration()
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { exportConfigJson, importConfigJson, loadConfig, saveConfig } from './config'
import { listAllNonProjectDirs, scanAllProjects } from './scanner'
import { syncGit, getGitBranches, switchGitBranch, pushGit, getGitChanges, cloneGitRepository, stashSyncGit, stashSwitchGitBranch, finalizeGitProject, getGitRemoteUrl, createAgentWorktree, integrateAgentWorktree } from './git'
import { getGitFileDiff, validateGitDiffPathspec } from './git-diff'
import { getGitInitPreview, initGitRepository } from './git-init'
import { ensureAccountDirectories, getAccountLabel, getCodexAccountEnvironment, hasValidCodexAuth, resolveCodexCommand } from './account-profiles'
import { launchTool, copyProjectContext, getToolHealth } from './launcher'
import { executeExplicitAgentTurn, getAgentProviderHealth, orderProvidersForTask, resolveAgentProviderWithFallback, resolveAgentTurn } from './agent-providers'
import { createResultWaiter, sendAgentTurn, spawnAgentProviderTerminal } from './agent-turn'
import { createProjectDirectory, createProjectFile, deleteProjectEntry, listProjectFiles, moveProjectEntry, readProjectFile, saveProjectFile } from './project-files'
import { onTerminalEvent, hasTerminal, resizeTerminal, startTerminal, stopAllTerminals, stopTerminal, writeTerminal, TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS, TERMINAL_MIN_COLS, TERMINAL_MIN_ROWS, type TerminalEvent } from './terminal-session'
import { clearPipe, clearPipesFor, installPtyPipe, setPipe } from './pty-pipe'
import { beginCompanionTerminalStart, handleCompanionTerminalEvent, onCompanionEvent, registerCompanionTerminal, unregisterAllCompanionTerminals, unregisterCompanionTerminal, type CompanionSummary } from './companion'
import { attachWebPanel, disposeWebPanel, getWebState, goBackWeb, goForwardWeb, navigateWeb, onWebPanelEvent, reloadWeb, setWebBounds, setWebVisible } from './web-panel'
import {
  checkCodexAuthStatus,
  startCodexDeviceLogin,
  cancelCodexLogin,
  type CodexAuthProgress,
} from './codex-auth'
import {
  getProjectMemory,
  saveProjectMemory,
  generateMemoryFromGit,
  cancelAllMemoryCompactions,
  cancelMemoryCompaction,
  syncMemorySchedulers,
} from './memory'
import { getRealUsage } from './usage-real'
import { downloadUpdate, getUpdateState, initializeUpdater, installUpdate } from './updater'
import { startShadowRoutingMetrics, stopShadowRoutingMetrics } from './shadow-routing-metrics'
import type {
  AgentProviderId,
  AppConfig,
  IpcInvokeChannel,
  IpcSendChannel,
  ManagedProject,
  SyncResult,
} from '../renderer/src/types'
import {
  assertTrustedIpcSender,
  canonicalizeExistingDirectory,
  isPathWithinRoot,
  validateCodexAccount,
  validateAgentProvider,
  validateConfigUpdates,
  validateFiniteNumber,
  validateLaunchOptions,
  validateLaunchTool,
  validateGitInitOptions,
  validateGitBranch,
  validateCloneInput,
  testToolPath,
  validateProjectDirs,
  validateWindowAction,
  validateGitPushOptions,
  isTrustedRendererUrl,
  type IpcSenderLike,
} from './validation'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '../..')

export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
const PRODUCTION_RENDERER_URL = pathToFileURL(path.join(RENDERER_DIST, 'index.html')).href

process.env.VITE_PUBLIC = process.env.VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

let mainWindow: BrowserWindowType | null = null
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL)
const SMOKE_FLAG = '--devorbit-smoke'

function getCliArgValue(name: string): string | undefined {
  const prefix = `${name}=`
  const match = process.argv.find((arg) => arg.startsWith(prefix))
  return match ? match.slice(prefix.length) : undefined
}

const isSmokeRun = process.argv.includes(SMOKE_FLAG)
let smokeStartupError: string | null = null

if (isSmokeRun) {
  const smokeTemp = getCliArgValue('--devorbit-smoke-temp')
  const smokeUserData = getCliArgValue('--devorbit-smoke-userdata')
  if (
    !smokeTemp ||
    !smokeUserData ||
    !isPathWithinRoot(path.resolve(smokeUserData), path.resolve(smokeTemp))
  ) {
    smokeStartupError = 'userData de smoke fora do diretório temporário esperado'
  } else {
    try {
      app.setPath('userData', smokeUserData)
    } catch (error: any) {
      smokeStartupError = `falha ao definir userData de smoke: ${error?.message || error}`
    }
  }
}

const hasSingleInstanceLock = isSmokeRun ? true : app.requestSingleInstanceLock()
let managedConfigQueue: Promise<void> = Promise.resolve()
let terminalLifecycleGeneration = 0

function invalidateTerminalLifecycle(): void {
  terminalLifecycleGeneration += 1
  stopAllTerminals()
  unregisterAllCompanionTerminals()
}

function assertTerminalLifecycle(generation: number): void {
  if (generation !== terminalLifecycleGeneration) {
    throw new Error('A janela do DevOrbit foi encerrada antes de iniciar o terminal.')
  }
}

function sendTerminalEvent(event: TerminalEvent): void {
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send('devorbit:terminalEvent', event)
}

function sendCompanionEvent(summary: CompanionSummary): void {
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send('devorbit:companionEvent', summary)
}

onTerminalEvent(sendTerminalEvent)
onTerminalEvent(handleCompanionTerminalEvent)
onCompanionEvent(sendCompanionEvent)
installPtyPipe({
  subscribe: onTerminalEvent,
  write: writeTerminal,
  exists: hasTerminal,
})

// Sessões de turno (provedor + modelo efetivos por terminal) para sendAgentTurn.
const turnSessions = new Map<string, { provider: AgentProviderId; model: string }>()
const waitTurnResult = createResultWaiter(onTerminalEvent)
onWebPanelEvent((event) => {
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send('devorbit:webEvent', event)
})


async function validateCloneParent(input: unknown): Promise<string> {
  const candidate = await canonicalizeExistingDirectory(input, 'Pasta de destino')
  const config = await loadConfig()
  const allowed = (await Promise.all(config.projectDirs.map(async (root) => {
    try {
      const canonicalRoot = await canonicalizeExistingDirectory(root, 'Pasta monitorada')
      return isPathWithinRoot(candidate, canonicalRoot)
    } catch { return false }
  }))).some(Boolean)
  if (!allowed) throw new Error('A pasta de destino não pertence a uma pasta monitorada.')
  return candidate
}

async function validateProjectPath(input: unknown): Promise<string> {
  const candidate = await canonicalizeExistingDirectory(input, 'Caminho de projeto')
  const config = await loadConfig()
  const allowed = (await Promise.all(config.projectDirs.map(async (root) => {
    try {
      const canonicalRoot = await canonicalizeExistingDirectory(root, 'Pasta monitorada')
      return isPathWithinRoot(candidate, canonicalRoot)
    } catch { return false }
  }))).some(Boolean)
  if (!allowed) throw new Error('O projeto não pertence a uma pasta monitorada.')
  return candidate
}

function managedProjectPath(project: ManagedProject): string {
  return path.resolve(project.parentPath, project.folderName)
}

async function rememberManagedProject(entry: ManagedProject): Promise<void> {
  const operation = managedConfigQueue.catch(() => undefined).then(async () => {
    const config = await loadConfig()
    const target = managedProjectPath(entry).toLowerCase()
    const managedProjects = [
      ...config.managedProjects.filter((item) => managedProjectPath(item).toLowerCase() !== target),
      entry,
    ]
    await saveConfig({ managedProjects })
  })
  managedConfigQueue = operation.then(() => undefined, () => undefined)
  await operation
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    frame: false, // Frameless para controle visual total estilo Linear/Raycast
    show: true,
    backgroundColor: '#f5f5f2',
    title: 'DevOrbit',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const window = mainWindow
  window.on('close', () => {
    invalidateTerminalLifecycle()
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  mainWindow.show()
  mainWindow.focus()

  // The renderer is always local (file:// in production or the Vite origin in
  // development). Do not allow links or navigations to turn this privileged
  // window into a general-purpose remote page.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, PRODUCTION_RENDERER_URL)) event.preventDefault()
  })
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) invalidateTerminalLifecycle()
  })
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  mainWindow.webContents.on(
    'did-fail-load',
    (_event: any, code: any, desc: any, url: any) => {
      console.error('[Window Load Error]', code, desc, url)
    }
  )

  mainWindow.webContents.on('console-message', (_event: any, level: any, message: any, line: any, sourceId: any) => {
    console.log(`[Renderer Console Level ${level}] ${message} (${sourceId}:${line})`)
  })

  mainWindow.webContents.on('render-process-gone', (_event: any, details: any) => {
    console.error('[Renderer Gone]', details)
    invalidateTerminalLifecycle()
  })

  mainWindow.webContents.on('before-input-event', (_event: any, input: any) => {
    if (isDevelopment && input.key === 'F12') {
      mainWindow?.webContents.toggleDevTools()
    }
  })

  // Gerenciamento de eventos de janela
  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (isDevelopment && devServerUrl && isTrustedRendererUrl(devServerUrl, PRODUCTION_RENDERER_URL)) {
    mainWindow.loadURL(devServerUrl)
  } else {
    mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html')).catch((err: any) => {
      console.error('Failed to load file:', err)
    })
  }
}

async function verifyPackagedRenderer(target: BrowserWindowType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    target.webContents.once('did-finish-load', () => resolve())
    target.webContents.once(
      'did-fail-load',
      (_event: unknown, errorCode: number, description: string, url: string) => {
        reject(new Error(`falha ao carregar ${url}: ${description} (${errorCode})`))
      }
    )
    target.loadFile(path.join(RENDERER_DIST, 'index.html')).catch(reject)
  })

  const deadline = Date.now() + 20_000
  let state: { hasBridge: boolean; hasShell: boolean; hasFallback: boolean } | null = null
  while (Date.now() < deadline) {
    state = await target.webContents.executeJavaScript(
      `(() => ({
        hasBridge: typeof window.devorbit === 'object' && window.devorbit !== null,
        hasShell: Boolean(document.querySelector('.app-shell')),
        hasFallback: Boolean(document.querySelector('.renderer-fallback')),
      }))()`,
      true
    )
    if (state && state.hasBridge && (state.hasShell || state.hasFallback)) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  if (!state || !state.hasBridge) throw new Error('preload não expôs window.devorbit')
  if (!state.hasShell) {
    throw new Error(
      state.hasFallback
        ? 'renderer exibiu o estado de ponte ausente'
        : 'renderer não montou o workspace (.app-shell ausente)'
    )
  }

  const probe = await target.webContents.executeJavaScript(
    `window.devorbit.getConfig()
      .then((config) => ({ ok: true, hasProjectDirs: Array.isArray(config && config.projectDirs) }))
      .catch((error) => ({ ok: false, message: String((error && error.message) || error) }))`,
    true
  )
  if (!probe.ok) throw new Error(`invoke IPC falhou: ${probe.message}`)
  if (!probe.hasProjectDirs) throw new Error('getConfig retornou payload inesperado')
}

async function runPackagedSmokeTest(): Promise<void> {
  const smokeTemp = getCliArgValue('--devorbit-smoke-temp')
  const smokeResult = getCliArgValue('--devorbit-smoke-result')
  const smokeToken = getCliArgValue('--devorbit-smoke-token')
  const expectedVersion = getCliArgValue('--devorbit-smoke-version')
  const canWriteResult = Boolean(
    smokeTemp && smokeResult && isPathWithinRoot(path.resolve(smokeResult), path.resolve(smokeTemp))
  )

  const emit = async (
    success: boolean,
    error?: string,
    evidence?: Record<string, boolean>
  ): Promise<void> => {
    if (canWriteResult && smokeResult) {
      try {
        await fs.writeFile(
          smokeResult,
          JSON.stringify({
            kind: 'devorbit-packaged-smoke',
            success,
            version: app.getVersion(),
            token: smokeToken,
            error,
            ...evidence,
          }),
          'utf8'
        )
      } catch (error: any) {
        console.error('[smoke] falha ao gravar o marcador de resultado:', error?.message || error)
      }
    }
    console.log(`[smoke] ${success ? 'OK' : 'FALHA'}${error ? `: ${error}` : ''}`)
    app.exit(success ? 0 : 1)
  }

  if (smokeStartupError) return emit(false, smokeStartupError)
  if (!app.isPackaged) return emit(false, 'o modo smoke exige um aplicativo empacotado')
  if (!expectedVersion || !smokeToken) return emit(false, 'argumentos de smoke ausentes')
  if (!canWriteResult) {
    return emit(false, 'resultado de smoke fora do diretório temporário esperado')
  }
  if (app.getVersion() !== expectedVersion) {
    return emit(
      false,
      `versão empacotada ${app.getVersion()} diferente da esperada ${expectedVersion}`
    )
  }

  let smokeWindow: BrowserWindowType | null = null
  let timeoutHandle: NodeJS.Timeout | null = null
  try {
    setupIpcHandlers()

    smokeWindow = new BrowserWindow({
      show: false,
      width: 1024,
      height: 700,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })

    const timedOut = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('timeout aguardando o renderer empacotado')),
        30_000
      )
    })

    await Promise.race([timedOut, verifyPackagedRenderer(smokeWindow)])
    return await emit(true, undefined, { renderer: true, preload: true, ipc: true })
  } catch (error: any) {
    return await emit(false, `smoke falhou: ${error?.message || error}`)
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (smokeWindow && !smokeWindow.isDestroyed()) smokeWindow.destroy()
  }
}

if (isSmokeRun || hasSingleInstanceLock) {
  app.whenReady().then(() => {
    startShadowRoutingMetrics(app.getPath('userData'))
  })
}

if (isSmokeRun) {
  app.whenReady().then(() => {
    void runPackagedSmokeTest()
  })
} else if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    setupIpcHandlers()
    createWindow()
    initializeUpdater((state) => {
      const window = mainWindow
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
      window.webContents.send('devorbit:updateStatus', state)
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('before-quit', () => {
  void stopShadowRoutingMetrics()
  invalidateTerminalLifecycle()
  disposeWebPanel()
  cancelAllMemoryCompactions()
})

app.on('window-all-closed', () => {
  if (isSmokeRun) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function registerIpcHandler(
  channel: IpcInvokeChannel,
  handler: (event: IpcSenderLike, ...args: any[]) => unknown,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedIpcSender(event, PRODUCTION_RENDERER_URL)
    return await handler(event, ...args)
  })
}

function registerIpcListener(
  channel: IpcSendChannel,
  handler: (event: IpcSenderLike, ...args: any[]) => unknown,
): void {
  ipcMain.on(channel, (event, ...args) => {
    try {
      assertTrustedIpcSender(event, PRODUCTION_RENDERER_URL)
      void handler(event, ...args)
    } catch (error) {
      console.warn(`IPC bloqueado no canal ${channel}:`, error)
    }
  })
}

function setupIpcHandlers() {
  // Obter lista de projetos
  registerIpcHandler('devorbit:getProjects', async () => {
    const config = await loadConfig()
    const projects = await scanAllProjects(config.projectDirs, false, config.managedProjects)
    syncMemorySchedulers(projects.map((project) => project.path))
    return projects
  })

  // Atualizar projetos forçando novo scan
  registerIpcHandler('devorbit:refreshProjects', async () => {
    const config = await loadConfig()
    const projects = await scanAllProjects(config.projectDirs, true, config.managedProjects)
    syncMemorySchedulers(projects.map((project) => project.path))
    return projects
  })

  registerIpcHandler('devorbit:getOtherDirs', async () => {
    const config = await loadConfig()
    return await listAllNonProjectDirs(config.projectDirs)
  })

  // Sincronizar um projeto com Git (Pull)
  registerIpcHandler('devorbit:syncGit', async (_event, projectPath: string): Promise<SyncResult> => {
    return await syncGit(await validateProjectPath(projectPath))
  })

  registerIpcHandler('devorbit:getGitBranches', async (_event, projectPath: string, refreshRemote?: boolean) => {
    if (refreshRemote !== undefined && typeof refreshRemote !== 'boolean') {
      throw new Error('Opção de atualização das branches inválida.')
    }
    return await getGitBranches(await validateProjectPath(projectPath), refreshRemote === true)
  })

  registerIpcHandler(
    'devorbit:switchGitBranch',
    async (_event, projectPath: string, branch: string): Promise<SyncResult> => {
      const safeBranch = validateGitBranch(branch)
      return await switchGitBranch(await validateProjectPath(projectPath), safeBranch)
    }
  )

  registerIpcHandler('devorbit:stashSyncGit', async (_event, projectPath: string): Promise<SyncResult> => {
    return await stashSyncGit(await validateProjectPath(projectPath))
  })

  registerIpcHandler(
    'devorbit:stashSwitchGitBranch',
    async (_event, projectPath: string, branch: string): Promise<SyncResult> => {
      const safeBranch = validateGitBranch(branch)
      return await stashSwitchGitBranch(await validateProjectPath(projectPath), safeBranch)
    }
  )

  // Subir alterações para o GitHub (Commit & Push)
  registerIpcHandler(
    'devorbit:pushGit',
    async (_event, projectPath: string, commitMessage?: unknown, options?: unknown): Promise<SyncResult> => {
      if (commitMessage !== undefined && typeof commitMessage !== 'string') {
        throw new Error('Mensagem de commit inválida.')
      }
      const safeOptions = validateGitPushOptions(options)
      return await pushGit(
        await validateProjectPath(projectPath),
        commitMessage,
        safeOptions,
      )
    }
  )

  // Obter arquivos alterados recentemente
  registerIpcHandler('devorbit:getGitChanges', async (_event, projectPath: string) => {
    return await getGitChanges(await validateProjectPath(projectPath))
  })

  registerIpcHandler('devorbit:getGitFileDiff', async (_event, projectPath: string, relativePath: unknown) => {
    const safePath = await validateProjectPath(projectPath)
    const safeRelative = validateGitDiffPathspec(relativePath)
    return await getGitFileDiff(safePath, safeRelative)
  })

  // Inicializar e vincular um projeto que ainda não possui Git
  registerIpcHandler('devorbit:getGitInitPreview', async (_event, projectPath: string, branch?: string) => {
    return await getGitInitPreview(await validateProjectPath(projectPath), branch)
  })

  registerIpcHandler('devorbit:initGitRepository', async (_event, projectPath: string, options?: unknown) => {
    return await initGitRepository(
      await validateProjectPath(projectPath),
      validateGitInitOptions(options),
    )
  })

  registerIpcHandler('devorbit:cloneGitRepository', async (_event, input?: unknown) => {
    const parsed = validateCloneInput(input)
    const safeParent = await validateCloneParent(parsed.parentDir)
    const result = await cloneGitRepository({ ...parsed, parentDir: safeParent })
    if (result.success) {
      await rememberManagedProject({
        id: Buffer.from(path.resolve(safeParent, parsed.folderName)).toString('base64'),
        name: parsed.folderName,
        parentPath: safeParent,
        folderName: parsed.folderName,
        remoteUrl: parsed.remoteUrl,
        branch: 'main',
        registeredAt: new Date().toISOString(),
      })
    }
    return result
  })

  registerIpcHandler('devorbit:restoreManagedProject', async (_event, projectPath: string) => {
    const config = await loadConfig()
    const requested = path.resolve(String(projectPath || '')).toLowerCase()
    const managed = config.managedProjects.find((entry) => managedProjectPath(entry).toLowerCase() === requested)
    if (!managed) throw new Error('Projeto não encontrado no cadastro do DevOrbit.')
    const safeParent = await validateCloneParent(managed.parentPath)
    return await cloneGitRepository({
      parentDir: safeParent,
      folderName: managed.folderName,
      remoteUrl: managed.remoteUrl,
    })
  })

  registerIpcHandler('devorbit:finalizeManagedProject', async (_event, projectPath: string, options?: unknown): Promise<SyncResult> => {
    const allowRecreatableIgnored = options === undefined
      ? false
      : typeof options === 'object' && options !== null && !Array.isArray(options) &&
        ('allowRecreatableIgnored' in options)
        ? (options as { allowRecreatableIgnored?: unknown }).allowRecreatableIgnored
        : false
    if (typeof allowRecreatableIgnored !== 'boolean') {
      throw new Error('Opção de liberação inválida.')
    }
    const safePath = await validateProjectPath(projectPath)
    const remoteBefore = await getGitRemoteUrl(safePath)
    const configBefore = await loadConfig()
    const existing = configBefore.managedProjects.find((entry) => managedProjectPath(entry).toLowerCase() === safePath.toLowerCase())
    if (!existing && !remoteBefore) {
      return { success: false, message: 'Liberação recusada: não foi possível identificar o remote origin para restaurar este projeto depois.' }
    }
    if (!existing && remoteBefore) {
      try {
        const remoteUrl = new URL(remoteBefore)
        if (remoteUrl.protocol !== 'https:' || remoteUrl.username || remoteUrl.password) {
          return { success: false, message: 'Liberação recusada: cadastre o projeto com um remote HTTPS antes de liberar a cópia local.' }
        }
      } catch {
        return { success: false, message: 'Liberação recusada: o remote origin não é uma URL HTTPS válida.' }
      }
    }
    const catalogEntry: ManagedProject = existing
      ? { ...existing, remoteUrl: remoteBefore || existing.remoteUrl }
      : {
          id: Buffer.from(safePath).toString('base64'),
          name: path.basename(safePath),
          parentPath: path.dirname(safePath),
          folderName: path.basename(safePath),
          remoteUrl: remoteBefore as string,
          branch: 'main',
          registeredAt: new Date().toISOString(),
        }
    try {
      // Persist the restore metadata before deleting the working tree. A
      // failed config write therefore leaves all local files untouched.
      await rememberManagedProject(catalogEntry)
    } catch (error: any) {
      return { success: false, message: `Liberação recusada: não foi possível salvar o cadastro do projeto (${error?.message || 'erro de configuração'}).` }
    }
    const result = await finalizeGitProject(safePath, { allowRecreatableIgnored })
    if (result.success) cancelMemoryCompaction(safePath)
    return result
  })

  // Sincronizar todos os projetos
  registerIpcHandler('devorbit:syncAllGit', async (): Promise<{ [path: string]: SyncResult }> => {
    const config = await loadConfig()
    const projects = await scanAllProjects(config.projectDirs, false, config.managedProjects)
    const repositories = projects.filter((project) => project.git.isRepo)
    const orderedResults = new Array<[string, SyncResult]>(repositories.length)
    const concurrency = Math.min(4, repositories.length)
    let nextIndex = 0
    let completed = 0

    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex++
        if (index >= repositories.length) return

        const project = repositories[index]
        try {
          orderedResults[index] = [project.path, await syncGit(project.path)]
        } catch (error: unknown) {
          // Keep the batch useful even if an unexpected error escapes a single
          // repository operation. The renderer can then report partial failure.
          const message = error instanceof Error ? error.message : String(error)
          orderedResults[index] = [project.path, {
            success: false,
            message: `Erro ao sincronizar: ${message}`,
          }]
        } finally {
          completed += 1
          mainWindow?.webContents.send('devorbit:syncProgress', {
            path: project.path,
            done: completed,
            total: repositories.length,
          })
        }
      }
    }

    if (concurrency > 0) {
      await Promise.all(Array.from({ length: concurrency }, () => worker()))
    }

    const results: { [path: string]: SyncResult } = {}
    for (const [projectPath, result] of orderedResults) {
      results[projectPath] = result
    }

    return results
  })

  // Lançar ferramentas
  registerIpcHandler(
    'devorbit:launchTool',
    async (_event, tool: any, projectPath: string, options?: any) => {
      const safeTool = validateLaunchTool(tool)
      const safeOptions = validateLaunchOptions(options)
      const safePath = safeTool === 'chrome' || safeTool === 'brave'
        ? ''
        : await validateProjectPath(projectPath)
      return await launchTool(safeTool, safePath, safeOptions)
    }
  )

  registerIpcHandler('devorbit:listProjectFiles', async (_event, projectPath: string, relativeDirectory?: unknown) => {
    return await listProjectFiles(await validateProjectPath(projectPath), relativeDirectory)
  })

  registerIpcHandler('devorbit:readProjectFile', async (_event, projectPath: string, relativePath: unknown) => {
    return await readProjectFile(await validateProjectPath(projectPath), relativePath)
  })

  registerIpcHandler('devorbit:saveProjectFile', async (_event, projectPath: string, relativePath: unknown, content: unknown) => {
    return await saveProjectFile(await validateProjectPath(projectPath), relativePath, content)
  })

  registerIpcHandler('devorbit:createProjectFile', async (_event, projectPath: string, relativePath: unknown) => {
    return await createProjectFile(await validateProjectPath(projectPath), relativePath)
  })

  registerIpcHandler('devorbit:createProjectDirectory', async (_event, projectPath: string, relativePath: unknown) => {
    return await createProjectDirectory(await validateProjectPath(projectPath), relativePath)
  })

  registerIpcHandler('devorbit:moveProjectEntry', async (_event, projectPath: string, sourcePath: unknown, destinationPath: unknown) => {
    return await moveProjectEntry(await validateProjectPath(projectPath), sourcePath, destinationPath)
  })

  registerIpcHandler('devorbit:deleteProjectEntry', async (_event, projectPath: string, relativePath: unknown, options?: { recursive?: unknown }) => {
    return await deleteProjectEntry(await validateProjectPath(projectPath), relativePath, options)
  })

  registerIpcHandler('devorbit:createAgentWorktree', async (_event, projectPath: string, agentId: unknown) => {
    if (typeof agentId !== 'string' || !/^[a-z0-9_-]{1,48}$/i.test(agentId)) throw new Error('Identificador de agente inválido.')
    const safePath = await canonicalizeExistingDirectory(projectPath)
    return await createAgentWorktree(safePath, agentId)
  })
  registerIpcHandler('devorbit:integrateAgentWorktree', async (_event, projectPath: string, branch: unknown, worktreePath: unknown) => {
    if (typeof branch !== 'string' || typeof worktreePath !== 'string') throw new Error('Dados de worktree inválidos.')
    const safePath = await canonicalizeExistingDirectory(projectPath)
    const safeWorktree = await canonicalizeExistingDirectory(worktreePath)
    return await integrateAgentWorktree(safePath, branch, safeWorktree)
  })

  registerIpcHandler('devorbit:startTerminal', async (_event, id: unknown, projectPath: string, cols?: unknown, rows?: unknown) => {
    if (typeof id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(id)) throw new Error('Identificador de terminal inválido.')
    const generation = terminalLifecycleGeneration
    const safePath = await validateProjectPath(projectPath)
    assertTerminalLifecycle(generation)
    const safeCols = cols === undefined ? undefined : validateFiniteNumber(cols, 'Colunas do terminal', { minimum: TERMINAL_MIN_COLS, maximum: TERMINAL_MAX_COLS, integer: true })
    const safeRows = rows === undefined ? undefined : validateFiniteNumber(rows, 'Linhas do terminal', { minimum: TERMINAL_MIN_ROWS, maximum: TERMINAL_MAX_ROWS, integer: true })
    beginCompanionTerminalStart(id)
    const started = await startTerminal(id, safePath, {
      ...(safeCols !== undefined ? { cols: safeCols } : {}),
      ...(safeRows !== undefined ? { rows: safeRows } : {}),
    })
    registerCompanionTerminal(id, { projectPath: safePath })
    return started
  })

  registerIpcHandler('devorbit:startCodexTerminal', async (
    _event,
    id: unknown,
    projectPath: string,
    account: unknown,
    cols?: unknown,
    rows?: unknown,
  ) => {
    if (typeof id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(id)) throw new Error('Identificador de terminal inválido.')
    const generation = terminalLifecycleGeneration
    const safeAccount = validateCodexAccount(account)
    const safePath = await validateProjectPath(projectPath)
    const config = await loadConfig()
    assertTerminalLifecycle(generation)
    const { codexHome } = await ensureAccountDirectories(safeAccount)
    const accountLabel = getAccountLabel(safeAccount, {
      account1: config.chatGptAccount1Name,
      account2: config.chatGptAccount2Name,
    })
    if (!(await hasValidCodexAuth(codexHome))) {
      return {
        success: false,
        needsAuth: true,
        fallback: false,
        account: safeAccount,
        message: accountLabel + ' ainda não está conectada. Conecte a conta e tente novamente.',
      }
    }

    const safeCols = cols === undefined ? 120 : validateFiniteNumber(cols, 'Colunas do terminal', { minimum: TERMINAL_MIN_COLS, maximum: TERMINAL_MAX_COLS, integer: true })
    const safeRows = rows === undefined ? 32 : validateFiniteNumber(rows, 'Linhas do terminal', { minimum: TERMINAL_MIN_ROWS, maximum: TERMINAL_MAX_ROWS, integer: true })
    const codexCommand = await resolveCodexCommand(config.customPaths.codex)
    assertTerminalLifecycle(generation)
    if (/[%!]/.test(codexCommand)) {
      return { success: false, fallback: false, account: safeAccount, message: 'O caminho configurado do Codex contém caracteres que o terminal não pode executar com segurança.' }
    }
    // A quota real é somente leitura via OAuth (usage-real.ts). O terminal
    // nunca é bloqueado por contador local.
    const isScript = /\.(?:cmd|bat)$/i.test(codexCommand)
    const command = isScript ? (process.env.ComSpec || 'cmd.exe') : codexCommand
    const args = isScript ? ['/d', '/q', '/k', 'call "' + codexCommand + '"'] : []
    assertTerminalLifecycle(generation)
    beginCompanionTerminalStart(id)
    const result = await startTerminal(id, safePath, {
      command,
      args,
      // A conta escolhida define o perfil do PTY (CODEX_HOME isolado), sem
      // reaproveitar autenticação de uma sessão anterior.
      env: getCodexAccountEnvironment(safeAccount),
      cols: safeCols,
      rows: safeRows,
    })
    registerCompanionTerminal(id, { projectPath: safePath })
    return {
      success: true,
      ...result,
      account: safeAccount,
      fallback: false,
      message: 'Codex conectado no terminal interno (' + accountLabel + ').',
    }
  })

  registerIpcHandler('devorbit:startAgentTerminal', async (
    _event,
    id: unknown,
    projectPath: string,
    provider: unknown,
    cols?: unknown,
    rows?: unknown,
    task?: unknown,
  ) => {
    if (typeof id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(id)) throw new Error('Identificador de terminal inválido.')
    const generation = terminalLifecycleGeneration
    const safeProvider = validateAgentProvider(provider)
    if (safeProvider === 'codex') {
      return {
        success: false,
        provider: safeProvider,
        message: 'O Codex usa o fluxo de conta do DevOrbit; selecione uma conta Codex ou outro provedor.',
      }
    }
    const safeTask = task === undefined || task === null ? undefined : String(task).slice(0, 8000)
    if (task !== undefined && task !== null && typeof task !== 'string') throw new Error('Tarefa do turno inválida.')
    const safePath = await validateProjectPath(projectPath)
    const config = await loadConfig()
    assertTerminalLifecycle(generation)
    // Resolução por turno: o prompt classifica tier/modelo e ordena provedores
    // (preferido + fallbacks prontos). O spawn tenta em ordem e só faz failover
    // em erro transitório classificado, devolvendo o provedor efetivo.
    const turn = await resolveAgentTurn(config, safeProvider, safeTask)
    if (!turn.available) {
      // Provedor explícito indisponível: erro estruturado, sem trocar de CLI.
      return {
        success: false,
        provider: turn.provider,
        code: turn.error?.code || 'provider-not-ready',
        fallback: false,
        message: turn.reason,
      }
    }
    const safeCols = cols === undefined ? 120 : validateFiniteNumber(cols, 'Colunas do terminal', { minimum: TERMINAL_MIN_COLS, maximum: TERMINAL_MAX_COLS, integer: true })
    const safeRows = rows === undefined ? 32 : validateFiniteNumber(rows, 'Linhas do terminal', { minimum: TERMINAL_MIN_ROWS, maximum: TERMINAL_MAX_ROWS, integer: true })
    beginCompanionTerminalStart(id)
    const execution = await executeExplicitAgentTurn(turn.provider, async (candidate) => {
      const spawned = await spawnAgentProviderTerminal(
        {
          resolveWithFallback: resolveAgentProviderWithFallback,
          startTerminal: (spawnId, options) => startTerminal(spawnId, safePath, options),
          assertLive: () => assertTerminalLifecycle(generation),
        },
        {
          id,
          candidate,
          model: turn.model,
          tier: turn.tier,
          routing: config.modelRouting,
          cols: safeCols,
          rows: safeRows,
        },
        config
      )
      return { started: spawned.started, provider: spawned.provider, command: spawned.command }
    })
    registerCompanionTerminal(id, { projectPath: safePath })
    return {
      success: true,
      ...execution.result.started,
      provider: execution.result.provider ?? execution.provider,
      command: execution.result.command,
      tier: turn.tier,
      model: turn.model,
      fallback: false,
      message: (execution.result.provider ?? execution.provider) + ' iniciado no terminal interno. Se precisar, autentique pelo próprio CLI.',
    }
  })

  registerIpcHandler('devorbit:resizeTerminal', (_event, id: unknown, cols: unknown, rows: unknown) => {
    if (typeof id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(id)) throw new Error('Identificador de terminal inválido.')
    const safeCols = validateFiniteNumber(cols, 'Colunas do terminal', { minimum: TERMINAL_MIN_COLS, maximum: TERMINAL_MAX_COLS, integer: true })
    const safeRows = validateFiniteNumber(rows, 'Linhas do terminal', { minimum: TERMINAL_MIN_ROWS, maximum: TERMINAL_MAX_ROWS, integer: true })
    return { success: resizeTerminal(id, safeCols, safeRows) }
  })

  registerIpcHandler('devorbit:writeTerminal', (_event, id: unknown, input: unknown) => {
    if (typeof id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(id)) throw new Error('Identificador de terminal inválido.')
    if (typeof input !== 'string' || input.length > 64_000) throw new Error('Entrada de terminal inválida.')
    return { success: writeTerminal(id, input) }
  })

  registerIpcHandler('devorbit:stopTerminal', (_event, id: unknown) => {
    if (typeof id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(id)) throw new Error('Identificador de terminal inválido.')
    stopTerminal(id)
    clearPipesFor(id)
    turnSessions.delete(id)
    unregisterCompanionTerminal(id)
    return { success: true }
  })

  registerIpcHandler('devorbit:pipeTerminals', (_event, fromId: unknown, toId: unknown) => {
    if (typeof fromId !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(fromId)) throw new Error('Identificador de terminal inválido.')
    if (toId === null || toId === undefined) {
      clearPipe(fromId)
      return { success: true }
    }
    if (typeof toId !== 'string') throw new Error('Identificador de terminal inválido.')
    setPipe(fromId, toId)
    return { success: true }
  })

  // Fronteira real de execução do turno (FASE 3): resolve tier/modelo pelo
  // prompt, garante o CLI com o env do turno, entrega, aguarda o marcador e
  // só faz failover em erro transitório — reutilizando o mesmo terminal id.
  registerIpcHandler('devorbit:sendAgentTurn', async (
    _event,
    terminalId: unknown,
    provider: unknown,
    projectPath: string,
    prompt: unknown,
    timeouts?: unknown,
  ) => {
    if (typeof terminalId !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(terminalId)) throw new Error('Identificador de terminal inválido.')
    const safeProvider = validateAgentProvider(provider)
    if (safeProvider === 'codex') {
      throw new Error('O Codex usa o fluxo de conta do DevOrbit; use startCodexTerminal.')
    }
    const safePath = await validateProjectPath(projectPath)
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000) throw new Error('Prompt do turno inválido.')
    let idleMs: number | undefined
    let overallMs: number | undefined
    if (timeouts !== undefined && timeouts !== null) {
      if (typeof timeouts !== 'object' || Array.isArray(timeouts)) throw new Error('Timeouts do turno inválidos.')
      const raw = timeouts as Record<string, unknown>
      if (raw.idleMs !== undefined) idleMs = validateFiniteNumber(raw.idleMs, 'Timeout de ociosidade', { minimum: 1000, maximum: 600_000, integer: true })
      if (raw.overallMs !== undefined) overallMs = validateFiniteNumber(raw.overallMs, 'Timeout total', { minimum: 5000, maximum: 1800_000, integer: true })
    }
    const generation = terminalLifecycleGeneration
    const outcome = await sendAgentTurn(
      {
        getSession: (id) => turnSessions.get(id),
        setSession: (id, session) => turnSessions.set(id, session),
        clearSession: (id) => turnSessions.delete(id),
        hasTerminal,
        spawn: async (id, turn) => {
          const turnConfig = await loadConfig()
          beginCompanionTerminalStart(id)
          const spawned = await spawnAgentProviderTerminal(
            {
              resolveWithFallback: resolveAgentProviderWithFallback,
              startTerminal: (spawnId, options) => startTerminal(spawnId, safePath, options),
              assertLive: () => assertTerminalLifecycle(generation),
            },
            {
              id,
              candidate: turn.provider,
              model: turn.model,
              tier: turn.tier,
              routing: turnConfig.modelRouting,
              cols: 120,
              rows: 32,
            },
            turnConfig
          )
          registerCompanionTerminal(id, { projectPath: safePath })
          // Provedor efetivo resolvido no spawn (health pode trocar o
          // candidato); sendAgentTurn usa isso na sessão e no desfecho.
          return { provider: spawned.provider }
        },
        write: writeTerminal,
        waitResult: waitTurnResult,
        resolveTurn: async (candidate, taskPrompt) => {
          const turnConfig = await loadConfig()
          return resolveAgentTurn(turnConfig, candidate, taskPrompt)
        },
        orderProviders: orderProvidersForTask,
        readyProviders: async () => (await getAgentProviderHealth(await loadConfig()))
          .filter((item) => item.state === 'ready')
          .map((item) => item.id),
      },
      {
        terminalId,
        provider: safeProvider,
        prompt,
        ...(idleMs !== undefined || overallMs !== undefined
          ? { timeouts: { ...(idleMs !== undefined ? { idleMs } : {}), ...(overallMs !== undefined ? { overallMs } : {}) } }
          : {}),
      }
    )
    return { success: true, ...outcome }
  })

  registerIpcHandler('devorbit:navigateWeb', async (_event, url: unknown) => {
    if (typeof url !== 'string') throw new Error('URL inválida.')
    return await navigateWeb(url)
  })

  registerIpcHandler('devorbit:getWebState', () => getWebState())
  registerIpcHandler('devorbit:goBackWeb', () => goBackWeb())
  registerIpcHandler('devorbit:goForwardWeb', () => goForwardWeb())
  registerIpcHandler('devorbit:reloadWeb', () => reloadWeb())

  registerIpcHandler('devorbit:disposeWebPanel', () => {
    disposeWebPanel()
    return { success: true }
  })

  registerIpcHandler('devorbit:setWebVisible', (_event, visible: unknown) => {
    if (typeof visible !== 'boolean') throw new Error('Visibilidade inválida.')
    if (visible && mainWindow) attachWebPanel(mainWindow)
    setWebVisible(visible)
    return { success: true }
  })

  registerIpcHandler('devorbit:setWebBounds', (_event, rawBounds: unknown) => {
    if (!rawBounds || typeof rawBounds !== 'object') throw new Error('Dimensões do navegador inválidas.')
    const value = rawBounds as Record<string, unknown>
    const safeBounds = {
      x: validateFiniteNumber(value.x, 'Posição horizontal'),
      y: validateFiniteNumber(value.y, 'Posição vertical'),
      width: validateFiniteNumber(value.width, 'Largura'),
      height: validateFiniteNumber(value.height, 'Altura'),
    }
    const contentKeys = ['contentX', 'contentY', 'contentWidth', 'contentHeight']
    const hasContentBounds = contentKeys.some((key) => value[key] !== undefined)
    const safeContentBounds = hasContentBounds
      ? {
          contentX: validateFiniteNumber(value.contentX, 'contentX'),
          contentY: validateFiniteNumber(value.contentY, 'contentY'),
          contentWidth: validateFiniteNumber(value.contentWidth, 'contentWidth'),
          contentHeight: validateFiniteNumber(value.contentHeight, 'contentHeight'),
        }
      : undefined
    if ((safeBounds.width > 0 && safeBounds.height > 0) && mainWindow) attachWebPanel(mainWindow)
    setWebBounds({ ...safeBounds, ...(safeContentBounds || {}) })
    return { success: true }
  })

  // Copiar resumo de contexto
  registerIpcHandler('devorbit:copyProjectContext', async (_event, projectPath: string) => {
    return await copyProjectContext(await validateProjectPath(projectPath))
  })

  // Configurações
  registerIpcHandler('devorbit:getConfig', async () => {
    return await loadConfig()
  })

  registerIpcHandler('devorbit:getUpdateState', () => getUpdateState())
  registerIpcHandler('devorbit:downloadUpdate', () => downloadUpdate())
  registerIpcHandler('devorbit:installUpdate', async () => {
    return await installUpdate()
  })

  registerIpcHandler('devorbit:saveConfig', async (_event, updates: Partial<AppConfig>) => {
    return await saveConfig(await validateConfigUpdates(updates))
  })

  registerIpcHandler('devorbit:exportConfig', async () => {
    if (!mainWindow) throw new Error('Janela indisponível.')
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar configurações do DevOrbit',
      defaultPath: 'devorbit-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { success: false, message: 'Exportação cancelada.' }
    await fs.writeFile(result.filePath, await exportConfigJson(), 'utf-8')
    return { success: true, message: `Configurações exportadas para ${result.filePath}` }
  })

  registerIpcHandler('devorbit:importConfig', async () => {
    if (!mainWindow) throw new Error('Janela indisponível.')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Importar configurações do DevOrbit',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return { success: false, message: 'Importação cancelada.' }
    const raw = await fs.readFile(result.filePaths[0], 'utf-8')
    await importConfigJson(raw)
    return { success: true, message: 'Configurações importadas! Backup anterior salvo em config.json.bak.' }
  })

  registerIpcHandler('devorbit:testToolPath', async (_event, toolPath: string) => {
    return await testToolPath(toolPath)
  })

  registerIpcHandler('devorbit:getToolHealth', async () => {
    return await getToolHealth(await loadConfig())
  })

  // Seletor de pasta no Windows
  registerIpcHandler('devorbit:selectDirectory', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Selecione uma pasta de projetos para monitorar',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Status e Autenticação do Codex Multi-Conta
  registerIpcHandler('devorbit:getCodexAuthStatus', async () => {
    return await checkCodexAuthStatus()
  })

  registerIpcHandler(
    'devorbit:startCodexLogin',
    async (_event, account: 'account1' | 'account2') => {
      const safeAccount = validateCodexAccount(account)
      await startCodexDeviceLogin(safeAccount, (progress: CodexAuthProgress) => {
        mainWindow?.webContents.send('devorbit:codexAuthProgress', progress)
      })
      return { success: true }
    }
  )

  registerIpcHandler('devorbit:cancelCodexLogin', async () => {
    await cancelCodexLogin()
    return { success: true }
  })

  // AI Memory Handlers
  registerIpcHandler('devorbit:getProjectMemory', async (_event, projectPath: string) => {
    return await getProjectMemory(await validateProjectPath(projectPath))
  })

  registerIpcHandler(
    'devorbit:saveProjectMemory',
    async (_event, projectPath: string, content: string) => {
      if (typeof content !== 'string' || content.length > 2_000_000) {
        throw new Error('Conteúdo da memória inválido ou grande demais.')
      }
      return await saveProjectMemory(await validateProjectPath(projectPath), content)
    }
  )

  registerIpcHandler('devorbit:generateMemoryFromGit', async (_event, projectPath: string) => {
    return await generateMemoryFromGit(await validateProjectPath(projectPath))
  })

  // Telemetria única: quotas reais via OAuth (usage-real.ts)
  registerIpcHandler('devorbit:getRealUsage', async (_event, force?: boolean) => {
    if (force !== undefined && typeof force !== 'boolean') {
      throw new Error('Opção de atualização de uso inválida.')
    }
    return await getRealUsage(force === true)
  })

  // Controles de janela (minimizar, maximizar, fechar)
  registerIpcListener('devorbit:windowControl', (_event, action: 'minimize' | 'maximize' | 'close') => {
    if (!mainWindow) return
    const safeAction = validateWindowAction(action)
    if (safeAction === 'minimize') mainWindow.minimize()
    else if (safeAction === 'maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
    } else if (safeAction === 'close') mainWindow.close()
  })
}
