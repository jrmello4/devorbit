/* eslint-disable @typescript-eslint/no-require-imports, no-undef, no-control-regex */
'use strict'

/**
 * verify-codex-bridge.cjs — E2E REAL do Codex gerenciado no DevOrbit.
 *
 * Execução: npx electron --in-process-gpu scripts/verify-codex-bridge.cjs
 *
 * Fases:
 *  TRANSPORT  — bridge real + MCP real (Electron RUN_AS_NODE) + workers fixture
 *               claramente rotulados como TRANSPORT-FIXTURE (nunca PASS live).
 *  CONTRACT   — prepareDevOrbitCodexLaunch: --config TOML, token só em env.
 *  REOPEN     — novo launchId supera o anterior; handshake velho é rejeitado.
 *  ROTATION   — runtime/token novos recusam credenciais antigas.
 *  REAL       — Codex CLI nativo real: workers e Coordinator por conta
 *               (.codex-conta1/.codex-conta2) + resume. Gated por
 *               DEVORBIT_CODEX_REAL_E2E=1 (opt-in; ausente/desligado não usa
 *               autenticação pessoal).
 *  SECURITY   — token/sessão/pipe nunca em argv, streams, config ou arquivos.
 *
 * Sem segredos em argv/logs/relatório. Não lê nem imprime auth.json.
 * Não edita config global, contas do usuário, src, package.json ou projetos.
 */

const electron = require('electron')
const { app } = electron
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')

const projectRoot = path.resolve(__dirname, '..')
const mcpScript = path.join(projectRoot, 'scripts', 'devorbit-mcp.cjs')
const bridgeCli = path.join(projectRoot, 'scripts', 'devorbit-bridge.cjs')
const emitRoot = path.join(projectRoot, 'node_modules', '.cache', `devorbit-codex-bridge-${process.pid}`)
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devorbit-codex-bridge-'))
const projectBasePath = path.resolve(process.env.DEVORBIT_CODEX_E2E_PROJECT || 'C:\\temp\\project-without-codex')
let projectPath = projectBasePath
const realEnabled = process.env.DEVORBIT_CODEX_REAL_E2E === '1'
const realTimeoutMs = Number(process.env.DEVORBIT_CODEX_E2E_TIMEOUT_MS || 300_000)
const keepScratch = process.env.DEVORBIT_CODEX_E2E_KEEP === '1'

const phases = []
const blockers = []
const secretSources = []
const secrets = new Map()
const liveChildren = new Set()
const cleanups = []
const spawnAudit = []
const streamsAudit = []
let nativeCodex = null
let npmCodexVersion = null
let appResolvedCodex = null

class BlockedError extends Error {
  constructor(message) {
    super(message)
    this.blocked = true
  }
}

function log(message) {
  process.stdout.write(`[verify-codex-bridge] ${message}\n`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function summarizeText(value, max = 400) {
  const text = String(value || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '').replace(/\s+/gu, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

async function phase(id, mode, fn) {
  const started = Date.now()
  try {
    const outcome = (await fn()) || {}
    const entry = {
      id,
      mode,
      status: outcome.status || 'PASS',
      detail: outcome.detail || '',
      ms: Date.now() - started,
    }
    phases.push(entry)
    log(`${entry.status} ${id}${entry.detail ? ` :: ${entry.detail}` : ''}`)
    return entry
  } catch (error) {
    const status = error instanceof BlockedError ? 'BLOCKED' : 'FAIL'
    const detail = error instanceof Error ? error.message : String(error)
    const entry = { id, mode, status, detail, ms: Date.now() - started }
    phases.push(entry)
    if (status === 'BLOCKED') blockers.push({ id, detail })
    log(`${status} ${id} :: ${detail}`)
    return entry
  }
}

function requireScratch(name) {
  const file = path.join(scratchRoot, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  return file
}

function runCodexCli({ exe, args, env, cwd, timeoutMs = realTimeoutMs, shell = false }) {
  return new Promise((resolve) => {
    spawnAudit.push({ label: 'codex', argv: [exe, ...args] })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let child
    try {
      child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell })
    } catch (error) {
      resolve({ code: null, error, stdout, stderr, timedOut: false })
      return
    }
    liveChildren.add(child)
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      liveChildren.delete(child)
      streamsAudit.push({ label: 'codex', text: `${stdout}\n${stderr}` })
      resolve(result)
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        /* já morto */
      }
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => finish({ code: null, error, stdout, stderr, timedOut }))
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut }))
  })
}

async function detectStaleDevOrbitEnv({ prepared, expectedEnv }) {
  if (!nativeCodex) return { stale: [], error: 'CLI nativo ausente' }
  const table = prepared.args.find((argument) => argument.startsWith(`mcp_servers.${prepared.mcp.name}={`))
  if (!table) return { stale: [], error: `tabela ${prepared.mcp.name} ausente` }
  const result = await runCodexCli({
    exe: nativeCodex,
    args: ['mcp', 'get', prepared.mcp.name, '--json', '-c', table],
    env: prepared.env,
    cwd: projectPath,
    timeoutMs: 30_000,
  })
  if (result.code !== 0) return { stale: [], error: summarizeText(result.stderr || result.stdout, 200) }
  const text = String(result.stdout || '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { stale: [], error: 'mcp get sem JSON' }
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return { stale: [], error: 'mcp get com JSON inválido' }
  }
  const env = (parsed.transport && parsed.transport.env) || {}
  const stale = []
  for (const name of ['DEVORBIT_BRIDGE_PIPE', 'DEVORBIT_BRIDGE_TOKEN', 'DEVORBIT_SESSION_ID']) {
    const actual = env[name]
    if (typeof actual === 'string' && actual !== '' && expectedEnv[name] && actual !== expectedEnv[name]) stale.push(name)
  }
  return { stale, envKeys: Object.keys(env).sort() }
}

function parseCodexJson(output) {
  const text = String(output || '').trim()
  const startObject = text.indexOf('{')
  const startArray = text.indexOf('[')
  const starts = [startObject, startArray].filter((value) => value >= 0)
  if (starts.length === 0) throw new Error('JSON ausente')
  const start = Math.min(...starts)
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (end <= start) throw new Error('JSON incompleto')
  return JSON.parse(text.slice(start, end + 1))
}

function managedConfigArgs(prepared, baseArgs = []) {
  const overrides = prepared.args.slice(baseArgs.length)
  assert(
    overrides.length > 0 && overrides.every((value, index) => index % 2 === 0 ? value === '--config' : typeof value === 'string'),
    'overrides MCP gerenciados inválidos',
  )
  return overrides
}

function classifyCliFailure(result) {
  if (result.timedOut) return { status: 'BLOCKED', detail: `timeout de ${realTimeoutMs}ms aguardando o Codex CLI` }
  if (result.error) {
    const message = summarizeText(result.error.message)
    if (result.error.code === 'ENOENT') return { status: 'BLOCKED', detail: `CLI Codex ausente: ${message}` }
    return { status: 'BLOCKED', detail: `falha ao iniciar o CLI Codex: ${message}` }
  }
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase()
  const blockedPatterns = [
    /401/u, /403/u, /unauthorized/u, /authentication/u, /not logged in/u, /login/u, /oauth/u,
    /\b429\b/u, /rate.?limit/u, /usage.?limit/u, /quota/u, /insufficient/u,
    /out of credits/u, /credits/u, /billing/u, /payment required/u,
    /stream error/u, /network/u, /connection/u, /econnrefused/u, /enotfound/u, /timed? ?out/u, /dns/u,
  ]
  const combined = [result.stderr, result.stdout].filter((part) => typeof part === 'string' && part.trim()).join(' ')
  if (blockedPatterns.some((pattern) => pattern.test(text))) {
    return { status: 'BLOCKED', detail: `Codex CLI indisponível (exit ${result.code}): ${summarizeText(combined, 240)}` }
  }
  return { status: 'FAIL', detail: `Codex CLI falhou (exit ${result.code}): ${summarizeText(combined, 240)}` }
}

function compileHarnessModules() {
  fs.mkdirSync(path.join(projectRoot, 'node_modules', '.cache'), { recursive: true })
  fs.rmSync(emitRoot, { recursive: true, force: true })
  fs.mkdirSync(emitRoot, { recursive: true })
  fs.writeFileSync(path.join(emitRoot, 'package.json'), JSON.stringify({ type: 'commonjs' }))
  const roots = [
    path.join(projectRoot, 'src', 'main', 'bridge-service.ts'),
    path.join(projectRoot, 'src', 'main', 'agent-bridge-runtime.ts'),
    path.join(projectRoot, 'src', 'main', 'codex-mcp-launch.ts'),
    path.join(projectRoot, 'src', 'main', 'codex-bridge-health.ts'),
    path.join(projectRoot, 'src', 'main', 'account-profiles.ts'),
  ]
  const program = ts.createProgram(roots, {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
    outDir: emitRoot,
    rootDir: projectRoot,
    skipLibCheck: true,
    types: [],
  })
  const emitted = program.emit()
  assert(!emitted.emitSkipped, 'não foi possível emitir os módulos do harness')
  const entries = {
    bridgeService: path.join(emitRoot, 'src', 'main', 'bridge-service.js'),
    agentBridgeRuntime: path.join(emitRoot, 'src', 'main', 'agent-bridge-runtime.js'),
    codexMcpLaunch: path.join(emitRoot, 'src', 'main', 'codex-mcp-launch.js'),
    codexBridgeHealth: path.join(emitRoot, 'src', 'main', 'codex-bridge-health.js'),
    accountProfiles: path.join(emitRoot, 'src', 'main', 'account-profiles.js'),
  }
  for (const [name, file] of Object.entries(entries)) assert(fs.existsSync(file), `módulo ${name} não emitido em ${file}`)
  return {
    createBridgeService: require(entries.bridgeService).createBridgeService,
    createAgentBridgeRuntime: require(entries.agentBridgeRuntime).createAgentBridgeRuntime,
    prepareDevOrbitCodexLaunch: require(entries.codexMcpLaunch).prepareDevOrbitCodexLaunch,
    CodexBridgeHealthStore: require(entries.codexBridgeHealth).CodexBridgeHealthStore,
    accountProfiles: require(entries.accountProfiles),
  }
}

function setupTemporaryProject() {
  // Nunca sobrescreve o diretório base: cada execução usa um filho único e
  // vazio. Se a base já tiver conteúdo do usuário, ele permanece intocado.
  fs.mkdirSync(projectBasePath, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const unique = path.join(projectBasePath, `run-${stamp}-${process.pid}`)
  fs.mkdirSync(unique, { recursive: false })
  const codexDir = path.join(unique, '.codex')
  if (fs.existsSync(codexDir)) {
    throw new BlockedError(`o projeto de teste contém .codex e não será limpo: ${codexDir}`)
  }
  fs.writeFileSync(
    path.join(unique, 'README.md'),
    '# project-without-codex\nFixture E2E do Codex gerenciado (sem .codex local).\n',
    'utf8',
  )
  fs.writeFileSync(
    path.join(unique, 'package.json'),
    JSON.stringify({ name: 'project-without-codex', version: '1.0.0', private: true }, null, 2),
    'utf8',
  )
  projectPath = unique
  return unique
}

function discoverPinnedCodex() {
  const pinned = process.env.DEVORBIT_CODEX_EXE
  if (pinned && fs.existsSync(pinned)) return pinned
  const binDirectory = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin')
  let entries = []
  try {
    entries = fs.readdirSync(binDirectory, { withFileTypes: true })
  } catch {
    return null
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(binDirectory, entry.name, 'codex.exe'))
    .filter((file) => fs.existsSync(file))
  const preferred = candidates.find((file) => file.includes('de8a38d2100ae498'))
  if (preferred) return preferred
  candidates.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
  return candidates[0] || null
}

function createMcpClient({ env, terminalId, launchId, label, requestTimeoutMs = 60_000, unsetEnv = [] }) {
  const argv = [mcpScript, '--terminal-id', terminalId, '--launch-id', launchId]
  spawnAudit.push({ label: `mcp-${label}`, argv: [process.execPath, ...argv] })
  const childEnv = { ...process.env, ...env }
  for (const key of unsetEnv) delete childEnv[key]
  childEnv.ELECTRON_RUN_AS_NODE = '1'
  const child = spawn(process.execPath, argv, {
    env: childEnv,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  liveChildren.add(child)
  let sequence = 0
  let buffer = ''
  let stdout = ''
  let stderr = ''
  const pending = new Map()
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    stdout += text
    buffer += text
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message && message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id)
        pending.delete(message.id)
        clearTimeout(entry.timer)
        entry.resolve(message)
      }
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const closed = new Promise((resolve) => {
    child.on('close', resolve)
    child.on('error', () => resolve(null))
  })
  return {
    child,
    request(method, params, timeoutMs = requestTimeoutMs) {
      const id = ++sequence
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(Object.assign(new Error(`MCP ${method} não respondeu em ${timeoutMs}ms`), { code: 'MCP_TIMEOUT' }))
        }, timeoutMs)
        pending.set(id, { resolve, timer })
      })
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
    writeRaw(text) {
      child.stdin.write(text)
    },
    awaitResponse(id, timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(Object.assign(new Error(`MCP id ${id} não respondeu em ${timeoutMs}ms`), { code: 'MCP_TIMEOUT' }))
        }, timeoutMs)
        pending.set(id, { resolve, timer })
      })
    },
    async close() {
      try {
        child.stdin.end()
      } catch {
        /* já fechado */
      }
      await Promise.race([closed, delay(1500)])
      try {
        child.kill()
      } catch {
        /* já morto */
      }
      liveChildren.delete(child)
      streamsAudit.push({ label: `mcp-${label}`, text: `${stdout}\n${stderr}` })
    },
    getStderr: () => stderr,
  }
}

function toolResultData(message) {
  const result = message && message.result
  assert(result && !result.isError, `MCP tools/call retornou erro: ${summarizeText(JSON.stringify(result))}`)
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = Array.isArray(result.content) && result.content[0] && result.content[0].text
  assert(typeof text === 'string', 'MCP tools/call sem conteúdo textual')
  return JSON.parse(text)
}

function writeCoordinatorDebugWrapper() {
  const wrapperPath = requireScratch('mcp-debug-wrapper.cjs')
  const logPath = path.join(scratchRoot, 'mcp-debug-wrapper.log')
  const source = `'use strict'
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const LOG = ${JSON.stringify(logPath)}
const BRIDGE = ${JSON.stringify(bridgeCli)}
const REAL = ${JSON.stringify(mcpScript)}
function log(entry) { fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...entry }) + '\\n') }
log({
  step: 'spawn',
  runAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
  names: Object.keys(process.env).filter((key) => key.startsWith('DEVORBIT')),
  lengths: {
    pipe: (process.env.DEVORBIT_BRIDGE_PIPE || '').length,
    token: (process.env.DEVORBIT_BRIDGE_TOKEN || '').length,
    session: (process.env.DEVORBIT_SESSION_ID || '').length,
  },
})
try {
  const bridge = require(BRIDGE)
  bridge.callBridge(process.env.DEVORBIT_BRIDGE_PIPE, process.env.DEVORBIT_BRIDGE_TOKEN, process.env.DEVORBIT_SESSION_ID, { type: 'ping' }, 3000).then((result) => {
    log({ step: 'ping', ok: result && result.ok, code: result && result.error && result.error.code, message: result && result.error && result.error.message })
  }).catch((error) => log({ step: 'ping-error', code: error && error.code, message: error && error.message }))
} catch (error) {
  log({ step: 'wrapper-failure', message: error && error.message })
}

const child = spawn(process.execPath, [REAL, ...process.argv.slice(2)], { env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
process.stdin.on('data', (chunk) => {
  log({ step: 'stdin', line: chunk.toString().trim().slice(0, 500) })
  child.stdin.write(chunk)
})
process.stdin.on('end', () => child.stdin.end())
child.stdout.on('data', (chunk) => {
  log({ step: 'mcp-stdout', line: chunk.toString().trim().slice(0, 500) })
  process.stdout.write(chunk)
})
child.stderr.on('data', (chunk) => {
  log({ step: 'mcp-stderr', line: chunk.toString().trim().slice(0, 500) })
  process.stderr.write(chunk)
})
child.on('close', (code) => process.exit(code === null ? 1 : code))
`
  fs.writeFileSync(wrapperPath, source)
  return wrapperPath
}

function writeCodexEnvForwardingProbe(evidencePath) {
  const probePath = requireScratch('codex-env-forwarding-probe.cjs')
  const source = `'use strict'
const crypto = require('node:crypto')
const fs = require('node:fs')
const readline = require('node:readline')
const EVIDENCE = ${JSON.stringify(evidencePath)}
const token = process.env.DEVORBIT_BRIDGE_TOKEN || ''
const evidence = {
  tokenPresent: token.length > 0,
  tokenLength: token.length,
  tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
  pipePresent: Boolean(process.env.DEVORBIT_BRIDGE_PIPE),
  sessionPresent: Boolean(process.env.DEVORBIT_SESSION_ID),
}
fs.writeFileSync(EVIDENCE, JSON.stringify(evidence), 'utf8')
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  let request
  try { request = JSON.parse(line) } catch { return }
  if (request.method === 'initialize') return void process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'DevOrbit env forwarding probe', version: '1' } } }) + '\\n')
  if (request.method === 'notifications/initialized') return
  if (request.method === 'tools/list') return void process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [] } }) + '\\n')
  if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\\n')
})
`
  fs.writeFileSync(probePath, source)
  return probePath
}

function createResultWaiter() {
  let resolveOutcome = () => undefined
  const promise = new Promise((resolve) => {
    resolveOutcome = resolve
  })
  promise.cancel = () => resolveOutcome({ error: 'A espera do resultado foi cancelada.' })
  return { promise, resolve: resolveOutcome }
}

function createTransportFixture({ label }) {
  const waiters = new Map()
  const writes = []
  const events = []
  return {
    writes,
    events,
    deps: {
      cliDirectory: projectRoot,
      hasTerminal: (id) => id === 'w1' || id === 'w2',
      waitTurnResult: (id) => {
        const waiter = createResultWaiter()
        waiters.set(id, waiter)
        return waiter.promise
      },
      sendInstruction: async ({ terminalId, content }) => {
        writes.push({ terminalId, content })
        const waiter = waiters.get(terminalId)
        setImmediate(() => {
          if (waiter) waiter.resolve({ result: `${label}:${terminalId}:${content}` })
        })
        return { acked: true, attempts: 1 }
      },
      onEvent: (event) => events.push(event),
      onReflection: () => undefined,
      onGuard: () => undefined,
      onMcpHandshake: undefined,
      onRegistryChanged: undefined,
    },
  }
}

function createRealWorkerPool({ codexExe, accounts }) {
  const waiters = new Map()
  const calls = []
  const deps = {
    cliDirectory: projectRoot,
    hasTerminal: (id) => id === 'w1' || id === 'w2',
    waitTurnResult: (id) => {
      const waiter = createResultWaiter()
      waiter.child = null
      waiter.promise.cancel = () => {
        waiter.resolve({ error: 'A espera do resultado foi cancelada.' })
        const entry = waiters.get(id)
        if (entry && entry.terminalChild) {
          try {
            entry.terminalChild.kill()
          } catch {
            /* já morto */
          }
        }
      }
      waiters.set(id, waiter)
      return waiter.promise
    },
    sendInstruction: async ({ terminalId, content }) => {
      const waiter = waiters.get(terminalId)
      assert(waiter, `worker real sem waiter armado para ${terminalId}`)
      const account = accounts[terminalId]
      assert(account, `worker real sem conta definida para ${terminalId}`)
      assert(account.environment && account.environment.CODEX_HOME, `worker ${terminalId} sem CODEX_HOME da conta`)
      const accountHome = path.basename(account.environment.CODEX_HOME)
      const outFile = requireScratch(`worker-${terminalId}-${Date.now()}.txt`)
      const args = ['exec', '--json', '--skip-git-repo-check', '-C', projectPath, '-o', outFile]
      if (process.env.DEVORBIT_CODEX_E2E_MODEL) args.push('-m', process.env.DEVORBIT_CODEX_E2E_MODEL)
      args.push(content)
      const child = spawn(codexExe, args, {
        cwd: projectPath,
        env: { ...process.env, ...account.environment },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      liveChildren.add(child)
      waiter.terminalChild = child
      spawnAudit.push({ label: `worker-${terminalId}`, argv: [codexExe, ...args] })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          child.kill()
        } catch {
          /* já morto */
        }
      }, realTimeoutMs)
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        calls.push({ terminalId, accountHome, prompt: content, code: null, error: error.message, timedOut })
        waiter.resolve({ error: `worker ${terminalId}: ${error.message}` })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        liveChildren.delete(child)
        streamsAudit.push({ label: `worker-${terminalId}`, text: `${stdout}\n${stderr}` })
        let text = ''
        try {
          text = fs.readFileSync(outFile, 'utf8').trim()
        } catch {
          text = ''
        }
        calls.push({ terminalId, accountHome, prompt: content, code, timedOut, output: summarizeText(text, 200) })
        if (timedOut) {
          waiter.resolve({ error: `worker ${terminalId} excedeu ${realTimeoutMs}ms` })
          return
        }
        if (code !== 0) {
          fs.writeFileSync(requireScratch(`worker-${terminalId}-${Date.now()}-stderr.log`), stderr)
          fs.writeFileSync(requireScratch(`worker-${terminalId}-${Date.now()}-stdout.jsonl`), stdout)
          const failure = classifyCliFailure({ code, stdout, stderr, timedOut })
          waiter.resolve({ error: `worker ${terminalId} ${failure.status}: ${failure.detail}` })
          return
        }
        if (!text) {
          waiter.resolve({ error: `worker ${terminalId} não produziu mensagem final` })
          return
        }
        waiter.resolve({ result: text })
      })
      return { acked: true, attempts: 1 }
    },
    onEvent: () => undefined,
    onReflection: () => undefined,
    onGuard: () => undefined,
    onMcpHandshake: undefined,
    onRegistryChanged: undefined,
  }
  return { deps, calls }
}

/**
 * Codex may expose MCP tools directly, namespaced (`devorbit__agent.list`) or
 * sanitized (`agent_list`) depending on exposure mode/version. The E2E only
 * requires that the canonical operation reached the model.
 */
function hasCodexTool(run, canonical) {
  const variants = [canonical, canonical.replace(/\./gu, '_'), canonical.replace(/\./gu, '__')]
  return run.tools.some((tool) => variants.some((variant) => String(tool).toLowerCase().includes(variant.toLowerCase())))
}

function directBridgeRequest(pipeName, token, sessionId, request, timeoutMs = 30_000) {
  const { callBridge } = require(bridgeCli)
  return callBridge(pipeName, token, sessionId, request, timeoutMs)
}

function analyzeCodexEvents(text) {
  const tools = []
  const messages = []
  const threads = []
  const collect = (value) => {
    if (!value || typeof value !== 'object') return
    if (value.type === 'mcp_tool_call') {
      tools.push({ tool: value.tool || value.name || '?', server: value.server, status: value.status })
    }
    if (value.type === 'agent_message' && typeof value.text === 'string') messages.push(value.text)
    if (typeof value.thread_id === 'string' && value.thread_id.trim()) threads.push(value.thread_id.trim())
    if (typeof value.session_id === 'string' && value.session_id.trim()) threads.push(value.session_id.trim())
    for (const child of Object.values(value)) collect(child)
  }
  for (const line of String(text || '').split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      collect(JSON.parse(trimmed))
    } catch {
      /* linha não-JSON do CLI */
    }
  }
  return { tools, messages, threads }
}

async function awaitHandshake(store, terminalId, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      store.waitConnected(terminalId),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new BlockedError(`handshake não chegou em ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function registerSecretSource(label, text) {
  secretSources.push({ label, text: String(text || '').slice(0, 400_000) })
}

function listFilesBounded(root, limit = 400) {
  const output = []
  const walk = (directory, depth) => {
    if (output.length >= limit || depth > 4) return
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (output.length >= limit) return
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile()) output.push(full)
    }
  }
  walk(root, 0)
  return output
}

function scanRegisteredSecrets() {
  const findings = []
  for (const source of secretSources) {
    for (const [name, secret] of secrets) {
      if (secret && source.text.includes(secret)) findings.push(`${source.label} contém ${name}`)
    }
  }
  return findings
}

function redactSecrets(text) {
  let output = String(text || '')
  for (const [name, secret] of secrets) {
    if (secret) output = output.split(secret).join(`<redacted:${name}>`)
  }
  return output
}

async function main() {
  assert(process.env.ELECTRON_RUN_AS_NODE !== '1', 'Electron foi iniciado como Node; use `npx electron --in-process-gpu scripts/verify-codex-bridge.cjs`')
  assert(fs.existsSync(mcpScript), `MCP ausente em ${mcpScript}`)

  let modules = null
  await phase('compile.modules', 'HARNESS', () => {
    modules = compileHarnessModules()
    return { detail: 'bridge-service, agent-bridge-runtime, codex-mcp-launch, codex-bridge-health, account-profiles' }
  })
  assert(modules, 'módulos compilados indisponíveis')
  const {
    createBridgeService,
    createAgentBridgeRuntime,
    prepareDevOrbitCodexLaunch,
    CodexBridgeHealthStore,
    accountProfiles,
  } = modules

  await phase('project.temporary', 'HARNESS', () => {
    setupTemporaryProject()
    return { detail: `${projectPath} (sem .codex)` }
  })

  // Finding the native binary is enough for the non-live namespace proof. Do
  // not resolve account commands or inspect account auth files unless the
  // explicitly opted-in live phase is enabled.
  nativeCodex = discoverPinnedCodex()
  appResolvedCodex = realEnabled ? await accountProfiles.resolveCodexCommand() : null
  if (realEnabled && !nativeCodex && appResolvedCodex && /\.exe$/iu.test(appResolvedCodex) && fs.existsSync(appResolvedCodex)) {
    nativeCodex = appResolvedCodex
  }
  const npmCodex = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'codex.cmd') : null
  if (realEnabled && npmCodex && fs.existsSync(npmCodex)) {
    const version = await runCodexCli({ exe: npmCodex, args: ['--version'], env: process.env, cwd: projectRoot, timeoutMs: 20_000, shell: true })
    const combined = `${version.stdout} ${version.stderr}`.trim()
    npmCodexVersion = combined.split(/\s+/u).find((part) => /^\d+\.\d+\.\d+$/u.test(part)) || summarizeText(combined, 60)
  }
  let nativeVersion = null
  if (nativeCodex) {
    const version = await runCodexCli({ exe: nativeCodex, args: ['--version'], env: process.env, cwd: projectRoot, timeoutMs: 20_000 })
    nativeVersion = summarizeText(`${version.stdout} ${version.stderr}`, 60)
  }

  const accounts = {
    account1: { id: 'account1', environment: accountProfiles.getCodexAccountEnvironment('account1') },
    account2: { id: 'account2', environment: accountProfiles.getCodexAccountEnvironment('account2') },
  }
  assert(accounts.account1.environment.CODEX_HOME.endsWith('.codex-conta1'), `CODEX_HOME da conta1 inesperado: ${accounts.account1.environment.CODEX_HOME}`)
  assert(accounts.account2.environment.CODEX_HOME.endsWith('.codex-conta2'), `CODEX_HOME da conta2 inesperado: ${accounts.account2.environment.CODEX_HOME}`)
  assert(accounts.account1.environment.CODEX_HOME !== accounts.account2.environment.CODEX_HOME, 'contas 1 e 2 não podem compartilhar CODEX_HOME')
  const accountAuth = realEnabled
    ? {
        account1: await accountProfiles.hasValidCodexAuth(accounts.account1.environment.CODEX_HOME),
        account2: await accountProfiles.hasValidCodexAuth(accounts.account2.environment.CODEX_HOME),
      }
    : { account1: false, account2: false }

  // ---------------------------------------------------------------- TRANSPORT
  const transportHealthEvents = []
  const transport = createTransportFixture({ label: 'TRANSPORT-FIXTURE' })
  let transportHealth
  const transportService = createBridgeService({
    ...transport.deps,
    onMcpHandshake: (handshake) => {
      if (transportHealth.handshake(handshake)) {
        transportHealth.registryChanged(transportService.listAgents().filter((agent) => agent.status === 'active').length)
      }
    },
    onRegistryChanged: () => {
      transportHealth.registryChanged(transportService.listAgents().filter((agent) => agent.status === 'active').length)
    },
  })
  transportHealth = new CodexBridgeHealthStore((health) => transportHealthEvents.push({ ...health }), 60_000)
  cleanups.push(() => {
    try {
      transportService.runtime.stop()
    } catch {
      /* já parado */
    }
    transportHealth.dispose()
  })
  transportService.registerAgent('w1', { provider: 'codex', model: 'transport-fixture', projectPath })
  transportService.registerAgent('w2', { provider: 'codex', model: 'transport-fixture', projectPath })
  await transportService.runtime.ready()
  const transportEnv = transportService.runtime.env()
  secrets.set('token TRANSPORT', transportService.runtime.token)
  secrets.set('session TRANSPORT', transportService.runtime.sessionId)
  secrets.set('pipe TRANSPORT', transportService.runtime.pipeName)
  const launchA = 'launch-transport-a'
  transportHealth.configure('coordinator', launchA, transportService.runtime.sessionId)
  transportHealth.connecting('coordinator', launchA)

  await phase('transport.env-guard', 'TRANSPORT', async () => {
    const envWithoutBridge = { ...process.env }
    delete envWithoutBridge.DEVORBIT_BRIDGE_PIPE
    delete envWithoutBridge.DEVORBIT_BRIDGE_TOKEN
    delete envWithoutBridge.DEVORBIT_SESSION_ID
    const client = createMcpClient({
      env: envWithoutBridge,
      unsetEnv: ['DEVORBIT_BRIDGE_PIPE', 'DEVORBIT_BRIDGE_TOKEN', 'DEVORBIT_SESSION_ID'],
      terminalId: 'coordinator',
      launchId: launchA,
      label: 'env-guard',
    })
    try {
      const response = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '1' } })
      assert(response.error, 'initialize sem ambiente deveria falhar')
      assert(response.error.data && response.error.data.code === 'BRIDGE_ENV_MISSING', `erro inesperado: ${JSON.stringify(response.error)}`)
      const tools = await client.request('tools/list', {}, 15_000)
      assert(tools.error || (tools.result && tools.result.isError), 'ferramentas expostas sem ambiente de bridge')
      return { detail: 'initialize e tools/list bloqueados sem DEVORBIT_BRIDGE_*' }
    } finally {
      await client.close()
    }
  })

  let transportMcp = null
  await phase('transport.handshake-list-ask', 'TRANSPORT', async () => {
    transportMcp = createMcpClient({ env: transportEnv, terminalId: 'coordinator', launchId: launchA, label: 'transport' })
    const initialized = await transportMcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '1' } })
    assert(initialized.result && initialized.result.serverInfo && initialized.result.serverInfo.name === 'DevOrbit MCP', `initialize inesperado: ${JSON.stringify(initialized)}`)
    transportMcp.notify('notifications/initialized', {})
    await awaitHandshake(transportHealth, 'coordinator', 30_000)
    const tools = await transportMcp.request('tools/list', {})
    const names = (tools.result.tools || []).map((tool) => tool.name)
    for (const required of ['agent.list', 'agent.send', 'agent.wait', 'agent.ask', 'agent.run']) {
      assert(names.includes(required), `tool ${required} ausente: ${names.join(',')}`)
    }
    const list = toolResultData(await transportMcp.request('tools/call', { name: 'agent.list', arguments: {} }))
    assert(Array.isArray(list) && list.length === 2, `agent.list inesperado: ${JSON.stringify(list)}`)
    assert(list.every((agent) => agent.status === 'starting' && agent.terminalExists === true && agent.operational === false), 'agentes transport deveriam estar starting e não operacionais antes do primeiro turno')
    const ask = toolResultData(await transportMcp.request('tools/call', { name: 'agent.ask', arguments: { target: 'w1', prompt: 'tarefa transporte' } }, 60_000))
    assert(ask.status === 'completed', `agent.ask inesperado: ${JSON.stringify(ask)}`)
    assert(String(ask.summary).startsWith('TRANSPORT-FIXTURE:w1:'), `resposta não é do fixture rotulado: ${ask.summary}`)
    assert(transport.writes.length === 1, 'fixture não recebeu exatamente um prompt')
    return { detail: `handshake + 5 tools + list(2) + ask(fixture) OK` }
  })

  await phase('transport.pipelined-tools-list', 'TRANSPORT', async () => {
    // Codex 0.159.2 envia notifications/initialized E tools/list no mesmo
    // chunk. O servidor MCP gerenciado precisa aguardar o handshake e ainda
    // assim responder tools/list (é o padrão real observado no CLI).
    const launchP = 'launch-transport-pipelined'
    transportHealth.configure('coordinator', launchP, transportService.runtime.sessionId)
    transportHealth.connecting('coordinator', launchP)
    const client = createMcpClient({ env: transportEnv, terminalId: 'coordinator', launchId: launchP, label: 'pipelined' })
    try {
      const initialized = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '1' } })
      assert(initialized.result, 'initialize falhou antes do pipelining')
      const pipelinedId = 9901
      client.writeRaw(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', id: pipelinedId, method: 'tools/list', params: {} })}\n`,
      )
      const response = await client.awaitResponse(pipelinedId, 30_000)
      await awaitHandshake(transportHealth, 'coordinator', 30_000)
      assert(response.result && Array.isArray(response.result.tools) && response.result.tools.length >= 5, `tools/list pipelined falhou como o Codex real: ${JSON.stringify(response.error || response.result)}`)
      return { detail: 'notifications/initialized + tools/list no mesmo write responderam normalmente (padrão Codex)' }
    } finally {
      await client.close()
    }
  })

  await phase('transport.auth-negative', 'TRANSPORT', async () => {
    const wrongToken = await directBridgeRequest(transportService.runtime.pipeName, 'token-invalido', transportService.runtime.sessionId, { type: 'ping' })
    assert(wrongToken.ok === false && wrongToken.error.code === 'BRIDGE_AUTH_REJECTED', `token inválido inesperado: ${JSON.stringify(wrongToken)}`)
    const wrongSession = await directBridgeRequest(transportService.runtime.pipeName, transportService.runtime.token, 'sessao-invalida', { type: 'ping' })
    assert(wrongSession.ok === false && wrongSession.error.code === 'BRIDGE_SESSION_MISMATCH', `sessão inválida inesperada: ${JSON.stringify(wrongSession)}`)
    return { detail: 'BRIDGE_AUTH_REJECTED e BRIDGE_SESSION_MISMATCH distintivos' }
  })

  await phase('launch.contract', 'CONTRACT', async () => {
    const runtime = {
      executablePath: process.execPath,
      scriptPath: mcpScript,
      appPath: projectRoot,
      isPackaged: false,
    }
    const prepared1 = prepareDevOrbitCodexLaunch({
      accountEnvironment: accounts.account1.environment,
      bridgeEnv: transportEnv,
      terminalId: 'codex-coordinator',
      baseArgs: ['exec', '--json'],
      runtime,
    })
    const prepared2 = prepareDevOrbitCodexLaunch({
      accountEnvironment: accounts.account2.environment,
      bridgeEnv: transportEnv,
      terminalId: 'codex-coordinator',
      baseArgs: ['exec', '--json'],
      runtime,
    })
    assert(prepared1.mcp.launchId !== prepared2.mcp.launchId, 'launchId deve ser único por lançamento')
    assert(prepared1.args.slice(0, 2).join(' ') === 'exec --json', 'baseArgs não foram preservados')
    assert(prepared1.mcp.command === process.execPath, 'MCP deve usar o executável Electron do app')
    assert(prepared1.mcp.args.includes(mcpScript), 'MCP deve apontar para scripts/devorbit-mcp.cjs')
    assert(prepared1.mcp.args.includes('--terminal-id') && prepared1.mcp.args.includes('codex-coordinator'), 'MCP sem terminal-id')
    assert(prepared1.mcp.args.includes('--launch-id') && prepared1.mcp.args.includes(prepared1.mcp.launchId), 'MCP sem launch-id')
    assert(JSON.stringify(prepared1.mcp.env) === JSON.stringify({ ELECTRON_RUN_AS_NODE: '1' }), `ELECTRON_RUN_AS_NODE deve ser exclusivo do MCP: ${JSON.stringify(prepared1.mcp.env)}`)
    assert(
      JSON.stringify(prepared1.mcp.envVars) === JSON.stringify(['DEVORBIT_BRIDGE_PIPE', 'DEVORBIT_BRIDGE_TOKEN', 'DEVORBIT_SESSION_ID']),
      `env_vars deve manter somente os três nomes canônicos: ${JSON.stringify(prepared1.mcp.envVars)}`,
    )
    assert(prepared1.env.ELECTRON_RUN_AS_NODE === undefined, 'Codex não pode herdar ELECTRON_RUN_AS_NODE')
    assert(prepared1.env.CODEX_HOME === accounts.account1.environment.CODEX_HOME, 'CODEX_HOME da conta1 ausente no env')
    assert(prepared2.env.CODEX_HOME === accounts.account2.environment.CODEX_HOME, 'CODEX_HOME da conta2 ausente no env')
    assert(prepared1.env.DEVORBIT_BRIDGE_TOKEN === transportService.runtime.token, 'token da bridge deve viajar só no env')
    assert(prepared1.mcp.name !== prepared2.mcp.name, 'namespace MCP deve ser único por lançamento')
    assert(/^devorbit_runtime_[0-9a-f]{32}$/u.test(prepared1.mcp.name), `namespace MCP inseguro: ${prepared1.mcp.name}`)
    assert(prepared1.mcp.name !== 'devorbit', 'namespace legado não pode ser reutilizado')
    const configArgs = prepared1.args.join('\n')
    assert(!configArgs.includes(transportService.runtime.token), 'token não pode aparecer em argv/--config')
    assert(!configArgs.includes(transportService.runtime.sessionId), 'sessão não pode aparecer em argv/--config')
    assert(!configArgs.includes(transportService.runtime.pipeName), 'pipe não pode aparecer em argv/--config')
    assert(prepared1.args.filter((argument) => argument === '--config').length === 3, 'legado desabilitado + tabela + reset deveriam ser 3 pares --config')
    assert(!configArgs.includes('enabled_tools=[]'), 'enabled_tools=[] ocultaria todas as tools (allowlist vazia)')
    // O dono do módulo pode representar strings TOML como basic (`"..."`) ou
    // literal (`'''...'''`); o contrato é o VALOR, então aceitamos ambos.
    const quoted = (value) => [JSON.stringify(value), `'''${value}'''`]
    const hasQuoted = (prefix, value) => quoted(value).some((variant) => configArgs.includes(`${prefix}${variant}`))
    const requiredConfigs = [`mcp_servers.devorbit={`, `mcp_servers.${prepared1.mcp.name}={`, 'env_vars = [', 'env = {', 'required = true', 'enabled = true', 'startup_timeout_sec = 10']
    for (const required of requiredConfigs) assert(configArgs.includes(required), `--config ausente: ${required}`)
    const legacyConfig = prepared1.args.find((argument) => argument.startsWith('mcp_servers.devorbit={'))
    assert(legacyConfig && legacyConfig.includes('enabled = false'), 'entrada legada deve permanecer desabilitada')
    assert(hasQuoted('command = ', process.execPath), 'command do MCP não consta no --config')
    assert(hasQuoted('cwd = ', path.dirname(mcpScript)), 'cwd do MCP não consta no --config')
    for (const value of [mcpScript, '--terminal-id', 'codex-coordinator', '--launch-id', prepared1.mcp.launchId]) {
      assert(hasQuoted('', value), `valor MCP ausente no --config: ${value}`)
    }
    assert(hasQuoted('ELECTRON_RUN_AS_NODE = ', '1'), 'ELECTRON_RUN_AS_NODE=1 ausente do env do MCP')
    for (const name of prepared1.mcp.envVars) assert(configArgs.includes(name), `env_var ausente no --config: ${name}`)
    assert(typeof prepared1.mcp.cwd === 'string' && prepared1.mcp.cwd === path.dirname(mcpScript), `cwd do MCP inesperado: ${prepared1.mcp.cwd}`)
    const tableIndex = prepared1.args.findIndex((argument) => argument.startsWith(`mcp_servers.${prepared1.mcp.name}={`))
    assert(tableIndex >= 0, 'tabela devorbit ausente do --config')
    assert(
      JSON.stringify(prepared1.args.slice(tableIndex + 1)) === JSON.stringify([
        '--config', `mcp_servers.${prepared1.mcp.name}.disabled_tools=[]`,
      ]),
      `reset de disabled_tools deve vir depois da tabela: ${JSON.stringify(prepared1.args.slice(tableIndex + 1))}`,
    )
    registerSecretSource('launch-contract', JSON.stringify(prepared1.args))
    registerSecretSource('launch-contract-mcp', JSON.stringify(prepared1.mcp))
    return { detail: 'tabela TOML única + resets de arrays, credenciais só em env (3 nomes canônicos), launchId único, RUN_AS_NODE só no MCP' }
  })

  await phase('codex.namespace-isolation', 'CLI', async () => {
    if (!nativeCodex) return { status: 'NOT_RUN', detail: 'CLI nativo ausente; prova mcp get/list não executada' }

    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devorbit-codex-namespace-'))
    const staleEnvValue = `legacy-stale-env-${process.pid}`
    const staleConfig = [
      '[mcp_servers.devorbit]',
      'command = "legacy-command"',
      'args = ["legacy"]',
      `env = { DEVORBIT_BRIDGE_TOKEN = "${staleEnvValue}" }`,
      'enabled = true',
      '',
    ].join('\n')
    fs.writeFileSync(path.join(isolatedHome, 'config.toml'), staleConfig, 'utf8')

    try {
      const prepared = prepareDevOrbitCodexLaunch({
        accountEnvironment: { CODEX_HOME: isolatedHome },
        bridgeEnv: {
          DEVORBIT_BRIDGE_PIPE: `\\\\.\\pipe\\devorbit-proof-${process.pid}`,
          DEVORBIT_BRIDGE_TOKEN: `bridge-proof-${process.pid}`,
          DEVORBIT_SESSION_ID: `session-proof-${process.pid}`,
        },
        terminalId: 'codex-namespace-proof',
        runtime: { executablePath: process.execPath, scriptPath: mcpScript, cwd: projectRoot },
      })
      const configArgs = managedConfigArgs(prepared)
      const env = { ...prepared.env, CODEX_HOME: isolatedHome }
      const list = await runCodexCli({
        exe: nativeCodex,
        args: ['mcp', 'list', '--json', ...configArgs],
        env,
        cwd: projectPath,
        timeoutMs: 30_000,
      })
      assert(list.code === 0, `mcp list falhou: ${summarizeText(list.stderr || list.stdout, 240)}`)
      const entries = parseCodexJson(list.stdout)
      assert(Array.isArray(entries), 'mcp list não retornou uma lista JSON')
      const legacy = entries.find((entry) => entry && entry.name === 'devorbit')
      const fresh = entries.find((entry) => entry && entry.name === prepared.mcp.name)
      assert(legacy && legacy.enabled === false, 'entrada legada devorbit não foi desabilitada por launch')
      assert(fresh && fresh.enabled === true, `namespace fresco ${prepared.mcp.name} não ficou habilitado`)
      assert(fresh.transport && fresh.transport.env && fresh.transport.env.DEVORBIT_BRIDGE_TOKEN === undefined, 'namespace fresco herdou env literal')
      assert(JSON.stringify(fresh.transport.env_vars || []) === JSON.stringify(prepared.mcp.envVars), 'namespace fresco perdeu env_vars canônicos')
      assert(legacy.transport && legacy.transport.env && legacy.transport.env.DEVORBIT_BRIDGE_TOKEN === staleEnvValue, 'fixture legado não preservou a prova de stale env')

      const getLegacy = await runCodexCli({
        exe: nativeCodex,
        args: ['mcp', 'get', 'devorbit', '--json', ...configArgs],
        env,
        cwd: projectPath,
        timeoutMs: 30_000,
      })
      assert(getLegacy.code === 0, `mcp get legado falhou: ${summarizeText(getLegacy.stderr || getLegacy.stdout, 240)}`)
      const legacyRecord = parseCodexJson(getLegacy.stdout)
      assert(legacyRecord.enabled === false, 'mcp get legado não refletiu enabled=false')
      assert(legacyRecord.transport && legacyRecord.transport.env.DEVORBIT_BRIDGE_TOKEN === staleEnvValue, 'mcp get legado não mostrou o fixture esperado')

      const getFresh = await runCodexCli({
        exe: nativeCodex,
        args: ['mcp', 'get', prepared.mcp.name, '--json', ...configArgs],
        env,
        cwd: projectPath,
        timeoutMs: 30_000,
      })
      assert(getFresh.code === 0, `mcp get fresco falhou: ${summarizeText(getFresh.stderr || getFresh.stdout, 240)}`)
      const freshRecord = parseCodexJson(getFresh.stdout)
      assert(freshRecord.name === prepared.mcp.name && freshRecord.enabled === true, 'mcp get fresco retornou namespace incorreto')
      assert(freshRecord.transport && freshRecord.transport.env && freshRecord.transport.env.DEVORBIT_BRIDGE_TOKEN === undefined, 'mcp get fresco revelou env legado')
      const configText = configArgs.join('\n')
      assert(!configText.includes('bridge-proof-') && !configText.includes('session-proof-') && !configText.includes('devorbit-proof-'), 'credencial de prova apareceu em argv/--config')
      return { detail: `mcp list/get confirmou devorbit desabilitado e ${prepared.mcp.name} fresco com env_vars; CODEX_HOME temporário` }
    } finally {
      fs.rmSync(isolatedHome, { recursive: true, force: true })
    }
  })

  let codexMcpEnvForwarding = null
  await phase('real.mcp-env-forwarding', 'REAL', async () => {
    if (!realEnabled) {
      codexMcpEnvForwarding = { status: 'NOT_RUN', reason: 'DEVORBIT_CODEX_REAL_E2E=0' }
      return { status: 'NOT_RUN', detail: 'DEVORBIT_CODEX_REAL_E2E=0' }
    }
    if (!nativeCodex) {
      codexMcpEnvForwarding = { status: 'BLOCKED', reason: 'CLI nativo codex.exe não encontrado no Desktop' }
      throw new BlockedError('CLI nativo codex.exe não encontrado no Desktop; sonda real de env_vars não executada')
    }

    const sentinelToken = `devorbit-env-probe-${crypto.randomUUID()}`
    const sentinelPipe = `\\\\.\\pipe\\devorbit-env-probe-${process.pid}`
    const sentinelSession = `session-env-probe-${crypto.randomUUID()}`
    secrets.set('token MCP env forwarding probe', sentinelToken)
    secrets.set('pipe MCP env forwarding probe', sentinelPipe)
    secrets.set('session MCP env forwarding probe', sentinelSession)
    const evidencePath = requireScratch('codex-env-forwarding-evidence.json')
    const probePath = writeCodexEnvForwardingProbe(evidencePath)
    const probeName = `devorbit_runtime_probe_${crypto.randomUUID().replaceAll('-', '')}`
    const table = [
      `command = ${JSON.stringify(process.execPath)}`,
      `args = ${JSON.stringify([probePath])}`,
      `cwd = ${JSON.stringify(path.dirname(probePath))}`,
      `env_vars = ${JSON.stringify(['DEVORBIT_BRIDGE_PIPE', 'DEVORBIT_BRIDGE_TOKEN', 'DEVORBIT_SESSION_ID'])}`,
      'env = { ELECTRON_RUN_AS_NODE = "1" }',
      'required = true',
      'enabled = true',
      'startup_timeout_sec = 10',
    ].join(', ')
    const legacyTable = `mcp_servers.devorbit={ command = ${JSON.stringify(process.execPath)}, args = [], cwd = ${JSON.stringify(projectRoot)}, env_vars = [], env = { ELECTRON_RUN_AS_NODE = "1" }, required = false, enabled = false, startup_timeout_sec = 10 }`
    const result = await runCodexCli({
      exe: nativeCodex,
      args: [
        'exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', projectPath,
        '-c', legacyTable,
        '-c', `mcp_servers.${probeName}={ ${table} }`,
        'Responda apenas com OK. Não execute comandos.',
      ],
      env: {
        ...process.env,
        ...accounts.account1.environment,
        DEVORBIT_BRIDGE_PIPE: sentinelPipe,
        DEVORBIT_BRIDGE_TOKEN: sentinelToken,
        DEVORBIT_SESSION_ID: sentinelSession,
      },
      cwd: projectPath,
      timeoutMs: Math.min(realTimeoutMs, 60_000),
    })
    let evidence = null
    try {
      evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'))
    } catch {
      evidence = null
    }
    const combinedOutput = `${result.stdout}\n${result.stderr}`
    registerSecretSource('codex-env-forwarding-probe-output', combinedOutput)
    assert(!combinedOutput.includes(sentinelToken), 'sonda Codex imprimiu o token sentinela')
    if (!evidence) {
      const failure = classifyCliFailure(result)
      const detail = `${failure.detail}; MCP fake não recebeu initialize/env_vars`
      codexMcpEnvForwarding = { status: failure.status, reason: detail, codexExit: result.code }
      throw failure.status === 'BLOCKED' ? new BlockedError(detail) : new Error(detail)
    }
    const expectedHash = crypto.createHash('sha256').update(sentinelToken).digest('hex')
    assert(evidence.tokenPresent === true, 'MCP fake não recebeu DEVORBIT_BRIDGE_TOKEN')
    assert(evidence.tokenLength === sentinelToken.length, 'MCP fake recebeu token sentinela com comprimento inesperado')
    assert(evidence.tokenHash === expectedHash, 'MCP fake recebeu valor diferente no DEVORBIT_BRIDGE_TOKEN')
    assert(evidence.pipePresent === true && evidence.sessionPresent === true, 'MCP fake não recebeu todos os env_vars canônicos')
    const evidenceText = fs.readFileSync(evidencePath, 'utf8')
    assert(!evidenceText.includes(sentinelToken), 'sonda persistiu o token sentinela em claro')
    codexMcpEnvForwarding = {
      status: 'PASS',
      codexExit: result.code,
      tokenPersisted: false,
      tokenPrinted: false,
      mcpInitialized: true,
    }
    const exitDetail = result.code === 0 ? 'exit 0' : `exit ${result.code} após iniciar o MCP (falha posterior do modelo/auth não invalida a sonda)`
    return { detail: `Codex real iniciou MCP fake; env_vars encaminhou token por hash sem impressão/persistência (${exitDetail})` }
  })

  await phase('reopen.launch', 'TRANSPORT', async () => {
    const launchB = 'launch-transport-b'
    transportHealth.configure('coordinator', launchB, transportService.runtime.sessionId)
    transportHealth.connecting('coordinator', launchB)
    assert(transportHealth.handshake({ terminalId: 'coordinator', launchId: launchA, sessionId: transportService.runtime.sessionId, pid: 1, connectedAt: 1 }) === false, 'novo configure deveria rejeitar handshake do lançamento antigo')
    const client = createMcpClient({ env: transportEnv, terminalId: 'coordinator', launchId: launchB, label: 'reopen' })
    try {
      const initialized = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '1' } })
      assert(initialized.result, 'initialize do relançamento falhou')
      client.notify('notifications/initialized', {})
      const health = await awaitHandshake(transportHealth, 'coordinator', 30_000)
      assert(health.launchId === launchB, 'health ainda aponta para o lançamento antigo')
      assert(typeof health.mcpPid === 'number' && health.mcpPid > 0, 'handshake sem pid do MCP')
      transportHealth.registryChanged(2)
      assert(transportHealth.get('coordinator').state === 'agents_available', `estado inesperado: ${transportHealth.get('coordinator').state}`)
      return { detail: `reopen trocou ${launchA} -> ${launchB}; handshake antigo rejeitado` }
    } finally {
      await client.close()
    }
  })

  if (transportMcp) await transportMcp.close()

  await phase('rotation.runtime-token', 'TRANSPORT', async () => {
    const handshakes1 = []
    const runtime1 = createAgentBridgeRuntime({
      cliDirectory: projectRoot,
      handlers: { list: async () => [] },
      onMcpHandshake: (input) => handshakes1.push(input),
    })
    runtime1.start()
    await runtime1.ready()
    cleanups.push(() => {
      try {
        runtime1.stop()
      } catch {
        /* já parado */
      }
    })
    secrets.set('token ROTATION-1', runtime1.token)
    secrets.set('session ROTATION-1', runtime1.sessionId)
    secrets.set('pipe ROTATION-1', runtime1.pipeName)
    const first = createMcpClient({ env: runtime1.env(), terminalId: 'coordinator', launchId: 'rot-1', label: 'rotation-1' })
    const firstInit = await first.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '1' } })
    assert(firstInit.result, 'MCP deveria conectar ao runtime 1')
    await first.close()
    runtime1.stop()

    const second = createMcpClient({ env: runtime1.env(), terminalId: 'coordinator', launchId: 'rot-old', label: 'rotation-old' })
    const staleInit = await second.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '1' } })
    assert(staleInit.error, 'credencial antiga deveria ser recusada após rotação')
    await second.close()

    const handshakes2 = []
    const runtime2 = createAgentBridgeRuntime({
      cliDirectory: projectRoot,
      handlers: { list: async () => [] },
      onMcpHandshake: (input) => handshakes2.push(input),
    })
    runtime2.start()
    await runtime2.ready()
    cleanups.push(() => {
      try {
        runtime2.stop()
      } catch {
        /* já parado */
      }
    })
    secrets.set('token ROTATION-2', runtime2.token)
    secrets.set('session ROTATION-2', runtime2.sessionId)
    secrets.set('pipe ROTATION-2', runtime2.pipeName)
    assert(runtime1.token !== runtime2.token, 'rotação deveria renovar o token')
    assert(runtime1.sessionId !== runtime2.sessionId, 'rotação deveria renovar a sessão')
    const third = createMcpClient({ env: runtime2.env(), terminalId: 'coordinator', launchId: 'rot-2', label: 'rotation-2' })
    try {
      const thirdInit = await third.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '1' } })
      assert(thirdInit.result, 'MCP deveria conectar ao runtime 2')
      third.notify('notifications/initialized', {})
      const deadline = Date.now() + 10_000
      while (handshakes2.length === 0 && Date.now() < deadline) await delay(50)
      assert(handshakes2.length === 1 && handshakes2[0].launchId === 'rot-2', `handshake do runtime 2 ausente: ${JSON.stringify(handshakes2)}`)
      return { detail: `runtime/token rotacionados; credencial antiga recusada (${staleInit.error.data ? staleInit.error.data.code : staleInit.error.code})` }
    } finally {
      await third.close()
      runtime2.stop()
    }
  })

  // --------------------------------------------------------------------- REAL
  let realWorkerPool = null
  let realService = null
  let realHealth = null
  let realEnv = null
  if (realEnabled) {
    realWorkerPool = createRealWorkerPool({ codexExe: nativeCodex, accounts: { w1: accounts.account1, w2: accounts.account2 } })
    realHealth = new CodexBridgeHealthStore(() => undefined, 120_000)
    realService = createBridgeService({
      ...realWorkerPool.deps,
      onMcpHandshake: (handshake) => {
        if (realHealth.handshake(handshake)) {
          realHealth.registryChanged(realService.listAgents().filter((agent) => agent.status === 'active').length)
        }
      },
      onRegistryChanged: () => {
        realHealth.registryChanged(realService.listAgents().filter((agent) => agent.status === 'active').length)
      },
    })
    cleanups.push(() => {
      try {
        realService.runtime.stop()
      } catch {
        /* já parado */
      }
      realHealth.dispose()
    })
    realService.registerAgent('w1', { provider: 'codex', model: 'real-worker', projectPath })
    realService.registerAgent('w2', { provider: 'codex', model: 'real-worker', projectPath })
    await realService.runtime.ready()
    realEnv = realService.runtime.env()
    secrets.set('token REAL', realService.runtime.token)
    secrets.set('session REAL', realService.runtime.sessionId)
    secrets.set('pipe REAL', realService.runtime.pipeName)
  }

  await phase('real.workers', 'REAL', async () => {
    if (!realEnabled) return { status: 'NOT_RUN', detail: 'DEVORBIT_CODEX_REAL_E2E=0' }
    if (process.env.DEVORBIT_CODEX_E2E_SKIP_WORKERS === '1') return { status: 'NOT_RUN', detail: 'DEVORBIT_CODEX_E2E_SKIP_WORKERS=1 (diagnóstico)' }
    if (!nativeCodex) throw new BlockedError('CLI nativo codex.exe não encontrado no Desktop')
    if (!accountAuth.account1 || !accountAuth.account2) throw new BlockedError('auth.json ausente/inválido em .codex-conta1 ou .codex-conta2')
    const expectations = { w1: 'PONG-W1', w2: 'PONG-W2' }
    const evidence = []
    for (const target of ['w1', 'w2']) {
      const response = await directBridgeRequest(
        realService.runtime.pipeName,
        realService.runtime.token,
        realService.runtime.sessionId,
        { type: 'ask', target, prompt: `Responda apenas com o texto ${expectations[target]}. Não execute comandos.`, timeoutMs: realTimeoutMs },
        realTimeoutMs + 30_000,
      )
      const prefix = evidence.length > 0 ? `${evidence.join('; ')}; ` : ''
      if (response.ok !== true) {
        const message = response.error && response.error.message ? String(response.error.message) : 'falha sem detalhe'
        const failure = classifyCliFailure({ code: 1, stdout: '', stderr: message, timedOut: false })
        const blocked = message.includes(' BLOCKED:') || failure.status === 'BLOCKED'
        throw blocked ? new BlockedError(`${prefix}${message}`) : new Error(`${prefix}${message}`)
      }
      const outcome = response.result || {}
      const summary = String(outcome.summary || '')
      if (outcome.status !== 'completed') {
        const failure = classifyCliFailure({ code: 1, stdout: '', stderr: summary, timedOut: false })
        const blocked = summary.includes(' BLOCKED:') || failure.status === 'BLOCKED'
        throw blocked ? new BlockedError(`${prefix}worker ${target} ${summary}`) : new Error(`${prefix}worker ${target} ${summary}`)
      }
      assert(summary.includes(expectations[target]), `worker ${target} respondeu ${summarizeText(summary, 120)}`)
      evidence.push(`${target}@${target === 'w1' ? '.codex-conta1' : '.codex-conta2'}:${expectations[target]}`)
    }
    const callsByTarget = new Map(realWorkerPool.calls.map((call) => [call.terminalId, call]))
    assert(callsByTarget.get('w1')?.accountHome === '.codex-conta1', `w1 não executou na conta1: ${callsByTarget.get('w1')?.accountHome}`)
    assert(callsByTarget.get('w2')?.accountHome === '.codex-conta2', `w2 não executou na conta2: ${callsByTarget.get('w2')?.accountHome}`)
    const calls = realWorkerPool.calls.map((call) => `${call.terminalId}@${call.accountHome}:exit=${call.code}:${call.output || ''}`).join(' | ')
    return { detail: `workers reais por conta responderam PONG-W1/PONG-W2 (${calls})` }
  })

  let execToolExposure = null
  await phase('codex.exec-tool-exposure', 'REAL', async () => {
    if (!realEnabled) return { status: 'NOT_RUN', detail: 'DEVORBIT_CODEX_REAL_E2E=0' }
    if (!nativeCodex) throw new BlockedError('CLI nativo codex.exe não encontrado no Desktop')
    if (!accountAuth.account1) throw new BlockedError('auth.json ausente/inválido em .codex-conta1')
    const probePath = requireScratch('exec-exposure-probe.cjs')
    const toolCallEvidencePath = requireScratch('exec-tool-calls.json')
    fs.writeFileSync(toolCallEvidencePath, '[]', 'utf8')
    fs.writeFileSync(probePath, `'use strict'
const fs = require('node:fs')
const readline = require('node:readline')
const callsPath = ${JSON.stringify(toolCallEvidencePath)}
const tools = ['agent_list', 'agent_ask'].map((name) => ({ name, description: 'probe ' + name, inputSchema: { type: 'object', properties: {} } }))
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  let request
  try { request = JSON.parse(line) } catch { return }
  if (request.method === 'initialize') return void process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'Probe', version: '1' } } }) + '\\n')
  if (request.method === 'tools/list') return void process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools } }) + '\\n')
  if (request.method === 'tools/call' && request.id !== undefined) {
    const calls = JSON.parse(fs.readFileSync(callsPath, 'utf8'))
    calls.push({ name: request.params && request.params.name })
    fs.writeFileSync(callsPath, JSON.stringify(calls), 'utf8')
    return void process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'probe-ok' }] } }) + '\\n')
  }
  if (request.method === 'notifications/initialized') return
  if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\\n')
})
`)
    const probeName = `devorbit_runtime_probe_${crypto.randomUUID().replaceAll('-', '')}`
    const table = `mcp_servers.${probeName}={ command = ${JSON.stringify(process.execPath)}, args = ${JSON.stringify([probePath])}, cwd = ${JSON.stringify(path.dirname(probePath))}, env_vars = [], env = { ELECTRON_RUN_AS_NODE = "1" }, required = true, enabled = true, startup_timeout_sec = 10 }`
    const result = await runCodexCli({
      exe: nativeCodex,
      args: [
        'exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', projectPath, '-c', table,
        'Call the DevOrbit MCP tool agent_list now. Do not list tools, answer from memory, or use shell. After it returns probe-ok, answer exactly PROBE-TOOL-CALLED.',
      ],
      env: { ...process.env, ...accounts.account1.environment },
      cwd: projectPath,
      timeoutMs: realTimeoutMs,
    })
    if (result.code !== 0) {
      const failure = classifyCliFailure(result)
      throw failure.status === 'BLOCKED' ? new BlockedError(failure.detail) : new Error(failure.detail)
    }
    const analysis = analyzeCodexEvents(result.stdout)
    const text = analysis.messages.join('\n')
    const recordedCalls = JSON.parse(fs.readFileSync(toolCallEvidencePath, 'utf8'))
    const callNames = [...analysis.tools.map((tool) => tool.tool), ...recordedCalls.map((call) => call.name)]
    const exposed = callNames.some((name) => /agent(?:[._]|__)list/iu.test(String(name)))
    execToolExposure = { exposed, exit: result.code, toolCalls: callNames, sample: summarizeText(text, 160) }
    registerSecretSource('exec-exposure', text)
    if (!exposed) {
      return { status: 'BLOCKED', detail: 'Codex exec terminou sem invocar agent_list após pedido direto; tool-call MCP não foi observado, disponibilidade inconclusiva' }
    }
    return { detail: `Codex exec invocou MCP agent_list (${callNames.filter(Boolean).join(', ')})` }
  })

  const coordinatorRuns = []
  async function runCoordinator({ account, terminalId, prompt, resume, threadId }) {
    assert(account.environment && account.environment.CODEX_HOME, `coordinator ${terminalId} sem CODEX_HOME da conta`)
    const scriptPath = process.env.DEVORBIT_CODEX_E2E_DEBUG === '1' ? writeCoordinatorDebugWrapper() : mcpScript
    const prepared = prepareDevOrbitCodexLaunch({
      accountEnvironment: account.environment,
      bridgeEnv: realEnv,
      terminalId,
      baseArgs: [
        ...(resume
          ? ['exec', 'resume', '--json', '--skip-git-repo-check']
          : ['exec', '--json', '--skip-git-repo-check', '-C', projectPath]),
        ...(process.env.DEVORBIT_CODEX_E2E_DEBUG === '1'
          ? ['-c', `log_dir=${path.join(scratchRoot, 'codex-logs')}`]
          : []),
      ],
      runtime: { executablePath: process.execPath, scriptPath, appPath: projectRoot, isPackaged: false },
    })
    assert(prepared.env.CODEX_HOME === account.environment.CODEX_HOME, `CODEX_HOME não aplicado ao coordinator ${terminalId}`)
    const staleProbe = await detectStaleDevOrbitEnv({ prepared, expectedEnv: realEnv })
    realHealth.configure(terminalId, prepared.mcp.launchId, realService.runtime.sessionId)
    realHealth.connecting(terminalId, prepared.mcp.launchId)
    const outFile = requireScratch(`coordinator-${terminalId}-${Date.now()}.txt`)
    // Resume usa EXATAMENTE o threadId criado pelo teste (nunca --last de conta real).
    const args = resume
      ? [...prepared.args, '-o', outFile, threadId, prompt]
      : [...prepared.args, '-o', outFile, prompt]
    const result = await runCodexCli({ exe: nativeCodex, args, env: prepared.env, cwd: projectPath, timeoutMs: realTimeoutMs })
    let handshake = null
    let handshakeError = null
    try {
      handshake = await awaitHandshake(realHealth, terminalId, 90_000)
    } catch (error) {
      handshakeError = error
    }
    let finalText = ''
    try {
      finalText = fs.readFileSync(outFile, 'utf8').trim()
    } catch {
      finalText = ''
    }
    const analysis = analyzeCodexEvents(result.stdout)
    const record = {
      terminalId,
      account: account.id,
      mcpName: prepared.mcp.name,
      accountHome: path.basename(account.environment.CODEX_HOME),
      threadId: analysis.threads[0] || null,
      staleOverrides: staleProbe.stale,
      staleProbeError: staleProbe.error || null,
      exit: result.code,
      timedOut: result.timedOut,
      handshake: Boolean(handshake),
      tools: [...new Set(analysis.tools.map((tool) => tool.tool))],
      finalText,
      stdout: result.stdout,
      stderr: result.stderr,
      handshakeError: handshakeError ? summarizeText(handshakeError.message) : null,
    }
    coordinatorRuns.push(record)
    registerSecretSource(`coordinator-${terminalId}-stdout`, result.stdout)
    registerSecretSource(`coordinator-${terminalId}-stderr`, result.stderr)
    registerSecretSource(`coordinator-${terminalId}-final`, finalText)
    fs.writeFileSync(requireScratch(`coordinator-${terminalId}-${Date.now()}-stdout.jsonl`), result.stdout)
    fs.writeFileSync(requireScratch(`coordinator-${terminalId}-${Date.now()}-stderr.log`), result.stderr)
    return record
  }

  await phase('real.coordinator', 'REAL', async () => {
    if (!realEnabled) return { status: 'NOT_RUN', detail: 'DEVORBIT_CODEX_REAL_E2E=0' }
    if (!nativeCodex) throw new BlockedError('CLI nativo codex.exe não encontrado no Desktop')
    if (!accountAuth.account1 || !accountAuth.account2) throw new BlockedError('auth.json ausente/inválido em .codex-conta1 ou .codex-conta2')
    const prompt = [
      'Você é o Codex Coordinator no DevOrbit.',
      'Chame a ferramenta MCP DevOrbit agent.list agora e use o resultado retornado.',
      'Depois chame agent.ask para o alvo w1 com o prompt "Responda apenas com o texto PONG-W1".',
      'Depois chame agent.ask para o alvo w2 com o prompt "Responda apenas com o texto PONG-W2".',
      'Não liste ferramentas, não responda de memória e não use shell.',
      'Responda em uma linha com os textos retornados pelas duas chamadas.',
      'Não execute comandos de shell.',
    ].join(' ')
    const summaries = []
    const selectedAccounts = (process.env.DEVORBIT_CODEX_E2E_COORDINATOR_ACCOUNTS || 'account1,account2')
      .split(',').map((value) => value.trim()).filter(Boolean)
    const targets = [['coordinator-account1', accounts.account1], ['coordinator-account2', accounts.account2]]
      .filter(([, account]) => selectedAccounts.includes(account.id))
    for (const [id, account] of targets) {
      const run = await runCoordinator({ account, terminalId: id, prompt, resume: false })
      if (run.exit !== 0) {
        if (run.staleOverrides.length > 0) {
          throw new BlockedError(`[mcp_servers.${run.mcpName}.env] persistido sobrepõe env_vars (${run.staleOverrides.join(', ')}); limitação upstream de deep-merge inesperada (${id})`)
        }
        const failure = classifyCliFailure({ code: run.exit, stdout: run.stdout, stderr: run.stderr, timedOut: run.timedOut })
        throw failure.status === 'BLOCKED' ? new BlockedError(`${failure.detail} (${id})`) : new Error(`${failure.detail} (${id})`)
      }
      assert(run.accountHome === (account.id === 'account1' ? '.codex-conta1' : '.codex-conta2'), `coordinator ${id} não executou na conta esperada: ${run.accountHome}`)
      assert(run.handshake, `handshake real do MCP não chegou (${id})${run.handshakeError ? `: ${run.handshakeError}` : ''}`)
      assert(hasCodexTool(run, 'agent.list'), `Codex não chamou agent.list (${id}); tools=${run.tools.join(',')}`)
      assert(hasCodexTool(run, 'agent.ask'), `Codex não chamou agent.ask (${id}); tools=${run.tools.join(',')}`)
      const evidence = `${run.stdout}\n${run.finalText}`
      assert(evidence.includes('PONG-W1') && evidence.includes('PONG-W2'), `respostas reais não transitaram pelo MCP (${id})`)
      summaries.push(`${id}@${run.accountHome}: tools=${run.tools.join('+')}`)
    }
    return { detail: summaries.join(' | ') }
  })

  await phase('real.resume', 'REAL', async () => {
    if (!realEnabled) return { status: 'NOT_RUN', detail: 'DEVORBIT_CODEX_REAL_E2E=0' }
    if (process.env.DEVORBIT_CODEX_E2E_SKIP_RESUME === '1') return { status: 'NOT_RUN', detail: 'DEVORBIT_CODEX_E2E_SKIP_RESUME=1 (diagnóstico)' }
    if (!nativeCodex) throw new BlockedError('CLI nativo codex.exe não encontrado no Desktop')
    if (!accountAuth.account1) throw new BlockedError('auth.json ausente/inválido em .codex-conta1')
    // Resume SOMENTE com o threadId criado por este teste; --last de conta real
    // poderia retomar conversa do usuário.
    const source = coordinatorRuns.find((run) => run.account === 'account1' && run.threadId)
    if (!source) {
      throw new BlockedError('coordinator-account1 não criou threadId; resume por id exato impossível (MCP falhou antes do modelo)')
    }
    const run = await runCoordinator({
      account: accounts.account1,
      terminalId: 'coordinator-resume',
      prompt: 'Chame a ferramenta MCP DevOrbit agent.list agora e responda com os ids ativos retornados. Não use shell nem responda de memória.',
      resume: true,
      threadId: source.threadId,
    })
    if (run.exit !== 0) {
      if (run.staleOverrides.length > 0) {
        throw new BlockedError(`[mcp_servers.${run.mcpName}.env] persistido sobrepõe env_vars (${run.staleOverrides.join(', ')}); limitação upstream de deep-merge inesperada (resume)`)
      }
      const failure = classifyCliFailure({ code: run.exit, stdout: run.stdout, stderr: run.stderr, timedOut: run.timedOut })
      throw failure.status === 'BLOCKED' ? new BlockedError(`${failure.detail} (resume)`) : new Error(`${failure.detail} (resume)`)
    }
    assert(run.accountHome === '.codex-conta1', `resume não executou na conta1: ${run.accountHome}`)
    assert(run.handshake, `handshake real ausente no resume${run.handshakeError ? `: ${run.handshakeError}` : ''}`)
    assert(hasCodexTool(run, 'agent.list'), `resume não chamou agent.list; tools=${run.tools.join(',')}`)
    if (run.threadId) assert(run.threadId === source.threadId, `resume retomou thread diferente: ${run.threadId} != ${source.threadId}`)
    const evidence = `${run.stdout}\n${run.finalText}`
    assert(evidence.includes('w1') && evidence.includes('w2'), 'resume não retornou os workers registrados')
    return { detail: `thread ${source.threadId.slice(0, 8)}… retomada; handshake + agent.list OK` }
  })

  // ---------------------------------------------------------------- AI-MEMORY
  // Doctor e wrapper/fallback são fases SEPARADAS: um doctor OK nunca deve ser
  // lido como wrapper/fallback aprovado.
  const aiMemoryBinary = await (async () => {
    const candidates = [
      path.join(projectRoot, 'node_modules', '.cache', 'ai-memory', 'ai-memory.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'devorbit', 'ai-memory', 'ai-memory.exe'),
    ]
    const known = candidates.find((file) => file && fs.existsSync(file))
    if (known) return known
    const lookup = await runCodexCli({ exe: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'where ai-memory'], env: process.env, cwd: projectRoot, timeoutMs: 10_000 })
    const line = String(lookup.stdout || '').split(/\r?\n/u).map((item) => item.trim()).find(Boolean)
    return line && fs.existsSync(line) ? line : null
  })()

  await phase('ai-memory.doctor', 'OPTIONAL', async () => {
    if (!aiMemoryBinary) return { status: 'NOT_RUN', detail: 'binário ai-memory ausente; doctor não executado' }
    const dataDir = path.join(scratchRoot, 'ai-memory-data')
    const doctor = await runCodexCli({ exe: aiMemoryBinary, args: ['--data-dir', dataDir, 'doctor'], env: process.env, cwd: projectRoot, timeoutMs: 60_000 })
    if (doctor.code !== 0) throw new Error(`ai-memory doctor falhou (exit ${doctor.code}): ${summarizeText(doctor.stderr || doctor.stdout, 200)}`)
    return { detail: `doctor real em data-dir temporário: ${summarizeText(doctor.stdout, 160)}` }
  })

  await phase('ai-memory.wrapper-fallback', 'OPTIONAL', () => {
    if (!aiMemoryBinary) return { status: 'NOT_RUN', detail: 'binário ai-memory ausente; wrapper/fallback não exercitado (sem editar config global)' }
    return { status: 'NOT_RUN', detail: 'binário presente, mas wrapper/fallback real não foi exercitado nesta missão; doctor não substitui wrapper' }
  })

  // ---------------------------------------------------------------- SECURITY
  await phase('security.token-scan', 'SECURITY', () => {
    for (const source of spawnAudit) registerSecretSource(`argv:${source.label}`, source.argv.join(' '))
    for (const source of streamsAudit) registerSecretSource(`stream:${source.label}`, source.text)
    for (const snapshot of transportHealthEvents) registerSecretSource('health-transport', JSON.stringify(snapshot))
    for (const file of [...listFilesBounded(scratchRoot), ...listFilesBounded(projectPath)]) {
      try {
        if (fs.statSync(file).size <= 1_000_000) registerSecretSource(`file:${path.relative(scratchRoot, file)}`, fs.readFileSync(file, 'utf8'))
      } catch {
        /* arquivo temporário já removido */
      }
    }
    const findings = scanRegisteredSecrets()
    assert(findings.length === 0, `segredos vazaram: ${findings.join('; ')}`)
    return { detail: `${secretSources.length} fontes varridas; token/sessão/pipe ausentes de argv, streams e arquivos` }
  })

  // ------------------------------------------------------------------ REPORT
  const summary = {
    harness: 'verify-codex-bridge',
    generatedAt: new Date().toISOString(),
    projectBase: projectBasePath,
    projectPath,
    realEnabled,
    codex: {
      native: nativeCodex,
      nativeVersion,
      appResolved: appResolvedCodex,
      npm: npmCodexVersion,
    },
    accounts: {
      authChecked: realEnabled,
      account1: { home: path.basename(accounts.account1.environment.CODEX_HOME), auth: realEnabled ? accountAuth.account1 : null },
      account2: { home: path.basename(accounts.account2.environment.CODEX_HOME), auth: realEnabled ? accountAuth.account2 : null },
    },
    mcpEnvForwardingProbe: codexMcpEnvForwarding,
    coverage: {
      proved: [
        'Codex CLI mcp list/get em CODEX_HOME temporário: stale env legado preservado apenas na entrada desabilitada',
        'MCP stdio real via Electron RUN_AS_NODE + bridge autenticada (env/ping/handshake/list/ask)',
        'prepareDevOrbitCodexLaunch: tabela TOML única, token só em env, launchId por execução',
        'Codex CLI real iniciou MCP fake e encaminhou DEVORBIT_BRIDGE_TOKEN via env_vars sem imprimir/persistir o sentinela',
        'Codex CLI nativo real por conta (.codex-conta1/.codex-conta2) como workers de modelo real',
        'reopen por launchId e rotação de runtime/token',
      ],
      notCovered: [
        'UI/renderer do DevOrbit (janela, WorkspaceTerminal, painel de saúde)',
        'startCodexTerminal/terminal-ipc (caminho PTY de produção e sendAgentInstruction real)',
        'eventos IPC devorbit:codexBridgeHealth no renderer',
        'restart/relançamento do app Electron (before-quit + restore de workspace)',
        'ai-memory wrapper/fallback real (somente doctor quando o binário existe)',
      ],
      nextPhase: 'Após as entregas: acionar startCodexTerminal via IPC de produção em harness de janela real e validar UI/health/restart com snapshot do app.',
    },
    phases,
    blockers,
    failures: phases.filter((entry) => entry.status === 'FAIL'),
    execToolExposure,
    limits: [
      'A entrada legada devorbit permanece visível com env antigo, mas recebe enabled=false por launch; o namespace fresco não herda essa tabela.',
      'Um nome legado arbitrário além de devorbit não pode ser removido por --config sem conhecer a chave; a prova mcp list exige que o namespace gerenciado conhecido esteja desabilitado.',
      'Upstream deep-merge de -c: tabelas persistidas (env/url/http_headers) não podem ser removidas via CLI; a entrada legada é desabilitada por launch e a definição fresca usa namespace isolado.',
      'Aliases de env por launch foram avaliados e NÃO integrados: contrato vigente exige env_vars somente com os três nomes canônicos; proposta mantida fora do código (scratch).',
      'Resets comprovados e aplicados: enabled_tools=[] e disabled_tools=[] limpam arrays persistidos (arrays substituem no leaf).',
      'url persistido em mcp_servers.devorbit continua no registro desabilitado; o lançamento fresco usa namespace stdio separado e não edita config persistido.',
      'Cobertura ausente: UI/renderer, startCodexTerminal/terminal-ipc, IPC de saúde e restart do app.',
    ],
    coordinatorRuns: coordinatorRuns.map((run) => ({
      terminalId: run.terminalId,
      account: run.account,
      mcpName: run.mcpName,
      accountHome: run.accountHome,
      threadId: run.threadId,
      staleOverrides: run.staleOverrides,
      staleProbeError: run.staleProbeError,
      exit: run.exit,
      handshake: run.handshake,
      tools: run.tools,
      final: summarizeText(run.finalText, 200),
    })),
  }
  let reportText = redactSecrets(JSON.stringify(summary, null, 2))
  registerSecretSource('report', reportText)
  const reportFindings = scanRegisteredSecrets()
  if (reportFindings.length > 0) {
    summary.failures.push({ id: 'security.report', detail: reportFindings.join('; ') })
    reportText = redactSecrets(JSON.stringify(summary, null, 2))
  }
  fs.writeFileSync(path.join(scratchRoot, 'verify-codex-bridge-report.json'), reportText)
  process.stdout.write(`${reportText}\n`)
  process.exitCode = summary.failures.length > 0 ? 1 : 0
  if (process.exitCode !== 0) log(`FALHAS: ${summary.failures.map((entry) => entry.id).join(', ')}`)
  log(`relatório: ${path.join(scratchRoot, 'verify-codex-bridge-report.json')}`)
  log(`fases: ${phases.map((entry) => `${entry.id}=${entry.status}`).join(' ')}`)
}

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox')

app.whenReady().then(async () => {
  try {
    await main()
  } catch (error) {
    console.error('verify-codex-bridge failed')
    console.error(error && error.stack ? error.stack : error)
    process.exitCode = 1
  } finally {
    for (const child of liveChildren) {
      try {
        child.kill()
      } catch {
        /* já morto */
      }
    }
    await delay(250)
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup()
      } catch {
        /* teardown defensivo */
      }
    }
    if (process.exitCode === 0 && !keepScratch) {
      try {
        fs.rmSync(scratchRoot, { recursive: true, force: true })
      } catch {
        /* scratch já removido */
      }
    } else {
      log(`scratch mantido em ${scratchRoot}`)
    }
    try {
      fs.rmSync(emitRoot, { recursive: true, force: true })
    } catch {
      /* emit já removido */
    }
    app.quit()
  }
})
