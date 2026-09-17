import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import electron from 'electron'
const { clipboard } = electron
const execFileAsync = promisify(execFile)
import { loadConfig } from './config'
import {
  checkBrowserAvailability,
  ensureAccountDirectories,
  getAccountBrowser,
  getAccountLabel,
  getBrowserLaunchArgs,
  getBrowserProfileDirectory,
  getCodexAccountEnvironment,
  getCodexHome,
  hasValidCodexAuth,
  resolveCodexCommand,
  resolveBrowserPath,
  type AccountId,
} from './account-profiles'

export interface CodexAccountStatus {
  account1: { connected: boolean; label: string; path: string; browserOk: boolean; browserPath: string }
  account2: { connected: boolean; label: string; path: string; browserOk: boolean; browserPath: string }
}

export interface CodexAuthProgress {
  account: AccountId
  status: 'idle' | 'starting' | 'code_generated' | 'success' | 'error' | 'cancelled'
  code?: string
  verificationUrl?: string
  message?: string
}

export const CODEX_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

interface LoginSession {
  account: AccountId
  child: ChildProcess
  generation: number
  timeout: NodeJS.Timeout
  cancelled: boolean
  capturedUrl: string
  startupSettled: boolean
  finished: boolean
  onProgress: (progress: CodexAuthProgress) => void
  resolveStartup: () => void
  rejectStartup: (error: Error) => void
}

let activeLoginSession: LoginSession | null = null
let loginGeneration = 0

/** Kept as a public compatibility wrapper for the existing renderer contract. */
export function getCodexDirForAccount(account: AccountId): string {
  return getCodexHome(account)
}

export function getCodexBrowserProfileForAccount(account: AccountId): string {
  return getBrowserProfileDirectory(account)
}

export async function checkCodexAuthStatus(): Promise<CodexAccountStatus> {
  const config = await loadConfig()
  const accounts: AccountId[] = ['account1', 'account2']
  const browsers = await checkBrowserAvailability(config.customPaths).catch(() => undefined)
  const statuses = await Promise.all(accounts.map(async (account) => {
    try {
      const { codexHome } = await ensureAccountDirectories(account)
      return [account, await hasValidCodexAuth(codexHome)] as const
    } catch {
      return [account, false] as const
    }
  }))
  const connected = Object.fromEntries(statuses) as Record<AccountId, boolean>
  const labels = { account1: config.chatGptAccount1Name, account2: config.chatGptAccount2Name }

  const entry = (account: AccountId) => ({
    connected: connected[account],
    label: getAccountLabel(account, labels),
    path: getCodexDirForAccount(account),
    browserOk: browsers?.[account].found ?? true,
    browserPath: browsers?.[account].path ?? '',
  })

  return { account1: entry('account1'), account2: entry('account2') }
}

function extractAuthorizationUrl(output: string): string | undefined {
  const match = output.match(/https:\/\/auth\.openai\.com\/oauth\/authorize[^\s<>'"]+/i)
  return match?.[0].replace(/[),.;]+$/, '')
}

function isCurrentSession(session: LoginSession): boolean {
  return activeLoginSession === session && session.generation === loginGeneration && !session.cancelled
}

function emitError(session: LoginSession, message: string): void {
  if (session.finished || !isCurrentSession(session)) return
  session.finished = true
  clearTimeout(session.timeout)
  activeLoginSession = null
  session.onProgress({ account: session.account, status: 'error', message })
}

function openAuthorizationBrowser(
  browserPath: string,
  profileDirectory: string,
  url: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const browser = spawn(
      browserPath,
      getBrowserLaunchArgs(profileDirectory, url),
      { detached: true, stdio: 'ignore', windowsHide: true }
    )
    browser.once('error', reject)
    browser.once('spawn', () => {
      browser.unref()
      resolve()
    })
  })
}

function quoteWindowsCommandLineArg(value: string): string {
  if (value.length === 0) return '""'
  if (/[%!]/.test(value)) {
    throw new Error('Caminhos com % ou ! não podem ser executados com segurança pelo CMD.')
  }
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}

function getCodexLoginInvocation(codexCommand: string): {
  command: string
  args: string[]
  windowsVerbatimArguments?: boolean
} {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(codexCommand)) {
    return { command: codexCommand, args: ['login'] }
  }

  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/v:off', '/s', '/c', `"${[codexCommand, 'login'].map(quoteWindowsCommandLineArg).join(' ')}"`],
    windowsVerbatimArguments: true,
  }
}

/**
 * On Windows the CLI is launched through cmd.exe and may create a child
 * process of its own. Killing only the wrapper leaves the OAuth process alive,
 * which can later write auth.json after the user cancelled the dialog.
 */
async function terminateLoginProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!pid) return

  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5000,
      })
      return
    } catch {
      // Fall back to the direct handle if taskkill is unavailable or the
      // process exited between the two calls.
    }
  }

  try { child.kill('SIGTERM') } catch { /* best effort */ }
}

export async function startCodexDeviceLogin(
  account: AccountId,
  onProgress: (progress: CodexAuthProgress) => void
): Promise<void> {
  const generation = ++loginGeneration
  // Reserve this generation before awaiting process-tree termination. A newer
  // login request or an explicit cancel can invalidate it while taskkill is
  // still pending, so an older request can never resume and replace it.
  await cancelCodexLogin(false)
  const config = await loadConfig()
  const custom = config.customPaths
  const { codexHome, browserProfile } = await ensureAccountDirectories(account)
  const codexCmd = await resolveCodexCommand(custom.codex)

  if (generation !== loginGeneration) {
    onProgress({ account, status: 'cancelled', message: 'Processo de login cancelado.' })
    return
  }

  onProgress({ account, status: 'starting', message: 'Iniciando autenticação oficial da OpenAI...' })

  const { name: browserName } = getAccountBrowser(account)
  const resolvedBrowser = await resolveBrowserPath(
    account,
    account === 'account2' ? custom.brave : custom.chrome
  )
  if (!resolvedBrowser) {
    onProgress({ account, status: 'error', message: `${browserName} não encontrado. Ajuste o caminho em Configurações ou instale o navegador.` })
    return
  }

  const invocation = getCodexLoginInvocation(codexCmd)
  const child = spawn(invocation.command, invocation.args, {
    env: { ...process.env, ...getCodexAccountEnvironment(account) },
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  })

  let resolveStartup!: () => void
  let rejectStartup!: (error: Error) => void
  const startup = new Promise<void>((resolve, reject) => {
    resolveStartup = resolve
    rejectStartup = reject
  })

  const session: LoginSession = {
    account,
    child,
    generation,
    timeout: undefined as unknown as NodeJS.Timeout,
    cancelled: false,
    capturedUrl: '',
    startupSettled: false,
    finished: false,
    onProgress,
    resolveStartup,
    rejectStartup,
  }
  session.timeout = setTimeout(() => {
    if (session.finished || !isCurrentSession(session)) return
    session.cancelled = true
    activeLoginSession = null
    if (!session.startupSettled) {
      session.startupSettled = true
      rejectStartup(new Error('Tempo limite para iniciar o login do Codex excedido.'))
    }
    void terminateLoginProcessTree(child)
    session.finished = true
    onProgress({ account, status: 'error', message: 'O login do Codex excedeu o tempo limite de 5 minutos.' })
  }, CODEX_LOGIN_TIMEOUT_MS)
  activeLoginSession = session

  const handleOutput = (data: Buffer | string): void => {
    if (!isCurrentSession(session)) return
    const url = extractAuthorizationUrl(data.toString())
    if (!url || session.capturedUrl) return
    session.capturedUrl = url

    try { clipboard.writeText(url) } catch { /* clipboard is only a convenience */ }

    const browserPath = resolvedBrowser
    void openAuthorizationBrowser(browserPath, browserProfile, url).then(
      () => {
        if (!isCurrentSession(session)) return
        onProgress({
          account,
          status: 'code_generated',
          verificationUrl: url,
          message: `Página de login da OpenAI aberta no ${account === 'account2' ? 'Brave' : 'Google Chrome'}!`,
        })
      },
      () => {
        if (!isCurrentSession(session)) return
        onProgress({
          account,
          status: 'code_generated',
          verificationUrl: url,
          message: 'Link de autorização gerado. Não foi possível abrir o navegador automaticamente; use Copiar Link ou Reabrir.',
        })
      }
    )
  }

  child.stdout?.on('data', handleOutput)
  child.stderr?.on('data', handleOutput)

  child.once('spawn', () => {
    if (session.startupSettled) return
    session.startupSettled = true
    resolveStartup()
  })

  child.once('error', (error) => {
    if (!session.startupSettled) {
      session.startupSettled = true
      rejectStartup(new Error(`Não foi possível iniciar o CLI do Codex: ${error.message}`))
    }
    emitError(session, 'Não foi possível iniciar o CLI do Codex. Verifique o caminho configurado.')
  })

  child.once('close', async (code) => {
    if (!session.startupSettled) {
      session.startupSettled = true
      rejectStartup(new Error('O processo de login encerrou antes de iniciar.'))
    }
    if (!isCurrentSession(session)) return

    session.finished = true
    clearTimeout(session.timeout)
    activeLoginSession = null
    const connected = code === 0 && await hasValidCodexAuth(codexHome)
    if (session.cancelled || session.generation !== loginGeneration) return
    if (connected) {
      onProgress({
        account,
        status: 'success',
        verificationUrl: session.capturedUrl || undefined,
        message: 'Autenticação concluída com sucesso!',
      })
      return
    }
    onProgress({
      account,
      status: 'error',
      message: code === 0
        ? 'O processo encerrou, mas o arquivo de autenticação não foi detectado.'
        : `Processo de login encerrado com código ${code ?? 'desconhecido'}.`,
    })
  })

  return startup
}

export async function cancelCodexLogin(invalidateGeneration = true): Promise<void> {
  if (invalidateGeneration) loginGeneration += 1
  const session = activeLoginSession
  if (!session) return
  session.cancelled = true
  clearTimeout(session.timeout)
  activeLoginSession = null
  const termination = terminateLoginProcessTree(session.child)
  if (!session.startupSettled) {
    session.startupSettled = true
    session.resolveStartup()
  }
  if (!session.finished) {
    session.finished = true
    session.onProgress({ account: session.account, status: 'cancelled', message: 'Processo de login cancelado.' })
  }
  await termination
}
