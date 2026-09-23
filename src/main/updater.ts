import electron from 'electron'
import updater from 'electron-updater'
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const app = (electron as unknown as { app?: Electron.App })?.app
const { autoUpdater } = updater
const execFileAsync = promisify(execFile)

const GITHUB_REPO_OWNER = 'jrmello4'
const GITHUB_REPO_NAME = 'devorbit'
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}`
const PORTABLE_MANIFEST_NAME = 'latest-portable.yml'
export const MAX_UPDATE_BYTES = 512 * 1024 * 1024
export const MAX_MANIFEST_BYTES = 64 * 1024
export const MAX_RELEASE_METADATA_BYTES = 256 * 1024
export const UPDATE_BASE_INTERVAL_MS = 30 * 60 * 1000
export const UPDATE_INITIAL_BACKOFF_MS = 60 * 1000
export const UPDATE_MAX_BACKOFF_MS = 60 * 60 * 1000
export const UPDATE_BACKOFF_MULTIPLIER = 2

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

export const PUBLISH_CONFIG = {
  provider: 'github' as const,
  owner: 'jrmello4',
  repo: 'devorbit',
  private: true,
}

export type TokenSource = 'env:GH_TOKEN' | 'env:GITHUB_TOKEN' | 'gh-cli' | 'none'

export interface UpdateDiagnostic {
  hasToken: boolean
  tokenSource: TokenSource
  tokenMasked: string | null
  provider: string
  isPrivate: boolean
  releaseTag?: string
  manifestFound?: boolean
  manifestVersion?: string
  manifestPath?: string
  httpStatus?: number
  assetError?: string
  errorDetail?: string
}

export type UpdateStatus = 'unavailable' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'

export type UpdateDistribution = 'installed' | 'portable' | 'dev'

export interface UpdateState {
  supported: boolean
  status: UpdateStatus
  distribution: UpdateDistribution
  version?: string
  progress?: number
  message?: string
  diagnostic?: UpdateDiagnostic
}

export interface PortableManifest {
  version: string
  path: string
  sha512: string
}

interface GitHubReleaseAsset {
  id: number
  name: string
  url: string
  size: number
}

interface GitHubReleaseResponse {
  tag_name: string
  name?: string
  assets?: GitHubReleaseAsset[]
}

let state: UpdateState = { supported: false, status: 'unavailable', distribution: 'dev' }
let publishState: (nextState: UpdateState) => void = () => undefined
let initialized = false
let githubHeaders: Record<string, string> = {}
let portableManifest: PortableManifest | null = null
let portableDownloadPath: string | null = null
let portableDownloadInFlight: Promise<UpdateState> | null = null
let portableDownloadUrl: string | null = null
let portableReleaseTag: string | null = null
let retryTimer: NodeJS.Timeout | null = null
let consecutiveFailures = 0
let portableInstallTriggered = false
let portableQuitHandlerRegistered = false
let currentDiagnostic: UpdateDiagnostic | undefined = undefined

export function getUpdateDiagnostic(): UpdateDiagnostic | undefined {
  return state.diagnostic ?? currentDiagnostic
}

export class UpdateError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
    public readonly assetName?: string
  ) {
    super(message)
    this.name = 'UpdateError'
  }
}

export function maskToken(token: string | null): string | null {
  if (!token) return null
  const trimmed = token.trim()
  if (trimmed.length <= 8) return '***'
  const prefix = trimmed.slice(0, 4)
  const suffix = trimmed.slice(-4)
  return `${prefix}...${suffix}`
}

export function extractHttpStatus(message: string): number | undefined {
  const match = message.match(/HTTP\s+(\d{3})|status\s+code\s+(\d{3})|(\d{3})\s+(?:Not Found|Forbidden|Unauthorized)/i)
  if (!match) return undefined
  const code = Number(match[1] || match[2] || match[3])
  return Number.isInteger(code) ? code : undefined
}

export function formatDiagnosticErrorMessage(rawMessage: string, diagnostic?: UpdateDiagnostic): string {
  if (!diagnostic?.hasToken) {
    return 'Autenticação do GitHub ausente. Faça gh auth login uma vez neste computador e tente novamente.'
  }
  if (diagnostic.httpStatus === 404) {
    return `Release ou asset não encontrado no repositório privado ${diagnostic.provider || 'github'} (HTTP 404).`
  }
  if (diagnostic.httpStatus === 401 || diagnostic.httpStatus === 403) {
    return `Acesso não autorizado ao repositório privado (HTTP ${diagnostic.httpStatus}). Verifique permissões do token ${diagnostic.tokenMasked || ''}.`
  }
  if (diagnostic.assetError) {
    return diagnostic.assetError
  }
  return rawMessage
}

function setState(nextState: UpdateState): void {
  state = nextState
  publishState(state)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getTempDir(): string {
  return typeof app?.getPath === 'function' ? app.getPath('temp') : (process.env.TEMP || process.env.TMP || os.tmpdir())
}

export function getBackoffDelay(failures = consecutiveFailures): number {
  if (failures <= 0) return UPDATE_BASE_INTERVAL_MS
  return Math.min(
    UPDATE_INITIAL_BACKOFF_MS * Math.pow(UPDATE_BACKOFF_MULTIPLIER, failures - 1),
    UPDATE_MAX_BACKOFF_MS
  )
}

export function stopPeriodicUpdater(): void {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

export function scheduleNextCheck(delayMs: number): void {
  stopPeriodicUpdater()
  if (!initialized || state.distribution === 'dev') return
  retryTimer = setTimeout(() => {
    void checkForUpdatesWithRetry()
  }, delayMs)
  if (typeof retryTimer.unref === 'function') {
    retryTimer.unref()
  }
}

export async function checkForUpdatesWithRetry(): Promise<void> {
  if (state.status === 'downloading' || state.status === 'downloaded') return
  const distribution = getUpdateDistribution()
  if (distribution === 'portable') {
    await checkPortableForUpdates(distribution)
  } else if (distribution === 'installed') {
    await checkInstalledForUpdates(distribution)
  }
}

export function getUpdateDistribution(info?: { packaged?: boolean; platform?: string; portableDir?: string }): UpdateDistribution {
  const packaged = info?.packaged ?? Boolean(app?.isPackaged)
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
  return path.win32.join(executableDir, path.win32.basename(info?.executablePath ?? process.execPath))
}

function canUpdate(): boolean {
  return getUpdateDistribution() === 'installed' || getUpdateDistribution() === 'portable'
}

export function getUpdateState(): UpdateState {
  return state
}

export interface GitHubTokenResolution {
  token: string | null
  source: TokenSource
  masked: string | null
}

let execFileRunner: (file: string, args: readonly string[], options?: any) => Promise<{ stdout: string; stderr: string }> = execFileAsync

export function _setExecFileRunnerForTest(
  fn: ((file: string, args: readonly string[], options?: any) => Promise<{ stdout: string; stderr: string }>) | null
): void {
  execFileRunner = fn ?? execFileAsync
}

/** Sem token via `gh`: re-tenta o spawn só depois deste TTL (evita um
 * `gh auth token` por ciclo de retry com backoff). Positivo vale pelo
 * tempo do processo — env é verificado antes do cache a cada chamada. */
const GH_TOKEN_NEGATIVE_TTL_MS = 10 * 60 * 1000
let cachedGhCliResolution: { resolution: GitHubTokenResolution; at: number } | undefined

export async function resolveGitHubToken(): Promise<GitHubTokenResolution> {
  const ghToken = (process.env.GH_TOKEN || '').trim()
  if (ghToken) {
    return { token: ghToken, source: 'env:GH_TOKEN', masked: maskToken(ghToken) }
  }
  const githubToken = (process.env.GITHUB_TOKEN || '').trim()
  if (githubToken) {
    return { token: githubToken, source: 'env:GITHUB_TOKEN', masked: maskToken(githubToken) }
  }
  const cached = cachedGhCliResolution
  if (cached) {
    const isPositive = cached.resolution.token !== null
    if (isPositive || Date.now() - cached.at < GH_TOKEN_NEGATIVE_TTL_MS) {
      return cached.resolution
    }
  }
  try {
    const result = await execFileRunner('gh', ['auth', 'token'], { timeout: 5000, windowsHide: true })
    const token = String(result.stdout || '').trim()
    if (token) {
      const resolution: GitHubTokenResolution = { token, source: 'gh-cli', masked: maskToken(token) }
      cachedGhCliResolution = { resolution, at: Date.now() }
      return resolution
    }
  } catch {
    // gh CLI ausente, não autenticado ou erro na chamada
  }
  const resolution: GitHubTokenResolution = { token: null, source: 'none', masked: null }
  cachedGhCliResolution = { resolution, at: Date.now() }
  return resolution
}

export async function getGitHubToken(): Promise<string | null> {
  const resolution = await resolveGitHubToken()
  return resolution.token
}

export function isValidUpdateSize(size: number, maxBytes = MAX_UPDATE_BYTES): boolean {
  return Number.isSafeInteger(size) && size >= 0 && size <= maxBytes
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 12_000
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error: unknown) {
    if (controller.signal.aborted) throw new Error('tempo limite excedido')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > 0 && !isValidUpdateSize(contentLength, maxBytes)) {
    throw new Error('resposta do GitHub excede o limite permitido')
  }
  if (!response.body) {
    const text = await response.text()
    if (!isValidUpdateSize(Buffer.byteLength(text, 'utf8'), maxBytes)) {
      throw new Error('resposta do GitHub excede o limite permitido')
    }
    return text
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value.byteLength
      if (!isValidUpdateSize(received, maxBytes)) {
        await reader.cancel()
        throw new Error('resposta do GitHub excede o limite permitido')
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

export async function checkPortableForUpdates(distribution: UpdateDistribution = 'portable'): Promise<void> {
  const resolution = await resolveGitHubToken()
  const token = resolution.token
  let diagnostic: UpdateDiagnostic = {
    hasToken: Boolean(token),
    tokenSource: resolution.source,
    tokenMasked: resolution.masked,
    provider: PUBLISH_CONFIG.provider,
    isPrivate: PUBLISH_CONFIG.private,
  }

  if (!token) {
    consecutiveFailures += 1
    currentDiagnostic = {
      ...diagnostic,
      errorDetail: 'Nenhum token encontrado via GH_TOKEN, GITHUB_TOKEN ou gh auth token.',
    }
    setState({
      supported: true,
      status: 'error',
      distribution,
      message: 'Autenticação do GitHub ausente. Faça gh auth login uma vez neste computador.',
      diagnostic: currentDiagnostic,
    })
    scheduleNextCheck(getBackoffDelay())
    return
  }

  // Autenticação só por headers explícitos: nunca escrever o token em
  // `process.env`, que é herdado por PTYs/agentes filhos.
  try {
    const apiHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'DevOrbit-Updater',
    }

    const releaseResponse = await fetchWithTimeout(
      `${GITHUB_API_BASE}/releases/latest`,
      { headers: apiHeaders, redirect: 'follow' }
    )
    if (!releaseResponse.ok) {
      throw new UpdateError(
        `GitHub API respondeu HTTP ${releaseResponse.status}.`,
        releaseResponse.status
      )
    }

    const releaseText = await readResponseText(releaseResponse, MAX_RELEASE_METADATA_BYTES)
    const release = JSON.parse(releaseText) as GitHubReleaseResponse
    diagnostic.releaseTag = release.tag_name

    if (!release.assets || !Array.isArray(release.assets)) {
      throw new UpdateError(
        `Nenhum asset encontrado na release ${release.tag_name || 'recente'}.`,
        200
      )
    }

    const manifestAsset = release.assets.find((asset) => asset.name === PORTABLE_MANIFEST_NAME)
    diagnostic.manifestFound = Boolean(manifestAsset)

    if (!manifestAsset) {
      const available = release.assets.map((a) => a.name).join(', ') || 'nenhum'
      throw new UpdateError(
        `Manifesto ${PORTABLE_MANIFEST_NAME} ausente na release ${release.tag_name}. Assets presentes: ${available}`,
        200,
        PORTABLE_MANIFEST_NAME
      )
    }

    const manifestResponse = await fetchWithTimeout(
      manifestAsset.url,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/octet-stream',
          'User-Agent': 'DevOrbit-Updater',
        },
        redirect: 'follow',
      }
    )
    if (!manifestResponse.ok) {
      throw new UpdateError(
        `Falha ao baixar ${PORTABLE_MANIFEST_NAME} via asset API (HTTP ${manifestResponse.status}).`,
        manifestResponse.status,
        PORTABLE_MANIFEST_NAME
      )
    }

    const manifestContent = await readResponseText(manifestResponse, MAX_MANIFEST_BYTES)
    const manifest = parsePortableManifest(manifestContent)
    if (!manifest) {
      throw new UpdateError(
        'Manifesto portable possui formato inválido ou corrompido.',
        200,
        PORTABLE_MANIFEST_NAME
      )
    }

    diagnostic.manifestVersion = manifest.version
    diagnostic.manifestPath = manifest.path

    const currentVersion = typeof app?.getVersion === 'function' ? app.getVersion() : (process.env.npm_package_version || '1.0.0')
    if (!isNewerVersion(manifest.version, currentVersion)) {
      consecutiveFailures = 0
      currentDiagnostic = diagnostic
      setState({
        supported: true,
        status: 'idle',
        distribution,
        version: manifest.version,
        diagnostic,
      })
      scheduleNextCheck(UPDATE_BASE_INTERVAL_MS)
      return
    }

    const binaryAsset = release.assets.find((asset) => asset.name === manifest.path)
    if (!binaryAsset) {
      const available = release.assets.map((a) => a.name).join(', ') || 'nenhum'
      throw new UpdateError(
        `Executável portable ${manifest.path} não encontrado nos assets da release ${release.tag_name}. Assets presentes: ${available}`,
        200,
        manifest.path
      )
    }

    portableManifest = manifest
    portableDownloadUrl = binaryAsset.url
    portableReleaseTag = release.tag_name
    consecutiveFailures = 0
    currentDiagnostic = diagnostic
    setState({
      supported: true,
      status: 'available',
      distribution,
      version: manifest.version,
      progress: 0,
      diagnostic,
    })
    void downloadPortableUpdate()
  } catch (error) {
    consecutiveFailures += 1
    const message = errorMessage(error)
    const httpStatus = error instanceof UpdateError ? error.httpStatus : extractHttpStatus(message)
    const assetError = error instanceof UpdateError && error.assetName ? error.message : undefined
    diagnostic = {
      ...diagnostic,
      httpStatus: httpStatus ?? diagnostic.httpStatus,
      assetError: assetError ?? diagnostic.assetError,
      errorDetail: message,
    }
    currentDiagnostic = diagnostic
    setState({
      supported: true,
      status: 'error',
      distribution,
      message: formatDiagnosticErrorMessage(message, diagnostic),
      diagnostic,
    })
    scheduleNextCheck(getBackoffDelay())
  }
}

export async function checkInstalledForUpdates(distribution: UpdateDistribution = 'installed'): Promise<void> {
  const resolution = await resolveGitHubToken()
  const token = resolution.token
  let diagnostic: UpdateDiagnostic = {
    hasToken: Boolean(token),
    tokenSource: resolution.source,
    tokenMasked: resolution.masked,
    provider: PUBLISH_CONFIG.provider,
    isPrivate: PUBLISH_CONFIG.private,
  }

  if (!token) {
    consecutiveFailures += 1
    currentDiagnostic = {
      ...diagnostic,
      errorDetail: 'Nenhum token encontrado via GH_TOKEN, GITHUB_TOKEN ou gh auth token.',
    }
    setState({
      supported: true,
      status: 'error',
      distribution,
      message: 'Autenticação do GitHub ausente. Faça gh auth login uma vez neste computador.',
      diagnostic: currentDiagnostic,
    })
    scheduleNextCheck(getBackoffDelay())
    return
  }

  // O token vai apenas para os headers do updater (provider/requestHeaders),
  // nunca para `process.env`.
  githubHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/octet-stream',
  }
  autoUpdater.requestHeaders = githubHeaders
  currentDiagnostic = diagnostic

  try {
    await autoUpdater.checkForUpdates()
  } catch (error: unknown) {
    consecutiveFailures += 1
    const message = errorMessage(error)
    const httpStatus = extractHttpStatus(message)
    diagnostic = {
      ...diagnostic,
      httpStatus,
      errorDetail: message,
    }
    currentDiagnostic = diagnostic
    setState({
      supported: true,
      status: 'error',
      distribution,
      message: formatDiagnosticErrorMessage(message, diagnostic),
      diagnostic,
    })
    scheduleNextCheck(getBackoffDelay())
  }
}

function registerInstalledUpdaterEvents(distribution: UpdateDistribution): void {
  autoUpdater.on('checking-for-update', () => {
    setState({
      supported: true,
      status: 'checking',
      distribution,
      diagnostic: currentDiagnostic,
    })
  })
  autoUpdater.on('update-not-available', (info) => {
    consecutiveFailures = 0
    currentDiagnostic = {
      ...(currentDiagnostic || {
        hasToken: Boolean(process.env.GH_TOKEN),
        tokenSource: 'none',
        tokenMasked: null,
        provider: PUBLISH_CONFIG.provider,
        isPrivate: PUBLISH_CONFIG.private,
      }),
      manifestFound: true,
      releaseTag: info?.version ? `v${info.version}` : undefined,
    }
    setState({
      supported: true,
      status: 'idle',
      distribution,
      version: info?.version,
      diagnostic: currentDiagnostic,
    })
    scheduleNextCheck(UPDATE_BASE_INTERVAL_MS)
  })
  autoUpdater.on('update-available', (info) => {
    currentDiagnostic = {
      ...(currentDiagnostic || {
        hasToken: Boolean(process.env.GH_TOKEN),
        tokenSource: 'none',
        tokenMasked: null,
        provider: PUBLISH_CONFIG.provider,
        isPrivate: PUBLISH_CONFIG.private,
      }),
      manifestFound: true,
      manifestVersion: info.version,
      releaseTag: info?.version ? `v${info.version}` : undefined,
    }
    setState({
      supported: true,
      status: 'downloading',
      distribution,
      version: info.version,
      progress: 0,
      diagnostic: currentDiagnostic,
    })
  })
  autoUpdater.on('download-progress', (progress) => {
    setState({
      supported: true,
      status: 'downloading',
      distribution,
      version: state.version,
      progress: Math.round(progress.percent),
      diagnostic: currentDiagnostic,
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    consecutiveFailures = 0
    currentDiagnostic = {
      ...(currentDiagnostic || {
        hasToken: Boolean(process.env.GH_TOKEN),
        tokenSource: 'none',
        tokenMasked: null,
        provider: PUBLISH_CONFIG.provider,
        isPrivate: PUBLISH_CONFIG.private,
      }),
      manifestFound: true,
      manifestVersion: info.version,
    }
    setState({
      supported: true,
      status: 'downloaded',
      distribution,
      version: info.version,
      progress: 100,
      diagnostic: currentDiagnostic,
    })
  })
  autoUpdater.on('error', (error) => {
    console.warn('Falha ao verificar atualização:', error)
    consecutiveFailures += 1
    const message = error.message || String(error)
    const httpStatus = extractHttpStatus(message)
    const diagnostic: UpdateDiagnostic = {
      ...(currentDiagnostic || {
        hasToken: Boolean(process.env.GH_TOKEN),
        tokenSource: process.env.GH_TOKEN ? 'env:GH_TOKEN' : 'none',
        tokenMasked: maskToken(process.env.GH_TOKEN || null),
        provider: PUBLISH_CONFIG.provider,
        isPrivate: PUBLISH_CONFIG.private,
      }),
      httpStatus,
      errorDetail: message,
    }
    currentDiagnostic = diagnostic
    setState({
      supported: true,
      status: 'error',
      distribution,
      message: formatDiagnosticErrorMessage(message, diagnostic),
      diagnostic,
    })
    scheduleNextCheck(getBackoffDelay())
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

  if (!portableQuitHandlerRegistered && typeof app?.on === 'function') {
    portableQuitHandlerRegistered = true
    app.on('before-quit', () => {
      stopPeriodicUpdater()
      void handleAppQuitPortableUpdate()
    })
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
  void checkInstalledForUpdates(distribution)
}

async function performPortableDownload(): Promise<UpdateState> {
  if (getUpdateDistribution() !== 'portable' || state.status !== 'available' || !portableManifest) return state
  const manifest = portableManifest
  const assetUrl = portableDownloadUrl
  if (!assetUrl) {
    const errorDetail = 'URL do executável portable ausente nos assets da release.'
    currentDiagnostic = {
      ...(currentDiagnostic || {
        hasToken: Boolean(process.env.GH_TOKEN),
        tokenSource: 'none',
        tokenMasked: null,
        provider: PUBLISH_CONFIG.provider,
        isPrivate: PUBLISH_CONFIG.private,
      }),
      assetError: errorDetail,
      errorDetail,
    }
    setState({
      supported: true,
      status: 'error',
      distribution: 'portable',
      version: manifest.version,
      message: errorDetail,
      diagnostic: currentDiagnostic,
    })
    return state
  }

  const temporaryPath = path.join(getTempDir(), 'DevOrbit-' + manifest.version + '-' + Date.now() + '.exe.download')
  setState({ ...state, status: 'downloading', progress: 0, diagnostic: currentDiagnostic })
  try {
    const resolution = await resolveGitHubToken()
    const token = resolution.token
    const downloadHeaders: Record<string, string> = {
      Accept: 'application/octet-stream',
      'User-Agent': 'DevOrbit-Updater',
    }
    if (token) {
      downloadHeaders.Authorization = `Bearer ${token}`
    }

    const response = await fetchWithTimeout(
      assetUrl,
      { headers: downloadHeaders, redirect: 'follow' },
      60_000
    )
    if (!response.ok) {
      throw new UpdateError(
        `Falha ao baixar asset executável ${manifest.path} (HTTP ${response.status}).`,
        response.status,
        manifest.path
      )
    }
    if (!response.body) throw new Error('O download não retornou um arquivo.')
    const total = Number(response.headers.get('content-length') || 0)
    if (total > 0 && !isValidUpdateSize(total)) {
      throw new Error('O arquivo de atualização excede o limite permitido.')
    }
    const hash = createHash('sha512')
    let received = 0
    let lastProgress = -1
    const input = Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>)
    input.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (!isValidUpdateSize(received)) {
        input.destroy(new Error('O arquivo de atualização excede o limite permitido.'))
        return
      }
      hash.update(chunk)
      if (total > 0) {
        const progress = Math.min(99, Math.floor((received / total) * 100))
        if (progress !== lastProgress) {
          lastProgress = progress
          setState({
            supported: true,
            status: 'downloading',
            distribution: 'portable',
            version: manifest.version,
            progress,
            diagnostic: currentDiagnostic,
          })
        }
      }
    })
    await pipeline(input, createWriteStream(temporaryPath))
    const digest = hash.digest('hex')
    const expected = manifest.sha512.toLowerCase()
    const valid = /^[a-f0-9]{128}$/.test(expected) ? digest === expected : Buffer.from(digest, 'hex').toString('base64') === manifest.sha512
    if (!valid) {
      throw new UpdateError('A verificação de integridade da atualização falhou.', 200, manifest.path)
    }
    const finalPath = temporaryPath.replace(/\.download$/i, '')
    await fs.rename(temporaryPath, finalPath)
    portableDownloadPath = finalPath
    consecutiveFailures = 0
    setState({
      supported: true,
      status: 'downloaded',
      distribution: 'portable',
      version: manifest.version,
      progress: 100,
      diagnostic: currentDiagnostic,
    })
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    const message = errorMessage(error)
    const httpStatus = error instanceof UpdateError ? error.httpStatus : extractHttpStatus(message)
    const assetError = error instanceof UpdateError && error.assetName ? error.message : undefined
    currentDiagnostic = {
      ...(currentDiagnostic || {
        hasToken: Boolean(process.env.GH_TOKEN),
        tokenSource: 'none',
        tokenMasked: null,
        provider: PUBLISH_CONFIG.provider,
        isPrivate: PUBLISH_CONFIG.private,
      }),
      httpStatus: httpStatus ?? currentDiagnostic?.httpStatus,
      assetError: assetError ?? currentDiagnostic?.assetError,
      errorDetail: message,
    }
    setState({
      supported: true,
      status: 'error',
      distribution: 'portable',
      version: manifest.version,
      message: formatDiagnosticErrorMessage(message, currentDiagnostic),
      diagnostic: currentDiagnostic,
    })
  }
  return state
}

function downloadPortableUpdate(): Promise<UpdateState> {
  if (portableDownloadInFlight) return portableDownloadInFlight
  const operation = performPortableDownload()
  const trackedOperation = operation.finally(() => {
    if (portableDownloadInFlight === trackedOperation) portableDownloadInFlight = null
  })
  portableDownloadInFlight = trackedOperation
  return trackedOperation
}

export async function downloadUpdate(): Promise<UpdateState> {
  const distribution = getUpdateDistribution()
  if (distribution === 'portable') return await downloadPortableUpdate()
  if (distribution !== 'installed' || state.status !== 'available') return state
  setState({ ...state, status: 'downloading', progress: 0, diagnostic: currentDiagnostic })
  try {
    await autoUpdater.downloadUpdate()
  } catch (error: unknown) {
    const message = errorMessage(error)
    const httpStatus = extractHttpStatus(message)
    currentDiagnostic = {
      ...(currentDiagnostic || {
        hasToken: Boolean(process.env.GH_TOKEN),
        tokenSource: 'none',
        tokenMasked: null,
        provider: PUBLISH_CONFIG.provider,
        isPrivate: PUBLISH_CONFIG.private,
      }),
      httpStatus,
      errorDetail: message,
    }
    setState({
      supported: true,
      status: 'error',
      distribution,
      version: state.version,
      message: formatDiagnosticErrorMessage(message, currentDiagnostic),
      diagnostic: currentDiagnostic,
    })
  }
  return state
}

export async function handleAppQuitPortableUpdate(): Promise<boolean> {
  if (portableInstallTriggered) return false
  if (getUpdateDistribution() !== 'portable' || state.status !== 'downloaded') return false
  if (process.platform !== 'win32' || !portableDownloadPath) return false

  const executablePath = getPortableExecutablePath()
  if (!executablePath) return false

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
    portableInstallTriggered = true

    const scriptPath = path.join(getTempDir(), 'devorbit-update-' + process.pid + '-' + Date.now() + '.ps1')
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
    return true
  } catch (error) {
    console.warn('Falha ao disparar instalação portable no encerramento:', error)
    return false
  }
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

  const spawned = await handleAppQuitPortableUpdate()
  if (spawned) {
    if (typeof app?.quit === 'function') {
      app.quit()
    }
    return { success: true, message: 'Atualização preparada; o app será reiniciado agora.' }
  }
  return { success: false, message: 'Não foi possível preparar a atualização portable.' }
}

export function _resetUpdaterForTest(): void {
  stopPeriodicUpdater()
  initialized = false
  consecutiveFailures = 0
  portableInstallTriggered = false
  portableQuitHandlerRegistered = false
  portableManifest = null
  portableDownloadPath = null
  portableDownloadUrl = null
  portableReleaseTag = null
  portableDownloadInFlight = null
  currentDiagnostic = undefined
  execFileRunner = execFileAsync
  cachedGhCliResolution = undefined
  state = { supported: false, status: 'unavailable', distribution: 'dev' }
}
