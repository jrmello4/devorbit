/**
 * API-key storage for ai-usagebar.
 *
 * Uses Electron safeStorage (Windows DPAPI, macOS Keychain, Linux Secret
 * Service) for per-vendor encryption at rest under the supplied userData.
 * No plaintext fallback: throws if safeStorage is unavailable.
 *
 * - Validates vendor IDs and env key names against a catalog.
 * - Never logs or returns raw API key values.
 * - Provides ephemeral environment overlay for process calls.
 *
 * All types are local; the upstream contract (ai-usagebar-contract.ts) is
 * never edited. Catalog validation uses structural typing against the
 * upstream AiUsagebarVendor shape (id + env).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AiUsagebarVendorCatalog } from '../shared/ai-usagebar-contract'

// ---------------------------------------------------------------------------
// Local types (not in upstream contract)
// ---------------------------------------------------------------------------

export interface AiUsagebarSecretsConfig {
  /** Absolute path to userData directory for persistent encrypted storage. */
  userDataPath: string
}

export type AiUsagebarSecretStatus = 'configured' | 'not_configured' | 'no_encryption'

export interface AiUsagebarSecretsStatus {
  vendorId: string
  envKey: string
  status: AiUsagebarSecretStatus
}

export interface AiUsagebarAsyncLock {
  withLock<T>(fn: () => Promise<T>): Promise<T>
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SECRETS_FILE_NAME = 'ai-usagebar-secrets.json'
const SECRETS_VERSION = 1
const MAX_KEY_LENGTH = 512

// ---------------------------------------------------------------------------
// safeStorage abstraction (injectable for tests)
// ---------------------------------------------------------------------------

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

function getDefaultSafeStorage(): SafeStorageLike | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { safeStorage?: SafeStorageLike }
    const storage = electron?.safeStorage
    if (!storage || typeof storage.isEncryptionAvailable !== 'function') return undefined
    return storage.isEncryptionAvailable() ? storage : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Encrypted store format
// ---------------------------------------------------------------------------

interface EncryptedStore {
  version: number
  encrypted: boolean
  /** Vendor ID → base64-encoded encrypted API key. */
  data: Record<string, string>
}

function getStorePath(userDataPath: string): string {
  return path.join(userDataPath, SECRETS_FILE_NAME)
}

function sanitizeVendorData(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, val] of Object.entries(value)) {
    if (typeof key === 'string' && typeof val === 'string' && key.length > 0 && key.length <= 120) {
      result[key] = val
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Catalog validation (structural matching against upstream vendor shape)
// ---------------------------------------------------------------------------

interface VendorWithEnv {
  id: string
  env: string
}

function isVendorWithEnv(vendor: unknown): vendor is VendorWithEnv {
  return typeof vendor === 'object' && vendor !== null
    && typeof (vendor as Record<string, unknown>).id === 'string'
    && ((vendor as Record<string, unknown>).id as string).trim().length > 0
    && typeof (vendor as Record<string, unknown>).env === 'string'
    && ((vendor as Record<string, unknown>).env as string).trim().length > 0
}

function isValidCatalog(catalog: AiUsagebarVendorCatalog): boolean {
  if (!catalog || !Array.isArray(catalog.vendors)) return false
  return catalog.vendors.every(
    (v) => typeof v === 'object' && v !== null
      && typeof (v as Record<string, unknown>).id === 'string'
      && ((v as Record<string, unknown>).id as string).trim().length > 0,
  )
}

function validateVendor(
  vendorId: string,
  envKey: string,
  catalog: AiUsagebarVendorCatalog,
): { valid: boolean; error?: string } {
  if (!isValidCatalog(catalog)) {
    return { valid: false, error: 'Invalid vendor catalog.' }
  }
  const entry = catalog.vendors.find(
    (v): v is typeof v & VendorWithEnv => isVendorWithEnv(v) && v.id === vendorId,
  )
  if (!entry) {
    return { valid: false, error: `Unknown vendor ID: ${vendorId}` }
  }
  if (entry.env !== envKey) {
    return { valid: false, error: `Env key mismatch for ${vendorId}: expected ${entry.env}, got ${envKey}` }
  }
  return { valid: true }
}

// ---------------------------------------------------------------------------
// Secrets store
// ---------------------------------------------------------------------------

export interface AiUsagebarSecretsStore {
  /** Persist an API key for a vendor. Throws if encryption unavailable. */
  setSecret(vendorId: string, envKey: string, apiKey: string, catalog: AiUsagebarVendorCatalog): Promise<void>
  /** Remove a vendor's stored API key. */
  removeSecret(vendorId: string): Promise<void>
  /** Status of all configured vendors (never returns actual keys). */
  getSecretsStatus(catalog: AiUsagebarVendorCatalog): Promise<AiUsagebarSecretsStatus[]>
  /**
   * Build an ephemeral environment overlay for process calls.
   * Returns only env vars for vendors that have stored keys.
   * Never logs or returns the raw key values.
   */
  getEnvOverlay(catalog: AiUsagebarVendorCatalog): Promise<Record<string, string>>
  /** Lock to serialize concurrent operations. */
  readonly lock: AiUsagebarAsyncLock
}

function createLock(): AiUsagebarAsyncLock {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    withLock<T>(fn: () => Promise<T>): Promise<T> {
      const run = tail.then(() => fn(), () => fn())
      tail = run.then(() => undefined, () => undefined)
      return run
    },
  }
}

export function createAiUsagebarSecretsStore(
  config: AiUsagebarSecretsConfig,
  safeStorageOverride?: SafeStorageLike,
): AiUsagebarSecretsStore {
  const storePath = getStorePath(config.userDataPath)
  const lock = createLock()

  let resolvedStorage: SafeStorageLike | undefined
  let storageChecked = false

  function getStorage(): SafeStorageLike {
    if (storageChecked) {
      if (!resolvedStorage) throw new Error('Encryption unavailable: safeStorage is not available on this platform.')
      return resolvedStorage
    }
    storageChecked = true
    const candidate = safeStorageOverride ?? getDefaultSafeStorage()
    if (!candidate) throw new Error('Encryption unavailable: safeStorage is not available on this platform.')
    if (!candidate.isEncryptionAvailable()) throw new Error('Encryption unavailable: safeStorage reports encryption is not available.')
    resolvedStorage = candidate
    return resolvedStorage
  }

  async function readStore(): Promise<Record<string, string>> {
    let content: string
    try {
      content = await fs.readFile(storePath, 'utf8')
    } catch {
      return {}
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return {}
    }

    if (typeof parsed !== 'object' || parsed === null) return {}
    const store = parsed as Record<string, unknown>
    if (typeof store.encrypted !== 'boolean' || !store.encrypted) return {}
    if (typeof store.data !== 'object' || store.data === null) return {}

    const storage = getStorage()
    const decrypted: Record<string, string> = {}
    const raw = sanitizeVendorData(store.data)
    for (const [vendorId, encryptedBase64] of Object.entries(raw)) {
      try {
        const encrypted = Buffer.from(encryptedBase64, 'base64')
        if (encrypted.length === 0) continue
        decrypted[vendorId] = storage.decryptString(encrypted)
      } catch {
        // Corrupted entry for this vendor; skip silently.
      }
    }
    return decrypted
  }

  async function writeStore(data: Record<string, string>): Promise<void> {
    const storage = getStorage()
    const encrypted: Record<string, string> = {}
    for (const [vendorId, plainValue] of Object.entries(data)) {
      encrypted[vendorId] = Buffer.from(storage.encryptString(plainValue)).toString('base64')
    }

    const store: EncryptedStore = {
      version: SECRETS_VERSION,
      encrypted: true,
      data: encrypted,
    }

    await fs.mkdir(path.dirname(storePath), { recursive: true })
    const tempFile = `${storePath}.${process.pid}.${Date.now()}.tmp`
    let renamed = false
    try {
      await fs.writeFile(tempFile, JSON.stringify(store, null, 2), 'utf8')
      await fs.rename(tempFile, storePath)
      renamed = true
    } finally {
      if (!renamed) await fs.rm(tempFile, { force: true }).catch(() => undefined)
    }
  }

  return {
    lock,

    async setSecret(
      vendorId: string,
      envKey: string,
      apiKey: string,
      catalog: AiUsagebarVendorCatalog,
    ): Promise<void> {
      if (typeof vendorId !== 'string' || vendorId.trim().length === 0) throw new Error('Vendor ID required.')
      if (typeof envKey !== 'string' || envKey.trim().length === 0) throw new Error('Env key required.')
      if (typeof apiKey !== 'string' || apiKey.trim().length === 0) throw new Error('API key required.')
      if (apiKey.length > MAX_KEY_LENGTH) throw new Error('API key exceeds maximum length.')

      const validation = validateVendor(vendorId, envKey, catalog)
      if (!validation.valid) throw new Error(validation.error)

      await lock.withLock(async () => {
        const current = await readStore()
        current[vendorId] = apiKey
        await writeStore(current)
      })
    },

    async removeSecret(vendorId: string): Promise<void> {
      await lock.withLock(async () => {
        const current = await readStore()
        delete current[vendorId]
        await writeStore(current)
      })
    },

    async getSecretsStatus(catalog: AiUsagebarVendorCatalog): Promise<AiUsagebarSecretsStatus[]> {
      const storageAvailable = (() => {
        try {
          getStorage()
          return true
        } catch {
          return false
        }
      })()

      const results: AiUsagebarSecretsStatus[] = []

      if (!storageAvailable) {
        for (const vendor of catalog.vendors) {
          if (isVendorWithEnv(vendor)) {
            results.push({ vendorId: vendor.id, envKey: vendor.env, status: 'no_encryption' })
          }
        }
        return results
      }

      const stored = await lock.withLock(() => readStore())
      for (const vendor of catalog.vendors) {
        if (!isVendorWithEnv(vendor)) continue
        const hasKey = typeof stored[vendor.id] === 'string' && stored[vendor.id].length > 0
        results.push({
          vendorId: vendor.id,
          envKey: vendor.env,
          status: hasKey ? 'configured' : 'not_configured',
        })
      }
      return results
    },

    async getEnvOverlay(catalog: AiUsagebarVendorCatalog): Promise<Record<string, string>> {
      const stored = await lock.withLock(() => readStore())
      const overlay: Record<string, string> = {}
      for (const vendor of catalog.vendors) {
        if (!isVendorWithEnv(vendor)) continue
        const key = stored[vendor.id]
        if (typeof key === 'string' && key.length > 0) {
          overlay[vendor.env] = key
        }
      }
      return overlay
    },
  }
}
