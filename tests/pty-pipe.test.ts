import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __setPipeClock,
  clearPipe,
  clearPipesFor,
  installPtyPipe,
  listPipes,
  resetPipes,
  setPipe,
  uninstallPtyPipe,
  type PtyPipeDependencies,
} from '../src/main/pty-pipe'
import type { TerminalEvent } from '../src/main/terminal-session'

function createDeps(): PtyPipeDependencies & { emit: (event: TerminalEvent) => void; written: Array<{ id: string; input: string }> } {
  const listeners = new Set<(event: TerminalEvent) => void>()
  const written: Array<{ id: string; input: string }> = []
  const live = new Set<string>(['src-node', 'dst-node', 'third-node', 'fourth-node'])
  return {
    written,
    emit: (event) => listeners.forEach((listener) => listener(event)),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    write: vi.fn((id: string, input: string) => {
      written.push({ id, input })
      return true
    }),
    exists: (id: string) => live.has(id),
  }
}

beforeEach(() => {
  resetPipes()
  uninstallPtyPipe()
  __setPipeClock(() => Date.now())
})

describe('pty pipe registry', () => {
  it('validates ids and refuses self-loops', () => {
    expect(() => setPipe('../evil', 'dst-node')).toThrow('Identificador de terminal inválido')
    expect(() => setPipe('src-node', 'src-node')).toThrow('si mesmo')
    expect(listPipes()).toEqual([])
  })

  it('supports fanout from one source to many destinations', () => {
    setPipe('src-node', 'dst-node')
    setPipe('src-node', 'third-node')
    expect(listPipes()).toEqual([
      { from: 'src-node', to: 'dst-node' },
      { from: 'src-node', to: 'third-node' },
    ])
    const deps = createDeps()
    const uninstall = installPtyPipe(deps)
    try {
      deps.emit({ id: 'src-node', type: 'data', data: 'broadcast\n' })
      expect(deps.written).toEqual([
        { id: 'dst-node', input: 'broadcast\n' },
        { id: 'third-node', input: 'broadcast\n' },
      ])
    } finally {
      uninstall()
    }
  })

  it('blocks cycles of any length', () => {
    setPipe('src-node', 'dst-node')
    setPipe('dst-node', 'third-node')
    expect(() => setPipe('third-node', 'src-node')).toThrow('ciclo')
    expect(() => setPipe('dst-node', 'src-node')).toThrow('ciclo')
    // Grafo acíclico continua válido após as rejeições.
    expect(listPipes()).toEqual([
      { from: 'dst-node', to: 'third-node' },
      { from: 'src-node', to: 'dst-node' },
    ])
  })

  it('caps runaway forwarding per second per edge', () => {
    let timestamp = 1_000_000
    __setPipeClock(() => timestamp)
    const deps = createDeps()
    const uninstall = installPtyPipe(deps)
    try {
      setPipe('src-node', 'dst-node')
      for (let index = 0; index < 120; index += 1) {
        deps.emit({ id: 'src-node', type: 'data', data: `line ${index}\n` })
      }
      expect(deps.written.filter((entry) => entry.id === 'dst-node')).toHaveLength(100)
      timestamp += 1001
      deps.emit({ id: 'src-node', type: 'data', data: 'recovered\n' })
      expect(deps.written.filter((entry) => entry.id === 'dst-node')).toHaveLength(101)
    } finally {
      uninstall()
      __setPipeClock(() => Date.now())
    }
  })

  it('clears bidirectionally so a dead destination leaves no hanging cable', () => {
    const deps = createDeps()
    const uninstall = installPtyPipe(deps)
    try {
      setPipe('src-node', 'dst-node')
      setPipe('third-node', 'dst-node')
      // Destino removido enquanto a origem permanece viva.
      expect(clearPipesFor('dst-node')).toBe(2)
      expect(listPipes()).toEqual([])
      deps.emit({ id: 'src-node', type: 'data', data: 'lost\n' })
      deps.emit({ id: 'third-node', type: 'data', data: 'lost\n' })
      expect(deps.written).toHaveLength(0)
      // Origem removida também limpa suas saídas.
      setPipe('src-node', 'dst-node')
      expect(clearPipesFor('src-node')).toBe(1)
      expect(listPipes()).toEqual([])
    } finally {
      uninstall()
    }
  })

  it('clearPipe removes every edge leaving a source', () => {
    setPipe('src-node', 'dst-node')
    setPipe('src-node', 'third-node')
    expect(clearPipe('src-node')).toBe(2)
    expect(listPipes()).toEqual([])
    expect(clearPipe('src-node')).toBe(0)
  })

  it('limpar A mantém C->A: só arestas que saem de A são removidas', () => {
    setPipe('src-node', 'dst-node')
    setPipe('third-node', 'src-node')
    expect(clearPipe('src-node')).toBe(1)
    expect(listPipes()).toEqual([{ from: 'third-node', to: 'src-node' }])
  })
})
