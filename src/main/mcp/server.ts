import type {
  JsonObject,
  JsonRpcError,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonValue,
  McpApprovalRequest,
  McpContent,
  McpServerIntegrations,
  McpServerOptions,
  McpTextContent,
  McpToolContext,
  McpToolDefinition,
  McpToolDescriptor,
  McpToolResult,
  McpToolsCallParams,
  McpToolsCallResult,
  McpToolsListResult,
} from './types'
import { type SemaphoreAcquireOptions } from '../semaphore'

export const MCP_JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

interface StoredTool {
  definition: McpToolDefinition<JsonObject, unknown>
}

interface JsonRecord {
  [key: string]: unknown
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value)
}

function toJsonValue(value: unknown, seen = new WeakSet<object>(), depth = 0): JsonValue {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined') return null
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  if (depth > 8) return '[TRUNCATED]'
  if (value instanceof Date) return value.toISOString()
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item, seen, depth + 1))
  const output: JsonObject = {}
  for (const [key, item] of Object.entries(value)) output[key] = toJsonValue(item, seen, depth + 1)
  return output
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\b((?:prompt|token|env|secret|password|authorization|api[-_]?key))\b\s*[:=]\s*[^\s,;]+/giu, '$1=[REDACTED]').slice(0, 1_000)
}

function textContent(text: string): McpTextContent {
  return { type: 'text', text }
}

function isMcpToolResult(value: unknown): value is McpToolResult {
  if (!isRecord(value) || !Array.isArray(value.content)) return false
  return value.content.every((item) => isRecord(item) && (item.type === 'text' || item.type === 'json'))
}

function normalizeToolResult(value: unknown): McpToolsCallResult {
  if (isMcpToolResult(value)) {
    return {
      content: value.content.map((item) => item.type === 'text'
        ? textContent(item.text)
        : textContent(JSON.stringify(toJsonValue(item.data)))),
      ...(value.structuredContent !== undefined ? { structuredContent: toJsonValue(value.structuredContent) as JsonObject } : {}),
      ...(value.isError !== undefined ? { isError: value.isError } : {}),
    }
  }
  if (typeof value === 'string') return { content: [textContent(value)] }
  const data = toJsonValue(value)
  return {
    content: [textContent(JSON.stringify(data))],
    ...(isRecord(data) ? { structuredContent: data as JsonObject } : {}),
  }
}

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  const error: JsonRpcError = {
    code,
    message,
    ...(data !== undefined ? { data: toJsonValue(data) } : {}),
  }
  return { jsonrpc: '2.0', id, error }
}

function response(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: toJsonValue(result) }
}

function parseRequest(value: unknown): { request?: JsonRpcRequest; error?: JsonRpcResponse } {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string' || value.method.trim().length === 0) {
    return { error: errorResponse(null, MCP_JSON_RPC_ERRORS.INVALID_REQUEST, 'Invalid Request.') }
  }
  if ('id' in value && !isJsonRpcId(value.id)) {
    return { error: errorResponse(null, MCP_JSON_RPC_ERRORS.INVALID_REQUEST, 'Invalid Request.') }
  }
  return {
    request: {
      jsonrpc: '2.0',
      method: value.method,
      ...('id' in value ? { id: value.id as JsonRpcId } : {}),
      ...(value.params !== undefined ? { params: toJsonValue(value.params) } : {}),
    },
  }
}

export class McpServer {
  readonly name: string
  readonly version: string
  readonly integrations: Readonly<McpServerIntegrations>
  private readonly tools = new Map<string, StoredTool>()

  constructor(options: McpServerOptions = {}) {
    this.name = options.name ?? 'DevOrbit MCP Server'
    this.version = options.version ?? '1.0.0'
    const directIntegrations: McpServerIntegrations = {
      ...(options.semaphore ? { semaphore: options.semaphore } : {}),
      ...(options.hitl ? { hitl: options.hitl } : {}),
      ...(options.ledger ? { ledger: options.ledger } : {}),
      ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    }
    this.integrations = Object.freeze({ ...directIntegrations, ...(options.integrations ?? {}) })
  }

  registerTool<TArgs extends object, TResult>(definition: McpToolDefinition<TArgs, TResult>): () => void {
    if (!definition || typeof definition.name !== 'string' || definition.name.trim().length === 0) {
      throw new TypeError('MCP tool name is required.')
    }
    if (!isJsonObject(definition.inputSchema)) throw new TypeError('MCP tool inputSchema is required.')
    if (typeof definition.handler !== 'function') throw new TypeError('MCP tool handler is required.')
    if (this.tools.has(definition.name)) throw new Error(`MCP tool already registered: ${definition.name}`)
    this.tools.set(definition.name, {
      definition: definition as unknown as McpToolDefinition<JsonObject, unknown>,
    })
    return () => {
      this.unregisterTool(definition.name)
    }
  }

  register<TArgs extends object, TResult>(definition: McpToolDefinition<TArgs, TResult>): () => void {
    return this.registerTool(definition)
  }

  unregisterTool(name: string): boolean {
    return this.tools.delete(name)
  }

  listTools(): McpToolDescriptor[] {
    return [...this.tools.values()].map(({ definition }) => ({
      name: definition.name,
      ...(definition.description !== undefined ? { description: definition.description } : {}),
      inputSchema: toJsonValue(definition.inputSchema) as JsonObject,
    }))
  }

  get toolCount(): number {
    return this.tools.size
  }

  async handle(
    request: unknown,
    signal?: AbortSignal,
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
    if (Array.isArray(request)) {
      if (request.length === 0) return errorResponse(null, MCP_JSON_RPC_ERRORS.INVALID_REQUEST, 'Invalid Request.')
      const results = await Promise.all(request.map((item) => this.handleOne(item, signal)))
      const responses = results.filter((item): item is JsonRpcResponse => item !== undefined)
      return responses.length > 0 ? responses : undefined
    }
    return this.handleOne(request, signal)
  }

  async handleJson(payload: string, signal?: AbortSignal): Promise<string | undefined> {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload) as unknown
    } catch {
      return JSON.stringify(errorResponse(null, MCP_JSON_RPC_ERRORS.PARSE_ERROR, 'Parse error.'))
    }
    const result = await this.handle(parsed, signal)
    return result === undefined ? undefined : JSON.stringify(result)
  }

  dispatch(request: unknown, signal?: AbortSignal): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
    return this.handle(request, signal)
  }

  private async handleOne(value: unknown, signal?: AbortSignal): Promise<JsonRpcResponse | undefined> {
    const parsed = parseRequest(value)
    if (parsed.error) return parsed.error
    const request = parsed.request as JsonRpcRequest
    const hasId = Object.prototype.hasOwnProperty.call(request, 'id')
    try {
      const result = await this.dispatchMethod(request, signal)
      return hasId ? response(request.id as JsonRpcId, result) : undefined
    } catch (error) {
      if (!hasId) return undefined
      if (error instanceof ProtocolError) {
        return errorResponse(request.id as JsonRpcId, error.code, error.message)
      }
      return errorResponse(request.id as JsonRpcId, MCP_JSON_RPC_ERRORS.INTERNAL_ERROR, 'Internal error.', safeMessage(error))
    }
  }

  private async dispatchMethod(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonValue> {
    if (request.method === 'initialize') {
      return {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: this.name, version: this.version },
      }
    }
    if (request.method === 'notifications/initialized') return {}
    if (request.method === 'tools/list') {
      const result: McpToolsListResult = { tools: this.listTools() }
      return result as unknown as JsonValue
    }
    if (request.method === 'tools/call') return this.callTool(request, signal) as unknown as JsonValue
    throw new ProtocolError(MCP_JSON_RPC_ERRORS.METHOD_NOT_FOUND, 'Method not found.')
  }

  private async callTool(request: JsonRpcRequest, signal?: AbortSignal): Promise<McpToolsCallResult> {
    if (!isRecord(request.params) || typeof request.params.name !== 'string' || request.params.name.trim().length === 0) {
      throw new ProtocolError(MCP_JSON_RPC_ERRORS.INVALID_PARAMS, 'Invalid params.')
    }
    const params: McpToolsCallParams = {
      name: request.params.name,
      ...(request.params.arguments !== undefined ? { arguments: toJsonValue(request.params.arguments) as JsonObject } : {}),
    }
    if (request.params.arguments !== undefined && !isJsonObject(request.params.arguments)) {
      throw new ProtocolError(MCP_JSON_RPC_ERRORS.INVALID_PARAMS, 'Invalid params.')
    }
    const stored = this.tools.get(params.name)
    if (!stored) throw new ProtocolError(MCP_JSON_RPC_ERRORS.METHOD_NOT_FOUND, 'Unknown tool.')
    const args = params.arguments ?? {}
    const telemetry = this.integrations.telemetry
    const span = telemetry?.startSpan('mcp.tools.call', {
      tool: params.name,
      requestId: request.id ?? null,
      argumentKeys: Object.keys(args),
    })
    await this.appendLedger({
      type: 'mcp.tool.request',
      requestId: request.id ?? null,
      tool: params.name,
      arguments: args,
    })
    try {
      const approval = await this.resolveApproval(stored.definition, args, signal)
      if (approval !== undefined && approval.state !== 'approved') {
        const result: McpToolsCallResult = {
          isError: true,
          content: [textContent(`Tool call ${approval.state}.`)],
        }
        span?.end({ status: 'error', attributes: { approvalState: approval.state } })
        await this.appendLedger({ type: 'mcp.tool.result', requestId: request.id ?? null, tool: params.name, result })
        return result
      }
      const context: McpToolContext = {
        requestId: request.id ?? null,
        signal: signal ?? new AbortController().signal,
        integrations: this.integrations,
      }
      const execute = (): Promise<unknown> => Promise.resolve(stored.definition.handler(args, context))
      const value = this.integrations.semaphore
        ? await this.integrations.semaphore.runExclusive(execute, this.acquireOptions(signal))
        : await execute()
      const result = normalizeToolResult(value)
      span?.end({ status: result.isError ? 'error' : 'ok' })
      await this.appendLedger({ type: 'mcp.tool.result', requestId: request.id ?? null, tool: params.name, result })
      return result
    } catch (error) {
      span?.end({ status: 'error', error })
      const result: McpToolsCallResult = {
        isError: true,
        content: [textContent(safeMessage(error))],
      }
      await this.appendLedger({ type: 'mcp.tool.error', requestId: request.id ?? null, tool: params.name, error: safeMessage(error) })
      return result
    }
  }

  private async resolveApproval(
    definition: McpToolDefinition<JsonObject, unknown>,
    args: JsonObject,
    signal?: AbortSignal,
  ): Promise<{ state: 'approved' | 'rejected' | 'expired' } | undefined> {
    if (!definition.requiresApproval) return undefined
    const hitl = this.integrations.hitl
    if (!hitl) throw new Error('HITL integration is required for this tool.')
    const approval: McpApprovalRequest = typeof definition.requiresApproval === 'function'
      ? await definition.requiresApproval(args)
      : {
        prompt: `Approve MCP tool ${definition.name}.`,
        context: { tool: definition.name, argumentKeys: Object.keys(args) },
      }
    const request = hitl.createRequest({
      prompt: approval.prompt,
      ...(approval.context !== undefined ? { context: approval.context } : {}),
      ...(approval.metadata !== undefined ? { metadata: approval.metadata } : {}),
      ...(approval.ttlMs !== undefined ? { ttlMs: approval.ttlMs } : {}),
    })
    const decision = await this.waitForHitl(hitl, request.id, signal)
    return decision.state === 'approved' || decision.state === 'rejected' || decision.state === 'expired'
      ? { state: decision.state }
      : undefined
  }

  private async waitForHitl(hitl: McpServerIntegrations['hitl'], id: string, signal?: AbortSignal): Promise<{ state: string }> {
    if (!hitl) throw new Error('HITL integration is required for this tool.')
    if (!signal) return hitl.waitForDecision(id)
    if (signal.aborted) throw new Error('MCP request aborted.')
    return new Promise<{ state: string }>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        callback()
      }
      const onAbort = (): void => finish(() => reject(new Error('MCP request aborted.')))
      signal.addEventListener('abort', onAbort, { once: true })
      hitl.waitForDecision(id).then(
        (request) => finish(() => resolve({ state: request.state })),
        (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
      )
    })
  }

  private acquireOptions(signal?: AbortSignal): SemaphoreAcquireOptions {
    return signal ? { signal } : {}
  }

  private async appendLedger(entry: { type: string; [key: string]: unknown }): Promise<void> {
    try {
      await this.integrations.ledger?.append(entry)
    } catch {
      return
    }
  }
}

class ProtocolError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  return new McpServer(options)
}

export { McpServer as MCPServer }

export type { JsonRpcRequest, JsonRpcResponse, McpToolDefinition }
