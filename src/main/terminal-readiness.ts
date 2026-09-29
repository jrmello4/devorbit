import {
  TURN_READY_QUIET_MS,
  TURN_READY_TIMEOUT_MS,
  createTerminalReadyWaiter,
  type TerminalReadyOptions,
  type TerminalReadyResult,
} from './agent-turn'
import type { TerminalEvent } from './terminal-session'

export interface TerminalReadiness {
  waitReady: (id: string, options?: TerminalReadyOptions) => Promise<TerminalReadyResult>
  invalidate: (id: string) => void
  isReady: (id: string) => boolean
}

/**
 * Cache de prontidão por terminal sobre o mesmo barramento de eventos do PTY.
 *
 * - PRONTO É UM ESTADO QUE EXPIRA: qualquer evento `data` remove o id do cache
 *   (a TUI pode ter entrado em streaming/logo depois do boot). Só resolução
 *   por quietude (ou exit, para CLIs que terminam) marca pronto.
 * - Timeout NÃO marca pronto: `timedOut: true` volta sem cachear, e a próxima
 *   espera recomeça do zero — nunca "pronto" apostando contra o boot da TUI.
 * - `since` ancora a prontidão no turno: pronto exige
 *   `Date.now() - max(lastOutput, since) >= quietMs`. Sessão idle reutilizada
 *   resolve pelo cache (sem latência); spawn novo exige silêncio pós-boot;
 *   TUI ocupada espera o silêncio real.
 * - `invalidate` é chamado em todo start de PTY (mesmo id reiniciado) e em
 *   exit/erro: reiniciar a sessão volta a exigir prontidão.
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
      // Saída nova = prontidão expirada (streaming/boot em andamento).
      ready.delete(event.id)
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

  const waitReady = async (id: string, waitOptions?: TerminalReadyOptions): Promise<TerminalReadyResult> => {
    const effectiveQuietMs = Math.max(100, waitOptions?.quietMs ?? quietMs)
    const since = waitOptions?.since
    if (ready.has(id)) return { timedOut: false }
    // Pronto só se o silêncio cobre o mais recente entre a última saída e a
    // âncora do turno. Sem NENHUMA evidência (sem saída registrada e sem
    // `since`), não há âncora: a espera volta a exigir a primeira saída — uma
    // TUI lenta nunca é declarada pronta só porque ainda não desenhou nada.
    const lastOutput = lastOutputAt.get(id)
    const anchor = lastOutput !== undefined || since !== undefined
      ? Math.max(lastOutput ?? 0, since ?? 0)
      : undefined
    if (anchor !== undefined && Date.now() - anchor >= effectiveQuietMs) {
      ready.add(id)
      return { timedOut: false }
    }
    const result = await settle(id, {
      quietMs: effectiveQuietMs,
      timeoutMs: Math.max(effectiveQuietMs, waitOptions?.timeoutMs ?? timeoutMs),
      ...(since !== undefined ? { since } : {}),
    })
    // Timeout NÃO cacheia: pronto é resolvido por quietude ou exit apenas.
    if (!result.timedOut) ready.add(id)
    return result
  }

  return {
    waitReady,
    invalidate,
    isReady: (id) => ready.has(id),
  }
}
