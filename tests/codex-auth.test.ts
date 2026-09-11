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
  getCodexHome: vi.fn((account: string) => `C:/devorbit/${account}`),
  hasValidCodexAuth: hasValidCodexAuthMock,
  resolveBrowserPath: vi.fn(async () => 'C:/devorbit/browser.exe'),
}))

import { cancelCodexLogin, startCodexDeviceLogin } from '../src/main/codex-auth'

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
  it('terminates the Windows process tree and ignores late close callbacks after cancel', async () => {
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

    expect(execFileMock).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '4242', '/T', '/F'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    )
    expect(progress).toContain('cancelled')
    expect(progress).not.toContain('success')
  })

  it('does not let an older login resume after a newer request starts', async () => {
    const firstChild = new FakeChild()
    const newestChild = new FakeChild()
    spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(newestChild)

    let releaseFirstKill: ((error: Error | null, result?: unknown) => void) | null = null
    let deferFirstKill = true
    execFileMock.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, result?: unknown) => void) => {
      if (deferFirstKill) {
        deferFirstKill = false
        releaseFirstKill = callback
        return
      }
      callback(null, { stdout: '', stderr: '' })
    })

    const firstStart = startCodexDeviceLogin('account1', () => undefined)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    firstChild.emit('spawn')
    await firstStart

    const olderRequestProgress: string[] = []
    const olderRequest = startCodexDeviceLogin('account2', (event) => olderRequestProgress.push(event.status))
    await vi.waitFor(() => expect(releaseFirstKill).not.toBeNull())

    // A third request arrives while request two is still awaiting taskkill.
    // Request two must observe the newer generation and never spawn a child.
    const newestRequest = startCodexDeviceLogin('account1', () => undefined)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    newestChild.emit('spawn')
    await newestRequest

    if (releaseFirstKill === null) throw new Error('taskkill callback não foi capturado')
    const release = releaseFirstKill as unknown as (error: Error | null, result?: unknown) => void
    release(null, { stdout: '', stderr: '' })
    await olderRequest

    expect(olderRequestProgress).toContain('cancelled')
    expect(spawnMock).toHaveBeenCalledTimes(2)
    deferFirstKill = false
  })
})
