import { describe, expect, it } from 'vitest'
import {
  planSquadCreation,
  sanitizeSquads,
  nodeDisplayGeometry,
  isCompactByDefault,
  COMPACT_NODE_WIDTH,
  COMPACT_NODE_HEIGHT,
  type CanvasNode,
} from '../src/renderer/src/components/WorkspaceCanvas'
import {
  computeCanvasFocus,
  resolveCanvasNodeSlot,
  squadAnchorId,
} from '../src/renderer/src/components/workspace-request-helpers'

function agent(id: string, role = 'Implementação'): CanvasNode {
  return { id, kind: 'agent', title: 'Agente ' + id, role, x: 0, y: 0, width: 460, height: 320, z: 1 }
}

function note(id: string): CanvasNode {
  return { id, kind: 'note', title: 'Nota ' + id, x: 0, y: 0, width: 340, height: 300, z: 1 }
}

describe('sanitizeSquads v5 — squad independente da Nota', () => {
  it('mantém squad sem nota e sem conexão alguma (independência do vínculo)', () => {
    const nodes = [agent('a'), agent('b'), note('n1')]
    const squads = sanitizeSquads(
      [{ id: 's1', title: 'Squad', objective: 'entregar X', memberNodeIds: ['a', 'b'] }],
      nodes,
    )
    expect(squads).toEqual([
      {
        id: 's1',
        title: 'Squad',
        objective: 'entregar X',
        memberNodeIds: ['a', 'b'],
        collapsed: false,
      },
    ])
  })

  it('membros livres: sem teto 4/32, só agentes existentes e sem duplicatas', () => {
    const agents = Array.from({ length: 40 }, (_, index) => agent('m' + index))
    const nodes = [...agents, note('n1')]
    const [squad] = sanitizeSquads(
      [
        {
          id: 's1',
          title: 'Grande',
          memberNodeIds: [...agents.map((node) => node.id), 'm0', 'n1', 'fantasma'],
        },
      ],
      nodes,
    )
    expect(squad.memberNodeIds).toHaveLength(40)
    expect(squad.memberNodeIds).not.toContain('n1')
    expect(squad.memberNodeIds).not.toContain('fantasma')
  })

  it('coordenador é opcional e nunca promovido: inválido vira ausente', () => {
    const nodes = [agent('a'), agent('b')]
    const [semCoordenador] = sanitizeSquads(
      [{ id: 's1', title: 'Sem coord', memberNodeIds: ['a', 'b'] }],
      nodes,
    )
    expect(semCoordenador.coordinatorNodeId).toBeUndefined()

    const [forasteiro] = sanitizeSquads(
      [{ id: 's2', title: 'Forasteiro', coordinatorNodeId: 'zzz', memberNodeIds: ['a', 'b'] }],
      nodes,
    )
    expect(forasteiro.coordinatorNodeId).toBeUndefined()

    const [valido] = sanitizeSquads(
      [{ id: 's3', title: 'Válido', coordinatorNodeId: 'b', memberNodeIds: ['a', 'b'] }],
      nodes,
    )
    expect(valido.coordinatorNodeId).toBe('b')
  })

  it('preserva papel custom no nó e collapse/objetivo persistidos', () => {
    const nodes = [agent('a', 'Especialista em UX'), agent('b')]
    const [squad] = sanitizeSquads(
      [
        {
          id: 's1',
          title: 'Custom',
          objective: 'meta',
          coordinatorNodeId: 'a',
          memberNodeIds: ['a', 'b'],
          collapsed: true,
        },
      ],
      nodes,
    )
    expect(squad.collapsed).toBe(true)
    expect(squad.objective).toBe('meta')
    expect(nodes[0].role).toBe('Especialista em UX')
  })

  it('descarta squad sem membro válido e entradas malformadas', () => {
    const nodes = [agent('a')]
    expect(
      sanitizeSquads(
        [
          { id: 's1', title: 'Vazio', memberNodeIds: ['fantasma'] },
          { id: 's2', title: '   ', memberNodeIds: ['a'] },
          null,
          'lixo',
        ],
        nodes,
      ),
    ).toEqual([])
  })
})

describe('slot de cartão: collapse/atenuação são estado, nunca remoção', () => {
  const connections = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ]

  it('colapsado fica oculto e atenuado fica dimmed — mounted é sempre true', () => {
    const focusOff = computeCanvasFocus(['a'], connections)
    expect(resolveCanvasNodeSlot('a', new Set(['a']), focusOff)).toEqual({
      hidden: true,
      dimmed: false,
      mounted: true,
    })

    const focusOn = computeCanvasFocus(['a', 'b'], connections)
    expect(resolveCanvasNodeSlot('z', new Set(), focusOn)).toEqual({
      hidden: false,
      dimmed: true,
      mounted: true,
    })
    expect(resolveCanvasNodeSlot('c', new Set(), focusOn)).toEqual({
      hidden: false,
      dimmed: false,
      mounted: true,
    })
    expect(resolveCanvasNodeSlot('z', new Set(), focusOff)).toEqual({
      hidden: false,
      dimmed: false,
      mounted: true,
    })
  })

  it('colapsado tem precedência sobre o focus (não soma hidden+dimmed)', () => {
    const focusOn = computeCanvasFocus(['x', 'y'], [])
    expect(resolveCanvasNodeSlot('z', new Set(['z']), focusOn)).toEqual({
      hidden: true,
      dimmed: false,
      mounted: true,
    })
  })
})

describe('planSquadCreation — Squad independente, Nota opcional', () => {
  const layout = { originX: 1000, originY: 200, zBase: 5 }

  function deterministicIds(): () => string {
    let n = 0
    return () => `note-${String(++n).padStart(4, '0')}`
  }

  function spec(overrides: Record<string, unknown> = {}) {
    return {
      title: 'Squad Ágil',
      objective: '',
      participants: [
        { role: 'Coordenador', provider: 'codex' as const, account: 'account1' as const },
        { role: 'Implementação', provider: 'codex' as const, account: 'account1' as const },
      ],
      coordinatorIndex: 0,
      ...overrides,
    }
  }

  it('cria Squad + agentes sem Nota por padrão e sem deslocamento de Nota no layout', () => {
    const plan = planSquadCreation(spec(), layout, { createId: deterministicIds() })
    expect(plan.note).toBeNull()
    expect(plan.agents).toHaveLength(2)
    expect(plan.agents[0].x).toBe(layout.originX)
    expect(plan.squad.objective).toBe('')
    expect(plan.squad.coordinatorNodeId).toBe(plan.agents[0].id)
    expect(plan.squad.memberNodeIds).toEqual(plan.agents.map((agent) => agent.id))
    expect(plan.connections).toEqual([
      {
        id: expect.any(String),
        from: plan.agents[0].id,
        to: plan.agents[1].id,
        kind: 'coordination',
      },
    ])
    expect(plan.selectedIds).toEqual(plan.agents.map((agent) => agent.id))
  })

  it('persiste objective no squad sem criar Nota nem vínculo Note→Squad', () => {
    const plan = planSquadCreation(spec({ objective: 'Entregar o módulo X' }), layout, {
      createId: deterministicIds(),
    })
    expect(plan.note).toBeNull()
    expect(plan.squad.objective).toBe('Entregar o módulo X')
    expect(plan.connections.some((connection) => connection.kind === 'membership')).toBe(false)
  })

  it('cria Nota e vínculo Note→Squad apenas com opt-in explícito', () => {
    const plan = planSquadCreation(spec({ objective: 'Entregar o módulo X' }), layout, {
      createId: deterministicIds(),
      createNote: true,
    })
    expect(plan.note?.title).toBe('Plano da tarefa')
    expect(plan.note?.content).toContain('Entregar o módulo X')
    expect(plan.connections.find((connection) => connection.kind === 'membership')).toMatchObject({
      from: plan.note?.id,
      to: squadAnchorId(plan.squad.id),
      label: 'objetivo',
    })
    expect(plan.selectedIds[0]).toBe(plan.note?.id)
  })

  it('índice de coordenador inválido não promove ninguém nem cria arestas', () => {
    const plan = planSquadCreation(spec({ coordinatorIndex: 9 }), layout, {
      createId: deterministicIds(),
    })
    expect(plan.squad.coordinatorNodeId).toBeUndefined()
    expect(plan.connections).toEqual([])
  })
})

describe('geometria compacta derivada (TASK-06)', () => {
  const persisted: CanvasNode = {
    id: 'a1',
    kind: 'agent',
    title: 'Agente',
    x: 120,
    y: 80,
    width: 500,
    height: 360,
    z: 2,
  }

  it('Agent/Terminal são compactos por padrão; demais nós não', () => {
    expect(isCompactByDefault({ kind: 'agent' })).toBe(true)
    expect(isCompactByDefault({ kind: 'terminal' })).toBe(true)
    expect(isCompactByDefault({ kind: 'note' })).toBe(false)
    expect(isCompactByDefault({ kind: 'workbench' })).toBe(false)
  })

  it('compacto deriva 320x130 sem mutar a geometria persistida', () => {
    const display = nodeDisplayGeometry(persisted, true)
    expect(display.width).toBe(COMPACT_NODE_WIDTH)
    expect(display.height).toBe(COMPACT_NODE_HEIGHT)
    expect(display.x).toBe(persisted.x)
    expect(display.y).toBe(persisted.y)
    expect(persisted.width).toBe(500)
    expect(persisted.height).toBe(360)
  })

  it('expandido preserva a geometria persistida (mesma referência)', () => {
    const display = nodeDisplayGeometry(persisted, false)
    expect(display).toBe(persisted)
    expect(display.width).toBe(500)
    expect(display.height).toBe(360)
  })
})
