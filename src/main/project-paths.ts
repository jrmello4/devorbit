import path from 'node:path'
import { loadConfig, saveConfig } from './config'
import { canonicalizeExistingDirectory, isPathWithinRoot } from './validation'
import type { ManagedProject } from '../renderer/src/types'

let managedConfigQueue: Promise<void> = Promise.resolve()

async function assertWithinMonitoredRoot(candidate: string, label: string): Promise<void> {
  const config = await loadConfig()
  const allowed = (await Promise.all(config.projectDirs.map(async (root) => {
    try {
      const canonicalRoot = await canonicalizeExistingDirectory(root, 'Pasta monitorada')
      return isPathWithinRoot(candidate, canonicalRoot)
    } catch {
      return false
    }
  }))).some(Boolean)
  if (!allowed) throw new Error(label)
}

export async function validateCloneParent(input: unknown): Promise<string> {
  const candidate = await canonicalizeExistingDirectory(input, 'Pasta de destino')
  await assertWithinMonitoredRoot(candidate, 'A pasta de destino não pertence a uma pasta monitorada.')
  return candidate
}

export async function validateProjectPath(input: unknown): Promise<string> {
  const candidate = await canonicalizeExistingDirectory(input, 'Caminho de projeto')
  await assertWithinMonitoredRoot(candidate, 'O projeto não pertence a uma pasta monitorada.')
  return candidate
}

export function managedProjectPath(project: ManagedProject): string {
  return path.resolve(project.parentPath, project.folderName)
}

export async function rememberManagedProject(entry: ManagedProject): Promise<void> {
  const operation = managedConfigQueue.catch(() => undefined).then(async () => {
    const config = await loadConfig()
    const target = managedProjectPath(entry).toLowerCase()
    const managedProjects = [
      ...config.managedProjects.filter((item) => managedProjectPath(item).toLowerCase() !== target),
      entry,
    ]
    await saveConfig({ managedProjects })
  })
  managedConfigQueue = operation.then(() => undefined, () => undefined)
  await operation
}
