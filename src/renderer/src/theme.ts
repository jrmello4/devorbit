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
export const DEFAULT_THEME: ThemeMode = 'dark'

const HERO_OPS_TOKENS = {
  '--ops-surface-0': '#0a0c10',
  '--ops-surface-1': '#0f1116',
  '--ops-surface-2': '#12151c',
  '--ops-surface-3': '#171b24',
  '--ops-surface-4': '#1d222e',
  '--ops-border-subtle': 'rgba(232, 236, 243, 0.08)',
  '--ops-border-strong': 'rgba(232, 236, 243, 0.16)',
  '--ops-text-primary': '#e8ecf3',
  '--ops-text-secondary': '#a8b1c2',
  '--ops-text-muted': '#7c8598',
  '--ops-focus': '#a6bf8a',
  '--ops-success': '#69a986',
  '--ops-warning': '#d0a05a',
  '--ops-danger': '#c97a85',
  '--ops-connection': '#3a4152',
  '--ops-selection': 'rgba(166, 191, 138, 0.16)',
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
  '--radius-sm': '5px',
  '--radius-md': '8px',
  '--radius-icon': '6px',
  '--radius-control': '8px',
  '--radius-node': '12px',
  '--radius-panel': '16px',
  '--text-size-body': '13px',
  '--text-size-meta': '11px',
  '--text-size-title': '17px',
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
  '--color-bg-inset': '#e8eaef',
  '--color-bg-raised': '#ffffff',
  '--color-border-subtle': '#d8dbe1',
  '--color-border-strong': '#b9bfc9',
  '--color-text-muted': '#646b78',
  '--color-text-secondary': '#454c58',
  '--color-accent': '#5f7a46',
  '--color-accent-strong': '#4a6038',
  '--color-accent-hover': '#3f5330',
  '--color-focus-ring': '#5f7a46',
  '--color-accent-contrast': '#ffffff',
  '--color-danger': '#a0545e',
  '--color-warning': '#8a6a33',
  '--color-success': '#4f7a5f',
  '--color-git-clean': '#3f7a5c',
  '--color-git-pending': '#8a6a33',
  '--color-git-ahead': '#7a5fa0',
  '--color-git-conflict': '#a0545e',
  '--color-git-none': '#6b7280',
  '--color-orchestrating': '#a8761c',
  '--text-primary': '#20242b',
  '--surface-hover': '#e9ebef',
  '--surface-selected': '#dde2e9',
  '--surface-muted': '#f0f1f4',
} as const

const DARK_TOKENS = {
  ...HERO_OPS_TOKENS,
  '--color-bg-page': '#0f1116',
  '--color-bg-header': '#12151c',
  '--color-bg-toolbar': '#12151c',
  '--color-bg-panel': '#171b24',
  '--color-bg-popover': '#1d222e',
  '--color-bg-card-start': '#171b24',
  '--color-bg-card-end': '#171b24',
  '--color-bg-inset': '#0a0c10',
  '--color-bg-raised': '#1d222e',
  '--color-border-subtle': 'rgba(232, 236, 243, 0.08)',
  '--color-border-strong': 'rgba(232, 236, 243, 0.16)',
  '--color-text-muted': '#7c8598',
  '--color-text-secondary': '#a8b1c2',
  '--color-accent': '#a6bf8a',
  '--color-accent-strong': '#4a6038',
  '--color-accent-hover': '#5a7344',
  '--color-focus-ring': '#a6bf8a',
  '--color-accent-contrast': '#ffffff',
  '--color-danger': '#c97a85',
  '--color-warning': '#d0a05a',
  '--color-success': '#69a986',
  '--color-git-clean': '#69a986',
  '--color-git-pending': '#d0a05a',
  '--color-git-ahead': '#b29dd6',
  '--color-git-conflict': '#c97a85',
  '--color-git-none': '#59616f',
  '--color-orchestrating': '#d9a441',
  '--text-primary': '#e8ecf3',
  '--surface-hover': 'rgba(232, 236, 243, 0.06)',
  '--surface-selected': 'rgba(166, 191, 138, 0.14)',
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
  void value
  return DEFAULT_THEME
}

export function toggleTheme(theme: ThemeMode): ThemeMode {
  void theme
  return 'dark'
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
  void theme
  if (!root) return DEFAULT_THEME
  root.dataset.theme = DEFAULT_THEME
  root.style.colorScheme = DEFAULT_THEME
  for (const [property, value] of Object.entries(THEME_TOKENS[DEFAULT_THEME])) {
    root.style.setProperty(property, value)
  }
  return DEFAULT_THEME
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
  _theme: ThemeMode,
  storage: ThemeStorage | null = getLocalStorage(),
  root: ThemeRoot | null = getDocumentRoot(),
): ThemeMode {
  persistTheme(DEFAULT_THEME, storage)
  return applyTheme(DEFAULT_THEME, root)
}

export function initializeTheme(
  storage: ThemeStorage | null = getLocalStorage(),
  root: ThemeRoot | null = getDocumentRoot(),
): ThemeMode {
  persistTheme('dark', storage)
  return applyTheme('dark', root)
}
