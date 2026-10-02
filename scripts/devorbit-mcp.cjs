/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const readline = require('node:readline')
const { DEFAULT_TIMEOUT_MS, bridgeContextFromEnv, callBridge } = require('./devorbit-bridge.cjs')

const BRIDGE_PING_TIMEOUT_MS = 8_000
const BRIDGE_ERROR_RPC_CODE = -32_001
const MAX_HANDSHAKE_ID_CHARS = 128
const KNOWN_ERROR_CODES = new Set([
  'BRIDGE_ENV_MISSING',
  'BRIDGE_AUTH_REJECTED',
  'BRIDGE_SESSION_MISMATCH',
  'BRIDGE_UNREACHABLE',
  'MCP_NOT_INITIALIZED',
  'MCP_STARTUP_FAILED',
  'BRIDGE_REQUEST_REJECTED',
])
const ERROR_MESSAGES = Object.freeze({
  BRIDGE_ENV_MISSING: 'DevOrbit bridge environment is incomplete.',
  BRIDGE_AUTH_REJECTED: 'Bridge authentication failed.',
  BRIDGE_SESSION_MISMATCH: 'Bridge session mismatch.',
  BRIDGE_UNREACHABLE: 'DevOrbit bridge is unreachable.',
  MCP_NOT_INITIALIZED: 'MCP initialize must complete before tools are used.',
  MCP_STARTUP_FAILED: 'MCP bridge initialization failed.',
  BRIDGE_REQUEST_REJECTED: 'Bridge request failed.',
})

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

function createMcpError(code) {
  const normalized = KNOWN_ERROR_CODES.has(code) ? code : 'BRIDGE_REQUEST_REJECTED'
  const cause = new Error(ERROR_MESSAGES[normalized])
  cause.code = normalized
  return cause
}

function safeError(cause, fallbackCode = 'MCP_STARTUP_FAILED') {
  if (cause && typeof cause.code === 'string' && KNOWN_ERROR_CODES.has(cause.code)) return createMcpError(cause.code)
  return createMcpError(fallbackCode)
}

function bridgeEnvironment(env) {
  const pipeName = env && typeof env.DEVORBIT_BRIDGE_PIPE === 'string' ? env.DEVORBIT_BRIDGE_PIPE : ''
  const token = env && typeof env.DEVORBIT_BRIDGE_TOKEN === 'string' ? env.DEVORBIT_BRIDGE_TOKEN : ''
  const sessionId = env && typeof env.DEVORBIT_SESSION_ID === 'string' ? env.DEVORBIT_SESSION_ID : ''
  if (!pipeName.trim() || !token || !sessionId) throw createMcpError('BRIDGE_ENV_MISSING')
  return { pipeName, token, sessionId }
}

function bridgeResponseError(result, fallbackCode = 'BRIDGE_REQUEST_REJECTED') {
  const code = result && result.error && typeof result.error.code === 'string'
    ? result.error.code
    : 'BRIDGE_REQUEST_REJECTED'
  if (code === 'BRIDGE_AUTH_REJECTED' || code === 'BRIDGE_SESSION_MISMATCH') return createMcpError(code)
  return createMcpError(code === 'BRIDGE_UNREACHABLE' ? code : fallbackCode)
}

function bridgeRequest(name, args) {
  const [type, command] = name.split('.')
  const request = { type: command, ...bridgeContextFromEnv(process.env) }
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
    return response(request.id, { isError: true, content: [{ type: 'text', text: failure.message }] })
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
