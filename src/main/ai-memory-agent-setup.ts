/**
 * Configuração das integrações do Gemini CLI no ai-memory (helper ISOLADO).
 *
 * Comandos da release pinada v2.4.0 (verificados em
 * `crates/ai-memory-cli/src/cli.rs`: `InstallMcpArgs.client = McpClient::GeminiCli`
 * e `InstallHooksArgs.agent = AgentChoice::GeminiCli`):
 *   ai-memory [--data-dir <dir>] install-mcp   --client gemini-cli --apply
 *   ai-memory [--data-dir <dir>] install-hooks --agent  gemini-cli --apply
 *
 * Contrato:
 * - Só executa quando o caller declara OPT-IN explícito (`request.optedIn`).
 *   Caso contrário retorna `skipped-opt-out` SEM ler disco e SEM subprocesso.
 * - Idempotência: receipt por identidade em
 *   `<userDataDir>/ai-memory/agent-setup/gemini-cli-<hash>.json`. Com receipt
 *   válida retorna `already-installed` sem subprocesso (a menos que `force`).
 *   O upstream `--apply` também é idempotente (substitui só a entrada
 *   ai-memory, preserva o restante e grava backup com timestamp).
 * - NUNCA editamos a configuração do usuário manualmente: delegamos ao
 *   `--apply` do upstream.
 * - Falha nunca lança e nunca impede o agente de iniciar (`degraded`).
 * - Não registra env nem tokens: só o detalhe de erro é redigido/limitado.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { redactSecretText } from '../shared/evolution-history'
import { buildAiMemoryHelperEnv } from './ai-memory-process-env'

const execFileAsync = promisify(execFile)

export const AI_MEMORY_AGENT_SETUP_CLIENT = 'gemini-cli'
export const AI_MEMORY_AGENT_SETUP_AGENT = 'gemini-cli'
export const AI_MEMORY_AGENT_SETUP_RECEIPT_VERSION = 1
export const AI_MEMORY_AGENT_SETUP_TIMEOUT_MS = 20_000
export const AI_MEMORY_AGENT_SETUP_DETAIL_MAX_CHARS = 300

export type AiMemoryAgentSetupStatus =
  | 'installed'
  | 'already-installed'
  | 'skipped-opt-out'
  | 'unsupported'
  | 'degraded'

/** Ação tomada nesta chamada para cada integração. */
export type AiMemoryAgentSetupStep = 'installed' | 'skipped' | 'failed'

export interface AiMemoryAgentSetupRequest {
  /** true SOMENTE após opt-in explícito do projeto; false → zero subprocessos. */
  optedIn: boolean
  /** Caminho do binário ai-memory (vindo do serviço). */
  binaryPath: string
  /** Identidade ESTÁVEL do projeto (ex.: `AiMemoryScope.identity`) — chave da receipt. */
  identity: string
  /**
   * Provider do agente (chave do mapa `AI_MEMORY_SETUP_FAMILIES`); default
   * 'gemini' (compat com o fluxo dedicado existente).
   */
  provider?: string
  /** Diretório de dados do ai-memory; quando presente vira `--data-dir` global. */
  dataDir?: string
  /** cwd dos subprocessos (default: `process.cwd()`). */
  cwd?: string
  /** Ignora a receipt e reexecuta (upstream `--apply` é idempotente). */
  force?: boolean
  /**
   * SOMENTE Codex: caminho do CODEX_HOME da conta escolhida — repassado como
   * env do subprocesso (isolamento de conta); é um CAMINHO, nunca token, e
   * nada é copiado de/para o perfil.
   */
  codexHome?: string
}

export interface AiMemoryAgentSetupResult {
  status: AiMemoryAgentSetupStatus
  mcp: AiMemoryAgentSetupStep
  hooks: AiMemoryAgentSetupStep
  message?: string
}

/**
 * Integração oficial v2.4.0 por provider (docs/support-matrix.md + cli.rs):
 * `client` = valor de `install-mcp --client`; `agent` = valor de
 * `install-hooks --agent` — `null` quando a integração é MCP-only
 * (família OpenCode: remote MCP + plugin; hooks NÃO são forçados).
 */
export interface AiMemorySetupFamily {
  client: string
  agent: string | null
}

/**
 * Mapa provider → integração (valores kebab-case/aliases CONFIRMADOS no
 * cli.rs v2.4.0 — tests `*_mcp_and_hook_aliases_parse`): codex → `codex`;
 * claude → `claude-code`; command-code → `command-code` (commandcode/cmdc/cmd);
 * antigravity → `antigravity-cli` (antigravity/agy); gemini → `gemini-cli`;
 * opencode → `opencode` e opencode2 → `opencode2` (MCP-only). Aider/custom
 * não são comprovados upstream → fora do mapa (setup `unsupported`).
 */
export const AI_MEMORY_SETUP_FAMILIES: Readonly<Record<string, AiMemorySetupFamily>> = {
  gemini: { client: 'gemini-cli', agent: 'gemini-cli' },
  codex: { client: 'codex', agent: 'codex' },
  claude: { client: 'claude-code', agent: 'claude-code' },
  'claude-code': { client: 'claude-code', agent: 'claude-code' },
  agy: { client: 'antigravity-cli', agent: 'antigravity-cli' },
  antigravity: { client: 'antigravity-cli', agent: 'antigravity-cli' },
  'antigravity-cli': { client: 'antigravity-cli', agent: 'antigravity-cli' },
  'command-code': { client: 'command-code', agent: 'command-code' },
  cmdc: { client: 'command-code', agent: 'command-code' },
  opencode: { client: 'opencode', agent: null },
  opencode2: { client: 'opencode2', agent: null },
}

export function resolveAiMemorySetupFamily(provider: string): AiMemorySetupFamily | null {
  return AI_MEMORY_SETUP_FAMILIES[provider.toLowerCase().trim()] ?? null
}

export type AiMemoryAgentSetupRunner = (
  binaryPath: string,
  args: readonly string[],
  options?: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv }
) => Promise<{ code: number | null; stdout: string; stderr: string }>

export interface AiMemoryAgentSetupFileSystem {
  readFile(filePath: string): Promise<string>
  writeFile(filePath: string, data: string): Promise<void>
  mkdir(dirPath: string, options: { recursive: boolean }): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(filePath: string, options?: { force?: boolean }): Promise<void>
}

export interface AiMemoryAgentSetupDeps {
  /** Root de userData (ex.: `app.getPath('userData')`); receipt vive sob ele. */
  userDataDir: string
  /** Runner CLI injetável (testes); default usa `execFile` sem shell. */
  runCli?: AiMemoryAgentSetupRunner
  /** FS injetável (testes); default usa `node:fs/promises`. */
  fileSystem?: AiMemoryAgentSetupFileSystem
  now?: () => number
}

interface SetupReceipt {
  version: number
  identityHash: string
  provider?: string
  client: string
  agent: string | null
  account?: string
  installedAt: string
}

/** Args exatos de `install-mcp --client <client> --apply` por provider. */
export function buildInstallMcpArgs(provider: string, dataDir?: string): string[] {
  const family = resolveAiMemorySetupFamily(provider)
  const client = family ? family.client : AI_MEMORY_AGENT_SETUP_CLIENT
  return [
    ...(dataDir ? ['--data-dir', dataDir] : []),
    'install-mcp',
    '--client',
    client,
    '--apply',
  ]
}

/**
 * Args exatos de `install-hooks --agent <agent> --apply --capture-mode
 * allowlist` por provider. A flag é aceita pelo CLI v2.4.0 (CaptureModeArg em
 * `install-hooks`, persistida no data dir) e fixa a política em allowlist.
 * Família MCP-only (OpenCode) NÃO tem comando de hooks → `null` = nada a
 * instalar (a matriz official usa remote MCP + plugin).
 */
export function buildInstallHooksArgs(provider: string, dataDir?: string): string[] | null {
  const family = resolveAiMemorySetupFamily(provider)
  if (!family || family.agent === null) return null
  return [
    ...(dataDir ? ['--data-dir', dataDir] : []),
    'install-hooks',
    '--agent',
    family.agent,
    '--apply',
    '--capture-mode',
    'allowlist',
  ]
}

/** Args exatos de `install-mcp --client gemini-cli --apply`. */
export function buildGeminiInstallMcpArgs(dataDir?: string): string[] {
  return buildInstallMcpArgs('gemini', dataDir)
}

/** Args exatos de `install-hooks --agent gemini-cli --apply --capture-mode allowlist`. */
export function buildGeminiInstallHooksArgs(dataDir?: string): string[] {
  return buildInstallHooksArgs('gemini', dataDir) ?? []
}

/** Caminho da receipt por identidade (hash — nunca a identidade crua). */
export function geminiAgentSetupReceiptPath(userDataDir: string, identity: string): string {
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 32)
  return path.join(
    userDataDir,
    'ai-memory',
    'agent-setup',
    `${AI_MEMORY_AGENT_SETUP_CLIENT}-${hash}.json`
  )
}

/**
 * Caminho da receipt GENÉRICA por provider: `<client>-<hash>.json`. O hash
 * cobre a identidade do escopo e — SOMENTE para o Codex — também o CODEX_HOME
 * da conta (duas contas distintas têm receipts distintas; isolamento testado).
 * Identidade crua nunca é gravada: só o hash.
 */
export function agentSetupReceiptPath(
  userDataDir: string,
  request: Pick<AiMemoryAgentSetupRequest, 'provider' | 'identity' | 'codexHome'> & { client: string }
): string {
  const provider = (request.provider ?? 'gemini').toLowerCase().trim()
  const key =
    provider === 'codex' && request.codexHome
      ? `${request.identity}::${request.codexHome}`
      : request.identity
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 32)
  return path.join(userDataDir, 'ai-memory', 'agent-setup', `${request.client}-${hash}.json`)
}

const nodeFileSystem: AiMemoryAgentSetupFileSystem = {
  readFile: (filePath) => fs.readFile(filePath, 'utf8'),
  writeFile: (filePath, data) => fs.writeFile(filePath, data, 'utf8'),
  mkdir: async (dirPath, options) => {
    await fs.mkdir(dirPath, options)
  },
  rename: (from, to) => fs.rename(from, to),
  rm: async (filePath, options) => {
    await fs.rm(filePath, options)
  },
}

const defaultRunner: AiMemoryAgentSetupRunner = async (binaryPath, args, options = {}) => {
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, [...args], {
      cwd: options.cwd,
      // Setup (install-mcp/install-hooks) é helper: env mínimo, sem BYOK/tokens.
      // Para o Codex, o overlay repassa SOMENTE o CAMINHO do CODEX_HOME da conta
      // (allowCodexHome) — nunca tokens (allowlist/SECRETISH_KEY continuam valendo).
      env:
        options.env && Object.keys(options.env).length > 0
          ? buildAiMemoryHelperEnv({ overlay: options.env, allowCodexHome: true })
          : buildAiMemoryHelperEnv(),
      timeout: options.timeout ?? AI_MEMORY_AGENT_SETUP_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
    })
    return { code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
    return {
      code: typeof err.code === 'number' ? (err.code as unknown as number) : 1,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || err.message || ''),
    }
  }
}

function sanitizeDetail(value: string): string {
  return redactSecretText(String(value || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, AI_MEMORY_AGENT_SETUP_DETAIL_MAX_CHARS)
}

async function readReceipt(
  fileSystem: AiMemoryAgentSetupFileSystem,
  filePath: string,
  family: AiMemorySetupFamily
): Promise<SetupReceipt | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fileSystem.readFile(filePath))
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed as SetupReceipt).version !== AI_MEMORY_AGENT_SETUP_RECEIPT_VERSION ||
      typeof (parsed as SetupReceipt).identityHash !== 'string' ||
      (parsed as SetupReceipt).client !== family.client ||
      (parsed as SetupReceipt).agent !== family.agent
    ) {
      return undefined
    }
    return parsed as SetupReceipt
  } catch {
    // Ausente/corrompida → trata como não instalado (reexecuta com segurança).
    return undefined
  }
}

async function writeReceipt(
  fileSystem: AiMemoryAgentSetupFileSystem,
  filePath: string,
  receipt: SetupReceipt
): Promise<void> {
  await fileSystem.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fileSystem.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`)
  try {
    await fileSystem.rename(temporary, filePath)
  } catch {
    // Windows pode recusar rename sobre arquivo existente: remove e troca.
    await fileSystem.rm(filePath, { force: true }).catch(() => undefined)
    await fileSystem.rename(temporary, filePath)
  }
}

async function runStep(
  runner: AiMemoryAgentSetupRunner,
  request: AiMemoryAgentSetupRequest,
  args: readonly string[],
  env?: NodeJS.ProcessEnv
): Promise<{ ok: boolean; detail?: string }> {
  try {
    const result = await runner(request.binaryPath, args, {
      timeout: AI_MEMORY_AGENT_SETUP_TIMEOUT_MS,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(env ? { env } : {}),
    })
    if (result.code === 0) return { ok: true }
    return { ok: false, detail: sanitizeDetail(result.stderr || result.stdout || `código ${result.code}`) }
  } catch (error) {
    return { ok: false, detail: sanitizeDetail(error instanceof Error ? error.message : String(error)) }
  }
}

/** Env do subprocesso de setup: para o Codex, SOMENTE o caminho do CODEX_HOME. */
function setupSubprocessEnv(request: AiMemoryAgentSetupRequest): NodeJS.ProcessEnv | undefined {
  const provider = (request.provider ?? 'gemini').toLowerCase().trim()
  if (provider !== 'codex' || !request.codexHome) return undefined
  return { CODEX_HOME: request.codexHome }
}

function installedMessage(provider: string, family: AiMemorySetupFamily): string {
  if (family.agent === null) {
    return `Remote MCP + plugin configurados (${family.client}); configuração existente preservada pelo upstream --apply.`
  }
  const label =
    provider === 'gemini'
      ? 'Gemini CLI'
      : provider === 'codex'
        ? 'Codex CLI'
        : provider === 'claude' || provider === 'claude-code'
          ? 'Claude Code'
          : provider === 'agy' || provider === 'antigravity' || provider === 'antigravity-cli'
            ? 'Antigravity CLI'
            : 'Command Code CLI'
  return `${label} configurado (MCP + hooks allowlist; configuração do usuário preservada pelo upstream --apply).`
}

/**
 * Setup idempotente da integração nativa por provider (v2.4.0): MCP (+ hooks
 * quando a família é MCP+hooks; família OpenCode = MCP-only). Complementar ao
 * `ai-memory run`. Nunca lança; `unsupported` para providers sem prova
 * upstream; falha → `degraded` sem receipt (fail-open do chamador).
 */
export async function setupAgentIntegrations(
  request: AiMemoryAgentSetupRequest,
  deps: AiMemoryAgentSetupDeps
): Promise<AiMemoryAgentSetupResult> {
  const provider = (request.provider ?? 'gemini').toLowerCase().trim()
  if (!request.optedIn) {
    return { status: 'skipped-opt-out', mcp: 'skipped', hooks: 'skipped' }
  }
  const family = resolveAiMemorySetupFamily(provider)
  if (!family) {
    return {
      status: 'unsupported',
      mcp: 'skipped',
      hooks: 'skipped',
      message: `Provider '${provider}' não possui integração MCP/hooks comprovada no ai-memory v2.4.0; execução direta mantida.`,
    }
  }
  if (!request.binaryPath || !request.identity) {
    return {
      status: 'degraded',
      mcp: 'failed',
      hooks: family.agent === null ? 'skipped' : 'failed',
      message: 'Binário ou identidade do ai-memory ausentes; integrações não configuradas.',
    }
  }

  const runner = deps.runCli ?? defaultRunner
  const fileSystem = deps.fileSystem ?? nodeFileSystem
  const now = deps.now ?? Date.now
  const receiptPath = agentSetupReceiptPath(deps.userDataDir, {
    provider,
    identity: request.identity,
    ...(request.codexHome ? { codexHome: request.codexHome } : {}),
    client: family.client,
  })
  const account =
    provider === 'codex' && request.codexHome
      ? path.basename(request.codexHome) || undefined
      : undefined

  if (!request.force) {
    const existing = await readReceipt(fileSystem, receiptPath, family)
    if (existing) {
      return {
        status: 'already-installed',
        mcp: 'skipped',
        hooks: 'skipped',
        message: `Integração ${family.client} já registrada (receipt).`,
      }
    }
  }

  const env = setupSubprocessEnv(request)
  const failures: string[] = []
  const mcpStep = await runStep(runner, request, buildInstallMcpArgs(provider, request.dataDir), env)
  if (!mcpStep.ok) failures.push(`install-mcp: ${mcpStep.detail ?? 'falhou'}`)

  const hooksArgs = buildInstallHooksArgs(provider, request.dataDir)
  const hooksOutcome = hooksArgs === null ? null : await runStep(runner, request, hooksArgs, env)
  if (hooksOutcome && !hooksOutcome.ok) {
    failures.push(`install-hooks: ${hooksOutcome.detail ?? 'falhou'}`)
  }

  const mcp: AiMemoryAgentSetupStep = mcpStep.ok ? 'installed' : 'failed'
  const hooks: AiMemoryAgentSetupStep =
    hooksArgs === null ? 'skipped' : hooksOutcome && hooksOutcome.ok ? 'installed' : 'failed'

  if (failures.length > 0) {
    // Degradado: não grava receipt (permite retry). Nunca impede o agente.
    return { status: 'degraded', mcp, hooks, message: failures.join(' | ') }
  }

  const identityHash = createHash('sha256').update(request.identity).digest('hex').slice(0, 32)
  try {
    await writeReceipt(fileSystem, receiptPath, {
      version: AI_MEMORY_AGENT_SETUP_RECEIPT_VERSION,
      identityHash,
      provider,
      client: family.client,
      agent: family.agent,
      installedAt: new Date(now()).toISOString(),
      ...(account ? { account } : {}),
    })
  } catch (error) {
    return {
      status: 'degraded',
      mcp,
      hooks,
      message: `Integrações instaladas, mas receipt não pôde ser gravada: ${sanitizeDetail(
        error instanceof Error ? error.message : String(error)
      )}`,
    }
  }

  return {
    status: 'installed',
    mcp,
    hooks,
    message: installedMessage(provider, family),
  }
}

/**
 * Compat do fluxo dedicado Gemini: delega ao setup generalizado com provider
 * 'gemini' (mesma receipt, mesmos comandos, mesma semântica).
 */
export async function setupGeminiAgentIntegrations(
  request: AiMemoryAgentSetupRequest,
  deps: AiMemoryAgentSetupDeps
): Promise<AiMemoryAgentSetupResult> {
  return setupAgentIntegrations({ ...request, provider: 'gemini' }, deps)
}
