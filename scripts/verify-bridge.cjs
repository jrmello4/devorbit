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
  const terminalListeners = new Set()
  const written = []
  const events = []
  const reflections = []
  const headless = []
  const guards = []
  let started = 0

  const service = createBridgeService({
    cliDirectory: projectRoot,
    hasTerminal: (id) => id === 't1' || id === 't2',
    subscribe: (listener) => {
      terminalListeners.add(listener)
      return () => terminalListeners.delete(listener)
    },
    sendInstruction: async (input) => {
      const id = input.terminalId
      const prompt = input.content.split('\n\n')[0]
      written.push({ id, prompt })
      for (const phase of ['content_written', 'submit_sent', 'acked']) {
        input.onPhase({ kind: 'instruction', terminalId: id, turnId: input.turnId,
          provider: input.provider, phase, at: Date.now(), attempt: 1 })
      }
      setImmediate(() => {
        const outcome = prompt.startsWith('block:') ? 'blocked' : prompt.startsWith('fail:') ? 'failed' : 'completed'
        const summary = outcome === 'blocked' ? `bloqueado:${prompt.slice(6)}`
          : outcome === 'failed' ? `falhou:${prompt.slice(5)}` : `resultado:${prompt}`
        const data = `DEVORBIT_RESULT_${input.turnId}: ${JSON.stringify({ version: 1, outcome, summary })}\r\n`
        for (const listener of [...terminalListeners]) listener({ id, type: 'data', data })
      })
      return { acked: true, attempts: 1 }
    },
    waitTurnResult: () => { throw new Error('managed turns must use the nonce-bound waiter') },
    onEvent: (event) => {
      events.push(event)
    },
    onReflection: (target, outcome) => {
      reflections.push({ target, ...outcome })
    },
    runHeadlessTurn: async (target, agent, input) => {
      headless.push({ target, provider: agent.provider, prompt: input.prompt, model: input.model, mode: input.mode })
      if (input.prompt.startsWith('fail:')) return { status: 'failed', summary: 'headless falhou' }
      return { status: 'completed', summary: `headless:${input.prompt}`, artifacts: ['artefato.md'] }
    },
    onGuard: (audit) => {
      guards.push(audit)
    },
  }, { allowedTargets: ['t1'] })

  service.registerAgent('t1', { provider: 'opencode', model: 'fixture-model', projectPath: projectRoot })
  // Alvo registrado mas FORA da allow-list: valida o guardrail auditável.
  service.registerAgent('t2', { provider: 'opencode', model: 'fixture-model', projectPath: projectRoot })
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
  assert(Array.isArray(listPayload) && listPayload[0]?.id === 't1' && listPayload[0]?.status === 'starting', 'payload de list inesperado')
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

  const headlessRun = await runBridgeCli(
    ['agent', 'run', 't1', 'tarefa H', '--model', 'gemini-2.0-flash', '--mode', 'accept-edits', '--json'],
    bridgeEnv,
  )
  assert(headlessRun.code === 0, `run falhou: ${headlessRun.stderr.trim()}`)
  const headlessOutcome = JSON.parse(headlessRun.stdout.trim())
  assert(headlessOutcome.status === 'completed' && headlessOutcome.summary === 'headless:tarefa H', `run inesperado: ${headlessRun.stdout.trim()}`)
  assert(headlessOutcome.origin === 'devorbit' && headlessOutcome.destination === 't1', `run sem origem/destino: ${headlessRun.stdout.trim()}`)
  assert(headlessOutcome.result && headlessOutcome.result.outcome === 'completed', `run sem resultado estruturado: ${headlessRun.stdout.trim()}`)
  assert(headless.length === 1 && headless[0].model === 'gemini-2.0-flash' && headless[0].mode === 'accept-edits', `runner headless nao recebeu as opcoes: ${JSON.stringify(headless)}`)
  pass('agent run executou turno nao-interativo com resultado estruturado')

  const blockedByAllowList = await runBridgeCli(['agent', 'send', 't2', 'tarefa X'], bridgeEnv)
  assert(blockedByAllowList.code !== 0, 'allow-list deveria bloquear o alvo t2')
  assert(
    guards.some((item) => item.kind === 'delegation.guard' && item.code === 'TARGET_NOT_ALLOWED' && item.target === 't2'),
    `auditoria de guardrail ausente: ${JSON.stringify(guards)}`,
  )
  pass('allow-list bloqueou a delegacao e registrou auditoria')

  const runEvent = [...events].reverse().find((event) => event.status === 'completed' && event.result && event.result.summary === 'headless:tarefa H')
  assert(
    runEvent && runEvent.origin === 'devorbit' && runEvent.destination === 't1' && runEvent.result.outcome === 'completed' && Array.isArray(runEvent.result.artifacts),
    `evento de run sem origem/destino/resultado: ${JSON.stringify(events.at(-1))}`,
  )
  pass('evento de delegacao carregou origem, destino, status e resultado')

  service.runtime.stop()
  assert(started === 1, 'runtime nao iniciou exatamente uma vez')
}

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox')

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
