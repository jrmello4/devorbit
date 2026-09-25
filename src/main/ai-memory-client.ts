import { spawn } from 'node:child_process'
import { buildAiMemoryHelperEnv } from './ai-memory-process-env'
import {
  AI_MEMORY_CLI_COMMANDS,
  AI_MEMORY_MCP_TOOLS,
  AI_MEMORY_VERSION,
  type AiMemoryBriefingArgs,
  type AiMemoryCliRunResult,
  type AiMemoryErrorCode,
  type AiMemoryFinalizeArgs,
  type AiMemoryHandoffAcceptArgs,
  type AiMemoryHandoffArgs,
  type AiMemoryHandoffBeginArgs,
  type AiMemoryJsonRpcRequest,
  type AiMemoryJsonRpcResponse,
  type AiMemoryMcpToolName,
  type AiMemoryMcpToolResult,
  type AiMemoryQueryArgs,
  type AiMemoryReadPageArgs,
  type AiMemoryRecentArgs,
  type AiMemoryScopeRef,
  type AiMemoryWorkstreamsArgs,
  type AiMemoryWritePageArgs,
} from '../shared/ai-memory-contract'

export class AiMemoryError extends Error {
  readonly code: AiMemoryErrorCode

  constructor(code: AiMemoryErrorCode, message: string) {
    super(message)
    this.name = 'AiMemoryError'
    this.code = code
  }
}

export interface McpRequestOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  id?: number
  signal?: AbortSignal
}

function parseJsonRpcPayload(
  text: string,
  contentType: string | null
): AiMemoryJsonRpcResponse | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (contentType && contentType.includes('text/event-stream')) {
    for (const block of trimmed.split(/\n\n+/)) {
      const dataLines = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
      if (dataLines.length === 0) continue
      try {
        const parsed = JSON.parse(dataLines.join('\n')) as AiMemoryJsonRpcResponse
        if (parsed && typeof parsed === 'object') return parsed
      } catch {
        // Bloco SSE sem JSON: tenta o próximo.
      }
    }
    return undefined
  }
  try {
    return JSON.parse(trimmed) as AiMemoryJsonRpcResponse
  } catch {
    return undefined
  }
}

/**
 * Chamada JSON-RPC única sobre MCP Streamable HTTP (stateless por padrão no
 * v2.4.0): POST no endpoint `/mcp`, aceitando resposta JSON ou SSE.
 */
export async function mcpRequest(
  endpoint: string,
  method: string,
  params: unknown,
  options: McpRequestOptions = {}
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new AiMemoryError('ai-memory/transport', 'fetch indisponível para o cliente MCP.')
  }
  const timeoutMs = options.timeoutMs ?? 5_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const request: AiMemoryJsonRpcRequest = {
    jsonrpc: '2.0',
    id: options.id ?? 1,
    method,
    ...(params === undefined ? {} : { params }),
  }
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(request),
      signal: options.signal ?? controller.signal,
    })
    if (!response.ok) {
      throw new AiMemoryError('ai-memory/transport', `HTTP ${response.status} do ai-memory.`)
    }
    const text = await response.text()
    const payload = parseJsonRpcPayload(text, response.headers.get('content-type'))
    if (!payload) throw new AiMemoryError('ai-memory/protocol', 'Resposta MCP inválida.')
    if (payload.error) {
      throw new AiMemoryError(
        'ai-memory/protocol',
        `MCP ${payload.error.code}: ${payload.error.message}`
      )
    }
    return payload.result
  } catch (error) {
    if (error instanceof AiMemoryError) throw error
    if ((error as { name?: string } | undefined)?.name === 'AbortError') {
      throw new AiMemoryError('ai-memory/timeout', 'Timeout na chamada MCP do ai-memory.')
    }
    throw new AiMemoryError(
      'ai-memory/transport',
      error instanceof Error ? error.message : String(error)
    )
  } finally {
    clearTimeout(timer)
  }
}

export interface AiMemoryToolCallResult {
  text: string
  json?: unknown
  isError: boolean
}

function toToolCallResult(result: unknown): AiMemoryToolCallResult {
  if (!result || typeof result !== 'object') return { text: '', isError: false }
  const value = result as AiMemoryMcpToolResult
  const text = Array.isArray(value.content)
    ? value.content.map((item) => (typeof item.text === 'string' ? item.text : '')).join('\n').trim()
    : ''
  let json: unknown
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
  }
  return { text, json, isError: value.isError === true }
}

function compact(args: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) output[key] = value
  }
  return output
}

export interface AiMemoryServerIdentity {
  reachable: boolean
  compatible: boolean
  name?: string
  version?: string
  message?: string
}

function extractServerInfo(result: unknown): { name?: string; version?: string } {
  if (!result || typeof result !== 'object') return {}
  const record = result as Record<string, unknown>
  const info = (record.serverInfo ?? record.server_info) as Record<string, unknown> | undefined
  if (!info || typeof info !== 'object') return {}
  return {
    ...(typeof info.name === 'string' ? { name: info.name } : {}),
    ...(typeof info.version === 'string' ? { version: info.version } : {}),
  }
}

export interface AiMemoryClientOptions {
  endpoint: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  idFactory?: () => number
  appVersion?: string
}

/**
 * Interface interna única de memória via MCP. Nenhum renderer fala MCP/CLI
 * diretamente; o main injeta o endpoint do sidecar de sua propriedade.
 */
export class AiMemoryClient {
  readonly endpoint: string
  private readonly fetchImpl: typeof fetch | undefined
  private readonly timeoutMs: number
  private readonly idFactory: () => number
  private readonly appVersion: string

  constructor(options: AiMemoryClientOptions) {
    this.endpoint = options.endpoint
    this.fetchImpl = options.fetchImpl
    this.timeoutMs = options.timeoutMs ?? 5_000
    let sequence = 0
    this.idFactory = options.idFactory ?? (() => ++sequence)
    this.appVersion = options.appVersion ?? 'unknown'
  }

  request(method: string, params?: unknown): Promise<unknown> {
    return mcpRequest(this.endpoint, method, params, {
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      timeoutMs: this.timeoutMs,
      id: this.idFactory(),
    })
  }

  async initialize(): Promise<unknown> {
    return this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'devorbit', version: this.appVersion },
    })
  }

  listTools(): Promise<unknown> {
    return this.request('tools/list', {})
  }

  async callTool(name: AiMemoryMcpToolName, args: Record<string, unknown> = {}): Promise<AiMemoryToolCallResult> {
    const result = await this.request('tools/call', { name, arguments: args })
    const parsed = toToolCallResult(result)
    if (parsed.isError) {
      throw new AiMemoryError('ai-memory/tool-error', parsed.text || `Ferramenta ${name} falhou.`)
    }
    return parsed
  }

  /**
   * Verifica que o endpoint é um ai-memory compatível, não apenas "algum MCP":
   * `initialize` devolve `serverInfo.name = "ai-memory"` e a versão do crate.
   */
  async serverIdentity(): Promise<AiMemoryServerIdentity> {
    try {
      const result = await this.initialize()
      const { name, version } = extractServerInfo(result)
      if (name === 'ai-memory' && version === AI_MEMORY_VERSION) {
        return { reachable: true, compatible: true, name, version }
      }
      const message =
        name !== 'ai-memory'
          ? `Servidor MCP em ${this.endpoint} não é ai-memory (name=${name ?? 'desconhecido'}).`
          : `ai-memory ${version ?? '?'} incompatível com a versão fixada ${AI_MEMORY_VERSION}.`
      return {
        reachable: true,
        compatible: false,
        ...(name ? { name } : {}),
        ...(version ? { version } : {}),
        message,
      }
    } catch (error) {
      return {
        reachable: false,
        compatible: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    const identity = await this.serverIdentity()
    return identity.compatible
      ? { ok: true }
      : { ok: false, ...(identity.message ? { message: identity.message } : {}) }
  }

  /**
   * Confere que o servidor responde no escopo esperado (workspace+project).
   *
   * FAIL-CLOSED: a API v2.4.0 `memory_status` recebe workspace/project e
   * devolve o scope resolvido. Resposta sem `scope`, com `scope` malformado,
   * divergente, ou uma chamada que falha NÃO é aceita como verificada.
   * Exceções de transporte/tool são propagadas para o chamador decidir.
   */
  async verifyScope(scope: AiMemoryScopeRef): Promise<{ ok: boolean; message?: string }> {
    try {
      const result = await this.status(scope)
      const record =
        result.json && typeof result.json === 'object'
          ? (result.json as { scope?: unknown })
          : undefined
      const resolved = record?.scope
      if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
        return { ok: false, message: 'Resposta de memory_status sem scope resolvido.' }
      }
      const { workspace, project } = resolved as { workspace?: unknown; project?: unknown }
      if (typeof workspace !== 'string' || typeof project !== 'string' || !workspace || !project) {
        return { ok: false, message: 'Resposta de memory_status com scope malformado.' }
      }
      if (workspace !== scope.workspace || project !== scope.project) {
        return {
          ok: false,
          message: `Escopo do ai-memory (${workspace}/${project}) difere do esperado (${scope.workspace}/${scope.project}).`,
        }
      }
      return { ok: true }
    } catch (error) {
      // Tratar "workspace not found" como escopo ainda não inicializado (fail-open)
      // SOMENTE quando o nome reportado é exatamente o workspace configurado.
      // Workspace divergente = falha fechado (possível conflito de escopo).
      // Qualquer outro erro é propagado sem tratamento.
      if (error instanceof AiMemoryError && error.code === 'ai-memory/protocol') {
        // Ancorado ao formato exato de mcpRequest: `MCP -32602: workspace '<name>' not found`
        const match = /^MCP -32602: workspace '([^']+)' not found$/i.exec(error.message)
        if (match && match[1] === scope.workspace) {
          return { ok: true }
        }
      }
      throw error
    }
  }

  status(scope?: AiMemoryScopeRef): Promise<AiMemoryToolCallResult> {
    return this.callTool(
      AI_MEMORY_MCP_TOOLS.status,
      scope ? { workspace: scope.workspace, project: scope.project } : {}
    )
  }

  query(args: AiMemoryQueryArgs): Promise<AiMemoryToolCallResult> {
    if (args.global === true) {
      // v2.4.0 proíbe global=true com workspace/project/scopes: omite o scope.
      return this.callTool(
        AI_MEMORY_MCP_TOOLS.query,
        compact({ query: args.query, limit: args.limit, global: true })
      )
    }
    return this.callTool(
      AI_MEMORY_MCP_TOOLS.query,
      compact({
        query: args.query,
        workspace: args.workspace,
        project: args.project,
        limit: args.limit,
      })
    )
  }

  recent(args: AiMemoryRecentArgs): Promise<AiMemoryToolCallResult> {
    return this.callTool(
      AI_MEMORY_MCP_TOOLS.recent,
      compact({ workspace: args.workspace, project: args.project, limit: args.limit })
    )
  }

  briefing(args: AiMemoryBriefingArgs): Promise<AiMemoryToolCallResult> {
    return this.callTool(
      AI_MEMORY_MCP_TOOLS.briefing,
      compact({
        workspace: args.workspace,
        project: args.project,
        recent_pages_limit: args.recentPagesLimit,
      })
    )
  }

  readPage(args: AiMemoryReadPageArgs): Promise<AiMemoryToolCallResult> {
    return this.callTool(
      AI_MEMORY_MCP_TOOLS.readPage,
      compact({ workspace: args.workspace, project: args.project, path: args.path })
    )
  }

  writePage(args: AiMemoryWritePageArgs): Promise<AiMemoryToolCallResult> {
    return this.callTool(
      AI_MEMORY_MCP_TOOLS.writePage,
      compact({
        workspace: args.workspace,
        project: args.project,
        path: args.path,
        body: args.body,
      })
    )
  }

  handoffs(args: AiMemoryHandoffArgs): Promise<AiMemoryToolCallResult> {
    return this.callTool(
      AI_MEMORY_MCP_TOOLS.handoffList,
      compact({ workspace: args.workspace, project: args.project, limit: args.limit })
    )
  }

  handoffBegin(args: AiMemoryHandoffBeginArgs): Promise<AiMemoryToolCallResult> {
    return this.callTool(
      AI_MEMORY_MCP_TOOLS.handoffBegin,
      compact({
        summary: args.summary,
        open_questions: args.openQuestions,
        next_steps: args.nextSteps,
        files_touched: args.filesTouched,
        cwd: args.cwd,
        shared: args.shared,
        workspace: args.workspace,
        project: args.project,
      })
    )
  }

  handoffAccept(args: AiMemoryHandoffAcceptArgs): Promise<AiMemoryToolCallResult> {
    return this.callTool(
      AI_MEMORY_MCP_TOOLS.handoffAccept,
      compact({
        cwd: args.cwd,
        any_owner: args.anyOwner,
        handoff_id: args.handoffId,
        workspace: args.workspace,
        project: args.project,
      })
    )
  }
}

export function createAiMemoryClient(options: AiMemoryClientOptions): AiMemoryClient {
  return new AiMemoryClient(options)
}

export interface AiMemorySpawnResult {
  code: number | null
  stdout: string
  stderr: string
}

export type AiMemorySpawnImpl = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; windowsHide?: boolean; signal?: AbortSignal }
) => Promise<AiMemorySpawnResult>

const defaultSpawnImpl: AiMemorySpawnImpl = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      // CLI runner (doctor/workstreams/finalize/import) é helper: env mínimo.
      env: buildAiMemoryHelperEnv({ overlay: options.env }),
      windowsHide: options.windowsHide ?? true,
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const onAbort = (): void => {
      // Timeout precisa MATAR o processo, não apenas rejeitar a Promise.
      try {
        child.kill()
      } catch {
        // Processo já encerrado.
      }
    }
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      callback()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => finish(() => reject(error)))
    child.on('close', (code) => finish(() => resolve({ code, stdout, stderr })))
  })

export interface AiMemoryCliRunnerOptions {
  binaryPath: string
  spawnImpl?: AiMemorySpawnImpl
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export type AiMemoryCliRunner = (args: readonly string[]) => Promise<AiMemoryCliRunResult>

export function createAiMemoryCliRunner(options: AiMemoryCliRunnerOptions): AiMemoryCliRunner {
  const spawnImpl = options.spawnImpl ?? defaultSpawnImpl
  const timeoutMs = options.timeoutMs ?? 15_000
  return async (args) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const result = await spawnImpl(options.binaryPath, args, {
        ...(options.env ? { env: options.env } : {}),
        windowsHide: true,
        signal: controller.signal,
      })
      if (controller.signal.aborted) {
        throw new AiMemoryError('ai-memory/timeout', 'Timeout na CLI do ai-memory.')
      }
      return { code: result.code, stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AiMemoryError('ai-memory/timeout', 'Timeout na CLI do ai-memory.')
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

function buildWorkstreamsArgs(args: AiMemoryWorkstreamsArgs): string[] {
  const output: string[] = [AI_MEMORY_CLI_COMMANDS.workstreams]
  if (args.workspace) output.push('--workspace', args.workspace)
  if (args.project) output.push('--project', args.project)
  if (args.limit !== undefined) output.push('--limit', String(args.limit))
  if (args.json === true) output.push('--json')
  return output
}

function buildFinalizeArgs(args: AiMemoryFinalizeArgs): string[] {
  const output: string[] = [AI_MEMORY_CLI_COMMANDS.finalizeSession, '--agent', args.agent]
  if (args.sessionId) output.push('--session-id', args.sessionId)
  return output
}

export function parseAiMemoryVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1]
}

/** Wrapper fino e injetável da CLI real (doctor/workstreams/finalize/import). */
export class AiMemoryCli {
  constructor(private readonly run: AiMemoryCliRunner) {}

  version(): Promise<AiMemoryCliRunResult> {
    return this.run([AI_MEMORY_CLI_COMMANDS.version])
  }

  doctor(args: readonly string[] = []): Promise<AiMemoryCliRunResult> {
    return this.run([AI_MEMORY_CLI_COMMANDS.doctor, ...args])
  }

  workstreams(args: AiMemoryWorkstreamsArgs = {}): Promise<AiMemoryCliRunResult> {
    return this.run(buildWorkstreamsArgs(args))
  }

  finalizeSession(args: AiMemoryFinalizeArgs): Promise<AiMemoryCliRunResult> {
    return this.run(buildFinalizeArgs(args))
  }

  /**
   * Comandos verificados no enum v2.4.0. `backfill`/`bootstrap` NÃO são a
   * migração do legado: markdown/JSON serão importados depois via
   * `memory_write_page` com recibos determinísticos.
   */
  backfill(args: readonly string[] = []): Promise<AiMemoryCliRunResult> {
    return this.run([AI_MEMORY_CLI_COMMANDS.backfill, ...args])
  }

  bootstrap(args: readonly string[] = []): Promise<AiMemoryCliRunResult> {
    return this.run([AI_MEMORY_CLI_COMMANDS.bootstrap, ...args])
  }
}

export function createAiMemoryCli(options: AiMemoryCliRunnerOptions): AiMemoryCli {
  return new AiMemoryCli(createAiMemoryCliRunner(options))
}
