import { spawn } from 'node:child_process'
import electron from 'electron'
const { clipboard, shell } = electron
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { loadConfig } from './config'
import { getGitStatus, getGitChangesSummary } from './git'
import { getProjectMemory } from './memory'
import { getUsageState, incrementUsage } from './usage'

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

async function reserveUsage(target: 'account1' | 'account2' | 'antigravity'): Promise<boolean> {
  const state = await getUsageState()
  if (target !== 'antigravity' && state[target].used >= state[target].limit) return false
  await incrementUsage(target)
  return true
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
        if (!(await reserveUsage(config.activeChatGptAccount || 'account1'))) {
          return { success: false, message: 'Limite de uso da conta ativa atingido.' }
        }
        try {
          await spawnDetached(codexCmd, ['app', projectPath])
        } catch {
          await spawnDetached('explorer.exe', ['shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App'])
        }
        return { success: true, message: 'OpenAI Codex Desktop aberto no projeto!' }
      }

      case 'codex-cli': {
        const isAccount2 = options?.account === 'account2'
        const codexHome = isAccount2
          ? path.join(os.homedir(), '.codex-conta2')
          : path.join(os.homedir(), '.codex-conta1')
        const accountLabel = isAccount2
          ? config.chatGptAccount2Name || 'Conta 2 (Brave)'
          : config.chatGptAccount1Name || 'Conta 1 (Chrome)'

        // Checa se a conta está autenticada
        const authPath = path.join(codexHome, 'auth.json')
        let isAuthed = false
        try {
          const stat = await fs.stat(authPath)
          isAuthed = stat.size > 50
        } catch {
          isAuthed = false
        }

        if (!isAuthed) {
          return {
            success: false,
            needsAuth: true,
            account: options?.account || 'account1',
            message: `${accountLabel} ainda não está conectada! Clique no botão de login para conectar.`,
          }
        }

        if (!(await reserveUsage(isAccount2 ? 'account2' : 'account1'))) {
          return { success: false, message: `Limite de uso da ${accountLabel} atingido.` }
        }

        const wtCmd = custom.wt || 'wt.exe'
        const codexCmd = custom.codex || 'codex.cmd'
        const env = { ...process.env, CODEX_HOME: codexHome }
        try {
          await spawnDetached(wtCmd, ['-d', projectPath, 'cmd.exe', '/d', '/k', codexCmd], { env })
        } catch {
          await spawnDetached('cmd.exe', ['/d', '/k', codexCmd], { cwd: projectPath, env })
        }
        return {
          success: true,
          message: `Codex CLI iniciado no terminal (${accountLabel})!`,
        }
      }

      case 'chrome': {
        if (!(await reserveUsage('account1'))) return { success: false, message: 'Limite de uso da Conta 1 atingido.' }
        const chromePath =
          custom.chrome ||
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        await spawnDetached(chromePath, [options?.url || 'https://chatgpt.com'])
        return { success: true, message: 'ChatGPT aberto no Google Chrome (Conta 1)!' }
      }

      case 'brave': {
        if (!(await reserveUsage('account2'))) return { success: false, message: 'Limite de uso da Conta 2 atingido.' }
        const bravePath =
          custom.brave ||
          'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
        await spawnDetached(bravePath, [options?.url || 'https://chatgpt.com'])
        return { success: true, message: 'ChatGPT aberto no Brave (Conta 2)!' }
      }

      case 'agy': {
        await reserveUsage('antigravity')
        const agyPath =
          custom.agy || 'C:\\Users\\adenilson.j\\AppData\\Local\\agy\\agy.exe'
        try {
          await spawnDetached('wt.exe', ['-d', projectPath, agyPath], { cwd: projectPath })
        } catch {
          await spawnDetached(agyPath, [], { cwd: projectPath })
        }
        return { success: true, message: 'Antigravity CLI iniciado no terminal!' }
      }

      case 'mimo': {
        const mimoPath =
          custom.mimo ||
          'C:\\Users\\adenilson.j\\AppData\\Local\\Programs\\Xiaomi MiMo AI\\Xiaomi MiMo AI.exe'
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
      `- **Caminho Local:** \`${projectPath}\``,
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
        memory.content.trim()
      )
    }

    lines.push('\n---\n*Pronto para colar no ChatGPT, Codex ou Claude. Continue o raciocínio a partir do handoff acima.*')

    const contextText = lines.join('\n')
    clipboard.writeText(contextText)

    // Incrementa o contador de uso da conta ativa
    const config = await loadConfig()
    await incrementUsage(config.activeChatGptAccount || 'account1')

    return { success: true, context: contextText }
  } catch (error: any) {
    return {
      success: false,
      context: `Erro ao capturar contexto: ${error.message}`,
    }
  }
}
