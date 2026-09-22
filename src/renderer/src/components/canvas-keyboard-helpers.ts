/**
 * Helpers para manipulação e navegação por teclado no Canvas do DevOrbit.
 * Permite mover e redimensionar nós focados respeitando grid, limites mínimos/máximos
 * e dimensões do mundo.
 */

export interface CanvasBoundsConfig {
  worldWidth: number
  worldHeight: number
  grid: number
  minWidth: number
  maxWidth: number
  minHeight: number
  maxHeight: number
}

export const DEFAULT_CANVAS_BOUNDS: CanvasBoundsConfig = {
  worldWidth: 5200,
  worldHeight: 3400,
  grid: 20,
  minWidth: 220,
  maxWidth: 1100,
  minHeight: 150,
  maxHeight: 850,
}

export function snapToGrid(value: number, grid = DEFAULT_CANVAS_BOUNDS.grid): number {
  return Math.round(value / grid) * grid
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export type KeyboardMoveDirection = 'up' | 'down' | 'left' | 'right'
export type KeyboardResizeDirection = 'grow-x' | 'shrink-x' | 'grow-y' | 'shrink-y'

/**
 * Move um nó usando teclado respeitando grid e limites do mundo.
 */
export function moveNodeByKeyboard<T extends { x: number; y: number; width: number; height: number }>(
  node: T,
  direction: KeyboardMoveDirection,
  step = DEFAULT_CANVAS_BOUNDS.grid,
  bounds = DEFAULT_CANVAS_BOUNDS,
): T {
  let nextX = node.x
  let nextY = node.y
  switch (direction) {
    case 'left':
      nextX = snapToGrid(node.x - step, bounds.grid)
      break
    case 'right':
      nextX = snapToGrid(node.x + step, bounds.grid)
      break
    case 'up':
      nextY = snapToGrid(node.y - step, bounds.grid)
      break
    case 'down':
      nextY = snapToGrid(node.y + step, bounds.grid)
      break
  }
  const maxX = Math.max(0, bounds.worldWidth - node.width)
  const maxY = Math.max(0, bounds.worldHeight - node.height)
  return {
    ...node,
    x: clamp(nextX, 0, maxX),
    y: clamp(nextY, 0, maxY),
  }
}

/**
 * Redimensiona um nó usando teclado respeitando min/max e limites do mundo.
 */
export function resizeNodeByKeyboard<T extends { x: number; y: number; width: number; height: number }>(
  node: T,
  direction: KeyboardResizeDirection,
  step = DEFAULT_CANVAS_BOUNDS.grid,
  bounds = DEFAULT_CANVAS_BOUNDS,
): T {
  let nextWidth = node.width
  let nextHeight = node.height
  switch (direction) {
    case 'shrink-x':
      nextWidth = snapToGrid(node.width - step, bounds.grid)
      break
    case 'grow-x':
      nextWidth = snapToGrid(node.width + step, bounds.grid)
      break
    case 'shrink-y':
      nextHeight = snapToGrid(node.height - step, bounds.grid)
      break
    case 'grow-y':
      nextHeight = snapToGrid(node.height + step, bounds.grid)
      break
  }
  const maxWidthAllowed = Math.min(bounds.maxWidth, bounds.worldWidth - node.x)
  const maxHeightAllowed = Math.min(bounds.maxHeight, bounds.worldHeight - node.y)
  return {
    ...node,
    width: clamp(nextWidth, bounds.minWidth, maxWidthAllowed),
    height: clamp(nextHeight, bounds.minHeight, maxHeightAllowed),
  }
}

export interface KeyboardCanvasEventOptions {
  key: string
  shiftKey?: boolean
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}

/**
 * Interpreta eventos de teclado em cartões focados do canvas.
 * - Setas: move pelo grid (20px)
 * - Shift + Setas: move 100px (5 grids)
 * - Alt + Setas: redimensiona cartão em 20px
 * - Shift + Alt + Setas: redimensiona cartão em 60px
 * Retorna o nó modificado se o atalho foi tratado, ou null se não aplicável.
 */
export function handleCanvasCardKeyboardAction<T extends { x: number; y: number; width: number; height: number }>(
  event: KeyboardCanvasEventOptions,
  node: T,
  bounds = DEFAULT_CANVAS_BOUNDS,
): { updated: T; action: 'move' | 'resize' } | null {
  const isArrow = event.key.startsWith('Arrow')
  if (!isArrow) return null

  // Redimensionamento via Alt + Setas
  if (event.altKey) {
    const step = event.shiftKey ? bounds.grid * 3 : bounds.grid
    let resizeDir: KeyboardResizeDirection | null = null
    if (event.key === 'ArrowRight') resizeDir = 'grow-x'
    else if (event.key === 'ArrowLeft') resizeDir = 'shrink-x'
    else if (event.key === 'ArrowDown') resizeDir = 'grow-y'
    else if (event.key === 'ArrowUp') resizeDir = 'shrink-y'

    if (resizeDir) {
      return {
        updated: resizeNodeByKeyboard(node, resizeDir, step, bounds),
        action: 'resize',
      }
    }
  }

  // Movimentação via Setas normais (ou Shift + Setas)
  if (!event.ctrlKey && !event.metaKey) {
    const step = event.shiftKey ? bounds.grid * 5 : bounds.grid
    let moveDir: KeyboardMoveDirection | null = null
    if (event.key === 'ArrowLeft') moveDir = 'left'
    else if (event.key === 'ArrowRight') moveDir = 'right'
    else if (event.key === 'ArrowUp') moveDir = 'up'
    else if (event.key === 'ArrowDown') moveDir = 'down'

    if (moveDir) {
      return {
        updated: moveNodeByKeyboard(node, moveDir, step, bounds),
        action: 'move',
      }
    }
  }

  return null
}
