import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { canonicalizeExistingDirectory, validateHttpsUrl } from './validation'
import { isGitRepository } from './git'

const execFileAsync = promisify(execFile)

const MAX_BRANCH_LENGTH = 100
const MAX_PREVIEW_FILES = 500
const gitInitLocks = new Map<string, Promise<GitInitResult>>()

export interface GitInitPreview {
  path: string
  canInitialize: boolean
  isRepository: boolean
  branch: string
  fileCount: number
  files: string[]
  truncated: boolean
  fingerprint: string
  message: string
}

export interface GitInitOptions {
  branch?: string
  remoteUrl?: string
  initialCommit?: boolean
  commitMessage?: string
  push?: boolean
  /** Required when creating the first commit: the user saw the file preview. */
  confirmAllFiles?: boolean
  /** Fingerprint returned by the preview that the user explicitly confirmed. */
  previewFingerprint?: string
}

export interface GitInitResult {
  success: boolean
  initialized: boolean
  commitCreated: boolean
  pushed: boolean
  branch: string
  remoteUrl?: string
  preview: GitInitPreview
  message: string
  output?: string
}

function lockKey(directory: string): string {
  const resolved = path.normalize(path.resolve(directory))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function commandText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error || '')
  const value = error as { stderr?: unknown; stdout?: unknown; message?: unknown }
  return String(value.stderr || value.stdout || value.message || '').trim()
}

function validateBranchName(value: unknown): string {
  const branch = typeof value === 'string' && value.trim() ? value.trim() : 'main'
  if (
    branch.length > MAX_BRANCH_LENGTH ||
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.startsWith('.') ||
    branch.endsWith('.') ||
    branch.includes('..') ||
    Array.from(branch).some((character) => character.charCodeAt(0) <= 0x20) ||
    /[~^:?*[\\]/.test(branch)
  ) {
    throw new Error('Nome de branch inválido.')
  }
  return branch
}

function validateCommitMessage(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) {
    throw new Error('Mensagem do commit inválida.')
  }
  return value.trim()
}

function parseStatus(status: string): string[] {
  return status
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function createPreviewFingerprint(files: string[], fileCount: number, truncated: boolean): string {
  return createHash('sha256')
    .update(JSON.stringify({ files, fileCount, truncated }))
    .digest('hex')
}

function asInitializedPreview(preview: GitInitPreview, message: string): GitInitPreview {
  return {
    ...preview,
    canInitialize: false,
    isRepository: true,
    message,
  }
}

async function listPreviewFiles(directory: string): Promise<Pick<GitInitPreview, 'fileCount' | 'files' | 'truncated'>> {
  const files: string[] = []
  let fileCount = 0
  let truncated = false
  const pending = [directory]

  while (pending.length > 0) {
    const current = pending.pop() as string
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      // A locked/unreadable folder should not make it possible to claim that
      // every file was reviewed. Surface truncation in the preview instead.
      truncated = true
      continue
    }

    for (const entry of entries) {
      if (entry.name === '.git') continue
      const absolute = path.join(current, entry.name)
      if (entry.isSymbolicLink()) {
        // Git stages a symlink itself rather than traversing its target. Keep
        // it visible in the preview so the file count cannot under-report what
        // `git add -A` may include.
        fileCount += 1
        if (files.length < MAX_PREVIEW_FILES) {
          files.push(path.relative(directory, absolute))
        } else {
          truncated = true
        }
        continue
      }
      if (entry.isDirectory()) {
        pending.push(absolute)
        continue
      }
      if (!entry.isFile()) continue

      fileCount += 1
      if (files.length < MAX_PREVIEW_FILES) {
        files.push(path.relative(directory, absolute))
      } else {
        truncated = true
      }
    }
  }

  files.sort((a, b) => a.localeCompare(b))
  return { fileCount, files, truncated }
}

export async function getGitInitPreview(inputPath: unknown, branch = 'main'): Promise<GitInitPreview> {
  const directory = await canonicalizeExistingDirectory(inputPath, 'Caminho de projeto')
  const safeBranch = validateBranchName(branch)
  const isRepository = await isGitRepository(directory)
  const files = await listPreviewFiles(directory)
  const fingerprint = createPreviewFingerprint(files.files, files.fileCount, files.truncated)

  return {
    path: directory,
    canInitialize: !isRepository,
    isRepository,
    branch: safeBranch,
    ...files,
    fingerprint,
    message: isRepository
      ? 'Esta pasta já é um repositório Git. Nenhum arquivo será alterado.'
      : `${files.fileCount} arquivo(s) encontrado(s). Revise antes de criar o primeiro commit.`,
  }
}

async function runGit(args: string[], directory: string, timeout = 15000): Promise<string> {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd: directory,
    timeout,
    windowsHide: true,
  })
  return `${stdout || ''}\n${stderr || ''}`.trim()
}

async function remoteHasRefs(remoteUrl: string, directory: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['ls-remote', '--refs', remoteUrl], {
    cwd: directory,
    timeout: 30000,
    windowsHide: true,
  })
  return String(stdout || '').trim().length > 0
}

async function initGitUnlocked(directory: string, options: GitInitOptions, preview: GitInitPreview): Promise<GitInitResult> {
  const branch = validateBranchName(options.branch)
  const remoteUrl = options.remoteUrl === undefined || options.remoteUrl === null ||
    (typeof options.remoteUrl === 'string' && options.remoteUrl.trim() === '')
    ? undefined
    : validateHttpsUrl(options.remoteUrl)
  const initialCommit = options.initialCommit === true
  const push = options.push === true
  const expectedFingerprint = typeof options.previewFingerprint === 'string'
    ? options.previewFingerprint.trim()
    : ''

  if (preview.isRepository || await isGitRepository(directory)) {
    return {
      success: false,
      initialized: false,
      commitCreated: false,
      pushed: false,
      branch,
      remoteUrl,
      preview: { ...preview, canInitialize: false, isRepository: true },
      message: 'Esta pasta já possui um repositório Git. O DevOrbit não o substituirá nem alterará o remote.',
    }
  }
  if (push && !remoteUrl) {
    return {
      success: false,
      initialized: false,
      commitCreated: false,
      pushed: false,
      branch,
      preview,
      message: 'Para fazer push, informe uma URL HTTPS de remote.',
    }
  }
  if (push && !initialCommit) {
    return {
      success: false,
      initialized: false,
      commitCreated: false,
      pushed: false,
      branch,
      remoteUrl,
      preview,
      message: 'O push inicial exige a criação do primeiro commit.',
    }
  }
  if (initialCommit && options.confirmAllFiles !== true) {
    return {
      success: false,
      initialized: false,
      commitCreated: false,
      pushed: false,
      branch,
      remoteUrl,
      preview,
      message: 'Confirme a pré-visualização: todos os arquivos não ignorados poderão entrar no commit.',
    }
  }
  if (initialCommit && !expectedFingerprint) {
    return {
      success: false,
      initialized: false,
      commitCreated: false,
      pushed: false,
      branch,
      remoteUrl,
      preview,
      message: 'Atualize a prévia dos arquivos antes de confirmar o primeiro commit.',
    }
  }
  if (initialCommit && preview.truncated) {
    return {
      success: false,
      initialized: false,
      commitCreated: false,
      pushed: false,
      branch,
      remoteUrl,
      preview,
      message: 'A prévia está incompleta. Reduza o escopo ou resolva as pastas ilegíveis antes de criar o commit.',
    }
  }
  if (initialCommit && expectedFingerprint !== preview.fingerprint) {
    return {
      success: false,
      initialized: false,
      commitCreated: false,
      pushed: false,
      branch,
      remoteUrl,
      preview,
      message: 'Os arquivos do projeto mudaram desde a prévia. Revise a lista atualizada antes de continuar.',
    }
  }
  if (push && remoteUrl) {
    try {
      if (await remoteHasRefs(remoteUrl, directory)) {
        return {
          success: false,
          initialized: false,
          commitCreated: false,
          pushed: false,
          branch,
          remoteUrl,
          preview,
          message: 'O remote já possui histórico. Use um remote vazio ou clone o projeto para preservar o histórico remoto.',
        }
      }
    } catch (error) {
      const text = commandText(error)
      return {
        success: false,
        initialized: false,
        commitCreated: false,
        pushed: false,
        branch,
        remoteUrl,
        preview,
        message: `Não foi possível verificar o remote antes do push: ${text || 'erro desconhecido'}`,
        output: text || undefined,
      }
    }
  }

  const output: string[] = []
  let initialized = false
  try {
    output.push(await runGit(['init', '--initial-branch', branch], directory))
    initialized = true

    // Recompute the file set after creating .git. If anything appeared,
    // disappeared, or became unreadable while the modal was open, do not stage
    // it under a stale confirmation.
    const currentPreview = await getGitInitPreview(directory, branch)
    if (initialCommit && currentPreview.fingerprint !== expectedFingerprint) {
      return {
        success: false,
        initialized: true,
        commitCreated: false,
        pushed: false,
        branch,
        remoteUrl,
        preview: {
          ...currentPreview,
          message: 'Os arquivos mudaram enquanto o repositório era criado. Nenhum arquivo foi adicionado ao commit.',
        },
        message: 'Os arquivos mudaram enquanto o repositório era criado. Revise a prévia e tente novamente.',
        output: output.filter(Boolean).join('\n'),
      }
    }

    // A second status check catches files created/removed while the modal was
    // open, before `git add -A` can stage them. The fingerprint checks above
    // make this an explicit guard rather than merely diagnostic output.
    const beforeAdd = await runGit(['status', '--short', '--untracked-files=all'], directory)
    output.push(beforeAdd)
    const statusEntries = parseStatus(beforeAdd)
    if (initialCommit && preview.fileCount > 0 && statusEntries.length === 0) {
      const message = 'Nenhum arquivo versionável foi encontrado para o primeiro commit. Verifique regras de ignore.'
      return {
        success: false,
        initialized: true,
        commitCreated: false,
        pushed: false,
        branch,
        remoteUrl,
        preview: asInitializedPreview(preview, message),
        message,
        output: output.filter(Boolean).join('\n'),
      }
    }

    if (remoteUrl) {
      output.push(await runGit(['remote', 'add', 'origin', remoteUrl], directory))
    }

    let commitCreated = false
    if (initialCommit) {
      const commitMessage = validateCommitMessage(options.commitMessage || 'chore: inicializa repositório')
      output.push(await runGit(['add', '-A'], directory, 30000))
      const staged = await runGit(['status', '--short'], directory)
      output.push(staged)
      output.push(await runGit(['commit', '-m', commitMessage], directory, 30000))
      commitCreated = true
    }

    let pushed = false
    if (push) {
      try {
        // Explicit branch/upstream; never use --force or merge remote history.
        output.push(await runGit(['push', '--set-upstream', 'origin', branch], directory, 60000))
        pushed = true
      } catch (error) {
        const text = commandText(error)
        const remoteRejected = /rejected|fetch first|non-fast-forward|unrelated histories|failed to push/i.test(text)
        return {
          success: false,
          initialized: true,
          commitCreated,
          pushed: false,
          branch,
          remoteUrl,
          preview: asInitializedPreview(preview, 'O repositório foi criado, mas o push não foi concluído.'),
          message: remoteRejected
            ? 'O push foi recusado: o remote já possui histórico. Use um remote vazio ou clone o projeto para preservar o histórico remoto.'
            : 'O repositório foi criado, mas o push falhou. Verifique credenciais, rede e permissões do remote.',
          output: [...output, text].filter(Boolean).join('\n'),
        }
      }
    }

    return {
      success: true,
      initialized: true,
      commitCreated,
      pushed,
      branch,
      remoteUrl,
      preview,
      message: pushed
        ? 'Repositório criado, primeiro commit realizado e enviado com sucesso.'
        : commitCreated
          ? 'Repositório criado e primeiro commit realizado localmente.'
          : 'Repositório Git criado. Nenhum arquivo foi commitado automaticamente.',
      output: output.filter(Boolean).join('\n'),
    }
  } catch (error) {
    const text = commandText(error)
    if (!initialized) {
      initialized = await isGitRepository(directory)
    }
    const remoteAlreadyExists = /remote\s+origin\s+already exists/i.test(text)
    const message = remoteAlreadyExists
      ? 'Repositório criado, mas o remote origin já existe. Nenhum remote existente foi substituído.'
      : initialized
        ? `Repositório criado, mas a operação não foi concluída: ${text || 'erro desconhecido'}`
        : `Não foi possível criar o repositório: ${text || 'erro desconhecido'}`
    return {
      success: false,
      initialized,
      commitCreated: false,
      pushed: false,
      branch,
      remoteUrl,
      preview: initialized ? asInitializedPreview(preview, message) : preview,
      message,
      output: [...output, text].filter(Boolean).join('\n'),
    }
  }
}

export async function initGitRepository(inputPath: unknown, options: GitInitOptions = {}): Promise<GitInitResult> {
  const preview = await getGitInitPreview(inputPath, options.branch || 'main')
  const directory = preview.path
  const key = lockKey(directory)
  const previous = gitInitLocks.get(key)
  const current = (previous ?? Promise.resolve()).catch(() => undefined).then(() => initGitUnlocked(directory, options, preview))
  gitInitLocks.set(key, current)
  try {
    return await current
  } finally {
    if (gitInitLocks.get(key) === current) gitInitLocks.delete(key)
  }
}
