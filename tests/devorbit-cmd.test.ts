import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

describe('devorbit.cmd CLI wrapper exit code propagation', () => {
  const isWindows = process.platform === 'win32'
  const cmdPath = path.resolve(__dirname, '..', 'devorbit.cmd')

  it.runIf(isWindows)('propagates exit code 2 on invalid CLI usage arguments', () => {
    const res = spawnSync(process.env.COMSPEC || 'cmd.exe', ['/c', cmdPath, 'invalid-command'], {
      encoding: 'utf8',
    })
    expect(res.status).toBe(2)
    expect(res.stderr).toMatch(/Usage: devorbit agent/)
  })

  it.runIf(isWindows)('propagates exit code 1 when bridge environment is missing', () => {
    const res = spawnSync(process.env.COMSPEC || 'cmd.exe', ['/c', cmdPath, 'agent', 'wait', 'agent-1'], {
      encoding: 'utf8',
      env: { ...process.env, DEVORBIT_BRIDGE_PIPE: '', DEVORBIT_BRIDGE_TOKEN: '', DEVORBIT_SESSION_ID: '' },
    })
    expect(res.status).toBe(1)
    expect(res.stderr).toMatch(/DevOrbit bridge environment is not configured/i)
  })

  it.runIf(isWindows)('propagates exit code 2 when required target or arguments are missing', () => {
    const res = spawnSync(process.env.COMSPEC || 'cmd.exe', ['/c', cmdPath, 'agent', 'send'], {
      encoding: 'utf8',
    })
    expect(res.status).toBe(2)
    expect(res.stderr).toMatch(/Usage: devorbit agent send/)
  })
})
