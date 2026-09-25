/**
 * Account sync: maps DevOrbit Codex CODEX_HOME-derived auth.json paths into
 * upstream [[openai.accounts]] entries for ai-usagebar.
 *
 * Rules:
 * - Never copies token contents; only codex_auth_path is recorded.
 * - Never passes active CODEX_HOME to ai-usagebar.
 * - Handles 1/2/3 generic profiles; missing/invalid auth reported distinctly.
 * - show_default_account=false; stable labels; preserves all other TOML keys.
 * - Exported async lock serializes refresh_token rotation across callers.
 *
 * All types are local; the upstream contract (ai-usagebar-contract.ts) is
 * never edited.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getAuthFilePaths } from './account-profiles'
import { sharedConfigWriteLock, type ConfigWriteLock } from './ai-usagebar-config-lock'

// ---------------------------------------------------------------------------
// Local types (not in upstream contract)
// ---------------------------------------------------------------------------

export interface AiUsagebarAccountEntry {
  /** codex_auth_path — absolute path to the auth.json file, never CODEX_HOME. */
  codex_auth_path: string
  /** Stable human label (e.g. 'DevOrbit Account 1'). */
  label: string
}

export type AiUsagebarAccountSyncStatus = 'ok' | 'missing_auth' | 'invalid_auth'

export interface AiUsagebarAccountSyncResult {
  profiles: AiUsagebarAccountEntry[]
  status: AiUsagebarAccountSyncStatus
  errors: string[]
}

export interface AiUsagebarAccountSyncConfig {
  /** Absolute path to the TOML config file to read/modify. */
  configPath: string
  /** Home directory override (default: os.homedir()). */
  homeDirectory?: string
  /** Environment override (default: process.env). */
  env?: NodeJS.ProcessEnv
  /** Max DevOrbit profiles to write (1-3). */
  maxProfiles?: number
  /** Explicit profile entries to sync. If omitted, derived from CODEX_HOME auth.json paths. */
  profiles?: AiUsagebarAccountEntry[]
  /** Optional path-scoped config write lock (prevents lost updates with service mutations). */
  configLock?: ConfigWriteLock
}

export interface AiUsagebarAsyncLock {
  withLock<T>(fn: () => Promise<T>): Promise<T>
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_PROFILES = 3
const AUTH_FILE_MAX_BYTES = 2 * 1024 * 1024

const MANAGED_HEADER = '# Managed by DevOrbit (ai-usagebar account sync).'
const SHOW_DEFAULT_ACCOUNT_KEY = 'show_default_account'
const OPENAI_SECTION = 'openai'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

function escapeTomlString(value: string): string {
  /* eslint-disable no-control-regex */
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\u0000-\u001f]/g, '')
  /* eslint-enable no-control-regex */
}

// ---------------------------------------------------------------------------
// Auth file validation
// ---------------------------------------------------------------------------

/**
 * Reads and validates an auth.json file. Returns true only if the file
 * contains valid JSON with a usable OAuth token structure (nested tokens
 * or top-level access_token / OPENAI_API_KEY).
 */
export async function isValidAuthFile(filePath: string): Promise<boolean> {
  let stat
  try {
    stat = await fs.stat(filePath)
  } catch {
    return false
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > AUTH_FILE_MAX_BYTES) return false

  let content: string
  try {
    content = await fs.readFile(filePath, 'utf8')
  } catch {
    return false
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return false
  }

  if (!isRecord(parsed)) return false

  const tokens = isRecord(parsed.tokens) ? parsed.tokens : undefined
  if (tokens) {
    return [tokens.access_token, tokens.refresh_token, tokens.id_token, tokens.OPENAI_API_KEY, tokens.api_key]
      .some((v) => typeof v === 'string' && v.trim().length >= 16)
  }

  return [parsed.access_token, parsed.refresh_token, parsed.id_token, parsed.OPENAI_API_KEY, parsed.api_key]
    .some((v) => typeof v === 'string' && v.trim().length >= 16)
}

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

export interface ProfileResolution {
  entry: AiUsagebarAccountEntry
  status: AiUsagebarAccountSyncStatus
  error?: string
}

async function resolveAccountProfile(
  account: 'account1' | 'account2',
  index: number,
  homeDirectory: string,
): Promise<ProfileResolution> {
  const authPaths = getAuthFilePaths(account, homeDirectory)
  const authPath = authPaths[0]
  const label = `DevOrbit Account ${index + 1}`
  const entry: AiUsagebarAccountEntry = { codex_auth_path: toPosix(authPath), label }

  const valid = await isValidAuthFile(authPath)
  if (!valid) {
    try {
      await fs.access(authPath)
      return { entry, status: 'invalid_auth', error: `${account}: auth.json exists but contains invalid data` }
    } catch {
      return { entry, status: 'missing_auth', error: `${account}: auth.json not found` }
    }
  }

  return { entry, status: 'ok' }
}

// ---------------------------------------------------------------------------
// TOML manipulation
// ---------------------------------------------------------------------------

/**
 * Strips only DevOrbit-managed [[openai.accounts]] blocks from the TOML.
 * Each managed block is identified by the MANAGED_HEADER comment immediately
 * preceding the [[openai.accounts]] line. Non-managed array-table entries
 * (user-written or third-party) are preserved.
 */
function stripManagedBlocks(content: string): string {
  const lines = content.split('\n')
  const result: string[] = []
  const removeIndices = new Set<number>()

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(MANAGED_HEADER)) continue
    if (removeIndices.has(i)) continue

    const managedIdx = i

    let nextNonComment = i + 1
    while (nextNonComment < lines.length && lines[nextNonComment].trim().startsWith('#')) {
      nextNonComment++
    }

    if (nextNonComment < lines.length && lines[nextNonComment].trim() === '[[openai.accounts]]') {
      removeIndices.add(managedIdx)
      removeIndices.add(nextNonComment)
      let j = nextNonComment + 1
      while (j < lines.length) {
        const l = lines[j]
        if (l.trim() === '' || l.trim().startsWith('#')) {
          j++
          continue
        }
        if (l.trim().startsWith('[')) break
        removeIndices.add(j)
        j++
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (removeIndices.has(i)) continue
    result.push(lines[i])
  }

  while (result.length > 0 && result[result.length - 1].trim() === '') {
    result.pop()
  }

  return result.join('\n')
}

function formatManagedBlock(profile: AiUsagebarAccountEntry): string {
  return [
    '',
    MANAGED_HEADER,
    '[[openai.accounts]]',
    `codex_auth_path = "${escapeTomlString(profile.codex_auth_path)}"`,
    `label = "${escapeTomlString(profile.label)}"`,
    '',
  ].join('\n')
}

function ensureShowDefaultAccount(content: string): string {
  const lines = content.split('\n')
  let inOpenaiSection = false
  let found = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === `[${OPENAI_SECTION}]`) {
      inOpenaiSection = true
      continue
    }
    if (inOpenaiSection && line.trim().startsWith('[')) {
      inOpenaiSection = false
      continue
    }
    if (inOpenaiSection && /^\s*show_default_account\s*=/.test(line)) {
      lines[i] = `${SHOW_DEFAULT_ACCOUNT_KEY} = false`
      found = true
      break
    }
  }

  if (!found) {
    const openaiIdx = lines.findIndex((l) => l.trim() === `[${OPENAI_SECTION}]`)
    if (openaiIdx >= 0) {
      let insertIdx = openaiIdx + 1
      while (
        insertIdx < lines.length
        && (lines[insertIdx].trim() === ''
          || lines[insertIdx].trim().startsWith('#')
          || lines[insertIdx].includes(MANAGED_HEADER))
      ) {
        insertIdx++
      }
      lines.splice(insertIdx, 0, `${SHOW_DEFAULT_ACCOUNT_KEY} = false`)
    } else {
      if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
        lines.push('')
      }
      lines.push(`[${OPENAI_SECTION}]`)
      lines.push(`${SHOW_DEFAULT_ACCOUNT_KEY} = false`)
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Atomic config write (caller must hold the configLock)
// ---------------------------------------------------------------------------

async function atomicWriteConfig(configPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`
  let renamed = false
  try {
    await fs.writeFile(temporary, content, 'utf8')
    await fs.rename(temporary, configPath)
    renamed = true
  } finally {
    if (!renamed) await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Syncs DevOrbit Codex account profiles into the given TOML config path
 * as [[openai.accounts]] entries. Only valid auth profiles are written;
 * missing/invalid profiles are reported in the result but never emitted.
 * Preserves all other config sections/keys and non-managed array-table entries.
 *
 * @returns Sync result with profiles and per-account status.
 */
export async function syncAiUsagebarAccounts(
  config: AiUsagebarAccountSyncConfig,
): Promise<AiUsagebarAccountSyncResult> {
  const lock = config.configLock ?? sharedConfigWriteLock
  return lock.withConfigLock(config.configPath, () => syncAiUsagebarAccountsInner(config))
}

async function syncAiUsagebarAccountsInner(
  config: AiUsagebarAccountSyncConfig,
): Promise<AiUsagebarAccountSyncResult> {
  const homeDirectory = config.homeDirectory ?? os.homedir()
  const env = config.env ?? process.env
  const maxProfiles = Math.min(config.maxProfiles ?? MAX_PROFILES, MAX_PROFILES)

  let existingContent = ''
  try {
    existingContent = await fs.readFile(config.configPath, 'utf8')
  } catch {
    existingContent = ''
  }

  let resolvedProfiles: ProfileResolution[]
  if (config.profiles) {
    const entries = config.profiles.slice(0, maxProfiles)
    resolvedProfiles = entries.map((entry) => ({ entry, status: 'ok' as const }))
  } else {
    const accounts: Array<'account1' | 'account2'> = ['account1', 'account2']
    resolvedProfiles = await Promise.all(
      accounts.slice(0, maxProfiles).map((account, index) => resolveAccountProfile(account, index, homeDirectory)),
    )

    const thirdAccount = env.THIRD_ACCOUNT_AUTH_PATH
    if (maxProfiles >= 3 && typeof thirdAccount === 'string' && thirdAccount.trim()) {
      const thirdPath = thirdAccount.trim()
      const valid = await isValidAuthFile(thirdPath)
      if (valid) {
        resolvedProfiles.push({
          entry: { codex_auth_path: toPosix(thirdPath), label: 'DevOrbit Account 3' },
          status: 'ok',
        })
      }
    }
  }

  const allErrors = resolvedProfiles.filter((r) => r.error).map((r) => r.error!)
  const statuses = resolvedProfiles.map((r) => r.status)

  const writtenProfiles = resolvedProfiles
    .filter((r) => r.status === 'ok')
    .map((r) => r.entry)

  if (writtenProfiles.length === 0) {
    const overallStatus: AiUsagebarAccountSyncStatus =
      statuses.every((s) => s === 'missing_auth') ? 'missing_auth' : 'invalid_auth'
    const cleaned = stripManagedBlocks(existingContent)
    const finalContent = ensureShowDefaultAccount(cleaned)
    if (finalContent !== existingContent) {
      await atomicWriteConfig(config.configPath, finalContent)
    }
    return { profiles: [], status: overallStatus, errors: allErrors }
  }

  const cleaned = stripManagedBlocks(existingContent)
  const withDefaults = ensureShowDefaultAccount(cleaned)
  const managedBlocks = writtenProfiles.map(formatManagedBlock).join('')
  const finalContent = withDefaults + managedBlocks

  if (finalContent !== existingContent) {
    await atomicWriteConfig(config.configPath, finalContent)
  }

  return {
    profiles: writtenProfiles,
    status: 'ok',
    errors: allErrors,
  }
}

/**
 * Creates an in-process async lock to serialize concurrent operations
 * that share mutable state (e.g. refresh_token rotation between
 * ai-usagebar and legacy getRealUsage).
 */
export function createAiUsagebarAsyncLock(): AiUsagebarAsyncLock {
  let tail: Promise<unknown> = Promise.resolve()

  return {
    withLock<T>(fn: () => Promise<T>): Promise<T> {
      const run = tail.then(() => fn(), () => fn())
      tail = run.then(() => undefined, () => undefined)
      return run
    },
  }
}
