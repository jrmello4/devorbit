import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'

const runProcessMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  default: {
    app: {
      getPath: () => {
        throw new Error('electron indisponível nos testes')
      },
    },
  },
}))

vi.mock('../src/main/project-paths', () => ({
  validateProjectPath: vi.fn(async (value: unknown) => String(value)),
}))

// Mantém as exportações reais (resolveProcessInvocation etc.) e substitui só o
// spawn para observar command/args/env recebidos.
vi.mock('../src/main/process-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/process-runner')>()),
  runProcess: runProcessMock,
}))

import {
  buildDiagnosticEnv,
  registerObservabilityIpc,
  resolveDiagnosticCommandPath,
  validateDiagnosticRequest,
} from '../src/main/ipc/observability-ipc'
import { resolveProcessInvocation } from '../src/main/process-runner'
import { HITLManager, type HitlRequest } from '../src/main/hitl'
import type { DiagnosticProcessResult } from '../src/shared/diagnostic-process'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

let hitlSequence = 0

interface Harness {
  handlers: Map<string, Handler>
  hitl: HITLManager
}

function buildHarness(overrides: {
  resolveDiagnosticCommand?: (name: string) => Promise<string>
} = {}): Harness {
  const handlers = new Map<string, Handler>()
  const hitl = new HITLManager({ idFactory: () => `hitl-${++hitlSequence}` })
  registerObservabilityIpc(((channel: string, handler: Handler) => handlers.set(channel, handler)) as never, {
    evolutionStore: {} as never,
    telemetry: {} as never,
    hitl,
    usageStore: {} as never,
    sanitizeHitlRequest: (request: HitlRequest) => request,
    ...overrides,
  })
  return { handlers, hitl }
}

function handler(harness: Harness, channel: string): Handler {
  const found = harness.handlers.get(channel)
  if (!found) throw new Error(`Handler ausente: ${channel}`)
  return found
}

const fakeGitPath = path.join('C:', 'Program Files', 'Git', 'cmd', 'git.exe')

const fakeDiagnosticResult: DiagnosticProcessResult = {
  command: fakeGitPath,
  args: ['status'],
  status: 'completed',
  code: 0,
  signal: null,
  stdout: 'ok',
  stderr: '',
  stdoutBytes: 2,
  stderrBytes: 0,
  truncated: false,
  durationMs: 5,
}

/** Aguarda o pedido HITL pendente criado pelo handler (após os awaits internos). */
async function waitForPendingHitl(hitl: HITLManager): Promise<HitlRequest> {
  await vi.waitFor(() => {
    if (hitl.pending().length === 0) throw new Error('Nenhum pedido HITL pendente ainda.')
  })
  const pending = hitl.pending()
  expect(pending).toHaveLength(1)
  return pending[0]
}

describe('validateDiagnosticRequest · aceita somente nomes canônicos', () => {
  it('rejeita caminho absoluto, relativo e UNC com erro claro', () => {
    const rejected = [
      'C:\\evil\\git.exe',
      'C:/evil/git.exe',
      '\\\\srv\\share\\git.exe',
      './git.exe',
      '.\\git.exe',
      '../git.exe',
      'tools/git.exe',
      'C:git.exe',
      'sub\\dir\\node',
    ]
    for (const command of rejected) {
      expect(() => validateDiagnosticRequest({ command, projectPath: 'C:/proj' }), command).toThrow(/não permitido/)
    }
  })

  it('rejeita comandos fora da allowlist e payloads inválidos', () => {
    for (const command of ['powershell', 'cmd', 'bash', 'git.exe.exe', 'git status', 'npmx', '', 'rg;calc']) {
      expect(() => validateDiagnosticRequest({ command, projectPath: 'C:/proj' }), command).toThrow(/não permitido/)
    }
    expect(() => validateDiagnosticRequest({ projectPath: 'C:/proj' })).toThrow(/não permitido/)
    expect(() => validateDiagnosticRequest(null)).toThrow(/inválido/)
  })

  it('aceita nomes canônicos e normaliza a extensão para o nome bare', () => {
    expect(validateDiagnosticRequest({ command: 'git', projectPath: 'C:/proj' })).toMatchObject({ command: 'git' })
    expect(validateDiagnosticRequest({ command: 'GIT.EXE', projectPath: 'C:/proj' })).toMatchObject({ command: 'git' })
    expect(validateDiagnosticRequest({ command: 'npm.CMD', projectPath: 'C:/proj', args: ['--version'] })).toMatchObject({
      command: 'npm',
      args: ['--version'],
    })
    expect(validateDiagnosticRequest({ command: 'Node.exe', projectPath: 'C:/proj' })).toMatchObject({ command: 'node' })
    expect(validateDiagnosticRequest({ command: ' rg ', projectPath: 'C:/proj', timeoutMs: 10_000 })).toMatchObject({
      command: 'rg',
      timeoutMs: 10_000,
    })
  })
})

describe('resolveDiagnosticCommandPath · resolução confiável via PATH', () => {
  // A preferência por executável nativo (.exe/.cmd) e os caminhos fake são
  // específicos do Windows (branch isWindows da implementação); no POSIX o
  // lookup devolve o caminho tal qual.
  const isWin = process.platform === 'win32'
  const fakeGitPath = isWin
    ? path.join('C:', 'Program Files', 'Git', 'cmd', 'git.exe')
    : '/usr/bin/git'

  it('devolve o caminho absoluto resolvido pelo lookup (where/which mockado)', async () => {
    const resolved = await resolveDiagnosticCommandPath('git', {
      lookup: async () => [fakeGitPath],
    })
    expect(resolved).toBe(fakeGitPath)
    expect(path.isAbsolute(resolved)).toBe(true)
  })

  it.skipIf(!isWin)('prefere um executável nativo (.exe/.cmd) quando o where devolve shims primeiro', async () => {
    const resolved = await resolveDiagnosticCommandPath('git', {
      // Simula a saída de `where npm`: shim sem extensão (inexistente) antes do .exe real.
      lookup: async () => ['C:\\tools\\missing\\git', fakeGitPath],
    })
    expect(resolved).toMatch(/git\.exe$/u)
  })

  it('falha explicitamente quando o comando não resolve no PATH', async () => {
    await expect(resolveDiagnosticCommandPath('git', { lookup: async () => [] })).rejects.toThrow(
      /git não encontrado no PATH/u,
    )
  })

  it('falha explicitamente quando o caminho resolvido não existe', async () => {
    await expect(
      resolveDiagnosticCommandPath('git', {
        lookup: async () => [path.join('C:', 'definitely', 'missing', 'git.exe')],
      }),
    ).rejects.toThrow(/git não encontrado no PATH/u)
  })

  it('resolve de verdade o node no PATH da máquina (where/which real)', async () => {
    const resolved = await resolveDiagnosticCommandPath('node')
    expect(path.basename(resolved).toLowerCase()).toMatch(/^node(\.exe)?$/u)
    expect(path.isAbsolute(resolved)).toBe(true)
  })
})

describe('resolveProcessInvocation · comando já resolvido', () => {
  it('lança um caminho absoluto de npm.cmd via npm-cli.js do node', () => {
    const fakeNpmCmd = path.join('C:', 'Program Files', 'nodejs', 'npm.cmd')
    const invocation = resolveProcessInvocation(fakeNpmCmd, ['--version'], 'win32')
    const commandName = path.basename(invocation.command).toLowerCase()

    if (commandName === 'node' || commandName === 'node.exe') {
      expect(invocation.args[0]).toMatch(/npm-cli\.js$/u)
      expect(invocation.args.slice(1)).toEqual(['--version'])
      expect(invocation.windowsVerbatimArguments).toBe(false)
    } else {
      // Fallback sem npm-cli.js: preserva o caminho resolvido dentro do wrap ComSpec.
      expect(commandName).toMatch(/cmd(?:\.exe)?$/u)
      expect(invocation.args[4]).toContain(fakeNpmCmd)
    }
  })

  it('não altera o comportamento de launchers .cmd não-npm', () => {
    const invocation = resolveProcessInvocation('C:\\tools\\probe.cmd', ['a b'], 'win32')
    expect(path.basename(invocation.command).toLowerCase()).toMatch(/cmd(?:\.exe)?$/u)
    expect(invocation.windowsVerbatimArguments).toBe(true)
    expect(invocation.args.slice(0, 4)).toEqual(['/d', '/v:off', '/s', '/c'])
  })
})

describe('devorbit:runDiagnostic · fluxo seguro', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
    runProcessMock.mockResolvedValue(fakeDiagnosticResult)
  })

  it('spawn usa o caminho resolvido pela camada confiável, não o input', async () => {
    const harness = buildHarness({ resolveDiagnosticCommand: async () => fakeGitPath })
    const pending = handler(harness, 'devorbit:runDiagnostic')(null, {
      command: 'git',
      args: ['status', '--short'],
      projectPath: 'C:/proj',
    })
    await waitForPendingHitl(harness.hitl)
    harness.hitl.approve(harness.hitl.pending()[0].id, { decidedBy: 'tester' })
    const result = (await pending) as DiagnosticProcessResult

    expect(runProcessMock).toHaveBeenCalledTimes(1)
    const options = runProcessMock.mock.calls[0][0] as {
      command: string
      args: readonly string[]
      cwd: string
      timeoutMs?: number
    }
    expect(options.command).toBe(fakeGitPath)
    expect(options.args).toEqual(['status', '--short'])
    expect(options.cwd).toBe('C:/proj')
    expect(result).toEqual(fakeDiagnosticResult)
  })

  it('falha antes do HITL quando o executável não é encontrado no PATH', async () => {
    const harness = buildHarness({
      resolveDiagnosticCommand: (name) => resolveDiagnosticCommandPath(name, { lookup: async () => [] }),
    })
    await expect(
      handler(harness, 'devorbit:runDiagnostic')(null, { command: 'git', projectPath: 'C:/proj' }),
    ).rejects.toThrow(/git não encontrado no PATH/u)
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(harness.hitl.pending()).toHaveLength(0)
  })

  it('rejeita caminho arbitrário antes de qualquer resolução ou HITL', async () => {
    const harness = buildHarness({ resolveDiagnosticCommand: async () => fakeGitPath })
    await expect(
      handler(harness, 'devorbit:runDiagnostic')(null, {
        command: 'C:\\evil\\git.exe',
        projectPath: 'C:/proj',
      }),
    ).rejects.toThrow(/não permitido/u)
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(harness.hitl.pending()).toHaveLength(0)
  })

  it('não executa quando o HITL reprova', async () => {
    const harness = buildHarness({ resolveDiagnosticCommand: async () => fakeGitPath })
    const pending = handler(harness, 'devorbit:runDiagnostic')(null, { command: 'git', projectPath: 'C:/proj' })
    const request = await waitForPendingHitl(harness.hitl)
    harness.hitl.reject(request.id, { reason: 'negado' })
    await expect(pending).rejects.toThrow(/Diagnóstico rejected/u)
    expect(runProcessMock).not.toHaveBeenCalled()
  })
})

describe('devorbit:runDiagnostic · metadata HITL', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
    runProcessMock.mockResolvedValue(fakeDiagnosticResult)
  })

  it('expõe command canônico, resolvedPath e args completos', async () => {
    const harness = buildHarness({ resolveDiagnosticCommand: async () => fakeGitPath })
    const pending = handler(harness, 'devorbit:runDiagnostic')(null, {
      command: 'git.exe',
      args: ['log', '--oneline', '-5'],
      projectPath: 'C:/dev/meu-projeto',
    })
    const request = await waitForPendingHitl(harness.hitl)

    expect(request.metadata).toMatchObject({
      operation: 'process.run',
      command: 'git',
      resolvedPath: fakeGitPath,
      args: 'log --oneline -5',
      project: 'meu-projeto',
    })
    expect(request.prompt).toContain('git')
    expect(request.prompt).toContain('meu-projeto')

    harness.hitl.approve(request.id)
    await pending
  })

  it('marca truncamento quando os args excedem o limite', async () => {
    const harness = buildHarness({ resolveDiagnosticCommand: async () => fakeGitPath })
    const longArgs = Array.from({ length: 32 }, (_value, index) => `a${index}-`.padEnd(4096, 'x'))
    const pending = handler(harness, 'devorbit:runDiagnostic')(null, {
      command: 'git',
      args: longArgs,
      projectPath: 'C:/proj',
    })
    const request = await waitForPendingHitl(harness.hitl)

    const args = String((request.metadata as Record<string, unknown>).args)
    expect(args.length).toBe(4000)
    expect(args.endsWith('…[truncado]')).toBe(true)

    harness.hitl.approve(request.id)
    await pending
  })

  it('usa o marcador "[sem argumentos]" quando não há args', async () => {
    const harness = buildHarness({ resolveDiagnosticCommand: async () => fakeGitPath })
    const pending = handler(harness, 'devorbit:runDiagnostic')(null, { command: 'node', projectPath: 'C:/proj' })
    const request = await waitForPendingHitl(harness.hitl)

    expect((request.metadata as Record<string, unknown>).args).toBe('[sem argumentos]')
    expect((request.metadata as Record<string, unknown>).resolvedPath).toBe(fakeGitPath)

    harness.hitl.approve(request.id)
    await pending
  })
})

describe('buildDiagnosticEnv · allowlist', () => {
  const originalKey = process.env.OPENAI_API_KEY
  const originalNodeOptions = process.env.NODE_OPTIONS

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalKey
    if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = originalNodeOptions
  })

  it('remove segredos, NODE_OPTIONS e npm_config do env do diagnóstico', () => {
    const env = buildDiagnosticEnv({
      PATH: 'C:\\tools',
      SystemRoot: 'C:\\Windows',
      OPENAI_API_KEY: 'sk-super-secret',
      ANTHROPIC_AUTH_TOKEN: 'tok-123',
      MY_DB_PASSWORD: 'hunter2',
      NODE_OPTIONS: '--inspect-brk',
      npm_config_registry: 'http://evil.example',
      foo: 'bar',
    })

    expect(env.PATH).toBe('C:\\tools')
    expect(env.SystemRoot).toBe('C:\\Windows')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.MY_DB_PASSWORD).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.npm_config_registry).toBeUndefined()
    expect(env.foo).toBeUndefined()
  })

  it('preserva as pontes npm→node e o base OS necessário', () => {
    const env = buildDiagnosticEnv({
      PATH: 'C:\\nodejs',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      TEMP: 'C:\\Temp',
      TMP: 'C:\\Temp',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      USERPROFILE: 'C:\\Users\\u',
      npm_execpath: 'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
      npm_node_execpath: 'C:\\nodejs\\node.exe',
    })

    expect(env).toMatchObject({
      PATH: 'C:\\nodejs',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      TEMP: 'C:\\Temp',
      TMP: 'C:\\Temp',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      USERPROFILE: 'C:\\Users\\u',
      npm_execpath: 'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
      npm_node_execpath: 'C:\\nodejs\\node.exe',
    })
  })

  it('o env passado ao spawn não contém o segredo do processo principal', async () => {
    const harness = buildHarness({ resolveDiagnosticCommand: async () => fakeGitPath })
    process.env.OPENAI_API_KEY = 'sk-test-main-process-secret'
    try {
      const pending = handler(harness, 'devorbit:runDiagnostic')(null, { command: 'git', projectPath: 'C:/proj' })
      const request = await waitForPendingHitl(harness.hitl)
      harness.hitl.approve(request.id)
      await pending

      const options = runProcessMock.mock.calls[0][0] as { env: NodeJS.ProcessEnv }
      expect(options.env).toBeDefined()
      expect(options.env.OPENAI_API_KEY).toBeUndefined()
      expect(options.env.NODE_OPTIONS).toBeUndefined()
      expect(options.env.PATH).toBeDefined()
    } finally {
      delete process.env.OPENAI_API_KEY
    }
  })
})
