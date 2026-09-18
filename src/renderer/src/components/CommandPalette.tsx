import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowRightLeft,
  Command as CommandIcon,
  FolderSearch,
  GitPullRequest,
  Download,
  RefreshCw,
  Search,
  Settings,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Project } from '../types'
import { AccessibleDialog } from './AccessibleDialog'
import {
  CREATE_BINDINGS,
  NAVIGATE_BINDINGS,
  detectPrefixQuery,
  matchTwoStroke,
  parseSpacedTwoStroke,
  rankWithFocusedContext,
  type CreateActionId,
  type FocusedCanvasContext,
  type NavigateActionId,
  type TwoStrokePrefix,
} from './command-center-helpers'

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
  projects: Project[]
  search: string
  onSearchChange: (value: string) => void
  onRefresh: () => void
  onSyncAll: () => void
  onOpenSettings: () => void
  onOpenClone?: () => void
  onToggleAccount: () => void | Promise<void>
  activeAccountLabel: string
  isRefreshing?: boolean
  isSyncingAll?: boolean
  isSwitchingAccount?: boolean
  focusedNode?: FocusedCanvasContext | null
  onNavigate?: (action: NavigateActionId) => void
  onCreate?: (action: CreateActionId) => void
  onRunEvolutionCommand?: (command: 'audit' | 'debt' | 'review' | 'fix') => void
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
  onOpenClone,
  onToggleAccount,
  activeAccountLabel,
  isRefreshing = false,
  isSyncingAll = false,
  isSwitchingAccount = false,
  focusedNode = null,
  onNavigate,
  onCreate,
  onRunEvolutionCommand,
}) => {
  const [query, setQuery] = useState(search)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [pendingPrefix, setPendingPrefix] = useState<TwoStrokePrefix | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setQuery(search)
    setHighlightedIndex(0)
    setPendingPrefix(null)
  }, [isOpen, search])

  const runTwoStroke = (prefix: TwoStrokePrefix, key: string): boolean => {
    const binding = matchTwoStroke(prefix, key)
    if (!binding) return false
    if (binding.prefix === 'g') {
      onNavigate?.(binding.action as NavigateActionId)
    } else {
      onCreate?.(binding.action as CreateActionId)
    }
    return true
  }

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
      ...(onOpenClone ? [{
        id: 'clone',
        label: 'Clonar repositório por link',
        description: 'Colar URL HTTPS e baixar a main mais recente',
        icon: Download,
        onSelect: onOpenClone,
      } as PaletteItem] : []),
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
      ...(onRunEvolutionCommand ? (['audit', 'debt', 'review', 'fix'] as const).map((command) => ({
        id: 'evolution-' + command,
        label: '/' + command,
        description: command === 'audit' ? 'Executar auditoria estática do projeto ativo' : 'Abrir o painel de evolução para ' + command,
        icon: FolderSearch,
        onSelect: () => onRunEvolutionCommand(command),
      })) : []),
    ]

    const commandMatches = normalizedQuery
      ? commands.filter((item) =>
          `${item.label} ${item.description}`.toLowerCase().includes(normalizedQuery)
        )
      : commands

    const spacedBinding = parseSpacedTwoStroke(query)
    const projectMatches = projects
      .filter((project) => {
        if (!normalizedQuery || normalizedQuery === 'g' || normalizedQuery === 'c') return true
        // Sequência válida de dois tempos (ex.: "g p"): mostra tudo pois a
        // ação executa ao confirmar; qualquer outro texto com espaço filtra normal.
        if (spacedBinding) return true
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

    const ranked = rankWithFocusedContext([...commandMatches, ...projectMatches], query, focusedNode)
    return ranked
  }, [
    activeAccountLabel,
    focusedNode,
    isRefreshing,
    isSyncingAll,
    isSwitchingAccount,
    onOpenClone,
    onOpenSettings,
    onRefresh,
    onRunEvolutionCommand,
    onSearchChange,
    onSyncAll,
    onToggleAccount,
    projects,
    query,
  ])

  const handleQueryChange = (value: string) => {
    const spaced = parseSpacedTwoStroke(value)
    if (spaced) {
      if (spaced.prefix === 'g') onNavigate?.(spaced.action as NavigateActionId)
      else onCreate?.(spaced.action as CreateActionId)
      setPendingPrefix(null)
      setQuery('')
      setHighlightedIndex(0)
      onClose()
      return
    }
    const prefix = detectPrefixQuery(value)
    setPendingPrefix(prefix)
    setQuery(value)
    setHighlightedIndex(0)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (pendingPrefix && event.key.length === 1) {
      if (runTwoStroke(pendingPrefix, event.key)) {
        event.preventDefault()
        setPendingPrefix(null)
        setQuery('')
        setHighlightedIndex(0)
        onClose()
        return
      }
      setPendingPrefix(null)
    }
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
      <div className="surface-panel overflow-hidden rounded-[8px] shadow-[0_18px_42px_rgba(28,25,23,0.14)]">
        <div className="flex items-center gap-3 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-toolbar)] px-4 py-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] border border-[var(--color-border-subtle)] bg-[var(--surface-selected)] text-[var(--color-accent-strong)]">
            <CommandIcon className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="command-palette-title" className="text-sm font-semibold text-[var(--text-primary)]">Ações rápidas</h2>
            <p className="text-xs text-[var(--color-text-muted)]">Pesquise um projeto ou execute uma ação</p>
          </div>
          <kbd className="hidden rounded-[4px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-muted)] sm:inline-flex">Esc</kbd>
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
            onChange={(event) => handleQueryChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Pesquisar comandos e projetos... (G + tecla navega, C + tecla cria)"
            role="combobox"
            aria-controls="command-palette-list"
            aria-expanded="true"
            aria-activedescendant={items[highlightedIndex] ? `command-item-${items[highlightedIndex].id}` : undefined}
            className="w-full bg-transparent py-4 ps-11 pe-4 text-base text-[var(--text-primary)] outline-none placeholder:text-[var(--color-text-muted)] sm:text-sm"
          />
        </div>

        {(pendingPrefix || focusedNode) && (
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-subtle)]/55 bg-[var(--surface-muted)] px-4 py-2 text-[11px] text-[var(--color-text-muted)]" aria-live="polite">
            {pendingPrefix === 'g' && <span>Aguardando segunda tecla de navegação: P · C · T · G · M · S</span>}
            {pendingPrefix === 'c' && <span>Aguardando segunda tecla de criação: T · N · B · P</span>}
            {!pendingPrefix && focusedNode && <span>Contexto do canvas: {focusedNode.title} ({focusedNode.kind}) — resultados priorizados</span>}
          </div>
        )}

        <div
          id="command-palette-list"
          role="listbox"
          aria-label="Comandos e projetos"
          className="max-h-[min(22rem,55vh)] overflow-y-auto p-2"
        >
          {items.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-semibold text-[var(--text-primary)]">Nenhum resultado</p>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">Tente outro termo ou limpe a busca.</p>
            </div>
          ) : (
            <>
              <p className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
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
                    className={`flex w-full items-center gap-3 rounded-[6px] px-3 py-2.5 text-start transition-[background-color,color] ${
                      isHighlighted ? 'bg-[var(--surface-selected)] text-[var(--text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--surface-hover)]'
                    }`}
                  >
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] border ${isHighlighted ? 'border-[var(--color-border-strong)] bg-[var(--surface-selected)] text-[var(--color-accent-strong)]' : 'border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] text-[var(--color-text-muted)]'}`}>
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{item.label}</span>
                      <span className="mt-0.5 block truncate text-xs text-[var(--color-text-muted)]">{item.description}</span>
                    </span>
                    {item.shortcut && (
                      <kbd className="hidden shrink-0 rounded-[4px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-muted)] sm:inline-flex">{item.shortcut}</kbd>
                    )}
                  </button>
                )
              })}
            </>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] px-4 py-2.5 text-[10px] text-[var(--color-text-muted)]">
          <span>Use ↑ ↓ para navegar · G + tecla navega · C + tecla cria</span>
          <span className="flex items-center gap-1"><kbd className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-1">↵</kbd> executar</span>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-[var(--color-border-subtle)]/55 px-4 py-2 text-[10px] text-[var(--color-text-muted)]" aria-label="Atalhos de dois tempos">
          {NAVIGATE_BINDINGS.map((binding) => (
            <span key={binding.hint} title={binding.label} className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-1.5 py-0.5 font-semibold">{binding.hint}</span>
          ))}
          {CREATE_BINDINGS.map((binding) => (
            <span key={binding.hint} title={binding.label} className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-1.5 py-0.5 font-semibold">{binding.hint}</span>
          ))}
        </div>
      </div>
    </AccessibleDialog>
  )
}
