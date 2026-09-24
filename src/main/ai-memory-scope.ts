import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { buildAiMemoryHelperEnv } from './ai-memory-process-env'
import {
  AI_MEMORY_MARKER_FILENAME,
  AI_MEMORY_MARKER_MANAGED_HEADER,
  AI_MEMORY_REQUIRED_MARKER_FIELDS,
  AI_MEMORY_WORKSPACE,
  type AiMemoryBriefingConfig,
  type AiMemoryMarker,
  type AiMemoryMarkerWriteResult,
  type AiMemoryScope,
} from '../shared/ai-memory-contract'

const execFileAsync = promisify(execFile)

/**
 * Subconjunto de filesystem usado pelo scope/marker. Injetável para que os
 * testes isolem disco sem tocar arquivos reais do usuário.
 */
export interface AiMemoryFileSystem {
  readFile(filePath: string): Promise<Buffer>
  writeFile(filePath: string, data: string | Uint8Array): Promise<void>
  mkdir(dirPath: string, options: { recursive: boolean }): Promise<void>
  stat(filePath: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number }>
  rm(filePath: string, options: { force: boolean; recursive?: boolean }): Promise<void>
  rename(from: string, to: string): Promise<void>
  access(filePath: string): Promise<void>
  realpath(filePath: string): Promise<string>
}

export const nodeAiMemoryFileSystem: AiMemoryFileSystem = {
  readFile: (filePath) => fs.readFile(filePath),
  writeFile: (filePath, data) => fs.writeFile(filePath, data),
  mkdir: async (dirPath, options) => {
    await fs.mkdir(dirPath, options)
  },
  stat: (filePath) => fs.stat(filePath),
  rm: async (filePath, options) => {
    await fs.rm(filePath, options)
  },
  rename: (from, to) => fs.rename(from, to),
  access: (filePath) => fs.access(filePath),
  realpath: (filePath) => fs.realpath(filePath),
}

export type AiMemoryGitRunner = (
  args: readonly string[],
  cwd: string
) => Promise<{ stdout: string }>

/** Runner Git real do scope: env mínimo do helper (sem BYOK/tokens do main). */
const defaultGitRunner: AiMemoryGitRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    env: buildAiMemoryHelperEnv(),
    timeout: 8000,
    windowsHide: true,
  })
  return { stdout: String(stdout || '') }
}

export interface AiMemoryIdentity {
  identity: string
  source: 'remote' | 'git-common-dir' | 'path'
  normalizedRemote?: string
  normalizedCommonDir?: string
}

export interface AiMemoryIdentityInput {
  remoteUrl?: string
  gitCommonDir?: string
  projectPath: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Normaliza a URL remota para uma chave determinística, independente de
 * credenciais, esquema, caixa do host e sufixo `.git`. Suporta HTTPS, SSH e a
 * forma scp-like `user@host:path`.
 */
export function normalizeRemoteUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  let value = raw.trim()
  if (!value) return undefined
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
  if (!hasScheme) {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value)
    if (scp) value = `${scp[1]}/${scp[2]}`
  }
  let host: string
  let pathname: string
  try {
    const url = new URL(hasScheme ? value : `https://${value}`)
    host = url.hostname.toLowerCase()
    pathname = url.pathname
  } catch {
    return undefined
  }
  if (!host) return undefined
  pathname = pathname.replace(/\/+$/, '').replace(/\.git$/i, '')
  return pathname ? `${host}${pathname.toLowerCase()}` : host
}

function normalizePathForKey(value: string): string {
  const normalized = path.normalize(value).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function identityFromValue(kind: string, value: string): string {
  return `${kind}:${sha256(value).slice(0, 32)}`
}

/**
 * Prioridade da identidade:
 * 1. `git-common-dir` — compartilhado por worktrees do MESMO checkout e
 *    distinto entre clones independentes, mesmo com o mesmo origin. Evita
 *    fundir clones distintos só pelo remote (requisito 5 do plano).
 * 2. remoto normalizado — fallback quando não há repositório Git.
 * 3. path resolvido — fallback final fora de Git.
 */
export function deriveAiMemoryIdentity(input: AiMemoryIdentityInput): AiMemoryIdentity {
  if (input.gitCommonDir) {
    const normalizedCommonDir = normalizePathForKey(input.gitCommonDir)
    if (normalizedCommonDir) {
      return {
        identity: identityFromValue('git-common-dir', normalizedCommonDir),
        source: 'git-common-dir',
        normalizedCommonDir,
      }
    }
  }
  const normalizedRemote = normalizeRemoteUrl(input.remoteUrl)
  if (normalizedRemote) {
    return {
      identity: identityFromValue('remote', normalizedRemote),
      source: 'remote',
      normalizedRemote,
    }
  }
  return {
    identity: identityFromValue('path', normalizePathForKey(path.resolve(input.projectPath))),
    source: 'path',
  }
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

function sanitizeName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return NAME_PATTERN.test(normalized) ? normalized : undefined
}

function projectNameFromIdentity(identity: string): string {
  const hash = identity.slice(identity.indexOf(':') + 1)
  return `p-${hash.slice(0, 16)}`
}

export interface ResolveAiMemoryScopeInput {
  projectPath: string
  remoteUrl?: string
  gitCommonDir?: string
  /** Raiz real do worktree (`git rev-parse --show-toplevel`), quando houver. */
  gitTopLevel?: string
  marker?: Partial<AiMemoryMarker>
}

export function resolveAiMemoryScope(input: ResolveAiMemoryScopeInput): AiMemoryScope {
  const derived = deriveAiMemoryIdentity(input)
  const marker = input.marker
  const workspace = sanitizeName(marker?.workspace) ?? AI_MEMORY_WORKSPACE
  const project = sanitizeName(marker?.project) ?? projectNameFromIdentity(derived.identity)
  return {
    workspace,
    project,
    identity: derived.identity,
    source: marker?.project ? 'marker' : derived.source,
    // O marker vive na raiz do checkout/worktree, não no subdiretório de entrada.
    root: path.resolve(input.gitTopLevel ?? input.projectPath),
  }
}

export async function detectGitCommonDir(
  projectPath: string,
  runner: AiMemoryGitRunner = defaultGitRunner
): Promise<string | undefined> {
  try {
    const { stdout } = await runner(['rev-parse', '--git-common-dir'], projectPath)
    const value = stdout.trim()
    if (!value) return undefined
    return path.isAbsolute(value) ? value : path.resolve(projectPath, value)
  } catch {
    return undefined
  }
}

export async function detectRemoteUrl(
  projectPath: string,
  runner: AiMemoryGitRunner = defaultGitRunner
): Promise<string | undefined> {
  try {
    const { stdout } = await runner(['remote', 'get-url', 'origin'], projectPath)
    const value = stdout.trim()
    return value || undefined
  } catch {
    return undefined
  }
}

/** Raiz real do worktree/checkout; `undefined` fora de um repositório Git. */
export async function detectGitTopLevel(
  projectPath: string,
  runner: AiMemoryGitRunner = defaultGitRunner
): Promise<string | undefined> {
  try {
    const { stdout } = await runner(['rev-parse', '--show-toplevel'], projectPath)
    const value = stdout.trim()
    return value || undefined
  } catch {
    return undefined
  }
}

function stripComment(line: string): string {
  let inString = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') inString = !inString
    else if (character === '#' && !inString) return line.slice(0, index)
  }
  return line
}

function parseTomlString(raw: string): string | undefined {
  const trimmed = raw.trim()
  const doubleQuoted = /^"([^"\\]*(?:\\.[^"\\]*)*)"$/.exec(trimmed)
  if (doubleQuoted) return doubleQuoted[1]
  const singleQuoted = /^'([^']*)'$/.exec(trimmed)
  return singleQuoted ? singleQuoted[1] : undefined
}

function parseStringArray(raw: string): string[] | undefined {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined
  const items: string[] = []
  for (const part of trimmed.slice(1, -1).split(',')) {
    const value = parseTomlString(part)
    if (value !== undefined) items.push(value)
  }
  return items
}

function parseTruthy(raw: string): boolean | undefined {
  const value = (parseTomlString(raw) ?? raw.trim()).toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(value)) return true
  if (['false', '0', 'no', 'off'].includes(value)) return false
  return undefined
}

/**
 * Parser TOML mínimo e conservador para o `.ai-memory.toml`. Lê apenas as
 * chaves que o DevOrbit usa; chaves desconhecidas são ignoradas (nunca
 * interpretadas) para preservar markers de terceiros.
 */
export function parseAiMemoryMarker(text: string): Partial<AiMemoryMarker> {
  const marker: Partial<AiMemoryMarker> = {}
  const briefing: AiMemoryBriefingConfig = {}
  let ignorePaths: string[] | undefined
  let section = ''
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim()
    if (!line) continue
    const sectionMatch = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line)
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase()
      continue
    }
    const equals = line.indexOf('=')
    if (equals === -1) continue
    const key = line.slice(0, equals).trim().toLowerCase()
    const rawValue = line.slice(equals + 1).trim()
    if (section === '') {
      if (key === 'workspace') {
        const value = parseTomlString(rawValue)
        if (value) marker.workspace = value
      } else if (key === 'project') {
        const value = parseTomlString(rawValue)
        if (value) marker.project = value
      } else if (key === 'project_strategy') {
        const value = parseTomlString(rawValue)
        if (value === 'repo-root' || value === 'repo_root') marker.projectStrategy = 'repo-root'
      }
    } else if (section === 'capture' && key === 'ignore_paths') {
      const value = parseStringArray(rawValue)
      if (value) ignorePaths = value
    } else if (section === 'briefing') {
      if (key === 'inject_on_session_start') {
        const value = parseTruthy(rawValue)
        if (value !== undefined) briefing.injectOnSessionStart = value
      } else if (key === 'max_chars') {
        const value = Number.parseInt(rawValue, 10)
        if (Number.isInteger(value)) briefing.maxChars = value
      }
    }
  }
  if (ignorePaths) marker.ignorePaths = ignorePaths
  if (Object.keys(briefing).length > 0) marker.briefing = briefing
  return marker
}

/** Escapa uma string para o literal TOML entre aspas duplas. */
export function escapeTomlString(value: string): string {
  /* eslint-disable no-control-regex */
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\u0000-\u001f]/g, '')
  /* eslint-enable no-control-regex */
}

export function renderAiMemoryMarker(marker: AiMemoryMarker): string {
  const quote = (value: string): string => `"${escapeTomlString(value)}"`
  const lines: string[] = [AI_MEMORY_MARKER_MANAGED_HEADER, `workspace = ${quote(marker.workspace)}`]
  if (marker.project) lines.push(`project = ${quote(marker.project)}`)
  if (marker.projectStrategy) lines.push(`project_strategy = ${quote(marker.projectStrategy)}`)
  if (marker.briefing) {
    const briefing = marker.briefing
    if (briefing.injectOnSessionStart !== undefined || briefing.maxChars !== undefined) {
      lines.push('', '[briefing]')
      if (briefing.injectOnSessionStart !== undefined) {
        lines.push(`inject_on_session_start = "${briefing.injectOnSessionStart ? 'true' : 'false'}"`)
      }
      if (briefing.maxChars !== undefined) lines.push(`max_chars = ${briefing.maxChars}`)
    }
  }
  if (marker.ignorePaths && marker.ignorePaths.length > 0) {
    lines.push(
      '',
      '[capture]',
      `ignore_paths = [${marker.ignorePaths.map((pattern) => quote(pattern)).join(', ')}]`
    )
  }
  return `${lines.join('\n')}\n`
}

export interface AiMemoryMarkerOptions {
  fs?: AiMemoryFileSystem
}

export async function readAiMemoryMarker(
  root: string,
  options: AiMemoryMarkerOptions = {}
): Promise<{ exists: boolean; raw?: string; marker?: Partial<AiMemoryMarker> }> {
  const fileSystem = options.fs ?? nodeAiMemoryFileSystem
  const filePath = path.join(path.resolve(root), AI_MEMORY_MARKER_FILENAME)
  try {
    const raw = (await fileSystem.readFile(filePath)).toString('utf8')
    return { exists: true, raw, marker: parseAiMemoryMarker(raw) }
  } catch {
    return { exists: false }
  }
}

/**
 * Substituição atômica com backup/restauração garantida. Nunca remove o
 * arquivo original antes de ter uma cópia: se a troca final falhar, o
 * conteúdo preexistente é restaurado. Em qualquer falha, o original
 * permanece intacto e o temporário é limpo.
 */
async function atomicWriteMarker(
  fileSystem: AiMemoryFileSystem,
  filePath: string,
  content: string
): Promise<void> {
  const stamp = `${process.pid}.${Date.now()}`
  const temporary = `${filePath}.${stamp}.tmp`
  await fileSystem.writeFile(temporary, content)
  try {
    await fileSystem.rename(temporary, filePath)
    return
  } catch {
    // Windows pode recusar o rename direto sobre um arquivo existente.
  }

  const backup = `${filePath}.${stamp}.bak`
  let backupCreated = false
  try {
    await fileSystem.rename(filePath, backup)
    backupCreated = true
    await fileSystem.rename(temporary, filePath)
    await fileSystem.rm(backup, { force: true }).catch(() => undefined)
  } catch (error) {
    if (backupCreated) {
      // Restaura o original; se a restauração falhar, o backup permanece.
      await fileSystem.rename(backup, filePath).catch(() => undefined)
    }
    await fileSystem.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Cabeçalho DevOrbit só conta como a PRIMEIRA linha significativa. */
function isManagedMarker(text: string): boolean {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    return line === AI_MEMORY_MARKER_MANAGED_HEADER
  }
  return false
}

const MANAGED_TOP_LEVEL_KEYS = new Set(['workspace', 'project', 'project_strategy'])
const MANAGED_SECTIONS = new Set(['capture', 'briefing'])

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, index) => value === sortedRight[index])
}

/**
 * Divergência semântica entre um marker gerenciado existente e o desejado.
 * Qualquer diferença de preferência/privacidade (exclusões ou briefing) é
 * reportada para que NADA seja reescrito silenciosamente.
 */
function markerDivergence(existing: Partial<AiMemoryMarker>, desired: AiMemoryMarker): string[] {
  const fields: string[] = []
  if ((existing.workspace ?? '') !== desired.workspace) fields.push('workspace')
  if ((existing.project ?? '') !== (desired.project ?? '')) fields.push('project')
  if ((existing.projectStrategy ?? '') !== (desired.projectStrategy ?? '')) fields.push('project_strategy')
  if (!sameStringSet(existing.ignorePaths ?? [], desired.ignorePaths ?? [])) fields.push('ignore_paths')
  const existingBriefing = existing.briefing ?? {}
  const desiredBriefing = desired.briefing ?? {}
  if (
    (existingBriefing.injectOnSessionStart ?? false) !==
    (desiredBriefing.injectOnSessionStart ?? false)
  ) {
    fields.push('briefing.inject_on_session_start')
  }
  if ((existingBriefing.maxChars ?? null) !== (desiredBriefing.maxChars ?? null)) {
    fields.push('briefing.max_chars')
  }
  return fields
}

/** Detecta conteúdo que não pertence ao conjunto gerenciado pelo DevOrbit. */
function hasUnmanagedContent(text: string): boolean {
  let section = ''
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim()
    if (!line) continue
    const sectionMatch = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line)
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase()
      if (!MANAGED_SECTIONS.has(section)) return true
      continue
    }
    const equals = line.indexOf('=')
    if (equals === -1) return true
    const key = line.slice(0, equals).trim().toLowerCase()
    if (section === '') {
      if (!MANAGED_TOP_LEVEL_KEYS.has(key)) return true
    } else if (section === 'capture') {
      if (key !== 'ignore_paths') return true
    } else if (section === 'briefing') {
      if (key !== 'inject_on_session_start' && key !== 'max_chars') return true
    }
  }
  return false
}

function missingMarkerFields(parsed: Partial<AiMemoryMarker>): string[] {
  const missing: string[] = []
  if (!parsed.workspace) missing.push('workspace')
  if (!parsed.project) missing.push('project')
  if (!parsed.ignorePaths || parsed.ignorePaths.length === 0) missing.push('ignore_paths')
  if (!parsed.briefing || parsed.briefing.injectOnSessionStart !== true) missing.push('briefing')
  return missing.filter((field) => (AI_MEMORY_REQUIRED_MARKER_FIELDS as readonly string[]).includes(field))
}

/**
 * Escrita idempotente, atômica e à prova de conflito:
 * - sem marker → cria (configured: true);
 * - marker gerenciado pelo DevOrbit → atualiza (ou não-op se idêntico);
 * - marker de terceiros → NUNCA é sobrescrito, fica `preserved` e
 *   `configured: false` (com os campos obrigatórios ausentes listados);
 * - marker de terceiros com workspace/project divergente → `conflict`.
 */
export async function writeAiMemoryMarker(
  root: string,
  marker: AiMemoryMarker,
  options: AiMemoryMarkerOptions = {}
): Promise<AiMemoryMarkerWriteResult> {
  const fileSystem = options.fs ?? nodeAiMemoryFileSystem
  const filePath = path.join(path.resolve(root), AI_MEMORY_MARKER_FILENAME)
  const desired = renderAiMemoryMarker(marker)

  let existing: string | undefined
  try {
    existing = (await fileSystem.readFile(filePath)).toString('utf8')
  } catch {
    existing = undefined
  }

  if (existing === undefined) {
    await fileSystem.mkdir(path.dirname(filePath), { recursive: true })
    await atomicWriteMarker(fileSystem, filePath, desired)
    return { status: 'created', path: filePath, configured: true }
  }

  const parsed = parseAiMemoryMarker(existing)
  const conflicts: string[] = []
  if (parsed.workspace && parsed.workspace !== marker.workspace) conflicts.push('workspace')
  if (parsed.project && marker.project && parsed.project !== marker.project) conflicts.push('project')
  if (conflicts.length > 0) {
    return { status: 'conflict', path: filePath, configured: false, conflicts }
  }

  if (!isManagedMarker(existing)) {
    // Marker de terceiros: preservado intacto e nunca reportado como configurado.
    return {
      status: 'preserved',
      path: filePath,
      configured: false,
      missingFields: missingMarkerFields(parsed),
    }
  }
  if (hasUnmanagedContent(existing)) {
    // Marker gerenciado com extras do usuário: não sobrescrever silenciosamente.
    return { status: 'conflict', path: filePath, configured: false, conflicts: ['extra-content'] }
  }
  // Preferência/privacidade divergente (exclusões, briefing, strategy): conflito
  // SEM escrita, preservando integralmente o que o usuário configurou.
  const divergence = markerDivergence(parsed, marker)
  if (divergence.length > 0) {
    return { status: 'conflict', path: filePath, configured: false, conflicts: divergence }
  }
  if (existing === desired) return { status: 'unchanged', path: filePath, configured: true }
  // Semântica idêntica, apenas formatação diferente: normaliza com a escrita
  // atômica segura (nunca altera preferência/privacidade).
  await atomicWriteMarker(fileSystem, filePath, desired)
  return { status: 'updated', path: filePath, configured: true }
}
