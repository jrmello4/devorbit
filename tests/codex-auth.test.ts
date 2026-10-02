import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const spawnMock = vi.hoisted(() => vi.fn())
const execFileMock = vi.hoisted(() => vi.fn())
const hasValidCodexAuthMock = vi.hoisted(() => vi.fn(async () => false))

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execFile: execFileMock,
}))

vi.mock('electron', () => ({
  default: {
    clipboard: { writeText: vi.fn() },
  },
}))

vi.mock('../src/main/config', () => ({
  loadConfig: vi.fn(async () => ({
    customPaths: {},
    chatGptAccount1Name: 'Conta 1',
    chatGptAccount2Name: 'Conta 2',
  })),
}))

vi.mock('../src/main/account-profiles', () => ({
  checkBrowserAvailability: vi.fn(async () => ({
    account1: { browser: 'Chrome', path: 'C:/devorbit/chrome.exe', found: true },
    account2: { browser: 'Brave', path: 'C:/devorbit/brave.exe', found: true },
  })),
  ensureAccountDirectories: vi.fn(async (account: string) => ({
    codexHome: `C:/devorbit/${account}`,
    browserProfile: `C:/devorbit/browser/${account}`,
  })),
  getAccountBrowser: vi.fn((account: string) => (
    account === 'account2'
      ? { name: 'Brave', executable: 'brave.exe' }
      : { name: 'Chrome', executable: 'chrome.exe' }
  )),
  getAccountLabel: vi.fn((account: string) => account),
  getBrowserLaunchArgs: vi.fn((_profile: string, url: string) => [url]),
  getBrowserProfileDirectory: vi.fn((account: string) => `C:/devorbit/browser/${account}`),
  getCodexAccountEnvironment: vi.fn((account: string) => ({
    CODEX_HOME: `C:/devorbit/${account}`,
  })),
  getCodexHome: vi.fn((account: string) => `C:/devorbit/${account}`),
  hasValidCodexAuth: hasValidCodexAuthMock,
  resolveCodexCommand: vi.fn(async (configured: string | undefined) => configured || 'codex.cmd'),
  resolveBrowserPath: vi.fn(async () => 'C:/devorbit/browser.exe'),
}))

import { cancelCodexLogin, startCodexDeviceLogin } from '../src/main/codex-auth'
import { loadConfig } from '../src/main/config'

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn(() => true)
}

afterEach(async () => {
  await cancelCodexLogin()
  spawnMock.mockReset()
  execFileMock.mockReset()
  hasValidCodexAuthMock.mockResolvedValue(false)
})

describe('Codex login process lifecycle', () => {
  it('terminates the login process tree and ignores late close callbacks after cancel', async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    execFileMock.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, result?: unknown) => void) => {
      callback(null, { stdout: '', stderr: '' })
    })

    const progress: string[] = []
    const startup = startCodexDeviceLogin('account1', (event) => progress.push(event.status))
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('spawn')
    await startup

    await cancelCodexLogin()
    child.emit('close', 0)
    await Promise.resolve()

    if (process.platform === 'win32') {
      expect(execFileMock).toHaveBeenCalledWith(
        'taskkill',
        ['/PID', '4242', '/T', '/F'],
        expect.objectContaining({ windowsHide: true }),
        expect.any(Function),
      )
    } else {
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    }
    expect(progress).toContain('cancelled')
    expect(progress).not.toContain('success')
  })

  it('scrubs Bridge and ELECTRON_RUN_AS_NODE (case-insensitive) from the login spawn env, keeping CODEX_HOME', async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    execFileMock.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, result?: unknown) => void) => {
      callback(null, { stdout: '', stderr: '' })
    })
    const previous = {
      pipe: process.env.DEVORBIT_BRIDGE_PIPE,
      token: process.env.DEVORBIT_BRIDGE_TOKEN,
      session: process.env.DEVORBIT_SESSION_ID,
      runAsNode: process.env.ELECTRON_RUN_AS_NODE,
      runAsNodeLower: process.env.electron_run_as_node,
    }
    process.env.DEVORBIT_BRIDGE_PIPE = 'stale-pipe'
    process.env.DEVORBIT_BRIDGE_TOKEN = 'stale-token'
    process.env.DEVORBIT_SESSION_ID = 'stale-session'
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.electron_run_as_node = '1'
    try {
      const startup = startCodexDeviceLogin('account1', () => undefined)
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
      child.emit('spawn')
      await startup
      const options = spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> }
      expect(options.env).toEqual(expect.not.objectContaining({
        DEVORBIT_BRIDGE_PIPE: expect.anything(),
        DEVORBIT_BRIDGE_TOKEN: expect.anything(),
        DEVORBIT_SESSION_ID: expect.anything(),
        ELECTRON_RUN_AS_NODE: expect.anything(),
        electron_run_as_node: expect.anything(),
      }))
      expect(options.env?.CODEX_HOME).toBe('C:/devorbit/account1')
    } finally {
      if (previous.pipe === undefined) delete process.env.DEVORBIT_BRIDGE_PIPE
      else process.env.DEVORBIT_BRIDGE_PIPE = previous.pipe
      if (previous.token === undefined) delete process.env.DEVORBIT_BRIDGE_TOKEN
      else process.env.DEVORBIT_BRIDGE_TOKEN = previous.token
      if (previous.session === undefined) delete process.env.DEVORBIT_SESSION_ID
      else process.env.DEVORBIT_SESSION_ID = previous.session
      if (previous.runAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE
      else process.env.ELECTRON_RUN_AS_NODE = previous.runAsNode
      if (previous.runAsNodeLower === undefined) delete process.env.electron_run_as_node
      else process.env.electron_run_as_node = previous.runAsNodeLower
    }
  })

  it('does not let an older login resume after a newer request starts', async () => {
    const firstChild = new FakeChild()
    const newestChild = new FakeChild()
    spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(newestChild)
    execFileMock.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, result?: unknown) => void) => {
      callback(null, { stdout: '', stderr: '' })
    })

    const baseConfig = {
      projectDirs: [],
      managedProjects: [],
      projectAccounts: {},
      activeChatGptAccount: 'account1' as const,
      chatGptAccount1Name: 'Conta 1',
      chatGptAccount2Name: 'Conta 2',
      customPaths: {},
    }
    let releaseOlderLoad: (() => void) | null = null
    let olderLoadEntered = false
    const olderLoadGate = new Promise<void>((resolve) => {
      releaseOlderLoad = resolve
    })
    let loadCalls = 0
    vi.mocked(loadConfig).mockImplementation(async () => {
      loadCalls += 1
      if (loadCalls === 2) {
        olderLoadEntered = true
        await olderLoadGate
      }
      return baseConfig
    })

    const firstStart = startCodexDeviceLogin('account1', () => undefined)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    firstChild.emit('spawn')
    await firstStart

    const olderRequestProgress: string[] = []
    const olderRequest = startCodexDeviceLogin('account2', (event) => olderRequestProgress.push(event.status))
    await vi.waitFor(() => expect(olderLoadEntered).toBe(true))

    const newestRequest = startCodexDeviceLogin('account1', () => undefined)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    newestChild.emit('spawn')
    await newestRequest

    if (releaseOlderLoad === null) throw new Error('loadConfig adiado não foi capturado')
    const release = releaseOlderLoad as unknown as () => void
    release()
    await olderRequest

    expect(olderRequestProgress).toContain('cancelled')
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })
})
