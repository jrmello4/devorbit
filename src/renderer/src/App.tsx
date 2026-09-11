import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Header } from './components/Header'
import { ProjectGrid } from './components/ProjectGrid'
import { SettingsModal } from './components/SettingsModal'
import { GitPushModal } from './components/GitPushModal'
import { CodexAuthModal } from './components/CodexAuthModal'
import { UsageBar } from './components/UsageBar'
import { AiMemoryModal } from './components/AiMemoryModal'
import { GitInitModal } from './components/GitInitModal'
import { GitBranchModal } from './components/GitBranchModal'
import { CommandPalette } from './components/CommandPalette'
import type {
  Project,
  AppConfig,
  CodexAccountStatus,
  UsageTrackerState,
  RealUsageState,
  SyncResult,
} from './types'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'

export const App: React.FC = () => {
  const [projects, setProjects] = useState<Project[]>([])
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [authStatus, setAuthStatus] = useState<CodexAccountStatus | null>(null)
  const [authModalAccount, setAuthModalAccount] = useState<'account1' | 'account2' | null>(null)
  const [usageState, setUsageState] = useState<UsageTrackerState | null>(null)
  const [realUsage, setRealUsage] = useState<RealUsageState | null>(null)
  const [activeMemoryProject, setActiveMemoryProject] = useState<Project | null>(null)
  const [activeBranchProject, setActiveBranchProject] = useState<Project | null>(null)
  const [search, setSearch] = useState('')
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isSyncingAll, setIsSyncingAll] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [pushProject, setPushProject] = useState<Project | null>(null)
  const [gitInitProject, setGitInitProject] = useState<Project | null>(null)
  const [isSwitchingAccount, setIsSwitchingAccount] = useState(false)
  const [isRefreshingRealUsage, setIsRefreshingRealUsage] = useState(false)
  const accountSwitchInFlightRef = useRef(false)
  const [notification, setNotification] = useState<{
    message: string
    type: 'success' | 'error' | 'info'
  } | null>(null)
  const notificationTimerRef = useRef<number | null>(null)

  const notify = useCallback(
    (message: string, type: 'success' | 'error' | 'info' = 'info') => {
      if (notificationTimerRef.current) {
        window.clearTimeout(notificationTimerRef.current)
        notificationTimerRef.current = null
      }
      setNotification({ message, type })
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

  // Load initial data
  const loadAuthStatus = useCallback(async () => {
    try {
      if (window.devorbit) {
        const status = await window.devorbit.getCodexAuthStatus()
        setAuthStatus(status)
      }
    } catch (err: any) {
      console.error('Falha ao carregar status do Codex:', err)
    }
  }, [])

  const loadUsage = useCallback(async () => {
    try {
      if (window.devorbit) {
        const usage = await window.devorbit.getUsageState()
        setUsageState(usage)
      }
    } catch (err: any) {
      console.error('Falha ao carregar uso:', err)
    }
  }, [])

  const loadRealUsage = useCallback(async (force = false) => {
    try {
      if (window.devorbit) {
        const usage = await window.devorbit.getRealUsage(force)
        setRealUsage(usage)
      }
    } catch (err: any) {
      console.error('Falha ao carregar uso real da OpenAI:', err)
    }
  }, [])

  const loadData = useCallback(async () => {
    console.log('[App] loadData called. window.devorbit available:', Boolean(window.devorbit))
    try {
      if (window.devorbit) {
        console.log('[App] Calling Promise.all for config, projects, auth, usage...')
        const [loadedConfig, loadedProjects, loadedAuth, loadedUsage] = await Promise.all([
          window.devorbit.getConfig(),
          window.devorbit.getProjects(),
          window.devorbit.getCodexAuthStatus(),
          window.devorbit.getUsageState(),
        ])
        console.log('[App] Loaded successfully! Projects count:', loadedProjects?.length)
        setConfig(loadedConfig)
        setProjects(loadedProjects)
        setAuthStatus(loadedAuth)
        setUsageState(loadedUsage)
      } else {
        console.warn('[App] window.devorbit is UNDEFINED! Preload failed or contextIsolation issue.')
      }
    } catch (err: any) {
      console.error('[App] Error in loadData:', err)
      notify(`Erro ao carregar projetos: ${err.message}`, 'error')
    } finally {
      setIsLoading(false)
    }
  }, [notify])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    if (!isLoading) void loadRealUsage()
  }, [isLoading, loadRealUsage])

  // Refresh projects on demand
  const handleRefresh = async () => {
    setIsRefreshing(true)
    try {
      if (window.devorbit) {
        const [refreshed] = await Promise.all([
          window.devorbit.refreshProjects(),
          loadAuthStatus(),
          loadUsage(),
          loadRealUsage(true),
        ])
        setProjects(refreshed)
        notify('Lista de projetos atualizada!', 'success')
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
      setProjects(await window.devorbit.getProjects())
    } catch (err) {
      console.error('[App] Erro ao atualizar projetos após operação Git:', err)
    }
  }, [])

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

  // Ações da Barra de Uso (Cotas)
  const handleIncrementUsage = async (target: 'account1' | 'account2' | 'antigravity') => {
    if (!window.devorbit) return
    try {
      const updated = await window.devorbit.incrementUsage(target)
      setUsageState(updated)
    } catch (err: any) {
      console.error(err)
    }
  }

  const handleDecrementUsage = async (target: 'account1' | 'account2') => {
    if (!window.devorbit) return
    try {
      const updated = await window.devorbit.decrementUsage(target)
      setUsageState(updated)
    } catch (err: any) {
      console.error(err)
    }
  }

  const handleResetUsage = async (target: 'account1' | 'account2') => {
    if (!window.devorbit) return
    try {
      const updated = await window.devorbit.resetUsage(target)
      setUsageState(updated)
      notify(`Janela de uso de ${target === 'account1' ? 'Conta 1' : 'Conta 2'} zerada!`, 'success')
    } catch (err: any) {
      console.error(err)
    }
  }

  const handleUpdateUsageLimit = async (account: 'account1' | 'account2', limit: number) => {
    if (!window.devorbit) return
    try {
      const updated = await window.devorbit.updateUsageLimits(account, limit)
      setUsageState(updated)
      notify(`Limite de ${account === 'account1' ? 'Conta 1' : 'Conta 2'} atualizado para ${limit}!`, 'info')
    } catch (err: any) {
      console.error(err)
    }
  }

  const handleRefreshRealUsage = async () => {
    setIsRefreshingRealUsage(true)
    try {
      await loadRealUsage(true)
      notify('Uso real do Codex atualizado.', 'success')
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
      setProjects(updated)
    } catch (err: any) {
      notify(`Erro na sincronização: ${err.message}`, 'error')
    }
  }

  // Sincronizar todos os repositórios
  const handleSyncAll = async () => {
    if (!window.devorbit) return
    setIsSyncingAll(true)
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
      setProjects(refreshed)
    } catch (err: any) {
      notify(`Erro ao sincronizar todos: ${err.message}`, 'error')
    } finally {
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

  // Salvar configurações vindas do modal
  const handleSaveConfig = async (updates: Partial<AppConfig>) => {
    if (!window.devorbit) return
    const saved = await window.devorbit.saveConfig(updates)
    setConfig(saved)
    await handleRefresh()
  }

  // Atalhos de teclado globais
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (isSettingsOpen || authModalAccount || pushProject || gitInitProject || activeMemoryProject || activeBranchProject) return
        setIsCommandPaletteOpen(true)
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        handleRefresh()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeBranchProject, activeMemoryProject, authModalAccount, gitInitProject, isSettingsOpen, pushProject])

  const gitProjectsCount = projects.filter((p) => p.git.isRepo).length

  return (
    <div className="relative isolate flex h-screen w-screen flex-col overflow-hidden bg-transparent font-sans text-slate-100 antialiased">
      {/* Header com barra de título e controles */}
      <Header
        search={search}
        setSearch={setSearch}
        onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
        onRefresh={handleRefresh}
        onSyncAll={handleSyncAll}
        onOpenSettings={() => setIsSettingsOpen(true)}
        config={config}
        onToggleAccount={handleToggleAccount}
        isSwitchingAccount={isSwitchingAccount}
        isRefreshing={isRefreshing}
        isSyncingAll={isSyncingAll}
        totalProjects={projects.length}
        gitProjectsCount={gitProjectsCount}
        authStatus={authStatus}
        onOpenAuthModal={(acc) => setAuthModalAccount(acc)}
      />

      {/* Barra de Monitoramento de Cotas & Smart Handoff (estilo Akita AI UsageBar) */}
      <UsageBar
        usage={usageState}
        config={config}
        onIncrement={handleIncrementUsage}
        onDecrement={handleDecrementUsage}
        onReset={handleResetUsage}
        onUpdateLimit={handleUpdateUsageLimit}
        onSwitchAccount={handleToggleAccount}
        isSwitchingAccount={isSwitchingAccount}
        realUsage={realUsage}
        onRefreshRealUsage={handleRefreshRealUsage}
        isRefreshingRealUsage={isRefreshingRealUsage}
      />

      {/* Grid de Projetos */}
      <ProjectGrid
        projects={projects}
        config={config}
        search={search}
        onSync={handleSyncProject}
        onOpenPushModal={setPushProject}
        onOpenGitInit={(project) => setGitInitProject(project)}
        onNotify={notify}
        isLoading={isLoading}
        onOpenAuthModal={(acc) => setAuthModalAccount(acc)}
        onOpenMemory={(project) => setActiveMemoryProject(project)}
        onOpenBranches={(project) => setActiveBranchProject(project)}
        onUsageUpdate={loadUsage}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        projects={projects}
        search={search}
        onSearchChange={setSearch}
        onRefresh={handleRefresh}
        onSyncAll={handleSyncAll}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onToggleAccount={handleToggleAccount}
        activeAccountLabel={
          config?.activeChatGptAccount === 'account2'
            ? config.chatGptAccount2Name || 'Conta 2 (Brave)'
            : config?.chatGptAccount1Name || 'Conta 1 (Chrome)'
        }
        isRefreshing={isRefreshing}
        isSyncingAll={isSyncingAll}
        isSwitchingAccount={isSwitchingAccount}
      />

      {/* Modal de Memória da Sessão & Handoff (estilo Akita AI Memory) */}
      <AiMemoryModal
        isOpen={Boolean(activeMemoryProject)}
        project={activeMemoryProject}
        onClose={() => setActiveMemoryProject(null)}
        onNotify={notify}
      />

      <GitBranchModal
        isOpen={Boolean(activeBranchProject)}
        project={activeBranchProject}
        onClose={() => setActiveBranchProject(null)}
        onSwitch={handleSwitchBranch}
        onProjectUpdated={refreshProjectsQuietly}
        onNotify={notify}
      />

      {/* Modal de Subir para o GitHub (Push) */}
      <GitPushModal
        isOpen={Boolean(pushProject)}
        project={pushProject}
        onClose={() => setPushProject(null)}
        onSuccess={handleRefresh}
        onNotify={notify}
      />

      <GitInitModal
        isOpen={Boolean(gitInitProject)}
        project={gitInitProject}
        onClose={() => setGitInitProject(null)}
        onPreview={(projectPath, branch) => window.devorbit.getGitInitPreview(projectPath, branch)}
        onInit={(projectPath, options) => window.devorbit.initGitRepository(projectPath, options)}
        onProjectUpdated={refreshProjectsQuietly}
        onNotify={notify}
      />

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
          className={`fixed bottom-5 end-5 z-50 flex max-w-[min(28rem,calc(100vw-2rem))] items-center gap-2.5 rounded-2xl border px-4 py-3 text-sm shadow-2xl backdrop-blur-md motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-200 ${
            notification.type === 'success'
              ? 'border-emerald-400/25 bg-emerald-950/80'
              : notification.type === 'error'
                ? 'border-rose-400/30 bg-rose-950/85'
                : 'border-indigo-300/25 bg-slate-950/90'
          }`}
          role="group"
          aria-label="Notificação"
        >
          {notification.type === 'success' && (
            <CheckCircle2 aria-hidden="true" className="w-4 h-4 text-emerald-400 shrink-0" />
          )}
          {notification.type === 'error' && (
            <AlertCircle aria-hidden="true" className="w-4 h-4 text-rose-400 shrink-0" />
          )}
          {notification.type === 'info' && (
            <Info aria-hidden="true" className="w-4 h-4 text-indigo-400 shrink-0" />
          )}
          <span className="text-pretty font-medium text-slate-100">{notification.message}</span>
          <button
            onClick={() => setNotification(null)}
            aria-label="Fechar notificação"
            className="ms-2 inline-flex min-h-8 min-w-8 items-center justify-center rounded-lg text-slate-400 transition-[color,background-color] hover:bg-white/10 hover:text-slate-100"
          >
            <X aria-hidden="true" className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

export default App
