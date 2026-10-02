export type CodexBridgeState = 'configuring' | 'connecting' | 'connected' | 'agents_available' | 'failed' | 'stopped'

export const CODEX_BRIDGE_MESSAGES = {
  MCP_CONFIGURATION_MISSING: 'Agent Bridge não foi configurada para esta sessão.',
  BRIDGE_ENV_MISSING: 'O ambiente temporário da Agent Bridge está incompleto.',
  BRIDGE_UNREACHABLE: 'O MCP DevOrbit não conseguiu conectar à Agent Bridge.',
  BRIDGE_AUTH_REJECTED: 'A autenticação temporária da Agent Bridge foi rejeitada.',
  BRIDGE_SESSION_MISMATCH: 'A sessão da Agent Bridge não corresponde à sessão atual.',
  MCP_STARTUP_FAILED: 'O MCP DevOrbit não confirmou a conexão desta sessão.',
  NO_AGENTS_REGISTERED: 'A comunicação foi estabelecida, mas nenhum agente está registrado.',
} as const

export type CodexBridgeErrorCode = keyof typeof CODEX_BRIDGE_MESSAGES

/** Public view: never includes credentials, pipe paths, or raw CLI output. */
export interface CodexBridgeHealth {
  terminalId: string
  launchId: string
  state: CodexBridgeState
  agentCount: number
  updatedAt: number
  connectedAt?: number
  mcpPid?: number
  code?: CodexBridgeErrorCode
  message: string
}
