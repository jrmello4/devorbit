import type { BrowserWindow } from 'electron'
import { attachWebPanel, disposeWebPanel, getWebState, goBackWeb, goForwardWeb, navigateWeb, reloadWeb, setWebBounds, setWebVisible } from '../web-panel'
import { validateFiniteNumber } from '../validation'
import type { IpcRegistrar } from './registrar'

export interface WebIpcDependencies {
  getWindow: () => BrowserWindow | null
}

export function registerWebIpc(register: IpcRegistrar, dependencies: WebIpcDependencies): void {
  register('devorbit:navigateWeb', async (_event, url: unknown) => {
    if (typeof url !== 'string') throw new Error('URL inválida.')
    return await navigateWeb(url)
  })

  register('devorbit:getWebState', () => getWebState())
  register('devorbit:goBackWeb', () => goBackWeb())
  register('devorbit:goForwardWeb', () => goForwardWeb())
  register('devorbit:reloadWeb', () => reloadWeb())

  register('devorbit:disposeWebPanel', () => {
    disposeWebPanel()
    return { success: true }
  })

  register('devorbit:setWebVisible', (_event, visible: unknown) => {
    if (typeof visible !== 'boolean') throw new Error('Visibilidade inválida.')
    const window = dependencies.getWindow()
    if (visible && window) attachWebPanel(window)
    setWebVisible(visible)
    return { success: true }
  })

  register('devorbit:setWebBounds', (_event, rawBounds: unknown) => {
    if (!rawBounds || typeof rawBounds !== 'object') throw new Error('Dimensões do navegador inválidas.')
    const value = rawBounds as Record<string, unknown>
    const safeBounds = {
      x: validateFiniteNumber(value.x, 'Posição horizontal'),
      y: validateFiniteNumber(value.y, 'Posição vertical'),
      width: validateFiniteNumber(value.width, 'Largura'),
      height: validateFiniteNumber(value.height, 'Altura'),
    }
    const contentKeys = ['contentX', 'contentY', 'contentWidth', 'contentHeight']
    const hasContentBounds = contentKeys.some((key) => value[key] !== undefined)
    const safeContentBounds = hasContentBounds
      ? {
          contentX: validateFiniteNumber(value.contentX, 'contentX'),
          contentY: validateFiniteNumber(value.contentY, 'contentY'),
          contentWidth: validateFiniteNumber(value.contentWidth, 'contentWidth'),
          contentHeight: validateFiniteNumber(value.contentHeight, 'contentHeight'),
        }
      : undefined
    const window = dependencies.getWindow()
    if ((safeBounds.width > 0 && safeBounds.height > 0) && window) attachWebPanel(window)
    setWebBounds({ ...safeBounds, ...(safeContentBounds || {}) })
    return { success: true }
  })
}
