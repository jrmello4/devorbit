import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import electron from 'electron'
const { app } = electron
import type { AppConfig, ManagedProject } from '../renderer/src/types'
import { isAgentProviderId, validateConfigUpdates } from './validation'

const MAX_IMPORT_BYTES = 1_000_000

const MAX_CONFIG_TEXT_LENGTH = 160
const MAX_CUSTOM_PATH_LENGTH = 4096
const MAX_PROJECT_DIRS = 16
const CUSTOM_PATH_KEYS = ['brave', 'chrome', 'mimo', 'agy', 'codex', 'opencode', 'claude', 'gemini', 'aider', 'customAgent', 'vscode', 'wt'] as const
let configOperationQueue: Promise<void> = Promise.resolve()
const CORRUPT_CONFIG_BACKUP_SUFFIX = '.corrupt.bak'

export type ConfigRecoveryState = {
  recovered: true
  reason: 'invalid-json' | 'unreadable'
  backupPath: string
}

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

let lastConfigRecoveryState: ConfigRecoveryState | null = null

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

function normalizeModelName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 200 || /[\s"']/.test(trimmed)) return undefined
  return trimmed
}

function normalizeModelApiKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 500 || /\s/.test(trimmed)) return undefined
  return trimmed
}

function normalizeAutomation(value: unknown): AppConfig['automation'] {
  if (!isRecord(value)) return undefined
  const result: NonNullable<AppConfig['automation']> = {}
  if (isAgentProviderId(value.defaultExecutor)) result.defaultExecutor = value.defaultExecutor
  if (value.defaultCodexAccount === 'account1' || value.defaultCodexAccount === 'account2') {
    result.defaultCodexAccount = value.defaultCodexAccount
  }
  if (value.autoStartExecutor === true) result.autoStartExecutor = true
  if (value.restoreWorkspace === true) result.restoreWorkspace = true
  const restoreProjectId = safeText(value.restoreProjectId, '').trim()
  if (restoreProjectId) result.restoreProjectId = restoreProjectId
  return Object.keys(result).length > 0 ? result : undefined
}

function normalizeModelRouting(value: unknown): AppConfig['modelRouting'] {
  if (!isRecord(value)) return undefined
  const result: NonNullable<AppConfig['modelRouting']> = {}
  const fastModel = normalizeModelName(value.fastModel)
  const deepModel = normalizeModelName(value.deepModel)
  const openaiApiKey = normalizeModelApiKey(value.openaiApiKey)
  const anthropicApiKey = normalizeModelApiKey(value.anthropicApiKey)
  if (fastModel) result.fastModel = fastModel
  if (deepModel) result.deepModel = deepModel
  if (openaiApiKey) result.openaiApiKey = openaiApiKey
  if (anthropicApiKey) result.anthropicApiKey = anthropicApiKey
  return Object.keys(result).length > 0 ? result : undefined
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

  const modelRouting = normalizeModelRouting(source.modelRouting)
  const automation = normalizeAutomation(source.automation)
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
    ...(modelRouting ? { modelRouting } : {}),
    ...(automation ? { automation } : {}),
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

function getCorruptConfigBackupPath(filePath: string): string {
  return `${filePath}${CORRUPT_CONFIG_BACKUP_SUFFIX}`
}

function isFileNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

async function preserveCorruptConfig(filePath: string): Promise<string> {
  const backupPath = getCorruptConfigBackupPath(filePath)
  try {
    await fs.copyFile(filePath, backupPath)
  } catch {
    throw new Error('Nao foi possivel preservar a configuracao invalida antes da recuperacao segura.')
  }
  return backupPath
}

type PersistedConfigResult = {
  config: AppConfig
  shouldPersist: boolean
  recovery?: Omit<ConfigRecoveryState, 'recovered'>
}

async function readPersistedConfig(filePath: string): Promise<PersistedConfigResult> {
  lastConfigRecoveryState = null

  let content: string
  try {
    content = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return { config: normalizeConfig(defaultConfig), shouldPersist: true }
    }

    const backupPath = await preserveCorruptConfig(filePath)
    return {
      config: normalizeConfig(defaultConfig),
      shouldPersist: true,
      recovery: { reason: 'unreadable', backupPath },
    }
  }

  try {
    return { config: normalizeConfig(JSON.parse(content)), shouldPersist: false }
  } catch {
    const backupPath = await preserveCorruptConfig(filePath)
    return {
      config: normalizeConfig(defaultConfig),
      shouldPersist: true,
      recovery: { reason: 'invalid-json', backupPath },
    }
  }
}

function recordConfigRecovery(recovery: Omit<ConfigRecoveryState, 'recovered'>): void {
  lastConfigRecoveryState = { recovered: true, ...recovery }
  const reason = recovery.reason === 'invalid-json' ? 'JSON invalido' : 'arquivo ilegivel'
  console.warn(
    `[DevOrbit config] Recuperacao concluida: ${reason} preservado antes da gravacao dos defaults.`
  )
}

export function getConfigRecoveryState(): ConfigRecoveryState | null {
  return lastConfigRecoveryState ? { ...lastConfigRecoveryState } : null
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
      const persisted = await readPersistedConfig(filePath)
      if (persisted.shouldPersist) {
        await atomicallyWriteConfig(filePath, persisted.config)
        if (persisted.recovery) recordConfigRecovery(persisted.recovery)
      }
      return persisted.config
    })
  }
}

export async function saveConfig(updates: Partial<AppConfig>): Promise<AppConfig> {
  const filePath = getConfigPath()
  return enqueueConfigOperation(async () => {
    const persisted = await readPersistedConfig(filePath)
    const current = persisted.config
    if (persisted.recovery) recordConfigRecovery(persisted.recovery)

    const merged = normalizeConfig({
      ...current,
      ...updates,
      customPaths: {
        ...current.customPaths,
        ...(updates.customPaths || {}),
      },
      // modelRouting funde por campo como customPaths: atualizações parciais
      // (só fastModel, por exemplo) não descartam as chaves já salvas.
      ...(updates.modelRouting !== undefined
        ? { modelRouting: { ...current.modelRouting, ...updates.modelRouting } }
        : current.modelRouting !== undefined
          ? { modelRouting: current.modelRouting }
          : {}),
      // Automação também funde por campo; `undefined` explícito limpa a chave
      // (ex.: trocar o executor padrão para "nenhum").
      ...(updates.automation !== undefined
        ? { automation: { ...current.automation, ...updates.automation } }
        : current.automation !== undefined
          ? { automation: current.automation }
          : {}),
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
