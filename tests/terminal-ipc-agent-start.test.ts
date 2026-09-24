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

const { resolveAgentTurnMock, resolveAgentProviderWithFallbackMock } = vi.hoisted(() => ({
  resolveAgentTurnMock: vi.fn(),
  resolveAgentProviderWithFallbackMock: vi.fn(),
}))

// CI (todos os SOs) não instala OpenCode. O mock ANTERIOR (só
// resolveAgentProviderCommand) era inócuo: terminal-ipc importa
// `resolveAgentTurn` e `resolveAgentProviderWithFallback` DIRETAMENTE, e a
// referência lexical dentro de agent-providers (fallback→command, health→command)
// não é substituída pelo spread — o PATH real do runner ainda era sondado e
// `provider-not-ready` continuava acontecendo. Mockamos exatamente os dois
// seams importados; `spawnAgentProviderTerminal`, `executeExplicitAgentTurn` e
// `orderProvidersForTask` permanecem REAIS (resolveProviderInvocation intacto).
vi.mock('../src/main/agent-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/agent-providers')>()
  return {
    ...actual,
    resolveAgentTurn: (config: unknown, preferred: string, prompt: unknown) =>
      resolveAgentTurnMock(config, preferred, prompt),
    resolveAgentProviderWithFallback: (config: unknown, preferred: string) =>
      resolveAgentProviderWithFallbackMock(config, preferred),
  }
})

const { spawnPtyMock } = vi.hoisted(() => ({ spawnPtyMock: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: spawnPtyMock }))

// O caminho de projeto é validated fora desta unidade: passthrough isola o
// contrato do canal devorbit:startAgentTerminal.
vi.mock('../src/main/project-paths', () => ({
  validateProjectPath: async (input: unknown) => String(input),
}))

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
    bridgeEnv: () => ({ DEVORBIT_AGENT_TEST: '1' }),
    registerBridgeAgent: vi.fn(),
    cancelBridgeTarget: vi.fn(),
    turnSessions: new Map(),
    waitTurnResult: vi.fn(),
    waitTerminalReady: vi.fn(async () => undefined),
    usage,
  }
  registerTerminalIpc(register, dependencies)
  const handler = handlers.get('devorbit:startAgentTerminal')
  if (!handler) throw new Error('canal devorbit:startAgentTerminal não registrado')
  return { dependencies, usage, handler }
}

// Diretório real em forma canônica. Usa o realpath ASSÍNCRONO — o mesmo do
// canonicalizeExistingDirectory — porque o realpathSync do Node preserva o
// nome curto 8.3 (ADENIL~1.J) no Windows e divergiria do validador.
const projectDirPromise = fs.promises.realpath(
  fs.mkdtempSync(path.join(os.tmpdir(), 'devorbit-agent-proj-')),
)
const projectDir = await projectDirPromise

function fakePtyDefaults() {
  spawnPtyMock.mockImplementation(() => createFakeTerminal())
}

describe('devorbit:startAgentTerminal — contrato e ciclo de vida', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    electronPaths.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'devorbit-agent-ipc-'))
    spawnPtyMock.mockReset()
    fakePtyDefaults()
    // Reset por teste + defaults determinísticos (sem depender do PATH).
    resolveAgentTurnMock.mockReset()
    resolveAgentTurnMock.mockResolvedValue({
      tier: 'fast',
      model: 'mock-model',
      authConfigured: true,
      provider: 'opencode',
      fellBack: false,
      available: true,
      reason: 'mock: provedor disponível para o teste',
      explanation: {
        tier: 'fast',
        complexity: 'mechanical',
        matchedMechanical: [],
        matchedDeep: [],
      },
    })
    resolveAgentProviderWithFallbackMock.mockReset()
    resolveAgentProviderWithFallbackMock.mockResolvedValue({
      path: path.join(path.sep, 'resolved', 'opencode'),
      message: 'resolvido (mock)',
      provider: 'opencode',
      fellBack: false,
    })
  })

  it('recusa codex indicando o fluxo de conta e não spawna terminal', async () => {
    const { handler } = createHarness()
    const result = (await handler(null, 'agent-codex', projectDir, 'codex', 120, 32)) as {
      success: boolean
      provider: string
      message?: string
    }
    expect(result).toMatchObject({ success: false, provider: 'codex' })
    expect(String(result.message)).toContain('fluxo de conta')
    expect(spawnPtyMock).not.toHaveBeenCalled()
  })

  it('rejeita id inválido ou formato incorreto', async () => {
    const { handler } = createHarness()
    await expect(handler(null, 'bad id! with spaces', projectDir, 'opencode')).rejects.toThrow(
      /Identificador de terminal inválido/
    )
    expect(spawnPtyMock).not.toHaveBeenCalled()
  })

  it('rejeita tarefa com tipo não string', async () => {
    const { handler } = createHarness()
    await expect(handler(null, 'agent-task-err', projectDir, 'opencode', 120, 32, 12345)).rejects.toThrow(
      /Tarefa do turno inválida/
    )
    expect(spawnPtyMock).not.toHaveBeenCalled()
  })

  it('inicia provider válido com dimensões customizadas, repassa cwd ao PTY e registra bridgeAgent', async () => {
    const { handler, dependencies, usage } = createHarness()
    const result = await handler(null, 'agent-x', projectDir, 'opencode', 100, 30, 'tarefa de teste')

    expect(result).toMatchObject({
      success: true,
      provider: 'opencode',
      fallback: false,
    })
    expect(spawnPtyMock).toHaveBeenCalledTimes(1)
    const [command, args, options] = spawnPtyMock.mock.calls[0]
    expect(command).toBeDefined()
    expect(Array.isArray(args)).toBe(true)
    expect(options.cwd).toBe(projectDir)
    expect(options.env.DEVORBIT_AGENT_TEST).toBe('1')
    expect(options.cols).toBe(100)
    expect(options.rows).toBe(30)
    expect(dependencies.registerBridgeAgent).toHaveBeenCalledWith('agent-x', {
      provider: 'opencode',
      model: expect.any(String),
      projectPath: projectDir,
    })
    expect(dependencies.turnSessions.get('agent-x')?.provider).toBe('opencode')
    expect(usage.beginUsageSession).toHaveBeenCalledWith('agent-x', 'opencode')
  })

  it('usa dimensões padrão quando cols e rows não são fornecidos', async () => {
    const { handler } = createHarness()
    const result = await handler(null, 'agent-defaults', projectDir, 'opencode')

    expect(result).toMatchObject({
      success: true,
      provider: 'opencode',
    })
    expect(spawnPtyMock).toHaveBeenCalledTimes(1)
    const [, , options] = spawnPtyMock.mock.calls[0]
    expect(options.cols).toBe(120)
    expect(options.rows).toBe(32)
  })
})
