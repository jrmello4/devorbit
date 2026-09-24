import { describe, expect, it, vi } from 'vitest'
import {
  AiMemoryCli,
  AiMemoryClient,
  createAiMemoryCliRunner,
  mcpRequest,
  parseAiMemoryVersion,
  type AiMemorySpawnImpl,
  type AiMemorySpawnResult,
} from '../src/main/ai-memory-client'

interface CapturedCall {
  url: string
  body: string
}

function responseOf(payload: unknown, contentType = 'application/json'): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => contentType },
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  } as unknown as Response
}

function toolResult(text: string, isError = false): Response {
  return responseOf({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text }], isError },
  })
}

function initializeResponse(name = 'ai-memory', version = '2.4.0'): Response {
  return responseOf({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name, version } } })
}

function createFetch(responder: (call: CapturedCall) => Response | Promise<Response>): {
  fetchImpl: typeof fetch
  calls: CapturedCall[]
} {
  const calls: CapturedCall[] = []
  const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
    const call: CapturedCall = { url: String(url), body: String(init?.body ?? '') }
    calls.push(call)
    return responder(call)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function parseBody(call: CapturedCall): { method: string; params?: { name?: string; arguments?: unknown } } {
  return JSON.parse(call.body) as { method: string; params?: { name?: string; arguments?: unknown } }
}

describe('AiMemoryClient — MCP Streamable HTTP', () => {
  it('chama status/query/recent/briefing/read/write/handoffs com o schema real', async () => {
    const { fetchImpl, calls } = createFetch(() => toolResult('{"ok":true}'))
    const client = new AiMemoryClient({ endpoint: 'http://127.0.0.1:49374/mcp', fetchImpl })

    await client.status({ workspace: 'devorbit', project: 'p-1' })
    await client.query({ workspace: 'devorbit', project: 'p-1', query: 'auth', limit: 5 })
    await client.query({ query: 'global term', global: true, limit: 2 })
    await client.recent({ workspace: 'devorbit', project: 'p-1', limit: 3 })
    await client.briefing({ workspace: 'devorbit', project: 'p-1', recentPagesLimit: 50 })
    await client.readPage({ workspace: 'devorbit', project: 'p-1', path: 'decisions/a.md' })
    await client.writePage({
      workspace: 'devorbit',
      project: 'p-1',
      path: 'decisions/a.md',
      body: '# Título\ncorpo',
    })
    await client.handoffs({ workspace: 'devorbit', project: 'p-1', limit: 25 })
    await client.handoffBegin({
      workspace: 'devorbit',
      project: 'p-1',
      summary: 'onde paramos',
      openQuestions: ['q1'],
      nextSteps: ['n1'],
      filesTouched: ['a.ts'],
      shared: true,
    })
    await client.handoffAccept({
      workspace: 'devorbit',
      project: 'p-1',
      handoffId: 'h-1',
      anyOwner: true,
    })

    expect(calls.map((call) => parseBody(call).params?.name)).toEqual([
      'memory_status',
      'memory_query',
      'memory_query',
      'memory_recent',
      'memory_briefing',
      'memory_read_page',
      'memory_write_page',
      'memory_handoff_list',
      'memory_handoff_begin',
      'memory_handoff_accept',
    ])
    // memory_status: só o par workspace+project.
    expect(parseBody(calls[0]).params?.arguments).toEqual({ workspace: 'devorbit', project: 'p-1' })
    // query com escopo: workspace+project+query+limit.
    expect(parseBody(calls[1]).params?.arguments).toEqual({
      query: 'auth',
      workspace: 'devorbit',
      project: 'p-1',
      limit: 5,
    })
    // query global: SEM workspace/project (proibido pela API v2.4.0).
    expect(parseBody(calls[2]).params?.arguments).toEqual({
      query: 'global term',
      limit: 2,
      global: true,
    })
    expect(parseBody(calls[3]).params?.arguments).toEqual({
      workspace: 'devorbit',
      project: 'p-1',
      limit: 3,
    })
    // briefing: recent_pages_limit (não max_chars).
    expect(parseBody(calls[4]).params?.arguments).toEqual({
      workspace: 'devorbit',
      project: 'p-1',
      recent_pages_limit: 50,
    })
    expect(parseBody(calls[5]).params?.arguments).toEqual({
      workspace: 'devorbit',
      project: 'p-1',
      path: 'decisions/a.md',
    })
    // write_page: body (não content).
    expect(parseBody(calls[6]).params?.arguments).toEqual({
      workspace: 'devorbit',
      project: 'p-1',
      path: 'decisions/a.md',
      body: '# Título\ncorpo',
    })
    expect(parseBody(calls[7]).params?.arguments).toEqual({
      workspace: 'devorbit',
      project: 'p-1',
      limit: 25,
    })
    // handoff_begin: summary + arrays + shared (schema real v2.4.0).
    expect(parseBody(calls[8]).params?.arguments).toEqual({
      summary: 'onde paramos',
      open_questions: ['q1'],
      next_steps: ['n1'],
      files_touched: ['a.ts'],
      shared: true,
      workspace: 'devorbit',
      project: 'p-1',
    })
    // handoff_accept: handoff_id + any_owner.
    expect(parseBody(calls[9]).params?.arguments).toEqual({
      any_owner: true,
      handoff_id: 'h-1',
      workspace: 'devorbit',
      project: 'p-1',
    })
  })

  it('parseia o conteúdo textual como JSON', async () => {
    const { fetchImpl } = createFetch(() => toolResult('{"sessions":2}'))
    const client = new AiMemoryClient({ endpoint: 'http://x/mcp', fetchImpl })
    const result = await client.status()
    expect(result.json).toEqual({ sessions: 2 })
    expect(result.isError).toBe(false)
  })

  it('isError vira AiMemoryError tool-error', async () => {
    const { fetchImpl } = createFetch(() => toolResult('falhou', true))
    const client = new AiMemoryClient({ endpoint: 'http://x/mcp', fetchImpl })
    await expect(client.status()).rejects.toMatchObject({ code: 'ai-memory/tool-error' })
  })

  it('erro JSON-RPC vira AiMemoryError protocol', async () => {
    const { fetchImpl } = createFetch(() =>
      responseOf({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no method' } })
    )
    await expect(mcpRequest('http://x/mcp', 'tools/call', {}, { fetchImpl })).rejects.toMatchObject({
      code: 'ai-memory/protocol',
    })
  })

  it('aceita resposta SSE (text/event-stream)', async () => {
    const sse = `event: message\ndata: ${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: '{"ok":true}' }] },
    })}\n\n`
    const { fetchImpl } = createFetch(() => responseOf(sse, 'text/event-stream'))
    const result = await mcpRequest('http://x/mcp', 'tools/call', {}, { fetchImpl })
    expect(result).toMatchObject({ content: [{ text: '{"ok":true}' }] })
  })

  it('aplica timeout quando a rede não responde', async () => {
    const fetchImpl = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })) as unknown as typeof fetch
    await expect(mcpRequest('http://x/mcp', 'tools/list', {}, { fetchImpl, timeoutMs: 10 })).rejects.toMatchObject({
      code: 'ai-memory/timeout',
    })
  })

  it('identifica ai-memory compatível via initialize (não só tools/list)', async () => {
    const { fetchImpl } = createFetch(() => initializeResponse())
    const client = new AiMemoryClient({ endpoint: 'http://x/mcp', fetchImpl })
    const identity = await client.serverIdentity()
    expect(identity).toMatchObject({ reachable: true, compatible: true, name: 'ai-memory', version: '2.4.0' })
    expect((await client.health()).ok).toBe(true)
  })

  it('não confunde outro servidor MCP com ai-memory', async () => {
    const { fetchImpl } = createFetch(() => initializeResponse('outro-mcp', '9.9.9'))
    const client = new AiMemoryClient({ endpoint: 'http://x/mcp', fetchImpl })
    const identity = await client.serverIdentity()
    expect(identity).toMatchObject({ reachable: true, compatible: false })
    expect(identity.message).toContain('não é ai-memory')
    expect((await client.health()).ok).toBe(false)
  })

  it('rejeita ai-memory de versão incompatível', async () => {
    const { fetchImpl } = createFetch(() => initializeResponse('ai-memory', '1.0.0'))
    const client = new AiMemoryClient({ endpoint: 'http://x/mcp', fetchImpl })
    const identity = await client.serverIdentity()
    expect(identity.compatible).toBe(false)
    expect(identity.message).toContain('incompatível')
  })

  it('verifyScope confere workspace/project retornados', async () => {
    const { fetchImpl } = createFetch(() =>
      toolResult('{"scope":{"workspace":"devorbit","project":"p-1"}}')
    )
    const client = new AiMemoryClient({ endpoint: 'http://x/mcp', fetchImpl })
    expect(await client.verifyScope({ workspace: 'devorbit', project: 'p-1' })).toEqual({ ok: true })
    expect((await client.verifyScope({ workspace: 'devorbit', project: 'p-2' })).ok).toBe(false)
  })

  it('verifyScope falha fechado quando falta o scope', async () => {
    const { fetchImpl } = createFetch(() => toolResult('{}'))
    const client = new AiMemoryClient({ endpoint: 'http://x/mcp', fetchImpl })
    const result = await client.verifyScope({ workspace: 'devorbit', project: 'p-1' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('sem scope')
  })

  it('verifyScope falha fechado com scope malformado', async () => {
    const { fetchImpl } = createFetch(() => toolResult('{"scope":{"workspace":1,"project":null}}'))
    const client = new AiMemoryClient({ endpoint: 'http://x/mcp', fetchImpl })
    const result = await client.verifyScope({ workspace: 'devorbit', project: 'p-1' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('malformado')
  })

  it('verifyScope propaga falha da chamada de status', async () => {
    const client = new AiMemoryClient({
      endpoint: 'http://x/mcp',
      fetchImpl: (async () => {
        throw new Error('recusado')
      }) as unknown as typeof fetch,
    })
    await expect(client.verifyScope({ workspace: 'devorbit', project: 'p-1' })).rejects.toThrow('recusado')
  })

  it('verifyScope trata "workspace not found" (-32602) com nome EXATO como escopo não inicializado (fail-open)', async () => {
    // mcpRequest transforma -32602 em AiMemoryError('ai-memory/protocol', 'MCP -32602: workspace \'devorbit\' not found')
    const errorResponse = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: "workspace 'devorbit' not found" },
    }
    const { fetchImpl } = createFetch(() => responseOf(errorResponse))
    const client = new AiMemoryClient({ endpoint: 'http://x/mcp', fetchImpl })
    // Deve retornar ok:true (fail-open) — nome exato = workspace ainda não inicializado.
    const result = await client.verifyScope({ workspace: 'devorbit', project: 'p-1' })
    expect(result.ok).toBe(true)
  })

  it('verifyScope trata "workspace \'custom-ws\' not found" com aspas simples quando nome confere (fail-open)', async () => {
    const errorResponse = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: "workspace 'custom-ws' not found" },
    }
    const { fetchImpl } = createFetch(() => responseOf(errorResponse))
    const client = new AiMemoryClient({ endpoint: 'http://x/mcp', fetchImpl })
    const result = await client.verifyScope({ workspace: 'custom-ws', project: 'p-1' })
    expect(result.ok).toBe(true)
  })

  it('verifyScope falha fechado quando workspace nomeado diverge do configurado', async () => {
    // Sidecar reporta "workspace 'alien' not found" mas o scope pede 'devorbit'.
    const errorResponse = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: "workspace 'alien' not found" },
    }
    const { fetchImpl } = createFetch(() => responseOf(errorResponse))
    const client = new AiMemoryClient({ endpoint: 'http://x/mcp', fetchImpl })
    await expect(client.verifyScope({ workspace: 'devorbit', project: 'p-1' }))
      .rejects.toMatchObject({ code: 'ai-memory/protocol' })
  })

  it('verifyScope rejeita mensagem com prefixo/sufixo extra (regex ancorado)', async () => {
    const errorResponse = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'prefix MCP -32602: workspace \'devorbit\' not found suffix' },
    }
    const { fetchImpl } = createFetch(() => responseOf(errorResponse))
    const client = new AiMemoryClient({ endpoint: 'http://x/mcp', fetchImpl })
    await expect(client.verifyScope({ workspace: 'devorbit', project: 'p-1' }))
      .rejects.toMatchObject({ code: 'ai-memory/protocol' })
  })

  it('verifyScope propaga -32602 genérico (message diferente de workspace not found)', async () => {
    const errorResponse = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'invalid params: missing project' },
    }
    const { fetchImpl } = createFetch(() => responseOf(errorResponse))
    const client = new AiMemoryClient({ endpoint: 'http://x/mcp', fetchImpl })
    await expect(client.verifyScope({ workspace: 'devorbit', project: 'p-1' }))
      .rejects.toMatchObject({ code: 'ai-memory/protocol' })
  })

  it('verifyScope propaga erro de transporte (não AiMemoryError)', async () => {
    const client = new AiMemoryClient({
      endpoint: 'http://x/mcp',
      fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
    })
    await expect(client.verifyScope({ workspace: 'devorbit', project: 'p-1' }))
      .rejects.toThrow('ECONNREFUSED')
  })

  it('health falso quando a rede falha', async () => {
    const bad = new AiMemoryClient({
      endpoint: 'http://x/mcp',
      fetchImpl: (async () => {
        throw new Error('recusado')
      }) as unknown as typeof fetch,
    })
    expect((await bad.health()).ok).toBe(false)
  })
})

describe('AiMemoryCli — CLI real encapsulada', () => {
  it('monta argv de doctor/workstreams/finalize/import', async () => {
    const calls: string[][] = []
    const spawnImpl: AiMemorySpawnImpl = async (_command, args) => {
      calls.push([...args])
      const result: AiMemorySpawnResult = { code: 0, stdout: 'ok', stderr: '' }
      return result
    }
    const cli = new AiMemoryCli(createAiMemoryCliRunner({ binaryPath: 'ai-memory.exe', spawnImpl }))

    await cli.doctor()
    await cli.workstreams({ workspace: 'devorbit', project: 'p-1', limit: 50, json: true })
    await cli.finalizeSession({ agent: 'antigravity-cli', sessionId: 'abc' })
    await cli.backfill(['--dry-run'])
    await cli.bootstrap()

    expect(calls).toEqual([
      ['doctor'],
      ['workstreams', '--workspace', 'devorbit', '--project', 'p-1', '--limit', '50', '--json'],
      ['finalize-session', '--agent', 'antigravity-cli', '--session-id', 'abc'],
      ['backfill', '--dry-run'],
      ['bootstrap'],
    ])
  })

  it('version extrai o semver', async () => {
    const spawnImpl: AiMemorySpawnImpl = async () => ({ code: 0, stdout: 'ai-memory 2.4.0\n', stderr: '' })
    const cli = new AiMemoryCli(createAiMemoryCliRunner({ binaryPath: 'ai-memory.exe', spawnImpl }))
    const result = await cli.version()
    expect(parseAiMemoryVersion(result.stdout)).toBe('2.4.0')
  })

  it('propaga falha da CLI como cli-error? (código preservado)', async () => {
    const spawnImpl = vi.fn(async () => ({ code: 3, stdout: '', stderr: 'boom' }))
    const cli = new AiMemoryCli(createAiMemoryCliRunner({ binaryPath: 'ai-memory.exe', spawnImpl }))
    const result = await cli.doctor()
    expect(result.code).toBe(3)
    expect(result.stderr).toBe('boom')
  })

  it('timeout da CLI aborta/termina o processo filho', async () => {
    let aborted = false
    const spawnImpl: AiMemorySpawnImpl = (_command, _args, options) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('aborted'))
        })
      })
    const cli = new AiMemoryCli(
      createAiMemoryCliRunner({ binaryPath: 'ai-memory.exe', spawnImpl, timeoutMs: 10 })
    )
    await expect(cli.doctor()).rejects.toMatchObject({ code: 'ai-memory/timeout' })
    expect(aborted).toBe(true)
  })
})
