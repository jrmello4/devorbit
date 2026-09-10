import electron, { type BrowserWindow as BrowserWindowType } from 'electron'
const { app, BrowserWindow, ipcMain, dialog } = electron
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, saveConfig } from './config'
import { scanAllProjects } from './scanner'
import { syncGit, pushGit, getGitChangesSummary } from './git'
import { launchTool, copyProjectContext } from './launcher'
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
import type { AppConfig, SyncResult } from '../renderer/src/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '../..')

export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = process.env.VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

let mainWindow: BrowserWindowType | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    frame: false, // Frameless para controle visual total estilo Linear/Raycast
    show: true,
    backgroundColor: '#090d16',
    title: 'DevOrbit',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.show()
  mainWindow.focus()

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
    if (input.key === 'F12') {
      mainWindow?.webContents.toggleDevTools()
    }
  })

  // Gerenciamento de eventos de janela
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html')).catch((err: any) => {
      console.error('Failed to load file:', err)
    })
  }
}

app.whenReady().then(async () => {
  setupIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function setupIpcHandlers() {
  // Obter lista de projetos
  ipcMain.handle('devorbit:getProjects', async () => {
    const config = await loadConfig()
    return await scanAllProjects(config.projectDirs)
  })

  // Atualizar projetos forçando novo scan
  ipcMain.handle('devorbit:refreshProjects', async () => {
    const config = await loadConfig()
    return await scanAllProjects(config.projectDirs)
  })

  // Sincronizar um projeto com Git (Pull)
  ipcMain.handle('devorbit:syncGit', async (_event, projectPath: string): Promise<SyncResult> => {
    return await syncGit(projectPath)
  })

  // Subir alterações para o GitHub (Commit & Push)
  ipcMain.handle(
    'devorbit:pushGit',
    async (_event, projectPath: string, commitMessage?: string): Promise<SyncResult> => {
      return await pushGit(projectPath, commitMessage)
    }
  )

  // Obter arquivos alterados recentemente
  ipcMain.handle('devorbit:getGitChanges', async (_event, projectPath: string): Promise<string[]> => {
    return await getGitChangesSummary(projectPath)
  })

  // Sincronizar todos os projetos
  ipcMain.handle('devorbit:syncAllGit', async (): Promise<{ [path: string]: SyncResult }> => {
    const config = await loadConfig()
    const projects = await scanAllProjects(config.projectDirs)
    const results: { [path: string]: SyncResult } = {}

    for (const project of projects) {
      if (project.git.isRepo) {
        results[project.path] = await syncGit(project.path)
      }
    }

    return results
  })

  // Lançar ferramentas
  ipcMain.handle(
    'devorbit:launchTool',
    async (_event, tool: any, projectPath: string, options?: any) => {
      return await launchTool(tool, projectPath, options)
    }
  )

  // Copiar resumo de contexto
  ipcMain.handle('devorbit:copyProjectContext', async (_event, projectPath: string) => {
    return await copyProjectContext(projectPath)
  })

  // Configurações
  ipcMain.handle('devorbit:getConfig', async () => {
    return await loadConfig()
  })

  ipcMain.handle('devorbit:saveConfig', async (_event, updates: Partial<AppConfig>) => {
    return await saveConfig(updates)
  })

  // Seletor de pasta no Windows
  ipcMain.handle('devorbit:selectDirectory', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Selecione uma pasta de projetos para monitorar',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Status e Autenticação do Codex Multi-Conta
  ipcMain.handle('devorbit:getCodexAuthStatus', async () => {
    return await checkCodexAuthStatus()
  })

  ipcMain.handle(
    'devorbit:startCodexLogin',
    async (_event, account: 'account1' | 'account2') => {
      startCodexDeviceLogin(account, (progress: CodexAuthProgress) => {
        mainWindow?.webContents.send('devorbit:codexAuthProgress', progress)
      })
      return { success: true }
    }
  )

  ipcMain.handle('devorbit:cancelCodexLogin', async () => {
    cancelCodexLogin()
    return { success: true }
  })

  // AI Memory Handlers
  ipcMain.handle('devorbit:getProjectMemory', async (_event, projectPath: string) => {
    return await getProjectMemory(projectPath)
  })

  ipcMain.handle(
    'devorbit:saveProjectMemory',
    async (_event, projectPath: string, content: string) => {
      return await saveProjectMemory(projectPath, content)
    }
  )

  ipcMain.handle('devorbit:generateMemoryFromGit', async (_event, projectPath: string) => {
    return await generateMemoryFromGit(projectPath)
  })

  // Usage Tracker Handlers
  ipcMain.handle('devorbit:getUsageState', async () => {
    return await getUsageState()
  })

  ipcMain.handle(
    'devorbit:incrementUsage',
    async (_event, target: 'account1' | 'account2' | 'antigravity') => {
      return await incrementUsage(target)
    }
  )

  ipcMain.handle(
    'devorbit:decrementUsage',
    async (_event, target: 'account1' | 'account2') => {
      return await decrementUsage(target)
    }
  )

  ipcMain.handle(
    'devorbit:resetUsage',
    async (_event, target: 'account1' | 'account2') => {
      return await resetUsageWindow(target)
    }
  )

  ipcMain.handle(
    'devorbit:updateUsageLimits',
    async (
      _event,
      account: 'account1' | 'account2',
      limit: number,
      windowHours?: number
    ) => {
      return await updateUsageLimits(account, limit, windowHours)
    }
  )

  // Controles de janela (minimizar, maximizar, fechar)
  ipcMain.on('devorbit:windowControl', (_event, action: 'minimize' | 'maximize' | 'close') => {
    if (!mainWindow) return
    if (action === 'minimize') mainWindow.minimize()
    else if (action === 'maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
    } else if (action === 'close') mainWindow.close()
  })
}
