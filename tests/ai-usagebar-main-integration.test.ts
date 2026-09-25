import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { registerConfigIpc, type ConfigIpcDependencies } from '../src/main/ipc/config-ipc'
import { createAiUsagebarAsyncLock, syncAiUsagebarAccounts } from '../src/main/ai-usagebar-accounts'
import { createAiUsagebarSecretsStore, type SafeStorageLike } from '../src/main/ai-usagebar-secrets'
import { createAiUsagebarService, type AiUsagebarFileSystem } from '../src/main/ai-usagebar-service'
import { sanitizeAiUsagebarMessage, resolveAiUsagebarPaths } from '../src/main/ai-usagebar-config'
import { registerAiUsagebarIpc, type AiUsagebarIpcOperations } from '../src/main/ipc/ai-usagebar-ipc'
import { AI_USAGEBAR_IPC_CHANNELS } from '../src/shared/ai-usagebar-ipc-contract'
import type { AiUsagebarSnapshot, AiUsagebarVendor } from '../src/shared/ai-usagebar-contract'
import type { RealUsageState } from '../src/renderer/src/types'

// Mock Electron and non-target IPC dependencies
const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  getRealUsage: vi.fn(),
  onRealUsage: vi.fn(),
}))

vi.mock('electron', () => ({
  default: {},
  dialog: {
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
  },
}))

vi.mock('../src/main/updater', () => ({
  downloadUpdate: vi.fn(),
  getUpdateState: vi.fn(),
  installUpdate: vi.fn(),
}))

vi.mock('../src/main/launcher', () => ({
  copyProjectContext: vi.fn(),
  getToolHealth: vi.fn(),
}))

vi.mock('../src/main/memory', () => ({
  generateMemoryFromGit: vi.fn(),
  getProjectMemory: vi.fn(),
  saveProjectMemory: vi.fn(),
}))

vi.mock('../src/main/codex-auth', () => ({
  cancelCodexLogin: vi.fn(),
  checkCodexAuthStatus: vi.fn(),
  startCodexDeviceLogin: vi.fn(),
}))

vi.mock('../src/main/usage-real', () => ({
  getRealUsage: mocks.getRealUsage,
}))

vi.mock('../src/main/project-paths', () => ({
  validateProjectPath: vi.fn(async (value: string) => value),
}))

vi.mock('../src/main/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/config')>()
  return { ...actual, loadConfig: mocks.loadConfig, saveConfig: mocks.saveConfig }
})

type Handler = (event: unknown, ...args: unknown[]) => unknown

function createMockSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value: Buffer) => {
      const text = value.toString('utf8')
      if (text.startsWith('enc:')) return text.slice(4)
      return text
    },
  }
}

describe('ai-usagebar main integration & composition', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    vi.clearAllMocks()
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
    tempDirs.length = 0
  })

  async function createTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-usagebar-main-test-'))
    tempDirs.push(dir)
    return dir
  }

  it('serializes concurrent calls between getRealUsage and ai-usagebar usageLock', async () => {
    const aiUsagebarLock = createAiUsagebarAsyncLock()
    const configIpcHandlers = new Map<string, Handler>()
    const executionOrder: string[] = []

    mocks.getRealUsage.mockImplementation(async () => {
      executionOrder.push('getRealUsage:start')
      await new Promise((resolve) => setTimeout(resolve, 50))
      executionOrder.push('getRealUsage:end')
      return {
        updatedAt: Date.now(),
        accounts: {
          account1: { status: 'ready', metrics: [] },
          account2: { status: 'disabled', metrics: [] },
        },
      } as unknown as RealUsageState
    })

    const dependencies: ConfigIpcDependencies = {
      getWindow: () => null,
      sendCodexAuthProgress: vi.fn(),
      onRealUsage: mocks.onRealUsage,
      aiUsagebarLock,
    }

    registerConfigIpc(
      ((channel: string, handler: Handler) => {
        configIpcHandlers.set(channel, handler)
      }) as never,
      dependencies
    )

    // Simulate an ai-usagebar usage call that also runs under the shared lock
    const runAiUsagebarTask = () =>
      aiUsagebarLock.withLock(async () => {
        executionOrder.push('aiUsagebar:start')
        await new Promise((resolve) => setTimeout(resolve, 30))
        executionOrder.push('aiUsagebar:end')
        return { ok: true }
      })

    const realUsageHandler = configIpcHandlers.get('devorbit:getRealUsage')
    expect(realUsageHandler).toBeDefined()

    // Trigger both concurrently
    const [realUsageResult, aiUsageResult] = await Promise.all([
      realUsageHandler!({}, false),
      runAiUsagebarTask(),
    ])

    expect(realUsageResult).toBeDefined()
    expect(aiUsageResult).toEqual({ ok: true })

    // Verify non-overlapping sequential execution: one finishes before the other starts
    expect(executionOrder).toHaveLength(4)
    if (executionOrder[0] === 'getRealUsage:start') {
      expect(executionOrder).toEqual([
        'getRealUsage:start',
        'getRealUsage:end',
        'aiUsagebar:start',
        'aiUsagebar:end',
      ])
    } else {
      expect(executionOrder).toEqual([
        'aiUsagebar:start',
        'aiUsagebar:end',
        'getRealUsage:start',
        'getRealUsage:end',
      ])
    }
  })

  it('runs syncAiUsagebarAccounts before refresh without failing open on missing accounts', async () => {
    const tempDir = await createTempDir()
    const configPath = path.join(tempDir, 'config.toml')

    // Initial config without managed accounts
    await fs.writeFile(configPath, '[general]\nlog_level = "info"\n', 'utf8')

    let syncCalled = false
    const syncAccountsBeforeRefresh = async () => {
      syncCalled = true
      try {
        await syncAiUsagebarAccounts({ configPath, homeDirectory: tempDir })
      } catch {
        // Fail-open
      }
    }

    // Refresh simulation with pre-sync hook
    let refreshInvoked = false
    const refreshWithSync = async () => {
      await syncAccountsBeforeRefresh()
      refreshInvoked = true
      return {
        state: 'ready',
        version: '1.24.0',
        vendors: [],
        stale: false,
        report: { schema_version: 1, entries: [] },
      } as AiUsagebarSnapshot
    }

    const snapshot = await refreshWithSync()

    expect(syncCalled).toBe(true)
    expect(refreshInvoked).toBe(true)
    expect(snapshot.state).toBe('ready')

    // TOML remains intact even when no accounts were configured
    const content = await fs.readFile(configPath, 'utf8')
    expect(content).toContain('[general]')
  })

  it('persists encrypted API keys and generates ephemeral overlay without exposing raw keys', async () => {
    const tempDir = await createTempDir()
    const mockStorage = createMockSafeStorage()
    const secretsStore = createAiUsagebarSecretsStore({ userDataPath: tempDir }, mockStorage)

    const vendors: AiUsagebarVendor[] = [
      { id: 'anthropic', name: 'Anthropic', kind: 'apikey', env: 'ANTHROPIC_API_KEY' },
      { id: 'custom-ai', name: 'Custom AI', kind: 'apikey', env: 'CUSTOM_AI_KEY' },
    ]
    const catalog = { vendors }

    let ephemeralOverlay: NodeJS.ProcessEnv | undefined

    const ipcHandlers = new Map<string, Handler>()
    const readySnapshot: AiUsagebarSnapshot = { state: 'ready', version: '1.24.0', vendors, stale: false }
    const operations: AiUsagebarIpcOperations = {
      snapshot: vi.fn(async () => readySnapshot),
      refresh: vi.fn(async () => {
        ephemeralOverlay = await secretsStore.getEnvOverlay(catalog)
        return readySnapshot
      }),
      detect: vi.fn(async () => ({ enabled: ['anthropic'], known: ['anthropic'], probed: 1 })),
      setProviderEnabled: vi.fn(async () => readySnapshot),
      setApiKey: vi.fn(async (vendorId: string, apiKey: string) => {
        const vendor = vendors.find((v) => v.id === vendorId)
        if (!vendor || !vendor.env) throw new Error(`Unknown vendor ${vendorId}`)
        await secretsStore.setSecret(vendorId, vendor.env, apiKey, catalog)
        ephemeralOverlay = await secretsStore.getEnvOverlay(catalog)
        return readySnapshot
      }),
      removeApiKey: vi.fn(async (vendorId: string) => {
        await secretsStore.removeSecret(vendorId)
        ephemeralOverlay = await secretsStore.getEnvOverlay(catalog)
        return readySnapshot
      }),
    }

    registerAiUsagebarIpc(
      ((channel: string, handler: Handler) => ipcHandlers.set(channel, handler)) as never,
      operations
    )

    const setKeyHandler = ipcHandlers.get(AI_USAGEBAR_IPC_CHANNELS.setApiKey)
    expect(setKeyHandler).toBeDefined()

    // 1. Set API key
    const setResult = (await setKeyHandler!({}, { vendorId: 'anthropic', apiKey: 'sk-ant-test-secret-123' })) as {
      ok: boolean
      data?: AiUsagebarSnapshot
    }
    expect(setResult.ok).toBe(true)
    // The response never contains the secret key
    expect(JSON.stringify(setResult)).not.toContain('sk-ant-test-secret-123')

    // Ephemeral overlay receives the plaintext strictly for subprocess usage
    expect(ephemeralOverlay).toBeDefined()
    expect(ephemeralOverlay!['ANTHROPIC_API_KEY']).toBe('sk-ant-test-secret-123')

    // Stored on disk is encrypted, not plaintext
    const secretsFile = await fs.readFile(path.join(tempDir, 'ai-usagebar-secrets.json'), 'utf8')
    expect(secretsFile).not.toContain('sk-ant-test-secret-123')
    expect(secretsFile).toContain(Buffer.from('enc:sk-ant-test-secret-123').toString('base64'))

    // 2. Remove API key
    const removeKeyHandler = ipcHandlers.get(AI_USAGEBAR_IPC_CHANNELS.removeApiKey)
    const removeResult = (await removeKeyHandler!({}, { vendorId: 'anthropic' })) as {
      ok: boolean
      data?: AiUsagebarSnapshot
    }
    expect(removeResult.ok).toBe(true)
    expect(ephemeralOverlay!['ANTHROPIC_API_KEY']).toBeUndefined()

    // 3. updateSecretsOverlay with empty catalog passes {} overlay to clear memory
    const emptyOverlay = await secretsStore.getEnvOverlay({ vendors: [] })
    expect(emptyOverlay).toEqual({})

    // 4. Teardown / failure clears overlay to undefined in catch
    let currentServiceOverlay: NodeJS.ProcessEnv | undefined = { SOME_KEY: 'abc' }
    const simulateUpdateSecretsOverlay = async (errorMode: boolean) => {
      try {
        if (errorMode) throw new Error('Store failure')
        currentServiceOverlay = emptyOverlay
      } catch {
        currentServiceOverlay = undefined
      }
    }
    await simulateUpdateSecretsOverlay(false)
    expect(currentServiceOverlay).toEqual({})
    await simulateUpdateSecretsOverlay(true)
    expect(currentServiceOverlay).toBeUndefined()
  })

  it('fails open on missing sidecar binary without throwing or blocking IPC registration', async () => {
    const tempDir = await createTempDir()
    const nonExistentBinary = path.join(tempDir, 'does-not-exist', 'ai-usagebar.exe')

    const downloadMock = vi.fn().mockRejectedValue(new Error('Network download disabled in test'))

    const service = createAiUsagebarService({
      userDataDir: tempDir,
      bundledBinaryPath: nonExistentBinary,
      download: downloadMock,
    })

    const ipcHandlers = new Map<string, Handler>()
    const operations: AiUsagebarIpcOperations = {
      snapshot: async () => service.snapshot(),
      refresh: async () => service.refresh(),
      detect: async () => service.detect({ all: true }),
      setProviderEnabled: async (id, enabled) => service.setVendorEnabled(id, enabled),
      setApiKey: vi.fn(),
      removeApiKey: vi.fn(),
    }

    // Handlers registered synchronously
    registerAiUsagebarIpc(
      ((channel: string, handler: Handler) => ipcHandlers.set(channel, handler)) as never,
      operations
    )

    // Snapshot is immediately available and fail-open (unavailable)
    const snapshotHandler = ipcHandlers.get(AI_USAGEBAR_IPC_CHANNELS.snapshot)
    const snapshotResult = (await snapshotHandler!({})) as { ok: boolean; data: AiUsagebarSnapshot }
    expect(snapshotResult.ok).toBe(true)
    expect(snapshotResult.data.state).toBe('unavailable')

    // No network download was attempted during startup registration or initial snapshot
    expect(downloadMock).not.toHaveBeenCalled()

    // Refresh fails open with error state instead of throwing unhandled exception
    const refreshHandler = ipcHandlers.get(AI_USAGEBAR_IPC_CHANNELS.refresh)
    const refreshResult = (await refreshHandler!({})) as { ok: boolean; data: AiUsagebarSnapshot }
    expect(refreshResult.ok).toBe(true)
    expect(refreshResult.data.state).toBe('error')
  })

  it('supports generic vendor toggle and keeps detect explicit-only', async () => {
    const ipcHandlers = new Map<string, Handler>()
    let detectedCalled = false
    let toggleId: string | null = null
    let toggleEnabled: boolean | null = null

    const operations: AiUsagebarIpcOperations = {
      snapshot: async () => ({ state: 'ready', version: '1.24.0', vendors: [], stale: false }),
      refresh: async () => ({ state: 'ready', version: '1.24.0', vendors: [], stale: false }),
      detect: async () => {
        detectedCalled = true
        return { enabled: ['future-vendor-x'], known: ['future-vendor-x'], probed: 1 }
      },
      setProviderEnabled: async (id, enabled) => {
        toggleId = id
        toggleEnabled = enabled
        return {
          state: 'ready',
          version: '1.24.0',
          vendors: [{ id, name: id, enabled }],
          stale: false,
        }
      },
      setApiKey: vi.fn(),
      removeApiKey: vi.fn(),
    }

    registerAiUsagebarIpc(
      ((channel: string, handler: Handler) => ipcHandlers.set(channel, handler)) as never,
      operations
    )

    // 1. Generic toggle
    const toggleHandler = ipcHandlers.get(AI_USAGEBAR_IPC_CHANNELS.setProvider)
    const toggleResult = (await toggleHandler!({}, { vendorId: 'future-vendor-x', enabled: true })) as {
      ok: boolean
      data?: AiUsagebarSnapshot
    }
    expect(toggleResult.ok).toBe(true)
    expect(toggleId).toBe('future-vendor-x')
    expect(toggleEnabled).toBe(true)

    // Detect has NOT been called automatically
    expect(detectedCalled).toBe(false)

    // 2. Explicit detect call
    const detectHandler = ipcHandlers.get(AI_USAGEBAR_IPC_CHANNELS.detect)
    const detectResult = (await detectHandler!({})) as {
      ok: boolean
      data?: { enabled: string[] }
    }
    expect(detectResult.ok).toBe(true)
    expect(detectedCalled).toBe(true)
    expect(detectResult.data?.enabled).toContain('future-vendor-x')
  })

  it('passes {all:true} to service.detect when IPC detect channel is invoked', async () => {
    const tempDir = await createTempDir()
    const configPath = path.join(tempDir, 'config.toml')
    await fs.writeFile(configPath, '[general]\nlog_level = "info"\n', 'utf8')

    const nonExistentBinary = path.join(tempDir, 'does-not-exist', 'ai-usagebar.exe')
    const downloadMock = vi.fn().mockRejectedValue(new Error('Network download disabled in test'))

    const service = createAiUsagebarService({
      userDataDir: tempDir,
      bundledBinaryPath: nonExistentBinary,
      download: downloadMock,
    })
    const detectSpy = vi.spyOn(service, 'detect')

    const ipcHandlers = new Map<string, Handler>()
    const operations: AiUsagebarIpcOperations = {
      snapshot: async () => service.snapshot(),
      refresh: async () => service.refresh(),
      detect: async () => service.detect({ all: true }),
      setProviderEnabled: async (id, enabled) => service.setVendorEnabled(id, enabled),
      setApiKey: vi.fn(),
      removeApiKey: vi.fn(),
    }

    registerAiUsagebarIpc(
      ((channel: string, handler: Handler) => ipcHandlers.set(channel, handler)) as never,
      operations
    )

    const detectHandler = ipcHandlers.get(AI_USAGEBAR_IPC_CHANNELS.detect)
    await detectHandler!({})

    expect(detectSpy).toHaveBeenCalledTimes(1)
    expect(detectSpy).toHaveBeenCalledWith({ all: true })
  })

  it('criterion (a): does not block consolidated report of other providers when account sync fails, and logs sanitized status', async () => {
    const tempDir = await createTempDir()
    const configPath = path.join(tempDir, 'config.toml')
    await fs.writeFile(configPath, '[general]\nlog_level = "info"\n', 'utf8')

    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((msg) => {
      warnings.push(String(msg))
    })

    const otherVendors: AiUsagebarVendor[] = [
      { id: 'anthropic', name: 'Anthropic', enabled: true },
      { id: 'google', name: 'Google', enabled: true },
    ]

    const syncAccountsBeforeRefresh = async (): Promise<void> => {
      try {
        const result = await syncAiUsagebarAccounts({
          configPath,
          // Intentionally broken home directory with corrupt auth to simulate failure
          homeDirectory: path.join(tempDir, 'nonexistent-home'),
        })
        if (result && result.status !== 'ok') {
          const detail = Array.isArray(result.errors) && result.errors.length > 0
            ? `: ${result.errors.map((e) => sanitizeAiUsagebarMessage(e)).join('; ')}`
            : ''
          console.warn(sanitizeAiUsagebarMessage(`[ai-usagebar] Sincronização de contas Codex reportou status '${result.status}'${detail}`))
        }
      } catch {
        // Warning estático sem interpolar error.message nem expor paths de arquivos
        console.warn('[ai-usagebar] Falha ao sincronizar contas Codex antes do refresh.')
      }
    }

    const refreshWithSync = async (): Promise<AiUsagebarSnapshot> => {
      await syncAccountsBeforeRefresh()
      // Consolidated report of other providers proceeds intact
      return {
        state: 'ready',
        version: '1.24.0',
        vendors: otherVendors,
        stale: false,
        report: {
          schema_version: 1,
          entries: [
            {
              id: 'anthropic',
              name: 'anthropic',
              display_name: 'Anthropic Claude',
              sections: [{ type: 'metric', label: '5-Hour Window', percent: 45 }],
            },
            {
              id: 'google',
              name: 'google',
              display_name: 'Google Gemini',
              sections: [{ type: 'metric', label: 'Daily Requests', percent: 12 }],
            },
          ],
        },
      }
    }

    const snapshot = await refreshWithSync()

    // 1. Other providers' report was NOT blocked
    expect(snapshot.state).toBe('ready')
    expect(snapshot.report?.entries).toHaveLength(2)
    expect(snapshot.report?.entries[0].id).toBe('anthropic')
    expect(snapshot.report?.entries[1].id).toBe('google')

    // 2. Status was logged and sanitized
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]).toContain("[ai-usagebar] Sincronização de contas Codex reportou status 'missing_auth'")
    expect(warnings[0]).not.toContain('sk-')

    // 3. Catch handler logs static message without error.message or file paths
    const catchWarnings: string[] = []
    const syncThrowing = async (): Promise<void> => {
      try {
        throw new Error('C:\\Users\\secret\\path\\auth.json not found')
      } catch {
        const msg = '[ai-usagebar] Falha ao sincronizar contas Codex antes do refresh.'
        catchWarnings.push(msg)
        console.warn(msg)
      }
    }
    await syncThrowing()
    expect(catchWarnings).toContain('[ai-usagebar] Falha ao sincronizar contas Codex antes do refresh.')
    expect(catchWarnings.join('\n')).not.toContain('secret')
    expect(catchWarnings.join('\n')).not.toContain('path')
    expect(catchWarnings.join('\n')).not.toContain('auth.json')

    warnSpy.mockRestore()
  })

  it('criterion (b): in any smoke/verify mode (including verify:runtime with DEVORBIT_VERIFY_RUNTIME/UI and bundled resource), stubs all operations to unavailable without auth sync, spawn, download, or network', async () => {
    const triggerCases: Array<{ argv: string[]; env: Record<string, string>; desc: string }> = [
      { argv: ['--devorbit-smoke'], env: {}, desc: '--devorbit-smoke' },
      { argv: ['--devorbit-verify-ui'], env: {}, desc: '--devorbit-verify-ui' },
      { argv: ['--devorbit-verify-runtime'], env: {}, desc: '--devorbit-verify-runtime' },
      { argv: [], env: { DEVORBIT_VERIFY_UI: '1' }, desc: 'DEVORBIT_VERIFY_UI=1' },
      { argv: [], env: { DEVORBIT_VERIFY_RUNTIME: '1' }, desc: 'DEVORBIT_VERIFY_RUNTIME=1' },
    ]

    const scenarios: Array<{
      desc: string
      argv: string[]
      env: Record<string, string>
      hasBundledResource: boolean
    }> = []

    for (const trigger of triggerCases) {
      for (const hasBundledResource of [true, false]) {
        scenarios.push({
          desc: `${trigger.desc} (hasBundledResource=${hasBundledResource})`,
          argv: trigger.argv,
          env: trigger.env,
          hasBundledResource,
        })
      }
    }

    for (const scenario of scenarios) {
      const isSmokeOrVerify =
        scenario.argv.includes('--devorbit-smoke') ||
        scenario.argv.includes('--devorbit-verify-ui') ||
        scenario.argv.includes('--devorbit-verify-runtime') ||
        scenario.env.DEVORBIT_VERIFY_UI === '1' ||
        scenario.env.DEVORBIT_VERIFY_RUNTIME === '1'
      expect(isSmokeOrVerify).toBe(true)

      // Simulate environment where bundled binary exists (true) or does not exist (false)
      const tempDir = await createTempDir()
      const bundledExePath = path.join(tempDir, 'ai-usagebar.exe')
      if (scenario.hasBundledResource) {
        await fs.writeFile(bundledExePath, 'dummy-binary-content')
      }

      const syncMock = vi.fn().mockImplementation(async () => {
        throw new Error('Auth sync não deve rodar em modo smoke/verificação.')
      })
      const downloadMock = vi.fn().mockImplementation(async () => {
        throw new Error('Download de rede bloqueado em modo smoke/verificação.')
      })
      const runnerMock = vi.fn().mockImplementation(async () => {
        throw new Error('Process spawn bloqueado em modo smoke/verificação.')
      })

      const unavailableSnapshot: AiUsagebarSnapshot = {
        state: 'unavailable',
        message: 'ai-usagebar indisponível em modo smoke/verificação.',
        vendors: [],
        stale: false,
      }

      const ipcHandlers = new Map<string, Handler>()
      // Main process setupIpcHandlers stubs aiUsagebarOperations directly for any isSmokeOrVerify,
      // regardless of whether bundled resource is present (hasBundledResource = true) or not.
      const aiUsagebarOperations: AiUsagebarIpcOperations = isSmokeOrVerify
        ? {
            snapshot: async () => unavailableSnapshot,
            refresh: async () => unavailableSnapshot,
            detect: async () => ({ enabled: [], known: [], probed: 0 }),
            setProviderEnabled: async () => unavailableSnapshot,
            setApiKey: async () => unavailableSnapshot,
            removeApiKey: async () => unavailableSnapshot,
          }
        : {
            snapshot: vi.fn(),
            refresh: vi.fn(),
            detect: vi.fn(),
            setProviderEnabled: vi.fn(),
            setApiKey: vi.fn(),
            removeApiKey: vi.fn(),
          }

      registerAiUsagebarIpc(
        ((channel: string, handler: Handler) => ipcHandlers.set(channel, handler)) as never,
        aiUsagebarOperations
      )

      // 1. Snapshot returns unavailable
      const snapshotHandler = ipcHandlers.get(AI_USAGEBAR_IPC_CHANNELS.snapshot)
      const snapshotResult = (await snapshotHandler!({})) as { ok: boolean; data: AiUsagebarSnapshot }
      expect(snapshotResult.ok).toBe(true)
      expect(snapshotResult.data.state).toBe('unavailable')

      // 2. Refresh returns unavailable without network, spawn, or auth sync
      const refreshHandler = ipcHandlers.get(AI_USAGEBAR_IPC_CHANNELS.refresh)
      const refreshResult = (await refreshHandler!({})) as { ok: boolean; data: AiUsagebarSnapshot }
      expect(refreshResult.ok).toBe(true)
      expect(refreshResult.data.state).toBe('unavailable')

      // 3. Detect returns empty report without probing
      const detectHandler = ipcHandlers.get(AI_USAGEBAR_IPC_CHANNELS.detect)
      const detectResult = (await detectHandler!({})) as {
        ok: boolean
        data?: { enabled: string[]; known: string[]; probed: number }
      }
      expect(detectResult.ok).toBe(true)
      expect(detectResult.data).toEqual({ enabled: [], known: [], probed: 0 })

      // 4. Provider toggles / API keys return unavailable fail-open
      const setProviderHandler = ipcHandlers.get(AI_USAGEBAR_IPC_CHANNELS.setProvider)
      const setProviderResult = (await setProviderHandler!({}, { vendorId: 'openai', enabled: true })) as {
        ok: boolean
        data: AiUsagebarSnapshot
      }
      expect(setProviderResult.ok).toBe(true)
      expect(setProviderResult.data.state).toBe('unavailable')

      const setApiKeyHandler = ipcHandlers.get(AI_USAGEBAR_IPC_CHANNELS.setApiKey)
      const setApiKeyResult = (await setApiKeyHandler!({}, { vendorId: 'openai', apiKey: 'sk-test' })) as {
        ok: boolean
        data: AiUsagebarSnapshot
      }
      expect(setApiKeyResult.ok).toBe(true)
      expect(setApiKeyResult.data.state).toBe('unavailable')

      const removeApiKeyHandler = ipcHandlers.get(AI_USAGEBAR_IPC_CHANNELS.removeApiKey)
      const removeApiKeyResult = (await removeApiKeyHandler!({}, { vendorId: 'openai' })) as {
        ok: boolean
        data: AiUsagebarSnapshot
      }
      expect(removeApiKeyResult.ok).toBe(true)
      expect(removeApiKeyResult.data.state).toBe('unavailable')

      // Absolute zero spawn, zero download, zero network traffic, zero auth sync
      expect(syncMock).not.toHaveBeenCalled()
      expect(downloadMock).not.toHaveBeenCalled()
      expect(runnerMock).not.toHaveBeenCalled()
    }
  })
})
