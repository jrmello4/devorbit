import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexBridgeHealthStore } from '../src/main/codex-bridge-health'

afterEach(() => vi.useRealTimers())

describe('managed Codex Bridge health', () => {
  it('requires the current process handshake and a live registry, not a PTY spawn', async () => {
    const store = new CodexBridgeHealthStore()
    store.configure('coordinator', 'run-b', 'session-b')
    store.connecting('coordinator', 'run-b')
    expect(store.get('coordinator')?.state).toBe('connecting')
    expect(() => store.assertReady('coordinator')).toThrow()
    const pending = store.waitReady('coordinator')
    expect(store.handshake({ terminalId: 'coordinator', launchId: 'run-a', sessionId: 'session-a', pid: 1, connectedAt: 1 })).toBe(false)
    expect(store.handshake({ terminalId: 'coordinator', launchId: 'run-b', sessionId: 'session-a', pid: 2, connectedAt: 2 })).toBe(false)
    expect(store.handshake({ terminalId: 'coordinator', launchId: 'run-b', sessionId: 'session-b', pid: 3, connectedAt: 3 })).toBe(true)
    expect(store.get('coordinator')?.state).toBe('connected')
    store.registryChanged(0)
    expect(store.get('coordinator')?.code).toBe('NO_AGENTS_REGISTERED')
    store.registryChanged(2)
    expect((await pending).state).toBe('agents_available')
    expect(() => store.assertReady('coordinator')).not.toThrow()
    store.registryChanged(0)
    expect(() => store.assertReady('coordinator')).toThrow(/nenhum agente/)
    store.dispose()
  })

  it('fails boundedly without a handshake and cancels previous launch waiters on reopen', async () => {
    vi.useFakeTimers()
    const store = new CodexBridgeHealthStore(() => undefined, 100)
    store.configure('terminal', 'old', 'session')
    store.connecting('terminal', 'old')
    const pending = store.waitReady('terminal')
    const rejection = expect(pending).rejects.toMatchObject({ code: 'MCP_STARTUP_FAILED' })
    store.configure('terminal', 'new', 'new-session')
    await rejection
    store.connecting('terminal', 'new')
    await vi.advanceTimersByTimeAsync(100)
    expect(store.get('terminal')?.state).toBe('failed')
    expect(store.handshake({ terminalId: 'terminal', launchId: 'new', sessionId: 'new-session', pid: 2, connectedAt: 1 })).toBe(false)
    store.dispose()
  })

  it('does not wait forever for agents after a valid empty Bridge handshake', async () => {
    vi.useFakeTimers()
    const store = new CodexBridgeHealthStore(() => undefined, 100)
    store.configure('terminal', 'run', 'session')
    store.handshake({ terminalId: 'terminal', launchId: 'run', sessionId: 'session', pid: 2, connectedAt: 1 })
    const rejection = expect(store.waitReady('terminal')).rejects.toMatchObject({ code: 'NO_AGENTS_REGISTERED' })
    await vi.advanceTimersByTimeAsync(100)
    await rejection
    store.dispose()
  })

  it('treats the launch handshake as single-use and clears failure codes on stop', () => {
    const store = new CodexBridgeHealthStore()
    store.configure('terminal', 'run', 'session')
    store.connecting('terminal', 'run')
    expect(store.handshake({ terminalId: 'terminal', launchId: 'run', sessionId: 'session', pid: 1, connectedAt: 1 })).toBe(true)
    expect(store.handshake({ terminalId: 'terminal', launchId: 'run', sessionId: 'session', pid: 2, connectedAt: 2 })).toBe(false)
    expect(store.get('terminal')?.mcpPid).toBe(1)
    store.registryChanged(0)
    expect(store.get('terminal')?.code).toBe('NO_AGENTS_REGISTERED')
    store.stop('terminal')
    expect(store.get('terminal')?.state).toBe('stopped')
    expect(store.get('terminal')?.code).toBeUndefined()
    store.dispose()
  })

  it('keeps the handshake flowing when the health consumer throws', () => {
    const store = new CodexBridgeHealthStore(() => {
      throw new Error('webContents destruído no teardown')
    })
    store.configure('terminal', 'run', 'session')
    store.connecting('terminal', 'run')
    expect(store.handshake({ terminalId: 'terminal', launchId: 'run', sessionId: 'session', pid: 1, connectedAt: 1 })).toBe(true)
    store.registryChanged(2)
    expect(store.get('terminal')?.state).toBe('agents_available')
    expect(() => store.assertReady('terminal')).not.toThrow()
    store.dispose()
  })

  it('só preserva a saúde no start do launch gerenciado recém-configurado', () => {
    const store = new CodexBridgeHealthStore()
    store.configure('terminal', 'run', 'session')
    expect(store.consumeManagedStart('terminal')).toBe(true)
    expect(store.consumeManagedStart('terminal')).toBe(false)
    store.connecting('terminal', 'run')
    expect(store.consumeManagedStart('terminal')).toBe(true)
    store.registryChanged(0)
    store.fail('terminal', 'MCP_STARTUP_FAILED')
    expect(store.consumeManagedStart('terminal')).toBe(false)
    store.dispose()
  })

  it('connecting não ressuscita um launch failed/stopped', () => {
    const store = new CodexBridgeHealthStore()
    store.configure('terminal', 'run', 'session')
    store.connecting('terminal', 'run')
    store.fail('terminal', 'MCP_STARTUP_FAILED')
    store.connecting('terminal', 'run')
    expect(store.get('terminal')?.state).toBe('failed')
    store.stop('terminal')
    store.connecting('terminal', 'run')
    expect(store.get('terminal')?.state).toBe('stopped')
    store.dispose()
  })
})
