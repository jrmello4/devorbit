import { describe, expect, it } from 'vitest'
import {
  applyWorkspaceUiRequest,
  buildPendingCanvasNode,
  buildWorkspaceUiRequest,
  computeWebSuppressed,
  isPendingNodeForProject,
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
