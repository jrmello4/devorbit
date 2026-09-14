import electron, { type BrowserWindow, type Rectangle, type WebContentsView } from 'electron'
import { validateHttpsUrl } from './validation'

const { WebContentsView: WebContentsViewConstructor, session } = electron
const DEFAULT_WEB_URL = 'https://www.google.com/'

export interface WebPanelEvent {
  type: 'loading' | 'loaded' | 'navigated' | 'error'
  url: string
  title?: string
  message?: string
}

let hostWindow: BrowserWindow | null = null
let webView: WebContentsView | null = null
let lastBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
let lastUrl = DEFAULT_WEB_URL
let lastTitle = 'Navegador'
const listeners = new Set<(event: WebPanelEvent) => void>()

function emit(event: WebPanelEvent): void {
  for (const listener of listeners) listener(event)
}

function currentState(): WebPanelEvent {
  return {
    type: 'navigated',
    url: webView?.webContents.getURL() || lastUrl,
    title: webView?.webContents.getTitle() || lastTitle,
  }
}

export function onWebPanelEvent(listener: (event: WebPanelEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function attachWebPanel(window: BrowserWindow): void {
  if (hostWindow === window && webView) return
  disposeWebPanel()
  hostWindow = window
  const webSession = session.fromPartition('persist:devorbit-web')
  webSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  webSession.setPermissionCheckHandler(() => false)
  webView = new WebContentsViewConstructor({
    webPreferences: {
      session: webSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
  })
  webView.setVisible(false)
  webView.setBounds(lastBounds)
  window.contentView.addChildView(webView)

  webView.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void navigateWeb(url)
    return { action: 'deny' }
  })
  webView.webContents.on('will-navigate', (event, url) => {
    try { validateHttpsUrl(url) } catch { event.preventDefault() }
  })
  webView.webContents.on('did-start-loading', () => emit({ ...currentState(), type: 'loading' }))
  webView.webContents.on('did-finish-load', () => emit({ ...currentState(), type: 'loaded' }))
  webView.webContents.on('did-navigate', (_event, url) => {
    lastUrl = url
    lastTitle = webView?.webContents.getTitle() || lastTitle
    emit({ type: 'navigated', url, title: lastTitle })
  })
  webView.webContents.on('did-navigate-in-page', (_event, url) => {
    lastUrl = url
    lastTitle = webView?.webContents.getTitle() || lastTitle
    emit({ type: 'navigated', url, title: lastTitle })
  })
  webView.webContents.on('did-fail-load', (_event, code, description, url) => {
    if (code === -3) return
    emit({ type: 'error', url, message: description })
  })
  void webView.webContents.loadURL(lastUrl)
}

export async function navigateWeb(url: string): Promise<{ success: boolean; url?: string; message?: string }> {
  if (!webView) return { success: false, message: 'O navegador interno ainda não está pronto.' }
  try {
    const safeUrl = validateHttpsUrl(url)
    await webView.webContents.loadURL(safeUrl)
    return { success: true, url: safeUrl }
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export function setWebBounds(bounds: Rectangle): void {
  if (!webView) return
  lastBounds = {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  }
  webView.setBounds(lastBounds)
  webView.setVisible(lastBounds.width > 0 && lastBounds.height > 0)
}

export function setWebVisible(visible: boolean): void {
  webView?.setVisible(visible && lastBounds.width > 0 && lastBounds.height > 0)
}

export function getWebState(): WebPanelEvent {
  return currentState()
}

export function disposeWebPanel(): void {
  if (hostWindow && webView) hostWindow.contentView.removeChildView(webView)
  if (webView && !webView.webContents.isDestroyed()) webView.webContents.close({ waitForBeforeUnload: false })
  webView = null
  hostWindow = null
}