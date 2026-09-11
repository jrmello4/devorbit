import React from 'react'
import {
  Search,
  RefreshCw,
  Settings,
  Minus,
  Square,
  X,
  Sparkles,
  GitPullRequest,
  CheckCircle2,
  FolderGit2,
} from 'lucide-react'
import type { AppConfig, CodexAccountStatus } from '../types'

interface HeaderProps {
  search: string
  setSearch: (value: string) => void
  onRefresh: () => void
  onSyncAll: () => void
  onOpenSettings: () => void
  config: AppConfig | null
  onToggleAccount: () => void
  isRefreshing: boolean
  isSyncingAll: boolean
  totalProjects: number
  gitProjectsCount: number
  authStatus?: CodexAccountStatus | null
  onOpenAuthModal?: (account: 'account1' | 'account2') => void
}

export const Header: React.FC<HeaderProps> = ({
  search,
  setSearch,
  onRefresh,
  onSyncAll,
  onOpenSettings,
  config,
  onToggleAccount,
  isRefreshing,
  isSyncingAll,
  totalProjects,
  gitProjectsCount,
  authStatus,
  onOpenAuthModal,
}) => {
  const isAccount1 = config?.activeChatGptAccount === 'account1'
  const isCurrentAuthed = isAccount1
    ? authStatus?.account1?.connected
    : authStatus?.account2?.connected

  return (
    <header className="titlebar-drag bg-[var(--color-bg-header)]/90 backdrop-blur-md border-b border-slate-800/80 px-4 py-2.5 flex items-center justify-between sticky top-0 z-50">
      {/* Left: Brand & Stats */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-600 via-purple-600 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/20 ring-1 ring-white/20">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold tracking-tight text-white text-base">
                DevOrbit
              </span>
              <span className="text-[10px] uppercase font-semibold tracking-wider px-1.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                Hub
              </span>
            </div>
          </div>
        </div>

        <div className="hidden lg:flex items-center gap-3 pl-2 border-l border-slate-800 text-xs text-slate-400">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 motion-safe:animate-pulse" aria-hidden="true" />
            <span className="font-medium text-slate-300">{totalProjects}</span> projetos
          </span>
          <span className="text-slate-400" aria-hidden="true">•</span>
          <span className="flex items-center gap-1.5">
            <FolderGit2 className="w-3.5 h-3.5 text-indigo-400" />
            <span className="font-medium text-slate-300">{gitProjectsCount}</span> repositórios Git
          </span>
        </div>
      </div>

      {/* Middle: Search bar */}
        <div className="titlebar-no-drag flex-1 max-w-md mx-4">
          <div className="relative flex items-center">
            <label htmlFor="project-search" className="sr-only">Buscar projetos</label>
            <Search className="w-4 h-4 text-slate-400 absolute start-3 pointer-events-none" />
            <input
              id="project-search"
              name="project-search"
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar projeto por nome, pasta ou tecnologia... (Ctrl+K)"
              autoComplete="off"
              aria-keyshortcuts="Control+K Meta+K"
              className="w-full bg-slate-900/90 text-sm text-slate-200 placeholder-slate-400 ps-9 pe-8 py-1.5 rounded-lg border border-slate-800 focus:border-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-400/70 focus-visible:outline-none transition-[border-color,box-shadow]"
            />
          {search && (
             <button
               onClick={() => setSearch('')}
               aria-label="Limpar busca"
               className="absolute end-2.5 min-w-6 min-h-6 flex items-center justify-center text-slate-400 hover:text-slate-200 p-0.5"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Right: Actions & Window Controls */}
      <div className="titlebar-no-drag flex items-center gap-2">
        {/* ChatGPT Account Switcher */}
        <div className="flex items-center gap-1">
          <button
            onClick={onToggleAccount}
            aria-pressed={isAccount1}
            aria-label={`Alternar conta do ChatGPT (atual: ${isAccount1 ? 'Conta 1' : 'Conta 2'})`}
            title="Clique para alternar entre Conta 1 e Conta 2 do ChatGPT Plus"
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-900/80 border border-slate-800 hover:border-slate-700 transition-[color,border-color,background-color] text-slate-300 hover:text-white cursor-pointer"
          >
            <span className="text-slate-400">Codex:</span>
            <span
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold transition-colors ${
                isAccount1
                  ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                  : 'bg-teal-500/20 text-teal-300 border border-teal-500/30'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isCurrentAuthed
                    ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50'
                    : 'bg-amber-400 motion-safe:animate-pulse'
                }`}
              />
              {isAccount1
                ? config?.chatGptAccount1Name || 'Conta 1 (Chrome)'
                : config?.chatGptAccount2Name || 'Conta 2 (Brave)'}
            </span>
          </button>

          {!isCurrentAuthed && onOpenAuthModal && (
            <button
              onClick={() => onOpenAuthModal(isAccount1 ? 'account1' : 'account2')}
              className="px-2 py-1.5 rounded-lg text-[11px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/30 transition-[background-color,border-color,color] cursor-pointer"
              title="Esta conta ainda não foi autenticada. Clique para conectar!"
            >
              Conectar
            </button>
          )}
        </div>

        {/* Sync All Button */}
        <button
          onClick={onSyncAll}
          disabled={isSyncingAll}
          aria-label={isSyncingAll ? 'Sincronizando todos os repositórios' : 'Sincronizar todos os repositórios com o GitHub'}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 hover:bg-indigo-600/30 hover:border-indigo-500/50 disabled:opacity-50 transition-[background-color,border-color,color,opacity] cursor-pointer"
          title="Executar git pull em todos os repositórios com alterações no GitHub"
        >
          <GitPullRequest
            className={`w-3.5 h-3.5 ${isSyncingAll ? 'motion-safe:animate-spin text-indigo-400' : ''}`}
          />
          <span className="hidden sm:inline">
            {isSyncingAll ? 'Sincronizando...' : 'Sync GitHub'}
          </span>
        </button>

        {/* Refresh List Button */}
          <button
            onClick={onRefresh}
            disabled={isRefreshing}
           aria-label="Recarregar projetos e verificar status do Git"
           className="min-w-8 min-h-8 p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/60 border border-slate-800/80 transition-[color,background-color,border-color,opacity]"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'motion-safe:animate-spin' : ''}`} />
        </button>

        {/* Settings Button */}
          <button
            onClick={onOpenSettings}
           aria-label="Abrir configurações de pastas e caminhos"
           className="min-w-8 min-h-8 p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/60 border border-slate-800/80 transition-[color,background-color,border-color]"
        >
          <Settings className="w-4 h-4" />
        </button>

        <div className="w-[1px] h-4 bg-slate-800 mx-1" />

        {/* Window controls */}
        <div className="flex items-center">
          <button
            onClick={() => window.devorbit?.windowControl('minimize')}
            aria-label="Minimizar janela"
            className="min-w-8 min-h-8 p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-[color,background-color]"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => window.devorbit?.windowControl('maximize')}
            aria-label="Maximizar janela"
            className="min-w-8 min-h-8 p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-[color,background-color]"
          >
            <Square className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => window.devorbit?.windowControl('close')}
            aria-label="Fechar janela"
            className="min-w-8 min-h-8 p-1.5 text-slate-400 hover:text-white hover:bg-red-500/80 rounded transition-[color,background-color]"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </header>
  )
}
