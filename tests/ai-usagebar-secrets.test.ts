import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAiUsagebarSecretsStore } from '../src/main/ai-usagebar-secrets'
import type { SafeStorageLike } from '../src/main/ai-usagebar-secrets'
import type { AiUsagebarVendorCatalog } from '../src/shared/ai-usagebar-contract'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

async function setupUserData(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-usagebar-secrets-'))
  temporaryDirectories.push(root)
  return root
}

function createMockSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => {
      const buf = Buffer.from(value, 'utf8')
      const reversed = Buffer.alloc(buf.length)
      for (let i = 0; i < buf.length; i++) reversed[i] = buf[buf.length - 1 - i]
      return reversed
    },
    decryptString: (value: Buffer) => {
      const reversed = Buffer.alloc(value.length)
      for (let i = 0; i < value.length; i++) reversed[i] = value[value.length - 1 - i]
      return reversed.toString('utf8')
    },
  }
}

const TEST_CATALOG: AiUsagebarVendorCatalog = {
  vendors: [
    { id: 'openai', name: 'OpenAI', env: 'OPENAI_API_KEY' },
    { id: 'anthropic', name: 'Anthropic', env: 'ANTHROPIC_API_KEY' },
  ],
}

describe('createAiUsagebarSecretsStore', () => {
  it('throws when safeStorage is unavailable', async () => {
    const root = await setupUserData()
    const unavailableSafeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
    }
    const store = createAiUsagebarSecretsStore(
      { userDataPath: root },
      unavailableSafeStorage,
    )

    await expect(
      store.setSecret('openai', 'OPENAI_API_KEY', 'sk-test', TEST_CATALOG),
    ).rejects.toThrow('Encryption unavailable')
  })

  it('sets and retrieves a secret via env overlay', async () => {
    const root = await setupUserData()
    const mockStorage = createMockSafeStorage()
    const store = createAiUsagebarSecretsStore({ userDataPath: root }, mockStorage)

    await store.setSecret('openai', 'OPENAI_API_KEY', 'sk-test-key-12345', TEST_CATALOG)

    const overlay = await store.getEnvOverlay(TEST_CATALOG)
    expect(overlay).toEqual({ OPENAI_API_KEY: 'sk-test-key-12345' })
  })

  it('never returns plaintext in status', async () => {
    const root = await setupUserData()
    const mockStorage = createMockSafeStorage()
    const store = createAiUsagebarSecretsStore({ userDataPath: root }, mockStorage)

    await store.setSecret('openai', 'OPENAI_API_KEY', 'sk-secret-key', TEST_CATALOG)

    const status = await store.getSecretsStatus(TEST_CATALOG)
    expect(status).toEqual([
      { vendorId: 'openai', envKey: 'OPENAI_API_KEY', status: 'configured' },
      { vendorId: 'anthropic', envKey: 'ANTHROPIC_API_KEY', status: 'not_configured' },
    ])
  })

  it('removes a secret', async () => {
    const root = await setupUserData()
    const mockStorage = createMockSafeStorage()
    const store = createAiUsagebarSecretsStore({ userDataPath: root }, mockStorage)

    await store.setSecret('openai', 'OPENAI_API_KEY', 'sk-key', TEST_CATALOG)
    await store.removeSecret('openai')

    const overlay = await store.getEnvOverlay(TEST_CATALOG)
    expect(overlay).toEqual({})
  })

  it('validates vendor ID exists in catalog', async () => {
    const root = await setupUserData()
    const mockStorage = createMockSafeStorage()
    const store = createAiUsagebarSecretsStore({ userDataPath: root }, mockStorage)

    await expect(
      store.setSecret('nonexistent', 'FAKE_KEY', 'value', TEST_CATALOG),
    ).rejects.toThrow('Unknown vendor ID')
  })

  it('validates env key matches catalog entry', async () => {
    const root = await setupUserData()
    const mockStorage = createMockSafeStorage()
    const store = createAiUsagebarSecretsStore({ userDataPath: root }, mockStorage)

    await expect(
      store.setSecret('openai', 'WRONG_ENV_KEY', 'value', TEST_CATALOG),
    ).rejects.toThrow('Env key mismatch')
  })

  it('rejects empty API key', async () => {
    const root = await setupUserData()
    const mockStorage = createMockSafeStorage()
    const store = createAiUsagebarSecretsStore({ userDataPath: root }, mockStorage)

    await expect(
      store.setSecret('openai', 'OPENAI_API_KEY', '', TEST_CATALOG),
    ).rejects.toThrow('API key required')
  })

  it('rejects oversized API key', async () => {
    const root = await setupUserData()
    const mockStorage = createMockSafeStorage()
    const store = createAiUsagebarSecretsStore({ userDataPath: root }, mockStorage)

    await expect(
      store.setSecret('openai', 'OPENAI_API_KEY', 'x'.repeat(600), TEST_CATALOG),
    ).rejects.toThrow('maximum length')
  })

  it('persists encrypted data to disk', async () => {
    const root = await setupUserData()
    const mockStorage = createMockSafeStorage()
    const store = createAiUsagebarSecretsStore({ userDataPath: root }, mockStorage)

    await store.setSecret('openai', 'OPENAI_API_KEY', 'sk-persist', TEST_CATALOG)

    const storePath = path.join(root, 'ai-usagebar-secrets.json')
    const raw = await fs.readFile(storePath, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.version).toBe(1)
    expect(parsed.encrypted).toBe(true)
    expect(typeof parsed.data.openai).toBe('string')
    expect(parsed.data.openai).not.toContain('sk-persist')
  })

  it('loads persisted secrets on new store instance', async () => {
    const root = await setupUserData()
    const mockStorage = createMockSafeStorage()
    const store1 = createAiUsagebarSecretsStore({ userDataPath: root }, mockStorage)
    await store1.setSecret('openai', 'OPENAI_API_KEY', 'sk-reload', TEST_CATALOG)

    const store2 = createAiUsagebarSecretsStore({ userDataPath: root }, mockStorage)
    const overlay = await store2.getEnvOverlay(TEST_CATALOG)
    expect(overlay).toEqual({ OPENAI_API_KEY: 'sk-reload' })
  })

  it('returns no_encryption status when safeStorage unavailable', async () => {
    const root = await setupUserData()
    const unavailableSafeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
    }
    const store = createAiUsagebarSecretsStore({ userDataPath: root }, unavailableSafeStorage)

    const status = await store.getSecretsStatus(TEST_CATALOG)
    expect(status).toEqual([
      { vendorId: 'openai', envKey: 'OPENAI_API_KEY', status: 'no_encryption' },
      { vendorId: 'anthropic', envKey: 'ANTHROPIC_API_KEY', status: 'no_encryption' },
    ])
  })

  it('returns empty env overlay when no secrets stored', async () => {
    const root = await setupUserData()
    const mockStorage = createMockSafeStorage()
    const store = createAiUsagebarSecretsStore({ userDataPath: root }, mockStorage)

    const overlay = await store.getEnvOverlay(TEST_CATALOG)
    expect(overlay).toEqual({})
  })

  it('validates against invalid catalog', async () => {
    const root = await setupUserData()
    const mockStorage = createMockSafeStorage()
    const store = createAiUsagebarSecretsStore({ userDataPath: root }, mockStorage)

    await expect(
      store.setSecret('openai', 'OPENAI_API_KEY', 'val', { vendors: [{ name: 'no-id' }] as never[] }),
    ).rejects.toThrow('Invalid vendor catalog')
  })

  it('serializes concurrent writes via lock', async () => {
    const root = await setupUserData()
    const mockStorage = createMockSafeStorage()
    const store = createAiUsagebarSecretsStore({ userDataPath: root }, mockStorage)

    await Promise.all([
      store.setSecret('openai', 'OPENAI_API_KEY', 'key1', TEST_CATALOG),
      store.setSecret('anthropic', 'ANTHROPIC_API_KEY', 'key2', TEST_CATALOG),
    ])

    const overlay = await store.getEnvOverlay(TEST_CATALOG)
    expect(overlay.OPENAI_API_KEY).toBe('key1')
    expect(overlay.ANTHROPIC_API_KEY).toBe('key2')
  })

  it('overwrites previous secret for same vendor', async () => {
    const root = await setupUserData()
    const mockStorage = createMockSafeStorage()
    const store = createAiUsagebarSecretsStore({ userDataPath: root }, mockStorage)

    await store.setSecret('openai', 'OPENAI_API_KEY', 'old-key', TEST_CATALOG)
    await store.setSecret('openai', 'OPENAI_API_KEY', 'new-key', TEST_CATALOG)

    const overlay = await store.getEnvOverlay(TEST_CATALOG)
    expect(overlay).toEqual({ OPENAI_API_KEY: 'new-key' })
  })

  it('skips vendors without env field in catalog', async () => {
    const root = await setupUserData()
    const mockStorage = createMockSafeStorage()
    const store = createAiUsagebarSecretsStore({ userDataPath: root }, mockStorage)

    const catalogWithMissingEnv: AiUsagebarVendorCatalog = {
      vendors: [
        { id: 'openai', name: 'OpenAI', env: 'OPENAI_API_KEY' },
        { id: 'noenv', name: 'No Env' },
      ],
    }

    await store.setSecret('openai', 'OPENAI_API_KEY', 'sk-ok', catalogWithMissingEnv)

    const overlay = await store.getEnvOverlay(catalogWithMissingEnv)
    expect(overlay).toEqual({ OPENAI_API_KEY: 'sk-ok' })

    const status = await store.getSecretsStatus(catalogWithMissingEnv)
    expect(status).toHaveLength(1)
    expect(status[0].vendorId).toBe('openai')

    await expect(
      store.setSecret('noenv', 'NOENV_KEY', 'val', catalogWithMissingEnv),
    ).rejects.toThrow('Unknown vendor ID')
  })
})
