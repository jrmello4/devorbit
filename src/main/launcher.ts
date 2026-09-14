import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
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
  resolveCodexCommand,
  resolveBrowserPath,
  shouldTrackBrowserUsage,
  type AccountId,
} from './account-profiles'
import {
  releaseUsageReservation,
  tryReserveUsage,
  type UsageTarget,
} from './usage'

const execFileAsync = promisify(execFile)

const MAX_CONTEXT_CHARS = 8000

async function getLastCommitLine(projectPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '-1', '--format=%h (%ad) %s', '--date=short'],
      { cwd: projectPath, timeout: 8000, windowsHide: true }
    )
    return String(stdout || '').trim()
  } catch {
    return ''
  }
}

function spawnDetached(
  command: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    windowsHide?: boolean
    windowsVerbatimArguments?: boolean
  } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const invocation = getCommandInvocation(command, args)
    const child = spawn(invocation.command, invocation.args, {
      ...options,
      detached: true,
      stdio: 'ignore',
      // These are user-facing launches. Hiding the console window makes both
      // Windows Terminal and the PowerShell fallback appear to do nothing.
      windowsHide: options.windowsHide ?? false,
      windowsVerbatimArguments:
        invocation.windowsVerbatimArguments ?? options.windowsVerbatimArguments,
    })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

function quoteWindowsCommandLineArg(value: string): string {
  if (value.length === 0) return '""'
  if (/[%!]/.test(value)) {
    throw new Error('Caminhos com % ou ! não podem ser executados com segurança pelo CMD.')
  }
  // Quotes protect spaces and shell separators such as &, | and (). The
  // caller uses /v:off and rejects the two expansion syntaxes that CMD can
  // still evaluate inside quoted arguments.
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}

function getCommandInvocation(
  command: string,
  args: string[]
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(command)) {
    return { command, args }
  }

  const commandLine = [command, ...args].map(quoteWindowsCommandLineArg).join(' ')
  return {
    command: process.env.ComSpec || 'cmd.exe',
    // The outer pair protects the quoted executable from cmd /s /c's special
    // handling of the first and last quote.
    args: ['/d', '/v:off', '/s', '/c', `"${commandLine}"`],
    // commandLine already contains the quoting intended for cmd.exe. Letting
    // Node quote it a second time turns valid paths into escaped arguments.
    windowsVerbatimArguments: true,
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    const stats = await fs.stat(file)
    return stats.isFile()
  } catch {
    return false
  }
}

async function findCommandOnPath(command: string): Promise<string | null> {
  if (process.platform !== 'win32') return null
  try {
    const { stdout } = await execFileAsync('where.exe', [command], {
      timeout: 5000,
      windowsHide: true,
    })
    const first = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0]
    return first && await fileExists(first) ? first : null
  } catch {
    return null
  }
}

async function resolveVscodeCommand(configuredCommand?: string): Promise<string | null> {
  const configured = configuredCommand?.trim()
  const commandCandidates: string[] = []

  if (configured) {
    if (path.isAbsolute(configured)) commandCandidates.push(configured)
    else {
      const onPath = await findCommandOnPath(configured)
      if (onPath) commandCandidates.push(onPath)
    }
  }

  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs'),
  ].filter((root): root is string => Boolean(root))
  for (const root of roots) {
    commandCandidates.push(path.join(root, 'Microsoft VS Code', 'Code.exe'))
  }

  const codeExeOnPath = await findCommandOnPath('code.exe')
  if (codeExeOnPath) commandCandidates.push(codeExeOnPath)
  const codeCmdOnPath = await findCommandOnPath('code.cmd')
  if (codeCmdOnPath) commandCandidates.push(codeCmdOnPath)

  const seen = new Set<string>()
  for (const candidate of commandCandidates) {
    const key = candidate.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    if (/\.(?:cmd|bat)$/i.test(candidate)) {
      const siblingExecutable = path.join(path.dirname(candidate), 'Code.exe')
      const parentExecutable = path.join(path.dirname(path.dirname(candidate)), 'Code.exe')
      if (await fileExists(parentExecutable)) return parentExecutable
      if (await fileExists(siblingExecutable)) return siblingExecutable
    }
    if (await fileExists(candidate)) return candidate
  }

  return null
}

async function resolveAntigravityCommand(configuredCommand?: string): Promise<string | null> {
  const candidates = [
    configuredCommand?.trim(),
    path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'agy', 'agy.exe'),
    await findCommandOnPath('agy.exe'),
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate
  }
  return null
}

async function openCmdSession(
  terminalCommand: string,
  projectPath: string,
  command: string,
  env?: NodeJS.ProcessEnv
): Promise<void> {
  const canUseVerbatimArguments = process.platform === 'win32' && !/\.(?:cmd|bat)$/i.test(terminalCommand)
  const terminalArgs = canUseVerbatimArguments
    ? ['-d', quoteWindowsCommandLineArg(projectPath), 'cmd.exe', '/d', '/v:off', '/k', quoteWindowsCommandLineArg(command)]
    : ['-d', projectPath, 'cmd.exe', '/d', '/k', command]
  try {
    await spawnDetached(
      terminalCommand,
      terminalArgs,
      { env, windowsVerbatimArguments: canUseVerbatimArguments }
    )
  } catch {
    await spawnDetached(
      'cmd.exe',
      ['/d', '/v:off', '/k', process.platform === 'win32' ? quoteWindowsCommandLineArg(command) : command],
      { cwd: projectPath, env, windowsVerbatimArguments: process.platform === 'win32' }
    )
  }
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
        const codexCmd = await resolveCodexCommand(custom.codex)
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
        const codexCmd = await resolveCodexCommand(custom.codex)
        const env = { ...process.env, CODEX_HOME: codexHome }
        try {
          await openCmdSession(wtCmd, projectPath, codexCmd, env)
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
        const chromePath = await resolveBrowserPath(account, custom.chrome)
        if (!chromePath) {
          return { success: false, message: 'Google Chrome não foi encontrado. Ajuste o caminho em Configurações ou instale o navegador.' }
        }
        // Explicit URLs are navigation/auth/reopen actions initiated by the UI,
        // not a new ChatGPT session. They must never consume the account quota.
        const trackUsage = shouldTrackBrowserUsage(options?.url)
        const usageTarget = account
        if (trackUsage && !(await reserveUsage(usageTarget))) return { success: false, message: 'Limite de uso da Conta 1 atingido.' }
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
        const bravePath = await resolveBrowserPath(account, custom.brave)
        if (!bravePath) {
          return { success: false, message: 'Brave não foi encontrado. Ajuste o caminho em Configurações ou instale o navegador.' }
        }
        const trackUsage = shouldTrackBrowserUsage(options?.url)
        const usageTarget = account
        if (trackUsage && !(await reserveUsage(usageTarget))) return { success: false, message: 'Limite de uso da Conta 2 atingido.' }
        try {
          await spawnDetached(bravePath, getBrowserLaunchArgs(browserProfile, url))
        } catch (error) {
          if (trackUsage) await rollbackUsage(usageTarget)
          throw error
        }
        return { success: true, message: `ChatGPT aberto no Brave (${getAccountLabel(account, { account2: config.chatGptAccount2Name })})!` }
      }

      case 'agy': {
        const agyPath = await resolveAntigravityCommand(custom.agy)
        if (!agyPath) {
          return {
            success: false,
            message: 'Antigravity não foi encontrado. Ajuste o caminho em Configurações ou instale o CLI.',
          }
        }
        const usageTarget = 'antigravity'
        // Antigravity is intentionally unlimited; keep the session counter for visibility.
        await reserveUsage(usageTarget)
        try {
          await openCmdSession(custom.wt || 'wt.exe', projectPath, agyPath)
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
        const codeCmd = await resolveVscodeCommand(custom.vscode)
        if (!codeCmd) {
          return { success: false, message: 'VS Code não foi encontrado. Ajuste o caminho em Configurações ou instale o editor.' }
        }
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
      const position: string[] = []
      if (git.ahead > 0) position.push(`${git.ahead} à frente`)
      if (git.behind > 0) position.push(`${git.behind} atrás`)
      lines.push(`- **Branch Git Atual:** \`${git.branch}\`${position.length > 0 ? ` (${position.join(', ')})` : ''}`)
      lines.push(`- **Status Git:** ${git.statusMessage}`)
      const lastCommit = await getLastCommitLine(projectPath)
      if (lastCommit) lines.push(`- **Último commit:** \`${lastCommit.slice(0, 200)}\``)
      if (changes.length > 0) {
        lines.push(`\n### 📝 Arquivos com alterações recentes:`)
        changes.forEach((c) => lines.push(`- \`${c}\``))
      }
    }

    // Lê a Memória da IA (Handoff) se existir
    const memory = await getProjectMemory(projectPath)
    const footer = '\n---\n*Pronto para colar no ChatGPT, Codex ou Claude. Continue o raciocínio a partir do handoff acima.*'
    if (memory.exists && memory.content.trim()) {
      const redacted = redactProjectPath(memory.content.trim(), projectPath)
      const used = `${lines.join('\n')}\n\n### 🧠 Memória da Sessão & Handoff (Onde paramos):\n\n${footer}`.length
      const budget = Math.max(0, MAX_CONTEXT_CHARS - used)
      const trimmed = redacted.length > budget && budget > 0
        ? `${redacted.slice(0, budget)}\n…(memória cortada para caber no limite)`
        : redacted
      if (budget > 0 || redacted.length === 0) {
        lines.push(`\n### 🧠 Memória da Sessão & Handoff (Onde paramos):`, trimmed)
      }
    }

    lines.push(footer)

    let contextText = lines.join('\n')
    if (contextText.length > MAX_CONTEXT_CHARS) {
      contextText = `${contextText.slice(0, MAX_CONTEXT_CHARS)}\n…(contexto cortado no limite de ${MAX_CONTEXT_CHARS} caracteres)`
    }
    clipboard.writeText(contextText)

    return { success: true, context: contextText }
  } catch (error: any) {
    return {
      success: false,
      context: `Erro ao capturar contexto: ${error.message}`,
    }
  }
}
