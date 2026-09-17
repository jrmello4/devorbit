export type NavigateActionId =
  | 'nav-projects'
  | 'nav-canvas'
  | 'nav-terminal'
  | 'nav-git'
  | 'nav-memory'
  | 'nav-settings'

export type CreateActionId =
  | 'create-agent-terminal'
  | 'create-note'
  | 'create-branch'
  | 'create-project'
  | 'create-squad'

export type TwoStrokePrefix = 'g' | 'c'

export interface TwoStrokeBinding {
  prefix: TwoStrokePrefix
  key: string
  action: NavigateActionId | CreateActionId
  label: string
  hint: string
}

export const NAVIGATE_BINDINGS: TwoStrokeBinding[] = [
  { prefix: 'g', key: 'p', action: 'nav-projects', label: 'Ir para Projetos', hint: 'G then P' },
  { prefix: 'g', key: 'c', action: 'nav-canvas', label: 'Ir para Canvas', hint: 'G then C' },
  { prefix: 'g', key: 't', action: 'nav-terminal', label: 'Ir para Terminal primário', hint: 'G then T' },
  { prefix: 'g', key: 'g', action: 'nav-git', label: 'Ir para Painel Git', hint: 'G then G' },
  { prefix: 'g', key: 'm', action: 'nav-memory', label: 'Ir para Memória', hint: 'G then M' },
  { prefix: 'g', key: 's', action: 'nav-settings', label: 'Ir para Configurações', hint: 'G then S' },
]

export const CREATE_BINDINGS: TwoStrokeBinding[] = [
  { prefix: 'c', key: 't', action: 'create-agent-terminal', label: 'Novo terminal de agente', hint: 'C then T' },
  { prefix: 'c', key: 's', action: 'create-squad', label: 'Novo squad de agentes', hint: 'C then S' },
  { prefix: 'c', key: 'n', action: 'create-note', label: 'Nova nota Markdown', hint: 'C then N' },
  { prefix: 'c', key: 'b', action: 'create-branch', label: 'Nova branch Git', hint: 'C then B' },
  { prefix: 'c', key: 'p', action: 'create-project', label: 'Novo projeto', hint: 'C then P' },
]

export const TWO_STROKE_BINDINGS: TwoStrokeBinding[] = [...NAVIGATE_BINDINGS, ...CREATE_BINDINGS]

export function normalizeStrokeKey(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  return normalized.length === 1 && /[a-z]/.test(normalized) ? normalized : null
}

export function matchTwoStroke(prefix: TwoStrokePrefix | null, key: string): TwoStrokeBinding | null {
  if (!prefix) return null
  const normalized = normalizeStrokeKey(key)
  if (!normalized) return null
  return TWO_STROKE_BINDINGS.find((binding) => binding.prefix === prefix && binding.key === normalized) || null
}

export function detectPrefixQuery(query: string): TwoStrokePrefix | null {
  const trimmed = query.trim().toLowerCase()
  if (trimmed === 'g' || trimmed === 'c') return trimmed as TwoStrokePrefix
  return null
}

export function parseSpacedTwoStroke(query: string): TwoStrokeBinding | null {
  const parts = query.trim().toLowerCase().split(/\s+/)
  if (parts.length !== 2) return null
  const [prefix, key] = parts
  if ((prefix !== 'g' && prefix !== 'c') || !key) return null
  return matchTwoStroke(prefix as TwoStrokePrefix, key)
}

export interface FocusedCanvasContext {
  id: string
  title: string
  kind: string
}

export function rankWithFocusedContext<T extends { label: string; description: string }>(
  items: T[],
  query: string,
  focused: FocusedCanvasContext | null,
): T[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!focused || !normalizedQuery) return items
  const focusTokens = focused.title.toLowerCase().split(/\s+/).filter(Boolean)
  if (focusTokens.length === 0) return items
  const scored = items.map((item) => {
    const haystack = `${item.label} ${item.description}`.toLowerCase()
    let score = 0
    for (const token of focusTokens) {
      if (token.length >= 3 && haystack.includes(token)) score += 1
    }
    return { item, score }
  })
  return scored
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.item)
}

export type PaletteToggleIntent = 'open' | 'close' | 'ignore'

export function resolvePaletteToggle(params: {
  paletteOpen: boolean
  settingsOpen: boolean
  toolHealthOpen: boolean
  authOpen: boolean
  memoryOpen: boolean
  updateModalOpen: boolean
}): PaletteToggleIntent {
  if (params.paletteOpen) return 'close'
  if (params.settingsOpen || params.toolHealthOpen || params.authOpen || params.memoryOpen || params.updateModalOpen) {
    return 'ignore'
  }
  return 'open'
}
