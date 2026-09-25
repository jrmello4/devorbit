import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import {
  AI_MEMORY_DEFAULT_HOST,
  AI_MEMORY_DEFAULT_PORT,
  AI_MEMORY_MARKER_FILENAME,
  AI_MEMORY_MCP_PATH,
  AI_MEMORY_RELEASE_TAG,
  AI_MEMORY_REQUIRED_IGNORE_PATHS,
  AI_MEMORY_VERSION,
  AI_MEMORY_WINDOWS_X64_ASSET,
  AI_MEMORY_WINDOWS_X64_SHA256,
  type AiMemoryCapabilities,
  type AiMemoryConfig,
  type AiMemoryMarker,
  type AiMemoryMarkerWriteResult,
  type AiMemoryProjectConfig,
  type AiMemoryScope,
  type AiMemoryServiceState,
  type AiMemoryStatus,
} from '../shared/ai-memory-contract'
import {
  AiMemoryClient,
  AiMemoryError,
  parseAiMemoryVersion,
  type AiMemoryServerIdentity,
} from './ai-memory-client'
import { buildAiMemoryHelperEnv } from './ai-memory-process-env'
import {
  createAiMemoryJobContainment,
  type AiMemoryJobContainment,
} from './ai-memory-job'
import {
  detectGitCommonDir,
  detectGitTopLevel,
  detectRemoteUrl,
  nodeAiMemoryFileSystem,
  readAiMemoryMarker,
  renderAiMemoryMarker,
  resolveAiMemoryScope,
  writeAiMemoryMarker,
  type AiMemoryFileSystem,
  type AiMemoryGitRunner,
} from './ai-memory-scope'

export interface AiMemoryChildHandle {
  readonly pid?: number
  kill(): void
  /** Notifica o exit do filho para limpar o rastreamento sem vazar processo. */
  onExit?(listener: (code: number | null) => void): void
}

export type AiMemoryChildSpawner = (
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; windowsHide?: boolean }
) => AiMemoryChildHandle

export interface AiMemoryProcessResult {
  code: number | null
  stdout: string
  stderr: string
}

export type AiMemoryProcessRunner = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string; timeoutMs?: number }
) => Promise<AiMemoryProcessResult>

/**
 * Spawner padrão do processo filho do sidecar ai-memory.
 *
 * No Windows, o child PRÓPRIO é associado a um Job Object com
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (ver ai-memory-job.ts): crash/kill do
 * DevOrbit não deixa órfão. Se a FFI/Assign falhar, o fluxo é fail-open e a
 * limitação aparece no status; em Mac/Linux nada muda. Serviço externo/adotado
 * nunca é associado nem encerrado.
 */
const defaultChildSpawner: AiMemoryChildSpawner = (command, args, options) => {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    // Sidecar é helper: env mínimo (sem BYOK/tokens).
    env: buildAiMemoryHelperEnv({ overlay: options.env }),
    windowsHide: options.windowsHide ?? true,
    stdio: 'ignore',
  })
  return {
    ...(typeof child.pid === 'number' ? { pid: child.pid } : {}),
    kill: () => {
      try {
        child.kill()
      } catch {
        // Processo já encerrado.
      }
    },
    onExit: (listener) => {
      child.on('exit', (code) => listener(code))
    },
  }
}

const defaultProcessRunner: AiMemoryProcessRunner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      // git/where/powershell/--version: helper, env mínimo.
      env: buildAiMemoryHelperEnv(),
      windowsHide: true,
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        // Ignora.
      }
      reject(new AiMemoryError('ai-memory/timeout', `Timeout ao executar ${command}.`))
    }, options.timeoutMs ?? 15_000)
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })

/**
 * Invocação de extração no Windows. `Expand-Archive` é um cmdlet do
 * PowerShell: NUNCA pode ser passado ao `cmd.exe` (process.env.ComSpec).
 */
export function buildExpandArchiveInvocation(
  powershellPath: string,
  archivePath: string,
  destinationDir: string
): { command: string; args: string[] } {
  const escape = (value: string): string => value.replace(/'/g, "''")
  const script = `Expand-Archive -LiteralPath '${escape(archivePath)}' -DestinationPath '${escape(destinationDir)}' -Force`
  return {
    command: powershellPath,
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
  }
}

export interface AiMemoryServiceOptions {
  /** Diretório de runtime/cache do DevOrbit: `app.getPath('userData')/ai-memory`. */
  userDataDir: string
  resourcesPath?: string
  config: AiMemoryConfig
  /** Plataforma do host; injetável para teste. Default = process.platform. */
  platform?: NodeJS.Platform
  /** Arquitetura do host; injetável para teste. Default = process.arch. */
  arch?: NodeJS.Architecture
  host?: string
  port?: number
  binaryPath?: string
  fetchImpl?: typeof fetch
  fileSystem?: AiMemoryFileSystem
  processRunner?: AiMemoryProcessRunner
  childSpawner?: AiMemoryChildSpawner
  downloadImpl?: (
    url: string,
    destination: string,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ) => Promise<void>
  extractImpl?: (archivePath: string, destinationDir: string) => Promise<void>
  /** SHA-256 esperado do artefato; default = o valor fixado da v2.4.0. */
  expectedSha256?: string
  /** Executável PowerShell real usado no extract padrão (Windows). */
  powershellPath?: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  healthTimeoutMs?: number
  healthIntervalMs?: number
  /** Timeout para download do artefato zip (default = 60_000ms). */
  downloadTimeoutMs?: number
  /** Contenção do sidecar próprio (Job Object Windows); injetável em teste. */
  containment?: AiMemoryJobContainment
  /** Função para obter a versão do app em runtime (injetável para teste; default = Electron app.getVersion). */
  getAppVersion?: () => string
}

export interface AiMemoryEnsureMarkerResult {
  status: AiMemoryMarkerWriteResult['status'] | 'disabled'
  configured: boolean
  path?: string
  conflicts?: string[]
  missingFields?: string[]
}

export type AiMemoryMarkerOptOutStatus = 'removed' | 'absent' | 'conflict'

export interface AiMemoryMarkerOptOutResult {
  status: AiMemoryMarkerOptOutStatus
  path: string
  message?: string
}

export interface AiMemoryService {
  status(): AiMemoryStatus
  start(): Promise<AiMemoryStatus>
  /** Aplica nova config (opt-in/projetos) sem reiniciar o app. */
  reconfigure(config: AiMemoryConfig): Promise<AiMemoryStatus>
  stop(): Promise<void>
  dispose(): Promise<void>
  health(): Promise<{ ok: boolean; message?: string }>
  client(): AiMemoryClient | undefined
  resolveScope(projectPath: string): Promise<AiMemoryScope>
  ensureProjectMarker(projectPath: string): Promise<AiMemoryEnsureMarkerResult>
  /** Opt-out efetivo: remove SÓ o marker exatamente canônico do DevOrbit. */
  optOutProjectMarker(projectPath: string): Promise<AiMemoryMarkerOptOutResult>
  isProjectEnabled(identity: string): boolean
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Reconhece o ÚNICO erro tolerável antes da primeira sessão: o projeto ainda
 * não existe no ai-memory. Upstream v2.4.0 pina o código JSON-RPC
 * `INVALID_PARAMS` (-32602) e a mensagem
 * `project '<nome>' not found in workspace '<ws>'`
 * (crates/ai-memory-mcp/src/server.rs — `memory_status_reports_an_unknown_project_as_invalid_params`).
 * Leituras resolvem find-only; a criação oficial do projeto acontece no
 * primeiro WRITE (`memory_write_page`/`memory_handoff_begin`), que o DevOrbit
 * não faz implicitamente. Qualquer outra falha permanece fail-closed.
 */
function isProjectNotYetCreatedError(
  error: unknown,
  expected: { workspace: string; project: string }
): boolean {
  if (!(error instanceof AiMemoryError) || error.code !== 'ai-memory/protocol') return false
  // Ancorado ao formato exato produzido pelo client (`MCP ${code}: ${message}`):
  // `MCP -32602: project '<p>' not found in workspace '<w>'`. Os nomes ecoados
  // pelo servidor precisam coincidir EXATAMENTE com o escopo configurado —
  // project/workspace divergentes, texto extra ou qualquer variação seguem
  // fail-closed/degraded.
  const match = /^MCP -32602: project '([^']+)' not found in workspace '([^']+)'$/i.exec(error.message)
  if (!match) return false
  return match[1] === expected.project && match[2] === expected.workspace
}

class AiMemoryServiceController implements AiMemoryService {
  private readonly userDataDir: string
  private readonly containment: AiMemoryJobContainment
  private readonly resourcesPath: string | undefined
  private readonly platform: NodeJS.Platform
  private readonly arch: NodeJS.Architecture
  private config: AiMemoryConfig
  private readonly host: string
  private readonly port: number
  private readonly endpoint: string
  private readonly runtimeDir: string
  private readonly dataDir: string
  private readonly cacheDir: string
  private readonly configuredBinaryPath: string | undefined
  private readonly fetchImpl: typeof fetch | undefined
  private readonly fileSystem: AiMemoryFileSystem
  private readonly processRunner: AiMemoryProcessRunner
  private readonly childSpawner: AiMemoryChildSpawner
  private readonly downloadTimeoutMs: number
  private readonly downloadImpl: (
    url: string,
    destination: string,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ) => Promise<void>
  private readonly extractImpl: (archivePath: string, destinationDir: string) => Promise<void>
  private readonly expectedSha256: string
  private readonly powershellPath: string
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly healthTimeoutMs: number
  private readonly healthIntervalMs: number
  private readonly getAppVersion?: () => string

  private state: AiMemoryServiceState = 'unavailable'
  private owned = false
  private conflict = false
  private message: string | undefined
  private binaryPath: string | undefined
  private version: string | undefined
  private child: AiMemoryChildHandle | undefined
  private startPromise: Promise<AiMemoryStatus> | undefined
  /** Incrementa em todo stop(): um start em voo detecta que ficou obsoleto. */
  private lifecycleGeneration = 0
  private startAbortController: AbortController | undefined
  private lastIncompatibleCandidate: { candidate: string; version?: string; message?: string } | undefined

  constructor(options: AiMemoryServiceOptions) {
    this.userDataDir = options.userDataDir
    this.containment = options.containment ?? createAiMemoryJobContainment()
    this.resourcesPath = options.resourcesPath
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.config = options.config
    this.host = options.host ?? AI_MEMORY_DEFAULT_HOST
    this.port = options.port ?? AI_MEMORY_DEFAULT_PORT
    this.endpoint = `http://${this.host}:${this.port}${AI_MEMORY_MCP_PATH}`
    this.runtimeDir = path.join(this.userDataDir, 'runtime')
    this.dataDir = path.join(this.userDataDir, 'data')
    this.cacheDir = path.join(this.userDataDir, 'cache')
    this.configuredBinaryPath = options.binaryPath
    this.fetchImpl = options.fetchImpl
    this.fileSystem = options.fileSystem ?? nodeAiMemoryFileSystem
    this.processRunner = options.processRunner ?? defaultProcessRunner
    this.childSpawner = options.childSpawner ?? defaultChildSpawner
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? 60_000
    this.downloadImpl =
      options.downloadImpl ??
      ((url, destination, opts) => this.defaultDownload(url, destination, opts))
    this.extractImpl = options.extractImpl ?? ((archivePath, destinationDir) => this.defaultExtract(archivePath, destinationDir))
    this.expectedSha256 = options.expectedSha256 ?? AI_MEMORY_WINDOWS_X64_SHA256
    this.powershellPath = options.powershellPath ?? 'powershell.exe'
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? defaultSleep
    this.healthTimeoutMs = options.healthTimeoutMs ?? 20_000
    this.healthIntervalMs = options.healthIntervalMs ?? 250
    this.getAppVersion = options.getAppVersion
  }

  private abortInFlight(): void {
    if (this.startAbortController) {
      try {
        this.startAbortController.abort()
      } catch {
        // Ignora
      }
      this.startAbortController = undefined
    }
  }

  status(): AiMemoryStatus {
    const capabilities: AiMemoryCapabilities = {
      mcp: this.state === 'running',
      cli: Boolean(this.binaryPath),
    }
    return {
      state: this.state,
      owned: this.owned,
      ...(this.state === 'running' || this.state === 'degraded' ? { endpoint: this.endpoint } : {}),
      ...(this.version ? { version: this.version } : {}),
      ...(this.binaryPath ? { binaryPath: this.binaryPath } : {}),
      capabilities,
      ...(this.conflict ? { conflict: true } : {}),
      ...(this.message ? { message: this.message } : {}),
    }
  }

  async start(): Promise<AiMemoryStatus> {
    if (this.startPromise) return this.startPromise
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = undefined
    })
    return this.startPromise
  }

  /**
   * Aplica nova configuração (opt-in/projetos) sem reiniciar o app.
   * Invalida starts em voo e, ao desabilitar, encerra SOMENTE o filho próprio
   * (serviço externo nunca é morto).
   */
  async reconfigure(config: AiMemoryConfig): Promise<AiMemoryStatus> {
    // Projetos que estavam habilitados antes da troca: os que deixarem de
    // estar habilitados precisam de opt-out efetivo do marker.
    const previouslyEnabled = this.enabledProjectList()
    // Invalida qualquer start em voo e espera ele terminar (auto-aborta e
    // limpa o próprio filho) antes de decidir o novo estado.
    this.lifecycleGeneration += 1
    this.abortInFlight()
    this.config = config
    const pending = this.startPromise
    if (pending) {
      try {
        await pending
      } catch {
        // Start obsoleto: o estado já foi reavaliado abaixo.
      }
    }

    const nowEnabled = new Set(
      config.enabled ? Object.values(config.projects).filter((p) => p.enabled).map((p) => p.identity) : []
    )
    const optOutConflicts: string[] = []
    for (const project of previouslyEnabled) {
      if (nowEnabled.has(project.identity)) continue
      const result = await this.optOutProjectMarker(project.path)
      if (result.status === 'conflict') optOutConflicts.push(result.path)
    }
    const conflictNote =
      optOutConflicts.length > 0
        ? ` ${optOutConflicts.length} marker(s) preservado(s) por não serem exatamente gerenciados pelo DevOrbit: ${optOutConflicts.join(', ')}.`
        : ''

    if (!config.enabled || this.enabledProjectCount() === 0) {
      this.stopOwnChild()
      this.conflict = false
      this.lastIncompatibleCandidate = undefined
      this.state = 'unavailable'
      this.message =
        (config.enabled ? 'ai-memory sem projetos habilitados.' : 'ai-memory desabilitado (opt-in por projeto).') +
        conflictNote
      return this.status()
    }

    if (this.state === 'running' || this.state === 'degraded') {
      const verification = await this.verifyEnabledScopes()
      if (verification) {
        this.conflict = verification.conflict
        this.state = 'degraded'
        this.message = this.withContainmentNote(verification.message + conflictNote)
      } else {
        this.conflict = false
        this.state = 'running'
        this.message =
          (this.owned
            ? this.withContainmentNote('ai-memory em execução (processo próprio do DevOrbit).')
            : 'Serviço ai-memory externo detectado; o DevOrbit não o controla.') + conflictNote
      }
      return this.status()
    }

    return this.start()
  }

  async stop(): Promise<void> {
    // Invalida qualquer start em voo antes de derrubar o filho.
    this.lifecycleGeneration += 1
    this.abortInFlight()
    try {
      this.stopOwnChild()
    } finally {
      // Mesmo se kill() lançar, o status não pode ficar stale como running/owned.
      this.conflict = false
      this.lastIncompatibleCandidate = undefined
      this.state = 'unavailable'
      this.message = 'Serviço ai-memory parado.'
    }
  }

  async dispose(): Promise<void> {
    await this.stop()
  }

  /**
   * Reflete outage após o serviço estar rodando: degrada com mensagem
   * acionável, sem derrubar processos (fail-graceful) e sem matar serviço
   * externo. Recuperação volta o estado para `running`.
   */
  async health(): Promise<{ ok: boolean; message?: string }> {
    if (this.state !== 'running' && this.state !== 'degraded') {
      return { ok: false, message: this.message ?? 'ai-memory não está em execução.' }
    }
    if (this.state === 'degraded' && this.conflict) {
      // Conflito de identidade/escopo: não conversar com servidor estranho.
      return { ok: false, ...(this.message ? { message: this.message } : {}) }
    }
    const result = await this.buildClient().health()
    if (result.ok) {
      if (this.state === 'degraded') {
        this.conflict = false
        this.state = 'running'
        this.message = this.owned
          ? this.withContainmentNote('ai-memory em execução (processo próprio do DevOrbit).')
          : 'Serviço ai-memory externo detectado; o DevOrbit não o controla.'
      }
      return { ok: true }
    }
    this.conflict = false
    this.state = 'degraded'
    this.message = this.withContainmentNote(
      `ai-memory sem resposta em ${this.endpoint}: ${result.message ?? 'endpoint indisponível'}. O workspace continua funcionando; a memória compartilhada está indisponível.`
    )
    return { ok: false, message: this.message }
  }

  private buildClient(): AiMemoryClient {
    return new AiMemoryClient({
      endpoint: this.endpoint,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      appVersion: this.getAppVersion?.() ?? 'unknown',
    })
  }

  client(): AiMemoryClient | undefined {
    if (this.state !== 'running') return undefined
    return this.buildClient()
  }

  private gitRunner(): AiMemoryGitRunner {
    return async (args, cwd) => {
      const result = await this.processRunner('git', args, { cwd, timeoutMs: 8_000 })
      if (result.code !== 0) throw new Error(result.stderr || 'git falhou.')
      return { stdout: result.stdout }
    }
  }

  /** Roots de worktree registrados no repositório (sem varredura global). */
  private async listWorktreeRoots(projectPath: string, runner: AiMemoryGitRunner): Promise<string[]> {
    try {
      const { stdout } = await runner(['worktree', 'list', '--porcelain'], projectPath)
      const roots = new Set<string>()
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.startsWith('worktree ')) continue
        const value = line.slice('worktree '.length).trim()
        if (value) roots.add(path.resolve(value))
      }
      return [...roots]
    } catch {
      return []
    }
  }

  async resolveScope(projectPath: string): Promise<AiMemoryScope> {
    const gitRunner = this.gitRunner()
    // A raiz do checkout/worktree é resolvida ANTES de ler o marker: um
    // subdiretório de entrada precisa enxergar o `.ai-memory.toml` do root.
    const [remoteUrl, gitCommonDir, gitTopLevel] = await Promise.all([
      detectRemoteUrl(projectPath, gitRunner),
      detectGitCommonDir(projectPath, gitRunner),
      detectGitTopLevel(projectPath, gitRunner),
    ])
    const markerRoot = gitTopLevel ?? projectPath
    const marker = (await readAiMemoryMarker(markerRoot, { fs: this.fileSystem })).marker
    return resolveAiMemoryScope({ projectPath, remoteUrl, gitCommonDir, gitTopLevel, marker })
  }

  isProjectEnabled(identity: string): boolean {
    return this.config.enabled && this.config.projects[identity]?.enabled === true
  }

  async ensureProjectMarker(projectPath: string): Promise<AiMemoryEnsureMarkerResult> {
    const scope = await this.resolveScope(projectPath)
    if (!this.isProjectEnabled(scope.identity)) return { status: 'disabled', configured: false }
    const marker: AiMemoryMarker = {
      workspace: scope.workspace,
      project: scope.project,
      projectStrategy: 'repo-root',
      briefing: { injectOnSessionStart: true, maxChars: 4_000 },
      ignorePaths: [...AI_MEMORY_REQUIRED_IGNORE_PATHS],
    }
    return writeAiMemoryMarker(scope.root, marker, { fs: this.fileSystem })
  }

  private enabledProjectCount(): number {
    return Object.values(this.config.projects).filter((project) => project.enabled).length
  }

  private enabledProjectList(): AiMemoryProjectConfig[] {
    if (!this.config.enabled) return []
    return Object.values(this.config.projects).filter((project) => project.enabled)
  }

  private markerCanonical(scope: AiMemoryScope): string {
    return renderAiMemoryMarker({
      workspace: scope.workspace,
      project: scope.project,
      projectStrategy: 'repo-root',
      briefing: { injectOnSessionStart: true, maxChars: 4_000 },
      ignorePaths: [...AI_MEMORY_REQUIRED_IGNORE_PATHS],
    })
  }

  /** Remove o marker de UM root somente se for byte-a-byte o canônico. */
  private async optOutMarkerAtRoot(root: string, canonical: string): Promise<AiMemoryMarkerOptOutResult> {
    const markerPath = path.join(path.resolve(root), AI_MEMORY_MARKER_FILENAME)
    const existing = await readAiMemoryMarker(root, { fs: this.fileSystem })
    if (!existing.exists || existing.raw === undefined) return { status: 'absent', path: markerPath }
    if (existing.raw !== canonical) {
      return {
        status: 'conflict',
        path: markerPath,
        message:
          'Marker não é exatamente o gerenciado pelo DevOrbit (de terceiros ou com alterações). ' +
          'Preservado intacto; ajuste ou remova manualmente para concluir o opt-out.',
      }
    }
    await this.fileSystem.rm(markerPath, { force: true })
    return { status: 'removed', path: markerPath }
  }

  /**
   * Opt-out efetivo do projeto. Como a identidade é o `git-common-dir`, o
   * marker canônico pode existir em VÁRIOS worktrees do mesmo checkout
   * (ex.: habilitado em A, primeira sessão em B). Removemos o marker canônico
   * em todos os roots registrados desse repositório (`git worktree list
   * --porcelain`, sem varredura global) mais o root do path informado.
   * Marker de terceiros ou com extras é preservado intacto e reportado.
   */
  async optOutProjectMarker(projectPath: string): Promise<AiMemoryMarkerOptOutResult> {
    const runner = this.gitRunner()
    const scope = await this.resolveScope(projectPath)
    const canonical = this.markerCanonical(scope)
    const roots = new Set<string>([path.resolve(scope.root)])
    const commonDir = await detectGitCommonDir(projectPath, runner)
    if (commonDir) {
      for (const root of await this.listWorktreeRoots(projectPath, runner)) roots.add(root)
    }

    const conflicts: string[] = []
    let removedPath: string | undefined
    for (const root of roots) {
      const result = await this.optOutMarkerAtRoot(root, canonical)
      if (result.status === 'conflict') conflicts.push(result.path)
      else if (result.status === 'removed' && removedPath === undefined) removedPath = result.path
    }

    if (conflicts.length > 0) {
      return {
        status: 'conflict',
        path: conflicts[0],
        message:
          `Marker não é exatamente o gerenciado pelo DevOrbit em ${conflicts.length} worktree(s): ${conflicts.join(', ')}. ` +
          'Preservado(s) intacto(s); ajuste ou remova manualmente para concluir o opt-out.',
      }
    }
    if (removedPath) return { status: 'removed', path: removedPath }
    return { status: 'absent', path: path.join(path.resolve(scope.root), AI_MEMORY_MARKER_FILENAME) }
  }

  private isStale(generation: number): boolean {
    return generation !== this.lifecycleGeneration
  }

  private async doStart(): Promise<AiMemoryStatus> {
    if (!this.config.enabled || this.enabledProjectCount() === 0) {
      this.state = 'unavailable'
      this.owned = false
      this.conflict = false
      this.message = 'ai-memory desabilitado (opt-in por projeto).'
      return this.status()
    }
    const generation = ++this.lifecycleGeneration
    this.abortInFlight()
    const abortController = new AbortController()
    this.startAbortController = abortController

    this.state = 'starting'
    this.conflict = false
    this.message = 'Iniciando ai-memory...'

    try {
      const external = await this.probeIdentity()
      if (this.isStale(generation)) return this.status()
      if (external.reachable) {
        this.owned = false
        if (external.compatible) {
          this.version = external.version
          this.state = 'running'
          this.message = 'Serviço ai-memory externo detectado; o DevOrbit não o controla.'
          const verification = await this.verifyEnabledScopes()
          if (verification) {
            this.conflict = verification.conflict
            this.state = 'degraded'
            this.message = verification.message
          }
        } else {
          // Algo ocupa a porta, mas não é um ai-memory compatível: conflito.
          this.conflict = true
          this.state = 'degraded'
          this.message = external.message ?? 'Servidor no endpoint não é um ai-memory compatível.'
        }
        return this.status()
      }

      let binary = await this.findBinary()
      if (!binary) {
        // A instalação automática é pinada para o asset Windows x64. Fora de
        // win32/x64 degrada graciosamente sem baixar artefato inútil —
        // binários configurados/PATH continuam aceitos em qualquer arch acima.
        if (this.platform !== 'win32' || this.arch !== 'x64') {
          if (this.lastIncompatibleCandidate?.message) {
            this.state = 'error'
            this.message = `${this.lastIncompatibleCandidate.message} A instalação automática só é suportada no Windows x64 (host atual: ${this.platform}/${this.arch}). Instale a versão compatível ${AI_MEMORY_VERSION} manualmente.`
            return this.status()
          }
          this.state = 'degraded'
          this.message =
            `Binário ai-memory compatível não encontrado e a instalação automática só é suportada no Windows x64 ` +
            `(host atual: ${this.platform}/${this.arch}). Instale no PATH ou configure o caminho do binário; ` +
            'a memória fica indisponível.'
          return this.status()
        }
        try {
          binary = await this.installPinned()
        } catch (installError) {
          if (this.lastIncompatibleCandidate?.message) {
            this.state = 'error'
            this.message = `${this.lastIncompatibleCandidate.message} Falha ao instalar versão pinada: ${installError instanceof Error ? installError.message : String(installError)}`
            return this.status()
          }
          throw installError
        }
      }
      if (this.isStale(generation)) return this.status()
      const check = await this.verifyVersion(binary)
      if (this.isStale(generation)) return this.status()
      this.version = check.version
      if (!check.ok) {
        this.state = 'error'
        this.message = check.message ?? 'Versão do ai-memory inválida.'
        return this.status()
      }
      this.binaryPath = binary
      await this.fileSystem.mkdir(this.dataDir, { recursive: true })
      if (this.isStale(generation)) return this.status()
      const spawnedAtMs = this.now()
      const child = this.spawnChild(binary)
      // Contenção Windows-only do sidecar PRÓPRIO (serviço externo nunca passa
      // por aqui): job por child com KILL_ON_JOB_CLOSE; falha é fail-open.
      this.containOwnedChild(child, binary, spawnedAtMs)
      const healthy = await this.waitForHealth(generation)
      if (this.isStale(generation)) {
        // stop() durante o start: encerra SOMENTE o filho deste start.
        if (this.child === child) this.stopOwnChild()
        return this.status()
      }
      if (!healthy) {
        this.stopOwnChild()
        this.state = 'degraded'
        this.message = this.withContainmentNote('Binário validado, mas o ai-memory não respondeu no prazo.')
        return this.status()
      }

      // P2 #4: Guarda contra corrida pós-probe: se o filho próprio encerrou durante a subida
      // (ex.: colisão de porta/concorrência) mas o endpoint está saudável por uma
      // instância externa compatível, adotamos como serviço externo (owned=false).
      if (this.child !== child || !this.child) {
        this.owned = false
        this.state = 'running'
        this.message = 'Serviço ai-memory externo detectado; o DevOrbit não o controla.'
      } else {
        this.owned = true
        this.state = 'running'
        this.message = this.withContainmentNote('ai-memory em execução (processo próprio do DevOrbit).')
      }

      const verification = await this.verifyEnabledScopes()
      if (verification) {
        this.conflict = verification.conflict
        this.state = 'degraded'
        this.message = this.owned ? this.withContainmentNote(verification.message) : verification.message
      }
      return this.status()
    } catch (error) {
      this.stopOwnChild()
      if (this.isStale(generation)) return this.status()
      this.state = 'error'
      this.message = error instanceof Error ? error.message : String(error)
      return this.status()
    } finally {
      if (this.startAbortController === abortController) {
        this.startAbortController = undefined
      }
    }
  }

  private stopOwnChild(): void {
    const child = this.child
    this.child = undefined
    this.owned = false
    try {
      if (child) child.kill()
    } finally {
      // Fecha o handle do Job Object do sidecar (KILL_ON_JOB_CLOSE) mesmo se
      // kill() lançar; a rejeição do kill é propagada ao caller. Nunca afeta
      // serviço externo/adotado: o job só existe se um child PRÓPRIO foi
      // associado.
      this.containment.release()
    }
  }

  /** Associa APENAS o child que o DevOrbit spawnou; falha nunca lança. */
  private containOwnedChild(child: AiMemoryChildHandle, imagePath: string, spawnedAtMs: number): void {
    if (this.child !== child) return
    try {
      this.containment.contain(child.pid ?? Number.NaN, { imagePath, spawnedAtMs })
    } catch {
      // Fail-open: sidecar segue sem contenção; limitação é reportada no status.
    }
  }

  private withContainmentNote(message: string): string {
    const limitation = this.containment.status().limitation
    return limitation ? `${message} Contenção de processo indisponível: ${limitation}` : message
  }

  private spawnChild(binary: string): AiMemoryChildHandle {
    const args = [
      'serve',
      '--transport',
      'http',
      '--bind',
      `${this.host}:${this.port}`,
      '--data-dir',
      this.dataDir,
    ]
    const handle = this.childSpawner(binary, args, { windowsHide: true })
    this.child = handle
    handle.onExit?.(() => {
      // Geração antiga: nunca toca no job de um child novo.
      if (this.child !== handle) return
      this.child = undefined
      // Libera o job EXATAMENTE uma vez, só para este handle; idempotente.
      this.containment.release()
      if (this.owned && this.state === 'running') {
        this.owned = false
        this.state = 'degraded'
        this.message = this.withContainmentNote('O processo ai-memory encerrou inesperadamente.')
      }
    })
    return handle
  }

  private async waitForHealth(generation: number): Promise<boolean> {
    const deadline = this.now() + this.healthTimeoutMs
    while (this.now() < deadline) {
      if (this.isStale(generation)) return false
      const identity = await this.probeIdentity()
      if (identity.reachable && identity.compatible) return true
      // Servidor estranho na porta: não insistir nem declarar saudável.
      if (identity.reachable && !identity.compatible) return false
      await this.sleep(this.healthIntervalMs)
    }
    return false
  }

  private async probeIdentity(): Promise<AiMemoryServerIdentity> {
    return this.buildClient().serverIdentity()
  }

  /**
   * Verifica o escopo esperado dos projetos habilitados, FAIL-CLOSED.
   *
   * Nenhuma falha é engolida: escopo ausente/malformado/divergente e falha de
   * chamada viram `degraded` com mensagem acionável. `conflict` marca o caso
   * em que o servidor respondeu com escopo errado/malformado; falha de
   * chamada é `degraded` sem `conflict`.
   */
  private async verifyEnabledScopes(): Promise<{ message: string; conflict: boolean } | undefined> {
    const client = this.buildClient()
    for (const project of Object.values(this.config.projects)) {
      if (!project.enabled) continue
      const label = `${project.workspace}/${project.project}`
      try {
        const result = await client.verifyScope({
          workspace: project.workspace,
          project: project.project,
        })
        if (!result.ok) {
          return {
            conflict: true,
            message: `ai-memory não verificado para ${label}: ${result.message ?? 'escopo divergente.'} Confirme o marker do projeto e o servidor em 127.0.0.1:49374.`,
          }
        }
      } catch (error) {
        // Projeto novo/ainda vazio: permitido ANTES da primeira sessão. O
        // primeiro `ai-memory run`/hook cria o projeto. Só este sinal é
        // tolerado; escopo divergente/malformado e demais falhas seguem
        // fail-closed abaixo.
        if (isProjectNotYetCreatedError(error, project)) continue
        const detail = error instanceof Error ? error.message : String(error)
        return {
          conflict: false,
          message: `ai-memory não verificado para ${label}: falha ao consultar memory_status (${detail}). Verifique se o servidor está saudável e se o projeto existe no ai-memory.`,
        }
      }
    }
    return undefined
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await this.fileSystem.access(filePath)
      return true
    } catch {
      return false
    }
  }

  private async findBinary(): Promise<string | undefined> {
    this.lastIncompatibleCandidate = undefined
    const candidates: string[] = []
    if (this.configuredBinaryPath) candidates.push(this.configuredBinaryPath)
    const executable = this.platform === 'win32' ? 'ai-memory.exe' : 'ai-memory'
    candidates.push(path.join(this.runtimeDir, executable))
    if (executable !== 'ai-memory.exe') {
      candidates.push(path.join(this.runtimeDir, 'ai-memory.exe'))
    }
    if (this.resourcesPath) {
      candidates.push(path.join(this.resourcesPath, 'ai-memory', executable))
      candidates.push(path.join(this.resourcesPath, executable))
      if (executable !== 'ai-memory.exe') {
        candidates.push(path.join(this.resourcesPath, 'ai-memory', 'ai-memory.exe'))
        candidates.push(path.join(this.resourcesPath, 'ai-memory.exe'))
      }
    }
    for (const candidate of candidates) {
      if (await this.exists(candidate)) {
        const check = await this.verifyVersion(candidate)
        if (check.ok) return candidate
        this.lastIncompatibleCandidate = { candidate, version: check.version, message: check.message }
      }
    }
    const fromPath = await this.findOnPath()
    if (fromPath) {
      const check = await this.verifyVersion(fromPath)
      if (check.ok) return fromPath
      this.lastIncompatibleCandidate = { candidate: fromPath, version: check.version, message: check.message }
    }
    return undefined
  }

  private async findOnPath(): Promise<string | undefined> {
    try {
      const executable = this.platform === 'win32' ? 'ai-memory.exe' : 'ai-memory'
      const locator = this.platform === 'win32' ? 'where' : 'which'
      const result = await this.processRunner(locator, [executable], { timeoutMs: 5_000 })
      if (result.code !== 0) return undefined
      const first = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)[0]
      if (!first) return undefined
      return (await this.exists(first)) ? first : undefined
    } catch {
      return undefined
    }
  }

  private async verifyVersion(
    binary: string
  ): Promise<{ ok: boolean; version?: string; message?: string }> {
    const result = await this.processRunner(binary, ['--version'], { timeoutMs: 8_000 })
    if (result.code !== 0) {
      return { ok: false, message: result.stderr || 'Falha ao executar ai-memory --version.' }
    }
    const version = parseAiMemoryVersion(result.stdout || result.stderr)
    if (!version) return { ok: false, message: 'Versão do ai-memory não reconhecida.' }
    if (version !== AI_MEMORY_VERSION) {
      return {
        ok: false,
        version,
        message: `Versão ${version} diferente da fixada ${AI_MEMORY_VERSION}.`,
      }
    }
    return { ok: true, version }
  }

  private async installPinned(): Promise<string> {
    const archivePath = path.join(this.cacheDir, AI_MEMORY_WINDOWS_X64_ASSET)
    const url = `https://github.com/akitaonrails/ai-memory/releases/download/${AI_MEMORY_RELEASE_TAG}/${AI_MEMORY_WINDOWS_X64_ASSET}`
    await this.downloadImpl(url, archivePath, {
      signal: this.startAbortController?.signal,
      timeoutMs: this.downloadTimeoutMs,
    })
    const buffer = await this.fileSystem.readFile(archivePath)
    const hash = createHash('sha256').update(buffer).digest('hex')
    if (hash !== this.expectedSha256) {
      try {
        await this.fileSystem.rm(archivePath, { force: true })
      } catch {
        // Ignora erro de remoção de zip corrompido
      }
      throw new AiMemoryError(
        'ai-memory/integrity',
        `SHA-256 do zip não confere (${hash}).`
      )
    }
    await this.fileSystem.mkdir(this.runtimeDir, { recursive: true })
    await this.extractImpl(archivePath, this.runtimeDir)
    const installed = path.join(this.runtimeDir, 'ai-memory.exe')
    if (!(await this.exists(installed))) {
      throw new AiMemoryError('ai-memory/integrity', 'ai-memory.exe ausente no artefato extraído.')
    }
    return installed
  }

  private async defaultDownload(
    url: string,
    destination: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<void> {
    const fetchImpl = this.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      throw new AiMemoryError('ai-memory/transport', 'fetch indisponível para baixar o ai-memory.')
    }
    const timeoutMs = options.timeoutMs ?? this.downloadTimeoutMs
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

    const externalSignal = options.signal
    const onExternalAbort = (): void => {
      controller.abort()
    }
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timer)
        throw new AiMemoryError('ai-memory/transport', 'Download cancelado.')
      }
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }

    try {
      const response = await fetchImpl(url, { signal: controller.signal })
      if (!response.ok) {
        throw new AiMemoryError('ai-memory/transport', `Download HTTP ${response.status}.`)
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      await this.fileSystem.mkdir(path.dirname(destination), { recursive: true })
      await this.fileSystem.writeFile(destination, buffer)
    } catch (error) {
      if (externalSignal?.aborted) {
        throw new AiMemoryError('ai-memory/transport', 'Download cancelado.')
      }
      if (timedOut) {
        throw new AiMemoryError('ai-memory/timeout', `Timeout no download do ai-memory (${timeoutMs}ms).`)
      }
      if (error instanceof AiMemoryError) throw error
      throw new AiMemoryError('ai-memory/transport', error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort)
      }
    }
  }

  private async defaultExtract(archivePath: string, destinationDir: string): Promise<void> {
    // PowerShell REAL: cmd.exe não entende `Expand-Archive` nem os flags abaixo.
    const invocation = buildExpandArchiveInvocation(this.powershellPath, archivePath, destinationDir)
    const result = await this.processRunner(invocation.command, invocation.args, {
      timeoutMs: 120_000,
    })
    if (result.code !== 0) {
      throw new AiMemoryError(
        'ai-memory/integrity',
        result.stderr || 'Falha ao extrair o artefato do ai-memory.'
      )
    }
  }
}

export function createAiMemoryService(options: AiMemoryServiceOptions): AiMemoryService {
  return new AiMemoryServiceController(options)
}
