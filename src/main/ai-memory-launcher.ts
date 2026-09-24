import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import electron from 'electron'
import type { AiMemoryScope } from '../shared/ai-memory-contract'
import type { AiMemoryService } from './ai-memory-service'
import {
  setupAgentIntegrations,
  setupGeminiAgentIntegrations,
  type AiMemoryAgentSetupDeps,
  type AiMemoryAgentSetupRequest,
  type AiMemoryAgentSetupResult,
} from './ai-memory-agent-setup'
import { buildAiMemoryHelperEnv } from './ai-memory-process-env'

const { app } = electron
const execFileAsync = promisify(execFile)

/**
 * Nome do arquivo de modo de captura sob `dataDir` (confirmado em `hook.rs: CAPTURE_MODE_FILE = "capture-mode"`).
 * Quando este arquivo contém "allowlist", hooks e autowire operam em modo restrito
 * onde repositórios sem marker `.ai-memory.toml` descartam eventos e não capturam nada.
 */
export const AI_MEMORY_CAPTURE_MODE_FILE = 'capture-mode'

/**
 * Harnesses suportados pelo `ai-memory run` na release v2.4.0 (verificados em `cli.rs`).
 * Posicionais no CLI: o `ai-memory run` v2.4.0 não aceita `--harness`.
 */
export const AI_MEMORY_HARNESS_MAP: Readonly<Record<string, string>> = {
  codex: 'codex',
  opencode: 'opencode',
  opencode2: 'opencode2',
  claude: 'claude',
  'claude-code': 'claude',
  agy: 'antigravity',
  antigravity: 'antigravity',
  'antigravity-cli': 'antigravity',
  'command-code': 'command-code',
  cmdc: 'command-code',
}

/**
 * Mapeamento oficial de harness para o nome de agente aceito por `install-hooks --agent <name>`.
 */
export const AI_MEMORY_AGENT_CHOICE_MAP: Readonly<Record<string, string>> = {
  codex: 'codex',
  opencode: 'opencode',
  opencode2: 'opencode2',
  claude: 'claude-code',
  'claude-code': 'claude-code',
  agy: 'antigravity-cli',
  antigravity: 'antigravity-cli',
  'antigravity-cli': 'antigravity-cli',
  'command-code': 'command-code',
  cmdc: 'command-code',
}

export function resolveAiMemoryAgentChoice(provider: string): string | null {
  const normalized = provider.toLowerCase().trim()
  return AI_MEMORY_AGENT_CHOICE_MAP[normalized] ?? null
}

export type AiMemorySupportedHarness =
  | 'codex'
  | 'opencode'
  | 'opencode2'
  | 'claude'
  | 'antigravity'
  | 'command-code'

export type AiMemoryDegradedReason =
  | 'opt-out'
  | 'service-unavailable'
  | 'marker-unconfigured'
  | 'harness-not-supported'
  | 'binary-missing'
  | 'preparation-failed'
  | 'setup-failed'

export interface ScopeReservation {
  terminalId: string
  scopeKey: string
  workspace: string
  project: string
  isDefault: boolean
  workstream: string
  reservedAt: number
}

export interface AiMemorySessionMetadata {
  terminalId: string
  provider: string
  harness: string
  workstream: string
  isDefaultWorkstream?: boolean
  workspace: string
  project: string
  dataDir: string
  binaryPath: string
  sessionId?: string
  startedAt: number
  generation?: number
}

export interface AiMemoryLaunchPlan {
  /** true = comando envelopado com `ai-memory run`; false = execução direta. */
  wrapped: boolean
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  harness?: string
  workstream?: string
  isDefaultWorkstream?: boolean
  degradedReason?: AiMemoryDegradedReason
  metadata?: AiMemorySessionMetadata
}

export interface AiMemoryLaunchContext {
  provider: string
  resolvedCommand: string
  originalArgs?: readonly string[]
  env: NodeJS.ProcessEnv
  cwd: string
  terminalId: string
  account?: 'account1' | 'account2'
  sessionId?: string
}

export interface AiMemoryLauncherDeps {
  getService?: () => Pick<
    AiMemoryService,
    'status' | 'health' | 'resolveScope' | 'ensureProjectMarker' | 'isProjectEnabled'
  > | null | undefined
  getDataDir?: () => string
  /** Root de userData para a receipt do setup (injetável; default Electron). */
  getUserDataDir?: () => string
  /**
   * Setup MCP+hooks do Gemini CLI (injetável para testes herméticos). Nunca
   * recebe o env do harness — logo CODEX_HOME/tokens não vazam para o instalador.
   */
  setupGemini?: (
    request: AiMemoryAgentSetupRequest,
    deps: AiMemoryAgentSetupDeps
  ) => Promise<AiMemoryAgentSetupResult>
  /**
   * Setup NATIVO por provider (v2.4.0: MCP + hooks onde a matriz diz hooks;
   * OpenCode/OpenCode2 = remote MCP + plugin). Complementar ao `ai-memory run`
   * (que é opt-in de continuidade, NÃO substituto). Injetável; falha → fallback
   * direto degradado ('setup-failed'), nunca bloqueia o workspace.
   */
  setupAgent?: (
    request: AiMemoryAgentSetupRequest,
    deps: AiMemoryAgentSetupDeps
  ) => Promise<AiMemoryAgentSetupResult>
  generateWorkstreamId?: (provider: string, terminalId: string) => string
  ensureAllowlistMode?: (dataDir: string) => Promise<boolean>
  execCli?: (
    binaryPath: string,
    args: readonly string[],
    options?: { timeout?: number; env?: NodeJS.ProcessEnv }
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>
}

const WINDOWS_SCRIPT_EXTENSIONS = /\.(?:cmd|bat|com)$/i

export interface ResolveExecutableForRustDeps {
  platform?: NodeJS.Platform
  isAbsolute?: (candidate: string) => boolean
  statSync?: (
    candidate: string,
    options?: { throwIfNoEntry?: boolean }
  ) => { isFile(): boolean } | undefined
}

/**
 * Resolve o executável real para `--executable` do Rust ai-memory run.
 *
 * Se o comando apontar para um script (.cmd/.bat/.com) ABSOLUTO e houver um
 * .exe de mesmo base name no mesmo diretório (ex.: opencode.exe ao lado de
 * opencode.cmd), prefere o binário compilado.
 *
 * Caminho RELATIVO é preservado como recebido: `path.dirname('foo.cmd')`
 * devolve '.', e procurar o `.exe` irmão recairia sobre o cwd do processo,
 * podendo escolher um executável alheio (achado Shell #3).
 *
 * Caso contrário, retorna o caminho do script resolvido diretamente:
 * a CLI upstream do ai-memory (v2.4.0) já suporta a seleção e execução de
 * scripts .cmd e .bat nativamente através de `--executable`. O toolchain
 * upstream fixa Rust 1.95 (BatBadBut já mitigado), então `.cmd`/`.bat` NÃO
 * são degradados.
 *
 * NUNCA retorne `cmd.exe /c <shim>`, pois `--executable` espera estritamente
 * o caminho do executável/script e passar a string `cmd.exe` com argumentos
 * quebra a invocação direta de subprocessos pelo binário Rust.
 */
export function resolveExecutableForRust(
  resolvedCommand: string,
  deps: ResolveExecutableForRustDeps = {}
): string {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return resolvedCommand
  if (!WINDOWS_SCRIPT_EXTENSIONS.test(resolvedCommand)) return resolvedCommand

  // Guarda Shell #3: só investiga o .exe irmão para caminhos ABSOLUTOS.
  const isAbsolute = deps.isAbsolute ?? path.isAbsolute
  if (!isAbsolute(resolvedCommand)) return resolvedCommand

  const dir = path.dirname(resolvedCommand)
  const base = path.basename(resolvedCommand, path.extname(resolvedCommand))

  // 1. Procura .exe de mesmo base name no mesmo diretório.
  const exeCandidate = path.join(dir, `${base}.exe`)
  const statSync = deps.statSync ?? fsSync.statSync
  try {
    // Síncrono: statSync é aceitável aqui (chamada rara, cold path).
    const stat = statSync(exeCandidate, { throwIfNoEntry: false })
    if (stat?.isFile()) return exeCandidate
  } catch {
    // Ignorado: arquivo não existe.
  }

  // 2. Retorna o script resolvido diretamente (upstream ai-memory v2.4.0 suporta .cmd/.bat).
  return resolvedCommand
}

/**
 * Garante que o capture-mode sob `dataDir` esteja configurado estritamente como 'allowlist'.
 * Sem essa garantia, o autowire padrão de `ai-memory run` adota 'denylist',
 * capturando repositórios sem marker ativo e violando o opt-in de privacidade do usuário.
 */
export async function ensureAllowlistCaptureMode(
  dataDir: string,
  fsImpl?: {
    readFile?: (path: string, encoding: string) => Promise<string>
    writeFile?: (path: string, content: string, encoding: string) => Promise<unknown>
    mkdir?: (path: string, options?: { recursive?: boolean }) => Promise<unknown>
  }
): Promise<boolean> {
  const targetFile = path.join(dataDir, AI_MEMORY_CAPTURE_MODE_FILE)
  const reader = fsImpl?.readFile ?? ((p: string) => fs.readFile(p, 'utf8'))
  const writer = fsImpl?.writeFile ?? ((p: string, c: string) => fs.writeFile(p, c, 'utf8'))
  const mkdirer = fsImpl?.mkdir ?? ((p: string, opts?: { recursive?: boolean }) => fs.mkdir(p, opts))

  try {
    const existing = await reader(targetFile, 'utf8').catch(() => null)
    if (existing && existing.trim().toLowerCase() === 'allowlist') {
      return true
    }
    await mkdirer(dataDir, { recursive: true })
    await writer(targetFile, 'allowlist\n', 'utf8')
    return true
  } catch (err) {
    console.warn('[DevOrbit ai-memory-launcher] Falha ao configurar capture-mode allowlist:', err)
    return false
  }
}

/** Instância global do serviço de memória (injetada no bootstrap). */
let globalAiMemoryService: Pick<
  AiMemoryService,
  'status' | 'health' | 'resolveScope' | 'ensureProjectMarker' | 'isProjectEnabled'
> | null = null

export function setGlobalAiMemoryService(
  service: Pick<
    AiMemoryService,
    'status' | 'health' | 'resolveScope' | 'ensureProjectMarker' | 'isProjectEnabled'
  > | null
): void {
  globalAiMemoryService = service
}

/**
 * Substituto do setup nativo para TESTES herméticos (agent-turn/launcher).
 * Produção nunca usa: `deps.setupAgent` tem precedência sobre o override.
 */
let aiMemorySetupOverride:
  | ((
      request: AiMemoryAgentSetupRequest,
      deps: AiMemoryAgentSetupDeps
    ) => Promise<AiMemoryAgentSetupResult>)
  | null = null

export function setAiMemorySetupOverrideForTest(
  fn:
    | ((
        request: AiMemoryAgentSetupRequest,
        deps: AiMemoryAgentSetupDeps
      ) => Promise<AiMemoryAgentSetupResult>)
    | null
): void {
  aiMemorySetupOverride = fn
}

export function getGlobalAiMemoryService(): Pick<
  AiMemoryService,
  'status' | 'health' | 'resolveScope' | 'ensureProjectMarker' | 'isProjectEnabled'
> | null {
  return globalAiMemoryService
}

export function resolveAiMemoryHarness(provider: string): AiMemorySupportedHarness | null {
  const normalized = provider.toLowerCase().trim()
  const match = AI_MEMORY_HARNESS_MAP[normalized]
  return (match as AiMemorySupportedHarness) ?? null
}

/**
 * Data dir do ai-memory: EXCLUSIVAMENTE `<userData>/ai-memory/data`.
 * `userDataDir` opcional é o construtor puro (testes); sem ele, usa
 * `app.getPath('userData')`. NÃO há fallback para outro home: se a resolução
 * falhar, o erro sobe para o chamador degradar sem criar uma segunda fonte.
 */
export function resolveAiMemoryDataDir(userDataDir?: string): string {
  const base = userDataDir ?? app.getPath('userData')
  return path.join(base, 'ai-memory', 'data')
}

/** Root de userData (receipt do setup de agente). Construtor puro injetável. */
export function resolveAiMemoryUserDataDir(userDataDir?: string): string {
  return userDataDir ?? app.getPath('userData')
}

/**
 * Gera identificador determinístico e único de workstream por execução.
 * `--new <id>` cria um workstream independente para evitar colisão ou lease compartilhado.
 */
export function generateWorkstreamId(provider: string, terminalId: string): string {
  const safeProvider = provider.toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'agent'
  const safeId = terminalId.replace(/[^a-z0-9_-]/g, '') || 'session'
  const randomSuffix = Math.random().toString(36).slice(2, 8)
  const timestamp = Date.now().toString(36)
  return `${safeProvider}-${safeId}-${timestamp}-${randomSuffix}`
}

/** Plano de execução DIRETA (sem wrapper ai-memory); opcionalmente degradado. */
function directPlan(
  context: AiMemoryLaunchContext,
  degradedReason?: AiMemoryDegradedReason
): AiMemoryLaunchPlan {
  return {
    wrapped: false,
    command: context.resolvedCommand,
    args: context.originalArgs ? [...context.originalArgs] : [],
    env: context.env,
    cwd: context.cwd,
    ...(degradedReason ? { degradedReason } : {}),
  }
}

function fallbackPlan(
  context: AiMemoryLaunchContext,
  degradedReason: AiMemoryDegradedReason
): AiMemoryLaunchPlan {
  pendingScopeReservations.delete(context.terminalId)
  return directPlan(context, degradedReason)
}

/**
 * Gemini CLI: a memória vem de hooks + MCP (`install-mcp`/`install-hooks`),
 * NUNCA de `ai-memory run`. Fail-closed no SETUP e fail-open no INÍCIO: qualquer
 * falha devolve execução direta com `degradedReason` visível, sem bloquear o PTY.
 * O env do harness NUNCA é repassado ao instalador (sem CODEX_HOME/tokens).
 */
async function prepareGeminiDirectLaunch(
  context: AiMemoryLaunchContext,
  deps: AiMemoryLauncherDeps
): Promise<AiMemoryLaunchPlan> {
  const service = deps.getService ? deps.getService() : getGlobalAiMemoryService()
  if (!service) return directPlan(context, 'service-unavailable')
  try {
    const status = service.status()
    if (status.state !== 'running') return directPlan(context, 'service-unavailable')

    if (typeof service.health === 'function') {
      try {
        const health = await service.health()
        if (!health.ok) return directPlan(context, 'service-unavailable')
      } catch {
        return directPlan(context, 'service-unavailable')
      }
    }

    const binaryPath = status.binaryPath
    if (!binaryPath) return directPlan(context, 'binary-missing')

    const scope = await service.resolveScope(context.cwd)
    if (!service.isProjectEnabled(scope.identity)) return directPlan(context, 'opt-out')

    const marker = await service.ensureProjectMarker(context.cwd)
    if (!marker.configured) return directPlan(context, 'marker-unconfigured')

    let dataDir: string
    let userDataDir: string
    try {
      dataDir = deps.getDataDir ? deps.getDataDir() : resolveAiMemoryDataDir()
      userDataDir = deps.getUserDataDir ? deps.getUserDataDir() : resolveAiMemoryUserDataDir()
    } catch {
      // userData indisponível: degrada e inicia direto, sem criar outra fonte.
      return directPlan(context, 'preparation-failed')
    }
    const ensureMode = deps.ensureAllowlistMode ?? ensureAllowlistCaptureMode
    if (!(await ensureMode(dataDir))) return directPlan(context, 'preparation-failed')

    const setup = deps.setupGemini ?? setupGeminiAgentIntegrations
    const result = await setup(
      // Sem `env`: CODEX_HOME/tokens do harness nunca chegam ao instalador.
      { optedIn: true, binaryPath, identity: scope.identity, dataDir, cwd: context.cwd },
      { userDataDir }
    )

    if (result.status === 'installed' || result.status === 'already-installed') {
      // Sucesso: execução direta, SEM degradedReason (hooks+MCP configurados).
      return directPlan(context)
    }
    if (result.status === 'skipped-opt-out') return directPlan(context, 'opt-out')
    return directPlan(context, 'preparation-failed')
  } catch {
    return directPlan(context, 'preparation-failed')
  }
}

/**
 * Prepara o plano de lançamento para um terminal de agente.
 *
 * Contrato de segurança v2.4.0:
 * - Se opt-in ativo, marker configurado, serviço running e harness suportado:
 *   embrulha com:
 *   `ai-memory --data-dir <dataDir> run --workspace <ws> --project <proj> --new <id> --executable <exe> <harness> -- <args>`
 * - Se qualquer condição falhar antes do spawn: fallback transparente para a execução direta.
 * - Preserva `cwd`, `env`, `argv`, `model` e `CODEX_HOME` da conta.
 */
export async function prepareAiMemoryLaunch(
  context: AiMemoryLaunchContext,
  deps: AiMemoryLauncherDeps = {}
): Promise<AiMemoryLaunchPlan> {
  exitedBeforeRegistration.delete(context.terminalId)
  // Gemini CLI usa hooks + MCP (não `ai-memory run`): caminho dedicado.
  if (context.provider.toLowerCase().trim() === 'gemini') {
    return await prepareGeminiDirectLaunch(context, deps)
  }

  const harness = resolveAiMemoryHarness(context.provider)
  if (!harness) {
    return fallbackPlan(context, 'harness-not-supported')
  }

  const service = deps.getService ? deps.getService() : getGlobalAiMemoryService()
  if (!service) {
    return fallbackPlan(context, 'service-unavailable')
  }

  try {
    const status = service.status()
    if (status.state !== 'running') {
      return fallbackPlan(context, 'service-unavailable')
    }

    // Preflight ativo de transporte / conectividade:
    // O status() síncrono pode permanecer 'running' mesmo após queda de transporte;
    // service.health() valida o transporte HTTP real. Se ok=false,
    // fallback transparente para execução direta sem quebrar o PTY.
    if (typeof service.health === 'function') {
      try {
        const health = await service.health()
        if (!health.ok) {
          console.warn(
            `[DevOrbit ai-memory-launcher] Service health check falhou para ${context.provider} (${health.message ?? 'unhealthy'}); fallback direto.`
          )
          return fallbackPlan(context, 'service-unavailable')
        }
      } catch (err) {
        console.warn(`[DevOrbit ai-memory-launcher] Exceção na verificação de health para ${context.provider}:`, err)
        return fallbackPlan(context, 'service-unavailable')
      }
    }

    const binaryPath = status.binaryPath
    if (!binaryPath) {
      return fallbackPlan(context, 'binary-missing')
    }

    const scope = await service.resolveScope(context.cwd)
    if (!service.isProjectEnabled(scope.identity)) {
      return fallbackPlan(context, 'opt-out')
    }

    const marker = await service.ensureProjectMarker(context.cwd)
    if (!marker.configured) {
      return fallbackPlan(context, 'marker-unconfigured')
    }

    let dataDir: string
    try {
      dataDir = deps.getDataDir ? deps.getDataDir() : resolveAiMemoryDataDir()
    } catch {
      // userData indisponível: degrada e inicia direto, sem criar outra fonte.
      return fallbackPlan(context, 'preparation-failed')
    }

    // Validação mandatória de privacidade:
    // Garante que o capture-mode sob dataDir é 'allowlist' antes de qualquer spawn.
    // O autowire upstream de ai-memory run sem allowlist explícito cai em 'denylist'
    // e captura qualquer repositório sem marker, violando o opt-in de privacidade.
    const ensureMode = deps.ensureAllowlistMode ?? ensureAllowlistCaptureMode
    const allowlistReady = await ensureMode(dataDir)
    if (!allowlistReady) {
      console.warn(
        `[DevOrbit ai-memory-launcher] Abortando embrulho ai-memory run para ${context.provider}: ` +
        'capture-mode allowlist não pôde ser garantido sob dataDir.'
      )
      return fallbackPlan(context, 'preparation-failed')
    }

    // Setup NATIVO complementar (v2.4.0): `ai-memory run` é opt-in de
    // continuidade/resume e NÃO substitui a integração (MCP + hooks onde a
    // matriz diz hooks; OpenCode/OpenCode2 = remote MCP + plugin). Roda APÓS o
    // opt-in (isProjectEnabled acima) e com capture-mode allowlist garantido;
    // é idempotente por receipt (provider/identidade/conta-Codex). Falha →
    // fallback direto degradado (fail-open), sem receipt de sucesso e sem
    // bloquear o workspace.
    const setupAgent = deps.setupAgent ?? aiMemorySetupOverride ?? setupAgentIntegrations
    const rawCodexHome = context.env ? context.env.CODEX_HOME : undefined
    const codexHome =
      context.provider.toLowerCase().trim() === 'codex' &&
      typeof rawCodexHome === 'string' &&
      rawCodexHome.trim().length > 0
        ? rawCodexHome
        : undefined
    try {
      const setupResult = await setupAgent(
        {
          optedIn: true,
          provider: context.provider,
          binaryPath,
          identity: scope.identity,
          dataDir,
          cwd: context.cwd,
          ...(codexHome ? { codexHome } : {}),
        },
        { userDataDir: deps.getUserDataDir ? deps.getUserDataDir() : resolveAiMemoryUserDataDir() }
      )
      if (setupResult.status === 'degraded' || setupResult.status === 'unsupported') {
        return fallbackPlan(context, 'setup-failed')
      }
    } catch {
      // Setup nunca derruba a sessão: fail-open direto, sem receipt de sucesso.
      return fallbackPlan(context, 'setup-failed')
    }

    // Reserva atômica de escopo (v2.4.0):
    // Quando nenhuma sessão embrulhada estiver ativa ou sendo preparada para o mesmo (workspace, project),
    // omite --new e utiliza o workstream default (garantindo continuidade sequencial cross-harness).
    // Quando já houver outra sessão ativa ou preparando no mesmo escopo, gera um workstream único (--new)
    // para isolar os writers e prevenir conflito de lease.
    const isBusy = isScopeActiveOrPreparing(scope.workspace, scope.project, context.terminalId)
    const isDefault = !isBusy
    const workstream = isDefault
      ? 'default'
      : (deps.generateWorkstreamId
          ? deps.generateWorkstreamId(context.provider, context.terminalId)
          : generateWorkstreamId(context.provider, context.terminalId))

    pendingScopeReservations.set(context.terminalId, {
      terminalId: context.terminalId,
      scopeKey: `${scope.workspace}::${scope.project}`,
      workspace: scope.workspace,
      project: scope.project,
      isDefault,
      workstream,
      reservedAt: Date.now(),
    })

    const originalArgs = context.originalArgs ? [...context.originalArgs] : []
    const args: string[] = [
      '--data-dir',
      dataDir,
      'run',
      '--workspace',
      scope.workspace,
      '--project',
      scope.project,
    ]

    if (!isDefault) {
      args.push('--new', workstream)
    }

    // Prefere binário .exe compilado quando disponível; caso contrário, passa o .cmd/.bat direto
    // (a CLI upstream do ai-memory suporta scripts .cmd/.bat nativamente em --executable).
    const rustExecutable = resolveExecutableForRust(context.resolvedCommand)

    args.push(
      '--executable',
      rustExecutable,
      harness,
      '--',
      ...originalArgs,
    )

    const metadata: AiMemorySessionMetadata = {
      terminalId: context.terminalId,
      provider: context.provider,
      harness,
      workstream,
      isDefaultWorkstream: isDefault,
      workspace: scope.workspace,
      project: scope.project,
      dataDir,
      binaryPath,
      sessionId: context.sessionId,
      startedAt: Date.now(),
    }

    return {
      wrapped: true,
      command: binaryPath,
      args,
      env: context.env,
      cwd: context.cwd,
      harness,
      workstream,
      isDefaultWorkstream: isDefault,
      metadata,
    }
  } catch (error) {
    pendingScopeReservations.delete(context.terminalId)
    console.warn(
      `[DevOrbit ai-memory-launcher] Falha ao preparar lançamento gerenciado para ${context.provider}:`,
      error
    )
    return fallbackPlan(context, 'preparation-failed')
  }
}

// ---------------------------------------------------------------------------
// Finalização Deduplicada de Sessões (Lifecycle) & Reservas de Escopo
// ---------------------------------------------------------------------------

const activeSessions = new Map<string, AiMemorySessionMetadata>()
const pendingScopeReservations = new Map<string, ScopeReservation>()
const successfulFinalizations = new Set<string>()
const inFlightFinalizations = new Map<string, Promise<{ finalized: boolean; message?: string }>>()
const terminalGenerations = new Map<string, number>()
const lastFinalizedSessionKeyByTerminal = new Map<string, string>()
const overlappingAntigravitySessions = new Set<string>()
const overlappingCommandCodeSessions = new Set<string>()
const exitedBeforeRegistration = new Set<string>()

export function isScopeActiveOrPreparing(
  workspace: string,
  project: string,
  excludingTerminalId?: string
): boolean {
  for (const [id, session] of activeSessions.entries()) {
    if (excludingTerminalId && id === excludingTerminalId) continue
    if (session.workspace === workspace && session.project === project) {
      return true
    }
  }
  for (const [id, res] of pendingScopeReservations.entries()) {
    if (excludingTerminalId && id === excludingTerminalId) continue
    if (res.workspace === workspace && res.project === project) {
      return true
    }
  }
  return false
}

/**
 * Realiza o rollback explícito e remoção de uma sessão/lançamento ai-memory
 * em caso de falha de spawn ou encerramento imediato do PTY antes do registro ativo.
 *
 * Garante que nenhuma reserva pendente ou sessão ativa zumbi permaneça bloqueando
 * o escopo (workspace::project), liberando o workstream default para os próximos lançamentos.
 */
export function rollbackAiMemoryLaunch(terminalId: string): void {
  pendingScopeReservations.delete(terminalId)
  activeSessions.delete(terminalId)
  overlappingAntigravitySessions.delete(terminalId)
  overlappingCommandCodeSessions.delete(terminalId)
  exitedBeforeRegistration.add(terminalId)
  inFlightFinalizations.delete(terminalId)
}

export const rollbackAiMemorySession = rollbackAiMemoryLaunch

export function releaseAiMemoryReservation(terminalId: string): void {
  rollbackAiMemoryLaunch(terminalId)
}

export function getPendingScopeReservation(terminalId: string): ScopeReservation | undefined {
  return pendingScopeReservations.get(terminalId)
}

export function registerActiveAiMemorySession(metadata: AiMemorySessionMetadata): boolean {
  // Transfere a reserva de escopo pendente para a sessão ativa
  pendingScopeReservations.delete(metadata.terminalId)

  // Proteção contra corrida de encerramento imediato:
  // Se o PTY já saiu (onExit) ou sofreu rollback/finalização antes do registro,
  // aborta o registro tardio para não deixar uma sessão zumbi bloqueando o workstream default.
  if (exitedBeforeRegistration.has(metadata.terminalId)) {
    exitedBeforeRegistration.delete(metadata.terminalId)
    activeSessions.delete(metadata.terminalId)
    console.warn(
      `[DevOrbit ai-memory-launcher] Sessão PTY ${metadata.terminalId} encerrou antes do registro ativo; descartando registro obsoleto.`
    )
    return false
  }

  const currentGen = (terminalGenerations.get(metadata.terminalId) ?? 0) + 1
  terminalGenerations.set(metadata.terminalId, currentGen)
  metadata.generation = currentGen
  // Ao registrar uma nova sessão em um terminal reutilizado, limpa a referência da sessão
  // anterior finalizada para este terminalId, evitando que a nova sessão seja considerada já finalizada.
  lastFinalizedSessionKeyByTerminal.delete(metadata.terminalId)
  overlappingAntigravitySessions.delete(metadata.terminalId)
  overlappingCommandCodeSessions.delete(metadata.terminalId)

  // Rastreia sobreposição (overlap) de sessões Antigravity e Command Code no mesmo escopo (workspace + project)
  // sem sessionId exato. Isso protege o encerramento sequencial de usar 'latest'.
  const explicitAgent = resolveExplicitFinalizeAgent(undefined, metadata.harness, metadata.provider)
  if (explicitAgent) {
    const targetSet = explicitAgent === 'antigravity-cli' ? overlappingAntigravitySessions : overlappingCommandCodeSessions
    for (const [id, active] of activeSessions.entries()) {
      if (id === metadata.terminalId) continue
      const activeAgent = resolveExplicitFinalizeAgent(undefined, active.harness, active.provider)
      if (activeAgent === explicitAgent) {
        const sameWorkspace = !metadata.workspace || !active.workspace || metadata.workspace === active.workspace
        const sameProject = !metadata.project || !active.project || metadata.project === active.project
        if (sameWorkspace && sameProject) {
          targetSet.add(id)
          targetSet.add(metadata.terminalId)
        }
      }
    }
  }

  activeSessions.set(metadata.terminalId, metadata)
  return true
}

export function unregisterActiveAiMemorySession(
  terminalId: string
): AiMemorySessionMetadata | undefined {
  pendingScopeReservations.delete(terminalId)
  const metadata = activeSessions.get(terminalId)
  activeSessions.delete(terminalId)
  overlappingAntigravitySessions.delete(terminalId)
  overlappingCommandCodeSessions.delete(terminalId)
  exitedBeforeRegistration.add(terminalId)
  return metadata
}

export const removeActiveAiMemorySession = unregisterActiveAiMemorySession

export function getActiveAiMemorySession(terminalId: string): AiMemorySessionMetadata | undefined {
  return activeSessions.get(terminalId)
}

export function clearActiveAiMemorySessions(): void {
  activeSessions.clear()
  pendingScopeReservations.clear()
  successfulFinalizations.clear()
  inFlightFinalizations.clear()
  terminalGenerations.clear()
  lastFinalizedSessionKeyByTerminal.clear()
  overlappingAntigravitySessions.clear()
  overlappingCommandCodeSessions.clear()
  exitedBeforeRegistration.clear()
}

export interface FinalizeSessionArgs {
  terminalId: string
  agent?: string
  sessionId?: string
  workspace?: string
  project?: string
  dataDir?: string
  binaryPath?: string
  workstream?: string
  generation?: number
}

const defaultCliRunner = async (
  binaryPath: string,
  args: readonly string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv; allowCodexHome?: boolean } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, [...args], {
      windowsHide: true,
      timeout: options.timeout ?? 10_000,
      // Finalize/install são helpers: env mínimo. `CODEX_HOME` (caminho do
      // perfil) só entra quando o chamador marca explicitamente; tokens nunca.
      env: buildAiMemoryHelperEnv({
        overlay: options.env,
        ...(options.allowCodexHome === true ? { allowCodexHome: true } : {}),
      }),
    })
    return { code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') }
  } catch (error: any) {
    return {
      code: typeof error?.code === 'number' ? error.code : 1,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || error?.message || ''),
    }
  }
}

/**
 * Instala explicitamente os hooks do agente com `--capture-mode allowlist`.
 * Sintaxe oficial v2.4.0 (verificada em cli.rs e install_hooks.rs):
 * `ai-memory --data-dir <dataDir> install-hooks --apply --capture-mode allowlist --agent <agentChoice>`
 *
 * Env mínimo do helper: para o Codex, apenas o CAMINHO de `CODEX_HOME` é
 * repassado (hooks gravados em `$CODEX_HOME/hooks.json`, isolando a conta);
 * nenhum token/credencial do harness é copiado.
 */
export async function installHarnessAllowlistHooks(
  params: {
    binaryPath: string
    dataDir: string
    agent: string
    env?: NodeJS.ProcessEnv
  },
  deps: {
    execCli?: (
      binaryPath: string,
      args: readonly string[],
      options?: { timeout?: number; env?: NodeJS.ProcessEnv; allowCodexHome?: boolean }
    ) => Promise<{ code: number | null; stdout: string; stderr: string }>
  } = {}
): Promise<{ success: boolean; message?: string }> {
  const agentChoice = resolveAiMemoryAgentChoice(params.agent)
  if (!agentChoice) {
    return {
      success: false,
      message: `Harness '${params.agent}' não suporta instalação de hooks gerenciados.`,
    }
  }

  const exec = deps.execCli ?? defaultCliRunner
  const args = [
    '--data-dir',
    params.dataDir,
    'install-hooks',
    '--apply',
    '--capture-mode',
    'allowlist',
    '--agent',
    agentChoice,
  ]

  try {
    const res = await exec(params.binaryPath, args, {
      env: params.env,
      timeout: 15_000,
      // Só o Codex precisa do CAMINHO do perfil para gravar hooks; tokens nunca.
      ...(agentChoice === 'codex' ? { allowCodexHome: true } : {}),
    })
    return {
      success: res.code === 0,
      message:
        res.code === 0
          ? `Hooks instalados com capture-mode allowlist para ${agentChoice}.`
          : (res.stderr || res.stdout || 'Falha ao instalar hooks.'),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, message: `Erro ao executar install-hooks: ${msg}` }
  }
}

/**
 * Finaliza uma sessão do ai-memory de forma deduplicada.
 *
 * Requisitos:
 * - Para o Antigravity, executa `finalize-session` com `--agent antigravity-cli`.
 * - NUNCA passa `--all`: encerra apenas a sessão exata ou a última sessão daquele agente/operador.
 * - Deduplicado: chamadas subsequentes para o mesmo `terminalId` após sucesso são no-ops.
 * - Em voo (in-flight): chamadas concorrentes compartilham a mesma Promise, evitando múltiplos spawns de CLI.
 * - Resiliente a falhas: se o CLI falhar ou for invocado sem sessão ativa, NÃO marca falha permanente, permitindo retry.
 */
export function isAntigravityAgent(agent?: string, harness?: string, provider?: string): boolean {
  const candidates = [agent, harness, provider].filter(Boolean) as string[]
  return candidates.some((c) => {
    const norm = c.toLowerCase()
    return norm === 'antigravity' || norm === 'antigravity-cli' || norm === 'agy'
  })
}

export function isCommandCodeAgent(agent?: string, harness?: string, provider?: string): boolean {
  const candidates = [agent, harness, provider].filter(Boolean) as string[]
  return candidates.some((c) => {
    const norm = c.toLowerCase()
    return norm === 'command-code' || norm === 'cmdc'
  })
}

export function resolveExplicitFinalizeAgent(
  agent?: string,
  harness?: string,
  provider?: string
): 'antigravity-cli' | 'command-code' | null {
  if (isAntigravityAgent(agent, harness, provider)) {
    return 'antigravity-cli'
  }
  if (isCommandCodeAgent(agent, harness, provider)) {
    return 'command-code'
  }
  return null
}

export function hasParallelExplicitSessions(
  targetAgent: 'antigravity-cli' | 'command-code',
  currentTerminalId: string,
  project?: string,
  workspace?: string
): boolean {
  for (const [id, session] of activeSessions.entries()) {
    if (id === currentTerminalId) continue
    const explicitAgent = resolveExplicitFinalizeAgent(undefined, session.harness, session.provider)
    if (explicitAgent === targetAgent) {
      if (workspace && session.workspace && session.workspace !== workspace) {
        continue
      }
      if (project && session.project && session.project !== project) {
        continue
      }
      return true
    }
  }
  return false
}

export function hasParallelAntigravitySessions(
  currentTerminalId: string,
  project?: string,
  workspace?: string
): boolean {
  return hasParallelExplicitSessions('antigravity-cli', currentTerminalId, project, workspace)
}

export function hasParallelCommandCodeSessions(
  currentTerminalId: string,
  project?: string,
  workspace?: string
): boolean {
  return hasParallelExplicitSessions('command-code', currentTerminalId, project, workspace)
}

export async function finalizeAiMemorySession(
  input: FinalizeSessionArgs,
  deps: {
    execCli?: (
      binaryPath: string,
      args: readonly string[],
      options?: { timeout?: number; env?: NodeJS.ProcessEnv }
    ) => Promise<{ code: number | null; stdout: string; stderr: string }>
  } = {}
): Promise<{ finalized: boolean; message?: string }> {
  const terminalId = input.terminalId
  const registered = activeSessions.get(terminalId)

  // Determina a identidade estável e geração da sessão
  let sessionKey: string
  if (registered) {
    // Proteção contra callbacks tardios de sessões/gerações anteriores
    if (
      (input.generation !== undefined && input.generation !== registered.generation) ||
      (input.workstream !== undefined && input.workstream !== registered.workstream)
    ) {
      const staleKey = `${terminalId}::g${input.generation ?? 0}::${input.workstream ?? 'legacy'}`
      if (successfulFinalizations.has(staleKey)) {
        return { finalized: false, message: 'Sessão já finalizada anteriormente.' }
      }
      return { finalized: false, message: 'Callback tardio para sessão anterior ignorado.' }
    }
    sessionKey = `${terminalId}::g${registered.generation ?? 1}::${registered.workstream}`
  } else {
    if (input.generation !== undefined || input.workstream !== undefined) {
      sessionKey = `${terminalId}::g${input.generation ?? 0}::${input.workstream ?? 'direct'}`
    } else {
      sessionKey =
        lastFinalizedSessionKeyByTerminal.get(terminalId) ??
        `${terminalId}::direct::${input.sessionId ?? input.agent ?? 'unknown'}`
    }
  }

  if (successfulFinalizations.has(sessionKey)) {
    return { finalized: false, message: 'Sessão já finalizada anteriormente.' }
  }

  const existingFlight = inFlightFinalizations.get(sessionKey)
  if (existingFlight) {
    return existingFlight
  }

  const finalizationPromise = (async (): Promise<{ finalized: boolean; message?: string }> => {
    const hadPendingReservation = pendingScopeReservations.has(terminalId)
    pendingScopeReservations.delete(terminalId)
    if (!registered && !input.agent && !input.binaryPath) {
      if (hadPendingReservation) {
        exitedBeforeRegistration.add(terminalId)
      }
      return { finalized: false, message: 'Nenhuma sessão ativa ou binário ai-memory disponível para finalização.' }
    }

    const explicitAgent = resolveExplicitFinalizeAgent(input.agent, registered?.harness, registered?.provider)
    if (!explicitAgent) {
      // Para outros harnesses (ex: opencode, codex, claude), o encerramento é gerenciado
      // pelos próprios hooks ou pelo processo ai-memory run. O CLI finalize-session não deve ser
      // invocado para evitar selecionar 'latest' e encerrar sessões concorrentes de irmãos em squads.
      activeSessions.delete(terminalId)
      successfulFinalizations.add(sessionKey)
      lastFinalizedSessionKeyByTerminal.set(terminalId, sessionKey)
      return {
        finalized: false,
        message: 'Encerramento de sessão gerenciado pelo harness/hooks; finalize CLI dispensado.',
      }
    }

    const binaryPath = input.binaryPath ?? registered?.binaryPath
    if (!binaryPath) {
      return { finalized: false, message: 'Nenhuma sessão ativa ou binário ai-memory disponível para finalização.' }
    }

    let dataDir = input.dataDir ?? registered?.dataDir
    if (!dataDir) {
      try {
        dataDir = resolveAiMemoryDataDir()
      } catch {
        // Sem userData resolvível: finaliza sem criar outra fonte.
        return {
          finalized: false,
          message: 'dataDir do ai-memory indisponível (userData não resolvido); finalização dispensada.',
        }
      }
    }
    const workspace = input.workspace ?? registered?.workspace
    const project = input.project ?? registered?.project
    const sessionId = input.sessionId ?? registered?.sessionId

    // Em squads com sessões concorrentes em paralelo ou que tiveram sobreposição (overlap)
    // temporal no mesmo escopo sem ID exato, NUNCA selecione 'latest' via CLI.
    // Isso protege tanto a primeira sessão que termina quanto a segunda (que pareceria única se olhasse só activeSessions).
    const targetOverlapSet =
      explicitAgent === 'antigravity-cli' ? overlappingAntigravitySessions : overlappingCommandCodeSessions
    const hadOverlap =
      !sessionId &&
      (targetOverlapSet.has(terminalId) ||
        hasParallelExplicitSessions(explicitAgent, terminalId, project, workspace))

    if (hadOverlap) {
      activeSessions.delete(terminalId)
      targetOverlapSet.delete(terminalId)
      successfulFinalizations.add(sessionKey)
      lastFinalizedSessionKeyByTerminal.set(terminalId, sessionKey)
      return {
        finalized: false,
        message:
          `Finalização CLI ignorada: sessão ${explicitAgent} teve sobreposição (overlap) sem sessionId exato; seleção de latest evitada.`,
      }
    }

    const args: string[] = ['--data-dir', dataDir, 'finalize-session', '--agent', explicitAgent]

    if (sessionId) {
      args.push('--session-id', sessionId)
    }
    if (workspace) {
      args.push('--workspace', workspace)
    }
    if (project) {
      args.push('--project', project)
    }

    const runner = deps.execCli ?? defaultCliRunner
    try {
      const result = await runner(binaryPath, args, { timeout: 8_000 })
      if (result.code === 0) {
        activeSessions.delete(terminalId)
        targetOverlapSet.delete(terminalId)
        successfulFinalizations.add(sessionKey)
        lastFinalizedSessionKeyByTerminal.set(terminalId, sessionKey)
        return {
          finalized: true,
          message: result.stdout || `Sessão ${explicitAgent} finalizada com sucesso.`,
        }
      }
      return {
        finalized: false,
        message: result.stderr.slice(0, 200) || `Falha ao finalizar sessão ${explicitAgent} (código ${result.code}).`,
      }
    } catch (error) {
      return {
        finalized: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })()

  inFlightFinalizations.set(sessionKey, finalizationPromise)
  try {
    return await finalizationPromise
  } finally {
    inFlightFinalizations.delete(sessionKey)
  }
}

/**
 * Aguarda a conclusão de todas as finalizações de sessão ai-memory em voo.
 *
 * Requisitos:
 * - Bounded: timeout explícito (default 5.000ms), nunca trava o encerramento do app.
 * - Resiliente: utiliza Promise.allSettled, capturando falhas/rejeições sem estourar unhandled error.
 * - Não bloqueante se não houver pendências: retorna imediatamente.
 */
export async function drainPendingAiMemoryFinalizations(options: {
  timeoutMs?: number
} = {}): Promise<{ drained: boolean; pendingCount: number }> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const pending = Array.from(inFlightFinalizations.values())

  if (pending.length === 0) {
    return { drained: true, pendingCount: 0 }
  }

  let timer: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<{ timeout: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timeout: true }), timeoutMs)
  })

  try {
    const outcome = await Promise.race([
      Promise.allSettled(pending).then(() => ({ timeout: false as const })),
      timeoutPromise,
    ])

    if (outcome.timeout) {
      console.warn(
        `[DevOrbit ai-memory-launcher] Timeout (${timeoutMs}ms) ao aguardar ${inFlightFinalizations.size} finalizações pendentes.`
      )
      return { drained: false, pendingCount: inFlightFinalizations.size }
    }

    return { drained: true, pendingCount: 0 }
  } catch (error) {
    console.warn('[DevOrbit ai-memory-launcher] Erro inesperado ao aguardar finalizações:', error)
    return { drained: false, pendingCount: inFlightFinalizations.size }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
