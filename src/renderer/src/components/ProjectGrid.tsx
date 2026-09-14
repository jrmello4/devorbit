import React, { useState, useMemo } from 'react'
import { Folder, FolderX, FolderOpen, GitBranch, GitPullRequest, SlidersHorizontal, ArrowDown, Circle, ArrowUpDown } from 'lucide-react'
import { ProjectCard } from './ProjectCard'
import type { Project, OtherDir, AppConfig } from '../types'
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
  onUsageUpdate?: () => void
  onOpenSettings?: () => void
  onOpenClone?: () => void
  onRestoreProject?: (project: Project) => Promise<void>
  onFinalizeProject?: (project: Project) => Promise<void>
  onProjectAccountChange?: (project: Project, account: 'account1' | 'account2') => Promise<void>
  onOpenWorkspace?: (project: Project) => void
}
export const ProjectGrid: React.FC<ProjectGridProps> = (props) => {
  const { projects, otherDirs, config, search, isLoading, onOpenSettings, onOpenClone, onOpenGitInit, onNotify } = props
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
  const techs = useMemo(() => Array.from(new Map(projects.flatMap(p => p.techs.map(t => [t.id, t.label] as const)))), [projects])
  const filtered = useMemo(() => projects.filter(p => {
    const query = search.trim().toLocaleLowerCase()
    return (!query || [p.name, p.path, p.git.branch, ...p.techs.map(t => t.label)].some(v => v.toLocaleLowerCase().includes(query))) &&
      (filter === 'all' || (filter === 'pull' && p.git.isRepo && p.git.behind > 0) || (filter === 'modified' && p.git.isRepo && p.git.hasChanges) || (filter === 'no-git' && !p.git.isRepo)) &&
      (!tech || p.techs.some(t => t.id === tech))
  }).sort((a,b) => sort === 'recent' ? b.lastModified - a.lastModified : a.name.localeCompare(b.name)), [projects, search, filter, tech, sort])
  const selected = filtered.find(p => p.id === selectedId) ?? filtered[0]
  return (
    <main className="project-workspace" aria-busy={isLoading}>
      <section className="project-master" aria-label="Lista de projetos">
        <div className="master-heading"><h1>Projetos</h1><span className="count-badge">{projects.length}</span>{onOpenClone && <button className="icon-button" title="Clonar repositório por link" aria-label="Clonar repositório por link" onClick={onOpenClone}><GitPullRequest size={14} /></button>}</div>
        <div className="project-filters">
          <label><SlidersHorizontal size={14}/><span className="sr-only">Filtrar status Git</span><select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">Todos os projetos</option><option value="pull">Pull pendente</option><option value="modified">Com alterações</option><option value="no-git">Sem Git</option></select></label>
          <div className="filter-secondary"><label><span className="sr-only">Filtrar tecnologia</span><select value={tech} onChange={e => setTech(e.target.value)}><option value="">Todas as tecnologias</option>{techs.map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></label><button className="icon-button" title={sort === 'name' ? 'Ordenar por modificação recente' : 'Ordenar por nome'} aria-label={sort === 'name' ? 'Ordenar por modificação recente' : 'Ordenar por nome'} onClick={() => setSort(sort === 'name' ? 'recent' : 'name')}><ArrowUpDown size={14}/></button></div>
        </div>
        <div className="project-list" aria-label="Selecionar projeto">
          {isLoading && !projects.length ? <p className="list-message" role="status">Lendo projetos…</p> : filtered.map(p => (
            <button key={p.id} className={`project-row ${selected?.id === p.id ? 'selected' : ''}`} aria-pressed={selected?.id === p.id} onClick={() => setSelectedId(p.id)}>
              <span className="project-row-icon"><Folder size={17}/></span>
              <span className="project-row-copy"><strong title={p.name}>{p.name}</strong><span title={p.path}>{p.parentDir}</span><small>{p.lifecycle === 'archived' ? 'Arquivado · pronto para baixar' : p.git.isRepo ? <><GitBranch size={11}/><span>{p.git.branch || 'Sem commits'}</span></> : 'Sem repositório'}</small></span>
              {p.git.behind > 0 ? <span className="row-status" title={`${p.git.behind} commits para receber`}><ArrowDown size={12}/>{p.git.behind}</span> : p.git.hasChanges ? <span className="row-status warning" title="Alterações locais"><Circle size={8} fill="currentColor"/></span> : null}
            </button>
          ))}
          {!isLoading && !filtered.length && <p className="list-message">{projects.length ? 'Nenhum resultado para estes filtros.' : 'Nenhuma pasta adicionada.'}</p>}
        </div>
        {!isLoading && visibleOtherDirs.length > 0 && (
          <div className="other-dirs" aria-label="Outras pastas">
            <div className="master-heading"><h2>Outras pastas</h2><span className="count-badge">{visibleOtherDirs.length}</span></div>
            <p className="list-message">Sem Git ou manifesto — abra a pasta ou adicione Git.</p>
            {visibleOtherDirs.map((dir) => (
              <div key={dir.path} className="project-row">
                <span className="project-row-icon"><Folder size={17} /></span>
                <span className="project-row-copy"><strong title={dir.name}>{dir.name}</strong><span title={dir.path}>{dir.parentDir}</span></span>
                <button className="icon-button" title={`Adicionar Git em ${dir.name}`} aria-label={`Adicionar Git em ${dir.name}`} onClick={() => handleAddGit(dir)}><GitBranch size={14} /></button>
                <button className="icon-button" title={`Abrir pasta ${dir.name}`} aria-label={`Abrir pasta ${dir.name}`} onClick={() => void handleOpenFolder(dir)}><FolderOpen size={14} /></button>
              </div>
            ))}
          </div>
        )}
        <div className="master-footer" role="status">{filtered.length} de {projects.length} projetos<span>{sort === 'name' ? 'Nome A–Z' : 'Mais recentes'}</span></div>
      </section>
      <section className="project-detail" aria-label="Projeto selecionado">
        {selected ? <ProjectCard key={selected.id} {...props} project={selected} config={config}/> : <div className="workspace-empty"><FolderX size={36} strokeWidth={1.2}/><h2>{isLoading ? 'Preparando seu workspace' : projects.length ? 'Nenhum projeto encontrado' : 'Seu próximo projeto começa aqui'}</h2><p>{isLoading ? 'Lendo pastas e verificando o Git.' : projects.length ? 'Altere a busca ou os filtros para continuar.' : 'Adicione uma pasta para reunir projetos, ferramentas e contexto em um só lugar.'}</p>{!isLoading && !projects.length && <button className="primary-button" onClick={onOpenSettings}>Adicionar pasta de projetos</button>}{!isLoading && projects.length > 0 && (filter !== 'all' || tech) && <button className="secondary-button" onClick={() => {setFilter('all'); setTech('')}}>Limpar filtros</button>}</div>}
      </section>
    </main>
  )
}

