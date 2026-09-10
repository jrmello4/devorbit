import React, { useState, useEffect, useCallback } from 'react'
import { Header } from './components/Header'
import { ProjectGrid } from './components/ProjectGrid'
import { SettingsModal } from './components/SettingsModal'
import { GitPushModal } from './components/GitPushModal'
import { CodexAuthModal } from './components/CodexAuthModal'
import { UsageBar } from './components/UsageBar'
import { AiMemoryModal } from './components/AiMemoryModal'
import type { Project, AppConfig, CodexAccountStatus, UsageTrackerState } from './types'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'

export const App: React.FC = () => {
  const [projects, setProjects] = useState<Project[]>([])
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [authStatus, setAuthStatus] = useState<CodexAccountStatus | null>(null)
  const [authModalAccount, setAuthModalAccount] = useState<'account1' | 'account2' | null>(null)
  const [usageState, setUsageState] = useState<UsageTrackerState | null>(null)
  const [activeMemoryProject, setActiveMemoryProject] = useState<Project | null>(null)
  const [search, setSearch] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isSyncingAll, setIsSyncingAll] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [pushProject, setPushProject] = useState<Project | null>(null)
  const [notification, setNotification] = useState<{
    message: string
    type: 'success' | 'error' | 'info'
  } | null>(null)

  const notify = useCallback(
    (message: string, type: 'success' | 'error' | 'info' = 'info') => {
      setNotification({ message, type })
      setTimeout(() => {
        setNotification((current) => (current?.message === message ? null : current))
      }, 4000)
    },
    []
  )

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

  // Refresh projects on demand
  const handleRefresh = async () => {
    setIsRefreshing(true)
    try {
      if (window.devorbit) {
        const [refreshed] = await Promise.all([
          window.devorbit.refreshProjects(),
          loadAuthStatus(),
          loadUsage(),
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
      const total = Object.keys(results).length
      notify(`Sincronização concluída em ${total} repositórios!`, 'success')
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
    if (!config || !window.devorbit) return
    const nextAccount =
      config.activeChatGptAccount === 'account1' ? 'account2' : 'account1'
    const updated = await window.devorbit.saveConfig({
      activeChatGptAccount: nextAccount,
    })
    setConfig(updated)
    notify(
      `ChatGPT alterado para: ${
        nextAccount === 'account1'
          ? updated.chatGptAccount1Name
          : updated.chatGptAccount2Name
      }`,
      'info'
    )
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
        const searchInput = document.querySelector('input[type="text"]') as HTMLInputElement
        searchInput?.focus()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        handleRefresh()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const gitProjectsCount = projects.filter((p) => p.git.isRepo).length

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#090d16] text-slate-100 antialiased font-sans">
      {/* Header com barra de título e controles */}
      <Header
        search={search}
        setSearch={setSearch}
        onRefresh={handleRefresh}
        onSyncAll={handleSyncAll}
        onOpenSettings={() => setIsSettingsOpen(true)}
        config={config}
        onToggleAccount={handleToggleAccount}
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
      />

      {/* Grid de Projetos */}
      <ProjectGrid
        projects={projects}
        config={config}
        search={search}
        onSync={handleSyncProject}
        onOpenPushModal={setPushProject}
        onNotify={notify}
        isLoading={isLoading}
        onOpenAuthModal={(acc) => setAuthModalAccount(acc)}
        onOpenMemory={(project) => setActiveMemoryProject(project)}
        onUsageUpdate={loadUsage}
      />

      {/* Modal de Memória da Sessão & Handoff (estilo Akita AI Memory) */}
      <AiMemoryModal
        isOpen={Boolean(activeMemoryProject)}
        project={activeMemoryProject}
        onClose={() => setActiveMemoryProject(null)}
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

      {/* Modal de Configurações */}
      <SettingsModal
        isOpen={isSettingsOpen}
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
      {notification && (
        <div className="fixed bottom-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-slate-900/95 border border-slate-700/80 shadow-2xl text-xs backdrop-blur-md animate-in fade-in slide-in-from-bottom-3 duration-200">
          {notification.type === 'success' && (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          )}
          {notification.type === 'error' && (
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
          )}
          {notification.type === 'info' && (
            <Info className="w-4 h-4 text-indigo-400 shrink-0" />
          )}
          <span className="text-slate-200 font-medium">{notification.message}</span>
          <button
            onClick={() => setNotification(null)}
            className="text-slate-500 hover:text-slate-300 ml-2"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

export default App
