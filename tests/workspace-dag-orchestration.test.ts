import { describe, expect, it } from 'vitest'
import {
  orderSpecialistsByGraph,
  discoverSpecialists,
  orchestrationContextNotes,
  memberContextNotes,
  type CanvasNode,
  type CanvasConnection,
  type OrchestrationNote,
} from '../src/renderer/src/components/WorkspaceCanvas'
import { squadAnchorId } from '../src/renderer/src/components/workspace-request-helpers'

type CanvasConn = { id: string; from: string; to: string }
type SpecAgent = {
  id: string
  title: string
  role: 'Implementação' | 'Revisão' | 'Testes' | 'Coordenador'
  notes: Array<{ id: string; title: string; content: string }>
}

function makeAgent(id: string, title: string, role: 'Implementação' | 'Revisão' | 'Testes' = 'Implementação'): SpecAgent {
  return { id, title, role, notes: [] }
}

function makeNode(
  id: string,
  kind: 'agent' | 'note' | 'workbench' | 'browser',
  title: string,
  role?: string,
  content?: string,
): CanvasNode {
  return {
    id,
    kind,
    title,
    role,
    content,
    x: 0,
    y: 0,
    width: 200,
    height: 150,
    z: 1,
  }
}

describe('WorkspaceCanvas DAG Orchestration', () => {
  it('preserves single specialist or empty array', () => {
    expect(orderSpecialistsByGraph([], [])).toEqual([])
    const single = [makeAgent('a1', 'Agent 1')]
    expect(orderSpecialistsByGraph(single, [])).toEqual(single)
  })

  it('orders specialists according to direct dependency connections (A -> B)', () => {
    // Agent 1 -> Agent 2 means Agent 1 must run before Agent 2
    const a1 = makeAgent('a1', 'Agent 1', 'Testes')
    const a2 = makeAgent('a2', 'Agent 2', 'Implementação')
    const connections: CanvasConn[] = [{ id: 'c1', from: 'a1', to: 'a2' }]

    // Even though a2 is Implementação and a1 is Testes, the graph connection forces a1 before a2
    const result = orderSpecialistsByGraph([a2, a1], connections)
    expect(result.map((a) => a.id)).toEqual(['a1', 'a2'])
  })

  it('orders multi-step linear dependency chains (A -> B -> C)', () => {
    const a = makeAgent('a', 'Step A')
    const b = makeAgent('b', 'Step B')
    const c = makeAgent('c', 'Step C')
    const connections: CanvasConn[] = [
      { id: 'c1', from: 'a', to: 'b' },
      { id: 'c2', from: 'b', to: 'c' },
    ]

    const result = orderSpecialistsByGraph([c, a, b], connections)
    expect(result.map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('handles diamond dependencies with parallel candidates (A -> B, A -> C, B -> D, C -> D)', () => {
    const a = makeAgent('a', 'Alpha')
    const b = makeAgent('b', 'Beta', 'Implementação')
    const c = makeAgent('c', 'Charlie', 'Revisão')
    const d = makeAgent('d', 'Delta', 'Testes')

    const connections: CanvasConn[] = [
      { id: 'c1', from: 'a', to: 'b' },
      { id: 'c2', from: 'a', to: 'c' },
      { id: 'c3', from: 'b', to: 'd' },
      { id: 'c4', from: 'c', to: 'd' },
    ]

    const result = orderSpecialistsByGraph([d, c, b, a], connections)
    expect(result[0].id).toBe('a')
    // b and c are parallel, b (Implementação) comes before c (Revisão) by role tiebreaker
    expect(result.slice(1, 3).map((x) => x.id)).toEqual(['b', 'c'])
    expect(result[3].id).toBe('d')
  })

  it('safely breaks cycles (A -> B -> C -> A) and returns all specialists without hanging', () => {
    const a = makeAgent('a', 'Alpha')
    const b = makeAgent('b', 'Beta')
    const c = makeAgent('c', 'Gamma')

    const cyclicConnections: CanvasConn[] = [
      { id: 'c1', from: 'a', to: 'b' },
      { id: 'c2', from: 'b', to: 'c' },
      { id: 'c3', from: 'c', to: 'a' },
    ]

    const result = orderSpecialistsByGraph([a, b, c], cyclicConnections)
    expect(result).toHaveLength(3)
    const resultIds = new Set(result.map((x) => x.id))
    expect(resultIds).toEqual(new Set(['a', 'b', 'c']))
  })

  it('uses role order as deterministic tiebreaker for independent parallel specialists', () => {
    const impl = makeAgent('i1', 'Dev', 'Implementação')
    const rev = makeAgent('r1', 'Reviewer', 'Revisão')
    const test = makeAgent('t1', 'Tester', 'Testes')

    // No connections between them
    const result = orderSpecialistsByGraph([test, rev, impl], [])
    expect(result.map((x) => x.id)).toEqual(['i1', 'r1', 't1'])
  })
})

describe('WorkspaceCanvas discoverSpecialists directed reachability & full flow', () => {
  const coord = makeNode('coord', 'agent', 'Coordinator', 'Coordenador')
  const taskNote = makeNode('note-task', 'note', 'Project Spec', undefined, 'Orchestration objective')

  it('discovers all specialists reachable along directed chains (Coordinator -> A -> B) and excludes islands', () => {
    const agentA = makeNode('agent-a', 'agent', 'Agent A', 'Testes')
    const agentB = makeNode('agent-b', 'agent', 'Agent B', 'Implementação')
    const agentIsland = makeNode('agent-island', 'agent', 'Agent Island', 'Implementação')

    const connections: CanvasConnection[] = [
      { id: 'c-note', from: 'coord', to: 'note-task' },
      { id: 'c-1', from: 'coord', to: 'agent-a' },
      { id: 'c-2', from: 'agent-a', to: 'agent-b' },
    ]

    const nodes: CanvasNode[] = [coord, taskNote, agentA, agentB, agentIsland]
    const specialists = discoverSpecialists({ nodes, connections }, coord)

    // Agent Island is unreachable from Coordinator, must not be included
    expect(specialists.map((s) => s.id)).toEqual(['agent-a', 'agent-b'])
    // Agent A runs before Agent B due to directed connection A -> B (even though B has Implementação role)
    expect(specialists[0].id).toBe('agent-a')
    expect(specialists[1].id).toBe('agent-b')
  })

  it('discovers multi-step specialist chain initiated from a coordinator note (Coordinator -> Note -> A -> B -> C)', () => {
    const agentA = makeNode('agent-a', 'agent', 'Agent A', 'Testes')
    const agentB = makeNode('agent-b', 'agent', 'Agent B', 'Revisão')
    const agentC = makeNode('agent-c', 'agent', 'Agent C', 'Implementação')

    const connections: CanvasConnection[] = [
      { id: 'c-0', from: 'coord', to: 'note-task' },
      { id: 'c-1', from: 'note-task', to: 'agent-a' },
      { id: 'c-2', from: 'agent-a', to: 'agent-b' },
      { id: 'c-3', from: 'agent-b', to: 'agent-c' },
    ]

    const nodes: CanvasNode[] = [coord, taskNote, agentA, agentB, agentC]
    const specialists = discoverSpecialists({ nodes, connections }, coord)

    expect(specialists.map((s) => s.id)).toEqual(['agent-a', 'agent-b', 'agent-c'])
  })

  it('traverses intermediate notes in agent chains (Coordinator -> A -> IntermediateNote -> B)', () => {
    const agentA = makeNode('agent-a', 'agent', 'Agent A', 'Implementação')
    const intermediateNote = makeNode('note-inter', 'note', 'Handoff Doc', undefined, 'Design schema')
    const agentB = makeNode('agent-b', 'agent', 'Agent B', 'Revisão')

    const connections: CanvasConnection[] = [
      { id: 'c-0', from: 'coord', to: 'note-task' },
      { id: 'c-1', from: 'coord', to: 'agent-a' },
      { id: 'c-2', from: 'agent-a', to: 'note-inter' },
      { id: 'c-3', from: 'note-inter', to: 'agent-b' },
      // Direct graph connection between agents for execution order
      { id: 'c-4', from: 'agent-a', to: 'agent-b' },
    ]

    const nodes: CanvasNode[] = [coord, taskNote, agentA, intermediateNote, agentB]
    const specialists = discoverSpecialists({ nodes, connections }, coord)

    expect(specialists.map((s) => s.id)).toEqual(['agent-a', 'agent-b'])
  })

  it('handles diamond DAG reachability and topological sort (Coordinator -> A -> (B, C) -> D)', () => {
    const a = makeNode('a', 'agent', 'Alpha', 'Implementação')
    const b = makeNode('b', 'agent', 'Beta', 'Implementação')
    const c = makeNode('c', 'agent', 'Charlie', 'Revisão')
    const d = makeNode('d', 'agent', 'Delta', 'Testes')

    const connections: CanvasConnection[] = [
      { id: 'c-0', from: 'coord', to: 'note-task' },
      { id: 'c-1', from: 'coord', to: 'a' },
      { id: 'c-2', from: 'a', to: 'b' },
      { id: 'c-3', from: 'a', to: 'c' },
      { id: 'c-4', from: 'b', to: 'd' },
      { id: 'c-5', from: 'c', to: 'd' },
    ]

    const nodes: CanvasNode[] = [coord, taskNote, a, b, c, d]
    const specialists = discoverSpecialists({ nodes, connections }, coord)

    expect(specialists[0].id).toBe('a')
    expect(specialists.slice(1, 3).map((s) => s.id)).toEqual(['b', 'c'])
    expect(specialists[3].id).toBe('d')
  })

  it('ignores upstream agents pointing into coordinator (Upstream -> Coordinator)', () => {
    const upstream = makeNode('upstream', 'agent', 'Upstream Agent', 'Implementação')
    const downstream = makeNode('downstream', 'agent', 'Downstream Agent', 'Implementação')

    const connections: CanvasConnection[] = [
      { id: 'c-0', from: 'coord', to: 'note-task' },
      { id: 'c-up', from: 'upstream', to: 'coord' },
      { id: 'c-down', from: 'coord', to: 'downstream' },
    ]

    const nodes: CanvasNode[] = [coord, taskNote, upstream, downstream]
    const specialists = discoverSpecialists({ nodes, connections }, coord)

    expect(specialists.map((s) => s.id)).toEqual(['downstream'])
  })

  it('safely handles directed cycles without infinite loops and breaks cycles deterministically', () => {
    const a = makeNode('a', 'agent', 'Agent A', 'Implementação')
    const b = makeNode('b', 'agent', 'Agent B', 'Revisão')

    const connections: CanvasConnection[] = [
      { id: 'c-0', from: 'coord', to: 'note-task' },
      { id: 'c-1', from: 'coord', to: 'a' },
      { id: 'c-2', from: 'a', to: 'b' },
      { id: 'c-3', from: 'b', to: 'a' }, // cycle
    ]

    const nodes: CanvasNode[] = [coord, taskNote, a, b]
    const specialists = discoverSpecialists({ nodes, connections }, coord)

    expect(specialists).toHaveLength(2)
    const specialistIds = new Set(specialists.map((s) => s.id))
    expect(specialistIds).toEqual(new Set(['a', 'b']))
  })

  it('associates connected specialist notes with each discovered specialist', () => {
    const a = makeNode('a', 'agent', 'Agent A', 'Implementação')
    const noteA = makeNode('note-a', 'note', 'Spec for A', undefined, 'Implementation details for A')

    const connections: CanvasConnection[] = [
      { id: 'c-0', from: 'coord', to: 'note-task' },
      { id: 'c-1', from: 'coord', to: 'a' },
      { id: 'c-note-a', from: 'a', to: 'note-a' },
    ]

    const nodes: CanvasNode[] = [coord, taskNote, a, noteA]
    const specialists = discoverSpecialists({ nodes, connections }, coord)

    expect(specialists).toHaveLength(1)
    expect(specialists[0].notes).toEqual([
      { id: 'note-a', title: 'Spec for A', content: 'Implementation details for A' },
    ])
  })
})

describe('WorkspaceCanvas squad-first discovery (TASK-02B)', () => {
  const coord = makeNode('coord', 'agent', 'Tech Lead', 'Tech Lead')
  const memberA = makeNode('a', 'agent', 'Backend', 'Backend')
  const memberB = makeNode('b', 'agent', 'UX', 'Especialista em UX')
  const island = makeNode('island', 'agent', 'Island', 'Implementação')

  it('usa os membros explícitos do squad (menos o coordenador) e ignora ilhas', () => {
    const nodes: CanvasNode[] = [coord, memberA, memberB, island]
    const connections: CanvasConnection[] = [{ id: 'c1', from: 'coord', to: 'island' }]
    const specialists = discoverSpecialists({ nodes, connections }, coord, [], {
      memberNodeIds: ['coord', 'a', 'b'],
    })
    expect(specialists.map((s) => s.id).sort()).toEqual(['a', 'b'])
  })

  it('papel custom nunca vira Coordenador nem é reescrito para Implementação', () => {
    const nodes: CanvasNode[] = [coord, memberA, memberB]
    const specialists = discoverSpecialists({ nodes, connections: [] }, coord, [], {
      memberNodeIds: ['coord', 'a', 'b'],
    })
    expect(specialists.map((s) => s.id).sort()).toEqual(['a', 'b'])
    expect(specialists.find((s) => s.id === 'b')?.role).toBe('Especialista em UX')
    expect(specialists.some((s) => s.role === 'Coordenador')).toBe(false)
  })

  it('ordenação interna usa só arestas de ordenação (delegation) e ignora coordenação', () => {
    const nodes: CanvasNode[] = [coord, memberA, memberB]
    const connections: CanvasConnection[] = [
      { id: 'c1', from: 'a', to: 'b', kind: 'delegation' },
      { id: 'c2', from: 'coord', to: 'b', kind: 'coordination' },
    ]
    const specialists = discoverSpecialists({ nodes, connections }, coord, [], {
      memberNodeIds: ['coord', 'a', 'b'],
    })
    expect(specialists.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('squad sem membros além do coordenador não inventa especialistas', () => {
    const nodes: CanvasNode[] = [coord, memberA]
    const specialists = discoverSpecialists({ nodes, connections: [] }, coord, [], {
      memberNodeIds: ['coord'],
    })
    expect(specialists).toEqual([])
  })
})

describe('WorkspaceCanvas orchestration context origin (Note→Squad + objective)', () => {
  const coord = makeNode('coord', 'agent', 'Tech Lead', 'Coordenador')
  const memberA = makeNode('a', 'agent', 'Backend', 'Implementação')
  const squad = { id: 's1', objective: '' }

  it('Note conectada à âncora do squad alimenta o contexto da equipe', () => {
    const note = makeNode('note-squad', 'note', 'Plano da tarefa', undefined, 'Entregar o módulo X')
    const nodes: CanvasNode[] = [coord, memberA, note]
    const connections: CanvasConnection[] = [
      { id: 'c-anchor', from: 'note-squad', to: squadAnchorId('s1'), kind: 'membership' },
    ]
    const notes = orchestrationContextNotes({ nodes, connections }, 'coord', squad)
    expect(notes).toEqual([
      { id: 'note-squad', title: 'Plano da tarefa', content: 'Entregar o módulo X' },
    ])
  })

  it('Squad com objective e sem Note usa o objetivo como contexto explícito', () => {
    const nodes: CanvasNode[] = [coord, memberA]
    const notes = orchestrationContextNotes({ nodes, connections: [] }, 'coord', {
      id: 's1',
      objective: 'Reduzir latência do checkout',
    })
    expect(notes).toEqual([
      {
        id: 'squad-objective-s1',
        title: 'Objetivo da squad',
        content: 'Reduzir latência do checkout',
      },
    ])
  })

  it('Squad sem Note e sem objective não fornece contexto (orquestração não inicia)', () => {
    const nodes: CanvasNode[] = [coord, memberA]
    expect(orchestrationContextNotes({ nodes, connections: [] }, 'coord', squad)).toEqual([])
  })

  it('preserva notas ligadas diretamente ao coordenador (legado) e não duplica o objetivo', () => {
    const direct = makeNode('note-direct', 'note', 'Handoff', undefined, 'Contexto legado direto')
    const squadNote = makeNode(
      'note-squad',
      'note',
      'Plano da tarefa',
      undefined,
      '# Objetivo\n\nReduzir latência do checkout',
    )
    const nodes: CanvasNode[] = [coord, memberA, direct, squadNote]
    const connections: CanvasConnection[] = [
      { id: 'c-direct', from: 'coord', to: 'note-direct', kind: 'context' },
      { id: 'c-anchor', from: squadNote.id, to: squadAnchorId('s1'), kind: 'membership' },
    ]
    const notes = orchestrationContextNotes({ nodes, connections }, 'coord', {
      id: 's1',
      objective: 'Reduzir latência do checkout',
    })
    expect(notes.map((note) => note.id).sort()).toEqual(['note-direct', 'note-squad'])
    expect(notes.some((note) => note.id.startsWith('squad-objective-'))).toBe(false)
  })

  it('notas de squad e diretas vazias não disparam contexto', () => {
    const emptyNote = makeNode('note-empty', 'note', 'Rascunho', undefined, '   ')
    const nodes: CanvasNode[] = [coord, memberA, emptyNote]
    const connections: CanvasConnection[] = [
      { id: 'c-anchor', from: emptyNote.id, to: squadAnchorId('s1'), kind: 'membership' },
    ]
    expect(orchestrationContextNotes({ nodes, connections }, 'coord', squad)).toEqual([])
  })
})

describe('WorkspaceCanvas memberContextNotes — envio manual herda contexto da squad', () => {
  const coord = makeNode('coord', 'agent', 'Tech Lead', 'Coordenador')
  const memberA = makeNode('a', 'agent', 'Backend', 'Implementação')
  const squad = {
    id: 's1',
    title: 'Squad',
    objective: '',
    memberNodeIds: ['coord', 'a'],
    collapsed: false,
  }

  it('membro não-coordenador sem nota direta usa a nota ligada à âncora do squad', () => {
    const note = makeNode('note-squad', 'note', 'Plano da tarefa', undefined, 'Entregar X')
    const nodes: CanvasNode[] = [coord, memberA, note]
    const connections: CanvasConnection[] = [
      { id: 'c-anchor', from: note.id, to: squadAnchorId('s1'), kind: 'membership' },
    ]
    expect(memberContextNotes({ nodes, connections, squads: [squad] }, 'a')).toEqual([
      { id: 'note-squad', title: 'Plano da tarefa', content: 'Entregar X' },
    ])
  })

  it('membro sem nota direta usa o objetivo da squad', () => {
    const nodes: CanvasNode[] = [coord, memberA]
    const notes = memberContextNotes(
      { nodes, connections: [], squads: [{ ...squad, objective: 'Reduzir latência' }] },
      'a',
    )
    expect(notes).toEqual([
      { id: 'squad-objective-s1', title: 'Objetivo da squad', content: 'Reduzir latência' },
    ])
  })

  it('agente avulso mantém apenas notas diretas (não herda squad alheio)', () => {
    const free = makeNode('free', 'agent', 'Avulso', 'Implementação')
    const direct = makeNode('note-direct', 'note', 'Handoff', undefined, 'Contexto direto')
    const squadNote = makeNode('note-squad', 'note', 'Plano', undefined, 'Contexto da squad')
    const nodes: CanvasNode[] = [coord, memberA, free, direct, squadNote]
    const connections: CanvasConnection[] = [
      { id: 'c-direct', from: 'free', to: direct.id, kind: 'context' },
      { id: 'c-anchor', from: squadNote.id, to: squadAnchorId('s1'), kind: 'membership' },
    ]
    expect(memberContextNotes({ nodes, connections, squads: [squad] }, 'free')).toEqual([
      { id: 'note-direct', title: 'Handoff', content: 'Contexto direto' },
    ])
  })

  it('agente avulso sem nota direta não recebe contexto (bloqueio mantido)', () => {
    const free = makeNode('free', 'agent', 'Avulso', 'Implementação')
    const squadNote = makeNode('note-squad', 'note', 'Plano', undefined, 'Contexto da squad')
    const nodes: CanvasNode[] = [coord, memberA, free, squadNote]
    const connections: CanvasConnection[] = [
      { id: 'c-anchor', from: squadNote.id, to: squadAnchorId('s1'), kind: 'membership' },
    ]
    expect(memberContextNotes({ nodes, connections, squads: [squad] }, 'free')).toEqual([])
  })
})
