import type { OtherDir, Project } from '../types'

export type ExplorerSortBy = 'name' | 'recent' | 'count'
export type ExplorerSortDirection = 'asc' | 'desc'

export interface ProjectExplorerGroupingOptions {
  /**
   * Critério de ordenação dos grupos de pastas.
   * - 'name': Alfabética pelo rótulo da pasta (padrão)
   * - 'recent': Pela data de modificação mais recente entre os projetos da pasta
   * - 'count': Pela quantidade total de projetos na pasta
   */
  groupBySort?: ExplorerSortBy
  groupSortDirection?: ExplorerSortDirection
  /**
   * Critério de ordenação dos projetos dentro de cada grupo.
   * - 'recent': Pela data da última modificação (mais recentes primeiro - padrão)
   * - 'name': Alfabética pelo nome do projeto
   */
  projectSortBy?: 'name' | 'recent'
  projectSortDirection?: ExplorerSortDirection
  /**
   * Pastas adicionais sem repositório Git/manifesto (OtherDir) para incluir no agrupamento.
   */
  otherDirs?: OtherDir[]
}

export interface FolderGroupSummary {
  totalCount: number
  projectCount: number
  otherDirCount: number
  gitCount: number
  changesCount: number
  behindCount: number
  aheadCount: number
  archivedCount: number
  latestModified: number
}

export interface ParentFolderGroup {
  /** Chave canônica estável em minúsculas para agrupamento determinístico */
  key: string
  /** Rótulo seguro e legível para exibição visual */
  label: string
  /** Caminho resolvido ou normalizado da pasta pai */
  resolvedPath: string
  /** Projetos pertencentes a este grupo */
  projects: Project[]
  /** Pastas não-projetos associadas */
  otherDirs: OtherDir[]
  /** Resumo quantitativo e de saúde Git do grupo */
  summary: FolderGroupSummary
}

/**
 * Normaliza caminhos de arquivo para formato com barras normais (forward slashes),
 * removendo barras duplicadas ou redundantes no final (mantendo raízes de disco).
 */
export function normalizeFolderPath(rawPath?: string | null): string {
  if (!rawPath || typeof rawPath !== 'string') return ''
  const trimmed = rawPath.trim()
  if (!trimmed) return ''

  // Substitui contrabarras por barras normais
  let normalized = trimmed.replace(/\\+/g, '/')

  // Remove barras normais duplicadas contíguas
  normalized = normalized.replace(/\/{2,}/g, '/')

  // Trata raízes de unidade Windows como "C:/" ou "C:"
  if (/^[a-zA-Z]:\/?$/.test(normalized)) {
    return normalized.slice(0, 2).toUpperCase() + '/'
  }

  // Remove barra final se não for raiz de barra única '/'
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }

  return normalized
}

/**
 * Extrai rótulo legível e seguro para uma pasta pai, tratando diretórios
 * relativos, caminhos Windows, caminhos Unix e entradas ausentes.
 */
export function resolveParentFolderLabel(
  parentPathOrDir?: string | null,
  fallbackProjectPath?: string | null,
): { key: string; label: string; resolvedPath: string } {
  const normParent = normalizeFolderPath(parentPathOrDir)
  let resolved = normParent

  // Se não foi informada a pasta pai diretamente, tenta extrair da pasta pai do projeto
  if (!resolved && fallbackProjectPath) {
    const normProject = normalizeFolderPath(fallbackProjectPath)
    const lastSlash = normProject.lastIndexOf('/')
    if (lastSlash > 0) {
      resolved = normProject.slice(0, lastSlash)
    } else if (lastSlash === 0) {
      resolved = '/'
    }
  }

  if (!resolved) {
    return {
      key: '__unassigned__',
      label: 'Outros projetos',
      resolvedPath: '',
    }
  }

  // Raiz de disco no Windows (ex.: "C:/")
  if (/^[a-zA-Z]:\/$/.test(resolved)) {
    const driveLetter = resolved.slice(0, 2).toUpperCase()
    return {
      key: resolved.toLowerCase(),
      label: `Disco (${driveLetter})`,
      resolvedPath: resolved,
    }
  }

  // Raiz Unix "/"
  if (resolved === '/') {
    return {
      key: '/',
      label: 'Raiz do sistema (/)',
      resolvedPath: '/',
    }
  }

  // Extrai o basename da pasta
  const segments = resolved.split('/').filter(Boolean)
  const basename = segments[segments.length - 1] || resolved

  // Rótulo seguro: higieniza caracteres de controle ASCII e C1 sem disparar no-control-regex
  let cleanLabel = ''
  for (let i = 0; i < basename.length; i++) {
    const code = basename.charCodeAt(i)
    if (code >= 32 && code !== 127 && (code < 128 || code > 159)) {
      cleanLabel += basename[i]
    }
  }
  const safeLabel = cleanLabel.trim() || 'Pasta'

  return {
    key: resolved.toLowerCase(),
    label: safeLabel,
    resolvedPath: resolved,
  }
}

/**
 * Calcula o resumo quantitativo e de status Git de um grupo de projetos e pastas.
 */
export function computeFolderGroupSummary(
  projects: Project[],
  otherDirs: OtherDir[] = [],
): FolderGroupSummary {
  let gitCount = 0
  let changesCount = 0
  let behindCount = 0
  let aheadCount = 0
  let archivedCount = 0
  let latestModified = 0

  for (const project of projects) {
    if (project.git?.isRepo) gitCount++
    if (project.git?.hasChanges) changesCount++
    if (project.git?.behind > 0) behindCount++
    if (project.git?.ahead > 0) aheadCount++
    if (project.lifecycle === 'archived') archivedCount++
    if (project.lastModified && project.lastModified > latestModified) {
      latestModified = project.lastModified
    }
  }

  return {
    totalCount: projects.length + otherDirs.length,
    projectCount: projects.length,
    otherDirCount: otherDirs.length,
    gitCount,
    changesCount,
    behindCount,
    aheadCount,
    archivedCount,
    latestModified,
  }
}

const COLLATOR = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true })

/**
 * Agrupa uma lista de projetos (e pastas avulsas) por pasta pai de forma
 * estável, determinística e livre de efeitos colaterais.
 */
export function groupProjectsByParent(
  projects: readonly Project[],
  options: ProjectExplorerGroupingOptions = {},
): ParentFolderGroup[] {
  const {
    groupBySort = 'name',
    groupSortDirection = 'asc',
    projectSortBy = 'recent',
    projectSortDirection = 'desc',
    otherDirs = [],
  } = options

  const groupsMap = new Map<
    string,
    {
      key: string
      label: string
      resolvedPath: string
      projects: Project[]
      otherDirs: OtherDir[]
    }
  >()

  // 1. Processa os projetos
  for (const project of projects) {
    const parentCandidate = project.parentPath || project.parentDir
    const { key, label, resolvedPath } = resolveParentFolderLabel(parentCandidate, project.path)

    let group = groupsMap.get(key)
    if (!group) {
      group = {
        key,
        label,
        resolvedPath,
        projects: [],
        otherDirs: [],
      }
      groupsMap.set(key, group)
    }

    group.projects.push(project)
  }

  // 2. Processa as pastas avulsas (OtherDir), se houver
  for (const dir of otherDirs) {
    const { key, label, resolvedPath } = resolveParentFolderLabel(dir.parentDir, dir.path)

    let group = groupsMap.get(key)
    if (!group) {
      group = {
        key,
        label,
        resolvedPath,
        projects: [],
        otherDirs: [],
      }
      groupsMap.set(key, group)
    }

    group.otherDirs.push(dir)
  }

  // 3. Ordena os itens internos e constrói a lista de grupos
  const result: ParentFolderGroup[] = []

  for (const group of groupsMap.values()) {
    // Ordenação determinística e estável dos projetos dentro do grupo
    const sortedProjects = [...group.projects].sort((a, b) => {
      let diff = 0
      if (projectSortBy === 'recent') {
        const timeA = a.lastModified || 0
        const timeB = b.lastModified || 0
        diff = projectSortDirection === 'asc' ? timeA - timeB : timeB - timeA
      } else {
        diff = COLLATOR.compare(a.name, b.name)
        if (projectSortDirection === 'desc') diff = -diff
      }

      // Desempate determinístico estável
      if (diff === 0) {
        diff = a.id.localeCompare(b.id)
      }
      return diff
    })

    // Ordenação alfabética das pastas avulsas
    const sortedOtherDirs = [...group.otherDirs].sort((a, b) => COLLATOR.compare(a.name, b.name))

    const summary = computeFolderGroupSummary(sortedProjects, sortedOtherDirs)

    result.push({
      key: group.key,
      label: group.label,
      resolvedPath: group.resolvedPath,
      projects: sortedProjects,
      otherDirs: sortedOtherDirs,
      summary,
    })
  }

  // 4. Ordenação dos grupos de pastas
  result.sort((groupA, groupB) => {
    let diff = 0

    if (groupBySort === 'name') {
      diff = COLLATOR.compare(groupA.label, groupB.label)
      if (groupSortDirection === 'desc') diff = -diff
    } else if (groupBySort === 'recent') {
      const timeA = groupA.summary.latestModified
      const timeB = groupB.summary.latestModified
      diff = groupSortDirection === 'asc' ? timeA - timeB : timeB - timeA
    } else if (groupBySort === 'count') {
      const countA = groupA.summary.totalCount
      const countB = groupB.summary.totalCount
      diff = groupSortDirection === 'asc' ? countA - countB : countB - countA
    }

    // Desempate estável pela chave canônica
    if (diff === 0) {
      diff = groupA.key.localeCompare(groupB.key)
    }

    return diff
  })

  return result
}

/**
 * Filtra grupos de pastas por termo de busca textual e status Git.
 * Mantém pastas caso o nome da pasta coincida com a busca ou contenha projetos filtrados.
 */
export function filterExplorerGroups(
  groups: readonly ParentFolderGroup[],
  filters: {
    query?: string
    gitFilter?: 'all' | 'pull' | 'modified' | 'no-git' | 'archived'
    techFilter?: string
  } = {},
): ParentFolderGroup[] {
  const { query = '', gitFilter = 'all', techFilter = '' } = filters
  const cleanQuery = query.trim().toLowerCase()

  if (!cleanQuery && gitFilter === 'all' && !techFilter) {
    return [...groups]
  }

  const filtered: ParentFolderGroup[] = []

  for (const group of groups) {
    const groupMatchesQuery = cleanQuery ? group.label.toLowerCase().includes(cleanQuery) : false

    const matchedProjects = group.projects.filter((project) => {
      // Filtro Git
      if (gitFilter === 'pull' && !(project.git?.behind > 0)) return false
      if (gitFilter === 'modified' && !project.git?.hasChanges) return false
      if (gitFilter === 'no-git' && project.git?.isRepo) return false
      if (gitFilter === 'archived' && project.lifecycle !== 'archived') return false

      // Filtro de Tecnologia
      if (techFilter && !project.techs?.some((t) => t.id === techFilter)) {
        return false
      }

      // Se a pasta já deu match na query, inclui o projeto
      if (!cleanQuery || groupMatchesQuery) return true

      // Filtro de texto no projeto
      const nameMatches = project.name.toLowerCase().includes(cleanQuery)
      const pathMatch = project.path.toLowerCase().includes(cleanQuery)
      const branchMatch = project.git?.branch?.toLowerCase().includes(cleanQuery)
      return nameMatches || pathMatch || Boolean(branchMatch)
    })

    const matchedOtherDirs = group.otherDirs.filter((dir) => {
      if (gitFilter !== 'all' && gitFilter !== 'no-git') return false
      if (techFilter) return false
      if (!cleanQuery || groupMatchesQuery) return true
      return (
        dir.name.toLowerCase().includes(cleanQuery) || dir.path.toLowerCase().includes(cleanQuery)
      )
    })

    if (matchedProjects.length > 0 || matchedOtherDirs.length > 0) {
      filtered.push({
        ...group,
        projects: matchedProjects,
        otherDirs: matchedOtherDirs,
        summary: computeFolderGroupSummary(matchedProjects, matchedOtherDirs),
      })
    }
  }

  return filtered
}
