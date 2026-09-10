import { spawn, exec } from 'node:child_process'
import electron from 'electron'
const { clipboard, shell } = electron
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { loadConfig } from './config'
import { getGitStatus, getGitChangesSummary } from './git'

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
): Promise<{ success: boolean; message?: string }> {
  const config = await loadConfig()
  const custom = config.customPaths

  try {
    switch (tool) {
      case 'codex-desktop': {
        const codexCmd = custom.codex || 'codex.cmd'
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
        const cmd = `wt.exe -d "${projectPath}" powershell.exe -NoExit -Command "$env:CODEX_HOME = '${codexHome}'; Write-Host '>>> Codex conectado com: ${accountLabel} <<<' -ForegroundColor Cyan; cd '${projectPath}'; codex"`
        exec(cmd, (err) => {
          if (err) {
            exec(
              `start cmd.exe /k "set CODEX_HOME=${codexHome} && cd /d \"${projectPath}\" && codex"`
            )
          }
        })
        return {
          success: true,
          message: `Codex CLI iniciado no terminal (${accountLabel})!`,
        }
      }

      case 'chrome': {
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

    lines.push('\n---\n*Pronto para colar no ChatGPT, Codex ou Claude.*')

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
