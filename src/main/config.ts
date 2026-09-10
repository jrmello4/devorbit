import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import electron from 'electron'
const { app } = electron
import type { AppConfig } from '../renderer/src/types'

const defaultConfig: AppConfig = {
  projectDirs: [
    'C:\\Users\\adenilson.j\\projects',
    'C:\\Users\\adenilson.j\\Documents',
  ],
  activeChatGptAccount: 'account1',
  chatGptAccount1Name: 'Conta 1 (Principal)',
  chatGptAccount2Name: 'Conta 2 (Codex / Backup)',
  customPaths: {
    brave: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    mimo: 'C:\\Users\\adenilson.j\\AppData\\Local\\Programs\\Xiaomi MiMo AI\\Xiaomi MiMo AI.exe',
    agy: 'C:\\Users\\adenilson.j\\AppData\\Local\\agy\\agy.exe',
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
