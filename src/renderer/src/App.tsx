import React, { Suspense, useState, useEffect, useCallback, useRef } from 'react'
import { Header } from './components/Header'
import { ProjectGrid } from './components/ProjectGrid'
import { SettingsModal } from './components/SettingsModal'
import { CodexAuthModal } from './components/CodexAuthModal'
import { UsageBar } from './components/UsageBar'
import { AiMemoryModal } from './components/AiMemoryModal'
import { GitDock, type GitDockTab } from './components/GitDock'
import { CommandPalette } from './components/CommandPalette'
import { UpdateModal } from './components/UpdateModal'
import { ToolHealthModal } from './components/ToolHealthModal'
import type { CreateActionId, NavigateActionId } from './components/command-center-helpers'
import { resolvePaletteToggle } from './components/command-center-helpers'
import type { PendingCanvasNode, WorkspaceUiRequest } from './components/workspace-request-helpers'
import { buildPendingCanvasNode, buildWorkspaceUiRequest, computeWebSuppressed } from './components/workspace-request-helpers'
import type {
  Project,
  OtherDir,
  AppConfig,
  CodexAccountStatus,
  RealUsageState,
  SyncResult,
  UpdateState,
} from './types'
import { CheckCircle2, AlertCircle, Info, X, FolderKanban, ChartNoAxesCombined, Settings, ArrowRightLeft, GitPullRequest, PanelLeftClose, PanelLeftOpen, Wrench, LayoutDashboard, RefreshCw } from 'lucide-react'

const IntegratedWorkspace = React.lazy(() => import('./components/IntegratedWorkspace').then((module) => ({ default: module.IntegratedWorkspace })))

export const App: React.FC = () => {
  const [projects, setProjects] = useState<Project[]>([])
  const [otherDirs, setOtherDirs] = useState<OtherDir[]>([])
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [authStatus, setAuthStatus] = useState<CodexAccountStatus | null>(null)
  const [authModalAccount, setAuthModalAccount] = useState<'account1' | 'account2' | null>(null)
  const [realUsage, setRealUsage] = useState<RealUsageState | null>(null)
  const [activeMemoryProject, setActiveMemoryProject] = useState<Project | null>(null)
  const [gitDockProject, setGitDockProject] = useState<Project | null>(null)
  const [gitDockTab, setGitDockTab] = useState<GitDockTab>('push')
  const [isGitDockOpen, setIsGitDockOpen] = useState(false)
  const [activeWorkspaceProject, setActiveWorkspaceProject] = useState<Project | null>(null)
  const [workspaceProjects, setWorkspaceProjects] = useState<Project[]>([])
  const [workspaceDirty, setWorkspaceDirty] = useState<Record<string, boolean>>({})
  const [search, setSearch] = useState('')
  const [workspaceView, setWorkspaceView] = useState<'projects' | 'usage' | 'workspace'>('projects')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false)
  const [focusedCanvasNode, setFocusedCanvasNode] = useState<{ id: string; title: string; kind: string } | null>(null)
  const [pendingCanvasNode, setPendingCanvasNode] = useState<PendingCanvasNode | null>(null)
  const [workspaceUiRequest, setWorkspaceUiRequest] = useState<WorkspaceUiRequest | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [bootstrapError, setBootstrapError] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isSyncingAll, setIsSyncingAll] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isToolHealthOpen, setIsToolHealthOpen] = useState(false)
  const [isSwitchingAccount, setIsSwitchingAccount] = useState(false)
  const [isRefreshingRealUsage, setIsRefreshingRealUsage] = useState(false)
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)
  const [isUpdateDismissed, setIsUpdateDismissed] = useState(false)
  const accountSwitchInFlightRef = useRef(false)
  const commandPaletteOriginRef = useRef<HTMLElement | null>(null)
  const [notification, setNotification] = useState<{
    message: string
    type: 'success' | 'error' | 'info'
    actions?: Array<{ id: string; label: string }>
  } | null>(null)
  const notificationTimerRef = useRef<number | null>(null)
  const notificationActionRef = useRef<((id: string) => void) | null>(null)

  const openCommandPalette = useCallback(() => {
    commandPaletteOriginRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    setIsCommandPaletteOpen(true)
  }, [])

  const closeCommandPalette = useCallback(() => {
    setIsCommandPaletteOpen(false)
    window.requestAnimationFrame(() => {
      const origin = commandPaletteOriginRef.current
      if (origin && document.contains(origin)) origin.focus()
      commandPaletteOriginRef.current = null
    })
  }, [])

  const notify = useCallback(
    (
      message: string,
      type: 'success' | 'error' | 'info' = 'info',
      options?: { actions?: Array<{ id: string; label: string }>; onAction?: (id: string) => void },
    ) => {
      if (notificationTimerRef.current) {
        window.clearTimeout(notificationTimerRef.current)
        notificationTimerRef.current = null
      }
      notificationActionRef.current = options?.onAction || null
      setNotification({ message, type, ...(options?.actions ? { actions: options.actions } : {}) })
      // Errors remain visible until the user dismisses them so failures are not lost.
      if (type !== 'error') {
        notificationTimerRef.current = window.setTimeout(() => {
          setNotification((current) =>
            current?.message === message && current.type === type ? null : current
          )
          notificationTimerRef.current = null
        }, 4000)
      }
    },
    []
  )

  useEffect(() => {
    return () => {
      if (notificationTimerRef.current) window.clearTimeout(notificationTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!window.devorbit) return
    let active = true
    const receiveUpdateState = (state: UpdateState) => {
      if (!active) return
      setUpdateState(state)
      if (state.status === 'available') setIsUpdateDismissed(false)
      if (state.status === 'error') notify(state.message || 'Não foi possível verificar a atualização agora.', 'error')
    }

    void window.devorbit.getUpdateState().then(receiveUpdateState).catch(() => undefined)
    const unsubscribe = window.devorbit.onUpdateStatus((state) => receiveUpdateState(state))
    return () => {
      active = false
      unsubscribe()
    }
  }, [notify])

  const handleDownloadUpdate = async () => {
    if (!window.devorbit) return
    try {
      setUpdateState(await window.devorbit.downloadUpdate())
    } catch {
      notify('Não foi possível baixar a atualização.', 'error')
    }
  }

  const handleInstallUpdate = async () => {
    if (!window.devorbit) return
    try {
      await window.devorbit.installUpdate()
    } catch (err: unknown) {
      notify(`Não foi possível instalar a atualização: ${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  // Load initial data
  const loadAuthStatus = useCallback(async (): Promise<boolean> => {
    try {
      if (window.devorbit) {
        const status = await window.devorbit.getCodexAuthStatus()
        setAuthStatus(status)
        return true
      }
    } catch (err: any) {
      console.error('Falha ao carregar status do Codex:', err)
    }
    return false
  }, [])

  const loadRealUsage = useCallback(async (force = false): Promise<boolean> => {
    try {
      if (window.devorbit) {
        const usage = await window.devorbit.getRealUsage(force)
        setRealUsage(usage)
        return true
      }
    } catch (err: any) {
      console.error('Falha ao carregar uso real da OpenAI:', err)
    }
    return false
  }, [])

  const applyProjects = useCallback((nextProjects: Project[]) => {
    setProjects(nextProjects)
    setWorkspaceProjects((current) => current.map((workspaceProject) =>
      nextProjects.find((project) => project.id === workspaceProject.id) || workspaceProject
    ))
    setActiveWorkspaceProject((current) => current
      ? nextProjects.find((project) => project.id === current.id) || current
      : current
    )
  }, [])

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setBootstrapError('')
    console.log('[App] loadData called. window.devorbit available:', Boolean(window.devorbit))
    try {
      if (window.devorbit) {
        console.log('[App] Calling Promise.all for config, projects, auth...')
        const [loadedConfig, loadedProjects, loadedOtherDirs, loadedAuth] = await Promise.all([
          window.devorbit.getConfig(),
          window.devorbit.getProjects(),
          window.devorbit.getOtherDirs(),
          window.devorbit.getCodexAuthStatus(),
        ])
        console.log('[App] Loaded successfully! Projects count:', loadedProjects?.length)
        setConfig(loadedConfig)
        applyProjects(loadedProjects)
        setOtherDirs(loadedOtherDirs)
        setAuthStatus(loadedAuth)
      } else {
        const message = 'O preload do DevOrbit não foi carregado. Reinicie o aplicativo e tente novamente.'
        console.warn('[App] window.devorbit is UNDEFINED! Preload failed or contextIsolation issue.')
        setBootstrapError(message)
      }
    } catch (err: any) {
      console.error('[App] Error in loadData:', err)
      const message = err instanceof Error ? err.message : String(err || 'erro desconhecido')
      setBootstrapError(`Não foi possível iniciar o workspace: ${message}`)
      notify(`Erro ao carregar projetos: ${message}`, 'error')
    } finally {
      setIsLoading(false)
    }
  }, [applyProjects, notify])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    if (!isLoading && !bootstrapError) void loadRealUsage()
  }, [bootstrapError, isLoading, loadRealUsage])

  // Refresh projects on demand
  const handleRefresh = async () => {
    setIsRefreshing(true)
    try {
      if (window.devorbit) {
        const [refreshed, refreshedOtherDirs, authLoaded, realUsageLoaded] = await Promise.all([
          window.devorbit.refreshProjects(),
          window.devorbit.getOtherDirs(),
          loadAuthStatus(),
          loadRealUsage(true),
        ])
        applyProjects(refreshed)
        setOtherDirs(refreshedOtherDirs)
        const allDataLoaded = authLoaded && realUsageLoaded
        notify(
          allDataLoaded
            ? 'Lista de projetos atualizada!'
            : 'Projetos atualizados, mas alguns dados não puderam ser carregados.',
          allDataLoaded ? 'success' : 'error'
        )
      }
    } catch (err: any) {
      notify(`Erro ao atualizar: ${err.message}`, 'error')
    } finally {
      setIsRefreshing(false)
    }
  }

  // Atualiza apenas o estado dos cards após uma operação Git parcial, sem
  // substituir a mensagem de erro/sucesso específica do modal.
  const refreshProjectsQuietly = useCallback(async () => {
    if (!window.devorbit) return
    try {
      const [refreshed, refreshedOtherDirs] = await Promise.all([
        window.devorbit.getProjects(),
        window.devorbit.getOtherDirs(),
      ])
      applyProjects(refreshed)
      setOtherDirs(refreshedOtherDirs)
    } catch (err) {
      console.error('[App] Erro ao atualizar projetos após operação Git:', err)
    }
  }, [applyProjects])

  // Keep Git status and the memory stale indicator useful while the app stays
  // open. The scan is local and quiet; explicit actions still provide toasts.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshProjectsQuietly()
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [refreshProjectsQuietly])

  // Keep the real Codex quota close to the provider without polling while the
  // app is hidden. The manual button and the global refresh remain available
  // for an immediate check.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadRealUsage(true)
    }, 5 * 60_000)
    return () => window.clearInterval(timer)
  }, [loadRealUsage])

  const handleRefreshRealUsage = async () => {
    setIsRefreshingRealUsage(true)
    try {
      const loaded = await loadRealUsage(true)
      notify(
        loaded ? 'Uso real do Codex atualizado.' : 'Não foi possível atualizar o uso real do Codex.',
        loaded ? 'success' : 'error'
      )
    } finally {
      setIsRefreshingRealUsage(false)
    }
  }

  // Sincronizar um repositório
  const handleSyncProject = async (projectPath: string) => {
    if (!window.devorbit) return
    try {
      const result = await window.devorbit.syncGit(projectPath)
      if (result.success) {
        notify(result.message, 'success')
      } else {
        notify(result.message, 'error')
      }
      // Atualiza lista em segundo plano
      const updated = await window.devorbit.getProjects()
      applyProjects(updated)
    } catch (err: any) {
      notify(`Erro na sincronização: ${err.message}`, 'error')
    }
  }

  const handleStashSyncProject = async (projectPath: string) => {
    if (!window.devorbit) return
    try {
      const result = await window.devorbit.stashSyncGit(projectPath)
      notify(result.message, result.success ? 'success' : 'error')
      const updated = await window.devorbit.getProjects()
      applyProjects(updated)
    } catch (err: any) {
      notify(`Erro na sincronização com stash: ${err.message}`, 'error')
    }
  }

  const handleRestoreProject = async (project: Project) => {
    if (!window.devorbit) return
    try {
      const result = await window.devorbit.restoreManagedProject(project.path)
      notify(result.message || (result.success ? 'Projeto baixado.' : 'Não foi possível baixar o projeto.'), result.success ? 'success' : 'error')
      if (result.success) await handleRefresh()
    } catch (err: any) {
      notify(`Erro ao baixar projeto: ${err.message || 'falha desconhecida'}`, 'error')
    }
  }

  const handleFinalizeProject = async (project: Project) => {
    if (!window.devorbit) return
    try {
      const result = await window.devorbit.finalizeManagedProject(project.path, {
        allowRecreatableIgnored: true,
      })
      notify(result.message, result.success ? 'success' : 'error')
      if (result.success) await handleRefresh()
    } catch (err: any) {
      notify(`Erro ao liberar espaço: ${err.message || 'falha desconhecida'}`, 'error')
    }
  }

  // Sincronizar todos os repositórios
  const handleSyncAll = async () => {
    if (!window.devorbit) return
    setIsSyncingAll(true)
    const unsubscribe = window.devorbit.onSyncProgress((progress) => {
      notify(`Sincronizando ${progress.done}/${progress.total} repositórios…`, 'info')
    })
    try {
      const results = await window.devorbit.syncAllGit()
      const entries = Object.values(results)
      const total = entries.length
      const failed = entries.filter((result) => !result.success).length
      const succeeded = total - failed

      if (total === 0) {
        notify('Nenhum repositório Git encontrado para sincronizar.', 'info')
      } else if (failed === 0) {
        notify(
          `Sincronização concluída com sucesso em ${succeeded} repositório(s)!`,
          'success'
        )
      } else if (succeeded === 0) {
        notify(`Falha ao sincronizar os ${failed} repositório(s).`, 'error')
      } else {
        notify(
          `${succeeded} repositório(s) sincronizado(s); ${failed} falharam.`,
          'error'
        )
      }

      const refreshed = await window.devorbit.getProjects()
      applyProjects(refreshed)
    } catch (err: any) {
      notify(`Erro ao sincronizar todos: ${err.message}`, 'error')
    } finally {
      unsubscribe()
      setIsSyncingAll(false)
    }
  }

  // Alternar conta do ChatGPT
  const handleToggleAccount = async () => {
    if (!config || !window.devorbit || accountSwitchInFlightRef.current) return
    const nextAccount =
      config.activeChatGptAccount === 'account1' ? 'account2' : 'account1'
    accountSwitchInFlightRef.current = true
    setIsSwitchingAccount(true)
    try {
      // Open the dedicated browser profile first. If the browser cannot be
      // started, keep the previous account active instead of creating a
      // misleading partial switch.
      const browser = nextAccount === 'account1' ? 'chrome' : 'brave'
      const opened = await window.devorbit.launchTool(browser, '', {
        account: nextAccount,
        url: 'https://chatgpt.com',
      })
      if (!opened?.success) {
        notify(opened?.message || 'Não foi possível abrir o perfil do ChatGPT.', 'error')
        return
      }

      const updated = await window.devorbit.saveConfig({
        activeChatGptAccount: nextAccount,
      })
      setConfig(updated)
      void loadRealUsage(true)
      notify(
        `ChatGPT aberto em ${
          nextAccount === 'account1'
            ? updated.chatGptAccount1Name
            : updated.chatGptAccount2Name
        }. O perfil isolado foi mantido para a próxima troca.`,
        'success'
      )
    } catch (err: any) {
      notify(`Não foi possível alternar a conta: ${err.message || 'erro desconhecido'}`, 'error')
    } finally {
      accountSwitchInFlightRef.current = false
      setIsSwitchingAccount(false)
    }
  }

  const handleSwitchBranch = async (projectPath: string, branch: string): Promise<SyncResult> => {
    if (!window.devorbit) return { success: false, message: 'A ponte do DevOrbit não está disponível.' }
    const result = await window.devorbit.switchGitBranch(projectPath, branch)
    if (result.success) await refreshProjectsQuietly()
    return result
  }

  const handleStashSwitchBranch = async (projectPath: string, branch: string): Promise<SyncResult> => {
    if (!window.devorbit) return { success: false, message: 'A ponte do DevOrbit não está disponível.' }
    const result = await window.devorbit.stashSwitchGitBranch(projectPath, branch)
    if (result.success) await refreshProjectsQuietly()
    return result
  }

  // Salvar configurações vindas do modal
  const handleSaveConfig = async (updates: Partial<AppConfig>) => {
    if (!window.devorbit) return
    const saved = await window.devorbit.saveConfig(updates)
    setConfig(saved)
    await handleRefresh()
  }
  const openIntegratedWorkspace = (project: Project) => {
    setWorkspaceProjects((current) => {
      const existingIndex = current.findIndex((item) => item.id === project.id)
      if (existingIndex < 0) return [...current, project]
      if (current[existingIndex] === project) return current
      return current.map((item) => item.id === project.id ? project : item)
    })
    setActiveWorkspaceProject(project)
    setWorkspaceView('workspace')
  }

  const selectWorkspaceProject = (project: Project) => {
    setActiveWorkspaceProject(project)
    setWorkspaceView('workspace')
  }

  const closeIntegratedWorkspace = () => {
    if (!activeWorkspaceProject) return
    const remaining = workspaceProjects.filter((item) => item.id !== activeWorkspaceProject.id)
    setWorkspaceProjects(remaining)
    setWorkspaceDirty((current) => {
      const { [activeWorkspaceProject.id]: _closedProject, ...remainingDirty } = current
      return remainingDirty
    })
    const nextProject = remaining[remaining.length - 1]
    setActiveWorkspaceProject(nextProject || null)
    if (!nextProject) setWorkspaceView('projects')
  }

  // Companion: toast com ação Ver ambiente abre o projeto dono do terminal.
  // Efeito após openIntegratedWorkspace para não acessar a const na TDZ.
  useEffect(() => {
    if (!window.devorbit?.onCompanionEvent) return
    const unsubscribe = window.devorbit.onCompanionEvent((summary) => {
      notify(`${summary.title}: ${summary.message} ${summary.suggestion}`, summary.outcome === 'completed' ? 'success' : summary.outcome === 'blocked' ? 'error' : 'info', {
        actions: summary.actions,
        onAction: (id) => {
          if (id === 'view-workspace') {
            const owner = summary.projectPath
              ? projects.find((project) => project.path === summary.projectPath)
              : undefined
            if (owner) openIntegratedWorkspace(owner)
            else setWorkspaceView('workspace')
          }
          setNotification(null)
        },
      })
    })
    return unsubscribe
  }, [notify, openIntegratedWorkspace, projects])

  useEffect(() => {
    const warnAboutDrafts = (event: BeforeUnloadEvent) => {
      if (!Object.values(workspaceDirty).some(Boolean)) return
      if (window.confirm('Há arquivos com alterações não salvas. Fechar o DevOrbit e descartar esses rascunhos?')) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnAboutDrafts)
    return () => window.removeEventListener('beforeunload', warnAboutDrafts)
  }, [workspaceDirty])

  const handleProjectAccountChange = async (project: Project, account: 'account1' | 'account2') => {
    if (!window.devorbit || !config) return
    try {
      const saved = await window.devorbit.saveConfig({
        projectAccounts: { ...config.projectAccounts, [project.id]: account },
      })
      setConfig(saved)
      notify(`Conta do Codex definida para ${project.name}.`, 'success')
    } catch (err) {
      notify(`Não foi possível salvar a conta do projeto: ${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  // GitDock não-bloqueante (FASE 1): substitui os 4 modais Git*Modal.
  const openGitDock = useCallback((tab: GitDockTab, project?: Project | null) => {
    if (project !== undefined) setGitDockProject(project)
    setGitDockTab(tab)
    setIsGitDockOpen(true)
  }, [])

  // Command Center (FASE 2): navegação G + tecla e criação C + tecla.
  // Abrir a paleta nunca desmonta workspaces/terminais; só alterna o overlay.
  // G+C/G+T forçam canvas (+ terminal primário) via uiRequest explícito, mesmo
  // com projeto salvo em grid ou terminal oculto.
  const handlePaletteNavigate = useCallback((action: NavigateActionId) => {
    const fallbackProject = activeWorkspaceProject || projects[0] || null
    if (action === 'nav-projects') setWorkspaceView('projects')
    else if (action === 'nav-canvas' || action === 'nav-terminal') {
      if (fallbackProject) {
        setWorkspaceProjects((current) => current.some((item) => item.id === fallbackProject.id) ? current : [...current, fallbackProject])
        setActiveWorkspaceProject(fallbackProject)
        setWorkspaceUiRequest(buildWorkspaceUiRequest(fallbackProject.id, {
          forceCanvas: true,
          showTerminal: action === 'nav-terminal',
        }))
      }
      setWorkspaceView('workspace')
    } else if (action === 'nav-git') openGitDock('push', fallbackProject)
    else if (action === 'nav-memory') {
      if (fallbackProject) setActiveMemoryProject(fallbackProject)
      else notify('Selecione um projeto para abrir a memória.', 'info')
    } else if (action === 'nav-settings') setIsSettingsOpen(true)
  }, [activeWorkspaceProject, notify, openGitDock, projects])

  // C+N/C+T usam fila pendente consumida após a montagem do canvas: no
  // primeiro uso a partir de Projetos não há WorkspaceCanvas montado, então
  // despachar evento síncrono seria perdido com notificação falsa.
  const handlePaletteCreate = useCallback((action: CreateActionId) => {
    const fallbackProject = activeWorkspaceProject || projects[0] || null
    if (action === 'create-agent-terminal' || action === 'create-note') {
      if (!fallbackProject) {
        notify('Abra um projeto antes de criar nós no canvas.', 'info')
        return
      }
      setWorkspaceProjects((current) => current.some((item) => item.id === fallbackProject.id) ? current : [...current, fallbackProject])
      setActiveWorkspaceProject(fallbackProject)
      setWorkspaceView('workspace')
      setWorkspaceUiRequest(buildWorkspaceUiRequest(fallbackProject.id, { forceCanvas: true, showTerminal: false }))
      setPendingCanvasNode(buildPendingCanvasNode(fallbackProject.id, action === 'create-note' ? 'note' : 'agent'))
      notify('Pedido registrado — o nó será criado ao abrir o canvas.', 'info')
    } else if (action === 'create-branch') openGitDock('branches', fallbackProject)
    else if (action === 'create-project') openGitDock('clone', null)
  }, [activeWorkspaceProject, notify, openGitDock, projects])

  const handleConsumePendingCanvasNode = useCallback((nonce: number) => {
    setPendingCanvasNode((current) => current && current.nonce === nonce ? null : current)
  }, [])

  const handleConsumeWorkspaceUiRequest = useCallback((nonce: number) => {
    setWorkspaceUiRequest((current) => current && current.nonce === nonce ? null : current)
  }, [])

  // Atalhos de teclado globais
  // Ctrl/Cmd+K alterna o Command Center em qualquer visão sem encerrar agentes:
  // workspaces, terminais PTY e tarefas permanecem montados; só o overlay abre/fecha.
  useEffect(() => {
    const isUpdateModalOpen = Boolean(
      updateState &&
      !isUpdateDismissed &&
      ['available', 'downloading', 'downloaded'].includes(updateState.status)
    )
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target
      const isEditableTarget = target instanceof HTMLElement && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      )
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const intent = resolvePaletteToggle({
          paletteOpen: isCommandPaletteOpen,
          settingsOpen: isSettingsOpen,
          toolHealthOpen: isToolHealthOpen,
          authOpen: Boolean(authModalAccount),
          memoryOpen: Boolean(activeMemoryProject),
          updateModalOpen: isUpdateModalOpen,
        })
        if (intent === 'open') openCommandPalette()
        else if (intent === 'close') closeCommandPalette()
        return
      } else if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault()
        if (isCommandPaletteOpen || isSettingsOpen || isToolHealthOpen || authModalAccount || activeMemoryProject || isUpdateModalOpen) return
        setIsSettingsOpen(true)
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        if (isCommandPaletteOpen || isSettingsOpen || isToolHealthOpen || authModalAccount || activeMemoryProject || isUpdateModalOpen || isEditableTarget) return
        void handleRefresh()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeMemoryProject, authModalAccount, closeCommandPalette, isCommandPaletteOpen, isSettingsOpen, isToolHealthOpen, isUpdateDismissed, openCommandPalette, updateState])

  // Atalho global com o WebContentsView nativo focado: a página consome o
  // teclado e o listener acima nunca dispara. O main encaminha Ctrl/Cmd+K via
  // webEvent 'palette-shortcut' (sem navegar nem recarregar); aqui só alterna
  // o overlay, preservando workspaces, terminais e sessão web.
  useEffect(() => {
    if (!window.devorbit) return
    const isUpdateModalOpen = Boolean(
      updateState &&
      !isUpdateDismissed &&
      ['available', 'downloading', 'downloaded'].includes(updateState.status)
    )
    const unsubscribe = window.devorbit.onWebEvent((event) => {
      if (event.type !== 'palette-shortcut') return
      const intent = resolvePaletteToggle({
        paletteOpen: isCommandPaletteOpen,
        settingsOpen: isSettingsOpen,
        toolHealthOpen: isToolHealthOpen,
        authOpen: Boolean(authModalAccount),
        memoryOpen: Boolean(activeMemoryProject),
        updateModalOpen: isUpdateModalOpen,
      })
      if (intent === 'open') openCommandPalette()
      else if (intent === 'close') closeCommandPalette()
    })
    return unsubscribe
  }, [activeMemoryProject, authModalAccount, closeCommandPalette, isCommandPaletteOpen, isSettingsOpen, isToolHealthOpen, isUpdateDismissed, openCommandPalette, updateState])

  const gitProjectsCount = projects.filter((p) => p.git.isRepo).length
  const isUpdateModalOpen = Boolean(
    updateState &&
    !isUpdateDismissed &&
    !isSettingsOpen &&
    !isToolHealthOpen &&
    !authModalAccount &&
    !activeMemoryProject &&
    !isCommandPaletteOpen &&
    ['available', 'downloading', 'downloaded'].includes(updateState.status)
  )
  // O WebContentsView nativo pinta acima do DOM: com o Command Center aberto a
  // view nativa é ocultada (preservando URL/histórico/sessão) para o overlay e
  // o input ficarem utilizáveis; ao fechar, a visibilidade é restaurada.
  const isWorkspaceWebSuppressed = computeWebSuppressed({
    workspaceView,
    settingsOpen: isSettingsOpen,
    toolHealthOpen: isToolHealthOpen,
    authOpen: Boolean(authModalAccount),
    memoryOpen: Boolean(activeMemoryProject),
    paletteOpen: isCommandPaletteOpen,
    updateModalOpen: isUpdateModalOpen,
  })

  if (bootstrapError) {
    return (
      <main className="min-h-screen bg-[#f5f5f2] px-6 py-16 text-stone-900" role="alert">
        <div className="mx-auto flex max-w-lg flex-col items-center rounded-xl border border-red-200 bg-white p-8 text-center shadow-sm">
          <AlertCircle aria-hidden="true" className="h-10 w-10 text-red-700" />
          <h1 className="mt-4 text-xl font-semibold">Não foi possível iniciar o DevOrbit</h1>
          <p className="mt-3 text-sm leading-6 text-stone-600">{bootstrapError}</p>
          <button
            type="button"
            className="mt-6 inline-flex items-center gap-2 rounded-md bg-[#3e562f] px-4 py-2 text-sm font-semibold text-white hover:bg-[#304624] disabled:cursor-wait disabled:opacity-60"
            onClick={() => void loadData()}
            disabled={isLoading}
          >
            <RefreshCw aria-hidden="true" className={isLoading ? 'h-4 w-4 motion-safe:animate-spin' : 'h-4 w-4'} />
            {isLoading ? 'Tentando novamente…' : 'Tentar novamente'}
          </button>
        </div>
      </main>
    )
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <Header search={search} setSearch={(value) => {setSearch(value); setWorkspaceView('projects')}}
        onOpenCommandPalette={openCommandPalette} onRefresh={handleRefresh} isRefreshing={isRefreshing}/>
      <div className="app-body">
      <aside className="workspace-sidebar" aria-label="Navegação principal">
        <div className="sidebar-heading"><span>Área de trabalho</span><button className="icon-button" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} aria-label={sidebarCollapsed ? 'Expandir navegação' : 'Recolher navegação'}>{sidebarCollapsed ? <PanelLeftOpen size={15}/> : <PanelLeftClose size={15}/>}</button></div>
        <nav>
          <button className={`nav-item ${workspaceView === 'projects' ? 'active' : ''}`} aria-current={workspaceView === 'projects' ? 'page' : undefined} title="Projetos" onClick={() => setWorkspaceView('projects')}><FolderKanban size={17}/><span>Projetos</span><small>{projects.length}</small></button>
          <button className={`nav-item ${workspaceView === 'usage' ? 'active' : ''}`} aria-current={workspaceView === 'usage' ? 'page' : undefined} title="Contas e uso" onClick={() => setWorkspaceView('usage')}><ChartNoAxesCombined size={17}/><span>Contas e uso</span></button>
          {activeWorkspaceProject && <button className={`nav-item ${workspaceView === 'workspace' ? 'active' : ''}`} aria-current={workspaceView === 'workspace' ? 'page' : undefined} title={`Ambiente integrado de ${activeWorkspaceProject.name}`} onClick={() => setWorkspaceView('workspace')}><LayoutDashboard size={17}/><span>Ambiente</span></button>}
        </nav>
        <div className="sidebar-tools"><span className="sidebar-label">Workspace</span><button className="nav-item" title="Sincronizar todos os repositórios" onClick={handleSyncAll} disabled={isSyncingAll}><GitPullRequest size={17}/><span>{isSyncingAll ? 'Sincronizando…' : 'Sincronizar Git'}</span></button><button className="nav-item" title="Configurações" onClick={() => setIsSettingsOpen(true)}><Settings size={17}/><span>Configurações</span></button><button className="nav-item" title="Diagnosticar ferramentas instaladas" onClick={() => setIsToolHealthOpen(true)}><Wrench size={17}/><span>Diagnóstico</span></button></div>
        <div className="sidebar-bottom">
          <div className="sidebar-account"><span className="account-avatar">{config?.activeChatGptAccount === 'account2' ? 'C2' : 'C1'}</span><div><strong title={config?.activeChatGptAccount === 'account2' ? config.chatGptAccount2Name : config?.chatGptAccount1Name}>{config?.activeChatGptAccount === 'account2' ? config.chatGptAccount2Name || 'Conta 2' : config?.chatGptAccount1Name || 'Conta 1'}</strong><span>{authStatus?.[config?.activeChatGptAccount || 'account1']?.connected ? 'Codex conectado' : 'Codex não conectado'}</span></div></div>
          <button className="nav-item" title="Alternar conta do ChatGPT" onClick={handleToggleAccount} disabled={isSwitchingAccount}><ArrowRightLeft size={16}/><span>{isSwitchingAccount ? 'Alternando…' : 'Alternar conta'}</span></button>
          {!authStatus?.[config?.activeChatGptAccount || 'account1']?.connected && <button className="sidebar-connect" title="Conectar Codex" onClick={() => setAuthModalAccount(config?.activeChatGptAccount || 'account1')}>Conectar Codex</button>}
        </div>
      </aside>
      <div id="main" tabIndex={-1} className="workspace-content">
      <div className="view-panel integrated-workspace-view" hidden={workspaceView !== 'workspace'}>
        {workspaceProjects.length > 0 && (
          <div className="workspace-tabs" role="tablist" aria-label="Projetos abertos">
            <div className="workspace-tab-list">
              {workspaceProjects.map((workspaceProject) => (
                <button
                  key={workspaceProject.id}
                  type="button"
                  role="tab"
                  aria-selected={activeWorkspaceProject?.id === workspaceProject.id}
                  className={'workspace-tab' + (activeWorkspaceProject?.id === workspaceProject.id ? ' active' : '')}
                  onClick={() => selectWorkspaceProject(workspaceProject)}
                  title={workspaceProject.path}
                >
                  <span>{workspaceDirty[workspaceProject.id] ? '• ' : ''}{workspaceProject.name}</span>
                  <small>{workspaceProject.git.branch || 'local'}</small>
                </button>
              ))}
            </div>
            <button type="button" className="workspace-tab-projects" onClick={() => setWorkspaceView('projects')}>
              <FolderKanban size={13} aria-hidden="true" /> Projetos
            </button>
          </div>
        )}
        <div className="workspace-tab-panes">
          {workspaceProjects.map((workspaceProject) => (
            <div
              key={workspaceProject.id}
              className="workspace-tab-pane"
              hidden={activeWorkspaceProject?.id !== workspaceProject.id}
            >
              <Suspense fallback={<div className="workspace-loading" role="status">Carregando ambiente integrado…</div>}>
              <IntegratedWorkspace
                project={workspaceProject}
                onClose={closeIntegratedWorkspace}
                onNotify={notify}
                codexAccount={config?.projectAccounts[workspaceProject.id] || config?.activeChatGptAccount || 'account1'}
                isSuspended={activeWorkspaceProject?.id !== workspaceProject.id}
                onRequestCodexAuth={setAuthModalAccount}
                isWebSuppressed={isWorkspaceWebSuppressed || activeWorkspaceProject?.id !== workspaceProject.id}
                onDirtyChange={(dirty) => setWorkspaceDirty((current) => current[workspaceProject.id] === dirty ? current : { ...current, [workspaceProject.id]: dirty })}
                onCanvasFocusChange={activeWorkspaceProject?.id === workspaceProject.id ? setFocusedCanvasNode : undefined}
                uiRequest={workspaceUiRequest && workspaceUiRequest.projectId === workspaceProject.id ? workspaceUiRequest : null}
                onUiRequestConsumed={handleConsumeWorkspaceUiRequest}
                pendingCanvasNode={pendingCanvasNode && pendingCanvasNode.projectId === workspaceProject.id ? pendingCanvasNode : null}
                onPendingCanvasNodeConsumed={handleConsumePendingCanvasNode}
              />
              </Suspense>
            </div>
          ))}
        </div>
      </div>
      <div className="view-panel" hidden={workspaceView !== 'usage'}>
      <UsageBar
        config={config}
        onSwitchAccount={handleToggleAccount}
        isSwitchingAccount={isSwitchingAccount}
        realUsage={realUsage}
        onRefreshRealUsage={handleRefreshRealUsage}
        isRefreshingRealUsage={isRefreshingRealUsage}
      />

      </div>
      <div className="view-panel" hidden={workspaceView !== 'projects'}>
      {/* Grid de Projetos */}
      <ProjectGrid
        projects={projects}
        otherDirs={otherDirs}
        config={config}
        search={search}
        onSync={handleSyncProject}
        onStashSync={handleStashSyncProject}
        onOpenPushModal={(project) => openGitDock('push', project)}
        onOpenGitInit={(project) => openGitDock('init', project)}
        onNotify={notify}
        isLoading={isLoading}
        onOpenAuthModal={(acc) => setAuthModalAccount(acc)}
        onOpenMemory={(project) => setActiveMemoryProject(project)}
        onOpenBranches={(project) => openGitDock('branches', project)}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenClone={() => openGitDock('clone', null)}
        onRestoreProject={handleRestoreProject}
        onFinalizeProject={handleFinalizeProject}
        onProjectAccountChange={handleProjectAccountChange}
        onOpenWorkspace={openIntegratedWorkspace}
      />

      </div>
      </div>
      {isGitDockOpen && (
        <GitDock
          isOpen={isGitDockOpen}
          initialTab={gitDockTab}
          project={gitDockProject}
          config={config}
          onClose={() => setIsGitDockOpen(false)}
          onNotify={notify}
          onProjectUpdated={refreshProjectsQuietly}
          onSwitch={handleSwitchBranch}
          onStashSwitch={handleStashSwitchBranch}
          onPreview={(projectPath, branch) => window.devorbit.getGitInitPreview(projectPath, branch)}
          onInit={(projectPath, options) => window.devorbit.initGitRepository(projectPath, options)}
          onCloned={handleRefresh}
          onPushSuccess={handleRefresh}
        />
      )}
      </div>
      <footer className="app-statusbar"><span><span className={`status-dot ${isLoading ? 'loading' : ''}`}/>{isLoading ? 'Carregando workspace' : `${projects.length} projetos · ${gitProjectsCount} repositórios`}{updateState?.distribution === 'portable' ? ' · portable · atualização automática' : ''}</span><span>Dados locais <span aria-hidden="true">·</span> <kbd>Ctrl K</kbd> Ações rápidas <span aria-hidden="true">·</span> <kbd>Ctrl R</kbd> Atualizar</span></footer>
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={closeCommandPalette}
        projects={projects}
        search={search}
        onSearchChange={(value) => {setSearch(value); setWorkspaceView('projects')}}
        onRefresh={handleRefresh}
        onSyncAll={handleSyncAll}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenClone={() => openGitDock('clone', null)}
        onToggleAccount={handleToggleAccount}
        activeAccountLabel={
          config?.activeChatGptAccount === 'account2'
            ? config.chatGptAccount2Name || 'Conta 2 (Brave)'
            : config?.chatGptAccount1Name || 'Conta 1 (Chrome)'
        }
        isRefreshing={isRefreshing}
        isSyncingAll={isSyncingAll}
        isSwitchingAccount={isSwitchingAccount}
        focusedNode={focusedCanvasNode}
        onNavigate={handlePaletteNavigate}
        onCreate={handlePaletteCreate}
      />

      {/* Modal de Memória da Sessão & Handoff (estilo Akita AI Memory) */}
      <AiMemoryModal
        isOpen={Boolean(activeMemoryProject)}
        project={activeMemoryProject}
        onClose={() => setActiveMemoryProject(null)}
        onNotify={notify}
      />

      <UpdateModal
        state={updateState}
        isOpen={isUpdateModalOpen}
        onClose={() => setIsUpdateDismissed(true)}
        onDownload={handleDownloadUpdate}
        onInstall={handleInstallUpdate}
      />

      <ToolHealthModal isOpen={isToolHealthOpen} onClose={() => setIsToolHealthOpen(false)} />

      {/* Modal de Configurações */}
      <SettingsModal
        // Keep the draft mounted but suspend its dialog while the auth dialog is open.
        // This guarantees that only one modal owns Escape, focus and inert state.
        isOpen={isSettingsOpen}
        suspended={Boolean(authModalAccount)}
        onClose={() => setIsSettingsOpen(false)}
        config={config}
        onSaveConfig={handleSaveConfig}
        onNotify={notify}
        authStatus={authStatus}
        onOpenAuthModal={(acc) => setAuthModalAccount(acc)}
      />

      {/* Modal de Conexão Assistida do OpenAI Codex */}
      {authModalAccount && (
        <CodexAuthModal
          isOpen={Boolean(authModalAccount)}
          account={authModalAccount}
          onClose={() => setAuthModalAccount(null)}
          onSuccess={() => {
            loadAuthStatus()
            notify(
              `Conta ${
                authModalAccount === 'account2' ? '2 (Brave)' : '1 (Chrome)'
              } conectada com sucesso!`,
              'success'
            )
            setAuthModalAccount(null)
          }}
          config={config}
        />
      )}

      {/* Toast Notification */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {notification?.type !== 'error' ? notification?.message ?? '' : ''}
      </div>
      <div className="sr-only" role="alert" aria-atomic="true">
        {notification?.type === 'error' ? notification.message : ''}
      </div>
      {notification && (
        <div
          className={`app-toast fixed bottom-10 end-5 z-50 flex max-w-[min(28rem,calc(100vw-2rem))] items-center gap-2.5 rounded-lg border px-4 py-3 text-sm shadow-lg ${
            notification.type === 'success'
              ? 'border-emerald-700/30 bg-white'
              : notification.type === 'error'
                ? 'border-red-700/30 bg-white'
                : 'border-stone-300 bg-white'
          }`}
          role="group"
          aria-label="Notificação"
        >
          {notification.type === 'success' && (
            <CheckCircle2 aria-hidden="true" className="w-4 h-4 text-emerald-800 shrink-0" />
          )}
          {notification.type === 'error' && (
            <AlertCircle aria-hidden="true" className="w-4 h-4 text-red-800 shrink-0" />
          )}
          {notification.type === 'info' && (
            <Info aria-hidden="true" className="w-4 h-4 text-stone-700 shrink-0" />
          )}
          <span className="text-pretty font-medium text-stone-800">{notification.message}</span>
          {notification.actions?.map((action) => (
            <button
              key={action.id}
              onClick={() => notificationActionRef.current?.(action.id)}
              className="ms-1 inline-flex min-h-8 items-center justify-center rounded-lg bg-[#3e562f] px-3 text-xs font-semibold text-white transition-[background-color] hover:bg-[#334827]"
            >
              {action.label}
            </button>
          ))}
          <button
            onClick={() => setNotification(null)}
            aria-label="Fechar notificação"
            className="ms-2 inline-flex min-h-8 min-w-8 items-center justify-center rounded-lg text-stone-600 transition-[color,background-color] hover:bg-stone-100 hover:text-stone-900"
          >
            <X aria-hidden="true" className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

export default App
