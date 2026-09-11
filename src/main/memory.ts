import path from 'node:path'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
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
  const memoryDir = path.join(projectPath, '.devorbit')
  const memoryFile = path.join(memoryDir, 'memory.md')
  const rootContextFile = path.join(projectPath, 'CONTEXT.md')

  // .devorbit/memory.md is canonical. CONTEXT.md remains a read-only legacy fallback.
  try {
    return await readMemoryFile(projectPath, memoryFile)
  } catch {
    try {
      return await readMemoryFile(projectPath, rootContextFile)
    } catch {
      const projectName = path.basename(projectPath)
      return {
        content: DEFAULT_MEMORY_TEMPLATE(projectName),
        exists: false,
        path: memoryFile,
        stale: 'unknown',
      }
    }
  }
}

async function atomicallyWriteText(file: string, content: string): Promise<void> {
  const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`
  let renamed = false

  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const handle = await fs.open(temporaryFile, 'w')
    try {
      await handle.writeFile(content, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    await fs.rename(temporaryFile, file)
    renamed = true
  } finally {
    if (!renamed) {
      await fs.rm(temporaryFile, { force: true }).catch(() => undefined)
    }
  }
}

export async function saveProjectMemory(
  projectPath: string,
  content: string
): Promise<{ success: boolean; message?: string }> {
  try {
    const memoryDir = path.join(projectPath, '.devorbit')
    const memoryFile = path.join(memoryDir, 'memory.md')

    // Manual edits are written verbatim. In particular, do not silently replace
    // the legacy CONTEXT.md or inject metadata into user-authored text.
    await atomicallyWriteText(memoryFile, content)

    return { success: true, message: 'Memória da IA salva com sucesso em .devorbit/memory.md!' }
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
