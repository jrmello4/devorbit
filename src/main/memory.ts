import path from 'node:path'
import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getGitStatus, getGitChangesSummary } from './git'

const execAsync = promisify(execFile)

export type MemoryStaleStatus = boolean | 'unknown'

export interface MemorySnapshotMetadata {
  version: 1
  branch?: string
  sourceCommit?: string
  statusFingerprint?: string
  generatedAt: string
}

export interface ProjectMemory {
  content: string
  lastUpdated?: string
  exists: boolean
  path: string
  stale?: MemoryStaleStatus
  sourceCommit?: string
  generatedAt?: string
}

const DEFAULT_MEMORY_TEMPLATE = (projectName: string) => `# 🧠 AI Memory & Handoff — ${projectName}

### 🎯 Objetivo Atual
- Definir o que estamos desenvolvendo nesta funcionalidade.

### 🧭 Onde Paramos (Handoff)
- Descreva exatamente o ponto da última sessão para a próxima IA continuar sem dúvidas.

### ⚠️ O que Falhou / Abordagens Descartadas
- Registre erros encontrados e soluções que não funcionaram (evita que a IA repita o erro).

### 💡 Decisões Técnicas & Arquitetura
- Padrões de código, bibliotecas escolhidas e regras deste projeto.

### 📋 Próximos Passos
- [ ] Próxima tarefa imediata
- [ ] Teste ou validação pendente
`

const MEMORY_METADATA_PREFIX = '<!-- devorbit-memory: '

const saveQueues = new Map<string, Promise<void>>()

interface GitSnapshot {
  branch?: string
  sourceCommit?: string
  statusFingerprint?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseMemoryMetadata(content: string): MemorySnapshotMetadata | undefined {
  const metadataLine = content
    .split(/\r?\n/)
    .find((line) => line.trimStart().startsWith(MEMORY_METADATA_PREFIX))
  if (!metadataLine) return undefined

  const trimmed = metadataLine.trim()
  if (!trimmed.startsWith(MEMORY_METADATA_PREFIX) || !trimmed.endsWith(' -->')) return undefined

  const json = trimmed.slice(MEMORY_METADATA_PREFIX.length, -' -->'.length)
  try {
    const parsed: unknown = JSON.parse(json)
    if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.generatedAt !== 'string') {
      return undefined
    }

    return {
      version: 1,
      ...(typeof parsed.branch === 'string' ? { branch: parsed.branch } : {}),
      ...(typeof parsed.sourceCommit === 'string' ? { sourceCommit: parsed.sourceCommit } : {}),
      ...(typeof parsed.statusFingerprint === 'string'
        ? { statusFingerprint: parsed.statusFingerprint }
        : {}),
      generatedAt: parsed.generatedAt,
    }
  } catch {
    return undefined
  }
}

function formatMemoryMetadata(metadata: MemorySnapshotMetadata): string {
  return `${MEMORY_METADATA_PREFIX}${JSON.stringify(metadata)} -->`
}

async function getGitSnapshot(projectPath: string, isRepo: boolean, branch?: string): Promise<GitSnapshot> {
  if (!isRepo) {
    return { statusFingerprint: 'no-git' }
  }

  try {
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      execAsync('git', ['rev-parse', 'HEAD'], {
        cwd: projectPath,
        timeout: 8000,
        windowsHide: true,
      }),
      execAsync(
        'git',
        [
          'status',
          '--porcelain=v1',
          '-b',
          '--untracked-files=all',
          '--',
          '.',
        ':(exclude).devorbit/memory.md',
        ],
        {
          cwd: projectPath,
          timeout: 8000,
          windowsHide: true,
        }
      ),
    ])
    const sourceCommit = head.trim() || undefined
    const statusFingerprint = createHash('sha256')
      .update(`${branch || ''}\n${sourceCommit || ''}\n${status}`)
      .digest('hex')

    return {
      branch: branch || undefined,
      sourceCommit,
      statusFingerprint,
    }
  } catch {
    return { branch: branch || undefined }
  }
}

function getStaleStatus(
  metadata: MemorySnapshotMetadata | undefined,
  current: GitSnapshot
): MemoryStaleStatus {
  if (!metadata || !metadata.statusFingerprint || !current.statusFingerprint) return 'unknown'
  return metadata.statusFingerprint !== current.statusFingerprint
}

function normalizePathForComparison(value: string): string {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

function assertPathInside(root: string, candidate: string): void {
  if (!isPathInside(root, candidate)) throw new Error('Unsafe memory path')
}

async function resolveProjectRoot(projectPath: string): Promise<string> {
  const candidate = path.resolve(projectPath)
  const root = await fs.realpath(candidate)
  const stats = await fs.stat(root)
  if (!stats.isDirectory()) throw new Error('Project path is not a directory')
  return root
}

async function assertCanonicalPath(root: string, candidate: string): Promise<void> {
  assertPathInside(root, candidate)
  const canonical = await fs.realpath(candidate)
  assertPathInside(root, canonical)
  if (normalizePathForComparison(canonical) !== normalizePathForComparison(candidate)) {
    throw new Error('Unsafe memory path')
  }
}

async function resolveSafeMemoryFile(root: string, createDirectory: boolean): Promise<string> {
  const memoryDir = path.join(root, '.devorbit')
  const memoryFile = path.join(memoryDir, 'memory.md')
  assertPathInside(root, memoryDir)
  assertPathInside(root, memoryFile)

  let directoryStats
  try {
    directoryStats = await fs.lstat(memoryDir)
  } catch (memoryDirError: any) {
    if (memoryDirError?.code !== 'ENOENT' || !createDirectory) return memoryFile
    await fs.mkdir(memoryDir, { recursive: true })
    directoryStats = await fs.lstat(memoryDir)
  }

  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error('Unsafe memory path')
  }
  await assertCanonicalPath(root, memoryDir)

  try {
    const fileStats = await fs.lstat(memoryFile)
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
      throw new Error('Unsafe memory path')
    }
    await assertCanonicalPath(root, memoryFile)
  } catch (memoryFileError: any) {
    if (memoryFileError?.code !== 'ENOENT') throw memoryFileError
  }

  return memoryFile
}

async function resolveSafeContextFile(root: string): Promise<string> {
  const contextFile = path.join(root, 'CONTEXT.md')
  assertPathInside(root, contextFile)
  const stats = await fs.lstat(contextFile)
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('Unsafe context path')
  await assertCanonicalPath(root, contextFile)
  return contextFile
}

async function readMemoryFile(
  projectPath: string,
  memoryFile: string
): Promise<ProjectMemory> {
  const stat = await fs.stat(memoryFile)
  const content = await fs.readFile(memoryFile, 'utf-8')
  const metadata = parseMemoryMetadata(content)
  const git = await getGitStatus(projectPath)
  const currentSnapshot = await getGitSnapshot(projectPath, git.isRepo, git.branch)

  return {
    content,
    lastUpdated: stat.mtime.toISOString(),
    exists: true,
    path: memoryFile,
    stale: getStaleStatus(metadata, currentSnapshot),
    sourceCommit: metadata?.sourceCommit,
    generatedAt: metadata?.generatedAt,
  }
}

export async function getProjectMemory(projectPath: string): Promise<ProjectMemory> {
  const requestedProjectPath = path.resolve(projectPath)
  let root: string
  try {
    root = await resolveProjectRoot(projectPath)
  } catch {
    const memoryFile = path.join(requestedProjectPath, '.devorbit', 'memory.md')
    const projectName = path.basename(requestedProjectPath)
    return {
      content: DEFAULT_MEMORY_TEMPLATE(projectName),
      exists: false,
      path: memoryFile,
      stale: 'unknown',
    }
  }

  const memoryFile = path.join(root, '.devorbit', 'memory.md')

  // .devorbit/memory.md is canonical. CONTEXT.md remains a read-only legacy fallback.
  try {
    const safeMemoryFile = await resolveSafeMemoryFile(root, false)
    return await readMemoryFile(root, safeMemoryFile)
  } catch {
    try {
      const safeContextFile = await resolveSafeContextFile(root)
      return await readMemoryFile(root, safeContextFile)
    } catch {
      const projectName = path.basename(root)
      return {
        content: DEFAULT_MEMORY_TEMPLATE(projectName),
        exists: false,
        path: memoryFile,
        stale: 'unknown',
      }
    }
  }
}

async function atomicallyWriteText(root: string, file: string, content: string): Promise<void> {
  await resolveSafeMemoryFile(root, true)
  const temporaryFile = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  let temporaryCreated = false
  let renamed = false

  try {
    const handle = await fs.open(temporaryFile, 'wx')
    temporaryCreated = true
    try {
      await handle.writeFile(content, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    await resolveSafeMemoryFile(root, true)
    await fs.rename(temporaryFile, file)
    renamed = true
  } finally {
    if (temporaryCreated && !renamed) {
      await fs.rm(temporaryFile, { force: true }).catch(() => undefined)
    }
  }
}

async function enqueueProjectSave<T extends { success: boolean; message?: string }>(
  root: string,
  operation: () => Promise<T>
): Promise<T> {
  const queueKey = normalizePathForComparison(root)
  const previous = saveQueues.get(queueKey) ?? Promise.resolve()
  const current = previous.then(operation)
  const tail = current.then(
    () => undefined,
    () => undefined
  )
  saveQueues.set(queueKey, tail)

  try {
    return await current
  } finally {
    if (saveQueues.get(queueKey) === tail) saveQueues.delete(queueKey)
  }
}

export async function saveProjectMemory(
  projectPath: string,
  content: string
): Promise<{ success: boolean; message?: string }> {
  try {
    const root = await resolveProjectRoot(projectPath)
    return await enqueueProjectSave(root, async () => {
      const memoryFile = await resolveSafeMemoryFile(root, true)

      // Manual edits are written verbatim. In particular, do not silently replace
      // the legacy CONTEXT.md or inject metadata into user-authored text.
      await atomicallyWriteText(root, memoryFile, content)

      return { success: true, message: 'Memória da IA salva com sucesso em .devorbit/memory.md!' }
    })
  } catch (err: any) {
    return { success: false, message: `Erro ao salvar memória: ${err.message}` }
  }
}

export async function generateMemoryFromGit(projectPath: string): Promise<string> {
  const projectName = path.basename(projectPath)
  const git = await getGitStatus(projectPath)
  const changes = await getGitChangesSummary(projectPath)
  const snapshot = await getGitSnapshot(projectPath, git.isRepo, git.branch)
  const generatedAt = new Date().toISOString()
  const metadata: MemorySnapshotMetadata = {
    version: 1,
    ...(snapshot.branch ? { branch: snapshot.branch } : {}),
    ...(snapshot.sourceCommit ? { sourceCommit: snapshot.sourceCommit } : {}),
    ...(snapshot.statusFingerprint ? { statusFingerprint: snapshot.statusFingerprint } : {}),
    generatedAt,
  }

  let recentCommits = ''
  if (git.isRepo) {
    try {
      const { stdout } = await execAsync('git', ['log', '-n', '3', '--oneline'], {
        cwd: projectPath,
        timeout: 8000,
        windowsHide: true,
      })
      recentCommits = stdout.trim()
    } catch {
      // Sem commits ainda
    }
  }

  const lines: string[] = [
    formatMemoryMetadata(metadata),
    `# 🧠 AI Memory & Handoff — ${projectName}`,
    ``,
    `### 🎯 Objetivo Atual`,
    `- Trabalhando na branch \`${git.isRepo ? git.branch : 'sem Git'}\`.`,
  ]

  if (changes.length > 0) {
    lines.push(
      `- Alterações recentes em andamento nos arquivos:`,
      ...changes.slice(0, 5).map((change) => `  - \`${change}\``)
    )
  }

  lines.push(
    ``,
    `### 🧭 Onde Paramos (Handoff)`,
    `- Status do Git: ${git.isRepo ? git.statusMessage : 'Sem repositório Git configurado'}.`,
    recentCommits
      ? `- Últimos commits registrados:\n${recentCommits
          .split('\n')
          .map((commit) => `  - ${commit}`)
          .join('\n')}`
      : `- Nenhum commit recente.`,
    ``,
    `### ⚠️ O que Falhou / Abordagens Descartadas`,
    `- Registre aqui se algo não funcionou para a próxima IA não repetir o erro.`,
    ``,
    `### 💡 Decisões Técnicas & Arquitetura`,
    `- Projeto: \`${projectName}\``,
    `- Mantenha as convenções de arquitetura já existentes no repositório.`,
    ``,
    `### 📋 Próximos Passos`,
    changes.length > 0
      ? `- [ ] Testar e validar as alterações pendentes nos ${changes.length} arquivos modificados`
      : `- [ ] Definir próxima funcionalidade`,
    `- [ ] Realizar commit e push para a branch \`${git.isRepo ? git.branch : 'sem Git'}\``
  )

  return lines.join('\n')
}

/**
 * Compactação semântica de contexto (FASE 3).
 *
 * Remove registros obsoletos de `.devorbit/memory.md` — linhas em branco
 * repetidas, bullets `- ` duplicados e cauda além do orçamento — preservando
 * cabeçalhos, a primeira ocorrência de cada bullet e a ordem original. Nunca
 * altera edições manuais por conta própria: a compactação só acontece via
 * `compactProjectMemory` (sob demanda) ou `scheduleMemoryCompaction`
 * (periódica e opt-in).
 */
export const MEMORY_COMPACTION_MAX_CHARS = 12_000
export const MEMORY_COMPACTION_INTERVAL_MS = 15 * 60_000

export interface MemoryCompactionReport {
  compacted: boolean
  originalChars: number
  compactedChars: number
  removedLines: number
  truncated: boolean
}

export function needsCompaction(content: unknown): boolean {
  if (typeof content !== 'string' || !content) return false
  if (content.length > MEMORY_COMPACTION_MAX_CHARS) return true
  const lines = content.split('\n')
  const seen = new Set<string>()
  let blankRun = 0
  for (const line of lines) {
    if (!line.trim()) {
      blankRun += 1
      if (blankRun > 1) return true
      continue
    }
    blankRun = 0
    const normalized = line.trim()
    if (normalized.startsWith('- ') && normalized.length > 2) {
      if (seen.has(normalized)) return true
      seen.add(normalized)
    }
  }
  return false
}

export function compactMemoryContent(content: string): { content: string; report: MemoryCompactionReport } {
  const originalChars = content.length
  const output: string[] = []
  const seenBullets = new Set<string>()
  let blankRun = 0
  let removedLines = 0
  for (const line of content.split('\n')) {
    if (!line.trim()) {
      blankRun += 1
      if (blankRun > 1) {
        removedLines += 1
        continue
      }
      output.push(line)
      continue
    }
    blankRun = 0
    const normalized = line.trim()
    if (normalized.startsWith('- ') && normalized.length > 2) {
      if (seenBullets.has(normalized)) {
        removedLines += 1
        continue
      }
      seenBullets.add(normalized)
    }
    output.push(line)
  }
  let compacted = output.join('\n')
  let truncated = false
  if (compacted.length > MEMORY_COMPACTION_MAX_CHARS) {
    truncated = true
    // Reserva o espaço do marcador para o resultado final nunca passar do
    // orçamento — senão needsCompaction continuaria true para sempre.
    const marker = '\n…(memória compactada automaticamente)'
    const budget = Math.max(0, MEMORY_COMPACTION_MAX_CHARS - marker.length)
    const beforeLines = compacted.split('\n').length
    compacted = compacted.slice(0, budget).replace(/\n[^\n]*$/, '') + marker
    removedLines += Math.max(0, beforeLines - compacted.split('\n').length)
  }
  return {
    content: compacted,
    report: {
      compacted: removedLines > 0 || truncated,
      originalChars,
      compactedChars: compacted.length,
      removedLines,
      truncated,
    },
  }
}

export async function compactProjectMemory(projectPath: string): Promise<MemoryCompactionReport & { success: boolean; message?: string }> {
  let root: string
  try {
    root = await resolveProjectRoot(projectPath)
  } catch (error) {
    return { success: false, compacted: false, originalChars: 0, compactedChars: 0, removedLines: 0, truncated: false, message: error instanceof Error ? error.message : String(error) }
  }
  return enqueueProjectSave(root, async () => {
    let memoryFile: string
    try {
      memoryFile = await resolveSafeMemoryFile(root, false)
    } catch {
      return { success: true, compacted: false, originalChars: 0, compactedChars: 0, removedLines: 0, truncated: false, message: 'Sem memória para compactar.' }
    }
    let current: string
    try {
      current = await fs.readFile(memoryFile, 'utf-8')
    } catch (error) {
      // Projeto sem .devorbit/memory.md: no-op bem-sucedido para o scheduler
      // periódico não rejeitar (e não poluir logs) a cada intervalo.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { success: true, compacted: false, originalChars: 0, compactedChars: 0, removedLines: 0, truncated: false, message: 'Sem memória para compactar.' }
      }
      throw error
    }
    const { content, report } = compactMemoryContent(current)
    if (!report.compacted) {
      return { success: true, ...report, message: 'Memória já está dentro do orçamento.' }
    }
    await atomicallyWriteText(root, memoryFile, content)
    return { success: true, ...report, message: `Memória compactada: ${report.removedLines} linha(s) removida(s).` }
  })
}

const compactionTimers = new Map<string, ReturnType<typeof setInterval>>()

function compactionKey(projectPath: string): string {
  return normalizePathForComparison(path.resolve(projectPath))
}

export function scheduleMemoryCompaction(
  projectPath: string,
  intervalMs = MEMORY_COMPACTION_INTERVAL_MS,
  runner: (projectPath: string) => Promise<unknown> = compactProjectMemory
): () => void {
  const key = normalizePathForComparison(path.resolve(projectPath))
  cancelMemoryCompaction(projectPath)
  const timer = setInterval(() => {
    void runner(projectPath).catch(() => undefined)
  }, Math.max(60_000, intervalMs))
  if (typeof timer.unref === 'function') timer.unref()
  compactionTimers.set(key, timer)
  return () => cancelMemoryCompaction(projectPath)
}

export function cancelMemoryCompaction(projectPath: string): void {
  const key = compactionKey(projectPath)
  const timer = compactionTimers.get(key)
  if (timer) {
    clearInterval(timer)
    compactionTimers.delete(key)
  }
}

export function cancelAllMemoryCompactions(): void {
  for (const timer of compactionTimers.values()) clearInterval(timer)
  compactionTimers.clear()
}

export function activeCompactionCount(): number {
  return compactionTimers.size
}

/**
 * Controlador de ciclo de vida: liga o scheduler aos projetos ativos —
 * agenda os novos, cancela os removidos. Chamado após scans e no encerramento.
 */
export function syncMemorySchedulers(
  projectPaths: readonly unknown[],
  runner: (projectPath: string) => Promise<unknown> = compactProjectMemory
): void {
  // Valida ANTES de path.resolve: uma entrada inválida nunca pode quebrar o
  // ciclo de scan que chama este controlador.
  const validPaths = projectPaths.filter(
    (entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()) && !entry.includes('\0')
  )
  const active = new Set(validPaths.map(compactionKey))
  for (const [key] of compactionTimers) {
    if (!active.has(key)) {
      const timer = compactionTimers.get(key)
      if (timer) clearInterval(timer)
      compactionTimers.delete(key)
    }
  }
  const scheduled = new Set(compactionTimers.keys())
  for (const projectPath of validPaths) {
    if (!scheduled.has(compactionKey(projectPath))) {
      scheduleMemoryCompaction(projectPath, MEMORY_COMPACTION_INTERVAL_MS, runner)
    }
  }
}
