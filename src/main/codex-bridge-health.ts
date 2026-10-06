import {
  CODEX_BRIDGE_MESSAGES,
  type CodexBridgeErrorCode,
  type CodexBridgeHealth,
} from '../shared/codex-bridge-health'

interface LaunchHealth {
  view: CodexBridgeHealth
  sessionId: string
  timer?: ReturnType<typeof setTimeout>
  /**
   * Expectativa de start do PRÓPRIO PTY do launch gerenciado: armarada por
   * configure/connecting e consumida por onTerminalStart. Start genérico sem
   * esta expectativa encerra a saúde antiga do terminal.
   */
  pendingManagedStart?: boolean
}

/** Handshakes belong to one launch, never just to a reusable terminal id. */
export class CodexBridgeHealthStore {
  private readonly launches = new Map<string, LaunchHealth>()
  private readonly listeners = new Set<(health: CodexBridgeHealth) => void>()

  constructor(
    private readonly publish: (health: CodexBridgeHealth) => void = () => undefined,
    private readonly startupTimeoutMs = 20_000,
  ) {}

  private emit(launch: LaunchHealth): void {
    launch.view.updatedAt = Date.now()
    const snapshot = { ...launch.view }
    try {
      this.publish(snapshot)
    } catch {
      // Consumidor quebrado (renderer destruído no teardown) nunca interrompe
      // o handshake nem o estado do launch.
    }
    for (const listener of this.listeners) {
      try {
        listener({ ...snapshot })
      } catch {
        // Um listener com defeito não derruba os demais nem o fluxo atual.
      }
    }
  }

  configure(terminalId: string, launchId: string, sessionId: string): void {
    this.stop(terminalId)
    const launch: LaunchHealth = {
      sessionId,
      pendingManagedStart: true,
      view: { terminalId, launchId, state: 'configuring', agentCount: 0, updatedAt: Date.now(), message: 'Configurando MCP DevOrbit.' },
    }
    this.launches.set(terminalId, launch)
    this.emit(launch)
  }

  connecting(terminalId: string, launchId: string): void {
    const launch = this.launches.get(terminalId)
    if (!launch || launch.view.launchId !== launchId || launch.view.connectedAt) return
    // failed/stopped nunca voltam a connecting por aqui: um launch anterior
    // morto não revive; um novo launch passa por configure() primeiro.
    if (launch.view.state === 'failed' || launch.view.state === 'stopped') return
    launch.pendingManagedStart = true
    launch.view.state = 'connecting'
    launch.view.message = 'Aguardando confirmação do MCP DevOrbit.'
    clearTimeout(launch.timer)
    launch.timer = setTimeout(() => this.fail(terminalId, 'MCP_STARTUP_FAILED', launchId), this.startupTimeoutMs)
    launch.timer.unref?.()
    this.emit(launch)
  }

  handshake(input: { terminalId: string; launchId: string; sessionId: string; pid: number; connectedAt: number }): boolean {
    const launch = this.launches.get(input.terminalId)
    if (!launch || launch.view.launchId !== input.launchId || launch.sessionId !== input.sessionId) return false
    if (launch.view.state === 'stopped' || launch.view.state === 'failed') return false
    // Nonce por launch: o handshake é de uso único; um replay do mesmo
    // launch nunca reconfigura a sessão confirmada.
    if (launch.view.connectedAt !== undefined) return false
    clearTimeout(launch.timer)
    launch.view.state = 'connected'
    launch.view.connectedAt = input.connectedAt
    launch.view.mcpPid = input.pid
    launch.view.message = 'MCP DevOrbit conectado à Agent Bridge.'
    delete launch.view.code
    this.emit(launch)
    return true
  }

  registryChanged(agentCount: number): void
  registryChanged(readyAgentIds: readonly string[]): void
  registryChanged(callerTerminalId: string, readyAgentIds: readonly string[]): void
  registryChanged(agentCountOrReadyIds: number | string | readonly string[], readyAgentIds?: readonly string[]): void {
    const callerTerminalId = typeof agentCountOrReadyIds === 'string' ? agentCountOrReadyIds : undefined
    const numericCount = typeof agentCountOrReadyIds === 'number' ? Math.max(0, agentCountOrReadyIds) : undefined
    const readyIds = typeof agentCountOrReadyIds === 'number' ? undefined :
      (typeof agentCountOrReadyIds === 'string' ? readyAgentIds : agentCountOrReadyIds)
    for (const launch of this.launches.values()) {
      if (callerTerminalId !== undefined && launch.view.terminalId !== callerTerminalId) continue
      if (launch.view.state !== 'connected' && launch.view.state !== 'agents_available') continue
      const count = numericCount ?? (readyIds?.filter((id) => id !== launch.view.terminalId).length ?? 0)
      if (launch.view.agentCount === count && launch.view.state === (count ? 'agents_available' : 'connected') && (count > 0 || launch.view.code === 'NO_AGENTS_REGISTERED')) continue
      launch.view.agentCount = count
      launch.view.state = count ? 'agents_available' : 'connected'
      launch.view.message = count ? `Agent Bridge conectada; ${count} agente(s) disponível(is).` : CODEX_BRIDGE_MESSAGES.NO_AGENTS_REGISTERED
      if (count) delete launch.view.code
      else launch.view.code = 'NO_AGENTS_REGISTERED'
      this.emit(launch)
    }
  }

  fail(terminalId: string, code: CodexBridgeErrorCode, launchId?: string): void {
    const launch = this.launches.get(terminalId)
    if (!launch || (launchId !== undefined && launch.view.launchId !== launchId) || launch.view.state === 'stopped') return
    clearTimeout(launch.timer)
    delete launch.pendingManagedStart
    launch.view.state = 'failed'
    launch.view.code = code
    launch.view.message = CODEX_BRIDGE_MESSAGES[code]
    this.emit(launch)
  }

  stop(terminalId: string): void {
    const launch = this.launches.get(terminalId)
    if (!launch) return
    clearTimeout(launch.timer)
    delete launch.pendingManagedStart
    launch.view.state = 'stopped'
    launch.view.agentCount = 0
    // Código pertence ao launch anterior; stopped limpa para um reopen não
    // herdar falha/sessão velha no reject de waiters pendentes.
    delete launch.view.code
    launch.view.message = 'Comunicação encerrada.'
    this.emit(launch)
  }

  /**
   * Consumo da expectativa de start do launch gerenciado. onTerminalStart só
   * preserva a saúde quando o start pertence ao launch recém-configurado/
   * conectando; qualquer outro start (genérico) encerra a saúde anterior.
   */
  consumeManagedStart(terminalId: string): boolean {
    const launch = this.launches.get(terminalId)
    if (!launch || !launch.pendingManagedStart) return false
    delete launch.pendingManagedStart
    return true
  }

  get(terminalId: string): CodexBridgeHealth | undefined {
    const view = this.launches.get(terminalId)?.view
    return view ? { ...view } : undefined
  }

  /** True only for the currently accepted, live launch of this terminal. */
  isCurrentLaunch(terminalId: string, launchId: string): boolean {
    const view = this.launches.get(terminalId)?.view
    return view?.launchId === launchId && (view.state === 'connected' || view.state === 'agents_available')
  }

  assertReady(terminalId: string): void {
    const view = this.get(terminalId)
    if (view?.state === 'agents_available') return
    const code = view?.code ?? 'MCP_STARTUP_FAILED'
    throw Object.assign(new Error(CODEX_BRIDGE_MESSAGES[code]), { code })
  }

  waitReady(terminalId: string): Promise<CodexBridgeHealth> {
    return this.waitFor(terminalId, true)
  }

  waitConnected(terminalId: string): Promise<CodexBridgeHealth> {
    return this.waitFor(terminalId, false)
  }

  private waitFor(terminalId: string, requireAgents: boolean): Promise<CodexBridgeHealth> {
    const expected = this.get(terminalId)
    if (!expected) return Promise.reject(Object.assign(new Error(CODEX_BRIDGE_MESSAGES.MCP_CONFIGURATION_MISSING), { code: 'MCP_CONFIGURATION_MISSING' }))
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        this.listeners.delete(inspect)
      }
      const inspect = (view: CodexBridgeHealth): void => {
        if (view.terminalId !== terminalId) return
        if (view.launchId !== expected.launchId || view.state === 'failed' || view.state === 'stopped') {
          cleanup()
          const code = view.code ?? 'MCP_STARTUP_FAILED'
          reject(Object.assign(new Error(CODEX_BRIDGE_MESSAGES[code]), { code }))
        } else if (view.state === 'agents_available' || (!requireAgents && view.state === 'connected')) {
          cleanup()
          resolve(view)
        }
      }
      const timer = setTimeout(() => {
        cleanup()
        const code = this.get(terminalId)?.state === 'connected' ? 'NO_AGENTS_REGISTERED' : 'MCP_STARTUP_FAILED'
        reject(Object.assign(new Error(CODEX_BRIDGE_MESSAGES[code]), { code }))
      }, this.startupTimeoutMs)
      this.listeners.add(inspect)
      inspect(expected)
    })
  }

  dispose(): void {
    for (const id of this.launches.keys()) this.stop(id)
    this.launches.clear()
    this.listeners.clear()
  }
}
