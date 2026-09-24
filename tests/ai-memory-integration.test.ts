import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createAiMemoryService,
  type AiMemoryChildHandle,
  type AiMemoryChildSpawner,
  type AiMemoryProcessRunner,
} from '../src/main/ai-memory-service'
import { AiMemoryError, AiMemoryClient } from '../src/main/ai-memory-client'
import { resolveAiMemoryScope, type AiMemoryFileSystem } from '../src/main/ai-memory-scope'
import type { AiMemoryConfig } from '../src/shared/ai-memory-contract'

const REMOTE = 'https://github.com/acme/repo.git'
const REPO_ROOT = path.join(os.tmpdir(), 'devorbit-aimem-it-repo')
const SUBDIR = path.join(REPO_ROOT, 'packages', 'app')
const USER_DATA = path.join(os.tmpdir(), 'devorbit-aimem-it-userdata')

// --- Filesystem em memória (nenhum arquivo real do usuário é tocado) --------

function createMemoryFs(seed: Record<string, string> = {}): {
  fs: AiMemoryFileSystem
  files: Map<string, Buffer>
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
  return { fs, files }
}

// --- Servidor MCP/HTTP fake, stateless, em memória --------------------------

interface RecordedCall {
  method: string
  name?: string
  arguments?: Record<string, unknown>
}

interface FakeMcpServer {
  fetchImpl: typeof fetch
  calls: RecordedCall[]
  registerProject: (workspace: string, project: string) => void
  writePage: (pagePath: string, body: string) => void
  setDown: (down: boolean) => void
}

function createFakeMcpServer(): FakeMcpServer {
  const calls: RecordedCall[] = []
  const projects = new Set<string>()
  const pages = new Map<string, string>()
  let down = false
  const projectKey = (workspace: string, project: string): string => `${workspace}/${project}`

  const json = (payload: unknown): Response =>
    ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(payload),
    }) as unknown as Response

  const toolResult = (payload: unknown): Response =>
    json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } })

  const rpcError = (code: number, message: string): Response =>
    json({ jsonrpc: '2.0', id: 1, error: { code, message } })

  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    if (down) throw new Error('ECONNREFUSED: endpoint ai-memory fora do ar')
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      method?: string
      params?: { name?: string; arguments?: Record<string, unknown> }
    }
    const method = body.method ?? ''
    if (method === 'initialize') {
      return json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'ai-memory', version: '2.4.0' },
        },
      })
    }
    if (method === 'tools/list') return json({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
    if (method !== 'tools/call') return rpcError(-32601, 'method not found')

    const name = body.params?.name ?? ''
    const args = body.params?.arguments ?? {}
    calls.push({ method, name, arguments: args })
    const workspace = typeof args.workspace === 'string' ? args.workspace : ''
    const project = typeof args.project === 'string' ? args.project : ''

    if (name === 'memory_status') {
      if (!workspace || !project || !projects.has(projectKey(workspace, project))) {
        return rpcError(-32602, 'invalid params: unknown project')
      }
      return toolResult({
        counts: { pages: pages.size },
        scope: { workspace, project, resolved_by: 'explicit' },
      })
    }
    if (name === 'memory_query') {
      const query = String(args.query ?? '')
      const hits = [...pages.entries()]
        .filter(([, value]) => value.includes(query))
        .map(([pagePath, body]) => ({ path: pagePath, snippet: body }))
      return toolResult({ hits, scope: { workspace, project } })
    }
    if (name === 'memory_recent') {
      const limit = typeof args.limit === 'number' ? args.limit : 10
      return toolResult({ pages: [...pages.keys()].slice(0, limit) })
    }
    if (name === 'memory_read_page') {
      const pagePath = String(args.path ?? '')
      return toolResult({ path: pagePath, body: pages.get(pagePath) ?? '' })
    }
    if (name === 'memory_write_page') {
      const pagePath = String(args.path ?? '')
      pages.set(pagePath, String(args.body ?? ''))
      return toolResult({ path: pagePath, written: true })
    }
    if (name === 'memory_briefing') {
      return toolResult({ recent: [...pages.keys()], recent_pages_limit: args.recent_pages_limit ?? 10 })
    }
    if (name === 'memory_handoff_list') {
      return toolResult({ handoffs: [], limit: args.limit ?? 50 })
    }
    return rpcError(-32601, 'method not found')
  }) as unknown as typeof fetch

  return {
    fetchImpl,
    calls,
    registerProject: (workspace, project) => {
      projects.add(projectKey(workspace, project))
    },
    writePage: (pagePath, pageBody) => {
      pages.set(pagePath, pageBody)
    },
    setDown: (value) => {
      down = value
    },
  }
}

// --- Processos fake (nunca spawna binário real) -----------------------------

function createGitRunner(): AiMemoryProcessRunner {
  return async (command, args) => {
    if (command === 'git' && args[0] === 'remote') return { code: 0, stdout: `${REMOTE}\n`, stderr: '' }
    if (command === 'git' && args[0] === 'rev-parse') {
      if (args[1] === '--show-toplevel') return { code: 0, stdout: `${REPO_ROOT}\n`, stderr: '' }
      return { code: 0, stdout: `${path.join(REPO_ROOT, '.git')}\n`, stderr: '' }
    }
    if (command === 'where' || command === 'which') return { code: 1, stdout: '', stderr: '' }
    return { code: 0, stdout: 'ai-memory 2.4.0\n', stderr: '' }
  }
}

interface ChildHarness {
  spawner: AiMemoryChildSpawner
  kill: ReturnType<typeof vi.fn>
  calls: number
}

function createChildSpawner(): ChildHarness {
  const kill = vi.fn()
  const harness: ChildHarness = { kill, calls: 0, spawner: () => ({}) as AiMemoryChildHandle }
  harness.spawner = (): AiMemoryChildHandle => {
    harness.calls += 1
    return { pid: 999, kill, onExit: () => undefined }
  }
  return harness
}

// --- Config e scope determinísticos ----------------------------------------

const BASE_SCOPE = resolveAiMemoryScope({
  projectPath: SUBDIR,
  remoteUrl: REMOTE,
  gitCommonDir: path.join(REPO_ROOT, '.git'),
  gitTopLevel: REPO_ROOT,
})

const CONFIG: AiMemoryConfig = {
  enabled: true,
  projects: {
    [BASE_SCOPE.identity]: {
      identity: BASE_SCOPE.identity,
      workspace: BASE_SCOPE.workspace,
      project: BASE_SCOPE.project,
      path: SUBDIR,
      enabled: true,
    },
  },
}

function seededBinary(): Record<string, string> {
  return { [path.join(USER_DATA, 'runtime', 'ai-memory.exe')]: '' }
}

describe('ai-memory integração service + client (servidor MCP fake em memória)', () => {
  it('lifecycle start→health→scope/marker→query/read com requests e scopes reais', async () => {
    const server = createFakeMcpServer()
    server.registerProject(BASE_SCOPE.workspace, BASE_SCOPE.project)
    server.writePage('notes/a.md', 'alpha conteúdo durável')
    const memory = createMemoryFs(seededBinary())
    const child = createChildSpawner()

    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: CONFIG,
      fileSystem: memory.fs,
      fetchImpl: server.fetchImpl,
      processRunner: createGitRunner(),
      childSpawner: child.spawner,
      sleep: async () => undefined,
    })

    // start: serviço externo compatível detectado; nenhum processo próprio.
    const status = await service.start()
    expect(status).toMatchObject({ state: 'running', owned: false, version: '2.4.0' })
    expect(child.calls).toBe(0)

    // health: initialize confirma ai-memory 2.4.0.
    expect(await service.health()).toMatchObject({ ok: true })

    // scope: subdiretório resolve para a raiz do worktree.
    const scope = await service.resolveScope(SUBDIR)
    expect(scope).toMatchObject({
      workspace: BASE_SCOPE.workspace,
      project: BASE_SCOPE.project,
      root: REPO_ROOT,
    })

    // marker: criado no root do worktree e idempotente.
    const created = await service.ensureProjectMarker(SUBDIR)
    expect(created).toMatchObject({ status: 'created', configured: true })
    expect(memory.files.has(path.join(REPO_ROOT, '.ai-memory.toml').toLowerCase())).toBe(true)
    const again = await service.ensureProjectMarker(SUBDIR)
    expect(again.status).toBe('unchanged')

    // client: query escopada, read e query global (sem scope).
    const client = service.client()
    if (!client) throw new Error('cliente MCP indisponível')
    const scoped = await client.query({
      workspace: scope.workspace,
      project: scope.project,
      query: 'alpha',
      limit: 5,
    })
    expect(scoped.isError).toBe(false)
    await client.readPage({ workspace: scope.workspace, project: scope.project, path: 'notes/a.md' })
    await client.query({ query: 'alpha', global: true })

    const scopedQuery = server.calls.find(
      (call) => call.name === 'memory_query' && call.arguments?.global !== true
    )
    expect(scopedQuery?.arguments).toEqual({
      query: 'alpha',
      workspace: scope.workspace,
      project: scope.project,
      limit: 5,
    })
    const globalQuery = server.calls.find(
      (call) => call.name === 'memory_query' && call.arguments?.global === true
    )
    expect(globalQuery?.arguments).toEqual({ query: 'alpha', global: true })
    expect(globalQuery?.arguments).not.toHaveProperty('workspace')
    expect(globalQuery?.arguments).not.toHaveProperty('project')

    const read = server.calls.find((call) => call.name === 'memory_read_page')
    expect(read?.arguments).toEqual({
      workspace: scope.workspace,
      project: scope.project,
      path: 'notes/a.md',
    })

    // status consultado pelo serviço com o scope do projeto habilitado.
    const statusCall = server.calls.find((call) => call.name === 'memory_status')
    expect(statusCall?.arguments).toEqual({
      workspace: BASE_SCOPE.workspace,
      project: BASE_SCOPE.project,
    })
  })

  it('endpoint fora do ar no boot vira degraded e encerra o filho próprio', async () => {
    const server = createFakeMcpServer()
    server.setDown(true)
    const child = createChildSpawner()

    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: CONFIG,
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: server.fetchImpl,
      processRunner: createGitRunner(),
      childSpawner: child.spawner,
      healthTimeoutMs: 15,
      healthIntervalMs: 1,
      sleep: async () => undefined,
    })

    const status = await service.start()
    expect(status).toMatchObject({ state: 'degraded', owned: false })
    expect(status.message).toContain('não respondeu no prazo')
    // O filho próprio foi encerrado (sem processo órfão).
    expect(child.calls).toBe(1)
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('queda do endpoint em sessão: erro tipado, health falso e stop limpo (terminal não bloqueado)', async () => {
    const server = createFakeMcpServer()
    server.registerProject(BASE_SCOPE.workspace, BASE_SCOPE.project)
    const service = createAiMemoryService({
      userDataDir: USER_DATA,
      config: CONFIG,
      fileSystem: createMemoryFs(seededBinary()).fs,
      fetchImpl: server.fetchImpl,
      processRunner: createGitRunner(),
      childSpawner: createChildSpawner().spawner,
      sleep: async () => undefined,
    })
    await service.start()
    const client = service.client() as AiMemoryClient

    expect((await client.query({ workspace: BASE_SCOPE.workspace, project: BASE_SCOPE.project, query: 'x' })).isError).toBe(false)

    // Endpoint cai: a falha de memória é tipada e não derruba o processo.
    server.setDown(true)
    let code: string | undefined
    try {
      await client.query({ workspace: BASE_SCOPE.workspace, project: BASE_SCOPE.project, query: 'y' })
    } catch (error) {
      code = error instanceof AiMemoryError ? error.code : undefined
    }
    expect(code).toBe('ai-memory/transport')
    expect((await service.health()).ok).toBe(false)

    // Shutdown continua funcionando (memória degradada não impede o teardown).
    await service.stop()
    expect(service.status().state).toBe('unavailable')
  })
})
