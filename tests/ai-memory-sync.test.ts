import { describe, expect, it } from 'vitest'
import {
  AiMemoryBridgeSync,
  applyBridgeEventToSnapshot,
  applyBridgeStatusToTask,
  bridgeOutcomePagePath,
  collectRecentBridgeOutcomeHistory,
  extractAiMemoryBriefingText,
  extractAiMemoryHandoffsText,
  extractAiMemoryPageBody,
  isCancellationSummary,
  legacySquadStatePagePath,
  outcomeToPage,
  renderSquadStateBody,
  SquadMemoryPublisher,
  squadStatePagePath,
  syncScopeOf,
  type BridgeOutcomeRecord,
  type SquadSnapshot,
  type SyncMemoryClient,
} from '../src/main/ai-memory-sync'
import type { AiMemoryScope } from '../src/shared/ai-memory-contract'

interface WriteCall {
  path: string
  body: string
  tags?: string[]
}

type ToolCall = { name: string; args: Record<string, unknown> }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function createClient(options: {
  delayFirst?: ReturnType<typeof deferred<void>>
  failWrites?: boolean
  throwOnCall?: boolean
} = {}): { client: SyncMemoryClient; writes: WriteCall[]; calls: ToolCall[] } {
  const writes: WriteCall[] = []
  const calls: ToolCall[] = []
  const client: SyncMemoryClient = {
    callTool: async (name, args) => {
      calls.push({ name, args })
      if (options.throwOnCall) throw new Error('servidor caiu')
      if (options.delayFirst && writes.length === 0) {
        await options.delayFirst.promise
      }
      if (options.failWrites) return { text: 'erro', isError: true }
      writes.push({ ...(args as { path: string; body: string }), tags: args.tags as string[] | undefined })
      return { text: 'ok', isError: false }
    },
  }
  return { client, writes, calls }
}

const SCOPE_WORKSPACE_PROJECT = { workspace: 'devorbit', project: 'p-1' }

function syncOf(client: SyncMemoryClient): AiMemoryBridgeSync {
  return new AiMemoryBridgeSync({ workspace: 'devorbit', project: 'p-1' }, client)
}

function outcomeOf(overrides: Partial<BridgeOutcomeRecord> = {}): BridgeOutcomeRecord {
  return {
    taskId: 'agent-1#1',
    target: 'agent-1',
    status: 'completed',
    summary: 'CONCLUIDO: build verde',
    ...overrides,
  }
}

describe('sync de outcomes do Bridge → ai-memory', () => {
  it('persiste outcome terminal em página determinística; pending não existe aqui', async () => {
    const { client, writes } = createClient()
    const sync = syncOf(client)
    const persisted = await sync.handle(outcomeOf())
    expect(persisted).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0].path).toBe(bridgeOutcomePagePath('agent-1#1'))
    expect(writes[0].body).toContain('CONCLUIDO: build verde')
  })

  it('deduplica por taskId: o mesmo ciclo não grava duas vezes', async () => {
    const { client, writes } = createClient()
    const sync = syncOf(client)
    await sync.handle(outcomeOf())
    const second = await sync.handle(outcomeOf())
    expect(second).toBe(false)
    expect(writes).toHaveLength(1)
  })

  it('ignora cancelamento e summary vazio (nada persistido, permite retry)', async () => {
    const { client, writes } = createClient()
    const sync = syncOf(client)
    expect(await sync.handle(outcomeOf({ summary: 'A espera da ponte foi cancelada.' }))).toBe(false)
    expect(await sync.handle(outcomeOf({ summary: '   ' }))).toBe(false)
    expect(writes).toHaveLength(0)
    expect(await sync.handle(outcomeOf())).toBe(true)
  })

  it('falha de memória não lança e permite retry do taskId', async () => {
    let failing = true
    const sync = syncOf({
      callTool: async () => {
        if (failing) return { text: 'erro', isError: true }
        return { text: 'ok', isError: false }
      },
    })
    expect(await sync.handle(outcomeOf())).toBe(false)
    failing = false
    // O mesmo taskId pode ser reprocessado após falha (retry permitido).
    expect(await sync.handle(outcomeOf())).toBe(true)
  })

  it('serializa escritas concorrentes na fila em memória', async () => {
    const gate = deferred<void>()
    const { client, writes } = createClient({ delayFirst: gate })
    const sync = syncOf(client)
    const first = sync.handle(outcomeOf({ taskId: 'agent-1#1', summary: 'primeiro' }))
    const second = sync.handle(outcomeOf({ taskId: 'agent-1#2', summary: 'segundo' }))
    gate.resolve()
    const results = await Promise.all([first, second])
    expect(results).toEqual([true, true])
    expect(writes).toHaveLength(2)
    expect(writes[0].body).toContain('primeiro')
    expect(writes[1].body).toContain('segundo')
  })

  it('path da sessão é determinístico por taskId', () => {
    expect(bridgeOutcomePagePath('agent-1#1')).toBe(bridgeOutcomePagePath('agent-1#1'))
    expect(bridgeOutcomePagePath('agent-1#1')).toMatch(/^sessions\/bridge-[a-z0-9._-]+\.md$/)
    expect(isCancellationSummary('A espera da ponte foi cancelada.')).toBe(true)
    expect(isCancellationSummary('CONCLUIDO')).toBe(false)
  })

  it('taskIds distintos nunca colidem no path (hash do RAW case-sensitive)', () => {
    // Case distinto: slug idêntico, mas o hash do RAW diferencia.
    expect(bridgeOutcomePagePath('Ab')).not.toBe(bridgeOutcomePagePath('ab'))
    expect(bridgeOutcomePagePath('a/b')).not.toBe(bridgeOutcomePagePath('a b'))
    // Determinístico.
    expect(bridgeOutcomePagePath('Ab')).toBe(bridgeOutcomePagePath('Ab'))
    // Slug legível preservado + sufixo de hash curto.
    expect(bridgeOutcomePagePath('agent-1#1')).toMatch(/^sessions\/bridge-agent-1-1-[a-f0-9]{12}\.md$/)
  })

  it('ids RAW que sanitizam para o MESMO texto (controle vs espaço) nunca colidem no path', () => {
    // sanitizeText converte o controle em espaço → slug idêntico ('agent-1')...
    const control = outcomeToPage(outcomeOf({ taskId: 'agent\u00011' }))
    const space = outcomeToPage(outcomeOf({ taskId: 'agent 1' }))
    expect(control).toBeDefined()
    expect(space).toBeDefined()
    // ...mas o hash de identidade é do RAW: os paths DIVERGEM.
    expect(control!.path).not.toBe(space!.path)
    expect(control!.path).toMatch(/^sessions\/bridge-agent-1-[a-f0-9]{12}\.md$/)
    expect(space!.path).toMatch(/^sessions\/bridge-agent-1-[a-f0-9]{12}\.md$/)
    // O RAW nunca vaza para o path nem para o body legível.
    expect(control!.path).not.toContain('\u0001')
    expect(control!.body).not.toContain('\u0001')
    expect(control!.body).toContain('agent 1')
    // Determinístico: mesma entrada raw → mesmo path.
    expect(outcomeToPage(outcomeOf({ taskId: 'agent\u00011' }))!.path).toBe(control!.path)
  })

  it('redige segredo no summary e nos artifacts, com limites reaproveitados', () => {
    const page = outcomeToPage(outcomeOf({
      summary: 'resultado com sk-abcdef123456 dentro',
      artifacts: ['ghp_abcdefghijklmnopqr', 'arquivo limpo'],
    }))
    expect(page).toBeDefined()
    expect(page!.body).not.toContain('sk-abcdef123456')
    expect(page!.body).not.toContain('ghp_abcdefghijklmnopqr')
    expect(page!.body).toContain('arquivo limpo')
  })

  it('marca a página como EVIDÊNCIA HISTÓRICA a confirmar (recuperável, sem prompt bruto)', async () => {
    const page = outcomeToPage(outcomeOf({ summary: 'build verde' }))
    expect(page!.body).toContain('EVIDÊNCIA HISTÓRICA')
    expect(page!.body).toContain('NÃO confiável')
    expect(page!.body).toContain('Nenhum prompt bruto é persistido')
    const writes: { path: string; body: string; tags?: string[] }[] = []
    const client: SyncMemoryClient = {
      callTool: async (_name, args) => {
        writes.push({ ...(args as { path: string; body: string }), tags: args.tags as string[] | undefined })
        return { text: 'ok', isError: false }
      },
    }
    const sync = new AiMemoryBridgeSync(SCOPE_WORKSPACE_PROJECT, client)
    await sync.handle(outcomeOf({ summary: 'build verde' }))
    expect(writes[0].tags).toEqual(['devorbit-bridge', 'historical'])
    expect(writes[0].body).toContain('EVIDÊNCIA HISTÓRICA')
  })
})

describe('snapshot consolidado do squad (squads/<id>/state.md)', () => {
  it('renderiza objetivo, membros e tarefas com status', () => {
    const body = renderSquadStateBody({
      id: 'sq-1',
      objective: 'Entregar fase 3',
      members: [{ id: 'm1', title: 'Codex', status: 'in-progress', role: 'impl' }],
      tasks: [{ id: 't1', title: 'Migrar memória', status: 'in-progress', memberId: 'm1' }],
      files: ['.env'],
      decisions: ['usar ai-memory'],
    })
    expect(body).toContain('## Objetivo')
    expect(body).toContain('- [in-progress] Codex — impl')
    expect(body).toContain('- [in-progress] Migrar memória (responsável: m1)')
    expect(body).toContain('## Decisões')
  })

  it('path do squad é determinístico', () => {
    expect(squadStatePagePath('Squad Principal!')).toBe('squads/squad-principal/state.md')
    expect(squadStatePagePath('')).toBe('squads/squad/state.md')
    // Compat v1.0.43: path legado é read-only no takeover; nunca escrito aqui.
    expect(legacySquadStatePagePath('Squad Principal!')).toBe('squads/squad-principal/state')
    expect(legacySquadStatePagePath('')).toBe('squads/squad/state')
  })

  it('pending projeta in-progress UMA vez; reaplicar não transita', () => {
    const task = { id: 't1', title: 'T', status: 'pending' as const, requestId: 'req-1' }
    const inProgress = applyBridgeStatusToTask(task, 'pending')
    expect(inProgress?.status).toBe('in-progress')
    // Idempotente: segunda aplicação não gera transição.
    expect(applyBridgeStatusToTask(inProgress!, 'pending')).toBeUndefined()
    // Pending nunca rebaixa done/blocked.
    expect(applyBridgeStatusToTask({ ...task, status: 'done' }, 'pending')).toBeUndefined()
  })

  it('terminal completed→done, failed→blocked; mesma tarefa por requestId', () => {
    const snapshot = {
      id: 'sq',
      objective: 'obj',
      members: [],
      tasks: [{ id: 't1', title: 'T', status: 'in-progress' as const, requestId: 'req-1' }],
    }
    const done = applyBridgeEventToSnapshot(snapshot, { requestId: 'req-1', status: 'completed' })
    expect(done?.tasks?.[0].status).toBe('done')
    // Reaplicar completed: sem transição, sem escrita.
    expect(applyBridgeEventToSnapshot(done!, { requestId: 'req-1', status: 'completed' })).toBeUndefined()
    const blocked = applyBridgeEventToSnapshot(done!, { requestId: 'req-1', status: 'failed' })
    expect(blocked?.tasks?.[0].status).toBe('blocked')
  })

  it('sem associação confiável: NADA publicado, squad não é inventado', () => {
    const snapshot = { id: 'sq', objective: 'obj', members: [] }
    expect(applyBridgeEventToSnapshot(snapshot, { requestId: 'req-x', status: 'completed' })).toBeUndefined()
    const noTasks = applyBridgeEventToSnapshot(
      { ...snapshot, tasks: [{ id: 't1', title: 'T', status: 'pending' as const }] },
      { requestId: 'req-x', status: 'completed' },
    )
    expect(noTasks).toBeUndefined()
  })
})

describe('publicação e resync do squad', () => {
  it('publica snapshot em squads/<id>/state.md com escritas concorrentes serializadas', async () => {
    const gate = deferred<void>()
    const { client, writes } = createClient({ delayFirst: gate })
    const publisher = new SquadMemoryPublisher({ workspace: 'devorbit', project: 'p-1' }, client)
    const first = publisher.publish({
      id: 'sq-1',
      objective: 'um',
      members: [],
      tasks: [{ id: 't1', title: 'A', status: 'in-progress' }],
    })
    const second = publisher.publish({
      id: 'sq-1',
      objective: 'dois',
      members: [],
      tasks: [{ id: 't1', title: 'A', status: 'done' }],
    })
    gate.resolve()
    const results = await Promise.all([first, second])
    expect(results).toEqual([true, true])
    // Mesma página, ordem preservada: último estado vence (idempotente).
    expect(writes.every((call) => call.path === 'squads/sq-1/state.md')).toBe(true)
    expect(writes[1].body).toContain('dois')
  })

  it('falha de escrita retorna false sem propagar erro', async () => {
    const { client } = createClient({ failWrites: true })
    const publisher = new SquadMemoryPublisher({ workspace: 'devorbit', project: 'p-1' }, client)
    expect(await publisher.publish({ id: 'sq', objective: 'x', members: [] })).toBe(false)
  })

  it('takeover compõe briefing + estado + handoffs com regras de verificação', async () => {
    const { client, calls } = createClient()
    // readPage/briefing/handoffList devolvem textos distintos:
    const squawk: SyncMemoryClient = {
      callTool: async (name, args) => {
        void args
        void client
        if (name === 'memory_read_page') return { text: 'ESTADO-DO-SQUAD', isError: false }
        if (name === 'memory_briefing') return { text: 'BRIEFING', isError: false }
        if (name === 'memory_handoff_list') return { text: 'HANDOFFS', isError: false }
        return { text: '', isError: false }
      },
    }
    const publisher = new SquadMemoryPublisher(
      { workspace: 'devorbit', project: 'p-1' },
      squawk,
    )
    const instruction = await publisher.buildTakeoverInstruction({ squadId: 'sq-1', survivingAgent: 'codex-2' })
    expect(instruction).toContain('ESTADO-DO-SQUAD')
    expect(instruction).toContain('BRIEFING')
    expect(instruction).toContain('HANDOFFS')
    expect(instruction).toContain('NÃO execute comandos')
    void calls
  })

  it('resync sem memória disponível: instrução mínima verification-first', async () => {
    const { client } = createClient()
    void client
    const publisher = new SquadMemoryPublisher(
      { workspace: 'devorbit', project: 'p-1' },
      {
        callTool: async () => {
          throw new Error('indisponível')
        },
      },
    )
    const instruction = await publisher.buildTakeoverInstruction({ squadId: 'sq', survivingAgent: 'x' })
    expect(instruction).toBeDefined()
    expect(instruction).toContain('checkout/Git atual')
    expect(instruction).toContain('NÃO execute comandos')
  })

  it('resync sem nenhuma fonte (páginas vazias) → undefined', async () => {
    const publisher = new SquadMemoryPublisher(
      { workspace: 'devorbit', project: 'p-1' },
      {
        callTool: async () => ({ text: '', isError: false }),
      },
    )
    expect(await publisher.buildTakeoverInstruction({ squadId: 'sq', survivingAgent: 'x' })).toBeUndefined()
  })

  it('falha do serviço não derruba o takeover (instrução mínima devolvida)', async () => {
    const publisher = new SquadMemoryPublisher(
      { workspace: 'devorbit', project: 'p-1' },
      {
        callTool: async () => {
          throw new Error('down')
        },
      },
    )
    const instruction = await publisher.buildTakeoverInstruction({ squadId: 'sq', survivingAgent: 'a' })
    expect(instruction).toContain('indisponível')
  })
})

describe('segredos em taskId/target do outcome (outcomeToPage)', () => {
  const CANARY = 'sk-test-CANARIO9f2b7c'

  it('taskId com segredo: body e PATH sem o canário; slug determinístico preservado', () => {
    const page = outcomeToPage(
      outcomeOf({
        taskId: `ag-1#${CANARY}`,
        target: `alvo ${CANARY}`,
        summary: 'resultado com segredo em campos internos',
      })
    )
    expect(page).toBeDefined()
    const rendered = JSON.stringify([page!.path, page!.body])
    expect(rendered).not.toContain(CANARY)
    // Path determinístico: slug do taskId RENDERIZADO (sanitizado), identidade
    // pelo hash do RAW — o segredo não vaza, mas o raw participa do hash.
    const renderedTaskId = page!.body.match(/^# Delegação \w+ — (.+)$/m)![1]
    expect(renderedTaskId).not.toContain(CANARY)
    expect(page!.path).toBe(bridgeOutcomePagePath(renderedTaskId, `ag-1#${CANARY}`))
    expect(page!.path).not.toBe(bridgeOutcomePagePath(renderedTaskId))
    expect(page!.path.startsWith('sessions/bridge-')).toBe(true)
  })

  it('target com controles/segredo: redigido; summary permanece sanitizado', () => {
    const page = outcomeToPage(
      outcomeOf({
        target: `x\x07y ${CANARY}`,
        summary: 'CONCLUIDO: ok',
      })
    )
    expect(page!.body).toContain('Alvo:')
    expect(page!.body).not.toContain(CANARY)
    expect(page!.body).not.toContain('\x07')
  })

  it('taskId limpo: path IDÊNTICO ao derivado do taskId cru (sem perda de dedupe/path)', () => {
    const page = outcomeToPage(outcomeOf({ taskId: 'agent-1#3', target: 'agente limpo' }))
    expect(page!.path).toBe(bridgeOutcomePagePath('agent-1#3'))
  })
})

describe('AiMemoryBridgeSync.flush (drain de shutdown)', () => {
  it('flush aguarda escrita BLOQUEADA e resolve após o gate abrir', async () => {
    const gate = deferred<void>()
    const { client, writes } = createClient({ delayFirst: gate })
    const sync = syncOf(client)
    const handled = sync.handle(outcomeOf({ taskId: 'flush-1#1', summary: 'CONCLUIDO: verde' }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(writes).toHaveLength(0) // escrita em voo, bloqueada no gate

    let flushResolved = false
    const flushing = sync.flush().then(() => {
      flushResolved = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(flushResolved).toBe(false) // aguarda a escrita enfileirada

    gate.resolve()
    await flushing
    expect(flushResolved).toBe(true)
    expect(await handled).toBe(true)
    expect(writes).toHaveLength(1)
  })

  it('flush com timeout curto não lança e NÃO re-lê/re-tenta (uma chamada só)', async () => {
    const gate = deferred<void>()
    const { client, calls } = createClient({ delayFirst: gate })
    const sync = syncOf(client)
    void sync.handle(outcomeOf({ taskId: 'flush-2#1', summary: 'CONCLUIDO: azul' }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await expect(sync.flush(25)).resolves.toBeUndefined()
    expect(calls).toHaveLength(1) // sem retry nem nova leitura
    gate.resolve() // libera para o teardown do teste
  })
})

describe('extração de resultados MCP (shapes v2.4.0)', () => {
  it('read_page: prefere json.body e cai para text só sem json objeto', () => {
    expect(extractAiMemoryPageBody({ text: 'TEXTO', json: { path: 'p', body: 'CORPO' }, isError: false })).toBe('CORPO')
    expect(extractAiMemoryPageBody({ text: 'TEXTO', isError: false })).toBe('TEXTO')
    expect(extractAiMemoryPageBody({ text: 'TEXTO', json: { body: 'CORPO' }, isError: true })).toBe('')
    expect(extractAiMemoryPageBody({ text: '', json: { body: 42 }, isError: false })).toBe('')
  })

  it('read_page malformed (json objeto sem body string): text serializado NUNCA vira corpo', () => {
    const serialized = JSON.stringify({ path: 'squads/sq-1/state.md', note: 'sem body' })
    expect(
      extractAiMemoryPageBody({
        text: serialized,
        json: { path: 'squads/sq-1/state.md', note: 'sem body' },
        isError: false,
      })
    ).toBe('')
    expect(extractAiMemoryPageBody({ text: serialized, json: { body: 42 }, isError: false })).toBe('')
    expect(extractAiMemoryPageBody({ text: serialized, json: [1, 2, 3], isError: false })).toBe('')
    expect(extractAiMemoryPageBody({ text: serialized, json: null, isError: false })).toBe(serialized)
  })

  it('briefing: prefere campos estruturados; objeto desconhecido vira JSON bounded (nunca text cru)', () => {
    expect(extractAiMemoryBriefingText({ text: 'T', json: { briefing: 'BRIEF' }, isError: false })).toBe('BRIEF')
    expect(extractAiMemoryBriefingText({ text: 'T', json: { summary: 'SUM' }, isError: false })).toBe('SUM')
    expect(extractAiMemoryBriefingText({ text: 'T', isError: false })).toBe('T')
  })

  it('briefing: shape REAL { recent, recent_pages_limit } renderiza JSON e ignora text', () => {
    const rendered = extractAiMemoryBriefingText({
      text: 'IGNORADO',
      isError: false,
      json: { recent: ['notes/a.md', 'sessions/bridge-x-1-abcdef123456.md'], recent_pages_limit: 10 },
    })
    expect(rendered).toContain('"recent_pages_limit": 10')
    expect(rendered).toContain('notes/a.md')
    expect(rendered).not.toContain('IGNORADO')
  })

  it('briefing: JSON bounded respeita maxChars', () => {
    const rendered = extractAiMemoryBriefingText(
      { text: 'IGNORADO', isError: false, json: { recent: Array.from({ length: 200 }, (_v, i) => `p-${i}.md`) } },
      120
    )
    expect(rendered.length).toBeLessThanOrEqual(120)
    expect(rendered).not.toContain('IGNORADO')
  })

  it('handoffs: formata lista, lista vazia explícita e itens sem summary em JSON (nunca text cru)', () => {
    const structured = extractAiMemoryHandoffsText({
      text: 'T',
      isError: false,
      json: { handoffs: [{ id: 'h-1', agent: 'codex', status: 'pending', summary: 'retomar build' }] },
    })
    expect(structured).toContain('- [pending] codex: retomar build (h-1)')
    expect(extractAiMemoryHandoffsText({ text: 'IGNORADO', json: { handoffs: [] }, isError: false })).toBe(
      '(nenhum handoff aberto)'
    )
    const noSummary = extractAiMemoryHandoffsText({
      text: 'IGNORADO',
      isError: false,
      json: { handoffs: [{ id: 'h-2', agent: 'agy' }] },
    })
    expect(noSummary).toContain('"h-2"')
    expect(noSummary).not.toContain('IGNORADO')
    expect(extractAiMemoryHandoffsText({ text: 'T', isError: false })).toBe('T')
  })
})

describe('evidência recente do Bridge para takeover (fail-open, bounded)', () => {
  function recentClient(options: {
    pages?: unknown[]
    bodies?: Record<string, { text?: string; json?: unknown }>
    failRecent?: boolean
    failShape?: boolean
  }): { client: SyncMemoryClient; reads: string[]; recentLimits: number[] } {
    const reads: string[] = []
    const recentLimits: number[] = []
    const client: SyncMemoryClient = {
      callTool: async (name, args) => {
        if (name === 'memory_recent') {
          if (options.failRecent) throw new Error('recent down')
          recentLimits.push(Number(args.limit))
          if (options.failShape) return { text: 'sem json', isError: false }
          return { text: '', json: { pages: options.pages ?? [] }, isError: false }
        }
        if (name === 'memory_read_page') {
          const pagePath = String(args.path)
          reads.push(pagePath)
          const body = options.bodies?.[pagePath]
          return { text: body?.text ?? '', json: body?.json ?? {}, isError: false }
        }
        return { text: '', isError: false }
      },
    }
    return { client, reads, recentLimits }
  }

  const SCOPE = { workspace: 'devorbit', project: 'p-1' }

  it('seleciona apenas sessions/bridge-*.md (ou tag devorbit-bridge) e lê bodies via json.body', async () => {
    const { client, reads, recentLimits } = recentClient({
      pages: [
        'notes/normal.md',
        'sessions/bridge-agent-1-1-abcdef123456.md',
        { path: 'sessions/bridge-agent-2-2-fedcba654321.md', tags: ['devorbit-bridge', 'historical'] },
        { path: 'notes/tagged.md', tags: ['devorbit-bridge'] },
      ],
      bodies: {
        'sessions/bridge-agent-1-1-abcdef123456.md': { text: 'IGNORADO', json: { body: 'BODY-1' } },
        'sessions/bridge-agent-2-2-fedcba654321.md': { text: 'IGNORADO', json: { body: 'BODY-2' } },
        'notes/tagged.md': { json: { body: 'BODY-TAGGED' } },
      },
    })

    const entries = await collectRecentBridgeOutcomeHistory(client, SCOPE, { recentLimit: 7 })
    expect(recentLimits).toEqual([7])
    expect(entries.map((entry) => entry.path)).toEqual([
      'sessions/bridge-agent-1-1-abcdef123456.md',
      'sessions/bridge-agent-2-2-fedcba654321.md',
      'notes/tagged.md',
    ])
    expect(entries.map((entry) => entry.body)).toEqual(['BODY-1', 'BODY-2', 'BODY-TAGGED'])
    expect(reads).toHaveLength(3)
  })

  it('respeita maxPages e maxChars (bounded)', async () => {
    const pages = Array.from({ length: 5 }, (_value, index) => `sessions/bridge-a-${index}-0123456789ab.md`)
    const bodies = Object.fromEntries(pages.map((pagePath) => [pagePath, { json: { body: 'X'.repeat(100) } }]))
    const first = recentClient({ pages, bodies })
    const limited = await collectRecentBridgeOutcomeHistory(first.client, SCOPE, { maxPages: 2, maxChars: 1_000 })
    expect(limited).toHaveLength(2)

    const second = recentClient({ pages, bodies })
    const clamped = await collectRecentBridgeOutcomeHistory(second.client, SCOPE, { maxChars: 250 })
    expect(clamped.reduce((sum, entry) => sum + entry.body.length, 0)).toBe(250)
    expect(clamped).toHaveLength(3)
  })

  it('é fail-open quando recent falha, shape some ou read_page cai', async () => {
    const failing = recentClient({ failRecent: true })
    expect(await collectRecentBridgeOutcomeHistory(failing.client, SCOPE)).toEqual([])

    const unknownShape = recentClient({ failShape: true })
    expect(await collectRecentBridgeOutcomeHistory(unknownShape.client, SCOPE)).toEqual([])

    const readsFailing: SyncMemoryClient = {
      callTool: async (name) => {
        if (name === 'memory_recent') {
          return { text: '', json: { pages: ['sessions/bridge-a-1-0123456789ab.md'] }, isError: false }
        }
        throw new Error('read down')
      },
    }
    expect(await collectRecentBridgeOutcomeHistory(readsFailing, SCOPE)).toEqual([])
  })
})