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
  xterm: {
    background: string
    foreground: string
    cursor: string
    selectionBackground: string
    black?: string
    brightBlack?: string
    red?: string
    brightRed?: string
    green?: string
    brightGreen?: string
    yellow?: string
    brightYellow?: string
    blue?: string
    brightBlue?: string
    magenta?: string
    brightMagenta?: string
    cyan?: string
    brightCyan?: string
    white?: string
    brightWhite?: string
  }
}

export const TERMINAL_THEMES: readonly TerminalThemeDefinition[] = [
  {
    id: 'carbon',
    label: 'Carbon',
    accent: '#8797b4',
    xterm: {
      background: '#0d0f14',
      foreground: '#f5f7fa',
      cursor: '#8797b4',
      selectionBackground: '#232b39',
      black: '#0d0f14',
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
    id: 'amber',
    label: 'Âmbar',
    accent: '#d97706',
    xterm: {
      background: '#120f09',
      foreground: '#fbf3e4',
      cursor: '#f59e0b',
      selectionBackground: '#382914',
      black: '#120f09',
      brightBlack: '#786b59',
      red: '#d97764',
      brightRed: '#f0907a',
      green: '#9bbd88',
      brightGreen: '#b7d7a3',
      yellow: '#f59e0b',
      brightYellow: '#fbbf24',
      blue: '#87a7c5',
      brightBlue: '#aac4e0',
      magenta: '#b49ac4',
      brightMagenta: '#d4b7e8',
      cyan: '#7db9b1',
      brightCyan: '#a5ded5',
      white: '#fbf3e4',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'emerald',
    label: 'Esmeralda',
    accent: '#059669',
    xterm: {
      background: '#0a130f',
      foreground: '#eafbf3',
      cursor: '#10b981',
      selectionBackground: '#143a29',
      black: '#0a130f',
      brightBlack: '#597368',
      red: '#d27564',
      brightRed: '#ef907a',
      green: '#10b981',
      brightGreen: '#34d399',
      yellow: '#d5b06c',
      brightYellow: '#ebcf8d',
      blue: '#87a7c5',
      brightBlue: '#aac4e0',
      magenta: '#b49ac4',
      brightMagenta: '#d4b7e8',
      cyan: '#5eead4',
      brightCyan: '#99f6e4',
      white: '#eafbf3',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'ocean',
    label: 'Oceano',
    accent: '#0284c7',
    xterm: {
      background: '#0a1017',
      foreground: '#eef6fc',
      cursor: '#38bdf8',
      selectionBackground: '#163148',
      black: '#0a1017',
      brightBlack: '#566c82',
      red: '#d27564',
      brightRed: '#ef907a',
      green: '#9bbd88',
      brightGreen: '#b7d7a3',
      yellow: '#d5b06c',
      brightYellow: '#ebcf8d',
      blue: '#38bdf8',
      brightBlue: '#7dd3fc',
      magenta: '#b49ac4',
      brightMagenta: '#d4b7e8',
      cyan: '#7db9b1',
      brightCyan: '#a5ded5',
      white: '#eef6fc',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'violet',
    label: 'Violeta',
    accent: '#7c3aed',
    xterm: {
      background: '#110c19',
      foreground: '#f8f4fc',
      cursor: '#a855f7',
      selectionBackground: '#35204c',
      black: '#110c19',
      brightBlack: '#6e5b82',
      red: '#d27564',
      brightRed: '#ef907a',
      green: '#9bbd88',
      brightGreen: '#b7d7a3',
      yellow: '#d5b06c',
      brightYellow: '#ebcf8d',
      blue: '#87a7c5',
      brightBlue: '#aac4e0',
      magenta: '#a855f7',
      brightMagenta: '#c084fc',
      cyan: '#7db9b1',
      brightCyan: '#a5ded5',
      white: '#f8f4fc',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'rose',
    label: 'Rosa',
    accent: '#e11d48',
    xterm: {
      background: '#160c11',
      foreground: '#fdf2f4',
      cursor: '#fb7185',
      selectionBackground: '#4a1c28',
      black: '#160c11',
      brightBlack: '#7f5d68',
      red: '#fb7185',
      brightRed: '#fda4af',
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
      white: '#fdf2f4',
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
