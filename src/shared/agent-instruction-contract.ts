/**
 * Contrato central de submissão de instruções a agentes (main ↔ renderer).
 *
 * Todo Enter enviado a um CLI de agente passa por aqui: NUNCA espalhe '\r'
 * por chamadores. Windows ConPTY/xterm: Enter é '\r' (o onData do xterm emite
 * '\r'), e a submissão única no fim do conteúdo é o que dispara o turno.
 */

/**
 * Fases observáveis de uma instrução (logs de orquestração, sem conteúdo).
 *
 * `content_written` substitui a antiga `sending` e `submit_sent` substitui a
 * antiga `submitted`: a distinção agora é LOAD-BEARING — o observador de ack
 * só é armado NO `submit_sent` (depois do Enter), então o eco do conteúdo
 * deixa de confirmar recebimento. Consumidores de telemetria que filtravam
 * pelas fases antigas devem acompanhar.
 */
export type AgentInstructionPhase =
  | 'queued'
  | 'waiting_ready'
  | 'content_written'
  | 'submit_sent'
  | 'awaiting_ack'
  | 'acked'
  | 'retry_submit'
  | 'failed'
  /**
   * Cancelamento cooperativo (AbortSignal): distinto de `failed` — o envio não
   * FALHOU, ele foi interrompido a pedido do chamador. Cancelar NÃO reescreve
   * nem "desfaz" o que já foi escrito no terminal (conteúdo/Enter entregues
   * permanecem), apenas para observers/retry/continuação local. Nenhum
   * consumidor deve tratar `cancelled` como gatilho de retry.
   */
  | 'cancelled'

export interface AgentInstructionEvent {
  kind: 'instruction'
  terminalId: string
  turnId: string
  provider: string
  phase: AgentInstructionPhase
  at: number
  attempt: number
  error?: string
  /**
   * Modo de escrita do conteúdo — somente na fase `content_written`. Telemetria
   * apenas: NUNCA coloque o conteúdo (ou trecho dele) aqui.
   */
  paste?: 'bracketed' | 'plain'
  /** Tamanho do conteúdo em caracteres — somente na fase `content_written`. */
  length?: number
  /**
   * Índice do padrão (em `hints.ackPatterns` do provider) que confirmou o ack —
   * somente na fase `acked` e somente quando o ack veio de um padrão do
   * catálogo. NUNCA carrega o trecho casado da saída do terminal (sem
   * conteúdo), só o índice para auditoria.
   */
  ackPattern?: number
}

/**
 * Sequência de submissão única: o Enter que efetiva o envio do conteúdo.
 * Windows ConPTY/xterm: Enter é '\r' (o onData do xterm emite '\r').
 */
export const AGENT_SUBMIT_SEQUENCE = '\r'
