import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { AgentProvider, AgentProviderId, AppConfig } from '../renderer/src/types'

const execFileAsync = promisify(execFile)

const MAX_COMMAND_LENGTH = 4096
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.bat', '.cmd', '.com', '.exe'])

export const AGENT_CLI_AUTH_MESSAGE = 'A autenticação é gerenciada pelo próprio CLI.'

export interface AgentCliDefinition {
  id: AgentProviderId
  label: string
  aliases: readonly string[]
  defaultCommand: string
}

export type AgentCliResolution = Pick<
  AgentProvider,
  'id' | 'label' | 'state' | 'path' | 'message'
>

export type AgentCliConfiguredCommands = Partial<
  Record<AgentProviderId, string | undefined>
>

export const AGENT_CLI_PROVIDER_IDS = [
  'codex',
  'opencode',
  'claude',
  'gemini',
  'aider',
  'agy',
  'custom',
] as const satisfies readonly AgentProviderId[]

export const AGENT_CLI_PROVIDERS = {
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    aliases: ['codex', 'codex.cmd', 'codex.exe'],
    defaultCommand: 'codex.cmd',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    aliases: ['opencode', 'opencode.cmd', 'opencode.exe'],
    defaultCommand: 'opencode.cmd',
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    aliases: [
      'claude',
      'claude.cmd',
      'claude.exe',
      'claude-code',
      'claude-code.cmd',
      'claude-code.exe',
    ],
    defaultCommand: 'claude.cmd',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    aliases: ['gemini', 'gemini.cmd', 'gemini.exe'],
    defaultCommand: 'gemini.cmd',
  },
  aider: {
    id: 'aider',
    label: 'Aider',
    aliases: ['aider', 'aider.cmd', 'aider.exe'],
    defaultCommand: 'aider.cmd',
  },
  agy: {
    id: 'agy',
    label: 'Antigravity',
    aliases: [
      'agy',
      'agy.cmd',
      'agy.exe',
      'antigravity',
      'antigravity.cmd',
      'antigravity.exe',
    ],
    defaultCommand: 'agy.cmd',
  },
  custom: {
    id: 'custom',
    label: 'Outro CLI',
    aliases: [],
    defaultCommand: '',
  },
} as const satisfies Record<AgentProviderId, AgentCliDefinition>

export const AGENT_PROVIDER_IDS = AGENT_CLI_PROVIDER_IDS
export const AGENT_PROVIDERS = AGENT_CLI_PROVIDERS

/**
 * Roteador de modelos por turno (FASE 3, padrão Elyra/BYOK).
 *
 * Tarefas mecânicas (grep, leitura de arquivos, compilação, resumos simples)
 * vão para modelos ultraleves e econômicos; refatoração complexa, arquitetura
 * e revisão vão para modelos de raciocínio profundo. O roteamento é por turno:
 * cada prompt é classificado de forma independente e determinística.
 */
export type TaskComplexity = 'mechanical' | 'deep'

export type ModelTier = 'fast' | 'deep'

export interface ModelTierDefinition {
  tier: ModelTier
  label: string
  models: readonly string[]
}

export const MODEL_TIERS = {
  fast: {
    tier: 'fast',
    label: 'Ultraleve e econômico',
    models: ['claude-haiku', 'gpt-4o-mini', 'ollama-local'],
  },
  deep: {
    tier: 'deep',
    label: 'Raciocínio profundo',
    models: ['gpt-6-astra', 'claude-sonnet'],
  },
} as const satisfies Record<ModelTier, ModelTierDefinition>

const MECHANICAL_PATTERNS = [
  /\bgrep\b/i,
  /leia?\s+(os?\s+|as?\s+)?arquivos?/i,
  /list(e|ar)?\s+.*arquivos?/i,
  /\bread\s+files?\b/i,
  /compil(ar|ação|e|ation|ing)/i,
  /\b(build|tsc|lint|testes?\s+rápidos?)\b/i,
  /resumo\s+simples/i,
  /\b(list(ar)?|show|print)\b.*\b(files?|arquivos?)\b/i,
  /^ *(ls|cat|dir|type|find|grep|rg)\b/im,
]

const DEEP_PATTERNS = [
  /refator/i,
  /refactor/i,
  /arquitet/i,
  /architect/i,
  /revis/i,
  /review/i,
  /design\s+(do\s+)?sistema/i,
  /migr/i,
  /otimiz/i,
  /segurança|vulnerabilidade/i,
]

export function classifyTaskComplexity(prompt: unknown): TaskComplexity {
  if (typeof prompt !== 'string' || !prompt.trim()) return 'mechanical'
  const text = prompt.trim()
  if (DEEP_PATTERNS.some((pattern) => pattern.test(text))) return 'deep'
  if (MECHANICAL_PATTERNS.some((pattern) => pattern.test(text))) return 'mechanical'
  // Prompt longo sem vocabulário mecânico explícito tende a exigir raciocínio.
  return text.length > 240 ? 'deep' : 'mechanical'
}

export interface ClassificationExplanation {
  complexity: TaskComplexity
  tier: ModelTier
  matchedMechanical: string[]
  matchedDeep: string[]
}

/** Explica a decisão do roteador (auditoria da escolha por turno). */
export function explainClassification(prompt: unknown): ClassificationExplanation {
  const text = typeof prompt === 'string' ? prompt.trim() : ''
  const matchedDeep = text ? DEEP_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source) : []
  const matchedMechanical = text && matchedDeep.length === 0
    ? MECHANICAL_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source)
    : []
  const complexity = classifyTaskComplexity(prompt)
  return {
    complexity,
    tier: complexity === 'deep' ? 'deep' : 'fast',
    matchedMechanical,
    matchedDeep,
  }
}

export function routeTaskToTier(prompt: unknown): ModelTier {
  return classifyTaskComplexity(prompt) === 'deep' ? 'deep' : 'fast'
}

export function tierModels(tier: ModelTier): readonly string[] {
  return MODEL_TIERS[tier].models
}

/**
 * Fallback multi-provedor: ordena o preferido primeiro e completa com os
 * demais provedores prontos, para que uma indisponibilidade ou rate limit do
 * primário não bloqueie o turno.
 */
export function orderProvidersForTask(
  preferred: AgentProviderId,
  readyIds: readonly AgentProviderId[]
): AgentProviderId[] {
  const ready = new Set(readyIds)
  const ordered: AgentProviderId[] = []
  if (ready.has(preferred)) ordered.push(preferred)
  for (const id of AGENT_CLI_PROVIDER_IDS) {
    if (id !== preferred && ready.has(id)) ordered.push(id)
  }
  if (!ready.has(preferred)) ordered.push(preferred)
  return ordered
}

export function selectProviderWithFallback(
  preferred: AgentProviderId,
  health: readonly { id: AgentProviderId; state: string }[]
): { provider: AgentProviderId; fellBack: boolean } {
  const ready = health.filter((item) => item.state === 'ready').map((item) => item.id)
  const ordered = orderProvidersForTask(preferred, ready)
  const selected = ordered[0] || preferred
  return { provider: selected, fellBack: selected !== preferred }
}

const CONFIGURED_COMMAND_KEYS: Record<
  AgentProviderId,
  keyof AppConfig['customPaths']
> = {
  codex: 'codex',
  opencode: 'opencode',
  claude: 'claude',
  gemini: 'gemini',
  aider: 'aider',
  agy: 'agy',
  custom: 'customAgent',
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 31 || code === 127) return true
  }
  return false
}

interface WindowsPathContext {
  home: string
  appData: string
  localAppData: string
  programFiles: string
  programFilesX86: string
  virtualEnv: string | undefined
}

function winJoin(...parts: string[]): string {
  return path.win32.join(...parts)
}

function isWindowsAbsolute(value: string): boolean {
  return path.win32.isAbsolute(value)
}

function getAbsoluteEnvironmentPath(
  name: string,
  fallback: string
): string {
  const value = process.env[name]?.trim()
  return value && isWindowsAbsolute(value) ? value : fallback
}

function getWindowsPathContext(): WindowsPathContext {
  const home = getAbsoluteEnvironmentPath('USERPROFILE', os.homedir())
  return {
    home,
    appData: getAbsoluteEnvironmentPath(
      'APPDATA',
      winJoin(home, 'AppData', 'Roaming')
    ),
    localAppData: getAbsoluteEnvironmentPath(
      'LOCALAPPDATA',
      winJoin(home, 'AppData', 'Local')
    ),
    programFiles: getAbsoluteEnvironmentPath(
      'ProgramFiles',
      winJoin('C:', 'Program Files')
    ),
    programFilesX86: getAbsoluteEnvironmentPath(
      'ProgramFiles(x86)',
      winJoin('C:', 'Program Files (x86)')
    ),
    virtualEnv: process.env.VIRTUAL_ENV?.trim() &&
      isWindowsAbsolute(process.env.VIRTUAL_ENV.trim())
      ? process.env.VIRTUAL_ENV.trim()
      : undefined,
  }
}

function isSupportedExecutable(file: string): boolean {
  const value = file.trim()
  if (!value || value.length > MAX_COMMAND_LENGTH || !isWindowsAbsolute(value)) {
    return false
  }
  if (hasControlCharacters(value)) return false
  return WINDOWS_EXECUTABLE_EXTENSIONS.has(path.win32.extname(value).toLowerCase())
}

function isSafeAlias(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)
}

function normalizeConfiguredCommand(command: string | undefined): string | null {
  if (typeof command !== 'string') return null

  let value = command.trim()
  if (!value || value.length > MAX_COMMAND_LENGTH) return null
  if (hasControlCharacters(value)) return null

  if (value.startsWith('"') || value.endsWith('"')) {
    if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) {
      return null
    }
    value = value.slice(1, -1).trim()
  }

  if (!value || value.includes('"')) return null
  if (isWindowsAbsolute(value)) return value
  if (!isSafeAlias(value)) return null
  return value
}

async function fileExists(file: string): Promise<boolean> {
  try {
    const stats = await fs.stat(file)
    return stats.isFile()
  } catch {
    return false
  }
}

async function findOnPath(alias: string): Promise<string | null> {
  if (process.platform !== 'win32' || !isSafeAlias(alias)) return null

  try {
    const { stdout } = await execFileAsync('where.exe', [alias], {
      shell: false,
      timeout: 5000,
      windowsHide: true,
    })
    const candidates = String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => isSupportedExecutable(line))

    for (const candidate of candidates) {
      if (await fileExists(candidate)) return candidate
    }
  } catch {
    // A missing alias is a normal result for an availability probe.
  }
  return null
}

function uniquePaths(candidates: string[]): string[] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = candidate.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function executableNames(provider: AgentCliDefinition): string[] {
  const names = provider.aliases.flatMap((alias) => {
    const extension = path.win32.extname(alias).toLowerCase()
    return WINDOWS_EXECUTABLE_EXTENSIONS.has(extension)
      ? [alias]
      : [alias + '.cmd', alias + '.bat', alias + '.exe']
  })
  return uniquePaths(names)
}

function addBinCandidates(
  candidates: string[],
  bin: string | undefined,
  provider: AgentCliDefinition
): void {
  if (!bin || !isWindowsAbsolute(bin)) return
  for (const name of executableNames(provider)) {
    candidates.push(winJoin(bin, name))
  }
}

function getKnownPathCandidates(
  provider: AgentCliDefinition,
  context: WindowsPathContext
): string[] {
  const candidates: string[] = []
  const scriptBins = [
    winJoin(context.appData, 'npm'),
    winJoin(context.localAppData, 'pnpm'),
    winJoin(context.localAppData, 'Yarn', 'bin'),
    winJoin(context.home, 'scoop', 'shims'),
  ]

  for (const bin of scriptBins) addBinCandidates(candidates, bin, provider)

  switch (provider.id) {
    case 'codex':
      candidates.push(
        winJoin(context.localAppData, 'OpenAI', 'Codex', 'bin', 'codex.exe'),
        winJoin(context.localAppData, 'OpenAI', 'Codex', 'codex.exe')
      )
      break
    case 'opencode':
      candidates.push(
        winJoin(context.home, '.opencode', 'bin', 'opencode.exe'),
        winJoin(context.localAppData, 'opencode', 'opencode.exe')
      )
      break
    case 'claude':
      candidates.push(
        winJoin(context.home, '.local', 'bin', 'claude.exe'),
        winJoin(context.localAppData, 'Programs', 'Claude Code', 'claude.exe'),
        winJoin(context.localAppData, 'Programs', 'claude-code', 'claude.exe')
      )
      break
    case 'gemini':
      candidates.push(
        winJoin(context.home, '.local', 'bin', 'gemini.exe'),
        winJoin(context.home, '.gemini', 'bin', 'gemini.exe'),
        winJoin(context.localAppData, 'Programs', 'Gemini CLI', 'gemini.exe')
      )
      break
    case 'aider':
      candidates.push(
        winJoin(context.home, '.local', 'bin', 'aider.exe'),
        winJoin(context.home, 'pipx', 'bin', 'aider.exe'),
        winJoin(context.appData, 'Python', 'Scripts', 'aider.exe')
      )
      addBinCandidates(
        candidates,
        context.virtualEnv && winJoin(context.virtualEnv, 'Scripts'),
        provider
      )
      break
    case 'agy':
      candidates.push(
        winJoin(context.localAppData, 'agy', 'bin', 'agy.exe'),
        winJoin(context.localAppData, 'agy', 'agy.exe'),
        winJoin(
          context.localAppData,
          'Programs',
          'Antigravity',
          'antigravity.exe'
        ),
        winJoin(context.programFiles, 'Antigravity', 'antigravity.exe'),
        winJoin(context.programFiles, 'Antigravity', 'agy.exe'),
        winJoin(context.programFilesX86, 'Antigravity', 'antigravity.exe'),
        winJoin(context.programFilesX86, 'Antigravity', 'agy.exe')
      )
      break
    case 'custom':
      break
  }

  return uniquePaths(candidates)
}

async function findVersionedExecutable(
  root: string,
  executable: string
): Promise<string | null> {
  if (process.platform !== 'win32' || !isWindowsAbsolute(root)) return null

  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const candidate = winJoin(root, entry.name, executable)
          if (!isSupportedExecutable(candidate)) return null
          try {
            const stats = await fs.stat(candidate)
            return stats.isFile()
              ? { path: candidate, modifiedAt: stats.mtimeMs }
              : null
          } catch {
            return null
          }
        })
    )

    return candidates
      .filter(
        (candidate): candidate is { path: string; modifiedAt: number } =>
          candidate !== null
      )
      .sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.path || null
  } catch {
    return null
  }
}

async function resolveKnownPath(
  provider: AgentCliDefinition,
  context: WindowsPathContext
): Promise<string | null> {
  for (const candidate of getKnownPathCandidates(provider, context)) {
    if (await fileExists(candidate)) return candidate
  }

  if (provider.id === 'codex') {
    return findVersionedExecutable(
      winJoin(context.localAppData, 'OpenAI', 'Codex', 'bin'),
      'codex.exe'
    )
  }

  if (provider.id === 'aider') {
    const pythonRoots = [
      winJoin(context.appData, 'Python'),
      winJoin(context.localAppData, 'Programs', 'Python'),
    ]
    for (const root of pythonRoots) {
      try {
        const entries = await fs.readdir(root, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const candidate = winJoin(root, entry.name, 'Scripts', 'aider.exe')
          if (await fileExists(candidate)) return candidate
        }
      } catch {
        // Optional package-manager directories may not exist.
      }
    }
  }

  return null
}

function providerDefinition(provider: AgentProviderId): AgentCliDefinition {
  return AGENT_CLI_PROVIDERS[provider]
}

function configuredCommand(
  config: AppConfig,
  provider: AgentProviderId
): string | undefined {
  const key = CONFIGURED_COMMAND_KEYS[provider]
  return config.customPaths?.[key]
}

async function resolveProviderPath(
  provider: AgentCliDefinition,
  configured: string | undefined
): Promise<string | null> {
  if (process.platform !== 'win32') return null

  const command = normalizeConfiguredCommand(configured)
  if (command) {
    const resolved = isWindowsAbsolute(command)
      ? (await fileExists(command) ? command : null)
      : await findOnPath(command)
    if (resolved) return resolved
  }

  if (provider.id === 'custom') return null

  for (const alias of provider.aliases) {
    const resolved = await findOnPath(alias)
    if (resolved) return resolved
  }

  return resolveKnownPath(provider, getWindowsPathContext())
}

function resolutionMessage(
  provider: AgentCliDefinition,
  resolvedPath: string | null
): string {
  return resolvedPath
    ? provider.label +
      ' instalado em ' +
      resolvedPath +
      '. ' +
      AGENT_CLI_AUTH_MESSAGE
    : provider.label + ' ausente. ' + AGENT_CLI_AUTH_MESSAGE
}

function statusCommand(
  provider: AgentCliDefinition,
  configured: string | undefined
): string {
  return normalizeConfiguredCommand(configured) || provider.defaultCommand
}

export async function resolveAgentProviderCommand(
  config: AppConfig,
  provider: AgentProviderId
): Promise<{ path: string | null; message: string }> {
  const definition = providerDefinition(provider)
  const resolvedPath = await resolveProviderPath(
    definition,
    configuredCommand(config, provider)
  )
  return {
    path: resolvedPath,
    message: resolutionMessage(definition, resolvedPath),
  }
}

/**
 * BYOK (Bring Your Own Keys): chaves vêm do ambiente ou de `modelRouting` no
 * config. Chaves NUNCA aparecem em mensagens, logs ou retornos — só o modelo
 * escolhido e um booleano `authConfigured` saem deste módulo.
 */
export interface ModelRoutingConfig {
  fastModel?: string
  deepModel?: string
  openaiApiKey?: string
  anthropicApiKey?: string
}

const MAX_MODEL_NAME_LENGTH = 200
const MAX_API_KEY_LENGTH = 500

function cleanModelName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_MODEL_NAME_LENGTH || /[\s"']/.test(trimmed)) return undefined
  return trimmed
}

function cleanApiKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_API_KEY_LENGTH || /\s/.test(trimmed)) return undefined
  return trimmed
}

export function validateModelRoutingConfig(value: unknown): ModelRoutingConfig | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuração de modelos inválida.')
  const source = value as Record<string, unknown>
  const result: ModelRoutingConfig = {}
  const fastModel = cleanModelName(source.fastModel)
  const deepModel = cleanModelName(source.deepModel)
  const openaiApiKey = cleanApiKey(source.openaiApiKey)
  const anthropicApiKey = cleanApiKey(source.anthropicApiKey)
  if (fastModel) result.fastModel = fastModel
  if (deepModel) result.deepModel = deepModel
  if (openaiApiKey) result.openaiApiKey = openaiApiKey
  if (anthropicApiKey) result.anthropicApiKey = anthropicApiKey
  return Object.keys(result).length > 0 ? result : undefined
}

export interface ModelAuthStatus {
  model: string
  authConfigured: boolean
}

export function resolveModelForTier(
  tier: ModelTier,
  routing?: ModelRoutingConfig,
  env: NodeJS.ProcessEnv = process.env
): ModelAuthStatus {
  const configured = tier === 'fast' ? routing?.fastModel : routing?.deepModel
  const fallback = tier === 'fast' ? MODEL_TIERS.fast.models[1] : MODEL_TIERS.deep.models[1]
  const model = cleanModelName(configured) || fallback
  const key = cleanApiKey(routing?.openaiApiKey) || cleanApiKey(env.OPENAI_API_KEY)
    || cleanApiKey(routing?.anthropicApiKey) || cleanApiKey(env.ANTHROPIC_API_KEY)
  return { model, authConfigured: Boolean(key) }
}

/** Remove qualquer material de chave antes de expor objetos em IPC/logs. */
export function redactSecrets<T>(value: T): T {
  if (typeof value === 'string') {
    return value
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[chave omitida]')
      .replace(/(api[_-]?key["'\s:=]+)(["']?)[^"'\s,}]+(["']?)/gi, '$1[chave omitida]') as T
  }
  if (Array.isArray(value)) return value.map(redactSecrets) as T
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (/api[_-]?key|secret|token/i.test(key)) {
        output[key] = '[chave omitida]'
      } else {
        output[key] = redactSecrets(entry)
      }
    }
    return output as T
  }
  return value
}

/**
 * Só erros transitórios (rate limit, indisponibilidade, rede, pipe quebrado)
 * autorizam fallback para o próximo provedor. Erros permanentes (auth,
 * requisição inválida, binário ausente) falham direto sem mascarar a causa.
 */
const TRANSIENT_PATTERNS = [
  /rate[\s_-]?limit/i,
  /too many requests/i,
  /\b429\b/,
  /\b503\b/,
  /\b502\b/,
  /overloaded/i,
  /unavailable/i,
  /temporar/i,
  /timeout|timed out/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENETUNREACH/i,
  /socket hang up/i,
  /service degraded/i,
]

const PERMANENT_PATTERNS = [
  /invalid[\s_-]*api[\s_-]*key|incorrect api key|authentication/i,
  /permission denied|forbidden|\b401\b|\b403\b/i,
  /not found.*model|model.*not found/i,
]

/**
 * Binário ausente (ENOENT) = provedor indisponível: autoriza tentar o próximo
 * provedor da ordem (cada um no máximo uma vez — sem repetição).
 */
const UNAVAILABLE_BINARY_PATTERNS = [/ENOENT/i, /command not found/i, /not recognized as .*command/i]

export function isTransientProviderError(error: unknown): boolean {
  const text = error instanceof Error
    ? `${error.message} ${(error as NodeJS.ErrnoException).code || ''}`
    : String(error ?? '')
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(text))) return false
  if (UNAVAILABLE_BINARY_PATTERNS.some((pattern) => pattern.test(text))) return true
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * Extrai da cauda de saída a última linha com sinal transitório (rate limit,
 * 429, indisponibilidade). Retorna undefined para texto permanente ou limpo —
 * inclusive quando há padrão permanente junto (auth prevalece: sem retry).
 */
export function findTransientSnippet(tail: unknown, maxLength = 300): string | undefined {
  if (typeof tail !== 'string' || !tail.trim()) return undefined
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(tail))) return undefined
  const lines = tail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(line))) {
      return line.slice(0, maxLength)
    }
  }
  return undefined
}

/** Prova de saúde real: executa `<cli> --version` com timeout (presença do binário não basta). */export async function probeProviderCommand(commandPath: string, timeoutMs = 8000): Promise<{ ok: boolean; detail: string }> {
  if (typeof commandPath !== 'string' || !commandPath.trim()) {
    return { ok: false, detail: 'Comando vazio.' }
  }
  try {
    const { stdout } = await execFileAsync(commandPath, ['--version'], {
      timeout: timeoutMs,
      windowsHide: true,
    })
    return { ok: true, detail: String(stdout || '').trim().slice(0, 200) || 'Respondeu a --version.' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, detail: message.slice(0, 200) }
  }
}

export interface AgentTurnResolution {
  tier: ModelTier
  model: string
  authConfigured: boolean
  provider: AgentProviderId
  fellBack: boolean
  reason: string
  explanation: ClassificationExplanation
}

/**
 * Resolução por turno: recebe o prompt, seleciona tier/modelo/provedor. Não
 * executa nada — só decide. Chaves nunca saem daqui.
 */
export async function resolveAgentTurn(
  config: AppConfig,
  preferred: AgentProviderId,
  prompt: unknown
): Promise<AgentTurnResolution> {
  const explanation = explainClassification(prompt)
  const routing = config.modelRouting
  const { model, authConfigured } = resolveModelForTier(explanation.tier, routing)
  const health = await getAgentProviderHealth(config)
  const { provider, fellBack } = selectProviderWithFallback(preferred, health)
  return {
    tier: explanation.tier,
    model,
    authConfigured,
    provider,
    fellBack,
    reason: fellBack
      ? `Provedor preferido indisponível; turno ${explanation.tier} encaminhado para ${provider}.`
      : `Turno ${explanation.tier} encaminhado para ${provider}.`,
    explanation,
  }
}

export interface TurnAttempt {
  provider: AgentProviderId
  ok: boolean
  error?: string
}

export interface TurnExecution<T> {
  provider: AgentProviderId
  result: T
  attempts: TurnAttempt[]
}

/**
 * Executa um turno tentando os provedores em ordem; o fallback acontece SOMENTE
 * para erros transitórios classificados. Retorna o provedor efetivamente usado.
 */
export async function executeAgentTurnWithFallback<T>(
  orderedProviders: readonly AgentProviderId[],
  execute: (provider: AgentProviderId) => Promise<T>
): Promise<TurnExecution<T>> {
  if (orderedProviders.length === 0) throw new Error('Nenhum provedor disponível para o turno.')
  const attempts: TurnAttempt[] = []
  let lastError: unknown
  for (const provider of orderedProviders) {
    try {
      const result = await execute(provider)
      attempts.push({ provider, ok: true })
      return { provider, result, attempts }
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      attempts.push({ provider, ok: false, error: redactSecrets(message).slice(0, 300) })
      if (!isTransientProviderError(error)) break
    }
  }
  throw Object.assign(
    new Error(`Turno falhou em ${attempts.length} provedor(es): ${redactSecrets(lastError instanceof Error ? lastError.message : String(lastError)).slice(0, 200)}`),
    { attempts }
  )
}

/**
 * Resolve o provedor preferido com fallback automático para o próximo CLI
 * pronto quando o preferido está ausente (rate limit/indisponibilidade nunca
 * devem travar o turno sem alternativa).
 */
export async function resolveAgentProviderWithFallback(
  config: AppConfig,
  preferred: AgentProviderId
): Promise<{ path: string | null; message: string; provider: AgentProviderId; fellBack: boolean }> {
  const health = await getAgentProviderHealth(config)
  const { provider, fellBack } = selectProviderWithFallback(preferred, health)
  const resolution = await resolveAgentProviderCommand(config, provider)
  if (fellBack && resolution.path) {
    return {
      ...resolution,
      provider,
      fellBack,
      message: `${providerDefinition(preferred).label} indisponível; usando ${providerDefinition(provider).label}. ${resolution.message}`,
    }
  }
  return { ...resolution, provider, fellBack: fellBack && resolution.path !== null }
}

export async function getAgentProviderHealth(
  config: AppConfig
): Promise<AgentProvider[]> {
  return Promise.all(
    AGENT_CLI_PROVIDER_IDS.map(async (providerId) => {
      const definition = providerDefinition(providerId)
      const configured = configuredCommand(config, providerId)
      const resolution = await resolveAgentProviderCommand(config, providerId)
      return {
        id: providerId,
        label: definition.label,
        command: statusCommand(definition, configured),
        state: resolution.path ? 'ready' : 'missing',
        path: resolution.path || undefined,
        message: resolution.message,
      }
    })
  )
}

/**
 * Monta o env do processo filho para o turno: modelo/tier sempre, chaves
 * BYOK por família somente quando presentes. Chaves nunca retornam ao renderer.
 */
export function buildAgentTurnEnv(
  provider: AgentProviderId,
  model: string,
  tier: ModelTier,
  routing?: ModelRoutingConfig,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    DEVORBIT_MODEL: model,
    DEVORBIT_MODEL_TIER: tier,
  }
  const pick = (configValue?: string, ...names: string[]): string | undefined => {
    if (configValue && configValue.trim()) return configValue.trim()
    for (const name of names) {
      const value = baseEnv[name]
      if (value && value.trim()) return value.trim()
    }
    return undefined
  }
  const openai = pick(routing?.openaiApiKey, 'OPENAI_API_KEY')
  const anthropic = pick(routing?.anthropicApiKey, 'ANTHROPIC_API_KEY')
  const gemini = pick(undefined, 'GEMINI_API_KEY')
  const assign = (name: string, value: string | undefined) => {
    if (value) env[name] = value
  }
  switch (provider) {
    case 'opencode':
    case 'claude':
      assign('ANTHROPIC_API_KEY', anthropic)
      break
    case 'codex':
      assign('OPENAI_API_KEY', openai)
      break
    case 'gemini':
      assign('GEMINI_API_KEY', gemini)
      break
    case 'aider':
      assign('OPENAI_API_KEY', openai)
      assign('ANTHROPIC_API_KEY', anthropic)
      break
    case 'agy':
    case 'custom':
      break
  }
  return env
}

/**
 * Flag de modelo reconhecida por provedor para o spawn interativo.
 * `null` = sem flag documentada: o modelo vai só via env (DEVORBIT_MODEL).
 * Contrato do CLI custom: ler `DEVORBIT_MODEL` / `DEVORBIT_MODEL_TIER` do
 * ambiente; chaves BYOK chegam nas vars padrão da família (ex.
 * ANTHROPIC_API_KEY) — nunca em argv, log ou retorno IPC.
 */
const PROVIDER_MODEL_FLAGS: Record<AgentProviderId, string | null> = {
  codex: null,
  opencode: '--model',
  claude: '--model',
  gemini: '--model',
  aider: '--model',
  agy: null,
  custom: null,
}

export interface ProviderInvocation {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/**
 * Adapter: produz o argv/env exato passado ao startTerminal para o modelo do
 * turno. No Windows os CLIs resolvem para wrappers .cmd — a flag do modelo é
 * encaminhada através do `call` (shims .cmd repassam `%*` ao executável real)
 * para a seleção valer também no caminho padrão; o env é sempre enviado como
 * redundância. Sem flag documentada (codex/agy/custom), vale o contrato
 * env-only: o CLI lê `DEVORBIT_MODEL` / `DEVORBIT_MODEL_TIER` (+ BYOK da
 * família). Chaves nunca vão em argv.
 */
export function resolveProviderInvocation(
  provider: AgentProviderId,
  commandPath: string,
  model: string,
  tier: ModelTier,
  routing?: ModelRoutingConfig,
  baseEnv: NodeJS.ProcessEnv = process.env
): ProviderInvocation {
  if (typeof model !== 'string' || !/^[\w][\w.:+-]{0,199}$/.test(model)) {
    throw new Error('Modelo do turno inválido.')
  }
  const env = buildAgentTurnEnv(provider, model, tier, routing, baseEnv)
  const flag = PROVIDER_MODEL_FLAGS[provider]
  if (/\.(?:cmd|bat)$/i.test(commandPath)) {
    // Wrapper Windows: `call "x.cmd" --model m` — o shim repassa os
    // argumentos ao CLI real; sem flag conhecida, só env (sem quebrar).
    const forwarded = flag ? ` ${flag} ${model}` : ''
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/q', '/k', `call "${commandPath}"${forwarded}`],
      env,
    }
  }
  return {
    command: commandPath,
    args: flag ? [flag, model] : [],
    env,
  }
}
