import { spawn, exec } from 'node:child_process'
import electron from 'electron'
const { clipboard, shell } = electron
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { loadConfig } from './config'
import { getGitStatus, getGitChangesSummary } from './git'
import { getProjectMemory } from './memory'
import { incrementUsage } from './usage'

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
  options?: { account?: 'account1' | 'account2' }
): Promise<{ success: boolean; message?: string; needsAuth?: boolean; account?: string }> {
  const config = await loadConfig()
  const custom = config.customPaths

  try {
    switch (tool) {
      case 'codex-desktop': {
        const codexCmd = custom.codex || 'codex.cmd'
        await incrementUsage(config.activeChatGptAccount || 'account1')
        exec(`"${codexCmd}" app "${projectPath}"`, (err) => {
          if (err) {
            exec(`start shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App`)
          }
        })
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

        await incrementUsage(isAccount2 ? 'account2' : 'account1')

        const wtCmd = custom.wt || 'wt.exe'
        const codexCmd = custom.codex || 'codex.cmd'
        const title = `Codex CLI - ${accountLabel}`
        const innerCmd = `title ${title} && set CODEX_HOME=${codexHome} && echo ======================================================== && echo   OpenAI Codex CLI Conectado: ${accountLabel} && echo   Projeto: ${projectPath} && echo ======================================================== && cd /d "${projectPath}" && ${codexCmd}`

        exec(`"${wtCmd}" -d "${projectPath}" cmd.exe /k "${innerCmd}"`, (err) => {
          if (err) {
            exec(`start cmd.exe /k "${innerCmd}"`)
          }
        })
        return {
          success: true,
          message: `Codex CLI iniciado no terminal (${accountLabel})!`,
        }
      }

      case 'chrome': {
        await incrementUsage('account1')
        const chromePath =
          custom.chrome ||
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        spawn(chromePath, ['https://chatgpt.com'], {
          detached: true,
          stdio: 'ignore',
        }).unref()
        return { success: true, message: 'ChatGPT aberto no Google Chrome (Conta 1)!' }
      }

      case 'brave': {
        await incrementUsage('account2')
        const bravePath =
          custom.brave ||
          'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
        spawn(bravePath, ['https://chatgpt.com'], {
          detached: true,
          stdio: 'ignore',
        }).unref()
        return { success: true, message: 'ChatGPT aberto no Brave (Conta 2)!' }
      }

      case 'agy': {
        await incrementUsage('antigravity')
        const agyPath =
          custom.agy || 'C:\\Users\\adenilson.j\\AppData\\Local\\agy\\agy.exe'
        const cmd = `wt.exe -d "${projectPath}" powershell.exe -NoExit -Command "cd '${projectPath}'; & '${agyPath}'"`
        exec(cmd, (err) => {
          if (err) {
            exec(`start cmd.exe /k "cd /d \"${projectPath}\" && \"${agyPath}\""`)
          }
        })
        return { success: true, message: 'Antigravity CLI iniciado no terminal!' }
      }

      case 'mimo': {
        const mimoPath =
          custom.mimo ||
          'C:\\Users\\adenilson.j\\AppData\\Local\\Programs\\Xiaomi MiMo AI\\Xiaomi MiMo AI.exe'
        spawn(mimoPath, [projectPath], {
          detached: true,
          stdio: 'ignore',
          cwd: projectPath,
        }).unref()
        return { success: true, message: 'Xiaomi MiMo AI aberto!' }
      }

      case 'vscode': {
        const codeCmd = custom.vscode || 'code.cmd'
        exec(`"${codeCmd}" "${projectPath}"`, { windowsHide: true })
        return { success: true, message: 'VS Code aberto no projeto!' }
      }

      case 'terminal': {
        const wtCmd = custom.wt || 'wt.exe'
        exec(`"${wtCmd}" -d "${projectPath}"`, (err) => {
          if (err) {
            exec(`start powershell.exe -NoExit -Command "cd '${projectPath}'"`)
          }
        })
        return { success: true, message: 'Terminal aberto no diretório do projeto!' }
      }

      case 'folder': {
        await shell.openPath(projectPath)
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
