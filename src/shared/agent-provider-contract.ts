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
