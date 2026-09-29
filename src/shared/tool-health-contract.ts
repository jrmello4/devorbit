/**
 * Contrato de saúde de ferramentas e cards de provider (fonte única).
 *
 * Consumido pelo launcher (main), pelo serviço de providers de agente e pela
 * UI de ferramentas do renderer.
 */
import type { AgentProviderId } from './agent-provider-contract'

export interface ToolPathCheck {
  path: string
  ok: boolean
  message: string
}

export type ToolHealthState = 'ready' | 'fallback' | 'missing'

export interface AgentProvider {
  id: AgentProviderId
  label: string
  command: string
  state: ToolHealthState
  path?: string
  message: string
  configuredPath?: string
  effectivePath?: string
  isConfigured?: boolean
}

export interface ToolHealth {
  id: 'terminal' | 'vscode' | 'codex' | 'opencode' | 'opencode2' | 'claude' | 'gemini' | 'aider' | 'agy' | 'command-code' | 'custom' | 'brave' | 'chrome' | 'mimo'
  label: string
  state: ToolHealthState
  path?: string
  message: string
  configuredPath?: string
  effectivePath?: string
  isConfigured?: boolean
}
