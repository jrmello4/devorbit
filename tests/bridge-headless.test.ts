import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_PROVIDERS,
  buildAgyHeadlessInvocation,
  createHeadlessTurnRunner,
  isHeadlessProvider,
  parseHeadlessOutput,
  runHeadlessInvocation,
  terminateProcessTree,
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('condição não satisfeita a tempo')
}
