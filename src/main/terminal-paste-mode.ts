import type { TerminalEvent } from './terminal-session'

/**
 * Capability dinâmica de BRACKETED PASTE (DECSET 2004) por terminal.
 *
 * TUIs de agentes (Codex/OpenCode/Claude) anunciam a capability no barramento
 * PTY com ANSI cru embutido no `data`:
 *   - `\x1b[?2004h` → bracketed paste HABILITADO (a TUI trata um bloco
 *     `ESC[200~ … ESC[201~` como UM paste e não executa nenhuma linha antes
 *     do Enter final — resolve multiline prematuro no prompt);
 *   - `\x1b[?2004l` → DESABILITADO (paste bruto de novo).
 *
 * Este módulo SUBSCREVE no barramento (mesmo contrato de
 * `onTerminalEvent`), varre cada chunk cru com `indexOf`/`lastIndexOf`
 * (O(1) por evento, sem parse de ANSI) e mantém estado em memória por
 * terminal id.
 *
 * Memória: NÃO acumula buffer de saída. Por chunk, mantém apenas a cauda de
 * até `PASTE_MODE_CARRY_CHARS` caracteres (o maior prefixo possível de uma
 * sequência partida entre dois chunks do PTY — node-pty/coalescer fatiam em
 * pontos arbitrários). `exit`/`error`/`reset` limpam o estado do terminal.
 *
 * Heurística deliberada: a DETECÇÃO é fiel (sequência explícita da TUI), mas
 * quem CONSOME a capability decide a política — `sendAgentInstruction` usa
 * `isBracketedPasteEnabled` para escolher entre paste embrulhado e verbatim.
 */
export const BRACKETED_PASTE_START = '\x1b[200~'
export const BRACKETED_PASTE_END = '\x1b[201~'

/** Sequência DECSET que habilita o bracketed paste na TUI. */
const PASTE_ENABLE_SEQUENCE = '\x1b[?2004h'
/** Sequência DECSET que desabilita o bracketed paste na TUI. */
const PASTE_DISABLE_SEQUENCE = '\x1b[?2004l'

/**
 * Cauda carregada entre chunks: `max(len(enable), len(disable)) - 1`.
 * Bounded por construção — um chunk novo nunca reprocessa uma sequência já
 * contada (a cauda é menor que a sequência completa).
 */
const PASTE_MODE_CARRY_CHARS = Math.max(PASTE_ENABLE_SEQUENCE.length, PASTE_DISABLE_SEQUENCE.length) - 1

export interface TerminalPasteMode {
  /** true se a TUI deste terminal anunciou `ESC[?2004h` e ainda não anunciou `?2004l`. */
  isBracketedPasteEnabled: (id: string) => boolean
  /** Limpa o estado do terminal (restart/stop manual; exit/error já limpam sozinhos). */
  reset: (id: string) => void
}

/**
 * Fábrica pura: recebe a função de subscrição do barramento (injetável para
 * testes) e devolve o observador de capability. Uma instância por processo é
 * suficiente — o estado é indexado por terminal id.
 *
 * `shouldTrack` delimita QUAIS terminais são observados: em terminal de shell
 * o usuário pode `cat`/`type` um arquivo contendo os bytes ESC[?2004h/l, e o
 * eco seria confundido com anúncio da TUI (falso-positivo/negativo). Passe um
 * predicado que reconheça terminais de AGENTE (sessão de turno registrada);
 * terminais não rastreados ficam sempre sem paste embrujado (fallback plain).
 */
export function createTerminalPasteMode(
  subscribe: (listener: (event: TerminalEvent) => void) => () => void,
  shouldTrack: (id: string) => boolean = () => true
): TerminalPasteMode {
  const enabled = new Set<string>()
  const carryByTerminal = new Map<string, string>()

  subscribe((event: TerminalEvent) => {
    if (event.type === 'exit' || event.type === 'error') {
      // PTY morto/reiniciado: a capability morre com ele (a nova TUI precisa
      // reanunciar 2004h).
      enabled.delete(event.id)
      carryByTerminal.delete(event.id)
      return
    }
    if (event.type !== 'data' || typeof event.data !== 'string' || event.data.length === 0) return
    if (!shouldTrack(event.id)) return

    // Junta a cauda do chunk anterior (prefixo possível de sequência partida)
    // com o chunk atual, decide pelo LAST match (a última sequência no fluxo
    // vence) e descarta tudo exceto a nova cauda bounded.
    const haystack = (carryByTerminal.get(event.id) ?? '') + event.data
    const enableIndex = haystack.lastIndexOf(PASTE_ENABLE_SEQUENCE)
    const disableIndex = haystack.lastIndexOf(PASTE_DISABLE_SEQUENCE)
    if (enableIndex !== -1 || disableIndex !== -1) {
      if (enableIndex > disableIndex) enabled.add(event.id)
      else enabled.delete(event.id)
    }
    carryByTerminal.set(event.id, haystack.slice(Math.max(0, haystack.length - PASTE_MODE_CARRY_CHARS)))
  })

  return {
    isBracketedPasteEnabled: (id: string) => enabled.has(id),
    reset: (id: string) => {
      enabled.delete(id)
      carryByTerminal.delete(id)
    },
  }
}
