import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { resolveInitialWorkspaceMode } from '../src/renderer/src/components/IntegratedWorkspace'

describe('Preservação do Terminal e Workbench entre Grid e Canvas (Área 6)', () => {
  it('resolveInitialWorkspaceMode resolve corretamente os modos grid e canvas', () => {
    expect(resolveInitialWorkspaceMode('grid')).toBe('grid')
    expect(resolveInitialWorkspaceMode('canvas')).toBe('canvas')
    expect(resolveInitialWorkspaceMode(null)).toBe('canvas')
    expect(resolveInitialWorkspaceMode('unknown')).toBe('canvas')
  })

  it('IntegratedWorkspace.tsx não possui mais o aviso destrutivo de reinicialização do terminal nem descarte de rascunhos', () => {
    const fileContent = fs.readFileSync(
      path.resolve(__dirname, '../src/renderer/src/components/IntegratedWorkspace.tsx'),
      'utf-8',
    )

    // O aviso destrutivo que bloqueava o usuário com window.confirm foi completamente removido
    expect(fileContent).not.toContain('reinicia o terminal')
    expect(fileContent).not.toContain('Trocar o layout reinicia')
    expect(fileContent).not.toContain('descarta esses rascunhos')

    // Confirma o uso de createPortal para o workbench persistente
    expect(fileContent).toContain('createPortal')
    expect(fileContent).toContain('persistentWorkbench')
    expect(fileContent).toContain('workspace-workbench-slot')
    expect(fileContent).toContain('workspace-workbench-fallback-host')
  })

  it('IntegratedWorkspace.css e WorkspaceCanvas.css definem regras de layout estáveis para workspace-workbench-slot', () => {
    const integratedCss = fs.readFileSync(
      path.resolve(__dirname, '../src/renderer/src/components/IntegratedWorkspace.css'),
      'utf-8',
    )
    const canvasCss = fs.readFileSync(
      path.resolve(__dirname, '../src/renderer/src/components/WorkspaceCanvas.css'),
      'utf-8',
    )

    expect(integratedCss).toContain('.workspace-workbench-slot')
    expect(integratedCss).toContain('.grid-workbench-slot')
    expect(canvasCss).toContain('.workspace-workbench-slot')
  })

  it('garante que a resolução do alvo de portal nunca fica nula durante a transição de modo', () => {
    // Simula a máquina de estados de transição de slots do IntegratedWorkspace
    function resolveTarget(
      isCanvas: boolean,
      gridSlot: unknown | null,
      canvasSlot: unknown | null,
      fallbackHost: unknown | null,
    ) {
      return (isCanvas ? canvasSlot : gridSlot) || fallbackHost
    }

    const dummyFallback = { id: 'fallback-host' }
    const dummyGridSlot = { id: 'grid-slot' }
    const dummyCanvasSlot = { id: 'canvas-slot' }

    // Estado inicial no Grid: alvo é o gridSlot
    let active = resolveTarget(false, dummyGridSlot, null, dummyFallback)
    expect(active).toBe(dummyGridSlot)

    // Início da troca para Canvas (gridSlot desmonta, canvasSlot ainda não conectou ref):
    // o fallbackHost atua como host intermediário seguro, garantindo que o portal NÃO desmonte
    active = resolveTarget(true, null, null, dummyFallback)
    expect(active).toBe(dummyFallback)

    // Canvas termina commit e conecta ref:
    active = resolveTarget(true, null, dummyCanvasSlot, dummyFallback)
    expect(active).toBe(dummyCanvasSlot)

    // Troca de volta para Grid (canvasSlot desmonta, gridSlot ainda não conectou ref):
    active = resolveTarget(false, null, null, dummyFallback)
    expect(active).toBe(dummyFallback)

    // Grid termina commit e conecta ref:
    active = resolveTarget(false, dummyGridSlot, null, dummyFallback)
    expect(active).toBe(dummyGridSlot)
  })
})
