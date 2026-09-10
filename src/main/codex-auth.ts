import { spawn, ChildProcess } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import electron from 'electron'
const { clipboard } = electron
import { loadConfig } from './config'

export interface CodexAccountStatus {
  account1: {
    connected: boolean
    label: string
    path: string
  }
  account2: {
    connected: boolean
    label: string
    path: string
  }
}

export interface CodexAuthProgress {
  account: 'account1' | 'account2'
  status: 'idle' | 'starting' | 'code_generated' | 'success' | 'error' | 'cancelled'
  code?: string
  verificationUrl?: string
  message?: string
}

let activeLoginProcess: ChildProcess | null = null

export function getCodexDirForAccount(account: 'account1' | 'account2'): string {
  return account === 'account2'
    ? path.join(os.homedir(), '.codex-conta2')
    : path.join(os.homedir(), '.codex-conta1')
}

export async function checkCodexAuthStatus(): Promise<CodexAccountStatus> {
  const config = await loadConfig()
  const conta1Dir = getCodexDirForAccount('account1')
  const conta2Dir = getCodexDirForAccount('account2')

  const checkAuth = async (dir: string): Promise<boolean> => {
    try {
      const authFile = path.join(dir, 'auth.json')
      const stat = await fs.stat(authFile)
      return stat.size > 50
    } catch {
      return false
    }
  }

  const [c1, c2] = await Promise.all([
    checkAuth(conta1Dir),
    checkAuth(conta2Dir),
  ])

  return {
    account1: {
      connected: c1,
      label: config.chatGptAccount1Name || 'Conta 1 (Chrome)',
      path: conta1Dir,
    },
    account2: {
      connected: c2,
      label: config.chatGptAccount2Name || 'Conta 2 (Brave)',
      path: conta2Dir,
    },
  }
}

export async function startCodexDeviceLogin(
  account: 'account1' | 'account2',
  onProgress: (progress: CodexAuthProgress) => void
): Promise<void> {
  // Cancela processo anterior se houver
  cancelCodexLogin()

  const config = await loadConfig()
  const custom = config.customPaths
  const codexHome = getCodexDirForAccount(account)
  const codexCmd = custom.codex || 'codex.cmd'

  // Garante que a pasta existe
  await fs.mkdir(codexHome, { recursive: true })

  onProgress({
    account,
    status: 'starting',
    message: 'Iniciando autenticação oficial da OpenAI...',
  })

  // Inicia codex login padrão (suporta contas corporativas/workspace sem restrição de device-auth)
  const child = spawn(
    'cmd.exe',
    ['/c', codexCmd, 'login'],
    {
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
      },
    }
  )

  activeLoginProcess = child

  let capturedUrl = ''

  const handleOutput = (data: Buffer) => {
    const text = data.toString()
    console.log(`[codex login]: ${text}`)

    // Captura a URL de autorização OAuth
    const match = text.match(/(https:\/\/auth\.openai\.com\/oauth\/authorize\S+)/)
    if (match && !capturedUrl) {
      capturedUrl = match[1]

      // Copia automaticamente o link para o clipboard
      try {
        clipboard.writeText(capturedUrl)
      } catch (err) {
        console.error('Falha ao copiar link para o clipboard:', err)
      }

      // Abre o navegador correto (Brave para conta 2, Chrome para conta 1)
      const isAccount2 = account === 'account2'
      const browserPath = isAccount2
        ? custom.brave ||
          'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
        : custom.chrome ||
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

      try {
        spawn(browserPath, [capturedUrl], {
          detached: true,
          stdio: 'ignore',
        }).unref()
      } catch (e) {
        console.error(`Erro ao abrir navegador (${browserPath}):`, e)
      }

      onProgress({
        account,
        status: 'code_generated',
        verificationUrl: capturedUrl,
        message: `Página de login da OpenAI aberta no ${isAccount2 ? 'Brave' : 'Google Chrome'}!`,
      })
    }
  }

  child.stdout?.on('data', handleOutput)
  child.stderr?.on('data', handleOutput)

  child.on('close', async (code) => {
    activeLoginProcess = null

    if (code === 0) {
      // Verifica se auth.json foi de fato gerado
      const status = await checkCodexAuthStatus()
      const isConnected =
        account === 'account2'
          ? status.account2.connected
          : status.account1.connected

      if (isConnected) {
        onProgress({
          account,
          status: 'success',
          verificationUrl: capturedUrl,
          message: 'Autenticação concluída com sucesso!',
        })
      } else {
        onProgress({
          account,
          status: 'error',
          message: 'O processo encerrou, mas o arquivo de autenticação não foi detectado.',
        })
      }
    } else {
      onProgress({
        account,
        status: 'error',
        message: `Processo de login cancelado ou encerrado com código ${code}.`,
      })
    }
  })

  child.on('error', (err) => {
    activeLoginProcess = null
    onProgress({
      account,
      status: 'error',
      message: `Erro ao executar o CLI do Codex: ${err.message}`,
    })
  })
}

export function cancelCodexLogin(): void {
  if (activeLoginProcess && !activeLoginProcess.killed) {
    try {
      activeLoginProcess.kill('SIGTERM')
    } catch {
      // Ignora falha de kill
    }
    activeLoginProcess = null
  }
}
