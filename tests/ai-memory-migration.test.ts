import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Captura o execFile REAL usado pelo defaultGitRunner para provar que o git
// read-only roda com o env mínimo (sem BYOK/tokens herdados do main).
const execFileSpies = vi.hoisted(() => ({ calls: [] as Array<{ command: string; args: string[]; options: unknown }> }))
vi.mock('node:child_process', () => ({
  execFile: (command: string, args: readonly string[], options: unknown, callback: unknown) => {
    execFileSpies.calls.push({ command, args: [...args], options })
    const cb = callback as (error: Error | null, result: { stdout: string; stderr: string }) => void
    queueMicrotask(() => cb(null, { stdout: 'ok', stderr: '' }))
    return {}
  },
}))

import {
  buildMigratedBody,
  isLegacyWriterReadOnly,
  listGitWorktrees,
  loadMigrationReceipt,
  migrateProjectLegacyMemory,
  migrationPagePath,
  migrationReceiptPath,
  readLegacyMemoryFiles,
  readMigrationReceiptState,
  runLegacyMigration,
  slugifyPageSegment,
  sourcesFromLegacyFiles,
  sourcesFromWorktrees,
  truncateBody,
  validateLinkedWorktree,
  defaultGitRunner,
  type GitRunner,
  type MigrationMemoryClient,
  type MigrationTarget,
} from '../src/main/ai-memory-migration'

interface WriteCall {
  workspace: unknown
  project: unknown
  path: unknown
  body: unknown
  tags?: unknown
}

function createMockClient(options: {
  failWriteOnPath?: string
  failReadOnPath?: string
} = {}): { client: MigrationMemoryClient; writes: WriteCall[]; pages: Map<string, string> } {
  const writes: WriteCall[] = []
  const pages = new Map<string, string>()
  const client: MigrationMemoryClient = {
    callTool: async (name, args) => {
      if (name === 'memory_write_page') {
        const pagePath = String(args.path)
        if (options.failWriteOnPath === pagePath) {
          return { text: 'erro simulado', isError: true }
        }
        writes.push({
          workspace: args.workspace,
          project: args.project,
          path: args.path,
          body: args.body,
          tags: args.tags,
        })
        pages.set(pagePath, String(args.body))
        return { text: 'ok', isError: false }
      }
      // memory_read_page — envelope real v2.4.0: text=json+json object
      const pagePath = String(args.path)
      if (options.failReadOnPath === pagePath || !pages.has(pagePath)) {
        return { text: '', isError: true }
      }
      const stored = pages.get(pagePath) ?? ''
      const envelope = { path: pagePath, body: stored }
      return { text: JSON.stringify(envelope), json: envelope, isError: false }
    },
  }
  return { client, writes, pages }
}

let userDataDir = ''
const tempRoots: string[] = []

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  tempRoots.push(root)
  return root
}

/** GitRunner read-only: common-dir fixo e show-toplevel = cwd (ou override). */
function linkedGitRunner(
  commonDir: string,
  topLevelFor?: (cwd: string) => string | undefined
): GitRunner {
  return async (args, cwd) => {
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return commonDir
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      const top = topLevelFor ? topLevelFor(cwd) : cwd
      if (!top) throw new Error('not a worktree')
      return top
    }
    throw new Error(`unexpected git ${args.join(' ')}`)
  }
}

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-migration-'))
})

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true })
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function targetFor(client: MigrationMemoryClient): MigrationTarget {
  return { scope: { workspace: 'devorbit', project: 'p-abc' }, client }
}

describe("migração legacy → ai-memory (FASE 3)", () => {
  it("mapeia taxonomia: operational/md→procedures, episodic→sessions, reflexive→gotchas", () => {
    const sources = sourcesFromLegacyFiles('# memoria', [
      { kind: 'operational', content: 'a' },
      { kind: 'episodic', content: 'b' },
      { kind: 'reflexive', content: 'c' },
    ])
    expect(sources).toHaveLength(4)
    expect(sources[0]).toMatchObject({ source: 'memory.md', namespace: 'procedures' })
    expect(sources[1]).toMatchObject({ namespace: 'procedures' })
    expect(sources[2]).toMatchObject({ namespace: 'sessions' })
    expect(sources[3]).toMatchObject({ namespace: 'gotchas' })
  })

  it('gera path determinístico por source+hash e slug conservador', () => {
    const first = migrationPagePath('memory.json#episodic (2026-01-01)', 'sessions', 'corpo')
    const second = migrationPagePath('memory.json#episodic (2026-01-01)', 'sessions', 'corpo')
    expect(first).toBe(second)
    expect(first).toMatch(/^sessions\/[a-z0-9._-]+\.md$/)
    expect(migrationPagePath('x', 'sessions', 'a')).not.toBe(migrationPagePath('x', 'sessions', 'b'))
    expect(slugifyPageSegment("Título Éstranho!!")).toBe("titulo-estranho")
    expect(slugifyPageSegment('!!!')).toBe('sem-nome')
  })

  it('redige segredo no body importado e trunca payloads', () => {
    const body = buildMigratedBody('memory.md', 'token sk-abcdef123456 e apiKey: "xyz987654321"')
    expect(body).not.toContain('sk-abcdef123456')
    expect(body).toContain("NÃO confiável")
    const huge = 'x'.repeat(70_000)
    expect(truncateBody(huge).length).toBeLessThanOrEqual(60_000)
    expect(truncateBody('curto')).toBe('curto')
  })

  it('migra com tags historical/do-not-answer-from e grava receipt só após todas as páginas', async () => {
    const { client, writes } = createMockClient()
    const outcome = await runLegacyMigration({
      userDataDir,
      identity: 'remote:github.com/o/r',
      target: targetFor(client),
      markdown: '# estado legado',
      jsonEntries: [{ kind: 'episodic', content: 'evento' }],
    })
    expect(outcome.status).toBe('migrated')
    expect(outcome.paths).toHaveLength(2)
    for (const call of writes) {
      expect(call.tags).toEqual(['historical', 'do-not-answer-from'])
      expect(call.workspace).toBe('devorbit')
      expect(call.project).toBe('p-abc')
    }
    const receipt = await loadMigrationReceipt(userDataDir, 'remote:github.com/o/r')
    expect(receipt?.paths).toEqual(outcome.paths)
    // Receipt é só metadado: nenhum conteúdo de memória gravado localmente.
    const raw = await fs.readFile(migrationReceiptPath(userDataDir, 'remote:github.com/o/r'), 'utf8')
    expect(raw).not.toContain('estado legado')
    expect(raw).not.toContain('evento')
  })

  it('é idempotente: repetir migração após receipt não regrava (sem dual-write)', async () => {
    const { client, writes } = createMockClient()
    await runLegacyMigration({
      userDataDir,
      identity: 'path:/tmp/proj',
      target: targetFor(client),
      markdown: 'conteúdo',
    })
    const writesAfterFirst = writes.length
    const second = await runLegacyMigration({
      userDataDir,
      identity: 'path:/tmp/proj',
      target: targetFor(client),
      markdown: 'conteúdo',
    })
    expect(second.status).toBe('already-migrated')
    expect(writes.length).toBe(writesAfterFirst)
    expect(await isLegacyWriterReadOnly(userDataDir, 'path:/tmp/proj')).toBe(true)
  })

  it('crash antes do receipt regrava os MESMOS paths (idempotência por source+hash)', async () => {
    const pathsFromFirstRun: string[][] = []
    // Tentativa 1: última página falha (simula crash pós-write parcial).
    const failing = createMockClient({ failWriteOnPath: undefined })
    // Simula crash: writePage OK para a 1ª página, depois o processo "morre"
  // — simulado por um segundo cliente que refaz TUDO do zero.
    const first = await runLegacyMigration({
      userDataDir,
      identity: 'crash-proj',
      target: targetFor(failing.client),
      markdown: 'linha um',
      jsonEntries: [{ kind: 'episodic', content: 'episódio' }],
    })
    expect(first.status).toBe('migrated')
    pathsFromFirstRun.push(first.paths)

    // Receipt corrompido = crash ANTES da receipt: reprocessa tudo.
    await fs.writeFile(
      migrationReceiptPath(userDataDir, 'path-crash'),
      '{ corrompido',
      'utf8'
    )
    const retry = createMockClient()
    const second = await runLegacyMigration({
      userDataDir,
      identity: 'path-crash',
      target: targetFor(retry.client),
      markdown: 'linha um',
      jsonEntries: [{ kind: 'episodic', content: 'episódio' }],
    })
    expect(second.status).toBe('migrated')
    // Paths determinísticos: idênticos aos da primeira execução.
    expect(second.paths).toEqual(pathsFromFirstRun[0])
    expect(retry.writes.length).toBe(2)
  })

  it('falha parcial (write ou read-back) NÒO grava receipt', async () => {
    const outcomeWrite = await runLegacyMigration({
      userDataDir,
      identity: 'fail-write',
      target: targetFor({
        callTool: async () => ({ text: 'erro', isError: true }),
      }),
      jsonEntries: [{ kind: 'episodic', content: 'alvo' }],
    })
    expect(outcomeWrite.status).toBe('failed')
    expect(await loadMigrationReceipt(userDataDir, 'fail-write')).toBeUndefined()

    const outcomeRead = await runLegacyMigration({
      userDataDir,
      identity: 'fail-read',
      target: targetFor({
        callTool: async (name, args) => {
          if (name === 'memory_write_page') {
            void args
            return { text: 'ok', isError: false }
          }
          return { text: '', isError: true }
        },
      }),
      markdown: 'conteúdo',
    })
    expect(outcomeRead.status).toBe('failed')
    expect(outcomeRead.message).toContain('Read-back')
    expect(await isLegacyWriterReadOnly(userDataDir, 'fail-read')).toBe(false)
  })

  it('read-back sem json.body (formato antigo text-only) falha explicitamente', async () => {
    const { writes } = createMockClient()
    // Override o mock para retornar APENAS text (formato antigo, sem json.body).
    const textOnlyClient: MigrationMemoryClient = {
      callTool: async (name, args) => {
        if (name === 'memory_write_page') {
          writes.push({ ...args } as never)
          return { text: 'ok', isError: false }
        }
        // Formato antigo: só text, sem json
        return { text: JSON.stringify({ path: args.path, body: 'conteúdo antigo' }), isError: false }
      },
    }
    const outcome = await runLegacyMigration({
      userDataDir,
      identity: 'old-format',
      target: { scope: { workspace: 'w', project: 'p' }, client: textOnlyClient },
      markdown: 'conteúdo',
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toContain('Read-back')
    expect(await loadMigrationReceipt(userDataDir, 'old-format')).toBeUndefined()
  })

  it("sem conteúdo legado → skipped-empty, sem receipt", async () => {
    const { client, writes } = createMockClient()
    const outcome = await runLegacyMigration({
      userDataDir,
      identity: 'vazio',
      target: targetFor(client),
      markdown: '   ',
      jsonEntries: [{ kind: 'episodic', content: '   ' }],
    })
    expect(outcome.status).toBe('skipped-empty')
    expect(writes.length).toBe(0)
    expect(await isLegacyWriterReadOnly(userDataDir, 'vazio')).toBe(false)
  })

  it('import repetido do MESMO conteúdo regrava o mesmo path (sem duplicar página)', async () => {
    const first = await runLegacyMigration({
      userDataDir,
      identity: 'rep-a',
      target: targetFor(createMockClient().client),
      markdown: 'mesmo conteúdo',
    })
    const secondClient = createMockClient()
    const second = await runLegacyMigration({
      userDataDir,
      identity: 'rep-b',
      target: targetFor(secondClient.client),
      markdown: 'mesmo conteúdo',
    })
    expect(first.paths).toEqual(second.paths)
    expect(secondClient.writes.length).toBe(1)
  })
})

  describe("receipt backup (.bak) — janela de crash (fail-closed)", () => {
  let dir = ''
  const IDENTITY = 'remote:github.com/o/r'

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-migration-crash-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  /** Migra uma vez e simula o crash: primária removida, backup válido no `.bak`. */
  async function crashFixture(): Promise<{ receiptPath: string }> {
    const receiptPath = migrationReceiptPath(dir, IDENTITY)
    const { client } = createMockClient()
    await runLegacyMigration({
      userDataDir: dir,
      identity: IDENTITY,
      target: targetFor(client),
      markdown: '# estado legado',
    })
    const primary = await fs.readFile(receiptPath, 'utf8')
    await fs.writeFile(`${receiptPath}.bak`, primary, 'utf8')
    await fs.rm(receiptPath)
    return { receiptPath }
  }

  it('somente backup válido mantém o writer read-only e restaura o canônico', async () => {
    const { receiptPath } = await crashFixture()
    const state = await readMigrationReceiptState(dir, IDENTITY)
    expect(state.status).toBe('present')
  // Restauração idempotente por CÓPIA: canônico == backup, backup preservado.
    expect(await fs.readFile(receiptPath, 'utf8')).toBe(
      await fs.readFile(`${receiptPath}.bak`, 'utf8')
    )
    expect(await isLegacyWriterReadOnly(dir, IDENTITY)).toBe(true)
  })

  it('backup corrompido NÒO marca migrated, NÒO apaga e NÒO libera legado', async () => {
    const { receiptPath } = await crashFixture()
    const corrupted = '{ receipt quebrada'
    await fs.writeFile(`${receiptPath}.bak`, corrupted, 'utf8')

    const state = await readMigrationReceiptState(dir, IDENTITY)
    expect(state.status).toBe('error')
    // Nada promovido nem apagado: primária continua ausente, backup intacto.
    await expect(fs.readFile(receiptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(`${receiptPath}.bak`, 'utf8')).toBe(corrupted)
    // O run também não adota backup inválido; o gate fica fail-closed (read-only).
    expect(await loadMigrationReceipt(dir, IDENTITY)).toBeUndefined()
    expect(await isLegacyWriterReadOnly(dir, IDENTITY)).toBe(true)
  })

  it('backup de outra identidade não é adotado (estado incerto, fail-closed)', async () => {
    const { receiptPath } = await crashFixture()
    const foreign = JSON.stringify({
      version: 1,
      workspace: 'devorbit',
      project: 'p-abc',
      identityHash: 'deadbeefdeadbeefdeadbeefdeadbeef',
      sources: {},
      paths: [],
      concludedAt: new Date().toISOString(),
    })
    await fs.writeFile(`${receiptPath}.bak`, foreign, 'utf8')

    const state = await readMigrationReceiptState(dir, IDENTITY)
    expect(state.status).toBe('error')
    await expect(fs.readFile(receiptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(`${receiptPath}.bak`, 'utf8')).toBe(foreign)
    expect(await isLegacyWriterReadOnly(dir, IDENTITY)).toBe(true)
  })

  it('rerun após crash com somente backup válido é incremental e idempotente (zero writes)', async () => {
    const { receiptPath } = await crashFixture()
    const { client, writes } = createMockClient()
    const second = await runLegacyMigration({
      userDataDir: dir,
      identity: IDENTITY,
      target: targetFor(client),
      markdown: '# estado legado',
    })
    expect(second.status).toBe('already-migrated')
    expect(writes).toHaveLength(0)
    // Receipt primária recriada pela recuperação; estado segue 'present'.
    expect((await fs.readFile(receiptPath, 'utf8')).length).toBeGreaterThan(0)
    expect((await readMigrationReceiptState(dir, IDENTITY)).status).toBe('present')
  })

  it('regressão Windows: recupera .bak e a migração incremental substitui a primária ATOMICAMENTE com .bak presente', async () => {
    const { receiptPath } = await crashFixture()
    // Recuperação OK: primária restaurada a partir do backup.
    expect((await readMigrationReceiptState(dir, IDENTITY)).status).toBe('present')

  // Migração incremental com worktree NOVA — substituição atômica da
    // primária ENQUANTO o .bak ainda existe (Windows: rename substitui
    // existente; sem fallback indevido nem perda do backup).
    const { client, writes } = createMockClient()
    const outcome = await runLegacyMigration({
      userDataDir: dir,
      identity: IDENTITY,
      target: targetFor(client),
      worktrees: [
        { root: '/repo/main', isPrimary: true, files: { markdown: '# estado legado' } },
        { root: '/repo/wt-nova', files: { markdown: 'legado da worktree nova' } },
      ],
    })
    expect(outcome.status).toBe('migrated')
    // Só a fonte NOVA é escrita; o retorno lista as paths MERGADAS (todas).
    expect(writes).toHaveLength(1)
    expect(outcome.paths).toHaveLength(2)

    // Receipt primária acompanha AMBAS as fontes.
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8')) as {
      sources: Record<string, string>
      paths: string[]
    }
    expect(Object.keys(receipt.sources)).toHaveLength(2)
    expect(Object.keys(receipt.sources)).toContain('memory.md')
    expect(Object.keys(receipt.sources).some((key) => key.includes('@wt:'))).toBe(true)
    expect(receipt.paths).toHaveLength(2)

    // Backup continua no disco com a receipt PRÃ‰-incremental (nunca apagado
    // pela recuperação, nunca destruído pela escrita atômica).
    const backup = JSON.parse(await fs.readFile(`${receiptPath}.bak`, 'utf8')) as {
      sources: Record<string, string>
      paths: string[]
    }
    expect(Object.keys(backup.sources)).toEqual(['memory.md'])
    expect(backup.paths).toHaveLength(1)
    expect((await readMigrationReceiptState(dir, IDENTITY)).status).toBe('present')
    expect(await isLegacyWriterReadOnly(dir, IDENTITY)).toBe(true)
  })

  it('I/O incerto na primária NÒO é tratado como "sem receipt" (run aborta sem sobrescrever)', async () => {
    // Diretório no lugar do arquivo: readFile falha com erro real (não ENOENT)
    // de forma determinística em qualquer plataforma (Windows incluído).
    const receiptPath = migrationReceiptPath(dir, IDENTITY)
    await fs.mkdir(receiptPath, { recursive: true })

    const { client, writes } = createMockClient()
    const outcome = await runLegacyMigration({
      userDataDir: dir,
      identity: IDENTITY,
      target: targetFor(client),
      markdown: 'conteúdo que NÒO pode ser importado sobre estado incerto',
    })

    expect(outcome.status).toBe('failed')
    expect(outcome.message).toContain('incerto')
    expect(writes).toHaveLength(0)
    // Estado incerto preservado byte-a-byte (o diretório segue no lugar).
    expect((await fs.stat(receiptPath)).isDirectory()).toBe(true)
    // Gate permanece fail-closed.
    expect((await readMigrationReceiptState(dir, IDENTITY)).status).toBe('error')
    expect(await isLegacyWriterReadOnly(dir, IDENTITY)).toBe(true)
  })
})

describe('leitura do legado real (memory.json StoredMemory v1)', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-legacy-v1-'))
    tempRoots.push(dir)
  })

  it("lê {version:1, entries:[...]} preservando kind/content/timestamps; array legado continua aceito; corrompido → undefined sem apagar", async () => {
    const root = dir
    const jsonPath = path.join(root, '.devorbit', 'memory.json')
    await fs.mkdir(path.dirname(jsonPath), { recursive: true })
    const entry = (id: string, kind: string, content: string) => ({
      id,
      kind,
      content,
      tags: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    await fs.writeFile(
      jsonPath,
      JSON.stringify({
        version: 1,
        entries: [
          entry('op-1', 'operational', 'procedimento principal'),
          entry('ep-1', 'episodic', 'evento do turno'),
          entry('rf-1', 'reflexive', 'lição reflexiva'),
        ],
      })
    )
    const files = await readLegacyMemoryFiles(root)
    expect(files.jsonEntries).toHaveLength(3)
    expect(files.jsonEntries?.map((item) => item.kind)).toEqual(['operational', 'episodic', 'reflexive'])
    expect(files.jsonEntries?.[0]).toMatchObject({
      content: 'procedimento principal',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })

    // Forma array (anterior ao StoredMemory) continua aceita.
    await fs.writeFile(jsonPath, JSON.stringify([{ kind: 'episodic', content: 'antigo' }]))
    expect((await readLegacyMemoryFiles(root)).jsonEntries).toEqual([{ kind: 'episodic', content: 'antigo' }])

  // Corrompido → sem entradas e o arquivo NÃO é apagado.
    await fs.writeFile(jsonPath, '{ corrompido')
    expect((await readLegacyMemoryFiles(root)).jsonEntries).toBeUndefined()
    expect(await fs.readFile(jsonPath, 'utf8')).toBe('{ corrompido')

  // Versão de StoredMemory estranha (futura) → sem entradas, arquivo intacto.
    await fs.writeFile(jsonPath, JSON.stringify({ version: 2, entries: [entry('x', 'operational', 'y')] }))
    expect((await readLegacyMemoryFiles(root)).jsonEntries).toBeUndefined()
    expect(JSON.parse(await fs.readFile(jsonPath, 'utf8'))).toMatchObject({ version: 2 })
  })

  it('fluxo de migração com payload REAL v1: namespaces, redação e idempotência', async () => {
    const root = dir
    const canary = 'sk-CANARIOabcdef123'
    await fs.mkdir(path.join(root, '.devorbit'), { recursive: true })
    await fs.writeFile(path.join(root, '.devorbit', 'memory.md'), `# memoria\napi_key=${canary}`)
    await fs.writeFile(
      path.join(root, '.devorbit', 'memory.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'op-1',
            kind: 'operational',
            content: `rotação do cache com ${canary}`,
            tags: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'ep-1',
            kind: 'episodic',
            content: 'deploy falhou por timeout',
            tags: [],
            createdAt: '2026-01-01T01:00:00.000Z',
            updatedAt: '2026-01-01T01:00:00.000Z',
          },
          {
            id: 'rf-1',
            kind: 'reflexive',
            content: 'diagnosticar antes de reexecutar',
            tags: [],
            createdAt: '2026-01-01T02:00:00.000Z',
            updatedAt: '2026-01-01T02:00:00.000Z',
          },
        ],
      })
    )

    // Fluxo REAL: o leitor de produção alimenta a migração (payload do disco).
    const files = await readLegacyMemoryFiles(root)
    expect(files.jsonEntries).toHaveLength(3)
    const { client, writes } = createMockClient()
    const first = await runLegacyMigration({
      userDataDir,
      identity: 'remote:github.com/o/real',
      target: targetFor(client),
      markdown: files.markdown,
      jsonEntries: files.jsonEntries,
    })
    expect(first.status).toBe('migrated')
  // memory.md + operational → procedures; episodic → sessions; reflexive → gotchas.
    expect(writes.filter((w) => String(w.path).startsWith('procedures/'))).toHaveLength(2)
    expect(writes.some((w) => String(w.path).startsWith('sessions/'))).toBe(true)
    expect(writes.some((w) => String(w.path).startsWith('gotchas/'))).toBe(true)
    // Redação: o canário não sobrevive em NENHUMA página; tags históricas em todas.
    for (const w of writes) {
      expect(String(w.body)).not.toContain(canary)
      expect(w.tags).toEqual(['historical', 'do-not-answer-from'])
    }
  // Idempotência: mesma payload → already-migrated, zero escritas novas.
    const writesAfterFirst = writes.length
    const second = await runLegacyMigration({
      userDataDir,
      identity: 'remote:github.com/o/real',
      target: targetFor(client),
      markdown: files.markdown,
      jsonEntries: files.jsonEntries,
    })
    expect(second.status).toBe('already-migrated')
    expect(writes).toHaveLength(writesAfterFirst)
  })
})

describe('worktrees vinculadas (mesma identidade ai-memory)', () => {
  it("listGitWorktrees: raiz atual sempre primeiro e dedupe; git falho → só a atual", async () => {
    const runner: GitRunner = async () =>
      [
        'worktree /repo/main',
        'HEAD 1234',
        'branch refs/heads/main',
        '',
        'worktree /repo/wt-2',
        'detached',
        '',
        'worktree /repo/main',
      ].join('\n')
    const roots = await listGitWorktrees('/repo/main', runner)
    expect(roots).toHaveLength(2)
    expect(roots[0]).toBe(path.resolve('/repo/main'))
    expect(roots[1]).toBe(path.resolve('/repo/wt-2'))
    const failing: GitRunner = async () => {
      throw new Error('git off')
    }
    expect(await listGitWorktrees('/repo/main', failing)).toEqual([path.resolve('/repo/main')])
  })

  it('sourcesFromWorktrees: primária mantém labels canônicos; secundárias ganham @wt:<slug>', () => {
    const sources = sourcesFromWorktrees([
      { root: '/repo/main', isPrimary: true, files: { markdown: '# principal' } },
      {
        root: '/repo/wt-2',
        files: { markdown: '# secundária', jsonEntries: [{ kind: 'episodic', content: 'evento wt2' }] },
      },
    ])
    expect(sources.map((source) => source.source)).toEqual([
      'memory.md',
      'memory.md@wt:wt-2',
      'memory.json#episodic@wt:wt-2',
    ])
    expect(sources.every((source) => source.namespace === 'procedures' || source.namespace === 'sessions')).toBe(true)
  })

  it('runLegacyMigration com worktrees: importa todas as raízes em paths distintos', async () => {
    const { client, writes } = createMockClient()
    const outcome = await runLegacyMigration({
      userDataDir,
      identity: 'git-common-dir:/repo/.git',
      target: targetFor(client),
      worktrees: [
        { root: '/repo/main', isPrimary: true, files: { markdown: 'conteúdo principal' } },
        { root: '/repo/wt-2', files: { markdown: 'conteúdo da wt-2' } },
      ],
    })
    expect(outcome.status).toBe('migrated')
    expect(outcome.paths).toHaveLength(2)
    expect(writes.some((write) => String(write.path).startsWith('procedures/memory.md-'))).toBe(true)
    expect(writes.some((write) => String(write.path).startsWith('procedures/memory.md-wt-wt-2-'))).toBe(true)
    // Sem colisão: paths distintos.
    expect(new Set(outcome.paths).size).toBe(2)
  })

  it('worktree vinculada adicionada DEPOIS da receipt: import incremental, re-run idempotente', async () => {
    const client = createMockClient()
    const first = await runLegacyMigration({
      userDataDir,
      identity: 'git-common-dir:/repo/.git',
      target: targetFor(client.client),
      markdown: 'somente a principal',
    })
    expect(first.status).toBe('migrated')
    const writesAfterFirst = client.writes.length

    // Worktree nova aparece DEPOIS da receipt (mesma identidade).
    const second = await runLegacyMigration({
      userDataDir,
      identity: 'git-common-dir:/repo/.git',
      target: targetFor(client.client),
      worktrees: [
        { root: '/repo/main', isPrimary: true, files: { markdown: 'somente a principal' } },
        { root: '/repo/wt-new', files: { markdown: 'legado da wt nova' } },
      ],
    })
    expect(second.status).toBe('migrated')
    expect(second.message).toContain('worktrees')
    expect(second.paths).toHaveLength(first.paths.length + 1)
    expect(client.writes.length).toBe(writesAfterFirst + 1)

    // Re-run idêntico: nada novo (already-migrated), zero writes.
    const third = await runLegacyMigration({
      userDataDir,
      identity: 'git-common-dir:/repo/.git',
      target: targetFor(client.client),
      worktrees: [
        { root: '/repo/main', isPrimary: true, files: { markdown: 'somente a principal' } },
        { root: '/repo/wt-new', files: { markdown: 'legado da wt nova' } },
      ],
    })
    expect(third.status).toBe('already-migrated')
    expect(client.writes.length).toBe(writesAfterFirst + 1)
  })

  it('M1: worktree VÁLIDA fora do projectPath (mesmo common-dir) é importada', async () => {
    const primary = await makeRoot('devorbit-mig-primary-')
    const worktree = await makeRoot('devorbit-mig-wt-')
    const common = path.join(primary, '.git')
    const reads: string[] = []
    const client = createMockClient()
    const outcome = await migrateProjectLegacyMemory({
      userDataDir,
      projectPath: primary,
      scope: { workspace: 'devorbit', project: 'p-abc', identity: 'git-common-dir:/repo/.git' },
      client: client.client,
      isProjectEnabled: () => true,
      worktreeRoots: async () => [primary, worktree],
      gitRunner: linkedGitRunner(common),
      readLegacyFiles: async (root) => {
        reads.push(root)
        return root === worktree ? { markdown: 'legado da worktree externa' } : { markdown: 'legado principal' }
      },
    })
    expect(outcome.status).toBe('migrated')
    expect(outcome.paths).toHaveLength(2)
    expect(reads).toContain(worktree)
    expect(outcome.paths.some((pagePath) => pagePath.startsWith('procedures/memory.md-wt-'))).toBe(true)
  })

  it('M1: path registrado inexistente é excluído ANTES de readLegacyFiles', async () => {
    const primary = await makeRoot('devorbit-mig-primary-')
    const missing = path.join(os.tmpdir(), `devorbit-mig-missing-${Date.now()}`)
    const reads: string[] = []
    const client = createMockClient()
    const outcome = await migrateProjectLegacyMemory({
      userDataDir,
      projectPath: primary,
      scope: { workspace: 'devorbit', project: 'p-abc', identity: 'git-common-dir:/repo/.git' },
      client: client.client,
      isProjectEnabled: () => true,
      worktreeRoots: async () => [primary, missing],
      gitRunner: linkedGitRunner(path.join(primary, '.git')),
      readLegacyFiles: async (root) => {
        reads.push(root)
        return { markdown: 'legado' }
      },
    })
    expect(outcome.status).toBe('migrated')
    expect(outcome.paths).toHaveLength(1)
    expect(reads).toEqual([primary])
  })

  it('M1: worktree de OUTRO repositório (common-dir diferente) é excluída', async () => {
    const primary = await makeRoot('devorbit-mig-primary-')
    const other = await makeRoot('devorbit-mig-other-')
    const common = path.join(primary, '.git')
    const reads: string[] = []
    const runner: GitRunner = async (args, cwd) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return cwd === other ? path.join(other, '.git') : common
      }
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return cwd
      throw new Error(`unexpected git ${args.join(' ')}`)
    }
    const client = createMockClient()
    const outcome = await migrateProjectLegacyMemory({
      userDataDir,
      projectPath: primary,
      scope: { workspace: 'devorbit', project: 'p-abc', identity: 'git-common-dir:/repo/.git' },
      client: client.client,
      isProjectEnabled: () => true,
      worktreeRoots: async () => [primary, other],
      gitRunner: runner,
      readLegacyFiles: async (root) => {
        reads.push(root)
        return { markdown: 'legado' }
      },
    })
    expect(outcome.status).toBe('migrated')
    expect(outcome.paths).toHaveLength(1)
    expect(reads).toEqual([primary])
  })

  it('M1: --show-toplevel divergente (não é a própria raiz) é excluído', async () => {
    const primary = await makeRoot('devorbit-mig-primary-')
    const fake = await makeRoot('devorbit-mig-fake-')
    const reads: string[] = []
  // top-level aponta para a primária → a "raiz" registrada não é worktree real.
    const runner = linkedGitRunner(path.join(primary, '.git'), () => primary)
    const client = createMockClient()
    const outcome = await migrateProjectLegacyMemory({
      userDataDir,
      projectPath: primary,
      scope: { workspace: 'devorbit', project: 'p-abc', identity: 'git-common-dir:/repo/.git' },
      client: client.client,
      isProjectEnabled: () => true,
      worktreeRoots: async () => [primary, fake],
      gitRunner: runner,
      readLegacyFiles: async (root) => {
        reads.push(root)
        return { markdown: 'legado' }
      },
    })
    expect(outcome.status).toBe('migrated')
    expect(outcome.paths).toHaveLength(1)
    expect(reads).toEqual([primary])
  })

  it('M1: Git off preserva somente a primária (fail-graceful, sem quebra)', async () => {
    const primary = await makeRoot('devorbit-mig-primary-')
    const worktree = await makeRoot('devorbit-mig-wt-')
    const reads: string[] = []
    const client = createMockClient()
    const outcome = await migrateProjectLegacyMemory({
      userDataDir,
      projectPath: primary,
      scope: { workspace: 'devorbit', project: 'p-abc', identity: 'git-common-dir:/repo/.git' },
      client: client.client,
      isProjectEnabled: () => true,
      worktreeRoots: async () => [primary, worktree],
      gitRunner: async () => {
        throw new Error('git off')
      },
      readLegacyFiles: async (root) => {
        reads.push(root)
        return { markdown: 'legado' }
      },
    })
    expect(outcome.status).toBe('migrated')
    expect(outcome.paths).toHaveLength(1)
    expect(reads).toEqual([primary])
  })

  it('validateLinkedWorktree: aceita a mesma raiz/common-dir e rejeita divergências', async () => {
    const root = await makeRoot('devorbit-mig-v-')
    const common = path.join(root, '.git')
    expect(await validateLinkedWorktree(root, common, linkedGitRunner(common))).toBe(true)
    expect(
      await validateLinkedWorktree(root, path.join(os.tmpdir(), 'other', '.git'), linkedGitRunner(common))
    ).toBe(false)
    expect(
      await validateLinkedWorktree(path.join(os.tmpdir(), `nope-${Date.now()}`), common, linkedGitRunner(common))
    ).toBe(false)
    expect(
      await validateLinkedWorktree(root, common, async () => {
        throw new Error('git off')
      })
    ).toBe(false)
  })
})

describe('defaultGitRunner — env mínimo (helper), sem BYOK/tokens', () => {
  it('executa git com env filtrado: variável de busca do SO presente, segredos ausentes', async () => {
    const previousKey = process.env.MIGRATION_SECRET_SENTINEL
    process.env.MIGRATION_SECRET_SENTINEL = 'sk-secret-token-123'
    try {
      execFileSpies.calls.length = 0
      await defaultGitRunner()(['rev-parse', '--show-toplevel'], 'C:\\repo')

      expect(execFileSpies.calls).toHaveLength(1)
      const call = execFileSpies.calls[0]
      expect(call.command).toBe('git')
      expect(call.args).toEqual(['rev-parse', '--show-toplevel'])
      const options = call.options as { env: NodeJS.ProcessEnv; timeout: number; shell: boolean; windowsHide: boolean }
      expect(options.shell).toBe(false)
      expect(options.timeout).toBe(8_000)
      expect(options.windowsHide).toBe(true)
      // Variável de busca de executáveis do SO: `PATH` (POSIX) / `Path`
      // (Windows). Assert case-insensitive porque o Windows usa `Path`.
      const envKey = (name: string): string | undefined =>
        Object.keys(options.env).find((key) => key.toLowerCase() === name.toLowerCase())
      const searchVar = process.platform === 'win32' ? 'Path' : 'PATH'
      expect(envKey(searchVar)).toBeDefined()
      expect(options.env[envKey(searchVar) as string]).toBe(process.env[envKey(searchVar) as string])
      if (process.platform === 'win32') {
        expect(envKey('SystemRoot')).toBeDefined()
      } else {
        expect(envKey('HOME')).toBeDefined()
      }
      // Nenhum segredo do main vaza para o subprocesso git.
      expect(JSON.stringify(options.env)).not.toContain('sk-secret-token-123')
      // E a busca case-insensitive não pega falso-positivo.
      expect(envKey('OPENAI_API_KEY')).toBeUndefined()
    } finally {
      if (previousKey === undefined) delete process.env.MIGRATION_SECRET_SENTINEL
      else process.env.MIGRATION_SECRET_SENTINEL = previousKey
    }
  })
})