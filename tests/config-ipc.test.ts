import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../src/renderer/src/types'

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
vi.mock('../src/main/usage-real', () => ({ getRealUsage: mocks.getRealUsage }))
vi.mock('../src/main/project-paths', () => ({ validateProjectPath: vi.fn(async (value: string) => value) }))
vi.mock('../src/main/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/config')>()
  return { ...actual, loadConfig: mocks.loadConfig, saveConfig: mocks.saveConfig }
})

import { registerConfigIpc } from '../src/main/ipc/config-ipc'

const baseConfig: AppConfig = {
  projectDirs: [],
  managedProjects: [],
  projectAccounts: {},
  activeChatGptAccount: 'account1',
  chatGptAccount1Name: 'Conta 1',
  chatGptAccount2Name: 'Conta 2',
  customPaths: {},
}

type Handler = (event: unknown, ...args: unknown[]) => unknown

let handlers: Map<string, Handler>

beforeEach(() => {
  handlers = new Map()
  mocks.loadConfig.mockReset()
  mocks.saveConfig.mockReset()
  mocks.getRealUsage.mockReset()
  mocks.onRealUsage.mockReset()
  registerConfigIpc(
    ((channel: string, handler: Handler) => handlers.set(channel, handler)) as never,
    { getWindow: () => null, sendCodexAuthProgress: () => undefined, onRealUsage: mocks.onRealUsage }
  )
})

function handler(channel: string): Handler {
  const found = handlers.get(channel)
  if (!found) throw new Error(`Handler ausente: ${channel}`)
  return found
}

describe('config IPC — fronteira segura', () => {
  it('getConfig remove credenciais e publica apenas flags de presença', async () => {
    mocks.loadConfig.mockResolvedValue({
      ...baseConfig,
      modelRouting: { fastModel: 'gpt-4o-mini', openaiApiKey: 'sk-secret-openai', deepseekApiKey: 'sk-secret-deepseek' },
    })

    const result = (await handler('devorbit:getConfig')({})) as AppConfig
    expect(result.modelRouting).not.toHaveProperty('openaiApiKey')
    expect(result.modelRouting).not.toHaveProperty('deepseekApiKey')
    expect(result.modelRouting?.hasOpenaiKey).toBe(true)
    expect(result.modelRouting?.hasDeepseekKey).toBe(true)
    expect(JSON.stringify(result)).not.toContain('sk-secret')
  })

  it('saveConfig valida os campos BYOK e devolve a visão segura', async () => {
    mocks.saveConfig.mockImplementation(async (updates: Partial<AppConfig>) => ({
      ...baseConfig,
      modelRouting: { ...(updates.modelRouting ?? {}) },
    }))

    const result = (await handler('devorbit:saveConfig')({}, {
      modelRouting: { deepseekApiKey: 'sk-deep', deepseekBaseUrl: 'https://gateway.example/v1' },
    })) as AppConfig

    const passed = mocks.saveConfig.mock.calls.at(-1)?.[0] as Partial<AppConfig>
    expect(passed.modelRouting?.deepseekApiKey).toBe('sk-deep')
    expect(passed.modelRouting?.deepseekBaseUrl).toBe('https://gateway.example/v1')
    expect(result.modelRouting).not.toHaveProperty('deepseekApiKey')
    expect(result.modelRouting?.hasDeepseekKey).toBe(true)
    expect(result.modelRouting?.deepseekBaseUrl).toBe('https://gateway.example/v1')
  })

  it('rejeita URL base remota insegura antes de persistir', async () => {
    await expect(
      handler('devorbit:saveConfig')({}, { modelRouting: { deepseekBaseUrl: 'http://evil.example' } })
    ).rejects.toThrow('URL base do provedor inválida.')
    expect(mocks.saveConfig).not.toHaveBeenCalled()
  })

  it('getRealUsage alimenta a continuidade com a quota OAuth real', async () => {
    const usage = {
      source: 'codex-oauth',
      fetchedAt: new Date().toISOString(),
      accounts: {
        account1: { account: 'account1', status: 'ready', metrics: [{ id: 'primary', label: 'Janela', percent: 99 }] },
        account2: { account: 'account2', status: 'not_configured', metrics: [] },
      },
    }
    mocks.getRealUsage.mockResolvedValue(usage)

    const result = await handler('devorbit:getRealUsage')({}, true)
    expect(result).toEqual(usage)
    expect(mocks.getRealUsage).toHaveBeenCalledWith(true)
    expect(mocks.onRealUsage).toHaveBeenCalledWith(usage)
  })

  it('aceita URL base HTTP apenas em loopback', async () => {
    mocks.saveConfig.mockImplementation(async (updates: Partial<AppConfig>) => ({
      ...baseConfig,
      modelRouting: { ...(updates.modelRouting ?? {}) },
    }))

    await handler('devorbit:saveConfig')({}, { modelRouting: { vllmBaseUrl: 'http://127.0.0.1:8000/v1' } })
    const passed = mocks.saveConfig.mock.calls.at(-1)?.[0] as Partial<AppConfig>
    expect(passed.modelRouting?.vllmBaseUrl).toBe('http://127.0.0.1:8000/v1')
  })
})
