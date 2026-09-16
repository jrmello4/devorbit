import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs/promises'
import { isGitRepository } from './git'

const execFileAsync = promisify(execFile)

export const GIT_DIFF_MAX_PATH_LENGTH = 4096
export const GIT_DIFF_MAX_BYTES = 100_000
export const GIT_DIFF_MAX_LINES = 2000
export const GIT_DIFF_MAX_FILE_BYTES = 200_000

export interface GitFileDiff {
  path: string
  status: string
  headExists: boolean
  worktreeExists: boolean
  binary: boolean
  truncated: boolean
  diff: string
  headContent: string
  worktreeContent: string
  message: string
}

export function validateGitDiffPathspec(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('Caminho de arquivo para diff inválido.')
  }
  const trimmed = value.trim().replaceAll('\\', '/')
  if (trimmed.length === 0 || trimmed.length > GIT_DIFF_MAX_PATH_LENGTH) {
    throw new Error('Caminho de arquivo para diff inválido.')
  }
  if (
    /^[A-Za-z]:/.test(value) ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('-') ||
    trimmed.startsWith(':') ||
    trimmed.startsWith('!') ||
    trimmed.startsWith('^') ||
    trimmed.includes('\r') ||
    trimmed.includes('\n') ||
    trimmed.includes('//') ||
    trimmed.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error('Caminho de arquivo para diff inválido.')
  }
  if (/[*?[\]{}!]/.test(trimmed)) {
    throw new Error('Caminho de arquivo para diff inválido.')
  }
  return trimmed
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000)
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] === 0) return true
  }
  return false
}

function decodeBounded(buffer: Buffer, limit = GIT_DIFF_MAX_FILE_BYTES): { text: string; truncated: boolean } {
  if (buffer.byteLength > limit) {
    return { text: new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, limit)), truncated: true }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), truncated: false }
  } catch {
    return { text: new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, limit)), truncated: true }
  }
}

function truncateDiff(diff: string): { diff: string; truncated: boolean } {
  const lines = diff.split('\n')
  let truncated = false
  let output = diff
  if (lines.length > GIT_DIFF_MAX_LINES) {
    output = lines.slice(0, GIT_DIFF_MAX_LINES).join('\n')
    truncated = true
  }
  if (Buffer.byteLength(output, 'utf8') > GIT_DIFF_MAX_BYTES) {
    const buffer = Buffer.from(output, 'utf8').subarray(0, GIT_DIFF_MAX_BYTES)
    output = buffer.toString('utf8')
    truncated = true
  }
  return { diff: output, truncated }
}

function assertInsideRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Caminho de arquivo para diff inválido.')
  }
}

async function hasHeadCommit(repoPath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repoPath,
      timeout: 8000,
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}

async function readWorktreeFile(repoPath: string, relativePath: string): Promise<{ exists: boolean; content: string; binary: boolean; truncated: boolean }> {
  const root = await fs.realpath(repoPath)
  const candidate = path.resolve(root, relativePath)
  assertInsideRoot(root, candidate)
  let stats
  try {
    stats = await fs.lstat(candidate)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { exists: false, content: '', binary: false, truncated: false }
    }
    throw error
  }
  if (stats.isSymbolicLink()) {
    throw new Error('Links simbólicos não podem ser abertos pelo diff.')
  }
  const realFile = await fs.realpath(candidate).catch(() => candidate)
  assertInsideRoot(root, realFile)
  try {
    const fileStats = await fs.stat(realFile)
    if (!fileStats.isFile()) return { exists: false, content: '', binary: false, truncated: false }
    if (fileStats.size > GIT_DIFF_MAX_FILE_BYTES * 4) {
      const handle = await fs.open(realFile, 'r')
      try {
        const buffer = Buffer.alloc(Math.min(fileStats.size, GIT_DIFF_MAX_FILE_BYTES))
        await handle.read(buffer, 0, buffer.length, 0)
        if (isBinaryBuffer(buffer)) return { exists: true, content: '', binary: true, truncated: true }
        const decoded = decodeBounded(buffer)
        return { exists: true, content: decoded.text, binary: false, truncated: true }
      } finally {
        await handle.close()
      }
    }
    const buffer = await fs.readFile(realFile)
    if (isBinaryBuffer(buffer)) return { exists: true, content: '', binary: true, truncated: false }
    const decoded = decodeBounded(buffer)
    return { exists: true, content: decoded.text, binary: false, truncated: decoded.truncated }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { exists: false, content: '', binary: false, truncated: false }
    }
    throw error
  }
}

async function readHeadFile(repoPath: string, relativePath: string): Promise<{ exists: boolean; content: string; binary: boolean; truncated: boolean }> {
  try {
    const child = await execFileAsync('git', ['show', `HEAD:${relativePath}`], {
      cwd: repoPath,
      timeout: 8000,
      windowsHide: true,
      maxBuffer: GIT_DIFF_MAX_FILE_BYTES * 4,
    })
    const stdout = typeof child.stdout === 'string' ? child.stdout : String(child.stdout ?? '')
    const buffer = Buffer.from(stdout, 'utf8')
    if (isBinaryBuffer(buffer)) return { exists: true, content: '', binary: true, truncated: false }
    const decoded = decodeBounded(buffer)
    return { exists: true, content: decoded.text, binary: false, truncated: decoded.truncated }
  } catch {
    return { exists: false, content: '', binary: false, truncated: false }
  }
}

export async function getGitFileDiff(repoPath: string, relativePath: unknown): Promise<GitFileDiff> {
  const safePath = validateGitDiffPathspec(relativePath)
  if (!(await isGitRepository(repoPath))) {
    throw new Error('Esta pasta não é um repositório Git.')
  }
  const hasHead = await hasHeadCommit(repoPath)

  let status = '  '
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '--', safePath], {
      cwd: repoPath,
      timeout: 8000,
      windowsHide: true,
    })
    const first = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0]
    if (first && first.length >= 2) status = first.slice(0, 2)
  } catch {
    status = '  '
  }

  let rawDiff = ''
  let binaryFromDiff = false
  if (hasHead) {
    try {
      const { stdout, stderr } = await execFileAsync('git', ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--', safePath], {
        cwd: repoPath,
        timeout: 8000,
        windowsHide: true,
        maxBuffer: GIT_DIFF_MAX_BYTES * 4,
      })
      rawDiff = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`
      if (/^Binary files .* differ/m.test(rawDiff)) binaryFromDiff = true
    } catch (error) {
      const text = String((error as { stdout?: unknown; stderr?: unknown })?.stdout || (error as { stderr?: unknown })?.stderr || '')
      // `fatal: bad revision 'HEAD'` indica repo sem commit; nunca deve vazar
      // como diff. Nesse caso o conteúdo é sintetizado do working tree abaixo.
      if (!/bad revision.*HEAD/i.test(text) && text) {
        rawDiff = text
        if (/^Binary files .* differ/m.test(rawDiff)) binaryFromDiff = true
      }
    }
  }

  // Arquivos untracked (ou repo sem HEAD) não aparecem em `git diff HEAD`;
  // o diff útil é o próprio conteúdo do working tree limitado.
  const [head, worktree] = await Promise.all([
    hasHead ? readHeadFile(repoPath, safePath) : Promise.resolve({ exists: false, content: '', binary: false, truncated: false }),
    readWorktreeFile(repoPath, safePath),
  ])

  if (!rawDiff.trim() && worktree.exists && !head.exists && !worktree.binary) {
    const lines = worktree.content.split('\n').slice(0, GIT_DIFF_MAX_LINES)
    rawDiff = `--- /dev/null\n+++ b/${safePath}\n${lines.map((line) => `+${line}`).join('\n')}`
  }

  const { diff, truncated: diffTruncated } = truncateDiff(rawDiff.slice(0, GIT_DIFF_MAX_BYTES * 2))
  const truncated = diffTruncated || head.truncated || worktree.truncated
  const binary = binaryFromDiff || head.binary || worktree.binary

  return {
    path: safePath,
    status,
    headExists: head.exists,
    worktreeExists: worktree.exists,
    binary,
    truncated,
    diff: binary ? '' : diff.slice(0, GIT_DIFF_MAX_BYTES),
    headContent: head.binary ? '' : head.content,
    worktreeContent: worktree.binary ? '' : worktree.content,
    message: binary
      ? 'Arquivo binário: prévia de texto indisponível.'
      : !head.exists && !worktree.exists
        ? 'Arquivo não encontrado no HEAD nem no working tree.'
        : truncated
          ? 'Prévia truncada pelos limites de segurança.'
          : 'Diff do working tree contra HEAD.',
  }
}
