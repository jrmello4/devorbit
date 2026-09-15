import fs from 'node:fs/promises'
import path from 'node:path'

export const MAX_PROJECT_FILE_BYTES = 1_500_000
export const MAX_PROJECT_TREE_ENTRIES = 600
const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'release',
  'coverage',
  '.next',
  '.turbo',
  'build',
  'out',
  'target',
  '.cache',
])

export interface ProjectFileEntry {
  path: string
  name: string
  kind: 'file' | 'directory'
  size?: number
  editable?: boolean
}

export interface ProjectFileContent {
  path: string
  content: string
  size: number
}

export interface ProjectFileTree {
  entries: ProjectFileEntry[]
  truncated: boolean
}

function normalizeRelativePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('Caminho de arquivo inválido.')
  }

  const normalized = path.normalize(value.trim())
  if (
    path.isAbsolute(normalized) ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('..' + path.sep) ||
    normalized.startsWith('../') ||
    normalized.startsWith('..\\')
  ) {
    throw new Error('O arquivo precisa estar dentro do projeto.')
  }

  return normalized
}

function normalizeRelativeDirectory(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error('Diretório de arquivos inválido.')
  }

  const normalized = path.normalize(value.trim())
  if (
    normalized === '.' ||
    path.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('..' + path.sep) ||
    normalized.startsWith('../') ||
    normalized.startsWith('..\\')
  ) {
    if (normalized === '.') return ''
    throw new Error('O diretório precisa estar dentro do projeto.')
  }

  return normalized
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate)
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('O arquivo precisa estar dentro do projeto.')
  }
}

async function resolveProjectRoot(projectPath: string): Promise<string> {
  if (typeof projectPath !== 'string' || !projectPath.trim() || projectPath.includes('\0')) {
    throw new Error('Projeto inválido.')
  }

  const root = await fs.realpath(projectPath.trim())
  const stats = await fs.stat(root)
  if (!stats.isDirectory()) throw new Error('O projeto precisa ser uma pasta.')
  return root
}

async function resolveProjectFile(projectPath: string, relativePath: unknown): Promise<{ root: string; file: string }> {
  const root = await resolveProjectRoot(projectPath)
  const normalized = normalizeRelativePath(relativePath)
  const candidate = path.resolve(root, normalized)
  assertInside(root, candidate)

  const file = await fs.realpath(candidate)
  assertInside(root, file)
  return { root, file }
}

async function resolveProjectDirectory(
  projectPath: string,
  relativeDirectory: unknown
): Promise<{ root: string; directory: string; relativeDirectory: string }> {
  const root = await resolveProjectRoot(projectPath)
  const normalized = normalizeRelativeDirectory(relativeDirectory)
  const candidate = path.resolve(root, normalized || '.')
  assertInside(root, candidate)

  const directory = await fs.realpath(candidate)
  assertInside(root, directory)
  const stats = await fs.stat(directory)
  if (!stats.isDirectory()) throw new Error('O diretório selecionado não é uma pasta.')

  return {
    root,
    directory,
    relativeDirectory: path.relative(root, directory),
  }
}

function decodeText(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new Error('Este arquivo não parece ser um texto UTF-8 editável.')
  }
}

function isEditableName(name: string): boolean {
  return !/\.(?:png|jpe?g|gif|webp|ico|svgz|pdf|zip|7z|rar|exe|dll|bin|db|sqlite)$/i.test(name)
}

export async function listProjectFiles(projectPath: string, relativeDirectory?: unknown): Promise<ProjectFileTree> {
  const { root, directory, relativeDirectory: baseDirectory } = await resolveProjectDirectory(projectPath, relativeDirectory)
  const result: ProjectFileEntry[] = []
  let truncated = false

  const entries = await fs.readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1
    return left.name.localeCompare(right.name, 'pt-BR', { sensitivity: 'base' })
  })

  for (const entry of entries) {
    if (!entry.name || entry.name === '.' || entry.name === '..') continue
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) continue
    if (entry.isSymbolicLink()) continue
    if (result.length >= MAX_PROJECT_TREE_ENTRIES) {
      truncated = true
      break
    }

    const relativePath = baseDirectory ? path.join(baseDirectory, entry.name) : entry.name
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      result.push({ path: relativePath, name: entry.name, kind: 'directory' })
      continue
    }
    if (!entry.isFile()) continue

    const stats = await fs.stat(absolutePath)
    result.push({
      path: relativePath,
      name: entry.name,
      kind: 'file',
      size: stats.size,
      editable: stats.size <= MAX_PROJECT_FILE_BYTES && isEditableName(entry.name),
    })
  }

  return { entries: result, truncated }
}

export async function readProjectFile(projectPath: string, relativePath: unknown): Promise<ProjectFileContent> {
  const { root, file } = await resolveProjectFile(projectPath, relativePath)
  const stats = await fs.stat(file)
  if (!stats.isFile()) throw new Error('O caminho selecionado não é um arquivo.')
  if (stats.size > MAX_PROJECT_FILE_BYTES) {
    throw new Error('Este arquivo é grande demais para o editor (' + Math.round(stats.size / 1024) + ' KB).')
  }

  const buffer = await fs.readFile(file)
  return { path: path.relative(root, file), content: decodeText(buffer), size: buffer.byteLength }
}

export async function saveProjectFile(projectPath: string, relativePath: unknown, content: unknown): Promise<ProjectFileContent> {
  const { root, file } = await resolveProjectFile(projectPath, relativePath)
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_PROJECT_FILE_BYTES) {
    throw new Error('O conteúdo excede o limite de 1,5 MB do editor.')
  }

  const stats = await fs.stat(file)
  if (!stats.isFile()) throw new Error('O caminho selecionado não é um arquivo.')
  const temporaryPath = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  let renamed = false
  try {
    const handle = await fs.open(temporaryPath, 'w')
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporaryPath, file)
    renamed = true
  } finally {
    if (!renamed) await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
  }

  return { path: path.relative(root, file), content, size: Buffer.byteLength(content, 'utf8') }
}
