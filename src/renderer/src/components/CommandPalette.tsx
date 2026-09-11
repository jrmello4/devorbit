import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowRightLeft,
  Command as CommandIcon,
  FolderSearch,
  GitPullRequest,
  RefreshCw,
  Search,
  Settings,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Project } from '../types'
import { AccessibleDialog } from './AccessibleDialog'

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
  projects: Project[]
  search: string
  onSearchChange: (value: string) => void
  onRefresh: () => void
  onSyncAll: () => void
  onOpenSettings: () => void
  onToggleAccount: () => void | Promise<void>
  activeAccountLabel: string
  isRefreshing?: boolean
  isSyncingAll?: boolean
  isSwitchingAccount?: boolean
}

interface PaletteItem {
  id: string
  label: string
  description: string
  shortcut?: string
  icon: LucideIcon
  onSelect: () => void | Promise<void>
}

/**
 * Local command palette primitive inspired by the composable Command patterns
 * in shadcn/ui and coss. It deliberately avoids a new runtime dependency so
 * the Electron renderer keeps its small, copy-owned component surface.
 */
export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  projects,
  search,
  onSearchChange,
  onRefresh,
  onSyncAll,
  onOpenSettings,
  onToggleAccount,
  activeAccountLabel,
  isRefreshing = false,
  isSyncingAll = false,
  isSwitchingAccount = false,
}) => {
  const [query, setQuery] = useState(search)
  const [highlightedIndex, setHighlightedIndex] = useState(0)

  useEffect(() => {
    if (!isOpen) return
    setQuery(search)
    setHighlightedIndex(0)
  }, [isOpen, search])

  const items = useMemo<PaletteItem[]>(() => {
    const normalizedQuery = query.trim().toLowerCase()
    const commands: PaletteItem[] = [
      {
        id: 'refresh',
        label: isRefreshing ? 'Atualizando projetos...' : 'Atualizar projetos',
        description: 'Ler pastas monitoradas e verificar o estado do Git',
        shortcut: 'Ctrl R',
        icon: RefreshCw,
        onSelect: onRefresh,
      },
      {
        id: 'sync',
        label: isSyncingAll ? 'Sincronizando com GitHub...' : 'Sincronizar com GitHub',
        description: 'Executar pull nos repositórios que precisam de atualização',
        icon: GitPullRequest,
        onSelect: onSyncAll,
      },
      {
        id: 'settings',
        label: 'Abrir configurações',
        description: 'Gerenciar pastas monitoradas e caminhos das ferramentas',
        shortcut: 'Ctrl ,',
        icon: Settings,
        onSelect: onOpenSettings,
      },
      {
        id: 'account',
        label: isSwitchingAccount ? 'Alternando conta...' : 'Alternar conta do ChatGPT',
        description: `Conta ativa: ${activeAccountLabel}`,
        icon: ArrowRightLeft,
        onSelect: onToggleAccount,
      },
    ]

    const commandMatches = normalizedQuery
      ? commands.filter((item) =>
          `${item.label} ${item.description}`.toLowerCase().includes(normalizedQuery)
        )
      : commands

    const projectMatches = projects
      .filter((project) => {
        if (!normalizedQuery) return true
        return `${project.name} ${project.path} ${project.parentDir}`
          .toLowerCase()
          .includes(normalizedQuery)
      })
      .slice(0, 6)
      .map<PaletteItem>((project) => ({
        id: `project-${project.id}`,
        label: project.name,
        description: project.path,
        icon: FolderSearch,
        onSelect: () => onSearchChange(project.name),
      }))

    return [...commandMatches, ...projectMatches]
  }, [
    activeAccountLabel,
    isRefreshing,
    isSyncingAll,
    isSwitchingAccount,
    onOpenSettings,
    onRefresh,
    onSearchChange,
    onSyncAll,
    onToggleAccount,
    projects,
    query,
  ])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightedIndex((current) => (current + 1) % Math.max(items.length, 1))
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightedIndex((current) => (current - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1))
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      const item = items[highlightedIndex]
      if (item) void item.onSelect()
      onClose()
    }
  }

  const selectItem = (item: PaletteItem) => {
    void item.onSelect()
    onClose()
  }

  return (
    <AccessibleDialog
      isOpen={isOpen}
      titleId="command-palette-title"
      onClose={onClose}
      className="w-full max-w-xl"
    >
      <div className="surface-panel overflow-hidden rounded-2xl">
        <div className="flex items-center gap-3 border-b border-[var(--color-border-subtle)]/70 px-4 py-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-200 ring-1 ring-indigo-400/25">
            <CommandIcon className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="command-palette-title" className="text-sm font-semibold text-white">Ações rápidas</h2>
            <p className="text-xs text-[var(--color-text-muted)]">Pesquise um projeto ou execute uma ação</p>
          </div>
          <kbd className="hidden rounded-md border border-[var(--color-border-subtle)] bg-slate-950/50 px-2 py-1 text-[10px] font-semibold text-slate-500 sm:inline-flex">Esc</kbd>
        </div>

        <div className="relative border-b border-[var(--color-border-subtle)]/55">
          <Search className="pointer-events-none absolute start-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" aria-hidden="true" />
          <label htmlFor="command-palette-search" className="sr-only">Pesquisar comandos e projetos</label>
          <input
            id="command-palette-search"
            name="command-palette-search"
            type="text"
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setHighlightedIndex(0)
            }}
            onKeyDown={handleKeyDown}
            placeholder="Pesquisar comandos e projetos..."
            role="combobox"
            aria-controls="command-palette-list"
            aria-expanded="true"
            aria-activedescendant={items[highlightedIndex] ? `command-item-${items[highlightedIndex].id}` : undefined}
            className="w-full bg-transparent py-4 ps-11 pe-4 text-base text-slate-100 outline-none placeholder:text-slate-500 sm:text-sm"
          />
        </div>

        <div
          id="command-palette-list"
          role="listbox"
          aria-label="Comandos e projetos"
          className="max-h-[min(22rem,55vh)] overflow-y-auto p-2"
        >
          {items.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-semibold text-slate-200">Nenhum resultado</p>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">Tente outro termo ou limpe a busca.</p>
            </div>
          ) : (
            <>
              <p className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                {query.trim() ? 'Resultados' : 'Sugestões'}
              </p>
              {items.map((item, index) => {
                const Icon = item.icon
                const isHighlighted = index === highlightedIndex
                return (
                  <button
                    key={item.id}
                    id={`command-item-${item.id}`}
                    type="button"
                    role="option"
                    aria-selected={isHighlighted}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => selectItem(item)}
                    title={item.description}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start transition-[background-color,color] ${
                      isHighlighted ? 'bg-indigo-500/15 text-white' : 'text-slate-300 hover:bg-white/[0.04]'
                    }`}
                  >
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${isHighlighted ? 'bg-indigo-500/20 text-indigo-200' : 'bg-slate-950/45 text-slate-500'}`}>
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{item.label}</span>
                      <span className="mt-0.5 block truncate text-xs text-[var(--color-text-muted)]">{item.description}</span>
                    </span>
                    {item.shortcut && (
                      <kbd className="hidden shrink-0 rounded-md border border-[var(--color-border-subtle)] bg-slate-950/45 px-2 py-1 text-[10px] font-semibold text-slate-500 sm:inline-flex">{item.shortcut}</kbd>
                    )}
                  </button>
                )
              })}
            </>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)]/55 px-4 py-2.5 text-[10px] text-slate-500">
          <span>Use ↑ ↓ para navegar</span>
          <span className="flex items-center gap-1"><kbd className="rounded border border-slate-700/70 px-1">↵</kbd> executar</span>
        </div>
      </div>
    </AccessibleDialog>
  )
}
