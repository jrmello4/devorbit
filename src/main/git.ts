import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs/promises'
import type {
  GitBranch,
  GitChange,
  GitCloneResult,
  GitPushOptions,
  GitStatus,
  SyncResult,
} from '../renderer/src/types'
import { validateFolderName, validateGitBranch, validateHttpsUrl } from './validation'

const execFileAsync = promisify(execFile)

// Git operations are process-bound and can mutate the same working tree. Keep
// syncs for one repository serialized even when the renderer fires multiple
// requests (for example, a manual sync while "Sync all" is still running).
const mutationLocks = new Map<string, Promise<unknown>>()
const cloneLocks = new Map<string, Promise<GitCloneResult>>()
const RECREATABLE_IGNORED_ROOTS = new Set([
  'node_modules', '.gradle', '.next', 'coverage', '.venv', 'venv', '__pycache__',
])

function normalizeLockPath(repoPath: string): string {
  const normalized = path.normalize(repoPath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function getRepositoryLockKey(repoPath: string): Promise<string> {
  const absolutePath = path.resolve(repoPath)
  try {
    // realpath collapses symlinks and junctions so aliases share one queue.
    return normalizeLockPath(await fs.realpath(absolutePath))
  } catch {
    // Keep useful behavior for paths that do not exist yet or cannot be
    // resolved. Existing callers still validate the repository separately.
    return normalizeLockPath(absolutePath)
  }
}

async function refreshGitRemote(repoPath: string): Promise<void> {
  const lockKey = await getRepositoryLockKey(repoPath)
  await runSerialized(lockKey, async () => {
    await execFileAsync('git', ['fetch', '--quiet', '--prune'], {
      cwd: repoPath,
      timeout: 15000,
      windowsHide: true,
    })
  })
}

export async function isGitRepository(dirPath: string): Promise<boolean> {
  try {
    const gitDir = path.join(dirPath, '.git')
    const stat = await fs.stat(gitDir)
    return stat.isDirectory() || stat.isFile()
  } catch {
    return false
  }
}

export async function getGitStatus(repoPath: string, refreshRemote = false): Promise<GitStatus> {
  const isRepo = await isGitRepository(repoPath)
  if (!isRepo) {
    return {
      isRepo: false,
      branch: '',
      ahead: 0,
      behind: 0,
      hasChanges: false,
      modifiedCount: 0,
      untrackedCount: 0,
      statusMessage: 'Sem controle de versão Git',
    }
  }

  try {
    if (refreshRemote) {
      try {
        await refreshGitRemote(repoPath)
      } catch {
        // A network failure must not hide the local Git status.
      }
    }
    // Run git status with branch and porcelain flags
    const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '-b'], {
      cwd: repoPath,
      timeout: 8000,
      windowsHide: true,
    })

    const lines = stdout.split(/\r?\n/).filter(Boolean)
    const branchLine = lines[0] || ''
    const changeLines = lines.slice(1)

    let branch = 'main'
    let ahead = 0
    let behind = 0

    // Parse branch line: e.g. ## master...origin/master [ahead 1, behind 2] or ## master
    if (branchLine.startsWith('## ')) {
      const info = branchLine.substring(3)
      const parts = info.split('...')
      branch = parts[0] ? parts[0].trim() : 'main'

      const matchAhead = info.match(/ahead (\d+)/)
      if (matchAhead) {
        ahead = parseInt(matchAhead[1], 10)
      }

      const matchBehind = info.match(/behind (\d+)/)
      if (matchBehind) {
        behind = parseInt(matchBehind[1], 10)
      }
    }

    let modifiedCount = 0
    let untrackedCount = 0

    for (const line of changeLines) {
      if (line.startsWith('??')) {
        untrackedCount++
      } else {
        modifiedCount++
      }
    }

    const hasChanges = modifiedCount > 0 || untrackedCount > 0

    let statusMessage = 'Sincronizado'
    if (behind > 0 && ahead > 0) {
      statusMessage = `${behind} atrás, ${ahead} à frente do GitHub`
    } else if (behind > 0) {
      statusMessage = `${behind} commit(s) atrás do GitHub (Pull recomendado)`
    } else if (ahead > 0) {
      statusMessage = `${ahead} commit(s) à frente do GitHub`
    } else if (hasChanges) {
      statusMessage = `${modifiedCount + untrackedCount} arquivos modificados`
    }

    return {
      isRepo: true,
      branch,
      ahead,
      behind,
      hasChanges,
      modifiedCount,
      untrackedCount,
      lastSyncTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      statusMessage,
    }
  } catch (error: any) {
    return {
      isRepo: true,
      branch: 'indisponível',
      ahead: 0,
      behind: 0,
      hasChanges: false,
      modifiedCount: 0,
      untrackedCount: 0,
      statusMessage: `Erro ao consultar Git: ${error.message || 'desconhecido'}`,
    }
  }
}

export async function createAgentWorktree(repoPath: string, agentId: string): Promise<{ path: string; branch: string }> {
  if (!/^[a-z0-9_-]{1,48}$/i.test(agentId)) throw new Error('Identificador de agente inválido.')
  if (!await isGitRepository(repoPath)) throw new Error('O projeto não é um repositório Git.')
  const lockKey = await getRepositoryLockKey(repoPath)
  return await runSerialized(lockKey, async () => {
    const { stdout: dirty } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoPath, timeout: 8000, windowsHide: true })
    if (dirty.trim()) throw new Error('Salve, faça commit ou stash das alterações antes de isolar um agente.')
    const root = await fs.realpath(repoPath)
    const worktreeRoot = path.join(path.dirname(root), '.devorbit-worktrees')
    const target = path.join(worktreeRoot, path.basename(root) + '-' + agentId.toLowerCase())
    try { await fs.access(target); throw new Error('Já existe um worktree para este agente: ' + target) } catch (error) { if (error instanceof Error && error.message.startsWith('Já existe')) throw error }
    await fs.mkdir(worktreeRoot, { recursive: true })
    const branch = 'devorbit/' + agentId.toLowerCase()
    try {
      await execFileAsync('git', ['worktree', 'add', '-b', branch, target, 'HEAD'], { cwd: root, timeout: 30000, windowsHide: true })
    } catch (error) {
      try { await execFileAsync('git', ['worktree', 'add', target, branch], { cwd: root, timeout: 30000, windowsHide: true }) } catch { throw error }
    }
    return { path: target, branch }
  })
}

export async function integrateAgentWorktree(repoPath: string, branch: string, worktreePath: string): Promise<SyncResult> {
  if (!/^devorbit\/[a-z0-9_-]{1,48}$/i.test(branch)) throw new Error('Branch de agente inválida.')
  const lockKey = await getRepositoryLockKey(repoPath)
  return await runSerialized(lockKey, async () => {
    const { stdout: dirty } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoPath, timeout: 8000, windowsHide: true })
    if (dirty.trim()) throw new Error('O projeto principal possui alterações pendentes.')
    const hasNodeManifest = await fs.access(path.join(worktreePath, 'package.json')).then(() => true).catch(() => false)
    if (hasNodeManifest) {
      try { await execFileAsync('npm', ['test', '--', '--run'], { cwd: worktreePath, timeout: 120000, windowsHide: true }) }
      catch { throw new Error('Os testes do worktree falharam; a integração foi bloqueada.') }
    }
    await execFileAsync('git', ['merge', '--no-ff', '--no-edit', branch], { cwd: repoPath, timeout: 30000, windowsHide: true })
    await execFileAsync('git', ['worktree', 'remove', worktreePath], { cwd: repoPath, timeout: 30000, windowsHide: true })
    return { success: true, message: 'Branch integrada e worktree removido.' }
  })
}

export async function getGitRemoteUrl(repoPath: string): Promise<string | null> {
  if (!await isGitRepository(repoPath)) return null
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
      timeout: 8000,
      windowsHide: true,
    })
    const remote = stdout.trim()
    return remote || null
  } catch {
    return null
  }
}

interface GitRefRecord {
  name: string
  isCurrent: boolean
  upstream?: string
  commit?: string
}

function parseGitRefRecords(stdout: string): GitRefRecord[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.split('\0'))
    .filter((fields) => fields[0]?.trim())
    .map(([name, head, upstream, commit]) => ({
      name: name.trim(),
      isCurrent: head.trim() === '*',
      ...(upstream?.trim() ? { upstream: upstream.trim() } : {}),
      ...(commit?.trim() ? { commit: commit.trim() } : {}),
    }))
}

/**
 * Lists the local branches and the remote refs that can be checked out. The
 * optional fetch is deliberately best-effort: a temporary network failure
 * should not hide branches already present in the local repository.
 */
export async function getGitBranches(
  repoPath: string,
  refreshRemote = false
): Promise<GitBranch[]> {
  const isRepo = await isGitRepository(repoPath)
  if (!isRepo) return []

  if (refreshRemote) {
    try {
      await refreshGitRemote(repoPath)
    } catch {
      // Keep the locally known refs available when the network is offline.
    }
  }

  try {
    const format = '%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(objectname:short)'
    const [{ stdout: localOutput }, { stdout: remoteOutput }] = await Promise.all([
      execFileAsync('git', ['for-each-ref', `--format=${format}`, 'refs/heads'], {
        cwd: repoPath,
        timeout: 8000,
        windowsHide: true,
      }),
      execFileAsync('git', ['for-each-ref', `--format=${format}`, 'refs/remotes'], {
        cwd: repoPath,
        timeout: 8000,
        windowsHide: true,
      }),
    ])

    const local = parseGitRefRecords(localOutput).map((ref) => ({
      name: ref.name,
      isCurrent: ref.isCurrent,
      isRemote: false,
      ...(ref.upstream ? { upstream: ref.upstream } : {}),
      ...(ref.commit ? { commit: ref.commit } : {}),
    }))
    const remote = parseGitRefRecords(remoteOutput)
      // origin/HEAD is a symbolic convenience ref, not a branch a user can
      // sensibly check out, so keep it out of the picker.
      .filter((ref) => ref.name.includes('/') && !ref.name.endsWith('/HEAD'))
      .map((ref) => ({
        name: ref.name,
        isCurrent: false,
        isRemote: true,
        ...(ref.commit ? { commit: ref.commit } : {}),
      }))

    return [...local, ...remote].sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
      if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1
      return a.name.localeCompare(b.name)
    })
  } catch (error: any) {
    throw new Error(`Não foi possível listar as branches: ${error.stderr || error.message || 'falha no Git'}`)
  }
}

async function switchGitBranchUnlocked(repoPath: string, requestedBranch: string): Promise<SyncResult> {
  const isRepo = await isGitRepository(repoPath)
  if (!isRepo) {
    return { success: false, message: 'Esta pasta não é um repositório Git.' }
  }

  try {
    const { stdout: statusOutput } = await execFileAsync('git', ['status', '--porcelain=v1'], {
      cwd: repoPath,
      timeout: 8000,
      windowsHide: true,
    })
    if (statusOutput.trim()) {
      return {
        success: false,
        message: 'Troca recusada: existem alterações locais. Faça commit ou stash antes de trocar de branch.',
        output: statusOutput.trim().slice(0, 4000),
      }
    }

    const branches = await getGitBranches(repoPath)
    const localBranches = branches.filter((branch) => !branch.isRemote)
    const remoteBranches = branches.filter((branch) => branch.isRemote)
    const remote = remoteBranches.find((branch) =>
      branch.name === requestedBranch || branch.name === `origin/${requestedBranch}`
    )
    const localName = remote
      ? remote.name.slice(remote.name.indexOf('/') + 1)
      : requestedBranch
    const local = localBranches.find((branch) => branch.name === localName)

    if (local) {
      const { stdout, stderr } = await execFileAsync('git', ['switch', '--no-guess', localName], {
        cwd: repoPath,
        timeout: 15000,
        windowsHide: true,
      })
      return {
        success: true,
        message: `Branch alterada para ${localName}.`,
        output: (stdout + '\n' + stderr).trim(),
      }
    }

    if (!remote) {
      return {
        success: false,
        message: `A branch “${requestedBranch}” não foi encontrada neste repositório. Atualize a lista e tente novamente.`,
      }
    }

    const { stdout, stderr } = await execFileAsync(
      'git',
      ['switch', '--track', '-c', localName, remote.name],
      { cwd: repoPath, timeout: 15000, windowsHide: true }
    )
    return {
      success: true,
      message: `Branch local ${localName} criada acompanhando ${remote.name}.`,
      output: (stdout + '\n' + stderr).trim(),
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Erro ao trocar de branch: ${error.stderr || error.message || 'falha no Git'}`,
      output: error.stderr || error.stdout,
    }
  }
}

async function syncGitUnlocked(repoPath: string): Promise<SyncResult> {
  const isRepo = await isGitRepository(repoPath)
  if (!isRepo) {
    return {
      success: false,
      message: 'Esta pasta não é um repositório Git.',
    }
  }

  try {
    // Never merge or overwrite local work as a side effect of a sync action.
    // Porcelain output includes staged, unstaged and untracked changes.
    const { stdout: statusOutput } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1'],
      {
        cwd: repoPath,
        timeout: 8000,
        windowsHide: true,
      }
    )

    const localChanges = statusOutput.trim()
    if (localChanges) {
      return {
        success: false,
        message:
          'Sincronização recusada: existem alterações locais. Faça commit ou stash antes do pull.',
        output: localChanges.slice(0, 4000),
      }
    }

    // --ff-only guarantees that sync never creates an implicit merge commit.
    const { stdout, stderr } = await execFileAsync('git', ['pull', '--ff-only'], {
      cwd: repoPath,
      timeout: 30000,
      windowsHide: true,
    })

    const output = (stdout + '\n' + stderr).trim()

    if (
      output.includes('Already up to date.') ||
      output.includes('Already up-to-date.') ||
      output.includes('Já atualizado.')
    ) {
      return {
        success: true,
        message: 'O projeto já está com a versão mais recente do GitHub!',
        output,
      }
    }

    return {
      success: true,
      message: 'Atualizado com sucesso a partir do GitHub!',
      output,
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Erro ao sincronizar: ${error.stderr || error.message || 'Falha no git pull'}`,
      output: error.stderr || error.stdout,
    }
  }
}

export async function syncGit(repoPath: string): Promise<SyncResult> {
  let lockKey: string
  try {
    lockKey = await getRepositoryLockKey(repoPath)
  } catch {
    return {
      success: false,
      message: 'Caminho de repositório inválido.',
    }
  }

  return runSerialized(lockKey, () => syncGitUnlocked(repoPath))
}

export async function switchGitBranch(repoPath: string, requestedBranch: string): Promise<SyncResult> {
  const safeBranch = validateGitBranch(requestedBranch)
  let lockKey: string
  try {
    lockKey = await getRepositoryLockKey(repoPath)
  } catch {
    return { success: false, message: 'Caminho de repositório inválido.' }
  }

  return runSerialized(lockKey, () => switchGitBranchUnlocked(repoPath, safeBranch))
}

export interface CloneGitOptions {
  parentDir: string
  folderName: string
  remoteUrl: string
}

async function cloneGitUnlocked(options: CloneGitOptions): Promise<GitCloneResult> {
  const safeParent = await (async () => {
    try {
      const canonical = await fs.realpath(path.resolve(options.parentDir.trim()))
      const stats = await fs.stat(canonical)
      if (!stats.isDirectory()) throw new Error('not-directory')
      return canonical
    } catch {
      throw new Error('Pasta de destino não existe ou não é uma pasta.')
    }
  })()
  const safeName = validateFolderName(options.folderName)
  const safeUrl = validateHttpsUrl(options.remoteUrl)
  const destPath = path.join(safeParent, safeName)

  let destExists = false
  let destEmpty = false
  try {
    const stats = await fs.stat(destPath)
    if (!stats.isDirectory()) {
      return { success: false, message: 'Já existe um arquivo com esse nome na pasta de destino.' }
    }
    destExists = true
    if (await isGitRepository(destPath)) {
      return { success: false, message: 'Esta pasta já é um repositório Git. Use Pull para atualizar com a main.', path: destPath }
    }
    const entries = await fs.readdir(destPath)
    if (entries.length > 0) {
      return { success: false, message: 'A pasta já existe e não está vazia. Escolha outro nome ou esvazie a pasta.' }
    }
    destEmpty = true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' && !(error instanceof Error && error.message.includes('não'))) {
      throw error
    }
  }

  try {
    if (destExists && destEmpty) {
      const { stdout, stderr } = await execFileAsync('git', ['clone', safeUrl, '.'], {
        cwd: destPath,
        timeout: 120000,
        windowsHide: true,
      })
      const output = `${stdout || ''}\n${stderr || ''}`.trim()
      return { success: true, message: 'Repositório clonado com a main mais recente!', output, path: destPath }
    }
    const { stdout, stderr } = await execFileAsync('git', ['clone', safeUrl, destPath], {
      cwd: safeParent,
      timeout: 120000,
      windowsHide: true,
    })
    const output = `${stdout || ''}\n${stderr || ''}`.trim()
    return { success: true, message: 'Repositório clonado com a main mais recente!', output, path: destPath }
  } catch (error: unknown) {
    const text = String((error as { stderr?: unknown; stdout?: unknown; message?: unknown })?.stderr || (error as { message?: unknown })?.message || '').trim()
    await fs.rm(destPath, { recursive: true, force: true }).catch(() => undefined).then(async () => {
      if (destExists && destEmpty) await fs.mkdir(destPath, { recursive: true }).catch(() => undefined)
    })
    if (/authentication|permission|not found|repository not found|invalid/i.test(text)) {
      return { success: false, message: 'Não foi possível clonar: verifique o link e o acesso ao repositório.', output: text.slice(0, 4000) }
    }
    return { success: false, message: `Erro ao clonar: ${text || 'falha no git clone'}`, output: text.slice(0, 4000) }
  }
}

export async function cloneGitRepository(options: CloneGitOptions): Promise<GitCloneResult> {
  const key = await (async () => {
    try {
      const canonicalParent = await fs.realpath(path.resolve(options.parentDir.trim()))
      return normalizeLockPath(path.join(canonicalParent, options.folderName.trim()))
    } catch {
      const normalized = path.normalize(path.resolve(path.join(options.parentDir.trim(), options.folderName.trim())))
      return normalizeLockPath(normalized)
    }
  })()
  const previous = cloneLocks.get(key)
  const current = (previous ?? Promise.resolve({ success: true, message: '' } as GitCloneResult))
    .catch(() => undefined)
    .then(() => cloneGitUnlocked(options))
  cloneLocks.set(key, current)
  try {
    return await current
  } finally {
    if (cloneLocks.get(key) === current) cloneLocks.delete(key)
  }
}

const STASH_MESSAGE = 'devorbit: guarda automática antes de sincronizar'

async function runSerialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = mutationLocks.get(key)
  const current = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(task)
  mutationLocks.set(key, current)
  try {
    return await current
  } finally {
    if (mutationLocks.get(key) === current) mutationLocks.delete(key)
  }
}

async function stashPush(repoPath: string): Promise<void> {
  await execFileAsync('git', ['stash', 'push', '-m', STASH_MESSAGE], {
    cwd: repoPath,
    timeout: 15000,
    windowsHide: true,
  })
}

async function stashPop(repoPath: string): Promise<void> {
  await execFileAsync('git', ['stash', 'pop'], {
    cwd: repoPath,
    timeout: 15000,
    windowsHide: true,
  })
}

async function stashSyncUnlocked(repoPath: string): Promise<SyncResult> {
  if (!await isGitRepository(repoPath)) {
    return { success: false, message: 'Esta pasta não é um repositório Git.' }
  }
  const { stdout: statusOutput } = await execFileAsync('git', ['status', '--porcelain=v1'], {
    cwd: repoPath,
    timeout: 8000,
    windowsHide: true,
  })
  if (!statusOutput.trim()) return syncGitUnlocked(repoPath)

  try {
    await stashPush(repoPath)
  } catch (error: unknown) {
    const text = String((error as { stderr?: unknown; message?: unknown })?.stderr || (error as { message?: unknown })?.message || '')
    return { success: false, message: `Não foi possível guardar as alterações em stash: ${text.slice(0, 200) || 'falha no git stash'}`, output: text.slice(0, 4000) }
  }

  const syncResult = await syncGitUnlocked(repoPath)

  try {
    await stashPop(repoPath)
  } catch (error: unknown) {
    const text = String((error as { stderr?: unknown; stdout?: unknown })?.stderr || (error as { stdout?: unknown })?.stdout || '')
    return {
      success: false,
      message: syncResult.success
        ? 'Pull concluído, mas o retorno do stash conflitou. Seu trabalho está guardado no stash "devorbit": resolva com git stash pop no terminal.'
        : `${syncResult.message} Suas alterações continuam guardadas no stash "devorbit".`,
      output: [syncResult.output, text].filter(Boolean).join('\n').slice(0, 4000),
    }
  }

  return syncResult.success
    ? { ...syncResult, message: `${syncResult.message} Alterações locais restauradas do stash.` }
    : syncResult
}

async function stashSwitchUnlocked(repoPath: string, requestedBranch: string): Promise<SyncResult> {
  if (!await isGitRepository(repoPath)) {
    return { success: false, message: 'Esta pasta não é um repositório Git.' }
  }
  const { stdout: statusOutput } = await execFileAsync('git', ['status', '--porcelain=v1'], {
    cwd: repoPath,
    timeout: 8000,
    windowsHide: true,
  })
  if (!statusOutput.trim()) return switchGitBranchUnlocked(repoPath, requestedBranch)

  try {
    await stashPush(repoPath)
  } catch (error: unknown) {
    const text = String((error as { stderr?: unknown; message?: unknown })?.stderr || (error as { message?: unknown })?.message || '')
    return { success: false, message: `Não foi possível guardar as alterações em stash: ${text.slice(0, 200) || 'falha no git stash'}`, output: text.slice(0, 4000) }
  }

  const switchResult = await switchGitBranchUnlocked(repoPath, requestedBranch)
  if (!switchResult.success) {
    try {
      await stashPop(repoPath)
      return { ...switchResult, message: `${switchResult.message} Suas alterações foram restauradas do stash.` }
    } catch {
      return { ...switchResult, message: `${switchResult.message} Suas alterações continuam guardadas no stash "devorbit".` }
    }
  }

  try {
    await stashPop(repoPath)
  } catch {
    return {
      success: false,
      message: `Branch trocada para ${requestedBranch}, mas o retorno do stash conflitou. Seu trabalho está guardado no stash "devorbit": resolva com git stash pop no terminal.`,
      output: switchResult.output,
    }
  }

  return { ...switchResult, message: `${switchResult.message} Alterações locais restauradas do stash.` }
}

export async function stashSyncGit(repoPath: string): Promise<SyncResult> {
  let key: string
  try {
    key = await getRepositoryLockKey(repoPath)
  } catch {
    return { success: false, message: 'Caminho de repositório inválido.' }
  }
  return runSerialized(key, () => stashSyncUnlocked(repoPath))
}

export async function stashSwitchGitBranch(repoPath: string, requestedBranch: string): Promise<SyncResult> {
  const safeBranch = validateGitBranch(requestedBranch)
  let key: string
  try {
    key = await getRepositoryLockKey(repoPath)
  } catch {
    return { success: false, message: 'Caminho de repositório inválido.' }
  }
  return runSerialized(key, () => stashSwitchUnlocked(repoPath, safeBranch))
}

interface GitStatusChange extends GitChange {
  /** Every path represented by this status entry, including rename/copy pairs. */
  paths: string[]
}

function parseGitStatusPorcelainZ(stdout: string): GitStatusChange[] {
  const fields = stdout.split('\0')
  const changes: GitStatusChange[] = []

  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index]
    if (!record) continue
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error('Resposta de status do Git inválida.')
    }

    const status = record.slice(0, 2)
    const changePath = record.slice(3)
    if (!changePath) throw new Error('Resposta de status do Git inválida.')

    const isRenameOrCopy = status.includes('R') || status.includes('C')
    const relatedPath = isRenameOrCopy ? fields[++index] : undefined
    if (isRenameOrCopy && !relatedPath) {
      throw new Error('Resposta de status do Git inválida.')
    }

    const paths = relatedPath ? [changePath, relatedPath] : [changePath]
    changes.push({
      path: changePath,
      status,
      ...(relatedPath ? { stagingPaths: paths } : {}),
      paths,
    })
  }

  return changes
}

async function readGitStatusChanges(repoPath: string): Promise<GitStatusChange[]> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '-z'], {
    cwd: repoPath,
    timeout: 8000,
    windowsHide: true,
  })
  return parseGitStatusPorcelainZ(stdout)
}

export async function getGitChanges(repoPath: string): Promise<GitChange[]> {
  try {
    return (await readGitStatusChanges(repoPath))
      .map(({ paths: _paths, ...change }) => change)
      .slice(0, 20)
  } catch {
    return []
  }
}

export async function getGitChangesSummary(repoPath: string): Promise<string[]> {
  return (await getGitChanges(repoPath)).map((change) =>
    `${change.status} ${change.stagingPaths?.join(' -> ') || change.path}`
  )
}

function isSafeGitPathspec(pathspec: unknown): pathspec is string {
  if (typeof pathspec !== 'string' || pathspec.length === 0 || pathspec.trim().length === 0) return false
  if (pathspec.length > 4096) return false
  if (/^[A-Za-z]:/.test(pathspec) || pathspec.startsWith('/') || pathspec.startsWith('\\')) return false
  if (pathspec.startsWith('-') || pathspec.startsWith(':') || pathspec.startsWith('!') || pathspec.startsWith('^')) return false
  if (Array.from(pathspec).some((character) =>
    character === '\0' || character === '\r' || character === '\n' ||
    '\\:*?[]'.includes(character)
  )) return false
  if (pathspec.includes('//')) return false
  if (pathspec.split('/').some((part) => part === '.' || part === '..')) return false
  return true
}

function validateSelectedPaths(options: GitPushOptions | undefined): string[] | null {
  const requestedPaths = options?.selectedPaths
  if (!Array.isArray(requestedPaths)) return null

  const selectedPaths: string[] = []
  for (const requestedPath of requestedPaths) {
    if (!isSafeGitPathspec(requestedPath)) return null
    if (!selectedPaths.includes(requestedPath)) selectedPaths.push(requestedPath)
  }
  return selectedPaths.length > 0 ? selectedPaths : null
}

function formatGitChanges(changes: GitStatusChange[]): string {
  return changes
    .map((change) => `${change.status} ${change.paths.join(' -> ')}`)
    .join('\n')
    .slice(0, 4000)
}

async function pushGitUnlocked(
  repoPath: string,
  commitMessage?: string,
  options?: GitPushOptions
): Promise<SyncResult> {
  const isRepo = await isGitRepository(repoPath)
  if (!isRepo) {
    return {
      success: false,
      message: 'Esta pasta não é um repositório Git.',
    }
  }

  try {
    // A push without a commit message only sends commits that already exist.
    // Keep this path free of status/staging calls so it cannot alter the index.
    if (commitMessage && commitMessage.trim()) {
      const selectedPaths = validateSelectedPaths(options)
      if (!selectedPaths) {
        return {
          success: false,
          message: 'Commit recusado: selecione ao menos um caminho listado nas alterações atuais.',
        }
      }

      const currentChanges = await readGitStatusChanges(repoPath)
      const selectedPathSet = new Set(selectedPaths)
      const currentPathSet = new Set(currentChanges.flatMap((change) => change.paths))
      if (selectedPaths.some((selectedPath) => !currentPathSet.has(selectedPath))) {
        return {
          success: false,
          message: 'Commit recusado: os caminhos selecionados não estão mais listados nas alterações atuais.',
          output: formatGitChanges(currentChanges),
        }
      }

      const stagedOutsideSelection = currentChanges.filter((change) => {
        const indexStatus = change.status[0]
        const isStaged = indexStatus !== ' ' && indexStatus !== '?'
        return isStaged && !change.paths.some((changePath) => selectedPathSet.has(changePath))
      })
      if (stagedOutsideSelection.length > 0) {
        return {
          success: false,
          message: 'Commit recusado: existem alterações preparadas fora dos caminhos selecionados.',
          output: formatGitChanges(stagedOutsideSelection),
        }
      }

      await execFileAsync('git', ['add', '--', ...selectedPaths], {
        cwd: repoPath,
        timeout: 15000,
        windowsHide: true,
      })

      try {
        await execFileAsync('git', ['commit', '-m', commitMessage.trim()], {
          cwd: repoPath,
          timeout: 15000,
          windowsHide: true,
        })
      } catch (commitErr: any) {
        const msg = (commitErr.stdout || commitErr.stderr || commitErr.message || '').toString().toLowerCase()
        if (!msg.includes('nothing to commit') && !msg.includes('working tree clean')) {
          return {
            success: false,
            message: `Erro ao criar commit: ${commitErr.stderr || commitErr.message}`,
            output: commitErr.stderr || commitErr.stdout,
          }
        }
      }
    }

    // 2. Executa git push
    let pushOutput = ''
    try {
      const { stdout, stderr } = await execFileAsync('git', ['push'], {
        cwd: repoPath,
        timeout: 45000,
        windowsHide: true,
      })
      pushOutput = (stdout + '\n' + stderr).trim()
    } catch (pushErr: any) {
      const errText = (pushErr.stderr || pushErr.stdout || pushErr.message || '').toString()

      // Se a branch não tem upstream no remote, configura automaticamente
      if (errText.includes('has no upstream branch') || errText.includes('--set-upstream')) {
        const { stdout: branchName } = await execFileAsync(
          'git',
          ['rev-parse', '--abbrev-ref', 'HEAD'],
          { cwd: repoPath, windowsHide: true }
        )
        const branch = branchName.trim()
        const { stdout, stderr } = await execFileAsync(
          'git',
          ['push', '--set-upstream', 'origin', branch],
          { cwd: repoPath, timeout: 45000, windowsHide: true }
        )
        pushOutput = (stdout + '\n' + stderr).trim()
      } else if (errText.includes('fetch first') || errText.includes('Updates were rejected')) {
        return {
          success: false,
          message:
            'O GitHub possui novos commits! Faça "Sync Git (Pull)" antes de subir suas alterações.',
          output: errText,
        }
      } else {
        return {
          success: false,
          message: `Erro ao subir para o GitHub: ${errText}`,
          output: errText,
        }
      }
    }

    return {
      success: true,
      message: 'Alterações enviadas com sucesso para o GitHub!',
      output: pushOutput,
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Erro ao processar push: ${error.stderr || error.message || 'Falha no push'}`,
      output: error.stderr || error.stdout,
    }
  }
}

export async function pushGit(
  repoPath: string,
  commitMessage?: string,
  options?: GitPushOptions
): Promise<SyncResult> {
  let lockKey: string
  try {
    lockKey = await getRepositoryLockKey(repoPath)
  } catch {
    return { success: false, message: 'Caminho de repositório inválido.' }
  }
  return runSerialized(lockKey, () => pushGitUnlocked(repoPath, commitMessage, options))
}

async function finalizeGitProjectUnlocked(repoPath: string, allowRecreatableIgnored: boolean): Promise<SyncResult> {
  if (!await isGitRepository(repoPath)) {
    return { success: false, message: 'Esta pasta não é um repositório Git.' }
  }

  try {
    const { stdout: localStatus } = await execFileAsync('git', ['status', '--porcelain=v1'], {
      cwd: repoPath, timeout: 8000, windowsHide: true,
    })
    if (localStatus.trim()) {
      return { success: false, message: 'Liberação recusada: existem alterações locais. Faça commit e push antes de liberar espaço.', output: localStatus.trim().slice(0, 4000) }
    }

    const { stdout: ignoredStatus } = await execFileAsync('git', ['status', '--porcelain=v1', '--ignored'], {
      cwd: repoPath, timeout: 8000, windowsHide: true,
    })
    const unsafeIgnored = ignoredStatus
      .split(/\r?\n/)
      .filter((line) => line.startsWith('!!'))
      .map((line) => line.slice(3).trim().replace(/^"|"$/g, ''))
      .filter((entry) => !allowRecreatableIgnored || !RECREATABLE_IGNORED_ROOTS.has(entry.split(/[\\/]/)[0]))
    if (unsafeIgnored.length > 0) {
      return { success: false, message: allowRecreatableIgnored
        ? 'Liberação recusada: existem arquivos ignorados importantes (por exemplo .env ou bancos) nesta pasta. Remova-os ou mova-os manualmente antes de liberar espaço.'
        : 'Liberação recusada: confirme explicitamente a remoção das dependências recriáveis ou remova os arquivos ignorados manualmente antes de liberar espaço.', output: unsafeIgnored.slice(0, 20).join('\n') }
    }

    const { stdout: stashList } = await execFileAsync('git', ['stash', 'list'], {
      cwd: repoPath, timeout: 8000, windowsHide: true,
    })
    if (stashList.trim()) {
      return { success: false, message: 'Liberação recusada: existem alterações guardadas em stash. Recupere ou remova o stash antes de liberar espaço.' }
    }

    const remote = await getGitRemoteUrl(repoPath)
    if (!remote) return { success: false, message: 'Liberação recusada: o repositório não possui um remote origin.' }

    try {
      await execFileAsync('git', ['fetch', '--quiet', '--prune'], {
        cwd: repoPath, timeout: 30000, windowsHide: true,
      })
    } catch (error: any) {
      return { success: false, message: 'Liberação recusada: não foi possível confirmar o estado do GitHub. Verifique a conexão e tente novamente.', output: error?.stderr || error?.message }
    }

    try {
      const [{ stdout: branchOutput }, { stdout: upstreamOutput }] = await Promise.all([
        execFileAsync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repoPath, timeout: 8000, windowsHide: true }),
        execFileAsync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: repoPath, timeout: 8000, windowsHide: true }),
      ])
      if (!branchOutput.trim() || !upstreamOutput.trim() || !upstreamOutput.trim().startsWith('origin/')) throw new Error('missing-origin-upstream')
    } catch {
      return { success: false, message: 'Liberação recusada: a branch atual não está acompanhando um branch remoto.' }
    }

    const { stdout: currentCounts } = await execFileAsync('git', ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], {
      cwd: repoPath, timeout: 8000, windowsHide: true,
    })
    if (!/^0\s+0$/.test(currentCounts.trim())) {
      return { success: false, message: 'Liberação recusada: existem commits locais ou remotos pendentes.' }
    }

    const { stdout: branchOutput } = await execFileAsync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
      cwd: repoPath, timeout: 8000, windowsHide: true,
    })
    const localBranches = branchOutput.split(/\r?\n/).map((branch) => branch.trim()).filter(Boolean)
    for (const branch of localBranches) {
      let upstream = ''
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{u}`], { cwd: repoPath, timeout: 8000, windowsHide: true })
        upstream = stdout.trim()
        if (!upstream.startsWith('origin/')) throw new Error('non-origin-upstream')
      } catch {
        return { success: false, message: `Liberação recusada: a branch local “${branch}” não foi enviada ao GitHub.` }
      }
      const { stdout: counts } = await execFileAsync('git', ['rev-list', '--left-right', '--count', `${branch}...${upstream}`], { cwd: repoPath, timeout: 8000, windowsHide: true })
      if (!/^0\s+0$/.test(counts.trim())) {
        return { success: false, message: `Liberação recusada: a branch “${branch}” não está alinhada ao GitHub.` }
      }
    }

    const { stdout: tagOutput } = await execFileAsync('git', ['tag', '--list'], {
      cwd: repoPath, timeout: 8000, windowsHide: true,
    })
    for (const tag of tagOutput.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      try {
        await execFileAsync('git', ['merge-base', '--is-ancestor', tag, 'HEAD'], {
          cwd: repoPath, timeout: 8000, windowsHide: true,
        })
      } catch {
        return { success: false, message: `Liberação recusada: a tag local “${tag}” aponta para um commit fora da branch atual.` }
      }
    }
    if (tagOutput.trim()) {
      let remoteTagOutput = ''
      try {
        const { stdout } = await execFileAsync('git', ['ls-remote', '--tags', 'origin'], {
          cwd: repoPath, timeout: 15000, windowsHide: true,
        })
        remoteTagOutput = stdout
      } catch {
        return { success: false, message: 'Liberação recusada: não foi possível confirmar as tags locais no GitHub.' }
      }
      const remoteTags = new Map<string, Set<string>>()
      for (const line of remoteTagOutput.split(/\r?\n/).filter(Boolean)) {
        const [objectId, ref] = line.trim().split(/\s+/)
        if (!objectId || !ref || !ref.startsWith('refs/tags/')) continue
        const tagName = ref.slice('refs/tags/'.length).replace(/\^\{\}$/, '')
        const hashes = remoteTags.get(tagName) || new Set<string>()
        hashes.add(objectId)
        remoteTags.set(tagName, hashes)
      }
      const { stdout: localTagRefs } = await execFileAsync('git', ['for-each-ref', '--format=%(refname:strip=2)%00%(objectname)', 'refs/tags'], {
        cwd: repoPath, timeout: 8000, windowsHide: true,
      })
      for (const line of localTagRefs.split(/\r?\n/).filter(Boolean)) {
        const [tagName, objectId] = line.split('\0')
        if (!tagName || !objectId || !remoteTags.get(tagName)?.has(objectId)) {
          return { success: false, message: `Liberação recusada: a tag local “${tagName || 'desconhecida'}” não está idêntica à tag do GitHub.` }
        }
      }
    }

    const { stdout: finalIgnoredStatus } = await execFileAsync('git', ['status', '--porcelain=v1', '--ignored'], {
      cwd: repoPath, timeout: 8000, windowsHide: true,
    })
    const { stdout: finalTrackedStatus } = await execFileAsync('git', ['status', '--porcelain=v1'], {
      cwd: repoPath, timeout: 8000, windowsHide: true,
    })
    if (finalTrackedStatus.trim()) {
      return { success: false, message: 'Liberação recusada: alterações locais apareceram durante a verificação.', output: finalTrackedStatus.trim().slice(0, 4000) }
    }
    const { stdout: finalStashList } = await execFileAsync('git', ['stash', 'list'], {
      cwd: repoPath, timeout: 8000, windowsHide: true,
    })
    if (finalStashList.trim()) {
      return { success: false, message: 'Liberação recusada: um stash apareceu durante a verificação.' }
    }
    const finalUnsafeIgnored = finalIgnoredStatus
      .split(/\r?\n/)
      .filter((line) => line.startsWith('!!'))
      .map((line) => line.slice(3).trim().replace(/^"|"$/g, ''))
      .filter((entry) => !allowRecreatableIgnored || !RECREATABLE_IGNORED_ROOTS.has(entry.split(/[\\/]/)[0]))
    if (finalUnsafeIgnored.length > 0) {
      return { success: false, message: 'Liberação recusada: arquivos ignorados importantes apareceram durante a verificação.' }
    }

    const entries = await fs.readdir(repoPath, { withFileTypes: true })
    for (const entry of entries) {
      await fs.rm(path.join(repoPath, entry.name), { recursive: true, force: true })
    }
    return { success: true, message: 'Projeto confirmado no GitHub e conteúdo local liberado com segurança.' }
  } catch (error: any) {
    return { success: false, message: `Não foi possível liberar espaço: ${error?.message || 'falha desconhecida'}` }
  }
}

export async function finalizeGitProject(
  repoPath: string,
  options: { allowRecreatableIgnored?: boolean } = {}
): Promise<SyncResult> {
  let key: string
  try { key = await getRepositoryLockKey(repoPath) } catch { return { success: false, message: 'Caminho de repositório inválido.' } }
  return runSerialized(key, () => finalizeGitProjectUnlocked(repoPath, options.allowRecreatableIgnored === true))
}
