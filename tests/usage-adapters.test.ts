import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  USAGE_MAX_EVENTS_PER_SCAN,
  resolveUsageSourceDirs,
  scanUsageAdapters,
} from '../src/main/usage-adapters'
import type { UsageScanState } from '../src/shared/usage-contract'

// O adaptador do OpenCode usa os.homedir() para o caminho XDG de fallback;
// nos testes apontamos esse "perfil" para o diretório temporário da prova.
const homedirHolder: { value: string } = { value: '' }

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const mocked = { ...actual, homedir: () => homedirHolder.value || actual.homedir() }
  return { ...mocked, default: mocked }
})

const sqliteAvailable = await import('node:sqlite').then(() => true).catch(() => false)

const EMPTY_STATE: UsageScanState = { offsets: {} }

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'devorbit-usage-adapters-'))
  homedirHolder.value = root
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Fixtures sintéticas (formatos documentados; nenhum dado real)
// ---------------------------------------------------------------------------

/** statuses sempre contém as quatro fontes; busque por source, não por índice. */
function statusOf(
  result: Awaited<ReturnType<typeof scanUsageAdapters>>,
  source: 'claude-transcripts' | 'codex-rollouts' | 'opencode-storage' | 'gemini-local'
): (typeof result.statuses)[number] | undefined {
  return result.statuses.find((status) => status.source === source)
}

function claudeAssistantLine(input: {
  uuid: string
  timestamp: string
  model?: string
  usage?: Record<string, number>
}): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: '/tmp/proj',
    sessionId: 'ses-1',
    version: '2.1.0',
    type: 'assistant',
    message: {
      id: `msg_${input.uuid}`,
      type: 'message',
      role: 'assistant',
      model: input.model ?? 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'resposta' }],
      stop_reason: 'end_turn',
      usage: input.usage ?? {
        input_tokens: 10,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 7,
        output_tokens: 5,
      },
    },
    uuid: input.uuid,
    timestamp: input.timestamp,
  })
}

function codexSessionMetaLine(model?: string): string {
  return JSON.stringify({
    timestamp: '2026-09-21T11:00:00.000Z',
    ordinal: 1,
    type: 'session_meta',
    payload: {
      id: 'rollout-1',
      timestamp: '2026-09-21T11:00:00.000Z',
      cwd: '/tmp/proj',
      originator: 'codex-cli-tui',
      cli_version: '0.155.1',
      ...(model ? { model } : {}),
    },
  })
}

function codexTotals(inputTokens: number, outputTokens: number): Record<string, number> {
  return {
    input_tokens: inputTokens,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    reasoning_output_tokens: 0,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  }
}

function codexTokenCountLine(input: {
  ordinal: number
  timestamp: string
  totals?: { inputTokens: number; outputTokens: number }
  last?: { inputTokens: number; outputTokens: number }
  infoNull?: boolean
  shape?: 'payload-info' | 'top-info' | 'payload-direct'
}): string {
  if (input.infoNull) {
    return JSON.stringify({
      timestamp: input.timestamp,
      ordinal: input.ordinal,
      type: 'event_msg',
      payload: { type: 'token_count', info: null },
    })
  }
  const info: Record<string, unknown> = {}
  if (input.totals) {
    info.total_token_usage = codexTotals(input.totals.inputTokens, input.totals.outputTokens)
  }
  if (input.last) {
    info.last_token_usage = codexTotals(input.last.inputTokens, input.last.outputTokens)
  }
  if (input.shape === 'top-info') {
    return JSON.stringify({
      timestamp: input.timestamp,
      ordinal: input.ordinal,
      type: 'token_count',
      info,
    })
  }
  if (input.shape === 'payload-direct') {
    return JSON.stringify({
      timestamp: input.timestamp,
      ordinal: input.ordinal,
      type: 'token_count',
      payload: { type: 'token_count', total_token_usage: codexTotals(input.totals!.inputTokens, input.totals!.outputTokens) },
    })
  }
  return JSON.stringify({
    timestamp: input.timestamp,
    ordinal: input.ordinal,
    type: 'event_msg',
    payload: { type: 'token_count', info: { ...info, rate_limits: {} } },
  })
}

async function writeJsonl(file: string, lines: string[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, lines.map((line) => `${line}\n`).join(''), 'utf8')
}

async function createOpenCodeDb(dbPath: string, setup: (db: DatabaseSync) => void): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  await mkdir(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    setup(db)
  } finally {
    db.close()
  }
}

function insertOpenCodeMessage(db: DatabaseSync, id: string, data: Record<string, unknown>): void {
  db.prepare('INSERT INTO message (id, data) VALUES (?, ?)').run(id, JSON.stringify(data))
}

function opencodeAssistantData(input: {
  id: string
  providerID?: string
  modelID?: string
  created?: number
  tokens?: Record<string, unknown>
}): Record<string, unknown> {
  return {
    id: input.id,
    sessionID: 'ses_1',
    role: 'assistant',
    providerID: input.providerID ?? 'anthropic',
    modelID: input.modelID ?? 'claude-3-5-haiku',
    time: { created: input.created ?? 1758450000000, completed: (input.created ?? 1758450000000) + 900 },
    ...(input.tokens
      ? { tokens: input.tokens }
      : {}),
    cost: 0.01,
  }
}

// ---------------------------------------------------------------------------
// resolveUsageSourceDirs
// ---------------------------------------------------------------------------

describe('resolveUsageSourceDirs', () => {
  it('usa o homedir como base quando o ambiente está vazio', () => {
    const dirs = resolveUsageSourceDirs(path.join(root, 'home'), {})
    expect(dirs.claude).toBe(path.join(root, 'home', '.claude'))
    expect(dirs.codex).toBe(path.join(root, 'home', '.codex'))
    expect(dirs.opencode).toBe(path.join(root, 'home', '.local', 'share', 'opencode'))
    expect(dirs.gemini).toBe(path.join(root, 'home', '.gemini'))
  })

  it('honra CLAUDE_CONFIG_DIR, CODEX_HOME e OPENCODE_DATA_DIR', () => {
    const dirs = resolveUsageSourceDirs(path.join(root, 'home'), {
      CLAUDE_CONFIG_DIR: path.join(root, 'claude-cfg'),
      CODEX_HOME: path.join(root, 'codex-home'),
      OPENCODE_DATA_DIR: path.join(root, 'opencode-data'),
    })
    expect(dirs.claude).toBe(path.join(root, 'claude-cfg'))
    expect(dirs.codex).toBe(path.join(root, 'codex-home'))
    expect(dirs.opencode).toBe(path.join(root, 'opencode-data'))
  })

  it('XDG_DATA_HOME resolve o diretório do OpenCode', () => {
    const dirs = resolveUsageSourceDirs(path.join(root, 'home'), {
      XDG_DATA_HOME: path.join(root, 'xdg-data'),
    })
    expect(dirs.opencode).toBe(path.join(root, 'xdg-data', 'opencode'))
  })

  it('sem XDG usa o caminho XDG do perfil (OpenCode real também no Windows)', () => {
    const dirs = resolveUsageSourceDirs(path.join(root, 'home'), {
      LOCALAPPDATA: path.join(root, 'localappdata'),
    })
    expect(dirs.opencode).toBe(path.join(root, 'home', '.local', 'share', 'opencode'))
  })

  it('sem argumentos devolve caminhos a partir do processo', () => {
    const dirs = resolveUsageSourceDirs()
    expect(typeof dirs.claude).toBe('string')
    expect(typeof dirs.codex).toBe('string')
    expect(typeof dirs.opencode).toBe('string')
    expect(typeof dirs.gemini).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Claude Code — transcripts JSONL
// ---------------------------------------------------------------------------

describe('claude-transcripts', () => {
  it('primeira varredura emite eventos com modelo, tokens, cache, at e dedupeKey', async () => {
    const file = path.join(root, 'claude', 'projects', 'proj-a', 'ses-1.jsonl')
    const lines = [
      claudeAssistantLine({ uuid: 'u-1', timestamp: '2026-09-21T10:00:00.000Z' }),
      claudeAssistantLine({
        uuid: 'u-2',
        timestamp: '2026-09-21T10:01:00.000Z',
        model: 'anthropic/claude-opus-4-1',
        usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 9, output_tokens: 50 },
      }),
    ]
    await writeJsonl(file, lines)

    const result = await scanUsageAdapters({ claude: path.join(root, 'claude') }, EMPTY_STATE)
    expect(result.statuses[0]).toMatchObject({ source: 'claude-transcripts', status: 'ok' })
    expect(result.events).toHaveLength(2)
    expect(result.events[0]).toEqual({
      kind: 'tokens',
      at: '2026-09-21T10:00:00.000Z',
      source: 'claude-transcripts',
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
      dedupeKey: 'claude:projects/proj-a/ses-1.jsonl:u-1',
    })
    expect(result.events[1]?.model).toBe('claude-opus-4-1')
    expect(result.events[1]?.inputTokens).toBe(100)
    expect(result.state.offsets[file]).toBe(Buffer.byteLength(`${lines[0]}\n${lines[1]}\n`, 'utf8'))
  })

  it('segunda varredura não reemite (offsets) e fica empty', async () => {
    const file = path.join(root, 'claude', 'projects', 'proj-a', 'ses-1.jsonl')
    await writeJsonl(file, [claudeAssistantLine({ uuid: 'u-1', timestamp: '2026-09-21T10:00:00.000Z' })])

    const first = await scanUsageAdapters({ claude: path.join(root, 'claude') }, EMPTY_STATE)
    expect(first.events).toHaveLength(1)
    const second = await scanUsageAdapters({ claude: path.join(root, 'claude') }, first.state)
    expect(second.events).toHaveLength(0)
    expect(second.statuses[0]).toMatchObject({ source: 'claude-transcripts', status: 'empty' })
  })

  it('anexar nova linha emite exatamente o novo evento', async () => {
    const file = path.join(root, 'claude', 'projects', 'proj-a', 'ses-1.jsonl')
    await writeJsonl(file, [claudeAssistantLine({ uuid: 'u-1', timestamp: '2026-09-21T10:00:00.000Z' })])
    const first = await scanUsageAdapters({ claude: path.join(root, 'claude') }, EMPTY_STATE)
    expect(first.events).toHaveLength(1)

    const appended = claudeAssistantLine({
      uuid: 'u-2',
      timestamp: '2026-09-21T10:05:00.000Z',
      usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 8 },
    })
    await appendFile(file, `${appended}\n`, 'utf8')
    const second = await scanUsageAdapters({ claude: path.join(root, 'claude') }, first.state)
    expect(second.events).toHaveLength(1)
    expect(second.events[0]?.dedupeKey).toBe('claude:projects/proj-a/ses-1.jsonl:u-2')
    expect(second.events[0]?.inputTokens).toBe(20)
  })

  it('linha parcial no final só é consumida quando completa', async () => {
    const file = path.join(root, 'claude', 'projects', 'proj-a', 'ses-1.jsonl')
    const complete = claudeAssistantLine({ uuid: 'u-1', timestamp: '2026-09-21T10:00:00.000Z' })
    await writeJsonl(file, [complete])
    await appendFile(file, '{"type":"assistant","message":{"model":"claude-ha', 'utf8')

    const first = await scanUsageAdapters({ claude: path.join(root, 'claude') }, EMPTY_STATE)
    expect(first.events).toHaveLength(1)
    expect(first.events[0]?.dedupeKey.endsWith(':u-1')).toBe(true)
    expect(first.state.offsets[file]).toBe(Buffer.byteLength(`${complete}\n`, 'utf8'))

    await appendFile(
      file,
      'iku-4-5","usage":{"input_tokens":3,"output_tokens":1}},"uuid":"u-2","timestamp":"2026-09-21T10:02:00.000Z"}\n',
      'utf8'
    )
    const second = await scanUsageAdapters({ claude: path.join(root, 'claude') }, first.state)
    expect(second.events).toHaveLength(1)
    expect(second.events[0]?.dedupeKey.endsWith(':u-2')).toBe(true)
    expect(second.events[0]?.model).toBe('claude-haiku-4-5')
    expect(second.events[0]?.inputTokens).toBe(3)
  })

  it('linha malformada é ignorada sem falhar a varredura', async () => {
    const file = path.join(root, 'claude', 'projects', 'proj-a', 'ses-1.jsonl')
    await writeJsonl(file, [
      claudeAssistantLine({ uuid: 'u-1', timestamp: '2026-09-21T10:00:00.000Z' }),
      'isto não é json',
      claudeAssistantLine({ uuid: 'u-2', timestamp: '2026-09-21T10:01:00.000Z' }),
    ])

    const result = await scanUsageAdapters({ claude: path.join(root, 'claude') }, EMPTY_STATE)
    expect(result.events).toHaveLength(2)
    expect(result.statuses[0]).toMatchObject({ source: 'claude-transcripts', status: 'ok' })
    expect(result.statuses[0]?.message).toContain('inválido')
  })

  it('diretório ausente gera status missing', async () => {
    const result = await scanUsageAdapters({ claude: path.join(root, 'inexistente') }, EMPTY_STATE)
    expect(result.statuses[0]).toMatchObject({ source: 'claude-transcripts', status: 'missing' })
    expect(result.events).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Codex — rollouts JSONL
// ---------------------------------------------------------------------------

describe('codex-rollouts', () => {
  it('emite o delta do turno via last_token_usage com modelo do session_meta', async () => {
    const file = path.join(root, 'codex', 'sessions', '2026', '09', '21', 'rollout-1.jsonl')
    await writeJsonl(file, [
      codexSessionMetaLine('gpt-5-codex'),
      codexTokenCountLine({
        ordinal: 2,
        timestamp: '2026-09-21T11:05:00.000Z',
        totals: { inputTokens: 100, outputTokens: 50 },
        last: { inputTokens: 30, outputTokens: 20 },
      }),
    ])

    const result = await scanUsageAdapters({ codex: path.join(root, 'codex') }, EMPTY_STATE)
    expect(statusOf(result, 'codex-rollouts')).toMatchObject({ status: 'ok' })
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toEqual({
      kind: 'tokens',
      at: '2026-09-21T11:05:00.000Z',
      source: 'codex-rollouts',
      provider: 'codex',
      model: 'gpt-5-codex',
      inputTokens: 30,
      outputTokens: 20,
      dedupeKey: 'codex:sessions/2026/09/21/rollout-1.jsonl:2',
    })
  })

  it('"info": null em eventos iniciais é ignorado sem falhar', async () => {
    const file = path.join(root, 'codex', 'sessions', '2026', '09', '21', 'rollout-2.jsonl')
    await writeJsonl(file, [
      codexSessionMetaLine('gpt-5-codex'),
      codexTokenCountLine({ ordinal: 2, timestamp: '2026-09-21T11:01:00.000Z', infoNull: true }),
      codexTokenCountLine({
        ordinal: 3,
        timestamp: '2026-09-21T11:05:00.000Z',
        last: { inputTokens: 12, outputTokens: 6 },
        totals: { inputTokens: 12, outputTokens: 6 },
      }),
    ])

    const result = await scanUsageAdapters({ codex: path.join(root, 'codex') }, EMPTY_STATE)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.inputTokens).toBe(12)
    expect(result.events[0]?.dedupeKey.endsWith(':3')).toBe(true)
  })

  it('calcula delta a partir do total cumulativo quando last_token_usage falta', async () => {
    const file = path.join(root, 'codex', 'sessions', '2026', '09', '21', 'rollout-3.jsonl')
    await writeJsonl(file, [
      codexSessionMetaLine('gpt-5-codex'),
      codexTokenCountLine({
        ordinal: 2,
        timestamp: '2026-09-21T11:05:00.000Z',
        totals: { inputTokens: 100, outputTokens: 50 },
      }),
      codexTokenCountLine({
        ordinal: 3,
        timestamp: '2026-09-21T11:10:00.000Z',
        totals: { inputTokens: 180, outputTokens: 90 },
      }),
    ])

    const result = await scanUsageAdapters({ codex: path.join(root, 'codex') }, EMPTY_STATE)
    expect(result.events).toHaveLength(2)
    expect(result.events[0]).toMatchObject({ inputTokens: 100, outputTokens: 50 })
    expect(result.events[1]).toMatchObject({ inputTokens: 80, outputTokens: 40 })
  })

  it('delta do total cumulativo continua correto entre varreduras (base em memória)', async () => {
    const file = path.join(root, 'codex', 'sessions', '2026', '09', '21', 'rollout-4.jsonl')
    await writeJsonl(file, [
      codexSessionMetaLine('gpt-5-codex'),
      codexTokenCountLine({
        ordinal: 2,
        timestamp: '2026-09-21T11:05:00.000Z',
        totals: { inputTokens: 100, outputTokens: 50 },
      }),
    ])
    const first = await scanUsageAdapters({ codex: path.join(root, 'codex') }, EMPTY_STATE)
    expect(first.events).toHaveLength(1)
    expect(first.events[0]).toMatchObject({ inputTokens: 100, outputTokens: 50 })

    await appendFile(
      file,
      `${codexTokenCountLine({
        ordinal: 3,
        timestamp: '2026-09-21T11:10:00.000Z',
        totals: { inputTokens: 180, outputTokens: 90 },
      })}\n`,
      'utf8'
    )
    const second = await scanUsageAdapters({ codex: path.join(root, 'codex') }, first.state)
    expect(second.events).toHaveLength(1)
    expect(second.events[0]).toMatchObject({ inputTokens: 80, outputTokens: 40 })
  })

  it('ordinal duplicado não é reemitido (bug conhecido do Codex)', async () => {
    const file = path.join(root, 'codex', 'sessions', '2026', '09', '21', 'rollout-5.jsonl')
    const duplicate = {
      ordinal: 2,
      timestamp: '2026-09-21T11:05:00.000Z',
      totals: { inputTokens: 100, outputTokens: 50 },
      last: { inputTokens: 30, outputTokens: 20 },
    }
    await writeJsonl(file, [
      codexSessionMetaLine('gpt-5-codex'),
      codexTokenCountLine(duplicate),
      codexTokenCountLine(duplicate),
    ])

    const result = await scanUsageAdapters({ codex: path.join(root, 'codex') }, EMPTY_STATE)
    expect(result.events).toHaveLength(1)
  })

  it('arquivo sem token_count fica com status empty', async () => {
    const file = path.join(root, 'codex', 'sessions', '2026', '09', '21', 'rollout-6.jsonl')
    await writeJsonl(file, [
      codexSessionMetaLine('gpt-5-codex'),
      JSON.stringify({
        timestamp: '2026-09-21T11:02:00.000Z',
        ordinal: 2,
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'olá' },
      }),
    ])

    const result = await scanUsageAdapters({ codex: path.join(root, 'codex') }, EMPTY_STATE)
    expect(result.events).toHaveLength(0)
    expect(statusOf(result, 'codex-rollouts')).toMatchObject({ status: 'empty' })
  })

  it('token_count anexado emite apenas o novo registro', async () => {
    const file = path.join(root, 'codex', 'sessions', '2026', '09', '21', 'rollout-7.jsonl')
    await writeJsonl(file, [
      codexSessionMetaLine('gpt-5-codex'),
      codexTokenCountLine({
        ordinal: 2,
        timestamp: '2026-09-21T11:05:00.000Z',
        totals: { inputTokens: 100, outputTokens: 50 },
        last: { inputTokens: 30, outputTokens: 20 },
      }),
    ])
    const first = await scanUsageAdapters({ codex: path.join(root, 'codex') }, EMPTY_STATE)
    expect(first.events).toHaveLength(1)

    await appendFile(
      file,
      `${codexTokenCountLine({
        ordinal: 3,
        timestamp: '2026-09-21T11:09:00.000Z',
        totals: { inputTokens: 130, outputTokens: 70 },
        last: { inputTokens: 25, outputTokens: 15 },
      })}\n`,
      'utf8'
    )
    const second = await scanUsageAdapters({ codex: path.join(root, 'codex') }, first.state)
    expect(second.events).toHaveLength(1)
    expect(second.events[0]).toMatchObject({
      inputTokens: 25,
      outputTokens: 15,
      at: '2026-09-21T11:09:00.000Z',
    })
  })

  it('aceita variantes de forma (info no topo / payload direto) e cai para o modelo padrão', async () => {
    await writeJsonl(path.join(root, 'codex', 'sessions', '2026', '09', '21', 'rollout-8.jsonl'), [
      codexTokenCountLine({
        ordinal: 1,
        timestamp: '2026-09-21T11:05:00.000Z',
        shape: 'top-info',
        totals: { inputTokens: 110, outputTokens: 60 },
      }),
    ])
    await writeJsonl(path.join(root, 'codex', 'sessions', '2026', '09', '21', 'rollout-9.jsonl'), [
      codexTokenCountLine({
        ordinal: 1,
        timestamp: '2026-09-21T11:06:00.000Z',
        shape: 'payload-direct',
        totals: { inputTokens: 70, outputTokens: 40 },
      }),
    ])

    const result = await scanUsageAdapters({ codex: path.join(root, 'codex') }, EMPTY_STATE)
    expect(result.events).toHaveLength(2)
    expect(result.events[0]).toMatchObject({ inputTokens: 110, outputTokens: 60, model: 'codex' })
    expect(result.events[1]).toMatchObject({ inputTokens: 70, outputTokens: 40, model: 'codex' })
  })
})

// ---------------------------------------------------------------------------
// OpenCode — banco SQLite (opencode.db)
// ---------------------------------------------------------------------------

describe.skipIf(!sqliteAvailable)('opencode-storage (SQLite)', () => {
  it('mensagem assistant com tokens vira evento; user/sem-tokens são ignorados', async () => {
    const dbPath = path.join(root, 'opencode', 'opencode.db')
    await createOpenCodeDb(dbPath, (db) => {
      db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT)')
      insertOpenCodeMessage(db, 'm1', opencodeAssistantData({
        id: 'm1',
        created: 1758450000000,
        tokens: { input: 12, output: 34, reasoning: 0, cache: { read: 5, write: 6 } },
      }))
      insertOpenCodeMessage(db, 'm2', {
        id: 'm2',
        role: 'user',
        providerID: 'anthropic',
        modelID: 'claude-3-5-haiku',
        tokens: { input: 3, output: 1 },
      })
      insertOpenCodeMessage(db, 'm3', opencodeAssistantData({ id: 'm3' }))
    })

    const result = await scanUsageAdapters({ opencode: path.join(root, 'opencode') }, EMPTY_STATE)
    expect(result.statuses[2]).toMatchObject({ source: 'opencode-storage', status: 'ok' })
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toEqual({
      kind: 'tokens',
      at: new Date(1758450000000).toISOString(),
      source: 'opencode-storage',
      provider: 'anthropic',
      model: 'claude-3-5-haiku',
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: 5,
      cacheWriteTokens: 6,
      dedupeKey: 'opencode:opencode.db:message:1',
    })
    expect(result.state.offsets[`sqlite:${dbPath}:maxRowId`]).toBe(3)

    const second = await scanUsageAdapters({ opencode: path.join(root, 'opencode') }, result.state)
    expect(second.events).toHaveLength(0)
    expect(second.statuses[2]).toMatchObject({ source: 'opencode-storage', status: 'empty' })
  })

  it('nova mensagem inserida no banco emite só o novo evento', async () => {
    const dbPath = path.join(root, 'opencode', 'opencode.db')
    const { DatabaseSync } = await import('node:sqlite')
    await createOpenCodeDb(dbPath, (db) => {
      db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT)')
      insertOpenCodeMessage(db, 'm1', opencodeAssistantData({
        id: 'm1',
        tokens: { input: 10, output: 5 },
      }))
    })
    const first = await scanUsageAdapters({ opencode: path.join(root, 'opencode') }, EMPTY_STATE)
    expect(first.events).toHaveLength(1)

    const db = new DatabaseSync(dbPath, { readOnly: false })
    try {
      insertOpenCodeMessage(db, 'm2', opencodeAssistantData({
        id: 'm2',
        providerID: 'openai',
        modelID: 'gpt-5-mini',
        created: 1758450100000,
        tokens: { input: 7, output: 9 },
      }))
    } finally {
      db.close()
    }

    const second = await scanUsageAdapters({ opencode: path.join(root, 'opencode') }, first.state)
    expect(second.events).toHaveLength(1)
    expect(second.events[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-5-mini',
      inputTokens: 7,
      outputTokens: 9,
      dedupeKey: 'opencode:opencode.db:message:2',
    })
  })

  it('sem message.data usa os agregados da tabela session (e message sem data cai nele)', async () => {
    const dbPath = path.join(root, 'opencode-legacy', 'opencode.db')
    await createOpenCodeDb(dbPath, (db) => {
      db.exec(
        'CREATE TABLE message (id TEXT PRIMARY KEY)' +
        '; CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, tokens_input INTEGER,' +
        ' tokens_output INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, timestamp TEXT)'
      )
      db.prepare(
        'INSERT INTO session (id, directory, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, timestamp)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run('s1', '/tmp/a', 100, 50, 4, 2, '2026-09-21T09:30:00.000Z')
      db.prepare(
        'INSERT INTO session (id, directory, tokens_input, tokens_output, timestamp) VALUES (?, ?, ?, ?, ?)'
      ).run('s2', '/tmp/b', 200, 80, '2026-09-21T09:40:00.000Z')
      db.prepare('INSERT INTO session (id, directory, timestamp) VALUES (?, ?, ?)').run('s3', '/tmp/c', '2026-09-21T09:50:00.000Z')
    })

    const result = await scanUsageAdapters({ opencode: path.join(root, 'opencode-legacy') }, EMPTY_STATE)
    expect(result.events).toHaveLength(2)
    expect(result.events[0]).toMatchObject({
      source: 'opencode-storage',
      provider: 'opencode',
      model: 'opencode',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      at: '2026-09-21T09:30:00.000Z',
      dedupeKey: 'opencode:opencode.db:session:1',
    })
    expect(result.events[1]).toMatchObject({ inputTokens: 200, outputTokens: 80 })
  })

  it('banco sem tabelas esperadas gera status error', async () => {
    await createOpenCodeDb(path.join(root, 'opencode-other', 'opencode.db'), (db) => {
      db.exec('CREATE TABLE other (id TEXT PRIMARY KEY)')
    })
    const result = await scanUsageAdapters({ opencode: path.join(root, 'opencode-other') }, EMPTY_STATE)
    expect(result.statuses[2]).toMatchObject({ source: 'opencode-storage', status: 'error' })
    expect(result.statuses[2]?.message).toContain('Esquema')
    expect(result.events).toHaveLength(0)
  })

  it('descobre o banco no caminho XDG do perfil quando o diretório resolvido não o tem', async () => {
    await createOpenCodeDb(path.join(root, '.local', 'share', 'opencode', 'opencode.db'), (db) => {
      db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT)')
      insertOpenCodeMessage(db, 'm1', opencodeAssistantData({
        id: 'm1',
        tokens: { input: 5, output: 5 },
      }))
    })
    await mkdir(path.join(root, 'opencode-resolved'), { recursive: true })

    const result = await scanUsageAdapters({ opencode: path.join(root, 'opencode-resolved') }, EMPTY_STATE)
    expect(result.statuses[2]).toMatchObject({ source: 'opencode-storage', status: 'ok' })
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.dedupeKey).toContain(':message:1')
  })

  it('diretório existente sem banco fica empty com mensagem', async () => {
    await mkdir(path.join(root, 'opencode-empty'), { recursive: true })
    const result = await scanUsageAdapters({ opencode: path.join(root, 'opencode-empty') }, EMPTY_STATE)
    expect(result.statuses[2]).toMatchObject({ source: 'opencode-storage', status: 'empty' })
    expect(result.statuses[2]?.message).toContain('não encontrado')
  })
})

// ---------------------------------------------------------------------------
// Offsets
// ---------------------------------------------------------------------------

describe('offsets incrementais', () => {
  it('arquivo truncado é relido do zero', async () => {
    const file = path.join(root, 'claude', 'projects', 'proj-a', 'ses-1.jsonl')
    await writeJsonl(file, [
      claudeAssistantLine({ uuid: 'u-1', timestamp: '2026-09-21T10:00:00.000Z' }),
      claudeAssistantLine({ uuid: 'u-2', timestamp: '2026-09-21T10:01:00.000Z' }),
    ])
    const first = await scanUsageAdapters({ claude: path.join(root, 'claude') }, EMPTY_STATE)
    expect(first.events).toHaveLength(2)

    const shortLine = claudeAssistantLine({ uuid: 'u-1', timestamp: '2026-09-21T10:00:00.000Z' })
    await writeFile(file, `${shortLine}\n`, 'utf8')
    const second = await scanUsageAdapters({ claude: path.join(root, 'claude') }, first.state)
    expect(second.events).toHaveLength(1)
    expect(second.events[0]?.dedupeKey.endsWith(':u-1')).toBe(true)
    expect(second.state.offsets[file]).toBe(Buffer.byteLength(`${shortLine}\n`, 'utf8'))
  })

  it('offsets fazem round-trip pelo estado persistido (JSON)', async () => {
    const claudeFile = path.join(root, 'claude', 'projects', 'proj-a', 'ses-1.jsonl')
    const codexFile = path.join(root, 'codex', 'sessions', '2026', '09', '21', 'rollout-1.jsonl')
    await writeJsonl(claudeFile, [claudeAssistantLine({ uuid: 'u-1', timestamp: '2026-09-21T10:00:00.000Z' })])
    await writeJsonl(codexFile, [
      codexSessionMetaLine('gpt-5-codex'),
      codexTokenCountLine({
        ordinal: 2,
        timestamp: '2026-09-21T11:05:00.000Z',
        last: { inputTokens: 30, outputTokens: 20 },
        totals: { inputTokens: 100, outputTokens: 50 },
      }),
    ])

    const first = await scanUsageAdapters(
      { claude: path.join(root, 'claude'), codex: path.join(root, 'codex') },
      EMPTY_STATE
    )
    expect(first.events).toHaveLength(2)
    expect(Object.keys(first.state.offsets).sort()).toEqual([claudeFile, codexFile].sort())
    for (const value of Object.values(first.state.offsets)) {
      expect(typeof value).toBe('number')
    }

    const revived = JSON.parse(JSON.stringify(first.state)) as UsageScanState
    const second = await scanUsageAdapters(
      { claude: path.join(root, 'claude'), codex: path.join(root, 'codex') },
      revived
    )
    expect(second.events).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Status e limites
// ---------------------------------------------------------------------------

describe('status e limites', () => {
  it('arquivo no lugar do subdiretório esperado gera status error', async () => {
    await mkdir(path.join(root, 'claude'), { recursive: true })
    await writeFile(path.join(root, 'claude', 'projects'), 'não sou um diretório', 'utf8')

    const result = await scanUsageAdapters({ claude: path.join(root, 'claude') }, EMPTY_STATE)
    expect(result.statuses[0]).toMatchObject({ source: 'claude-transcripts', status: 'error' })
    expect(result.statuses[0]?.message).toBeTruthy()
    expect(result.events).toHaveLength(0)
  })

  it('gemini permanece missing até existir adaptador', async () => {
    await mkdir(path.join(root, 'gemini'), { recursive: true })
    const result = await scanUsageAdapters({ gemini: path.join(root, 'gemini') }, EMPTY_STATE)
    const gemini = result.statuses.find((status) => status.source === 'gemini-local')
    expect(gemini).toMatchObject({
      source: 'gemini-local',
      status: 'missing',
      message: 'Sem dados locais de tokens (Gemini CLI não persiste uso).',
    })
  })

  it('reporta os status na ordem do contrato', async () => {
    const result = await scanUsageAdapters({}, EMPTY_STATE)
    expect(result.statuses.map((status) => status.source)).toEqual([
      'claude-transcripts',
      'codex-rollouts',
      'opencode-storage',
      'gemini-local',
    ])
  })

  it('teto de eventos por varredura mantém os mais recentes', async () => {
    const total = USAGE_MAX_EVENTS_PER_SCAN + 10
    const lines: string[] = []
    for (let index = 0; index < total; index += 1) {
      lines.push(
        claudeAssistantLine({
          uuid: `u-${index}`,
          timestamp: new Date(Date.UTC(2026, 8, 21, 12, 0, 0) + index * 1000).toISOString(),
          usage: { input_tokens: index, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: index },
        })
      )
    }
    await writeJsonl(path.join(root, 'claude', 'projects', 'proj-a', 'big.jsonl'), lines)

    const result = await scanUsageAdapters({ claude: path.join(root, 'claude') }, EMPTY_STATE)
    expect(result.events).toHaveLength(USAGE_MAX_EVENTS_PER_SCAN)
    expect(result.events[0]?.dedupeKey.endsWith(':u-10')).toBe(true)
    expect(result.events[0]?.inputTokens).toBe(10)
    expect(result.events[result.events.length - 1]?.dedupeKey.endsWith(`:u-${total - 1}`)).toBe(true)
  })
})
