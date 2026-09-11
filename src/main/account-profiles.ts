import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import electron from 'electron'

const { app } = electron

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

export function getBrowserProfileDirectory(
  account: AccountId,
  userDataDirectory = getUserDataDirectory()
): string {
  return path.join(userDataDirectory, 'browser-profiles', account)
}

export function getAccountLabel(account: AccountId, labels?: Partial<Record<AccountId, string>>): string {
  return labels?.[account] || (account === 'account2' ? 'Conta 2 (Brave)' : 'Conta 1 (Chrome)')
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
