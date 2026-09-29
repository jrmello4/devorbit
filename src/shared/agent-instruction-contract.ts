/**
 * Contrato central de submissão de instruções a agentes (main ↔ renderer).
 *
 * Todo Enter enviado a um CLI de agente passa por aqui: NUNCA espalhe '\r'
 * por chamadores. Windows ConPTY/xterm: Enter é '\r' (o onData do xterm emite
 * '\r'), e a submissão única no fim do conteúdo é o que dispara o turno.
 */

/** Fases observáveis de uma instrução (logs de orquestração, sem conteúdo). */
export type AgentInstructionPhase =
  | 'queued'
  | 'waiting_ready'
  | 'sending'
  | 'submitted'
  | 'awaiting_ack'
  | 'acked'
  | 'retry_submit'
  | 'failed'

export interface AgentInstructionEvent {
  kind: 'instruction'
  terminalId: string
  turnId: string
  provider: string
  phase: AgentInstructionPhase
  at: number
  attempt: number
  error?: string
}

/**
 * Sequência de submissão única: o Enter que efetiva o envio do conteúdo.
 * Windows ConPTY/xterm: Enter é '\r' (o onData do xterm emite '\r').
 */
export const AGENT_SUBMIT_SEQUENCE = '\r'
