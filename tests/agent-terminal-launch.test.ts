import { createElement, isValidElement } from 'react'
import { describe, expect, it } from 'vitest'
import {
  agentTerminalDefaultCommand,
  AGENT_TERMINAL_DEFAULT_COMMANDS,
  codexManagedTerminalLabel,
  injectAgentTerminalLaunch,
} from '../src/renderer/src/components/agent-creation-helpers'
import {
  parseCanvasState,
  persistCanvasState,
  readCanvasState,
  type CanvasNode,
  type CanvasStorageLike,
  type CanvasStorageWriter,
} from '../src/renderer/src/components/WorkspaceCanvas'
import type { TerminalNodeRuntimeConfig } from '../src/shared/terminal-presets'

/** Superfície que imita o WorkspaceTerminal embutido do renderAgent. */
const terminalSurface = (props: Record<string, unknown> = {}) =>
  createElement('div', { 'data-mock': 'workspace-terminal', ...props })

/**
 * Mesma estrutura produzida pela factory renderAgent do IntegratedWorkspace:
 * wrapper .canvas-agent-terminal > [review, WorkspaceTerminal].
 */
const agentCardContent = (surfaceProps: Record<string, unknown> = {}) =>
  createElement(
    'div',
    { className: 'canvas-agent-terminal' },
    createElement('div', { className: 'canvas-agent-review' }, 'Worktree'),
    terminalSurface({ terminalId: 'agent-p-1', provider: 'opencode', variant: 'embedded', ...surfaceProps }),
  )

/** Localiza o elemento de superfície (children[1]) dentro do conteúdo clonado. */
function surfaceOf(content: unknown): { props: Record<string, unknown> } | null {
  if (!isValidElement(content)) return null
  const children = (content.props as { children?: unknown[] }).children
  const surface = Array.isArray(children) ? children[1] : undefined
  return isValidElement(surface) ? { props: surface.props as Record<string, unknown> } : null
}

describe('defaults de terminal por provider', () => {
  it('usa o CLI homônimo como padrão para os provedores BYOK', () => {
    expect(agentTerminalDefaultCommand('opencode')).toBe('opencode')
    expect(agentTerminalDefaultCommand('claude')).toBe('claude')
    expect(agentTerminalDefaultCommand('gemini')).toBe('gemini')
    expect(agentTerminalDefaultCommand('aider')).toBe('aider')
    expect(agentTerminalDefaultCommand('agy')).toBe('agy')
  })

  it('não tem default para codex (conta gerenciada) nem para custom', () => {
    expect(agentTerminalDefaultCommand('codex')).toBe('')
    expect(agentTerminalDefaultCommand('custom')).toBe('')
    expect(agentTerminalDefaultCommand(null)).toBe('')
    expect(agentTerminalDefaultCommand(undefined)).toBe('')
    expect(AGENT_TERMINAL_DEFAULT_COMMANDS.codex).toBe('')
  })

  it('rotula o terminal do codex como gerenciado pela conta', () => {
    expect(codexManagedTerminalLabel('account1')).toBe('Gerenciado pelo DevOrbit (conta C1).')
    expect(codexManagedTerminalLabel('account2')).toBe('Gerenciado pelo DevOrbit (conta C2).')
    expect(codexManagedTerminalLabel(null)).toBe('Gerenciado pelo DevOrbit (conta C1).')
  })
})

describe('injectAgentTerminalLaunch (injeção no conteúdo do renderAgent)', () => {
  const agentNode = (
    overrides: Partial<CanvasNode> & { terminal?: TerminalNodeRuntimeConfig | null } = {},
  ) => ({
    kind: 'agent' as const,
    provider: 'opencode' as CanvasNode['provider'],
    ...overrides,
  })

  it('injeta autoStart quando o agente não tem comando próprio (CLI do provider ao abrir)', () => {
    const content = injectAgentTerminalLaunch(agentCardContent(), agentNode())
    const surface = surfaceOf(content)
    expect(surface).not.toBeNull()
    expect(surface?.props.autoStart).toBe(true)
    expect(surface?.props.runtimeConfig).toBeUndefined()
  })

  it('injeta runtimeConfig com comando/args/cwd quando o nó tem comando próprio', () => {
    const content = injectAgentTerminalLaunch(agentCardContent(), agentNode({
      terminal: {
        presetId: 'custom',
        command: 'npm',
        args: ['run', 'dev'],
        cwdMode: 'custom',
        cwd: 'C:\\tmp\\worktree',
        autoStart: true,
        restartBehavior: 'restart',
        monitorActivity: false,
      },
    }))
    const surface = surfaceOf(content)
    expect(surface).not.toBeNull()
    const runtime = surface?.props.runtimeConfig as TerminalNodeRuntimeConfig
    expect(runtime).toMatchObject({
      command: 'npm',
      args: ['run', 'dev'],
      cwd: 'C:\\tmp\\worktree',
      cwdMode: 'custom',
      autoStart: true,
      restartBehavior: 'restart',
      monitorActivity: false,
    })
    // O caminho runtimeConfig substitui o autoStart (startTerminal com options).
    expect(surface?.props.autoStart).toBeUndefined()
  })

  it('comando rejeitado pelo sanitize degrada para o autoStart do provider', () => {
    const content = injectAgentTerminalLaunch(agentCardContent(), agentNode({
      terminal: {
        presetId: 'custom',
        command: 'npm %x',
        cwdMode: 'workspace',
        autoStart: true,
        restartBehavior: 'restart',
        monitorActivity: false,
      },
    }))
    const surface = surfaceOf(content)
    expect(surface?.props.autoStart).toBe(true)
    const runtime = surface?.props.runtimeConfig as TerminalNodeRuntimeConfig | undefined
    expect(runtime?.command).toBeUndefined()
  })

  it('agente codex sem comando custom auto-inicia o fluxo gerenciado da conta', () => {
    const original = agentCardContent({ provider: 'codex', codexAccount: 'account1' })
    const content = injectAgentTerminalLaunch(original, agentNode({ provider: 'codex', account: 'account1' }))
    const surface = surfaceOf(content)
    expect(surface?.props.autoStart).toBe(true)
    expect(surface?.props.runtimeConfig).toBeUndefined()
    expect(surface?.props.codexAccount).toBe('account1')
  })

  it('não altera conteúdo sem superfície de terminal embutida nem nós não-agente', () => {
    const withoutSurface = createElement('div', { className: 'canvas-agent-terminal' }, 'só texto')
    expect(injectAgentTerminalLaunch(withoutSurface, agentNode())).toBe(withoutSurface)

    const terminalNode = { kind: 'terminal', provider: null }
    const content = injectAgentTerminalLaunch(agentCardContent(), terminalNode)
    const surface = surfaceOf(content)
    expect(surface?.props.autoStart).toBeUndefined()
  })
})

describe('persistência do terminal no nó de agente (canvas localStorage)', () => {
  interface MemoryStorage extends CanvasStorageLike, CanvasStorageWriter {
    raw: Map<string, string>
  }
  const PROJECT_ID = 'proj-agent-term'
  const STORAGE_KEY = 'devorbit:workspace-canvas:' + PROJECT_ID
  const memoryStorage = (initial?: unknown): MemoryStorage => {
    const raw = new Map<string, string>()
    if (initial !== undefined) raw.set(STORAGE_KEY, JSON.stringify(initial))
    return {
      raw,
      getItem: (storageKey) => raw.get(storageKey) ?? null,
      setItem: (storageKey, value) => {
        raw.set(storageKey, value)
      },
    }
  }

  const agentFixture = (terminal: unknown) => ({
    version: 5,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: 'agent-1',
        kind: 'agent',
        title: 'Dev',
        x: 10,
        y: 10,
        width: 500,
        height: 360,
        z: 1,
        provider: 'opencode',
        role: 'Implementação',
        ...(terminal !== undefined ? { terminal } : {}),
      },
    ],
    connections: [],
    squads: [],
  })

  it('restaura a config de terminal salva no agente', () => {
    const state = readCanvasState(memoryStorage(agentFixture({
      presetId: 'custom',
      command: 'npm',
      args: ['run', 'dev'],
      cwdMode: 'workspace',
      autoStart: true,
      restartBehavior: 'restart',
      monitorActivity: false,
    })), PROJECT_ID)
    const agent = state.nodes.find((node) => node.id === 'agent-1')
    expect(agent?.terminal).toMatchObject({
      command: 'npm',
      args: ['run', 'dev'],
      autoStart: true,
    })
  })

  it('agente sem terminal segue sem config (comportamento padrão do provider)', () => {
    const state = readCanvasState(memoryStorage(agentFixture(undefined)), PROJECT_ID)
    expect(state.nodes.find((node) => node.id === 'agent-1')?.terminal).toBeUndefined()
  })

  it('lixo de terminal no agente é descartado pelo sanitize', () => {
    const state = readCanvasState(memoryStorage(agentFixture({ command: 42, args: 'nope' })), PROJECT_ID)
    const agent = state.nodes.find((node) => node.id === 'agent-1')
    expect(agent?.terminal).toBeDefined()
    expect(agent?.terminal?.command).toBeUndefined()
    expect(agent?.terminal?.args).toBeUndefined()
  })

  it('parse direto do estado também preserva o terminal do agente (round-trip)', () => {
    const state = parseCanvasState(agentFixture({
      presetId: 'custom',
      command: 'aider',
      cwdMode: 'custom',
      cwd: 'C:\\work',
      autoStart: true,
      restartBehavior: 'restart',
      monitorActivity: false,
    }), 'opencode')
    const agent = state.nodes[0]
    expect(agent.terminal).toMatchObject({ command: 'aider', cwd: 'C:\\work' })
    const storage = memoryStorage()
    persistCanvasState(storage, PROJECT_ID, state)
    const reopened = readCanvasState(storage, PROJECT_ID)
    expect(reopened.nodes[0].terminal).toEqual(agent.terminal)
  })
})
