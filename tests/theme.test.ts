import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  THEME_TOKENS,
  type ThemeRoot,
  type ThemeStorage,
  applyTheme,
  initializeTheme,
  readStoredTheme,
  resolveTheme,
  setTheme,
  toggleTheme,
} from '../src/renderer/src/theme'

function createStorage(initialValue: string | null = null): ThemeStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  if (initialValue) values.set(THEME_STORAGE_KEY, initialValue)
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}

function createRoot(): ThemeRoot & { properties: Map<string, string> } {
  const properties = new Map<string, string>()
  return {
    properties,
    dataset: {},
    style: {
      colorScheme: '',
      setProperty: (property, value) => properties.set(property, value),
    },
  }
}

describe('theme', () => {
  it('mantém a interface sempre escura, independentemente de preferências anteriores', () => {
    expect(DEFAULT_THEME).toBe('dark')
    expect(resolveTheme(null)).toBe('dark')
    expect(resolveTheme('other')).toBe('dark')
    expect(resolveTheme('dark')).toBe('dark')
    expect(resolveTheme('light')).toBe('dark')
    expect(toggleTheme('light')).toBe('dark')
    expect(toggleTheme('dark')).toBe('dark')
  })

  it('ignora valores inválidos no localStorage', () => {
    expect(readStoredTheme(createStorage('system'))).toBeNull()
    expect(readStoredTheme(createStorage('dark'))).toBe('dark')
  })

  it('aplica data-theme, color-scheme e tokens da escolha', () => {
    const root = createRoot()
    expect(applyTheme('dark', root)).toBe('dark')
    expect(root.dataset.theme).toBe('dark')
    expect(root.style.colorScheme).toBe('dark')
    expect(root.properties.get('--color-bg-page')).toBe(THEME_TOKENS.dark['--color-bg-page'])
    expect(root.properties.get('--color-accent')).toBe(THEME_TOKENS.dark['--color-accent'])
  })

  it('substitui uma preferência clara legada ao inicializar', () => {
    const storage = createStorage('light')
    const root = createRoot()
    expect(initializeTheme(storage, root)).toBe('dark')
    expect(storage.values.get(THEME_STORAGE_KEY)).toBe('dark')
    expect(root.dataset.theme).toBe('dark')
  })

  it('persiste e aplica apenas o tema escuro', () => {
    const storage = createStorage('light')
    const root = createRoot()
    expect(setTheme('light', storage, root)).toBe('dark')
    expect(storage.values.get(THEME_STORAGE_KEY)).toBe('dark')
    expect(root.dataset.theme).toBe('dark')
  })
})
