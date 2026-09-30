import {
  AGENT_SUBMIT_SEQUENCE,
  type AgentInstructionEvent,
  type AgentInstructionPhase,
} from '../shared/agent-instruction-contract'
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from './terminal-paste-mode'
import { TURN_READY_QUIET_MS, TURN_READY_TIMEOUT_MS, type TerminalReadyOptions } from './agent-turn'
import type { TerminalEvent } from './terminal-session'

/**
 * Abstração central de submissão de instruções a um agente — o único lugar do
 * CAMINHO DE TURNOS da orquestração que envia Enter (AGENT_SUBMIT_SEQUENCE).
 * Fluxo: queued → waiting_ready (timeout de prontidão NÃO escreve nada) →
 * content_written (conteúdo verbatim ou paste embrulhado) → submit_sent
 * (UM Enter) → awaiting_ack (após o settle do eco, qualquer saída confirma) →
 * acked. Sem ack: re-submete APENAS o Enter (reenviar o conteúdo duplicaria a
 * tarefa).
 *
 * ACK PÓS-SUBMIT: o observador é armado NO `submit_sent` — o eco do conteúdo
 * (que antes contava como ack) não confirma mais nada. Imediatamente depois do
 * Enter a TUI costuma redesenhar o prompt (echo do '\r'); essa saída cai na
 * janela de settle (`echoSettleMs`, default 150ms) e NÃO confirma nem rejeita.
 * Depois do settle, QUALQUER saída do terminal = ack (heurística default,
 * documentada; patterns por provider ficam para o adapter futuro).
 *
 * BRACKETED PASTE: quando a TUI anunciou `ESC[?2004h` (capability observada em
 * `terminal-paste-mode.ts`) e o conteúdo é multiline, o conteúdo entra
 * embrulhado em `ESC[200~ … ESC[201~` como UMA escrita antes do Enter — o bloco
 * é tratado como paste único e nenhuma linha executa prematuramente. Sem a
 * capability ou com conteúdo de uma linha, verbatim como antes.
 *
 * Consumidores: os turnos da orquestração (sendAgentTurn) e o Bridge
 * (send/ask do bridge-service, via dep `sendInstruction` injetada em index.ts)
 * — não há mais caminho que escreva prompt + Enter direto no PTY.
 */
export interface AgentInstructionDeps {
  hasTerminal: (id: string) => boolean
  waitReady: (id: string, options?: TerminalReadyOptions) => Promise<{ timedOut: boolean }>
  write: (id: string, data: string) => boolean
  subscribe: (listener: (event: TerminalEvent) => void) => () => void
  now: () => number
  /**
   * Capability dinâmica de bracketed paste do terminal (factory
   * `createTerminalPasteMode`). Ausente → false (escrita verbatim).
   */
  isBracketedPasteEnabled?: (id: string) => boolean
}

export interface AgentInstructionInput {
  terminalId: string
  turnId: string
  /** Conteúdo enviado VERBATIM numa única escrita (multiline sem transformar \n). */
  content: string
  provider: string
  /**
   * Janela de ack APÓS o settle do eco pós-submit. Default 3000ms; a espera
   * total por tentativa é `echoSettleMs + ackTimeoutMs`.
   */
  ackTimeoutMs?: number
  /**
   * Janela de acomodação do eco: saída nos primeiros `echoSettleMs` ms após o
   * Enter (redraw do prompt gerado pelo próprio submit) não confirma nem
   * rejeita. Default 150ms.
   */
  echoSettleMs?: number
  /** Total de tentativas de Enter (1 sem retry). Default 2. */
  maxSubmitAttempts?: number
  quietMs?: number
  timeoutMs?: number
  /** Âncora de prontidão (epoch ms): spawn do terminal ou início do turno. */
  since?: number
}

export interface AgentInstructionResult {
  acked: boolean
  attempts: number
  error?: string
}

const DEFAULT_ACK_TIMEOUT_MS = 3_000
const DEFAULT_ECHO_SETTLE_MS = 150
const DEFAULT_MAX_SUBMIT_ATTEMPTS = 2

/**
 * Log observável de orquestração: fases da instrução SEM o conteúdo da
 * mensagem (o prompt nunca vai para o console). `content_written` carrega o
 * modo de paste e o TAMANHO do conteúdo — metadados, nunca o texto.
 */
function emitInstructionLog(event: AgentInstructionEvent): void {
  console.info(
    '[orchestration] turn=%s terminal=%s provider=%s event=%s attempt=%d%s%s',
    event.turnId,
    event.terminalId,
    event.provider,
    event.phase,
    event.attempt,
    event.paste !== undefined ? ` paste=${event.paste}` : '',
    event.length !== undefined ? ` length=${event.length}` : ''
  )
  if (event.error !== undefined) {
    console.info('[orchestration] turn=%s event=%s error=%s', event.turnId, event.phase, event.error)
  }
}

/**
 * Observador de ack pós-submit. Primeiro a janela de settle: toda saída é
 * descartada (o redraw do prompt gerado pelo Enter não é resposta). Só depois
 * do settle o subscribe é registrado e o teto `ackTimeoutMs` começa a contar —
 * qualquer `data` do terminal confirma. A espera total por tentativa é
 * `echoSettleMs + ackTimeoutMs`; resolver por timeout NÃO é ack.
 *
 * Não há corrida entre settle e subscribe: o callback do settle registra o
 * listener sincronamente no mesmo tick, então nenhum evento do barramento
 * escapa entre o fim do settle e o armado do observador.
 */
function waitForAck(
  deps: AgentInstructionDeps,
  terminalId: string,
  ackTimeoutMs: number,
  echoSettleMs: number
): Promise<boolean> {
  return new Promise<boolean>((resolveAck) => {
    let ackTimer: ReturnType<typeof setTimeout> | undefined
    let unsubscribeAck: () => void = () => undefined
    const settleTimer = setTimeout(() => {
      ackTimer = setTimeout(() => finish(false), ackTimeoutMs)
      unsubscribeAck = deps.subscribe((event: TerminalEvent) => {
        if (event.id !== terminalId) return
        if (event.type !== 'data') return
        finish(true)
      })
    }, echoSettleMs)
    const finish = (acked: boolean): void => {
      if (ackTimer !== undefined) clearTimeout(ackTimer)
      clearTimeout(settleTimer)
      unsubscribeAck()
      resolveAck(acked)
    }
  })
}

export async function sendAgentInstruction(
  deps: AgentInstructionDeps,
  input: AgentInstructionInput
): Promise<AgentInstructionResult> {
  const ackTimeoutMs = Math.max(100, input.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS)
  const echoSettleMs = Math.max(0, input.echoSettleMs ?? DEFAULT_ECHO_SETTLE_MS)
  const maxSubmitAttempts = Math.max(1, input.maxSubmitAttempts ?? DEFAULT_MAX_SUBMIT_ATTEMPTS)
  const readyOptions: TerminalReadyOptions = {
    ...(input.quietMs !== undefined ? { quietMs: input.quietMs } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.since !== undefined ? { since: input.since } : {}),
  }
  const emit = (
    phase: AgentInstructionPhase,
    attempt: number,
    error?: string,
    detail?: Pick<AgentInstructionEvent, 'paste' | 'length'>
  ): void => {
    emitInstructionLog({
      kind: 'instruction',
      terminalId: input.terminalId,
      turnId: input.turnId,
      provider: input.provider,
      phase,
      at: deps.now(),
      attempt,
      ...(error !== undefined ? { error } : {}),
      ...(detail ?? {}),
    })
  }

  emit('queued', 0)
  if (!deps.hasTerminal(input.terminalId)) {
    const error = `O terminal ${input.terminalId} não existe mais; a tarefa não foi enviada.`
    emit('failed', 0, error)
    return { acked: false, attempts: 0, error }
  }

  emit('waiting_ready', 0)
  const ready = await deps.waitReady(input.terminalId, readyOptions)
  if (ready.timedOut) {
    // Prontidão por timeout NÃO autoriza escrita: Enter durante o boot da TUI
    // é exatamente a corrida que este módulo existe para eliminar.
    const error = 'A interface do agente não ficou pronta; nada foi escrito no terminal.'
    emit('failed', 0, error)
    return { acked: false, attempts: 0, error }
  }

  for (let attempt = 1; attempt <= maxSubmitAttempts; attempt += 1) {
    if (attempt === 1) {
      // Bracketed paste como capability dinâmica: multiline + `ESC[?2004h`
      // ativo → o bloco entra embrulhado (UMA escrita; a TUI não executa
      // nenhuma linha antes do Enter). Sem capability ou 1 linha → verbatim.
      const bracketedPaste =
        input.content.includes('\n') && (deps.isBracketedPasteEnabled?.(input.terminalId) ?? false)
      const payload = bracketedPaste
        ? `${BRACKETED_PASTE_START}${input.content}${BRACKETED_PASTE_END}`
        : input.content
      // Conteúdo verbatim numa única escrita (multiline intacta); o Enter é
      // uma escrita separada e única no fim.
      if (input.content.length > 0 && !deps.write(input.terminalId, payload)) {
        const error = 'O terminal recusou o conteúdo da tarefa.'
        emit('failed', attempt, error)
        return { acked: false, attempts: attempt, error }
      }
      emit('content_written', attempt, undefined, {
        paste: bracketedPaste ? 'bracketed' : 'plain',
        length: input.content.length,
      })
    } else {
      // Re-submissão envia APENAS o Enter: no pior caso é um Enter vazio;
      // reenviar o conteúdo duplicaria a tarefa no CLI.
      emit('retry_submit', attempt)
    }
    if (!deps.write(input.terminalId, AGENT_SUBMIT_SEQUENCE)) {
      const error = 'O terminal recusou o Enter de submissão.'
      emit('failed', attempt, error)
      return { acked: false, attempts: attempt, error }
    }
    emit('submit_sent', attempt)
    emit('awaiting_ack', attempt)
    const acked = await waitForAck(deps, input.terminalId, ackTimeoutMs, echoSettleMs)
    if (acked) {
      emit('acked', attempt)
      return { acked: true, attempts: attempt }
    }
  }

  const error = `O terminal não confirmou o recebimento da tarefa após ${maxSubmitAttempts} tentativa(s) de Enter.`
  emit('failed', maxSubmitAttempts, error)
  return { acked: false, attempts: maxSubmitAttempts, error }
}
