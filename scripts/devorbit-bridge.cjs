/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const net = require('node:net')

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const MAX_TIMEOUT_MS = 60 * 60 * 1000
const MAX_RESPONSE_BYTES = 64 * 1024

function usageError(message) {
  const error = new Error(message)
  error.code = 'USAGE'
  return error
}

function parseTimeout(value) {
  if (typeof value !== 'string' || !/^([1-9]\d*)(ms|s|m|h)$/i.test(value.trim())) {
    throw usageError('Invalid timeout. Use a positive duration such as 5m.')
  }
  const [, amountText, unit] = /^([1-9]\d*)(ms|s|m|h)$/i.exec(value.trim())
  const amount = Number(amountText)
  const multiplier = { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit.toLowerCase()]
  const result = amount * multiplier
  if (!Number.isSafeInteger(result) || result > MAX_TIMEOUT_MS) {
    throw usageError('Invalid timeout. The maximum is 1h.')
  }
  return result
}

function requireTarget(value) {
  if (!value || value.startsWith('-')) throw usageError('A target is required.')
  return value
}

function requirePrompt(value) {
  if (!value) throw usageError('A prompt is required.')
  return value
}

function bridgeContextFromEnv(env) {
  const context = {}
  if (typeof env.DEVORBIT_BRIDGE_ORIGIN === 'string' && env.DEVORBIT_BRIDGE_ORIGIN) {
    context.origin = env.DEVORBIT_BRIDGE_ORIGIN
  }
  if (typeof env.DEVORBIT_BRIDGE_DEPTH === 'string' && /^\d+$/.test(env.DEVORBIT_BRIDGE_DEPTH)) {
    context.depth = Number(env.DEVORBIT_BRIDGE_DEPTH)
  }
  if (typeof env.DEVORBIT_BRIDGE_VISITED === 'string') {
    try {
      const visited = JSON.parse(env.DEVORBIT_BRIDGE_VISITED)
      if (Array.isArray(visited)) context.visited = visited
    } catch {
      // Contexto inválido é descartado; o bridge valida todo valor repassado.
    }
  }
  return context
}

function parseAgentBridgeCliArgs(argv) {
  if (argv[0] !== 'agent') throw usageError('Usage: devorbit agent <list|send|wait|ask> ...')
  const command = argv[1]
  if (command === 'list') {
    if (argv.length > 3 || (argv[2] && argv[2] !== '--json')) throw usageError('Usage: devorbit agent list [--json]')
    return { command: 'list', json: argv[2] === '--json' }
  }
  if (command === 'send') {
    if (argv.length !== 4) throw usageError('Usage: devorbit agent send <target> <prompt>')
    return { command: 'send', target: requireTarget(argv[2]), prompt: requirePrompt(argv[3]) }
  }
  if (command === 'wait') {
    if (argv.length < 3 || argv.length > 5) throw usageError('Usage: devorbit agent wait <target> [--timeout 5m]')
    const target = requireTarget(argv[2])
    let timeoutMs = DEFAULT_TIMEOUT_MS
    if (argv.length === 4 || argv.length === 5) {
      if (argv[3] !== '--timeout' || !argv[4]) throw usageError('Usage: devorbit agent wait <target> [--timeout 5m]')
      timeoutMs = parseTimeout(argv[4])
    }
    return { command: 'wait', target, timeoutMs }
  }
  if (command === 'ask') {
    if (argv.length < 4 || argv.length > 5) throw usageError('Usage: devorbit agent ask <target> <prompt> [--json]')
    const target = requireTarget(argv[2])
    const prompt = requirePrompt(argv[3])
    if (argv[4] && argv[4] !== '--json') throw usageError('Usage: devorbit agent ask <target> <prompt> [--json]')
    return { command: 'ask', target, prompt, json: argv[4] === '--json' }
  }
  if (command === 'run') {
    if (argv.length < 4) {
      throw usageError('Usage: devorbit agent run <target> <prompt> [--model m] [--mode x] [--effort e] [--agent a] [--timeout 5m] [--json]')
    }
    const target = requireTarget(argv[2])
    const prompt = requirePrompt(argv[3])
    const options = { command: 'run', target, prompt }
    let index = 4
    while (index < argv.length) {
      const flag = argv[index]
      if (flag === '--json') {
        options.json = true
        index += 1
        continue
      }
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw usageError('Valor ausente para ' + flag)
      if (flag === '--model') options.model = value
      else if (flag === '--mode') options.mode = value
      else if (flag === '--effort') options.effort = value
      else if (flag === '--agent') options.agent = value
      else if (flag === '--timeout') options.timeoutMs = parseTimeout(value)
      else throw usageError('Opção desconhecida em run: ' + flag)
      index += 2
    }
    return options
  }
  throw usageError('Usage: devorbit agent <list|send|wait|ask|run> ...')
}

function serializeRequest(request) {
  const json = JSON.stringify(request)
  if (Buffer.byteLength(json, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('Bridge request is too large.')
  return `${json}\n`
}

function callBridge(pipeName, token, sessionId, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName)
    let pending = Buffer.alloc(0)
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error)
    }
    socket.setTimeout(request.timeoutMs ? request.timeoutMs + 1000 : 30000, () => fail(new Error('Bridge request timed out.')))
    socket.on('error', () => fail(new Error('Could not connect to the DevOrbit bridge.')))
    socket.on('data', (chunk) => {
      if (settled) return
      pending = Buffer.concat([pending, chunk])
      if (pending.length > MAX_RESPONSE_BYTES) return fail(new Error('Bridge response is too large.'))
      const newlineIndex = pending.indexOf(0x0a)
      if (newlineIndex === -1) return
      const line = pending.subarray(0, newlineIndex).toString('utf8').replace(/\r$/u, '')
      try {
        const response = JSON.parse(line)
        settled = true
        socket.end()
        resolve(response)
      } catch {
        fail(new Error('Bridge returned an invalid response.'))
      }
    })
    socket.on('connect', () => {
      try {
        socket.write(serializeRequest({ ...request, token, sessionId }))
      } catch (error) {
        fail(error)
      }
    })
  })
}

function printResponse(response, json) {
  if (!response || response.ok !== true) {
    const message = response && response.error && typeof response.error.message === 'string'
      ? response.error.message
      : 'Bridge request failed.'
    throw new Error(message)
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(response.result)}\n`)
    return
  }
  if (typeof response.result === 'string') process.stdout.write(`${response.result}\n`)
  else process.stdout.write(`${JSON.stringify(response.result)}\n`)
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const command = parseAgentBridgeCliArgs(argv)
  const pipeName = env.DEVORBIT_BRIDGE_PIPE
  const token = env.DEVORBIT_BRIDGE_TOKEN
  const sessionId = env.DEVORBIT_SESSION_ID
  if (!pipeName || !token || !sessionId) throw new Error('DevOrbit bridge environment is not configured.')

  const request = { type: command.command, ...bridgeContextFromEnv(env) }
  if (command.target) request.target = command.target
  if (command.prompt) request.prompt = command.prompt
  for (const key of ['model', 'mode', 'effort', 'agent']) {
    if (command[key] !== undefined) request[key] = command[key]
  }
  if (command.timeoutMs || command.command === 'ask' || command.command === 'run') {
    request.timeoutMs = command.timeoutMs || DEFAULT_TIMEOUT_MS
  }
  const response = await callBridge(pipeName, token, sessionId, request)
  printResponse(response, command.json === true)
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.message ? error.message : 'Bridge command failed.'}\n`)
    process.exitCode = error && error.code === 'USAGE' ? 2 : 1
  })
}

module.exports = { DEFAULT_TIMEOUT_MS, bridgeContextFromEnv, parseAgentBridgeCliArgs, parseTimeout, callBridge, main }
