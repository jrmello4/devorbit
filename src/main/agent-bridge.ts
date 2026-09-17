import { createServer, type Server, type Socket } from 'node:net'
import { timingSafeEqual } from 'node:crypto'

export const MAX_AGENT_BRIDGE_PAYLOAD_BYTES = 64 * 1024
export const MAX_AGENT_BRIDGE_PROMPT_CHARS = 16 * 1024
export const MAX_AGENT_BRIDGE_TARGET_CHARS = 128
export const MAX_AGENT_BRIDGE_CREDENTIAL_CHARS = 256
export const MAX_AGENT_BRIDGE_DEPTH = 8
export const MAX_AGENT_BRIDGE_VISITED = 32
export const DEFAULT_AGENT_BRIDGE_TIMEOUT_MS = 5 * 60 * 1000
export const MAX_AGENT_BRIDGE_TIMEOUT_MS = 60 * 60 * 1000

type AgentBridgeRequestType = 'list' | 'send' | 'wait' | 'ask'

export interface AgentBridgeRequestBase {
  type: AgentBridgeRequestType
  token: string
  sessionId: string
  id?: string
  depth?: number
  visited?: string[]
}

export interface AgentBridgeListRequest extends AgentBridgeRequestBase {
  type: 'list'
}

export interface AgentBridgeSendRequest extends AgentBridgeRequestBase {
  type: 'send'
  target: string
  prompt: string
}

export interface AgentBridgeWaitRequest extends AgentBridgeRequestBase {
  type: 'wait'
  target: string
  timeoutMs: number
}

export interface AgentBridgeAskRequest extends AgentBridgeRequestBase {
  type: 'ask'
  target: string
  prompt: string
  timeoutMs?: number
}

export type AgentBridgeRequest =
  | AgentBridgeListRequest
  | AgentBridgeSendRequest
  | AgentBridgeWaitRequest
  | AgentBridgeAskRequest

export interface AgentBridgeSuccessResponse {
  ok: true
  id?: string
  result: unknown
}

export interface AgentBridgeErrorResponse {
  ok: false
  id?: string
  error: {
    code: string
    message: string
  }
}

export type AgentBridgeResponse = AgentBridgeSuccessResponse | AgentBridgeErrorResponse

export class AgentBridgeProtocolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AgentBridgeProtocolError'
    this.code = code
  }
}

export interface AgentBridgeHandlerContext {
  readonly signal: AbortSignal
}

export type AgentBridgeHandler<T extends AgentBridgeRequest = AgentBridgeRequest> = (
  request: T,
  context?: AgentBridgeHandlerContext,
) => unknown | Promise<unknown>

export interface AgentBridgeHandlers {
  list?: AgentBridgeHandler<AgentBridgeListRequest>
  send?: AgentBridgeHandler<AgentBridgeSendRequest>
  wait?: AgentBridgeHandler<AgentBridgeWaitRequest>
  ask?: AgentBridgeHandler<AgentBridgeAskRequest>
}

export interface AgentBridgeServerOptions {
  pipeName: string
  token: string
  sessionId: string
  handlers: AgentBridgeHandlers
  maxPayloadBytes?: number
}

function protocolError(code: string, message: string): never {
  throw new AgentBridgeProtocolError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 31 || code === 127) return true
  }
  return false
}

function validateCredential(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_AGENT_BRIDGE_CREDENTIAL_CHARS) {
    return protocolError('INVALID_REQUEST', `Invalid ${field}.`)
  }
  if (hasControlCharacters(value)) {
    return protocolError('INVALID_REQUEST', `Invalid ${field}.`)
  }
  return value
}

export function validateTarget(value: unknown): string {
  if (typeof value !== 'string') return protocolError('INVALID_TARGET', 'Target must be a string.')
  const target = value.trim()
  if (target.length === 0 || target.length > MAX_AGENT_BRIDGE_TARGET_CHARS) {
    return protocolError('INVALID_TARGET', 'Target must be non-empty and within the size limit.')
  }
  if (hasControlCharacters(target)) {
    return protocolError('INVALID_TARGET', 'Target contains unsupported characters.')
  }
  return target
}

export function validatePrompt(value: unknown): string {
  if (typeof value !== 'string') return protocolError('INVALID_PROMPT', 'Prompt must be a string.')
  if (value.trim().length === 0 || value.length > MAX_AGENT_BRIDGE_PROMPT_CHARS) {
    return protocolError('INVALID_PROMPT', 'Prompt must be non-empty and within the size limit.')
  }
  if (hasControlCharacters(value)) {
    return protocolError('INVALID_PROMPT', 'Prompt contains unsupported characters.')
  }
  return value
}

export function parseAgentBridgeTimeout(value: unknown): number {
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value > 0 && value <= MAX_AGENT_BRIDGE_TIMEOUT_MS) return value
    return protocolError('INVALID_TIMEOUT', 'Timeout must be a positive value within the limit.')
  }
  if (typeof value !== 'string') return protocolError('INVALID_TIMEOUT', 'Timeout must be a duration.')

  const match = /^([1-9]\d*)(ms|s|m|h)$/iu.exec(value.trim())
  if (!match) return protocolError('INVALID_TIMEOUT', 'Timeout must use ms, s, m, or h.')
  const amount = Number(match[1])
  const multiplier = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 }[match[2].toLowerCase() as 'ms' | 's' | 'm' | 'h']
  const timeout = amount * multiplier
  if (!Number.isSafeInteger(timeout) || timeout > MAX_AGENT_BRIDGE_TIMEOUT_MS) {
    return protocolError('INVALID_TIMEOUT', 'Timeout must be within the limit.')
  }
  return timeout
}

export const parseTimeout = parseAgentBridgeTimeout

function validateDepth(value: unknown): number {
  if (value === undefined) return 0
  if (!Number.isInteger(value) || (value as number) < 0) {
    return protocolError('INVALID_GUARD', 'Depth must be a non-negative integer.')
  }
  if ((value as number) >= MAX_AGENT_BRIDGE_DEPTH) {
    return protocolError('CYCLE_BLOCKED', 'Delegation depth limit reached.')
  }
  return value as number
}

function validateVisited(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_AGENT_BRIDGE_VISITED) {
    return protocolError('INVALID_GUARD', 'Visited must be a short list of targets.')
  }
  const visited = value.map(validateTarget)
  if (new Set(visited).size !== visited.length) {
    return protocolError('INVALID_GUARD', 'Visited must not contain duplicates.')
  }
  return visited
}

export function isDelegationCycleBlocked(
  target: string,
  options: { depth?: number; visited?: readonly string[] } = {}
): boolean {
  return (options.depth ?? 0) >= MAX_AGENT_BRIDGE_DEPTH || (options.visited ?? []).includes(target)
}

export const isCycleBlocked = isDelegationCycleBlocked

export function validateDelegationGuard(
  target: unknown,
  depth?: unknown,
  visited?: unknown
): { target: string; depth: number; visited: string[] } {
  const normalizedTarget = validateTarget(target)
  const normalizedDepth = validateDepth(depth)
  const normalizedVisited = validateVisited(visited)
  if (isDelegationCycleBlocked(normalizedTarget, { depth: normalizedDepth, visited: normalizedVisited })) {
    return protocolError('CYCLE_BLOCKED', 'Delegation cycle blocked.')
  }
  return { target: normalizedTarget, depth: normalizedDepth, visited: normalizedVisited }
}

export function validateAgentBridgeRequest(value: unknown): AgentBridgeRequest {
  if (!isRecord(value)) return protocolError('INVALID_REQUEST', 'Request must be a JSON object.')

  const type = value.type
  if (type !== 'list' && type !== 'send' && type !== 'wait' && type !== 'ask') {
    return protocolError('INVALID_REQUEST', 'Unknown request type.')
  }

  const token = validateCredential(value.token, 'token')
  const sessionId = validateCredential(value.sessionId, 'sessionId')
  const id = value.id === undefined ? undefined : validateCredential(value.id, 'id')
  const depth = validateDepth(value.depth)
  const visited = validateVisited(value.visited)

  if (type === 'list') return { type, token, sessionId, id, depth, visited }

  const guard = validateDelegationGuard(value.target, depth, visited)
  if (type === 'wait') {
    return {
      type,
      token,
      sessionId,
      id,
      depth: guard.depth,
      visited: guard.visited,
      target: guard.target,
      timeoutMs: parseAgentBridgeTimeout(value.timeoutMs),
    }
  }

  const request = {
    token,
    sessionId,
    id,
    depth: guard.depth,
    visited: guard.visited,
    target: guard.target,
    prompt: validatePrompt(value.prompt),
  }
  if (type === 'ask' && value.timeoutMs !== undefined) {
    return { ...request, type: 'ask' as const, timeoutMs: parseAgentBridgeTimeout(value.timeoutMs) }
  }
  return { ...request, type }
}

export function serializeAgentBridgeMessage(
  value: unknown,
  maxPayloadBytes = MAX_AGENT_BRIDGE_PAYLOAD_BYTES
): string {
  let json: string
  try {
    json = JSON.stringify(value)
  } catch {
    return protocolError('SERIALIZATION_ERROR', 'Message could not be serialized.')
  }
  if (json === undefined) return protocolError('SERIALIZATION_ERROR', 'Message could not be serialized.')
  if (Buffer.byteLength(json, 'utf8') > maxPayloadBytes) {
    return protocolError('PAYLOAD_TOO_LARGE', 'Message exceeds the payload limit.')
  }
  return `${json}\n`
}

export function parseAgentBridgeLine(
  line: string | Buffer,
  maxPayloadBytes = MAX_AGENT_BRIDGE_PAYLOAD_BYTES
): AgentBridgeRequest {
  const bytes = Buffer.isBuffer(line) ? line : Buffer.from(line, 'utf8')
  if (bytes.length > maxPayloadBytes) return protocolError('PAYLOAD_TOO_LARGE', 'Message exceeds the payload limit.')
  const text = bytes.toString('utf8').replace(/\r$/u, '')
  if (text.trim().length === 0) return protocolError('INVALID_REQUEST', 'Empty request.')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return protocolError('INVALID_JSON', 'Request is not valid JSON.')
  }
  return validateAgentBridgeRequest(value)
}

export const parseAgentBridgeRequest = parseAgentBridgeLine
export const serializeAgentBridgeRequest = serializeAgentBridgeMessage
export const serializeAgentBridgeResponse = serializeAgentBridgeMessage
export const validateTimeout = parseAgentBridgeTimeout

function credentialsMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function responseError(code: string, message: string, id?: string): AgentBridgeErrorResponse {
  return { ok: false, ...(id === undefined ? {} : { id }), error: { code, message } }
}

async function dispatchRequest(
  request: AgentBridgeRequest,
  handlers: AgentBridgeHandlers,
  signal: AbortSignal,
): Promise<AgentBridgeSuccessResponse | AgentBridgeErrorResponse> {
  const handler = handlers[request.type] as AgentBridgeHandler | undefined
  if (!handler) return responseError('NOT_IMPLEMENTED', 'This bridge operation is unavailable.', request.id)
  try {
    const result = await handler(request, { signal })
    return { ok: true, ...(request.id === undefined ? {} : { id: request.id }), result }
  } catch {
    return responseError('HANDLER_ERROR', 'The bridge operation failed.', request.id)
  }
}

function handleSocket(socket: Socket, options: AgentBridgeServerOptions): void {
  const maxPayloadBytes = options.maxPayloadBytes ?? MAX_AGENT_BRIDGE_PAYLOAD_BYTES
  let pending = Buffer.alloc(0)
  let closed = false
  let queue = Promise.resolve()
  const controller = new AbortController()

  const closeInvalid = (error: AgentBridgeProtocolError, id?: string) => {
    if (closed) return
    closed = true
    controller.abort()
    socket.end(serializeAgentBridgeMessage(responseError(error.code, error.message, id), maxPayloadBytes))
  }

  const processLine = (line: Buffer) => {
    let request: AgentBridgeRequest
    try {
      request = parseAgentBridgeLine(line, maxPayloadBytes)
    } catch (error) {
      closeInvalid(error instanceof AgentBridgeProtocolError ? error : new AgentBridgeProtocolError('INVALID_REQUEST', 'Invalid request.'))
      return
    }
    if (!credentialsMatch(request.token, options.token) || !credentialsMatch(request.sessionId, options.sessionId)) {
      closeInvalid(new AgentBridgeProtocolError('UNAUTHORIZED', 'Bridge authentication failed.'), request.id)
      return
    }
    queue = queue.then(async () => {
      if (closed || socket.destroyed || controller.signal.aborted) return
      const response = await dispatchRequest(request, options.handlers, controller.signal)
      if (!closed) socket.write(serializeAgentBridgeMessage(response, maxPayloadBytes))
    })
    queue.catch(() => closeInvalid(new AgentBridgeProtocolError('INTERNAL_ERROR', 'Bridge request failed.')))
  }

  socket.setNoDelay(true)
  socket.on('data', (chunk: Buffer) => {
    if (closed) return
    pending = Buffer.concat([pending, chunk])
    if (pending.length > maxPayloadBytes && !pending.includes(0x0a)) {
      closeInvalid(new AgentBridgeProtocolError('PAYLOAD_TOO_LARGE', 'Message exceeds the payload limit.'))
      return
    }
    let newlineIndex = pending.indexOf(0x0a)
    while (newlineIndex !== -1 && !closed) {
      const line = pending.subarray(0, newlineIndex)
      pending = pending.subarray(newlineIndex + 1)
      if (line.length > maxPayloadBytes) {
        closeInvalid(new AgentBridgeProtocolError('PAYLOAD_TOO_LARGE', 'Message exceeds the payload limit.'))
        return
      }
      processLine(line)
      newlineIndex = pending.indexOf(0x0a)
    }
    if (pending.length > maxPayloadBytes) {
      closeInvalid(new AgentBridgeProtocolError('PAYLOAD_TOO_LARGE', 'Message exceeds the payload limit.'))
    }
  })
  socket.on('error', () => { closed = true; controller.abort() })
  socket.on('close', () => { closed = true; controller.abort() })
}

export function createAgentBridgeServer(options: AgentBridgeServerOptions): Server {
  if (typeof options.pipeName !== 'string' || options.pipeName.trim().length === 0) {
    throw new AgentBridgeProtocolError('INVALID_CONFIGURATION', 'Bridge pipe name is required.')
  }
  validateCredential(options.token, 'token')
  validateCredential(options.sessionId, 'sessionId')
  if (!options.handlers || typeof options.handlers !== 'object') {
    throw new AgentBridgeProtocolError('INVALID_CONFIGURATION', 'Bridge handlers are required.')
  }
  const maxPayloadBytes = options.maxPayloadBytes ?? MAX_AGENT_BRIDGE_PAYLOAD_BYTES
  if (!Number.isInteger(maxPayloadBytes) || maxPayloadBytes < 1024 || maxPayloadBytes > MAX_AGENT_BRIDGE_PAYLOAD_BYTES) {
    throw new AgentBridgeProtocolError('INVALID_CONFIGURATION', 'Bridge payload limit is invalid.')
  }
  const server = createServer((socket) => handleSocket(socket, { ...options, maxPayloadBytes }))
  server.listen(options.pipeName)
  return server
}
