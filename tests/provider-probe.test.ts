import { describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}))

import { probeProviderCommand } from '../src/main/agent-providers'

describe('probeProviderCommand', () => {
  it('proves health by executing --version', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: object, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout: 'opencode v1.2.3\n', stderr: '' })
    })
    await expect(probeProviderCommand('C:\\cli\\opencode.exe')).resolves.toMatchObject({ ok: true })
    expect(execFileMock).toHaveBeenCalledWith(
      'C:\\cli\\opencode.exe',
      ['--version'],
      expect.objectContaining({ timeout: 8000 }),
      expect.any(Function)
    )
  })

  it('reports failure instead of trusting file presence', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: object, callback: (error: Error | null) => void) => {
      callback(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    })
    await expect(probeProviderCommand('C:\\cli\\missing.exe')).resolves.toMatchObject({ ok: false })
  })

  it('rejects empty commands', async () => {
    await expect(probeProviderCommand('   ')).resolves.toMatchObject({ ok: false })
    expect(execFileMock).not.toHaveBeenCalled()
  })
})
