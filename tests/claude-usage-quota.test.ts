import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createClaudeQuotaPoller,
  defaultClaudeCredentialsPath,
  parseClaudeUsagePayload,
  readClaudeOAuthAccessToken,
} from '../src/main/claude-usage-quota'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

async function writeCredentials(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-claude-quota-'))
  temporaryDirectories.push(dir)
  const filePath = path.join(dir, '.credentials.json')
  await fs.writeFile(filePath, content, 'utf-8')
  return filePath
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

describe('readClaudeOAuthAccessToken', () => {
  it('extrai o token do claudeAiOauth', async () => {
    const filePath = await writeCredentials(JSON.stringify({
      claudeAiOauth: { accessToken: 'tok-abc', refreshToken: 'r' },
    }))
    expect(await readClaudeOAuthAccessToken(filePath)).toBe('tok-abc')
  })

  it('devolve null para arquivo ausente, corrompido ou sem token', async () => {
    expect(await readClaudeOAuthAccessToken(path.join(os.tmpdir(), 'inexistente-cred.json'))).toBeNull()
    const broken = await writeCredentials('{quebrado')
    expect(await readClaudeOAuthAccessToken(broken)).toBeNull()
    const empty = await writeCredentials(JSON.stringify({ other: 1 }))
    expect(await readClaudeOAuthAccessToken(empty)).toBeNull()
  })
})

describe('parseClaudeUsagePayload', () => {
  it('mapeia five_hour e seven_day para janelas de quota', () => {
    const event = parseClaudeUsagePayload({
      five_hour: { utilization: 80.04, resets_at: '2026-09-21T18:00:00Z' },
      seven_day: { utilization: 41.2 },
    }, '2026-09-21T12:00:00.000Z')
    expect(event).not.toBeNull()
    expect(event?.provider).toBe('claude')
    expect(event?.kind).toBe('quota')
    expect(event?.windows).toEqual([
      { id: 'five_hour', label: '5 horas', percent: 80, resetAt: '2026-09-21T18:00:00Z' },
      { id: 'seven_day', label: 'Semanal', percent: 41.2 },
    ])
  })

  it('devolve null para payload sem janelas utilizáveis', () => {
    expect(parseClaudeUsagePayload({}, '2026-09-21T12:00:00.000Z')).toBeNull()
    expect(parseClaudeUsagePayload('lixo', '2026-09-21T12:00:00.000Z')).toBeNull()
  })
})

describe('createClaudeQuotaPoller', () => {
  it('consulta o endpoint e devolve evento de quota', async () => {
    const credentialsPath = await writeCredentials(JSON.stringify({
      claudeAiOauth: { accessToken: 'tok-1' },
    }))
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
      return jsonResponse(200, {
        five_hour: { utilization: 25, resets_at: '2026-09-21T20:00:00Z' },
        seven_day: { utilization: 10 },
      })
    }) as typeof fetch
    const poller = createClaudeQuotaPoller({ credentialsPath, fetchImpl, now: () => 1_000_000 })
    const event = await poller.check()
    expect(event?.windows[0]).toEqual({ id: 'five_hour', label: '5 horas', percent: 25, resetAt: '2026-09-21T20:00:00Z' })
    expect(calls[0]?.url).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(calls[0]?.headers.Authorization).toBe('Bearer tok-1')
    expect(calls[0]?.headers['anthropic-beta']).toBe('oauth-2025-04-20')
  })

  it('respeita o intervalo mínimo entre chamadas bem-sucedidas', async () => {
    const credentialsPath = await writeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }))
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return jsonResponse(200, { five_hour: { utilization: 1 } })
    }) as typeof fetch
    let clock = 1_000_000
    const poller = createClaudeQuotaPoller({ credentialsPath, fetchImpl, now: () => clock })
    expect(await poller.check()).not.toBeNull()
    clock += 60_000
    expect(await poller.check()).toBeNull()
    expect(calls).toBe(1)
    clock += 31 * 60_000
    expect(await poller.check()).not.toBeNull()
    expect(calls).toBe(2)
  })

  it('entra em cooldown longo após 429 e não consulta de novo', async () => {
    const credentialsPath = await writeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }))
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return jsonResponse(429, {})
    }) as typeof fetch
    let clock = 2_000_000
    const poller = createClaudeQuotaPoller({ credentialsPath, fetchImpl, now: () => clock })
    expect(await poller.check()).toBeNull()
    expect(calls).toBe(1)
    clock += 60 * 60_000
    expect(await poller.check()).toBeNull()
    expect(calls).toBe(1)
  })

  it('não lança quando a rede falha e aplica cooldown de erro', async () => {
    const credentialsPath = await writeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }))
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      throw new Error('rede caiu')
    }) as typeof fetch
    let clock = 3_000_000
    const poller = createClaudeQuotaPoller({ credentialsPath, fetchImpl, now: () => clock })
    expect(await poller.check()).toBeNull()
    clock += 10_000
    expect(await poller.check()).toBeNull()
    expect(calls).toBe(1)
  })

  it('sem credencial devolve null sem chamar o endpoint', async () => {
    const missingPath = path.join(os.tmpdir(), 'sem-credencial.json')
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return jsonResponse(200, {})
    }) as typeof fetch
    const poller = createClaudeQuotaPoller({ credentialsPath: missingPath, fetchImpl, now: () => 5_000_000 })
    expect(await poller.check()).toBeNull()
    expect(calls).toBe(0)
  })
})

describe('defaultClaudeCredentialsPath', () => {
  it('honra CLAUDE_CONFIG_DIR e cai no homedir', () => {
    expect(defaultClaudeCredentialsPath('C:\\Users\\u', { CLAUDE_CONFIG_DIR: 'D:\\claude' } as NodeJS.ProcessEnv))
      .toBe(path.join('D:\\claude', '.credentials.json'))
    expect(defaultClaudeCredentialsPath('C:\\Users\\u', {} as NodeJS.ProcessEnv))
      .toBe(path.join('C:\\Users\\u', '.claude', '.credentials.json'))
  })
})
