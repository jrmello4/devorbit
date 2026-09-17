import type { AuditLedger } from '../audit-ledger'
import type { HITLManager, HitlRequestInput } from '../hitl'
import type { Semaphore } from '../semaphore'
import type { Telemetry } from '../telemetry'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }
export type JsonRpcId = string | number | null

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: JsonValue
}

export interface JsonRpcError {
  code: number
  message: string
  data?: JsonValue
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: JsonValue
  error?: JsonRpcError
}

export interface McpTextContent {
  type: 'text'
  text: string
}

export interface McpJsonContent {
  type: 'json'
  data: JsonValue
}

export type McpContent = McpTextContent | McpJsonContent

export interface McpToolResult {
  content: McpContent[]
  structuredContent?: JsonObject
  isError?: boolean
}

export interface McpApprovalRequest extends Omit<HitlRequestInput, 'id'> {
  prompt: string
}

export interface McpToolContext {
  requestId: JsonRpcId
  signal: AbortSignal
  integrations: Readonly<McpServerIntegrations>
}

export type McpToolHandler<TArgs extends object = JsonObject, TResult = unknown> = (
  args: TArgs,
  context: McpToolContext,
) => TResult | Promise<TResult>

export interface McpToolDefinition<TArgs extends object = JsonObject, TResult = unknown> {
  name: string
  description?: string
  inputSchema: JsonObject
  handler: McpToolHandler<TArgs, TResult>
  requiresApproval?: boolean | ((args: TArgs) => McpApprovalRequest | Promise<McpApprovalRequest>)
}

export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema: JsonObject
}

export interface McpServerIntegrations {
  semaphore?: Semaphore
  hitl?: HITLManager
  ledger?: AuditLedger
  telemetry?: Telemetry
}

export interface McpServerOptions extends Partial<McpServerIntegrations> {
  name?: string
  version?: string
  integrations?: McpServerIntegrations
}

export interface McpToolsListResult {
  tools: McpToolDescriptor[]
}

export interface McpToolsCallParams {
  name: string
  arguments?: JsonObject
}

export interface McpToolsCallResult extends McpToolResult {
  content: McpContent[]
}
