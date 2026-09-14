import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle, Check, Code2, FileText, Folder, Globe, GripVertical,
  RefreshCw, Save, Terminal, X,
} from 'lucide-react'
import type { Project, ProjectFileEntry, TerminalEvent, WebPanelEvent } from '../types'
import './IntegratedWorkspace.css'

interface IntegratedWorkspaceProps {
  project: Project
  onClose: () => void
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void
  isWebSuppressed?: boolean
}
interface WorkspaceLayout {
  rightWidth: number
  terminalHeight: number
  terminalVisible: boolean
  webVisible: boolean
}

const DEFAULT_LAYOUT: WorkspaceLayout = {
  rightWidth: 390, terminalHeight: 220, terminalVisible: true, webVisible: true,
}
const MIN_RIGHT_WIDTH = 300
const MAX_RIGHT_WIDTH = 680
const MIN_TERMINAL_HEIGHT = 150
const MAX_TERMINAL_HEIGHT = 420
const MAX_TERMINAL_OUTPUT = 160_000

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
function fileName(path: string): string {
  return path.replaceAll('\\', '/').split('/').pop() || path
}
function fileDepth(path: string): number {
  return Math.max(0, path.replaceAll('\\', '/').split('/').length - 1)
}
function formatBytes(size?: number): string {
  if (size === undefined) return ''
  if (size < 1024) return size + ' B'
  return (size / 1024).toFixed(size < 1024 * 1024 ? 1 : 0) + (size < 1024 * 1024 ? ' KB' : ' MB')
}

export const IntegratedWorkspace: React.FC<IntegratedWorkspaceProps> = ({
  project, onClose, onNotify, isWebSuppressed = false,
}) => {
  const [files, setFiles] = useState<ProjectFileEntry[]>([])
  const [selectedPath, setSelectedPath] = useState('')
  const [editorContent, setEditorContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [isLoadingFiles, setIsLoadingFiles] = useState(true)
  const [isLoadingFile, setIsLoadingFile] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [fileError, setFileError] = useState('')
  const [terminalOutput, setTerminalOutput] = useState('')
  const [terminalInput, setTerminalInput] = useState('')
  const [terminalState, setTerminalState] = useState<'starting' | 'ready' | 'stopped' | 'error'>('starting')
  const [webUrl, setWebUrl] = useState('https://www.google.com/')
  const [webTitle, setWebTitle] = useState('Navegador')
  const [webLoading, setWebLoading] = useState(false)
  const [webError, setWebError] = useState('')
  const [layout, setLayout] = useState<WorkspaceLayout>(() => readLayout(project.id))
  const [dragging, setDragging] = useState<'browser' | 'terminal' | null>(null)
  const terminalId = useMemo(
    () => 'workspace-' + project.id.replace(/[^a-z0-9_-]/gi, '-').slice(0, 48),
    [project.id],
  )
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const webViewportRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef({
    startX: 0, startY: 0, rightWidth: layout.rightWidth, terminalHeight: layout.terminalHeight,
  })
  const initialFileLoadRef = useRef(true)
  const latestContentRef = useRef(editorContent)
  const latestPathRef = useRef(selectedPath)
  const isDirty = editorContent !== savedContent
  const isDirtyRef = useRef(false)
  isDirtyRef.current = isDirty
  latestContentRef.current = editorContent
  latestPathRef.current = selectedPath

  const openFile = useCallback(async (entry: ProjectFileEntry, ignoreDirty = false) => {
    if (entry.kind !== 'file' || entry.editable === false) return
    if (!ignoreDirty && isDirtyRef.current && !window.confirm('Há alterações não salvas. Deseja trocar de arquivo?')) return
    setIsLoadingFile(true)
    setFileError('')
    try {
      const loaded = await window.devorbit.readProjectFile(project.path, entry.path)
      setSelectedPath(loaded.path)
      setEditorContent(loaded.content)
      setSavedContent(loaded.content)
      window.requestAnimationFrame(() => editorRef.current?.focus())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setFileError(message)
      onNotify('Não foi possível abrir ' + fileName(entry.path) + ': ' + message, 'error')
    } finally {
      setIsLoadingFile(false)
    }
  }, [onNotify, project.path])

  const loadFiles = useCallback(async () => {
    setIsLoadingFiles(true)
    setFileError('')
    try {
      const entries = await window.devorbit.listProjectFiles(project.path)
      setFiles(entries)
      const editable = entries.filter((entry) => entry.kind === 'file' && entry.editable !== false)
      const preferred = editable.find((entry) => /(^|[\\/])readme(?:\.md)?$/i.test(entry.path))
        || editable.find((entry) => fileName(entry.path).toLowerCase() === 'package.json')
        || editable[0]
      const shouldOpenInitialFile = initialFileLoadRef.current
      initialFileLoadRef.current = false
      if (shouldOpenInitialFile && preferred) await openFile(preferred, true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setFileError(message)
      onNotify('Não foi possível ler os arquivos do projeto: ' + message, 'error')
    } finally {
      setIsLoadingFiles(false)
    }
  }, [onNotify, openFile, project.path])

  useEffect(() => { void loadFiles() }, [loadFiles])

  useEffect(() => {
    const unsubscribe = window.devorbit.onTerminalEvent((event: TerminalEvent) => {
      if (event.id !== terminalId) return
      if (event.type === 'data' && event.data) {
        setTerminalOutput((current) => (current + event.data).slice(-MAX_TERMINAL_OUTPUT))
      } else if (event.type === 'exit') {
        setTerminalState('stopped')
        setTerminalOutput((current) => current + '\r\n[processo encerrado: ' + String(event.code ?? '') + ']\r\n')
      } else if (event.type === 'error') {
        setTerminalState('error')
        if (event.data) setTerminalOutput((current) => current + '\r\n[erro: ' + event.data + ']\r\n')
      }
    })
    void window.devorbit.startTerminal(terminalId, project.path)
      .then(() => setTerminalState('ready'))
      .catch((error) => {
        setTerminalState('error')
        onNotify('Não foi possível iniciar o terminal interno: ' + (error instanceof Error ? error.message : String(error)), 'error')
      })
    return () => { unsubscribe(); void window.devorbit.stopTerminal(terminalId) }
  }, [onNotify, project.path, terminalId])

  useEffect(() => {
    const unsubscribe = window.devorbit.onWebEvent((event: WebPanelEvent) => {
      setWebUrl(event.url || 'https://www.google.com/')
      if (event.title) setWebTitle(event.title)
      setWebLoading(event.type === 'loading')
      setWebError(event.type === 'error' ? event.message || 'Falha ao carregar esta página.' : '')
    })
    void window.devorbit.getWebState().then((state) => {
      setWebUrl(state.url || 'https://www.google.com/')
      setWebTitle(state.title || 'Navegador')
    }).catch(() => undefined)
    void window.devorbit.setWebVisible(layout.webVisible && !isWebSuppressed)
    return unsubscribe
  }, [isWebSuppressed, layout.webVisible])

  useEffect(() => {
    try { window.localStorage.setItem(layoutKey(project.id), JSON.stringify(layout)) } catch { /* opcional */ }
  }, [layout, project.id])

  useEffect(() => {
    const viewport = webViewportRef.current
    if (!viewport) return
    const updateBounds = () => {
      const rect = viewport.getBoundingClientRect()
      const visible = layout.webVisible && !isWebSuppressed && rect.width > 0 && rect.height > 0
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
  }, [isWebSuppressed, layout.rightWidth, layout.webVisible])

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

  const saveFile = async () => {
    if (!selectedPath || !isDirty || isSaving) return
    const pathAtStart = selectedPath
    const contentAtStart = editorContent
    setIsSaving(true)
    try {
      const saved = await window.devorbit.saveProjectFile(project.path, pathAtStart, contentAtStart)
      if (latestPathRef.current === pathAtStart) {
        setSavedContent(saved.content)
        if (latestContentRef.current === contentAtStart) setEditorContent(saved.content)
      }
      onNotify('Arquivo salvo: ' + fileName(saved.path), 'success')
    } catch (error) {
      onNotify('Não foi possível salvar o arquivo: ' + (error instanceof Error ? error.message : String(error)), 'error')
    } finally { setIsSaving(false) }
  }

  useEffect(() => {
    const handleEditorShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && document.activeElement === editorRef.current) {
        event.preventDefault()
        void saveFile()
      }
    }
    window.addEventListener('keydown', handleEditorShortcut)
    return () => window.removeEventListener('keydown', handleEditorShortcut)
  })

  const submitTerminal = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!terminalInput.trim() || terminalState !== 'ready') return
    const command = terminalInput
    setTerminalInput('')
    try { await window.devorbit.writeTerminal(terminalId, command + '\r\n') }
    catch (error) { onNotify('Não foi possível enviar o comando: ' + (error instanceof Error ? error.message : String(error)), 'error') }
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
    } else if (result.url) setWebUrl(result.url)
  }

  const restartTerminal = async () => {
    setTerminalOutput('')
    setTerminalState('starting')
    try {
      await window.devorbit.stopTerminal(terminalId)
      await window.devorbit.startTerminal(terminalId, project.path)
      setTerminalState('ready')
    } catch (error) {
      setTerminalState('error')
      onNotify('Não foi possível reiniciar o terminal: ' + (error instanceof Error ? error.message : String(error)), 'error')
    }
  }

  const closeWorkspace = () => {
    if (isDirty && !window.confirm('Há alterações não salvas. Fechar o ambiente mesmo assim?')) return
    void window.devorbit.setWebVisible(false)
    void window.devorbit.disposeWebPanel()
    void window.devorbit.stopTerminal(terminalId)
    onClose()
  }

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
          <button type="button" className={'workspace-tool-button' + (layout.terminalVisible ? ' active' : '')} onClick={() => setLayout((current) => ({ ...current, terminalVisible: !current.terminalVisible }))} aria-pressed={layout.terminalVisible} title="Mostrar ou ocultar terminal">
            <Terminal size={14} aria-hidden="true" /><span>Terminal</span>
          </button>
          <button type="button" className={'workspace-tool-button' + (layout.webVisible ? ' active' : '')} onClick={() => setLayout((current) => ({ ...current, webVisible: !current.webVisible }))} aria-pressed={layout.webVisible} title="Mostrar ou ocultar navegador">
            <Globe size={14} aria-hidden="true" /><span>Web</span>
          </button>
          <button type="button" className="workspace-close-button" onClick={closeWorkspace} title="Fechar ambiente integrado">
            <X size={16} aria-hidden="true" /><span>Fechar</span>
          </button>
        </div>
      </header>

      <div className="workspace-editor-stack">
        <div className="workspace-code-area">
          <aside className="workspace-file-panel" aria-label="Arquivos do projeto">
            <div className="workspace-panel-heading">
              <div><strong>Arquivos</strong><span>{files.filter((entry) => entry.kind === 'file').length}</span></div>
              <button type="button" className="workspace-icon-button" onClick={() => void loadFiles()} aria-label="Atualizar arquivos" title="Atualizar arquivos"><RefreshCw size={14} aria-hidden="true" /></button>
            </div>
            <div className="workspace-file-list">
              {isLoadingFiles && <p className="workspace-muted" role="status">Lendo arquivos…</p>}
              {!isLoadingFiles && !files.length && <p className="workspace-muted">Nenhum arquivo encontrado.</p>}
              {!isLoadingFiles && files.map((entry) => (
                <button
                  type="button" key={entry.path}
                  className={'workspace-file-row' + (entry.path === selectedPath ? ' selected' : '') + (entry.kind === 'directory' ? ' directory' : '')}
                  style={{ paddingLeft: 10 + fileDepth(entry.path) * 12 }}
                  onClick={() => void openFile(entry)}
                  disabled={entry.kind === 'directory' || entry.editable === false}
                  title={entry.editable === false ? 'Arquivo somente leitura ou binário' : entry.path}
                  aria-current={entry.path === selectedPath ? 'page' : undefined}
                >
                  {entry.kind === 'directory' ? <Folder size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}
                  <span>{entry.name}</span>
                  {entry.kind === 'file' && <small>{formatBytes(entry.size)}</small>}
                </button>
              ))}
            </div>
            {fileError && <p className="workspace-error workspace-file-error"><AlertCircle size={13} aria-hidden="true" />{fileError}</p>}
          </aside>

          <section className="workspace-editor-panel" aria-label="Editor de texto">
            <div className="workspace-panel-heading editor-heading">
              <div><strong>{selectedPath ? fileName(selectedPath) : 'Editor'}</strong><span>{selectedPath || 'Selecione um arquivo à esquerda'}</span></div>
              <div className="editor-actions">
                {isDirty && <span className="editor-dirty" title="Alterações não salvas">● Não salvo</span>}
                <button type="button" className="workspace-save-button" onClick={() => void saveFile()} disabled={!selectedPath || !isDirty || isSaving} aria-busy={isSaving}>
                  <Save size={14} aria-hidden="true" /><span>{isSaving ? 'Salvando…' : 'Salvar'}</span>
                </button>
              </div>
            </div>
            <textarea
              ref={editorRef} className="workspace-editor" value={editorContent}
              onChange={(event) => setEditorContent(event.target.value)}
              placeholder="Selecione um arquivo para começar." spellCheck={false}
              aria-label={selectedPath ? 'Editando ' + selectedPath : 'Editor de texto'}
              disabled={!selectedPath || isLoadingFile}
            />
            {isLoadingFile && <div className="workspace-editor-loading" role="status">Abrindo arquivo…</div>}
          </section>
        </div>

        {layout.terminalVisible && (
          <>
            <button type="button" className="workspace-resize-handle horizontal" onPointerDown={(event) => startDrag('terminal', event)} aria-label="Redimensionar terminal" title="Arraste para redimensionar o terminal"><GripVertical size={15} aria-hidden="true" /></button>
            <section className="workspace-terminal-panel" aria-label="Terminal interno">
              <div className="workspace-panel-heading terminal-heading">
                <div><strong><Terminal size={14} aria-hidden="true" /> Terminal interno</strong><span className={'terminal-status ' + terminalState}><i />{terminalState === 'ready' ? 'Pronto' : terminalState === 'starting' ? 'Iniciando' : terminalState === 'error' ? 'Erro' : 'Encerrado'}</span></div>
                <button type="button" className="workspace-icon-button" onClick={() => void restartTerminal()} aria-label="Reiniciar terminal" title="Reiniciar terminal"><RefreshCw size={14} aria-hidden="true" /></button>
              </div>
              <pre className="workspace-terminal-output" aria-live="polite">{terminalOutput || 'Terminal pronto. Digite um comando abaixo.'}</pre>
              <form className="workspace-terminal-form" onSubmit={(event) => void submitTerminal(event)}>
                <span className="terminal-prompt" aria-hidden="true">&gt;</span>
                <input value={terminalInput} onChange={(event) => setTerminalInput(event.target.value)} disabled={terminalState !== 'ready'} aria-label="Comando do terminal" placeholder="Digite um comando…" autoComplete="off" />
                <button type="submit" className="workspace-send-button" disabled={terminalState !== 'ready' || !terminalInput.trim()}>Enviar</button>
              </form>
            </section>
          </>
        )}
      </div>

      {layout.webVisible && (
        <>
          <aside className="workspace-browser-panel" aria-label="Pesquisa web">
            <div className="workspace-panel-heading browser-heading">
              <div><strong><Globe size={14} aria-hidden="true" /> Pesquisa web</strong><span title={webTitle}>{webTitle}</span></div>
              <span className={'browser-loading-dot' + (webLoading ? ' loading' : '')} aria-label={webLoading ? 'Carregando página' : 'Página pronta'} />
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
    </main>
  )
}
