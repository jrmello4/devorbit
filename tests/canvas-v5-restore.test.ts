import { describe, expect, it } from 'vitest'
import {
  canRemoveSquadMember,
  persistCanvasState,
  readCanvasState,
  type CanvasStorageLike,
  type CanvasStorageWriter,
} from '../src/renderer/src/components/WorkspaceCanvas'

const PROJECT_ID = 'proj-1'
const STORAGE_KEY = 'devorbit:workspace-canvas:' + PROJECT_ID

interface MemoryStorage extends CanvasStorageLike, CanvasStorageWriter {
  raw: Map<string, string>
}

function memoryStorage(initial?: unknown): MemoryStorage {
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

const v4Fixture = {
  version: 4,
  viewport: { x: 40, y: 36, zoom: 1 },
  nodes: [
    {
      id: 'note-handoff',
      kind: 'note',
      title: 'Handoff',
      x: 780,
      y: 40,
      width: 330,
      height: 270,
      z: 2,
      content: '# Objetivo',
    },
    {
      id: 'agent-a',
      kind: 'agent',
      title: 'Agente: Implementação',
      x: 420,
      y: 260,
      width: 500,
      height: 360,
      z: 7,
      role: 'Implementação',
      provider: 'codex',
      account: 'account2',
    },
    {
      id: 'agent-b',
      kind: 'agent',
      title: 'Revisor',
      x: 960,
      y: 260,
      width: 500,
      height: 360,
      z: 8,
      role: 'Revisão',
      provider: 'claude',
    },
  ],
  connections: [
    { id: 'l1', from: 'note-handoff', to: 'agent-a' },
    { id: 'l2', from: 'agent-a', to: 'agent-b' },
  ],
  squads: [
    {
      id: 'squad-1',
      title: 'Legado',
      coordinatorNodeId: 'agent-a',
      memberNodeIds: ['agent-a', 'agent-b'],
    },
  ],
}

const v5Fixture = {
  version: 5,
  viewport: { x: 10, y: 20, zoom: 0.75 },
  nodes: [
    {
      id: 'note-1',
      kind: 'note',
      title: 'Plano',
      x: 100,
      y: 100,
      width: 340,
      height: 300,
      z: 1,
      content: 'meta',
    },
    {
      id: 'agent-a',
      kind: 'agent',
      title: 'UX',
      x: 500,
      y: 100,
      width: 460,
      height: 320,
      z: 2,
      role: 'Especialista em UX',
    },
    {
      id: 'agent-b',
      kind: 'agent',
      title: 'Backend',
      x: 500,
      y: 500,
      width: 460,
      height: 320,
      z: 3,
      role: 'Backend',
    },
  ],
  connections: [
    { id: 'm1', from: 'note-1', to: 'squad:squad-9', kind: 'membership', label: 'objetivo' },
    { id: 'c1', from: 'agent-a', to: 'agent-b', kind: 'dependency' },
  ],
  squads: [
    {
      id: 'squad-9',
      title: 'Produto',
      objective: 'entregar',
      memberNodeIds: ['agent-a', 'agent-b'],
      collapsed: true,
    },
  ],
}

describe('save/reopen real pelo storage (mesmo caminho do localStorage)', () => {
  it('abre v4 do storage sem perder geometria, papéis, provider e arestas', () => {
    const storage = memoryStorage(v4Fixture)
    const state = readCanvasState(storage, PROJECT_ID)

    expect(state.version).toBe(5)
    expect(state.nodes.find((node) => node.id === 'agent-a')).toMatchObject({
      x: 420,
      y: 260,
      width: 500,
      height: 360,
      z: 7,
      role: 'Implementação',
      provider: 'codex',
      account: 'account2',
    })
    expect(state.nodes.find((node) => node.id === 'agent-b')).toMatchObject({
      x: 960,
      y: 260,
      z: 8,
      role: 'Revisão',
      provider: 'claude',
    })
    expect(state.connections).toEqual([
      { id: 'l1', from: 'note-handoff', to: 'agent-a', kind: 'flow' },
      { id: 'l2', from: 'agent-a', to: 'agent-b', kind: 'flow' },
    ])
  })

  it('Squad legado v4 sobrevive com membros/coordenador e ganha campos v5', () => {
    const state = readCanvasState(memoryStorage(v4Fixture), PROJECT_ID)
    expect(state.squads).toEqual([
      {
        id: 'squad-1',
        title: 'Legado',
        objective: '',
        coordinatorNodeId: 'agent-a',
        memberNodeIds: ['agent-a', 'agent-b'],
        collapsed: false,
      },
    ])
  })

  it('reabrir após salvar é estável e preserva posições/edges/squad', () => {
    const storage = memoryStorage(v4Fixture)
    const first = readCanvasState(storage, PROJECT_ID)
    persistCanvasState(storage, PROJECT_ID, first)
    const reopened = readCanvasState(storage, PROJECT_ID)

    expect(reopened).toEqual(first)
    expect(reopened.nodes.map((node) => node.x)).toEqual(first.nodes.map((node) => node.x))
    expect(reopened.connections).toEqual(first.connections)
  })

  it('edição de squad (collapse + membro) persiste e volta igual do storage', () => {
    const storage = memoryStorage(v4Fixture)
    const state = readCanvasState(storage, PROJECT_ID)
    const edited = {
      ...state,
      squads: state.squads.map((squad) =>
        squad.id === 'squad-1'
          ? { ...squad, collapsed: true, memberNodeIds: [...squad.memberNodeIds, 'agent-b'] }
          : squad,
      ),
    }
    persistCanvasState(storage, PROJECT_ID, edited)
    const reopened = readCanvasState(storage, PROJECT_ID)
    expect(reopened.squads[0]).toMatchObject({
      collapsed: true,
      memberNodeIds: ['agent-a', 'agent-b'],
      coordinatorNodeId: 'agent-a',
    })
  })
})

describe('restore v5 (squad independente, âncora, papel custom, collapse)', () => {
  it('preserva squad sem coordenador, objetivo, collapse e aresta de membership', () => {
    const state = readCanvasState(memoryStorage(v5Fixture), PROJECT_ID)
    expect(state.squads).toEqual([
      {
        id: 'squad-9',
        title: 'Produto',
        objective: 'entregar',
        memberNodeIds: ['agent-a', 'agent-b'],
        collapsed: true,
      },
    ])
    expect(state.connections).toContainEqual({
      id: 'm1',
      from: 'note-1',
      to: 'squad:squad-9',
      kind: 'membership',
      label: 'objetivo',
    })
    expect(state.connections).toContainEqual({
      id: 'c1',
      from: 'agent-a',
      to: 'agent-b',
      kind: 'dependency',
    })
    expect(state.viewport).toEqual({ x: 10, y: 20, zoom: 0.75 })
  })

  it('papel custom atravessa o reload sem virar Implementação', () => {
    const state = readCanvasState(memoryStorage(v5Fixture), PROJECT_ID)
    expect(state.nodes.find((node) => node.id === 'agent-a')?.role).toBe('Especialista em UX')
    expect(state.nodes.find((node) => node.id === 'agent-b')?.role).toBe('Backend')
  })

  it('reabrir o estado v5 é idempotente (nada é reescrito)', () => {
    const first = readCanvasState(memoryStorage(v5Fixture), PROJECT_ID)
    const storage = memoryStorage(first)
    expect(readCanvasState(storage, PROJECT_ID)).toEqual(first)
  })
})

describe('compatibilidade de versões antigas e entradas inválidas', () => {
  it('v2 preserva nós/arestas e NUNCA infere squads por conexão', () => {
    const state = readCanvasState(
      memoryStorage({
        version: 2,
        nodes: v4Fixture.nodes,
        connections: v4Fixture.connections,
        squads: v4Fixture.squads,
      }),
      PROJECT_ID,
    )
    expect(state.squads).toEqual([])
    expect(state.nodes).toHaveLength(3)
    expect(state.connections.map((connection) => connection.id)).toEqual(['l1', 'l2'])
  })

  it('formato legado de cards ainda restaura geometria', () => {
    const state = readCanvasState(
      memoryStorage({
        cards: [{ id: 'workbench', x: 10, y: 20, width: 700, height: 570, z: 1 }],
        note: 'memória antiga',
      }),
      PROJECT_ID,
    )
    expect(state.nodes.find((node) => node.kind === 'workbench')).toMatchObject({
      x: 10,
      y: 20,
      width: 700,
      height: 570,
    })
    expect(state.nodes.find((node) => node.kind === 'note')?.content).toBe('memória antiga')
  })

  it('storage vazio/corrompido cai no canvas default sem lançar', () => {
    const empty = readCanvasState(memoryStorage(), PROJECT_ID)
    expect(empty.version).toBe(5)
    expect(empty.nodes.map((node) => node.id)).toEqual(['workbench', 'note-handoff', 'browser'])

    const corrupted: MemoryStorage = {
      raw: new Map([[STORAGE_KEY, '{quebrado']]),
      getItem: () => '{quebrado',
      setItem: () => undefined,
    }
    expect(readCanvasState(corrupted, PROJECT_ID).nodes).toHaveLength(3)
  })

  it('falha de escrita no storage não derruba o canvas', () => {
    const failing: CanvasStorageWriter = {
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(() =>
      persistCanvasState(failing, PROJECT_ID, readCanvasState(memoryStorage(v5Fixture), PROJECT_ID)),
    ).not.toThrow()
  })
})

describe('integridade do squad: bloquear remoção do último membro', () => {
  it('canRemoveSquadMember só libera quando resta mais de um membro', () => {
    expect(canRemoveSquadMember({ memberNodeIds: ['a'] }, 'a')).toBe(false)
    expect(canRemoveSquadMember({ memberNodeIds: ['a', 'b'] }, 'a')).toBe(true)
    expect(canRemoveSquadMember({ memberNodeIds: ['a', 'b'] }, 'zzz')).toBe(false)
  })

  it('bloqueio preserva squad/objetivo após salvar e reabrir', () => {
    const storage = memoryStorage({
      version: 5,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'agent-a',
          kind: 'agent',
          title: 'Solo',
          x: 0,
          y: 0,
          width: 460,
          height: 320,
          z: 1,
          role: 'Implementação',
        },
      ],
      connections: [],
      squads: [
        {
          id: 'squad-solo',
          title: 'Squad Solo',
          objective: 'não perder este objetivo',
          memberNodeIds: ['agent-a'],
        },
      ],
    })
    const state = readCanvasState(storage, PROJECT_ID)
    const squad = state.squads[0]
    // Remoção do último membro é bloqueada: estado permanece intacto.
    expect(canRemoveSquadMember(squad, 'agent-a')).toBe(false)
    persistCanvasState(storage, PROJECT_ID, state)
    const reopened = readCanvasState(storage, PROJECT_ID)
    expect(reopened.squads).toEqual([
      {
        id: 'squad-solo',
        title: 'Squad Solo',
        objective: 'não perder este objetivo',
        memberNodeIds: ['agent-a'],
        collapsed: false,
      },
    ])
  })
})
