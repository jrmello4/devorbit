import {
  AGENT_SUBMIT_SEQUENCE,
  type AgentInstructionEvent,
  type AgentInstructionPhase,
} from '../shared/agent-instruction-contract'
import { TURN_READY_QUIET_MS, TURN_READY_TIMEOUT_MS, type TerminalReadyOptions } from './agent-turn'
import type { TerminalEvent } from './terminal-session'

/**
 * Abstração central de submissão de instruções a um agente — o único lugar do
 * CAMINHO DE TURNOS da orquestração que envia Enter (AGENT_SUBMIT_SEQUENCE).
 * Fluxo: queued → waiting_ready (timeout de prontidão NÃO escreve nada) →
 * sending (conteúdo verbatim + UM Enter) → submitted → awaiting_ack (qualquer
 * saída do terminal confirma) → acked. Sem ack: re-submete APENAS o Enter
 * (reenviar o conteúdo duplicaria a tarefa).
 *
 * Pendência conhecida: o Bridge (send/ask best-effort em bridge-service.ts)
 * ainda escreve direto no PTY com '\r' próprio — migrá-lo para cá é trabalho
 * futuro; até lá esta doc NÃO vale para o Bridge.
 */
export interface AgentInstructionDeps {
  hasTerminal: (id: string) => boolean
  waitReady: (id: string, options?: TerminalReadyOptions) => Promise<{ timedOut: boolean }>
  write: (id: string, data: string) => boolean
  subscribe: (listener: (event: TerminalEvent) => void) => () => void
  now: () => number
}

export interface AgentInstructionInput {
  terminalId: string
  turnId: string
  /** Conteúdo enviado VERBATIM numa única escrita (multiline sem transformar \n). */
  content: string
  provider: string
  /** Janela de espera pelo echo/redraw pós-submit. Default 3000ms. */
  ackTimeoutMs?: number
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
const DEFAULT_MAX_SUBMIT_ATTEMPTS = 2

/**
 * Log observável de orquestração: fases da instrução SEM o conteúdo da
 * mensagem (o prompt nunca vai para o console).
 */
function emitInstructionLog(event: AgentInstructionEvent): void {
  console.info(
    '[orchestration] turn=%s terminal=%s provider=%s event=%s attempt=%d',
    event.turnId,
    event.terminalId,
    event.provider,
    event.phase,
    event.attempt
  )
  if (event.error !== undefined) {
    console.info('[orchestration] turn=%s event=%s error=%s', event.turnId, event.phase, event.error)
  }
}

export async function sendAgentInstruction(
  deps: AgentInstructionDeps,
  input: AgentInstructionInput
): Promise<AgentInstructionResult> {
  const ackTimeoutMs = Math.max(100, input.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS)
  const maxSubmitAttempts = Math.max(1, input.maxSubmitAttempts ?? DEFAULT_MAX_SUBMIT_ATTEMPTS)
  const readyOptions: TerminalReadyOptions = {
    ...(input.quietMs !== undefined ? { quietMs: input.quietMs } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.since !== undefined ? { since: input.since } : {}),
  }
  const emit = (phase: AgentInstructionPhase, attempt: number, error?: string): void => {
    emitInstructionLog({
      kind: 'instruction',
      terminalId: input.terminalId,
      turnId: input.turnId,
      provider: input.provider,
      phase,
      at: deps.now(),
      attempt,
      ...(error !== undefined ? { error } : {}),
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
    // O observador de ack é armado ANTES da escrita: o echo do próprio prompt
    // e o redraw da TUI contam como confirmação e não podem ser perdidos na
    // corrida com o PTY.
    let unsubscribeAck = (): void => undefined
    const ackSignal = new Promise<boolean>((resolveAck) => {
      const timer = setTimeout(() => {
        unsubscribeAck()
        resolveAck(false)
      }, ackTimeoutMs)
      unsubscribeAck = deps.subscribe((event: TerminalEvent) => {
        if (event.id !== input.terminalId) return
        if (event.type !== 'data') return
        clearTimeout(timer)
        unsubscribeAck()
        resolveAck(true)
      })
    })

    if (attempt === 1) {
      emit('sending', attempt)
      // Conteúdo verbatim numa única escrita (multiline intacta); o Enter é
      // uma escrita separada e única no fim.
      if (input.content.length > 0 && !deps.write(input.terminalId, input.content)) {
        unsubscribeAck()
        const error = 'O terminal recusou o conteúdo da tarefa.'
        emit('failed', attempt, error)
        return { acked: false, attempts: attempt, error }
      }
    } else {
      // Re-submissão envia APENAS o Enter: no pior caso é um Enter vazio;
      // reenviar o conteúdo duplicaria a tarefa no CLI.
      emit('retry_submit', attempt)
    }
    if (!deps.write(input.terminalId, AGENT_SUBMIT_SEQUENCE)) {
      unsubscribeAck()
      const error = 'O terminal recusou o Enter de submissão.'
      emit('failed', attempt, error)
      return { acked: false, attempts: attempt, error }
    }
    emit('submitted', attempt)
    emit('awaiting_ack', attempt)
    const acked = await ackSignal
    if (acked) {
      emit('acked', attempt)
      return { acked: true, attempts: attempt }
    }
  }

  const error = `O terminal não confirmou o recebimento da tarefa após ${maxSubmitAttempts} tentativa(s) de Enter.`
  emit('failed', maxSubmitAttempts, error)
  return { acked: false, attempts: maxSubmitAttempts, error }
}
