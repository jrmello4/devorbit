import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createAiUsagebarAsyncLock,
  isValidAuthFile,
  syncAiUsagebarAccounts,
} from '../src/main/ai-usagebar-accounts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

async function setupHome(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-usagebar-acct-'))
  temporaryDirectories.push(root)
  return root
}

async function writeAuth(home: string, account: 'account1' | 'account2', data: Record<string, unknown>): Promise<void> {
  const dir = path.join(home, account === 'account2' ? '.codex-conta2' : '.codex-conta1')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'auth.json'), JSON.stringify(data), 'utf8')
}

async function readConfig(configPath: string): Promise<string> {
  try {
    return await fs.readFile(configPath, 'utf8')
  } catch {
    return ''
  }
}

describe('isValidAuthFile', () => {
  it('returns false for missing file', async () => {
    expect(await isValidAuthFile('/nonexistent/path/auth.json')).toBe(false)
  })

  it('returns false for malformed JSON', async () => {
    const root = await setupHome()
    const filePath = path.join(root, 'auth.json')
    await fs.writeFile(filePath, '{not json', 'utf8')
    expect(await isValidAuthFile(filePath)).toBe(false)
  })

  it('returns false for empty auth structure', async () => {
    const root = await setupHome()
    const filePath = path.join(root, 'auth.json')
    await fs.writeFile(filePath, JSON.stringify({ tokens: {} }), 'utf8')
    expect(await isValidAuthFile(filePath)).toBe(false)
  })

  it('returns false for short tokens', async () => {
    const root = await setupHome()
    const filePath = path.join(root, 'auth.json')
    await fs.writeFile(filePath, JSON.stringify({ tokens: { access_token: 'short' } }), 'utf8')
    expect(await isValidAuthFile(filePath)).toBe(false)
  })

  it('returns true for nested tokens with access_token', async () => {
    const root = await setupHome()
    const filePath = path.join(root, 'auth.json')
    await fs.writeFile(filePath, JSON.stringify({ tokens: { access_token: 'a'.repeat(32) } }), 'utf8')
    expect(await isValidAuthFile(filePath)).toBe(true)
  })

  it('returns true for top-level access_token', async () => {
    const root = await setupHome()
    const filePath = path.join(root, 'auth.json')
    await fs.writeFile(filePath, JSON.stringify({ access_token: 'a'.repeat(32) }), 'utf8')
    expect(await isValidAuthFile(filePath)).toBe(true)
  })

  it('returns true for OPENAI_API_KEY', async () => {
    const root = await setupHome()
    const filePath = path.join(root, 'auth.json')
    await fs.writeFile(filePath, JSON.stringify({ OPENAI_API_KEY: 'sk-' + 'a'.repeat(24) }), 'utf8')
    expect(await isValidAuthFile(filePath)).toBe(true)
  })

  it('returns true for refresh_token only', async () => {
    const root = await setupHome()
    const filePath = path.join(root, 'auth.json')
    await fs.writeFile(filePath, JSON.stringify({ tokens: { refresh_token: 'r'.repeat(32) } }), 'utf8')
    expect(await isValidAuthFile(filePath)).toBe(true)
  })
})

describe('syncAiUsagebarAccounts', () => {
  it('writes two profiles from valid auth files', async () => {
    const root = await setupHome()
    await writeAuth(root, 'account1', { tokens: { access_token: 'a'.repeat(32), refresh_token: 'r'.repeat(32) } })
    await writeAuth(root, 'account2', { tokens: { access_token: 'b'.repeat(32), refresh_token: 's'.repeat(32) } })

    const configPath = path.join(root, 'config.toml')
    const result = await syncAiUsagebarAccounts({ configPath, homeDirectory: root })

    expect(result.status).toBe('ok')
    expect(result.profiles).toHaveLength(2)
    expect(result.profiles[0].codex_auth_path).toContain('.codex-conta1/auth.json')
    expect(result.profiles[0].label).toBe('DevOrbit Account 1')
    expect(result.profiles[1].codex_auth_path).toContain('.codex-conta2/auth.json')
    expect(result.profiles[1].label).toBe('DevOrbit Account 2')
    expect(result.errors).toEqual([])

    const content = await readConfig(configPath)
    expect(content).toContain('[[openai.accounts]]')
    expect(content).toContain('show_default_account = false')
    expect(content).toContain('# Managed by DevOrbit')
  })

  it('reports missing_auth when no auth files exist', async () => {
    const root = await setupHome()
    const configPath = path.join(root, 'config.toml')
    const result = await syncAiUsagebarAccounts({ configPath, homeDirectory: root })

    expect(result.status).toBe('missing_auth')
    expect(result.profiles).toHaveLength(0)
    expect(result.errors.length).toBeGreaterThan(0)

    const content = await readConfig(configPath)
    expect(content).not.toContain('[[openai.accounts]]')
  })

  it('reports invalid_auth when auth files are malformed', async () => {
    const root = await setupHome()
    await writeAuth(root, 'account1', { tokens: {} })
    await writeAuth(root, 'account2', { invalid: 'structure' })

    const configPath = path.join(root, 'config.toml')
    const result = await syncAiUsagebarAccounts({ configPath, homeDirectory: root })

    expect(result.status).toBe('invalid_auth')
    expect(result.errors.length).toBeGreaterThan(0)

    const content = await readConfig(configPath)
    expect(content).not.toContain('[[openai.accounts]]')
  })

  it('strips stale managed blocks when all auth becomes invalid', async () => {
    const root = await setupHome()
    await writeAuth(root, 'account1', { tokens: { access_token: 'a'.repeat(32) } })

    const configPath = path.join(root, 'config.toml')
    await syncAiUsagebarAccounts({ configPath, homeDirectory: root })
    let content = await readConfig(configPath)
    expect(content).toContain('# Managed by DevOrbit')

    await writeAuth(root, 'account1', { tokens: {} })
    await syncAiUsagebarAccounts({ configPath, homeDirectory: root })
    content = await readConfig(configPath)
    expect(content).not.toContain('codex_auth_path')
    expect(content).not.toContain('[[openai.accounts]]')
  })

  it('reports ok and writes only valid profiles when mixed', async () => {
    const root = await setupHome()
    await writeAuth(root, 'account1', { tokens: { access_token: 'a'.repeat(32) } })
    await writeAuth(root, 'account2', { tokens: {} })

    const configPath = path.join(root, 'config.toml')
    const result = await syncAiUsagebarAccounts({ configPath, homeDirectory: root })

    expect(result.status).toBe('ok')
    expect(result.profiles).toHaveLength(1)
    expect(result.profiles[0].codex_auth_path).toContain('.codex-conta1')
    expect(result.errors.length).toBeGreaterThan(0)

    const content = await readConfig(configPath)
    const matches = content.match(/\[\[openai\.accounts\]\]/g)
    expect(matches).toHaveLength(1)
  })

  it('preserves existing TOML sections and keys', async () => {
    const root = await setupHome()
    await writeAuth(root, 'account1', { tokens: { access_token: 'a'.repeat(32) } })

    const configPath = path.join(root, 'config.toml')
    const existing = '[general]\nname = "test"\nversion = "1.0"\n\n[openai]\nenabled = true\n\n[other]\nfoo = "bar"\n'
    await fs.writeFile(configPath, existing, 'utf8')

    const result = await syncAiUsagebarAccounts({ configPath, homeDirectory: root })

    expect(result.status).toBe('ok')
    const content = await readConfig(configPath)
    expect(content).toContain('[general]')
    expect(content).toContain('name = "test"')
    expect(content).toContain('[other]')
    expect(content).toContain('foo = "bar"')
    expect(content).toContain('[[openai.accounts]]')
    expect(content).toContain('# Managed by DevOrbit')
  })

  it('replaces only managed blocks on re-sync, preserving third-party entries', async () => {
    const root = await setupHome()
    await writeAuth(root, 'account1', { tokens: { access_token: 'a'.repeat(32) } })

    const configPath = path.join(root, 'config.toml')
    const existing = [
      '',
      '# Managed by DevOrbit (ai-usagebar account sync).',
      '[[openai.accounts]]',
      'codex_auth_path = "/old/path"',
      'label = "Old"',
      '',
      '# Managed by DevOrbit (ai-usagebar account sync).',
      '[[openai.accounts]]',
      'codex_auth_path = "/old/path2"',
      'label = "Old2"',
      '',
      '[[openai.accounts]]',
      'codex_auth_path = "/user/custom"',
      'label = "User Custom"',
      '',
    ].join('\n')
    await fs.writeFile(configPath, existing, 'utf8')

    await syncAiUsagebarAccounts({ configPath, homeDirectory: root })
    const content = await readConfig(configPath)

    expect(content).toContain('codex_auth_path = "/user/custom"')
    expect(content).not.toContain('/old/path')
    expect(content).not.toContain('/old/path2')
    const matches = content.match(/\[\[openai\.accounts\]\]/g)
    expect(matches).toHaveLength(2)
  })

  it('accepts explicit profiles and writes only those', async () => {
    const root = await setupHome()
    const configPath = path.join(root, 'config.toml')
    const result = await syncAiUsagebarAccounts({
      configPath,
      homeDirectory: root,
      profiles: [
        { codex_auth_path: '/tmp/auth1.json', label: 'Custom 1' },
        { codex_auth_path: '/tmp/auth2.json', label: 'Custom 2' },
        { codex_auth_path: '/tmp/auth3.json', label: 'Custom 3' },
      ],
    })

    expect(result.status).toBe('ok')
    expect(result.profiles).toHaveLength(3)
    expect(result.profiles[0].label).toBe('Custom 1')
    expect(result.profiles[2].label).toBe('Custom 3')
  })

  it('caps profiles at 3', async () => {
    const root = await setupHome()
    const configPath = path.join(root, 'config.toml')
    const result = await syncAiUsagebarAccounts({
      configPath,
      homeDirectory: root,
      profiles: [
        { codex_auth_path: '/a', label: 'P1' },
        { codex_auth_path: '/b', label: 'P2' },
        { codex_auth_path: '/c', label: 'P3' },
        { codex_auth_path: '/d', label: 'P4' },
      ],
    })

    expect(result.profiles).toHaveLength(3)
    expect(result.profiles.map((p) => p.label)).toEqual(['P1', 'P2', 'P3'])
  })

  it('handles show_default_account=false correctly', async () => {
    const root = await setupHome()
    await writeAuth(root, 'account1', { tokens: { access_token: 'a'.repeat(32) } })
    const configPath = path.join(root, 'config.toml')

    const withOpenaiSection = '[openai]\nenabled = true\n'
    await fs.writeFile(configPath, withOpenaiSection, 'utf8')

    await syncAiUsagebarAccounts({ configPath, homeDirectory: root })
    const content = await readConfig(configPath)
    expect(content).toContain('show_default_account = false')
    const lines = content.split('\n').filter((l) => l.includes('show_default_account'))
    expect(lines).toHaveLength(1)
  })

  it('returns missing_auth when profiles array is empty', async () => {
    const root = await setupHome()
    const configPath = path.join(root, 'config.toml')
    const result = await syncAiUsagebarAccounts({ configPath, homeDirectory: root, profiles: [] })

    expect(result.status).toBe('missing_auth')
    expect(result.profiles).toHaveLength(0)
  })

  it('never writes CODEX_HOME to TOML, only codex_auth_path', async () => {
    const root = await setupHome()
    await writeAuth(root, 'account1', { tokens: { access_token: 'a'.repeat(32) } })

    const configPath = path.join(root, 'config.toml')
    await syncAiUsagebarAccounts({ configPath, homeDirectory: root })

    const content = await readConfig(configPath)
    expect(content).not.toContain('.codex-conta1"')
    expect(content).toContain('.codex-conta1/auth.json"')
  })
})

describe('createAiUsagebarAsyncLock', () => {
  it('serializes concurrent calls', async () => {
    const lock = createAiUsagebarAsyncLock()
    const order: number[] = []
    let counter = 0

    const task = (delay: number, id: number) => lock.withLock(async () => {
      const current = counter++
      order.push(current)
      await new Promise((resolve) => setTimeout(resolve, delay))
      order.push(current + 0.5)
      return id
    })

    await Promise.all([task(10, 1), task(5, 2), task(1, 3)])
    expect(order).toEqual([0, 0.5, 1, 1.5, 2, 2.5])
  })

  it('propagates errors without blocking queue', async () => {
    const lock = createAiUsagebarAsyncLock()

    const failing = lock.withLock(async () => {
      throw new Error('fail')
    })
    await expect(failing).rejects.toThrow('fail')

    const result = await lock.withLock(async () => 42)
    expect(result).toBe(42)
  })
})

describe('atomic writes', () => {
  it('skips write when output equals existing content (byte-for-byte)', async () => {
    const root = await setupHome()
    await writeAuth(root, 'account1', { tokens: { access_token: 'a'.repeat(32) } })

    const configPath = path.join(root, 'config.toml')
    await syncAiUsagebarAccounts({ configPath, homeDirectory: root })
    const content1 = await readConfig(configPath)

    await new Promise((r) => setTimeout(r, 20))
    await syncAiUsagebarAccounts({ configPath, homeDirectory: root })
    const content2 = await readConfig(configPath)

    expect(content2).toBe(content1)
    const matches = content2.match(/show_default_account/g)
    expect(matches).toHaveLength(1)
  })
})
