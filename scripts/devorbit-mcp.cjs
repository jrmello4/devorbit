/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const readline = require('node:readline')
const { DEFAULT_TIMEOUT_MS, bridgeContextFromEnv, callBridge } = require('./devorbit-bridge.cjs')

const BRIDGE_PING_TIMEOUT_MS = 8_000
const BRIDGE_ERROR_RPC_CODE = -32_001
const MAX_HANDSHAKE_ID_CHARS = 128
const MAX_SAFE_ID_CHARS = 128
const MAX_SAFE_ELAPSED_MS = 60 * 60 * 1000
const MIN_SAFE_EXIT_CODE = -2_147_483_648
const MAX_SAFE_EXIT_CODE = 4_294_967_295
const DIRECT_ERROR_CODES = new Set([
  'BRIDGE_ENV_MISSING',
  'BRIDGE_AUTH_REJECTED',
  'BRIDGE_SESSION_MISMATCH',
  'BRIDGE_UNREACHABLE',
  'MCP_NOT_INITIALIZED',
  'MCP_STARTUP_FAILED',
])
const KNOWN_ERROR_CODES = new Set([
  'BRIDGE_ENV_MISSING',
  'BRIDGE_AUTH_REJECTED',
  'BRIDGE_SESSION_MISMATCH',
  'BRIDGE_UNREACHABLE',
  'MCP_NOT_INITIALIZED',
  'MCP_STARTUP_FAILED',
  'BRIDGE_REQUEST_REJECTED',
  'INVALID_REQUEST',
  'INVALID_JSON',
  'INVALID_TARGET',
  'INVALID_PROMPT',
  'INVALID_TIMEOUT',
  'INVALID_GUARD',
  'CYCLE_BLOCKED',
  'TARGET_NOT_ALLOWED',
  'NOT_IMPLEMENTED',
  'HANDLER_ERROR',
  'SELF_DELEGATION_NOT_ALLOWED',
  'CALLER_IDENTITY_REQUIRED',
  'CALLER_IDENTITY_STALE',
])
const ERROR_MESSAGES = Object.freeze({
  AGENT_NOT_READY: 'The worker is not ready.',
  AGENT_STARTUP_FAILED: 'The worker failed during startup.',
  PROVIDER_STARTUP_FAILED: 'The worker provider failed to start.',
  INSTRUCTION_DELIVERY_FAILED: 'Instruction delivery failed.',
  INSTRUCTION_ACK_TIMEOUT: 'Instruction acknowledgement timed out.',
  RESULT_TIMEOUT: 'The worker result timed out.',
  TERMINAL_EXITED: 'The worker terminal exited.',
  RESULT_MARKER_MISSING: 'Worker output did not contain the expected result.',
  RESULT_PARSE_FAILED: 'The worker result is invalid.',
  ECHO_ONLY: 'Only instruction echo was observed.',
  CANCELLED: 'The worker turn was cancelled.',
  AGENT_REPORTED_FAILURE: 'The worker reported failure.',
  BRIDGE_ENV_MISSING: 'DevOrbit bridge environment is incomplete.',
  BRIDGE_AUTH_REJECTED: 'Bridge authentication failed.',
  BRIDGE_SESSION_MISMATCH: 'Bridge session mismatch.',
  BRIDGE_UNREACHABLE: 'DevOrbit bridge is unreachable.',
  MCP_NOT_INITIALIZED: 'MCP initialize must complete before tools are used.',
  MCP_STARTUP_FAILED: 'MCP bridge initialization failed.',
  BRIDGE_REQUEST_REJECTED: 'Bridge request failed.',
  INVALID_REQUEST: 'Bridge request is invalid.',
  INVALID_JSON: 'Bridge request is invalid.',
  INVALID_TARGET: 'Target is invalid.',
  INVALID_PROMPT: 'Prompt is invalid.',
  INVALID_TIMEOUT: 'Timeout is invalid.',
  INVALID_GUARD: 'Delegation guard is invalid.',
  CYCLE_BLOCKED: 'Delegation cycle blocked.',
  TARGET_NOT_ALLOWED: 'Target is not allowed.',
  NOT_IMPLEMENTED: 'Bridge operation is unavailable.',
  HANDLER_ERROR: 'Bridge operation failed.',
  SELF_DELEGATION_NOT_ALLOWED: 'Self-delegation is not allowed.',
  CALLER_IDENTITY_REQUIRED: 'Bridge caller identity is required.',
  CALLER_IDENTITY_STALE: 'Bridge caller identity is stale.',
})
const SAFE_PHASES = new Set([
  'request_received', 'request_validated', 'request_rejected', 'bridge_request', 'bridge_response',
  'target_validation',
  'task_created', 'target_resolved', 'target_state_checked', 'instruction_prepared',
  'queued', 'waiting_ready', 'content_written', 'submit_sent', 'awaiting_ack', 'retry_submit', 'acked',
  'provider_running', 'provider_output_seen', 'result_marker_seen', 'result_parsed',
  'result_candidate', 'nonce_matched',
  'turn_started', 'turn_completed', 'turn_failed', 'provider_startup_failed',
  'agent_not_ready',
  'instruction_delivery_failed', 'instruction_ack_timeout', 'result_timeout', 'terminal_exited',
  'result_marker_missing', 'result_parse_failed', 'echo_only', 'cancelled', 'agent_reported_failure',
  'completed', 'blocked', 'failed',
])
const SAFE_PROVIDER_IDS = new Set([
  'codex', 'opencode', 'opencode2', 'claude', 'gemini', 'aider', 'agy', 'command-code', 'custom', 'unknown',
])
const SAFE_PROVIDER_STATES = new Set(['starting', 'ready', 'busy', 'failed', 'stopped', 'unavailable', 'unknown'])
const SAFE_MARKER_STATES = new Set(['missing', 'not_seen', 'seen', 'present', 'invalid', 'parsed', 'valid', 'completed', 'unknown'])
const SAFE_NONCE_STATES = new Set(['missing', 'not_seen', 'seen', 'matched', 'unmatched', 'mismatched', 'invalid', 'unknown'])
const SAFE_AGENT_STATUSES = new Set(['starting', 'ready', 'busy', 'failed', 'stopped'])
const SAFE_STARTUP_FAILURE_CODES = new Set([
  'AGENT_STARTUP_TIMEOUT', 'AGENT_STARTUP_PROVIDER_ERROR', 'AGENT_STARTUP_CONFIGURATION_INVALID',
  'AGENT_STARTUP_AUTH_FAILED', 'AGENT_STARTUP_CLI_NOT_FOUND',
])
for (const code of Object.keys(ERROR_MESSAGES)) KNOWN_ERROR_CODES.add(code)

const tools = [
  { name: 'agent.list', description: 'Lista os agentes ativos do DevOrbit.', inputSchema: { type: 'object', properties: {} } },
  { name: 'agent.send', description: 'Envia uma tarefa a um agente ativo.', inputSchema: { type: 'object', required: ['target', 'prompt'], properties: { target: { type: 'string' }, prompt: { type: 'string' } } } },
  { name: 'agent.wait', description: 'Aguarda o resultado estruturado de um agente.', inputSchema: { type: 'object', required: ['target'], properties: { target: { type: 'string' }, timeoutMs: { type: 'number' } } } },
  { name: 'agent.ask', description: 'Envia uma tarefa e aguarda o resultado.', inputSchema: { type: 'object', required: ['target', 'prompt'], properties: { target: { type: 'string' }, prompt: { type: 'string' }, timeoutMs: { type: 'number' } } } },
  { name: 'agent.run', description: 'Executa um turno não-interativo (print mode) e retorna o resultado estruturado.', inputSchema: { type: 'object', required: ['target', 'prompt'], properties: { target: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' }, mode: { type: 'string' }, effort: { type: 'string' }, agent: { type: 'string' }, timeoutMs: { type: 'number' } } } },
]

function response(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function error(id, code, message, data) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeIdentifier(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SAFE_ID_CHARS) return undefined
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value) ? value : undefined
}

function safeInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined
}

function diagnosticRecord(value) {
  if (!isRecord(value)) return {}
  if (isRecord(value.diagnostic)) return value.diagnostic
  if (isRecord(value.data) && isRecord(value.data.diagnostic)) return value.data.diagnostic
  return value
}

function safeDiagnostic(value) {
  const source = diagnosticRecord(value)
  const output = {}
  if (SAFE_PHASES.has(source.phase)) output.phase = source.phase
  const turnId = safeIdentifier(source.turnId)
  if (turnId !== undefined) output.turnId = turnId
  if (SAFE_PROVIDER_IDS.has(source.provider)) output.provider = source.provider
  const elapsedMs = safeInteger(source.elapsedMs, 0, MAX_SAFE_ELAPSED_MS)
  if (elapsedMs !== undefined) output.elapsedMs = elapsedMs
  const agentId = safeIdentifier(source.agentId)
  if (agentId !== undefined) output.agentId = agentId
  const requestId = safeIdentifier(source.requestId)
  if (requestId !== undefined) output.requestId = requestId
  if (SAFE_AGENT_STATUSES.has(source.status)) output.status = source.status
  if (SAFE_STARTUP_FAILURE_CODES.has(source.failureCode)) output.failureCode = source.failureCode
  if (typeof source.operational === 'boolean') output.operational = source.operational
  if (typeof source.turnCreated === 'boolean') output.turnCreated = source.turnCreated
  if (SAFE_PROVIDER_STATES.has(source.providerState)) output.providerState = source.providerState
  if (SAFE_MARKER_STATES.has(source.markerState)) output.markerState = source.markerState
  if (SAFE_NONCE_STATES.has(source.nonceState)) output.nonceState = source.nonceState
  const exitCode = safeInteger(source.exitCode, MIN_SAFE_EXIT_CODE, MAX_SAFE_EXIT_CODE)
  if (exitCode !== undefined) output.exitCode = exitCode
  return output
}

function knownCode(value) {
  return typeof value === 'string' && KNOWN_ERROR_CODES.has(value) ? value : undefined
}

function createMcpError(errorCode, options = {}) {
  const normalizedErrorCode = knownCode(errorCode) ?? 'BRIDGE_REQUEST_REJECTED'
  const normalizedCode = knownCode(options.code)
    ?? (DIRECT_ERROR_CODES.has(normalizedErrorCode) ? normalizedErrorCode : 'BRIDGE_REQUEST_REJECTED')
  const cause = new Error(ERROR_MESSAGES[normalizedErrorCode] ?? ERROR_MESSAGES.BRIDGE_REQUEST_REJECTED)
  cause.code = normalizedCode
  cause.errorCode = normalizedErrorCode
  cause.diagnostic = safeDiagnostic(options.diagnostic)
  return cause
}

function safeError(cause, fallbackCode = 'MCP_STARTUP_FAILED') {
  const fallback = knownCode(fallbackCode) ?? 'MCP_STARTUP_FAILED'
  const errorCode = knownCode(cause && cause.errorCode)
    ?? knownCode(cause && cause.code)
    ?? fallback
  const code = knownCode(cause && cause.code)
    ?? (DIRECT_ERROR_CODES.has(errorCode) ? errorCode : fallback)
  return createMcpError(errorCode, { code, diagnostic: cause && cause.diagnostic })
}

function bridgeEnvironment(env) {
  const pipeName = env && typeof env.DEVORBIT_BRIDGE_PIPE === 'string' ? env.DEVORBIT_BRIDGE_PIPE : ''
  const token = env && typeof env.DEVORBIT_BRIDGE_TOKEN === 'string' ? env.DEVORBIT_BRIDGE_TOKEN : ''
  const sessionId = env && typeof env.DEVORBIT_SESSION_ID === 'string' ? env.DEVORBIT_SESSION_ID : ''
  if (!pipeName.trim() || !token || !sessionId) throw createMcpError('BRIDGE_ENV_MISSING')
  return { pipeName, token, sessionId }
}

function bridgeResponseError(result, fallbackCode = 'BRIDGE_REQUEST_REJECTED') {
  const bridgeError = result && isRecord(result.error) ? result.error : {}
  const data = isRecord(bridgeError.data) ? bridgeError.data : {}
  const errorCode = knownCode(data.errorCode) ?? knownCode(data.code) ?? knownCode(bridgeError.code) ?? fallbackCode
  const code = DIRECT_ERROR_CODES.has(errorCode) ? errorCode : fallbackCode
  return createMcpError(errorCode, { code, diagnostic: data })
}

function bridgeResultError(result, fallbackCode = 'BRIDGE_REQUEST_REJECTED') {
  if (!result || !isRecord(result.result) || result.result.status !== 'failed') return undefined
  const data = result.result
  const errorCode = knownCode(data.errorCode) ?? fallbackCode
  return createMcpError(errorCode, { code: fallbackCode, diagnostic: data.diagnostic ?? data })
}

function failureContent(cause) {
  const errorCode = knownCode(cause && cause.errorCode)
    ?? knownCode(cause && cause.code)
    ?? 'BRIDGE_REQUEST_REJECTED'
  const code = errorCode
  const diagnostic = safeDiagnostic(cause && cause.diagnostic)
  const beforeTurn = diagnostic.phase === 'target_validation'
  const envelope = {
    code,
    errorCode,
    phase: diagnostic.phase ?? 'request_rejected',
    ...(!beforeTurn ? { turnId: diagnostic.turnId ?? 'unknown' } : {}),
    ...(diagnostic.provider !== undefined ? { provider: diagnostic.provider } : beforeTurn ? {} : { provider: 'unknown' }),
    ...(diagnostic.elapsedMs !== undefined ? { elapsedMs: diagnostic.elapsedMs } : beforeTurn ? {} : { elapsedMs: 0 }),
    ...Object.fromEntries(Object.entries(diagnostic).filter(([key]) => !['phase', 'turnId', 'provider', 'elapsedMs'].includes(key))),
  }
  return envelope
}

function bridgeRequest(name, args) {
  const [type, command] = name.split('.')
  const request = {
    type: command,
    ...bridgeContextFromEnv(process.env),
    ...(managedLaunch ? {
      origin: managedLaunch.terminalId,
      originTerminalId: managedLaunch.terminalId,
      originLaunchId: managedLaunch.launchId,
    } : {}),
  }
  if (type !== 'agent') throw createMcpError('BRIDGE_REQUEST_REJECTED')
  if (args.target !== undefined) request.target = args.target
  if (args.prompt !== undefined) request.prompt = args.prompt
  for (const key of ['model', 'mode', 'effort', 'agent']) {
    if (args[key] !== undefined) request[key] = args[key]
  }
  if (args.timeoutMs !== undefined) request.timeoutMs = args.timeoutMs
  else if (command === 'ask' || command === 'wait' || command === 'run') request.timeoutMs = DEFAULT_TIMEOUT_MS
  const credentials = bridgeEnvironment(process.env)
  return callBridge(credentials.pipeName, credentials.token, credentials.sessionId, request).then((result) => {
    if (!result || result.ok !== true) throw bridgeResponseError(result)
    const failure = bridgeResultError(result)
    if (failure) throw failure
    return result
  })
}

function pingBridge() {
  const credentials = bridgeEnvironment(process.env)
  return callBridge(credentials.pipeName, credentials.token, credentials.sessionId, { type: 'ping' }, BRIDGE_PING_TIMEOUT_MS).then((result) => {
    if (!result || result.ok !== true) throw bridgeResponseError(result, 'BRIDGE_UNREACHABLE')
    return result
  })
}

function isSafeHandshakeIdentifier(value) {
  if (typeof value !== 'string') return false
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 31 || code === 127) return false
  }
  return typeof value === 'string'
    && value.trim().length > 0
    && value.trim().length <= MAX_HANDSHAKE_ID_CHARS
}

function parseMcpLaunchArgs(argv = process.argv.slice(2)) {
  let terminalId
  let launchId
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--terminal-id' || argument === '--launch-id') {
      const value = argv[index + 1]
      index += 1
      if (argument === '--terminal-id' && isSafeHandshakeIdentifier(value)) terminalId = value.trim()
      if (argument === '--launch-id' && isSafeHandshakeIdentifier(value)) launchId = value.trim()
      continue
    }
    if (argument.startsWith('--terminal-id=')) {
      const value = argument.slice('--terminal-id='.length)
      if (isSafeHandshakeIdentifier(value)) terminalId = value.trim()
    } else if (argument.startsWith('--launch-id=')) {
      const value = argument.slice('--launch-id='.length)
      if (isSafeHandshakeIdentifier(value)) launchId = value.trim()
    }
  }
  return terminalId && launchId ? { terminalId, launchId } : undefined
}

const managedLaunch = parseMcpLaunchArgs()

function sendMcpHandshake() {
  const launch = parseMcpLaunchArgs()
  if (!launch) return Promise.resolve()
  const credentials = bridgeEnvironment(process.env)
  return callBridge(credentials.pipeName, credentials.token, credentials.sessionId, {
    type: 'mcp-handshake',
    terminalId: launch.terminalId,
    launchId: launch.launchId,
    pid: process.pid,
  }, BRIDGE_PING_TIMEOUT_MS).then((result) => {
    if (!result || result.ok !== true) throw createMcpError('MCP_STARTUP_FAILED')
  }).catch((cause) => {
    if (cause && cause.code === 'BRIDGE_ENV_MISSING') throw cause
    throw createMcpError('MCP_STARTUP_FAILED')
  })
}

function getMcpVersion() {
  try {
    const fs = require('node:fs')
    const path = require('node:path')
    const candidates = [
      path.join(__dirname, '..', 'app.asar', 'package.json'),
      path.join(__dirname, '..', 'package.json'),
      path.join(__dirname, 'package.json'),
      path.join(process.cwd(), 'package.json'),
    ]
    for (const pkgPath of candidates) {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) return pkg.version.trim()
      }
    }
  } catch {
    /* fallback to default */
  }
  return '1.0.46'
}

let initialized = false
let handshakeComplete = false
let handshakePromise = null
let pendingInitializations = 0
let initializationQueue = Promise.resolve()

function triggerHandshake() {
  if (!managedLaunch) {
    handshakeComplete = true
    return Promise.resolve()
  }
  if (!handshakePromise) {
    handshakePromise = sendMcpHandshake().then(() => {
      handshakeComplete = true
    }).catch(() => {
      handshakeComplete = false
    })
  }
  return handshakePromise
}

function initializeBridge() {
  pendingInitializations += 1
  const next = initializationQueue.then(async () => {
    try {
      initialized = false
      handshakeComplete = false
      handshakePromise = null
      await pingBridge()
      if (managedLaunch) {
        // A managed MCP must prove its launch identity before initialize is
        // acknowledged. This keeps required MCP startup fail-closed while
        // leaving the agent registry free to become non-empty later.
        handshakePromise = sendMcpHandshake()
        await handshakePromise
      }
      initialized = true
      handshakeComplete = true
    } finally {
      pendingInitializations -= 1
    }
  })
  initializationQueue = next.catch(() => undefined)
  return next
}

async function requireInitialized() {
  if (pendingInitializations > 0) await initializationQueue
  if (!initialized) throw createMcpError('MCP_NOT_INITIALIZED')
  if (managedLaunch) {
    if (handshakePromise) await handshakePromise
    if (!handshakeComplete) throw createMcpError('MCP_STARTUP_FAILED')
  }
}

async function handle(request) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return error(null, -32600, 'Invalid Request.')
  const hasId = Object.prototype.hasOwnProperty.call(request, 'id')
  if (request.method === 'initialize') {
    const initialization = initializeBridge()
    try {
      await initialization
      return hasId ? response(request.id, { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'DevOrbit MCP', version: getMcpVersion() } }) : undefined
    } catch (cause) {
      const failure = safeError(cause)
      return hasId ? error(request.id, BRIDGE_ERROR_RPC_CODE, failure.message, { code: failure.code }) : undefined
    }
  }
  if (request.method === 'notifications/initialized') {
    if (pendingInitializations > 0) await initializationQueue
    if (!initialized) return undefined
    if (managedLaunch) {
      await triggerHandshake()
    }
    return undefined
  }
  if (request.method === 'tools/list') {
    try {
      await requireInitialized()
    } catch (cause) {
      const failure = safeError(cause, 'MCP_NOT_INITIALIZED')
      return hasId ? error(request.id, BRIDGE_ERROR_RPC_CODE, failure.message, { code: failure.code }) : undefined
    }
    return hasId ? response(request.id, { tools }) : undefined
  }
  if (request.method !== 'tools/call') return error(hasId ? request.id : null, -32601, 'Method not found.')
  try {
    await requireInitialized()
    const params = request.params && typeof request.params === 'object' ? request.params : {}
    const name = params.name
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {}
    if (!tools.some((tool) => tool.name === name)) return error(hasId ? request.id : null, -32602, 'Unknown tool.')
    if (!hasId) {
      await bridgeRequest(name, args)
      return undefined
    }
    const bridge = await bridgeRequest(name, args)
    const data = bridge.result === undefined ? null : bridge.result
    return response(request.id, { content: [{ type: 'text', text: JSON.stringify(data) }], ...(data && typeof data === 'object' && !Array.isArray(data) ? { structuredContent: data } : {}) })
  } catch (cause) {
    const failure = safeError(cause, cause && cause.code === 'MCP_NOT_INITIALIZED' ? 'MCP_NOT_INITIALIZED' : 'BRIDGE_REQUEST_REJECTED')
    if (!hasId) return undefined
    const content = failureContent(failure)
    return response(request.id, {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(content) }],
      structuredContent: content,
    })
  }
}

if (require.main === module) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', (line) => {
    void Promise.resolve().then(() => JSON.parse(line)).then(handle).then((value) => {
      if (value !== undefined) process.stdout.write(`${value}\n`)
    }).catch((cause) => {
      const code = cause instanceof SyntaxError ? -32700 : -32603
      process.stdout.write(`${error(null, code, cause instanceof SyntaxError ? 'Parse error.' : 'Internal error.')}\n`)
    })
  })
}

module.exports = {
  BRIDGE_PING_TIMEOUT_MS,
  getMcpVersion,
}
