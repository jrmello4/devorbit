import fs from 'node:fs/promises'
import path from 'node:path'
import type { AppConfig } from '../renderer/src/types'

export const MAX_PROJECT_DIRS = 16
export const MAX_PROJECT_DIR_LENGTH = 4096
export const MAX_CONFIG_TEXT_LENGTH = 160

export const LAUNCH_TOOLS = [
  'agy',
  'mimo',
  'brave',
  'chrome',
  'codex-desktop',
  'codex-cli',
  'vscode',
  'terminal',
  'folder',
] as const

export type LaunchToolName = (typeof LAUNCH_TOOLS)[number]
export type CodexAccount = 'account1' | 'account2'
export type UsageTarget = CodexAccount | 'antigravity'
export type WindowAction = 'minimize' | 'maximize' | 'close'

const CODEX_ACCOUNTS = ['account1', 'account2'] as const
const USAGE_TARGETS = ['account1', 'account2', 'antigravity'] as const
const WINDOW_ACTIONS = ['minimize', 'maximize', 'close'] as const
const CUSTOM_PATH_KEYS = [
  'brave',
  'chrome',
  'mimo',
  'agy',
  'codex',
  'vscode',
  'wt',
] as const

type CustomPathKey = (typeof CUSTOM_PATH_KEYS)[number]

export interface LaunchToolOptions {
  account?: CodexAccount
  url?: string
}

export interface GitInitRequest {
  branch?: string
  remoteUrl?: string
  initialCommit?: boolean
  commitMessage?: string
  push?: boolean
  confirmAllFiles?: boolean
  previewFingerprint?: string
}

export interface IpcSenderLike {
  senderFrame?: { url?: string } | null
  sender?: { getURL?: () => string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasValue<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && values.includes(value)
}

export function validateLaunchTool(value: unknown): LaunchToolName {
  if (!hasValue(LAUNCH_TOOLS, value)) {
    throw new Error('Ferramenta inválida.')
  }
  return value
}

export function validateCodexAccount(value: unknown): CodexAccount {
  if (!hasValue(CODEX_ACCOUNTS, value)) {
    throw new Error('Conta do Codex inválida.')
  }
  return value
}

export function validateUsageTarget(value: unknown): UsageTarget {
  if (!hasValue(USAGE_TARGETS, value)) {
    throw new Error('Alvo de uso inválido.')
  }
  return value
}

export function validateWindowAction(value: unknown): WindowAction {
  if (!hasValue(WINDOW_ACTIONS, value)) {
    throw new Error('Ação de janela inválida.')
  }
  return value
}

export function validateFiniteNumber(
  value: unknown,
  label: string,
  { minimum = 0, integer = false }: { minimum?: number; integer?: boolean } = {}
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    (integer && !Number.isInteger(value))
  ) {
    throw new Error(`${label} inválido.`)
  }
  return value
}

export function validateHttpsUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_PROJECT_DIR_LENGTH) {
    throw new Error('URL inválida.')
  }

  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('URL inválida.')
  }

  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('A URL deve usar HTTPS e não pode conter credenciais.')
  }

  return url.toString()
}

export function validateLaunchOptions(value: unknown): LaunchToolOptions | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('Opções de inicialização inválidas.')

  const options: LaunchToolOptions = {}
  if ('account' in value && value.account !== undefined) {
    options.account = validateCodexAccount(value.account)
  }
  if ('url' in value && value.url !== undefined) {
    options.url = validateHttpsUrl(value.url)
  }
  return options
}

function validateGitBranch(value: unknown): string {
  const branch = value === undefined ? 'main' : value
  if (typeof branch !== 'string' || !branch.trim() || branch.length > 100) {
    throw new Error('Nome de branch inválido.')
  }
  const normalized = branch.trim()
  if (
    normalized.startsWith('-') ||
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    normalized.startsWith('.') ||
    normalized.endsWith('.') ||
    normalized.includes('..') ||
    Array.from(normalized).some((character) => character.charCodeAt(0) <= 0x20) ||
    /[~^:?*[\\]/.test(normalized)
  ) {
    throw new Error('Nome de branch inválido.')
  }
  return normalized
}

export function validateGitInitOptions(value: unknown): GitInitRequest {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new Error('Opções de inicialização Git inválidas.')

  const options: GitInitRequest = {}
  if ('branch' in value && value.branch !== undefined) {
    options.branch = validateGitBranch(value.branch)
  }
  if ('remoteUrl' in value && value.remoteUrl !== undefined && value.remoteUrl !== null) {
    if (typeof value.remoteUrl !== 'string' || value.remoteUrl.trim() === '') {
      throw new Error('URL do remote inválida.')
    }
    options.remoteUrl = validateHttpsUrl(value.remoteUrl)
  }
  for (const key of ['initialCommit', 'push', 'confirmAllFiles'] as const) {
    if (key in value && value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') throw new Error(`Opção ${key} inválida.`)
      options[key] = value[key]
    }
  }
  if ('commitMessage' in value && value.commitMessage !== undefined) {
    if (typeof value.commitMessage !== 'string' || !value.commitMessage.trim() || value.commitMessage.length > 500) {
      throw new Error('Mensagem do commit inválida.')
    }
    options.commitMessage = value.commitMessage.trim()
  }
  if ('previewFingerprint' in value && value.previewFingerprint !== undefined) {
    if (
      typeof value.previewFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(value.previewFingerprint.trim())
    ) {
      throw new Error('Prévia de arquivos inválida.')
    }
    options.previewFingerprint = value.previewFingerprint.trim().toLowerCase()
  }
  return options
}

export async function canonicalizeExistingDirectory(
  value: unknown,
  label = 'Diretório'
): Promise<string> {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${label} inválido.`)
  }
  if (value.length > MAX_PROJECT_DIR_LENGTH) {
    throw new Error(`${label} muito longo.`)
  }

  let canonical: string
  try {
    canonical = await fs.realpath(path.resolve(value.trim()))
    const stats = await fs.stat(canonical)
    if (!stats.isDirectory()) throw new Error('not-directory')
  } catch {
    throw new Error(`${label} não existe ou não é uma pasta.`)
  }
  return canonical
}

export async function validateProjectDirs(value: unknown): Promise<string[]> {
  if (!Array.isArray(value)) throw new Error('Pastas de projeto inválidas.')
  if (value.length > MAX_PROJECT_DIRS) {
    throw new Error(`É permitido monitorar no máximo ${MAX_PROJECT_DIRS} pastas.`)
  }

  const result: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const canonical = await canonicalizeExistingDirectory(entry, 'Pasta de projeto')
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
    if (!seen.has(key)) {
      seen.add(key)
      result.push(canonical)
    }
  }
  return result
}

function validateConfigText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > MAX_CONFIG_TEXT_LENGTH) {
    throw new Error(`${label} inválido.`)
  }
  return value
}

function validateCustomPaths(value: unknown): AppConfig['customPaths'] {
  if (!isRecord(value)) throw new Error('Caminhos de ferramentas inválidos.')

  const customPaths: AppConfig['customPaths'] = {}
  for (const key of CUSTOM_PATH_KEYS) {
    if (!(key in value) || value[key] === undefined) continue
    const entry = value[key]
    if (typeof entry !== 'string' || entry.length > MAX_PROJECT_DIR_LENGTH || entry.includes('\0')) {
      throw new Error(`Caminho da ferramenta ${key} inválido.`)
    }
    customPaths[key] = entry.trim()
  }
  return customPaths
}

export async function validateConfigUpdates(value: unknown): Promise<Partial<AppConfig>> {
  if (!isRecord(value)) throw new Error('Configuração inválida.')

  const updates: Partial<AppConfig> = {}
  if ('projectDirs' in value) {
    updates.projectDirs = await validateProjectDirs(value.projectDirs)
  }
  if ('activeChatGptAccount' in value && value.activeChatGptAccount !== undefined) {
    updates.activeChatGptAccount = validateCodexAccount(value.activeChatGptAccount)
  }
  if ('chatGptAccount1Name' in value && value.chatGptAccount1Name !== undefined) {
    updates.chatGptAccount1Name = validateConfigText(value.chatGptAccount1Name, 'Nome da Conta 1')
  }
  if ('chatGptAccount2Name' in value && value.chatGptAccount2Name !== undefined) {
    updates.chatGptAccount2Name = validateConfigText(value.chatGptAccount2Name, 'Nome da Conta 2')
  }
  if ('customPaths' in value && value.customPaths !== undefined) {
    updates.customPaths = validateCustomPaths(value.customPaths)
  }
  return updates
}

export function isTrustedRendererUrl(value: unknown, productionUrl?: string): boolean {
  if (typeof value !== 'string') return false

  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  try {
    const actual = new URL(value)
    if (devServerUrl) {
      return actual.origin === new URL(devServerUrl).origin
    }
    if (!productionUrl) return false
    return actual.href === new URL(productionUrl).href
  } catch {
    return false
  }
}

export function assertTrustedIpcSender(event: IpcSenderLike, productionUrl?: string): void {
  const url = event.senderFrame?.url || event.sender?.getURL?.() || ''
  if (!isTrustedRendererUrl(url, productionUrl)) {
    throw new Error('Origem IPC não autorizada.')
  }
}
