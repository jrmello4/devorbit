import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_PROVIDERS,
  activeHeadlessRunCount,
  buildAgyHeadlessInvocation,
  createHeadlessTurnRunner,
  drainHeadlessFinalizers,
  drainHeadlessRuns,
  generateHeadlessExecutionId,
  isHeadlessProvider,
  parseHeadlessOutput,
  pendingHeadlessFinalizerCount,
  resetHeadlessFinalizersForTests,
  runHeadlessInvocation,
  terminateProcessTree,
  trackHeadlessFinalizer,
  type HeadlessMemoryLaunchRequest,
} from '../src/main/bridge-headless'

interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: EventEmitter & { end: (value?: string) => void; write: (value: string) => boolean }
  kill: ReturnType<typeof vi.fn>
  writes: string[]
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.writes = []
  child.stdin = Object.assign(new EventEmitter(), {
    end: (value?: string) => {
      if (value) child.writes.push(value)
    },
    write: () => true,
  })
  child.kill = vi.fn()
  return child
}

interface SpawnCall {
  command: string
  args: readonly string[]
  options?: unknown
}

/** Fake spawn que registra (command, args, options) e devolve o child. */
function recordingSpawn(child: FakeChild, calls: SpawnCall[]): typeof spawn {
  return ((command: string, args: readonly string[], options?: unknown) => {
    calls.push({ command, args, options })
    return child
  }) as unknown as typeof spawn
}

describe('bridge headless — agy não interativo', () => {
  it('só considera o agy como provedor headless', () => {
    expect(HEADLESS_PROVIDERS).toEqual(['agy'])
    expect(isHeadlessProvider('agy')).toBe(true)
    expect(isHeadlessProvider('opencode')).toBe(false)
  })

  it('constrói o argv de print mode e entrega o prompt por stdin', () => {
    const invocation = buildAgyHeadlessInvocation('C:\\cli\\agy.exe', {
      prompt: 'implemente a tarefa',
      model: 'gemini-2.0-flash',
      mode: 'accept-edits',
      effort: 'high',
    })

    expect(invocation.stdin).toBe('implemente a tarefa')
    expect(invocation.args).toContain('--print')
    expect(invocation.args).toContain('--output-format')
    expect(invocation.args).toContain('json')
    expect(invocation.args).toEqual(expect.arrayContaining(['--model', 'gemini-2.0-flash', '--mode', 'accept-edits', '--effort', 'high']))
    // O prompt nunca entra no argv.
    expect(invocation.args.join(' ')).not.toContain('implemente a tarefa')
  })

  it.runIf(process.platform === 'win32')('cita o wrapper .cmd verbatim (caminhos com espaço)', () => {
    const invocation = buildAgyHeadlessInvocation('C:\\Program Files\\agy\\agy.cmd', {
      prompt: 'x',
      model: 'gemini-2.0-flash',
    })
    expect(invocation.command).toBe(process.env.ComSpec || 'cmd.exe')
    expect(invocation.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(invocation.args[3]).toBe(
      '""C:\\Program Files\\agy\\agy.cmd" --print --output-format json --model gemini-2.0-flash"',
    )
    expect(invocation.windowsVerbatimArguments).toBe(true)
    expect(invocation.stdin).toBe('x')
  })

  it('recusa caminho de CLI e opções inseguras', () => {
    expect(() => buildAgyHeadlessInvocation('C:\\cli\\agy%PATH%.exe', { prompt: 'x' })).toThrow(/inválido/i)
    expect(() => buildAgyHeadlessInvocation('C:\\cli\\agy.exe', { prompt: 'x', model: 'bad model' })).toThrow(/model/i)
    expect(() => buildAgyHeadlessInvocation('C:\\cli\\agy.exe', { prompt: '   ' })).toThrow(/Prompt/i)
  })

  it('interpreta DEVORBIT_RESULT, JSON e texto puro', () => {
    expect(parseHeadlessOutput({
      stdout: 'DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"pronto"}\n',
      code: 0,
    })).toMatchObject({ status: 'completed', summary: 'pronto' })

    expect(parseHeadlessOutput({
      stdout: JSON.stringify({ status: 'completed', summary: 'json ok', artifacts: ['a.md'] }),
      code: 0,
    })).toMatchObject({ status: 'completed', summary: 'json ok', artifacts: ['a.md'] })

    expect(parseHeadlessOutput({ stdout: 'tudo certo', code: 0 })).toMatchObject({ status: 'completed', summary: 'tudo certo' })
    expect(parseHeadlessOutput({ stdout: 'explodiu', code: 1 })).toMatchObject({ status: 'failed' })
    expect(parseHeadlessOutput({ stdout: '', stderr: '', code: 1 }).status).toBe('failed')
  })

  it('spawna o processo, lê a saída e resolve o resultado estruturado', async () => {
    const child = fakeChild()
    const spawnImpl = (() => child) as unknown as typeof import('node:child_process').spawn
    const invocation = buildAgyHeadlessInvocation('C:\\cli\\agy.exe', { prompt: 'rode' })

    const promise = runHeadlessInvocation(invocation, { cwd: process.cwd(), spawnImpl })
    child.stdout.emit('data', Buffer.from('DEVORBIT_RESULT: {"version":1,"outcome":"blocked","summary":"sem permissao"}\n'))
    child.emit('close', 0)

    await expect(promise).resolves.toMatchObject({ status: 'blocked', summary: 'sem permissao' })
    expect(child.writes.join('')).toContain('rode')
  })

  it('consome EPIPE assíncrono de stdin e aguarda o close do filho', async () => {
    const child = fakeChild()
    const spawnImpl = (() => child) as unknown as typeof import('node:child_process').spawn
    const invocation = buildAgyHeadlessInvocation('C:\\cli\\agy.exe', { prompt: 'rode' })
    const promise = runHeadlessInvocation(invocation, { cwd: process.cwd(), spawnImpl })

    expect(() => child.stdin.emit('error', Object.assign(new Error('stdin fechado'), { code: 'EPIPE' }))).not.toThrow()
    child.emit('close', 0)
    await expect(promise).resolves.toMatchObject({ status: 'failed' })
  })

  it('encerra por timeout como falha estruturada', async () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      const spawnImpl = (() => child) as unknown as typeof import('node:child_process').spawn
      const invocation = buildAgyHeadlessInvocation('C:\\cli\\agy.exe', { prompt: 'demora' })
      const promise = runHeadlessInvocation(invocation, { cwd: process.cwd(), timeoutMs: 1_000, spawnImpl })
      await vi.advanceTimersByTimeAsync(1_100)
      await expect(promise).resolves.toMatchObject({ status: 'failed' })
      expect(child.kill).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('o runner resolve o binário e recusa provedores sem print mode', async () => {
    const child = fakeChild()
    const spawnImpl = (() => child) as unknown as typeof import('node:child_process').spawn
    const resolveCommand = vi.fn(async () => 'C:\\cli\\agy.exe')
    const runner = createHeadlessTurnRunner({ resolveCommand, spawnImpl })

    const promise = runner({ provider: 'agy', prompt: 'x', cwd: process.cwd() })
    await new Promise((resolve) => setImmediate(resolve))
    child.stdout.emit('data', Buffer.from('DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"ok"}\n'))
    child.emit('close', 0)
    await expect(promise).resolves.toMatchObject({ status: 'completed', summary: 'ok' })
    expect(resolveCommand).toHaveBeenCalledWith('agy')

    await expect(runner({ provider: 'opencode', prompt: 'x', cwd: process.cwd() })).rejects.toThrow(/não suporta turno não-interativo/i)
  })

  it('compõe process.env com o overlay de provider/bridge sem apagar autenticação', () => {
    const previous = process.env.HEADLESS_BASE_SENTINEL
    process.env.HEADLESS_BASE_SENTINEL = 'base'
    try {
      const invocation = buildAgyHeadlessInvocation('C:\\cli\\agy.exe', {
        prompt: 'x',
        env: { GEMINI_API_KEY: 'gk', HEADLESS_BASE_SENTINEL: 'override', EMPTY: undefined },
      })
      expect(invocation.env.HEADLESS_BASE_SENTINEL).toBe('override')
      expect(invocation.env.GEMINI_API_KEY).toBe('gk')
      expect(invocation.env.PATH).toBe(process.env.PATH)
      expect('EMPTY' in invocation.env).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.HEADLESS_BASE_SENTINEL
      else process.env.HEADLESS_BASE_SENTINEL = previous
    }
  })

  it('no timeout encerra a árvore e aguarda o término antes de resolver', async () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      ;(child as unknown as { pid: number }).pid = 4242
      const spawnImpl = (() => child) as unknown as typeof spawn
      let release!: () => void
      const killTreeImpl = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
      const invocation = buildAgyHeadlessInvocation('C:\\cli\\agy.exe', { prompt: 'demora' })
      const promise = runHeadlessInvocation(invocation, { cwd: process.cwd(), timeoutMs: 1_000, spawnImpl, killTreeImpl })
      let resolved = false
      void promise.then(() => { resolved = true })

      await vi.advanceTimersByTimeAsync(1_100)
      expect(killTreeImpl).toHaveBeenCalledWith(4242, child)
      await Promise.resolve()
      expect(resolved).toBe(false)

      release()
      await expect(promise).resolves.toMatchObject({ status: 'failed' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('no abort encerra a árvore e aguarda o término antes de rejeitar', async () => {
    const child = fakeChild()
    ;(child as unknown as { pid: number }).pid = 77
    const spawnImpl = (() => child) as unknown as typeof spawn
    let release!: () => void
    const killTreeImpl = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const controller = new AbortController()
    const invocation = buildAgyHeadlessInvocation('C:\\cli\\agy.exe', { prompt: 'x' })
    const promise = runHeadlessInvocation(invocation, { cwd: process.cwd(), spawnImpl, killTreeImpl, signal: controller.signal })
    let settled = false
    void promise.catch(() => { settled = true })

    controller.abort()
    await Promise.resolve()
    expect(killTreeImpl).toHaveBeenCalledWith(77, child)
    expect(settled).toBe(false)

    release()
    await expect(promise).rejects.toMatchObject({ code: 'HEADLESS_ABORTED' })
  })

  it.runIf(process.platform === 'win32')('taskkill /T encerra o wrapper e o filho persistente', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-headless-'))
    const pidFile = path.join(directory, 'child.pid')
    const scriptFile = path.join(directory, 'child.cjs')
    await fs.writeFile(
      scriptFile,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetInterval(() => {}, 1000)\n`,
    )
    const line = `"${process.execPath}" "${scriptFile}"`
    const wrapper = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsVerbatimArguments: true,
    })
    try {
      await waitFor(async () => {
        try {
          await fs.stat(pidFile)
          return true
        } catch {
          return false
        }
      })
      const grandchildPid = Number((await fs.readFile(pidFile, 'utf8')).trim())
      expect(grandchildPid).toBeGreaterThan(0)

      await expect(terminateProcessTree(wrapper.pid, wrapper)).resolves.toBeUndefined()
      // O neto persistente precisa ter morrido junto (taskkill /T).
      await waitFor(() => {
        try {
          process.kill(grandchildPid, 0)
          return false
        } catch {
          return true
        }
      })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})

describe('bridge headless — envólucro ai-memory (workstream/sessão/finalize)', () => {
  it('embrulha com prepareMemoryLaunch e finaliza após o close', async () => {
    const child = fakeChild()
    const calls: SpawnCall[] = []
    const spawnImpl = recordingSpawn(child, calls)
    const finalize = vi.fn(async () => undefined)
    const prepareMemoryLaunch = vi.fn(async (request: HeadlessMemoryLaunchRequest) => ({
      command: 'C:\\bin\\ai-memory.exe',
      args: ['--data-dir', 'd', 'run', '--new', 'ws', '--executable', 'C:\\cli\\agy.exe', 'antigravity', '--', ...request.args],
      env: { AI_MEMORY_RUN_ID: 'run-1', PATH: 'C:\\Windows' },
      cwd: 'C:\\proj',
      finalize,
    }))
    const runner = createHeadlessTurnRunner({ spawnImpl, prepareMemoryLaunch, resolveCommand: async () => 'C:\\cli\\agy.exe' })

    const promise = runner({ provider: 'agy', prompt: 'tarefa', cwd: 'C:\\proj' })
    await new Promise((resolve) => setImmediate(resolve))
    child.stdout.emit('data', Buffer.from('DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"ok"}\n'))
    child.emit('close', 0)

    await expect(promise).resolves.toMatchObject({ status: 'completed', summary: 'ok' })
    expect(calls[0].command).toBe('C:\\bin\\ai-memory.exe')
    expect(calls[0].args).toEqual(expect.arrayContaining(['--print', '--output-format', 'json']))
    expect(calls[0].options).toMatchObject({ cwd: 'C:\\proj' })
    // Flags nativas passadas ao launcher; prompt vai por stdin (nunca argv).
    expect(prepareMemoryLaunch.mock.calls[0][0].args).toEqual(expect.arrayContaining(['--print', '--output-format', 'json']))
    expect(child.writes.join('')).toContain('tarefa')
    await waitFor(() => finalize.mock.calls.length === 1)
    expect(finalize).toHaveBeenCalledTimes(1)
  })

  it('executa direto quando prepareMemoryLaunch devolve undefined (opt-out/degradado)', async () => {
    const child = fakeChild()
    const calls: SpawnCall[] = []
    const spawnImpl = recordingSpawn(child, calls)
    const prepareMemoryLaunch = vi.fn(async () => undefined)
    const runner = createHeadlessTurnRunner({
      spawnImpl,
      prepareMemoryLaunch,
      resolveCommand: async () => 'C:\\cli\\agy.exe',
    })

    const promise = runner({ provider: 'agy', prompt: 'x', cwd: 'C:\\p' })
    await new Promise((resolve) => setImmediate(resolve))
    child.stdout.emit('data', Buffer.from('ok'))
    child.emit('close', 0)

    await promise
    expect(prepareMemoryLaunch).toHaveBeenCalledTimes(1)
    expect(calls[0].command).toBe('C:\\cli\\agy.exe')
    expect(calls[0].args).toEqual(expect.arrayContaining(['--print']))
  })

  it('runs paralelos recebem executionId único (workstreams independentes)', async () => {
    const seen: string[] = []
    const prepareMemoryLaunch = vi.fn(async (request: HeadlessMemoryLaunchRequest) => {
      seen.push(request.executionId)
      return {
        command: 'C:\\bin\\ai-memory.exe',
        args: ['run', '--new', request.executionId, '--print'],
        env: {},
        finalize: async () => undefined,
      }
    })
    const children = [fakeChild(), fakeChild()]
    let index = 0
    const spawnImpl = vi.fn(() => children[index++]) as unknown as typeof spawn
    const runner = createHeadlessTurnRunner({
      spawnImpl,
      prepareMemoryLaunch,
      resolveCommand: async () => 'C:\\cli\\agy.exe',
    })

    const first = runner({ provider: 'agy', prompt: 'a', cwd: 'C:\\p' })
    const second = runner({ provider: 'agy', prompt: 'b', cwd: 'C:\\p' })
    await new Promise((resolve) => setImmediate(resolve))
    children[0].emit('close', 0)
    children[1].emit('close', 0)
    await Promise.all([first, second])

    expect(seen).toHaveLength(2)
    expect(new Set(seen).size).toBe(2)
    expect(generateHeadlessExecutionId('agy', 'x')).not.toBe(generateHeadlessExecutionId('agy', 'x'))
  })

  it('finaliza mesmo quando o processo termina com falha', async () => {
    const child = fakeChild()
    const spawnImpl = vi.fn(() => child) as unknown as typeof spawn
    const finalize = vi.fn(async () => undefined)
    const prepareMemoryLaunch = vi.fn(async () => ({
      command: 'C:\\bin\\ai-memory.exe',
      args: ['run', '--print'],
      env: {},
      finalize,
    }))
    const runner = createHeadlessTurnRunner({
      spawnImpl,
      prepareMemoryLaunch,
      resolveCommand: async () => 'C:\\cli\\agy.exe',
    })

    const promise = runner({ provider: 'agy', prompt: 'x', cwd: 'C:\\p' })
    await new Promise((resolve) => setImmediate(resolve))
    child.emit('close', 3)

    await expect(promise).resolves.toMatchObject({ status: 'failed' })
    await waitFor(() => finalize.mock.calls.length === 1)
    expect(finalize).toHaveBeenCalledTimes(1)
  })

  it('drain bounded aguarda finalizadores pendentes sem lançar', async () => {
    resetHeadlessFinalizersForTests()
    let release!: () => void
    trackHeadlessFinalizer(new Promise<void>((resolve) => { release = resolve }))
    expect(pendingHeadlessFinalizerCount()).toBe(1)

    const timedOut = await drainHeadlessFinalizers({ timeoutMs: 20 })
    expect(timedOut.drained).toBe(false)

    release()
    await waitFor(() => pendingHeadlessFinalizerCount() === 0)
    expect(await drainHeadlessFinalizers({ timeoutMs: 50 })).toEqual({ drained: true, pending: 0 })
  })
})

describe('bridge headless — runs ativos e shutdown', () => {
  it('run ativo é abortado no shutdown: child fecha e finalize Antigravity executa', async () => {
    resetHeadlessFinalizersForTests()
    const child = fakeChild()
    const calls: SpawnCall[] = []
    const killTreeImpl = vi.fn(() => new Promise<void>((resolve) => { child.once('close', () => resolve()) }))
    const spawnImpl = recordingSpawn(child, calls)
    const finalize = vi.fn(async () => undefined)
    const prepareMemoryLaunch = vi.fn(async () => ({
      command: 'C:\\bin\\ai-memory.exe',
      args: ['run', '--print'],
      env: {},
      finalize,
    }))
    const runner = createHeadlessTurnRunner({
      spawnImpl,
      prepareMemoryLaunch,
      killTreeImpl,
      resolveCommand: async () => 'C:\\cli\\agy.exe',
    })

    const run = runner({ provider: 'agy', prompt: 'x', cwd: 'C:\\p' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(activeHeadlessRunCount()).toBe(1)

    const drain = drainHeadlessRuns({ timeoutMs: 1_000 })
    await new Promise((resolve) => setImmediate(resolve))
    expect(killTreeImpl).toHaveBeenCalled()
    // Simula o child fechando após o kill da árvore.
    child.emit('close', 0)

    await expect(run).rejects.toMatchObject({ code: 'HEADLESS_ABORTED' })
    expect(await drain).toEqual({ drained: true, pending: 0 })
    await waitFor(() => finalize.mock.calls.length === 1)
    expect(finalize).toHaveBeenCalledTimes(1)
  })

  it('shutdown não trava o quit: run sem término drena como timeout bounded', async () => {
    resetHeadlessFinalizersForTests()
    const child = fakeChild()
    const killTreeImpl = vi.fn(() => new Promise<void>(() => undefined))
    const spawnImpl = recordingSpawn(child, [])
    const prepareMemoryLaunch = vi.fn(async () => ({
      command: 'C:\\bin\\ai-memory.exe',
      args: ['run', '--print'],
      env: {},
      finalize: async () => undefined,
    }))
    const runner = createHeadlessTurnRunner({
      spawnImpl,
      prepareMemoryLaunch,
      killTreeImpl,
      resolveCommand: async () => 'C:\\cli\\agy.exe',
    })

    // Rejeição anexada na criação: nunca vira unhandled rejection.
    const run = runner({ provider: 'agy', prompt: 'x', cwd: 'C:\\p' }).catch(() => undefined)
    await new Promise((resolve) => setImmediate(resolve))
    expect(activeHeadlessRunCount()).toBe(1)

    // O drain é BOUNDED: aborta e retorna no timeout sem aguardar o child
    // (que nunca fecha) — o quit não trava.
    const result = await drainHeadlessRuns({ timeoutMs: 20 })
    expect(result).toEqual({ drained: false, pending: 1 })

    // Limpa o registro do teste (o child pendente é um fake; o `run` pendente
    // tem `.catch` anexado, sem unhandled rejection).
    resetHeadlessFinalizersForTests()
  })

  it('caminho disabled/direct permanece normal e não deixa runs ativos', async () => {
    resetHeadlessFinalizersForTests()
    const child = fakeChild()
    const spawnImpl = recordingSpawn(child, [])
    const prepareMemoryLaunch = vi.fn(async () => undefined)
    const runner = createHeadlessTurnRunner({
      spawnImpl,
      prepareMemoryLaunch,
      resolveCommand: async () => 'C:\\cli\\agy.exe',
    })

    const run = runner({ provider: 'agy', prompt: 'x', cwd: 'C:\\p' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(activeHeadlessRunCount()).toBe(1)

    child.emit('close', 0)
    await expect(run).resolves.toBeDefined()
    await waitFor(() => activeHeadlessRunCount() === 0)
    expect(await drainHeadlessRuns({ timeoutMs: 50 })).toEqual({ drained: true, pending: 0 })
  })

  it('run concluído naturalmente registra finalizer; drains cobrem run→finalize (evidência de ordem)', async () => {
    resetHeadlessFinalizersForTests()
    const child = fakeChild()
    const killTreeImpl = vi.fn(() => new Promise<void>((resolve) => { child.once('close', () => resolve()) }))
    const spawnImpl = recordingSpawn(child, [])
    const finalize = vi.fn(async () => undefined)
    const prepareMemoryLaunch = vi.fn(async () => ({
      command: 'C:\\bin\\ai-memory.exe',
      args: ['run', '--print'],
      env: {},
      finalize,
    }))
    const runner = createHeadlessTurnRunner({
      spawnImpl,
      prepareMemoryLaunch,
      killTreeImpl,
      resolveCommand: async () => 'C:\\cli\\agy.exe',
    })

    const run = runner({ provider: 'agy', prompt: 'x', cwd: 'C:\\p' })
    await new Promise((resolve) => setImmediate(resolve))

    // O child CONCLUI naturalmente (close código 0) ANTES do drain de runs: em
    // produção o bridge-service emite o outcome do run quando `runHeadlessTurn`
    // resolve (bridge-service.ts:372) — que pode acontecer DEPOIS de o drain de
    // outcomes do Bridge do index já ter rodado na ordem antiga. Por isso a
    // ordem de shutdown é runs → finalizadores → outcomes → stop do sidecar.
    child.stdout.emit('data', Buffer.from('DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"concluiu no shutdown"}\n'))
    child.emit('close', 0)

    await expect(run).resolves.toMatchObject({ status: 'completed', summary: 'concluiu no shutdown' })
    expect(await drainHeadlessRuns({ timeoutMs: 1_000 })).toEqual({ drained: true, pending: 0 })
    expect(await drainHeadlessFinalizers({ timeoutMs: 1_000 })).toEqual({ drained: true, pending: 0 })
    expect(finalize).toHaveBeenCalledTimes(1)
  })

  it('múltiplos runs ativos são todos abortados e aguardados no drain', async () => {
    resetHeadlessFinalizersForTests()
    const children = [fakeChild(), fakeChild(), fakeChild()]
    const killCalls: number[] = []
    let index = 0
    const spawnImpl = vi.fn(() => children[index++]) as unknown as typeof spawn
    const killTreeImpl = vi.fn((pid?: number) => {
      killCalls.push(pid ?? 0)
      return new Promise<void>((resolve) => {
        // Cada fake child precisa emitir close para o kill se concretizar.
        const target = children[killCalls.length - 1]
        target.once('close', () => resolve())
      })
    })
    const runner = createHeadlessTurnRunner({
      spawnImpl,
      killTreeImpl,
      resolveCommand: async () => 'C:\\cli\\agy.exe',
    })

    const runs = [
      runner({ provider: 'agy', prompt: 'a', cwd: 'C:\\p' }),
      runner({ provider: 'agy', prompt: 'b', cwd: 'C:\\p' }),
      runner({ provider: 'agy', prompt: 'c', cwd: 'C:\\p' }),
    ]
    await new Promise((resolve) => setImmediate(resolve))
    expect(activeHeadlessRunCount()).toBe(3)

    const drain = drainHeadlessRuns({ timeoutMs: 1_000 })
    await new Promise((resolve) => setImmediate(resolve))
    children.forEach((child) => child.emit('close', 0))

    const result = await drain
    expect(result.drained).toBe(true)
    expect(killTreeImpl).toHaveBeenCalledTimes(3)
    await Promise.all(runs.map((run) => expect(run).rejects.toMatchObject({ code: 'HEADLESS_ABORTED' })))
  })
})

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('condição não satisfeita a tempo')
}
