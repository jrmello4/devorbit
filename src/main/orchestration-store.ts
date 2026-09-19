import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  createEmptyOrchestrationState,
  parseOrchestrationState,
  type OrchestrationState,
} from '../shared/orchestration-continuity'

const ORCHESTRATION_DIR = '.devorbit'
const ORCHESTRATION_FILE = 'orchestration.json'
const CORRUPT_SUFFIX = '.corrupt.bak'
const MAX_ORCHESTRATION_BYTES = 512 * 1024

const writeQueues = new Map<string, Promise<void>>()

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
  if (!isPathInside(root, candidate)) throw new Error('Caminho de orquestração inválido.')
}

async function resolveProjectRoot(projectPath: string): Promise<string> {
  if (typeof projectPath !== 'string' || !projectPath.trim() || projectPath.includes('\0')) {
    throw new Error('Projeto inválido.')
  }
  const root = await fs.realpath(path.resolve(projectPath))
  const stats = await fs.stat(root)
  if (!stats.isDirectory()) throw new Error('Projeto não é um diretório.')
  return root
}

async function assertCanonicalPath(root: string, candidate: string): Promise<void> {
  assertPathInside(root, candidate)
  const canonical = await fs.realpath(candidate)
  assertPathInside(root, canonical)
  if (normalizePathForComparison(canonical) !== normalizePathForComparison(candidate)) {
    throw new Error('Caminho de orquestração inseguro.')
  }
}

async function resolveSafeOrchestrationFile(root: string, createDirectory: boolean): Promise<string> {
  const directory = path.join(root, ORCHESTRATION_DIR)
  const file = path.join(directory, ORCHESTRATION_FILE)
  assertPathInside(root, directory)
  assertPathInside(root, file)

  let directoryStats
  try {
    directoryStats = await fs.lstat(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' || !createDirectory) return file
    await fs.mkdir(directory, { recursive: true })
    directoryStats = await fs.lstat(directory)
  }
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error('Caminho de orquestração inseguro.')
  }
  await assertCanonicalPath(root, directory)

  try {
    const fileStats = await fs.lstat(file)
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
      throw new Error('Caminho de orquestração inseguro.')
    }
    await assertCanonicalPath(root, file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
  }

  return file
}

export function getOrchestrationFilePath(projectPath: string): string {
  return path.join(path.resolve(projectPath), ORCHESTRATION_DIR, ORCHESTRATION_FILE)
}

export function getOrchestrationProjectId(projectPath: string): string {
  return normalizePathForComparison(path.resolve(projectPath))
}

async function preserveCorruptFile(file: string): Promise<void> {
  try {
    await fs.copyFile(file, `${file}${CORRUPT_SUFFIX}`)
  } catch {
    // Backup é melhor esforço; nunca impede a recuperação segura.
  }
}

export async function readOrchestrationState(projectPath: string): Promise<OrchestrationState> {
  let root: string
  try {
    root = await resolveProjectRoot(projectPath)
  } catch {
    return createEmptyOrchestrationState(getOrchestrationProjectId(projectPath))
  }
  const projectId = getOrchestrationProjectId(root)

  let file: string
  try {
    file = await resolveSafeOrchestrationFile(root, false)
  } catch {
    return createEmptyOrchestrationState(projectId)
  }

  let content: string
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ORCHESTRATION_BYTES) {
      return createEmptyOrchestrationState(projectId)
    }
    content = await fs.readFile(file, 'utf-8')
  } catch {
    return createEmptyOrchestrationState(projectId)
  }

  try {
    return parseOrchestrationState(JSON.parse(content), projectId)
  } catch {
    await preserveCorruptFile(file)
    return createEmptyOrchestrationState(projectId)
  }
}

async function atomicallyWrite(root: string, file: string, state: OrchestrationState): Promise<void> {
  await resolveSafeOrchestrationFile(root, true)
  const temporaryFile = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  let created = false
  let renamed = false
  try {
    const handle = await fs.open(temporaryFile, 'wx')
    created = true
    try {
      await handle.writeFile(JSON.stringify(state, null, 2), 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await resolveSafeOrchestrationFile(root, true)
    await fs.rename(temporaryFile, file)
    renamed = true
  } finally {
    if (created && !renamed) {
      await fs.rm(temporaryFile, { force: true }).catch(() => undefined)
    }
  }
}

function enqueueWrite(root: string, operation: () => Promise<void>): Promise<void> {
  const key = normalizePathForComparison(root)
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const current = previous.then(operation)
  const tail = current.then(() => undefined, () => undefined)
  writeQueues.set(key, tail)
  return current.finally(() => {
    if (writeQueues.get(key) === tail) writeQueues.delete(key)
  })
}

export async function writeOrchestrationState(projectPath: string, state: OrchestrationState): Promise<void> {
  const root = await resolveProjectRoot(projectPath)
  const file = await resolveSafeOrchestrationFile(root, true)
  await enqueueWrite(root, () => atomicallyWrite(root, file, state))
}

/**
 * Read-modify-write serializado por projeto. O mutador recebe o estado
 * persistido atual e devolve o próximo; a gravação é atômica.
 */
export async function updateOrchestrationState(
  projectPath: string,
  mutator: (state: OrchestrationState) => OrchestrationState,
): Promise<OrchestrationState> {
  const root = await resolveProjectRoot(projectPath)
  let written: OrchestrationState | undefined
  await enqueueWrite(root, async () => {
    const current = await readOrchestrationState(root)
    const next = mutator(current)
    const file = await resolveSafeOrchestrationFile(root, true)
    await atomicallyWrite(root, file, next)
    written = next
  })
  return written ?? readOrchestrationState(root)
}
