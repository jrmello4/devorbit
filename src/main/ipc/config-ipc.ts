import fs from 'node:fs/promises'
import { dialog, type BrowserWindow } from 'electron'
import { exportConfigJson, importConfigJson, loadConfig, saveConfig } from '../config'
import { cancelCodexLogin, checkCodexAuthStatus, startCodexDeviceLogin, type CodexAuthProgress } from '../codex-auth'
import { copyProjectContext, getToolHealth } from '../launcher'
import { generateMemoryFromGit, getProjectMemory, saveProjectMemory } from '../memory'
import { validateProjectPath } from '../project-paths'
import { downloadUpdate, getUpdateState, installUpdate } from '../updater'
import { getRealUsage } from '../usage-real'
import { testToolPath, validateCodexAccount } from '../validation'
import { validateConfigUpdates } from '../validation'
import type { IpcRegistrar } from './registrar'
import type { AppConfig } from '../../renderer/src/types'

export interface ConfigIpcDependencies {
  getWindow: () => BrowserWindow | null
  sendCodexAuthProgress: (progress: CodexAuthProgress) => void
}

export function registerConfigIpc(register: IpcRegistrar, dependencies: ConfigIpcDependencies): void {
  register('devorbit:copyProjectContext', async (_event, projectPath: string) => {
    return await copyProjectContext(await validateProjectPath(projectPath))
  })

  register('devorbit:getConfig', async () => {
    return await loadConfig()
  })

  register('devorbit:getUpdateState', () => getUpdateState())
  register('devorbit:downloadUpdate', () => downloadUpdate())
  register('devorbit:installUpdate', async () => {
    return await installUpdate()
  })

  register('devorbit:saveConfig', async (_event, updates: Partial<AppConfig>) => {
    return await saveConfig(await validateConfigUpdates(updates))
  })

  register('devorbit:exportConfig', async () => {
    const window = dependencies.getWindow()
    if (!window) throw new Error('Janela indisponível.')
    const result = await dialog.showSaveDialog(window, {
      title: 'Exportar configurações do DevOrbit',
      defaultPath: 'devorbit-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { success: false, message: 'Exportação cancelada.' }
    await fs.writeFile(result.filePath, await exportConfigJson(), 'utf-8')
    return { success: true, message: `Configurações exportadas para ${result.filePath}` }
  })

  register('devorbit:importConfig', async () => {
    const window = dependencies.getWindow()
    if (!window) throw new Error('Janela indisponível.')
    const result = await dialog.showOpenDialog(window, {
      title: 'Importar configurações do DevOrbit',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return { success: false, message: 'Importação cancelada.' }
    const raw = await fs.readFile(result.filePaths[0], 'utf-8')
    await importConfigJson(raw)
    return { success: true, message: 'Configurações importadas! Backup anterior salvo em config.json.bak.' }
  })

  register('devorbit:testToolPath', async (_event, toolPath: string) => {
    return await testToolPath(toolPath)
  })

  register('devorbit:getToolHealth', async () => {
    return await getToolHealth(await loadConfig())
  })

  register('devorbit:selectDirectory', async () => {
    const window = dependencies.getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
      title: 'Selecione uma pasta de projetos para monitorar',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  register('devorbit:getCodexAuthStatus', async () => {
    return await checkCodexAuthStatus()
  })

  register(
    'devorbit:startCodexLogin',
    async (_event, account: 'account1' | 'account2') => {
      const safeAccount = validateCodexAccount(account)
      await startCodexDeviceLogin(safeAccount, (progress: CodexAuthProgress) => {
        dependencies.sendCodexAuthProgress(progress)
      })
      return { success: true }
    }
  )

  register('devorbit:cancelCodexLogin', async () => {
    await cancelCodexLogin()
    return { success: true }
  })

  register('devorbit:getProjectMemory', async (_event, projectPath: string) => {
    return await getProjectMemory(await validateProjectPath(projectPath))
  })

  register(
    'devorbit:saveProjectMemory',
    async (_event, projectPath: string, content: string) => {
      if (typeof content !== 'string' || content.length > 2_000_000) {
        throw new Error('Conteúdo da memória inválido ou grande demais.')
      }
      return await saveProjectMemory(await validateProjectPath(projectPath), content)
    }
  )

  register('devorbit:generateMemoryFromGit', async (_event, projectPath: string) => {
    return await generateMemoryFromGit(await validateProjectPath(projectPath))
  })

  register('devorbit:getRealUsage', async (_event, force?: boolean) => {
    if (force !== undefined && typeof force !== 'boolean') {
      throw new Error('Opção de atualização de uso inválida.')
    }
    return await getRealUsage(force === true)
  })
}
