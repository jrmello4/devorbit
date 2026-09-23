import { describe, expect, it } from 'vitest'
import {
  addSquadMember,
  applyWorkspaceUiRequest,
  buildPendingCreation,
  buildPendingCanvasNode,
  buildWorkspaceUiRequest,
  CANVAS_ZOOM_LEVELS,
  collectSquadAnchorIds,
  computeCanvasFocus,
  computeFocusViewport,
  computePipeSync,
  computeSquadRegions,
  computeStreamingPipeEdges,
  computeWebSuppressed,
  createsAgentCycle,
  inferCanvasEdgeKind,
  isCanvasNodeDimmed,
  isPendingNodeForProject,
  parseSquadAnchorId,
  removeSquadMember,
  renameSquad,
  sanitizeAgentCycles,
  sanitizeCanvasEdges,
  setSquadCoordinator,
  setSquadObjective,
  squadAnchorId,
  squadCoordinatedBy,
  squadForNode,
  stepZoomLevel,
  toggleSquadCollapsed,
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

describe('computeSquadRegions (Hero Ops squad layer)', () => {
  const nodes = [
    { id: 'coordinator', x: 100, y: 100, width: 300, height: 200 },
    { id: 'specialist', x: 500, y: 260, width: 280, height: 180 },
    { id: 'note', x: 20, y: 20, width: 200, height: 150 },
  ]
  const squad = {
    id: 'squad-1',
    title: 'Frontend Review',
    coordinatorNodeId: 'coordinator',
    memberNodeIds: ['coordinator', 'specialist'],
  }

  it('cobre todos os membros com padding simétrico e marca collapse', () => {
    expect(computeSquadRegions([squad], nodes, 24)).toEqual([
      {
        id: 'squad-1',
        title: 'Frontend Review',
        coordinatorNodeId: 'coordinator',
        x: 76,
        y: 76,
        width: 728,
        height: 388,
        collapsed: false,
      },
    ])
  })

  it('propaga collapsed do squad para a região', () => {
    const [region] = computeSquadRegions([{ ...squad, collapsed: true }], nodes)
    expect(region.collapsed).toBe(true)
  })

  it('ignora membros ausentes e squads sem nós válidos', () => {
    const partial = { ...squad, memberNodeIds: ['coordinator', 'missing'] }
    const [region] = computeSquadRegions([partial, { ...squad, id: 'squad-2', memberNodeIds: ['missing'] }], nodes, 10)
    expect(region).toMatchObject({ x: 90, y: 90, width: 320, height: 220 })
    expect(computeSquadRegions([{ ...squad, memberNodeIds: [] }], nodes)).toEqual([])
  })

  it('ordena as regiões de forma determinística', () => {
    const regions = computeSquadRegions([
      { ...squad, id: 'b', memberNodeIds: ['specialist'] },
      { ...squad, id: 'a', memberNodeIds: ['coordinator'] },
    ], nodes)
    expect(regions.map((region) => region.id)).toEqual(['a', 'b'])
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

describe('edição de squad (membros livres, coordenador opcional)', () => {
  const base = {
    id: 's1',
    title: 'Squad',
    objective: '',
    memberNodeIds: ['a', 'b'],
    collapsed: false,
  }

  it('adiciona membro sem duplicar e sem cap de 4/32', () => {
    const members = Array.from({ length: 40 }, (_, index) => 'm' + index)
    const big = { ...base, memberNodeIds: members }
    const next = addSquadMember(big, 'novo')
    expect(next.memberNodeIds).toHaveLength(41)
    expect(addSquadMember(next, 'novo').memberNodeIds).toHaveLength(41)
    expect(addSquadMember(base, 'a')).toBe(base)
  })

  it('remove membro; coordenador que sai deixa o squad sem coordenador', () => {
    const withCoordinator = { ...base, coordinatorNodeId: 'a' }
    const next = removeSquadMember(withCoordinator, 'a')
    expect(next.memberNodeIds).toEqual(['b'])
    expect(next.coordinatorNodeId).toBeUndefined()
    // Remover quem não é membro é no-op.
    expect(removeSquadMember(base, 'zzz')).toBe(base)
  })

  it('troca o coordenador apenas entre membros; null limpa a função', () => {
    expect(setSquadCoordinator(base, 'b').coordinatorNodeId).toBe('b')
    expect(setSquadCoordinator(base, 'forasteiro')).toBe(base)
    expect(setSquadCoordinator({ ...base, coordinatorNodeId: 'a' }, null).coordinatorNodeId).toBeUndefined()
  })

  it('renomeia com saneamento, define objetivo e alterna collapse', () => {
    expect(renameSquad(base, '  Novo nome  ').title).toBe('Novo nome')
    expect(renameSquad(base, '   ').title).toBe('Squad')
    expect(setSquadObjective(base, 'entregar X').objective).toBe('entregar X')
    expect(toggleSquadCollapsed(base).collapsed).toBe(true)
    expect(toggleSquadCollapsed({ ...base, collapsed: true }).collapsed).toBe(false)
  })

  it('localiza squad por membro e por coordenador', () => {
    const squads = [base, { ...base, id: 's2', memberNodeIds: ['c'], coordinatorNodeId: 'c' }]
    expect(squadForNode(squads, 'b')?.id).toBe('s1')
    expect(squadCoordinatedBy(squads, 'c')?.id).toBe('s2')
    expect(squadForNode(squads, 'zzz')).toBeUndefined()
  })
})

describe('arestas tipadas e âncoras de squad', () => {
  const nodeIds = new Set(['note-1', 'agent-a', 'agent-b', 'note-2'])
  const agentIds = new Set(['agent-a', 'agent-b'])
  const anchors = collectSquadAnchorIds([{ id: 's1' }])

  it('infere delegação para agente→agente e contexto para o resto', () => {
    expect(inferCanvasEdgeKind('agent', 'agent')).toBe('delegation')
    expect(inferCanvasEdgeKind('note', 'agent')).toBe('context')
    expect(inferCanvasEdgeKind('agent', 'note')).toBe('context')
  })

  it('endpoint âncora squad:<id> sobrevive à sanitização e vira rótulo de vínculo', () => {
    const edges = sanitizeCanvasEdges(
      [
        { id: 'l1', from: 'note-1', to: squadAnchorId('s1'), kind: 'membership' },
        { id: 'l2', from: 'note-1', to: squadAnchorId('fantasma'), kind: 'membership' },
        { id: 'l3', from: 'note-1', to: 'note-2' },
      ],
      nodeIds,
      agentIds,
      anchors,
    )
    expect(edges.map((edge) => edge.id)).toEqual(['l1', 'l3'])
    expect(edges[0]).toMatchObject({ kind: 'membership', to: 'squad:s1' })
    expect(edges[1]).toMatchObject({ kind: 'flow' })
  })

  it('guarda de ciclo só vale para arestas de ordenação agente→agente', () => {
    const edges = sanitizeCanvasEdges(
      [
        { id: 'l1', from: 'agent-a', to: 'agent-b', kind: 'delegation' },
        { id: 'l2', from: 'agent-b', to: 'agent-a', kind: 'delegation' },
        { id: 'l3', from: 'agent-b', to: 'agent-a', kind: 'result' },
        { id: 'l4', from: 'agent-a', to: 'agent-b', kind: 'context' },
      ],
      nodeIds,
      agentIds,
      anchors,
    )
    expect(edges.map((edge) => edge.id)).toEqual(['l1', 'l3', 'l4'])
  })

  it('descarta self-loop e ponta inexistente', () => {
    expect(
      sanitizeCanvasEdges(
        [
          { id: 'x', from: 'note-1', to: 'note-1' },
          { id: 'y', from: 'note-1', to: 'fantasma' },
        ],
        nodeIds,
        agentIds,
        anchors,
      ),
    ).toEqual([])
  })

  it('parseSquadAnchorId reconhece apenas o prefixo do contrato', () => {
    expect(parseSquadAnchorId(squadAnchorId('s1'))).toBe('s1')
    expect(parseSquadAnchorId('note-1')).toBeNull()
  })
})

describe('focus de múltipla seleção e níveis de zoom', () => {
  const connections = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ]

  it('desliga com 0/1 selecionado e mantém selecionados + vizinhos diretos', () => {
    expect(computeCanvasFocus([], connections).active).toBe(false)
    expect(computeCanvasFocus(['a'], connections).active).toBe(false)
    const focus = computeCanvasFocus(['a', 'b'], connections)
    expect(focus.active).toBe(true)
    expect([...focus.relatedIds].sort()).toEqual(['a', 'b', 'c'])
    expect(isCanvasNodeDimmed('c', focus)).toBe(false)
    expect(isCanvasNodeDimmed('d', focus)).toBe(true)
  })

  it('saída simples: seleção única desliga a atenuação', () => {
    expect(isCanvasNodeDimmed('d', computeCanvasFocus(['a'], connections))).toBe(false)
  })

  it('stepZoomLevel anda por níveis discretos e respeita os limites', () => {
    expect([...CANVAS_ZOOM_LEVELS]).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5])
    expect(stepZoomLevel(1, 1)).toBe(1.25)
    expect(stepZoomLevel(1, -1)).toBe(0.75)
    expect(stepZoomLevel(1.5, 1)).toBe(1.5)
    expect(stepZoomLevel(0.25, -1)).toBe(0.25)
    expect(stepZoomLevel(0.9, 1)).toBe(1)
  })

  it('computeFocusViewport centraliza a seleção com padding e clampa o zoom', () => {
    const nodes = [
      { id: 'a', x: 0, y: 0, width: 100, height: 100 },
      { id: 'b', x: 300, y: 100, width: 100, height: 100 },
    ]
    const view = computeFocusViewport(nodes, { width: 800, height: 600 })
    expect(view).not.toBeNull()
    // Centro do bounding box (200, 100) cai no centro da viewport.
    expect(view!.x + 200 * view!.zoom).toBeCloseTo(400, 5)
    expect(view!.y + 100 * view!.zoom).toBeCloseTo(300, 5)
    expect(view!.zoom).toBeLessThanOrEqual(1.6)
    expect(view!.zoom).toBeGreaterThanOrEqual(0.08)

    expect(computeFocusViewport([], { width: 800, height: 600 })).toBeNull()
    expect(computeFocusViewport(nodes, { width: 0, height: 0 })).toBeNull()
    const clamped = computeFocusViewport(
      [{ id: 'tiny', x: 0, y: 0, width: 10, height: 10 }],
      { width: 800, height: 600 },
      { maxZoom: 1.25 },
    )
    expect(clamped!.zoom).toBe(1.25)
  })
})
