import { beforeEach, describe, expect, it, vi } from 'vitest'
import { validateFiniteNumber } from '../src/main/validation'
import {
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
} from '../src/main/terminal-session'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node-pty', () => ({ spawn: spawnMock }))

function createFakeTerminal(pid: number) {
  const dataListeners: Array<(data: string) => void> = []
  const exitListeners: Array<(event: { exitCode: number }) => void> = []
  return {
    pid,
    cols: 120,
    rows: 32,
    onData: (callback: (data: string) => void) => { dataListeners.push(callback) },
    onExit: (callback: (event: { exitCode: number }) => void) => { exitListeners.push(callback) },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  }
}

describe('terminal narrow dimensions 20x5', () => {
  beforeEach(() => {
    vi.resetModules()
    spawnMock.mockReset()
  })

  it('exporta os limites mínimos alinhados com o resize', () => {
    expect(TERMINAL_MIN_COLS).toBe(20)
    expect(TERMINAL_MIN_ROWS).toBe(5)
    expect(TERMINAL_MAX_COLS).toBe(400)
    expect(TERMINAL_MAX_ROWS).toBe(200)
  })

  it('aceita 20x5 nos handlers de start sem rejeitar', () => {
    expect(validateFiniteNumber(20, 'Colunas do terminal', { minimum: TERMINAL_MIN_COLS, maximum: TERMINAL_MAX_COLS, integer: true })).toBe(20)
    expect(validateFiniteNumber(5, 'Linhas do terminal', { minimum: TERMINAL_MIN_ROWS, maximum: TERMINAL_MAX_ROWS, integer: true })).toBe(5)
  })

  it('inicia PTY estreito e emite resize real', async () => {
    const terminal = createFakeTerminal(901)
    spawnMock.mockReturnValue(terminal)
    const session = await import('../src/main/terminal-session')

    const events: Array<{ type: string; cols?: number; rows?: number }> = []
    session.onTerminalEvent((event) => events.push(event))

    const started = await session.startTerminal('narrow-one', 'C:\\workspace', { cols: 20, rows: 5 })
    expect(started).toEqual({ id: 'narrow-one', pid: 901 })
    expect(session.getTerminalDimensions('narrow-one')).toEqual({ cols: 20, rows: 5 })
    expect(session.resizeTerminal('narrow-one', 20, 5)).toBe(true)
    expect(session.resizeTerminal('narrow-one', 40, 12)).toBe(true)
    expect(events).toContainEqual({ id: 'narrow-one', type: 'resize', cols: 40, rows: 12 })
    session.stopTerminal('narrow-one')
  })
})
