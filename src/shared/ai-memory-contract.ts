/**
 * Contrato compartilhado do ai-memory (FASE 1: runtime, scope e consentimento).
 *
 * Este arquivo NÃO importa Electron nem Node: só tipos e constantes, para ser
 * consumido pelo main, por testes e, no futuro, pelo renderer via preload.
 *
 * Fatos fixados da release oficial v2.4.0:
 * - asset Windows x64 `ai-memory-windows-x86_64.zip`;
 * - SHA-256 do zip: 4b3b8757c16a6ae97a3a43f46baef012a400121017272fb4e799503d8c130a50;
 * - endpoint MCP Streamable HTTP padrão em 127.0.0.1:49374/mcp (stateless).
 */

export const AI_MEMORY_VERSION = '2.4.0'
export const AI_MEMORY_RELEASE_TAG = 'v2.4.0'
/** Prefixo documentado do commit da tag v2.4.0 (fixado para validação). */
export const AI_MEMORY_RELEASE_COMMIT = 'b1b25219'
export const AI_MEMORY_WINDOWS_X64_ASSET = 'ai-memory-windows-x86_64.zip'
export const AI_MEMORY_WINDOWS_X64_SHA256 =
  '4b3b8757c16a6ae97a3a43f46baef012a400121017272fb4e799503d8c130a50'

export const AI_MEMORY_DEFAULT_HOST = '127.0.0.1'
export const AI_MEMORY_DEFAULT_PORT = 49374
export const AI_MEMORY_MCP_PATH = '/mcp'
export const AI_MEMORY_WORKSPACE = 'devorbit'
export const AI_MEMORY_MARKER_FILENAME = '.ai-memory.toml'
export const AI_MEMORY_MARKER_MANAGED_HEADER = '# Managed by DevOrbit (ai-memory scope).'

/**
 * Exclusões de captura do marker. Gramática v2.4.0: padrões relativos ao
 * diretório do marker, apenas `*`, `?`, `**` e `~/`; `[capture]` aceita
 * somente `ignore_paths`. Cobre artefatos do próprio DevOrbit e segredos
 * comuns (defesa lexical, não DLP completo).
 */
export const AI_MEMORY_REQUIRED_IGNORE_PATHS = [
  '.devorbit/**',
  '.git/**',
  '.env',
  '.env.*',
  'secrets/**',
  'credentials/**',
  '**/*.pem',
  '**/*.key',
] as const

/** Campos mínimos para considerar um marker configurado pelo DevOrbit. */
export const AI_MEMORY_REQUIRED_MARKER_FIELDS = [
  'workspace',
  'project',
  'ignore_paths',
  'briefing',
] as const

export const AI_MEMORY_STATES = [
  'unavailable',
  'starting',
  'running',
  'degraded',
  'error',
] as const

export type AiMemoryServiceState = (typeof AI_MEMORY_STATES)[number]

export type AiMemoryErrorCode =
  | 'ai-memory/unavailable'
  | 'ai-memory/disabled'
  | 'ai-memory/version-mismatch'
  | 'ai-memory/integrity'
  | 'ai-memory/timeout'
  | 'ai-memory/transport'
  | 'ai-memory/protocol'
  | 'ai-memory/tool-error'
  | 'ai-memory/cli-error'
  | 'ai-memory/marker-conflict'
  | 'ai-memory/invalid-scope'

export interface AiMemoryCapabilities {
  /** Endpoint MCP Streamable HTTP respondeu a uma chamada de saúde. */
  mcp: boolean
  /** Binário CLI local descoberto e com versão validada. */
  cli: boolean
}

export interface AiMemoryStatus {
  state: AiMemoryServiceState
  /** true = processo filho iniciado e controlado pelo DevOrbit. */
  owned: boolean
  endpoint?: string
  version?: string
  binaryPath?: string
  capabilities?: AiMemoryCapabilities
  /** true = algo respondeu no endpoint mas não é um ai-memory compatível. */
  conflict?: boolean
  message?: string
}

export interface AiMemoryScope {
  workspace: string
  project: string
  /** Chave estável e determinística (remoto normalizado / git-common-dir / path). */
  identity: string
  source: 'marker' | 'remote' | 'git-common-dir' | 'path'
  root: string
}

export interface AiMemoryBriefingConfig {
  injectOnSessionStart?: boolean
  maxChars?: number
}

export interface AiMemoryMarker {
  workspace: string
  project?: string
  projectStrategy?: 'repo-root'
  briefing?: AiMemoryBriefingConfig
  ignorePaths?: string[]
}

export type AiMemoryMarkerWriteStatus =
  | 'created'
  | 'unchanged'
  | 'updated'
  | 'preserved'
  | 'conflict'

export interface AiMemoryMarkerWriteResult {
  status: AiMemoryMarkerWriteStatus
  path: string
  /** true somente quando o marker é gerenciado pelo DevOrbit e está completo. */
  configured: boolean
  /** Campos do marker existente que conflitam com o desejado. */
  conflicts?: string[]
  /** Campos obrigatórios ausentes em um marker de terceiros preservado. */
  missingFields?: string[]
}

export interface AiMemoryProjectConfig {
  identity: string
  workspace: string
  project: string
  path: string
  enabled: boolean
}

export interface AiMemoryConfig {
  /** Opt-in global. Desabilitado não inicia sidecar, não escreve marker nem storage. */
  enabled: boolean
  /** Opt-in por projeto, indexado pela identidade determinística. */
  projects: Record<string, AiMemoryProjectConfig>
}

export const DEFAULT_AI_MEMORY_CONFIG: AiMemoryConfig = {
  enabled: false,
  projects: {},
}

/** Nomes reais das ferramentas MCP (docs v2.4.0), centralizados aqui. */
export const AI_MEMORY_MCP_TOOLS = {
  status: 'memory_status',
  query: 'memory_query',
  recent: 'memory_recent',
  briefing: 'memory_briefing',
  readPage: 'memory_read_page',
  writePage: 'memory_write_page',
  handoffList: 'memory_handoff_list',
  handoffBegin: 'memory_handoff_begin',
  handoffAccept: 'memory_handoff_accept',
} as const

export type AiMemoryMcpToolName =
  (typeof AI_MEMORY_MCP_TOOLS)[keyof typeof AI_MEMORY_MCP_TOOLS]

/**
 * Subcomandos reais da CLI encapsulada, verificados no enum v2.4.0
 * (`crates/ai-memory-cli/src/cli.rs`). NÃO existe `import`: a importação do
 * legado será feita depois via `memory_write_page` com recibos determinísticos,
 * não por `bootstrap`.
 */
export const AI_MEMORY_CLI_COMMANDS = {
  version: '--version',
  doctor: 'doctor',
  workstreams: 'workstreams',
  finalizeSession: 'finalize-session',
  backfill: 'backfill',
  bootstrap: 'bootstrap',
} as const

export interface AiMemoryScopeRef {
  workspace: string
  project: string
}

export interface AiMemoryQueryScopedArgs extends AiMemoryScopeRef {
  query: string
  limit?: number
  global?: false
}

export interface AiMemoryQueryGlobalArgs {
  query: string
  limit?: number
  global: true
}

/**
 * `memory_query` v2.4.0 proíbe `global=true` junto com `workspace`/`project`/
 * `scopes`. A união torna a combinação inválida impossível de expressar.
 */
export type AiMemoryQueryArgs = AiMemoryQueryScopedArgs | AiMemoryQueryGlobalArgs

export interface AiMemoryRecentArgs extends AiMemoryScopeRef {
  limit?: number
}

export interface AiMemoryBriefingArgs extends AiMemoryScopeRef {
  /**
   * Quantas páginas atualizadas recentemente incluir (schema real v2.4.0
   * `BriefingArgs.recent_pages_limit`; default 10, máx 100). Não existe
   * `max_chars` no MCP — truncamento de orçamento é decisão local da UI.
   */
  recentPagesLimit?: number
}

export interface AiMemoryReadPageArgs extends AiMemoryScopeRef {
  path: string
}

export interface AiMemoryWritePageArgs extends AiMemoryScopeRef {
  path: string
  /** Corpo markdown (schema real v2.4.0 `WritePageArgs.body`). */
  body: string
}

export interface AiMemoryHandoffArgs extends AiMemoryScopeRef {
  sessionId?: string
  shared?: boolean
  /** Máximo de handoffs abertos (schema real v2.4.0 `HandoffListArgs.limit`). */
  limit?: number
}

/** `memory_handoff_begin` (schema real v2.4.0 `HandoffBeginArgs`). */
export interface AiMemoryHandoffBeginArgs extends AiMemoryScopeRef {
  summary: string
  openQuestions?: string[]
  nextSteps?: string[]
  filesTouched?: string[]
  cwd?: string
  shared?: boolean
}

/** `memory_handoff_accept` (schema real v2.4.0 `HandoffAcceptArgs`). */
export interface AiMemoryHandoffAcceptArgs extends AiMemoryScopeRef {
  cwd?: string
  anyOwner?: boolean
  handoffId?: string
}

export interface AiMemoryJsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

export interface AiMemoryJsonRpcError {
  code: number
  message: string
}

export interface AiMemoryMcpContent {
  type: string
  text?: string
}

export interface AiMemoryMcpToolResult {
  content?: AiMemoryMcpContent[]
  structuredContent?: unknown
  isError?: boolean
}

export interface AiMemoryJsonRpcResponse {
  jsonrpc?: string
  id?: number
  result?: unknown
  error?: AiMemoryJsonRpcError
}

export interface AiMemoryCliRunResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface AiMemoryWorkstreamsArgs {
  workspace?: string
  project?: string
  limit?: number
  json?: boolean
}

export interface AiMemoryFinalizeArgs {
  agent: string
  sessionId?: string
}
