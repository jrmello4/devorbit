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

const HERO_OPS_TOKENS = {
  '--ops-surface-0': '#08090c',
  '--ops-surface-1': '#0d0f14',
  '--ops-surface-2': '#11141b',
  '--ops-surface-3': '#171a22',
  '--ops-surface-4': '#1d212b',
  '--ops-border-subtle': '#252a34',
  '--ops-border-strong': '#343b48',
  '--ops-text-primary': '#f5f7fa',
  '--ops-text-secondary': '#b7bdc8',
  '--ops-text-muted': '#7e8491',
  '--ops-focus': '#8797b4',
  '--ops-success': '#69a986',
  '--ops-warning': '#c79a59',
  '--ops-danger': '#b56e76',
  '--ops-connection': '#5b667a',
  '--ops-selection': 'rgba(135, 151, 180, 0.16)',
  '--ops-overlay': 'rgba(4, 5, 8, 0.78)',
  '--ops-grid-line': 'rgba(255, 255, 255, 0.032)',
  '--ops-shadow-node': 'rgba(0, 0, 0, 0.45)',
  '--space-1': '4px',
  '--space-2': '8px',
  '--space-3': '12px',
  '--space-4': '16px',
  '--space-5': '20px',
  '--space-6': '24px',
  '--space-8': '32px',
  '--radius-icon': '6px',
  '--radius-control': '8px',
  '--radius-node': '12px',
  '--radius-panel': '16px',
  '--font-ui': "'Segoe UI', system-ui, sans-serif",
  '--font-mono': "'Cascadia Code', Consolas, 'JetBrains Mono', ui-monospace, monospace",
} as const

const LIGHT_TOKENS = {
  ...HERO_OPS_TOKENS,
  '--color-bg-page': '#f4f5f7',
  '--color-bg-header': '#fbfbfc',
  '--color-bg-toolbar': '#eef0f3',
  '--color-bg-panel': '#ffffff',
  '--color-bg-popover': '#ffffff',
  '--color-bg-card-start': '#ffffff',
  '--color-bg-card-end': '#ffffff',
  '--color-border-subtle': '#d8dbe1',
  '--color-border-strong': '#b9bfc9',
  '--color-text-muted': '#646b78',
  '--color-text-secondary': '#454c58',
  '--color-accent': '#5b6b86',
  '--color-accent-strong': '#46536b',
  '--color-accent-hover': '#3a4557',
  '--color-focus-ring': '#5b6b86',
  '--color-accent-contrast': '#ffffff',
  '--color-danger': '#a0545e',
  '--color-warning': '#8a6a33',
  '--color-success': '#4f7a5f',
  '--text-primary': '#20242b',
  '--surface-hover': '#e9ebef',
  '--surface-selected': '#dde2e9',
  '--surface-muted': '#f0f1f4',
} as const

const DARK_TOKENS = {
  ...HERO_OPS_TOKENS,
  '--color-bg-page': '#0d0f14',
  '--color-bg-header': '#11141b',
  '--color-bg-toolbar': '#0d0f14',
  '--color-bg-panel': '#171a22',
  '--color-bg-popover': '#1d212b',
  '--color-bg-card-start': '#171a22',
  '--color-bg-card-end': '#11141b',
  '--color-border-subtle': '#252a34',
  '--color-border-strong': '#343b48',
  '--color-text-muted': '#8b93a3',
  '--color-text-secondary': '#b7bdc8',
  '--color-accent': '#8797b4',
  '--color-accent-strong': '#8797b4',
  '--color-accent-hover': '#9aa9c3',
  '--color-focus-ring': '#a3b1c9',
  '--color-accent-contrast': '#11141b',
  '--color-danger': '#b56e76',
  '--color-warning': '#c79a59',
  '--color-success': '#69a986',
  '--text-primary': '#f5f7fa',
  '--surface-hover': '#1d212b',
  '--surface-selected': '#232b39',
  '--surface-muted': '#141820',
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
