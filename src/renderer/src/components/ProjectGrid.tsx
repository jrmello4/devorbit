import React, { useState, useMemo } from 'react'
import { Folder, FolderX, FolderOpen, GitBranch, GitPullRequest, SlidersHorizontal, ArrowDown, ArrowUp, Circle, ArrowUpDown, ChevronDown, ChevronRight } from 'lucide-react'
import type { Project, OtherDir, AppConfig } from '../types'
import { groupProjectsByParent } from './project-explorer-helpers'

interface ProjectGridProps {
  projects: Project[]
  otherDirs: OtherDir[]
  config: AppConfig | null
  search: string
  onSync: (projectPath: string) => Promise<void>
  onStashSync?: (projectPath: string) => Promise<void>
  onOpenPushModal: (project: Project) => void
  onOpenGitInit: (project: Project) => void
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void
  isLoading: boolean
  onOpenAuthModal?: (account: 'account1' | 'account2') => void
  onOpenMemory?: (project: Project) => void
  onOpenBranches?: (project: Project) => void
  onOpenSettings?: () => void
  onOpenClone?: () => void
  onRestoreProject?: (project: Project) => Promise<void>
  onFinalizeProject?: (project: Project) => Promise<void>
  onProjectAccountChange?: (project: Project, account: 'account1' | 'account2') => Promise<void>
  onOpenWorkspace?: (project: Project) => void
  onOpenProject?: (project: Project) => void
}

export const ProjectGrid: React.FC<ProjectGridProps> = (props) => {
  const { projects, otherDirs, search, isLoading, onOpenSettings, onOpenClone, onOpenGitInit, onNotify, onOpenProject } = props
  const visibleOtherDirs = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return otherDirs.filter((dir) => !query || [dir.name, dir.path].some((v) => v.toLocaleLowerCase().includes(query)))
  }, [otherDirs, search])

  const handleOpenFolder = async (dir: OtherDir) => {
    try {
      const res = await window.devorbit?.launchTool('folder', dir.path)
      if (!res?.success) onNotify(res?.message || 'Não foi possível abrir a pasta.', 'error')
    } catch (err: unknown) {
      onNotify(`Erro ao abrir pasta: ${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  const handleAddGit = (dir: OtherDir) => {
    onOpenGitInit({
      id: `other:${dir.path}`,
      name: dir.name,
      path: dir.path,
      parentDir: dir.parentDir,
      lastModified: Date.now(),
      techs: [],
      git: { isRepo: false, branch: '', ahead: 0, behind: 0, hasChanges: false, modifiedCount: 0, untrackedCount: 0 },
    })
  }

  const [filter, setFilter] = useState('all')
  const [tech, setTech] = useState('')
  const [sort, setSort] = useState('name')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const techs = useMemo(() => Array.from(new Map(projects.flatMap(p => p.techs.map(t => [t.id, t.label] as const)))), [projects])
  const filtered = useMemo(() => projects.filter(p => {
    const query = search.trim().toLocaleLowerCase()
    return (!query || [p.name, p.path, p.git.branch, ...p.techs.map(t => t.label)].some(v => v.toLocaleLowerCase().includes(query))) &&
      (filter === 'all' || (filter === 'pull' && p.git.isRepo && p.git.behind > 0) || (filter === 'modified' && p.git.isRepo && p.git.hasChanges) || (filter === 'no-git' && !p.git.isRepo)) &&
      (!tech || p.techs.some(t => t.id === tech))
  }).sort((a,b) => sort === 'recent' ? b.lastModified - a.lastModified : a.name.localeCompare(b.name)), [projects, search, filter, tech, sort])

  const groups = useMemo(() => groupProjectsByParent(filtered, {
    groupBySort: 'name',
    groupSortDirection: 'asc',
    projectSortBy: sort === 'recent' ? 'recent' : 'name',
    projectSortDirection: sort === 'recent' ? 'desc' : 'asc',
  }), [filtered, sort])

  const selected = filtered.find(p => p.id === selectedId) ?? filtered[0]
  const attentionCount = useMemo(() => projects.filter((project) =>
    project.git.isRepo && (project.git.behind > 0 || project.git.ahead > 0 || project.git.hasChanges),
  ).length, [projects])
  const withoutGitCount = useMemo(() => projects.filter((project) => !project.git.isRepo).length, [projects])

  const openProject = (project: Project) => {
    setSelectedId(project.id)
    onOpenProject?.(project)
  }

  const toggleGroup = (key: string) => {
    setCollapsedGroups((current) => ({ ...current, [key]: !current[key] }))
  }

  return (
    <main className="project-workspace project-library" aria-busy={isLoading}>
      <section className="project-master" aria-label="Biblioteca de projetos">
        <div className="master-heading">
          <div className="master-heading-copy">
            <div className="master-heading-title"><h1>Projetos</h1><span className="count-badge" aria-label={`${projects.length} projetos`}>{projects.length}</span></div>
            <span className="master-heading-summary" aria-live="polite">
              {projects.length ? `${projects.length} projetos` : 'Nenhum projeto monitorado'}
              {attentionCount > 0 && ` · ${attentionCount} com atenção`}
              {withoutGitCount > 0 && ` · ${withoutGitCount} sem Git`}
              {groups.length > 0 && ` · ${groups.length} pastas`}
            </span>
          </div>
          {onOpenClone && <button type="button" className="clone-button" title="Clonar repositório por link" aria-label="Clonar repositório por link" onClick={onOpenClone}><GitPullRequest size={14} aria-hidden="true" /><span>Clonar</span></button>}
        </div>
        <div className="project-filters">
          <label><SlidersHorizontal size={14} aria-hidden="true"/><span className="sr-only">Filtrar status Git</span><select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">Todos os projetos</option><option value="pull">Pull pendente</option><option value="modified">Com alterações</option><option value="no-git">Sem Git</option></select></label>
          <div className="filter-secondary"><label><span className="sr-only">Filtrar tecnologia</span><select value={tech} onChange={e => setTech(e.target.value)}><option value="">Todas as tecnologias</option>{techs.map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></label><button type="button" className="icon-button" title={sort === 'name' ? 'Ordenar por modificação recente' : 'Ordenar por nome'} aria-label={sort === 'name' ? 'Ordenar por modificação recente' : 'Ordenar por nome'} onClick={() => setSort(sort === 'name' ? 'recent' : 'name')}><ArrowUpDown size={14} aria-hidden="true"/></button></div>
        </div>
        <div className="project-list" aria-label="Projetos agrupados por pasta">
          {isLoading && !projects.length ? (
            <p className="list-message" role="status">Lendo projetos…</p>
          ) : groups.length ? (
            groups.map((group) => {
              const collapsed = Boolean(collapsedGroups[group.key])
              const panelId = `project-group-${group.key.replace(/[^a-zA-Z0-9_-]+/g, '-')}`
              return (
                <section key={group.key} className="project-group" role="group" aria-label={group.label}>
                  <button
                    type="button"
                    className="project-group-toggle"
                    aria-expanded={!collapsed}
                    aria-controls={panelId}
                    onClick={() => toggleGroup(group.key)}
                    title={collapsed ? `Expandir ${group.label}` : `Recolher ${group.label}`}
                  >
                    {collapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                    <FolderOpen size={15} aria-hidden="true" />
                    <span className="project-group-label" title={group.label}>{group.label}</span>
                    <span className="count-badge">{group.summary.projectCount}</span>
                  </button>
                  <div id={panelId} className="project-group-items" hidden={collapsed}>
                    {group.projects.map(p => (
                      <button
                        type="button"
                        key={p.id}
                        className={`project-row ${selected?.id === p.id ? 'selected' : ''}`}
                        aria-pressed={selected?.id === p.id}
                        onClick={() => openProject(p)}
                        title={p.path}
                      >
                        <span className="project-row-icon"><Folder size={17} aria-hidden="true"/></span>
                        <span className="project-row-copy"><strong title={p.name}>{p.name}</strong><span title={p.path}>{p.parentDir}</span><small>{p.lifecycle === 'archived' ? 'Arquivado · pronto para baixar' : p.git.isRepo ? <><GitBranch size={11} aria-hidden="true"/><span>{p.git.branch || 'Sem commits'}</span></> : 'Sem repositório'}</small></span>
                        {p.git.behind > 0 ? <span className="row-status" title={`${p.git.behind} commits para receber`}><ArrowDown size={12} aria-hidden="true"/>{p.git.behind}</span> : p.git.hasChanges ? <span className="row-status warning" title="Alterações locais"><Circle size={8} fill="currentColor" aria-hidden="true"/></span> : p.git.ahead > 0 ? <span className="row-status" title={`${p.git.ahead} commits para enviar`}><ArrowUp size={12} aria-hidden="true"/>{p.git.ahead}</span> : null}
                      </button>
                    ))}
                  </div>
                </section>
              )
            })
          ) : (
            <div className="workspace-empty">
              <span className="workspace-empty-kicker">{isLoading ? 'Preparando seu workspace' : projects.length ? 'Ajuste sua busca' : 'Primeiro passo'}</span>
              {isLoading ? <FolderX size={36} strokeWidth={1.2} aria-hidden="true" /> : projects.length ? <FolderX size={36} strokeWidth={1.2} aria-hidden="true" /> : <FolderOpen size={36} strokeWidth={1.2} aria-hidden="true" />}
              <h2>{isLoading ? 'Preparando seu workspace' : projects.length ? 'Nenhum projeto encontrado' : 'Seu próximo projeto começa aqui'}</h2>
              <p>{isLoading ? 'Lendo pastas e verificando o Git.' : projects.length ? 'Altere a busca ou os filtros para continuar.' : 'Adicione uma pasta para abrir seu primeiro projeto e começar a trabalhar.'}</p>
              {!isLoading && !projects.length && onOpenSettings && <button type="button" className="primary-button" onClick={onOpenSettings}>Adicionar uma pasta</button>}
              {!isLoading && projects.length > 0 && (filter !== 'all' || tech) && <button type="button" className="secondary-button" onClick={() => {setFilter('all'); setTech('')}}>Limpar filtros</button>}
            </div>
          )}
        </div>
        {!isLoading && visibleOtherDirs.length > 0 && (
          <div className="other-dirs" aria-label="Outras pastas">
            <div className="master-heading"><h2>Outras pastas</h2><span className="count-badge">{visibleOtherDirs.length}</span></div>
            <p className="list-message">Sem Git ou manifesto — abra a pasta ou adicione Git.</p>
            {visibleOtherDirs.map((dir) => (
              <div key={dir.path} className="project-row">
                <span className="project-row-icon"><Folder size={17} aria-hidden="true" /></span>
                <span className="project-row-copy"><strong title={dir.name}>{dir.name}</strong><span title={dir.path}>{dir.parentDir}</span></span>
                <button type="button" className="icon-button" title={`Adicionar Git em ${dir.name}`} aria-label={`Adicionar Git em ${dir.name}`} onClick={() => handleAddGit(dir)}><GitBranch size={14} aria-hidden="true" /></button>
                <button type="button" className="icon-button" title={`Abrir pasta ${dir.name}`} aria-label={`Abrir pasta ${dir.name}`} onClick={() => void handleOpenFolder(dir)}><FolderOpen size={14} aria-hidden="true" /></button>
              </div>
            ))}
          </div>
        )}
        <div className="master-footer" role="status">{filtered.length} de {projects.length} projetos<span>{sort === 'name' ? 'Nome A–Z' : 'Mais recentes'}</span></div>
      </section>
    </main>
  )
}
