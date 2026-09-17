import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle, ArrowLeft, ArrowRight, Check, Code2, Globe, GripVertical,
  RefreshCw, Send, Terminal, X,
} from 'lucide-react'
import type { AgentBridgeEvent } from '../../../shared/agent-bridge-event'
import type { AgentProvider, AgentProviderId, CodexAccountStatus, Project, ToolHealth, WebPanelEvent } from '../types'
import type { PendingCanvasNode, WorkspaceUiRequest } from './workspace-request-helpers'
import { applyWorkspaceUiRequest, computePipeSync, isPendingNodeForProject } from './workspace-request-helpers'
import { createPipeCallQueue } from './pipe-ipc-queue'
import { WorkspaceEditor, type WorkspaceEditorContext } from './WorkspaceEditor'
import { WorkspaceTerminal } from './WorkspaceTerminal'
import { WorkspaceCanvas, type CanvasNode } from './WorkspaceCanvas'
import './IntegratedWorkspace.css'

interface IntegratedWorkspaceProps {
  project: Project
  onClose: () => void
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void
  codexAccount?: 'account1' | 'account2'
  isWebSuppressed?: boolean
  isSuspended?: boolean
  onRequestCodexAuth?: (account: 'account1' | 'account2') => void
  codexAuthStatus?: CodexAccountStatus | null
  onDirtyChange?: (dirty: boolean) => void
  onCanvasFocusChange?: (node: { id: string; title: string; kind: string } | null) => void
  uiRequest?: WorkspaceUiRequest | null
  onUiRequestConsumed?: (nonce: number) => void
  pendingCanvasNode?: PendingCanvasNode | null
  onPendingCanvasNodeConsumed?: (nonce: number) => void
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
const AGENT_PROVIDER_IDS: AgentProviderId[] = ['codex', 'opencode', 'claude', 'gemini', 'aider', 'agy', 'custom']

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

export function resolveInitialWorkspaceMode(saved: string | null): 'canvas' | 'grid' {
  if (saved === 'grid') return 'grid'
  return 'canvas'
}

export function agentTerminalId(projectId: string, nodeId: string): string {
  return 'agent-' + projectId.replace(/[^a-z0-9_-]/gi, '-').slice(0, 32) + '-' + nodeId.slice(-18)
}

export const IntegratedWorkspace: React.FC<IntegratedWorkspaceProps> = ({
  project, onClose, onNotify, codexAccount = 'account1', codexAuthStatus = null, isWebSuppressed = false, isSuspended = false, onRequestCodexAuth, onDirtyChange, onCanvasFocusChange,
  uiRequest = null, onUiRequestConsumed, pendingCanvasNode = null, onPendingCanvasNodeConsumed,
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
  const [isCanvas, setIsCanvas] = useState(() => {
    try {
      return resolveInitialWorkspaceMode(window.localStorage.getItem('devorbit:workspace-mode:' + project.id)) === 'canvas'
    } catch {
      return true
    }
  })
  const [dragging, setDragging] = useState<'browser' | 'terminal' | null>(null)
  const [agentTasks, setAgentTasks] = useState<Record<string, { id: string; prompt: string }>>({})
  const consumedUiRef = useRef<Set<number>>(new Set())
  // Requisição explícita App -> workspace (G+C/G+T/C+N/C+T): força canvas e/ou
  // terminal primário mesmo com projeto salvo em grid ou terminal oculto.
  useEffect(() => {
    if (!uiRequest || uiRequest.projectId !== project.id || consumedUiRef.current.has(uiRequest.nonce)) return
    consumedUiRef.current.add(uiRequest.nonce)
    const next = applyWorkspaceUiRequest({ isCanvas, terminalVisible: layout.terminalVisible }, uiRequest, project.id)
    if (next.isCanvas !== isCanvas) setIsCanvas(next.isCanvas)
    if (next.terminalVisible !== layout.terminalVisible) {
      setLayout((current) => ({ ...current, terminalVisible: next.terminalVisible }))
    }
    onUiRequestConsumed?.(uiRequest.nonce)
  }, [isCanvas, layout.terminalVisible, onUiRequestConsumed, project.id, uiRequest])
  const handlePendingCanvasNodeConsumed = useCallback((nonce: number) => {
    const pending = pendingCanvasNode
    onPendingCanvasNodeConsumed?.(nonce)
    if (pending && pending.nonce === nonce && isPendingNodeForProject(pending, project.id)) {
      onNotify(pending.kind === 'note' ? 'Nova nota criada no canvas.' : 'Escolha os participantes e confirme a criação.', 'info')
    }
  }, [onNotify, onPendingCanvasNodeConsumed, pendingCanvasNode, project.id])
  const [agentProviders, setAgentProviders] = useState<AgentProvider[]>([])
  const [agentWorktrees, setAgentWorktrees] = useState<Record<string, { path: string; branch: string }>>({})
  const appliedPipesRef = useRef<Map<string, Set<string>>>(new Map())
  // Fila seriada por origem: clear -> add sempre nessa ordem observável,
  // mesmo sob mudanças rápidas de fanout.
  const pipeQueueRef = useRef(createPipeCallQueue((from, to) => window.devorbit.pipeTerminals(from, to)))
  // PTY piping (FASE 3): cabos agente -> agente no canvas canalizam stdout
  // para stdin via `devorbit:pipeTerminals`. Fanout suportado; reconciliação
  // determinística por origem via computePipeSync. Best-effort, sem spam.
  const syncCanvasPipes = useCallback((
    connections: Array<{ id: string; from: string; to: string }>,
    nodes: Array<{ id: string; kind: string }>,
  ) => {
    const kinds = new Map(nodes.map((node) => [node.id, node.kind] as const))
    const desired = new Map<string, Set<string>>()
    for (const connection of connections) {
      if (kinds.get(connection.from) === 'agent' && kinds.get(connection.to) === 'agent') {
        const from = agentTerminalId(project.id, connection.from)
        const to = agentTerminalId(project.id, connection.to)
        const destinations = desired.get(from) || new Set<string>()
        destinations.add(to)
        desired.set(from, destinations)
      }
    }
    const plan = computePipeSync(appliedPipesRef.current, desired)
    const queue = pipeQueueRef.current
    for (const from of plan.clearSources) {
      appliedPipesRef.current.delete(from)
      void queue(from, null)
    }
    for (const edge of plan.addEdges) {
      const destinations = appliedPipesRef.current.get(edge.from) || new Set<string>()
      destinations.add(edge.to)
      appliedPipesRef.current.set(edge.from, destinations)
      void queue(edge.from, edge.to).then(() => undefined, () => {
        const current = appliedPipesRef.current.get(edge.from)
        if (current) {
          current.delete(edge.to)
          if (current.size === 0) appliedPipesRef.current.delete(edge.from)
        }
      })
    }
  }, [project.id])
  // Canvas -> grid: os PTYs dos agentes desmontam e os cabos somem do main;
  // limpa o mapa para reinstalar os mesmos cabos ao voltar ao canvas.
  useEffect(() => {
    if (isCanvas) return
    const queue = pipeQueueRef.current
    for (const from of Array.from(appliedPipesRef.current.keys())) {
      void queue(from, null)
    }
    appliedPipesRef.current.clear()
  }, [isCanvas, project.id])
  useEffect(() => {
    const applied = appliedPipesRef.current
    const queue = pipeQueueRef.current
    return () => {
      for (const from of Array.from(applied.keys())) {
        void queue(from, null)
      }
      applied.clear()
    }
  }, [project.id])
  const terminalId = useMemo(
    () => 'workspace-' + project.id.replace(/[^a-z0-9_-]/gi, '-').slice(0, 48),
    [project.id],
  )
  const queueAgentTask = useCallback((node: CanvasNode, prompt: string) => {
    const taskId = 'task-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
    setAgentTasks((current) => ({ ...current, [node.id]: { id: taskId, prompt } }))
    onNotify('Tarefa encaminhada para ' + node.title + '.', 'info')
    return taskId
  }, [onNotify])
  const isolateAgent = useCallback(async (node: CanvasNode) => {
    try {
      const result = await window.devorbit.createAgentWorktree(project.path, node.id)
      setAgentWorktrees((current) => ({ ...current, [node.id]: result }))
      onNotify(node.title + ' isolado na branch ' + result.branch + '.', 'success')
    } catch (error) {
      onNotify('Não foi possível isolar o agente: ' + (error instanceof Error ? error.message : String(error)), 'error')
    }
  }, [onNotify, project.path])
  const reviewAgent = useCallback(async (node: CanvasNode) => {
    const worktree = agentWorktrees[node.id]
    if (!worktree) return
    try {
      const changes = await window.devorbit.getGitChanges(worktree.path)
      onNotify(changes.length ? node.title + ': ' + changes.length + ' arquivo(s) alterado(s): ' + changes.slice(0, 4).map((change) => change.path).join(', ') : node.title + ': nenhuma alteração pendente.', 'info')
    } catch (error) { onNotify('Não foi possível revisar: ' + (error instanceof Error ? error.message : String(error)), 'error') }
  }, [agentWorktrees, onNotify])
  const mergeAgent = useCallback(async (node: CanvasNode) => {
    const worktree = agentWorktrees[node.id]
    if (!worktree || !window.confirm('Integrar ' + worktree.branch + ' no projeto principal? O worktree será removido após o merge.')) return
    try {
      await window.devorbit.integrateAgentWorktree(project.path, worktree.branch, worktree.path)
      setAgentWorktrees((current) => { const next = { ...current }; delete next[node.id]; return next })
      onNotify(node.title + ' integrado ao projeto principal.', 'success')
    } catch (error) { onNotify('Não foi possível integrar: ' + (error instanceof Error ? error.message : String(error)), 'error') }
  }, [agentWorktrees, onNotify, project.path])
  useEffect(() => { setAgentTasks({}) }, [project.id])
  useEffect(() => { setAgentWorktrees({}) }, [project.id])
  useEffect(() => {
    if (!isCanvas) {
      setAgentProviders([])
      return
    }
    let alive = true
    void window.devorbit.getToolHealth().then((items) => {
      if (!alive) return
      setAgentProviders(items
        .filter((item): item is ToolHealth & { id: AgentProviderId } => AGENT_PROVIDER_IDS.includes(item.id as AgentProviderId))
        .map((item) => ({ ...item, id: item.id as AgentProviderId, command: item.path || item.id })))
    }).catch(() => {
      if (alive) setAgentProviders([])
    })
    return () => { alive = false }
  }, [isCanvas, project.id])

  useEffect(() => {
    if (isSuspended) return
    return window.devorbit.onAgentBridgeEvent((event: AgentBridgeEvent) => {
      const target = event.target === 'bridge-target' ? 'agente' : event.target
      if (event.status === 'pending') {
        onNotify('Delegação iniciada para ' + target + '.', 'info')
      } else if (event.status === 'completed') {
        onNotify(event.summary || 'Delegação concluída para ' + target + '.', 'success')
      } else if (event.status === 'blocked') {
        onNotify(event.summary || 'Delegação bloqueada para ' + target + '.', 'error')
      } else {
        onNotify(event.summary || 'Delegação falhou para ' + target + '.', 'error')
      }
    })
  }, [isSuspended, onNotify])
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
      // Atalho global vindo do WebContentsView nativo: só sinaliza a App para
      // abrir o Command Center; nunca altera URL, histórico ou loading.
      if (event.type === 'palette-shortcut') return
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
    const canvas = viewport.closest('.workspace-canvas')
    const updateBounds = () => {
      const rect = viewport.getBoundingClientRect()
      const clip = canvas?.getBoundingClientRect()
      const left = Math.max(0, rect.left, clip?.left ?? 0)
      const top = Math.max(0, rect.top, clip?.top ?? 0)
      const right = Math.min(window.innerWidth, rect.right, clip?.right ?? window.innerWidth)
      const bottom = Math.min(window.innerHeight, rect.bottom, clip?.bottom ?? window.innerHeight)
      const width = Math.max(0, right - left)
      const height = Math.max(0, bottom - top)
      const visible = layout.webVisible && !suppressNativeWeb && width > 0 && height > 0
      void window.devorbit.setWebBounds({
        x: Math.round(left), y: Math.round(top),
        width: Math.round(width), height: Math.round(height),
        contentX: Math.round(rect.left), contentY: Math.round(rect.top),
        contentWidth: Math.round(rect.width), contentHeight: Math.round(rect.height),
      })
      void window.devorbit.setWebVisible(visible)
    }
    const observer = new ResizeObserver(updateBounds)
    observer.observe(viewport)
    const mutationObserver = canvas ? new MutationObserver(updateBounds) : null
    if (canvas) mutationObserver?.observe(canvas, { attributes: true, subtree: true, attributeFilter: ['style'] })
    canvas?.addEventListener('scroll', updateBounds, { passive: true })
    updateBounds()
    window.addEventListener('resize', updateBounds)
    return () => {
      observer.disconnect()
      mutationObserver?.disconnect()
      canvas?.removeEventListener('scroll', updateBounds)
      window.removeEventListener('resize', updateBounds)
      void window.devorbit.setWebVisible(false)
    }
  }, [isCanvas, suppressNativeWeb, layout.rightWidth, layout.webVisible])

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

  const toggleWorkspaceMode = () => {
    const warning = isEditorDirty
      ? 'Há alterações não salvas. Trocar o layout descarta esses rascunhos e reinicia o terminal. Continuar mesmo assim?'
      : 'Trocar o layout reinicia o terminal interno. Continuar?'
    if (!window.confirm(warning)) return
    setIsCanvas((current) => !current)
  }

  const canvasWorkbench = (
    <div className="workspace-editor-stack">
      <WorkspaceEditor projectPath={project.path} onNotify={onNotify} onContextChange={setEditorContext} onDirtyChange={(dirty) => { setIsEditorDirty(dirty); onDirtyChange?.(dirty) }} />
      {layout.terminalVisible && <WorkspaceTerminal projectPath={project.path} terminalId={terminalId} codexAccount={codexAccount} provider="codex" onNotify={onNotify} onRequestCodexAuth={onRequestCodexAuth} />}
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
          <button type="button" className={'workspace-tool-button' + (isCanvas ? ' active' : '')} onClick={toggleWorkspaceMode} aria-pressed={isCanvas} aria-label={isCanvas ? 'Voltar ao layout integrado' : 'Abrir canvas'} title={isCanvas ? 'Voltar ao layout integrado' : 'Abrir canvas'}>
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

      {isCanvas ? <WorkspaceCanvas project={project} workbench={canvasWorkbench} browser={layout.webVisible ? canvasBrowser : undefined} codexAuthStatus={codexAuthStatus} onRequestCodexAuth={onRequestCodexAuth} agentProviders={agentProviders} onSendAgentTask={queueAgentTask} onCreateAgentWorktree={(node) => void isolateAgent(node)} onSelectionChange={onCanvasFocusChange} onConnectionsChange={syncCanvasPipes} pendingNodeRequest={pendingCanvasNode && isPendingNodeForProject(pendingCanvasNode, project.id) ? { kind: pendingCanvasNode.kind, nonce: pendingCanvasNode.nonce } : null} onPendingNodeConsumed={handlePendingCanvasNodeConsumed} renderAgent={(node: CanvasNode, onAgentResult, onAgentTaskFailure) => node.provider ? (<div className="canvas-agent-terminal"><div className="canvas-agent-review"><span>Worktree</span><button type="button" disabled={!agentWorktrees[node.id]} onClick={() => void reviewAgent(node)}>Alterações</button><button type="button" disabled={!agentWorktrees[node.id]} onClick={() => void mergeAgent(node)}>Integrar</button></div><WorkspaceTerminal projectPath={agentWorktrees[node.id]?.path || project.path} terminalId={agentTerminalId(project.id, node.id)} codexAccount={node.account} provider={node.provider} agentTask={agentTasks[node.id]} onAgentResult={onAgentResult} onAgentTaskFailure={onAgentTaskFailure} onNotify={onNotify} onRequestCodexAuth={onRequestCodexAuth} /></div>) : null} /> : <>
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
              provider="codex"
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
