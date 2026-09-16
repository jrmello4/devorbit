import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import electron from 'electron'
const { app } = electron
import type { AppConfig, ManagedProject } from '../renderer/src/types'
import { validateConfigUpdates } from './validation'

const MAX_IMPORT_BYTES = 1_000_000

const MAX_CONFIG_TEXT_LENGTH = 160
const MAX_CUSTOM_PATH_LENGTH = 4096
const MAX_PROJECT_DIRS = 16
const CUSTOM_PATH_KEYS = ['brave', 'chrome', 'mimo', 'agy', 'codex', 'opencode', 'claude', 'gemini', 'aider', 'customAgent', 'vscode', 'wt'] as const
let configOperationQueue: Promise<void> = Promise.resolve()

const defaultConfig: AppConfig = {
  projectDirs: [
    path.join(os.homedir(), 'projects'),
    path.join(os.homedir(), 'Documents'),
  ],
  managedProjects: [],
  projectAccounts: {},
  activeChatGptAccount: 'account1',
  chatGptAccount1Name: 'Conta 1 (Principal)',
  chatGptAccount2Name: 'Conta 2 (Codex / Backup)',
  customPaths: {
    brave: path.join(process.env.ProgramFiles || 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    chrome: path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    mimo: path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Xiaomi MiMo AI', 'Xiaomi MiMo AI.exe'),
    agy: path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
    codex: 'codex.cmd',
    vscode: 'code.cmd',
    wt: 'wt.exe',
  },
}

function normalizeManagedProjects(value: unknown): ManagedProject[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: ManagedProject[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    const parentPath = typeof entry.parentPath === 'string' ? entry.parentPath.trim() : ''
    const folderName = typeof entry.folderName === 'string' ? entry.folderName.trim() : ''
    const remoteUrl = typeof entry.remoteUrl === 'string' ? entry.remoteUrl.trim() : ''
    const branch = typeof entry.branch === 'string' && entry.branch.trim() ? entry.branch.trim() : 'main'
    const registeredAt = typeof entry.registeredAt === 'string' ? entry.registeredAt : new Date().toISOString()
    if (!id || !name || !parentPath || !folderName || !remoteUrl) continue
    if (folderName === '.' || folderName === '..' || /[\\/\0]/.test(folderName)) continue
    try {
      const url = new URL(remoteUrl)
      if (url.protocol !== 'https:' || url.username || url.password) continue
    } catch {
      continue
    }
    const key = `${parentPath.toLowerCase()}\\${folderName.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ id, name, parentPath, folderName, remoteUrl, branch, registeredAt })
  }
  return result.slice(0, 500)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length <= MAX_CONFIG_TEXT_LENGTH ? value : fallback
}

function safePath(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_CUSTOM_PATH_LENGTH || value.includes('\0')) {
    return fallback
  }
  const trimmed = value.trim()
  return trimmed || fallback
}

function normalizeProjectAccounts(value: unknown): Record<string, 'account1' | 'account2'> {
  if (!isRecord(value)) return {}
  const result: Record<string, 'account1' | 'account2'> = {}
  for (const [projectId, account] of Object.entries(value).slice(0, 500)) {
    if (projectId.length > 512) continue
    if (account === 'account1' || account === 'account2') result[projectId] = account
  }
  return result
}
function normalizeConfig(value: unknown): AppConfig {
  const source = isRecord(value) ? value : {}
  const rawProjectDirs = source.projectDirs
  const projectDirs = Array.isArray(rawProjectDirs)
    ? rawProjectDirs
        .filter(
          (entry): entry is string =>
            typeof entry === 'string' &&
            entry.trim().length > 0 &&
            entry.length <= MAX_CUSTOM_PATH_LENGTH &&
            !entry.includes('\0')
        )
        .map((entry) => entry.trim())
        .slice(0, MAX_PROJECT_DIRS)
    : [...defaultConfig.projectDirs]
  const hasValidProjectDirList =
    Array.isArray(rawProjectDirs) &&
    (rawProjectDirs.length === 0 || projectDirs.length > 0)

  const rawCustomPaths = isRecord(source.customPaths) ? source.customPaths : {}
  const customPaths: AppConfig['customPaths'] = { ...defaultConfig.customPaths }
  for (const key of CUSTOM_PATH_KEYS) {
    const fallback = customPaths[key]
    const normalized = safePath(rawCustomPaths[key], fallback)
    if (normalized !== undefined) customPaths[key] = normalized
  }

  return {
    projectDirs: hasValidProjectDirList ? projectDirs : [...defaultConfig.projectDirs],
    managedProjects: normalizeManagedProjects(source.managedProjects),
    projectAccounts: normalizeProjectAccounts(source.projectAccounts),
    activeChatGptAccount:
      source.activeChatGptAccount === 'account2' ? 'account2' : 'account1',
    chatGptAccount1Name: safeText(
      source.chatGptAccount1Name,
      defaultConfig.chatGptAccount1Name
    ),
    chatGptAccount2Name: safeText(
      source.chatGptAccount2Name,
      defaultConfig.chatGptAccount2Name
    ),
    customPaths,
  }
}

function getConfigPath(): string {
  try {
    const userData = app.getPath('userData')
    return path.join(userData, 'config.json')
  } catch {
    return path.join(os.homedir(), '.devorbit-config.json')
  }
}

async function atomicallyWriteConfig(file: string, config: AppConfig): Promise<void> {
  const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`
  let renamed = false

  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const handle = await fs.open(temporaryFile, 'w')
    try {
      await handle.writeFile(JSON.stringify(config, null, 2), 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporaryFile, file)
    renamed = true
  } finally {
    if (!renamed) await fs.rm(temporaryFile, { force: true }).catch(() => undefined)
  }
}

function enqueueConfigOperation<T>(operation: () => Promise<T>): Promise<T> {
  const queued = configOperationQueue.catch(() => undefined).then(operation)
  configOperationQueue = queued.then(() => undefined, () => undefined)
  return queued
}

export async function loadConfig(): Promise<AppConfig> {
  const filePath = getConfigPath()
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return normalizeConfig(JSON.parse(content))
  } catch {
    return enqueueConfigOperation(async () => {
      // Another initial load may have created the file while this call was
      // waiting for the queue. Re-read before deciding to initialize it.
      try {
        const content = await fs.readFile(filePath, 'utf-8')
        return normalizeConfig(JSON.parse(content))
      } catch {
        await atomicallyWriteConfig(filePath, defaultConfig)
        return normalizeConfig(defaultConfig)
      }
    })
  }
}

export async function saveConfig(updates: Partial<AppConfig>): Promise<AppConfig> {
  const filePath = getConfigPath()
  return enqueueConfigOperation(async () => {
    const current = await (async () => {
      try {
        const content = await fs.readFile(filePath, 'utf-8')
        return normalizeConfig(JSON.parse(content))
      } catch {
        return normalizeConfig(defaultConfig)
      }
    })()

    const merged = normalizeConfig({
      ...current,
      ...updates,
      customPaths: {
        ...current.customPaths,
        ...(updates.customPaths || {}),
      },
    })

    await atomicallyWriteConfig(filePath, merged)
    return merged
  })
}

export async function exportConfigJson(): Promise<string> {
  return JSON.stringify(await loadConfig(), null, 2)
}

export async function importConfigJson(raw: unknown): Promise<AppConfig> {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_IMPORT_BYTES) {
    throw new Error('Arquivo de configuração inválido.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Arquivo de configuração inválido.')
  }
  const updates = await validateConfigUpdates(parsed)
  const filePath = getConfigPath()
  try {
    const current = await fs.readFile(filePath, 'utf-8')
    await fs.writeFile(`${filePath}.bak`, current, 'utf-8')
  } catch {
    // Sem backup quando ainda não há arquivo anterior.
  }
  return saveConfig(updates)
}
