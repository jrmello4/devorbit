import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const autoUpdaterMock = vi.hoisted(() => ({
  autoDownload: false,
  autoInstallOnAppQuit: false,
  on: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
  requestHeaders: null as Record<string, string> | null,
}))

vi.mock('electron-updater', () => ({
  default: { autoUpdater: autoUpdaterMock },
}))

import {
  _resetUpdaterForTest,
  _setExecFileRunnerForTest,
  checkInstalledForUpdates,
  checkPortableForUpdates,
  getBackoffDelay,
  getGitHubToken,
  getPortableExecutablePath,
  getUpdateDiagnostic,
  getUpdateDistribution,
  getUpdateState,
  handleAppQuitPortableUpdate,
  isNewerVersion,
  isValidUpdateSize,
  maskToken,
  MAX_UPDATE_BYTES,
  parsePortableManifest,
  PUBLISH_CONFIG,
  resolveGitHubToken,
  scheduleNextCheck,
  stopPeriodicUpdater,
  UPDATE_BACKOFF_MULTIPLIER,
  UPDATE_BASE_INTERVAL_MS,
  UPDATE_INITIAL_BACKOFF_MS,
  UPDATE_MAX_BACKOFF_MS,
} from '../src/main/updater'

describe('getUpdateDistribution', () => {
  it('classifica checkout como dev', () => {
    expect(getUpdateDistribution({ packaged: false, platform: 'win32' })).toBe('dev')
  })
  it('classifica portable pelo env', () => {
    expect(getUpdateDistribution({ packaged: true, platform: 'win32', portableDir: 'C:\\portable' })).toBe('portable')
  })
  it('classifica NSIS instalado', () => {
    expect(getUpdateDistribution({ packaged: true, platform: 'win32', portableDir: '' })).toBe('installed')
  })
  it('plataforma fora do Windows não promete update', () => {
    expect(getUpdateDistribution({ packaged: true, platform: 'darwin', portableDir: '' })).toBe('dev')
  })
})

describe('portable update helpers', () => {
  it('rejects invalid or oversized update bodies', () => {
    expect(isValidUpdateSize(0)).toBe(true)
    expect(isValidUpdateSize(MAX_UPDATE_BYTES)).toBe(true)
    expect(isValidUpdateSize(MAX_UPDATE_BYTES + 1)).toBe(false)
    expect(isValidUpdateSize(-1)).toBe(false)
    expect(isValidUpdateSize(Number.POSITIVE_INFINITY)).toBe(false)
  })

  it('detects only newer stable versions', () => {
    expect(isNewerVersion('1.0.15', '1.0.14')).toBe(true)
    expect(isNewerVersion('1.0.14', '1.0.14')).toBe(false)
    expect(isNewerVersion('1.0.13', '1.0.14')).toBe(false)
    expect(isNewerVersion('invalid', '1.0.14')).toBe(false)
  })

  it('parses and validates the portable manifest', () => {
    const digest = 'a'.repeat(128)
    expect(parsePortableManifest('\uFEFFversion: 1.0.15\npath: DevOrbit-1.0.15-portable.exe\nsha512: ' + digest)).toEqual({
      version: '1.0.15',
      path: 'DevOrbit-1.0.15-portable.exe',
      sha512: digest,
    })
    expect(parsePortableManifest('version: 1.0.15\npath: ../unsafe.exe\nsha512: ' + digest)).toBeNull()
  })

  it('locates the portable executable from builder environment values', () => {
    expect(getPortableExecutablePath({ portableExecutableFile: 'C:\\portable\\DevOrbit.exe' })).toBe('C:\\portable\\DevOrbit.exe')
    expect(getPortableExecutablePath({ portableExecutableDir: 'C:\\portable', executablePath: 'C:\\runtime\\electron.exe' })).toBe('C:\\portable\\electron.exe')
  })
})

describe('retry with exponential backoff', () => {
  beforeEach(() => {
    _resetUpdaterForTest()
  })

  it('returns base interval when failures is 0', () => {
    expect(getBackoffDelay(0)).toBe(UPDATE_BASE_INTERVAL_MS)
  })

  it('computes exponential backoff on consecutive failures', () => {
    expect(getBackoffDelay(1)).toBe(UPDATE_INITIAL_BACKOFF_MS)
    expect(getBackoffDelay(2)).toBe(UPDATE_INITIAL_BACKOFF_MS * UPDATE_BACKOFF_MULTIPLIER)
    expect(getBackoffDelay(3)).toBe(UPDATE_INITIAL_BACKOFF_MS * UPDATE_BACKOFF_MULTIPLIER * UPDATE_BACKOFF_MULTIPLIER)
  })

  it('caps backoff delay at maximum interval', () => {
    expect(getBackoffDelay(10)).toBe(UPDATE_MAX_BACKOFF_MS)
    expect(getBackoffDelay(50)).toBe(UPDATE_MAX_BACKOFF_MS)
  })

  it('allows stopping periodic checks cleanly without lingering timers', () => {
    scheduleNextCheck(1000)
    stopPeriodicUpdater()
    // Calling stopPeriodicUpdater again is safe and idempotent
    expect(() => stopPeriodicUpdater()).not.toThrow()
  })
})

describe('github token resolution', () => {
  const originalGhToken = process.env.GH_TOKEN
  const originalGitHubToken = process.env.GITHUB_TOKEN

  beforeEach(() => {
    if (originalGhToken !== undefined) process.env.GH_TOKEN = originalGhToken
    else delete process.env.GH_TOKEN
    if (originalGitHubToken !== undefined) process.env.GITHUB_TOKEN = originalGitHubToken
    else delete process.env.GITHUB_TOKEN
  })

  it('reads token from GH_TOKEN or GITHUB_TOKEN environment variable', async () => {
    process.env.GH_TOKEN = 'test-token-123'
    expect(await getGitHubToken()).toBe('test-token-123')

    delete process.env.GH_TOKEN
    process.env.GITHUB_TOKEN = 'github-token-456'
    expect(await getGitHubToken()).toBe('github-token-456')
  })

  it('masks sensitive tokens without leaking raw secrets', () => {
    expect(maskToken(null)).toBeNull()
    expect(maskToken('')).toBeNull()
    expect(maskToken('short')).toBe('***')
    expect(maskToken('12345678')).toBe('***')
    expect(maskToken('gho_1234567890abcdef')).toBe('gho_...cdef')
    expect(maskToken('github_pat_11ABCD_XYZ9999')).toBe('gith...9999')
  })

  it('identifies token source correctly from environment or CLI', async () => {
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN

    _setExecFileRunnerForTest(async () => ({ stdout: 'gho_secret_from_cli_1234', stderr: '' }))
    const cliResolution = await resolveGitHubToken()
    expect(cliResolution.source).toBe('gh-cli')
    expect(cliResolution.token).toBe('gho_secret_from_cli_1234')
    expect(cliResolution.masked).toBe('gho_...1234')

    process.env.GH_TOKEN = 'ghp_env_token_5678'
    const envResolution = await resolveGitHubToken()
    expect(envResolution.source).toBe('env:GH_TOKEN')
    expect(envResolution.token).toBe('ghp_env_token_5678')
    expect(envResolution.masked).toBe('ghp_...5678')
  })
})

describe('gh auth token is delivered via headers, never process.env', () => {
  const originalGhToken = process.env.GH_TOKEN
  const originalGitHubToken = process.env.GITHUB_TOKEN

  beforeEach(() => {
    _resetUpdaterForTest()
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
    autoUpdaterMock.checkForUpdates.mockReset()
    autoUpdaterMock.requestHeaders = null
  })

  afterEach(() => {
    if (originalGhToken !== undefined) process.env.GH_TOKEN = originalGhToken
    else delete process.env.GH_TOKEN
    if (originalGitHubToken !== undefined) process.env.GITHUB_TOKEN = originalGitHubToken
    else delete process.env.GITHUB_TOKEN
    _setExecFileRunnerForTest(null)
  })

  it('usa o token só em headers/provider e mantém process.env sem GH_TOKEN/GITHUB_TOKEN', async () => {
    const cliToken = 'gho_cli_injected_token_8888'
    let tokenDuringCheck: string | undefined
    let githubTokenDuringCheck: string | undefined
    let headersDuringCheck: Record<string, string> | null | undefined

    _setExecFileRunnerForTest(async (file, args) => {
      if (file === 'gh' && args[0] === 'auth' && args[1] === 'token') {
        return { stdout: `${cliToken}\n`, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    autoUpdaterMock.checkForUpdates.mockImplementation(async () => {
      tokenDuringCheck = process.env.GH_TOKEN
      githubTokenDuringCheck = process.env.GITHUB_TOKEN
      headersDuringCheck = autoUpdaterMock.requestHeaders
      return {} as any
    })

    await checkInstalledForUpdates('installed')

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    // Garantia: o ambiente herdado (inclusive PTYs/agentes) nunca recebe o token.
    expect(tokenDuringCheck).toBeUndefined()
    expect(githubTokenDuringCheck).toBeUndefined()
    expect(process.env.GH_TOKEN).toBeUndefined()
    expect(process.env.GITHUB_TOKEN).toBeUndefined()
    // O token vai apenas nos headers usados pelo provider do electron-updater.
    expect(headersDuringCheck?.Authorization).toBe(`Bearer ${cliToken}`)

    const diagnostic = getUpdateDiagnostic()
    expect(diagnostic).toBeDefined()
    expect(diagnostic?.hasToken).toBe(true)
    expect(diagnostic?.tokenSource).toBe('gh-cli')
    expect(diagnostic?.tokenMasked).toBe('gho_...8888')
    expect(diagnostic?.provider).toBe('github')
    expect(diagnostic?.isPrivate).toBe(true)
    expect(diagnostic?.tokenMasked).not.toContain('injected')
  })
})

describe('portable asset discovery via GitHub REST API', () => {
  const originalGhToken = process.env.GH_TOKEN
  const originalGitHubToken = process.env.GITHUB_TOKEN
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    _resetUpdaterForTest()
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
  })

  afterEach(() => {
    if (originalGhToken !== undefined) process.env.GH_TOKEN = originalGhToken
    else delete process.env.GH_TOKEN
    if (originalGitHubToken !== undefined) process.env.GITHUB_TOKEN = originalGitHubToken
    else delete process.env.GITHUB_TOKEN
    _setExecFileRunnerForTest(null)
    globalThis.fetch = originalFetch
  })

  it('queries /releases/latest and downloads latest-portable.yml via private asset API', async () => {
    const token = 'gho_api_test_token_7777'
    _setExecFileRunnerForTest(async () => ({ stdout: `${token}\n`, stderr: '' }))

    const requestedUrls: string[] = []
    const requestedHeaders: Record<string, any>[] = []

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      requestedUrls.push(url)
      requestedHeaders.push((init?.headers as Record<string, string>) || {})

      if (url.includes('/releases/latest')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () =>
            JSON.stringify({
              tag_name: 'v1.0.32',
              assets: [
                { id: 101, name: 'latest-portable.yml', url: 'https://api.github.com/repos/jrmello4/devorbit/releases/assets/101', size: 200 },
                { id: 102, name: 'DevOrbit-1.0.32-portable.exe', url: 'https://api.github.com/repos/jrmello4/devorbit/releases/assets/102', size: 50000000 },
              ],
            }),
        } as any
      }

      if (url.includes('/releases/assets/101')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/octet-stream' }),
          text: async () => 'version: 1.0.32\npath: DevOrbit-1.0.32-portable.exe\nsha512: ' + 'b'.repeat(128),
        } as any
      }

      return { ok: false, status: 404, text: async () => 'Not found' } as any
    })

    await checkPortableForUpdates('portable')

    expect(requestedUrls[0]).toBe('https://api.github.com/repos/jrmello4/devorbit/releases/latest')
    expect(requestedHeaders[0].Authorization).toBe(`Bearer ${token}`)
    expect(requestedHeaders[0].Accept).toBe('application/vnd.github.v3+json')

    expect(requestedUrls[1]).toBe('https://api.github.com/repos/jrmello4/devorbit/releases/assets/101')
    expect(requestedHeaders[1].Authorization).toBe(`Bearer ${token}`)
    expect(requestedHeaders[1].Accept).toBe('application/octet-stream')

    const diagnostic = getUpdateDiagnostic()
    expect(diagnostic?.hasToken).toBe(true)
    expect(diagnostic?.tokenSource).toBe('gh-cli')
    expect(diagnostic?.manifestFound).toBe(true)
    expect(diagnostic?.manifestVersion).toBe('1.0.32')
    expect(diagnostic?.manifestPath).toBe('DevOrbit-1.0.32-portable.exe')
    expect(diagnostic?.releaseTag).toBe('v1.0.32')
  })

  it('reports exact HTTP status when release query returns HTTP 404', async () => {
    const token = 'gho_api_test_token_7777'
    _setExecFileRunnerForTest(async () => ({ stdout: `${token}\n`, stderr: '' }))

    globalThis.fetch = vi.fn().mockImplementation(async () => ({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    }))

    await checkPortableForUpdates('portable')

    const state = getUpdateState()
    expect(state.status).toBe('error')
    expect(state.message).toContain('HTTP 404')

    const diagnostic = getUpdateDiagnostic()
    expect(diagnostic?.httpStatus).toBe(404)
    expect(diagnostic?.hasToken).toBe(true)
    expect(diagnostic?.tokenMasked).toBe('gho_...7777')
    expect(diagnostic?.provider).toBe('github')
    expect(diagnostic?.isPrivate).toBe(true)
  })

  it('reports exact asset error when latest-portable.yml is missing in release', async () => {
    const token = 'gho_api_test_token_7777'
    _setExecFileRunnerForTest(async () => ({ stdout: `${token}\n`, stderr: '' }))

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/releases/latest')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () =>
            JSON.stringify({
              tag_name: 'v1.0.31',
              assets: [
                { id: 201, name: 'DevOrbit-1.0.31-x64.exe', url: 'https://api.github.com/repos/jrmello4/devorbit/releases/assets/201', size: 60000000 },
              ],
            }),
        } as any
      }
      return { ok: false, status: 404 } as any
    })

    await checkPortableForUpdates('portable')

    const state = getUpdateState()
    expect(state.status).toBe('error')
    expect(state.message).toContain('latest-portable.yml')

    const diagnostic = getUpdateDiagnostic()
    expect(diagnostic?.manifestFound).toBe(false)
    expect(diagnostic?.assetError).toContain('latest-portable.yml')
    expect(diagnostic?.assetError).toContain('DevOrbit-1.0.31-x64.exe')
    expect(diagnostic?.releaseTag).toBe('v1.0.31')
  })
})

describe('handleAppQuitPortableUpdate safe execution', () => {
  beforeEach(() => {
    _resetUpdaterForTest()
  })

  it('returns false when status is not downloaded or not in portable mode', async () => {
    expect(getUpdateState().status).toBe('unavailable')
    const triggered = await handleAppQuitPortableUpdate()
    expect(triggered).toBe(false)
  })
})
