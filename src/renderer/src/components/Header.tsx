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
  FolderGit2,
} from 'lucide-react'
import type { AppConfig, CodexAccountStatus } from '../types'

interface HeaderProps {
  search: string
  setSearch: (value: string) => void
  onOpenCommandPalette?: () => void
  onRefresh: () => void
  onSyncAll: () => void
  onOpenSettings: () => void
  config: AppConfig | null
  onToggleAccount: () => void | Promise<void>
  isSwitchingAccount?: boolean
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
  onOpenCommandPalette,
  onRefresh,
  onSyncAll,
  onOpenSettings,
  config,
  onToggleAccount,
  isSwitchingAccount = false,
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
    <header className="titlebar-drag sticky top-0 z-50 flex min-h-16 items-center justify-between gap-3 border-b border-[var(--color-border-subtle)]/70 bg-[var(--color-bg-header)]/90 px-4 py-3 backdrop-blur-xl sm:px-5">
      {/* Left: Brand & Stats */}
      <div className="flex min-w-0 shrink-0 items-center gap-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--color-accent-strong)] shadow-lg shadow-indigo-500/20 ring-1 ring-white/20">
            <Sparkles className="h-4 w-4 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-bold tracking-tight text-white">
                DevOrbit
              </span>
              <span className="rounded-full border border-indigo-400/30 bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-200">
                Hub
              </span>
            </div>
          </div>
        </div>

        <div className="hidden items-center gap-3 border-l border-[var(--color-border-subtle)] pl-3 text-xs text-[var(--color-text-muted)] lg:flex">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-400 motion-safe:animate-pulse" aria-hidden="true" />
            <span className="tabular-nums font-semibold text-slate-200">{totalProjects}</span> projetos
          </span>
          <span className="text-slate-500" aria-hidden="true">•</span>
          <span className="flex items-center gap-1.5">
            <FolderGit2 className="h-3.5 w-3.5 text-indigo-300" />
            <span className="tabular-nums font-semibold text-slate-200">{gitProjectsCount}</span> repositórios Git
          </span>
        </div>
      </div>

      {/* Middle: Search bar */}
        <div className="titlebar-no-drag min-w-0 max-w-xl flex-1 basis-44 px-1 sm:min-w-[9rem] sm:px-4">
          <div className="relative flex items-center">
            <label htmlFor="project-search" className="sr-only">Buscar projetos</label>
            <Search className="pointer-events-none absolute start-3 h-4 w-4 text-[var(--color-text-muted)]" />
            <input
              id="project-search"
              name="project-search"
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar projetos... (Ctrl+K)"
              autoComplete="off"
              aria-keyshortcuts="Control+K Meta+K"
              className="w-full rounded-xl border border-[var(--color-border-subtle)]/90 bg-slate-950/55 py-2.5 ps-9 pe-9 text-base text-slate-100 placeholder:text-slate-500 shadow-inner shadow-black/10 transition-[border-color,box-shadow,background-color] focus:border-indigo-400/80 focus:bg-slate-950/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/30 sm:text-sm"
            />
          {search && (
             <button
               onClick={() => setSearch('')}
               aria-label="Limpar busca"
               className="absolute end-2 min-h-8 min-w-8 flex items-center justify-center rounded-lg p-1 text-slate-400 hover:bg-white/5 hover:text-slate-200"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {!search && onOpenCommandPalette && (
            <button
              type="button"
              onClick={onOpenCommandPalette}
              aria-label="Abrir ações rápidas"
              className="absolute end-2 inline-flex min-h-8 items-center rounded-lg border border-[var(--color-border-subtle)]/70 bg-slate-950/45 px-2 text-[10px] font-semibold text-slate-500 transition-[color,background-color,border-color] hover:border-indigo-400/40 hover:bg-indigo-500/10 hover:text-indigo-200"
            >
              <kbd>Ctrl K</kbd>
            </button>
          )}
        </div>
      </div>

      {/* Right: Actions & Window Controls */}
      <div className="titlebar-no-drag flex shrink-0 items-center gap-1.5 sm:gap-2">
        {/* ChatGPT Account Switcher */}
        <div className="flex min-w-0 items-center gap-1">
          <button
            onClick={() => void onToggleAccount()}
            disabled={isSwitchingAccount}
            aria-pressed={isAccount1}
            aria-busy={isSwitchingAccount}
            aria-label={`Alternar conta do ChatGPT (atual: ${isAccount1 ? 'Conta 1' : 'Conta 2'})`}
            title="Clique para alternar entre Conta 1 e Conta 2 do ChatGPT Plus"
            className="flex min-w-0 items-center gap-2 rounded-xl border border-[var(--color-border-subtle)]/90 bg-slate-950/55 px-2.5 py-2 text-xs font-semibold text-slate-300 transition-[color,border-color,background-color,opacity] hover:border-slate-600 hover:bg-slate-950/80 hover:text-white disabled:cursor-wait disabled:opacity-60 cursor-pointer"
          >
            <span className="hidden text-slate-500 xl:inline">Codex</span>
            <span
              className={`flex min-w-0 max-w-[7rem] items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-semibold transition-colors sm:max-w-[9rem] ${
                isAccount1
                  ? 'border-indigo-400/30 bg-indigo-500/15 text-indigo-200'
                  : 'border-teal-400/30 bg-teal-500/15 text-teal-200'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isCurrentAuthed
                    ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50'
                    : 'bg-amber-400 motion-safe:animate-pulse'
                }`}
              />
              <span className="truncate">{isAccount1
                ? config?.chatGptAccount1Name || 'Conta 1 (Chrome)'
                : config?.chatGptAccount2Name || 'Conta 2 (Brave)'}</span>
            </span>
          </button>

          {!isCurrentAuthed && onOpenAuthModal && (
            <button
              onClick={() => onOpenAuthModal(isAccount1 ? 'account1' : 'account2')}
              className="rounded-xl border border-amber-400/35 bg-amber-500/15 px-2.5 py-2 text-[11px] font-semibold text-amber-200 transition-[background-color,border-color,color] hover:border-amber-300/60 hover:bg-amber-500/25 cursor-pointer"
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
          className="flex min-h-10 items-center gap-1.5 rounded-xl border border-indigo-400/30 bg-indigo-500/15 px-3 text-xs font-semibold text-indigo-200 transition-[background-color,border-color,color,opacity] hover:border-indigo-300/60 hover:bg-indigo-500/25 disabled:opacity-50 cursor-pointer"
          title="Executar git pull em todos os repositórios com alterações no GitHub"
        >
          <GitPullRequest
            className={`h-3.5 w-3.5 ${isSyncingAll ? 'motion-safe:animate-spin text-indigo-300' : 'text-indigo-300'}`}
          />
          <span className="hidden lg:inline">
            {isSyncingAll ? 'Sincronizando...' : 'Sync GitHub'}
          </span>
        </button>

        {/* Refresh List Button */}
          <button
            onClick={onRefresh}
            disabled={isRefreshing}
           aria-label="Recarregar projetos e verificar status do Git"
           className="min-h-10 min-w-10 rounded-xl border border-[var(--color-border-subtle)]/80 p-2 text-slate-400 transition-[color,background-color,border-color,opacity] hover:bg-white/5 hover:text-white"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'motion-safe:animate-spin' : ''}`} />
        </button>

        {/* Settings Button */}
          <button
            onClick={onOpenSettings}
           aria-label="Abrir configurações de pastas e caminhos"
           className="min-h-10 min-w-10 rounded-xl border border-[var(--color-border-subtle)]/80 p-2 text-slate-400 transition-[color,background-color,border-color] hover:bg-white/5 hover:text-white"
        >
          <Settings className="w-4 h-4" />
        </button>

        <div className="mx-1 h-5 w-px bg-[var(--color-border-subtle)]" />

        {/* Window controls */}
        <div className="flex items-center">
          <button
            onClick={() => window.devorbit?.windowControl('minimize')}
            aria-label="Minimizar janela"
            className="min-h-9 min-w-9 rounded-lg p-2 text-slate-400 transition-[color,background-color] hover:bg-white/5 hover:text-white"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => window.devorbit?.windowControl('maximize')}
            aria-label="Maximizar janela"
            className="min-h-9 min-w-9 rounded-lg p-2 text-slate-400 transition-[color,background-color] hover:bg-white/5 hover:text-white"
          >
            <Square className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => window.devorbit?.windowControl('close')}
            aria-label="Fechar janela"
            className="min-h-9 min-w-9 rounded-lg p-2 text-slate-400 transition-[color,background-color] hover:bg-rose-500/80 hover:text-white"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </header>
  )
}
