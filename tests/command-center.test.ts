import { describe, expect, it } from 'vitest'
import {
  detectPrefixQuery,
  matchTwoStroke,
  parseSpacedTwoStroke,
  rankWithFocusedContext,
  resolvePaletteToggle,
} from '../src/renderer/src/components/command-center-helpers'
import { resolveInitialWorkspaceMode } from '../src/renderer/src/components/IntegratedWorkspace'

describe('command center two-stroke', () => {
  it('mapeia G + tecla para rotas', () => {
    expect(matchTwoStroke('g', 'p')?.action).toBe('nav-projects')
    expect(matchTwoStroke('g', 'c')?.action).toBe('nav-canvas')
    expect(matchTwoStroke('g', 't')?.action).toBe('nav-terminal')
    expect(matchTwoStroke('g', 'g')?.action).toBe('nav-git')
    expect(matchTwoStroke('g', 'm')?.action).toBe('nav-memory')
    expect(matchTwoStroke('g', 's')?.action).toBe('nav-settings')
  })

  it('mapeia C + tecla para criação', () => {
    expect(matchTwoStroke('c', 't')?.action).toBe('create-agent-terminal')
    expect(matchTwoStroke('c', 's')?.action).toBe('create-squad')
    expect(matchTwoStroke('c', 'n')?.action).toBe('create-note')
    expect(matchTwoStroke('c', 'b')?.action).toBe('create-branch')
    expect(matchTwoStroke('c', 'p')?.action).toBe('create-project')
  })

  it('rejeita prefixo ou tecla inválidos', () => {
    expect(matchTwoStroke(null, 'p')).toBeNull()
    expect(matchTwoStroke('g', 'z')).toBeNull()
    expect(matchTwoStroke('g', 'Enter')).toBeNull()
    expect(detectPrefixQuery('g')).toBe('g')
    expect(detectPrefixQuery('projeto')).toBeNull()
    expect(parseSpacedTwoStroke('g p')?.action).toBe('nav-projects')
    expect(parseSpacedTwoStroke('c s')?.action).toBe('create-squad')
    expect(parseSpacedTwoStroke('c n')?.action).toBe('create-note')
    expect(parseSpacedTwoStroke('busca livre')).toBeNull()
  })

  it('prioriza o nó em foco na busca adaptativa', () => {
    const items = [
      { label: 'Outro projeto', description: '/tmp/outro' },
      { label: 'Handoff do coordenador', description: 'plano da tarefa' },
    ]
    const ranked = rankWithFocusedContext(items, 'plano', { id: 'n1', title: 'Handoff do coordenador', kind: 'note' })
    expect(ranked[0].label).toBe('Handoff do coordenador')
  })
})

describe('palette global sem encerrar agentes', () => {
  it('alterna sem fechar quando aberta e ignora com modal bloqueante', () => {
    expect(resolvePaletteToggle({ paletteOpen: true, settingsOpen: false, toolHealthOpen: false, authOpen: false, memoryOpen: false, updateModalOpen: false })).toBe('close')
    expect(resolvePaletteToggle({ paletteOpen: false, settingsOpen: true, toolHealthOpen: false, authOpen: false, memoryOpen: false, updateModalOpen: false })).toBe('ignore')
    expect(resolvePaletteToggle({ paletteOpen: false, settingsOpen: false, toolHealthOpen: false, authOpen: false, memoryOpen: false, updateModalOpen: false })).toBe('open')
  })
})

describe('canvas unificado', () => {
  it('abre o projeto direto no canvas por padrão', () => {
    expect(resolveInitialWorkspaceMode(null)).toBe('canvas')
    expect(resolveInitialWorkspaceMode('canvas')).toBe('canvas')
    expect(resolveInitialWorkspaceMode('grid')).toBe('grid')
  })
})
