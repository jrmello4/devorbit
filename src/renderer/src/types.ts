/**
 * Compat: os contratos compartilhados main ↔ renderer têm FONTE ÚNICA em
 * `src/shared`. Este módulo apenas re-exporta esses contratos para que os
 * arquivos do renderer continuem importando de `../types` (ou `./types`).
 *
 * Definições EXCLUSIVAS do renderer (UI/canvas) continuam declaradas aqui.
 * Nada novo deve ser definido neste arquivo se for consumido por main ou
 * preload — mova para `src/shared`.
 */
export * from '../../shared/app-config'
export * from '../../shared/git-contract'
export * from '../../shared/usage-real-contract'
export * from '../../shared/ipc-channels'
export * from '../../shared/app-events'
export * from '../../shared/tool-health-contract'
export * from '../../shared/devorbit-api'
export type { CustomTerminalPreset } from '../../shared/terminal-presets'
export type { AgentProviderId } from '../../shared/agent-provider-contract'
export type { CodexAccountId } from '../../shared/codex-session'

export type PendingCreationKind = 'agent' | 'squad' | 'terminal'

export interface PendingCreationPayload {
  projectId: string
  kind: PendingCreationKind
  nonce: number
}

import type { DevOrbitAPI } from '../../shared/devorbit-api'

declare global {
  interface Window {
    devorbit: DevOrbitAPI
  }
}
