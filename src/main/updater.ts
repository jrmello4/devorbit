import electron from 'electron'
import updater from 'electron-updater'
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const { app } = electron
const { autoUpdater } = updater
const execFileAsync = promisify(execFile)

const GITHUB_RELEASE_BASE = 'https://github.com/jrmello4/devorbit/releases'
const PORTABLE_MANIFEST_NAME = 'latest-portable.yml'
const PORTABLE_UPDATE_SCRIPT = [
  'param([int]$ProcessId,[string]$Source,[string]$Target,[string]$Backup,[string]$ScriptPath)',
  '$deadline = (Get-Date).AddSeconds(90)',
  'while ((Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) -or (Get-Process -Name DevOrbit -ErrorAction SilentlyContinue)) {',
  '  if ((Get-Date) -gt $deadline) { Remove-Item -LiteralPath $ScriptPath -Force -ErrorAction SilentlyContinue; exit 1 }',
  '  Start-Sleep -Milliseconds 250',
  '}',
  'try {',
  '  if (-not (Test-Path -LiteralPath $Source)) { throw "Arquivo de atualização ausente." }',
  '  if (Test-Path -LiteralPath $Target) { Move-Item -LiteralPath $Target -Destination $Backup -Force }',
  '  Move-Item -LiteralPath $Source -Destination $Target -Force',
  '  Start-Process -FilePath $Target',
  '  Remove-Item -LiteralPath $Backup -Force -ErrorAction SilentlyContinue',
  '} catch {',
  '  if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Force -ErrorAction SilentlyContinue }',
  '  if (Test-Path -LiteralPath $Backup) { Move-Item -LiteralPath $Backup -Destination $Target -Force }',
  '  exit 1',
  '} finally {',
  '  Remove-Item -LiteralPath $ScriptPath -Force -ErrorAction SilentlyContinue',
  '}',
].join('\r\n')

export type UpdateStatus = 'unavailable' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'

export type UpdateDistribution = 'installed' | 'portable' | 'dev'

export interface UpdateState {
  supported: boolean
  status: UpdateStatus
  distribution: UpdateDistribution
  version?: string
  progress?: number
  message?: string
}

export interface PortableManifest {
  version: string
  path: string
  sha512: string
}

let state: UpdateState = { supported: false, status: 'unavailable', distribution: 'dev' }
let publishState: (nextState: UpdateState) => void = () => undefined
let initialized = false
let githubHeaders: Record<string, string> = {}
let portableManifest: PortableManifest | null = null
let portableDownloadPath: string | null = null

function setState(nextState: UpdateState): void {
  state = nextState
  publishState(state)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function privateRepositoryHint(message: string): string {
  if (/404|latest\.yml|not found|cannot find/i.test(message)) {
    return 'Não foi possível consultar o release privado. Faça gh auth login uma vez neste computador e tente novamente.'
  }
  return message
}

export function getUpdateDistribution(info?: { packaged?: boolean; platform?: string; portableDir?: string }): UpdateDistribution {
  const packaged = info?.packaged ?? app.isPackaged
  const platform = info?.platform ?? process.platform
  const portableDir = info?.portableDir ?? process.env.PORTABLE_EXECUTABLE_DIR
  if (!packaged) return 'dev'
  if (portableDir) return 'portable'
  if (platform === 'win32') return 'installed'
  return 'dev'
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (value: string) => value.trim().replace(/^v/i, '').split(/[+-]/)[0].split('.').map((part) => Number(part))
  const candidateParts = parse(candidate)
  const currentParts = parse(current)
  if (candidateParts.length < 3 || currentParts.length < 3 || candidateParts.some((part) => !Number.isInteger(part)) || currentParts.some((part) => !Number.isInteger(part))) return false
  for (let index = 0; index < 3; index += 1) {
    if (candidateParts[index] !== currentParts[index]) return candidateParts[index] > currentParts[index]
  }
  return false
}

export function parsePortableManifest(content: string): PortableManifest | null {
  const normalized = content.replace(/^\uFEFF/, '')
  const version = normalized.match(/^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/m)?.[1]
  const filePath = normalized.match(/^path:\s*([^\r\n]+)\s*$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  const sha512 = normalized.match(/^sha512:\s*([A-Za-z0-9+/=]+)\s*$/m)?.[1]
  if (!version || !filePath || !sha512 || filePath.includes('/') || filePath.includes('\\') || !/^[A-Za-z0-9._-]+\.exe$/i.test(filePath)) return null
  return { version, path: filePath, sha512 }
}

export function getPortableExecutablePath(info?: {
  portableExecutableFile?: string
  portableExecutableDir?: string
  executablePath?: string
}): string | null {
  const executableFile = (info?.portableExecutableFile ?? process.env.PORTABLE_EXECUTABLE_FILE)?.trim()
  if (executableFile) return executableFile
  const executableDir = (info?.portableExecutableDir ?? process.env.PORTABLE_EXECUTABLE_DIR)?.trim()
  if (!executableDir) return null
  return path.join(executableDir, path.basename(info?.executablePath ?? process.execPath))
}

function canUpdate(): boolean {
  return getUpdateDistribution() === 'installed' || getUpdateDistribution() === 'portable'
}

export function getUpdateState(): UpdateState {
  return state
}

async function getGitHubToken(): Promise<string | null> {
  const configured = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim()
  if (configured) return configured
  try {
    const result = await execFileAsync('gh', ['auth', 'token'], { timeout: 5000, windowsHide: true })
    const token = String(result.stdout || '').trim()
    return token || null
  } catch {
    return null
  }
}

async function loadGitHubHeaders(): Promise<Record<string, string>> {
  const token = await getGitHubToken()
  return token
    ? { Authorization: 'Bearer ' + token, Accept: 'application/octet-stream' }
    : {}
}

async function fetchText(url: string, headers: Record<string, string>): Promise<string> {
  const response = await fetch(url, { headers, redirect: 'follow' })
  if (!response.ok) throw new Error('GitHub respondeu HTTP ' + response.status + '.')
  return await response.text()
}

async function checkPortableForUpdates(distribution: UpdateDistribution): Promise<void> {
  try {
    githubHeaders = await loadGitHubHeaders()
    if (!Object.keys(githubHeaders).length) {
      throw new Error('Autenticação do GitHub ausente. Faça gh auth login uma vez neste computador.')
    }
    const manifest = parsePortableManifest(
      await fetchText(GITHUB_RELEASE_BASE + '/latest/download/' + PORTABLE_MANIFEST_NAME, githubHeaders)
    )
    if (!manifest) throw new Error('Manifesto portable inválido ou ausente no último release.')
    if (!isNewerVersion(manifest.version, app.getVersion())) {
      setState({ supported: true, status: 'idle', distribution })
      return
    }
    portableManifest = manifest
    setState({ supported: true, status: 'available', distribution, version: manifest.version, progress: 0 })
    void downloadPortableUpdate()
  } catch (error) {
    setState({
      supported: true,
      status: 'error',
      distribution,
      message: privateRepositoryHint(errorMessage(error)),
    })
  }
}

function registerInstalledUpdaterEvents(distribution: UpdateDistribution): void {
  autoUpdater.on('checking-for-update', () => setState({ supported: true, status: 'checking', distribution }))
  autoUpdater.on('update-not-available', () => setState({ supported: true, status: 'idle', distribution }))
  autoUpdater.on('update-available', (info) => {
    setState({ supported: true, status: 'downloading', distribution, version: info.version, progress: 0 })
  })
  autoUpdater.on('download-progress', (progress) => {
    setState({ supported: true, status: 'downloading', distribution, version: state.version, progress: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    setState({ supported: true, status: 'downloaded', distribution, version: info.version, progress: 100 })
  })
  autoUpdater.on('error', (error) => {
    console.warn('Falha ao verificar atualização:', error)
    setState({
      supported: true,
      status: 'error',
      distribution,
      message: privateRepositoryHint(error.message),
    })
  })
}

export function initializeUpdater(sendState: (nextState: UpdateState) => void): void {
  publishState = sendState
  if (initialized) {
    publishState(state)
    return
  }
  initialized = true

  const distribution = getUpdateDistribution()
  if (distribution === 'dev') {
    setState({ supported: false, status: 'unavailable', distribution })
    return
  }

  setState({
    supported: true,
    status: 'checking',
    distribution,
    message: distribution === 'portable' ? 'Procurando atualizações automaticamente.' : undefined,
  })

  if (distribution === 'portable') {
    void checkPortableForUpdates(distribution)
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  registerInstalledUpdaterEvents(distribution)
  void (async () => {
    githubHeaders = await loadGitHubHeaders()
    if (!Object.keys(githubHeaders).length) {
      throw new Error('Autenticação do GitHub ausente. Faça gh auth login uma vez neste computador.')
    }
    autoUpdater.requestHeaders = githubHeaders
    await autoUpdater.checkForUpdates()
  })().catch((error: unknown) => {
    setState({
      supported: true,
      status: 'error',
      distribution,
      message: privateRepositoryHint(errorMessage(error)),
    })
  })
}

async function downloadPortableUpdate(): Promise<UpdateState> {
  if (getUpdateDistribution() !== 'portable' || state.status !== 'available' || !portableManifest) return state
  const manifest = portableManifest
  const temporaryPath = path.join(app.getPath('temp'), 'DevOrbit-' + manifest.version + '-' + Date.now() + '.exe.download')
  setState({ ...state, status: 'downloading', progress: 0 })
  try {
    const response = await fetch(
      GITHUB_RELEASE_BASE + '/download/v' + manifest.version + '/' + encodeURIComponent(manifest.path),
      { headers: githubHeaders, redirect: 'follow' }
    )
    if (!response.ok) throw new Error('GitHub respondeu HTTP ' + response.status + '.')
    if (!response.body) throw new Error('O download não retornou um arquivo.')
    const total = Number(response.headers.get('content-length') || 0)
    const hash = createHash('sha512')
    let received = 0
    let lastProgress = -1
    const input = Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>)
    input.on('data', (chunk: Buffer) => {
      received += chunk.length
      hash.update(chunk)
      if (total > 0) {
        const progress = Math.min(99, Math.floor((received / total) * 100))
        if (progress !== lastProgress) {
          lastProgress = progress
          setState({ supported: true, status: 'downloading', distribution: 'portable', version: manifest.version, progress })
        }
      }
    })
    await pipeline(input, createWriteStream(temporaryPath))
    const digest = hash.digest('hex')
    const expected = manifest.sha512.toLowerCase()
    const valid = /^[a-f0-9]{128}$/.test(expected) ? digest === expected : Buffer.from(digest, 'hex').toString('base64') === manifest.sha512
    if (!valid) throw new Error('A verificação de integridade da atualização falhou.')
    const finalPath = temporaryPath.replace(/\.download$/i, '')
    await fs.rename(temporaryPath, finalPath)
    portableDownloadPath = finalPath
    setState({ supported: true, status: 'downloaded', distribution: 'portable', version: manifest.version, progress: 100 })
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    setState({
      supported: true,
      status: 'error',
      distribution: 'portable',
      version: manifest.version,
      message: privateRepositoryHint(errorMessage(error)),
    })
  }
  return state
}

export async function downloadUpdate(): Promise<UpdateState> {
  const distribution = getUpdateDistribution()
  if (distribution === 'portable') return await downloadPortableUpdate()
  if (distribution !== 'installed' || state.status !== 'available') return state
  setState({ ...state, status: 'downloading', progress: 0 })
  try {
    await autoUpdater.downloadUpdate()
  } catch (error: unknown) {
    setState({ supported: true, status: 'error', distribution, version: state.version, message: privateRepositoryHint(errorMessage(error)) })
  }
  return state
}

export async function installUpdate(): Promise<{ success: boolean; message?: string }> {
  const distribution = getUpdateDistribution()
  if (!canUpdate() || state.status !== 'downloaded') {
    return { success: false, message: 'Nenhuma atualização pronta para instalar.' }
  }

  if (distribution === 'installed') {
    autoUpdater.quitAndInstall()
    return { success: true }
  }

  if (process.platform !== 'win32' || !portableDownloadPath) {
    return { success: false, message: 'A atualização portable não está pronta.' }
  }

  const executablePath = getPortableExecutablePath()
  if (!executablePath) {
    return { success: false, message: 'Não foi possível localizar o executável portable atual.' }
  }

  const powershellPath = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  try {
    await fs.access(executablePath)
    await fs.access(portableDownloadPath)
    await fs.access(powershellPath)
    const scriptPath = path.join(app.getPath('temp'), 'devorbit-update-' + process.pid + '-' + Date.now() + '.ps1')
    const backupPath = executablePath + '.backup-' + Date.now()
    await fs.writeFile(scriptPath, PORTABLE_UPDATE_SCRIPT, 'utf8')
    const child = spawn(
      powershellPath,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-ProcessId',
        String(process.pid),
        '-Source',
        portableDownloadPath,
        '-Target',
        executablePath,
        '-Backup',
        backupPath,
        '-ScriptPath',
        scriptPath,
      ],
      { detached: true, stdio: 'ignore', windowsHide: true }
    )
    child.unref()
    app.quit()
    return { success: true, message: 'Atualização preparada; o app será reiniciado agora.' }
  } catch (error) {
    return { success: false, message: 'Não foi possível preparar a atualização: ' + errorMessage(error) }
  }
}