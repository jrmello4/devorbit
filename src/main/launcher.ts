import { spawn } from 'node:child_process'
import electron from 'electron'
const { clipboard, shell } = electron
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { loadConfig } from './config'
import { getGitStatus, getGitChangesSummary } from './git'
import { getProjectMemory } from './memory'
import {
  ensureAccountDirectories,
  getAccountLabel,
  getBrowserLaunchArgs,
  hasValidCodexAuth,
  shouldTrackBrowserUsage,
  type AccountId,
} from './account-profiles'
import {
  releaseUsageReservation,
  tryReserveUsage,
  type UsageTarget,
} from './usage'

function spawnDetached(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

async function reserveUsage(target: UsageTarget): Promise<boolean> {
  return tryReserveUsage(target)
}

async function rollbackUsage(target: UsageTarget): Promise<void> {
  await releaseUsageReservation(target)
}

function redactProjectPath(content: string, projectPath: string): string {
  const variants = new Set([projectPath, projectPath.replaceAll('\\', '/')])
  let redacted = content

  for (const variant of variants) {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    redacted = redacted.replace(new RegExp(escaped, 'gi'), '[caminho local omitido]')
  }

  return redacted
}

export async function launchTool(
  tool:
    | 'agy'
    | 'mimo'
    | 'brave'
    | 'chrome'
    | 'codex-desktop'
    | 'codex-cli'
    | 'vscode'
    | 'terminal'
    | 'folder',
  projectPath: string,
  options?: { account?: 'account1' | 'account2'; url?: string }
): Promise<{ success: boolean; message?: string; needsAuth?: boolean; account?: string }> {
  const config = await loadConfig()
  const custom = config.customPaths

  try {
    switch (tool) {
      case 'codex-desktop': {
        const codexCmd = custom.codex || 'codex.cmd'
        const usageTarget = config.activeChatGptAccount === 'account2' ? 'account2' : 'account1'
        if (!(await reserveUsage(usageTarget))) {
          return { success: false, message: 'Limite de uso da conta ativa atingido.' }
        }
        try {
          try {
            await spawnDetached(codexCmd, ['app', projectPath])
          } catch {
            await spawnDetached('explorer.exe', ['shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App'])
          }
        } catch (error) {
          await rollbackUsage(usageTarget)
          throw error
        }
        return { success: true, message: 'OpenAI Codex Desktop aberto no projeto!' }
      }

      case 'codex-cli': {
        const account: AccountId = options?.account || 'account1'
        const { codexHome } = await ensureAccountDirectories(account)
        const accountLabel = getAccountLabel(account, {
          account1: config.chatGptAccount1Name,
          account2: config.chatGptAccount2Name,
        })

        // Checa se a conta está autenticada
        const isAuthed = await hasValidCodexAuth(codexHome)

        if (!isAuthed) {
          return {
            success: false,
            needsAuth: true,
            account,
            message: `${accountLabel} ainda não está conectada! Clique no botão de login para conectar.`,
          }
        }

        const usageTarget = account
        if (!(await reserveUsage(usageTarget))) {
          return { success: false, message: `Limite de uso da ${accountLabel} atingido.` }
        }

        const wtCmd = custom.wt || 'wt.exe'
        const codexCmd = custom.codex || 'codex.cmd'
        const env = { ...process.env, CODEX_HOME: codexHome }
        try {
          try {
            await spawnDetached(wtCmd, ['-d', projectPath, 'cmd.exe', '/d', '/k', codexCmd], { env })
          } catch {
            await spawnDetached('cmd.exe', ['/d', '/k', codexCmd], { cwd: projectPath, env })
          }
        } catch (error) {
          await rollbackUsage(usageTarget)
          throw error
        }
        return {
          success: true,
          message: `Codex CLI iniciado no terminal (${accountLabel})!`,
        }
      }

      case 'chrome': {
        const account: AccountId = 'account1'
        const { browserProfile } = await ensureAccountDirectories(account)
        const url = options?.url || 'https://chatgpt.com'
        // Explicit URLs are navigation/auth/reopen actions initiated by the UI,
        // not a new ChatGPT session. They must never consume the account quota.
        const trackUsage = shouldTrackBrowserUsage(options?.url)
        const usageTarget = account
        if (trackUsage && !(await reserveUsage(usageTarget))) return { success: false, message: 'Limite de uso da Conta 1 atingido.' }
        const chromePath =
          custom.chrome ||
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        try {
          await spawnDetached(chromePath, getBrowserLaunchArgs(browserProfile, url))
        } catch (error) {
          if (trackUsage) await rollbackUsage(usageTarget)
          throw error
        }
        return { success: true, message: `ChatGPT aberto no Google Chrome (${getAccountLabel(account, { account1: config.chatGptAccount1Name })})!` }
      }

      case 'brave': {
        const account: AccountId = 'account2'
        const { browserProfile } = await ensureAccountDirectories(account)
        const url = options?.url || 'https://chatgpt.com'
        const trackUsage = shouldTrackBrowserUsage(options?.url)
        const usageTarget = account
        if (trackUsage && !(await reserveUsage(usageTarget))) return { success: false, message: 'Limite de uso da Conta 2 atingido.' }
        const bravePath =
          custom.brave ||
          'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
        try {
          await spawnDetached(bravePath, getBrowserLaunchArgs(browserProfile, url))
        } catch (error) {
          if (trackUsage) await rollbackUsage(usageTarget)
          throw error
        }
        return { success: true, message: `ChatGPT aberto no Brave (${getAccountLabel(account, { account2: config.chatGptAccount2Name })})!` }
      }

      case 'agy': {
        const usageTarget = 'antigravity'
        // Antigravity is intentionally unlimited; keep the session counter for visibility.
        await reserveUsage(usageTarget)
        const agyPath =
          custom.agy || path.join(os.homedir(), 'AppData', 'Local', 'agy', 'agy.exe')
        try {
          try {
            await spawnDetached('wt.exe', ['-d', projectPath, agyPath], { cwd: projectPath })
          } catch {
            await spawnDetached(agyPath, [], { cwd: projectPath })
          }
        } catch (error) {
          await rollbackUsage(usageTarget)
          throw error
        }
        return { success: true, message: 'Antigravity CLI iniciado no terminal!' }
      }

      case 'mimo': {
        const mimoPath =
          custom.mimo ||
          path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Xiaomi MiMo AI', 'Xiaomi MiMo AI.exe')
        await spawnDetached(mimoPath, [projectPath], { cwd: projectPath })
        return { success: true, message: 'Xiaomi MiMo AI aberto!' }
      }

      case 'vscode': {
        const codeCmd = custom.vscode || 'code.cmd'
        await spawnDetached(codeCmd, [projectPath])
        return { success: true, message: 'VS Code aberto no projeto!' }
      }

      case 'terminal': {
        const wtCmd = custom.wt || 'wt.exe'
        try {
          await spawnDetached(wtCmd, ['-d', projectPath])
        } catch {
          await spawnDetached('powershell.exe', ['-NoExit'], { cwd: projectPath })
        }
        return { success: true, message: 'Terminal aberto no diretório do projeto!' }
      }

      case 'folder': {
        const openError = await shell.openPath(projectPath)
        if (openError) throw new Error(openError)
        return { success: true, message: 'Pasta aberta no Windows Explorer!' }
      }

      default:
        return { success: false, message: 'Ferramenta não reconhecida.' }
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Erro ao iniciar ${tool}: ${error.message || 'desconhecido'}`,
    }
  }
}

export async function copyProjectContext(
  projectPath: string
): Promise<{ success: boolean; context: string }> {
  try {
    const projectName = path.basename(projectPath)
    const git = await getGitStatus(projectPath)
    const changes = await getGitChangesSummary(projectPath)

    // Tenta ler descrição do package.json se existir
    let description = ''
    try {
      const pkgRaw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf-8')
      const pkg = JSON.parse(pkgRaw)
      if (pkg.description) description = pkg.description
    } catch {
      // Sem package.json ou sem descrição
    }

    const lines: string[] = [
      `# 📂 Contexto do Projeto: ${projectName}`,
    ]

    if (description) {
      lines.push(`- **Descrição:** ${description}`)
    }

    if (git.isRepo) {
      lines.push(`- **Branch Git Atual:** \`${git.branch}\``)
      lines.push(`- **Status Git:** ${git.statusMessage}`)
      if (changes.length > 0) {
        lines.push(`\n### 📝 Arquivos com alterações recentes:`)
        changes.forEach((c) => lines.push(`- \`${c}\``))
      }
    }

    // Lê a Memória da IA (Handoff) se existir
    const memory = await getProjectMemory(projectPath)
    if (memory.exists && memory.content.trim()) {
      lines.push(
        `\n### 🧠 Memória da Sessão & Handoff (Onde paramos):`,
        redactProjectPath(memory.content.trim(), projectPath)
      )
    }

    lines.push('\n---\n*Pronto para colar no ChatGPT, Codex ou Claude. Continue o raciocínio a partir do handoff acima.*')

    const contextText = lines.join('\n')
    clipboard.writeText(contextText)

    return { success: true, context: contextText }
  } catch (error: any) {
    return {
      success: false,
      context: `Erro ao capturar contexto: ${error.message}`,
    }
  }
}
