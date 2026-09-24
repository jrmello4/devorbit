import React, { useEffect, useState } from 'react'
import { AlertTriangle, ArrowRightLeft, RefreshCw } from 'lucide-react'
import type {
  AppConfig,
  RealAccountUsage,
  RealUsageMetric,
  RealUsageState,
} from '../types'
import { UsageSharePanel } from './UsageSharePanel'
import './UsagePanel.css'

interface UsageBarProps {
  config: AppConfig | null
  realUsage: RealUsageState | null
  onRefreshRealUsage: () => Promise<void>
  isRefreshingRealUsage?: boolean
  onSwitchAccount: () => Promise<void>
  isSwitchingAccount?: boolean
}

type AccountKey = 'account1' | 'account2'

const accountKeys: AccountKey[] = ['account1', 'account2']

const formatTimestamp = (timestamp?: string) => {
  if (!timestamp) return null
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
}

const getAccountName = (config: AppConfig | null, accountKey: AccountKey) =>
  accountKey === 'account1'
    ? config?.chatGptAccount1Name || 'Conta 1'
    : config?.chatGptAccount2Name || 'Conta 2'

// Estado em texto curto: vira tooltip do ponto de status (um indicador por conta).
const getProviderStatusLabel = (account: RealAccountUsage) => {
  if (account.status === 'ready') return account.plan ? `Pronta · ${account.plan}` : 'Pronta'
  if (account.status === 'not_configured') return 'Não autenticada'
  return 'Indisponível'
}

export const UsageBar: React.FC<UsageBarProps> = ({
  config,
  realUsage,
  onRefreshRealUsage,
  isRefreshingRealUsage = false,
  onSwitchAccount,
  isSwitchingAccount = false,
}) => {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    // Tick de 10s mantido: atualiza as contagens regressivas das janelas.
    const timer = setInterval(() => setNow(Date.now()), 10000)
    return () => clearInterval(timer)
  }, [])

  const formatRealReset = (resetAt?: number) => {
    if (!resetAt) return null
    const remainingMs = Math.max(0, resetAt - now)
    if (remainingMs <= 0) return 'reset disponível'
    const totalMinutes = Math.ceil(remainingMs / 60000)
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return hours > 0 ? `reseta em ${hours}h ${minutes}m` : `reseta em ${minutes}m`
  }

  const activeAccount = config?.activeChatGptAccount || 'account1'
  const nextAccount: AccountKey = activeAccount === 'account1' ? 'account2' : 'account1'

  const primaryPercent = ((): number | undefined => {
    if (!realUsage) return undefined
    const metrics = realUsage.accounts[activeAccount]?.metrics || []
    const primary = metrics.find((metric) => metric.id === 'primary') || metrics[0]
    return typeof primary?.percent === 'number' ? primary.percent : undefined
  })()
  const showHandoffAlert = typeof primaryPercent === 'number' && primaryPercent >= 80

  const renderProviderMetric = (accountName: string, metric: RealUsageMetric) => {
    const metricPercent = typeof metric.percent === 'number' && Number.isFinite(metric.percent)
      ? Math.min(100, Math.max(0, metric.percent))
      : undefined
    const resetLabel = formatRealReset(metric.resetAt)
    const metricTone = metricPercent !== undefined && metricPercent >= 90
      ? 'usage-provider-metric--critical'
      : metricPercent !== undefined && metricPercent >= 75
        ? 'usage-provider-metric--warning'
        : ''

    return (
      <div key={`${accountName}-${metric.id}`} className={`usage-provider-metric ${metricTone}`}>
        <div className="usage-provider-metric-heading">
          <span className="usage-provider-metric-label" title={metric.label}>{metric.label}</span>
          {metricPercent !== undefined && (
            <span className="usage-provider-metric-value tabular-nums">{metricPercent}%</span>
          )}
          {metric.value && metricPercent === undefined && (
            <span className="usage-provider-metric-value">{metric.value}</span>
          )}
        </div>

        {metricPercent !== undefined && (
          <div
            className="usage-progress usage-progress--provider"
            role="progressbar"
            aria-label={`${accountName} — ${metric.label}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={metricPercent}
          >
            <div className="usage-progress-fill" style={{ width: `${metricPercent}%` }} />
          </div>
        )}

        {(metric.detail || resetLabel) && (
          <div className="usage-provider-metric-meta">
            {metric.detail && <span>{metric.detail}</span>}
            {resetLabel && <span className="usage-reset-label tabular-nums">{resetLabel}</span>}
          </div>
        )}
      </div>
    )
  }

  const renderProviderAccount = (accountKey: AccountKey) => {
    if (!realUsage) return null
    const account = realUsage.accounts[accountKey]
    const accountName = getAccountName(config, accountKey)
    const isActive = activeAccount === accountKey
    const statusLabel = getProviderStatusLabel(account)

    return (
      <article
        key={accountKey}
        className={`usage-provider-account usage-provider-account--${account.status}`}
        aria-label={`Uso do provedor para ${accountName}`}
      >
        <div className="usage-account-heading">
          <div className="usage-account-name-wrap">
            {/* Ponto + tooltip substitui a pill de status */}
            <span
              className={`usage-status-dot usage-status-dot--${account.status}`}
              title={statusLabel}
              aria-label={statusLabel}
              role="img"
            />
            <h3>{accountName}</h3>
            {isActive && <span className="usage-active-label">Ativa</span>}
          </div>
        </div>

        {account.metrics.length > 0 ? (
          <div className="usage-provider-metrics">
            {account.metrics.map((metric) => renderProviderMetric(accountName, metric))}
          </div>
        ) : account.status === 'ready' ? (
          <p className="usage-provider-message">A conta respondeu, mas não publicou uma janela percentual.</p>
        ) : account.message ? (
          <p className="usage-provider-message" role={account.status === 'error' ? 'alert' : 'status'}>
            {account.message}
          </p>
        ) : null}
      </article>
    )
  }

  const realFetchedLabel = formatTimestamp(realUsage?.fetchedAt)
  const providerSourceLabel = realUsage?.source === 'codex-oauth' ? 'OAuth do Codex' : 'Aguardando fonte'

  return (
    <section className="usage-panel" aria-labelledby="usage-heading" aria-busy={!realUsage || isRefreshingRealUsage}>
      <div className="usage-scroll">
        <div className="usage-shell">
          <header className="usage-header">
            <h1 id="usage-heading">Uso e quotas</h1>
            <div className="usage-header-actions">
              {/* Fonte vira tooltip no carimbo de atualização */}
              {realFetchedLabel && (
                <span className="usage-source-meta" title={`Fonte: ${providerSourceLabel}`} aria-live="polite">
                  Atualizado em {realFetchedLabel}
                </span>
              )}
              <button
                type="button"
                className="usage-button usage-button--primary"
                onClick={() => void onRefreshRealUsage()}
                disabled={isRefreshingRealUsage}
                aria-busy={isRefreshingRealUsage}
                aria-label={isRefreshingRealUsage ? 'Atualizando quotas do provedor' : 'Atualizar quotas do provedor'}
              >
                <RefreshCw className={isRefreshingRealUsage ? 'usage-spin' : ''} aria-hidden="true" />
                {isRefreshingRealUsage ? 'Consultando…' : 'Atualizar quotas'}
              </button>
            </div>
          </header>

          {showHandoffAlert && (
            <div className={`usage-handoff ${typeof primaryPercent === 'number' && primaryPercent >= 100 ? 'usage-handoff--critical' : ''}`} role="status">
              <div className="usage-handoff-copy">
                <AlertTriangle aria-hidden="true" />
                <div>
                  <strong>{typeof primaryPercent === 'number' && primaryPercent >= 100 ? 'Quota do provedor esgotada!' : 'Quota do provedor próxima do limite!'}</strong>
                  <span>A conta ativa chegou a {primaryPercent}% na janela principal.</span>
                </div>
              </div>
              <button
                type="button"
                className="usage-button usage-button--handoff"
                onClick={() => void onSwitchAccount()}
                disabled={isSwitchingAccount}
                aria-busy={isSwitchingAccount}
              >
                <ArrowRightLeft aria-hidden="true" />
                {isSwitchingAccount ? 'Alternando…' : `Alternar para ${getAccountName(config, nextAccount)}`}
              </button>
            </div>
          )}

          <section className="usage-section usage-provider-section" aria-labelledby="usage-provider-heading">
            <div className="usage-section-heading">
              <h2 id="usage-provider-heading">Quotas do provedor</h2>
            </div>

            {realUsage ? (
              <div className="usage-provider-grid">
                {accountKeys.map(renderProviderAccount)}
              </div>
            ) : (
              <div className="usage-loading" role="status" aria-live="polite">
                <RefreshCw className="usage-loading-icon usage-spin" aria-hidden="true" />
                <span>Consultando quotas do provedor…</span>
              </div>
            )}
          </section>

          <UsageSharePanel />
        </div>
      </div>
    </section>
  )
}
