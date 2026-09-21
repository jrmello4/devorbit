import electron, { type BrowserWindow as BrowserWindowType } from 'electron'
const { app, BrowserWindow, ipcMain } = electron
if (process.argv.includes('--disable-gpu')) app.disableHardwareAcceleration()
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createResultWaiter } from './agent-turn'
import { createTerminalReadiness } from './terminal-readiness'
import { scanUsageAdapters, resolveUsageSourceDirs } from './usage-adapters'
import { createClaudeQuotaPoller, defaultClaudeCredentialsPath } from './claude-usage-quota'
import { createBridgeService } from './bridge-service'
import { createHeadlessTurnRunner } from './bridge-headless'
import { getAgentProviderHealth, resolveAgentProviderWithFallback } from './agent-providers'
import { loadConfig } from './config'
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
import { disposeProjectHybridMemory } from './project-hybrid-memory'
import { EvolutionStore } from './evolution-store'
import { createUsageStore } from './usage-store'
import { onTerminalEvent, onTerminalStart, hasTerminal, stopAllTerminals, writeTerminal, type TerminalEvent } from './terminal-session'
import { installPtyPipe } from './pty-pipe'
import { handleCompanionTerminalEvent, onCompanionEvent, unregisterAllCompanionTerminals, type CompanionSummary } from './companion'
import { disposeWebPanel, onWebPanelEvent } from './web-panel'
import { cancelAllMemoryCompactions } from './memory'
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

function invalidateTerminalLifecycle(): void {
  terminalLifecycleGeneration += 1
  // Teardown derruba os PTYs sem evento de exit: fecha as sessões de uso aqui.
  endAllUsageSessions()
  stopAllTerminals()
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

const bridgeService = createBridgeService({
  cliDirectory: app.isPackaged ? process.resourcesPath : (process.env.APP_ROOT || path.resolve(__dirname, '../..')),
  hasTerminal,
  writeTerminal,
  waitTurnResult,
  waitTerminalReady,
  onEvent: sendAgentBridgeEvent,
  onReflection: rememberBridgeReflection,
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
    .then((config) => getAgentProviderHealth(config))
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

refreshProviderReadiness()
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
    setupIpcHandlers()
    agentBridgeRuntime.start()
    createWindow()
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

app.on('before-quit', () => {
  clearInterval(usageScanTimer)
  void stopShadowRoutingMetrics()
  orchestrationService.stop()
  if (providerReadinessTimer) {
    clearInterval(providerReadinessTimer)
    providerReadinessTimer = null
  }
  agentBridgeRuntime.stop()
  invalidateTerminalLifecycle()
  disposeWebPanel()
  cancelAllMemoryCompactions()
  void disposeProjectHybridMemory()
  void evolutionStore.disposeAsync()
  void usageStore.close()
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
