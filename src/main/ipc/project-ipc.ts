import path from 'node:path'
import { loadConfig } from '../config'
import { listAllNonProjectDirs, scanAllProjects } from '../scanner'
import {
  cloneGitRepository,
  finalizeGitProject,
  getGitApprovalSnapshot,
  getGitBranches,
  getGitChanges,
  getGitRemoteUrl,
  pushGitWithApproval,
  stashSwitchGitBranch,
  stashSyncGit,
  syncGit,
  switchGitBranch,
} from '../git'
import { getGitFileDiff, validateGitDiffPathspec } from '../git-diff'
import { getGitInitPreview, initGitRepository } from '../git-init'
import { launchTool } from '../launcher'
import { cancelMemoryCompaction, syncMemorySchedulers } from '../memory'
import { managedProjectPath, rememberManagedProject, validateCloneParent, validateProjectPath } from '../project-paths'
import {
  validateCloneInput,
  validateGitBranch,
  validateGitInitOptions,
  validateGitPushOptions,
  validateLaunchOptions,
  validateLaunchTool,
} from '../validation'
import type { IpcRegistrar } from './registrar'
import type { ManagedProject, SyncResult } from '../../renderer/src/types'

export interface ProjectIpcDependencies {
  requestApproval: (input: { prompt: string; metadata?: Record<string, unknown> }) => Promise<{ state: string }>
  sendSyncProgress: (payload: { path: string; done: number; total: number }) => void
}

export function registerProjectIpc(register: IpcRegistrar, dependencies: ProjectIpcDependencies): void {
  register('devorbit:getProjects', async () => {
    const config = await loadConfig()
    const projects = await scanAllProjects(config.projectDirs, false, config.managedProjects)
    syncMemorySchedulers(projects.map((project) => project.path))
    return projects
  })

  register('devorbit:refreshProjects', async () => {
    const config = await loadConfig()
    const projects = await scanAllProjects(config.projectDirs, true, config.managedProjects)
    syncMemorySchedulers(projects.map((project) => project.path))
    return projects
  })

  register('devorbit:getOtherDirs', async () => {
    const config = await loadConfig()
    return await listAllNonProjectDirs(config.projectDirs)
  })

  register('devorbit:syncGit', async (_event, projectPath: string): Promise<SyncResult> => {
    return await syncGit(await validateProjectPath(projectPath))
  })

  register('devorbit:getGitBranches', async (_event, projectPath: string, refreshRemote?: boolean) => {
    if (refreshRemote !== undefined && typeof refreshRemote !== 'boolean') {
      throw new Error('Opção de atualização das branches inválida.')
    }
    return await getGitBranches(await validateProjectPath(projectPath), refreshRemote === true)
  })

  register(
    'devorbit:switchGitBranch',
    async (_event, projectPath: string, branch: string): Promise<SyncResult> => {
      const safeBranch = validateGitBranch(branch)
      return await switchGitBranch(await validateProjectPath(projectPath), safeBranch)
    }
  )

  register('devorbit:stashSyncGit', async (_event, projectPath: string): Promise<SyncResult> => {
    return await stashSyncGit(await validateProjectPath(projectPath))
  })

  register(
    'devorbit:stashSwitchGitBranch',
    async (_event, projectPath: string, branch: string): Promise<SyncResult> => {
      const safeBranch = validateGitBranch(branch)
      return await stashSwitchGitBranch(await validateProjectPath(projectPath), safeBranch)
    }
  )

  register(
    'devorbit:pushGit',
    async (_event, projectPath: string, commitMessage?: unknown, options?: unknown): Promise<SyncResult> => {
      if (commitMessage !== undefined && typeof commitMessage !== 'string') {
        throw new Error('Mensagem de commit inválida.')
      }
      const safeOptions = validateGitPushOptions(options)
      const safePath = await validateProjectPath(projectPath)
      const snapshot = await getGitApprovalSnapshot(safePath)
      const approval = await dependencies.requestApproval({
        prompt: `Autorizar commit e push do projeto ${path.basename(safePath)}?`,
        metadata: { operation: 'git.push', project: path.basename(safePath), head: snapshot.head, branch: snapshot.branch, remote: snapshot.remote ?? '[sem remoto]', pushRemote: snapshot.pushRemote ?? '[sem destino]', pushRefspec: snapshot.pushRefspec ?? '[sem refspec]' },
      })
      if (approval.state !== 'approved') throw new Error(`Ação Git ${approval.state}.`)
      return await pushGitWithApproval(
        safePath,
        commitMessage,
        safeOptions,
        snapshot,
      )
    }
  )

  register('devorbit:getGitChanges', async (_event, projectPath: string) => {
    return await getGitChanges(await validateProjectPath(projectPath))
  })

  register('devorbit:getGitFileDiff', async (_event, projectPath: string, relativePath: unknown) => {
    const safePath = await validateProjectPath(projectPath)
    const safeRelative = validateGitDiffPathspec(relativePath)
    return await getGitFileDiff(safePath, safeRelative)
  })

  register('devorbit:getGitInitPreview', async (_event, projectPath: string, branch?: string) => {
    return await getGitInitPreview(await validateProjectPath(projectPath), branch)
  })

  register('devorbit:initGitRepository', async (_event, projectPath: string, options?: unknown) => {
    return await initGitRepository(
      await validateProjectPath(projectPath),
      validateGitInitOptions(options),
    )
  })

  register('devorbit:cloneGitRepository', async (_event, input?: unknown) => {
    const parsed = validateCloneInput(input)
    const safeParent = await validateCloneParent(parsed.parentDir)
    const result = await cloneGitRepository({ ...parsed, parentDir: safeParent })
    if (result.success) {
      await rememberManagedProject({
        id: Buffer.from(path.resolve(safeParent, parsed.folderName)).toString('base64'),
        name: parsed.folderName,
        parentPath: safeParent,
        folderName: parsed.folderName,
        remoteUrl: parsed.remoteUrl,
        branch: 'main',
        registeredAt: new Date().toISOString(),
      })
    }
    return result
  })

  register('devorbit:restoreManagedProject', async (_event, projectPath: string) => {
    const config = await loadConfig()
    const requested = path.resolve(String(projectPath || '')).toLowerCase()
    const managed = config.managedProjects.find((entry) => managedProjectPath(entry).toLowerCase() === requested)
    if (!managed) throw new Error('Projeto não encontrado no cadastro do DevOrbit.')
    const safeParent = await validateCloneParent(managed.parentPath)
    return await cloneGitRepository({
      parentDir: safeParent,
      folderName: managed.folderName,
      remoteUrl: managed.remoteUrl,
    })
  })

  register('devorbit:finalizeManagedProject', async (_event, projectPath: string, options?: unknown): Promise<SyncResult> => {
    const allowRecreatableIgnored = options === undefined
      ? false
      : typeof options === 'object' && options !== null && !Array.isArray(options) &&
        ('allowRecreatableIgnored' in options)
        ? (options as { allowRecreatableIgnored?: unknown }).allowRecreatableIgnored
        : false
    if (typeof allowRecreatableIgnored !== 'boolean') {
      throw new Error('Opção de liberação inválida.')
    }
    const safePath = await validateProjectPath(projectPath)
    const remoteBefore = await getGitRemoteUrl(safePath)
    const configBefore = await loadConfig()
    const existing = configBefore.managedProjects.find((entry) => managedProjectPath(entry).toLowerCase() === safePath.toLowerCase())
    if (!existing && !remoteBefore) {
      return { success: false, message: 'Liberação recusada: não foi possível identificar o remote origin para restaurar este projeto depois.' }
    }
    if (!existing && remoteBefore) {
      try {
        const remoteUrl = new URL(remoteBefore)
        if (remoteUrl.protocol !== 'https:' || remoteUrl.username || remoteUrl.password) {
          return { success: false, message: 'Liberação recusada: cadastre o projeto com um remote HTTPS antes de liberar a cópia local.' }
        }
      } catch {
        return { success: false, message: 'Liberação recusada: o remote origin não é uma URL HTTPS válida.' }
      }
    }
    const catalogEntry: ManagedProject = existing
      ? { ...existing, remoteUrl: remoteBefore || existing.remoteUrl }
      : {
          id: Buffer.from(safePath).toString('base64'),
          name: path.basename(safePath),
          parentPath: path.dirname(safePath),
          folderName: path.basename(safePath),
          remoteUrl: remoteBefore as string,
          branch: 'main',
          registeredAt: new Date().toISOString(),
        }
    try {
      await rememberManagedProject(catalogEntry)
    } catch (error: any) {
      return { success: false, message: `Liberação recusada: não foi possível salvar o cadastro do projeto (${error?.message || 'erro de configuração'}).` }
    }
    const result = await finalizeGitProject(safePath, { allowRecreatableIgnored })
    if (result.success) cancelMemoryCompaction(safePath)
    return result
  })

  register('devorbit:syncAllGit', async (): Promise<{ [path: string]: SyncResult }> => {
    const config = await loadConfig()
    const projects = await scanAllProjects(config.projectDirs, false, config.managedProjects)
    const repositories = projects.filter((project) => project.git.isRepo)
    const orderedResults = new Array<[string, SyncResult]>(repositories.length)
    const concurrency = Math.min(4, repositories.length)
    let nextIndex = 0
    let completed = 0

    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex++
        if (index >= repositories.length) return

        const project = repositories[index]
        try {
          orderedResults[index] = [project.path, await syncGit(project.path)]
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          orderedResults[index] = [project.path, {
            success: false,
            message: `Erro ao sincronizar: ${message}`,
          }]
        } finally {
          completed += 1
          dependencies.sendSyncProgress({
            path: project.path,
            done: completed,
            total: repositories.length,
          })
        }
      }
    }

    if (concurrency > 0) {
      await Promise.all(Array.from({ length: concurrency }, () => worker()))
    }

    const results: { [path: string]: SyncResult } = {}
    for (const [projectPath, result] of orderedResults) {
      results[projectPath] = result
    }

    return results
  })

  register(
    'devorbit:launchTool',
    async (_event, tool: any, projectPath: string, options?: any) => {
      const safeTool = validateLaunchTool(tool)
      const safeOptions = validateLaunchOptions(options)
      const safePath = safeTool === 'chrome' || safeTool === 'brave'
        ? ''
        : await validateProjectPath(projectPath)
      return await launchTool(safeTool, safePath, safeOptions)
    }
  )
}
