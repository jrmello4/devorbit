import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProcessRunner, resolveProcessInvocation, runProcess } from '../src/main/process-runner'

const tempBase = fs.realpathSync.native(
  fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'devorbit-runner-')),
)
const node = process.execPath

afterAll(() => {
  fs.rmSync(tempBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const nodeEval = (code: string, args: string[] = []) => ({ command: node, args: ['-e', code, ...args] })

describe('ProcessRunner', () => {
  it('resolves Windows npm launchers to the real npm-cli.js without a generic shell', () => {
    const invocation = resolveProcessInvocation('npm.cmd', ['run', 'test', '--', 'x&y'], 'win32')

    if (invocation.command.toLowerCase().endsWith('node.exe')) {
      expect(invocation.args[0]).toMatch(/npm-cli\.js$/u)
      expect(invocation.args.slice(1)).toEqual(['run', 'test', '--', 'x&y'])
      expect(invocation.windowsVerbatimArguments).toBe(false)
    } else {
      expect(invocation.command.toLowerCase()).toMatch(/cmd(?:\.exe)?$/u)
      expect(invocation.args.slice(0, 4)).toEqual(['/d', '/v:off', '/s', '/c'])
      expect(invocation.args[4]).toContain('x&y')
    }
  })

  it('quotes Windows batch arguments without caret-escaping inside quoted tokens', () => {
    const invocation = resolveProcessInvocation(
      'C:\\tools\\probe.cmd',
      ['a b', 'c"d', 'x&y', '> out.txt'],
      'win32',
    )

    expect(invocation.command.toLowerCase()).toMatch(/cmd(?:\.exe)?$/u)
    expect(invocation.windowsVerbatimArguments).toBe(true)
    expect(invocation.args).toEqual([
      '/d',
      '/v:off',
      '/s',
      '/c',
      '"C:\\tools\\probe.cmd "a b" "c""d" "x&y" "> out.txt""',
    ])
  })

  it('executes a real .cmd probe preserving spaces, quotes, ampersand and redirection', async () => {
    if (process.platform !== 'win32') return
    const probeScript = path.join(tempBase, 'probe.cjs')
    const probeLauncher = path.join(tempBase, 'probe.cmd')
    const outputFile = path.join(tempBase, 'probe-args.json')
    fs.writeFileSync(
      probeScript,
      "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'probe-args.json'), JSON.stringify(process.argv.slice(2)))",
      'utf8',
    )
    fs.writeFileSync(probeLauncher, '@echo off\r\nnode "%~dp0probe.cjs" %*\r\n', 'utf8')
    const args = ['a b', 'c"d', 'x&y', '> out.txt']

    const result = await runProcess({ command: probeLauncher, args, timeoutMs: 20_000 })

    expect(result.status).toBe('completed')
    expect(result.code).toBe(0)
    expect(JSON.parse(fs.readFileSync(outputFile, 'utf8'))).toEqual(args)
  })

  it('preserves spaces, percent and ampersand in a real npm argument', async () => {
    if (process.platform !== 'win32') return
    const weirdDirectory = path.join(tempBase, 'npm config %amp& space')
    fs.mkdirSync(weirdDirectory, { recursive: true })
    const userConfig = path.join(weirdDirectory, 'npmrc')
    fs.writeFileSync(userConfig, 'prefix=C:\\devorbit-marker', 'utf8')
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.toLowerCase().startsWith('npm_config')) env[key] = value
    }

    const result = await runProcess({
      command: 'npm.cmd',
      args: ['config', 'get', 'prefix', '--userconfig', userConfig],
      env,
      timeoutMs: 20_000,
    })

    expect(result.status).toBe('completed')
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('C:\\devorbit-marker')
  })

  it('executes the Windows npm launcher in the real environment', async () => {
    if (process.platform !== 'win32') return
    const result = await runProcess({ command: 'npm.cmd', args: ['--version'], timeoutMs: 10_000 })

    expect(result.status).toBe('completed')
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u)
  })

  it('preserves spaces in arguments passed to npm', async () => {
    if (process.platform !== 'win32') return
    const result = await runProcess({ command: 'npm.cmd', args: ['config', 'get', 'cache', '--cache', 'C:\\a b'], timeoutMs: 10_000 })

    expect(result.status).toBe('completed')
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('C:\\a b')
  })

  it('captures stdout, stderr and the exit code as a serializable result', async () => {
    const result = await runProcess(
      nodeEval('process.stdout.write("saida");process.stderr.write("erro");process.exit(3)'),
    )

    expect(result).toMatchObject({
      status: 'completed',
      code: 3,
      stdout: 'saida',
      stderr: 'erro',
      truncated: false,
    })
    expect(result.signal).toBeNull()
    expect(typeof result.durationMs).toBe('number')
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })

  it('passes arguments literally, without a shell', async () => {
    const args = ['a b', 'c"d', 'x&y', '%PATH%', '> out.txt']
    const result = await runProcess(
      nodeEval('process.stdout.write(JSON.stringify(process.argv.slice(1)))', args),
    )

    expect(result.status).toBe('completed')
    expect(JSON.parse(result.stdout)).toEqual(args)
  })

  it('controls cwd and the inherited environment', async () => {
    process.env.DEVORBIT_SHOULD_NOT_LEAK = 'parent'
    try {
      const result = await runProcess({
        ...nodeEval('process.stdout.write(process.cwd()+"|"+String(process.env.DEVORBIT_TEST_ENV)+"|"+String(process.env.DEVORBIT_SHOULD_NOT_LEAK))'),
        cwd: tempBase,
        env: {
          DEVORBIT_TEST_ENV: 'isolado',
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        },
      })

      expect(result.stdout).toBe(`${tempBase}|isolado|undefined`)
    } finally {
      delete process.env.DEVORBIT_SHOULD_NOT_LEAK
    }
  })

  it('kills the process when the timeout is reached', async () => {
    const startedAt = Date.now()
    const result = await runProcess({
      ...nodeEval('setTimeout(() => {}, 60000)'),
      timeoutMs: 200,
    })

    expect(result.status).toBe('timed-out')
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  })

  it('cancels a running process through the abort signal', async () => {
    const controller = new AbortController()
    const pending = runProcess({
      ...nodeEval('setTimeout(() => {}, 60000)'),
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 100)

    const result = await pending
    expect(result.status).toBe('cancelled')
  })

  it('stops capturing and terminates when the output limit is exceeded', async () => {
    const result = await runProcess({
      ...nodeEval('process.stdout.write("x".repeat(200000));setTimeout(() => {}, 60000)'),
      maxOutputBytes: 1_000,
    })

    expect(result.status).toBe('output-limit')
    expect(result.truncated).toBe(true)
    expect(result.stdoutBytes).toBe(1_000)
    expect(result.stdout.length).toBeLessThanOrEqual(1_000)
  })

  it('reports spawn failures without throwing', async () => {
    const result = await runProcess({ command: 'devorbit-command-that-does-not-exist-xyz' })

    expect(result.status).toBe('spawn-failed')
    expect(result.code).toBeNull()
    expect(result.error).toBeTruthy()
  })

  it('applies runner defaults and rejects work after disposal', async () => {
    const runner = new ProcessRunner({ maxOutputBytes: 10 })
    const result = await runner.run(nodeEval('process.stdout.write("abcdefghijklmnop")'))

    expect(result.status).toBe('output-limit')
    expect(result.stdout).toBe('abcdefghij')

    runner.dispose()
    expect(runner.disposed).toBe(true)
    await expect(runner.run(nodeEval(''))).rejects.toThrow(/indisponível/)
  })

  it('cancels active runs deterministically on dispose', async () => {
    const runner = new ProcessRunner()
    const pending = runner.run(nodeEval('setTimeout(() => {}, 60000)'))
    setTimeout(() => runner.dispose(), 100)

    const result = await pending
    expect(result.status).toBe('cancelled')
    expect(runner.disposed).toBe(true)
  })

  it('rejects empty commands', async () => {
    await expect(runProcess({ command: '   ' })).rejects.toThrow(/inválido/)
  })
})
