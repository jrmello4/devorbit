import path from 'node:path'
import { getGitApprovalSnapshot, createAgentWorktree, integrateAgentWorktree } from '../git'
import {
  createProjectDirectory,
  createProjectFile,
  deleteProjectEntry,
  listProjectFiles,
  moveProjectEntry,
  readProjectFile,
  saveProjectFile,
} from '../project-files'
import { validateProjectPath } from '../project-paths'
import { canonicalizeExistingDirectory } from '../validation'
import type { IpcRegistrar } from './registrar'

export interface WorkspaceIpcDependencies {
  requestApproval: (input: { prompt: string; metadata?: Record<string, unknown> }) => Promise<{ state: string }>
}

export function registerWorkspaceIpc(register: IpcRegistrar, dependencies: WorkspaceIpcDependencies): void {
  register('devorbit:listProjectFiles', async (_event, projectPath: string, relativeDirectory?: unknown) => {
    return await listProjectFiles(await validateProjectPath(projectPath), relativeDirectory)
  })

  register('devorbit:readProjectFile', async (_event, projectPath: string, relativePath: unknown) => {
    return await readProjectFile(await validateProjectPath(projectPath), relativePath)
  })

  register('devorbit:saveProjectFile', async (_event, projectPath: string, relativePath: unknown, content: unknown) => {
    return await saveProjectFile(await validateProjectPath(projectPath), relativePath, content)
  })

  register('devorbit:createProjectFile', async (_event, projectPath: string, relativePath: unknown) => {
    return await createProjectFile(await validateProjectPath(projectPath), relativePath)
  })

  register('devorbit:createProjectDirectory', async (_event, projectPath: string, relativePath: unknown) => {
    return await createProjectDirectory(await validateProjectPath(projectPath), relativePath)
  })

  register('devorbit:moveProjectEntry', async (_event, projectPath: string, sourcePath: unknown, destinationPath: unknown) => {
    return await moveProjectEntry(await validateProjectPath(projectPath), sourcePath, destinationPath)
  })

  register('devorbit:deleteProjectEntry', async (_event, projectPath: string, relativePath: unknown, options?: { recursive?: unknown }) => {
    return await deleteProjectEntry(await validateProjectPath(projectPath), relativePath, options)
  })

  register('devorbit:createAgentWorktree', async (_event, projectPath: string, agentId: unknown) => {
    if (typeof agentId !== 'string' || !/^[a-z0-9_-]{1,48}$/i.test(agentId)) throw new Error('Identificador de agente inválido.')
    const safePath = await canonicalizeExistingDirectory(projectPath)
    return await createAgentWorktree(safePath, agentId)
  })

  register('devorbit:integrateAgentWorktree', async (_event, projectPath: string, branch: unknown, worktreePath: unknown) => {
    if (typeof branch !== 'string' || typeof worktreePath !== 'string') throw new Error('Dados de worktree inválidos.')
    const safePath = await canonicalizeExistingDirectory(projectPath)
    const safeWorktree = await canonicalizeExistingDirectory(worktreePath)
    const snapshot = await getGitApprovalSnapshot(safePath, branch, safeWorktree)
    const approval = await dependencies.requestApproval({
      prompt: `Autorizar merge da branch ${branch} no projeto ${path.basename(safePath)}?`,
      metadata: { operation: 'git.merge', branch, project: path.basename(safePath), targetHead: snapshot.head, sourceHead: snapshot.sourceHead },
    })
    if (approval.state !== 'approved') throw new Error(`Merge ${approval.state}.`)
    return await integrateAgentWorktree(safePath, branch, safeWorktree, snapshot)
  })
}
