/**
 * Backend do ai-usagebar no main do DevOrbit (v1.24.0 pinada).
 *
 * Contrato para o IPC:
 * - `snapshot()` devolve sempre um estado seguro (nunca segredos/stderr cru);
 * - `refresh()` é o ÚNICO caminho que roda `usage --json` (single-flight,
 *   sem timers/auto-refresh/startup) e é fail-open (mantém o último relatório
 *   com `stale: true` quando a CLI falha);
 * - primeiro uso: se o config sob o userData não existe, um TOML válido é
 *   criado ATOMICAMENTE (sem detect/enable de qualquer vendor);
 * - `detect()` é SOMENTE explícito (o `detect` upstream ESCREVE no config);
 * - nenhum caminho troca de conta (`account switch` é proibido);
 * - binário: candidato empacotado SÓ é aceito com SHA-256/versão exatos;
 *   caso contrário cai para o download no runtime sob userData (nunca
 *   escreve em resources);
 * - `usageLock` injetável embrulha SOMENTE a chamada de `usage` no refresh.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  AI_USAGEBAR_DEFAULT_CONFIG_CONTENT,
  AI_USAGEBAR_VERSION,
  AI_USAGEBAR_WINDOWS_X64_SHA256,
  AI_USAGEBAR_WINDOWS_X64_URL,
  defaultAiUsagebarDownload,
  setVendorEnabledInConfig,
  sanitizeAiUsagebarMessage,
  resolveAiUsagebarPaths,
  type AiUsagebarDownloadOptions,
  type AiUsagebarPaths,
} from './ai-usagebar-config'
import { sharedConfigWriteLock, type ConfigWriteLock } from './ai-usagebar-config-lock'
import {
  AiUsagebarClient,
  type AiUsagebarAccountConfig,
  type AiUsagebarCommandRunner,
} from './ai-usagebar-client'
import {
  AI_USAGEBAR_SUPPORTED_SCHEMA_VERSION,
  type AiUsagebarDetectReport,
  type AiUsagebarReport,
  type AiUsagebarServiceState,
  type AiUsagebarSnapshot,
  type AiUsagebarVendor,
} from '../shared/ai-usagebar-contract'

export type AiUsagebarAccountProvider = () =>
  | Promise<AiUsagebarAccountConfig | undefined>
  | AiUsagebarAccountConfig
  | undefined

export interface AiUsagebarFileSystem {
  exists(filePath: string): Promise<boolean>
  readFile(filePath: string): Promise<string>
  readFileBytes(filePath: string): Promise<Uint8Array>
  writeFile(filePath: string, data: string | Uint8Array): Promise<void>
  mkdir(dirPath: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(filePath: string): Promise<void>
}

const nodeFileSystem: AiUsagebarFileSystem = {
  exists: async (filePath) => {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  },
  readFile: (filePath) => fs.readFile(filePath, 'utf8'),
  readFileBytes: (filePath) => fs.readFile(filePath),
  writeFile: (filePath, data) => fs.writeFile(filePath, data),
  mkdir: async (dirPath) => {
    await fs.mkdir(dirPath, { recursive: true })
  },
  rename: (from, to) => fs.rename(from, to),
  rm: (filePath) => fs.rm(filePath, { force: true }),
}

export type AiUsagebarDownload = (
  url: string,
  destination: string,
  options?: AiUsagebarDownloadOptions
) => Promise<void>

export interface AiUsagebarServiceOptions {
  userDataDir: string
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
  binaryPath?: string
  /** Candidato empacotado (read-only) aceito só com hash/versão exatos. */
  bundledBinaryPath?: string
  runner?: AiUsagebarCommandRunner
  fileSystem?: AiUsagebarFileSystem
  /** Downloader injetável; default = fetch bounded com AbortController. */
  download?: AiUsagebarDownload
  expectedSha256?: string
  expectedVersion?: string
  timeoutMs?: number
  now?: () => number
  /**
   * Lock assíncrono opcional (injete o mutex compartilhado do Shell) aplicado
   * APENAS à chamada `usage --json` dentro de `refresh()`. Se o caller também
   * embrulhar `refresh()` no mesmo lock, use um lock reentrante.
   */
  usageLock?: <T>(run: () => Promise<T>) => Promise<T>
}

export interface AiUsagebarService {
  state(): AiUsagebarServiceState
  snapshot(): AiUsagebarSnapshot
  refresh(): Promise<AiUsagebarSnapshot>
  vendors(): Promise<AiUsagebarVendor[]>
  /** EXPLÍCITO: pode habilitar vendors no config (upstream). Nunca automático. */
  detect(options?: { all?: boolean }): Promise<AiUsagebarDetectReport>
  setVendorEnabled(vendorId: string, enabled: boolean): Promise<AiUsagebarSnapshot>
  setSecretEnv(overlay: NodeJS.ProcessEnv | undefined): void
  setAccountConfig(provider: AiUsagebarAccountProvider | undefined): void
  ensureInstalled(): Promise<AiUsagebarSnapshot>
}

const NO_ENABLED_VENDOR_HINT =
  'Nenhum provedor habilitado no ai-usagebar. Use a detecção explícita ou habilite um provedor para ver o uso.'

function sameEnvOverlay(
  current: NodeJS.ProcessEnv | undefined,
  next: NodeJS.ProcessEnv | undefined
): boolean {
  if (current === undefined || next === undefined) return current === next
  const keys = Object.keys(current)
  if (keys.length !== Object.keys(next).length) return false
  return keys.every((key) => current[key] === next[key])
}

class AiUsagebarServiceController implements AiUsagebarService {
  private readonly paths: AiUsagebarPaths
  private readonly platform: NodeJS.Platform
  private readonly arch: NodeJS.Architecture
  private readonly fileSystem: AiUsagebarFileSystem
  private readonly download: AiUsagebarDownload
  private readonly expectedSha256: string
  private readonly expectedVersion: string
  private readonly now: () => number
  private readonly configLock: ConfigWriteLock

  private secretEnv: NodeJS.ProcessEnv | undefined
  private accountProvider: AiUsagebarAccountProvider | undefined
  private stateValue: AiUsagebarServiceState = 'unavailable'
  private message: string | undefined
  private version: string | undefined
  private vendorsCache: AiUsagebarVendor[] = []
  private catalogReloadRequested = true
  private catalogRevision = 0
  private reportCache: AiUsagebarReport | undefined
  private fetchedAt: string | undefined
  private stale = false
  private installed = false
  private inFlight: Promise<AiUsagebarSnapshot> | undefined
  private installInFlight: Promise<void> | undefined

  constructor(private readonly options: AiUsagebarServiceOptions) {
    this.paths = {
      ...resolveAiUsagebarPaths(options.userDataDir),
      ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
    }
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.fileSystem = options.fileSystem ?? nodeFileSystem
    this.download = options.download ?? defaultAiUsagebarDownload
    this.expectedSha256 = options.expectedSha256 ?? AI_USAGEBAR_WINDOWS_X64_SHA256
    this.expectedVersion = options.expectedVersion ?? AI_USAGEBAR_VERSION
    this.now = options.now ?? Date.now
    this.configLock = sharedConfigWriteLock
  }

  private client(configPath: string = this.paths.configPath): AiUsagebarClient {
    return new AiUsagebarClient({
      binaryPath: this.paths.binaryPath,
      configPath,
      ...(this.options.runner ? { runner: this.options.runner } : {}),
      ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
      envOverlay: () => this.secretEnv,
      accountConfig: () => this.accountProvider?.(),
    })
  }

  state(): AiUsagebarServiceState {
    return this.stateValue
  }

  snapshot(): AiUsagebarSnapshot {
    return {
      state: this.stateValue,
      vendors: [...this.vendorsCache],
      stale: this.stale,
      ...(this.version !== undefined ? { version: this.version } : {}),
      ...(this.reportCache !== undefined ? { report: this.reportCache } : {}),
      ...(this.fetchedAt !== undefined ? { fetchedAt: this.fetchedAt } : {}),
      ...(this.message !== undefined ? { message: this.message } : {}),
    }
  }

  /**
   * Overlay de segredos efetivo para os próximos comandos. Mudança efetiva
   * (chaves/valores) invalida o catálogo: `configured`/`enabled` refletem o
   * config+env usados de fato e precisam ser relidos no próximo refresh.
   */
  setSecretEnv(overlay: NodeJS.ProcessEnv | undefined): void {
    const next = overlay ? { ...overlay } : undefined
    if (sameEnvOverlay(this.secretEnv, next)) return
    this.secretEnv = next
    this.invalidateCatalog()
  }

  /** Troca do config ativo (por conta) também pode mudar o catálogo. */
  setAccountConfig(provider: AiUsagebarAccountProvider | undefined): void {
    if (provider === this.accountProvider) return
    this.accountProvider = provider
    this.invalidateCatalog()
  }

  private invalidateCatalog(): void {
    this.catalogReloadRequested = true
    this.catalogRevision += 1
  }

  private async activeConfigPath(): Promise<string> {
    if (!this.accountProvider) return this.paths.configPath
    try {
      const value = await this.accountProvider()
      const configPath = value && typeof value.configPath === 'string' ? value.configPath.trim() : ''
      return configPath || this.paths.configPath
    } catch {
      return this.paths.configPath
    }
  }

  /**
   * Relê o catálogo com o config/env correntes. Se uma invalidação ocorrer
   * durante a leitura (revision mudou), mantém o pedido de reload para o
   * próximo refresh não servir dados obsoletos.
   */
  private async loadCatalog(): Promise<AiUsagebarVendor[]> {
    const revision = this.catalogRevision
    const catalog = await this.client().vendors()
    this.vendorsCache = catalog.vendors
    if (revision === this.catalogRevision) this.catalogReloadRequested = false
    return [...this.vendorsCache]
  }

  /**
   * Primeiro uso: cria um config TOML válido (vazio, sem habilitar nada) de
   * forma ATÔMICA sob o userData. Nunca roda detect/enable implicitamente.
   */
  private async ensureConfigFile(): Promise<boolean> {
    if (await this.fileSystem.exists(this.paths.configPath)) return true
    try {
      await this.configLock.withConfigLock(this.paths.configPath, async () => {
        if (await this.fileSystem.exists(this.paths.configPath)) return
        await this.fileSystem.mkdir(this.paths.root)
        const temporary = `${this.paths.configPath}.tmp`
        await this.fileSystem.writeFile(temporary, AI_USAGEBAR_DEFAULT_CONFIG_CONTENT)
        await this.fileSystem.rename(temporary, this.paths.configPath)
      })
      return true
    } catch (error) {
      this.stateValue = 'unavailable'
      this.message = sanitizeAiUsagebarMessage(
        `Não foi possível criar o config do ai-usagebar (${this.paths.configPath}): ${error instanceof Error ? error.message : String(error)}`
      )
      return false
    }
  }

  private bundledCandidates(): string[] {
    const candidates: string[] = []
    if (this.options.bundledBinaryPath) candidates.push(this.options.bundledBinaryPath)
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath
    if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
      candidates.push(path.join(resourcesPath, 'ai-usagebar', 'ai-usagebar.exe'))
      candidates.push(path.join(resourcesPath, 'ai-usagebar.exe'))
    }
    return candidates
  }

  private async installFromBytes(bytes: Uint8Array): Promise<void> {
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (hash !== this.expectedSha256) {
      throw new Error('SHA-256 do ai-usagebar não confere; binário descartado.')
    }
    const temporary = `${this.paths.binaryPath}.download`
    await this.fileSystem.writeFile(temporary, bytes)
    await this.fileSystem.rename(temporary, this.paths.binaryPath)
  }

  /** Prefere o candidato empacotado SOMENTE com hash exato; senão baixa. */
  private async installBinary(): Promise<void> {
    await this.fileSystem.mkdir(this.paths.runtimeDir)
    for (const candidate of this.bundledCandidates()) {
      if (!(await this.fileSystem.exists(candidate))) continue
      try {
        const bytes = await this.fileSystem.readFileBytes(candidate)
        await this.installFromBytes(bytes)
        return
      } catch {
        // Candidato inválido/adulterado: tenta o próximo e cai no download.
      }
    }
    await this.downloadBinary()
  }

  private async downloadBinary(): Promise<void> {
    const target = `${this.paths.binaryPath}.download`
    await this.download(AI_USAGEBAR_WINDOWS_X64_URL, target, {
      timeoutMs: this.options.timeoutMs,
    })
    const bytes = await this.fileSystem.readFileBytes(target)
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (hash !== this.expectedSha256) {
      await this.fileSystem.rm(target)
      throw new Error('SHA-256 do ai-usagebar não confere; binário descartado.')
    }
    await this.fileSystem.rename(target, this.paths.binaryPath)
  }

  /**
   * Garante o binário instalado/verificado. O runtime do userData SÓ é
   * executado depois de o SHA-256 dos bytes bater com o pinado — um exe
   * adulterado que reporte a versão correta nunca é executado: é substituído
   * pelo candidato empacotado (hash exato) ou por download. Single-flight:
   * chamadas concorrentes compartilham a mesma instalação.
   */
  async ensureInstalled(): Promise<AiUsagebarSnapshot> {
    if (this.platform !== 'win32' || this.arch !== 'x64') {
      this.stateValue = 'unavailable'
      this.message = 'ai-usagebar pinado só está disponível para Windows x64.'
      return this.snapshot()
    }
    if (this.installed) {
      // A falha de uma consulta/configuração não invalida o binário já
      // verificado. Reabilita a próxima ação após erro/degradação, mantendo
      // `starting` intacto para bloquear operações concorrentes.
      if (this.stateValue === 'error' || this.stateValue === 'degraded') {
        this.stateValue = 'ready'
        this.message = undefined
      }
      return this.snapshot()
    }
    if (!this.installInFlight) {
      const tracked = this.doEnsureInstalled().finally(() => {
        if (this.installInFlight === tracked) this.installInFlight = undefined
      })
      this.installInFlight = tracked
    }
    await this.installInFlight
    return this.snapshot()
  }

  private async runtimeBinaryVerified(): Promise<boolean> {
    if (!(await this.fileSystem.exists(this.paths.binaryPath))) return false
    try {
      const bytes = await this.fileSystem.readFileBytes(this.paths.binaryPath)
      return createHash('sha256').update(bytes).digest('hex') === this.expectedSha256
    } catch {
      return false
    }
  }

  private async doEnsureInstalled(): Promise<void> {
    if (!(await this.ensureConfigFile())) return
    try {
      if (!(await this.runtimeBinaryVerified())) {
        this.stateValue = 'installing'
        this.message = undefined
        await this.installBinary()
      }
      const binaryVersion = await this.client().version()
      if (binaryVersion !== this.expectedVersion) {
        this.stateValue = 'error'
        this.message = sanitizeAiUsagebarMessage(
          `Versão do ai-usagebar ${binaryVersion ?? 'desconhecida'} difere da fixada ${this.expectedVersion}.`
        )
        return
      }
      this.version = binaryVersion
      this.installed = true
      this.stateValue = 'ready'
      this.message = undefined
    } catch (error) {
      this.stateValue = 'error'
      this.message = sanitizeAiUsagebarMessage(error)
    }
  }

  async vendors(): Promise<AiUsagebarVendor[]> {
    const installed = await this.ensureInstalled()
    if (installed.state !== 'ready') {
      throw new Error(installed.message ?? 'ai-usagebar indisponível.')
    }
    return await this.loadCatalog()
  }

  refresh(): Promise<AiUsagebarSnapshot> {
    if (this.inFlight) return this.inFlight
    const operation = this.doRefresh()
    this.inFlight = operation
    void operation.finally(() => {
      if (this.inFlight === operation) this.inFlight = undefined
    })
    return operation
  }

  private async doRefresh(): Promise<AiUsagebarSnapshot> {
    const installed = await this.ensureInstalled()
    if (installed.state !== 'ready') return this.snapshot()

    this.stateValue = 'starting'
    try {
      if (this.catalogReloadRequested || this.vendorsCache.length === 0) {
        await this.loadCatalog()
      }
      if (!this.vendorsCache.some((vendor) => vendor.enabled === true)) {
        // Primeiro uso (config vazio): catalogar sem habilitar nada. `usage`
        // upstream sairia ≠0 sem vendors habilitados; devolvemos o relatório
        // vazio válido + hint sanitizado e seguimos pronto.
        this.reportCache = { schema_version: AI_USAGEBAR_SUPPORTED_SCHEMA_VERSION, entries: [] }
        this.fetchedAt = new Date(this.now()).toISOString()
        this.stale = false
        this.stateValue = 'ready'
        this.message = NO_ENABLED_VENDOR_HINT
        return this.snapshot()
      }

      const runUsage = (): Promise<AiUsagebarReport> => this.client().usage()
      const report = this.options.usageLock
        ? await this.options.usageLock(runUsage)
        : await runUsage()
      this.reportCache = this.sanitizeEntryErrors(report)
      this.fetchedAt = new Date(this.now()).toISOString()
      this.stale = false
      this.stateValue = 'ready'
      this.message = undefined
    } catch (error) {
      // Fail-open: mantém o último relatório (stale) e segue degradado.
      this.stale = this.reportCache !== undefined
      this.stateValue = this.reportCache !== undefined ? 'degraded' : 'error'
      this.message = sanitizeAiUsagebarMessage(error)
    }
    return this.snapshot()
  }

  async detect(options: { all?: boolean } = {}): Promise<AiUsagebarDetectReport> {
    const installed = await this.ensureInstalled()
    if (installed.state !== 'ready') {
      throw new Error(installed.message ?? 'ai-usagebar indisponível.')
    }
    const configPath = await this.activeConfigPath()
    return await this.configLock.withConfigLock(configPath, async () => {
      const report = await this.client().detect({ all: options.all === true })
      try {
        await this.loadCatalog()
      } catch {
        this.vendorsCache = []
      }
      return report
    })
  }

  async setVendorEnabled(vendorId: string, enabled: boolean): Promise<AiUsagebarSnapshot> {
    const installed = await this.ensureInstalled()
    if (installed.state !== 'ready') return this.snapshot()

    const configPath = await this.activeConfigPath()
    try {
      await this.configLock.withConfigLock(configPath, async () => {
        let catalog = this.vendorsCache
        if (this.catalogReloadRequested || catalog.length === 0) {
          catalog = await this.loadCatalog()
        }
        if (!catalog.some((vendor) => vendor.id === vendorId)) {
          return
        }

        if (enabled) {
          await this.client().enableVendor(vendorId)
        } else {
          const content = await this.fileSystem.readFile(configPath)
          const updated = setVendorEnabledInConfig(content, vendorId, false)
          if (updated !== content) {
            const temporary = `${configPath}.tmp`
            await this.fileSystem.writeFile(temporary, updated)
            await this.fileSystem.rename(temporary, configPath)
          }
        }
      })

      let catalog = this.vendorsCache
      if (this.catalogReloadRequested || catalog.length === 0) {
        catalog = await this.loadCatalog()
      }
      if (!catalog.some((vendor) => vendor.id === vendorId)) {
        this.stateValue = 'degraded'
        this.message = `Provedor ${sanitizeAiUsagebarMessage(vendorId)} não consta no catálogo do ai-usagebar.`
        return this.snapshot()
      }
      await this.loadCatalog()
      this.stateValue = 'ready'
      this.message = undefined
    } catch (error) {
      this.stateValue = 'degraded'
      this.message = sanitizeAiUsagebarMessage(error)
    }
    return this.snapshot()
  }

  private sanitizeEntryErrors(report: AiUsagebarReport): AiUsagebarReport {
    if (!report.entries || report.entries.length === 0) return report
    return {
      ...report,
      entries: report.entries.map((entry) => {
        if (!entry.error) return entry
        return { ...entry, error: sanitizeAiUsagebarMessage(entry.error) }
      }),
    }
  }
}

export function createAiUsagebarService(options: AiUsagebarServiceOptions): AiUsagebarService {
  return new AiUsagebarServiceController(options)
}
