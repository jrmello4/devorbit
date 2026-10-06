import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  starts: [] as Array<{ id: string; command: string; args: string[]; env: NodeJS.ProcessEnv }>,
  startCodex: vi.fn(),
  prepareAiMemoryLaunch: vi.fn(),
  stopTerminal: vi.fn(),
}))

vi.mock('electron', () => ({
  default: {
    app: {
      getPath: () => 'C:\\Users\\tester\\AppData\\Roaming\\DevOrbit',
      getAppPath: () => 'C:\\DevOrbit',
      isPackaged: false,
    },
  },
}))

vi.mock('../src/main/account-profiles', () => ({
  ensureAccountDirectories: vi.fn(async (account: string) => ({
    codexHome: account === 'account2' ? 'C:\\Users\\tester\\.codex-conta2' : 'C:\\Users\\tester\\.codex-conta1',
  })),
  getAccountLabel: vi.fn(() => 'Conta de teste'),
  getCodexAccountEnvironment: vi.fn((account: string) => ({
    CODEX_HOME: account === 'account2' ? 'C:\\Users\\tester\\.codex-conta2' : 'C:\\Users\\tester\\.codex-conta1',
  })),
  hasValidCodexAuth: vi.fn(async () => true),
  resolveCodexCommand: vi.fn(async () => 'C:\\OpenAI\\Codex\\bin\\codex.exe'),
}))

vi.mock('../src/main/config', () => ({
  loadConfig: vi.fn(async () => ({
    customPaths: {},
    chatGptAccount1Name: 'C1',
    chatGptAccount2Name: 'C2',
    modelRouting: { fastModel: 'codex-model' },
  })),
}))

vi.mock('../src/main/project-paths', () => ({
  validateProjectPath: vi.fn(async (value: unknown) => String(value)),
}))

vi.mock('../src/main/ai-memory-launcher', () => ({
  prepareAiMemoryLaunch: state.prepareAiMemoryLaunch,
  registerActiveAiMemorySession: vi.fn(),
  rollbackAiMemoryLaunch: vi.fn(),
  releaseAiMemoryReservation: vi.fn(),
}))

vi.mock('../src/main/terminal-session', () => ({
  TERMINAL_MAX_COLS: 400,
  TERMINAL_MAX_ROWS: 200,
  TERMINAL_MIN_COLS: 20,
  TERMINAL_MIN_ROWS: 5,
  hasTerminal: vi.fn(() => true),
  onTerminalEvent: vi.fn(() => () => undefined),
  resizeTerminal: vi.fn(() => true),
  startTerminal: state.startCodex,
  stopTerminal: state.stopTerminal,
  writeTerminal: vi.fn(() => true),
}))

import { registerTerminalIpc, type TerminalIpcDependencies } from '../src/main/ipc/terminal-ipc'
import type { IpcRegistrar } from '../src/main/ipc/registrar'
import { releaseAiMemoryReservation, rollbackAiMemoryLaunch } from '../src/main/ai-memory-launcher'

function createHarness(health?: Record<string, unknown>) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const register = ((channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler)
  }) as unknown as IpcRegistrar
  const dependencies: TerminalIpcDependencies = {
    getTerminalLifecycleGeneration: () => 1,
    assertTerminalLifecycle: () => undefined,
    bridgeEnv: () => ({
      DEVORBIT_BRIDGE_PIPE: '\\\\.\\pipe\\devorbit-test',
      DEVORBIT_BRIDGE_TOKEN: 'bridge-secret',
      DEVORBIT_SESSION_ID: 'session-test',
    }),
    registerBridgeAgent: vi.fn(),
    cancelBridgeTarget: vi.fn(),
    turnSessions: new Map(),
    waitTurnResult: vi.fn(),
    waitTerminalReady: vi.fn(async () => ({ timedOut: false })),
    ...(health ? { codexBridgeHealth: health as never } : {}),
  }
  registerTerminalIpc(register, dependencies)
  const handler = handlers.get('devorbit:startCodexTerminal')
  if (!handler) throw new Error('startCodexTerminal handler not registered')
  return { dependencies, handler, handlers }
}

describe('devorbit:startCodexTerminal managed MCP launch', () => {
  beforeEach(() => {
    state.starts = []
    state.startCodex.mockReset()
    state.startCodex.mockImplementation(async (id: string, _cwd: string, options: { command?: string; args?: string[]; env?: NodeJS.ProcessEnv }) => {
      state.starts.push({ id, command: options.command || '', args: options.args || [], env: options.env || {} })
      return { id, pid: state.starts.length + 100 }
    })
    state.stopTerminal.mockReset()
    state.prepareAiMemoryLaunch.mockReset()
    state.prepareAiMemoryLaunch.mockResolvedValue({ wrapped: false, command: 'ignored', args: [], env: {}, cwd: 'C:\\work' })
  })

  it('passes the same managed MCP argv to a native Codex launch and keeps credentials in env', async () => {
    const configured = vi.fn()
    const connecting = vi.fn()
    const harness = createHarness({ configure: configured, connecting, fail: vi.fn(), get: vi.fn(() => undefined), stop: vi.fn() })
    const result = await harness.handler(null, 'codex-one', 'C:\\work', 'account1', 120, 32, ['resume', '--last']) as Record<string, unknown>

    expect(result.success).toBe(true)
    expect(state.starts).toHaveLength(1)
    const started = state.starts[0]
    expect(started.command).toBe('C:\\OpenAI\\Codex\\bin\\codex.exe')
    expect(started.args.slice(0, 2)).toEqual(['resume', '--last'])
    // O helper (deepmerge) emite a tabela e overrides por-chave depois dela.
    const tableIndex = started.args.findIndex((arg) => arg.startsWith('mcp_servers.devorbit={'))
    expect(tableIndex).toBeGreaterThan(0)
    expect(started.args[tableIndex - 1]).toBe('--config')
    expect(started.args.join(' ')).not.toContain('bridge-secret')
    expect(started.env).toMatchObject({ CODEX_HOME: 'C:\\Users\\tester\\.codex-conta1', DEVORBIT_BRIDGE_TOKEN: 'bridge-secret' })
    expect(configured).toHaveBeenCalledWith('codex-one', expect.any(String), 'session-test')
    expect(state.prepareAiMemoryLaunch.mock.calls[0]?.[0]).toMatchObject({
      reservationId: configured.mock.calls[0]?.[1],
    })
    expect(connecting).toHaveBeenCalledWith('codex-one', expect.any(String))
  })

  it('retries direct with a fresh managed nonce when the ai-memory wrapper exits before MCP', async () => {
    state.prepareAiMemoryLaunch.mockImplementation(async (context: { originalArgs: string[]; env: NodeJS.ProcessEnv; cwd: string }) => ({
      wrapped: true,
      command: 'C:\\ai-memory\\ai-memory.exe',
      args: ['run', '--', ...context.originalArgs],
      env: context.env,
      cwd: context.cwd,
    }))
    let waitConnectedCalls = 0
    const launches: string[] = []
    const health = {
      configure: vi.fn((_id: string, launchId: string) => launches.push(launchId)),
      connecting: vi.fn(),
      fail: vi.fn(),
      stop: vi.fn(),
      get: vi.fn(() => ({ state: 'connecting' })),
      waitConnected: vi.fn(async () => {
        waitConnectedCalls++
        throw new Error('wrapper exited')
      }),
    }
    const harness = createHarness(health)
    const result = await harness.handler(null, 'codex-wrap', 'C:\\work', 'account2', 120, 32) as Record<string, unknown>

    expect(result.success).toBe(true)
    expect(waitConnectedCalls).toBe(1)
    expect(state.starts).toHaveLength(2)
    expect(state.starts[0].command).toContain('ai-memory')
    expect(state.starts[1].command).toBe('C:\\OpenAI\\Codex\\bin\\codex.exe')
    expect(launches).toHaveLength(2)
    expect(launches[0]).not.toBe(launches[1])
    const firstContext = state.prepareAiMemoryLaunch.mock.calls[0]?.[0] as { originalArgs: string[]; env: NodeJS.ProcessEnv; reservationId: string }
    // Normaliza launch-id (UUID v4) e o nonce do servidor MCP gerenciado
    // (`devorbit_runtime_<32 hex>`): o retry deve usar um nonce FRESCO, então
    // o assertion compara estrutura, não o valor do nonce.
    const normalizeManagedArgs = (args: string[]) => args
      .join('\u0000')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu, '<launch-id>')
      .replace(/devorbit_runtime_[0-9a-f]{32}/giu, 'devorbit_runtime_<nonce>')
      .split('\u0000')
    expect(firstContext.originalArgs.at(0)).toBe('--config')
    expect(firstContext.originalArgs.at(-2)).toBe('--config')
    expect(firstContext.originalArgs.join(' ')).not.toContain('bridge-secret')
    expect(firstContext.reservationId).toBe(launches[0])
    expect(state.starts[0].args.slice(2)).toEqual(firstContext.originalArgs)
    expect(normalizeManagedArgs(state.starts[1].args)).toEqual(normalizeManagedArgs(firstContext.originalArgs))
    expect(state.starts[0].env).toMatchObject({
      CODEX_HOME: 'C:\\Users\\tester\\.codex-conta2',
      DEVORBIT_BRIDGE_PIPE: '\\\\.\\pipe\\devorbit-test',
      DEVORBIT_BRIDGE_TOKEN: 'bridge-secret',
      DEVORBIT_SESSION_ID: 'session-test',
    })
    expect(state.starts[1].env).toMatchObject({
      CODEX_HOME: 'C:\\Users\\tester\\.codex-conta2',
      DEVORBIT_BRIDGE_PIPE: '\\\\.\\pipe\\devorbit-test',
      DEVORBIT_BRIDGE_TOKEN: 'bridge-secret',
      DEVORBIT_SESSION_ID: 'session-test',
    })
    for (const name of ['CODEX_HOME', 'DEVORBIT_BRIDGE_PIPE', 'DEVORBIT_BRIDGE_TOKEN', 'DEVORBIT_SESSION_ID']) {
      expect(state.starts[0].env[name]).toBe(state.starts[1].env[name])
      expect(firstContext.env[name]).toBe(state.starts[1].env[name])
    }
  })

  it('does not revive a wrapper launch after the user stops the terminal while MCP connects', async () => {
    state.prepareAiMemoryLaunch.mockImplementation(async (context: { originalArgs: string[]; env: NodeJS.ProcessEnv; cwd: string }) => ({
      wrapped: true,
      command: 'C:\\ai-memory\\ai-memory.exe',
      args: ['run', '--', ...context.originalArgs],
      env: context.env,
      cwd: context.cwd,
      metadata: { terminalId: 'codex-cancel', provider: 'codex' },
    }))
    let markWaitEntered!: () => void
    let rejectWait!: (reason: Error) => void
    const waitEntered = new Promise<void>((resolve) => { markWaitEntered = resolve })
    const health = {
      configure: vi.fn(),
      connecting: vi.fn(),
      fail: vi.fn(),
      stop: vi.fn(),
      get: vi.fn(() => ({ state: 'connecting' })),
      waitConnected: vi.fn(() => new Promise<void>((_resolve, reject) => {
        rejectWait = reject
        markWaitEntered()
      })),
    }
    const harness = createHarness(health)
    const pendingStart = harness.handler(null, 'codex-cancel', 'C:\\work', 'account1', 120, 32) as Promise<Record<string, unknown>>
    await waitEntered

    const stop = harness.handlers.get('devorbit:stopTerminal')
    expect(stop).toBeTypeOf('function')
    await stop!(null, 'codex-cancel')
    rejectWait(new Error('terminal stopped'))

    await expect(pendingStart).rejects.toThrow('terminal stopped')
    expect(state.starts).toHaveLength(1)
    expect(state.stopTerminal).toHaveBeenCalledTimes(1)
    expect(health.stop).toHaveBeenCalledWith('codex-cancel')
  })

  it('does not let a stale wrapper failure stop a newer Codex launch with the same terminal id', async () => {
    state.prepareAiMemoryLaunch.mockImplementationOnce(async (context: { originalArgs: string[]; env: NodeJS.ProcessEnv; cwd: string }) => ({
      wrapped: true,
      command: 'C:\\ai-memory\\ai-memory.exe',
      args: ['run', '--', ...context.originalArgs],
      env: context.env,
      cwd: context.cwd,
    }))
    let markWaitEntered!: () => void
    let rejectWait!: (reason: Error) => void
    const waitEntered = new Promise<void>((resolve) => { markWaitEntered = resolve })
    const health = {
      configure: vi.fn(),
      connecting: vi.fn(),
      fail: vi.fn(),
      stop: vi.fn(),
      get: vi.fn(() => ({ state: 'connecting' })),
      waitConnected: vi.fn(() => new Promise<void>((_resolve, reject) => {
        rejectWait = reject
        markWaitEntered()
      })),
    }
    const harness = createHarness(health)
    const staleStart = harness.handler(null, 'codex-reopen', 'C:\\work', 'account1', 120, 32) as Promise<Record<string, unknown>>
    await waitEntered

    const replacement = await harness.handler(null, 'codex-reopen', 'C:\\work', 'account2', 120, 32) as Record<string, unknown>
    expect(replacement.success).toBe(true)
    rejectWait(new Error('stale wrapper exited'))

    await expect(staleStart).rejects.toThrow('stale wrapper exited')
    expect(state.starts).toHaveLength(2)
    expect(state.starts[1].env.CODEX_HOME).toBe('C:\\Users\\tester\\.codex-conta2')
    expect(state.stopTerminal).not.toHaveBeenCalled()
  })

  it('marks the configured launch failed when ai-memory preparation rejects', async () => {
    const fail = vi.fn()
    const health = {
      configure: vi.fn(),
      connecting: vi.fn(),
      fail,
      get: vi.fn(() => ({ state: 'failed' })),
      stop: vi.fn(),
    }
    state.prepareAiMemoryLaunch.mockRejectedValueOnce(new Error('preparation failed'))
    vi.mocked(rollbackAiMemoryLaunch).mockClear()
    const harness = createHarness(health)

    await expect(harness.handler(null, 'codex-prepare-fail', 'C:\\work', 'account1', 120, 32)).rejects.toThrow('preparation failed')
    expect(fail).toHaveBeenCalledWith('codex-prepare-fail', 'MCP_STARTUP_FAILED', expect.any(String))
    expect(releaseAiMemoryReservation).toHaveBeenCalledWith('codex-prepare-fail', expect.any(String))
    expect(rollbackAiMemoryLaunch).not.toHaveBeenCalledWith('codex-prepare-fail')
    expect(state.starts).toHaveLength(0)
  })

  it('registers devorbit:getCodexBridgeHealth returning store.get after assertTerminalId', async () => {
    const get = vi.fn(() => ({ terminalId: 'codex-one', state: 'connected' }))
    const harness = createHarness({ configure: vi.fn(), connecting: vi.fn(), fail: vi.fn(), get, stop: vi.fn() })
    const channel = harness.handlers.get('devorbit:getCodexBridgeHealth')
    expect(channel).toBeTypeOf('function')
    expect(await channel!(null, 'codex-one')).toEqual({ terminalId: 'codex-one', state: 'connected' })
    expect(get).toHaveBeenCalledWith('codex-one')
    expect(() => channel!(null, 'INVALID ID!')).toThrow('Identificador de terminal inválido.')
  })

  it('markConnecting only after the managed PTY spawn (old flush outside the connecting window)', async () => {
    const order: string[] = []
    state.startCodex.mockImplementation(async (id: string, _cwd: string, options: { command?: string; args?: string[]; env?: NodeJS.ProcessEnv }) => {
      order.push('start')
      state.starts.push({ id, command: options.command || '', args: options.args || [], env: options.env || {} })
      return { id, pid: 100 }
    })
    const harness = createHarness({
      configure: vi.fn(() => order.push('configure')),
      connecting: vi.fn(() => order.push('connecting')),
      fail: vi.fn(),
      get: vi.fn(() => ({ state: 'configuring' })),
      stop: vi.fn(),
    })
    await harness.handler(null, 'codex-order', 'C:\\work', 'account1', 120, 32)
    expect(order).toEqual(['configure', 'start', 'connecting'])
  })
})
