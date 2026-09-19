/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const readline = require('node:readline')
const { DEFAULT_TIMEOUT_MS, bridgeContextFromEnv, callBridge } = require('./devorbit-bridge.cjs')

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

function error(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}

function bridgeRequest(name, args) {
  const [type, command] = name.split('.')
  const request = { type: command, ...bridgeContextFromEnv(process.env) }
  if (type !== 'agent') throw new Error('Ferramenta MCP desconhecida.')
  if (args.target !== undefined) request.target = args.target
  if (args.prompt !== undefined) request.prompt = args.prompt
  for (const key of ['model', 'mode', 'effort', 'agent']) {
    if (args[key] !== undefined) request[key] = args[key]
  }
  if (args.timeoutMs !== undefined) request.timeoutMs = args.timeoutMs
  else if (command === 'ask' || command === 'wait' || command === 'run') request.timeoutMs = DEFAULT_TIMEOUT_MS
  const env = process.env
  if (!env.DEVORBIT_BRIDGE_PIPE || !env.DEVORBIT_BRIDGE_TOKEN || !env.DEVORBIT_SESSION_ID) {
    throw new Error('Ambiente do bridge não configurado.')
  }
  return callBridge(env.DEVORBIT_BRIDGE_PIPE, env.DEVORBIT_BRIDGE_TOKEN, env.DEVORBIT_SESSION_ID, request)
}

function getMcpVersion() {
  try {
    const fs = require('node:fs')
    const path = require('node:path')
    const candidates = [
      path.join(__dirname, '..', 'package.json'),
      path.join(__dirname, 'package.json'),
      path.join(process.cwd(), 'package.json'),
    ]
    for (const pkgPath of candidates) {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) {
          return pkg.version.trim()
        }
      }
    }
  } catch {
    /* fallback to default */
  }
  return '1.0.31'
}

async function handle(request) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return error(null, -32600, 'Invalid Request.')
  const hasId = Object.prototype.hasOwnProperty.call(request, 'id')
  if (request.method === 'initialize') return hasId ? response(request.id, { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'DevOrbit MCP', version: getMcpVersion() } }) : undefined
  if (request.method === 'notifications/initialized') return undefined
  if (request.method === 'tools/list') return hasId ? response(request.id, { tools }) : undefined
  if (request.method !== 'tools/call') return error(hasId ? request.id : null, -32601, 'Method not found.')
  const params = request.params && typeof request.params === 'object' ? request.params : {}
  const name = params.name
  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {}
  if (!tools.some((tool) => tool.name === name)) return error(hasId ? request.id : null, -32602, 'Unknown tool.')
  try {
    if (!hasId) {
      await bridgeRequest(name, args)
      return undefined
    }
    const bridge = await bridgeRequest(name, args)
    if (!bridge.ok) return response(request.id, { isError: true, content: [{ type: 'text', text: bridge.error?.message || 'Bridge request failed.' }] })
    const data = bridge.result === undefined ? null : bridge.result
    return response(request.id, { content: [{ type: 'text', text: JSON.stringify(data) }], ...(data && typeof data === 'object' && !Array.isArray(data) ? { structuredContent: data } : {}) })
  } catch (cause) {
    return response(request.id ?? null, { isError: true, content: [{ type: 'text', text: cause?.message || String(cause) }] })
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  void Promise.resolve().then(() => JSON.parse(line)).then(handle).then((value) => {
    if (value !== undefined) process.stdout.write(`${value}\n`)
  }).catch((cause) => process.stdout.write(`${error(null, cause instanceof SyntaxError ? -32700 : -32603, cause?.message || String(cause))}\n`))
})
