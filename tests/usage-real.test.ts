import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const usageHome = vi.hoisted(() => ({ value: '' }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => usageHome.value,
    },
  }
})

import { getRealUsage, parseCodexUsagePayload } from '../src/main/usage-real'

let temporaryHome = ''
const fetchMock = vi.fn()

beforeEach(async () => {
  temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-real-usage-'))
  usageHome.value = temporaryHome
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await fs.rm(temporaryHome, { recursive: true, force: true })
})

async function writeAuth(account: 'account1' | 'account2', accessToken = `access-${account}-token`) {
  const directory = path.join(temporaryHome, account === 'account2' ? '.codex-conta2' : '.codex-conta1')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, 'auth.json'),
    JSON.stringify({ tokens: { access_token: accessToken, account_id: `${account}-id` } }),
    'utf8'
  )
}

describe('Codex real usage adapter', () => {
  it('parses official percentage windows and reset timestamps', () => {
    const parsed = parseCodexUsagePayload(
      {
        plan_type: 'plus',
        rate_limit: {
          primary_window: { used_percent: 37.5, limit_window_seconds: 18000, reset_at: 2_000_000_000 },
          secondary_window: { used_percent: '12', limit_window_seconds: 604800, reset_after_seconds: 3600 },
        },
      },
      1_000_000_000_000
    )

    expect(parsed.plan).toBe('plus')
    expect(parsed.metrics.slice(0, 2)).toEqual([
      { id: 'primary', label: 'Janela de 5h', percent: 37.5, resetAt: 2_000_000_000_000, windowSeconds: 18000 },
      { id: 'secondary', label: 'Janela semanal', percent: 12, resetAt: 1_000_003_600_000, windowSeconds: 604800 },
    ])
  })

  it('never turns an invalid percentage into a plausible value', () => {
    const parsed = parseCodexUsagePayload({
      rate_limit: { primary_window: { used_percent: 120, limit_window_seconds: 18000 } },
    })
    expect(parsed.metrics).toEqual([])
  })

  it('reports both isolated accounts as ready and never returns their tokens', async () => {
    await writeAuth('account1')
    await writeAuth('account2')
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        plan_type: 'plus',
        rate_limit: { primary_window: { used_percent: 8, limit_window_seconds: 18000 } },
      }),
    })

    const result = await getRealUsage(true)

    expect(result.source).toBe('codex-oauth')
    expect(result.accounts.account1.status).toBe('ready')
    expect(result.accounts.account1.metrics[0].percent).toBe(8)
    expect(JSON.stringify(result)).not.toContain('access-account1-token')
    expect(JSON.stringify(result)).not.toContain('account1-id')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('marks a missing auth file as not configured instead of showing zero percent', async () => {
    const result = await getRealUsage(true)

    expect(result.accounts.account1.status).toBe('not_configured')
    expect(result.accounts.account1.metrics).toEqual([])
    expect(result.accounts.account1.message).toContain('não autenticada')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
