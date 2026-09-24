import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// Guardas da rodada "clean pass" (titlebar/statusbar/biblioteca): microcopy
// removida sem enfraquecer os contratos consultados pelo harness
// scripts/verify-ui.cjs (.app-titlebar, .app-statusbar, data-testid do
// projeto, colunas 4/3/2/1, foco com outline 2px, popover em 480px).
const rendererDir = path.resolve(__dirname, '../src/renderer/src')

function read(...parts: string[]): string {
  return fs.readFileSync(path.resolve(rendererDir, ...parts), 'utf-8')
}

describe('titlebar mínimo (Header)', () => {
  const header = read('components', 'Header.tsx')

  it('remove o rótulo estático "Workspace local" (não informava nada)', () => {
    expect(header).not.toContain('Workspace local')
    expect(header).not.toContain('titlebar-location')
  })

  it('mantém a marca reduzida a logo + DevOrbit e a busca do harness', () => {
    expect(header).toContain('app-brand')
    expect(header).toContain('DevOrbit')
    // O harness preenche #project-search e clica em botões da titlebar.
    expect(header).toContain('id="project-search"')
    expect(header).toContain('aria-label="Atualizar projetos"')
  })

  it('sem alternador de tema (o harness exige tema escuro permanente)', () => {
    expect(header).not.toMatch(/tema claro|tema escuro/i)
  })
})

describe('statusbar mínima (App)', () => {
  const app = read('App.tsx')
  const statusbar = /<footer className="app-statusbar">.*<\/footer>/.exec(app)?.[0] || ''

  it('mantém a statusbar e os fatos à esquerda (contagens de projetos/repos)', () => {
    expect(statusbar).toContain('app-statusbar')
    expect(statusbar).toContain('${projects.length} projetos · ${gitProjectsCount} repositórios')
    // Estado de carregamento continua sinalizado pelo ponto de status.
    expect(statusbar).toContain('status-dot')
  })

  it('à direita fica um único hint; textos decorativos saem', () => {
    expect(statusbar).toContain('<kbd>Ctrl K</kbd> Ações rápidas')
    expect(statusbar).not.toContain('Dados locais')
    expect(statusbar).not.toContain('Ctrl R')
  })
})

describe('cabeçalho e rodapé da biblioteca (ProjectGrid)', () => {
  const grid = read('components', 'ProjectGrid.tsx')

  it('cabeçalho é título + contagem, sem subtítulo decorativo', () => {
    expect(grid).not.toContain('Seus projetos em um só lugar')
    // O harness espera o texto "Projetos" visível no painel da biblioteca.
    expect(grid).toContain('<h1>Projetos <span className="project-header-count">{projects.length}</span></h1>')
  })

  it('rodapé mantém a contagem filtrada e larga a ordenação duplicada', () => {
    expect(grid).toContain('{filtered.length} de {projects.length} projetos')
    expect(grid).not.toContain("sort === 'name' ? 'Nome A–Z'")
  })

  it('card conserva pílula de branch, ponto de status e data relativa', () => {
    expect(grid).toContain('project-status-dot')
    expect(grid).toContain('branchPillText(p)')
    expect(grid).toContain('relativeDate(p.lastModified)')
  })
})

describe('contratos do harness em ProjectLibrary.css', () => {
  const css = read('components', 'ProjectLibrary.css')

  it('mantém classes legadas do ponto de status (warning/success/danger/neutral)', () => {
    for (const legacy of ['warning', 'success', 'danger', 'neutral']) {
      expect(css).toMatch(new RegExp(`\\.project-status-dot\\.${legacy}`))
    }
  })

  it('mantém foco por teclado com outline 2px e colunas 4/3/2/1', () => {
    expect(css).toContain('.project-tile:focus-within')
    expect(css).toMatch(/outline:2px solid/)
    expect(css).toContain('repeat(4,minmax(0,1fr))')
    expect(css).toContain('repeat(3,minmax(0,1fr))')
    expect(css).toContain('repeat(2,minmax(0,1fr))')
  })

  it('popover de filtros preserva a geometria validada em 480px', () => {
    expect(css).toContain('width:min(300px,calc(100vw - 88px))')
  })

  it('microinterações em 120ms e reduced-motion preservado', () => {
    expect(css).not.toMatch(/\.18s/)
    expect(css).toContain('.12s ease')
    expect(css).toContain('prefers-reduced-motion')
  })
})
