export type CodexAccountId = 'account1' | 'account2'
export type TerminalSessionMode = 'shell' | 'codex' | 'agent'
export type TerminalSessionState = 'starting' | 'ready' | 'stopped' | 'error'

export interface TerminalSessionIdentity {
  provider: string | null
  account: CodexAccountId | null
  mode: TerminalSessionMode
  state: TerminalSessionState
}

/**
 * Um PTY do Codex nasce com o `CODEX_HOME` da conta escolhida. A sessão só
 * pode receber uma nova tarefa quando provider, conta, modo e estado ainda
 * correspondem ao pedido; ao trocar de conta o terminal precisa reiniciar
 * antes do envio.
 */
export function canReuseCodexSession(
  session: TerminalSessionIdentity,
  provider: string,
  account: CodexAccountId | null | undefined,
): boolean {
  return session.provider === provider
    && session.account === (account ?? null)
    && session.mode === 'codex'
    && session.state === 'ready'
}
