import React, { useState, useMemo } from 'react'
import {
  GitPullRequest,
  AlertCircle,
  FolderX,
  Filter,
  Settings,
} from 'lucide-react'
import { ProjectCard } from './ProjectCard'
import type { Project, AppConfig } from '../types'

interface ProjectGridProps {
  projects: Project[]
  config: AppConfig | null
  search: string
  onSync: (projectPath: string) => Promise<void>
  onOpenPushModal: (project: Project) => void
  onOpenGitInit: (project: Project) => void
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void
  isLoading: boolean
  onOpenAuthModal?: (account: 'account1' | 'account2') => void
  onOpenMemory?: (project: Project) => void
  onOpenBranches?: (project: Project) => void
  onUsageUpdate?: () => void
  onOpenSettings?: () => void
}

type FilterType = 'all' | 'needs-pull' | 'modified' | 'no-git'

export const ProjectGrid: React.FC<ProjectGridProps> = ({
  projects,
  config,
  search,
  onSync,
  onOpenPushModal,
  onOpenGitInit,
  onNotify,
  isLoading,
  onOpenAuthModal,
  onOpenMemory,
  onOpenBranches,
  onUsageUpdate,
  onOpenSettings,
}) => {
  const [filterType, setFilterType] = useState<FilterType>('all')
  const [selectedTech, setSelectedTech] = useState<string | null>(null)

  // Extract all unique technologies
  const allTechs = useMemo(() => {
    const map = new Map<string, string>()
    projects.forEach((p) => {
      p.techs.forEach((t) => map.set(t.id, t.label))
    })
    return Array.from(map.entries()).map(([id, label]) => ({ id, label }))
  }, [projects])

  // Counts for tabs
  const counts = useMemo(() => {
    let needsPull = 0
    let modified = 0
    let noGit = 0

    projects.forEach((p) => {
      if (!p.git.isRepo) {
        noGit++
      } else {
        if (p.git.behind > 0) needsPull++
        if (p.git.hasChanges) modified++
      }
    })

    return { all: projects.length, needsPull, modified, noGit }
  }, [projects])

  // Filtered projects
  const filteredProjects = useMemo(() => {
    return projects.filter((p) => {
      // Search text filter
      if (search.trim()) {
        const query = search.toLowerCase()
        const matchesName = p.name.toLowerCase().includes(query)
        const matchesPath = p.path.toLowerCase().includes(query)
        const matchesTech = p.techs.some((t) => t.label.toLowerCase().includes(query))
        const matchesBranch = p.git.branch.toLowerCase().includes(query)
        if (!matchesName && !matchesPath && !matchesTech && !matchesBranch) return false
      }

      // Tab filter
      if (filterType === 'needs-pull' && (!p.git.isRepo || p.git.behind === 0)) return false
      if (filterType === 'modified' && (!p.git.isRepo || !p.git.hasChanges)) return false
      if (filterType === 'no-git' && p.git.isRepo) return false

      // Tech filter
      if (selectedTech && !p.techs.some((t) => t.id === selectedTech)) return false

      return true
    })
  }, [projects, search, filterType, selectedTech])

  if (isLoading && projects.length === 0) {
    return (
      <main id="main" className="flex-1 flex flex-col items-center justify-center p-12 text-slate-400" aria-busy="true">
        <h1 className="sr-only">Projetos</h1>
        <div className="w-11 h-11 border-2 border-indigo-500/25 border-t-[var(--color-accent)] rounded-full motion-safe:animate-spin mb-4" aria-hidden="true" />
        <p className="text-sm font-medium text-slate-200">Buscando seus projetos</p>
        <p className="text-xs text-[var(--color-text-muted)] mt-1">Lendo pastas e status do Git...</p>
      </main>
    )
  }

  return (
    <main id="main" className="flex-1 flex flex-col min-h-0" aria-busy={isLoading}>
      <div className="mx-auto w-full max-w-[1680px] px-5 pt-7 pb-5 sm:px-6 lg:px-8 lg:pt-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-balance text-2xl font-semibold tracking-tight text-white sm:text-3xl">Seu workspace</h1>
            <p className="text-pretty mt-1.5 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">
              Encontre um projeto, veja o estado do repositório e abra a ferramenta certa para continuar.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-[var(--color-border-subtle)]/70 bg-slate-950/35 px-3 py-2 text-xs text-[var(--color-text-muted)]">
            <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.12)]" aria-hidden="true" />
            <span className="tabular-nums font-semibold text-slate-200">{filteredProjects.length}</span>
            <span>{filteredProjects.length === 1 ? 'projeto visível' : 'projetos visíveis'}</span>
          </div>
        </div>
      </div>

      {/* Filter Tabs Bar */}
      <div className="border-y border-[var(--color-border-subtle)]/60 bg-[var(--color-bg-toolbar)]/70 px-5 py-3 backdrop-blur-sm sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-[1680px] flex-wrap items-center justify-between gap-3">
        {/* Main Status Tabs */}
        <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-[var(--color-border-subtle)]/80 bg-slate-950/45 p-1">
          <button
            onClick={() => setFilterType('all')}
            aria-pressed={filterType === 'all'}
            className={`min-h-9 shrink-0 cursor-pointer rounded-lg px-3 text-xs font-semibold transition-[color,background-color,border-color,box-shadow] ${
              filterType === 'all'
                ? 'bg-[var(--color-accent-strong)] text-white shadow-sm shadow-indigo-500/30'
                : 'text-[var(--color-text-muted)] hover:bg-white/[0.04] hover:text-slate-100'
            }`}
          >
            Todos <span className="ms-1 text-[11px] opacity-70">{counts.all}</span>
          </button>

          <button
            onClick={() => setFilterType('needs-pull')}
            aria-pressed={filterType === 'needs-pull'}
            className={`flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-[color,background-color,border-color,box-shadow] ${
              filterType === 'needs-pull'
                ? 'bg-sky-600 text-white shadow-sm shadow-sky-500/30'
                : 'text-[var(--color-text-muted)] hover:bg-white/[0.04] hover:text-slate-100'
            }`}
          >
            <GitPullRequest className={`h-3.5 w-3.5 ${filterType === 'needs-pull' ? 'text-sky-100' : 'text-sky-400'}`} />
            <span>Requerem pull <span className="ms-1 text-[11px] opacity-70">{counts.needsPull}</span></span>
          </button>

          <button
            onClick={() => setFilterType('modified')}
            aria-pressed={filterType === 'modified'}
            className={`flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-[color,background-color,border-color,box-shadow] ${
              filterType === 'modified'
                ? 'bg-amber-600 text-white shadow-sm shadow-amber-500/30'
                : 'text-[var(--color-text-muted)] hover:bg-white/[0.04] hover:text-slate-100'
            }`}
          >
            <AlertCircle className={`h-3.5 w-3.5 ${filterType === 'modified' ? 'text-amber-100' : 'text-amber-400'}`} />
            <span>Com alterações <span className="ms-1 text-[11px] opacity-70">{counts.modified}</span></span>
          </button>

          <button
            onClick={() => setFilterType('no-git')}
            aria-pressed={filterType === 'no-git'}
            className={`min-h-9 shrink-0 cursor-pointer rounded-lg px-3 text-xs font-semibold transition-[color,background-color,border-color,box-shadow] ${
              filterType === 'no-git'
                ? 'bg-slate-700 text-white'
                : 'text-[var(--color-text-muted)] hover:bg-white/[0.04] hover:text-slate-100'
            }`}
          >
            Sem Git <span className="ms-1 text-[11px] opacity-70">{counts.noGit}</span>
          </button>
        </div>

        {/* Tech Stack Pills Filter */}
        {allTechs.length > 0 && (
          <div className="flex max-w-full items-center gap-1.5 overflow-x-auto py-1">
              <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--color-text-muted)]">
              <Filter className="h-3.5 w-3.5" /> Stack
            </span>
            {selectedTech && (
              <button
                onClick={() => setSelectedTech(null)}
                className="min-h-8 shrink-0 rounded-full border border-[var(--color-border-subtle)] bg-slate-900/70 px-2.5 text-[11px] text-slate-300 hover:border-slate-600 hover:text-white"
              >
                Limpar
              </button>
            )}
            {allTechs.map((tech) => (
              <button
                key={tech.id}
                onClick={() =>
                  setSelectedTech(selectedTech === tech.id ? null : tech.id)
                }
                aria-pressed={selectedTech === tech.id}
                className={`min-h-8 shrink-0 rounded-full border px-2.5 text-[11px] font-semibold transition-[color,background-color,border-color] cursor-pointer ${
                  selectedTech === tech.id
                    ? 'border-indigo-400/60 bg-indigo-500/20 text-indigo-200'
                    : 'border-[var(--color-border-subtle)]/80 bg-slate-950/35 text-[var(--color-text-muted)] hover:border-slate-600 hover:text-slate-200'
                }`}
              >
                {tech.label}
              </button>
            ))}
          </div>
        )}
        </div>
      </div>

      {/* Projects Grid Container */}
      <div className="flex-1 overflow-y-auto px-5 pb-8 pt-5 sm:px-6 lg:px-8 lg:pt-6">
        <div className="mx-auto w-full max-w-[1680px]">
        <div className="sr-only" role="status" aria-live="polite">
          {filteredProjects.length} projeto(s) exibido(s)
        </div>
        {filteredProjects.length === 0 ? (
          <div className="surface-panel flex min-h-72 flex-col items-center justify-center rounded-2xl border-dashed px-6 py-12 text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500/10 text-indigo-300 ring-1 ring-indigo-400/20">
              <FolderX className="h-6 w-6" aria-hidden="true" />
            </div>
            <p className="text-balance text-base font-semibold text-slate-100">
              {projects.length === 0 ? 'Adicione suas pastas de trabalho' : 'Nenhum projeto nesta visão'}
            </p>
            <p className="text-pretty mt-1.5 max-w-md text-sm leading-6 text-[var(--color-text-muted)]">
              {projects.length === 0
                ? 'Escolha as pastas em Configurações para começar a acompanhar Git, ferramentas e contexto em um só lugar.'
                : 'Tente limpar a busca ou ajustar os filtros acima para encontrar outro projeto.'}
            </p>
            {projects.length === 0 && onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="mt-6 inline-flex min-h-10 items-center gap-2 rounded-xl bg-[var(--color-accent-strong)] px-4 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20 transition-[background-color,box-shadow,transform] hover:bg-indigo-500 hover:shadow-indigo-500/30 active:translate-y-px"
              >
                <Settings className="h-4 w-4" aria-hidden="true" />
                Abrir configurações
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
            {filteredProjects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                config={config}
                onSync={onSync}
                onOpenPushModal={onOpenPushModal}
                onOpenGitInit={onOpenGitInit}
                onNotify={onNotify}
                onOpenAuthModal={onOpenAuthModal}
                onOpenMemory={onOpenMemory}
                onOpenBranches={onOpenBranches}
                onUsageUpdate={onUsageUpdate}
              />
            ))}
          </div>
        )}
        </div>
      </div>
    </main>
  )
}
