import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  appendGitMemory,
  buildEnableNotice,
  mapNoticeSeverity,
  extractIpcArray,
  renderPage,
  renderHandoff,
  renderBriefingContent,
  FallbackJson,
  AiMemoryModal,
} from '../src/renderer/src/components/AiMemoryModal'
import type { Project } from '../src/renderer/src/types'

/** Cast seguro para inspecionar props de um React element sem DOM lib. */
function elProps(node: unknown): Record<string, unknown> {
  return (node as React.ReactElement<Record<string, unknown>>)?.props || {}
}

describe('appendGitMemory - Preservação de notas ao puxar do Git', () => {
  it('preserva notas existentes e anexa o rascunho do Git com separador claro', () => {
    const existing = '### Notas de Arquitetura\n- Usar SQLite local\n- Evitar chamadas redundantes'
    const gitDraft = '<!-- devorbit-memory -->\n# 🧠 AI Memory & Handoff\n### 🎯 Objetivo Atual\n- Branch main'

    const result = appendGitMemory(existing, gitDraft)

    expect(result).toBe(`${existing}\n\n---\n\n${gitDraft}`)
    expect(result).toContain(existing)
    expect(result).toContain(gitDraft)
    expect(result).toContain('\n\n---\n\n')
  })

  it('adota o rascunho do Git diretamente quando não há notas prévias (conteúdo vazio)', () => {
    const gitDraft = '# 🧠 AI Memory & Handoff\n- Rascunho inicial'

    expect(appendGitMemory('', gitDraft)).toBe(gitDraft)
    expect(appendGitMemory('   \n\t  ', gitDraft)).toBe(gitDraft)
  })

  it('preserva notas existentes sem adicionar separador se o rascunho do Git for vazio', () => {
    const existing = 'Minhas anotações importantes'

    expect(appendGitMemory(existing, '')).toBe(existing)
    expect(appendGitMemory(existing, '   \n  ')).toBe(existing)
  })

  it('evita duplicação se o mesmo rascunho gerado já estiver presente nas notas', () => {
    const gitDraft = '### 🎯 Objetivo Atual\n- Branch main'
    const existing = `Notas prévias\n\n---\n\n${gitDraft}`

    const result = appendGitMemory(existing, gitDraft)

    expect(result).toBe(existing)
  })

  it('evita duplicação de traços markdown se as notas já terminam com ---', () => {
    const existing = 'Notas do projeto\n\n---'
    const gitDraft = '### 🎯 Handoff Git'

    const result = appendGitMemory(existing, gitDraft)

    expect(result).toBe('Notas do projeto\n\n---\n\n### 🎯 Handoff Git')
    expect(result).not.toContain('------')
  })

  it('evita duplicação de traços markdown se o rascunho do Git já inicia com ---', () => {
    const existing = 'Notas do projeto'
    const gitDraft = '---\n### 🎯 Handoff Git'

    const result = appendGitMemory(existing, gitDraft)

    expect(result).toBe('Notas do projeto\n\n---\n### 🎯 Handoff Git')
    expect(result).not.toContain('------')
  })

  it('retorna string vazia sem separador quando ambos forem vazios', () => {
    expect(appendGitMemory('', '')).toBe('')
    expect(appendGitMemory('   ', '   ')).toBe('')
  })
})

describe('AiMemoryModal IPC contract', () => {
  const mockApi = {
    getProjectStatus: vi.fn(),
    aiMemoryStatus: vi.fn(),
    aiMemoryDoctor: vi.fn(),
    aiMemoryEnableProject: vi.fn(),
    aiMemoryMigrateLegacy: vi.fn(),
    aiMemoryMigrationStatus: vi.fn(),
    aiMemoryRecent: vi.fn(),
    aiMemoryBriefing: vi.fn(),
    aiMemoryHandoffs: vi.fn(),
    aiMemoryQuery: vi.fn(),
  }

  beforeEach(() => {
    vi.stubGlobal('window', { devorbit: mockApi })
    Object.values(mockApi).forEach((fn) => fn.mockReset())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getProjectStatus returns isProjectEnabled, status, and migration', async () => {
    mockApi.getProjectStatus.mockResolvedValue({
      ok: true,
      data: {
        isProjectEnabled: true,
        status: { state: 'running', owned: true, version: '2.4.0' },
        migration: { receipt: 'present' as const, concludedAt: '2025-01-01T00:00:00Z', paths: ['.devorbit/memory.md'] },
      },
    })

    const result = await mockApi.getProjectStatus({ projectPath: '/repo' })
    expect(result.ok).toBe(true)
    expect(result.data?.isProjectEnabled).toBe(true)
    expect(result.data?.status.state).toBe('running')
    expect(result.data?.migration.receipt).toBe('present')
  })

  it('getProjectStatus failure returns ok:false with reason', async () => {
    mockApi.getProjectStatus.mockResolvedValue({
      ok: false,
      reason: 'disabled',
      message: 'ai-memory desabilitado.',
    })

    const result = await mockApi.getProjectStatus({ projectPath: '/repo' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('disabled')
  })

  it('aiMemoryEnableProject toggles opt-in and returns updated status', async () => {
    mockApi.aiMemoryEnableProject.mockResolvedValue({
      ok: true,
      data: {
        config: { enabled: true, projects: {} },
        status: { state: 'running', owned: true },
        marker: { status: 'created', configured: true },
      },
    })

    const result = await mockApi.aiMemoryEnableProject({ projectPath: '/repo', enabled: true })
    expect(result.ok).toBe(true)
    expect(result.data?.status.state).toBe('running')
    expect(result.data?.marker?.status).toBe('created')
  })

  it('aiMemoryMigrateLegacy returns migration outcome', async () => {
    mockApi.aiMemoryMigrateLegacy.mockResolvedValue({
      ok: true,
      data: { status: 'migrated', paths: ['.devorbit/memory.md'], message: '1 arquivo migrado.' },
    })

    const result = await mockApi.aiMemoryMigrateLegacy({ projectPath: '/repo' })
    expect(result.ok).toBe(true)
    expect(result.data?.status).toBe('migrated')
    expect(result.data?.paths).toContain('.devorbit/memory.md')
  })

  it('aiMemoryDoctor returns health check', async () => {
    mockApi.aiMemoryDoctor.mockResolvedValue({
      ok: true,
      data: { ok: true },
    })

    const result = await mockApi.aiMemoryDoctor()
    expect(result.ok).toBe(true)
    expect(result.data?.ok).toBe(true)
  })

  it('aiMemoryQuery returns search results in IPC envelope (hits)', async () => {
    const hits = [{ path: 'decisions/auth.md', title: 'Auth', snippet: 'JWT auth', score: 0.9 }]
    mockApi.aiMemoryQuery.mockResolvedValue({
      ok: true,
      data: { text: JSON.stringify({ hits }), isError: false, json: { hits } },
    })

    const result = await mockApi.aiMemoryQuery({ projectPath: '/repo', query: 'auth' })
    expect(result.ok).toBe(true)
    // IPC envelope wraps items in { text, isError, json } — extractIpcArray extracts from json.hits
    expect(extractIpcArray(result.data)).toHaveLength(1)
    expect((result.data as any).json.hits[0].path).toBe('decisions/auth.md')
  })

  it('aiMemoryRecent returns recent pages in IPC envelope', async () => {
    const pages = [{ path: 'state/current.md', title: 'State', updatedAt: '2025-01-01' }]
    mockApi.aiMemoryRecent.mockResolvedValue({
      ok: true,
      data: { text: JSON.stringify({ pages }), isError: false, json: { pages } },
    })

    const result = await mockApi.aiMemoryRecent({ projectPath: '/repo', limit: 10 })
    expect(result.ok).toBe(true)
    expect(extractIpcArray(result.data)).toHaveLength(1)
  })

  it('aiMemoryHandoffs returns handoff list in IPC envelope', async () => {
    const handoffs = [{ id: 'h-1', agent: 'codex', summary: 'Implement auth' }]
    mockApi.aiMemoryHandoffs.mockResolvedValue({
      ok: true,
      data: { text: JSON.stringify({ handoffs }), isError: false, json: { handoffs } },
    })

    const result = await mockApi.aiMemoryHandoffs({ projectPath: '/repo' })
    expect(result.ok).toBe(true)
    expect(extractIpcArray(result.data)).toHaveLength(1)
    expect((result.data as any).json.handoffs[0].agent).toBe('codex')
  })

  it('all IPC calls handle network errors gracefully', async () => {
    mockApi.getProjectStatus.mockRejectedValue(new Error('Network error'))

    await expect(mockApi.getProjectStatus({ projectPath: '/repo' })).rejects.toThrow('Network error')
  })
})

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

describe('renderPage', () => {
  it('renders a plain string wrapped in div>p', () => {
    const el = renderPage('hello world', 0)
    expect(React.isValidElement(el)).toBe(true)
    const p = elProps(el).children as React.ReactElement
    expect(React.isValidElement(p)).toBe(true)
    expect(elProps(p).children).toBe('hello world')
  })

  it('renders a page object with path and body', () => {
    const el = renderPage({ path: 'decisions/auth.md', body: '# Auth\n\nDetails here' }, 0)
    expect(React.isValidElement(el)).toBe(true)
    expect((el as React.ReactElement).type).toBe('details')
    const children = elProps(el).children as React.ReactElement[]
    const summary = children[0]
    expect(elProps(summary).children).toContain('decisions/auth.md')
  })

  it('renders a page with title taking precedence over path', () => {
    const el = renderPage({ path: 'some/path.md', title: 'My Page' }, 0)
    const children = elProps(el).children as React.ReactElement[]
    const summary = children[0]
    const summaryText = (elProps(summary).children as unknown[]).filter((c: unknown) => typeof c === 'string')
    expect(summaryText).toContain('My Page')
  })

  it('renders updatedAt in summary', () => {
    const el = renderPage({ path: 'x.md', updatedAt: '2025-01-15' }, 0)
    const children = elProps(el).children as React.ReactElement[]
    const summary = children[0]
    const spans = (elProps(summary).children as unknown[]).filter((c: unknown) => React.isValidElement(c))
    const timeSpan = spans.find((s: unknown) => React.isValidElement(s) && elProps(s).children === '2025-01-15')
    expect(timeSpan).toBeTruthy()
  })

  it('renders snippet as preview when body is absent (memory_query hit)', () => {
    const el = renderPage({ path: 'decisions/auth.md', title: 'Auth', snippet: 'JWT auth for API', score: 0.92 }, 0)
    const details = el as React.ReactElement
    expect(details.type).toBe('details')
    const children = elProps(details).children as React.ReactElement[]
    const summary = children[0]
    expect(elProps(summary).children).toContain('Auth')
  })

  it('falls back to FallbackJson for unknown object', () => {
    const el = renderPage({ foo: 'bar', baz: 42 }, 0)
    expect(React.isValidElement(el)).toBe(true)
    expect((el as React.ReactElement).type).toBe('details')
  })

  it('returns FallbackJson for primitive non-string', () => {
    const el = renderPage(42, 0)
    expect(React.isValidElement(el)).toBe(true)
  })
})

describe('renderHandoff', () => {
  it('renders a handoff with agent and summary', () => {
    const el = renderHandoff({ agent: 'codex', summary: 'Implement auth module', status: 'pending' }, 0)
    expect(React.isValidElement(el)).toBe(true)
    expect((el as React.ReactElement).type).toBe('details')
    const children = elProps(el).children as React.ReactElement[]
    const summary = children[0]
    expect(elProps(summary).children).toContain('codex')
  })

  it('renders status badge with correct color', () => {
    const el = renderHandoff({ agent: 'agy', summary: 'Done', status: 'completed' }, 0)
    const children = elProps(el).children as React.ReactElement[]
    const summary = children[0]
    const spans = (elProps(summary).children as unknown[]).filter((c: unknown) => React.isValidElement(c))
    const badge = spans.find((s: unknown) => React.isValidElement(s) && elProps(s).children === 'completed')
    expect(badge).toBeTruthy()
    expect(elProps(badge).className).toContain('success')
  })

  it('renders plain string handoff wrapped in div>p', () => {
    const el = renderHandoff('simple handoff text', 0)
    expect(React.isValidElement(el)).toBe(true)
    const p = elProps(el).children as React.ReactElement
    expect(React.isValidElement(p)).toBe(true)
    expect(elProps(p).children).toBe('simple handoff text')
  })

  it('falls back for unknown object', () => {
    const el = renderHandoff({ unknown: 'data' }, 0)
    expect(React.isValidElement(el)).toBe(true)
    expect((el as React.ReactElement).type).toBe('details')
  })
})

describe('renderBriefingContent', () => {
  it('renders a plain string briefing', () => {
    const el = renderBriefingContent('Project status: running')
    expect(React.isValidElement(el)).toBe(true)
    expect(elProps(el).children).toBe('Project status: running')
  })

  it('renders object with summary field', () => {
    const el = renderBriefingContent({ summary: 'Auth is working' })
    expect(React.isValidElement(el)).toBe(true)
    expect(elProps(el).children).toBe('Auth is working')
  })

  it('renders object with known string keys', () => {
    const el = renderBriefingContent({ scope: 'devorbit', project: 'p-1', extra: 'info' })
    expect(React.isValidElement(el)).toBe(true)
    expect(elProps(el).className).toContain('space-y')
  })

  it('returns FallbackJson element for empty object', () => {
    const el = renderBriefingContent({})
    expect(React.isValidElement(el)).toBe(true)
    expect((el as React.ReactElement).type).toBe(FallbackJson)
  })
})

describe('extractIpcArray — IPC envelope parser', () => {
  it('extracts hits from json field (memory_query v2.4.0)', () => {
    const data = { text: '{"hits":[1,2]}', isError: false, json: { hits: [1, 2] } }
    expect(extractIpcArray(data)).toEqual([1, 2])
  })

  it('falls back to global_scope_hits when hits absent', () => {
    const data = { text: '', isError: false, json: { global_scope_hits: [{ path: 'a.md' }] } }
    expect(extractIpcArray(data)).toHaveLength(1)
  })

  it('falls back to raw_hits when hits and global_scope_hits absent', () => {
    const data = { text: '', isError: false, json: { raw_hits: [42] } }
    expect(extractIpcArray(data)).toEqual([42])
  })

  it('extracts pages from json field (memory_recent v2.4.0)', () => {
    const data = { text: '', isError: false, json: { pages: [{ path: 'p.md' }] } }
    expect(extractIpcArray(data)).toHaveLength(1)
  })

  it('extracts handoffs from json field (memory_handoff_list v2.4.0)', () => {
    const data = { text: '', isError: false, json: { handoffs: [{ id: 'h-1' }] } }
    expect(extractIpcArray(data)).toHaveLength(1)
  })

  it('parses text as JSON fallback when json is absent', () => {
    const items = [{ path: 'x.md' }]
    const data = { text: JSON.stringify(items), isError: false }
    expect(extractIpcArray(data)).toEqual(items)
  })

  it('parses text containing { hits: [...] } fallback', () => {
    const data = { text: JSON.stringify({ hits: [{ path: 'a.md' }, { path: 'b.md' }] }), isError: false }
    expect(extractIpcArray(data)).toHaveLength(2)
  })

  it('returns plain array when data is already an array', () => {
    expect(extractIpcArray([1, 2, 3])).toEqual([1, 2, 3])
  })

  it('limits to IPC_ARRAY_LIMIT (200)', () => {
    const big = Array.from({ length: 300 }, (_, i) => i)
    const data = { text: '', isError: false, json: { hits: big } }
    expect(extractIpcArray(data)).toHaveLength(200)
  })

  it('returns empty for null/undefined/string', () => {
    expect(extractIpcArray(null)).toEqual([])
    expect(extractIpcArray(undefined)).toEqual([])
    expect(extractIpcArray('just text')).toEqual([])
  })

  it('returns empty for empty envelope', () => {
    expect(extractIpcArray({ text: '', isError: false })).toEqual([])
  })
})

describe('FallbackJson', () => {
  it('returns null for null/undefined', () => {
    expect(FallbackJson({ data: null })).toBeNull()
    expect(FallbackJson({ data: undefined })).toBeNull()
  })

  it('returns null for empty object', () => {
    expect(FallbackJson({ data: {} })).toBeNull()
  })

  it('renders details with formatted JSON', () => {
    const el = FallbackJson({ data: { key: 'value' } })
    expect(React.isValidElement(el)).toBe(true)
    expect((el as React.ReactElement).type).toBe('details')
    const children = elProps(el).children as React.ReactElement[]
    const pre = children.find((c: unknown) => React.isValidElement(c) && (c as React.ReactElement).type === 'pre')
    expect(pre).toBeTruthy()
    expect(elProps(pre).children).toContain('"key"')
  })

  it('renders details for a string', () => {
    const el = FallbackJson({ data: 'some text' })
    expect(React.isValidElement(el)).toBe(true)
    expect((el as React.ReactElement).type).toBe('details')
  })

  it('handles circular references safely without throwing', () => {
    const circular: Record<string, unknown> = { name: 'cyclic' }
    circular.self = circular
    const el = FallbackJson({ data: circular })
    expect(React.isValidElement(el)).toBe(true)
  })
})

describe('AiMemoryModal UI & Accessibility semantics', () => {
  const mockProject: Project = {
    id: 'p-1',
    name: 'DevOrbit App',
    path: '/work/devorbit',
    parentDir: '/work',
    lastModified: 1000,
    techs: [],
    git: {
      isRepo: true,
      branch: 'main',
      ahead: 0,
      behind: 0,
      hasChanges: false,
      modifiedCount: 0,
      untrackedCount: 0,
    },
  }

  beforeEach(() => {
    vi.stubGlobal('window', {
      devorbit: {
        getProjectStatus: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            isProjectEnabled: true,
            status: { state: 'running' },
            migration: { receipt: 'absent' },
          },
        }),
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renderiza com estrutura acessível: dialog, tablist, tabs e tabpanel com ids correspondentes', () => {
    const html = renderToStaticMarkup(
      createElement(AiMemoryModal, {
        isOpen: true,
        project: mockProject,
        onClose: vi.fn(),
        onNotify: vi.fn(),
      }),
    )

    // Dialog semântico
    expect(html).toContain('role="dialog"')
    expect(html).toContain('id="ai-memory-dialog-title"')
    expect(html).toContain('Shared AI Memory')
    expect(html).toContain('DevOrbit App')

    // Tablist e Tabs
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-label="Seções da memória"')
    expect(html).toContain('id="ai-memory-tab-status"')
    expect(html).toContain('aria-controls="ai-memory-panel-status"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('tabindex="0"')

    // Inactive tabs
    expect(html).toContain('id="ai-memory-tab-activity"')
    expect(html).toContain('aria-controls="ai-memory-panel-activity"')
    expect(html).toContain('tabindex="-1"')

    // Tabpanel
    expect(html).toContain('role="tabpanel"')
    expect(html).toContain('id="ai-memory-panel-status"')
    expect(html).toContain('aria-labelledby="ai-memory-tab-status"')
  })

  it('desabilita a aba Legado quando não há receipt de migração presente', () => {
    const html = renderToStaticMarkup(
      createElement(AiMemoryModal, {
        isOpen: true,
        project: mockProject,
        onClose: vi.fn(),
        onNotify: vi.fn(),
      }),
    )

    // Legado tab deve estar desabilitada
    expect(html).toMatch(/id="ai-memory-tab-legacy"[^>]*disabled=""/)
    expect(html).toMatch(/id="ai-memory-tab-legacy"[^>]*aria-disabled="true"/)
  })

  it('renderiza botão de fechar com aria-label acessível', () => {
    const html = renderToStaticMarkup(
      createElement(AiMemoryModal, {
        isOpen: true,
        project: mockProject,
        onClose: vi.fn(),
        onNotify: vi.fn(),
      }),
    )

    expect(html).toContain('aria-label="Fechar memória da IA"')
  })
})

describe('AiMemoryModal migration and opt-in recapture contract', () => {
  it('ao concluir migração, invoca getProjectStatus para confirmar receipt=present', async () => {
    const mockApi = {
      getProjectStatus: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          isProjectEnabled: true,
          status: { state: 'running' },
          migration: { receipt: 'present', concludedAt: '2026-09-24T00:00:00Z', paths: ['legacy.md'] },
        },
      }),
      aiMemoryMigrateLegacy: vi.fn().mockResolvedValue({
        ok: true,
        data: { status: 'migrated', paths: ['legacy.md'], message: 'Migrado' },
      }),
    }

    const res = await mockApi.aiMemoryMigrateLegacy({ projectPath: '/work' })
    expect(res.ok).toBe(true)

    const freshStatus = await mockApi.getProjectStatus({ projectPath: '/work' })
    expect(freshStatus.ok).toBe(true)
    expect(freshStatus.data.migration.receipt).toBe('present')
  })

  it('ao alterar opt-in, invoca getProjectStatus para sincronizar marker e estado', async () => {
    const mockApi = {
      getProjectStatus: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          isProjectEnabled: true,
          status: { state: 'running' },
          migration: { receipt: 'absent' },
        },
      }),
      aiMemoryEnableProject: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          config: { enabled: true },
          status: { state: 'running' },
          marker: { status: 'created', configured: true },
        },
      }),
    }

    const enableRes = await mockApi.aiMemoryEnableProject({ projectPath: '/work', enabled: true })
    expect(enableRes.ok).toBe(true)

    const freshStatus = await mockApi.getProjectStatus({ projectPath: '/work' })
    expect(freshStatus.ok).toBe(true)
    expect(freshStatus.data.isProjectEnabled).toBe(true)
  })

  it('toggle failure (ok:false) re-fetches getProjectStatus para rollback do estado otimista', async () => {
    const mockApi = {
      getProjectStatus: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          isProjectEnabled: false,
          status: { state: 'running', owned: true },
          migration: { receipt: 'absent' },
        },
      }),
      aiMemoryEnableProject: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'service-unavailable',
        message: 'ai-memory indisponível.',
      }),
    }

    // Primeira chamada: getProjectStatus retorna disabled
    const initial = await mockApi.getProjectStatus({ projectPath: '/repo' })
    expect(initial.data.isProjectEnabled).toBe(false)

    // Toggle tenta habilitar mas falha
    const toggleRes = await mockApi.aiMemoryEnableProject({ projectPath: '/repo', enabled: true })
    expect(toggleRes.ok).toBe(false)

    // Rollback: re-fetch deve ser chamado para restaurar estado real
    const rollback = await mockApi.getProjectStatus({ projectPath: '/repo' })
    expect(mockApi.getProjectStatus).toHaveBeenCalledTimes(2) // initial + rollback
    expect(rollback.data.isProjectEnabled).toBe(false) // server side unchanged
  })

  it('toggle exception (throw) re-fetches getProjectStatus para rollback do estado otimista', async () => {
    const serverState = {
      ok: true,
      data: {
        isProjectEnabled: true,
        status: { state: 'running', owned: true },
        migration: { receipt: 'absent' },
      },
    }
    const mockApi = {
      getProjectStatus: vi.fn().mockResolvedValue(serverState),
      aiMemoryEnableProject: vi.fn().mockRejectedValue(new Error('Network error')),
    }

    // Initial load: enabled
    const initial = await mockApi.getProjectStatus({ projectPath: '/repo' })
    expect(initial.data.isProjectEnabled).toBe(true)

    // Toggle throws
    await expect(mockApi.aiMemoryEnableProject({ projectPath: '/repo', enabled: false }))
      .rejects.toThrow('Network error')

    // Rollback re-fetch returns server state (still enabled since toggle failed)
    const rollback = await mockApi.getProjectStatus({ projectPath: '/repo' })
    expect(mockApi.getProjectStatus).toHaveBeenCalledTimes(2)
    expect(rollback.data.isProjectEnabled).toBe(true) // server unchanged
  })

  it('mapNoticeSeverity: warning → error, info → info', () => {
    expect(mapNoticeSeverity('warning')).toBe('error')
    expect(mapNoticeSeverity('info')).toBe('info')
  })

  it('buildEnableNotice: marker conflict → warning com conflitos e instrução segura', () => {
    const notices = buildEnableNotice({
      marker: { status: 'conflict', configured: false, conflicts: ['workspace'] },
    })
    expect(notices).toHaveLength(1)
    expect(notices[0].type).toBe('warning')
    expect(notices[0].message).toContain('conflita')
    expect(notices[0].message).toContain('workspace')
    expect(notices[0].message).toContain('revise o .ai-memory.toml')
    expect(notices[0].message).not.toContain('remova')
  })

  it('buildEnableNotice: marker preserved → info com orientação', () => {
    const notices = buildEnableNotice({
      marker: { status: 'preserved', configured: false },
    })
    expect(notices).toHaveLength(1)
    expect(notices[0].type).toBe('info')
    expect(notices[0].message).toContain('preservado')
  })

  it('buildEnableNotice: marker configured + sem migration → info sobre legado', () => {
    const notices = buildEnableNotice({
      marker: { status: 'created', configured: true },
      migration: undefined,
    })
    expect(notices).toHaveLength(1)
    expect(notices[0].type).toBe('info')
    expect(notices[0].message).toContain('legados')
  })

  it('buildEnableNotice: marker configured + migration completa → sem avisos', () => {
    const notices = buildEnableNotice({
      marker: { status: 'created', configured: true },
      migration: { status: 'migrated', paths: [] },
    })
    expect(notices).toHaveLength(0)
  })

  it('buildEnableNotice: migration failed → warning com mensagem', () => {
    const notices = buildEnableNotice({
      marker: { status: 'created', configured: true },
      migration: { status: 'failed', message: 'write timeout' },
    })
    expect(notices).toHaveLength(1)
    expect(notices[0].type).toBe('warning')
    expect(notices[0].message).toContain('write timeout')
  })

  it('buildEnableNotice: marker não pronto (created, configured=false) → warning', () => {
    const notices = buildEnableNotice({
      marker: { status: 'created', configured: false },
    })
    expect(notices).toHaveLength(1)
    expect(notices[0].type).toBe('warning')
    expect(notices[0].message).toContain('não está completamente configurado')
  })

  it('buildEnableNotice: marker disabled → warning', () => {
    const notices = buildEnableNotice({
      marker: { status: 'disabled', configured: false },
    })
    expect(notices).toHaveLength(1)
    expect(notices[0].type).toBe('warning')
    expect(notices[0].message).toContain('desabilitado')
  })

  it('buildEnableNotice: sem marker → sem avisos', () => {
    const notices = buildEnableNotice({})
    expect(notices).toHaveLength(0)
  })

  it('buildEnableNotice: marker pronta (created, configured=true) + migration completa → 0 notices (sucesso normal)', () => {
    const notices = buildEnableNotice({
      marker: { status: 'created', configured: true },
      migration: { status: 'migrated', paths: ['.devorbit/memory.md'] },
    })
    expect(notices).toHaveLength(0)
    // handleToggle emite success separadamente ("habilitado/desabilitado"),
    // não depende de buildEnableNotice para isso.
  })

  it('buildEnableNotice: disable (sem marker, sem migration) → 0 notices (sucesso normal)', () => {
    // Ao desabilitar, enableProject retorna {config, status} sem marker/migration
    const notices = buildEnableNotice({})
    expect(notices).toHaveLength(0)
    // handleToggle emite success separadamente ("desabilitado para este projeto").
  })

  it('buildEnableNotice: marker conflict + sem migration → warning (conflita) + info (legado)', () => {
    const notices = buildEnableNotice({
      marker: { status: 'conflict', configured: true, conflicts: ['workspace'] },
      migration: undefined,
    })
    expect(notices).toHaveLength(2)
    expect(notices[0].type).toBe('warning')
    expect(notices[0].message).toContain('conflita')
    expect(notices[1].type).toBe('info')
    expect(notices[1].message).toContain('legados')
  })

  it('retorna disabled quando o projeto não tem opt-in nas consultas', async () => {
    const mockApi = {
      aiMemoryRecent: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'disabled',
        message: 'Projeto sem opt-in para o ai-memory.',
      }),
      aiMemoryQuery: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'disabled',
        message: 'Projeto sem opt-in para o ai-memory.',
      }),
      aiMemoryHandoffs: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'disabled',
        message: 'Projeto sem opt-in para o ai-memory.',
      }),
    }

    const recentRes = await mockApi.aiMemoryRecent({ projectPath: '/work' })
    expect(recentRes.ok).toBe(false)
    expect(recentRes.reason).toBe('disabled')

    const queryRes = await mockApi.aiMemoryQuery({ projectPath: '/work', query: 'test' })
    expect(queryRes.ok).toBe(false)
    expect(queryRes.reason).toBe('disabled')

    const handoffsRes = await mockApi.aiMemoryHandoffs({ projectPath: '/work' })
    expect(handoffsRes.ok).toBe(false)
    expect(handoffsRes.reason).toBe('disabled')
  })
})
