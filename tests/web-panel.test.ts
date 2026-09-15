import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type WebContentsMock = {
  loadURL: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  getURL: ReturnType<typeof vi.fn>
  getTitle: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  canGoBack: ReturnType<typeof vi.fn>
  canGoForward: ReturnType<typeof vi.fn>
  goBack: ReturnType<typeof vi.fn>
  goForward: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
}

const state = vi.hoisted(() => ({
  view: undefined as any,
  clipView: undefined as any,
  session: undefined as any,
}))

vi.mock('electron', () => ({
  default: {
    View: vi.fn(function () {
      return state.clipView
    }),
    WebContentsView: vi.fn(function () {
      return state.view
    }),
    session: {
      fromPartition: vi.fn(() => state.session),
    },
  },
}))

import {
  attachWebPanel,
  disposeWebPanel,
  getWebState,
  navigateWeb,
  onWebPanelEvent,
  setWebBounds,
  setWebVisible,
} from '../src/main/web-panel'
import electron from 'electron'

function createFixture() {
  const handlers = new Map<string, (...args: any[]) => void>()
  const webContents: WebContentsMock = {
    loadURL: vi.fn(async (url: string) => {
      webContents.getURL.mockReturnValue(url)
    }),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler)
    }),
    getURL: vi.fn(() => ''),
    getTitle: vi.fn(() => 'Example'),
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
  }
  const view = {
    webContents,
    setVisible: vi.fn(),
    setBounds: vi.fn(),
  }
  const clipView = {
    setVisible: vi.fn(),
    setBounds: vi.fn(),
    addChildView: vi.fn(),
    removeChildView: vi.fn(),
  }
  const window = {
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
  }
  const session = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  }
  state.view = view
  state.clipView = clipView
  state.session = session
  return { handlers, webContents, view, clipView, window, session }
}

beforeEach(() => {
  disposeWebPanel()
})

afterEach(() => {
  disposeWebPanel()
})

describe('web panel', () => {
  it('creates a sandboxed, isolated view with denied permissions', () => {
    const fixture = createFixture()
    attachWebPanel(fixture.window as any)

    expect(fixture.session.setPermissionRequestHandler).toHaveBeenCalledWith(expect.any(Function))
    expect(fixture.session.setPermissionCheckHandler).toHaveBeenCalledWith(expect.any(Function))
    expect(fixture.view.setVisible).toHaveBeenCalledWith(false)
    expect(fixture.window.contentView.addChildView).toHaveBeenCalledWith(fixture.clipView)
    expect(fixture.clipView.addChildView).toHaveBeenCalledWith(fixture.view)
    expect(fixture.webContents.loadURL).toHaveBeenCalledWith('https://www.google.com/')

    expect(electron.WebContentsView).toHaveBeenCalledWith({
      webPreferences: expect.objectContaining({
        session: fixture.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
      }),
    })
  })

  it('validates HTTPS navigation case-insensitively and blocks unsafe URLs', async () => {
    const fixture = createFixture()
    attachWebPanel(fixture.window as any)
    fixture.webContents.loadURL.mockClear()

    await expect(navigateWeb('  HTTPS://Example.com/path  ')).resolves.toEqual({
      success: true,
      url: 'https://example.com/path',
    })
    expect(fixture.webContents.loadURL).toHaveBeenCalledWith('https://example.com/path')

    await expect(navigateWeb('http://example.com/')).resolves.toMatchObject({ success: false })
    expect(fixture.webContents.loadURL).toHaveBeenCalledTimes(1)

    const willNavigate = fixture.handlers.get('will-navigate')!
    const unsafeEvent = { preventDefault: vi.fn() }
    willNavigate(unsafeEvent, 'http://example.com/')
    expect(unsafeEvent.preventDefault).toHaveBeenCalledOnce()

    const willRedirect = fixture.handlers.get('will-redirect')!
    const unsafeRedirect = { preventDefault: vi.fn() }
    willRedirect(unsafeRedirect, 'http://example.com/redirect')
    expect(unsafeRedirect.preventDefault).toHaveBeenCalledOnce()
  })

  it('clamps bounds and ties visibility to non-empty dimensions', () => {
    const fixture = createFixture()
    attachWebPanel(fixture.window as any)
    fixture.view.setBounds.mockClear()
    fixture.clipView.setBounds.mockClear()
    fixture.view.setVisible.mockClear()
    fixture.clipView.setVisible.mockClear()

    setWebBounds({ x: -2, y: 1.4, width: 640.2, height: -5 })
    expect(fixture.clipView.setBounds).toHaveBeenCalledWith({ x: 0, y: 1, width: 640, height: 0 })
    expect(fixture.view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 640, height: 0 })
    expect(fixture.view.setVisible).toHaveBeenCalledWith(false)

    setWebVisible(true)
    expect(fixture.view.setVisible).toHaveBeenLastCalledWith(false)
    setWebBounds({ x: 2, y: 3, width: 640, height: 480 })
    setWebVisible(true)
    expect(fixture.view.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('keeps the full page viewport while the native clip follows the visible card', () => {
    const fixture = createFixture()
    attachWebPanel(fixture.window as any)
    fixture.view.setBounds.mockClear()
    fixture.clipView.setBounds.mockClear()

    setWebBounds({
      x: 100,
      y: 120,
      width: 200,
      height: 150,
      contentX: 80,
      contentY: 90,
      contentWidth: 320,
      contentHeight: 240,
    })

    expect(fixture.clipView.setBounds).toHaveBeenCalledWith({ x: 100, y: 120, width: 200, height: 150 })
    expect(fixture.view.setBounds).toHaveBeenCalledWith({ x: -20, y: -30, width: 320, height: 240 })
  })

  it('emits lifecycle events and disposes the attached view', () => {
    const fixture = createFixture()
    const listener = vi.fn()
    const unsubscribe = onWebPanelEvent(listener)
    attachWebPanel(fixture.window as any)

    fixture.handlers.get('did-start-loading')!()
    fixture.handlers.get('did-finish-load')!()
    fixture.handlers.get('did-navigate')!({}, 'https://example.com/page')
    fixture.handlers.get('did-fail-load')!({}, -2, 'offline', 'https://example.com/page')
    expect(listener.mock.calls.map(([event]) => event.type)).toEqual([
      'loading', 'loaded', 'navigated', 'error',
    ])

    unsubscribe()
    disposeWebPanel()
    expect(fixture.window.contentView.removeChildView).toHaveBeenCalledWith(fixture.clipView)
    expect(fixture.clipView.removeChildView).toHaveBeenCalledWith(fixture.view)
    expect(fixture.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
    expect(getWebState()).toMatchObject({ type: 'navigated', url: 'https://example.com/page' })
  })

  it('denies every popup and routes valid HTTPS targets through navigation', async () => {
    const fixture = createFixture()
    attachWebPanel(fixture.window as any)
    fixture.webContents.loadURL.mockClear()
    const handler = fixture.webContents.setWindowOpenHandler.mock.calls[0][0]

    expect(handler({ url: 'HTTPS://Example.com/popup' })).toEqual({ action: 'deny' })
    await vi.waitFor(() => expect(fixture.webContents.loadURL).toHaveBeenCalledWith('https://example.com/popup'))

    fixture.webContents.loadURL.mockClear()
    expect(handler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
    await Promise.resolve()
    expect(fixture.webContents.loadURL).not.toHaveBeenCalled()
  })
})
