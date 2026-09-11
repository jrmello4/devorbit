import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs/promises'
import type { GitBranch, GitCloneResult, GitStatus, SyncResult } from '../renderer/src/types'
import { validateFolderName, validateGitBranch, validateHttpsUrl } from './validation'

const execFileAsync = promisify(execFile)

// Git operations are process-bound and can mutate the same working tree. Keep
// syncs for one repository serialized even when the renderer fires multiple
// requests (for example, a manual sync while "Sync all" is still running).
const mutationLocks = new Map<string, Promise<SyncResult>>()
const cloneLocks = new Map<string, Promise<GitCloneResult>>()

function getSyncLockKey(repoPath: string): string {
  const normalized = path.normalize(path.resolve(repoPath))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
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
        await execFileAsync('git', ['fetch', '--quiet', '--prune'], {
          cwd: repoPath,
          timeout: 15000,
          windowsHide: true,
        })
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
      await execFileAsync('git', ['fetch', '--quiet', '--prune'], {
        cwd: repoPath,
        timeout: 15000,
        windowsHide: true,
      })
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
    lockKey = getSyncLockKey(repoPath)
  } catch {
    return {
      success: false,
      message: 'Caminho de repositório inválido.',
    }
  }

  const previous = mutationLocks.get(lockKey)
  const current = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => syncGitUnlocked(repoPath))

  mutationLocks.set(lockKey, current)

  try {
    return await current
  } finally {
    if (mutationLocks.get(lockKey) === current) {
      mutationLocks.delete(lockKey)
    }
  }
}

export async function switchGitBranch(repoPath: string, requestedBranch: string): Promise<SyncResult> {
  const safeBranch = validateGitBranch(requestedBranch)
  let lockKey: string
  try {
    lockKey = getSyncLockKey(repoPath)
  } catch {
    return { success: false, message: 'Caminho de repositório inválido.' }
  }

  const previous = mutationLocks.get(lockKey)
  const current = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => switchGitBranchUnlocked(repoPath, safeBranch))

  mutationLocks.set(lockKey, current)
  try {
    return await current
  } finally {
    if (mutationLocks.get(lockKey) === current) mutationLocks.delete(lockKey)
  }
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
  const key = (() => {
    try {
      const normalized = path.normalize(path.resolve(path.join(options.parentDir.trim(), options.folderName.trim())))
      return process.platform === 'win32' ? normalized.toLowerCase() : normalized
    } catch {
      return `${options.parentDir}/${options.folderName}`
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

async function runSerialized(key: string, task: () => Promise<SyncResult>): Promise<SyncResult> {
  const previous = mutationLocks.get(key)
  const current = (previous ?? Promise.resolve({ success: true, message: '' }))
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
    key = getSyncLockKey(repoPath)
  } catch {
    return { success: false, message: 'Caminho de repositório inválido.' }
  }
  return runSerialized(key, () => stashSyncUnlocked(repoPath))
}

export async function stashSwitchGitBranch(repoPath: string, requestedBranch: string): Promise<SyncResult> {
  const safeBranch = validateGitBranch(requestedBranch)
  let key: string
  try {
    key = getSyncLockKey(repoPath)
  } catch {
    return { success: false, message: 'Caminho de repositório inválido.' }
  }
  return runSerialized(key, () => stashSwitchUnlocked(repoPath, safeBranch))
}

export async function getGitChangesSummary(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--short'], {
      cwd: repoPath,
      timeout: 5000,
      windowsHide: true,
    })
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 20)
  } catch {
    return []
  }
}

export async function pushGit(
  repoPath: string,
  commitMessage?: string
): Promise<SyncResult> {
  const isRepo = await isGitRepository(repoPath)
  if (!isRepo) {
    return {
      success: false,
      message: 'Esta pasta não é um repositório Git.',
    }
  }

  try {
    // 1. Se foi informada mensagem de commit, adiciona todos os arquivos e commita
    if (commitMessage && commitMessage.trim()) {
      await execFileAsync('git', ['add', '-A'], {
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
