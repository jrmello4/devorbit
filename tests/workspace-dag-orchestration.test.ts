import { describe, expect, it } from 'vitest'
import {
  orderSpecialistsByGraph,
  discoverSpecialists,
  type CanvasNode,
  type CanvasConnection,
  type OrchestrationNote,
} from '../src/renderer/src/components/WorkspaceCanvas'

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
  role?: 'Coordenador' | 'Implementação' | 'Revisão' | 'Testes',
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
