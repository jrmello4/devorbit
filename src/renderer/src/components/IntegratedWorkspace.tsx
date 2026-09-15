import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle, ArrowLeft, ArrowRight, Check, Code2, Globe, GripVertical,
  RefreshCw, Send, Terminal, X,
} from 'lucide-react'
import type { Project, WebPanelEvent } from '../types'
import { WorkspaceEditor, type WorkspaceEditorContext } from './WorkspaceEditor'
import { WorkspaceTerminal } from './WorkspaceTerminal'
import { WorkspaceCanvas } from './WorkspaceCanvas'
import './IntegratedWorkspace.css'

interface IntegratedWorkspaceProps {
  project: Project
  onClose: () => void
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void
  codexAccount?: 'account1' | 'account2'
  isWebSuppressed?: boolean
  isSuspended?: boolean
  onRequestCodexAuth?: (account: 'account1' | 'account2') => void
  onDirtyChange?: (dirty: boolean) => void
}
interface WorkspaceLayout {
  rightWidth: number
  terminalHeight: number
  terminalVisible: boolean
  webVisible: boolean
}
interface WebHistory {
  entries: Array<{ url: string; title: string }>
  index: number
}

const DEFAULT_LAYOUT: WorkspaceLayout = {
  rightWidth: 390, terminalHeight: 220, terminalVisible: true, webVisible: true,
}
const MIN_RIGHT_WIDTH = 300
const MAX_RIGHT_WIDTH = 680
const MIN_TERMINAL_HEIGHT = 150
const MAX_TERMINAL_HEIGHT = 420

function layoutKey(id: string): string {
  return 'devorbit:workspace-layout:' + id
}
function readLayout(id: string): WorkspaceLayout {
  try {
    const raw = window.localStorage.getItem(layoutKey(id))
    if (!raw) return DEFAULT_LAYOUT
    const parsed = JSON.parse(raw) as Partial<WorkspaceLayout>
    return {
      rightWidth: Number.isFinite(parsed.rightWidth)
        ? Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, parsed.rightWidth as number))
        : DEFAULT_LAYOUT.rightWidth,
      terminalHeight: Number.isFinite(parsed.terminalHeight)
        ? Math.min(MAX_TERMINAL_HEIGHT, Math.max(MIN_TERMINAL_HEIGHT, parsed.terminalHeight as number))
        : DEFAULT_LAYOUT.terminalHeight,
      terminalVisible: parsed.terminalVisible !== false,
      webVisible: parsed.webVisible !== false,
    }
  } catch {
    return DEFAULT_LAYOUT
  }
}

export const IntegratedWorkspace: React.FC<IntegratedWorkspaceProps> = ({
  project, onClose, onNotify, codexAccount = 'account1', isWebSuppressed = false, isSuspended = false, onRequestCodexAuth, onDirtyChange,
}) => {
  const [webUrl, setWebUrl] = useState('https://www.google.com/')
  const [webTitle, setWebTitle] = useState('Navegador')
  const [webLoading, setWebLoading] = useState(false)
  const [webError, setWebError] = useState('')
  const [webHistory, setWebHistory] = useState<WebHistory>({
    entries: [{ url: 'https://www.google.com/', title: 'Navegador' }], index: 0,
  })
  const [editorContext, setEditorContext] = useState<WorkspaceEditorContext | null>(null)
  const [isEditorDirty, setIsEditorDirty] = useState(false)
  const suppressNativeWeb = isWebSuppressed || isSuspended
  const [layout, setLayout] = useState<WorkspaceLayout>(() => readLayout(project.id))
  const [isCanvas, setIsCanvas] = useState(() => window.localStorage.getItem('devorbit:workspace-mode:' + project.id) === 'canvas')
  const [dragging, setDragging] = useState<'browser' | 'terminal' | null>(null)
  const terminalId = useMemo(
    () => 'workspace-' + project.id.replace(/[^a-z0-9_-]/gi, '-').slice(0, 48),
    [project.id],
  )
  const webViewportRef = useRef<HTMLDivElement>(null)
  const restoreWebOnActivateRef = useRef(true)
  const requestedHistoryIndexRef = useRef<number | null>(null)
  const dragRef = useRef({
    startX: 0, startY: 0, rightWidth: layout.rightWidth, terminalHeight: layout.terminalHeight,
  })
  useEffect(() => {
    if (isSuspended) restoreWebOnActivateRef.current = true
  }, [isSuspended])

  useEffect(() => {
    // The BrowserView is a single native resource. Suspended tabs stay mounted
    // to preserve their editor state, but must not observe or control it.
    if (suppressNativeWeb) return
    const unsubscribe = window.devorbit.onWebEvent((event: WebPanelEvent) => {
      const nextUrl = event.url || 'https://www.google.com/'
      const nextTitle = event.title || 'Navegador'
      setWebUrl(nextUrl)
      setWebTitle(nextTitle)
      if (event.type === 'navigated') {
        setWebHistory((current) => {
          const requestedIndex = requestedHistoryIndexRef.current
          if (requestedIndex !== null && current.entries[requestedIndex]?.url === nextUrl) {
            requestedHistoryIndexRef.current = null
            return { ...current, index: requestedIndex }
          }
          if (current.entries[current.index]?.url === nextUrl) {
            const entries = [...current.entries]
            entries[current.index] = { url: nextUrl, title: nextTitle }
            return { ...current, entries }
          }
          const entries = [...current.entries.slice(0, current.index + 1), { url: nextUrl, title: nextTitle }]
          return { entries, index: entries.length - 1 }
        })
      }
      setWebLoading(event.type === 'loading')
      setWebError(event.type === 'error' ? event.message || 'Falha ao carregar esta página.' : '')
    })
    if (restoreWebOnActivateRef.current) {
      restoreWebOnActivateRef.current = false
      void window.devorbit.navigateWeb(webUrl).catch(() => undefined)
    }
    return unsubscribe
  }, [suppressNativeWeb])

  useEffect(() => {
    try { window.localStorage.setItem(layoutKey(project.id), JSON.stringify(layout)) } catch { /* opcional */ }
  }, [layout, project.id])

  useEffect(() => {
    try { window.localStorage.setItem('devorbit:workspace-mode:' + project.id, isCanvas ? 'canvas' : 'grid') } catch { /* opcional */ }
  }, [isCanvas, project.id])

  useEffect(() => {
    if (suppressNativeWeb) return
    const viewport = webViewportRef.current
    if (!viewport) return
    const updateBounds = () => {
      const rect = viewport.getBoundingClientRect()
      const visible = layout.webVisible && !suppressNativeWeb && rect.width > 0 && rect.height > 0
      void window.devorbit.setWebBounds({
        x: Math.round(rect.left), y: Math.round(rect.top),
        width: Math.round(rect.width), height: Math.round(rect.height),
      })
      void window.devorbit.setWebVisible(visible)
    }
    const observer = new ResizeObserver(updateBounds)
    observer.observe(viewport)
    updateBounds()
    window.addEventListener('resize', updateBounds)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateBounds)
      void window.devorbit.setWebVisible(false)
    }
  }, [suppressNativeWeb, layout.rightWidth, layout.webVisible])

  useEffect(() => {
    if (!dragging) return
    const handlePointerMove = (event: PointerEvent) => {
      if (dragging === 'browser') {
        const next = Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, dragRef.current.rightWidth - (event.clientX - dragRef.current.startX)))
        setLayout((current) => ({ ...current, rightWidth: next }))
      } else {
        const next = Math.min(MAX_TERMINAL_HEIGHT, Math.max(MIN_TERMINAL_HEIGHT, dragRef.current.terminalHeight - (event.clientY - dragRef.current.startY)))
        setLayout((current) => ({ ...current, terminalHeight: next }))
      }
    }
    const handlePointerUp = () => setDragging(null)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [dragging])

  const startDrag = (kind: 'browser' | 'terminal', event: React.PointerEvent) => {
    event.preventDefault()
    dragRef.current = {
      startX: event.clientX, startY: event.clientY,
      rightWidth: layout.rightWidth, terminalHeight: layout.terminalHeight,
    }
    setDragging(kind)
  }

  const sendContextToTerminal = async () => {
    const context = editorContext
    if (!context?.path) {
      onNotify('Abra um arquivo antes de enviar contexto ao terminal.', 'info')
      return
    }
    const body = (context.selection.trim() || context.content).slice(0, 12_000)
    const payload = [
      '',
      '[DevOrbit contexto]',
      'Arquivo: ' + context.path,
      'Pesquisa web: ' + webUrl,
      context.selection.trim() ? 'Seleção atual:' : 'Conteúdo atual:',
      body,
      '[/DevOrbit contexto]',
      '',
    ].join('\r\n')
    const result = await window.devorbit.writeTerminal(terminalId, payload)
    if (result.success) onNotify('Contexto do editor e da web enviado ao terminal.', 'success')
    else onNotify('O terminal interno não está pronto para receber contexto.', 'error')
  }

  const navigateBrowser = async (event: React.FormEvent) => {
    event.preventDefault()
    const raw = webUrl.trim()
    if (!raw) return
    const target = /^https:\/\//i.test(raw) ? raw : 'https://' + raw
    setWebLoading(true)
    setWebError('')
    const result = await window.devorbit.navigateWeb(target)
    if (!result.success) {
      setWebLoading(false)
      setWebError(result.message || 'URL não permitida.')
      onNotify(result.message || 'Não foi possível navegar para esta URL.', 'error')
    } else if (result.url) {
      setWebUrl(result.url)
      setWebHistory((current) => {
        if (current.entries[current.index]?.url === result.url) return current
        const entries = [...current.entries.slice(0, current.index + 1), { url: result.url as string, title: result.url as string }]
        return { entries, index: entries.length - 1 }
      })
    }
  }

  const moveWebHistory = async (direction: -1 | 1) => {
    const nextIndex = webHistory.index + direction
    const entry = webHistory.entries[nextIndex]
    if (!entry) return
    setWebLoading(true)
    requestedHistoryIndexRef.current = nextIndex
    const result = await window.devorbit.navigateWeb(entry.url)
    if (!result.success) {
      requestedHistoryIndexRef.current = null
      setWebLoading(false)
      onNotify(result.message || 'Não foi possível navegar no histórico.', 'error')
      return
    }
  }

  const closeWorkspace = () => {
    if (isEditorDirty && !window.confirm('Há alterações não salvas. Fechar o ambiente mesmo assim?')) return
    void window.devorbit.setWebVisible(false)
    void window.devorbit.disposeWebPanel()
    void window.devorbit.stopTerminal(terminalId)
    onClose()
  }

  const canvasWorkbench = (
    <div className="workspace-editor-stack">
      <WorkspaceEditor projectPath={project.path} onNotify={onNotify} onContextChange={setEditorContext} onDirtyChange={(dirty) => { setIsEditorDirty(dirty); onDirtyChange?.(dirty) }} />
      {layout.terminalVisible && <WorkspaceTerminal projectPath={project.path} terminalId={terminalId + '-c'} codexAccount={codexAccount} onNotify={onNotify} onRequestCodexAuth={onRequestCodexAuth} />}
    </div>
  )
  const canvasBrowser = (
    <aside className="workspace-browser-panel" aria-label="Pesquisa web">
      <div className="workspace-panel-heading browser-heading"><div><strong><Globe size={14} aria-hidden="true" /> Pesquisa web</strong><span title={webTitle}>{webTitle}</span></div><div className="browser-actions"><button type="button" className="workspace-icon-button" onClick={() => void moveWebHistory(-1)} disabled={webHistory.index === 0} aria-label="Voltar na pesquisa web" title="Voltar"><ArrowLeft size={14} aria-hidden="true" /></button><button type="button" className="workspace-icon-button" onClick={() => void moveWebHistory(1)} disabled={webHistory.index >= webHistory.entries.length - 1} aria-label="Avançar na pesquisa web" title="Avançar"><ArrowRight size={14} aria-hidden="true" /></button><button type="button" className="workspace-icon-button" onClick={() => void window.devorbit.reloadWeb()} aria-label="Recarregar pesquisa web" title="Recarregar"><RefreshCw size={14} aria-hidden="true" /></button></div></div>
      <form className="workspace-browser-form" onSubmit={(event) => void navigateBrowser(event)}><label className="sr-only" htmlFor="workspace-canvas-web-url">Endereço da página web</label><input id="workspace-canvas-web-url" value={webUrl} onChange={(event) => setWebUrl(event.target.value)} spellCheck={false} autoComplete="off" /><button type="submit" className="workspace-send-button" aria-label="Navegar" title="Navegar"><Check size={14} aria-hidden="true" /></button></form>
      <div ref={webViewportRef} className="workspace-web-viewport">{webError && <div className="workspace-web-message"><AlertCircle size={18} aria-hidden="true" /><strong>Não foi possível carregar</strong><span>{webError}</span></div>}</div>
    </aside>
  )

  return (
    <main
      className={'integrated-workspace' + (dragging ? ' is-resizing is-resizing-' + dragging : '')}
      style={{
        '--workspace-browser-width': layout.webVisible ? layout.rightWidth + 'px' : '0px',
        '--workspace-terminal-height': layout.terminalVisible ? layout.terminalHeight + 'px' : '0px',
      } as React.CSSProperties}
      aria-label={'Ambiente integrado de ' + project.name}
    >
      <header className="integrated-toolbar">
        <div className="integrated-heading">
          <span className="integrated-heading-icon"><Code2 size={16} aria-hidden="true" /></span>
          <div><strong>{project.name}</strong><span title={project.path}>{project.path}</span></div>
        </div>
        <div className="integrated-toolbar-actions">
          <button type="button" className={'workspace-tool-button' + (isCanvas ? ' active' : '')} onClick={() => setIsCanvas((current) => !current)} aria-pressed={isCanvas} aria-label={isCanvas ? 'Voltar ao layout integrado' : 'Abrir canvas'} title={isCanvas ? 'Voltar ao layout integrado' : 'Abrir canvas'}>
            <Code2 size={14} aria-hidden="true" /><span>{isCanvas ? 'Layout' : 'Canvas'}</span>
          </button>
          <button type="button" className={'workspace-tool-button' + (layout.terminalVisible ? ' active' : '')} onClick={() => setLayout((current) => ({ ...current, terminalVisible: !current.terminalVisible }))} aria-pressed={layout.terminalVisible} title="Mostrar ou ocultar terminal">
            <Terminal size={14} aria-hidden="true" /><span>Terminal</span>
          </button>
          <button type="button" className={'workspace-tool-button' + (layout.webVisible ? ' active' : '')} onClick={() => setLayout((current) => ({ ...current, webVisible: !current.webVisible }))} aria-pressed={layout.webVisible} title="Mostrar ou ocultar navegador">
            <Globe size={14} aria-hidden="true" /><span>Web</span>
          </button>
          <button type="button" className="workspace-tool-button" onClick={() => void sendContextToTerminal()} disabled={!editorContext?.path} title="Enviar arquivo e pesquisa web ao terminal">
            <Send size={14} aria-hidden="true" /><span>Enviar contexto</span>
          </button>
          <button type="button" className="workspace-close-button" onClick={closeWorkspace} title="Fechar ambiente integrado">
            <X size={16} aria-hidden="true" /><span>Fechar</span>
          </button>
        </div>
      </header>

      {isCanvas ? <WorkspaceCanvas project={project} workbench={canvasWorkbench} browser={canvasBrowser} /> : <>
      <div className="workspace-editor-stack">
        <WorkspaceEditor
          projectPath={project.path}
          onNotify={onNotify}
          onContextChange={setEditorContext}
          onDirtyChange={(dirty) => {
            setIsEditorDirty(dirty)
            onDirtyChange?.(dirty)
          }}
        />

        {layout.terminalVisible && (
          <>
            <button type="button" className="workspace-resize-handle horizontal" onPointerDown={(event) => startDrag('terminal', event)} aria-label="Redimensionar terminal" title="Arraste para redimensionar o terminal"><GripVertical size={15} aria-hidden="true" /></button>
            <WorkspaceTerminal
              projectPath={project.path}
              terminalId={terminalId}
              codexAccount={codexAccount}
              onNotify={onNotify}
              onRequestCodexAuth={onRequestCodexAuth}
            />
          </>
        )}
      </div>

      {layout.webVisible && (
        <>
          <aside className="workspace-browser-panel" aria-label="Pesquisa web">
            <div className="workspace-panel-heading browser-heading">
              <div><strong><Globe size={14} aria-hidden="true" /> Pesquisa web</strong><span title={webTitle}>{webTitle}</span></div>
              <div className="browser-actions">
                <button type="button" className="workspace-icon-button" onClick={() => void moveWebHistory(-1)} disabled={webHistory.index === 0} aria-label="Voltar na pesquisa web" title="Voltar"><ArrowLeft size={14} aria-hidden="true" /></button>
                <button type="button" className="workspace-icon-button" onClick={() => void moveWebHistory(1)} disabled={webHistory.index >= webHistory.entries.length - 1} aria-label="Avançar na pesquisa web" title="Avançar"><ArrowRight size={14} aria-hidden="true" /></button>
                <button type="button" className="workspace-icon-button" onClick={() => void window.devorbit.reloadWeb()} aria-label="Recarregar pesquisa web" title="Recarregar"><RefreshCw size={14} aria-hidden="true" /></button>
                <span className={'browser-loading-dot' + (webLoading ? ' loading' : '')} aria-label={webLoading ? 'Carregando página' : 'Página pronta'} />
              </div>
            </div>
            <form className="workspace-browser-form" onSubmit={(event) => void navigateBrowser(event)}>
              <label className="sr-only" htmlFor="workspace-web-url">Endereço da página web</label>
              <input id="workspace-web-url" value={webUrl} onChange={(event) => setWebUrl(event.target.value)} spellCheck={false} autoComplete="off" />
              <button type="submit" className="workspace-send-button" aria-label="Navegar" title="Navegar"><Check size={14} aria-hidden="true" /></button>
            </form>
            <div ref={webViewportRef} className="workspace-web-viewport">
              {webError && <div className="workspace-web-message"><AlertCircle size={18} aria-hidden="true" /><strong>Não foi possível carregar</strong><span>{webError}</span></div>}
            </div>
          </aside>
          <button type="button" className="workspace-resize-handle vertical" onPointerDown={(event) => startDrag('browser', event)} aria-label="Redimensionar pesquisa web" title="Arraste para redimensionar a pesquisa web"><GripVertical size={15} aria-hidden="true" /></button>
        </>
      )}
      </>}
    </main>
  )
}
