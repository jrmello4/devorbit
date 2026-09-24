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
    // Estado "Não salvo" continua sinalizado como ponto âmbar com tooltip
    // (harness consulta .editor-dirty e a informação não pode se perder).
    expect(editor).toContain('editor-dirty')
    expect(editor).toContain('title="Não salvo"')
  })

  it('terminal docked mantém rótulo, ponto de status com tooltip e executor não-default', () => {
    const terminal = readComponent('WorkspaceTerminal.tsx')
    // aria-label da seção é consultado pelo harness (verify-ui.cjs).
    expect(terminal).toContain('aria-label="Terminal interno"')
    expect(terminal).toContain('<strong><TerminalIcon size={13} aria-hidden="true" /> Terminal</strong>')
    expect(terminal).toContain('terminal-status')
    expect(terminal).toContain('terminal-heading-executor')
    // Chip de atividade só quando ativa (running/falha) — em repouso, nada.
    expect(terminal).toContain("activityState === 'running' || activityState === 'failed'")
    const integrated = readComponent('IntegratedWorkspace.tsx')
    expect(integrated).toContain('Pesquisa web')
    expect(integrated).toContain('browser-actions')
  })

  it('contrato embedded: cards do canvas consomem o overlay compacto', () => {
    const terminal = readComponent('WorkspaceTerminal.tsx')
    // Prop opcional com default docked (painel do grid não muda).
    expect(terminal).toContain("variant?: 'docked' | 'embedded'")
    expect(terminal).toContain("variant = 'docked'")
    expect(terminal).toContain('data-terminal-variant={variant}')
    // Embedded não renderiza o cabeçalho: overlay fino com ponto + ações.
    expect(terminal).toContain('terminal-embedded-overlay')
    const integrated = readComponent('IntegratedWorkspace.tsx')
    // Os dois factories de card do canvas (renderAgent e renderTerminal) usam
    // embedded; o painel do grid mantém o default docked.
    expect(integrated.match(/variant="embedded"/g)).toHaveLength(2)
  })

  it('clean pass: reveal de 120ms, reduced-motion e pontos de status no CSS', () => {
    const css = readCss('IntegratedWorkspace.css')
    // Ações do terminal em repouso invisíveis e sem pointer-events.
    expect(css).toMatch(/\.terminal-actions > button\s*\{[^}]*opacity: 0/)
    expect(css).toMatch(/\.terminal-actions > button\s*\{[^}]*pointer-events: none/)
    expect(css).toMatch(/\.terminal-actions > button\s*\{[^}]*transition: opacity 120ms/)
    // Foco por teclado: cluster sempre visível.
    expect(css).toContain('.terminal-actions:focus-within > button')
    // Overlay embedded e ponto "Não salvo".
    expect(css).toContain('.terminal-embedded-overlay')
    expect(css).toMatch(/\.editor-dirty i\s*\{[^}]*var\(--color-warning\)/)
    // Reduced-motion preservado, agora incluindo o reveal.
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('.terminal-actions > button')
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

describe('navegador do canvas: remover pelo cartão e view nativo que cede', () => {
  const tsx = readComponent('IntegratedWorkspace.tsx')

  it('tem botão de remover no próprio cartão do navegador', () => {
    expect(tsx).toContain('aria-label="Remover navegador do canvas"')
    expect(tsx).toContain('webVisible: false')
  })

  it('view nativo cede ao grip (recuo 20px) e aos gestos (is-panning/is-dragging)', () => {
    expect(tsx).toContain('WEB_GRIP_INSET = 20')
    expect(tsx).toContain("classList.contains('is-panning')")
    expect(tsx).toContain("classList.contains('is-dragging')")
    expect(tsx).toContain("attributeFilter: ['style', 'class']")
  })
})
