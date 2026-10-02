import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  health: vi.fn(async () => [{ id: 'opencode', state: 'ready' }]),
  resolveTurn: vi.fn(async (_config: unknown, provider: string) => ({
    available: true,
    provider,
    model: 'mock-model',
    tier: 'fast',
  })),
  active: new Set<string>(),
  getGeneration: vi.fn(() => 1),
  startTerminal: vi.fn(async (id: string) => ({ id, pid: 10 })),
  waitReady: vi.fn(),
  waitResult: vi.fn(async () => ({ result: 'ok' })),
  sendInstruction: vi.fn(async () => ({ acked: true, attempts: 1 })),
}))

vi.mock('electron', () => ({ default: { app: { getPath: () => 'C:\\Temp\\DevOrbit' } } }))
vi.mock('../src/main/project-paths', () => ({ validateProjectPath: async (value: unknown) => String(value) }))
vi.mock('../src/main/config', () => ({ loadConfig: async () => ({ customPaths: {}, modelRouting: {} }) }))
vi.mock('../src/main/agent-providers', () => ({
  executeExplicitAgentTurn: vi.fn(),
  getAgentProviderHealth: state.health,
  orderProvidersForTask: (preferred: string, readyIds: string[]) => readyIds.includes(preferred) ? [preferred] : [],
  resolveAgentProviderWithFallback: vi.fn(),
  resolveAgentTurn: state.resolveTurn,
  resolveProviderInstructionHints: () => undefined,
}))
vi.mock('../src/main/agent-instruction', () => ({ sendAgentInstruction: state.sendInstruction }))
vi.mock('../src/main/terminal-session', () => ({
  TERMINAL_MAX_COLS: 400,
  TERMINAL_MAX_ROWS: 200,
  TERMINAL_MIN_COLS: 20,
  TERMINAL_MIN_ROWS: 5,
  hasTerminal: (id: string) => state.active.has(id),
  onTerminalEvent: () => () => undefined,
  resizeTerminal: vi.fn(() => true),
  startTerminal: state.startTerminal,
  stopTerminal: vi.fn(),
  writeTerminal: vi.fn(() => true),
}))

import { registerTerminalIpc, type TerminalIpcDependencies } from '../src/main/ipc/terminal-ipc'
import type { IpcRegistrar } from '../src/main/ipc/registrar'
import { resetTurnQueues } from '../src/main/agent-turn'
import type { AgentProviderId } from '../src/shared/agent-provider-contract'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function createHarness() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const register = ((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) as unknown as IpcRegistrar
  const turnSessions = new Map<string, { provider: AgentProviderId; model: string }>([
    ['agent-queued', { provider: 'opencode', model: 'mock-model' }],
  ])
  const dependencies: TerminalIpcDependencies = {
    getTerminalLifecycleGeneration: state.getGeneration,
    assertTerminalLifecycle: () => undefined,
    bridgeEnv: () => ({}),
    registerBridgeAgent: vi.fn(),
    cancelBridgeTarget: vi.fn(),
    turnSessions,
    waitTurnResult: state.waitResult as unknown as TerminalIpcDependencies['waitTurnResult'],
    waitTerminalReady: state.waitReady as TerminalIpcDependencies['waitTerminalReady'],
  }
  registerTerminalIpc(register, dependencies)
  const handler = handlers.get('devorbit:sendAgentTurn')
  const startTerminalHandler = handlers.get('devorbit:startTerminal')
  if (!handler) throw new Error('canal sendAgentTurn não registrado')
  if (!startTerminalHandler) throw new Error('canal startTerminal não registrado')
  return { dependencies, handler, startTerminalHandler, turnSessions }
}

describe('devorbit:sendAgentTurn lifecycle', () => {
  beforeEach(() => {
    resetTurnQueues()
    state.health.mockClear()
    state.resolveTurn.mockClear()
    state.getGeneration.mockClear()
    state.active.clear()
    state.active.add('agent-queued')
    state.startTerminal.mockClear()
    state.waitReady.mockReset()
    state.waitResult.mockReset()
    state.waitResult.mockImplementation(() => {
      const result = Promise.resolve({ result: 'ok' }) as Promise<{ result: string }> & { cancel?: () => void }
      result.cancel = vi.fn()
      return result
    })
    state.sendInstruction.mockReset()
    state.sendInstruction.mockResolvedValue({ acked: true, attempts: 1 })
  })

  it('serializa dois turnos concorrentes sem cancelar o primeiro nem limpar a sessão', async () => {
    const firstReadiness = deferred<{ timedOut: boolean }>()
    state.waitReady
      .mockImplementationOnce(() => firstReadiness.promise)
      .mockResolvedValue({ timedOut: false })
    const { handler, dependencies, turnSessions } = createHarness()

    const first = handler(null, 'agent-queued', 'opencode', 'C:\\work', 'tarefa A')
    await vi.waitFor(() => expect(dependencies.waitTerminalReady).toHaveBeenCalledTimes(1))

    const second = handler(null, 'agent-queued', 'opencode', 'C:\\work', 'tarefa B')
    await vi.waitFor(() => expect(state.getGeneration).toHaveBeenCalledTimes(2))
    firstReadiness.resolve({ timedOut: false })

    await expect(first).resolves.toMatchObject({ success: true, result: 'ok' })
    await expect(second).resolves.toMatchObject({ success: true, result: 'ok' })
    expect(state.sendInstruction).toHaveBeenCalledTimes(2)
    expect(dependencies.turnSessions.get('agent-queued')).toEqual({ provider: 'opencode', model: 'mock-model' })
    expect(state.startTerminal).not.toHaveBeenCalled()
  })

  it('um turno antigo não apaga a sessão que um novo start já registrou', async () => {
    const oldReadiness = deferred<{ timedOut: boolean }>()
    state.waitReady.mockImplementationOnce(() => oldReadiness.promise)
    const { handler, startTerminalHandler, dependencies, turnSessions } = createHarness()

    const oldTurn = handler(null, 'agent-queued', 'opencode', 'C:\\work', 'turno antigo')
    await vi.waitFor(() => expect(dependencies.waitTerminalReady).toHaveBeenCalledTimes(1))

    await startTerminalHandler(null, 'agent-queued', 'C:\\work')
    turnSessions.set('agent-queued', { provider: 'claude', model: 'new-model' })
    oldReadiness.resolve({ timedOut: false })

    await expect(oldTurn).rejects.toMatchObject({ code: 'TERMINAL_LAUNCH_CANCELLED' })
    expect(turnSessions.get('agent-queued')).toEqual({ provider: 'claude', model: 'new-model' })
  })
})
