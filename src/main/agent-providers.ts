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
