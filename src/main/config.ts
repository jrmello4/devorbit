import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import electron from 'electron'
const { app } = electron
import type { AppConfig, ManagedProject, ModelRoutingConfig, ModelRoutingSecretKey } from '../renderer/src/types'
import { MODEL_ROUTING_BASE_URL_KEYS, MODEL_ROUTING_SECRET_KEYS } from '../renderer/src/types'
import { sanitizeCustomTerminalPresets } from '../shared/terminal-presets'
import {
  DEFAULT_AI_MEMORY_CONFIG,
  type AiMemoryConfig,
  type AiMemoryProjectConfig,
} from '../shared/ai-memory-contract'
import { isAgentProviderId, validateConfigUpdates } from './validation'

const MAX_IMPORT_BYTES = 1_000_000

const MAX_CONFIG_TEXT_LENGTH = 160
const MAX_CUSTOM_PATH_LENGTH = 4096
const MAX_PROJECT_DIRS = 16
const CUSTOM_PATH_KEYS = ['brave', 'chrome', 'mimo', 'agy', 'codex', 'opencode', 'opencode2', 'claude', 'gemini', 'aider', 'commandCode', 'customAgent', 'vscode', 'wt'] as const
let configOperationQueue: Promise<void> = Promise.resolve()
const CORRUPT_CONFIG_BACKUP_SUFFIX = '.corrupt.bak'
const SECRET_STORE_FILE = 'config-secrets.json'
const SECRET_STORE_VERSION = 1
const MAX_API_KEY_LENGTH = 500

/** Subconjunto tipado de `electron.safeStorage` usado para cifrar segredos. */
interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

function getSafeStorage(): SafeStorageLike | undefined {
  const storage = (electron as unknown as { safeStorage?: SafeStorageLike }).safeStorage
  if (!storage || typeof storage.isEncryptionAvailable !== 'function') return undefined
  try {
    return storage.isEncryptionAvailable() ? storage : undefined
  } catch {
    return undefined
  }
}

function isRoutingSecretKey(value: string): value is ModelRoutingSecretKey {
  return (MODEL_ROUTING_SECRET_KEYS as readonly string[]).includes(value)
}

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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function normalizeBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 300) return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  if (url.username || url.password) return undefined
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) return undefined
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * Lê chaves de API de um objeto de roteamento. `values` são chaves válidas;
 * `clears` são chaves enviadas como string vazia para remoção explícita.
 */
function readSecretInputs(value: unknown): { values: Partial<Record<ModelRoutingSecretKey, string>>; clears: ModelRoutingSecretKey[] } {
  const values: Partial<Record<ModelRoutingSecretKey, string>> = {}
  const clears: ModelRoutingSecretKey[] = []
  if (!isRecord(value)) return { values, clears }
  for (const key of MODEL_ROUTING_SECRET_KEYS) {
    if (!(key in value) || value[key] === undefined) continue
    const raw = value[key]
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (trimmed === '') {
      clears.push(key)
      continue
    }
    if (trimmed.length > MAX_API_KEY_LENGTH || /\s/.test(trimmed)) continue
    values[key] = trimmed
  }
  return { values, clears }
}

/**
 * String vazia é remoção explícita de uma URL base. Precisa ser aplicada antes
 * de `stripSecretKeys`, que descarta campos vazios e por isso não distinguiria
 * "não informado" de "limpar".
 */
function clearExplicitBaseUrls(
  base: ModelRoutingConfig | undefined,
  updates: ModelRoutingConfig | undefined,
): ModelRoutingConfig | undefined {
  const routing: ModelRoutingConfig = { ...(base ?? {}) }
  if (updates) {
    for (const key of MODEL_ROUTING_BASE_URL_KEYS) {
      if (updates[key] === '') delete routing[key]
    }
  }
  return routing
}

/** Remove segredos e flags derivadas de um roteamento destinado à persistência. */
function stripSecretKeys(routing: ModelRoutingConfig | undefined): ModelRoutingConfig | undefined {
  if (!routing) return undefined
  const result: ModelRoutingConfig = {}
  const fastModel = normalizeModelName(routing.fastModel)
  const deepModel = normalizeModelName(routing.deepModel)
  if (fastModel) result.fastModel = fastModel
  if (deepModel) result.deepModel = deepModel
  for (const key of MODEL_ROUTING_BASE_URL_KEYS) {
    const url = normalizeBaseUrl(routing[key])
    if (url) result[key] = url
  }
  return Object.keys(result).length > 0 ? result : undefined
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
  return stripSecretKeys(value as ModelRoutingConfig)
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
  const terminalPresets = sanitizeCustomTerminalPresets(source.terminalPresets)
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
    ...(terminalPresets ? { terminalPresets } : {}),
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

async function atomicallyWriteJson(file: string, value: unknown, mode?: number): Promise<void> {
  const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`
  let renamed = false

  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const handle = await fs.open(temporaryFile, 'w', mode)
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), 'utf-8')
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

function atomicallyWriteConfig(file: string, config: AppConfig): Promise<void> {
  return atomicallyWriteJson(file, config)
}

function getSecretStorePath(): string {
  return path.join(path.dirname(getConfigPath()), SECRET_STORE_FILE)
}

function sanitizeSecretRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  if (!isRecord(value)) return result
  for (const [key, entry] of Object.entries(value)) {
    if (!isRoutingSecretKey(key) || typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed || trimmed.length > MAX_API_KEY_LENGTH || /\s/.test(trimmed)) continue
    result[key] = trimmed
  }
  return result
}

interface SecretStoreRead {
  secrets: Record<string, string>
  /** Há um cofre cifrado que não pôde ser lido neste ambiente. */
  locked: boolean
}

async function readSecretStore(): Promise<SecretStoreRead> {
  let content: string
  try {
    content = await fs.readFile(getSecretStorePath(), 'utf-8')
  } catch {
    return { secrets: {}, locked: false }
  }
  try {
    const parsed: unknown = JSON.parse(content)
    if (!isRecord(parsed)) return { secrets: {}, locked: false }
    if (parsed.encrypted === true) {
      if (typeof parsed.data !== 'string') return { secrets: {}, locked: false }
      const storage = getSafeStorage()
      if (!storage) return { secrets: {}, locked: true }
      try {
        return { secrets: sanitizeSecretRecord(JSON.parse(storage.decryptString(Buffer.from(parsed.data, 'base64')))), locked: false }
      } catch {
        return { secrets: {}, locked: true }
      }
    }
    return { secrets: sanitizeSecretRecord(parsed.data), locked: false }
  } catch {
    return { secrets: {}, locked: false }
  }
}

async function writeSecretStore(secrets: Record<string, string>): Promise<void> {
  const cleaned = sanitizeSecretRecord(secrets)
  const file = getSecretStorePath()
  if (Object.keys(cleaned).length === 0) {
    await fs.rm(file, { force: true }).catch(() => undefined)
    return
  }
  const storage = getSafeStorage()
  const record = storage
    ? {
        version: SECRET_STORE_VERSION,
        encrypted: true,
        data: Buffer.from(storage.encryptString(JSON.stringify(cleaned))).toString('base64'),
      }
    : { version: SECRET_STORE_VERSION, encrypted: false, data: cleaned }
  if (!storage) {
    console.warn('[DevOrbit config] Armazenamento seguro indisponivel; credenciais BYOK foram salvas sem criptografia.')
  }
  await atomicallyWriteJson(file, record, 0o600)
}

/** Cópia destinada à persistência: sem credenciais nem flags derivadas. */
function toPersistedConfig(config: AppConfig): AppConfig {
  return { ...config, modelRouting: stripSecretKeys(config.modelRouting) }
}

/**
 * Persistência defensiva quando o cofre está ilegível: reinjeta os segredos
 * legados que só existem no config.json para que a remoção pública não os
 * apague sem uma cópia cifrada.
 */
function toPersistedConfigPreservingSecrets(
  config: AppConfig,
  secrets: Partial<Record<ModelRoutingSecretKey, string>>,
): AppConfig {
  const persisted = toPersistedConfig(config)
  const entries = Object.entries(secrets).filter(([key, value]) => isRoutingSecretKey(key) && typeof value === 'string' && value)
  if (entries.length === 0) return persisted
  const routing: ModelRoutingConfig = { ...(persisted.modelRouting ?? {}) }
  for (const [key, value] of entries) routing[key as ModelRoutingSecretKey] = value as string
  return { ...persisted, modelRouting: routing }
}

/** Injeta segredos decifrados na cópia em memória usada pelo processo main. */
function injectRoutingSecrets(config: AppConfig, secrets: Record<string, string>): AppConfig {
  const base = stripSecretKeys(config.modelRouting)
  const entries = Object.entries(secrets).filter(([key, value]) => isRoutingSecretKey(key) && Boolean(value))
  if (entries.length === 0) return { ...config, ...(base ? { modelRouting: base } : {}) }
  const routing: ModelRoutingConfig = { ...(base ?? {}) }
  for (const [key, value] of entries) routing[key as ModelRoutingSecretKey] = value
  return { ...config, modelRouting: routing }
}

/**
 * Projeção segura para o renderer: remove as chaves BYOK e publica apenas
 * booleanos `has*Key`, indicando presença sem revelar o valor.
 */
export function toSafeConfig(config: AppConfig): AppConfig {
  const routing = config.modelRouting
  if (!routing) return { ...config, customPaths: { ...config.customPaths } }
  const safe: ModelRoutingConfig = {}
  if (routing.fastModel) safe.fastModel = routing.fastModel
  if (routing.deepModel) safe.deepModel = routing.deepModel
  for (const key of MODEL_ROUTING_BASE_URL_KEYS) {
    const url = routing[key]
    if (url) safe[key] = url
  }
  if (routing.openaiApiKey) safe.hasOpenaiKey = true
  if (routing.anthropicApiKey) safe.hasAnthropicKey = true
  if (routing.geminiApiKey) safe.hasGeminiKey = true
  if (routing.deepseekApiKey) safe.hasDeepseekKey = true
  if (routing.glmApiKey) safe.hasGlmKey = true
  if (routing.kimiApiKey) safe.hasKimiKey = true
  if (routing.minimaxApiKey) safe.hasMinimaxKey = true
  if (routing.vllmApiKey) safe.hasVllmKey = true
  return { ...config, modelRouting: safe, customPaths: { ...config.customPaths } }
}

/**
 * Exporta somente pastas monitoradas que ainda existem. Os defaults dependem
 * do perfil do sistema e podem não existir em uma instalação nova; mantê-los
 * no arquivo faria a própria importação falhar na validação de diretórios.
 */
async function getExportableProjectDirs(projectDirs: string[]): Promise<string[]> {
  const result: string[] = []
  const seen = new Set<string>()
  for (const projectDir of projectDirs) {
    try {
      const stats = await fs.stat(projectDir)
      if (!stats.isDirectory()) continue
    } catch {
      continue
    }
    const key = process.platform === 'win32' ? path.resolve(projectDir).toLowerCase() : path.resolve(projectDir)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(projectDir)
  }
  return result
}

function enqueueConfigOperation<T>(operation: () => Promise<T>): Promise<T> {
  const queued = configOperationQueue.catch(() => undefined).then(operation)
  configOperationQueue = queued.then(() => undefined, () => undefined)
  return queued
}

function validateProviderRouting(value: unknown): Partial<ModelRoutingConfig> | undefined {
  if (!isRecord(value)) return undefined
  const result: Partial<ModelRoutingConfig> = {}
  for (const key of MODEL_ROUTING_SECRET_KEYS) {
    if (!(key in value) || value[key] === undefined) continue
    const raw = value[key]
    if (typeof raw !== 'string') throw new Error('Chave de API inválida.')
    const trimmed = raw.trim()
    if (trimmed === '') {
      result[key] = ''
      continue
    }
    if (trimmed.length > MAX_API_KEY_LENGTH || /\s/.test(trimmed)) throw new Error('Chave de API inválida.')
    result[key] = trimmed
  }
  for (const key of MODEL_ROUTING_BASE_URL_KEYS) {
    if (!(key in value) || value[key] === undefined) continue
    const raw = value[key]
    if (typeof raw !== 'string') throw new Error('URL base do provedor inválida.')
    const trimmed = raw.trim()
    if (trimmed === '') {
      result[key] = ''
      continue
    }
    const url = normalizeBaseUrl(trimmed)
    if (!url) throw new Error('URL base do provedor inválida.')
    result[key] = url
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * Valida atualizações de config para persistência, cobrindo os campos BYOK
 * que não vivem em agent-providers (chaves e URLs base por provedor).
 */
export async function validateConfigUpdatesForSave(value: unknown): Promise<Partial<AppConfig>> {
  const updates = await validateConfigUpdates(value)
  if (!isRecord(value) || !('modelRouting' in value) || value.modelRouting === undefined) return updates
  const providerRouting = validateProviderRouting(value.modelRouting)
  if (!providerRouting) return updates
  return { ...updates, modelRouting: { ...(updates.modelRouting ?? {}), ...providerRouting } }
}

async function readRawConfig(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8')) as unknown
  } catch {
    return undefined
  }
}

function legacySecretsFrom(raw: unknown): Partial<Record<ModelRoutingSecretKey, string>> {
  return readSecretInputs(isRecord(raw) && isRecord(raw.modelRouting) ? raw.modelRouting : undefined).values
}

export async function loadConfig(): Promise<AppConfig> {
  const filePath = getConfigPath()
  const raw = await readRawConfig(filePath)
  if (raw === undefined) {
    return enqueueConfigOperation(async () => {
      const persisted = await readPersistedConfig(filePath)
      if (persisted.shouldPersist) {
        await atomicallyWriteConfig(filePath, toPersistedConfig(persisted.config))
        if (persisted.recovery) recordConfigRecovery(persisted.recovery)
      }
      return injectRoutingSecrets(persisted.config, (await readSecretStore()).secrets)
    })
  }

  const normalized = normalizeConfig(raw)
  if (Object.keys(legacySecretsFrom(raw)).length === 0) {
    return injectRoutingSecrets(normalized, (await readSecretStore()).secrets)
  }

  /*
   * Migração em disco serializada. O segredo é relido DENTRO da fila (outro
   * load/save pode ter migrado nesse meio-tempo) e o cofre é gravado ANTES de
   * remover o texto claro do config.json — se a escrita do cofre falhar, o
   * agente vê o erro e o arquivo legado permanece intacto (sem perda).
   */
  return enqueueConfigOperation(async () => {
    const freshRaw = await readRawConfig(filePath)
    const fresh = freshRaw === undefined ? normalized : normalizeConfig(freshRaw)
    const legacy = legacySecretsFrom(freshRaw)
    const store = await readSecretStore()
    if (store.locked || Object.keys(legacy).length === 0) {
      return injectRoutingSecrets(fresh, { ...legacy, ...store.secrets })
    }
    const secrets = { ...store.secrets, ...legacy }
    await writeSecretStore(secrets)
    await atomicallyWriteConfig(filePath, toPersistedConfig(fresh))
    return injectRoutingSecrets(fresh, secrets)
  })
}

export async function saveConfig(updates: Partial<AppConfig>): Promise<AppConfig> {
  const filePath = getConfigPath()
  return enqueueConfigOperation(async () => {
    const persisted = await readPersistedConfig(filePath)
    const current = persisted.config
    if (persisted.recovery) recordConfigRecovery(persisted.recovery)

    const store = await readSecretStore()
    const secrets = { ...store.secrets }
    let legacySecrets: Partial<Record<ModelRoutingSecretKey, string>> = {}
    try {
      const raw: unknown = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      legacySecrets = readSecretInputs(isRecord(raw) && isRecord(raw.modelRouting) ? raw.modelRouting : undefined).values
      Object.assign(secrets, legacySecrets)
    } catch {
      // Sem config.json legível: nada a migrar deste arquivo.
    }
    const secretInputs = readSecretInputs(updates.modelRouting)
    const touchingSecrets = Object.keys(secretInputs.values).length > 0 || secretInputs.clears.length > 0
    if (store.locked && touchingSecrets) {
      throw new Error('Armazenamento seguro indisponível para atualizar as credenciais.')
    }
    Object.assign(secrets, secretInputs.values)
    for (const key of secretInputs.clears) delete secrets[key]

    // modelRouting funde por campo: atualizações parciais (só fastModel, por
    // exemplo) não descartam as URLs já salvas. Segredos ficam fora do arquivo.
    const publicRouting = updates.modelRouting === undefined
      ? current.modelRouting
      : stripSecretKeys(clearExplicitBaseUrls(
          { ...current.modelRouting, ...stripSecretKeys(updates.modelRouting) },
          updates.modelRouting,
        ))

    const merged = normalizeConfig({
      ...current,
      ...updates,
      customPaths: {
        ...current.customPaths,
        ...(updates.customPaths || {}),
      },
      modelRouting: publicRouting,
      // Automação também funde por campo; `undefined` explícito limpa a chave
      // (ex.: trocar o executor padrão para "nenhum").
      ...(updates.automation !== undefined
        ? { automation: { ...current.automation, ...updates.automation } }
        : current.automation !== undefined
          ? { automation: current.automation }
          : {}),
      // terminalPresets troca a lista inteira (não funde por item): editar um
      // preset é reescrever o array; `undefined` preserva o que já está salvo.
      ...(updates.terminalPresets !== undefined
        ? { terminalPresets: updates.terminalPresets }
        : current.terminalPresets !== undefined
          ? { terminalPresets: current.terminalPresets }
          : {}),
    })

    if (store.locked) {
      // Cofre ilegível: não há como cifrar agora. Preserva o texto claro legado
      // (que já estava no arquivo) para não perder a credencial.
      await atomicallyWriteConfig(filePath, toPersistedConfigPreservingSecrets(merged, legacySecrets))
    } else {
      // Cofre ANTES da remoção pública: se a escrita falhar, o config.json
      // legado permanece intacto e o segredo não se perde.
      await writeSecretStore(secrets)
      await atomicallyWriteConfig(filePath, toPersistedConfig(merged))
    }
    return injectRoutingSecrets(merged, secrets)
  })
}

export async function exportConfigJson(): Promise<string> {
  const config = toSafeConfig(await loadConfig())
  return JSON.stringify(
    { ...config, projectDirs: await getExportableProjectDirs(config.projectDirs) },
    null,
    2,
  )
}

/*
 * ---------------------------------------------------------------------------
 * ai-memory: consentimento (opt-in) e configuração por projeto.
 *
 * Persistido em um arquivo PRÓPRIO (`userData/ai-memory/config.json`) para não
 * alterar o AppConfig do renderer nem seus tipos. Desabilitado por padrão e
 * sem qualquer efeito de storage/marker quando `enabled` é falso.
 * ---------------------------------------------------------------------------
 */

const AI_MEMORY_CONFIG_DIR = 'ai-memory'
const AI_MEMORY_CONFIG_FILE = 'config.json'
const AI_MEMORY_MAX_PROJECTS = 500
const AI_MEMORY_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

function getAiMemoryConfigPath(): string {
  // Sem fallback para outro home: se o userData do Electron não está
  // disponível, a falha sobe para o chamador em vez de gravar em outro lugar.
  return path.join(app.getPath('userData'), AI_MEMORY_CONFIG_DIR, AI_MEMORY_CONFIG_FILE)
}

function normalizeAiMemoryProject(value: unknown): AiMemoryProjectConfig | undefined {
  if (!isRecord(value)) return undefined
  const identity = typeof value.identity === 'string' ? value.identity.trim() : ''
  const workspace = typeof value.workspace === 'string' ? value.workspace.trim().toLowerCase() : ''
  const project = typeof value.project === 'string' ? value.project.trim().toLowerCase() : ''
  const projectPath = typeof value.path === 'string' ? value.path.trim() : ''
  if (!identity || identity.length > 200 || identity.includes('\0')) return undefined
  if (!AI_MEMORY_NAME_PATTERN.test(workspace) || !AI_MEMORY_NAME_PATTERN.test(project)) {
    return undefined
  }
  if (!projectPath || projectPath.length > MAX_CUSTOM_PATH_LENGTH || projectPath.includes('\0')) {
    return undefined
  }
  return { identity, workspace, project, path: projectPath, enabled: value.enabled === true }
}

function normalizeAiMemoryConfig(value: unknown): AiMemoryConfig {
  const source = isRecord(value) ? value : {}
  const projects: Record<string, AiMemoryProjectConfig> = {}
  if (isRecord(source.projects)) {
    for (const entry of Object.values(source.projects).slice(0, AI_MEMORY_MAX_PROJECTS)) {
      const project = normalizeAiMemoryProject(entry)
      if (project) projects[project.identity] = project
    }
  }
  return { enabled: source.enabled === true, projects }
}

export async function loadAiMemoryConfig(): Promise<AiMemoryConfig> {
  const filePath = getAiMemoryConfigPath()
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    // Arquivo ausente é o default; qualquer outra falha é reportada.
    if (isFileNotFoundError(error)) return { ...DEFAULT_AI_MEMORY_CONFIG, projects: {} }
    throw new Error(
      `Falha ao ler a configuração do ai-memory: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  try {
    return normalizeAiMemoryConfig(JSON.parse(raw))
  } catch {
    throw new Error('Configuração do ai-memory inválida (JSON corrompido).')
  }
}

export async function saveAiMemoryConfig(updates: Partial<AiMemoryConfig>): Promise<AiMemoryConfig> {
  return enqueueConfigOperation(async () => {
    const current = await loadAiMemoryConfig()
    const merged = normalizeAiMemoryConfig({
      enabled: updates.enabled === undefined ? current.enabled : updates.enabled,
      projects:
        updates.projects === undefined ? current.projects : { ...current.projects, ...updates.projects },
    })
    await atomicallyWriteJson(getAiMemoryConfigPath(), merged)
    return merged
  })
}

export async function setAiMemoryProjectEnabled(
  entry: AiMemoryProjectConfig,
  enabled: boolean
): Promise<AiMemoryConfig> {
  const project = normalizeAiMemoryProject({ ...entry, enabled })
  if (!project) throw new Error('Configuração de projeto ai-memory inválida.')
  // Habilitar um projeto SEMPRE liga o gate global em um único update atômico.
  // O default `enabled: false` impedia o sidecar de subir após one-click opt-in.
  // Desabilitar um projeto NÃO desliga o gate: o usuário controla o global
  // explicitamente; desabilitar o último projeto é seguro (sidecar fica no-op).
  return saveAiMemoryConfig({
    ...(enabled ? { enabled: true } : {}),
    projects: { [project.identity]: project },
  })
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
  const updates = await validateConfigUpdatesForSave(parsed)
  const filePath = getConfigPath()
  try {
    const current = await fs.readFile(filePath, 'utf-8')
    await fs.writeFile(`${filePath}.bak`, current, 'utf-8')
  } catch {
    // Sem backup quando ainda não há arquivo anterior.
  }
  return saveConfig(updates)
}
