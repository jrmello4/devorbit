import React, { useEffect, useMemo, useState } from 'react'
import { Archive, ArchiveRestore, ChevronDown, Code2, Ellipsis, ExternalLink, Folder, FolderOpen, GitBranch, GitPullRequest, LayoutGrid, List, Plus, Search, SlidersHorizontal, Terminal, X } from 'lucide-react'
import type { Project, OtherDir, AppConfig } from '../types'
import { groupProjectsByParent } from './project-explorer-helpers'
import {
  SITUATION_SEGMENTS,
  branchPillText,
  branchSyncLabel,
  getProjectStatus,
  matchSituationFilter,
  relativeDate,
  type SituationFilter,
} from './project-library-helpers'
import './ProjectLibrary.css'

interface ProjectGridProps {
  projects: Project[]; otherDirs: OtherDir[]; config: AppConfig | null; search: string
  onSync: (projectPath: string) => Promise<void>; onStashSync?: (projectPath: string) => Promise<void>
  onOpenPushModal: (project: Project) => void; onOpenGitInit: (project: Project) => void
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void; isLoading: boolean
  onOpenAuthModal?: (account: 'account1' | 'account2') => void; onOpenMemory?: (project: Project) => void
  onOpenBranches?: (project: Project) => void; onOpenSettings?: () => void; onOpenClone?: () => void
  onRestoreProject?: (project: Project) => Promise<void>; onFinalizeProject?: (project: Project) => Promise<void>
  onProjectAccountChange?: (project: Project, account: 'account1' | 'account2') => Promise<void>
  onOpenWorkspace?: (project: Project) => void; onOpenProject?: (project: Project) => void
}
type GitFilter = 'all' | 'pull' | 'modified' | 'no-git'

export const ProjectGrid: React.FC<ProjectGridProps> = (props) => {
  const { projects, otherDirs, search, isLoading, onOpenSettings, onOpenClone, onOpenGitInit, onNotify, onOpenProject, onOpenWorkspace, onRestoreProject, onFinalizeProject } = props
  // Estado dos filtros mora aqui no ProjectGrid (não no App) — mantido no local original.
  const [situationFilter, setSituationFilter] = useState<SituationFilter>('all'); const [gitFilter, setGitFilter] = useState<GitFilter>('all'); const [tech, setTech] = useState(''); const [branch, setBranch] = useState(''); const [location, setLocation] = useState(''); const [sort, setSort] = useState<'name' | 'recent'>('name')
  const [view, setView] = useState<'grid' | 'list'>('grid'); const [showFilters, setShowFilters] = useState(false); const [grouped, setGrouped] = useState(false)
  const [openMenu, setOpenMenu] = useState<string | null>(null); const [selectedId, setSelectedId] = useState<string | null>(null); const [finalizingId, setFinalizingId] = useState<string | null>(null); const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpenMenu(null)
      setShowFilters(false)
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [])
  const techs = useMemo(() => Array.from(new Map(projects.flatMap((p) => p.techs.map((t) => [t.id, t.label] as const)))), [projects])
  // Contagens REAIS do segmentado, derivadas da mesma função de situação dos cards.
  const counts = useMemo(() => ({
    all: projects.length,
    pending: projects.filter((p) => matchSituationFilter(p, 'pending')).length,
    clean: projects.filter((p) => matchSituationFilter(p, 'clean')).length,
    none: projects.filter((p) => matchSituationFilter(p, 'none')).length,
    archived: projects.filter((p) => matchSituationFilter(p, 'archived')).length,
  }), [projects])
  const branches = useMemo(() => Array.from(new Set(projects.map((p) => p.git.branch).filter(Boolean))).sort(), [projects])
  const locations = useMemo(() => Array.from(new Set(projects.map((p) => p.parentDir).filter(Boolean))).sort(), [projects])
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return projects.filter((p) => {
      const matchQuery = !query || [p.name, p.path, p.git.branch, ...p.techs.map((t) => t.label)].some((v) => v.toLocaleLowerCase().includes(query))
      const matchSituation = matchSituationFilter(p, situationFilter)
      const matchGit = gitFilter === 'all' || gitFilter === 'pull' && p.git.isRepo && p.git.behind > 0 || gitFilter === 'modified' && p.git.isRepo && p.git.hasChanges || gitFilter === 'no-git' && !p.git.isRepo
      return matchQuery && matchSituation && matchGit && (!tech || p.techs.some((t) => t.id === tech)) && (!branch || p.git.branch === branch) && (!location || p.parentDir === location)
    }).sort((a, b) => sort === 'recent' ? b.lastModified - a.lastModified : a.name.localeCompare(b.name))
  }, [projects, search, situationFilter, gitFilter, tech, branch, location, sort])
  const groups = useMemo(() => groupProjectsByParent(filtered, { groupBySort: 'name', groupSortDirection: 'asc', projectSortBy: sort, projectSortDirection: sort === 'recent' ? 'desc' : 'asc' }), [filtered, sort])
  const visibleOtherDirs = useMemo(() => { const q = search.trim().toLocaleLowerCase(); return otherDirs.filter((d) => !q || [d.name, d.path].some((v) => v.toLocaleLowerCase().includes(q))) }, [otherDirs, search])
  const openProject = (p: Project) => { setSelectedId(p.id); setOpenMenu(null); onOpenProject?.(p) }
  const openFolder = async (path: string) => { try { const res = await window.devorbit?.launchTool('folder', path); if (!res?.success) onNotify(res?.message || 'Não foi possível abrir a pasta.', 'error') } catch (e) { onNotify(`Erro ao abrir pasta: ${e instanceof Error ? e.message : String(e)}`, 'error') } }
  const addGit = (d: OtherDir) => onOpenGitInit({ id: `other:${d.path}`, name: d.name, path: d.path, parentDir: d.parentDir, lastModified: Date.now(), techs: [], git: { isRepo: false, branch: '', ahead: 0, behind: 0, hasChanges: false, modifiedCount: 0, untrackedCount: 0 } })
  const launchTerminal = async (p: Project) => { const res = await window.devorbit?.launchTool('terminal', p.path); if (!res?.success) onNotify(res?.message || 'Não foi possível abrir o terminal.', 'error') }

  const safeLaunchTerminal = async (p: Project) => { try { await launchTerminal(p) } catch (e) { onNotify(`Erro ao abrir terminal: ${e instanceof Error ? e.message : String(e)}`, 'error') } }
  const finalizeProject = async (p: Project) => {
    if (!onFinalizeProject || finalizingId) return
    const confirmed = window.confirm('O DevOrbit só libera a pasta depois de confirmar que ela está limpa e sincronizada com o GitHub. A cópia local e dependências recriáveis como node_modules serão removidas; arquivos ignorados importantes bloqueiam a operação. O cadastro do projeto permanecerá. Continuar?')
    if (!confirmed) return
    setOpenMenu(null)
    setFinalizingId(p.id)
    try { await onFinalizeProject(p) } finally { setFinalizingId(null) }
  }
  const renderProject = (p: Project) => {
    const status = getProjectStatus(p)
    const archived = p.lifecycle === 'archived'
    const selected = selectedId === p.id
    const tech = p.techs[0]
    const syncLabel = branchSyncLabel(p)

    return (
      <article
        key={p.id}
        data-situation={status.situation}
        className={'project-tile' + (view === 'list' ? ' project-row' : '') + (selected ? ' is-selected' : '') + (archived ? ' is-archived' : '')}
      >
        <div className="project-tile-menu-wrap project-tile-menu-outside">
          <button
            type="button"
            className="project-icon-button"
            aria-label={'Mais ações de ' + p.name}
            aria-expanded={openMenu === p.id}
            title="Mais ações"
            onClick={(event) => {
              event.stopPropagation()
              setOpenMenu(openMenu === p.id ? null : p.id)
            }}
          >
            <Ellipsis aria-hidden="true" />
          </button>
          {openMenu === p.id && (
            <div className="project-action-menu" aria-label={'Ações de ' + p.name} onClick={(event) => event.stopPropagation()}>
              {onOpenWorkspace && !archived && <button type="button" onClick={() => { setOpenMenu(null); onOpenWorkspace(p) }}><Code2 aria-hidden="true" />Abrir workspace</button>}
              {!archived && <button type="button" onClick={() => { setOpenMenu(null); void safeLaunchTerminal(p) }}><Terminal aria-hidden="true" />Abrir terminal</button>}
              <button type="button" onClick={() => { setOpenMenu(null); void openFolder(p.path) }}><FolderOpen aria-hidden="true" />Abrir no Explorer</button>
              {!archived && !p.git.isRepo && <button type="button" onClick={() => { setOpenMenu(null); onOpenGitInit(p) }}><GitBranch aria-hidden="true" />Adicionar Git</button>}
              {archived && onRestoreProject && <button type="button" onClick={() => { setOpenMenu(null); void onRestoreProject(p) }}><ArchiveRestore aria-hidden="true" />Baixar projeto</button>}
              {!archived && onFinalizeProject && <button type="button" disabled={finalizingId === p.id} aria-busy={finalizingId === p.id} onClick={() => void finalizeProject(p)}><Archive aria-hidden="true" />{finalizingId === p.id ? 'Finalizando…' : 'Finalizar projeto'}</button>}
            </div>
          )}
        </div>

        <button
          type="button"
          className="project-tile-main project-tile-copy"
          aria-pressed={selected}
          onClick={() => openProject(p)}
          title={'Abrir projeto ' + p.name}
        >
          <span className="project-tile-name" title={p.name}>{p.name}</span>
          <span className="project-tile-branch" title={status.label}>
            <span className={'project-status-dot ' + status.classes} role="img" title={status.label} aria-label={status.label} />
            <span className="project-tile-branch-name">{branchPillText(p)}</span>
            {syncLabel && <span className="project-tile-branch-sync">{syncLabel}</span>}
          </span>
        </button>

        <div className="project-tile-footer">
          <span className="project-tile-updated">
            {tech && <><span className="project-tile-tech-dot" style={{ background: tech.color }} aria-hidden="true" /><span>{tech.label}</span><span className="project-meta-separator" aria-hidden="true">·</span></>}
            <span>atualizado {relativeDate(p.lastModified)}</span>
          </span>
          <div className="project-quick-actions" aria-label={'Ações rápidas de ' + p.name} onClick={(event) => event.stopPropagation()}>
            <button type="button" className="project-open-button" onClick={() => openProject(p)}><ExternalLink aria-hidden="true" />Abrir</button>
            {!archived && <button type="button" title="Abrir terminal" aria-label={'Abrir terminal em ' + p.name} onClick={() => void safeLaunchTerminal(p)}><Terminal aria-hidden="true" /></button>}
          </div>
        </div>
      </article>
    )
  }
  const collection = () => {
    if (isLoading && !projects.length) return <div className="project-skeleton-grid" aria-label="Carregando projetos" role="status">{Array.from({ length: 8 }, (_, i) => <div key={i} className="project-skeleton" />)}</div>
    if (!filtered.length) return <div className="project-empty"><FolderOpen aria-hidden="true" /><h2>{projects.length ? 'Nenhum projeto encontrado' : 'Você ainda não adicionou nenhum projeto.'}</h2><p>{projects.length ? 'Ajuste a busca ou os filtros para continuar.' : 'Adicione uma pasta ou clone um repositório para começar.'}</p>{!projects.length && <div className="project-empty-actions">{onOpenSettings && <button type="button" className="project-primary-button" onClick={onOpenSettings}><Plus aria-hidden="true" />Adicionar projeto</button>}{onOpenClone && <button type="button" className="project-secondary-button" onClick={onOpenClone}><GitPullRequest aria-hidden="true" />Clonar repositório</button>}</div>}</div>
    if (!grouped) return <div className={view === 'grid' ? 'project-card-grid' : 'project-card-list project-list'} data-testid={view === 'grid' ? 'project-grid' : 'project-list'}>{filtered.map(renderProject)}</div>
    return <div className="project-groups" data-testid="project-collection">{groups.map((g) => <section key={g.key} className="project-group"><button type="button" className="project-group-heading" aria-expanded={!collapsedGroups[g.key]} onClick={() => setCollapsedGroups((c) => ({ ...c, [g.key]: !c[g.key] }))}><ChevronDown className={collapsedGroups[g.key] ? 'is-collapsed' : ''} aria-hidden="true" /><Folder aria-hidden="true" /><span>{g.label}</span><small>{g.summary.projectCount}</small></button>{!collapsedGroups[g.key] && <div className={view === 'grid' ? 'project-card-grid' : 'project-card-list project-list'}>{g.projects.map(renderProject)}</div>}</section>)}</div>
  }
  return <main className="project-workspace project-library" aria-busy={isLoading} onClick={() => { if (openMenu) setOpenMenu(null); if (showFilters) setShowFilters(false) }}><section className="project-master" aria-label="Biblioteca de projetos">
    <header className="project-library-header"><div><h1>Projetos <span className="project-header-count">{projects.length}</span></h1><p>Seus projetos em um só lugar.</p></div><div className="project-header-actions">{onOpenClone && <button type="button" className="project-secondary-button" onClick={onOpenClone}><GitPullRequest aria-hidden="true" />Clonar</button>}{onOpenSettings && <button type="button" className="project-primary-button" onClick={onOpenSettings}><Plus aria-hidden="true" />Novo projeto</button>}</div></header>
    <div className="project-library-toolbar">
      {/* Segmentado por situação Git real (limpo/pendente/sem Git) + Arquivados quando existir. */}
      <div className="project-filter-pills" role="group" aria-label="Filtrar por situação do Git" data-testid="project-situation-filter">
        {SITUATION_SEGMENTS.filter((segment) => segment.key !== 'archived' || counts.archived > 0).map((segment) => (
          <button
            key={segment.key}
            type="button"
            data-testid={'situation-filter-' + segment.key}
            aria-pressed={situationFilter === segment.key}
            className={situationFilter === segment.key ? 'is-active' : ''}
            onClick={() => setSituationFilter(segment.key)}
          >
            <span className={'project-filter-dot ' + segment.dotClass} aria-hidden="true" />
            {segment.label} <span>· {counts[segment.key]}</span>
          </button>
        ))}
      </div>
      <div className="project-view-tools">
        <label className="project-sort-control">
          <span>Ordenar:</span>
          <select data-testid="filter-sort-select" value={sort} onChange={(e) => setSort(e.target.value as 'name' | 'recent')}>
            <option value="name">Nome A–Z</option>
            <option value="recent">Mais recentes</option>
          </select>
        </label>
        <div className="project-filter-popover-wrap"><button type="button" className={`project-tool-button${showFilters ? ' is-active' : ''}`} aria-expanded={showFilters} data-testid="project-filter-toggle" onClick={(e) => { e.stopPropagation(); setShowFilters(!showFilters) }}><SlidersHorizontal aria-hidden="true" />Filtros{(tech || gitFilter !== 'all' || branch || location) && <span className="filter-indicator" />}</button>{showFilters && <div className="project-filter-popover" role="dialog" aria-label="Filtros de projetos" data-testid="project-filter-popover" onClick={(e) => e.stopPropagation()}><div className="project-filter-popover-title">Filtros <button type="button" aria-label="Fechar filtros" onClick={() => setShowFilters(false)}><X aria-hidden="true" /></button></div><label>Status Git<select data-testid="filter-git-select" value={gitFilter} onChange={(e) => setGitFilter(e.target.value as GitFilter)}><option value="all">Todos</option><option value="pull">Pull pendente</option><option value="modified">Com alterações</option><option value="no-git">Sem Git</option></select></label><label>Tecnologia<select data-testid="filter-tech-select" value={tech} onChange={(e) => setTech(e.target.value)}><option value="">Todas</option>{techs.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label>Branch<select data-testid="filter-branch-select" value={branch} onChange={(e) => setBranch(e.target.value)}><option value="">Todas</option>{branches.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label>Localização<select data-testid="filter-location-select" value={location} onChange={(e) => setLocation(e.target.value)}><option value="">Todas</option>{locations.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label className="project-filter-check"><input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />Agrupar por pasta</label></div>}</div>
        <div className="project-view-toggle" role="group" aria-label="Modo de visualização" data-testid="project-view-toggle"><button type="button" aria-label="Visualização em grade" aria-pressed={view === 'grid'} className={view === 'grid' ? 'is-active' : ''} onClick={() => setView('grid')}><LayoutGrid aria-hidden="true" />Grid</button><button type="button" aria-label="Visualização em lista" aria-pressed={view === 'list'} className={view === 'list' ? 'is-active' : ''} onClick={() => setView('list')}><List aria-hidden="true" />Lista</button></div>
      </div>
    </div>
    {search && <div className="project-search-context"><Search aria-hidden="true" />Resultados para <strong>{search}</strong></div>}
    <div className="project-library-content">
      {collection()}
      {!isLoading && visibleOtherDirs.length > 0 && (
        <section className="project-other-dirs" aria-label="Outras pastas">
          <div className="project-section-heading">
            <div><h2>Outras pastas</h2><p>Pastas sem Git ou manifesto.</p></div>
            <span>{visibleOtherDirs.length}</span>
          </div>
          {visibleOtherDirs.map((dir) => (
            <div key={dir.path} className="other-dir-row">
              <Folder aria-hidden="true" />
              <span title={dir.path}>{dir.name}</span>
              <div>
                <button type="button" title={'Adicionar Git em ' + dir.name} aria-label={'Adicionar Git em ' + dir.name} onClick={() => addGit(dir)}><GitBranch aria-hidden="true" /></button>
                <button type="button" title={'Abrir pasta ' + dir.name} aria-label={'Abrir pasta ' + dir.name} onClick={() => void openFolder(dir.path)}><FolderOpen aria-hidden="true" /></button>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
    <footer className="project-library-footer"><span>{filtered.length} de {projects.length} projetos</span><span>{sort === 'name' ? 'Nome A–Z' : 'Mais recentes'}</span></footer>
  </section></main>
}
