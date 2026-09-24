/**
 * Contrato compartilhado dos Smart Terminals (presets de terminal).
 *
 * Um preset NÃO é um tipo especial de terminal: é apenas dados — rótulo,
 * comando, diretório, auto start e comportamento de reinício — resolvido em
 * tempo de execução pelos caminhos de start já existentes (shell, provider ou
 * comando direto). Isso mantém Codex, Claude, OpenCode e futuras ferramentas
 * fora de hardcode no canvas e no main.
 */

export type TerminalPresetId = 'shell' | 'codex' | 'claude' | 'opencode' | 'antigravity' | 'custom'

/**
 * O que faz o terminal ao reiniciar:
 * - restart: mata o processo e relança o comando salvo do preset;
 * - resume: tenta retomar a sessão anterior quando o preset define
 *   resumeCommand/resumeArgs (sem suporte, cai no relançamento normal);
 * - shell: reinicia como shell puro, sem relançar o agente.
 */
export type TerminalRestartBehavior = 'restart' | 'resume' | 'shell'

/** Como o terminal é iniciado de fato. */
export type TerminalStartKind = 'shell' | 'provider' | 'command'

/** Provedores com fluxo próprio de start no main (conta, health, fallback). */
export type TerminalProviderId = 'codex' | 'claude' | 'opencode' | 'agy'

export interface TerminalPresetDefinition {
  id: TerminalPresetId
  label: string
  description: string
  kind: TerminalStartKind
  providerId?: TerminalProviderId
  /** Comando padrão do preset; presets provider resolvem o comando no main. */
  command?: string
  args?: string[]
  /** Comando que recupera a sessão anterior; ausente = preset sem resume. */
  resumeCommand?: string
  resumeArgs?: string[]
  defaultAutoStart: boolean
  defaultMonitorActivity: boolean
  defaultRestartBehavior: TerminalRestartBehavior
}

const TERMINAL_PRESET_LIST: readonly TerminalPresetDefinition[] = [
  {
    id: 'shell',
    label: 'Shell',
    description: 'Terminal do sistema no diretório do projeto.',
    kind: 'shell',
    defaultAutoStart: false,
    defaultMonitorActivity: false,
    defaultRestartBehavior: 'restart',
  },
  {
    id: 'codex',
    label: 'Codex',
    description: 'Codex CLI com a conta conectada do DevOrbit.',
    kind: 'provider',
    providerId: 'codex',
    defaultAutoStart: true,
    defaultMonitorActivity: true,
    defaultRestartBehavior: 'restart',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    description: 'Claude Code CLI no diretório do projeto.',
    kind: 'provider',
    providerId: 'claude',
    defaultAutoStart: true,
    defaultMonitorActivity: true,
    defaultRestartBehavior: 'restart',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    description: 'OpenCode CLI no diretório do projeto.',
    kind: 'provider',
    providerId: 'opencode',
    defaultAutoStart: true,
    defaultMonitorActivity: true,
    defaultRestartBehavior: 'restart',
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    description: 'Antigravity CLI no diretório do projeto.',
    kind: 'provider',
    providerId: 'agy',
    defaultAutoStart: true,
    defaultMonitorActivity: true,
    defaultRestartBehavior: 'restart',
  },
  {
    id: 'custom',
    label: 'Personalizado',
    description: 'Comando próprio, salvo com o nó do terminal.',
    kind: 'command',
    defaultAutoStart: false,
    defaultMonitorActivity: true,
    defaultRestartBehavior: 'restart',
  },
]

export const TERMINAL_PRESETS = TERMINAL_PRESET_LIST

export function isTerminalPresetId(value: unknown): value is TerminalPresetId {
  return typeof value === 'string' && TERMINAL_PRESET_LIST.some((preset) => preset.id === value)
}

export function getTerminalPreset(id: string): TerminalPresetDefinition | undefined {
  return TERMINAL_PRESET_LIST.find((preset) => preset.id === id)
}

/** Prefixo obrigatório dos ids de presets criados pelo usuário. */
export const CUSTOM_TERMINAL_PRESET_PREFIX = 'custom:'
export const CUSTOM_TERMINAL_PRESET_LIMIT = 24
const CUSTOM_PRESET_ID_PATTERN = /^custom:[a-z0-9][a-z0-9-]{0,48}$/

export type TerminalThemeId = 'carbon' | 'amber' | 'emerald' | 'ocean' | 'violet' | 'rose'

export interface TerminalThemeDefinition {
  id: TerminalThemeId
  label: string
  accent: string
  /**
   * ITheme COMPLETO do xterm: toda a superfície do terminal (fundo com tint
   * da família, foreground suave, cursor/cursorAccent, seleção translúcida e
   * as 16 cores ANSI calibradas) muda junto com o tema — não só o accent.
   * Contraste AA (≥ 4.5:1) garantido para foreground e ANSI de texto sobre o
   * background da própria família (asserções em tests/terminal-theme.test.ts).
   */
  xterm: {
    background: string
    foreground: string
    cursor: string
    /** Cor do texto sob o cursor bloco: o próprio background do tema. */
    cursorAccent: string
    /** Translúcido (#RRGGBBAA): o texto sob a seleção continua legível. */
    selectionBackground: string
    black: string
    brightBlack: string
    red: string
    brightRed: string
    green: string
    brightGreen: string
    yellow: string
    brightYellow: string
    blue: string
    brightBlue: string
    magenta: string
    brightMagenta: string
    cyan: string
    brightCyan: string
    white: string
    brightWhite: string
  }
}

export const TERMINAL_THEMES: readonly TerminalThemeDefinition[] = [
  {
    // Neutro frio (padrão). Fundo/near-fg mantidos; ANSI leve matiz de aço.
    id: 'carbon',
    label: 'Carbon',
    accent: '#8797b4',
    xterm: {
      background: '#0d0f14',
      foreground: '#f5f7fa',
      cursor: '#8797b4',
      cursorAccent: '#0d0f14',
      selectionBackground: '#8797b42e',
      black: '#12151d',
      brightBlack: '#7e8491',
      red: '#d27564',
      brightRed: '#ef907a',
      green: '#9bbd88',
      brightGreen: '#b7d7a3',
      yellow: '#d5b06c',
      brightYellow: '#ebcf8d',
      blue: '#87a7c5',
      brightBlue: '#aac4e0',
      magenta: '#b49ac4',
      brightMagenta: '#d4b7e8',
      cyan: '#7db9b1',
      brightCyan: '#a5ded5',
      white: '#f5f7fa',
      brightWhite: '#ffffff',
    },
  },
  {
    // Âmbar CRT: fundo marrom-café, ANSI puxando para o quente (verde oliva,
    // azul de aço morno, magenta rosado, cian teal quente).
    id: 'amber',
    label: 'Âmbar',
    accent: '#d97706',
    xterm: {
      background: '#141009',
      foreground: '#f6ead2',
      cursor: '#f59e0b',
      cursorAccent: '#141009',
      selectionBackground: '#f59e0b33',
      black: '#1d1710',
      brightBlack: '#8d7f68',
      red: '#e0806a',
      brightRed: '#f29a84',
      green: '#a8bd85',
      brightGreen: '#c4d8a0',
      yellow: '#f0a83c',
      brightYellow: '#ffc95e',
      blue: '#92a9c4',
      brightBlue: '#b3c6de',
      magenta: '#c497ae',
      brightMagenta: '#e0b3c9',
      cyan: '#82bcae',
      brightCyan: '#a9ded2',
      white: '#f6ead2',
      brightWhite: '#fff8ec',
    },
  },
  {
    // Esmeralda: fundo verde-petróleo, verdes emergem (green/cian da família),
    // demais ANSI dessaturados com toque frio-vegetal.
    id: 'emerald',
    label: 'Esmeralda',
    accent: '#059669',
    xterm: {
      background: '#0a130f',
      foreground: '#e6f5ed',
      cursor: '#10b981',
      cursorAccent: '#0a130f',
      selectionBackground: '#10b98133',
      black: '#101d18',
      brightBlack: '#6b887a',
      red: '#d87f6e',
      brightRed: '#f09a89',
      green: '#2fbd85',
      brightGreen: '#5bd9a7',
      yellow: '#cdb97a',
      brightYellow: '#e8d598',
      blue: '#7fabc4',
      brightBlue: '#a6c9de',
      magenta: '#b09cba',
      brightMagenta: '#cfbcd9',
      cyan: '#46cdb2',
      brightCyan: '#85e5cf',
      white: '#e6f5ed',
      brightWhite: '#ffffff',
    },
  },
  {
    // Oceano: fundo azul-abissal, azuis/cian dominantes, magenta periwinkle.
    id: 'ocean',
    label: 'Oceano',
    accent: '#0284c7',
    xterm: {
      background: '#0a1018',
      foreground: '#e7f1fa',
      cursor: '#38bdf8',
      cursorAccent: '#0a1018',
      selectionBackground: '#38bdf833',
      black: '#121d2b',
      brightBlack: '#6d839b',
      red: '#e07f6e',
      brightRed: '#f29b8b',
      green: '#8fbd8f',
      brightGreen: '#aed7ab',
      yellow: '#d8c07c',
      brightYellow: '#ecd899',
      blue: '#45b1f5',
      brightBlue: '#7cc7fa',
      magenta: '#9d8fd0',
      brightMagenta: '#bcb0e6',
      cyan: '#55c3d4',
      brightCyan: '#8edfe8',
      white: '#e7f1fa',
      brightWhite: '#ffffff',
    },
  },
  {
    // Violeta: fundo arroxeado, azul/magenta deslizando para o roxo, cian frio.
    id: 'violet',
    label: 'Violeta',
    accent: '#7c3aed',
    xterm: {
      background: '#110f18',
      foreground: '#f2edf9',
      cursor: '#a855f7',
      cursorAccent: '#110f18',
      selectionBackground: '#a855f733',
      black: '#1a1726',
      brightBlack: '#8679a4',
      red: '#d87d90',
      brightRed: '#ef9aa9',
      green: '#9fbd8f',
      brightGreen: '#bdd8ab',
      yellow: '#d6ba7e',
      brightYellow: '#ecd4a2',
      blue: '#9d90e6',
      brightBlue: '#bcb2f2',
      magenta: '#c084fc',
      brightMagenta: '#d8b4fe',
      cyan: '#82b5cd',
      brightCyan: '#aad6e6',
      white: '#f2edf9',
      brightWhite: '#ffffff',
    },
  },
  {
    // Rosa: fundo vinho-neutro, vermelho/rosa dominantes, magenta pink.
    id: 'rose',
    label: 'Rosa',
    accent: '#e11d48',
    xterm: {
      background: '#140d10',
      foreground: '#f9edf0',
      cursor: '#fb7185',
      cursorAccent: '#140d10',
      selectionBackground: '#fb718533',
      black: '#211419',
      brightBlack: '#93737e',
      red: '#f2687f',
      brightRed: '#ff8fa3',
      green: '#a8bd8c',
      brightGreen: '#c6d9ab',
      yellow: '#dcc386',
      brightYellow: '#f0d9a6',
      blue: '#92a9d2',
      brightBlue: '#b3c7e8',
      magenta: '#e08fb4',
      brightMagenta: '#f2b1ce',
      cyan: '#7fb9c1',
      brightCyan: '#a8dde2',
      white: '#f9edf0',
      brightWhite: '#ffffff',
    },
  },
]

export const TERMINAL_THEME_MAP: Record<TerminalThemeId, TerminalThemeDefinition> = Object.fromEntries(
  TERMINAL_THEMES.map((theme) => [theme.id, theme]),
) as Record<TerminalThemeId, TerminalThemeDefinition>

export function resolveTerminalTheme(themeId?: unknown): TerminalThemeDefinition {
  if (typeof themeId === 'string' && themeId in TERMINAL_THEME_MAP) {
    return TERMINAL_THEME_MAP[themeId as TerminalThemeId]
  }
  return TERMINAL_THEME_MAP.carbon
}

export function sanitizeTerminalThemeId(value: unknown): TerminalThemeId {
  if (typeof value === 'string' && value in TERMINAL_THEME_MAP) {
    return value as TerminalThemeId
  }
  return 'carbon'
}

/**
 * Preset de terminal criado pelo usuário e persistido no config.json.
 * Segredos NÃO pertencem aqui: ambiente sensível continua fora do preset.
 */
export interface CustomTerminalPreset {
  id: string
  name: string
  /** Emoji curto exibido no cartão/chip; opcional. */
  icon?: string
  command: string
  args?: string[]
  resumeCommand?: string
  resumeArgs?: string[]
  defaultAutoStart?: boolean
  defaultMonitorActivity?: boolean
  defaultRestartBehavior?: TerminalRestartBehavior
}

/** Configuração de runtime persistida junto com o nó do canvas. */
export interface TerminalNodeRuntimeConfig {
  presetId: TerminalPresetId | string
  /** Tema de cor do terminal (borda, header e xterm). */
  theme?: TerminalThemeId
  /** Override do comando por terminal; vence o comando do preset. */
  command?: string
  args?: string[]
  resumeCommand?: string
  resumeArgs?: string[]
  cwdMode: 'workspace' | 'custom'
  /** Diretório absoluto usado quando cwdMode === 'custom'. */
  cwd?: string
  autoStart: boolean
  restartBehavior: TerminalRestartBehavior
  monitorActivity: boolean
}

const COMMAND_MAX_LENGTH = 512
const ARG_MAX_LENGTH = 256
const MAX_ARGS = 16
const NAME_MAX_LENGTH = 60
const ICON_MAX_LENGTH = 8

/** Comandos/argumentos nunca passam por shell; % e ! são rejeitados por
 * simetria com a guarda do cmd.exe usada nos caminhos de start do main.
 * Sanitização exige casar códigos de controle. */
/* eslint-disable no-control-regex */
function sanitizeCommandField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > COMMAND_MAX_LENGTH) return undefined
  if (/[%!\0]/.test(trimmed) || /[\u0000-\u001f]/.test(trimmed)) return undefined
  return trimmed
}
/* eslint-enable no-control-regex */

function sanitizeArgList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const args = value
    .slice(0, MAX_ARGS)
    .map((arg) => sanitizeCommandField(arg))
    .filter((arg): arg is string => arg !== undefined)
  return args.length > 0 ? args : undefined
}

function sanitizeRestartBehavior(value: unknown): TerminalRestartBehavior | undefined {
  return value === 'restart' || value === 'resume' || value === 'shell' ? value : undefined
}

export function sanitizeCustomTerminalPreset(value: unknown): CustomTerminalPreset | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const source = value as Record<string, unknown>
  const id = typeof source.id === 'string' ? source.id.trim() : ''
  if (!CUSTOM_PRESET_ID_PATTERN.test(id)) return undefined
  const command = sanitizeCommandField(source.command)
  if (!command) return undefined
  const name = typeof source.name === 'string' ? source.name.trim().slice(0, NAME_MAX_LENGTH) : ''
  if (!name) return undefined
  const icon = typeof source.icon === 'string' && source.icon.trim() && source.icon.trim().length <= ICON_MAX_LENGTH
    ? source.icon.trim()
    : undefined
  const preset: CustomTerminalPreset = { id, name, command }
  if (icon) preset.icon = icon
  const args = sanitizeArgList(source.args)
  if (args) preset.args = args
  const resumeCommand = sanitizeCommandField(source.resumeCommand)
  if (resumeCommand) {
    preset.resumeCommand = resumeCommand
    const resumeArgs = sanitizeArgList(source.resumeArgs)
    if (resumeArgs) preset.resumeArgs = resumeArgs
  }
  if (source.defaultAutoStart === true) preset.defaultAutoStart = true
  if (source.defaultMonitorActivity === true) preset.defaultMonitorActivity = true
  const restartBehavior = sanitizeRestartBehavior(source.defaultRestartBehavior)
  if (restartBehavior) preset.defaultRestartBehavior = restartBehavior
  return preset
}

export function sanitizeCustomTerminalPresets(value: unknown): CustomTerminalPreset[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const presets: CustomTerminalPreset[] = []
  for (const entry of value.slice(0, CUSTOM_TERMINAL_PRESET_LIMIT)) {
    const preset = sanitizeCustomTerminalPreset(entry)
    if (!preset || seen.has(preset.id)) continue
    seen.add(preset.id)
    presets.push(preset)
  }
  return presets.length > 0 ? presets : undefined
}

/** Preset de nó: nunca nulo quando o campo existe; sanitize devolve undefined
 * para lixo de versões antigas do localStorage. */
export function sanitizeTerminalNodeConfig(value: unknown): TerminalNodeRuntimeConfig | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const source = value as Record<string, unknown>
  const presetId = typeof source.presetId === 'string' && source.presetId.trim() ? source.presetId.trim().slice(0, 64) : 'shell'
  const cwdMode = source.cwdMode === 'custom' ? 'custom' : 'workspace'
  const config: TerminalNodeRuntimeConfig = {
    presetId,
    theme: sanitizeTerminalThemeId(source.theme),
    cwdMode,
    autoStart: source.autoStart === true,
    restartBehavior: sanitizeRestartBehavior(source.restartBehavior) ?? 'restart',
    monitorActivity: source.monitorActivity !== false,
  }
  const command = sanitizeCommandField(source.command)
  if (command) config.command = command
  const args = sanitizeArgList(source.args)
  if (args) config.args = args
  const resumeCommand = sanitizeCommandField(source.resumeCommand)
  if (resumeCommand) {
    config.resumeCommand = resumeCommand
    const resumeArgs = sanitizeArgList(source.resumeArgs)
    if (resumeArgs) config.resumeArgs = resumeArgs
  }
  if (cwdMode === 'custom' && typeof source.cwd === 'string' && source.cwd.trim() && source.cwd.length <= 4096) {
    config.cwd = source.cwd.trim()
  }
  return config
}

/** Defaults de nó derivados de um preset (builtin ou custom). */
export function createTerminalNodeConfig(
  preset: TerminalPresetDefinition | CustomTerminalPreset,
): TerminalNodeRuntimeConfig {
  const config: TerminalNodeRuntimeConfig = {
    presetId: preset.id,
    theme: 'carbon',
    cwdMode: 'workspace',
    autoStart: preset.defaultAutoStart === true,
    restartBehavior: preset.defaultRestartBehavior ?? 'restart',
    monitorActivity: preset.defaultMonitorActivity !== false,
  }
  // Presets provider resolvem o comando no main; só copiamos comando quando o
  // preset de fato define um (hoje: presets custom do usuário).
  if (preset.command) {
    config.command = preset.command
    if (preset.args) config.args = [...preset.args]
    if (preset.resumeCommand) {
      config.resumeCommand = preset.resumeCommand
      if (preset.resumeArgs) config.resumeArgs = [...preset.resumeArgs]
    }
  }
  return config
}

export interface ResolvedTerminalLaunch {
  presetId: TerminalPresetId | string
  label: string
  kind: TerminalStartKind
  providerId?: TerminalProviderId
  /** Comando resolvido (override do nó > preset custom > preset builtin). */
  command?: string
  args?: string[]
  resumeCommand?: string
  resumeArgs?: string[]
  autoStart: boolean
  restartBehavior: TerminalRestartBehavior
  monitorActivity: boolean
  /** Preset não encontrado (preset custom apagado): renderer mostra aviso. */
  missing?: boolean
}

/**
 * Resolve o plano de start de um nó a partir da config salva e da lista de
 * presets personalizados. Função pura — usada pelo renderer antes de chamar
 * os canais IPC de start.
 */
export function resolveTerminalLaunch(
  config: TerminalNodeRuntimeConfig,
  customPresets: readonly CustomTerminalPreset[] = [],
): ResolvedTerminalLaunch {
  const builtin = getTerminalPreset(config.presetId)
  const custom = builtin ? undefined : customPresets.find((preset) => preset.id === config.presetId)
  const base: ResolvedTerminalLaunch = {
    presetId: config.presetId,
    label: builtin?.label ?? custom?.name ?? config.presetId,
    kind: builtin?.kind ?? 'command',
    providerId: builtin?.providerId,
    autoStart: config.autoStart,
    restartBehavior: config.restartBehavior,
    monitorActivity: config.monitorActivity,
    missing: !builtin && !custom ? true : undefined,
  }
  const presetCommand = custom?.command ?? (builtin?.kind === 'command' ? builtin.command : undefined)
  const presetArgs = custom?.args ?? (builtin?.kind === 'command' ? builtin.args : undefined)
  const command = config.command ?? presetCommand
  if (command) base.command = command
  const args = config.args ?? presetArgs
  if (args) base.args = [...args]
  const resumeCommand = config.resumeCommand ?? custom?.resumeCommand
  if (resumeCommand) {
    base.resumeCommand = resumeCommand
    const resumeArgs = config.resumeArgs ?? custom?.resumeArgs
    if (resumeArgs) base.resumeArgs = [...resumeArgs]
  }
  if (base.kind === 'command' && !base.command) base.missing = true
  return base
}
