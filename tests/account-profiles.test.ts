import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  getAuthFilePaths,
  getBrowserLaunchArgs,
  getBrowserProfileDirectory,
  getCodexHome,
  hasValidCodexAuth,
  isAuthOrReopenUrl,
  isValidCodexAuthDocument,
  resolveBrowserPath,
  resolveCodexCommand,
  shouldTrackBrowserUsage,
} from '../src/main/account-profiles'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('isolated account profiles', () => {
  it('uses distinct persistent Codex homes and browser profiles', () => {
    const root = path.join(os.tmpdir(), 'devorbit-account-test')
    expect(getCodexHome('account1', root)).not.toBe(getCodexHome('account2', root))
    expect(getBrowserProfileDirectory('account1', root)).toBe(path.join(root, 'browser-profiles', 'account1'))
    expect(getBrowserProfileDirectory('account2', root)).toBe(path.join(root, 'browser-profiles', 'account2'))

    expect(getBrowserLaunchArgs(getBrowserProfileDirectory('account2', root), 'https://chatgpt.com'))
      .toEqual([
        `--user-data-dir=${path.join(root, 'browser-profiles', 'account2')}`,
        '--new-window',
        '--no-first-run',
        '--no-default-browser-check',
        'https://chatgpt.com',
      ])
  })

  it('accepts only structurally valid Codex auth documents', async () => {
    expect(isValidCodexAuthDocument({ tokens: { access_token: 'short' } })).toBe(false)
    expect(isValidCodexAuthDocument({ tokens: { access_token: 'a'.repeat(32) } })).toBe(true)
    const expiredPayload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60 })).toString('base64url')
    expect(isValidCodexAuthDocument({ tokens: { access_token: `header.${expiredPayload}.signature` } })).toBe(false)
    expect(isValidCodexAuthDocument({ OPENAI_API_KEY: 'sk-' + 'a'.repeat(24) })).toBe(true)
    expect(isValidCodexAuthDocument({ tokens: [] })).toBe(false)

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-account-auth-'))
    temporaryDirectories.push(root)
    await fs.writeFile(path.join(root, 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'b'.repeat(32) } }))
    expect(await hasValidCodexAuth(root)).toBe(true)
    await fs.writeFile(path.join(root, 'auth.json'), '{malformed')
    expect(await hasValidCodexAuth(root)).toBe(false)
  })

  it('shares one auth-path list between usage and auth checks', () => {
    const root = path.join(os.tmpdir(), 'devorbit-account-paths')
    expect(getAuthFilePaths('account1', root)).toEqual([
      path.join(root, '.codex-conta1', 'auth.json'),
      path.join(root, '.codex', 'auth.json'),
    ])
    expect(getAuthFilePaths('account2', root)).toEqual([
      path.join(root, '.codex-conta2', 'auth.json'),
    ])
  })

  it('prefers an existing custom browser executable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-browser-'))
    temporaryDirectories.push(root)
    const fake = path.join(root, 'brave.exe')
    await fs.writeFile(fake, 'x')
    expect(await resolveBrowserPath('account2', fake)).toBe(fake)
    expect(await resolveBrowserPath('account1', path.join(root, 'missing.exe'))).not.toBe(path.join(root, 'missing.exe'))
  })

  it('encontra o executÃ¡vel versionado do Codex mesmo sem codex.cmd no PATH', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-codex-bin-'))
    temporaryDirectories.push(root)
    const executable = path.join(root, 'OpenAI', 'Codex', 'bin', 'version', 'codex.exe')
    const previousLocalAppData = process.env.LOCALAPPDATA
    process.env.LOCALAPPDATA = root
    await fs.mkdir(path.dirname(executable), { recursive: true })
    await fs.writeFile(executable, 'fixture')

    try {
      expect(await resolveCodexCommand('codex.cmd')).toBe(executable)
    } finally {
      if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA
      else process.env.LOCALAPPDATA = previousLocalAppData
    }
  })

  it('does not count OAuth/auth reopen URLs as ChatGPT usage', () => {
    expect(isAuthOrReopenUrl('https://auth.openai.com/oauth/authorize?code=secret')).toBe(true)
    expect(isAuthOrReopenUrl('https://chatgpt.com/auth/login')).toBe(true)
    expect(isAuthOrReopenUrl('https://chatgpt.com/c/normal-conversation')).toBe(false)
    expect(isAuthOrReopenUrl('http://auth.openai.com/oauth/authorize')).toBe(false)
    expect(shouldTrackBrowserUsage(undefined)).toBe(true)
    expect(shouldTrackBrowserUsage('https://chatgpt.com')).toBe(false)
    expect(shouldTrackBrowserUsage('https://auth.openai.com/oauth/authorize?code=secret')).toBe(false)
  })
})
