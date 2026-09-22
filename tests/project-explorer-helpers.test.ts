import { describe, expect, it } from 'vitest'
import type { OtherDir, Project } from '../src/renderer/src/types'
import {
  computeFolderGroupSummary,
  filterExplorerGroups,
  groupProjectsByParent,
  normalizeFolderPath,
  resolveParentFolderLabel,
} from '../src/renderer/src/components/project-explorer-helpers'

function createMockProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-' + Math.random().toString(36).slice(2, 8),
    name: 'Projeto Padrão',
    path: 'C:/Users/test/Projects/devorbit',
    parentDir: 'Projects',
    parentPath: 'C:/Users/test/Projects',
    lastModified: 1700000000000,
    techs: [{ id: 'react', label: 'React', color: '#61dafb' }],
    git: {
      isRepo: true,
      branch: 'main',
      ahead: 0,
      behind: 0,
      hasChanges: false,
      modifiedCount: 0,
      untrackedCount: 0,
    },
    ...overrides,
  }
}

describe('project-explorer-helpers — Agrupador do Explorador de Projetos', () => {
  describe('normalizeFolderPath', () => {
    it('normaliza contrabarras para barras normais e elimina espaços', () => {
      expect(normalizeFolderPath('C:\\Users\\test\\Projects')).toBe('C:/Users/test/Projects')
      expect(normalizeFolderPath('  /home/user/code/  ')).toBe('/home/user/code')
    })

    it('remove barras redundantes e barras finais (exceto raiz)', () => {
      expect(normalizeFolderPath('C:\\Users\\\\test//Projects/')).toBe('C:/Users/test/Projects')
      expect(normalizeFolderPath('/var/www/html/')).toBe('/var/www/html')
      expect(normalizeFolderPath('/')).toBe('/')
    })

    it('preserva e padroniza raízes de unidade do Windows com barra final', () => {
      expect(normalizeFolderPath('c:\\')).toBe('C:/')
      expect(normalizeFolderPath('d:')).toBe('D:/')
      expect(normalizeFolderPath('C:/')).toBe('C:/')
    })

    it('trata valores vazios ou não-string com fallback seguro', () => {
      expect(normalizeFolderPath('')).toBe('')
      expect(normalizeFolderPath(null)).toBe('')
      expect(normalizeFolderPath(undefined)).toBe('')
      expect(normalizeFolderPath('   ')).toBe('')
    })
  })

  describe('resolveParentFolderLabel', () => {
    it('extrai rótulo seguro e legível a partir de caminho completo', () => {
      const info = resolveParentFolderLabel('C:/Users/test/Trabalho')
      expect(info.label).toBe('Trabalho')
      expect(info.key).toBe('c:/users/test/trabalho')
      expect(info.resolvedPath).toBe('C:/Users/test/Trabalho')
    })

    it('reconhece raiz de unidade no Windows', () => {
      const info = resolveParentFolderLabel('C:/')
      expect(info.label).toBe('Disco (C:)')
      expect(info.key).toBe('c:/')
      expect(info.resolvedPath).toBe('C:/')
    })

    it('reconhece raiz Unix', () => {
      const info = resolveParentFolderLabel('/')
      expect(info.label).toBe('Raiz do sistema (/)')
      expect(info.key).toBe('/')
      expect(info.resolvedPath).toBe('/')
    })

    it('deduz a pasta pai a partir do caminho do projeto quando parentPath estiver ausente', () => {
      const info = resolveParentFolderLabel(null, 'C:/Users/test/Clients/AcmeApp')
      expect(info.label).toBe('Clients')
      expect(info.key).toBe('c:/users/test/clients')
      expect(info.resolvedPath).toBe('C:/Users/test/Clients')
    })

    it('atribui rótulo seguro de fallback quando não houver qualquer caminho', () => {
      const info = resolveParentFolderLabel('', '')
      expect(info.label).toBe('Outros projetos')
      expect(info.key).toBe('__unassigned__')
    })

    it('higieniza caracteres de controle invisíveis', () => {
      const info = resolveParentFolderLabel('C:/Users/\u0000Projeto\u001F')
      expect(info.label).toBe('Projeto')
    })
  })

  describe('computeFolderGroupSummary', () => {
    it('sintetiza métricas de saúde Git, contagens e timestamp mais recente', () => {
      const p1 = createMockProject({
        lastModified: 1000,
        git: { isRepo: true, branch: 'main', ahead: 2, behind: 0, hasChanges: true, modifiedCount: 1, untrackedCount: 0 },
      })
      const p2 = createMockProject({
        lastModified: 2000,
        lifecycle: 'archived',
        git: { isRepo: true, branch: 'main', ahead: 0, behind: 3, hasChanges: false, modifiedCount: 0, untrackedCount: 0 },
      })
      const p3 = createMockProject({
        lastModified: 1500,
        git: { isRepo: false, branch: '', ahead: 0, behind: 0, hasChanges: false, modifiedCount: 0, untrackedCount: 0 },
      })
      const otherDir: OtherDir = { name: 'Notas', path: 'C:/Projects/Notas', parentDir: 'Projects' }

      const summary = computeFolderGroupSummary([p1, p2, p3], [otherDir])

      expect(summary.totalCount).toBe(4)
      expect(summary.projectCount).toBe(3)
      expect(summary.otherDirCount).toBe(1)
      expect(summary.gitCount).toBe(2)
      expect(summary.changesCount).toBe(1)
      expect(summary.aheadCount).toBe(1)
      expect(summary.behindCount).toBe(1)
      expect(summary.archivedCount).toBe(1)
      expect(summary.latestModified).toBe(2000)
    })
  })

  describe('groupProjectsByParent', () => {
    const projA1 = createMockProject({
      id: 'a1',
      name: 'Alpha App',
      path: 'C:/Work/Projects/Alpha',
      parentPath: 'C:/Work/Projects',
      lastModified: 100,
    })
    const projA2 = createMockProject({
      id: 'a2',
      name: 'Beta Tool',
      path: 'C:/Work/Projects/Beta',
      parentPath: 'C:/Work/Projects',
      lastModified: 300,
    })
    const projB1 = createMockProject({
      id: 'b1',
      name: 'Zeta Lib',
      path: 'C:/Personal/Zeta',
      parentPath: 'C:/Personal',
      lastModified: 500,
    })
    const otherDir: OtherDir = {
      name: 'Drafts',
      path: 'C:/Personal/Drafts',
      parentDir: 'C:/Personal',
    }

    it('agrupa projetos sob as respectivas pastas pai com identificadores seguros', () => {
      const groups = groupProjectsByParent([projA1, projA2, projB1], { otherDirs: [otherDir] })

      expect(groups).toHaveLength(2)
      // Ordenação padrão alfabética das pastas: Personal antes de Projects
      expect(groups[0].label).toBe('Personal')
      expect(groups[0].projects).toHaveLength(1)
      expect(groups[0].otherDirs).toHaveLength(1)
      expect(groups[0].otherDirs[0].name).toBe('Drafts')

      expect(groups[1].label).toBe('Projects')
      expect(groups[1].projects).toHaveLength(2)
    })

    it('ordena projetos dentro de cada grupo por modificação recente por padrão', () => {
      const groups = groupProjectsByParent([projA1, projA2])
      const projGroup = groups.find((g) => g.label === 'Projects')

      expect(projGroup).toBeDefined()
      // Beta (300) mais recente que Alpha (100)
      expect(projGroup?.projects[0].id).toBe('a2')
      expect(projGroup?.projects[1].id).toBe('a1')
    })

    it('suporta ordenação interna por nome com desempate determinístico', () => {
      const groups = groupProjectsByParent([projA2, projA1], {
        projectSortBy: 'name',
        projectSortDirection: 'asc',
      })
      const projGroup = groups.find((g) => g.label === 'Projects')

      expect(projGroup?.projects[0].name).toBe('Alpha App')
      expect(projGroup?.projects[1].name).toBe('Beta Tool')
    })

    it('ordena grupos por modificação mais recente quando configurado', () => {
      // Personal tem último modificado 500; Projects tem 300
      const groups = groupProjectsByParent([projA1, projA2, projB1], {
        groupBySort: 'recent',
        groupSortDirection: 'desc',
      })

      expect(groups[0].label).toBe('Personal')
      expect(groups[1].label).toBe('Projects')
    })

    it('ordena grupos por quantidade de itens quando configurado', () => {
      // Projects tem 2 projetos; Personal tem 1 projeto
      const groups = groupProjectsByParent([projA1, projA2, projB1], {
        groupBySort: 'count',
        groupSortDirection: 'desc',
      })

      expect(groups[0].label).toBe('Projects')
      expect(groups[1].label).toBe('Personal')
    })
  })

  describe('filterExplorerGroups', () => {
    const pReact = createMockProject({
      id: 'p1',
      name: 'Frontend Web',
      path: 'C:/Dev/Frontend',
      parentPath: 'C:/Dev',
      techs: [{ id: 'react', label: 'React', color: '#61dafb' }],
      git: { isRepo: true, branch: 'feat/login', ahead: 1, behind: 0, hasChanges: true, modifiedCount: 1, untrackedCount: 0 },
    })
    const pNode = createMockProject({
      id: 'p2',
      name: 'Backend API',
      path: 'C:/Dev/Backend',
      parentPath: 'C:/Dev',
      techs: [{ id: 'node', label: 'Node', color: '#339933' }],
      git: { isRepo: true, branch: 'main', ahead: 0, behind: 2, hasChanges: false, modifiedCount: 0, untrackedCount: 0 },
    })
    const pOther = createMockProject({
      id: 'p3',
      name: 'Mobile Flutter',
      path: 'C:/Mobile/FlutterApp',
      parentPath: 'C:/Mobile',
      techs: [{ id: 'flutter', label: 'Flutter', color: '#02569b' }],
      git: { isRepo: false, branch: '', ahead: 0, behind: 0, hasChanges: false, modifiedCount: 0, untrackedCount: 0 },
    })

    const groups = groupProjectsByParent([pReact, pNode, pOther])

    it('filtra por busca textual no nome do projeto', () => {
      const filtered = filterExplorerGroups(groups, { query: 'backend' })
      expect(filtered).toHaveLength(1)
      expect(filtered[0].label).toBe('Dev')
      expect(filtered[0].projects).toHaveLength(1)
      expect(filtered[0].projects[0].name).toBe('Backend API')
      expect(filtered[0].summary.projectCount).toBe(1)
    })

    it('filtra por busca textual na branch Git', () => {
      const filtered = filterExplorerGroups(groups, { query: 'feat/login' })
      expect(filtered).toHaveLength(1)
      expect(filtered[0].projects[0].name).toBe('Frontend Web')
    })

    it('filtra por busca textual no nome da pasta pai', () => {
      const filtered = filterExplorerGroups(groups, { query: 'mobile' })
      expect(filtered).toHaveLength(1)
      expect(filtered[0].label).toBe('Mobile')
      expect(filtered[0].projects).toHaveLength(1)
    })

    it('filtra por status Git: pull pendente', () => {
      const filtered = filterExplorerGroups(groups, { gitFilter: 'pull' })
      expect(filtered).toHaveLength(1)
      expect(filtered[0].projects[0].name).toBe('Backend API')
    })

    it('filtra por status Git: com alterações', () => {
      const filtered = filterExplorerGroups(groups, { gitFilter: 'modified' })
      expect(filtered).toHaveLength(1)
      expect(filtered[0].projects[0].name).toBe('Frontend Web')
    })

    it('filtra por status Git: sem repositório Git', () => {
      const filtered = filterExplorerGroups(groups, { gitFilter: 'no-git' })
      expect(filtered).toHaveLength(1)
      expect(filtered[0].projects[0].name).toBe('Mobile Flutter')
    })

    it('filtra por tecnologia', () => {
      const filtered = filterExplorerGroups(groups, { techFilter: 'react' })
      expect(filtered).toHaveLength(1)
      expect(filtered[0].projects[0].name).toBe('Frontend Web')
    })

    it('retorna lista inalterada se nenhum filtro for aplicado', () => {
      const unfiltered = filterExplorerGroups(groups, { query: '', gitFilter: 'all' })
      expect(unfiltered).toHaveLength(2)
      expect(unfiltered[0].projects.length + unfiltered[1].projects.length).toBe(3)
    })
  })
})
