import electron, { type BrowserWindow, type Rectangle, type View, type WebContentsView } from 'electron'
import { validateHttpsUrl } from './validation'

const { View: ViewConstructor, WebContentsView: WebContentsViewConstructor, session } = electron
const DEFAULT_WEB_URL = 'https://www.google.com/'

export interface WebPanelEvent {
  type: 'loading' | 'loaded' | 'navigated' | 'error' | 'palette-shortcut'
  url: string
  title?: string
  message?: string
}

export interface WebPanelBounds extends Rectangle {
  contentX?: number
  contentY?: number
  contentWidth?: number
  contentHeight?: number
}

let hostWindow: BrowserWindow | null = null
let webView: WebContentsView | null = null
let clipView: View | null = null
let lastBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
let lastContentBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
let lastUrl = DEFAULT_WEB_URL
let lastTitle = 'Navegador'
const listeners = new Set<(event: WebPanelEvent) => void>()

// O WebContentsView nativo consome o teclado quando focado: a página recebe
// Ctrl/Cmd+K e o listener global do renderer (App) nunca dispara. Este
// handler encaminha o atalho via webEvent sem navegar, recarregar ou tocar na
// sessão — só emite para o renderer abrir o Command Center.
interface BeforeInputEvent {
  preventDefault: () => void
}

interface BeforeInputDetail {
  type?: string
  key?: string
  control?: boolean
  meta?: boolean
}

function shortcutHandler(event: BeforeInputEvent, input: BeforeInputDetail): void {
  if (input?.type && input.type !== 'keyDown') return
  if (typeof input?.key !== 'string' || input.key.toLowerCase() !== 'k') return
  if (!input.control && !input.meta) return
  event.preventDefault()
  const state = currentState()
  emit({ type: 'palette-shortcut', url: state.url, title: state.title })
}

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

function applyNativeBounds(): void {
  if (!webView || !clipView) return
  clipView.setBounds(lastBounds)
  webView.setBounds({
    x: Math.round(lastContentBounds.x - lastBounds.x),
    y: Math.round(lastContentBounds.y - lastBounds.y),
    width: Math.max(0, Math.round(lastContentBounds.width)),
    height: Math.max(0, Math.round(lastContentBounds.height)),
  })
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
  clipView = new ViewConstructor()
  webView.setVisible(false)
  clipView.setVisible(false)
  applyNativeBounds()
  clipView.addChildView(webView)
  window.contentView.addChildView(clipView)

  webView.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void navigateWeb(validateHttpsUrl(url))
    } catch {
      // Keep popups denied when the target is not a valid HTTPS URL.
    }
    return { action: 'deny' }
  })
  webView.webContents.on('will-navigate', (event, url) => {
    try { validateHttpsUrl(url) } catch { event.preventDefault() }
  })
  webView.webContents.on('will-redirect', (event, url) => {
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
  webView.webContents.on('before-input-event', shortcutHandler)
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

export function goBackWeb(): { success: boolean } {
  if (!webView?.webContents.canGoBack()) return { success: false }
  webView.webContents.goBack()
  return { success: true }
}

export function goForwardWeb(): { success: boolean } {
  if (!webView?.webContents.canGoForward()) return { success: false }
  webView.webContents.goForward()
  return { success: true }
}

export function reloadWeb(): { success: boolean } {
  if (!webView) return { success: false }
  webView.webContents.reload()
  return { success: true }
}

export function setWebBounds(bounds: WebPanelBounds): void {
  lastBounds = {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  }
  lastContentBounds = {
    x: Math.round(bounds.contentX ?? lastBounds.x),
    y: Math.round(bounds.contentY ?? lastBounds.y),
    width: Math.max(0, Math.round(bounds.contentWidth ?? lastBounds.width)),
    height: Math.max(0, Math.round(bounds.contentHeight ?? lastBounds.height)),
  }
  applyNativeBounds()
  clipView?.setVisible(lastBounds.width > 0 && lastBounds.height > 0)
  webView?.setVisible(lastBounds.width > 0 && lastBounds.height > 0)
}

export function setWebVisible(visible: boolean): void {
  const nextVisible = visible && lastBounds.width > 0 && lastBounds.height > 0
  clipView?.setVisible(nextVisible)
  webView?.setVisible(nextVisible)
}

export function getWebState(): WebPanelEvent {
  return currentState()
}

export function disposeWebPanel(): void {
  if (hostWindow && clipView) hostWindow.contentView.removeChildView(clipView)
  if (clipView && webView) clipView.removeChildView(webView)
  if (webView && !webView.webContents.isDestroyed()) {
    webView.webContents.removeListener?.('before-input-event', shortcutHandler)
    webView.webContents.close({ waitForBeforeUnload: false })
  }
  webView = null
  clipView = null
  hostWindow = null
}
