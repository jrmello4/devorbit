import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronPaths = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  default: {
    app: { getPath: () => electronPaths.userData },
  },
}))

const { spawnPtyMock } = vi.hoisted(() => ({ spawnPtyMock: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: spawnPtyMock }))

// O caminho de projeto é validado fora desta unidade: passthrough isola o
// contrato de thread-through dos hints.
vi.mock('../src/main/project-paths', () => ({
  validateProjectPath: async (input: unknown) => String(input),
}))

const { sendAgentInstructionMock } = vi.hoisted(() => ({ sendAgentInstructionMock: vi.fn() }))

// Spy do SEAM de submissão: o que interessa aqui é o INPUT que o consumidor
// (terminal-ipc) monta para o sendAgentInstruction — não a execução real.
vi.mock('../src/main/agent-instruction', () => ({
  sendAgentInstruction: (deps: unknown, input: unknown) => sendAgentInstructionMock(deps, input),
}))

const { hintsSentinel } = vi.hoisted(() => ({
  hintsSentinel: { ackPatterns: ['SENTINEL-ACK-DO-TESTE'] },
}))

vi.mock('../src/main/agent-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/agent-providers')>()
  return {
    ...actual,
    // Turno determinístico: qualquer provider pedido fica disponível com o
    // MESMO model — a sessão criada pelo startAgentTerminal é reutilizada pelo
    // sendAgentTurn (sem spawn no caminho do turno).
    resolveAgentTurn: async (_config: unknown, preferred: string) => ({
      tier: 'fast',
      model: 'mock-model',
      authConfigured: true,
      provider: preferred,
      fellBack: false,
      available: true,
      reason: 'mock: provedor disponível para o teste',
      explanation: { tier: 'fast', complexity: 'mechanical', matchedMechanical: [], matchedDeep: [] },
    }),
    resolveAgentProviderWithFallback: async (_config: unknown, preferred: string) => ({
      path: `/resolved/${preferred}`,
      message: 'resolvido (mock)',
      provider: preferred,
      fellBack: false,
    }),
    getAgentProviderHealth: async () =>
      actual.AGENT_PROVIDER_IDS.map((id) => ({
        id,
        label: id,
        command: id,
        state: 'ready' as const,
        message: 'mock',
      })),
    // SEAM sob teste: sentinel só para 'opencode' torna observável que o
    // consumidor consulta o helper PELO PROVIDER da sessão e repassa o
    // resultado verbatim ao sendAgentInstruction. Os demais providers caem no
    // helper REAL (catálogo vazio hoje → undefined).
    resolveProviderInstructionHints: (provider: string | undefined | null) =>
      provider === 'opencode' ? hintsSentinel : actual.resolveProviderInstructionHints(provider),
  }
})

import { registerTerminalIpc, type TerminalIpcDependencies } from '../src/main/ipc/terminal-ipc'
import type { IpcRegistrar } from '../src/main/ipc/registrar'

function createFakeTerminal() {
  return {
    pid: 4242,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  }
}

function createHarness() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const register = ((channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler)
  }) as unknown as IpcRegistrar
  const usage = {
    recordUsageEvents: vi.fn(async () => undefined),
    beginUsageSession: vi.fn(),
    endUsageSession: vi.fn(),
  }
  const dependencies: TerminalIpcDependencies = {
    getTerminalLifecycleGeneration: () => 1,
    assertTerminalLifecycle: () => undefined,
    bridgeEnv: () => ({ DEVORBIT_HINTS_TEST: '1' }),
    registerBridgeAgent: vi.fn(),
    cancelBridgeTarget: vi.fn(),
    turnSessions: new Map(),
    waitTurnResult: vi.fn(() =>
      Object.assign(Promise.resolve({ result: 'resultado do agente' }), { cancel: () => undefined })
    ),
    waitTerminalReady: vi.fn(async () => ({ timedOut: false })),
    usage,
  }
  registerTerminalIpc(register, dependencies)
  const handler = (channel: string): ((...args: unknown[]) => unknown) => {
    const found = handlers.get(channel)
    if (!found) throw new Error(`canal ${channel} não registrado`)
    return found
  }
  return { dependencies, usage, handler }
}

function lastInstructionInput(): Record<string, unknown> {
  const calls = sendAgentInstructionMock.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][1] as Record<string, unknown>
}

beforeEach(() => {
  electronPaths.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'devorbit-hints-ipc-'))
  spawnPtyMock.mockReset()
  spawnPtyMock.mockImplementation(() => createFakeTerminal())
  sendAgentInstructionMock.mockReset()
  sendAgentInstructionMock.mockImplementation(async () => ({ acked: true, attempts: 1 }))
})

describe('thread-through dos hints de instrução (terminal-ipc → sendAgentInstruction)', () => {
  it('provider com hints → o sendInstruction do turno recebe os hints resolvidos pelo provider da sessão', async () => {
    const { handler, dependencies } = createHarness()
    const start = await handler('devorbit:startAgentTerminal')(
      null,
      'agent-hints',
      '/projeto',
      'opencode',
      100,
      30,
    )
    expect(start).toMatchObject({ success: true, provider: 'opencode' })
    expect(dependencies.turnSessions.get('agent-hints')).toMatchObject({
      provider: 'opencode',
      model: 'mock-model',
    })

    const turn = await handler('devorbit:sendAgentTurn')(
      null,
      'agent-hints',
      'opencode',
      '/projeto',
      'tarefa de teste',
    )
    expect(turn).toMatchObject({ success: true, provider: 'opencode' })

    expect(sendAgentInstructionMock).toHaveBeenCalledTimes(1)
    expect(lastInstructionInput()).toMatchObject({
      terminalId: 'agent-hints',
      provider: 'opencode',
      hints: { ackPatterns: ['SENTINEL-ACK-DO-TESTE'] },
    })
  })

  it('provider SEM hints catalogados → o input carrega hints undefined (resolução real, sem erro)', async () => {
    const { handler } = createHarness()
    const start = await handler('devorbit:startAgentTerminal')(
      null,
      'agent-sem-hints',
      '/projeto',
      'claude',
      100,
      30,
    )
    expect(start).toMatchObject({ success: true, provider: 'claude' })

    const turn = await handler('devorbit:sendAgentTurn')(
      null,
      'agent-sem-hints',
      'claude',
      '/projeto',
      'tarefa de teste',
    )
    expect(turn).toMatchObject({ success: true, provider: 'claude' })

    const input = lastInstructionInput()
    expect(input.provider).toBe('claude')
    // O consumidor SEMPRE resolve e anexa a chave (helper real → undefined
    // enquanto o catálogo não tiver hints para o provider).
    expect(input.hints).toBeUndefined()
    expect('hints' in input).toBe(true)
  })

  it('canal do Codex (submitAgentInstruction) também resolve hints do provider fixo', async () => {
    const { handler } = createHarness()
    const result = await handler('devorbit:submitAgentInstruction')(
      null,
      'agent-codex-chan',
      { turnId: 'task-hints-codex', content: 'tarefa' },
    )
    expect(result).toMatchObject({ success: true, acked: true })

    expect(lastInstructionInput()).toMatchObject({
      terminalId: 'agent-codex-chan',
      turnId: 'task-hints-codex',
      provider: 'codex',
    })
    // 'codex' não é o sentinel → helper real → undefined (catálogo vazio hoje).
    expect(lastInstructionInput().hints).toBeUndefined()
  })
})
