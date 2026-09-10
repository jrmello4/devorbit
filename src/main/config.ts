import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import electron from 'electron'
const { app } = electron
import type { AppConfig } from '../renderer/src/types'

const defaultConfig: AppConfig = {
  projectDirs: [
    path.join(os.homedir(), 'projects'),
    path.join(os.homedir(), 'Documents'),
  ],
  activeChatGptAccount: 'account1',
  chatGptAccount1Name: 'Conta 1 (Principal)',
  chatGptAccount2Name: 'Conta 2 (Codex / Backup)',
  customPaths: {
    brave: path.join(process.env.ProgramFiles || 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    chrome: path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    mimo: path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Xiaomi MiMo AI', 'Xiaomi MiMo AI.exe'),
    agy: path.join(os.homedir(), 'AppData', 'Local', 'agy', 'agy.exe'),
    codex: 'codex.cmd',
    vscode: 'code.cmd',
    wt: 'wt.exe',
  },
}

function getConfigPath(): string {
  try {
    const userData = app.getPath('userData')
    return path.join(userData, 'config.json')
  } catch {
    return path.join(os.homedir(), '.devorbit-config.json')
  }
}

export async function loadConfig(): Promise<AppConfig> {
  const filePath = getConfigPath()
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(content)
    return {
      ...defaultConfig,
      ...parsed,
      customPaths: {
        ...defaultConfig.customPaths,
        ...(parsed.customPaths || {}),
      },
    }
  } catch {
    await saveConfig(defaultConfig)
    return defaultConfig
  }
}

export async function saveConfig(updates: Partial<AppConfig>): Promise<AppConfig> {
  const current = await (async () => {
    try {
      const content = await fs.readFile(getConfigPath(), 'utf-8')
      return { ...defaultConfig, ...JSON.parse(content) }
    } catch {
      return defaultConfig
    }
  })()

  const merged: AppConfig = {
    ...current,
    ...updates,
    customPaths: {
      ...current.customPaths,
      ...(updates.customPaths || {}),
    },
  }

  const filePath = getConfigPath()
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(merged, null, 2), 'utf-8')
  return merged
}
