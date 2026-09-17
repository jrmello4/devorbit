import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import electron from 'electron'

const { app } = electron
const execFileAsync = promisify(execFile)

export type AccountId = 'account1' | 'account2'

const AUTH_FILE_MAX_BYTES = 2 * 1024 * 1024

function getUserDataDirectory(): string {
  try {
    return app.getPath('userData')
  } catch {
    // This fallback is only useful in tests or before Electron is ready.
    return path.join(os.homedir(), '.devorbit')
  }
}

export function getCodexHome(account: AccountId, homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, account === 'account2' ? '.codex-conta2' : '.codex-conta1')
}

/**
 * Ambiente do processo Codex/PTY: a conta escolhida define o `CODEX_HOME`.
 * Contém somente o caminho do perfil — nenhum token, chave ou credencial.
 */
export function getCodexAccountEnvironment(
  account: AccountId,
  homeDirectory = os.homedir()
): NodeJS.ProcessEnv {
  return { CODEX_HOME: getCodexHome(account, homeDirectory) }
}

export function getBrowserProfileDirectory(
  account: AccountId,
  userDataDirectory = getUserDataDirectory()
): string {
  return path.join(userDataDirectory, 'browser-profiles', account)
}

export function getAccountLabel(account: AccountId, labels?: Partial<Record<AccountId, string>>): string {
  return labels?.[account] || (account === 'account2' ? 'Conta 2 (Brave)' : 'Conta 1 (Chrome)')
}

export function getAccountBrowser(account: AccountId): { name: string; executable: string } {
  return account === 'account2'
    ? { name: 'Brave', executable: 'brave.exe' }
    : { name: 'Chrome', executable: 'chrome.exe' }
}

function defaultBrowserPaths(executable: string, vendorDir: string): string[] {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files']
  const seen = new Set<string>()
  const result: string[] = []
  for (const root of roots) {
    if (!root) continue
    const candidate = path.join(root, vendorDir, executable)
    const key = candidate.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      result.push(candidate)
    }
  }
  return result
}

export function getDefaultBrowserPaths(account: AccountId): string[] {
  return account === 'account2'
    ? defaultBrowserPaths('brave.exe', path.join('BraveSoftware', 'Brave-Browser', 'Application'))
    : defaultBrowserPaths('chrome.exe', path.join('Google', 'Chrome', 'Application'))
}

async function fileExists(file: string): Promise<boolean> {
  try {
    const stats = await fs.stat(file)
    return stats.isFile()
  } catch {
    return false
  }
}

async function findOnPath(executable: string): Promise<string | null> {
  if (process.platform !== 'win32') return null
  try {
    const { stdout } = await execFileAsync('where', [executable], { windowsHide: true, timeout: 5000 })
    const first = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0]
    return first && await fileExists(first) ? first : null
  } catch {
    return null
  }
}

async function findInstalledCodexCommand(): Promise<string | null> {
  const binDirectory = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'OpenAI',
    'Codex',
    'bin'
  )

  try {
    const entries = await fs.readdir(binDirectory, { withFileTypes: true })
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const executable = path.join(binDirectory, entry.name, 'codex.exe')
          try {
            const stats = await fs.stat(executable)
            return stats.isFile() ? { executable, modifiedAt: stats.mtimeMs } : null
          } catch {
            return null
          }
        })
    )
    return candidates
      .filter((candidate): candidate is { executable: string; modifiedAt: number } => candidate !== null)
      .sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.executable || null
  } catch {
    return null
  }
}

export async function resolveCodexCommand(configuredCommand?: string): Promise<string> {
  const configured = configuredCommand?.trim()
  const isDefaultShim = !configured || configured.toLowerCase() === 'codex.cmd'

  if (!isDefaultShim && configured) {
    if (path.isAbsolute(configured)) return configured
    return await findOnPath(configured) || configured
  }

  return await findInstalledCodexCommand()
    || await findOnPath('codex.cmd')
    || 'codex.cmd'
}

export async function resolveBrowserPath(account: AccountId, customPath?: string): Promise<string | null> {
  const trimmed = customPath?.trim()
  if (trimmed && await fileExists(trimmed)) return trimmed
  for (const candidate of getDefaultBrowserPaths(account)) {
    if (await fileExists(candidate)) return candidate
  }
  return findOnPath(getAccountBrowser(account).executable)
}

export interface BrowserAvailability {
  browser: string
  path: string
  found: boolean
}

export async function checkBrowserAvailability(customPaths?: { chrome?: string; brave?: string }): Promise<Record<AccountId, BrowserAvailability>> {
  const entries: AccountId[] = ['account1', 'account2']
  const result = {} as Record<AccountId, BrowserAvailability>
  await Promise.all(entries.map(async (account) => {
    const { name } = getAccountBrowser(account)
    const custom = account === 'account2' ? customPaths?.brave : customPaths?.chrome
    const resolved = await resolveBrowserPath(account, custom)
    result[account] = { browser: name, path: resolved || custom?.trim() || getDefaultBrowserPaths(account)[0], found: resolved !== null }
  }))
  return result
}

/**
 * Auth SEMPRE no home isolado da conta escolhida. O `~/.codex` legado não é
 * mais considerado: reaproveitar o perfil anterior mascarava a troca de conta
 * (usage e login liam arquivos diferentes do PTY).
 */
export function getAuthFilePaths(account: AccountId, homeDirectory = os.homedir()): string[] {
  return [path.join(getCodexHome(account, homeDirectory), 'auth.json')]
}

export function getBrowserLaunchArgs(profileDirectory: string, url: string): string[] {
  return [
    `--user-data-dir=${profileDirectory}`,
    '--new-window',
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ]
}

export async function ensureAccountDirectories(
  account: AccountId,
  userDataDirectory?: string
): Promise<{ codexHome: string; browserProfile: string }> {
  const codexHome = getCodexHome(account)
  const browserProfile = getBrowserProfileDirectory(account, userDataDirectory)
  await Promise.all([
    fs.mkdir(codexHome, { recursive: true }),
    fs.mkdir(browserProfile, { recursive: true }),
  ])
  return { codexHome, browserProfile }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasUsableToken(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim().length < 16) return false

  // JWT access/id tokens expose an expiry in their payload. Opaque refresh
  // tokens and API keys cannot be inspected locally, so their presence is
  // still treated as usable without ever logging or returning the secret.
  const parts = value.split('.')
  if (parts.length !== 3) return true
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof payload.exp !== 'number' || payload.exp * 1000 > Date.now()
  } catch {
    return true
  }
}

/**
 * Checks the shape of Codex's auth file without exposing its token values.
 * The CLI has used both nested `tokens` and API-key based auth over time.
 */
export function isValidCodexAuthDocument(value: unknown): boolean {
  if (!isRecord(value)) return false

  const tokens = isRecord(value.tokens) ? value.tokens : undefined
  if (tokens && [tokens.access_token, tokens.refresh_token, tokens.id_token].some(hasUsableToken)) {
    return true
  }

  return [value.access_token, value.refresh_token, value.id_token, value.OPENAI_API_KEY, value.api_key]
    .some(hasUsableToken)
}

export async function hasValidCodexAuth(codexHome: string): Promise<boolean> {
  try {
    const authPath = path.join(codexHome, 'auth.json')
    const stat = await fs.stat(authPath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > AUTH_FILE_MAX_BYTES) return false
    const content = await fs.readFile(authPath, 'utf8')
    return isValidCodexAuthDocument(JSON.parse(content))
  } catch {
    return false
  }
}

export function isAuthOrReopenUrl(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return false
    return url.hostname === 'auth.openai.com' ||
      (url.hostname === 'chatgpt.com' && /(^|\/)auth(\/|$)|oauth|login/i.test(url.pathname + url.search))
  } catch {
    return false
  }
}

export function shouldTrackBrowserUsage(value: string | undefined): boolean {
  return value === undefined && !isAuthOrReopenUrl(value)
}
