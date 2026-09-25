import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  buildExpandArchiveInvocation,
  createAiMemoryService as createAiMemoryServiceBase,
  type AiMemoryChildHandle,
  type AiMemoryChildSpawner,
  type AiMemoryProcessRunner,
  type AiMemoryService,
  type AiMemoryServiceOptions,
} from '../src/main/ai-memory-service'

function createAiMemoryService(options: AiMemoryServiceOptions): AiMemoryService {
  return createAiMemoryServiceBase({
    platform: 'win32',
    arch: 'x64',
    // Nenhum teste desta suíte pode abrir processos reais: a FFI real fica
    // restrita ao teste de kernel explícito em tests/ai-memory-job.test.ts.
    containment: {
      contain: () => undefined,
      release: () => undefined,
      status: () => ({ platform: 'win32', supported: true, active: false }),
    },
    ...options,
  })
}
import {
  escapeTomlString,
  resolveAiMemoryScope,
  type AiMemoryFileSystem,
} from '../src/main/ai-memory-scope'
import { AI_MEMORY_MARKER_MANAGED_HEADER, type AiMemoryConfig } from '../src/shared/ai-memory-contract'
import type { AiMemoryJobContainment, AiMemoryJobProcessIdentity } from '../src/main/ai-memory-job'

const PROJECT_PATH = path.join(os.tmpdir(), 'devorbit-ai-memory-proj')
const REPO_ROOT = path.join(os.tmpdir(), 'devorbit-ai-memory-repo')
const SUBDIR = path.join(REPO_ROOT, 'packages', 'app')
const REMOTE = 'https://github.com/acme/repo.git'
const USER_DATA = path.join(os.tmpdir(), 'devorbit-ai-memory-userdata')
const WORKTREE_A = path.join(os.tmpdir(), 'devorbit-aimem-wt-a')
const WORKTREE_B = path.join(os.tmpdir(), 'devorbit-aimem-wt-b')
const COMMON_DIR = path.join(os.tmpdir(), 'devorbit-aimem-common', '.git')

function createMemoryFs(seed: Record<string, string> = {}): {
  fs: AiMemoryFileSystem
  files: Map<string, Buffer>
  dirs: Set<string>
} {
  const files = new Map<string, Buffer>()
  const dirs = new Set<string>()
  const key = (value: string): string => path.resolve(value).toLowerCase()
  for (const [filePath, content] of Object.entries(seed)) files.set(key(filePath), Buffer.from(content))
  const missing = (): NodeJS.ErrnoException => {
    const error = new Error('ENOENT') as NodeJS.ErrnoException
    error.code = 'ENOENT'
    return error
  }
  const fs: AiMemoryFileSystem = {
    readFile: async (filePath) => {
      const value = files.get(key(filePath))
      if (!value) throw missing()
      return Buffer.from(value)
    },
    writeFile: async (filePath, data) => {
      files.set(key(filePath), Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data))
    },
    mkdir: async (dirPath) => {
      dirs.add(key(dirPath))
    },
    stat: async (filePath) => {
      const value = files.get(key(filePath))
      if (value) return { isFile: () => true, isDirectory: () => false, size: value.length }
      if (dirs.has(key(filePath))) return { isFile: () => false, isDirectory: () => true, size: 0 }
      throw missing()
    },
    rm: async (filePath) => {
      files.delete(key(filePath))
      dirs.delete(key(filePath))
    },
    rename: async (from, to) => {
      const value = files.get(key(from))
      if (!value) throw missing()
      files.delete(key(from))
      files.set(key(to), value)
    },
    access: async (filePath) => {
      if (!files.has(key(filePath)) && !dirs.has(key(filePath))) throw missing()
    },
    realpath: async (filePath) => path.resolve(filePath),
  }
  return { fs, files, dirs }
}

function initializeOk(name = 'ai-memory', version = '2.4.0'): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name, version } } }),
  } as unknown as Response
}

function rpcError(code: number, message: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } }),
  } as unknown as Response
}

function scopedStatus(workspace: string, project: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ scope: { workspace, project } }) }],
        },
      }),
  } as unknown as Response
}

function enabledScope(): { workspace: string; project: string } {
  const scope = resolveAiMemoryScope({
    projectPath: PROJECT_PATH,
    remoteUrl: REMOTE,
    gitCommonDir: path.join(PROJECT_PATH, '.git'),
  })
  return { workspace: scope.workspace, project: scope.project }
}

function fetchScopedOk(): typeof fetch {
  const scope = enabledScope()
  return (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
    if (body.method === 'initialize') return initializeOk()
    return scopedStatus(scope.workspace, scope.project)
  }) as unknown as typeof fetch
}

function fetchStatefulScoped(isSpawned: () => boolean): typeof fetch {
  const scope = enabledScope()
  return (async (_url: unknown, init?: { body?: unknown }) => {
    if (!isSpawned()) throw new Error('recusado')
    const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
    if (body.method === 'initialize') return initializeOk()
    return scopedStatus(scope.workspace, scope.project)
  }) as unknown as typeof fetch
}

function fetchAlwaysOk(): typeof fetch {
  return (async () => initializeOk()) as unknown as typeof fetch
}

function fetchAlwaysFail(): typeof fetch {
  return (async () => {
    throw new Error('recusado')
  }) as unknown as typeof fetch
}

function createRunner(
  options: { version?: string; remote?: string | null; topLevel?: string } = {}
): AiMemoryProcessRunner {
  const remote = options.remote === undefined ? REMOTE : options.remote
  return async (command, args) => {
    if (command === 'git' && args[0] === 'remote') {
      return { code: 0, stdout: remote === null ? '' : `${remote}\n`, stderr: '' }
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      if (args[1] === '--show-toplevel') {
        return options.topLevel
          ? { code: 0, stdout: `${options.topLevel}\n`, stderr: '' }
          : { code: 1, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: `${path.join(PROJECT_PATH, '.git')}\n`, stderr: '' }
    }
    if (command === 'where' || command === 'which') return { code: 1, stdout: '', stderr: '' }
    return { code: 0, stdout: `ai-memory ${options.version ?? '2.4.0'}\n`, stderr: '' }
  }
}

/** Runner de um repositório com dois worktrees (A e B) no mesmo common-dir. */
function createWorktreeRunner(): AiMemoryProcessRunner {
  return async (command, args, options) => {
    if (command === 'git' && args[0] === 'remote') return { code: 0, stdout: `${REMOTE}\n`, stderr: '' }
    if (command === 'git' && args[0] === 'rev-parse') {
      if (args[1] === '--show-toplevel') {
        const cwd = options?.cwd ?? ''
        const top = cwd.includes('wt-b') ? WORKTREE_B : cwd.includes('wt-a') ? WORKTREE_A : REPO_ROOT
        return { code: 0, stdout: `${top}\n`, stderr: '' }
      }
      return { code: 0, stdout: `${COMMON_DIR}\n`, stderr: '' }
    }
    if (command === 'git' && args[0] === 'worktree') {
      return { code: 0, stdout: `worktree ${WORKTREE_A}\nworktree ${WORKTREE_B}\n`, stderr: '' }
    }
    if (command === 'where' || command === 'which') return { code: 1, stdout: '', stderr: '' }
    return { code: 0, stdout: 'ai-memory 2.4.0\n', stderr: '' }
  }
}

function worktreeConfig(): AiMemoryConfig {
  const scope = resolveAiMemoryScope({
    projectPath: WORKTREE_A,
    remoteUrl: REMOTE,
    gitCommonDir: COMMON_DIR,
    gitTopLevel: WORKTREE_A,
  })
  return {
    enabled: true,
    projects: {
      [scope.identity]: {
        identity: scope.identity,
        workspace: scope.workspace,
        project: scope.project,
        path: WORKTREE_A,
        enabled: true,
      },
    },
  }
}

function enabledConfig(): AiMemoryConfig {
  const scope = resolveAiMemoryScope({
    projectPath: PROJECT_PATH,
    remoteUrl: REMOTE,
    gitCommonDir: path.join(PROJECT_PATH, '.git'),
  })
  return {
    enabled: true,
    projects: {
      [scope.identity]: {
        identity: scope.identity,
        workspace: scope.workspace,
        project: scope.project,
        path: PROJECT_PATH,
        enabled: true,
      },
    },
  }
}

function seededBinary(): Record<string, string> {
  return { [path.join(USER_DATA, 'runtime', 'ai-memory.exe')]: '' }
}

interface ChildHarness {
  spawner: AiMemoryChildSpawner
  kill: ReturnType<typeof vi.fn>
  calls: string[][]
  exit: (code: number | null) => void
}

function createChildSpawner(): ChildHarness {
  const kill = vi.fn()
  const calls: string[][] = []
  let exitListener: ((code: number | null) => void) | undefined
  const spawner: AiMemoryChildSpawner = (command, args): AiMemoryChildHandle => {
    calls.push([command, ...args])
    return {
      pid: 4242,
      kill,
      onExit: (listener) => {
        exitListener = listener
      },
    }
  }
  return { spawner, kill, calls, exit: (code) => exitListener?.(code) }
}

describe('ai-memory service lifecycle', () => {
  it('desabilitado fica unavailable e não cria storage', async () => {
    const memory = createMemoryFs()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: { enabled: false, projects: {} },
      fileSystem: memory.fs,
      fetchImpl: fetchAlwaysOk(),
      processRunner: createRunner(),
      sleep: async () => undefined,
    })
    const status = await service.start()
    expect(status.state).toBe('unavailable')
    expect(memory.files.size).toBe(0)
    expect(memory.dirs.size).toBe(0)
  })

  it('detecta serviço externo compatível e não inicia processo próprio', async () => {
    const { spawner, calls } = createChildSpawner()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: fetchScopedOk(),
      processRunner: createRunner(),
      childSpawner: spawner,
      sleep: async () => undefined,
    })
    const status = await service.start()
    expect(status).toMatchObject({ state: 'running', owned: false, version: '2.4.0' })
    expect(calls).toHaveLength(0)
    await service.stop()
  })

  it('servidor estranho na porta vira degraded com conflito (não spawna)', async () => {
    const { spawner, calls } = createChildSpawner()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: (async () => initializeOk('outro-mcp', '9.9.9')) as unknown as typeof fetch,
      processRunner: createRunner(),
      childSpawner: spawner,
      sleep: async () => undefined,
    })
    const status = await service.start()
    expect(status).toMatchObject({ state: 'degraded', conflict: true, owned: false })
    expect(status.message).toContain('não é ai-memory')
    expect(calls).toHaveLength(0)
  })

  it('escopo divergente do projeto habilitado vira degraded com conflito', async () => {
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
      if (body.method === 'initialize') return initializeOk()
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              content: [
                { type: 'text', text: JSON.stringify({ scope: { workspace: 'devorbit', project: 'outro' } }) },
              ],
            },
          }),
      } as unknown as Response
    }) as unknown as typeof fetch
    const harness = createChildSpawner()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl,
      processRunner: createRunner(),
      childSpawner: harness.spawner,
      sleep: async () => undefined,
    })
    const status = await service.start()
    expect(status).toMatchObject({ state: 'degraded', conflict: true, owned: false })
    expect(harness.calls).toHaveLength(0)
  })

  it('scope ausente na resposta de status vira degraded com conflito', async () => {
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
      if (body.method === 'initialize') return initializeOk()
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () =>
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } }),
      } as unknown as Response
    }) as unknown as typeof fetch
    const harness = createChildSpawner()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl,
      processRunner: createRunner(),
      childSpawner: harness.spawner,
      sleep: async () => undefined,
    })
    const status = await service.start()
    expect(status).toMatchObject({ state: 'degraded', conflict: true, owned: false })
    expect(status.message).toContain('sem scope')
    expect(harness.calls).toHaveLength(0)
  })

  it('falha ao consultar status vira degraded acionável (fail-closed)', async () => {
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
      if (body.method === 'initialize') return initializeOk()
      throw new Error('tool indisponível')
    }) as unknown as typeof fetch
    const harness = createChildSpawner()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl,
      processRunner: createRunner(),
      childSpawner: harness.spawner,
      sleep: async () => undefined,
    })
    const status = await service.start()
    expect(status).toMatchObject({ state: 'degraded', owned: false })
    expect(status.conflict).not.toBe(true)
    expect(status.message).toContain('falha ao consultar memory_status')
    expect(harness.calls).toHaveLength(0)
  })

  it('sobe o filho próprio quando o MCP só responde após o spawn', async () => {
    let spawned = false
    const fetchImpl = fetchStatefulScoped(() => spawned)
    const harness = createChildSpawner()
    const spawnerWithFlag: AiMemoryChildSpawner = (command, args, options) => {
      spawned = true
      return harness.spawner(command, args, options)
    }
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl,
      processRunner: createRunner(),
      childSpawner: spawnerWithFlag,
      sleep: async () => undefined,
    })
    const status = await service.start()
    expect(status).toMatchObject({ state: 'running', owned: true, version: '2.4.0' })
    expect(harness.calls[0]).toEqual([
      path.join(USER_DATA, 'runtime', 'ai-memory.exe'),
      'serve',
      '--transport',
      'http',
      '--bind',
      '127.0.0.1:49374',
      '--data-dir',
      path.join(USER_DATA, 'data'),
    ])
    await service.stop()
    expect(harness.kill).toHaveBeenCalledTimes(1)
  })

  it('exit inesperado do filho vira degraded e para de rastrear o processo', async () => {
    let spawned = false
    const fetchImpl = fetchStatefulScoped(() => spawned)
    const harness = createChildSpawner()
    const spawnerWithFlag: AiMemoryChildSpawner = (command, args, options) => {
      spawned = true
      return harness.spawner(command, args, options)
    }
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl,
      processRunner: createRunner(),
      childSpawner: spawnerWithFlag,
      sleep: async () => undefined,
    })
    await service.start()
    harness.exit(1)
    expect(service.status()).toMatchObject({ state: 'degraded', owned: false })
  })

  it('stop durante o start impede o spawn (sem filho órfão)', async () => {
    const harness = createChildSpawner()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: fetchAlwaysFail(),
      processRunner: createRunner(),
      childSpawner: harness.spawner,
      sleep: async () => undefined,
    })
    const pending = service.start()
    await service.stop()
    await pending
    expect(harness.calls).toHaveLength(0)
    expect(service.status().state).toBe('unavailable')
  })

  it('versão divergente vira error', async () => {
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: fetchAlwaysFail(),
      processRunner: createRunner({ version: '1.2.3' }),
      childSpawner: createChildSpawner().spawner,
      sleep: async () => undefined,
    })
    const status = await service.start()
    expect(status.state).toBe('error')
    expect(status.message).toContain('2.4.0')
  })

  it('hash divergente do artefato vira error de integridade', async () => {
    const memory = createMemoryFs()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: memory.fs,
      fetchImpl: fetchAlwaysFail(),
      processRunner: createRunner(),
      childSpawner: createChildSpawner().spawner,
      downloadImpl: async (_url, destination) => {
        await memory.fs.writeFile(destination, 'zip-corrompido')
      },
      extractImpl: async () => undefined,
      sleep: async () => undefined,
    })
    const status = await service.start()
    expect(status.state).toBe('error')
    expect(status.message).toContain('SHA-256')
    expect(memory.files.has(path.join(USER_DATA, 'cache', 'ai-memory-windows-x86_64.zip').toLowerCase())).toBe(false)
  })

  it('instala artefato verificado e extrai via extract injetado', async () => {
    const memory = createMemoryFs()
    const zipBytes = 'zip-valido'
    const extract = vi.fn(async (_archive: string, destination: string) => {
      await memory.fs.mkdir(destination, { recursive: true })
      await memory.fs.writeFile(path.join(destination, 'ai-memory.exe'), '')
    })
    let spawned = false
    const fetchImpl = fetchStatefulScoped(() => spawned)
    const harness = createChildSpawner()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: memory.fs,
      fetchImpl,
      processRunner: createRunner(),
      childSpawner: (command, args, options) => {
        spawned = true
        return harness.spawner(command, args, options)
      },
      downloadImpl: async (_url, destination) => {
        await memory.fs.writeFile(destination, zipBytes)
      },
      expectedSha256: createHash('sha256').update(zipBytes).digest('hex'),
      extractImpl: extract,
      sleep: async () => undefined,
    })
    const status = await service.start()
    expect(status.state).toBe('running')
    expect(extract).toHaveBeenCalledWith(
      path.join(USER_DATA, 'cache', 'ai-memory-windows-x86_64.zip'),
      path.join(USER_DATA, 'runtime')
    )
  })

  it('timeout de health vira degraded e encerra o filho', async () => {
    const harness = createChildSpawner()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: fetchAlwaysFail(),
      processRunner: createRunner(),
      childSpawner: harness.spawner,
      healthTimeoutMs: 15,
      healthIntervalMs: 1,
      sleep: async () => undefined,
    })
    const status = await service.start()
    expect(status.state).toBe('degraded')
    expect(harness.kill).toHaveBeenCalledTimes(1)
  })

  it('start concorrente é deduplicado (single-flight)', async () => {
    let spawned = false
    const fetchImpl = fetchStatefulScoped(() => spawned)
    const harness = createChildSpawner()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl,
      processRunner: createRunner(),
      childSpawner: (command, args, options) => {
        spawned = true
        return harness.spawner(command, args, options)
      },
      sleep: async () => undefined,
    })
    const [first, second] = await Promise.all([service.start(), service.start()])
    expect(first.state).toBe('running')
    expect(second.state).toBe('running')
    expect(harness.calls).toHaveLength(1)
  })
})

describe('ai-memory extract invocation', () => {
  it('usa o PowerShell real, nunca o cmd.exe', () => {
    const invocation = buildExpandArchiveInvocation(
      'powershell.exe',
      "C:\\tmp\\a'memory.zip",
      'C:\\tmp\\dest'
    )
    expect(invocation.command).toBe('powershell.exe')
    expect(invocation.command).not.toMatch(/cmd\.exe/i)
    expect(invocation.args[0]).toBe('-NoProfile')
    expect(invocation.args[1]).toBe('-NonInteractive')
    expect(invocation.args[2]).toBe('-Command')
    expect(invocation.args[3]).toContain("Expand-Archive")
    expect(invocation.args[3]).toContain("''memory.zip")
  })

  it('escapeTomlString protege aspas e barras', () => {
    expect(escapeTomlString('a"b\\c')).toBe('a\\"b\\\\c')
  })
})

describe('ai-memory scope + marker via service', () => {
  it('resolve worktrees para a mesma identidade via git-common-dir', async () => {
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs().fs,
      processRunner: createRunner({ remote: '' }),
      sleep: async () => undefined,
    })
    const scope = await service.resolveScope(PROJECT_PATH)
    expect(scope.source).toBe('git-common-dir')
    expect(scope.workspace).toBe('devorbit')
  })

  it('lê o marker customizado na raiz do worktree, não no subdiretório de entrada', async () => {
    const memory = createMemoryFs({
      [path.join(REPO_ROOT, '.ai-memory.toml')]: 'workspace = "custom-ws"\nproject = "custom-proj"\n',
    })
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: memory.fs,
      processRunner: createRunner({ topLevel: REPO_ROOT }),
      sleep: async () => undefined,
    })
    const scope = await service.resolveScope(SUBDIR)
    expect(scope).toMatchObject({
      workspace: 'custom-ws',
      project: 'custom-proj',
      source: 'marker',
      root: REPO_ROOT,
    })
  })

  it('escreve o marker na raiz do worktree (--show-toplevel), não no subdiretório', async () => {
    const memory = createMemoryFs()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: memory.fs,
      processRunner: createRunner({ topLevel: REPO_ROOT }),
      sleep: async () => undefined,
    })
    const result = await service.ensureProjectMarker(SUBDIR)
    expect(result.status).toBe('created')
    expect(result.configured).toBe(true)
    expect(memory.files.has(path.join(REPO_ROOT, '.ai-memory.toml').toLowerCase())).toBe(true)
    expect(memory.files.has(path.join(SUBDIR, '.ai-memory.toml').toLowerCase())).toBe(false)
    const marker = [...memory.files.values()][0].toString('utf8')
    expect(marker).toContain('.env')
    expect(marker).toContain('secrets/**')
    expect(marker).toContain('**/*.pem')
    expect(marker).toContain('**/*.key')
  })

  it('disabled não escreve marker; habilitado escreve idempotente', async () => {
    const disabledMemory = createMemoryFs()
    const disabled = createAiMemoryService({
      userDataDir: USER_DATA,
      config: { enabled: false, projects: {} },
      fileSystem: disabledMemory.fs,
      processRunner: createRunner(),
      sleep: async () => undefined,
    })
    expect(await disabled.ensureProjectMarker(PROJECT_PATH)).toEqual({
      status: 'disabled',
      configured: false,
    })
    expect(disabledMemory.files.size).toBe(0)

    const memory = createMemoryFs()
    const enabled = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: memory.fs,
      processRunner: createRunner(),
      sleep: async () => undefined,
    })
    const created = await enabled.ensureProjectMarker(PROJECT_PATH)
    expect(created.status).toBe('created')
    const again = await enabled.ensureProjectMarker(PROJECT_PATH)
    expect(again.status).toBe('unchanged')
  })

  it('marker de terceiros fica intacto e NÃO é reportado como configurado', async () => {
    const memory = createMemoryFs({
      [path.join(PROJECT_PATH, '.ai-memory.toml')]: 'workspace = "devorbit"\n',
    })
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: memory.fs,
      processRunner: createRunner(),
      sleep: async () => undefined,
    })
    const result = await service.ensureProjectMarker(PROJECT_PATH)
    expect(result.status).toBe('preserved')
    expect(result.configured).toBe(false)
    expect(result.missingFields).toEqual(expect.arrayContaining(['project', 'ignore_paths', 'briefing']))
    expect([...memory.files.values()][0].toString('utf8')).toBe('workspace = "devorbit"\n')
  })
})

describe('ai-memory reconfigure + health outage', () => {
  it('reconfigure liga/desliga sem matar serviço externo', async () => {
    const harness = createChildSpawner()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: { enabled: false, projects: {} },
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: fetchScopedOk(),
      processRunner: createRunner(),
      childSpawner: harness.spawner,
      sleep: async () => undefined,
    })

    expect((await service.start()).state).toBe('unavailable')
    const enabled = await service.reconfigure(enabledConfig())
    expect(enabled).toMatchObject({ state: 'running', owned: false })
    const disabled = await service.reconfigure({ enabled: false, projects: {} })
    expect(disabled.state).toBe('unavailable')
    // Serviço externo nunca é morto e nenhum filho é iniciado.
    expect(harness.calls).toHaveLength(0)
    expect(harness.kill).not.toHaveBeenCalled()
  })

  it('reconfigure com filho próprio encerra apenas o filho ao desabilitar', async () => {
    let spawned = false
    const harness = createChildSpawner()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: fetchStatefulScoped(() => spawned),
      processRunner: createRunner(),
      childSpawner: (command, args, options) => {
        spawned = true
        return harness.spawner(command, args, options)
      },
      sleep: async () => undefined,
    })

    expect((await service.start()).state).toBe('running')
    const disabled = await service.reconfigure({ enabled: false, projects: {} })
    expect(disabled.state).toBe('unavailable')
    expect(harness.kill).toHaveBeenCalledTimes(1)
  })

  it('reconfigure alterna projeto habilitado e reavalia o serviço', async () => {
    const base = enabledConfig()
    const identity = Object.keys(base.projects)[0]
    const projectDisabled: AiMemoryConfig = {
      enabled: true,
      projects: { [identity]: { ...base.projects[identity], enabled: false } },
    }
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: { enabled: true, projects: {} },
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: fetchScopedOk(),
      processRunner: createRunner(),
      childSpawner: createChildSpawner().spawner,
      sleep: async () => undefined,
    })

    expect((await service.start()).state).toBe('unavailable')
    expect((await service.reconfigure(projectDisabled)).state).toBe('unavailable')
    expect((await service.reconfigure(base)).state).toBe('running')
  })

  it('reconfigure invalida start em voo sem deixar filho órfão', async () => {
    const harness = createChildSpawner()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: fetchAlwaysFail(),
      processRunner: createRunner(),
      childSpawner: harness.spawner,
      healthTimeoutMs: 5_000,
      healthIntervalMs: 5,
      sleep: async () => undefined,
    })

    const pending = service.start()
    const result = await service.reconfigure({ enabled: false, projects: {} })
    await pending
    expect(result.state).toBe('unavailable')
    // O start obsoleto não chega a spawnar; nenhum filho fica rastreável.
    expect(harness.calls).toHaveLength(0)
    expect(harness.kill).not.toHaveBeenCalled()
  })

  it('health após running reflete outage em degraded, sem derrubar o filho', async () => {
    let spawned = false
    let down = false
    const scope = enabledScope()
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      if (!spawned || down) throw new Error('recusado')
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
      if (body.method === 'initialize') return initializeOk()
      return scopedStatus(scope.workspace, scope.project)
    }) as unknown as typeof fetch
    const harness = createChildSpawner()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl,
      processRunner: createRunner(),
      childSpawner: (command, args, options) => {
        spawned = true
        return harness.spawner(command, args, options)
      },
      sleep: async () => undefined,
    })

    expect((await service.start()).state).toBe('running')
    down = true
    const outage = await service.health()
    expect(outage.ok).toBe(false)
    expect(service.status().state).toBe('degraded')
    expect(service.status().message).toContain('sem resposta')
    // Fail-graceful: o filho não é morto por uma falha de saúde.
    expect(harness.kill).not.toHaveBeenCalled()

    down = false
    expect((await service.health()).ok).toBe(true)
    expect(service.status().state).toBe('running')
  })
})

describe('ai-memory opt-out efetivo de marker', () => {
  it('optOutProjectMarker remove apenas o marker canônico gerenciado', async () => {
    const memory = createMemoryFs()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: memory.fs,
      processRunner: createRunner(),
      sleep: async () => undefined,
    })
    const created = await service.ensureProjectMarker(PROJECT_PATH)
    expect(created.status).toBe('created')
    const markerPath = path.join(PROJECT_PATH, '.ai-memory.toml').toLowerCase()
    expect(memory.files.has(markerPath)).toBe(true)

    const removed = await service.optOutProjectMarker(PROJECT_PATH)
    expect(removed.status).toBe('removed')
    expect(memory.files.has(markerPath)).toBe(false)
  })

  it('optOutProjectMarker é absent sem marker', async () => {
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs().fs,
      processRunner: createRunner(),
      sleep: async () => undefined,
    })
    expect((await service.optOutProjectMarker(PROJECT_PATH)).status).toBe('absent')
  })

  it('optOutProjectMarker preserva marker de terceiros e retorna conflito', async () => {
    const thirdParty = 'workspace = "devorbit"\n'
    const memory = createMemoryFs({ [path.join(PROJECT_PATH, '.ai-memory.toml')]: thirdParty })
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: memory.fs,
      processRunner: createRunner(),
      sleep: async () => undefined,
    })
    const result = await service.optOutProjectMarker(PROJECT_PATH)
    expect(result.status).toBe('conflict')
    expect(result.message).toContain('Preservado')
    const raw = (await memory.fs.readFile(path.join(PROJECT_PATH, '.ai-memory.toml'))).toString('utf8')
    expect(raw).toBe(thirdParty)
  })

  it('optOutProjectMarker preserva marker gerenciado com extras', async () => {
    const managed = `${AI_MEMORY_MARKER_MANAGED_HEADER}\nworkspace = "devorbit"\nproject = "p-abc"\n[recall]\ndefault_global = "true"\n`
    const memory = createMemoryFs({ [path.join(PROJECT_PATH, '.ai-memory.toml')]: managed })
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: memory.fs,
      processRunner: createRunner(),
      sleep: async () => undefined,
    })
    expect((await service.optOutProjectMarker(PROJECT_PATH)).status).toBe('conflict')
    const raw = (await memory.fs.readFile(path.join(PROJECT_PATH, '.ai-memory.toml'))).toString('utf8')
    expect(raw).toBe(managed)
  })

  it('reconfigure true→false remove o marker canônico do projeto', async () => {
    const memory = createMemoryFs()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: memory.fs,
      fetchImpl: fetchScopedOk(),
      processRunner: createRunner(),
      childSpawner: createChildSpawner().spawner,
      sleep: async () => undefined,
    })
    await service.ensureProjectMarker(PROJECT_PATH)
    const status = await service.reconfigure({ enabled: false, projects: {} })
    expect(status.state).toBe('unavailable')
    expect(memory.files.has(path.join(PROJECT_PATH, '.ai-memory.toml').toLowerCase())).toBe(false)
  })

  it('reconfigure true→false preserva marker de terceiros e reporta conflito acionável', async () => {
    const thirdParty = 'workspace = "devorbit"\n'
    const memory = createMemoryFs({ [path.join(PROJECT_PATH, '.ai-memory.toml')]: thirdParty })
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: memory.fs,
      fetchImpl: fetchScopedOk(),
      processRunner: createRunner(),
      childSpawner: createChildSpawner().spawner,
      sleep: async () => undefined,
    })
    const status = await service.reconfigure({ enabled: false, projects: {} })
    expect(status.state).toBe('unavailable')
    expect(status.message).toContain('preservado')
    const raw = (await memory.fs.readFile(path.join(PROJECT_PATH, '.ai-memory.toml'))).toString('utf8')
    expect(raw).toBe(thirdParty)
  })
})

describe('ai-memory bootstrap de projeto novo (pré-primeira sessão)', () => {
  it('projeto novo vazio (not found) permite start running sem bootstrap de conteúdo', async () => {
    const scope = enabledScope()
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
      if (body.method === 'initialize') return initializeOk()
      return rpcError(-32602, `project '${scope.project}' not found in workspace '${scope.workspace}'`)
    }) as unknown as typeof fetch
    const harness = createChildSpawner()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl,
      processRunner: createRunner(),
      childSpawner: harness.spawner,
      sleep: async () => undefined,
    })

    const status = await service.start()
    // Endpoint compatível + projeto ainda não materializado: launcher pode rodar.
    expect(status).toMatchObject({ state: 'running', owned: false })
    // Nenhum bootstrap de conteúdo: não spawna e não escreve marker.
    expect(harness.calls).toHaveLength(0)
  })

  it('invalid_params que NÃO é "not found" continua fail-closed', async () => {
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
      if (body.method === 'initialize') return initializeOk()
      return rpcError(-32602, 'workspace and project must be provided together')
    }) as unknown as typeof fetch
    const harness = createChildSpawner()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl,
      processRunner: createRunner(),
      childSpawner: harness.spawner,
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status).toMatchObject({ state: 'degraded', owned: false })
    expect(status.conflict).not.toBe(true)
    expect(status.message).toContain('falha ao consultar memory_status')
    expect(harness.calls).toHaveLength(0)
  })

  it('not-found de PROJECT divergente não é tolerado (fail-closed)', async () => {
    const scope = enabledScope()
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
      if (body.method === 'initialize') return initializeOk()
      return rpcError(-32602, `project 'outro-projeto' not found in workspace '${scope.workspace}'`)
    }) as unknown as typeof fetch
    const harness = createChildSpawner()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl,
      processRunner: createRunner(),
      childSpawner: harness.spawner,
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status).toMatchObject({ state: 'degraded', owned: false })
    expect(status.message).toContain('falha ao consultar memory_status')
    expect(harness.calls).toHaveLength(0)
  })

  it('not-found de WORKSPACE divergente não é tolerado (fail-closed)', async () => {
    const scope = enabledScope()
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
      if (body.method === 'initialize') return initializeOk()
      return rpcError(-32602, `project '${scope.project}' not found in workspace 'outro-workspace'`)
    }) as unknown as typeof fetch
    const harness = createChildSpawner()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl,
      processRunner: createRunner(),
      childSpawner: harness.spawner,
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status).toMatchObject({ state: 'degraded', owned: false })
    expect(status.message).toContain('falha ao consultar memory_status')
    expect(harness.calls).toHaveLength(0)
  })

  it('formato com texto extra além do eco exato não é tolerado (âncora $)', async () => {
    const scope = enabledScope()
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
      if (body.method === 'initialize') return initializeOk()
      return rpcError(
        -32602,
        `project '${scope.project}' not found in workspace '${scope.workspace}' (hint: use memory_write_page)`
      )
    }) as unknown as typeof fetch
    const harness = createChildSpawner()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl,
      processRunner: createRunner(),
      childSpawner: harness.spawner,
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status).toMatchObject({ state: 'degraded', owned: false })
    expect(status.message).toContain('falha ao consultar memory_status')
    expect(harness.calls).toHaveLength(0)
  })
})

describe('ai-memory opt-out em worktrees do mesmo common-dir', () => {
  it('A+B→off: remove o marker canônico em todos os worktrees registrados', async () => {
    const memory = createMemoryFs()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: worktreeConfig(),
      fileSystem: memory.fs,
      processRunner: createWorktreeRunner(),
      childSpawner: createChildSpawner().spawner,
      fetchImpl: fetchAlwaysFail(),
      sleep: async () => undefined,
    })

    expect((await service.ensureProjectMarker(WORKTREE_A)).status).toBe('created')
    expect((await service.ensureProjectMarker(WORKTREE_B)).status).toBe('created')
    const markerA = path.join(WORKTREE_A, '.ai-memory.toml').toLowerCase()
    const markerB = path.join(WORKTREE_B, '.ai-memory.toml').toLowerCase()
    expect(memory.files.has(markerA)).toBe(true)
    expect(memory.files.has(markerB)).toBe(true)

    const status = await service.reconfigure({ enabled: false, projects: {} })
    expect(status.state).toBe('unavailable')
    expect(memory.files.has(markerA)).toBe(false)
    expect(memory.files.has(markerB)).toBe(false)
  })

  it('A+B→off preserva marker de terceiros em um worktree e reporta conflito', async () => {
    const thirdParty = 'workspace = "devorbit"\n'
    const memory = createMemoryFs({ [path.join(WORKTREE_B, '.ai-memory.toml')]: thirdParty })
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: worktreeConfig(),
      fileSystem: memory.fs,
      processRunner: createWorktreeRunner(),
      childSpawner: createChildSpawner().spawner,
      fetchImpl: fetchAlwaysFail(),
      sleep: async () => undefined,
    })

    expect((await service.ensureProjectMarker(WORKTREE_A)).status).toBe('created')
    const status = await service.reconfigure({ enabled: false, projects: {} })
    expect(status.state).toBe('unavailable')
    expect(status.message).toContain('preservado')
    expect(memory.files.has(path.join(WORKTREE_A, '.ai-memory.toml').toLowerCase())).toBe(false)
    const rawB = (await memory.fs.readFile(path.join(WORKTREE_B, '.ai-memory.toml'))).toString('utf8')
    expect(rawB).toBe(thirdParty)
  })
})

describe('ai-memory service — plataforma não-Windows (sem download do asset x64)', () => {
  it('Linux/macOS sem binário: degrada graceful e NÃO baixa o asset Windows', async () => {
    const download = vi.fn(async () => undefined)
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      platform: 'linux',
      fileSystem: createMemoryFs().fs,
      fetchImpl: fetchAlwaysFail(),
      processRunner: createRunner(),
      childSpawner: createChildSpawner().spawner,
      downloadImpl: download,
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status.state).toBe('degraded')
    expect(download).not.toHaveBeenCalled()
    expect(status.message).toContain('Windows x64')
  })

  it('Linux com binário externo no PATH: running (suportado)', async () => {
    const externalBinary = '/usr/local/bin/ai-memory'
    const memory = createMemoryFs({ [externalBinary]: '' })
    let spawned = false
    const harness = createChildSpawner()
    const runner: AiMemoryProcessRunner = async (command, args) => {
      if (command === 'git' && args[0] === 'remote') return { code: 0, stdout: `${REMOTE}\n`, stderr: '' }
      if (command === 'git' && args[0] === 'rev-parse') {
        if (args[1] === '--show-toplevel') return { code: 1, stdout: '', stderr: '' }
        return { code: 0, stdout: `${path.join(PROJECT_PATH, '.git')}\n`, stderr: '' }
      }
      if (command === 'which') return { code: 0, stdout: `${externalBinary}\n`, stderr: '' }
      if (command === 'where') return { code: 1, stdout: '', stderr: '' }
      return { code: 0, stdout: 'ai-memory 2.4.0\n', stderr: '' }
    }
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      platform: 'linux',
      fileSystem: memory.fs,
      fetchImpl: fetchStatefulScoped(() => spawned),
      processRunner: runner,
      childSpawner: (command, args, options) => {
        spawned = true
        return harness.spawner(command, args, options)
      },
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status).toMatchObject({ state: 'running', owned: true, version: '2.4.0' })
    expect(harness.calls[0][0]).toBe(externalBinary)
  })

  it('win32/arm64 sem binário: degrada graceful e NÃO baixa o asset x64', async () => {
    const download = vi.fn(async () => undefined)
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      platform: 'win32',
      arch: 'arm64',
      fileSystem: createMemoryFs().fs,
      fetchImpl: fetchAlwaysFail(),
      processRunner: createRunner(),
      childSpawner: createChildSpawner().spawner,
      downloadImpl: download,
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status.state).toBe('degraded')
    expect(download).not.toHaveBeenCalled()
    expect(status.message).toContain('win32/arm64')
  })

  it('win32/arm64 com binário no PATH: running (aceito em qualquer arch)', async () => {
    const externalBinary = 'C:\\tools\\ai-memory.exe'
    const memory = createMemoryFs({ [externalBinary]: '' })
    let spawned = false
    const harness = createChildSpawner()
    const runner: AiMemoryProcessRunner = async (command, args) => {
      if (command === 'git' && args[0] === 'remote') return { code: 0, stdout: `${REMOTE}\n`, stderr: '' }
      if (command === 'git' && args[0] === 'rev-parse') {
        if (args[1] === '--show-toplevel') return { code: 1, stdout: '', stderr: '' }
        return { code: 0, stdout: `${path.join(PROJECT_PATH, '.git')}\n`, stderr: '' }
      }
      if (command === 'where') return { code: 0, stdout: `${externalBinary}\n`, stderr: '' }
      if (command === 'which') return { code: 1, stdout: '', stderr: '' }
      return { code: 0, stdout: 'ai-memory 2.4.0\n', stderr: '' }
    }
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      platform: 'win32',
      arch: 'arm64',
      fileSystem: memory.fs,
      fetchImpl: fetchStatefulScoped(() => spawned),
      processRunner: runner,
      childSpawner: (command, args, options) => {
        spawned = true
        return harness.spawner(command, args, options)
      },
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status).toMatchObject({ state: 'running', owned: true, version: '2.4.0' })
    expect(harness.calls[0][0]).toBe(externalBinary)
  })

  it('macOS sem binário: degrada graceful e NÃO baixa o asset Windows', async () => {
    const download = vi.fn(async () => undefined)
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      platform: 'darwin',
      arch: 'arm64',
      fileSystem: createMemoryFs().fs,
      fetchImpl: fetchAlwaysFail(),
      processRunner: createRunner(),
      childSpawner: createChildSpawner().spawner,
      downloadImpl: download,
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status.state).toBe('degraded')
    expect(download).not.toHaveBeenCalled()
    expect(status.message).toContain('darwin/arm64')
  })

  it('macOS com binário no PATH: running (suportado)', async () => {
    const externalBinary = '/opt/homebrew/bin/ai-memory'
    const memory = createMemoryFs({ [externalBinary]: '' })
    let spawned = false
    const harness = createChildSpawner()
    const runner: AiMemoryProcessRunner = async (command, args) => {
      if (command === 'git' && args[0] === 'remote') return { code: 0, stdout: `${REMOTE}\n`, stderr: '' }
      if (command === 'git' && args[0] === 'rev-parse') {
        if (args[1] === '--show-toplevel') return { code: 1, stdout: '', stderr: '' }
        return { code: 0, stdout: `${path.join(PROJECT_PATH, '.git')}\n`, stderr: '' }
      }
      if (command === 'which') return { code: 0, stdout: `${externalBinary}\n`, stderr: '' }
      if (command === 'where') return { code: 1, stdout: '', stderr: '' }
      return { code: 0, stdout: 'ai-memory 2.4.0\n', stderr: '' }
    }
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      platform: 'darwin',
      arch: 'arm64',
      fileSystem: memory.fs,
      fetchImpl: fetchStatefulScoped(() => spawned),
      processRunner: runner,
      childSpawner: (command, args, options) => {
        spawned = true
        return harness.spawner(command, args, options)
      },
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status).toMatchObject({ state: 'running', owned: true, version: '2.4.0' })
    expect(harness.calls[0][0]).toBe(externalBinary)
  })

  it('macOS com versão divergente no PATH: vira error', async () => {
    const externalBinary = '/opt/homebrew/bin/ai-memory'
    const memory = createMemoryFs({ [externalBinary]: '' })
    const runner: AiMemoryProcessRunner = async (command, args) => {
      if (command === 'git') return { code: 0, stdout: `${REMOTE}\n`, stderr: '' }
      if (command === 'which') return { code: 0, stdout: `${externalBinary}\n`, stderr: '' }
      if (command === externalBinary && args[0] === '--version') {
        return { code: 0, stdout: 'ai-memory 1.0.0\n', stderr: '' }
      }
      return { code: 0, stdout: 'ai-memory 2.4.0\n', stderr: '' }
    }
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      platform: 'darwin',
      arch: 'arm64',
      fileSystem: memory.fs,
      fetchImpl: fetchAlwaysFail(),
      processRunner: runner,
      childSpawner: createChildSpawner().spawner,
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status.state).toBe('error')
    expect(status.message).toContain('2.4.0')
  })

  it('macOS com binário no runtimeDir sem extensão .exe: running (suportado)', async () => {
    const runtimeBinary = path.join(USER_DATA, 'runtime', 'ai-memory')
    const memory = createMemoryFs({ [runtimeBinary]: '' })
    let spawned = false
    const harness = createChildSpawner()
    const runner: AiMemoryProcessRunner = async (command, args) => {
      if (command === 'git') return { code: 0, stdout: `${REMOTE}\n`, stderr: '' }
      if (command === 'which' || command === 'where') return { code: 1, stdout: '', stderr: '' }
      if (command === runtimeBinary && args[0] === '--version') {
        return { code: 0, stdout: 'ai-memory 2.4.0\n', stderr: '' }
      }
      return { code: 0, stdout: 'ai-memory 2.4.0\n', stderr: '' }
    }
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      platform: 'darwin',
      arch: 'arm64',
      fileSystem: memory.fs,
      fetchImpl: fetchStatefulScoped(() => spawned),
      processRunner: runner,
      childSpawner: (command, args, options) => {
        spawned = true
        return harness.spawner(command, args, options)
      },
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status).toMatchObject({ state: 'running', owned: true, version: '2.4.0' })
    expect(harness.calls[0][0]).toBe(runtimeBinary)
  })
})

describe('ai-memory-service — resiliência sidecar, lifecycle e discovery (P1/P2 fixes)', () => {
  function createHangingFetch(onAbort?: () => void): typeof fetch {
    return ((url: unknown, init?: { signal?: AbortSignal }) => {
      const urlStr = String(url)
      if (!urlStr.includes('github.com')) {
        return Promise.reject(new Error('connection refused'))
      }
      return new Promise<Response>((_, reject) => {
        if (init?.signal?.aborted) {
          onAbort?.()
          reject(new DOMException('The operation was aborted', 'AbortError'))
          return
        }
        init?.signal?.addEventListener(
          'abort',
          () => {
            onAbort?.()
            reject(new DOMException('The operation was aborted', 'AbortError'))
          },
          { once: true }
        )
      })
    }) as unknown as typeof fetch
  }

  it('download com timeout aborta com erro e libera startPromise (P1 #1)', async () => {
    const memory = createMemoryFs()
    let aborted = false
    const hangingFetch = createHangingFetch(() => {
      aborted = true
    })

    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: memory.fs,
      fetchImpl: hangingFetch,
      downloadTimeoutMs: 15,
      processRunner: createRunner(),
      childSpawner: createChildSpawner().spawner,
      sleep: async () => undefined,
    })
    const status = await service.start()
    expect(status.state).toBe('error')
    expect(status.message).toContain('Timeout')
    expect(aborted).toBe(true)
  })

  it('stop() durante o download aborta o fetch em voo e libera startPromise (P1 #1)', async () => {
    const memory = createMemoryFs()
    let signalAborted = false
    const hangingFetch = createHangingFetch(() => {
      signalAborted = true
    })

    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: memory.fs,
      fetchImpl: hangingFetch,
      downloadTimeoutMs: 10_000,
      processRunner: createRunner(),
      childSpawner: createChildSpawner().spawner,
      sleep: async () => undefined,
    })

    const startPromise = service.start()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await service.stop()
    const status = await startPromise

    expect(signalAborted).toBe(true)
    expect(status.state).toBe('unavailable')
  })

  it('reconfigure() durante o download aborta o fetch em voo sem travar a UI (P1 #1)', async () => {
    const memory = createMemoryFs()
    let signalAborted = false
    const hangingFetch = createHangingFetch(() => {
      signalAborted = true
    })

    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: memory.fs,
      fetchImpl: hangingFetch,
      downloadTimeoutMs: 10_000,
      processRunner: createRunner(),
      childSpawner: createChildSpawner().spawner,
      sleep: async () => undefined,
    })

    void service.start()
    await new Promise((resolve) => setTimeout(resolve, 5))

    const reconfigured = await service.reconfigure({ enabled: false, projects: {} })
    expect(signalAborted).toBe(true)
    expect(reconfigured.state).toBe('unavailable')
  })

  it('discovery pula binário incompatível no PATH e instala a versão pinada v2.4.0 (P1 #2)', async () => {
    const memory = createMemoryFs()
    const zipBytes = 'zip-v2.4.0'
    const extract = vi.fn(async (_archive: string, destination: string) => {
      await memory.fs.mkdir(destination, { recursive: true })
      await memory.fs.writeFile(path.join(destination, 'ai-memory.exe'), '')
    })

    let spawned = false
    const fetchImpl = fetchStatefulScoped(() => spawned)
    const harness = createChildSpawner()

    const customRunner: AiMemoryProcessRunner = async (command, args) => {
      if (command === 'git') return { code: 0, stdout: `${REMOTE}\n`, stderr: '' }
      if (command === 'where' || command === 'which') {
        await memory.fs.writeFile('/system/bin/ai-memory.exe', '')
        return { code: 0, stdout: '/system/bin/ai-memory.exe\n', stderr: '' }
      }
      if (command === '/system/bin/ai-memory.exe' && args[0] === '--version') {
        return { code: 0, stdout: 'ai-memory 2.2.0\n', stderr: '' }
      }
      if (command.includes('runtime') && args[0] === '--version') {
        return { code: 0, stdout: 'ai-memory 2.4.0\n', stderr: '' }
      }
      return { code: 0, stdout: 'ai-memory 2.4.0\n', stderr: '' }
    }

    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: memory.fs,
      fetchImpl,
      processRunner: customRunner,
      childSpawner: (command, args, options) => {
        spawned = true
        return harness.spawner(command, args, options)
      },
      downloadImpl: async (_url, destination) => {
        await memory.fs.writeFile(destination, zipBytes)
      },
      expectedSha256: createHash('sha256').update(zipBytes).digest('hex'),
      extractImpl: extract,
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status.state).toBe('running')
    expect(status.version).toBe('2.4.0')
    expect(extract).toHaveBeenCalledTimes(1)
    expect(harness.calls[0][0]).toBe(path.join(USER_DATA, 'runtime', 'ai-memory.exe'))
  })

  it('discovery pula binário obsoleto no runtimeDir e reinstala a versão pinada v2.4.0 (P1 #2)', async () => {
    const memory = createMemoryFs({
      [path.join(USER_DATA, 'runtime', 'ai-memory.exe')]: 'old-bin',
    })
    const zipBytes = 'zip-v2.4.0-updated'
    let extracted = false
    const extract = vi.fn(async (_archive: string, destination: string) => {
      extracted = true
      await memory.fs.mkdir(destination, { recursive: true })
      await memory.fs.writeFile(path.join(destination, 'ai-memory.exe'), 'new-bin')
    })

    let spawned = false
    const fetchImpl = fetchStatefulScoped(() => spawned)
    const harness = createChildSpawner()

    const customRunner: AiMemoryProcessRunner = async (command, args) => {
      if (command === 'git') return { code: 0, stdout: `${REMOTE}\n`, stderr: '' }
      if (command === 'where' || command === 'which') return { code: 1, stdout: '', stderr: '' }
      if (args[0] === '--version') {
        return { code: 0, stdout: extracted ? 'ai-memory 2.4.0\n' : 'ai-memory 2.1.0\n', stderr: '' }
      }
      return { code: 0, stdout: 'ai-memory 2.4.0\n', stderr: '' }
    }

    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: memory.fs,
      fetchImpl,
      processRunner: customRunner,
      childSpawner: (command, args, options) => {
        spawned = true
        return harness.spawner(command, args, options)
      },
      downloadImpl: async (_url, destination) => {
        await memory.fs.writeFile(destination, zipBytes)
      },
      expectedSha256: createHash('sha256').update(zipBytes).digest('hex'),
      extractImpl: extract,
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status.state).toBe('running')
    expect(status.version).toBe('2.4.0')
    expect(extract).toHaveBeenCalledTimes(1)
  })

  it('se o filho próprio encerra no spawn mas servidor compatível responde na porta, adota external com owned=false (P2 #4)', async () => {
    const scope = enabledScope()
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
      if (body.method === 'initialize') return initializeOk('ai-memory', '2.4.0')
      return scopedStatus(scope.workspace, scope.project)
    }) as unknown as typeof fetch

    const harness = createChildSpawner()
    const spawnerImmediateExit: AiMemoryChildSpawner = (command, args, options) => {
      const handle = harness.spawner(command, args, options)
      queueMicrotask(() => harness.exit(1))
      return handle
    }

    let probedOnce = false
    const dynamicFetch: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!probedOnce) {
        probedOnce = true
        throw new Error('porta livre antes do spawn')
      }
      return fetchImpl(url, init)
    }) as unknown as typeof fetch

    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: dynamicFetch,
      processRunner: createRunner(),
      childSpawner: spawnerImmediateExit,
      sleep: async () => {
        await new Promise((r) => setTimeout(r, 5))
      },
    })

    const status = await service.start()
    expect(status.state).toBe('running')
    expect(status.owned).toBe(false)
    expect(status.message).toContain('Serviço ai-memory externo detectado')
  })

  it('lastIncompatibleCandidate é resetado por tentativa de discovery e não vaza em retry sem candidato (P3)', async () => {
    const incompatibleBinary = path.join(USER_DATA, 'runtime', 'ai-memory')
    const memory = createMemoryFs({ [incompatibleBinary]: 'bad-bin' })

    const customRunner: AiMemoryProcessRunner = async (command, args) => {
      if (command === 'git') return { code: 0, stdout: `${REMOTE}\n`, stderr: '' }
      if (command === 'where' || command === 'which') return { code: 1, stdout: '', stderr: '' }
      if (args[0] === '--version') {
        return { code: 0, stdout: 'ai-memory 1.0.0\n', stderr: '' }
      }
      return { code: 0, stdout: 'ai-memory 2.4.0\n', stderr: '' }
    }

    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      platform: 'darwin',
      arch: 'arm64',
      fileSystem: memory.fs,
      fetchImpl: fetchAlwaysFail(),
      processRunner: customRunner,
      childSpawner: createChildSpawner().spawner,
      sleep: async () => undefined,
    })

    // 1ª tentativa: binário incompatível presente vira error mencionando a versão encontrada
    const firstStatus = await service.start()
    expect(firstStatus.state).toBe('error')
    expect(firstStatus.message).toContain('1.0.0')

    // Remove o binário incompatível: agora nenhum candidato existe
    await memory.fs.rm(incompatibleBinary, { force: true })

    // 2ª tentativa via reconfigure (sem stop prévio): discovery reseta lastIncompatibleCandidate e mostra estado/mensagem atual sem texto antigo
    const retryStatus = await service.reconfigure(enabledConfig())
    expect(retryStatus.state).toBe('degraded')
    expect(retryStatus.message).not.toContain('1.0.0')
    expect(retryStatus.message).toContain('Binário ai-memory compatível não encontrado')
  })
})

describe('ai-memory service — contenção Job Object do sidecar próprio', () => {
  function fakeContainment(limitation?: string): AiMemoryJobContainment & {
    contain: Mock<(pid: number, identity?: AiMemoryJobProcessIdentity) => void>
    release: Mock<() => void>
  } {
    const contain = vi.fn<(pid: number, identity?: AiMemoryJobProcessIdentity) => void>()
    const release = vi.fn<() => void>()
    return {
      contain,
      release,
      status: () => ({
        platform: 'win32' as NodeJS.Platform,
        supported: true,
        active: contain.mock.calls.length > 0,
        ...(limitation !== undefined ? { limitation } : {}),
      }),
    }
  }

  it('associa SOMENTE o child próprio (pid do spawner) e libera o job no stop', async () => {
    let spawned = false
    const harness = createChildSpawner()
    const containment = fakeContainment()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: fetchStatefulScoped(() => spawned),
      processRunner: createRunner(),
      childSpawner: (command, args, options) => {
        spawned = true
        return harness.spawner(command, args, options)
      },
      containment,
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status).toMatchObject({ state: 'running', owned: true })
    expect(containment.contain).toHaveBeenCalledTimes(1)
    expect(containment.contain).toHaveBeenCalledWith(
      4242,
      expect.objectContaining({
        imagePath: path.join(USER_DATA, 'runtime', 'ai-memory.exe'),
        spawnedAtMs: expect.any(Number),
      })
    )
    expect(status.message).not.toContain('Contenção de processo indisponível')
    expect(containment.release).not.toHaveBeenCalled()

    await service.stop()
    expect(containment.release).toHaveBeenCalledTimes(1)
    expect(harness.kill).toHaveBeenCalledTimes(1)
  })

  it('serviço externo/adotado NUNCA é associado nem encerrado', async () => {
    const harness = createChildSpawner()
    const containment = fakeContainment()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: fetchScopedOk(),
      processRunner: createRunner(),
      childSpawner: harness.spawner,
      containment,
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status).toMatchObject({ state: 'running', owned: false })
    expect(harness.calls).toHaveLength(0)
    expect(containment.contain).not.toHaveBeenCalled()

    await service.stop()
    expect(harness.kill).not.toHaveBeenCalled()
  })

  it('falha da contenção é fail-open: serviço sobe e a limitação aparece no status', async () => {
    let spawned = false
    const harness = createChildSpawner()
    const containment = fakeContainment('Job Object indisponível: koffi ausente no asar')
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: fetchStatefulScoped(() => spawned),
      processRunner: createRunner(),
      childSpawner: (command, args, options) => {
        spawned = true
        return harness.spawner(command, args, options)
      },
      containment,
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status).toMatchObject({ state: 'running', owned: true, version: '2.4.0' })
    expect(status.message).toContain('Contenção de processo indisponível')
    expect(status.message).toContain('koffi ausente no asar')
    await service.stop()
    expect(containment.release).toHaveBeenCalledTimes(1)
  })

  it('child sem pid não impede o start e reporta limitação', async () => {
    let spawned = false
    const containment = fakeContainment('processo do sidecar sem pid válido; contenção Job Object indisponível.')
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: fetchStatefulScoped(() => spawned),
      processRunner: createRunner(),
      childSpawner: () => {
        spawned = true
        return { kill: vi.fn() }
      },
      containment,
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status).toMatchObject({ state: 'running', owned: true })
    expect(containment.contain).toHaveBeenCalledWith(Number.NaN, expect.objectContaining({ spawnedAtMs: expect.any(Number) }))
    expect(status.message).toContain('Contenção de processo indisponível')
  })

  it('exit do child libera o job EXATAMENTE uma vez (listener repetido é no-op)', async () => {
    let spawned = false
    const listeners: Array<(code: number | null) => void> = []
    const containment = fakeContainment()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: fetchStatefulScoped(() => spawned),
      processRunner: createRunner(),
      childSpawner: () => {
        spawned = true
        return { pid: 777, kill: vi.fn(), onExit: (listener) => listeners.push(listener) }
      },
      containment,
      sleep: async () => undefined,
    })

    await service.start()
    expect(containment.contain).toHaveBeenCalledTimes(1)
    expect(containment.release).not.toHaveBeenCalled()

    listeners[0](0)
    expect(containment.release).toHaveBeenCalledTimes(1)
    listeners[0](0)
    expect(containment.release).toHaveBeenCalledTimes(1)
  })

  it('callback de geração antiga NÃO libera o job do child novo', async () => {
    let serverUp = false
    let spawnIndex = 0
    const listeners: Array<(code: number | null) => void> = []
    const pids = [111, 222]
    const containment = fakeContainment()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: fetchStatefulScoped(() => serverUp),
      processRunner: createRunner(),
      childSpawner: () => {
        serverUp = true
        const pid = pids[spawnIndex++]
        return { pid, kill: vi.fn(), onExit: (listener) => listeners.push(listener) }
      },
      containment,
      sleep: async () => undefined,
    })

    await service.start()
    expect(containment.contain).toHaveBeenLastCalledWith(111, expect.objectContaining({ spawnedAtMs: expect.any(Number) }))
    await service.stop()
    expect(containment.release).toHaveBeenCalledTimes(1)

    serverUp = false
    await service.start()
    expect(containment.contain).toHaveBeenLastCalledWith(222, expect.objectContaining({ spawnedAtMs: expect.any(Number) }))

    const releasesAfterRestart = containment.release.mock.calls.length
    listeners[0](0)
    expect(containment.release.mock.calls.length).toBe(releasesAfterRestart)
  })

  function switchableFetch(
    state: { spawned: boolean; mode: 'ok' | 'fail' | 'alien' }
  ): typeof fetch {
    const scope = enabledScope()
    return (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
      if (!state.spawned) throw new Error('recusado')
      if (state.mode === 'fail') throw new Error('recusado')
      if (body.method === 'initialize') return initializeOk()
      return state.mode === 'alien'
        ? scopedStatus('alien-ws', 'alien-proj')
        : scopedStatus(scope.workspace, scope.project)
    }) as unknown as typeof fetch
  }

  it('reconfigure mantém a limitação da FFI no status (running)', async () => {
    const state = { spawned: false, mode: 'ok' as const }
    const containment = fakeContainment('Job Object indisponível: koffi ausente no asar')
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: switchableFetch(state),
      processRunner: createRunner(),
      childSpawner: (command, args, options) => {
        state.spawned = true
        return createChildSpawner().spawner(command, args, options)
      },
      containment,
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status).toMatchObject({ state: 'running', owned: true })
    const reconfigured = await service.reconfigure(enabledConfig())
    expect(reconfigured.state).toBe('running')
    expect(reconfigured.message).toContain('Contenção de processo indisponível')
    expect(reconfigured.message).toContain('koffi ausente no asar')
    await service.stop()
  })

  it('health degradado e recuperação preservam a limitação', async () => {
    const state: { spawned: boolean; mode: 'ok' | 'fail' | 'alien' } = { spawned: false, mode: 'ok' }
    const containment = fakeContainment('Job Object indisponível: loader falhou')
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: switchableFetch(state),
      processRunner: createRunner(),
      childSpawner: (command, args, options) => {
        state.spawned = true
        return createChildSpawner().spawner(command, args, options)
      },
      containment,
      sleep: async () => undefined,
    })

    await service.start()
    state.mode = 'fail'
    const degraded = await service.health()
    expect(degraded.ok).toBe(false)
    expect(degraded.message).toContain('Contenção de processo indisponível')
    expect(service.status().message).toContain('Contenção de processo indisponível')

    state.mode = 'ok'
    const recovered = await service.health()
    expect(recovered.ok).toBe(true)
    expect(service.status().state).toBe('running')
    expect(service.status().message).toContain('em execução')
    expect(service.status().message).toContain('Contenção de processo indisponível')
    await service.stop()
  })

  it('verifyEnabledScopes degradado mantém a limitação no status', async () => {
    const state: { spawned: boolean; mode: 'ok' | 'fail' | 'alien' } = { spawned: false, mode: 'alien' }
    const containment = fakeContainment('Job Object indisponível: koffi bloqueado')
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: switchableFetch(state),
      processRunner: createRunner(),
      childSpawner: (command, args, options) => {
        state.spawned = true
        return createChildSpawner().spawner(command, args, options)
      },
      containment,
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status.state).toBe('degraded')
    expect(status.message).toContain('Contenção de processo indisponível')
    expect(status.message).toContain('koffi bloqueado')
    await service.stop()
  })

  it('kill que lança rejeita o stop sem vazar o Job Object, com status coerente', async () => {
    let spawned = false
    const kill = vi.fn(() => {
      throw new Error('kill boom')
    })
    const containment = fakeContainment()
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: fetchStatefulScoped(() => spawned),
      processRunner: createRunner(),
      childSpawner: () => {
        spawned = true
        return { pid: 555, kill, onExit: () => undefined }
      },
      containment,
      sleep: async () => undefined,
    })

    await service.start()
    expect(containment.contain).toHaveBeenCalledTimes(1)
    expect(containment.release).not.toHaveBeenCalled()

    await expect(service.stop()).rejects.toThrow('kill boom')
    expect(kill).toHaveBeenCalledTimes(1)
    expect(containment.release).toHaveBeenCalledTimes(1)
    const status = service.status()
    expect(status).toMatchObject({ state: 'unavailable', owned: false })
    expect(status.message).toBe('Serviço ai-memory parado.')
  })

  it('exit inesperado do child preserva a limitação no status degradado', async () => {
    let spawned = false
    const listeners: Array<(code: number | null) => void> = []
    const containment = fakeContainment('Job Object indisponível: sem FFI')
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: enabledConfig(),
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: fetchStatefulScoped(() => spawned),
      processRunner: createRunner(),
      childSpawner: () => {
        spawned = true
        return { pid: 999, kill: vi.fn(), onExit: (listener) => listeners.push(listener) }
      },
      containment,
      sleep: async () => undefined,
    })

    await service.start()
    listeners[0](1)
    const status = service.status()
    expect(status.state).toBe('degraded')
    expect(status.message).toContain('encerrou inesperadamente')
    expect(status.message).toContain('Contenção de processo indisponível')
  })
})
