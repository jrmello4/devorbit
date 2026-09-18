import { describe, expect, it } from 'vitest'
import {
  applyWorkspaceUiRequest,
  buildPendingCreation,
  buildPendingCanvasNode,
  buildWorkspaceUiRequest,
  computePipeSync,
  computeStreamingPipeEdges,
  computeWebSuppressed,
  createsAgentCycle,
  isPendingNodeForProject,
  sanitizeAgentCycles,
} from '../src/renderer/src/components/workspace-request-helpers'
import { parseSpacedTwoStroke } from '../src/renderer/src/components/command-center-helpers'

describe('pending canvas node queue (C+N/C+T)', () => {
  it('constrói pedido com projeto, tipo e nonce', () => {
    const pending = buildPendingCanvasNode('proj-1', 'note')
    expect(pending.projectId).toBe('proj-1')
    expect(pending.kind).toBe('note')
    expect(Number.isFinite(pending.nonce)).toBe(true)
  })

  it('só consome o pedido no projeto correspondente', () => {
    const pending = buildPendingCanvasNode('proj-1', 'agent')
    expect(isPendingNodeForProject(pending, 'proj-1')).toBe(true)
    expect(isPendingNodeForProject(pending, 'proj-2')).toBe(false)
    expect(isPendingNodeForProject(null, 'proj-1')).toBe(false)
  })

  it('representa agente e squad sem selecionar squad automaticamente', () => {
    const agent = buildPendingCreation('proj-1', 'agent')
    const squad = buildPendingCreation('proj-1', 'squad')

    expect(agent).toMatchObject({ projectId: 'proj-1', kind: 'agent' })
    expect(squad).toMatchObject({ projectId: 'proj-1', kind: 'squad' })
    expect('autoSelect' in agent).toBe(false)
    expect('autoSelect' in squad).toBe(false)
    expect(Number.isFinite(agent.nonce)).toBe(true)
    expect(Number.isFinite(squad.nonce)).toBe(true)
  })

  it('cobre projeto ainda não aberto e modo grid (força canvas)', () => {
    const request = buildWorkspaceUiRequest('proj-novo', { forceCanvas: true, showTerminal: false })
    const next = applyWorkspaceUiRequest({ isCanvas: false, terminalVisible: false }, request, 'proj-novo')
    expect(next.isCanvas).toBe(true)
  })
})

describe('workspace ui request (G+C/G+T)', () => {
  it('G+C força canvas sem mexer no terminal', () => {
    const request = buildWorkspaceUiRequest('p1', { forceCanvas: true, showTerminal: false })
    expect(applyWorkspaceUiRequest({ isCanvas: false, terminalVisible: false }, request, 'p1')).toEqual({
      isCanvas: true,
      terminalVisible: false,
    })
  })

  it('G+T força canvas e terminal primário visível', () => {
    const request = buildWorkspaceUiRequest('p1', { forceCanvas: true, showTerminal: true })
    expect(applyWorkspaceUiRequest({ isCanvas: false, terminalVisible: false }, request, 'p1')).toEqual({
      isCanvas: true,
      terminalVisible: true,
    })
  })

  it('ignora pedido de outro projeto', () => {
    const request = buildWorkspaceUiRequest('p1', { forceCanvas: true, showTerminal: true })
    expect(applyWorkspaceUiRequest({ isCanvas: false, terminalVisible: false }, request, 'p2')).toEqual({
      isCanvas: false,
      terminalVisible: false,
    })
  })
})

describe('web nativa vs overlay', () => {
  it('suprime a view nativa com a paleta aberta preservando estado', () => {
    const base = {
      workspaceView: 'workspace',
      settingsOpen: false,
      toolHealthOpen: false,
      authOpen: false,
      memoryOpen: false,
      updateModalOpen: false,
    }
    expect(computeWebSuppressed({ ...base, paletteOpen: true })).toBe(true)
    expect(computeWebSuppressed({ ...base, paletteOpen: false })).toBe(false)
    expect(computeWebSuppressed({ ...base, paletteOpen: false, workspaceView: 'projects' })).toBe(true)
  })
})

describe('busca com espaço não degrada', () => {
  it('só trata como dois tempos uma sequência válida', () => {
    expect(parseSpacedTwoStroke('g p')?.action).toBe('nav-projects')
    expect(parseSpacedTwoStroke('meu projeto')).toBeNull()
    expect(parseSpacedTwoStroke('projeto final v2')).toBeNull()
  })
})

describe('computeStreamingPipeEdges (sem espelhamento implícito)', () => {
  it('não canaliza PTY para conexões agente -> agente do canvas', () => {
    const nodes = new Map([
      ['coordinator', 'agent'],
      ['specialist', 'agent'],
      ['note', 'note'],
    ])

    expect(computeStreamingPipeEdges(nodes, [
      { from: 'coordinator', to: 'specialist' },
      { from: 'specialist', to: 'coordinator' },
    ])).toEqual([])
  })

  it('não canaliza nenhum outro tipo de cabo do canvas', () => {
    const nodes = new Map([
      ['note', 'note'],
      ['agent', 'agent'],
      ['workbench', 'workbench'],
    ])

    expect(computeStreamingPipeEdges(nodes, [
      { from: 'note', to: 'agent' },
      { from: 'workbench', to: 'agent' },
    ])).toEqual([])
  })
})

describe('computePipeSync determinístico', () => {
  const setOf = (...entries: string[]) => new Set(entries)

  it('instala cabos novos e remove os desfeitos por origem', () => {
    const plan = computePipeSync(
      new Map([['t1', setOf('t2')]]),
      new Map([['t1', setOf('t2', 't3')], ['t4', setOf('t5')]])
    )
    expect(plan.clearSources).toEqual(['t1'])
    expect(plan.addEdges).toEqual([
      { from: 't1', to: 't2' },
      { from: 't1', to: 't3' },
      { from: 't4', to: 't5' },
    ])
  })

  it('não toca em cabos idênticos', () => {
    const plan = computePipeSync(
      new Map([['t1', setOf('t2')]]),
      new Map([['t1', setOf('t2')]])
    )
    expect(plan).toEqual({ clearSources: [], addEdges: [] })
  })

  it('canvas -> grid -> canvas com a mesma conexão reinstala tudo', () => {
    const desired = new Map([['term-a', setOf('term-b')]])
    // Ida ao grid: limpa o mapa aplicado (volta vazio).
    const appliedAfterGrid = new Map<string, Set<string>>()
    // Volta ao canvas com a mesma conexão: plano reinstala do zero.
    const plan = computePipeSync(appliedAfterGrid, desired)
    expect(plan.clearSources).toEqual([])
    expect(plan.addEdges).toEqual([{ from: 'term-a', to: 'term-b' }])
  })

  it('ordena arestas para aplicação determinística', () => {
    const plan = computePipeSync(
      new Map(),
      new Map([['b', setOf('z')], ['a', setOf('y', 'x')]])
    )
    expect(plan.addEdges).toEqual([
      { from: 'a', to: 'x' },
      { from: 'a', to: 'y' },
      { from: 'b', to: 'z' },
    ])
  })
})

describe('sanitização de ciclos agente-agente', () => {
  const agents = new Set(['a', 'b', 'c'])

  it('detecta ciclo direto, de 3 nós e ignora não-agentes', () => {
    expect(createsAgentCycle([], agents, 'a', 'a')).toBe(true)
    expect(createsAgentCycle([{ from: 'a', to: 'b' }], agents, 'b', 'a')).toBe(true)
    expect(
      createsAgentCycle(
        [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
        agents,
        'c',
        'a'
      )
    ).toBe(true)
    expect(
      createsAgentCycle(
        [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
        agents,
        'a',
        'c'
      )
    ).toBe(false)
    // Nota no caminho não participa do piping: sem ciclo de agentes.
    expect(createsAgentCycle([{ from: 'a', to: 'n1' }], agents, 'n1', 'a')).toBe(false)
  })

  it('saneia estado carregado descartando só a aresta que fecha o ciclo', () => {
    const stored = [
      { id: 'l1', from: 'a', to: 'b' },
      { id: 'l2', from: 'b', to: 'c' },
      { id: 'l3', from: 'c', to: 'a' },
      { id: 'l4', from: 'a', to: 'n1' },
    ]
    expect(sanitizeAgentCycles(stored, agents).map((link) => link.id)).toEqual(['l1', 'l2', 'l4'])
  })
})
