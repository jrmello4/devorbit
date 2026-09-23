/**
 * Adaptadores de uso real por token (Camada B do contrato em
 * ../shared/usage-contract.ts).
 *
 * Lê, de forma incremental e SOMENTE LEITURA, os stores locais de cada CLI:
 * - Claude Code:  <claude>/projects/ (recursivo, *.jsonl — transcripts JSONL
 *   por sessão; linhas "assistant" trazem message.usage com tokens).
 * - Codex:        <codex>/sessions/ (recursivo, *.jsonl — rollouts JSONL;
 *   registros token_count trazem info.last_token_usage (delta do turno) e/ou
 *   info.total_token_usage (TOTAIS CUMULATIVOS da sessão); eventos iniciais
 *   podem ter "info": null e são ignorados).
 * - OpenCode:     <opencode>/opencode.db — banco SQLite (a antiga pasta
 *   storage/message em JSON por arquivo não existe mais nas versões atuais).
 *   A tabela
 *   `message` (coluna `data` em JSON) é a fonte preferida por dar granularia
 *   por modelo; a tabela `session` (agregados tokens_*) é o fallback.
 * - Gemini:       diretório reportado por resolveUsageSourceDirs, mas SEM
 *   adaptador — o Gemini CLI não persiste uso local de tokens.
 *
 * Incrementalidade: UsageScanState.offsets guarda, por caminho absoluto (ou
 * chave sintética "sqlite:<db>:maxRowId" no caso do OpenCode), a posição já
 * consumida. Cada varredura lê só o trecho novo, em blocos — nunca o
 * diretório inteiro na memória. Linha parcial no fim do JSONL fica pendente
 * até o '\n' completar (o offset só avança até o último '\n'); arquivo
 * truncado (menor que o offset registrado) é relido do zero. Arquivo parado
 * (offset já no fim + mtime/size iguais ao carimbo da última leitura) nem é
 * aberto; o carimbo viaja como campo opcional `mtimes` do scan-state e
 * entradas antigas sem ele seguem o caminho de hoje.
 *
 * Semântica do Codex (importante para o agregador): quando presente,
 * last_token_usage já é o DELTA do turno e cada evento carrega esse delta.
 * Sem last_token_usage, o delta é calculado contra o último acumulado visto
 * (base mantida em memória por processo + zero quando o arquivo é lido do
 * início). Um acumulado sem base conhecida (arquivo já consumido por um
 * processo anterior) é PULADO em vez de emitir o total inteiro — prefere
 * subcontar a dobrar. `cached_input_tokens` é subconjunto de input_tokens na
 * contabilidade do Codex e por isso NÃO vira cacheReadTokens (evita soma em
 * dobro).
 *
 * dedupeKey: o contrato pede chave estável por registro ("arquivo+offset ou
 * id"). Claude usa record.uuid com fallback para o offset da linha; Codex usa
 * record.ordinal (com fallback para o offset da linha — tolera os ordinais
 * duplicados/fora de ordem conhecidos do Codex); OpenCode usa
 * <banco>:<tabela>:<rowid>.
 *
 * Limites: arquivos > USAGE_MAX_FILE_BYTES são pulados (nota no status); no
 * máximo USAGE_MAX_EVENTS_PER_SCAN eventos por varredura (mantidos os mais
 * recentes); links simbólicos nunca são seguidos; nenhum byte é escrito.
 */
import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  UsageAdapterStatus,
  UsageScanResult,
  UsageScanState,
  UsageSourceDirs,
  UsageTokenEvent,
} from '../shared/usage-contract'

/** Arquivos maiores que isso são pulados por segurança (nota no status). */
export const USAGE_MAX_FILE_BYTES = 50 * 1024 * 1024
/** Teto de eventos por varredura; excedente descarta os mais antigos. */
export const USAGE_MAX_EVENTS_PER_SCAN = 5000

const TAIL_CHUNK_BYTES = 1024 * 1024
const NEWLINE_BYTE = 0x0a
const OPENCODE_SQLITE_BATCH = 500

type UsageSourceId = UsageAdapterStatus['source']
type SqliteDatabaseCtor = typeof import('node:sqlite').DatabaseSync
type SqliteDatabase = import('node:sqlite').DatabaseSync

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined
  return nonEmptyString(error.code)
}

function shortReason(error: unknown): string {
  const code = errorCode(error)
  if (code === 'ENOENT') return 'caminho não encontrado'
  if (code === 'ENOTDIR') return 'caminho inesperado (arquivo no lugar de pasta)'
  if (code === 'EACCES' || code === 'EPERM') return 'sem permissão de leitura'
  return error instanceof Error ? error.message.slice(0, 140) : 'erro desconhecido'
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

function isoFromTimestamp(value: unknown): string | undefined {
  const raw = nonEmptyString(value)
  if (!raw) return undefined
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

/** Aceita epoch (s ou ms), ISO string ou record com created/completed/start. */
function flexibleTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 0 && value < 1e12 ? value * 1000 : value
    return new Date(ms).toISOString()
  }
  const iso = isoFromTimestamp(value)
  if (iso) return iso
  if (isRecord(value)) {
    for (const key of ['created', 'completed', 'start', 'updated_at']) {
      const parsed = flexibleTimestamp(value[key])
      if (parsed) return parsed
    }
  }
  return undefined
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory()
  } catch {
    return false
  }
}

async function fileMtimeIso(file: string): Promise<string | undefined> {
  try {
    return new Date((await fs.stat(file)).mtimeMs).toISOString()
  } catch {
    return undefined
  }
}

/**
 * Resolve os diretórios das fontes locais a partir do homedir e do ambiente.
 * Chamadores passam homedir/env explícitos em testes; em produção omita.
 */
export function resolveUsageSourceDirs(homedir?: string, env?: NodeJS.ProcessEnv): UsageSourceDirs {
  const home = homedir ?? os.homedir()
  const environment = env ?? process.env
  const claude = environment.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  const codex = environment.CODEX_HOME || path.join(home, '.codex')
  // OpenCode real usa o caminho XDG sob o perfil mesmo no Windows
  // (%USERPROFILE%\.local\share\opencode\opencode.db); LOCALAPPDATA não é
  // usado. O adaptador ainda tem sonda de fallback no próprio DB.
  const opencode =
    environment.OPENCODE_DATA_DIR ||
    (environment.XDG_DATA_HOME ? path.join(environment.XDG_DATA_HOME, 'opencode') : undefined) ||
    path.join(home, '.local', 'share', 'opencode')
  return {
    claude,
    codex,
    opencode,
    gemini: path.join(home, '.gemini'),
  }
}

interface SourceOutcome {
  status: UsageAdapterStatus['status']
  message?: string
  events: UsageTokenEvent[]
  offsets: Record<string, number>
  /** Carimbo (mtimeMs) dos arquivos consumidos até o fim nesta passada. */
  mtimes?: Record<string, number>
}

function missingOutcome(message = 'Diretório da fonte não encontrado.'): SourceOutcome {
  return { status: 'missing', message, events: [], offsets: {} }
}

function outcomeWithNotes(
  events: UsageTokenEvent[],
  offsets: Record<string, number>,
  notes: string[],
  mtimes?: Record<string, number>
): SourceOutcome {
  return {
    status: events.length > 0 ? 'ok' : 'empty',
    ...(notes.length > 0 ? { message: notes.join('; ') } : {}),
    events,
    offsets,
    ...(mtimes && Object.keys(mtimes).length > 0 ? { mtimes } : {}),
  }
}

function previousOffsetFor(state: UsageScanState, key: string): number {
  const stored = state.offsets?.[key]
  return typeof stored === 'number' && Number.isFinite(stored) && stored >= 0 ? stored : 0
}

/**
 * Estado de scan com carimbos opcionais por arquivo (mtimeMs). Campo irmão de
 * `offsets`: entradas antigas do scan-state.json (só offsets) seguem o caminho
 * de hoje e seguem válidas.
 */
type UsageScanStateWithMtimes = UsageScanState & { mtimes?: Record<string, number> }

function persistedMtimeFor(previous: UsageScanState, file: string): number | undefined {
  const value = (previous as UsageScanStateWithMtimes).mtimes?.[file]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Carimbo em memória (arquivo → mtimeMs) da última leitura concluída até o
 * fim. O scan seguinte pula `readJsonlTail` quando o offset registrado já é
 * o tamanho atual E o mtime não mudou (o tamanho do stat é feito de qualquer
 * forma; o skip economiza open/read/close por arquivo parado).
 */
const fullyReadStamps = new Map<string, number>()

/**
 * Caminha a árvore a partir de `root` coletando arquivos regulares.
 * Links simbólicos NUNCA são seguidos; erro na raiz propaga (EACCES/ENOTDIR
 * viram status 'error'), mas raiz inexistente (ENOENT) só significa "nada a
 * ler"; erros em subdiretórios são contados e ignorados.
 */
async function walkRegularFiles(root: string): Promise<{ files: string[]; unreadableDirs: number }> {
  const files: string[] = []
  let unreadableDirs = 0
  const visit = async (dir: string, isRoot: boolean): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (isRoot) {
        if (errorCode(error) === 'ENOENT') return
        throw error
      }
      unreadableDirs += 1
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(fullPath, false)
      else if (entry.isFile()) files.push(fullPath)
    }
  }
  await visit(root, true)
  files.sort()
  return { files, unreadableDirs }
}

interface JsonlTail {
  lines: string[]
  /** Offset absoluto (bytes) do início de cada linha em `lines`. */
  lineStarts: number[]
  /** Offset já consumido (após o último '\n' completo). */
  nextOffset: number
  /** Offset onde esta leitura começou (0 se o arquivo foi resetado). */
  readStart: number
  size: number
  mtimeMs: number
}

/**
 * Lê o trecho novo do JSONL (de `fromOffset` até o último '\n') em blocos.
 * Linha parcial no fim fica para a próxima varredura; arquivo truncado
 * (menor que o offset) é relido do zero. Split por byte 0x0A é seguro em
 * UTF-8 (continuação multi-byte nunca colide com '\n').
 */
async function readJsonlTail(file: string, fromOffset: number): Promise<JsonlTail> {
  const handle = await fs.open(file, 'r')
  try {
    const stat = await handle.stat()
    const size = stat.size
    const readStart = size < fromOffset ? 0 : fromOffset
    const chunks: Buffer[] = []
    let position = readStart
    while (position < size) {
      const length = Math.min(TAIL_CHUNK_BYTES, size - position)
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead <= 0) break
      chunks.push(bytesRead === length ? buffer : buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const data = Buffer.concat(chunks)
    const lines: string[] = []
    const lineStarts: number[] = []
    let lineStart = 0
    let searchFrom = 0
    for (;;) {
      const newline = data.indexOf(NEWLINE_BYTE, searchFrom)
      if (newline < 0) break
      lines.push(data.toString('utf8', lineStart, newline))
      lineStarts.push(readStart + lineStart)
      lineStart = newline + 1
      searchFrom = lineStart
    }
    return { lines, lineStarts, nextOffset: readStart + lineStart, readStart, size, mtimeMs: stat.mtimeMs }
  } finally {
    await handle.close()
  }
}

interface JsonlRecordContext {
  relPath: string
  absPath: string
  /** Offset absoluto do início da linha (base do dedupeKey por arquivo+offset). */
  lineStart: number
  mtimeIso: string
  /** Offset onde a leitura deste arquivo começou nesta varredura. */
  readStart: number
}

type JsonlRecordHandler = (
  record: Record<string, unknown>,
  ctx: JsonlRecordContext
) => UsageTokenEvent | undefined

// ---------------------------------------------------------------------------
// Claude Code — transcripts JSONL em <claude>/projects/ (recursivo, *.jsonl)
// ---------------------------------------------------------------------------

function stripModelNamespace(model: string): string {
  const slash = model.lastIndexOf('/')
  return slash >= 0 ? model.slice(slash + 1) : model
}

function handleClaudeRecord(record: Record<string, unknown>, ctx: JsonlRecordContext): UsageTokenEvent | undefined {
  const message = isRecord(record.message) ? record.message : undefined
  const usage = message && isRecord(message.usage) ? message.usage : undefined
  if (!message || !usage) return undefined
  const inputTokens = finiteNumber(usage.input_tokens)
  const outputTokens = finiteNumber(usage.output_tokens)
  const cacheReadTokens = finiteNumber(usage.cache_read_input_tokens)
  const cacheWriteTokens = finiteNumber(usage.cache_creation_input_tokens)
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined
  ) {
    return undefined
  }
  const uuid = nonEmptyString(record.uuid)
  return {
    kind: 'tokens',
    at: isoFromTimestamp(record.timestamp) ?? ctx.mtimeIso,
    source: 'claude-transcripts',
    provider: 'claude',
    model: stripModelNamespace(nonEmptyString(message.model) ?? 'claude'),
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    dedupeKey: `claude:${ctx.relPath}:${uuid ?? ctx.lineStart}`,
  }
}

// ---------------------------------------------------------------------------
// Codex — rollouts JSONL em <codex>/sessions/ (recursivo, *.jsonl)
// ---------------------------------------------------------------------------

interface CodexTokenTotals {
  inputTokens: number
  outputTokens: number
}

interface CodexTokenInfo {
  /** total_token_usage (cumulativo da sessão), quando presente. */
  totals?: CodexTokenTotals
  /** last_token_usage (delta do turno), quando presente. */
  last?: CodexTokenTotals
}

interface CodexFileScanState {
  model?: string
  lastCumulative?: CodexTokenTotals
  seenOrdinals: Set<number>
}

function readTokenPair(value: unknown): CodexTokenTotals | undefined {
  if (!isRecord(value)) return undefined
  const inputTokens =
    finiteNumber(value.input_tokens) ?? finiteNumber(value.inputTokens) ?? finiteNumber(value.input)
  const outputTokens =
    finiteNumber(value.output_tokens) ?? finiteNumber(value.outputTokens) ?? finiteNumber(value.output)
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 }
}

/**
 * Extrai o uso de tokens de um registro token_count, tolerando as variações
 * de forma: info dentro de payload (formato atual), info no topo, usage
 * direto no payload e pares soltos em contexto token_count. Campos sem
 * números são ignorados; "info": null cai fora silenciosamente.
 */
function extractCodexTokenInfo(record: Record<string, unknown>): CodexTokenInfo | undefined {
  const payload = isRecord(record.payload) ? record.payload : undefined
  const payloadInfo = payload && isRecord(payload.info) ? payload.info : undefined
  const info = isRecord(record.info) ? record.info : undefined
  for (const candidate of [payloadInfo, info, payload, record]) {
    if (!candidate) continue
    const totals =
      readTokenPair(candidate.total_token_usage) ?? readTokenPair(candidate.token_usage)
    const last = readTokenPair(candidate.last_token_usage)
    if (totals || last) return { ...(totals ? { totals } : {}), ...(last ? { last } : {}) }
  }
  const tokenCountContext =
    nonEmptyString(record.type) === 'token_count' || nonEmptyString(payload?.type) === 'token_count'
  if (tokenCountContext) {
    for (const candidate of [payloadInfo, info, payload, record]) {
      if (!candidate) continue
      const direct = readTokenPair(candidate)
      if (direct) return { totals: direct }
    }
  }
  return undefined
}

function findCodexModel(record: Record<string, unknown>): string | undefined {
  const payload = isRecord(record.payload) ? record.payload : undefined
  return nonEmptyString(payload?.model) ?? nonEmptyString(record.model)
}

/**
 * Cria o handler do Codex com estado por arquivo que vive enquanto o
 * processo vive: modelo já descoberto (session_meta/turn_context), último
 * acumulado visto (base dos deltas quando falta last_token_usage) e
 * ordinais já emitidos (o Codex pode gravar ordinais duplicados/fora de
 * ordem; duplicados não são reemitidos).
 */
function createCodexAdapter(): {
  handler: JsonlRecordHandler
  onFileReset: (file: string) => void
  skippedNoBaseline: () => number
  resetSkippedNoBaseline: () => void
} {
  const files = new Map<string, CodexFileScanState>()
  let skipped = 0

  const stateFor = (file: string): CodexFileScanState => {
    let state = files.get(file)
    if (!state) {
      state = { seenOrdinals: new Set<number>() }
      files.set(file, state)
    }
    return state
  }

  const handler: JsonlRecordHandler = (record, ctx) => {
    const state = stateFor(ctx.absPath)
    if (state.model === undefined) {
      const discovered = findCodexModel(record)
      if (discovered !== undefined) state.model = discovered
    }
    const info = extractCodexTokenInfo(record)
    if (!info) return undefined

    const ordinal = finiteNumber(record.ordinal)
    const ordinalId = ordinal !== undefined ? Math.trunc(ordinal) : undefined
    if (ordinalId !== undefined) {
      if (state.seenOrdinals.has(ordinalId)) return undefined
      state.seenOrdinals.add(ordinalId)
    }

    let inputTokens: number | undefined
    let outputTokens: number | undefined
    if (info.last) {
      // Formato atual: last_token_usage já é o delta do turno.
      inputTokens = info.last.inputTokens
      outputTokens = info.last.outputTokens
    } else if (info.totals) {
      // Fallback: total_token_usage é cumulativo; delta contra a última base.
      const baseline =
        state.lastCumulative ??
        (ctx.readStart === 0 ? { inputTokens: 0, outputTokens: 0 } : undefined)
      if (!baseline) {
        // Sem base conhecida (arquivo parcialmente consumido por um processo
        // anterior): emitir o acumulado inteiro contaria turno em dobro.
        skipped += 1
        state.lastCumulative = info.totals
        return undefined
      }
      const deltaInput = info.totals.inputTokens - baseline.inputTokens
      const deltaOutput = info.totals.outputTokens - baseline.outputTokens
      if (deltaInput < 0 || deltaOutput < 0) return undefined // ordinais fora de ordem
      if (deltaInput === 0 && deltaOutput === 0) return undefined // duplicado sem ordinal
      inputTokens = deltaInput
      outputTokens = deltaOutput
    }
    if (info.totals) state.lastCumulative = info.totals
    if (inputTokens === undefined && outputTokens === undefined) return undefined

    return {
      kind: 'tokens',
      at: isoFromTimestamp(record.timestamp) ?? ctx.mtimeIso,
      source: 'codex-rollouts',
      provider: 'codex',
      model: state.model ?? 'codex',
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      dedupeKey: `codex:${ctx.relPath}:${ordinalId ?? ctx.lineStart}`,
    }
  }

  return {
    handler,
    onFileReset: (file: string) => files.delete(file),
    skippedNoBaseline: () => skipped,
    resetSkippedNoBaseline: () => {
      skipped = 0
    },
  }
}

// ---------------------------------------------------------------------------
// OpenCode — banco SQLite em <opencode>/opencode.db (ou no caminho XDG do
// perfil quando o diretório resolvido não o contém).
// ---------------------------------------------------------------------------

interface OpenCodeTokens {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

function extractOpenCodeTokens(record: Record<string, unknown>): OpenCodeTokens | undefined {
  const candidates = [record.tokens, record.usage, record]
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue
    const cache = isRecord(candidate.cache) ? candidate.cache : undefined
    const inputTokens =
      finiteNumber(candidate.input) ??
      finiteNumber(candidate.input_tokens) ??
      finiteNumber(candidate.inputTokens)
    const outputTokens =
      finiteNumber(candidate.output) ??
      finiteNumber(candidate.output_tokens) ??
      finiteNumber(candidate.outputTokens)
    if (inputTokens === undefined && outputTokens === undefined) continue
    const cacheReadTokens =
      finiteNumber(cache?.read) ??
      finiteNumber(candidate.cache_read_input_tokens) ??
      finiteNumber(candidate.cache_read) ??
      finiteNumber(candidate.cacheReadInputTokens)
    const cacheWriteTokens =
      finiteNumber(cache?.write) ??
      finiteNumber(candidate.cache_creation_input_tokens) ??
      finiteNumber(candidate.cache_write) ??
      finiteNumber(candidate.cacheCreationInputTokens)
    return {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    }
  }
  return undefined
}

async function loadSqliteConstructor(): Promise<SqliteDatabaseCtor | undefined> {
  try {
    const mod = await import('node:sqlite')
    return typeof mod.DatabaseSync === 'function' ? mod.DatabaseSync : undefined
  } catch {
    return undefined
  }
}

/**
 * Procura o banco do OpenCode: primeiro no diretório resolvido; se ausente,
 * no caminho XDG padrão sob o perfil do usuário (instalações atuais gravam
 * em <perfil>/.local/share/opencode/opencode.db mesmo no Windows).
 */
async function findOpenCodeDatabase(sourceDir: string): Promise<string | undefined> {
  const candidates = [path.join(sourceDir, 'opencode.db')]
  const profileXdg = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')
  if (profileXdg !== candidates[0]) candidates.push(profileXdg)
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate
    } catch {
      // Tenta o próximo caminho conhecido.
    }
  }
  return undefined
}

function openCodeDbKey(sourceDir: string, dbPath: string): string {
  const relative = path.relative(sourceDir, dbPath)
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return toPosix(relative)
  return toPosix(dbPath)
}

function sqliteTableNames(db: SqliteDatabase): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
  const names = new Set<string>()
  for (const row of rows) {
    const name = nonEmptyString(row.name)
    if (name) names.add(name)
  }
  return names
}

function sqliteColumnNames(db: SqliteDatabase, table: 'message' | 'session'): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all()
  const names = new Set<string>()
  for (const row of rows) {
    const name = nonEmptyString(row.name)
    if (name) names.add(name)
  }
  return names
}

function sqliteRowId(row: Record<string, unknown>): number | undefined {
  const value = finiteNumber(row.rid)
  return value === undefined ? undefined : Math.trunc(value)
}

function openCodeRowTimestamp(row: Record<string, unknown>, fallbackIso: string): string {
  for (const key of ['timestamp', 'time_created', 'created_at', 'time']) {
    const parsed = flexibleTimestamp(row[key])
    if (parsed) return parsed
  }
  return fallbackIso
}

function scanOpenCodeMessageTable(
  db: SqliteDatabase,
  dbMtimeIso: string,
  dbKey: string,
  events: UsageTokenEvent[],
  fromRowId: number
): { maxRowId: number; malformed: number } {
  const statement = db.prepare(
    'SELECT rowid AS rid, data FROM message WHERE rowid > ? ORDER BY rowid LIMIT ?'
  )
  let cursor = fromRowId
  let maxRowId = fromRowId
  let malformed = 0
  for (;;) {
    const rows = statement.all(cursor, OPENCODE_SQLITE_BATCH)
    if (rows.length === 0) break
    for (const row of rows) {
      const rid = sqliteRowId(row)
      if (rid === undefined) continue
      if (rid > maxRowId) maxRowId = rid
      const raw = nonEmptyString(row.data)
      if (!raw) {
        malformed += 1
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        malformed += 1
        continue
      }
      if (!isRecord(parsed)) {
        malformed += 1
        continue
      }
      // Mensagens do usuário/sistema não têm uso de modelo; assistant sem
      // tokens (em aberto) também é ignorado.
      const role = nonEmptyString(parsed.role)
      if (role && role !== 'assistant') continue
      const tokens = extractOpenCodeTokens(parsed)
      if (!tokens) continue
      events.push({
        kind: 'tokens',
        at: flexibleTimestamp(parsed.time) ?? dbMtimeIso,
        source: 'opencode-storage',
        provider: nonEmptyString(parsed.providerID) ?? 'opencode',
        model: nonEmptyString(parsed.modelID) ?? 'opencode',
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        ...(tokens.cacheReadTokens !== undefined ? { cacheReadTokens: tokens.cacheReadTokens } : {}),
        ...(tokens.cacheWriteTokens !== undefined
          ? { cacheWriteTokens: tokens.cacheWriteTokens }
          : {}),
        dedupeKey: `opencode:${dbKey}:message:${rid}`,
      })
    }
    if (rows.length < OPENCODE_SQLITE_BATCH) break
    if (maxRowId <= cursor) break // sem avanço verificável: evita loop infinito
    cursor = maxRowId
  }
  return { maxRowId, malformed }
}

function scanOpenCodeSessionTable(
  db: SqliteDatabase,
  dbMtimeIso: string,
  dbKey: string,
  events: UsageTokenEvent[],
  fromRowId: number
): { maxRowId: number; malformed: number } {
  const statement = db.prepare(
    'SELECT rowid AS rid, * FROM session WHERE rowid > ? ORDER BY rowid LIMIT ?'
  )
  let cursor = fromRowId
  let maxRowId = fromRowId
  for (;;) {
    const rows = statement.all(cursor, OPENCODE_SQLITE_BATCH)
    if (rows.length === 0) break
    for (const row of rows) {
      const rid = sqliteRowId(row)
      if (rid === undefined) continue
      if (rid > maxRowId) maxRowId = rid
      const inputTokens = finiteNumber(row.tokens_input) ?? 0
      const outputTokens = finiteNumber(row.tokens_output) ?? 0
      const cacheReadTokens = finiteNumber(row.tokens_cache_read)
      const cacheWriteTokens = finiteNumber(row.tokens_cache_write)
      const total =
        inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
      // Sessões sem uso registrada são apenas ignoradas (não é erro).
      if (total <= 0) continue
      events.push({
        kind: 'tokens',
        at: openCodeRowTimestamp(row, dbMtimeIso),
        source: 'opencode-storage',
        provider: nonEmptyString(row.providerID) ?? 'opencode',
        model: nonEmptyString(row.modelID) ?? 'opencode',
        inputTokens,
        outputTokens,
        ...(cacheReadTokens !== undefined && cacheReadTokens > 0 ? { cacheReadTokens } : {}),
        ...(cacheWriteTokens !== undefined && cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
        dedupeKey: `opencode:${dbKey}:session:${rid}`,
      })
    }
    if (rows.length < OPENCODE_SQLITE_BATCH) break
    if (maxRowId <= cursor) break
    cursor = maxRowId
  }
  return { maxRowId, malformed: 0 }
}

async function scanOpenCodeSource(sourceDir: string | undefined, previous: UsageScanState): Promise<SourceOutcome> {
  if (!sourceDir) return missingOutcome('Diretório da fonte não configurado.')
  if (!(await isDirectory(sourceDir))) return missingOutcome()

  const dbPath = await findOpenCodeDatabase(sourceDir)
  if (!dbPath) {
    return {
      status: 'empty',
      message: 'Banco opencode.db não encontrado nos caminhos conhecidos.',
      events: [],
      offsets: {},
    }
  }
  const DatabaseSync = await loadSqliteConstructor()
  if (!DatabaseSync) {
    return {
      status: 'error',
      message: 'node:sqlite indisponível neste runtime.',
      events: [],
      offsets: {},
    }
  }

  let db: SqliteDatabase
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    return {
      status: 'error',
      message: `Falha ao abrir ${dbPath}: ${shortReason(error)}`,
      events: [],
      offsets: {},
    }
  }

  const events: UsageTokenEvent[] = []
  const offsets: Record<string, number> = {}
  let malformed = 0
  try {
    const tables = sqliteTableNames(db)
    const dbKey = openCodeDbKey(sourceDir, dbPath)
    const dbMtimeIso = (await fileMtimeIso(dbPath)) ?? new Date().toISOString()
    const hasMessageData = tables.has('message') && sqliteColumnNames(db, 'message').has('data')
    if (hasMessageData) {
      const offsetKey = `sqlite:${dbPath}:maxRowId`
      const result = scanOpenCodeMessageTable(
        db,
        dbMtimeIso,
        dbKey,
        events,
        previousOffsetFor(previous, offsetKey)
      )
      malformed += result.malformed
      offsets[offsetKey] = result.maxRowId
    } else if (tables.has('session')) {
      const offsetKey = `sqlite:${dbPath}:maxSessionRowId`
      const result = scanOpenCodeSessionTable(
        db,
        dbMtimeIso,
        dbKey,
        events,
        previousOffsetFor(previous, offsetKey)
      )
      malformed += result.malformed
      offsets[offsetKey] = result.maxRowId
    } else {
      return {
        status: 'error',
        message: 'Esquema do banco não reconhecido (tabelas message/session ausentes).',
        events: [],
        offsets: {},
      }
    }
  } catch (error) {
    return {
      status: 'error',
      message: `Falha ao ler ${dbPath}: ${shortReason(error)}`,
      events: [],
      offsets: {},
    }
  } finally {
    try {
      db.close()
    } catch {
      // Banco já fechado; nada a fazer.
    }
  }

  const notes: string[] = []
  if (malformed > 0) notes.push(`${malformed} registro(s) inválido(s) ignorado(s)`)
  return outcomeWithNotes(events, offsets, notes)
}

// ---------------------------------------------------------------------------
// Motor genérico de varredura JSONL incremental (Claude e Codex)
// ---------------------------------------------------------------------------

async function scanJsonlSource(
  sourceDir: string | undefined,
  walkSubdir: string,
  previous: UsageScanState,
  handler: JsonlRecordHandler,
  onFileReset?: (file: string) => void
): Promise<SourceOutcome> {
  if (!sourceDir) return missingOutcome('Diretório da fonte não configurado.')
  if (!(await isDirectory(sourceDir))) return missingOutcome()

  const offsets: Record<string, number> = {}
  const mtimes: Record<string, number> = {}
  const events: UsageTokenEvent[] = []
  let malformed = 0
  let skippedLarge = 0
  let unreadableFiles = 0
  let unreadableDirs = 0
  try {
    const walk = await walkRegularFiles(path.join(sourceDir, walkSubdir))
    unreadableDirs = walk.unreadableDirs
    for (const file of walk.files) {
      if (!file.endsWith('.jsonl')) continue
      const previousOffset = previousOffsetFor(previous, file)
      let size = 0
      let mtimeMs = 0
      try {
        const stats = await fs.stat(file)
        size = stats.size
        mtimeMs = stats.mtimeMs
      } catch {
        unreadableFiles += 1
        continue
      }
      // Nada novo: o offset registrado já consumiu o arquivo inteiro e o
      // carimbo da última leitura continua igual — pula a abertura do arquivo.
      const knownMtimeMs = fullyReadStamps.get(file) ?? persistedMtimeFor(previous, file)
      if (knownMtimeMs !== undefined && previousOffset === size && knownMtimeMs === mtimeMs) {
        offsets[file] = previousOffset
        mtimes[file] = knownMtimeMs
        continue
      }
      if (size > USAGE_MAX_FILE_BYTES) {
        // Grande demais: pula com nota, mas avança o offset para não tentar
        // de novo a cada varredura.
        skippedLarge += 1
        offsets[file] = size
        continue
      }
      let tail: JsonlTail
      try {
        tail = await readJsonlTail(file, previousOffset)
      } catch {
        unreadableFiles += 1
        continue
      }
      if (tail.readStart === 0 && previousOffset > 0) onFileReset?.(file)
      const relPath = toPosix(path.relative(sourceDir, file))
      const mtimeIso = new Date(tail.mtimeMs).toISOString()
      for (let index = 0; index < tail.lines.length; index += 1) {
        const raw = tail.lines[index].trim()
        if (!raw) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          malformed += 1
          continue
        }
        if (!isRecord(parsed)) {
          malformed += 1
          continue
        }
        const ctx: JsonlRecordContext = {
          relPath,
          absPath: file,
          lineStart: tail.lineStarts[index],
          mtimeIso,
          readStart: tail.readStart,
        }
        try {
          const event = handler(parsed, ctx)
          if (event) events.push(event)
        } catch {
          malformed += 1
        }
      }
      offsets[file] = tail.nextOffset
      // Leitura chegou ao fim: registra o carimbo para a próxima varredura
      // poder pular o arquivo parado (linha parcial fica sem carimbo).
      if (tail.nextOffset >= tail.size) {
        fullyReadStamps.set(file, tail.mtimeMs)
        mtimes[file] = tail.mtimeMs
      }
    }
  } catch (error) {
    return {
      status: 'error',
      message: `Falha ao varrer ${sourceDir}: ${shortReason(error)}`,
      events: [],
      offsets: {},
    }
  }

  const notes: string[] = []
  if (malformed > 0) notes.push(`${malformed} registro(s) inválido(s) ignorado(s)`)
  if (skippedLarge > 0) notes.push(`${skippedLarge} arquivo(s) acima de 50MB ignorado(s)`)
  if (unreadableFiles > 0) notes.push(`${unreadableFiles} arquivo(s) ilegível(is)`)
  if (unreadableDirs > 0) notes.push(`${unreadableDirs} subdiretório(s) ilegível(is)`)
  return outcomeWithNotes(events, offsets, notes, mtimes)
}

// ---------------------------------------------------------------------------
// Ponto de entrada
// ---------------------------------------------------------------------------

// Estado do Codex (modelo descoberto, último acumulado por arquivo, ordinais
// vistos) vive no nível do módulo: baselines de delta precisam sobreviver
// entre varreduras enquanto o processo estiver de pé.
const codexAdapter = createCodexAdapter()

/**
 * Varre todas as fontes locais de forma incremental e somente leitura,
 * partindo de `previous` (offsets persistidos) e devolvendo os novos eventos,
 * o próximo estado e o status de cada adaptador.
 */
export async function scanUsageAdapters(dirs: UsageSourceDirs, previous: UsageScanState): Promise<UsageScanResult> {
  const nowIso = new Date().toISOString()
  const offsets: Record<string, number> = { ...previous.offsets }
  const mtimes: Record<string, number> = {}
  const events: UsageTokenEvent[] = []
  const statuses: UsageAdapterStatus[] = []

  // Carimbos persistidos (scan-state com mtimes) semeiam o mapa em memória;
  // o mapa em memória é sempre mais recente e não é sobrescrito.
  for (const [file, value] of Object.entries((previous as UsageScanStateWithMtimes).mtimes ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value) && !fullyReadStamps.has(file)) {
      fullyReadStamps.set(file, value)
    }
  }

  const claudeOutcome = await scanJsonlSource(dirs.claude, 'projects', previous, handleClaudeRecord)
  const codexOutcome = await scanJsonlSource(
    dirs.codex,
    'sessions',
    previous,
    codexAdapter.handler,
    codexAdapter.onFileReset
  )
  const skippedNoBaselineThisScan = codexAdapter.skippedNoBaseline()
  codexAdapter.resetSkippedNoBaseline()
  if (skippedNoBaselineThisScan > 0) {
    const note = `${skippedNoBaselineThisScan} acumulado(s) sem base de delta ignorado(s)`
    codexOutcome.message = codexOutcome.message ? `${codexOutcome.message}; ${note}` : note
  }
  const opencodeOutcome = await scanOpenCodeSource(dirs.opencode, previous)

  const runs: Array<{ source: UsageSourceId; outcome: SourceOutcome }> = [
    { source: 'claude-transcripts', outcome: claudeOutcome },
    { source: 'codex-rollouts', outcome: codexOutcome },
    { source: 'opencode-storage', outcome: opencodeOutcome },
  ]
  const jsonlSeenOffsets = new Set<string>()
  for (const { source, outcome } of runs) {
    for (const [key, value] of Object.entries(outcome.offsets)) {
      offsets[key] = value
      if (source !== 'opencode-storage') jsonlSeenOffsets.add(key)
    }
    for (const [file, value] of Object.entries(outcome.mtimes ?? {})) mtimes[file] = value
    for (const event of outcome.events) events.push(event)
    statuses.push({
      source,
      status: outcome.status,
      lastScanAt: nowIso,
      ...(outcome.message ? { message: outcome.message } : {}),
    })
  }

  // Poda conservadora: entradas de arquivos que não apareceram em nenhum walk
  // desta passada E cujo stat confirma ENOENT (erro transitório NÃO poda —
  // EACCES/EPERM mantêm a entrada). Chaves sqlite (rowids) não são tocadas.
  for (const key of Object.keys(offsets)) {
    if (!key.endsWith('.jsonl') || jsonlSeenOffsets.has(key)) continue
    try {
      await fs.stat(key)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        delete offsets[key]
        delete mtimes[key]
        fullyReadStamps.delete(key)
      }
    }
  }

  statuses.push({
    source: 'gemini-local',
    status: 'missing',
    lastScanAt: nowIso,
    message: 'Sem dados locais de tokens (Gemini CLI não persiste uso).',
  })

  let emitted = events
  if (emitted.length > USAGE_MAX_EVENTS_PER_SCAN) {
    const ordered = [...events].sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.dedupeKey.localeCompare(b.dedupeKey)
    )
    emitted = ordered.slice(Math.max(0, ordered.length - USAGE_MAX_EVENTS_PER_SCAN))
  }
  const state: UsageScanStateWithMtimes = { offsets }
  if (Object.keys(mtimes).length > 0) state.mtimes = mtimes
  return { events: emitted, state, statuses }
}
