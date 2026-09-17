export type ThemeMode = 'light' | 'dark'

export interface ThemeStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export interface ThemeRoot {
  dataset: {
    theme?: string
    [key: string]: string | undefined
  }
  style: {
    colorScheme: string
    setProperty: (property: string, value: string) => void
  }
}

export const THEME_STORAGE_KEY = 'devorbit:theme'
export const DEFAULT_THEME: ThemeMode = 'light'

const LIGHT_TOKENS = {
  '--color-bg-page': '#f5f5f2',
  '--color-bg-header': '#fcfcfa',
  '--color-bg-toolbar': '#f0f1ed',
  '--color-bg-panel': '#ffffff',
  '--color-bg-popover': '#ffffff',
  '--color-bg-card-start': '#ffffff',
  '--color-bg-card-end': '#ffffff',
  '--color-border-subtle': '#d9dcd5',
  '--color-text-muted': '#62695f',
  '--color-accent': '#49643b',
  '--color-accent-strong': '#3e562f',
  '--color-focus-ring': '#49643b',
  '--color-accent-contrast': '#ffffff',
  '--color-danger': '#993c32',
  '--color-warning': '#8a5d16',
  '--color-success': '#3e6a45',
  '--text-primary': '#242923',
  '--surface-hover': '#eceee7',
  '--surface-selected': '#e7ecdf',
  '--surface-muted': '#f0f1ec',
} as const

const DARK_TOKENS = {
  '--color-bg-page': '#171b17',
  '--color-bg-header': '#1c211c',
  '--color-bg-toolbar': '#222922',
  '--color-bg-panel': '#202620',
  '--color-bg-popover': '#252c25',
  '--color-bg-card-start': '#222a22',
  '--color-bg-card-end': '#202620',
  '--color-border-subtle': '#3b473a',
  '--color-text-muted': '#aeb8a7',
  '--color-accent': '#9dbd83',
  '--color-accent-strong': '#9dbd83',
  '--color-focus-ring': '#b9d89d',
  '--color-accent-contrast': '#172017',
  '--color-danger': '#e08b80',
  '--color-warning': '#d3ae6d',
  '--color-success': '#9cc28d',
  '--text-primary': '#edf1e8',
  '--surface-hover': '#293028',
  '--surface-selected': '#34412f',
  '--surface-muted': '#273027',
} as const

export const THEME_TOKENS = {
  light: LIGHT_TOKENS,
  dark: DARK_TOKENS,
} as const

function getLocalStorage(): ThemeStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function getDocumentRoot(): ThemeRoot | null {
  if (typeof document === 'undefined') return null
  return document.documentElement as ThemeRoot
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark'
}

export function resolveTheme(value: string | null | undefined): ThemeMode {
  return isThemeMode(value) ? value : DEFAULT_THEME
}

export function toggleTheme(theme: ThemeMode): ThemeMode {
  return theme === 'light' ? 'dark' : 'light'
}

export function readStoredTheme(storage: ThemeStorage | null = getLocalStorage()): ThemeMode | null {
  if (!storage) return null
  try {
    const value = storage.getItem(THEME_STORAGE_KEY)
    return isThemeMode(value) ? value : null
  } catch {
    return null
  }
}

export function applyTheme(theme: ThemeMode, root: ThemeRoot | null = getDocumentRoot()): ThemeMode {
  if (!root) return theme
  root.dataset.theme = theme
  root.style.colorScheme = theme
  for (const [property, value] of Object.entries(THEME_TOKENS[theme])) {
    root.style.setProperty(property, value)
  }
  return theme
}

export function persistTheme(theme: ThemeMode, storage: ThemeStorage | null = getLocalStorage()): ThemeMode {
  if (!storage) return theme
  try {
    storage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    return theme
  }
  return theme
}

export function setTheme(
  theme: ThemeMode,
  storage: ThemeStorage | null = getLocalStorage(),
  root: ThemeRoot | null = getDocumentRoot(),
): ThemeMode {
  persistTheme(theme, storage)
  return applyTheme(theme, root)
}

export function initializeTheme(
  storage: ThemeStorage | null = getLocalStorage(),
  root: ThemeRoot | null = getDocumentRoot(),
): ThemeMode {
  return applyTheme(resolveTheme(readStoredTheme(storage)), root)
}
