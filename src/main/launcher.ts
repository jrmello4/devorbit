import { spawn, exec } from 'node:child_process'
import electron from 'electron'
const { clipboard, shell } = electron
import path from 'node:path'
import fs from 'node:fs/promises'
import { loadConfig } from './config'
import { getGitStatus, getGitChangesSummary } from './git'

export async function launchTool(
  tool: 'agy' | 'mimo' | 'brave' | 'vscode' | 'terminal' | 'folder',
  projectPath: string,
  options?: { account?: 'account1' | 'account2' }
): Promise<{ success: boolean; message?: string }> {
  const config = await loadConfig()
  const custom = config.customPaths

  try {
    switch (tool) {
      case 'agy': {
        const agyPath = custom.agy || 'C:\\Users\\adenilson.j\\AppData\\Local\\agy\\agy.exe'
        // Abre o Windows Terminal no diretório do projeto executando o agy interativamente
        const cmd = `wt.exe -d "${projectPath}" powershell.exe -NoExit -Command "cd '${projectPath}'; & '${agyPath}'"`
        exec(cmd, (err) => {
          if (err) {
            // Fallback para cmd normal caso wt.exe falhe
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

      case 'brave': {
        const bravePath =
          custom.brave ||
          'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
        const url = 'https://chatgpt.com'
        spawn(bravePath, [url], {
          detached: true,
          stdio: 'ignore',
        }).unref()
        return {
          success: true,
          message: `ChatGPT aberto no Brave (${options?.account === 'account2' ? 'Conta 2 / Codex' : 'Conta 1'})!`,
        }
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
