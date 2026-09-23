import { describe, expect, it } from 'vitest'
import {
  SITUATION_SEGMENTS,
  branchPillText,
  branchSyncLabel,
  getGitSituation,
  getProjectStatus,
  matchSituationFilter,
  relativeDate,
  situationDotClasses,
  situationLabel,
} from '../src/renderer/src/components/project-library-helpers'
import type { Project } from '../src/renderer/src/types'

// Fábrica de projetos: cobre os campos de Project.git usados na derivação da situação.
const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'Projeto de teste',
  path: 'C:/dev/projeto',
  parentDir: 'C:/dev',
  lastModified: Date.now(),
  techs: [],
  git: { isRepo: true, branch: 'main', ahead: 0, behind: 0, hasChanges: false, modifiedCount: 0, untrackedCount: 0 },
  ...overrides,
})

describe('situação Git do card da biblioteca (getGitSituation)', () => {
  it('repositório alinhado e limpo é "clean"', () => {
    expect(getGitSituation(makeProject())).toBe('clean')
  })

  it('pull pendente (behind) é "pending"', () => {
    expect(getGitSituation(makeProject({ git: { isRepo: true, branch: 'main', ahead: 0, behind: 3, hasChanges: false, modifiedCount: 0, untrackedCount: 0 } }))).toBe('pending')
  })

  it('mudanças locais sem ahead/behind são "pending"', () => {
    expect(getGitSituation(makeProject({ git: { isRepo: true, branch: 'main', ahead: 0, behind: 0, hasChanges: true, modifiedCount: 2, untrackedCount: 1 } }))).toBe('pending')
  })

  it('commits à frente do remoto são "ahead"', () => {
    expect(getGitSituation(makeProject({ git: { isRepo: true, branch: 'main', ahead: 2, behind: 0, hasChanges: false, modifiedCount: 0, untrackedCount: 0 } }))).toBe('ahead')
  })

  it('branch divergente (ahead + behind) é "ahead"', () => {
    expect(getGitSituation(makeProject({ git: { isRepo: true, branch: 'main', ahead: 2, behind: 1, hasChanges: false, modifiedCount: 0, untrackedCount: 0 } }))).toBe('ahead')
  })

  it('statusMessage com conflito/erro é "conflict" (tem precedência)', () => {
    expect(getGitSituation(makeProject({ git: { isRepo: true, branch: 'main', ahead: 0, behind: 0, hasChanges: true, modifiedCount: 1, untrackedCount: 0, statusMessage: 'CONFLICT (content): Merge conflict in arquivo.ts' } }))).toBe('conflict')
    expect(getGitSituation(makeProject({ git: { isRepo: true, branch: 'main', ahead: 0, behind: 0, hasChanges: false, modifiedCount: 0, untrackedCount: 0, statusMessage: 'Erro ao ler o repositório' } }))).toBe('conflict')
  })

  it('pasta sem Git é "none"', () => {
    expect(getGitSituation(makeProject({ git: { isRepo: false, branch: '', ahead: 0, behind: 0, hasChanges: false, modifiedCount: 0, untrackedCount: 0 } }))).toBe('none')
  })

  it('projeto arquivado degrada para "none" sem inventar dado de Git', () => {
    expect(getGitSituation(makeProject({ lifecycle: 'archived' }))).toBe('none')
  })
})

describe('classes do ponto de status (contrato com o harness verify-ui.cjs)', () => {
  it('pendente mantém a classe legada "warning" (o harness filtra .project-status-dot.warning) e recebe git-pending', () => {
    expect(situationDotClasses('pending')).toBe('warning git-pending')
  })

  it('sem Git mantém "neutral" e recebe git-none', () => {
    expect(situationDotClasses('none')).toBe('neutral git-none')
  })

  it('limpo usa "success git-clean" e conflito "danger git-conflict"', () => {
    expect(situationDotClasses('clean')).toBe('success git-clean')
    expect(situationDotClasses('conflict')).toBe('danger git-conflict')
  })

  it('ahead mantém "warning" (legado) com a cor git-ahead', () => {
    expect(situationDotClasses('ahead')).toBe('warning git-ahead')
  })
})

describe('rótulos de situação (aria-label do ponto consultado pelo harness)', () => {
  it('pasta sem Git informa "Git não configurado"', () => {
    // O harness procura /Git/ e /configurado/ no aria-label do ponto.
    expect(situationLabel(makeProject({ git: { isRepo: false, branch: '', ahead: 0, behind: 0, hasChanges: false, modifiedCount: 0, untrackedCount: 0 } }))).toBe('Git não configurado')
  })

  it('rótulos por situação', () => {
    expect(situationLabel(makeProject())).toBe('Sincronizado')
    expect(situationLabel(makeProject({ git: { isRepo: true, branch: 'main', ahead: 0, behind: 2, hasChanges: false, modifiedCount: 0, untrackedCount: 0 } }))).toContain('aguardando pull')
    expect(situationLabel(makeProject({ git: { isRepo: true, branch: 'main', ahead: 1, behind: 0, hasChanges: false, modifiedCount: 0, untrackedCount: 0 } }))).toContain('à frente')
    expect(situationLabel(makeProject({ lifecycle: 'archived' }))).toBe('Projeto arquivado')
  })

  it('getProjectStatus consolida situação, classes e rótulo', () => {
    const status = getProjectStatus(makeProject({ git: { isRepo: true, branch: 'main', ahead: 0, behind: 1, hasChanges: false, modifiedCount: 0, untrackedCount: 0 } }))
    expect(status).toEqual({ situation: 'pending', classes: 'warning git-pending', label: '1 commit(s) aguardando pull' })
  })
})

describe('filtro segmentado por situação real (matchSituationFilter)', () => {
  const clean = makeProject({ id: 'clean' })
  const pending = makeProject({ id: 'pending', git: { isRepo: true, branch: 'dev', ahead: 0, behind: 2, hasChanges: false, modifiedCount: 0, untrackedCount: 0 } })
  const ahead = makeProject({ id: 'ahead', git: { isRepo: true, branch: 'dev', ahead: 4, behind: 0, hasChanges: false, modifiedCount: 0, untrackedCount: 0 } })
  const noGit = makeProject({ id: 'no-git', git: { isRepo: false, branch: '', ahead: 0, behind: 0, hasChanges: false, modifiedCount: 0, untrackedCount: 0 } })
  const archived = makeProject({ id: 'archived', lifecycle: 'archived' })
  const projects = [clean, pending, ahead, noGit, archived]

  it('"all" inclui tudo, inclusive arquivados', () => {
    expect(projects.filter((p) => matchSituationFilter(p, 'all'))).toHaveLength(5)
  })

  it('"pending" pega behind/hasChanges/conflito/à frente e exclui limpo, sem Git e arquivado', () => {
    expect(projects.filter((p) => matchSituationFilter(p, 'pending')).map((p) => p.id)).toEqual(['pending', 'ahead'])
  })

  it('"clean" pega apenas repositórios alinhados não arquivados', () => {
    expect(projects.filter((p) => matchSituationFilter(p, 'clean')).map((p) => p.id)).toEqual(['clean'])
  })

  it('"none" pega apenas pastas sem Git não arquivadas', () => {
    expect(projects.filter((p) => matchSituationFilter(p, 'none')).map((p) => p.id)).toEqual(['no-git'])
  })

  it('"archived" pega apenas arquivados', () => {
    expect(projects.filter((p) => matchSituationFilter(p, 'archived')).map((p) => p.id)).toEqual(['archived'])
  })

  it('sem arquivados, as situações pendentes+limpas+sem Git cobrem todos os projetos', () => {
    const active = [clean, pending, ahead, noGit]
    const counted = active.filter((p) => matchSituationFilter(p, 'pending') || matchSituationFilter(p, 'clean') || matchSituationFilter(p, 'none'))
    expect(counted).toHaveLength(active.length)
  })

  it('segmentos expõem rótulo e classe de ponto para o segmentado', () => {
    expect(SITUATION_SEGMENTS.map((s) => s.key)).toEqual(['all', 'pending', 'clean', 'none', 'archived'])
    expect(SITUATION_SEGMENTS.find((s) => s.key === 'pending')).toMatchObject({ label: 'Pendentes', dotClass: 'git-pending' })
    expect(SITUATION_SEGMENTS.find((s) => s.key === 'clean')).toMatchObject({ label: 'Limpos', dotClass: 'git-clean' })
  })
})

describe('pílula de branch do card', () => {
  it('mostra o branch e as setas ↑n ↓n quando houver ahead/behind', () => {
    expect(branchSyncLabel(makeProject({ git: { isRepo: true, branch: 'main', ahead: 2, behind: 1, hasChanges: false, modifiedCount: 0, untrackedCount: 0 } }))).toBe('↑2 ↓1')
    expect(branchSyncLabel(makeProject({ git: { isRepo: true, branch: 'main', ahead: 3, behind: 0, hasChanges: false, modifiedCount: 0, untrackedCount: 0 } }))).toBe('↑3')
    expect(branchSyncLabel(makeProject({ git: { isRepo: true, branch: 'main', ahead: 0, behind: 4, hasChanges: false, modifiedCount: 0, untrackedCount: 0 } }))).toBe('↓4')
    expect(branchSyncLabel(makeProject())).toBe('')
  })

  it('sem Git mostra "sem repositório"; repo sem branch mostra "sem branch"', () => {
    expect(branchPillText(makeProject({ git: { isRepo: false, branch: '', ahead: 0, behind: 0, hasChanges: false, modifiedCount: 0, untrackedCount: 0 } }))).toBe('sem repositório')
    expect(branchPillText(makeProject({ git: { isRepo: true, branch: '', ahead: 0, behind: 0, hasChanges: false, modifiedCount: 0, untrackedCount: 0 } }))).toBe('sem branch')
    expect(branchPillText(makeProject())).toBe('main')
  })
})

describe('data relativa do rodapé do card', () => {
  it('formata minutos, horas e dias', () => {
    const now = Date.now()
    expect(relativeDate(now)).toBe('agora')
    expect(relativeDate(now - 30 * 60_000)).toBe('há 30min')
    expect(relativeDate(now - 5 * 3_600_000)).toBe('há 5h')
    expect(relativeDate(now - 12 * 86_400_000)).toBe('há 12d')
  })

  it('valor inválido cai em "Data desconhecida"', () => {
    expect(relativeDate(0)).toBe('Data desconhecida')
    expect(relativeDate(Number.NaN)).toBe('Data desconhecida')
  })
})
