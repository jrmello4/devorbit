/**
 * Fonte única de verdade para IDs de providers first-class do DevOrbit.
 *
 * Este arquivo NÃO importa Electron, React nem módulos de UI: só tipos e
 * constantes. Pode ser consumido por main, renderer e testes sem risco de
 * ciclo. Qualquer novo provider DEVE ser adicionado aqui primeiro; os
 * consumidores derivam o tuple e o tipo.
 */

/** Tuple readonly dos IDs first-class — a ordem define a prioridade de exibição. */
export const AGENT_PROVIDER_ID_LIST = [
  'codex',
  'opencode',
  'opencode2',
  'claude',
  'gemini',
  'aider',
  'agy',
  'command-code',
  'custom',
] as const

/** Tipo derivado do tuple — garante que AgentProviderId e a lista estão sincronizados. */
export type AgentProviderId = (typeof AGENT_PROVIDER_ID_LIST)[number]

/**
 * Hints por provider para a submissão central (agent-instruction).
 */
export interface AgentInstructionHints {
  /** Allow a CLI's paste buffer to settle before submitting (milliseconds). */
  pasteSettleMs?: number
  /**
   * Fontes de regex (string) casadas contra a saída CRU pós-settle: a primeira
   * que casar confirma o ack. Vazio/ausente = heurística default (qualquer
   * saída confirma). Padrões NÃO observados em CLI real NÃO devem ser
   * preenchidos — mecanismo primeiro, evidência depois.
   */
  ackPatterns?: string[]
  /** 'auto' (default): usa a detecção dinâmica do terminal. */
  bracketedPaste?: 'auto' | 'on' | 'off'
}
