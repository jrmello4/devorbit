/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
'use strict'

const electron = require('electron')
const { app } = electron
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')

const projectRoot = path.resolve(__dirname, '..')
const bridgeCli = path.join(projectRoot, 'scripts', 'devorbit-bridge.cjs')
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devorbit-bridge-e2e-'))
const emitRoot = path.join(projectRoot, 'node_modules', '.cache', `devorbit-bridge-e2e-${process.pid}`)

const checks = []

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function pass(message) {
  checks.push(message)
  console.log(`PASS ${message}`)
}

function compileBridgeService() {
  fs.mkdirSync(path.join(projectRoot, 'node_modules', '.cache'), { recursive: true })
  fs.rmSync(emitRoot, { recursive: true, force: true })
  fs.mkdirSync(emitRoot, { recursive: true })
  fs.writeFileSync(path.join(emitRoot, 'package.json'), JSON.stringify({ type: 'commonjs' }))
  const program = ts.createProgram([path.join(projectRoot, 'src', 'main', 'bridge-service.ts')], {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
    outDir: emitRoot,
    rootDir: projectRoot,
    skipLibCheck: true,
    types: [],
  })
  const emitted = program.emit()
  assert(!emitted.emitSkipped, 'nao foi possivel emitir o bridge-service para o teste')
  const entry = path.join(emitRoot, 'src', 'main', 'bridge-service.js')
  assert(fs.existsSync(entry), `bridge-service nao emitido em ${entry}`)
  return require(entry)
}

function runBridgeCli(args, bridgeEnv, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bridgeCli, ...args], {
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ...bridgeEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, stdout, stderr })
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: null, timedOut: true })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => finish({ code: null, error }))
    child.on('close', (code) => finish({ code }))
  })
}

async function main() {
  assert(process.env.ELECTRON_RUN_AS_NODE !== '1', 'Electron foi iniciado como Node; use `npx electron scripts/verify-bridge.cjs`')
  assert(fs.existsSync(bridgeCli), `CLI do bridge ausente em ${bridgeCli}`)

  const { createBridgeService } = compileBridgeService()
  const waiters = new Map()
  const written = []
  const events = []
  const reflections = []
  let started = 0

  const createWaiter = () => {
    let resolveOutcome = () => undefined
    const promise = new Promise((resolve) => {
      resolveOutcome = resolve
    })
    promise.cancel = () => resolveOutcome({ error: 'cancelada' })
    return { promise, resolve: resolveOutcome }
  }

  const service = createBridgeService({
    cliDirectory: projectRoot,
    hasTerminal: (id) => id === 't1',
    writeTerminal: (id, input) => {
      const prompt = input.replace(/\r$/u, '')
      written.push({ id, prompt })
      const waiter = waiters.get(id)
      setImmediate(() => {
        if (!waiter) return
        if (prompt.startsWith('block:')) waiter.resolve({ blocked: `bloqueado:${prompt.slice(6)}` })
        else if (prompt.startsWith('fail:')) waiter.resolve({ error: `falhou:${prompt.slice(5)}` })
        else waiter.resolve({ result: `resultado:${prompt}` })
      })
      return true
    },
    waitTurnResult: (id) => {
      const waiter = createWaiter()
      waiters.set(id, waiter)
      return waiter.promise
    },
    onEvent: (event) => {
      events.push(event)
    },
    onReflection: (target, outcome) => {
      reflections.push({ target, ...outcome })
    },
  })

  service.registerAgent('t1', { provider: 'opencode', model: 'fixture-model', projectPath: projectRoot })
  const server = service.runtime.start()
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve))
  started += 1
  pass('runtime do bridge iniciou o servidor local')

  const bridgeEnv = {
    DEVORBIT_BRIDGE_PIPE: service.runtime.pipeName,
    DEVORBIT_BRIDGE_TOKEN: service.runtime.token,
    DEVORBIT_SESSION_ID: service.runtime.sessionId,
  }

  const listed = await runBridgeCli(['agent', 'list', '--json'], bridgeEnv)
  assert(listed.code === 0, `list falhou: ${listed.stderr.trim()}`)
  const listPayload = JSON.parse(listed.stdout.trim())
  assert(Array.isArray(listPayload) && listPayload[0]?.id === 't1' && listPayload[0]?.status === 'active', `payload de list inesperado: ${listed.stdout.trim()}`)
  pass('CLI real listou o agente ativo pelo transporte do bridge')

  const send = await runBridgeCli(['agent', 'send', 't1', 'tarefa A'], bridgeEnv)
  assert(send.code === 0, `send falhou: ${send.stderr.trim()}`)
  assert(JSON.parse(send.stdout.trim()).accepted === true, `send nao aceitou: ${send.stdout.trim()}`)

  const waitAfterSend = await runBridgeCli(['agent', 'wait', 't1', '--timeout', '5s'], bridgeEnv)
  assert(waitAfterSend.code === 0, `wait falhou: ${waitAfterSend.stderr.trim()}`)
  const sentOutcome = JSON.parse(waitAfterSend.stdout.trim())
  assert(sentOutcome.status === 'completed' && sentOutcome.summary === 'resultado:tarefa A', `wait apos send retornou outro resultado: ${waitAfterSend.stdout.trim()}`)
  pass('send seguido de wait retornou o resultado correlacionado da mesma tarefa')

  const ask = await runBridgeCli(['agent', 'ask', 't1', 'tarefa B', '--json'], bridgeEnv)
  assert(ask.code === 0, `ask falhou: ${ask.stderr.trim()}`)
  const askOutcome = JSON.parse(ask.stdout.trim())
  assert(askOutcome.status === 'completed' && askOutcome.summary === 'resultado:tarefa B', `ask retornou outro resultado: ${ask.stdout.trim()}`)

  const waitAfterAsk = await runBridgeCli(['agent', 'wait', 't1', '--timeout', '5s'], bridgeEnv)
  const cachedOutcome = JSON.parse(waitAfterAsk.stdout.trim())
  assert(cachedOutcome.summary === 'resultado:tarefa B', `wait posterior ao ask nao reaproveitou o resultado: ${waitAfterAsk.stdout.trim()}`)
  pass('ask guardou o resultado para o wait posterior')

  const blockedSend = await runBridgeCli(['agent', 'send', 't1', 'block:tarefa C'], bridgeEnv)
  assert(blockedSend.code === 0, `send bloqueado falhou: ${blockedSend.stderr.trim()}`)
  const blockedWait = await runBridgeCli(['agent', 'wait', 't1', '--timeout', '5s'], bridgeEnv)
  const blockedOutcome = JSON.parse(blockedWait.stdout.trim())
  assert(blockedOutcome.status === 'blocked' && blockedOutcome.summary === 'bloqueado:tarefa C', `blocked inesperado: ${blockedWait.stdout.trim()}`)
  pass('bloqueio do agente chegou ao CLI com status blocked')

  const unrelated = await runBridgeCli(['agent', 'wait', 't1', '--timeout', '1s'], bridgeEnv)
  assert(unrelated.code === 0, `wait sem pendencia falhou: ${unrelated.stderr.trim()}`)
  assert(written.map((item) => item.prompt).join('|') === 'tarefa A|tarefa B|block:tarefa C', `prompts inesperados: ${JSON.stringify(written)}`)
  assert(events.length >= 6 && events.every((event) => typeof event.requestId === 'string' && event.requestId.length > 0), 'eventos do bridge sem requestId')
  assert(new Set(events.map((event) => event.requestId)).size >= 4, 'requestIds nao sao distintos por ciclo')
  assert(reflections.length >= 3 && reflections.every((item) => item.target === 't1'), `reflexoes inesperadas: ${JSON.stringify(reflections)}`)
  pass('eventos e reflexoes ficaram correlacionados por requestId/revisao')

  service.runtime.stop()
  assert(started === 1, 'runtime nao iniciou exatamente uma vez')
}

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

app.whenReady().then(async () => {
  try {
    await main()
    console.log(`Bridge E2E passed: ${checks.length} checks`)
    process.exitCode = 0
  } catch (error) {
    console.error('Bridge E2E failed')
    console.error(error && error.stack ? error.stack : error)
    process.exitCode = 1
  } finally {
    try {
      fs.rmSync(emitRoot, { recursive: true, force: true })
    } catch {
      process.exitCode = process.exitCode || 1
    }
    try {
      fs.rmSync(scratchRoot, { recursive: true, force: true })
    } catch {
      process.exitCode = process.exitCode || 1
    }
    app.quit()
  }
})
