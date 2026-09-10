import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs/promises'
import type { GitStatus, SyncResult } from '../renderer/src/types'

const execFileAsync = promisify(execFile)

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

export async function syncGit(repoPath: string): Promise<SyncResult> {
  const isRepo = await isGitRepository(repoPath)
  if (!isRepo) {
    return {
      success: false,
      message: 'Esta pasta não é um repositório Git.',
    }
  }

  try {
    // Executa git pull
    const { stdout, stderr } = await execFileAsync('git', ['pull'], {
      cwd: repoPath,
      timeout: 30000,
      windowsHide: true,
    })

    const output = (stdout + '\n' + stderr).trim()

    if (output.includes('Already up to date.') || output.includes('Já atualizado.')) {
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
