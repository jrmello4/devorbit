import electron, { type BrowserWindow as BrowserWindowType } from 'electron'
const { app, BrowserWindow, ipcMain } = electron
if (process.argv.includes('--disable-gpu')) app.disableHardwareAcceleration()
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createResultWaiter } from './agent-turn'
import {
  finalizeAiMemorySession,
  prepareAiMemoryLaunch,
  registerActiveAiMemorySession,
  setGlobalAiMemoryService,
} from './ai-memory-launcher'
import { createTerminalReadiness } from './terminal-readiness'
import { scanUsageAdapters, resolveUsageSourceDirs } from './usage-adapters'
import { createClaudeQuotaPoller, defaultClaudeCredentialsPath } from './claude-usage-quota'
import { createBridgeService, type BridgeCycleOutcome } from './bridge-service'
import { createHeadlessTurnRunner, drainHeadlessFinalizers, drainHeadlessRuns } from './bridge-headless'
import { getAgentProviderHealth, resolveAgentProviderWithFallback } from './agent-providers'
import { loadAiMemoryConfig, loadConfig, setAiMemoryProjectEnabled } from './config'
import { createAiMemoryService, type AiMemoryService } from './ai-memory-service'
import { AiMemoryBridgeSync, syncScopeOf } from './ai-memory-sync'
import { DEFAULT_AI_MEMORY_CONFIG, type AiMemoryScope } from '../shared/ai-memory-contract'
import { registerAiMemoryIpc } from './ipc/ai-memory-ipc'
import { createOrchestrationService } from './orchestration-service'
import { registerOrchestrationIpc } from './ipc/orchestration-ipc'
import { registerProjectIpc } from './ipc/project-ipc'
import { registerWorkspaceIpc } from './ipc/workspace-ipc'
import { registerTerminalIpc } from './ipc/terminal-ipc'
import { registerWebIpc } from './ipc/web-ipc'
import { registerConfigIpc } from './ipc/config-ipc'
import { registerObservabilityIpc } from './ipc/observability-ipc'
import { registerWindowIpc } from './ipc/window-ipc'
import { createOtlpExporter, readOtlpOptionsFromEnv } from './telemetry-otlp'
import type { AgentBridgeEvent } from '../shared/agent-bridge-event'
import { HITLManager, type HitlRequest } from './hitl'
import { AuditLedger } from './audit-ledger'
import { Telemetry } from './telemetry'
import { disposeProjectHybridMemory, setProjectHybridMemoryWriteGuard } from './project-hybrid-memory'
import { readMigrationReceiptState } from './ai-memory-migration'
import { detectGitCommonDir, detectRemoteUrl, deriveAiMemoryIdentity } from './ai-memory-scope'
import { EvolutionStore } from './evolution-store'
import { createUsageStore } from './usage-store'
import { onTerminalEvent, onTerminalStart, hasTerminal, stopAllTerminals, stopAllTerminalsAsync, writeTerminal, type TerminalEvent } from './terminal-session'
import { installPtyPipe } from './pty-pipe'
import { handleCompanionTerminalEvent, onCompanionEvent, unregisterAllCompanionTerminals, type CompanionSummary } from './companion'
import { disposeWebPanel, onWebPanelEvent } from './web-panel'
import { cancelAllMemoryCompactions, setLegacyMemoryWriteGuard } from './memory'
import { initializeUpdater } from './updater'
import { startShadowRoutingMetrics, stopShadowRoutingMetrics } from './shadow-routing-metrics'
import type { AgentProviderId, AppConfig, IpcInvokeChannel, IpcSendChannel } from '../renderer/src/types'
import {
  assertTrustedIpcSender,
  isPathWithinRoot,
  isTrustedRendererUrl,
  type IpcSenderLike,
} from './validation'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '../..')

export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
const PRODUCTION_RENDERER_URL = pathToFileURL(path.join(RENDERER_DIST, 'index.html')).href

process.env.VITE_PUBLIC = process.env.VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

let mainWindow: BrowserWindowType | null = null
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL)
const SMOKE_FLAG = '--devorbit-smoke'

function getCliArgValue(name: string): string | undefined {
  const prefix = `${name}=`
  const match = process.argv.find((arg) => arg.startsWith(prefix))
  return match ? match.slice(prefix.length) : undefined
}

const isSmokeRun = process.argv.includes(SMOKE_FLAG)
let smokeStartupError: string | null = null

if (isSmokeRun) {
  const smokeTemp = getCliArgValue('--devorbit-smoke-temp')
  const smokeUserData = getCliArgValue('--devorbit-smoke-userdata')
  if (
    !smokeTemp ||
    !smokeUserData ||
    !isPathWithinRoot(path.resolve(smokeUserData), path.resolve(smokeTemp))
  ) {
    smokeStartupError = 'userData de smoke fora do diretório temporário esperado'
  } else {
    try {
      app.setPath('userData', smokeUserData)
    } catch (error: any) {
      smokeStartupError = `falha ao definir userData de smoke: ${error?.message || error}`
    }
  }
}

const hasSingleInstanceLock = isSmokeRun ? true : app.requestSingleInstanceLock()
let terminalLifecycleGeneration = 0

function invalidateTerminalLifecycle(options: { stopTerminals?: boolean } = {}): void {
  terminalLifecycleGeneration += 1
  // Teardown derruba os PTYs sem evento de exit: fecha as sessões de uso aqui.
  endAllUsageSessions()
  if (options.stopTerminals !== false) stopAllTerminals()
  unregisterAllCompanionTerminals()
}

function assertTerminalLifecycle(generation: number): void {
  if (generation !== terminalLifecycleGeneration) {
    throw new Error('A janela do DevOrbit foi encerrada antes de iniciar o terminal.')
  }
}

function sendTerminalEvent(event: TerminalEvent): void {
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send('devorbit:terminalEvent', event)
}

function sendCompanionEvent(summary: CompanionSummary): void {
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send('devorbit:companionEvent', summary)
}

function sendAgentBridgeEvent(event: AgentBridgeEvent): void {
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send('devorbit:agentBridgeEvent', event)
}

function sanitizeHitlRequest(request: HitlRequest): HitlRequest {
  const prompt = request.prompt
    .replace(/Bearer\s+[A-Za-z0-9._-]+/giu, 'Bearer [REDACTED]')
    .replace(/(?:sk|key|token)[-_][A-Za-z0-9_-]{8,}/giu, '[REDACTED]')
    .slice(0, 500)
  const metadata = request.metadata
    ? Object.fromEntries(Object.entries(request.metadata).map(([key, value]) => [key, typeof value === 'string'
      ? value.replace(/(https?:\/\/)([^\s/@]+):([^\s/@]+)@/giu, '$1[REDACTED]@').slice(0, 300)
      : typeof value === 'number' || typeof value === 'boolean' ? value : String(value).slice(0, 300)]))
    : undefined
  return {
    id: request.id,
    prompt,
    state: request.state,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    ...(metadata ? { metadata } : {}),
    ...(request.decision ? { decision: request.decision } : {}),
  }
}

function sendHitlEvent(request: HitlRequest): void {
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send('devorbit:hitlEvent', sanitizeHitlRequest(request))
}

onTerminalEvent(sendTerminalEvent)
onTerminalEvent(handleCompanionTerminalEvent)
onCompanionEvent(sendCompanionEvent)
installPtyPipe({
  subscribe: onTerminalEvent,
  write: writeTerminal,
  exists: hasTerminal,
})

// Sessões de turno (provedor + modelo efetivos por terminal) para sendAgentTurn.
const turnSessions = new Map<string, { provider: AgentProviderId; model: string }>()
const waitTurnResult = createResultWaiter(onTerminalEvent)
// Prontidão central: cacheada por terminal, invalidada em todo restart de PTY.
const terminalReadiness = createTerminalReadiness(onTerminalEvent)
onTerminalStart((id) => terminalReadiness.invalidate(id))
const waitTerminalReady = terminalReadiness.waitReady
const hitlManager = new HITLManager({ onChange: sendHitlEvent })
const observabilityLedger = new AuditLedger(path.join(app.getPath('userData'), 'observability.jsonl'))
const evolutionStore = new EvolutionStore({ dataDirectory: path.join(app.getPath('userData'), 'evolution') })
const usageStore = createUsageStore({ directory: path.join(app.getPath('userData'), 'usage') })

// ai-memory (FASE 1): sidecar de propriedade do DevOrbit, opt-in por projeto.
// Desabilitado não inicia processo, não cria data dir nem escreve marker.
let aiMemoryService: AiMemoryService | null = null

async function initializeAiMemoryService(): Promise<AiMemoryService> {
  if (aiMemoryService) return aiMemoryService

  let config = DEFAULT_AI_MEMORY_CONFIG
  try {
    config = await loadAiMemoryConfig()
  } catch (error) {
    // A configuração corrompida não bloqueia o workspace. A instância fica
    // desabilitada e a UI poderá exibir/diagnosticar o erro ao tentar opt-in.
    console.warn('[DevOrbit ai-memory] configuração indisponível; iniciando desabilitado:', error)
  }

  aiMemoryService = createAiMemoryService({
    userDataDir: path.join(app.getPath('userData'), 'ai-memory'),
    resourcesPath: process.resourcesPath,
    config,
    getAppVersion: () => app.getVersion(),
  })
  // O launcher e a IPC usam a mesma instância gerenciada no processo principal.
  setGlobalAiMemoryService(aiMemoryService)
  return aiMemoryService
}

async function bootstrapAiMemory(): Promise<void> {
  try {
    if (quitCleanupStarted) return
    const service = await initializeAiMemoryService()
    if (quitCleanupStarted) return
    await service.start()
  } catch (error) {
    console.warn('[DevOrbit ai-memory] bootstrap falhou:', error)
  }
}

// Scanner dos adaptadores locais (Camada B — tokens reais de cada CLI) e o
// poller de quota do Claude. O poller é autolimitado (30 min mín. entre
// chamadas; 6h de cooldown após 429), então pode rodar junto do scan barato.
const claudeQuotaPoller = createClaudeQuotaPoller({
  credentialsPath: defaultClaudeCredentialsPath(os.homedir(), process.env),
})
usageStore.setUsageScanner(async (previous) => {
  const result = await scanUsageAdapters(resolveUsageSourceDirs(os.homedir(), process.env), previous)
  const claudeQuota = await claudeQuotaPoller.check()
  return claudeQuota ? { ...result, quota: [claudeQuota] } : result
})
// Varredura periódica barata (incremental e limitada); falhas são silenciosas.
const usageScanTimer = setInterval(() => {
  void usageStore.refreshNow().catch(() => undefined)
}, 60_000)
// Não segura o processo vivo: o mesmo padrão do providerReadinessTimer.
if (typeof usageScanTimer.unref === 'function') usageScanTimer.unref()

// Sessões de uso: terminais com provider (start → exit) para a duração.
const usageSessions = new Map<string, { provider: string; startedAt: number }>()

function beginUsageSession(terminalId: string, provider: string): void {
  const existing = usageSessions.get(terminalId)
  if (existing) {
    // Turno novo no mesmo terminal NÃO reinicia o relógio da sessão; só
    // corrige o provider se o nó mudou de executor no meio da sessão.
    existing.provider = provider
    return
  }
  usageSessions.set(terminalId, { provider, startedAt: Date.now() })
}

function endUsageSession(terminalId: string): void {
  const session = usageSessions.get(terminalId)
  if (!session) return
  usageSessions.delete(terminalId)
  void usageStore.recordUsageEvents([{
    kind: 'session',
    at: new Date().toISOString(),
    terminalId,
    provider: session.provider,
    durationMs: Math.max(0, Date.now() - session.startedAt),
  }]).catch(() => undefined)
}

/** Fecha todas as sessões pendentes (teardown mata os PTYs sem evento de exit). */
function endAllUsageSessions(): void {
  for (const terminalId of Array.from(usageSessions.keys())) endUsageSession(terminalId)
}

onTerminalEvent((event) => {
  if (event.type === 'exit') endUsageSession(event.id)
})

const otlpExporter = createOtlpExporter(readOtlpOptionsFromEnv())
const telemetry = new Telemetry({
  onSpanEnd: (span) => {
    void observabilityLedger.append({ type: 'telemetry.span', ...span })
    void otlpExporter.exportSpan(span)
  },
})

function rememberBridgeReflection(target: string, outcome: { status: string; summary: string }): void {
  void evolutionStore.recordAgentReflection({ target, status: outcome.status, summary: outcome.summary }, { metadata: { source: 'agent-bridge' } }).catch(() => undefined)
}

const headlessTurn = createHeadlessTurnRunner({
  resolveCommand: async (provider) => {
    const resolved = await resolveAgentProviderWithFallback(await loadConfig(), provider)
    return resolved.path
  },
  // Envólucro ai-memory (workstream único + sessão) para o turno headless.
  // Reusa o MESMO launcher do caminho interativo; `undefined` = execução direta
  // (opt-out/degradado), preservando o fallback gracioso.
  prepareMemoryLaunch: async (request) => {
    try {
      const plan = await prepareAiMemoryLaunch({
        provider: request.provider,
        resolvedCommand: request.commandPath,
        originalArgs: request.args,
        env: request.env,
        cwd: request.cwd,
        terminalId: request.executionId,
      })
      if (!plan.wrapped) return undefined
      if (plan.metadata) registerActiveAiMemorySession(plan.metadata)
      const terminalId = plan.metadata?.terminalId
      return {
        command: plan.command,
        args: plan.args,
        env: plan.env,
        cwd: plan.cwd,
        ...(terminalId
          ? { finalize: () => finalizeAiMemorySession({ terminalId }) }
          : {}),
      }
    } catch {
      return undefined
    }
  },
})

/**
 * Credenciais BYOK configuradas no app (inclui Gemini, usado pelo `agy`).
 * Só injeta o que existe para nunca apagar autenticação/perfis herdados de
 * `process.env`.
 */
function headlessProviderEnv(config: AppConfig): NodeJS.ProcessEnv {
  const routing = config.modelRouting
  const env: NodeJS.ProcessEnv = {}
  if (routing?.geminiApiKey) env.GEMINI_API_KEY = routing.geminiApiKey
  if (routing?.openaiApiKey) env.OPENAI_API_KEY = routing.openaiApiKey
  if (routing?.anthropicApiKey) env.ANTHROPIC_API_KEY = routing.anthropicApiKey
  return env
}

let bridgeEnv: () => NodeJS.ProcessEnv = () => ({})

/**
 * Sync ai-memory para outcomes do Bridge (FASE 3). Fire-and-forget: falha de
 * memória nunca quebra o Bridge. Escopo resolve uma vez por projectPath e é
 * cacheado; opt-in por projeto (isProjectEnabled) e serviço `running` gateiam
 * toda escrita. Sem serviço/opt-in, o Bridge segue sem persistência.
 */
/**
 * Identidade ai-memory determinística do projeto (cache por caminho) para os
 * guards read-only pós-migração. Falha de git/derivação lança — o guard
 * consumidor converte em estado 'uncertain' (fail-closed), nunca reabre
 * escrita legada.
 */
const legacyIdentityCache = new Map<string, string>()

async function legacyMemoryIdentity(projectPath: string): Promise<string> {
  const key = path.resolve(projectPath)
  const cached = legacyIdentityCache.get(key)
  if (cached !== undefined) return cached
  const [remoteUrl, gitCommonDir] = await Promise.all([
    detectRemoteUrl(projectPath),
    detectGitCommonDir(projectPath),
  ])
  const identity = deriveAiMemoryIdentity({ projectPath, ...(remoteUrl !== undefined ? { remoteUrl } : {}), ...(gitCommonDir !== undefined ? { gitCommonDir } : {}) }).identity
  legacyIdentityCache.set(key, identity)
  return identity
}

/**
 * Guard read-only pós-migração para os escritores legacy (memory.md e
 * memory.json). Receipt 'present' → true (read-only); 'absent' → false
 * (legado preservado); 'error' → LANÇA (fail-closed nos consumidores).
 */
async function isLegacyMemoryMigrated(projectPath: string): Promise<boolean> {
  // Gate funciona OFFLINE: lê a receipt local (não depende do sidecar).
  const identity = await legacyMemoryIdentity(projectPath)
  const state = await readMigrationReceiptState(app.getPath('userData'), identity)
  if (state.status === 'present') return true
  if (state.status === 'absent') return false
  throw new Error(`Receipt de migração ilegível: ${state.message}`)
}

// Ativação dos guards: ambos os escritores legados (.devorbit/memory.md e
// .devorbit/memory.json) passam a respeitar a receipt pós-migração. Sem
// receipt ('absent') o comportamento legado é preservado integralmente;
// erro real de I/O → fail-closed (consumidores mapeiam para 'uncertain').
setLegacyMemoryWriteGuard(isLegacyMemoryMigrated)
setProjectHybridMemoryWriteGuard(isLegacyMemoryMigrated)

const bridgeOutcomeSyncs = new Map<string, AiMemoryBridgeSync>()
const bridgeOutcomeScopes = new Map<string, AiMemoryScope>()
const pendingBridgeOutcomeWrites = new Set<Promise<void>>()

const AI_MEMORY_SHUTDOWN_DRAIN_TIMEOUT_MS = 6_000

async function rememberBridgeOutcome(outcome: BridgeCycleOutcome): Promise<void> {
  const service = aiMemoryService
  if (!service || service.status().state !== 'running' || !outcome.projectPath) return
  try {
    const cacheKey = outcome.projectPath
    let scope = bridgeOutcomeScopes.get(cacheKey)
    if (!scope) {
      scope = await service.resolveScope(outcome.projectPath)
      bridgeOutcomeScopes.set(cacheKey, scope)
    }
    if (!service.isProjectEnabled(scope.identity)) return
    const client = service.client()
    if (!client) return
    const storeKey = `${scope.workspace}/${scope.project}`
    let sync = bridgeOutcomeSyncs.get(storeKey)
    if (!sync) {
      sync = new AiMemoryBridgeSync(syncScopeOf(scope), client)
      bridgeOutcomeSyncs.set(storeKey, sync)
    }
    await sync.handle(outcome)
  } catch {
    // Memória nunca quebra o Bridge.
  }
}

function scheduleBridgeOutcomeWrite(outcome: BridgeCycleOutcome): void {
  const task: Promise<void> = rememberBridgeOutcome(outcome)
    .catch(() => undefined)
    .finally(() => {
      pendingBridgeOutcomeWrites.delete(task)
    })
  pendingBridgeOutcomeWrites.add(task)
}

async function drainBridgeOutcomeWrites(timeoutMs = AI_MEMORY_SHUTDOWN_DRAIN_TIMEOUT_MS): Promise<void> {
  const drain = async (): Promise<void> => {
    // Await outcomes still resolving project scope as well as writes already
    // queued in their per-project sync instance. Bridge shutdown prevents new
    // cycles; the loop also covers an outcome that was reported during PTY stop.
    for (;;) {
      while (pendingBridgeOutcomeWrites.size > 0) {
        await Promise.allSettled([...pendingBridgeOutcomeWrites])
      }
      const syncs = [...bridgeOutcomeSyncs.values()]
      await Promise.allSettled(syncs.map((sync) => sync.flush()))
      if (pendingBridgeOutcomeWrites.size === 0 && syncs.length === bridgeOutcomeSyncs.size) break
    }
  }

  let timer: NodeJS.Timeout | undefined
  const result = await Promise.race([
    drain().then(() => 'drained' as const, () => 'failed' as const),
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    }),
  ])
  if (timer) clearTimeout(timer)
  if (result !== 'drained') {
    console.warn(`[DevOrbit ai-memory] drain de resultados do Bridge não concluiu (${result}) em ${timeoutMs}ms.`)
  }
}

const bridgeService = createBridgeService({
  cliDirectory: app.isPackaged ? process.resourcesPath : (process.env.APP_ROOT || path.resolve(__dirname, '../..')),
  hasTerminal,
  writeTerminal,
  waitTurnResult,
  waitTerminalReady,
  onEvent: sendAgentBridgeEvent,
  onReflection: rememberBridgeReflection,
  onOutcome: (outcome) => {
    scheduleBridgeOutcomeWrite(outcome)
  },
  onGuard: (audit) => {
    void observabilityLedger.append({ type: 'delegation.guard', ...audit }).catch(() => undefined)
  },
  runHeadlessTurn: async (target, agent, input) => {
    const config = await loadConfig()
    return headlessTurn({
      provider: agent.provider,
      prompt: input.prompt,
      cwd: agent.projectPath,
      model: input.model ?? agent.model,
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      signal: input.signal,
      env: {
        ...headlessProviderEnv(config),
        ...bridgeEnv(),
        DEVORBIT_BRIDGE_ORIGIN: input.origin,
        DEVORBIT_BRIDGE_DEPTH: String(input.depth),
        DEVORBIT_BRIDGE_VISITED: JSON.stringify(input.visited),
      },
    })
  },
})
const agentBridgeRuntime = bridgeService.runtime
bridgeEnv = () => agentBridgeRuntime.env()

// Continuidade multi-provedor: estado/eleição no main; o renderer despacha.
const providerReadiness = new Map<AgentProviderId, boolean>()
let providerReadinessTimer: NodeJS.Timeout | null = null

function refreshProviderReadiness(): void {
  void loadConfig()
    .then((config) => getAgentProviderHealth(config, { useCache: true }))
    .then((health) => {
      for (const item of health) providerReadiness.set(item.id, item.state === 'ready')
    })
    .catch(() => undefined)
}

const orchestrationService = createOrchestrationService({
  onEvent: (event) => {
    const window = mainWindow
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send('devorbit:orchestrationEvent', event)
  },
  isProviderReady: (provider) => providerReadiness.get(provider) ?? true,
})

// O primeiro refresh acontece no app.whenReady, DEPOIS de createWindow(): o
// boot da janela não compete com o probing de PATH dos providers.
providerReadinessTimer = setInterval(refreshProviderReadiness, 60_000)
if (typeof providerReadinessTimer.unref === 'function') providerReadinessTimer.unref()

onWebPanelEvent((event) => {
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send('devorbit:webEvent', event)
})


function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    frame: false, // Frameless para controle visual total estilo Linear/Raycast
    show: true,
    backgroundColor: '#f4f5f7',
    title: 'DevOrbit',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const window = mainWindow
  window.on('close', () => {
    invalidateTerminalLifecycle()
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  mainWindow.show()
  mainWindow.focus()

  // The renderer is always local (file:// in production or the Vite origin in
  // development). Do not allow links or navigations to turn this privileged
  // window into a general-purpose remote page.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, PRODUCTION_RENDERER_URL)) event.preventDefault()
  })
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) invalidateTerminalLifecycle()
  })
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  mainWindow.webContents.on(
    'did-fail-load',
    (_event: any, code: any, desc: any, url: any) => {
      console.error('[Window Load Error]', code, desc, url)
    }
  )

  mainWindow.webContents.on('console-message', (_event: any, level: any, message: any, line: any, sourceId: any) => {
    console.log(`[Renderer Console Level ${level}] ${message} (${sourceId}:${line})`)
  })

  mainWindow.webContents.on('render-process-gone', (_event: any, details: any) => {
    console.error('[Renderer Gone]', details)
    invalidateTerminalLifecycle()
  })

  mainWindow.webContents.on('before-input-event', (_event: any, input: any) => {
    if (isDevelopment && input.key === 'F12') {
      mainWindow?.webContents.toggleDevTools()
    }
  })

  // Gerenciamento de eventos de janela
  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (isDevelopment && devServerUrl && isTrustedRendererUrl(devServerUrl, PRODUCTION_RENDERER_URL)) {
    mainWindow.loadURL(devServerUrl)
  } else {
    mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html')).catch((err: any) => {
      console.error('Failed to load file:', err)
    })
  }
}

async function verifyPackagedRenderer(target: BrowserWindowType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    target.webContents.once('did-finish-load', () => resolve())
    target.webContents.once(
      'did-fail-load',
      (_event: unknown, errorCode: number, description: string, url: string) => {
        reject(new Error(`falha ao carregar ${url}: ${description} (${errorCode})`))
      }
    )
    target.loadFile(path.join(RENDERER_DIST, 'index.html')).catch(reject)
  })

  const deadline = Date.now() + 20_000
  let state: { hasBridge: boolean; hasShell: boolean; hasFallback: boolean } | null = null
  while (Date.now() < deadline) {
    state = await target.webContents.executeJavaScript(
      `(() => ({
        hasBridge: typeof window.devorbit === 'object' && window.devorbit !== null,
        hasShell: Boolean(document.querySelector('.app-shell')),
        hasFallback: Boolean(document.querySelector('.renderer-fallback')),
      }))()`,
      true
    )
    if (state && state.hasBridge && (state.hasShell || state.hasFallback)) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  if (!state || !state.hasBridge) throw new Error('preload não expôs window.devorbit')
  if (!state.hasShell) {
    throw new Error(
      state.hasFallback
        ? 'renderer exibiu o estado de ponte ausente'
        : 'renderer não montou o workspace (.app-shell ausente)'
    )
  }

  const probe = await target.webContents.executeJavaScript(
    `window.devorbit.getConfig()
      .then((config) => ({ ok: true, hasProjectDirs: Array.isArray(config && config.projectDirs) }))
      .catch((error) => ({ ok: false, message: String((error && error.message) || error) }))`,
    true
  )
  if (!probe.ok) throw new Error(`invoke IPC falhou: ${probe.message}`)
  if (!probe.hasProjectDirs) throw new Error('getConfig retornou payload inesperado')
}

async function runPackagedSmokeTest(): Promise<void> {
  const smokeTemp = getCliArgValue('--devorbit-smoke-temp')
  const smokeResult = getCliArgValue('--devorbit-smoke-result')
  const smokeToken = getCliArgValue('--devorbit-smoke-token')
  const expectedVersion = getCliArgValue('--devorbit-smoke-version')
  const canWriteResult = Boolean(
    smokeTemp && smokeResult && isPathWithinRoot(path.resolve(smokeResult), path.resolve(smokeTemp))
  )

  const emit = async (
    success: boolean,
    error?: string,
    evidence?: Record<string, boolean>
  ): Promise<void> => {
    if (canWriteResult && smokeResult) {
      try {
        await fs.writeFile(
          smokeResult,
          JSON.stringify({
            kind: 'devorbit-packaged-smoke',
            success,
            version: app.getVersion(),
            token: smokeToken,
            error,
            ...evidence,
          }),
          'utf8'
        )
      } catch (error: any) {
        console.error('[smoke] falha ao gravar o marcador de resultado:', error?.message || error)
      }
    }
    console.log(`[smoke] ${success ? 'OK' : 'FALHA'}${error ? `: ${error}` : ''}`)
    app.exit(success ? 0 : 1)
  }

  if (smokeStartupError) return emit(false, smokeStartupError)
  if (!app.isPackaged) return emit(false, 'o modo smoke exige um aplicativo empacotado')
  if (!expectedVersion || !smokeToken) return emit(false, 'argumentos de smoke ausentes')
  if (!canWriteResult) {
    return emit(false, 'resultado de smoke fora do diretório temporário esperado')
  }
  if (app.getVersion() !== expectedVersion) {
    return emit(
      false,
      `versão empacotada ${app.getVersion()} diferente da esperada ${expectedVersion}`
    )
  }

  let smokeWindow: BrowserWindowType | null = null
  let timeoutHandle: NodeJS.Timeout | null = null
  try {
    await initializeAiMemoryService()
    setupIpcHandlers()

    smokeWindow = new BrowserWindow({
      show: false,
      width: 1024,
      height: 700,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })

    const timedOut = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('timeout aguardando o renderer empacotado')),
        30_000
      )
    })

    await Promise.race([timedOut, verifyPackagedRenderer(smokeWindow)])
    return await emit(true, undefined, { renderer: true, preload: true, ipc: true })
  } catch (error: any) {
    return await emit(false, `smoke falhou: ${error?.message || error}`)
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (smokeWindow && !smokeWindow.isDestroyed()) smokeWindow.destroy()
  }
}

if (isSmokeRun || hasSingleInstanceLock) {
  app.whenReady().then(() => {
    startShadowRoutingMetrics(app.getPath('userData'))
  })
}

if (isSmokeRun) {
  app.whenReady().then(() => {
    void runPackagedSmokeTest()
  })
} else if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    // Configuração local rápida; não aguarda download/saúde do sidecar para abrir a UI.
    await initializeAiMemoryService()
    setupIpcHandlers()
    agentBridgeRuntime.start()
    // Depois do bridge e da janela: o sidecar não atrasa o primeiro paint.
    void bootstrapAiMemory()
    createWindow()
    // Depois da janela: a prontidão dos providers não atrasa o primeiro paint.
    refreshProviderReadiness()
    initializeUpdater((state) => {
      const window = mainWindow
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
      window.webContents.send('devorbit:updateStatus', state)
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

let quitCleanupStarted = false
let quitCleanupFinished = false

app.on('before-quit', (event) => {
  // Electron não aguarda a Promise retornada por um listener async de before-quit.
  // Interrompe o primeiro quit e só o solicita novamente após o drain bounded.
  if (quitCleanupFinished) return
  event.preventDefault()
  if (quitCleanupStarted) return
  quitCleanupStarted = true

  void (async () => {
    clearInterval(usageScanTimer)
    orchestrationService.stop()
    if (providerReadinessTimer) {
      clearInterval(providerReadinessTimer)
      providerReadinessTimer = null
    }
    agentBridgeRuntime.stop()

    // Rejeita novos starts antes de encerrar os PTYs; cada stop inicia a
    // finalização ai-memory correspondente enquanto o sidecar ainda está vivo.
    invalidateTerminalLifecycle({ stopTerminals: false })
    const terminalShutdown = await stopAllTerminalsAsync({ timeoutMs: 3_000 })
    if (!terminalShutdown.completed) {
      console.warn(
        `[DevOrbit] ${terminalShutdown.stopped} terminal(is) encerrado(s), mas o drain de ai-memory atingiu o timeout.`
      )
    }
    // Runs headless ATIVOS: aborta a árvore e aguarda o child fechar (bounded).
    // É o fechamento que registra o finalizador Antigravity do run — e pode
    // EMITIR o Bridge outcome do run (child que concluiu durante o abort).
    const headlessRunsDrain = await drainHeadlessRuns({ timeoutMs: 3_000 })
    if (!headlessRunsDrain.drained) {
      console.warn(
        `[DevOrbit ai-memory] ${headlessRunsDrain.pending} run(s) headless ainda ativo(s) no drain de shutdown.`
      )
    }
    // Finalizadores headless (Antigravity): bounded, ANTES de parar o sidecar
    // (a página de handoff ainda precisa do servidor vivo).
    const headlessDrain = await drainHeadlessFinalizers({ timeoutMs: 3_000 })
    if (!headlessDrain.drained) {
      console.warn(
        `[DevOrbit ai-memory] ${headlessDrain.pending} finalizador(es) headless ainda pendente(s) no drain de shutdown.`
      )
    }
    // Bridge outcomes (incluindo os emitidos por runs que concluíram durante o
    // abort acima) por ÚLTIMO, imediatamente antes de parar o sidecar.
    await drainBridgeOutcomeWrites()
  })().catch((error) => {
    console.warn('[DevOrbit] Falha durante o encerramento ordenado:', error)
  }).finally(async () => {
    if (pendingBridgeOutcomeWrites.size > 0) {
      console.warn(
        `[DevOrbit ai-memory] ${pendingBridgeOutcomeWrites.size} resultado(s) do Bridge ainda pendente(s) ao parar o sidecar.`
      )
    }
    setGlobalAiMemoryService(null)
    try {
      await aiMemoryService?.stop()
    } catch (error) {
      console.warn('[DevOrbit ai-memory] falha ao parar o sidecar durante o encerramento:', error)
    }

    disposeWebPanel()
    cancelAllMemoryCompactions()
    const cleanupResults = await Promise.allSettled([
      stopShadowRoutingMetrics(),
      disposeProjectHybridMemory(),
      evolutionStore.disposeAsync(),
      usageStore.close(),
    ])
    for (const result of cleanupResults) {
      if (result.status === 'rejected') {
        console.warn('[DevOrbit] Falha ao finalizar um recurso durante o encerramento:', result.reason)
      }
    }
    quitCleanupFinished = true
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (isSmokeRun) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function registerIpcHandler(
  channel: IpcInvokeChannel,
  handler: (event: IpcSenderLike, ...args: any[]) => unknown,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedIpcSender(event, PRODUCTION_RENDERER_URL)
    const span = telemetry.startSpan(`ipc.${channel}`, { channel })
    try {
      const result = await handler(event, ...args)
      span.end({ status: 'ok' })
      return result
    } catch (error) {
      span.end({ status: 'error', error })
      throw error
    }
  })
}

function registerIpcListener(
  channel: IpcSendChannel,
  handler: (event: IpcSenderLike, ...args: any[]) => unknown,
): void {
  ipcMain.on(channel, (event, ...args) => {
    try {
      assertTrustedIpcSender(event, PRODUCTION_RENDERER_URL)
      void handler(event, ...args)
    } catch (error) {
      console.warn(`IPC bloqueado no canal ${channel}:`, error)
    }
  })
}

function setupIpcHandlers() {
  if (aiMemoryService) {
    registerAiMemoryIpc(registerIpcHandler, {
      service: aiMemoryService,
      // migrationReceiptPath acrescenta `ai-memory/migrations` a este root.
      userDataDir: app.getPath('userData'),
      loadAiMemoryConfig,
      setProjectEnabled: setAiMemoryProjectEnabled,
    })
  }

  registerProjectIpc(registerIpcHandler, {
    requestApproval: (input) => hitlManager.request(input),
    sendSyncProgress: (payload) => {
      mainWindow?.webContents.send('devorbit:syncProgress', payload)
    },
  })

  registerWorkspaceIpc(registerIpcHandler, {
    requestApproval: (input) => hitlManager.request(input),
  })

  registerTerminalIpc(registerIpcHandler, {
    getTerminalLifecycleGeneration: () => terminalLifecycleGeneration,
    assertTerminalLifecycle,
    bridgeEnv: () => agentBridgeRuntime.env(),
    registerBridgeAgent: (id, agent) => bridgeService.registerAgent(id, agent),
    cancelBridgeTarget: (id) => bridgeService.cancelTarget(id),
    turnSessions,
    waitTurnResult,
    waitTerminalReady,
    usage: {
      recordUsageEvents: (events) => usageStore.recordUsageEvents(events),
      beginUsageSession,
      endUsageSession,
    },
  })

  registerWebIpc(registerIpcHandler, { getWindow: () => mainWindow })

  registerConfigIpc(registerIpcHandler, {
    getWindow: () => mainWindow,
    sendCodexAuthProgress: (progress) => {
      mainWindow?.webContents.send('devorbit:codexAuthProgress', progress)
    },
    onRealUsage: (usage) => {
      void orchestrationService.reportCodexUsage(usage).catch(() => undefined)
    },
    usage: {
      recordUsageEvents: (events) => usageStore.recordUsageEvents(events),
    },
  })

  registerObservabilityIpc(registerIpcHandler, {
    evolutionStore,
    telemetry,
    hitl: hitlManager,
    sanitizeHitlRequest,
    usageStore,
  })

  registerOrchestrationIpc(registerIpcHandler, { service: orchestrationService })

  registerWindowIpc(registerIpcListener, { getWindow: () => mainWindow })
}
