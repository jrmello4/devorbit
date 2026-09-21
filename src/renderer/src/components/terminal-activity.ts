/**
 * Monitor de atividade de Smart Terminals (puro — sem DOM/xterm).
 *
 * Converte o fluxo bruto de eventos do PTY (data/exit/error) em um estado
 * pequeno e legível para o chip do cartão. Os limiares são injetáveis para
 * testes determinísticos: os testes passam timestamps explícitos, sem fake
 * timers.
 */

export type TerminalActivityState =
  | 'starting'
  | 'running'
  | 'waiting'
  | 'attention'
  | 'exited'
  | 'failed'
  | 'idle'

/** Rótulos pt-BR; o texto (não a cor) carrega o estado — regra do DESIGN.md. */
export const TERMINAL_ACTIVITY_LABELS: Record<TerminalActivityState, string> = {
  starting: 'Iniciando',
  running: 'Executando',
  waiting: 'Aguardando entrada',
  attention: 'Atenção',
  exited: 'Concluído',
  failed: 'Falhou',
  idle: 'Parado',
}

export interface TerminalActivityEvent {
  type: 'data' | 'exit' | 'error'
  /** Código de saída; null/undefined quando desconhecido (tratado como falha). */
  code?: number | null
  /** Timestamp do evento; ausente = agora (Date.now()). */
  at?: number
}

export interface TerminalActivityMonitorOptions {
  /** Saída mais recente que isto (ms) conta como execução ativa. */
  activeWindowMs?: number
  /** Silêncio além da janela ativa até este limite (ms) = aguardando entrada. */
  quietMs?: number
}

const DEFAULT_ACTIVE_WINDOW_MS = 2_000
const DEFAULT_QUIET_MS = 20_000

export interface TerminalActivityMonitor {
  push: (event: TerminalActivityEvent) => void
  snapshot: (now?: number) => TerminalActivityState
  reset: () => void
}

export function createTerminalActivityMonitor(
  options?: TerminalActivityMonitorOptions,
): TerminalActivityMonitor {
  const activeWindowMs = options?.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS
  const quietMs = options?.quietMs ?? DEFAULT_QUIET_MS
  let lastDataAt: number | null = null
  let attention = false
  let exitState: 'exited' | 'failed' | null = null

  return {
    push(event) {
      const at = event.at ?? Date.now()
      if (exitState) return
      if (event.type === 'data') {
        lastDataAt = at
        attention = false
        return
      }
      if (event.type === 'error') {
        attention = true
        return
      }
      exitState = event.code === 0 ? 'exited' : 'failed'
    },
    snapshot(now = Date.now()) {
      if (exitState) return exitState
      if (attention) return 'attention'
      if (lastDataAt === null) return 'starting'
      const sinceData = now - lastDataAt
      if (sinceData <= activeWindowMs) return 'running'
      if (sinceData <= quietMs) return 'waiting'
      return 'idle'
    },
    reset() {
      lastDataAt = null
      attention = false
      exitState = null
    },
  }
}
