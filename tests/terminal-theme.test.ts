import { describe, expect, it } from 'vitest'
import {
  TERMINAL_THEMES,
  TERMINAL_THEME_MAP,
  createTerminalNodeConfig,
  getTerminalPreset,
  resolveTerminalTheme,
  sanitizeTerminalNodeConfig,
  sanitizeTerminalThemeId,
  type TerminalThemeId,
} from '../src/shared/terminal-presets'

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
      expect(theme.xterm.background).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(theme.xterm.foreground).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(theme.xterm.cursor).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(theme.xterm.selectionBackground).toMatch(/^#[0-9a-fA-F]{6}$/)
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
