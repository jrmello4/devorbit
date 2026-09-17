import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

function backupCandidates(baseName: string, entries: readonly string[]): string[] {
  return entries
    .filter((entry) => entry === `${baseName}.bak` || (entry.startsWith(`${baseName}.`) && entry.endsWith('.bak')))
    .sort()
    .reverse()
}

export async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryFile = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  const backupFile = `${filePath}.bak`
  let temporaryCreated = false
  let temporaryRenamed = false
  let backupCreated = false
  try {
    const handle = await open(temporaryFile, 'wx')
    temporaryCreated = true
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (await pathExists(filePath)) {
      await rm(backupFile, { force: true }).catch(() => undefined)
      try {
        await rename(filePath, backupFile)
        backupCreated = true
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw error
      }
    }
    try {
      await rename(temporaryFile, filePath)
      temporaryRenamed = true
    } catch (error) {
      if (backupCreated) {
        await rename(backupFile, filePath).catch(() => undefined)
        backupCreated = false
      }
      throw error
    }
  } finally {
    if (temporaryCreated && !temporaryRenamed) await rm(temporaryFile, { force: true }).catch(() => undefined)
  }
}

export async function restoreFileFromBackup(
  filePath: string,
  options: { overwrite?: boolean } = {},
): Promise<boolean> {
  const directory = path.dirname(filePath)
  const baseName = path.basename(filePath)
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const candidates = backupCandidates(baseName, entries)
  if (candidates.length === 0) return false
  const mainExists = await pathExists(filePath)
  if (mainExists && options.overwrite !== true) return false
  if (mainExists) {
    await rename(filePath, `${filePath}.corrupt-${Date.now()}`).catch(() => rm(filePath, { force: true }))
  }
  for (const candidate of candidates) {
    try {
      await rename(path.join(directory, candidate), filePath)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'EEXIST' && code !== 'EPERM') throw error
    }
  }
  return false
}

export async function recoverFileFromBackup(filePath: string): Promise<boolean> {
  if (await pathExists(filePath)) return false
  return restoreFileFromBackup(filePath)
}
