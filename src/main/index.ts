import electron, { type BrowserWindow as BrowserWindowType } from 'electron'
const { app, BrowserWindow, ipcMain, dialog } = electron
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { exportConfigJson, importConfigJson, loadConfig, saveConfig } from './config'
import { listAllNonProjectDirs, scanAllProjects } from './scanner'
import { syncGit, getGitBranches, switchGitBranch, pushGit, getGitChangesSummary, cloneGitRepository, stashSyncGit, stashSwitchGitBranch, finalizeGitProject, getGitRemoteUrl } from './git'
import { getGitInitPreview, initGitRepository } from './git-init'
import { launchTool, copyProjectContext, getToolHealth } from './launcher'
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
} from './memory'
import {
  getUsageState,
  incrementUsage,
  decrementUsage,
  resetUsageWindow,
  updateUsageLimits,
} from './usage'
import { getRealUsage } from './usage-real'
import { downloadUpdate, getUpdateState, initializeUpdater, installUpdate } from './updater'
import type { AppConfig, ManagedProject, SyncResult } from '../renderer/src/types'
import {
  assertTrustedIpcSender,
  canonicalizeExistingDirectory,
  validateCodexAccount,
  validateConfigUpdates,
  validateFiniteNumber,
  validateLaunchOptions,
  validateLaunchTool,
  validateGitInitOptions,
  validateGitBranch,
  validateCloneInput,
  testToolPath,
  validateProjectDirs,
  validateUsageTarget,
  validateWindowAction,
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
const hasSingleInstanceLock = app.requestSingleInstanceLock()
let managedConfigQueue: Promise<void> = Promise.resolve()

async function validateCloneParent(input: unknown): Promise<string> {
  const candidate = await canonicalizeExistingDirectory(input, 'Pasta de destino')
  const config = await loadConfig()
  const allowed = (await Promise.all(config.projectDirs.map(async (root) => {
    try {
      const canonicalRoot = await canonicalizeExistingDirectory(root, 'Pasta monitorada')
      if (candidate === canonicalRoot) return true
      const relative = path.relative(canonicalRoot, candidate)
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
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
      const relative = path.relative(canonicalRoot, candidate)
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
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

  mainWindow.show()
  mainWindow.focus()

  // The renderer is always local (file:// in production or the Vite origin in
  // development). Do not allow links or navigations to turn this privileged
  // window into a general-purpose remote page.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, PRODUCTION_RENDERER_URL)) event.preventDefault()
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

if (!hasSingleInstanceLock) {
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
      mainWindow?.webContents.send('devorbit:updateStatus', state)
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function registerIpcHandler(
  channel: string,
  handler: (event: IpcSenderLike, ...args: any[]) => unknown,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedIpcSender(event, PRODUCTION_RENDERER_URL)
    return await handler(event, ...args)
  })
}

function registerIpcListener(
  channel: string,
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
    return await scanAllProjects(config.projectDirs, false, config.managedProjects)
  })

  // Atualizar projetos forçando novo scan
  registerIpcHandler('devorbit:refreshProjects', async () => {
    const config = await loadConfig()
    return await scanAllProjects(config.projectDirs, true, config.managedProjects)
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
    async (_event, projectPath: string, commitMessage?: string): Promise<SyncResult> => {
      if (commitMessage !== undefined && typeof commitMessage !== 'string') {
        throw new Error('Mensagem de commit inválida.')
      }
      return await pushGit(await validateProjectPath(projectPath), commitMessage)
    }
  )

  // Obter arquivos alterados recentemente
  registerIpcHandler('devorbit:getGitChanges', async (_event, projectPath: string): Promise<string[]> => {
    return await getGitChangesSummary(await validateProjectPath(projectPath))
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
          completed += 1
          mainWindow?.webContents.send('devorbit:syncProgress', {
            path: project.path,
            done: completed,
            total: repositories.length,
          })
        } catch (error: unknown) {
          // Keep the batch useful even if an unexpected error escapes a single
          // repository operation. The renderer can then report partial failure.
          const message = error instanceof Error ? error.message : String(error)
          orderedResults[index] = [project.path, {
            success: false,
            message: `Erro ao sincronizar: ${message}`,
          }]
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
  registerIpcHandler('devorbit:installUpdate', () => {
    installUpdate()
    return { success: true }
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

  // Usage Tracker Handlers
  registerIpcHandler('devorbit:getUsageState', async () => {
    return await getUsageState()
  })

  registerIpcHandler('devorbit:getRealUsage', async (_event, force?: boolean) => {
    if (force !== undefined && typeof force !== 'boolean') {
      throw new Error('Opção de atualização de uso inválida.')
    }
    return await getRealUsage(force === true)
  })

  registerIpcHandler(
    'devorbit:incrementUsage',
    async (_event, target: 'account1' | 'account2' | 'antigravity') => {
      return await incrementUsage(validateUsageTarget(target))
    }
  )

  registerIpcHandler(
    'devorbit:decrementUsage',
    async (_event, target: 'account1' | 'account2') => {
      const account = validateCodexAccount(target)
      return await decrementUsage(account)
    }
  )

  registerIpcHandler(
    'devorbit:resetUsage',
    async (_event, target: 'account1' | 'account2') => {
      const account = validateCodexAccount(target)
      return await resetUsageWindow(account)
    }
  )

  registerIpcHandler(
    'devorbit:updateUsageLimits',
    async (
      _event,
      account: 'account1' | 'account2',
      limit: number,
      windowHours?: number
    ) => {
      const safeAccount = validateCodexAccount(account)
      const safeLimit = validateFiniteNumber(limit, 'Limite de uso', { minimum: 1, integer: true })
      const safeWindowHours = windowHours === undefined
        ? undefined
        : validateFiniteNumber(windowHours, 'Janela de uso', { minimum: 1 })
      return await updateUsageLimits(safeAccount, safeLimit, safeWindowHours)
    }
  )

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

