import { describe, expect, it, vi } from 'vitest'
import { registerAiUsagebarIpc, type AiUsagebarIpcOperations } from '../src/main/ipc/ai-usagebar-ipc'
import { AI_USAGEBAR_IPC_CHANNELS } from '../src/shared/ai-usagebar-ipc-contract'
import type { AiUsagebarSnapshot } from '../src/shared/ai-usagebar-contract'

type Handler = (_event: unknown, request?: unknown) => unknown

const snapshot: AiUsagebarSnapshot = {
  state: 'ready',
  version: '1.24.0',
  vendors: [{ id: 'future-provider', name: 'Future Provider', kind: 'apikey', env: 'FUTURE_API_KEY' }],
  stale: false,
  report: { schema_version: 1, entries: [] },
}

function setup(overrides: Partial<AiUsagebarIpcOperations> = {}) {
  const handlers = new Map<string, Handler>()
  const operations: AiUsagebarIpcOperations = {
    snapshot: vi.fn(async () => snapshot),
    refresh: vi.fn(async () => snapshot),
    detect: vi.fn(async () => ({ enabled: ['future-provider'], known: ['future-provider'], probed: 1 })),
    setProviderEnabled: vi.fn(async () => snapshot),
    setApiKey: vi.fn(async () => snapshot),
    removeApiKey: vi.fn(async () => snapshot),
    ...overrides,
  }
  registerAiUsagebarIpc(((channel: string, handler: Handler) => handlers.set(channel, handler)) as never, operations)
  return {
    operations,
    invoke: async (channel: string, request?: unknown) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`missing IPC handler ${channel}`)
      return await handler({}, request)
    },
  }
}

describe('ai-usagebar IPC', () => {
  it('returns renderer-safe snapshots and refresh results', async () => {
    const h = setup()
    await expect(h.invoke(AI_USAGEBAR_IPC_CHANNELS.snapshot)).resolves.toEqual({ ok: true, data: snapshot })
    await expect(h.invoke(AI_USAGEBAR_IPC_CHANNELS.refresh)).resolves.toEqual({ ok: true, data: snapshot })
  })

  it('runs detect only on its explicit IPC action', async () => {
    const h = setup()
    expect(h.operations.detect).not.toHaveBeenCalled()
    await expect(h.invoke(AI_USAGEBAR_IPC_CHANNELS.detect)).resolves.toEqual({
      ok: true,
      data: { enabled: ['future-provider'], known: ['future-provider'], probed: 1 },
    })
    expect(h.operations.detect).toHaveBeenCalledTimes(1)
  })

  it('validates provider changes and passes unknown future IDs through unchanged', async () => {
    const h = setup()
    await expect(h.invoke(AI_USAGEBAR_IPC_CHANNELS.setProvider, { vendorId: 'future-provider', enabled: true }))
      .resolves.toEqual({ ok: true, data: snapshot })
    expect(h.operations.setProviderEnabled).toHaveBeenCalledWith('future-provider', true)
    await expect(h.invoke(AI_USAGEBAR_IPC_CHANNELS.setProvider, { vendorId: '../auth.json', enabled: true }))
      .resolves.toMatchObject({ ok: false, reason: 'invalid' })
    expect(h.operations.setProviderEnabled).toHaveBeenCalledTimes(1)
  })

  it('submits an API key only to the main operation and never returns it', async () => {
    const secret = 'not-a-real-api-key'
    const h = setup()
    const result = await h.invoke(AI_USAGEBAR_IPC_CHANNELS.setApiKey, { vendorId: 'future-provider', apiKey: secret })
    expect(h.operations.setApiKey).toHaveBeenCalledWith('future-provider', secret)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(result).toEqual({ ok: true, data: snapshot })
  })

  it('rejects oversized or multiline API keys before storage', async () => {
    const h = setup()
    await expect(h.invoke(AI_USAGEBAR_IPC_CHANNELS.setApiKey, { vendorId: 'provider', apiKey: 'a'.repeat(8193) }))
      .resolves.toMatchObject({ ok: false, reason: 'invalid' })
    await expect(h.invoke(AI_USAGEBAR_IPC_CHANNELS.setApiKey, { vendorId: 'provider', apiKey: 'first\nsecond' }))
      .resolves.toMatchObject({ ok: false, reason: 'invalid' })
    expect(h.operations.setApiKey).not.toHaveBeenCalled()
  })

  it('sanitizes failures instead of returning raw stderr or paths', async () => {
    const h = setup({ snapshot: vi.fn(async () => { throw new Error('C:\\Users\\secret\\auth.json token=abc') }) })
    const result = await h.invoke(AI_USAGEBAR_IPC_CHANNELS.snapshot)
    expect(result).toEqual({ ok: false, reason: 'failed', message: 'Não foi possível concluir a operação de quotas.' })
    expect(JSON.stringify(result)).not.toContain('auth.json')
    expect(JSON.stringify(result)).not.toContain('abc')
  })
})
