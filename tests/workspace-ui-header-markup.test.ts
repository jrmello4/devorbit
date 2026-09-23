import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// Guardas por markup da UI do workspace: seletor segmentado de visão,
// cabeçalhos de painel unificados (32px), empty state do painel web e rodapé
// enxuto da paleta de comandos. Os seletores listados são consultados pelo
// harness scripts/verify-ui.cjs — mudanças aqui devem manter o contrato.
const componentDir = path.resolve(__dirname, '../src/renderer/src/components')

function readComponent(name: string): string {
  return fs.readFileSync(path.resolve(componentDir, name), 'utf-8')
}
function readCss(name: string): string {
  return fs.readFileSync(path.resolve(componentDir, name), 'utf-8')
}

describe('seletor segmentado de visão (IntegratedWorkspace)', () => {
  const tsx = readComponent('IntegratedWorkspace.tsx')

  it('substitui os três botões-toggle por um grupo segmentado Canvas · Código · Web', () => {
    expect(tsx).toContain('workspace-view-switch')
    expect(tsx).toContain('role="group"')
    expect(tsx).toContain('<span>Canvas</span>')
    expect(tsx).toContain('<span>Código</span>')
    expect(tsx).toContain('<span>Web</span>')
  })

  it('preserva os accessible-names usados pelo harness verify-ui.cjs', () => {
    // "Abrir canvas"/"Voltar ao layout integrado": cliques de troca canvas↔ambiente.
    expect(tsx).toContain("'Abrir canvas'")
    expect(tsx).toContain("'Voltar ao layout integrado'")
    // Toggle do navegador no modo dedicado do canvas.
    expect(tsx).toContain('Mostrar ou ocultar navegador')
    // Painel web continua encontrável pelo harness.
    expect(tsx).toContain('aria-label="Pesquisa web"')
  })

  it('mantém "Enviar contexto" e "Fechar" ao lado do seletor', () => {
    expect(tsx).toContain('Enviar contexto')
    expect(tsx).toContain('Fechar ambiente integrado')
    expect(tsx).toContain('sendContextToTerminal')
    expect(tsx).toContain('closeWorkspace')
  })
})

describe('cabeçalhos de painel unificados (32px)', () => {
  const css = readCss('IntegratedWorkspace.css')

  it('define a spec única de cabeçalho no IntegratedWorkspace.css', () => {
    expect(css).toMatch(/\.workspace-panel-heading\s*\{[^}]*height: 32px/)
    expect(css).toMatch(/\.workspace-panel-heading strong\s*\{[^}]*font-size: 10\.5px/)
    expect(css).toMatch(/\.workspace-panel-heading strong\s*\{[^}]*font-weight: 650/)
    expect(css).toMatch(/\.workspace-panel-heading strong\s*\{[^}]*letter-spacing: \.8px/)
    expect(css).toMatch(/\.workspace-panel-heading strong\s*\{[^}]*text-transform: uppercase/)
    expect(css).toMatch(/\.workspace-icon-button\s*\{[^}]*width: 28px/)
  })

  it('editor mantém rótulo + abas (role=tab) + ações com títulos do harness', () => {
    const editor = readComponent('WorkspaceEditor.tsx')
    expect(editor).toContain('editor-heading-label')
    expect(editor).toContain('role="tablist"')
    expect(editor).toContain('role="tab"')
    expect(editor).toContain('title="Buscar no arquivo atual (Ctrl+F)"')
    expect(editor).toContain('title="Mostrar símbolos do arquivo atual"')
    expect(editor).toContain('title="Ver alterações não salvas"')
    expect(editor).toContain('title="Enviar arquivo ao contexto"')
    expect(editor).toContain('title="Salvar arquivo (Ctrl+S)"')
    // Estado "Não salvo" continua sinalizado (harness consulta .editor-dirty).
    expect(editor).toContain('editor-dirty')
  })

  it('terminal e pesquisa web seguem a mesma spec', () => {
    const terminal = readComponent('WorkspaceTerminal.tsx')
    // aria-label da seção é consultado pelo harness (verify-ui.cjs).
    expect(terminal).toContain('aria-label="Terminal interno"')
    expect(terminal).toContain('<strong><TerminalIcon size={13} aria-hidden="true" /> Terminal</strong>')
    expect(terminal).toContain('terminal-status')
    expect(terminal).toContain('terminal-heading-executor')
    const integrated = readComponent('IntegratedWorkspace.tsx')
    expect(integrated).toContain('Pesquisa web')
    expect(integrated).toContain('browser-actions')
  })
})

describe('empty state do painel web', () => {
  it('mostra o cartão "Navegue dentro do DevOrbit" sem novo IPC', () => {
    const tsx = readComponent('IntegratedWorkspace.tsx')
    expect(tsx).toContain('workspace-web-empty')
    expect(tsx).toContain('Navegue dentro do DevOrbit')
    const css = readCss('IntegratedWorkspace.css')
    expect(css).toMatch(/\.workspace-web-empty\s*\{[^}]*border: 1px dashed/)
  })
})

describe('rodapé da paleta de comandos', () => {
  it('remove os chips de atalhos e deixa uma única linha de ajuda', () => {
    const palette = readComponent('CommandPalette.tsx')
    expect(palette).not.toContain('NAVIGATE_BINDINGS')
    expect(palette).not.toContain('CREATE_BINDINGS')
    expect(palette).not.toContain('Atalhos de dois tempos')
    expect(palette).toContain('G+letra vai · C+letra cria')
  })

  it('mantém os atalhos de dois tempos funcionando (G/C)', () => {
    const palette = readComponent('CommandPalette.tsx')
    expect(palette).toContain('matchTwoStroke')
    expect(palette).toContain('detectPrefixQuery')
    expect(palette).toContain('runTwoStroke')
  })

  it('preserva os seletores da paleta usados pelo harness', () => {
    const palette = readComponent('CommandPalette.tsx')
    expect(palette).toContain('command-palette-search')
    expect(palette).toContain('command-palette-title')
    expect(palette).toContain('role="option"')
  })
})
