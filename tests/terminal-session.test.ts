import { beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}))

vi.mock('node-pty', () => ({ spawn: spawnMock }))

interface FakeTerminal {
  pid: number
  cols: number
  rows: number
  onData: (callback: (data: string) => void) => void
  onExit: (callback: (event: { exitCode: number }) => void) => void
  write: (input: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  emitData: (data: string) => void
  emitExit: (exitCode: number) => void
}

function createFakeTerminal(pid: number): FakeTerminal {
  const dataListeners: Array<(data: string) => void> = []
  const exitListeners: Array<(event: { exitCode: number }) => void> = []
  return {
    pid,
    cols: 120,
    rows: 32,
    onData: (callback) => { dataListeners.push(callback) },
    onExit: (callback) => { exitListeners.push(callback) },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    emitData: (data) => dataListeners.forEach((callback) => callback(data)),
    emitExit: (exitCode) => exitListeners.forEach((callback) => callback({ exitCode })),
  }
}

describe('terminal-session', () => {
  beforeEach(() => {
    vi.resetModules()
    spawnMock.mockReset()
  })

  it('inicia PTY, encaminha saída, escrita e redimensionamento', async () => {
    const terminal = createFakeTerminal(401)
    spawnMock.mockReturnValue(terminal)
    const { onTerminalEvent, startTerminal, writeTerminal, resizeTerminal, stopTerminal } = await import('../src/main/terminal-session')

    const events: Array<{ type: string; data?: string; code?: number | null }> = []
    const unsubscribe = onTerminalEvent((event) => events.push(event))
    const result = await startTerminal('workspace-one', 'C:\\workspace')
    expect(result).toEqual({ id: 'workspace-one', pid: 401 })

    terminal.emitData('\x1b[31mhello\x1b[0m')
    expect(events).toContainEqual({ id: 'workspace-one', type: 'data', data: '\x1b[31mhello\x1b[0m' })
    expect(writeTerminal('workspace-one', 'Ctrl-C')).toBe(true)
    expect(terminal.write).toHaveBeenCalledWith('Ctrl-C')
    expect(resizeTerminal('workspace-one', 151, 44)).toBe(true)
    expect(terminal.resize).toHaveBeenCalledWith(151, 44)

    terminal.emitExit(0)
    expect(events).toContainEqual({ id: 'workspace-one', type: 'exit', code: 0 })
    stopTerminal('workspace-one')
    expect(terminal.kill).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('ignora eventos atrasados de uma sessão substituída', async () => {
    const first = createFakeTerminal(501)
    const second = createFakeTerminal(502)
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const { onTerminalEvent, startTerminal } = await import('../src/main/terminal-session')
    const events: Array<{ id: string; type: string; data?: string }> = []
    onTerminalEvent((event) => events.push(event))

    await startTerminal('workspace-one', 'C:\\workspace')
    await startTerminal('workspace-one', 'C:\\workspace')
    first.emitData('stale')
    first.emitExit(1)
    second.emitData('fresh')

    expect(events.filter((event) => event.type === 'data')).toEqual([
      { id: 'workspace-one', type: 'data', data: 'fresh' },
    ])
  })

  it('encerra todos os PTYs e ignora operaÃ§Ãµes posteriores', async () => {
    const first = createFakeTerminal(601)
    const second = createFakeTerminal(602)
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const { startTerminal, stopAllTerminals, writeTerminal } = await import('../src/main/terminal-session')

    await startTerminal('workspace-one', 'C:\\workspace')
    await startTerminal('workspace-two', 'C:\\workspace')

    stopAllTerminals()

    expect(first.kill).toHaveBeenCalledOnce()
    expect(second.kill).toHaveBeenCalledOnce()
    expect(writeTerminal('workspace-one', 'after-cleanup')).toBe(false)
    expect(writeTerminal('workspace-two', 'after-cleanup')).toBe(false)

    stopAllTerminals()
    expect(first.kill).toHaveBeenCalledOnce()
    expect(second.kill).toHaveBeenCalledOnce()
  })
})
