import React, { useState, useMemo } from 'react'
import {
  FolderGit2,
  GitPullRequest,
  AlertCircle,
  FolderX,
  Filter,
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
  onUsageUpdate?: () => void
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
  onUsageUpdate,
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
        <div className="w-10 h-10 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full motion-safe:animate-spin mb-4" aria-hidden="true" />
        <p className="text-sm font-medium">Buscando repositórios e projetos...</p>
      </main>
    )
  }

  return (
    <main id="main" className="flex-1 flex flex-col min-h-0" aria-busy={isLoading}>
      <h1 className="sr-only">Projetos</h1>
      {/* Filter Tabs Bar */}
      <div className="px-6 py-3 border-b border-slate-800/60 bg-[var(--color-bg-page)]/60 backdrop-blur-sm flex flex-wrap items-center justify-between gap-3">
        {/* Main Status Tabs */}
        <div className="flex items-center gap-1.5 p-1 bg-slate-900/90 rounded-xl border border-slate-800">
          <button
            onClick={() => setFilterType('all')}
            aria-pressed={filterType === 'all'}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-[color,background-color,border-color,box-shadow] ${
              filterType === 'all'
                ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Todos ({counts.all})
          </button>

          <button
            onClick={() => setFilterType('needs-pull')}
            aria-pressed={filterType === 'needs-pull'}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-[color,background-color,border-color,box-shadow] ${
              filterType === 'needs-pull'
                ? 'bg-sky-600 text-white shadow-sm shadow-sky-500/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <GitPullRequest className="w-3.5 h-3.5 text-sky-400" />
            <span>Requerem Pull ({counts.needsPull})</span>
          </button>

          <button
            onClick={() => setFilterType('modified')}
            aria-pressed={filterType === 'modified'}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-[color,background-color,border-color,box-shadow] ${
              filterType === 'modified'
                ? 'bg-amber-600 text-white shadow-sm shadow-amber-500/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <AlertCircle className="w-3.5 h-3.5 text-amber-400" />
            <span>Com Alterações ({counts.modified})</span>
          </button>

          <button
            onClick={() => setFilterType('no-git')}
            aria-pressed={filterType === 'no-git'}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-[color,background-color,border-color,box-shadow] ${
              filterType === 'no-git'
                ? 'bg-slate-700 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Sem Git ({counts.noGit})
          </button>
        </div>

        {/* Tech Stack Pills Filter */}
        {allTechs.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto py-1">
              <span className="text-xs text-slate-400 flex items-center gap-1 shrink-0">
              <Filter className="w-3 h-3" /> Stack:
            </span>
            {selectedTech && (
              <button
                onClick={() => setSelectedTech(null)}
                className="min-h-6 text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 hover:text-white border border-slate-700"
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
                className={`min-h-6 text-[11px] font-medium px-2 py-0.5 rounded-full border transition-[color,background-color,border-color] cursor-pointer ${
                  selectedTech === tech.id
                    ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/50'
                    : 'bg-slate-900/80 text-slate-400 border-slate-800 hover:border-slate-700 hover:text-slate-300'
                }`}
              >
                {tech.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Projects Grid Container */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="sr-only" role="status" aria-live="polite">
          {filteredProjects.length} projeto(s) exibido(s)
        </div>
        {filteredProjects.length === 0 ? (
          <div className="min-h-64 flex flex-col items-center justify-center text-slate-400 border border-dashed border-slate-800 rounded-2xl">
            <FolderX className="w-10 h-10 text-slate-400 mb-3" aria-hidden="true" />
            <p className="text-sm font-medium text-slate-400">
              Nenhum projeto encontrado
            </p>
            <p className="text-xs text-slate-400 mt-1 text-center">
              Tente alterar os termos da busca ou ajustar os filtros acima.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
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
                onUsageUpdate={onUsageUpdate}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
