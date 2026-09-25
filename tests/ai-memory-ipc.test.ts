import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AI_MEMORY_IPC_CHANNELS,
  type AiMemoryIpcResult,
  type AiMemoryMigrationOutcomeView,
  type AiMemoryTakeoverPlanView,
} from '../src/shared/ai-memory-ipc-contract'
import { registerAiMemoryIpc, type AiMemoryIpcDependencies } from '../src/main/ipc/ai-memory-ipc'
import { migrationReceiptPath, type MigrationMemoryClient } from '../src/main/ai-memory-migration'
import { renderSquadStateBody, type SquadSnapshot } from '../src/main/ai-memory-sync'
import type { AiMemoryConfig, AiMemoryScope, AiMemoryStatus } from '../src/shared/ai-memory-contract'

type Handler = (...args: unknown[]) => unknown

function registrarFake(): {
  handlers: Map<string, Handler>
  register: (channel: never, handler: Handler) => void
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
} {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    register: ((channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    }) as never,
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`canal não registrado: ${channel}`)
      return await handler({}, ...args)
    },
  }
}

interface Harness {
  deps: AiMemoryIpcDependencies
  scope: AiMemoryScope
  statuses: AiMemoryStatus[]
  status: AiMemoryStatus
  client: MigrationMemoryClient & { calls: Array<{ name: string; args: Record<string, unknown> }> }
  configs: AiMemoryConfig[]
  scopeCalls: string[]
  writes: Array<{ path: string; body: string; tags?: string[] }>
  setEnabled: (value: boolean) => void
  failScope: boolean
  /** Registrador criado UMA vez: publishers cacheados sobrevivem entre invokes. */
  registrar?: (channel: string, handler: Handler) => void
}

function statusOf(state: AiMemoryStatus['state'], message?: string): AiMemoryStatus {
  return {
    state,
    owned: state === 'running',
    ...(state === 'running' ? { endpoint: 'http://127.0.0.1:9/mcp', binaryPath: '/bin/ai-memory' } : {}),
    capabilities: { mcp: state === 'running', cli: state === 'running' },
    ...(message !== undefined ? { message } : {}),
  }
}

function harnessOf(initial: { enabled?: boolean; state?: AiMemoryStatus['state'] } = {}): Harness {
  let enabled = initial.enabled ?? true
  let failScope = false
  const statuses: AiMemoryStatus[] = []
  let state: AiMemoryStatus['state'] = initial.state ?? 'running'
  const scope: AiMemoryScope = {
    identity: 'identity-p1',
    workspace: 'devorbit',
    project: 'p-1',
    root: '/repo',
  } as AiMemoryScope
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const writes: Array<{ path: string; body: string; tags?: string[] }> = []
  const scopeCalls: string[] = []
  const client = {
    calls,
    callTool: async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args })
      if (name === 'memory_write_page') {
        writes.push({ ...(args as { path: string; body: string }), tags: args.tags as string[] | undefined })
        return { text: 'ok', isError: false }
      }
      if (name === 'memory_read_page') {
        const path_ = args.path as string
        const page = writes.find((entry) => entry.path === path_)
        if (!page) return { text: '', isError: true }
        const envelope = { path: path_, body: page.body }
        return { text: JSON.stringify(envelope), json: envelope, isError: false }
      }
      if (name === 'memory_briefing') return { text: 'BRIEFING-OK', isError: false }
      if (name === 'memory_recent') return { text: 'RECENT-OK', isError: false }
      if (name === 'memory_handoff_list') return { text: 'HANDOFF-OK', isError: false }
      if (name === 'memory_query') return { text: 'QUERY-OK', isError: false }
      return { text: '', isError: false }
    },
  } as Harness['client']
  const configs: AiMemoryConfig[] = []
  const deps: AiMemoryIpcDependencies = {
    service: {
      status: () => {
        const current = statusOf(state)
        statuses.push(current)
        return current
      },
      client: () => (state === 'running' ? client : undefined),
      resolveScope: async (projectPath: string) => {
        scopeCalls.push(projectPath)
        if (failScope) throw new Error('git quebrou')
        return scope
      },
      isProjectEnabled: () => enabled,
      reconfigure: async (config) => {
        configs.push(config)
        enabled = config.enabled && Object.values(config.projects).some((project) => project.enabled)
        state = enabled ? 'running' : 'unavailable'
        return statusOf(state, 'reconfigurado')
      },
      ensureProjectMarker: async () => ({ status: 'created', configured: true, path: '/repo/.ai-memory.toml' }),
      health: async () => ({
        ok: state === 'running',
        ...(state === 'running' ? {} : { message: 'serviço indisponível' }),
      }),
    },
    userDataDir: '',
    loadAiMemoryConfig: async () => ({ enabled: enabled, projects: {} }),
    validator: async (input: unknown) => String(input),
    setProjectEnabled: async (entry, value) => {
      enabled = value
      return { enabled: true, projects: { [entry.identity]: { ...entry, enabled: value } } }
    },
  }
  return { deps, scope, statuses, client, configs, get status() { return statuses[0] }, writes, setEnabled: (value: boolean) => { enabled = value }, scopeCalls, get failScope() { return failScope }, set failScope(value: boolean) { failScope = value } }
}

async function invokeIpc<T>(
  h: Harness,
  channel: string,
  ...args: unknown[]
): Promise<AiMemoryIpcResult<T>> {
  // Registra UMA vez por harness: o estado interno do registrador (cache de
  // publishers/escopos) persiste entre invokes, como no main real.
  if (!h.registrar) {
    const register = ((channel: string, handler: Handler) => {
      handlersOf(h).set(channel, handler)
    }) as never
    registerAiMemoryIpc(register, h.deps)
    h.registrar = register as unknown as (channel: string, handler: Handler) => void
  }
  const handler = handlersOf(h).get(channel)
  if (!handler) throw new Error(`canal não registrado: ${channel}`)
  return (await handler({}, ...args)) as AiMemoryIpcResult<T>
}

const handlerMaps = new WeakMap<object, Map<string, Handler>>()

function handlersOf(h: Harness): Map<string, Handler> {
  let map = handlerMaps.get(h.deps)
  if (!map) {
    map = new Map<string, Handler>()
    handlerMaps.set(h.deps, map)
  }
  return map
}

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function userDataOf(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-memory-ipc-'))
  dirs.push(dir)
  return dir
}

describe('ai-memory-ipc — status/leitura', () => {
  it('status reflete o serviço injetado', async () => {
    const h = harnessOf()
    const result = await invokeIpc<AiMemoryStatus>(h, AI_MEMORY_IPC_CHANNELS.status)
    expect(result.ok).toBe(true)
    expect(result.data!.state).toBe('running')
  })

  it('briefing/recent/handoffs/query passam pelo escopo resolvido com opt-in', async () => {
    const h = harnessOf()
    const briefing = await invokeIpc<{ text: string }>(h, AI_MEMORY_IPC_CHANNELS.briefing, { projectPath: '/repo' })
    expect(briefing.ok).toBe(true)
    expect(briefing.data!.text).toBe('BRIEFING-OK')
    expect(h.client.calls[0].args).toMatchObject({ workspace: 'devorbit', project: 'p-1' })
    const recent = await invokeIpc<{ text: string }>(h, AI_MEMORY_IPC_CHANNELS.recent, { projectPath: '/repo', limit: 5 })
    expect(recent.ok).toBe(true)
    expect(h.client.calls.at(-1)!.args).toMatchObject({ limit: 5 })
    const handoffs = await invokeIpc<{ text: string }>(h, AI_MEMORY_IPC_CHANNELS.handoffs, { projectPath: '/repo' })
    expect(handoffs.data!.text).toBe('HANDOFF-OK')
    const query = await invokeIpc<{ text: string }>(h, AI_MEMORY_IPC_CHANNELS.query, { projectPath: '/repo', q: 'x' })
    expect(query.data!.text).toBe('QUERY-OK')
  })

  it('serviço fora do ar → resposta estruturada (nunca throw)', async () => {
    const h = harnessOf({ state: 'unavailable' })
    const result = await invokeIpc<{ text: string }>(h, AI_MEMORY_IPC_CHANNELS.briefing, { projectPath: '/repo' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unavailable')
  })

  it('projeto sem opt-in → reason disabled; erro de escopo → reason error', async () => {
    const h = harnessOf({ enabled: false })
    const result = await invokeIpc<{ text: string }>(h, AI_MEMORY_IPC_CHANNELS.briefing, { projectPath: '/repo' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('disabled')
    // Caminho NOVO (escopo de '/repo' já está cacheado no registrador).
    h.failScope = true
    const erro = await invokeIpc<{ text: string }>(h, AI_MEMORY_IPC_CHANNELS.briefing, { projectPath: '/outro' })
    expect(erro.ok).toBe(false)
    expect(erro.reason).toBe('error')
  })

  it('doctor owned: CLI recebe --data-dir <userDataDir>/ai-memory/data + doctor', async () => {
    const h = harnessOf()
    h.deps.userDataDir = '/fake/userData'
    let capturedArgs: readonly string[] = []
    h.deps.doctorRunner = async (args) => {
      capturedArgs = args
      return { code: 0, stdout: 'diagnostico ok', stderr: '' }
    }
    const result = await invokeIpc<{ ok: boolean; message?: string }>(h, AI_MEMORY_IPC_CHANNELS.doctor)
    expect(result.ok).toBe(true)
    expect(result.data!.ok).toBe(true)
    expect(capturedArgs).toEqual(['--data-dir', path.join('/fake/userData', 'ai-memory', 'data'), 'doctor'])
    expect(result.data!.message).toBe('diagnostico ok')
  })

  it('doctor owned: sem binaryPath → ok:false sem lançar', async () => {
    const h = harnessOf()
    h.deps.doctorRunner = undefined
    const status = { ...statusOf('running') } as AiMemoryStatus & { binaryPath?: string }
    delete status.binaryPath
    const originalStatus = h.deps.service.status
    h.deps.service.status = () => status
    const result = await invokeIpc<{ ok: boolean; message?: string }>(h, AI_MEMORY_IPC_CHANNELS.doctor)
    expect(result.ok).toBe(true)
    expect(result.data!.ok).toBe(false)
    expect(result.data!.message).toContain('Binário CLI')
    void originalStatus
  })

  it('doctor owned: CLI falha (code≠0) → ok:false com detalhes do stderr', async () => {
    const h = harnessOf()
    h.deps.userDataDir = '/ud'
    h.deps.doctorRunner = async () => ({ code: 1, stdout: '', stderr: 'porta ocupada' })
    const result = await invokeIpc<{ ok: boolean; message?: string }>(h, AI_MEMORY_IPC_CHANNELS.doctor)
    expect(result.data!.ok).toBe(false)
    expect(result.data!.message).toContain('porta ocupada')
  })

  it('doctor não-owned com health(): resultado do health() refletido sem binaryPath local nem runner', async () => {
    const h = harnessOf({ state: 'running' })
    let runnerCalled = false
    h.deps.doctorRunner = async () => {
      runnerCalled = true
      return { code: 0, stdout: '', stderr: '' }
    }
    // Força não-owned, sem binaryPath local
    h.deps.service.status = () => ({ state: 'running', owned: false, endpoint: 'http://ext:9/mcp' } as AiMemoryStatus)
    h.deps.service.health = async () => ({ ok: true })
    const result = await invokeIpc<{ ok: boolean; message?: string }>(h, AI_MEMORY_IPC_CHANNELS.doctor)
    expect(result.ok).toBe(true)
    expect(result.data!.ok).toBe(true)
    expect(result.data!.message).toContain('externo saudável')
    expect(result.data!.message).toContain('http://ext:9/mcp')
    expect(runnerCalled).toBe(false)
  })

  it('doctor não-owned com health() ok=false → ok:false com mensagem', async () => {
    const h = harnessOf({ state: 'running' })
    h.deps.service.status = () => ({ state: 'running', owned: false } as AiMemoryStatus)
    h.deps.service.health = async () => ({ ok: false, message: 'timeout' })
    const result = await invokeIpc<{ ok: boolean; message?: string }>(h, AI_MEMORY_IPC_CHANNELS.doctor)
    expect(result.data!.ok).toBe(false)
    expect(result.data!.message).toContain('timeout')
  })

  it('doctor não-owned sem health(): fallback usa status state', async () => {
    const h = harnessOf({ state: 'running' })
    h.deps.service.status = () => ({ state: 'running', owned: false, endpoint: 'http://x:9/mcp' } as AiMemoryStatus)
    // health NÃO definido no service
    delete (h.deps.service as unknown as Record<string, unknown>).health
    const result = await invokeIpc<{ ok: boolean; message?: string }>(h, AI_MEMORY_IPC_CHANNELS.doctor)
    expect(result.data!.ok).toBe(true)
    expect(result.data!.message).toContain('externo em execução')
  })

  it('doctor não-owned com health() throw → erro estruturado (não throw)', async () => {
    const h = harnessOf({ state: 'running' })
    h.deps.service.status = () => ({ state: 'running', owned: false } as AiMemoryStatus)
    h.deps.service.health = async () => { throw new Error('conexão recusada') }
    const result = await invokeIpc<{ ok: boolean; message?: string }>(h, AI_MEMORY_IPC_CHANNELS.doctor)
    expect(result.ok).toBe(true)
    expect(result.data!.ok).toBe(false)
    expect(result.data!.message).toContain('conexão recusada')
  })
})

describe('ai-memory-ipc — enable → migração (opt-in explícito)', () => {
  it('enable=true persiste opt-in derivado do escopo, garante marker e migra idempotentemente', async () => {
    const h = harnessOf({ enabled: false })
    h.deps.userDataDir = await userDataOf()
    h.deps.readLegacyFiles = async () => ({ markdown: '# legado\n- dado' })
    const first = await invokeIpc<{ config: AiMemoryConfig; marker?: { status: string }; migration?: AiMemoryMigrationOutcomeView }>(h, AI_MEMORY_IPC_CHANNELS.enableProject, {
      projectPath: '/repo',
      enabled: true,
    })
    expect(first.ok).toBe(true)
    // Entry derivado do escopo resolvido (renderer não fornece identity/workspace/project).
    expect(first.data!.config.projects['identity-p1']).toMatchObject({
      identity: 'identity-p1',
      workspace: 'devorbit',
      project: 'p-1',
      path: '/repo',
    })
    expect(first.data!.marker!.status).toBe('created')
    expect(first.data!.migration!.status).toBe('migrated')
    expect(first.data!.migration!.paths[0]).toMatch(/^procedures\//)
    // Receipt gravada → segunda chamada idempotente (already-migrated).
    const second = await invokeIpc<AiMemoryMigrationOutcomeView>(h, AI_MEMORY_IPC_CHANNELS.migrateLegacy, { projectPath: '/repo' })
    expect(second.data!.status).toBe('already-migrated')
  })

  it('marker em conflito com terceiros: migration NÃO roda, isProjectEnabled=false e config desabilitado', async () => {
    const h = harnessOf()
    h.deps.userDataDir = await userDataOf()
    h.deps.readLegacyFiles = async () => ({ markdown: '# legado' })
    h.deps.service.ensureProjectMarker = async () => ({
      status: 'conflict',
      configured: false,
      path: '/repo/.ai-memory.toml',
      conflicts: ['workspace'],
    })
    const result = await invokeIpc<{ config: AiMemoryConfig; isProjectEnabled: boolean; marker?: { status: string; conflicts?: string[] }; migration?: AiMemoryMigrationOutcomeView }>(h, AI_MEMORY_IPC_CHANNELS.enableProject, {
      projectPath: '/repo',
      enabled: true,
    })
    expect(result.ok).toBe(true)
    expect(result.data!.isProjectEnabled).toBe(false)
    expect(result.data!.config.projects['identity-p1']?.enabled).toBe(false)
    expect(result.data!.marker!.status).toBe('conflict')
    expect(result.data!.marker!.conflicts).toEqual(['workspace'])
    expect(result.data!.migration).toBeUndefined()
    expect(h.client.calls.some((call) => call.name === 'memory_write_page')).toBe(false)
  })

  it('marker preserved incompleto: rollback isProjectEnabled=false e config desabilitado', async () => {
    const h = harnessOf()
    h.deps.userDataDir = await userDataOf()
    h.deps.readLegacyFiles = async () => ({ markdown: '# legado' })
    h.deps.service.ensureProjectMarker = async () => ({
      status: 'preserved',
      configured: false,
      path: '/repo/.ai-memory.toml',
      missingFields: ['ignore_paths'],
    })
    const result = await invokeIpc<{ config: AiMemoryConfig; isProjectEnabled: boolean; marker?: { status: string } }>(h, AI_MEMORY_IPC_CHANNELS.enableProject, {
      projectPath: '/repo',
      enabled: true,
    })
    expect(result.ok).toBe(true)
    expect(result.data!.isProjectEnabled).toBe(false)
    expect(result.data!.config.projects['identity-p1']?.enabled).toBe(false)
    expect(result.data!.marker!.status).toBe('preserved')
    expect(h.client.calls.some((call) => call.name === 'memory_write_page')).toBe(false)
  })

  it('projectPath inválido → invalid-path em todos os canais com caminho (validator injetável)', async () => {
    const h = harnessOf()
    h.deps.validator = async () => {
      throw new Error('fora das pastas monitoradas')
    }
    const briefing = await invokeIpc<never>(h, AI_MEMORY_IPC_CHANNELS.briefing, { projectPath: '/etc' })
    expect(briefing.ok).toBe(false)
    expect(briefing.reason).toBe('invalid-path')
    const migrate = await invokeIpc<never>(h, AI_MEMORY_IPC_CHANNELS.migrateLegacy, { projectPath: '/etc' })
    expect(migrate.reason).toBe('invalid-path')
    const status = await invokeIpc<never>(h, AI_MEMORY_IPC_CHANNELS.migrationStatus, { projectPath: '/etc' })
    expect(status.reason).toBe('invalid-path')
    // resolveScope NUNCA é chamado com caminho não validado.
    expect(h.client.calls).toHaveLength(0)
  })

  it('validator canonicaliza o caminho e o escopo é resolvido com o caminho canônico', async () => {
    const h = harnessOf()
    const resolvedPaths: string[] = []
    h.deps.validator = async (input) => `/canonical/${String(input)}`
    const originalResolve = h.deps.service.resolveScope
    h.deps.service.resolveScope = async (projectPath: string) => {
      resolvedPaths.push(projectPath)
      return await originalResolve(projectPath)
    }
    const result = await invokeIpc<{ text: string }>(h, AI_MEMORY_IPC_CHANNELS.briefing, { projectPath: '/repo' })
    expect(result.ok).toBe(true)
    expect(resolvedPaths).toEqual(['/canonical//repo'])
  })

  it('enable=false NÃO migra e devolve config/status (sem erro)', async () => {
    const h = harnessOf()
    const result = await invokeIpc<{ migration?: AiMemoryMigrationOutcomeView }>(h, AI_MEMORY_IPC_CHANNELS.enableProject, {
      projectPath: '/repo',
      enabled: false,
    })
    expect(result.ok).toBe(true)
    expect(result.data!.migration).toBeUndefined()
    expect(h.client.calls.some((call) => call.name === 'memory_write_page')).toBe(false)
  })

  it('getProjectStatus: identidade derivada no main (resolveScope), opt-in + status + receipt', async () => {
    const h = harnessOf()
    const result = await invokeIpc<{
      isProjectEnabled: boolean
      status: { state: string }
      migration: { receipt: string }
    }>(h, AI_MEMORY_IPC_CHANNELS.getProjectStatus, { projectPath: '/repo' })
    expect(result.ok).toBe(true)
    expect(result.data!.isProjectEnabled).toBe(true)
    expect(result.data!.status.state).toBe('running')
    expect(result.data!.migration.receipt).toBe('absent')
    // Escopo SEMPRE derivado no main a partir do caminho CANÔNICO.
    expect(h.scopeCalls).toEqual(['/repo'])
  })

  it('getProjectStatus: receipt presente após migração (paths expostos)', async () => {
    const h = harnessOf()
    h.deps.userDataDir = await userDataOf()
    h.deps.readLegacyFiles = async () => ({ markdown: '# legado' })
    await invokeIpc<unknown>(h, AI_MEMORY_IPC_CHANNELS.migrateLegacy, { projectPath: '/repo' })
    const result = await invokeIpc<{
      isProjectEnabled: boolean
      migration: { receipt: string; paths?: string[]; concludedAt?: string }
    }>(h, AI_MEMORY_IPC_CHANNELS.getProjectStatus, { projectPath: '/repo' })
    expect(result.ok).toBe(true)
    expect(result.data!.isProjectEnabled).toBe(true)
    expect(result.data!.migration.receipt).toBe('present')
    expect(result.data!.migration.paths!.length).toBeGreaterThan(0)
    expect(result.data!.migration.concludedAt).toBeTruthy()
  })

  it('getProjectStatus: caminho inválido → invalid-path; escopo quebrado → error (sem throw)', async () => {
    const h = harnessOf()
    h.deps.validator = async () => {
      throw new Error('fora da raiz monitorada')
    }
    const invalid = await invokeIpc<unknown>(h, AI_MEMORY_IPC_CHANNELS.getProjectStatus, { projectPath: '/etc' })
    expect(invalid.ok).toBe(false)
    expect(invalid.reason).toBe('invalid-path')
    const h2 = harnessOf()
    h2.failScope = true
    const erro = await invokeIpc<unknown>(h2, AI_MEMORY_IPC_CHANNELS.getProjectStatus, { projectPath: '/repo' })
    expect(erro.ok).toBe(false)
    expect(erro.reason).toBe('error')
  })

  it('sem opt-in → migrateLegacy devolve disabled (não impeditivo, sem escrita)', async () => {
    const h = harnessOf({ enabled: false })
    const result = await invokeIpc<AiMemoryMigrationOutcomeView>(h, AI_MEMORY_IPC_CHANNELS.migrateLegacy, { projectPath: '/repo' })
    expect(result.ok).toBe(true)
    expect(result.data!.status).toBe('disabled')
    expect(h.client.calls.some((call) => call.name === 'memory_write_page')).toBe(false)
  })

  it('serviço indisponível → status unavailable, legado preservado (não impeditivo)', async () => {
    const h = harnessOf({ state: 'unavailable' })
    const result = await invokeIpc<AiMemoryMigrationOutcomeView>(h, AI_MEMORY_IPC_CHANNELS.migrateLegacy, { projectPath: '/repo' })
    expect(result.ok).toBe(true)
    expect(result.data!.status).toBe('unavailable')
  })

  it('migrationStatus lê a receipt local após migração (absent antes)', async () => {
    const h = harnessOf()
    h.deps.userDataDir = await userDataOf()
    h.deps.identityFor = async () => 'identity-p1'
    h.deps.readLegacyFiles = async () => ({ markdown: '# legado' })
    const before = await invokeIpc<{ receipt: string }>(h, AI_MEMORY_IPC_CHANNELS.migrationStatus, { projectPath: '/repo' })
    expect(before.data!.receipt).toBe('absent')
    await invokeIpc<AiMemoryMigrationOutcomeView>(h, AI_MEMORY_IPC_CHANNELS.migrateLegacy, { projectPath: '/repo' })
    const after = await invokeIpc<{ receipt: string; paths?: string[] }>(h, AI_MEMORY_IPC_CHANNELS.migrationStatus, { projectPath: '/repo' })
    expect(after.data!.receipt).toBe('present')
    expect(after.data!.paths!.length).toBeGreaterThan(0)
  })
})

describe('ai-memory-ipc — takeover e squad state', () => {
  it('takeover invocável pelo canal: pendências + evidência estruturadas', async () => {
    const h = harnessOf()
    const body = renderSquadStateBody({
      id: 'sq-1',
      objective: 'entregar',
      members: [],
      tasks: [{ id: 't1', title: 'Migrar memória', status: 'pending' }],
    })
    const original = h.client.callTool
    h.client.callTool = async (name, args) => {
      if (name === 'memory_read_page' && args.path === 'squads/sq-1/state.md') {
        const envelope = { path: args.path, body }
        return { text: JSON.stringify(envelope), json: envelope, isError: false }
      }
      return await original(name, args)
    }
    const result = await invokeIpc<AiMemoryTakeoverPlanView | null>(h, AI_MEMORY_IPC_CHANNELS.takeover, {
      projectPath: '/repo',
      squadId: 'sq-1',
      survivingAgent: 'codex-2',
    })
    expect(result.ok).toBe(true)
    expect(result.data!.instruction).toContain('codex-2')
    expect(result.data!.pendingTasks.map((task) => task.title)).toEqual(['Migrar memória'])
  })

  it('takeover com serviço fora do ar → plano mínimo verification-first (não impeditivo)', async () => {
    const h = harnessOf({ state: 'unavailable' })
    const result = await invokeIpc<AiMemoryTakeoverPlanView | null>(h, AI_MEMORY_IPC_CHANNELS.takeover, {
      projectPath: '/repo',
      squadId: 'sq-1',
      survivingAgent: 'a1',
    })
    expect(result.ok).toBe(true)
    expect(result.data!.instruction).toContain('indisponível')
    expect(result.data!.pendingTasks).toEqual([])
  })

  it('takeover: Git inspector recebe EXATAMENTE o caminho canônico validado (nunca o cru)', async () => {
    const h = harnessOf()
    h.deps.validator = async (input) => `/canonico${String(input)}`
    const inspected: string[] = []
    h.deps.gitInspector = async (projectPath) => {
      inspected.push(projectPath)
      return { branch: 'main', head: 'abcd1234ef', dirtyFiles: ['src/a.ts'] }
    }
    const body = renderSquadStateBody({ id: 'sq-1', objective: 'entregar', members: [], tasks: [] })
    const original = h.client.callTool
    h.client.callTool = async (name, args) => {
      if (name === 'memory_read_page' && args.path === 'squads/sq-1/state.md') {
        const envelope = { path: args.path, body }
        return { text: JSON.stringify(envelope), json: envelope, isError: false }
      }
      return await original(name, args)
    }
    const result = await invokeIpc<AiMemoryTakeoverPlanView | null>(h, AI_MEMORY_IPC_CHANNELS.takeover, {
      projectPath: '/repo',
      squadId: 'sq-1',
      survivingAgent: 'opencode',
    })
    expect(result.ok).toBe(true)
    // O inspector (default de produção é o read-only do módulo takeover) viu
    // o caminho CANÔNICO — nunca o path cru do renderer.
    expect(inspected).toEqual(['/canonico/repo'])
    expect(result.data!.evidence).toEqual({ branch: 'main', head: 'abcd1234ef', dirtyFiles: ['src/a.ts'] })
    expect(result.data!.instruction).toContain('EVIDÊNCIA do checkout')
  })

  it('publishSquadState publica snapshot consolidado em squads/<id>/state', async () => {
    const h = harnessOf()
    const snapshot: SquadSnapshot = {
      id: 'sq-9',
      objective: 'Fechar fase 3',
      members: [{ id: 'm1', title: 'Codex', status: 'in-progress' }],
      tasks: [{ id: 't1', title: 'Item', status: 'pending', memberId: 'm1' }],
    }
    const result = await invokeIpc<{ path: string; published: boolean }>(h, AI_MEMORY_IPC_CHANNELS.publishSquadState, {
      projectPath: '/repo',
      snapshot,
    })
    expect(result.ok).toBe(true)
    expect(result.data!.published).toBe(true)
    expect(result.data!.path).toBe('squads/sq-9/state.md')
    expect(h.writes[0].body).toContain('Fechar fase 3')
  })

  it('publishes concorrentes para o mesmo squad são serializados (estado final = último)', async () => {
    const h = harnessOf()
    // Primeira escrita bloqueia num gate: a segunda invoke só pode escrever
    // DEPOIS dela (fila do publisher cacheado), senão perde alteração.
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let firstWriteStarted = false
    const original = h.client.callTool
    h.client.callTool = async (name, args) => {
      if (name === 'memory_write_page' && !firstWriteStarted) {
        firstWriteStarted = true
        await gate
      }
      return await original(name, args)
    }
    const first = invokeIpc<{ path: string; published: boolean }>(h, AI_MEMORY_IPC_CHANNELS.publishSquadState, {
      projectPath: '/repo',
      snapshot: { id: 'sq-c', objective: 'PRIMEIRO', members: [] },
    })
    const second = invokeIpc<{ path: string; published: boolean }>(h, AI_MEMORY_IPC_CHANNELS.publishSquadState, {
      projectPath: '/repo',
      snapshot: { id: 'sq-c', objective: 'SEGUNDO', members: [] },
    })
    // A primeira está no gate: NADA foi escrito ainda (sem corrida).
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.writes).toHaveLength(0)
    release()
    const [r1, r2] = await Promise.all([first, second])
    expect(r1.data!.published).toBe(true)
    expect(r2.data!.published).toBe(true)
    expect(h.writes).toHaveLength(2)
    // Ordem preservada: primeiro entra primeiro; estado FINAL = último snapshot.
    expect(h.writes[0].body).toContain('PRIMEIRO')
    expect(h.writes[1].body).toContain('SEGUNDO')
    expect(h.writes[1].body).not.toContain('PRIMEIRO')
  })
})