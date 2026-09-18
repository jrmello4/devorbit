import { TURN_READY_QUIET_MS, TURN_READY_TIMEOUT_MS, createTerminalReadyWaiter, type TerminalReadyOptions } from './agent-turn'
import type { TerminalEvent } from './terminal-session'

export interface TerminalReadiness {
  waitReady: (id: string, options?: TerminalReadyOptions) => Promise<void>
  invalidate: (id: string) => void
  isReady: (id: string) => boolean
}

/**
 * Cache de prontidão por terminal sobre o mesmo barramento de eventos do PTY.
 *
 * - Um terminal que já ficou quieto desde a última saída é considerado pronto
 *   e não paga a janela de quietude de novo (sem +12s em terminal já pronto).
 * - `invalidate` é chamado em todo start de PTY (mesmo id reiniciado) e em
 *   exit/erro: reiniciar a sessão volta a exigir prontidão.
 * - O timeout continua sendo melhor esforço: nunca pior que escrever já.
 */
export function createTerminalReadiness(
  subscribe: (listener: (event: TerminalEvent) => void) => () => void,
  options: TerminalReadyOptions = {},
): TerminalReadiness {
  const quietMs = Math.max(100, options.quietMs ?? TURN_READY_QUIET_MS)
  const timeoutMs = Math.max(quietMs, options.timeoutMs ?? TURN_READY_TIMEOUT_MS)
  const lastOutputAt = new Map<string, number>()
  const ready = new Set<string>()
  const settle = createTerminalReadyWaiter(subscribe)

  subscribe((event) => {
    if (event.type === 'data') {
      lastOutputAt.set(event.id, Date.now())
      return
    }
    if (event.type === 'exit' || event.type === 'error') {
      ready.delete(event.id)
      lastOutputAt.delete(event.id)
    }
  })

  const invalidate = (id: string): void => {
    ready.delete(id)
    lastOutputAt.delete(id)
  }

  const waitReady = async (id: string, waitOptions?: TerminalReadyOptions): Promise<void> => {
    if (ready.has(id)) return
    const lastOutput = lastOutputAt.get(id)
    if (lastOutput !== undefined && Date.now() - lastOutput >= quietMs) {
      ready.add(id)
      return
    }
    await settle(id, { quietMs, timeoutMs, ...waitOptions })
    ready.add(id)
  }

  return {
    waitReady,
    invalidate,
    isReady: (id) => ready.has(id),
  }
}
