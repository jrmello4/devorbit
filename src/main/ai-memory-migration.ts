/**
 * Migração do legado DevOrbit (`.devorbit/memory.md` + `.devorbit/memory.json`)
 * para o ai-memory v2.4.0 (FASE 3).
 *
 * Decisões de arquitetura fixadas na coordenação:
 * - ai-memory é a ÚNICA memória de conteúdo. Nenhuma terceira fonte de
 *   conteúdo é criada; o único artefato local é a receipt de metadados em
 *   `userData/ai-memory/migrations/<identity-hash>.json` (sem conteúdo de
 *   memória) que alimenta o guarda read-only pós-migração.
 * - Histórico importado é NÃO confiável: vai para namespaces `procedures/`,
 *   `sessions/`, `decisions/` e `gotchas/` com tags MCP reais
 *   `historical` + `do-not-answer-from` (schema real v2.4.0 de
 *   `crates/ai-memory-mcp/src/server.rs`, campo `tags` de WritePageArgs).
 *   JAMAIS em `_rules` e nunca marcado como canonical.
 * - Idempotência: cada página usa path determinístico derivado de
 *   `source+hash`; crash após o write remoto antes do receipt regrava o MESMO
 *   path (write_page é sobrescrita por path, não append). A receipt só é
 *   gravada depois de TODAS as páginas confirmadas por read-back.
 * - Segredo: redação via `redactSecretText`/`redactEvolutionValue`
 *   (src/shared/evolution-history.ts); payload limitado.
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { redactSecretText } from '../shared/evolution-history'
import { buildAiMemoryHelperEnv } from './ai-memory-process-env'
import {
  AI_MEMORY_MCP_TOOLS,
  type AiMemoryScope,
} from '../shared/ai-memory-contract'

/** Versão do schema da receipt local (somente metadados, nunca conteúdo). */
export const MIGRATION_RECEIPT_VERSION = 1

/** Tags obrigatórias em toda página importada (histórico não confiável). */
export const MIGRATED_PAGE_TAGS = ['historical', 'do-not-answer-from'] as const

/** Teto por página importada; conteúdo além disso é truncado com marcador. */
export const MIGRATION_MAX_BODY_CHARS = 60_000
/** Teto de entradas migradas do memory.json (defesa contra arquivo gigante). */
export const MIGRATION_MAX_JSON_ENTRIES = 2_000
/** Teto de linhas do memory.md consideradas (markdown legado). */
export const MIGRATION_MAX_MD_LINES = 5_000

export interface MigrationReceipt {
  version: typeof MIGRATION_RECEIPT_VERSION
  /** Escopo ai-memory de destino (workspace/project). */
  workspace: string
  project: string
  /** Hash da identidade (não a identidade completa nem conteúdo). */
  identityHash: string
  /** Hash SHA-256 de cada fonte migrada (caminho → hash do conteúdo). */
  sources: Record<string, string>
  /** Paths das páginas escritas no ai-memory. */
  paths: string[]
  concludedAt: string
}

/** Client mínimo usado pela migração (subconjunto de AiMemoryClient). */
export interface MigrationMemoryClient {
  callTool(
    name: typeof AI_MEMORY_MCP_TOOLS[keyof typeof AI_MEMORY_MCP_TOOLS],
    args: Record<string, unknown>
  ): Promise<{ text: string; json?: unknown; isError: boolean }>
}

export interface MigrationTarget {
  scope: Pick<AiMemoryScope, 'workspace' | 'project'>
  client: MigrationMemoryClient
}

export interface MigrationSourceContent {
  /** Identificador estável da fonte (ex.: 'memory.md', 'memory.json#episodic'). */
  source: string
  /** Namespace v2.4.0 de destino; histórico nunca vai para _rules/notes. */
  namespace: 'procedures' | 'sessions' | 'decisions' | 'gotchas'
  body: string
}

export interface MigrationOutcome {
  status: 'migrated' | 'already-migrated' | 'skipped-empty' | 'failed'
  paths: string[]
  message?: string
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Trunca com marcador explícito; reserva o espaço do marcador para o resultado
 * nunca passar do limite.
 */
export function truncateBody(body: string, maxChars = MIGRATION_MAX_BODY_CHARS): string {
  if (body.length <= maxChars) return body
  const marker = '\n\n…(truncado na migração DevOrbit → ai-memory)'
  return body.slice(0, Math.max(0, maxChars - marker.length)) + marker
}

/**
 * Slug determinístico e conservador para o segmento de path da página.
 * Apenas `[a-z0-9._-]`; tudo o mais vira `-`; nunca vazio.
 */
export function slugifyPageSegment(value: string): string {
  const slug = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug || 'sem-nome'
}

/** Path determinístico da página: `<namespace>/<source-slug>-<hash12>.md`. */
export function migrationPagePath(source: string, namespace: MigrationSourceContent['namespace'], body: string): string {
  const hash = sha256(`${source}\n${body}`).slice(0, 12)
  return `${namespace}/${slugifyPageSegment(source)}-${hash}.md`
}

/** Body de uma página importada: redigido, truncado e rotulado. */
export function buildMigratedBody(source: string, rawBody: string): string {
  const redacted = redactSecretText(String(rawBody ?? ''))
  const header = [
    '> Importado do legado DevOrbit (`' + source + '`).',
    '> Histórico NÃO confiável: não usar como resposta canônica.',
    '',
  ].join('\n')
  return header + redacted
}

export interface MigrationJsonEntry {
  kind?: string
  content?: string
  createdAt?: string
  updatedAt?: string
}

function jsonEntryLabel(entry: MigrationJsonEntry): string {
  const stamp = entry.updatedAt ?? entry.createdAt
  return `memory.json#${entry.kind ?? 'unknown'}${stamp ? ` (${stamp})` : ''}`
}

/**
 * Mapeamento da taxonomia:
 * - memory.md → procedures (estado operacional legado);
 * - memory.json operational → procedures; episodic → sessions;
 *   reflexive → gotchas (falhas/abordagens descartadas).
 */
export function sourcesFromLegacyFiles(
  markdown: string | undefined,
  jsonEntries?: readonly MigrationJsonEntry[]
): MigrationSourceContent[] {
  const sources: MigrationSourceContent[] = []
  const md = typeof markdown === 'string' ? markdown : ''
  if (md.trim().length > 0) {
    sources.push({
      source: 'memory.md',
      namespace: 'procedures',
      body: md.split('\n').slice(0, MIGRATION_MAX_MD_LINES).join('\n'),
    })
  }
  const json = jsonEntries ?? []
  for (const entry of json.slice(0, MIGRATION_MAX_JSON_ENTRIES)) {
    const content = typeof entry?.content === 'string' ? entry.content : ''
    if (!content.trim()) continue
    const namespace: MigrationSourceContent['namespace'] =
      entry.kind === 'episodic' ? 'sessions' : entry.kind === 'reflexive' ? 'gotchas' : 'procedures'
    sources.push({
      source: jsonEntryLabel(entry),
      namespace,
      body: content,
    })
  }
  return sources
}

/* ------------------------------------------------------------------ */
/* Worktrees vinculadas (mesma identidade ai-memory)                   */
/* ------------------------------------------------------------------ */

/** Runner Git injetável (testes); devolve stdout ou lança. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>

const execFileAsync = promisify(execFile)

/** Runner Git real (default de produção). argv separado, sem shell, bounded.
 *  Env mínimo do helper: git não precisa de BYOK/tokens do processo main. */
export function defaultGitRunner(): GitRunner {
  return async (args, cwd) => {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      env: buildAiMemoryHelperEnv(),
      timeout: 8_000,
      windowsHide: true,
      shell: false,
    })
    return stdout
  }
}

/**
 * Raízes de TODAS as worktrees vinculadas ao mesmo repositório (inclusive a
 * atual, sempre PRIMEIRA). Identidade ai-memory é derivada do `git-common-dir`
 * (ai-memory-scope.ts:121), ou seja, todas as worktrees compartilham a MESMA
 * identidade → a mesma receipt de migração. Git indisponível/fora de repo →
 * apenas a raiz atual (nunca lança).
 */
export async function listGitWorktrees(projectPath: string, runner?: GitRunner): Promise<string[]> {
  const current = path.resolve(projectPath)
  const samePath = (candidate: string): boolean =>
    normalizePathKey(candidate) === normalizePathKey(current)
  try {
    const out = await (runner ?? defaultGitRunner())(['worktree', 'list', '--porcelain'], current)
    const linked = out
      .split(/\r?\n/)
      .filter((line) => line.startsWith('worktree '))
      .map((line) => path.resolve(line.slice('worktree '.length).trim()))
      .filter((candidate) => candidate && !samePath(candidate))
    return [current, ...new Set(linked)]
  } catch {
    return [current]
  }
}

function normalizePathKey(value: string): string {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Caminho canônico (realpath quando possível); nunca lança. */
async function canonicalPath(value: string): Promise<string> {
  const resolved = path.resolve(value)
  try {
    return await fs.realpath(resolved)
  } catch {
    return resolved
  }
}

/** stdout de um comando Git read-only; `undefined` em qualquer falha. */
async function gitStdout(
  runner: GitRunner,
  args: readonly string[],
  cwd: string
): Promise<string | undefined> {
  try {
    const out = await runner([...args], cwd)
    const value = String(out ?? '').trim()
    return value || undefined
  } catch {
    return undefined
  }
}

/** `--git-common-dir` canônico de `root`; `undefined` se Git falhar. */
async function resolveGitCommonDir(root: string, runner: GitRunner): Promise<string | undefined> {
  const raw = await gitStdout(runner, ['rev-parse', '--git-common-dir'], root)
  if (!raw) return undefined
  return await canonicalPath(path.isAbsolute(raw) ? raw : path.resolve(root, raw))
}

/**
 * M1: valida, com Git read-only, que `root` é a raiz de uma worktree REAL e
 * que pertence ao MESMO repositório do primário (`git-common-dir` canônico).
 * Fail-closed: qualquer falha de Git, `--show-toplevel` divergente ou
 * common-dir diferente → `false` (a raiz NÃO deve ser lida).
 *
 * NÃO exige que `root` seja subpasta de `projectPath`: worktrees legítimas
 * podem viver fora do checkout (ex.: `~/.codex/worktrees`).
 */
export async function validateLinkedWorktree(
  root: string,
  primaryCommonDir: string,
  runner: GitRunner
): Promise<boolean> {
  try {
    const stats = await fs.stat(root)
    if (!stats.isDirectory()) return false
  } catch {
    return false
  }
  const topLevel = await gitStdout(runner, ['rev-parse', '--show-toplevel'], root)
  if (!topLevel) return false
  const canonicalRoot = await canonicalPath(root)
  const canonicalTop = await canonicalPath(topLevel)
  if (normalizePathKey(canonicalTop) !== normalizePathKey(canonicalRoot)) return false

  const commonDir = await resolveGitCommonDir(root, runner)
  if (!commonDir) return false
  return normalizePathKey(commonDir) === normalizePathKey(primaryCommonDir)
}

/** Legado lido de UMA raiz de worktree. */
export interface WorktreeLegacyInput {
  root: string
  /** Raiz do projeto atual (labels idênticos aos paths já migrados). */
  isPrimary?: boolean
  files: LegacyMemoryFiles
}

/**
 * Fontes de migração de todas as worktrees: a primária mantém os labels
 * canônicos (`memory.md`, `memory.json#kind (stamp)` — compatível com
 * receipts existentes); as secundárias recebem sufixo determinístico
 * `@wt:<slug>` — paths derivados de source+hash continuam idempotentes e sem
 * colisão entre worktrees.
 */
export function sourcesFromWorktrees(
  worktrees: readonly WorktreeLegacyInput[]
): MigrationSourceContent[] {
  const sources: MigrationSourceContent[] = []
  for (const worktree of worktrees) {
    const suffix = worktree.isPrimary ? '' : `@wt:${slugifyPageSegment(path.basename(worktree.root))}`
    const md = typeof worktree.files.markdown === 'string' ? worktree.files.markdown : ''
    if (md.trim().length > 0) {
      sources.push({
        source: `memory.md${suffix}`,
        namespace: 'procedures',
        body: md.split('\n').slice(0, MIGRATION_MAX_MD_LINES).join('\n'),
      })
    }
    const json = worktree.files.jsonEntries ?? []
    for (const entry of json.slice(0, MIGRATION_MAX_JSON_ENTRIES)) {
      const content = typeof entry?.content === 'string' ? entry.content : ''
      if (!content.trim()) continue
      const namespace: MigrationSourceContent['namespace'] =
        entry.kind === 'episodic' ? 'sessions' : entry.kind === 'reflexive' ? 'gotchas' : 'procedures'
      sources.push({
        source: `${jsonEntryLabel(entry)}${suffix}`,
        namespace,
        body: content,
      })
    }
  }
  return sources
}

/* ------------------------------------------------------------------ */
/* Receipt local (somente metadados)                                   */
/* ------------------------------------------------------------------ */

/** Caminho da receipt: `migrations/<identity-hash>.json` sob userData. */
export function migrationReceiptPath(userDataDir: string, identity: string): string {
  const hash = sha256(identity).slice(0, 32)
  return path.join(userDataDir, 'ai-memory', 'migrations', `${hash}.json`)
}

interface StoredReceipt {
  version: number
  workspace: string
  project: string
  identityHash: string
  sources: Record<string, string>
  paths: string[]
  concludedAt: string
}

/** Caminho do backup escrito pela escrita atômica (janela de crash). */
function receiptBackupPath(filePath: string): string {
  return `${filePath}.bak`
}

/** Validação estrutural compartilhada entre receipt primária e backup. */
function isWellFormedStoredReceipt(raw: unknown): raw is StoredReceipt {
  return (
    isRecord(raw) &&
    raw.version === MIGRATION_RECEIPT_VERSION &&
    Array.isArray(raw.paths) &&
    typeof raw.identityHash === 'string' &&
    raw.identityHash.length > 0 &&
    isRecord(raw.sources)
  )
}

type ReceiptFileState =
  | { kind: 'absent' }
  | { kind: 'error'; message: string }
  | { kind: 'malformed' }
  | { kind: 'foreign' }
  | { kind: 'valid'; receipt: StoredReceipt }

/**
 * Lê um arquivo de receipt com categorias explícitas: ENOENT, erro real de
 * I/O, JSON/não-objeto quebrado, estrutura incompatível (versão antiga ou
 * identityHash de outro projeto) e válido. `expectedIdentityHash` amarra a
 * receipt ao projeto atual (primária e backup).
 */
async function readReceiptFile(
  filePath: string,
  expectedIdentityHash?: string
): Promise<ReceiptFileState> {
  let rawText: string
  try {
    rawText = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText) as unknown
  } catch {
    return { kind: 'malformed' }
  }
  if (!isWellFormedStoredReceipt(parsed)) return { kind: 'foreign' }
  if (expectedIdentityHash !== undefined && parsed.identityHash !== expectedIdentityHash) {
    return { kind: 'foreign' }
  }
  return { kind: 'valid', receipt: parsed }
}

type ReceiptLookup =
  | { kind: 'valid'; receipt: StoredReceipt; restored: boolean }
  | { kind: 'none' }
  | { kind: 'uncertain'; source: 'primary' | 'backup'; message?: string }

/**
 * Recuperação da janela de crash (crash após mover o canônico para `.bak` e
 * antes de publicar o tmp): primária ausente ou incompatível + backup VÁLIDO
 * (mesma versão, paths e identityHash do projeto) → restaura o canônico de
 * forma idempotente (copyFile: o backup permanece; a próxima writeReceipt
 * reescreve o primário de qualquer forma) e devolve a receipt. Backup
 * inválido/corrompido/de outra identidade NUNCA é adotado NEM apagado — vira
 * estado incerto (fail-closed no gate). Primária malformada mantém o contrato
 * atual de erro real (não consulta backup).
 */
async function loadReceiptWithRecovery(
  filePath: string,
  expectedIdentityHash: string
): Promise<ReceiptLookup> {
  const primary = await readReceiptFile(filePath, expectedIdentityHash)
  if (primary.kind === 'valid') return { kind: 'valid', receipt: primary.receipt, restored: false }
  if (primary.kind === 'error') {
    // Erro REAL de leitura da primária: NUNCA é "sem receipt" — o run não pode
    // sobrescrever estado incerto; o gate permanece fail-closed.
    return { kind: 'uncertain', source: 'primary', message: primary.message }
  }
  // malformed = arquivo lixo (sem informação recuperável): o run repara
  // reescrevendo uma receipt nova; o gate segue fail-closed pela leitura atual.
  if (primary.kind === 'malformed') return { kind: 'none' }
  if (primary.kind !== 'absent' && primary.kind !== 'foreign') return { kind: 'none' }
  const backupPath = receiptBackupPath(filePath)
  const backup = await readReceiptFile(backupPath, expectedIdentityHash)
  if (backup.kind === 'valid') {
    try {
      await fs.copyFile(backupPath, filePath)
    } catch {
      // Cópia best-effort: a receipt continua válida (memória + backup); o
      // canônico é reescrito pela próxima writeReceipt.
    }
    return { kind: 'valid', receipt: backup.receipt, restored: true }
  }
  if (backup.kind === 'error') {
    return { kind: 'uncertain', source: 'backup', message: backup.message }
  }
  if (backup.kind === 'malformed' || backup.kind === 'foreign') {
    return { kind: 'uncertain', source: 'backup' }
  }
  return { kind: 'none' }
}

async function writeReceipt(filePath: string, receipt: StoredReceipt): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  // Windows não garante rename sobre arquivo existente: tenta direto e cai
  // para backup+restore (mesma estratégia do ai-memory-scope).
  try {
    await fs.rename(temporary, filePath)
  } catch {
    const backup = `${filePath}.bak`
    let restored = false
    try {
      await fs.rename(filePath, backup)
      await fs.rename(temporary, filePath)
      restored = true
    } finally {
      if (restored) await fs.rm(backup, { force: true }).catch(() => undefined)
      else await fs.rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}

/** Lê a receipt local; `undefined` = projeto ainda não migrado. */
export async function loadMigrationReceipt(
  userDataDir: string,
  identity: string
): Promise<StoredReceipt | undefined> {
  const lookup = await loadReceiptWithRecovery(
    migrationReceiptPath(userDataDir, identity),
    sha256(identity).slice(0, 32)
  )
  return lookup.kind === 'valid' ? lookup.receipt : undefined
}

export type MigrationReceiptState =
  | { status: 'absent' }
  | { status: 'present'; receipt: StoredReceipt }
  | { status: 'error'; message: string }

/**
 * Estado da receipt com ENOENT (ausente = legado permitido) DISTINTO de erro
 * real de I/O/permissão (estado incerto = fail-closed nos escritores legacy).
 * Receipt corrompida (crash antes do write) = 'absent': a migração pode
 * reprocessar; erro real de I/O NÃO autoriza reescrita legada.
 */
export async function readMigrationReceiptState(
  userDataDir: string,
  identity: string
): Promise<MigrationReceiptState> {
  const filePath = migrationReceiptPath(userDataDir, identity)
  const expectedHash = sha256(identity).slice(0, 32)
  const primary = await readReceiptFile(filePath, expectedHash)
  if (primary.kind === 'valid') return { status: 'present', receipt: primary.receipt }
  if (primary.kind === 'error') return { status: 'error', message: primary.message }
  if (primary.kind === 'malformed') return { status: 'error', message: 'Receipt malformada.' }
  // absent | foreign (versão antiga/identidade alheia) → janela de crash:
  // tenta recuperar do backup validado (versão + identityHash amarrados).
  const lookup = await loadReceiptWithRecovery(filePath, expectedHash)
  if (lookup.kind === 'valid') return { status: 'present', receipt: lookup.receipt }
  if (lookup.kind === 'uncertain') {
    // Backup inválido/corrompido/de outra identidade NUNCA libera escritores
    // legados: estado incerto, fail-closed.
    return {
      status: 'error',
      message:
        lookup.message ??
        'Receipt ausente/incompatível com backup inválido no disco — estado incerto (fail-closed).',
    }
  }
  // Sem receipt nem backup → 'absent' (preserva o mapeamento atual de
  // estrutura incompatível → 'absent' quando não há backup).
  return { status: 'absent' }
}

/* ------------------------------------------------------------------ */
/* Migração                                                            */
/* ------------------------------------------------------------------ */

export interface RunLegacyMigrationInput {
  userDataDir: string
  identity: string
  target: MigrationTarget
  /** Conteúdo bruto do memory.md (undefined = ausente). */
  markdown?: string
  /** Entradas brutas do memory.json já lidas pelo chamador. */
  jsonEntries?: readonly MigrationJsonEntry[]
  /**
   * Fontes por worktree (mesma identidade); quando presente, substitui
   * markdown/jsonEntries na derivação de fontes.
   */
  worktrees?: readonly WorktreeLegacyInput[]
}

/**
 * Escreve cada página e confere por read-back. `message` definido = falha
 * (parcial); paths/hashes acumulam só o confirmado.
 */
async function writeAndConfirm(
  sources: readonly MigrationSourceContent[],
  target: MigrationTarget
): Promise<{ paths: string[]; hashes: Record<string, string>; message?: string }> {
  const { workspace, project } = target.scope
  const paths: string[] = []
  const hashes: Record<string, string> = {}
  for (const item of sources) {
    const pagePath = migrationPagePath(item.source, item.namespace, item.body)
    const body = truncateBody(buildMigratedBody(item.source, item.body))
    hashes[item.source] = sha256(item.body)
    // Write idempotente: sempre o MESMO path derivado de source+hash; um
    // crash aqui regrava a página idêntica na próxima tentativa.
    const result = await target.client.callTool(AI_MEMORY_MCP_TOOLS.writePage, {
      workspace,
      project,
      path: pagePath,
      body,
      tags: [...MIGRATED_PAGE_TAGS],
    })
    if (result.isError) {
      return { paths, hashes, message: `Falha ao escrever ${pagePath} no ai-memory.` }
    }
    // Read-back: extrai body do envelope JSON; exatidão, não substring.
    const readBack = await target.client.callTool(AI_MEMORY_MCP_TOOLS.readPage, {
      workspace,
      project,
      path: pagePath,
    })
    const readBody =
      readBack.json && typeof readBack.json === 'object'
        ? (readBack.json as { body?: unknown }).body
        : undefined
    if (readBack.isError || typeof readBody !== 'string' || readBody !== body) {
      return { paths, hashes, message: `Read-back falhou para ${pagePath}.` }
    }
    paths.push(pagePath)
  }
  return { paths, hashes }
}

/**
 * Executa a migração de um projeto:
 * 1. receipt existente → fontes com MESMO hash são puladas; fontes novas
 *    (ex.: worktree vinculada adicionada depois) são importadas e a receipt é
 *    MERGADA — `already-migrated` quando nada muda (idempotência);
 * 2. sem conteúdo legado → `skipped-empty`;
 * 3. páginas via `memory_write_page` com tags `historical`+`do-not-answer-from`
 *    e read-back;
 * 4. receipt só depois de TODAS as páginas confirmadas.
 */
export async function runLegacyMigration(input: RunLegacyMigrationInput): Promise<MigrationOutcome> {
  const receiptPath = migrationReceiptPath(input.userDataDir, input.identity)
  const sources = input.worktrees
    ? sourcesFromWorktrees(input.worktrees)
    : sourcesFromLegacyFiles(input.markdown, input.jsonEntries)

  const receiptLookup = await loadReceiptWithRecovery(
    receiptPath,
    sha256(input.identity).slice(0, 32)
  )
  const existing = receiptLookup.kind === 'valid' ? receiptLookup.receipt : undefined
  if (receiptLookup.kind === 'uncertain' && receiptLookup.source === 'primary') {
    // Primária ilegível por I/O real: tratar como "sem receipt" deixaria a
    // migração explícita SOBRESCREVER um estado incerto. Aborta sem escrever
    // páginas nem receipt; o gate permanece fail-closed.
    return {
      status: 'failed',
      paths: [],
      message: `Receipt primária ilegível (I/O incerto) — migração abortada sem sobrescrever estado incerto: ${receiptLookup.message ?? 'erro de leitura'}`,
    }
  }
  const { workspace, project } = input.target.scope
  if (existing) {
    // Incremental: só fontes novas/alteradas (ex.: worktree vinculada nova).
    const pending = sources.filter((item) => existing.sources[item.source] !== sha256(item.body))
    if (pending.length === 0) {
      return { status: 'already-migrated', paths: existing.paths }
    }
    const confirmed = await writeAndConfirm(pending, input.target)
    if (confirmed.message !== undefined) {
      return { status: 'failed', paths: existing.paths, message: confirmed.message }
    }
    const merged: StoredReceipt = {
      version: MIGRATION_RECEIPT_VERSION,
      workspace,
      project,
      identityHash: existing.identityHash,
      sources: { ...existing.sources, ...confirmed.hashes },
      paths: [...existing.paths, ...confirmed.paths],
      concludedAt: new Date().toISOString(),
    }
    await writeReceipt(receiptPath, merged)
    return {
      status: 'migrated',
      paths: merged.paths,
      message: `Importada(s) ${confirmed.paths.length} fonte(s) nova(s) de outras worktrees.`,
    }
  }

  if (sources.length === 0) {
    return { status: 'skipped-empty', paths: [] }
  }

  const identityHash = sha256(input.identity).slice(0, 32)
  const confirmed = await writeAndConfirm(sources, input.target)
  if (confirmed.message !== undefined) {
    return { status: 'failed', paths: confirmed.paths, message: confirmed.message }
  }

  const receipt: StoredReceipt = {
    version: MIGRATION_RECEIPT_VERSION,
    workspace,
    project,
    identityHash,
    sources: confirmed.hashes,
    paths: confirmed.paths,
    concludedAt: new Date().toISOString(),
  }
  await writeReceipt(receiptPath, receipt)
  return { status: 'migrated', paths: confirmed.paths }
}

/** Guarda read-only: true quando o projeto já migrou (receipt existente). */
export async function isLegacyWriterReadOnly(
  userDataDir: string,
  identity: string
): Promise<boolean> {
  // Fail-closed: 'present' → legado bloqueado (read-only); 'error'/incerto
  // (receipt malformada, backup inválido, I/O real) → TAMBÉM bloqueia. Só
  // 'absent' (sem receipt nem backup) libera o escritor legado.
  const state = await readMigrationReceiptState(userDataDir, identity)
  return state.status !== 'absent'
}

/* ------------------------------------------------------------------ */
/* Leitura segura do legado + invocação por IPC                        */
/* ------------------------------------------------------------------ */

export interface LegacyMemoryFiles {
  markdown?: string
  jsonEntries?: MigrationJsonEntry[]
}

/**
 * Converte itens crus (array legado OU `entries` do StoredMemory v1 do
 * HybridMemory) em `MigrationJsonEntry` tolerante: campos estranhos são
 * descartados, timestamps de strings preservados, teto
 * `MIGRATION_MAX_JSON_ENTRIES` aplicado aqui também (defesa em profundidade).
 */
function parseJsonEntryItems(items: readonly unknown[]): MigrationJsonEntry[] {
  const entries: MigrationJsonEntry[] = []
  for (const item of items.slice(0, MIGRATION_MAX_JSON_ENTRIES)) {
    if (!isRecord(item)) continue
    const kind = typeof item.kind === 'string' ? item.kind : undefined
    const content = typeof item.content === 'string' ? item.content : undefined
    if (kind === undefined && content === undefined) continue
    entries.push({
      ...(kind !== undefined ? { kind } : {}),
      ...(content !== undefined ? { content } : {}),
      ...(typeof item.createdAt === 'string' ? { createdAt: item.createdAt } : {}),
      ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
    })
  }
  return entries
}

/**
 * Leitura SEGURA e tolerante dos arquivos legados de um projeto: ausência →
 * campo undefined (nunca erro); arquivo corrompido → campo undefined com o
 * resto preservado; NADA é apagado ou reescrito aqui.
 */
export async function readLegacyMemoryFiles(projectPath: string): Promise<LegacyMemoryFiles> {
  const result: LegacyMemoryFiles = {}
  try {
    result.markdown = await fs.readFile(path.join(projectPath, '.devorbit', 'memory.md'), 'utf8')
  } catch {
    // Ausente ou ilegível: sem markdown (a migração segue com o json).
  }
  try {
    const raw = JSON.parse(await fs.readFile(path.join(projectPath, '.devorbit', 'memory.json'), 'utf8')) as unknown
    if (Array.isArray(raw)) {
      result.jsonEntries = parseJsonEntryItems(raw)
    } else if (isRecord(raw) && raw.version === 1 && Array.isArray(raw.entries)) {
      // Formato REAL do HybridMemory (StoredMemory v1): `{ version: 1, entries: [...] }`.
      // Aceito sem apagar/regravar nada; versão estranha → sem entradas (tolerante).
      result.jsonEntries = parseJsonEntryItems(raw.entries)
    }
  } catch {
    // Ausente (ENOENT — caso comum) ou corrompido: sem entradas.
  }
  return result
}

export interface MigrateProjectLegacyMemoryDeps {
  userDataDir: string
  projectPath: string
  /** Escopo ai-memory do projeto (já resolvido pelo chamador). */
  scope: Pick<AiMemoryScope, 'workspace' | 'project' | 'identity'>
  /** Client MCP do ai-memory; `undefined` = serviço indisponível. */
  client: MigrationMemoryClient | undefined
  /** Opt-in EXPLÍCITO por projeto — gate antes de qualquer migração. */
  isProjectEnabled: (identity: string) => boolean
  /** Leitura dos arquivos legados (injetável para teste). */
  readLegacyFiles?: (projectPath: string) => Promise<LegacyMemoryFiles>
  /**
   * Raízes das worktrees vinculadas (mesma identidade); default = real via
   * `git worktree list` com runner injetável; sempre inclui a raiz atual.
   */
  worktreeRoots?: (projectPath: string) => Promise<string[]>
  /** Runner Git do default de `worktreeRoots` (injetável para teste). */
  gitRunner?: GitRunner
}

export type LegacyMigrationStatus = MigrationOutcome['status'] | 'disabled' | 'unavailable'

/** Resultado estruturado da invocação IPC — nunca lança. */
export interface LegacyMigrationInvocation extends Omit<MigrationOutcome, 'status'> {
  status: LegacyMigrationStatus
}

/**
 * Invocação idempotente da migração (usada pelo IPC e pelo enable):
 * - projeto sem opt-in → `disabled` (nada é migrado, NUNCA erro);
 * - serviço/client indisponível → `unavailable` (não impeditivo);
 * - caso contrário → `runLegacyMigration` (receipt garante idempotência).
 * Nunca lança: todo resultado é estruturado.
 */
export async function migrateProjectLegacyMemory(
  deps: MigrateProjectLegacyMemoryDeps
): Promise<LegacyMigrationInvocation> {
  if (!deps.isProjectEnabled(deps.scope.identity)) {
    return { status: 'disabled', paths: [], message: 'Projeto sem opt-in para o ai-memory; migração não executada.' }
  }
  if (!deps.client) {
    return {
      status: 'unavailable',
      paths: [],
      message: 'Serviço ai-memory indisponível: migração ficará pendente (legado preservado).',
    }
  }
  const runner = deps.gitRunner ?? defaultGitRunner()
  const readFn = deps.readLegacyFiles ?? readLegacyMemoryFiles
  const roots = deps.worktreeRoots
    ? await deps.worktreeRoots(deps.projectPath)
    : await listGitWorktrees(deps.projectPath, runner)

  // Raiz primária SEMPRE primeira (labels canônicos) e dedup por caminho
  // canônico — a primária é sempre preservada, mesmo se `roots` a omitir.
  const orderedRoots: string[] = [deps.projectPath]
  const seenRoots = new Set<string>([normalizePathKey(await canonicalPath(deps.projectPath))])
  for (const root of roots) {
    const key = normalizePathKey(await canonicalPath(root))
    if (seenRoots.has(key)) continue
    seenRoots.add(key)
    orderedRoots.push(root)
  }

  // Common-dir canônico do primário. Sem ele, NENHUMA raiz secundária é lida
  // (fail-closed): Git indisponível → somente a primária.
  const primaryCommonDir = await resolveGitCommonDir(deps.projectPath, runner)

  const worktrees: WorktreeLegacyInput[] = []
  for (let index = 0; index < orderedRoots.length; index += 1) {
    const root = orderedRoots[index]
    const isPrimary = index === 0
    if (!isPrimary) {
      // M1: só lê `.devorbit` de worktree REAL do MESMO repositório
      // (mesmo `git-common-dir`). Path inválido/malicioso é excluído ANTES
      // de qualquer `readLegacyFiles`.
      if (!primaryCommonDir) continue
      if (!(await validateLinkedWorktree(root, primaryCommonDir, runner))) continue
    }
    const files = await readFn(root)
    const hasContent =
      (typeof files.markdown === 'string' && files.markdown.trim().length > 0) ||
      (files.jsonEntries?.some((entry) => typeof entry.content === 'string' && entry.content.trim()) ?? false)
    if (!hasContent) continue
    worktrees.push({ root, isPrimary, files })
  }
  // Sem conteúdo em nenhuma raiz: garante que a primária apareça (runLegacy
  // decide skipped-empty).
  if (worktrees.length === 0) {
    worktrees.push({
      root: deps.projectPath,
      isPrimary: true,
      files: await readFn(deps.projectPath),
    })
  }
  try {
    return await runLegacyMigration({
      userDataDir: deps.userDataDir,
      identity: deps.scope.identity,
      target: { scope: { workspace: deps.scope.workspace, project: deps.scope.project }, client: deps.client },
      worktrees,
    })
  } catch (error) {
    return {
      status: 'failed',
      paths: [],
      message: `Migração falhou: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
