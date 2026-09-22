import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CANVAS_BOUNDS,
  handleCanvasCardKeyboardAction,
  moveNodeByKeyboard,
  resizeNodeByKeyboard,
  snapToGrid,
} from '../src/renderer/src/components/canvas-keyboard-helpers'

describe('canvas-keyboard-helpers — Operação por teclado no Canvas', () => {
  const baseNode = {
    id: 'node-1',
    x: 100,
    y: 100,
    width: 300,
    height: 200,
  }

  describe('snapToGrid', () => {
    it('alinha valores para o múltiplo mais próximo de 20', () => {
      expect(snapToGrid(21)).toBe(20)
      expect(snapToGrid(29)).toBe(20)
      expect(snapToGrid(30)).toBe(40)
      expect(snapToGrid(0)).toBe(0)
    })
  })

  describe('moveNodeByKeyboard', () => {
    it('move para a direita e esquerda por passo de grid', () => {
      const movedRight = moveNodeByKeyboard(baseNode, 'right', 20)
      expect(movedRight.x).toBe(120)
      expect(movedRight.y).toBe(100)

      const movedLeft = moveNodeByKeyboard(baseNode, 'left', 20)
      expect(movedLeft.x).toBe(80)
      expect(movedLeft.y).toBe(100)
    })

    it('move para cima e para baixo por passo de grid', () => {
      const movedDown = moveNodeByKeyboard(baseNode, 'down', 20)
      expect(movedDown.x).toBe(100)
      expect(movedDown.y).toBe(120)

      const movedUp = moveNodeByKeyboard(baseNode, 'up', 20)
      expect(movedUp.x).toBe(100)
      expect(movedUp.y).toBe(80)
    })

    it('respeita os limites do mundo (não ultrapassa 0 nem maxX)', () => {
      const nearZero = { ...baseNode, x: 10, y: 10 }
      const clampedZero = moveNodeByKeyboard(nearZero, 'left', 40)
      expect(clampedZero.x).toBe(0)

      const nearEdge = { ...baseNode, x: DEFAULT_CANVAS_BOUNDS.worldWidth - 310 }
      const clampedEdge = moveNodeByKeyboard(nearEdge, 'right', 40)
      expect(clampedEdge.x).toBe(DEFAULT_CANVAS_BOUNDS.worldWidth - baseNode.width)
    })
  })

  describe('resizeNodeByKeyboard', () => {
    it('expande e reduz dimensões respeitando limites mínimos e máximos', () => {
      const grown = resizeNodeByKeyboard(baseNode, 'grow-x', 40)
      expect(grown.width).toBe(340)

      const shrunk = resizeNodeByKeyboard(baseNode, 'shrink-x', 40)
      expect(shrunk.width).toBe(260)

      // Teste limite mínimo (220)
      const nearMin = { ...baseNode, width: 230 }
      const minReached = resizeNodeByKeyboard(nearMin, 'shrink-x', 40)
      expect(minReached.width).toBe(220)

      // Teste limite máximo (1100)
      const nearMax = { ...baseNode, width: 1090 }
      const maxReached = resizeNodeByKeyboard(nearMax, 'grow-x', 40)
      expect(maxReached.width).toBe(1100)
    })
  })

  describe('handleCanvasCardKeyboardAction', () => {
    it('trata Setas normais para movimentação', () => {
      const result = handleCanvasCardKeyboardAction({ key: 'ArrowRight' }, baseNode)
      expect(result).not.toBeNull()
      expect(result?.action).toBe('move')
      expect(result?.updated.x).toBe(120)
    })

    it('trata Shift + Setas para movimentação ampliada (100px)', () => {
      const result = handleCanvasCardKeyboardAction({ key: 'ArrowDown', shiftKey: true }, baseNode)
      expect(result).not.toBeNull()
      expect(result?.action).toBe('move')
      expect(result?.updated.y).toBe(200)
    })

    it('trata Alt + Setas para redimensionamento', () => {
      const result = handleCanvasCardKeyboardAction({ key: 'ArrowRight', altKey: true }, baseNode)
      expect(result).not.toBeNull()
      expect(result?.action).toBe('resize')
      expect(result?.updated.width).toBe(320)
    })

    it('ignora teclas não relacionadas como Tab ou Enter', () => {
      expect(handleCanvasCardKeyboardAction({ key: 'Enter' }, baseNode)).toBeNull()
      expect(handleCanvasCardKeyboardAction({ key: 'Tab' }, baseNode)).toBeNull()
    })
  })
})
