import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  TERMINAL_THEMES,
  TERMINAL_THEME_MAP,
  createTerminalNodeConfig,
  getTerminalPreset,
  resolveTerminalTheme,
  sanitizeTerminalNodeConfig,
  sanitizeTerminalThemeId,
  type TerminalThemeDefinition,
  type TerminalThemeId,
} from '../src/shared/terminal-presets'

/** Luminância relativa WCAG 2.x para cor #RGB de 6 dígitos. */
function relativeLuminance(hex: string): number {
  const raw = hex.replace('#', '').slice(0, 6)
  const channels = [0, 2, 4].map((offset) => {
    const channel = parseInt(raw.slice(offset, offset + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
  })
  const [r, g, b] = channels
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Razão de contraste WCAG entre duas cores hex. */
function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

/** Todas as chaves de cor de texto que precisam de AA (≥ 4.5:1) sobre o fundo. */
const XTERM_TEXT_KEYS = [
  'foreground',
  'brightBlack',
  'red',
  'brightRed',
  'green',
  'brightGreen',
  'yellow',
  'brightYellow',
  'blue',
  'brightBlue',
  'magenta',
  'brightMagenta',
  'cyan',
  'brightCyan',
  'white',
] as const

/** As 20 chaves que tornam o xterm um ITheme completo (fundo + 16 ANSI + UI). */
const XTERM_COMPLETE_KEYS = [
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'black',
  'brightBlack',
  'red',
  'brightRed',
  'green',
  'brightGreen',
  'yellow',
  'brightYellow',
  'blue',
  'brightBlue',
  'magenta',
  'brightMagenta',
  'cyan',
  'brightCyan',
  'white',
  'brightWhite',
] as const

const componentDir = path.resolve(__dirname, '../src/renderer/src/components')

function readComponent(name: string): string {
  return fs.readFileSync(path.resolve(componentDir, name), 'utf-8')
}

describe('Terminal Themes - Presets de Cores', () => {
  it('define exatamente os 6 presets esperados com identidade discreta', () => {
    const expectedIds: TerminalThemeId[] = ['carbon', 'amber', 'emerald', 'ocean', 'violet', 'rose']
    expect(TERMINAL_THEMES.map((t) => t.id)).toEqual(expectedIds)

    const expectedLabels = ['Carbon', 'Âmbar', 'Esmeralda', 'Oceano', 'Violeta', 'Rosa']
    expect(TERMINAL_THEMES.map((t) => t.label)).toEqual(expectedLabels)
  })

  it('cada preset possui accent hexadecimal e opções completas do xterm', () => {
    for (const theme of TERMINAL_THEMES) {
      expect(theme.accent).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(theme.xterm).toBeDefined()
      for (const key of XTERM_COMPLETE_KEYS) {
        if (key === 'selectionBackground') continue // translúcida: asserção própria abaixo
        // Demais cores são #RRGGBB.
        expect(theme.xterm[key], `${theme.id}.${key}`).toMatch(/^#[0-9a-fA-F]{6}$/)
      }
      expect(theme.xterm.selectionBackground, `${theme.id}.selectionBackground`).toMatch(/^#[0-9a-fA-F]{8}$/)
    }
  })

  it('cada tema pinta a superfície inteira: fundo com tint próprio da família e nenhum fundo repetido', () => {
    const backgrounds = TERMINAL_THEMES.map((t) => t.xterm.background)
    expect(new Set(backgrounds).size).toBe(TERMINAL_THEMES.length)

    // O tint da família é perceptível: nenhum tema usa o fundo neutro do Carbon.
    for (const theme of TERMINAL_THEMES.filter((t) => t.id !== 'carbon')) {
      expect(theme.xterm.background).not.toBe(TERMINAL_THEME_MAP.carbon.xterm.background)
      // ANSI da família difere do Carbon em pelo menos green e blue.
      expect(theme.xterm.green).not.toBe(TERMINAL_THEME_MAP.carbon.xterm.green)
      expect(theme.xterm.blue).not.toBe(TERMINAL_THEME_MAP.carbon.xterm.blue)
    }
  })

  it('cursorAccent acompanha o background e o cursor contrasta com o fundo (não-texto ≥ 3:1)', () => {
    for (const theme of TERMINAL_THEMES) {
      expect(theme.xterm.cursorAccent).toBe(theme.xterm.background)
      expect(contrastRatio(theme.xterm.cursor, theme.xterm.background)).toBeGreaterThanOrEqual(3)
    }
  })

  it('contraste AA (≥ 4.5:1) para foreground e ANSI de texto sobre o fundo da própria família', () => {
    for (const theme of TERMINAL_THEMES as readonly TerminalThemeDefinition[]) {
      for (const key of XTERM_TEXT_KEYS) {
        const ratio = contrastRatio(theme.xterm[key], theme.xterm.background)
        expect(ratio, `${theme.id}.${key} contraste ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('hierarquia ANSI preservada: cada cor bright é mais clara que a normal correspondente', () => {
    for (const theme of TERMINAL_THEMES) {
      const pairs = [
        ['black', 'brightBlack'],
        ['red', 'brightRed'],
        ['green', 'brightGreen'],
        ['yellow', 'brightYellow'],
        ['blue', 'brightBlue'],
        ['magenta', 'brightMagenta'],
        ['cyan', 'brightCyan'],
        ['white', 'brightWhite'],
      ] as const
      for (const [normal, bright] of pairs) {
        expect(relativeLuminance(theme.xterm[bright]), `${theme.id}.${bright}`).toBeGreaterThanOrEqual(
          relativeLuminance(theme.xterm[normal]),
        )
      }
    }
  })

  it('TERMINAL_THEME_MAP indexa todos os presets pelo identificador', () => {
    for (const theme of TERMINAL_THEMES) {
      expect(TERMINAL_THEME_MAP[theme.id]).toBe(theme)
    }
  })

  it('resolveTerminalTheme resolve corretamente temas existentes e faz fallback seguro para carbon', () => {
    expect(resolveTerminalTheme('amber').id).toBe('amber')
    expect(resolveTerminalTheme('emerald').id).toBe('emerald')
    expect(resolveTerminalTheme('ocean').id).toBe('ocean')
    expect(resolveTerminalTheme('violet').id).toBe('violet')
    expect(resolveTerminalTheme('rose').id).toBe('rose')
    expect(resolveTerminalTheme('carbon').id).toBe('carbon')

    // Fallbacks
    expect(resolveTerminalTheme(undefined).id).toBe('carbon')
    expect(resolveTerminalTheme(null).id).toBe('carbon')
    expect(resolveTerminalTheme('').id).toBe('carbon')
    expect(resolveTerminalTheme('desconhecido').id).toBe('carbon')
    expect(resolveTerminalTheme(123).id).toBe('carbon')
  })

  it('sanitizeTerminalThemeId valida e sanitiza valores arbitrários', () => {
    expect(sanitizeTerminalThemeId('ocean')).toBe('ocean')
    expect(sanitizeTerminalThemeId('rose')).toBe('rose')
    expect(sanitizeTerminalThemeId('invalido')).toBe('carbon')
    expect(sanitizeTerminalThemeId(null)).toBe('carbon')
    expect(sanitizeTerminalThemeId(undefined)).toBe('carbon')
  })
})

describe('Terminal Themes - Configuração de Nó e Retrocompatibilidade', () => {
  it('createTerminalNodeConfig atribui o tema padrão carbon', () => {
    const shellPreset = getTerminalPreset('shell')!
    const config = createTerminalNodeConfig(shellPreset)
    expect(config.theme).toBe('carbon')
  })

  it('sanitizeTerminalNodeConfig preserva tema válido', () => {
    const raw = {
      presetId: 'shell',
      theme: 'emerald',
      cwdMode: 'workspace',
      autoStart: false,
      restartBehavior: 'restart',
    }
    const sanitized = sanitizeTerminalNodeConfig(raw)
    expect(sanitized).toBeDefined()
    expect(sanitized?.theme).toBe('emerald')
  })

  it('sanitizeTerminalNodeConfig garante retrocompatibilidade quando tema está ausente no dado persistido', () => {
    const legacyRaw = {
      presetId: 'shell',
      cwdMode: 'workspace',
      autoStart: false,
      restartBehavior: 'restart',
    }
    const sanitized = sanitizeTerminalNodeConfig(legacyRaw)
    expect(sanitized).toBeDefined()
    expect(sanitized?.theme).toBe('carbon')
  })

  it('sanitizeTerminalNodeConfig sanitiza tema inválido ou corrompido para carbon', () => {
    const corruptedRaw = {
      presetId: 'shell',
      theme: 'neon-glow-ultra',
      cwdMode: 'workspace',
      autoStart: false,
      restartBehavior: 'restart',
    }
    const sanitized = sanitizeTerminalNodeConfig(corruptedRaw)
    expect(sanitized).toBeDefined()
    expect(sanitized?.theme).toBe('carbon')
  })
})

describe('Terminal Themes - Aplicação viva nas superfícies (docked e embedded)', () => {
  const terminalTsx = readComponent('WorkspaceTerminal.tsx')
  const integratedCss = readComponent('IntegratedWorkspace.css')
  const inspectorTsx = readComponent('CanvasNodeInspector.tsx')

  it('o ITheme completo do tema é passado ao construtor do xterm', () => {
    expect(terminalTsx).toContain('theme: terminalTheme.xterm')
  })

  it('trocar o tema re-tematiza o terminal vivo via updateTheme, sem recriar a sessão', () => {
    expect(terminalTsx).toContain('terminalRef.current.options.theme = themeDef.xterm')
    // O efeito depende só do id do tema: nenhuma remontagem de PTY envolvida.
    expect(terminalTsx).toContain('const themeDef = resolveTerminalTheme(runtimeConfig?.theme)')
    expect(terminalTsx).toContain('}, [runtimeConfig?.theme])')
  })

  it('a raiz do painel publica o tema nas duas superfícies: data-terminal-theme e --term-accent', () => {
    expect(terminalTsx).toContain('data-terminal-theme={themeDefinition.id}')
    expect(terminalTsx).toContain("'--term-accent': themeDefinition.accent")
    // A raiz é única para docked e embedded (variant muda via atributo).
    expect(terminalTsx).toContain('data-terminal-variant={variant}')
  })

  it('chrome do terminal usa o accent: fio de 2px no topo interno do viewport e ponto de status', () => {
    // Fio de 2px interno (::before do viewport), alimentado pela var do tema.
    expect(integratedCss).toMatch(/\.workspace-terminal-xterm::before \{[\s\S]*?height: 2px;[\s\S]*?background: var\(--term-accent, transparent\)/)
    expect(integratedCss).toMatch(/\.workspace-terminal-xterm \{ position: relative;/)
    // Ponto de status ready/starting na cor da família (error/missing seguem semânticos).
    expect(integratedCss).toContain('.terminal-status.ready i { background: var(--term-accent, var(--color-success)); }')
    expect(integratedCss).toContain('.terminal-status.starting i { background: var(--term-accent, var(--color-text-muted)); }')
    expect(integratedCss).toContain('.terminal-status.error i { background: var(--color-danger); }')
  })

  it('o card do canvas continua com um único backgroundColor (asserção do harness)', () => {
    // O fio/accent vivem em .workspace-terminal-xterm/.terminal-status — este
    // arquivo não pinta fundo de .workspace-canvas-card, cujo fundo neutro
    // único é verificado em runtime pelo scripts/verify-ui.cjs.
    expect(integratedCss).not.toMatch(/\.workspace-canvas-card[^{]*\{[^}]*\bbackground\s*:/)
  })

  it('seletor do Inspector preserva labels/ids do harness e mostra o pontinho da família', () => {
    expect(inspectorTsx).toContain('id="terminal-theme-select"')
    expect(inspectorTsx).toContain('aria-label="Tema de cores do terminal"')
    expect(inspectorTsx).toContain('TERMINAL_THEMES.map((theme) => (')
    expect(inspectorTsx).toContain('canvas-inspector-theme-dot')
    expect(readComponent('CanvasInspector.css')).toContain('.canvas-inspector-theme-dot')
  })
})
