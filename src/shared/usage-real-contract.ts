/**
 * Contrato de uso REAL de quotas (fonte única main ↔ renderer).
 *
 * A medição vem exclusivamente do OAuth do Codex (`getRealUsage`), via canal
 * IPC `devorbit:getRealUsage`. Somente leitura: nunca inclui credenciais.
 */

export type RealUsageStatus = 'ready' | 'not_configured' | 'error'

export interface RealUsageMetric {
  id: string
  label: string
  percent?: number
  resetAt?: number
  windowSeconds?: number
  value?: string
  detail?: string
}

export interface RealAccountUsage {
  account: 'account1' | 'account2'
  status: RealUsageStatus
  plan?: string
  metrics: RealUsageMetric[]
  fetchedAt?: string
  message?: string
}

export interface RealUsageState {
  source: 'codex-oauth'
  fetchedAt: string
  accounts: {
    account1: RealAccountUsage
    account2: RealAccountUsage
  }
}
