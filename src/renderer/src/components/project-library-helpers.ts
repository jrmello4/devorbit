import type { Project } from '../types'

/**
 * Situação Git derivada EXCLUSIVAMENTE dos campos de Project.git
 * (isRepo, ahead, behind, hasChanges, statusMessage) e de lifecycle.
 * Se um caso não puder ser determinado, degrada para 'none' sem inventar dado.
 */
export type ProjectGitSituation = 'clean' | 'pending' | 'ahead' | 'conflict' | 'none'

/** Filtro por situação real da biblioteca (segmentado acima da grade). */
export type SituationFilter = 'all' | 'pending' | 'clean' | 'none' | 'archived'

/**
 * Deriva a situação Git de um projeto:
 * - 'conflict': statusMessage indica erro/conflito reportado pelo Git.
 * - 'ahead': commits locais à frente do remoto (inclusive divergido ahead+behind).
 * - 'pending': mudanças locais não commitadas OU pull pendente (behind).
 * - 'clean': repositório alinhado e sem alterações.
 * - 'none': sem repositório Git — ou projeto arquivado (cópia local liberada,
 *   o estado Git conhecido não é confiável).
 */
export function getGitSituation(project: Project): ProjectGitSituation {
  if (project.lifecycle === 'archived') return 'none'
  const { git } = project
  if (!git.isRepo) return 'none'
  const message = (git.statusMessage || '').toLocaleLowerCase()
  if (/erro|error|conflit|conflict/.test(message)) return 'conflict'
  if (git.ahead > 0) return 'ahead'
  if (git.behind > 0 || git.hasChanges) return 'pending'
  return 'clean'
}

/**
 * Classes CSS do ponto de status. O sufixo git-* recebe a cor da situação
 * (var(--color-git-*)). A classe base (success/warning/danger/neutral) é o
 * contrato legado consultado pelo harness scripts/verify-ui.cjs
 * (".project-status-dot.warning" após filtrar por situação Git) — não remover.
 */
export function situationDotClasses(situation: ProjectGitSituation): string {
  switch (situation) {
    case 'clean':
      return 'success git-clean'
    case 'pending':
      return 'warning git-pending'
    case 'ahead':
      return 'warning git-ahead'
    case 'conflict':
      return 'danger git-conflict'
    default:
      return 'neutral git-none'
  }
}

/** Rótulo acessível/tooltip da situação Git do projeto. */
export function situationLabel(project: Project): string {
  if (project.lifecycle === 'archived') return 'Projeto arquivado'
  const { git } = project
  if (!git.isRepo) return 'Git não configurado'
  const message = (git.statusMessage || '').toLocaleLowerCase()
  if (/erro|error|conflit|conflict/.test(message)) {
    return git.statusMessage || 'Erro ou conflito no Git'
  }
  if (git.ahead > 0 && git.behind > 0) {
    return `Branch divergente: ${git.ahead} à frente, ${git.behind} atrás`
  }
  if (git.ahead > 0) return `${git.ahead} commit(s) à frente do remoto`
  if (git.behind > 0) return `${git.behind} commit(s) aguardando pull`
  if (git.hasChanges) return 'Alterações locais pendentes'
  return 'Sincronizado'
}

export interface ProjectStatusView {
  situation: ProjectGitSituation
  classes: string
  label: string
}

/** Visão consolidada de status usada pelo card da biblioteca. */
export function getProjectStatus(project: Project): ProjectStatusView {
  const situation = getGitSituation(project)
  return { situation, classes: situationDotClasses(situation), label: situationLabel(project) }
}

/** Texto da pílula de branch: o branch, ou um rótulo neutro quando não há Git. */
export function branchPillText(project: Project): string {
  if (!project.git.isRepo) return 'sem repositório'
  return project.git.branch || 'sem branch'
}

/** Seta de sincronismo da pílula: "↑n ↓n" quando houver ahead/behind. */
export function branchSyncLabel(project: Project): string {
  const parts: string[] = []
  if (project.git.isRepo && project.git.ahead > 0) parts.push(`↑${project.git.ahead}`)
  if (project.git.isRepo && project.git.behind > 0) parts.push(`↓${project.git.behind}`)
  return parts.join(' ')
}

/**
 * Casamento do filtro por situação. Projetos arquivados só aparecem em 'all'
 * e 'archived'. 'pending' é o complemento de limpo/sem Git: mudanças locais,
 * pull pendente, commits à frente (trabalho não publicado) e conflitos — assim
 * as contagens do segmentado somam o total, como na proposta visual.
 */
export function matchSituationFilter(project: Project, filter: SituationFilter): boolean {
  const archived = project.lifecycle === 'archived'
  switch (filter) {
    case 'all':
      return true
    case 'archived':
      return archived
    case 'none':
      return !archived && !project.git.isRepo
    default: {
      if (archived) return false
      const situation = getGitSituation(project)
      if (filter === 'clean') return situation === 'clean'
      return situation === 'pending' || situation === 'ahead' || situation === 'conflict'
    }
  }
}

/** Segmentos do filtro segmentado, com a cor de ponto de cada situação. */
export const SITUATION_SEGMENTS: ReadonlyArray<{
  key: SituationFilter
  label: string
  dotClass: string
}> = [
  { key: 'all', label: 'Todas as situações', dotClass: 'git-none' },
  { key: 'pending', label: 'Pendentes', dotClass: 'git-pending' },
  { key: 'clean', label: 'Limpos', dotClass: 'git-clean' },
  { key: 'none', label: 'Sem Git', dotClass: 'git-none' },
  { key: 'archived', label: 'Arquivados', dotClass: 'git-none' },
]

/** Datas relativas curtas para o rodapé do card ("há 12d", "há 3h", "agora"). */
export function relativeDate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return 'Data desconhecida'
  const minutes = Math.floor(Math.max(0, Date.now() - value) / 60000)
  if (minutes < 1) return 'agora'
  if (minutes < 60) return `há ${minutes}min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `há ${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `há ${days}d`
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(value)
}
