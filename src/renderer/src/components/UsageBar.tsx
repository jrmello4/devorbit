import React, { useEffect, useState } from 'react'
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  ChevronDown,
  Clock,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  Sparkles,
} from 'lucide-react'
import type {
  AccountUsage,
  AppConfig,
  RealAccountUsage,
  RealUsageMetric,
  RealUsageState,
  UsageTrackerState,
} from '../types'
import './UsagePanel.css'

interface UsageBarProps {
  usage: UsageTrackerState | null
  config: AppConfig | null
  onIncrement: (target: 'account1' | 'account2' | 'antigravity') => Promise<void>
  onDecrement: (target: 'account1' | 'account2') => Promise<void>
  onReset: (target: 'account1' | 'account2') => Promise<void>
  onUpdateLimit: (account: 'account1' | 'account2', limit: number) => Promise<void>
  onSwitchAccount: () => Promise<void>
  isSwitchingAccount?: boolean
  realUsage: RealUsageState | null
  onRefreshRealUsage: () => Promise<void>
  isRefreshingRealUsage?: boolean
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

const getProviderStatusLabel = (account: RealAccountUsage) => {
  if (account.status === 'ready') return account.plan ? `Pronta · ${account.plan}` : 'Pronta'
  if (account.status === 'not_configured') return 'Não autenticada'
  return 'Indisponível'
}

const getProviderStatusIcon = (status: RealAccountUsage['status']) => {
  if (status === 'ready') return <CheckCircle2 aria-hidden="true" />
  return <AlertTriangle aria-hidden="true" />
}

export const UsageBar: React.FC<UsageBarProps> = ({
  usage,
  config,
  onIncrement,
  onDecrement,
  onReset,
  onUpdateLimit,
  onSwitchAccount,
  isSwitchingAccount = false,
  realUsage,
  onRefreshRealUsage,
  isRefreshingRealUsage = false,
}) => {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000)
    return () => clearInterval(timer)
  }, [])

  const getRemainingTime = (account: AccountUsage) => {
    if (!account.windowStart || account.used === 0) return null
    const durationMs = (account.windowDurationHours || 3) * 3600 * 1000
    const remainingMs = Math.max(0, account.windowStart + durationMs - now)
    if (remainingMs <= 0) return 'Reset iminente'

    const totalMinutes = Math.floor(remainingMs / 60000)
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
  }

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
  const activeUsage = usage?.[activeAccount]
  const activePercent = activeUsage && activeUsage.limit > 0
    ? Math.round((activeUsage.used / activeUsage.limit) * 100)
    : 0
  const showHandoffAlert = Boolean(activeUsage && activePercent >= 80)
  const nextAccount: AccountKey = activeAccount === 'account1' ? 'account2' : 'account1'

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

        <div className="usage-provider-metric-meta">
          {metric.detail && <span>{metric.detail}</span>}
          {resetLabel && <span className="usage-reset-label"><Clock aria-hidden="true" />{resetLabel}</span>}
        </div>
      </div>
    )
  }

  const renderProviderAccount = (accountKey: AccountKey) => {
    if (!realUsage) return null
    const account = realUsage.accounts[accountKey]
    const accountName = getAccountName(config, accountKey)
    const fetchedLabel = formatTimestamp(account.fetchedAt)
    const isActive = activeAccount === accountKey

    return (
      <article
        key={accountKey}
        className={`usage-provider-account usage-provider-account--${account.status}`}
        aria-label={`Uso do provedor para ${accountName}`}
      >
        <div className="usage-account-heading">
          <div className="usage-account-name-wrap">
            <span className={`usage-status-dot usage-status-dot--${account.status}`} aria-hidden="true" />
            <h3>{accountName}</h3>
            {isActive && <span className="usage-active-label">Conta ativa</span>}
          </div>
          <span className={`usage-status usage-status--${account.status}`}>
            {getProviderStatusIcon(account.status)}
            {getProviderStatusLabel(account)}
          </span>
        </div>

        {fetchedLabel && <p className="usage-account-meta">Consultada em {fetchedLabel}</p>}

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

  const renderManualAccount = (accountKey: AccountKey) => {
    if (!usage) return null
    const account = usage[accountKey]
    const accountName = getAccountName(config, accountKey)
    const percent = account.limit > 0
      ? Math.min(100, Math.max(0, Math.round((account.used / account.limit) * 100)))
      : 0
    const isWarning = percent >= 75 && percent < 100
    const isCritical = percent >= 100
    const remaining = getRemainingTime(account)
    const tone = isCritical
      ? 'usage-manual-account--critical'
      : isWarning
        ? 'usage-manual-account--warning'
        : ''
    const isActive = activeAccount === accountKey

    return (
      <article key={accountKey} className={`usage-manual-account ${tone} ${isActive ? 'usage-manual-account--active' : ''}`}>
        <div className="usage-account-heading">
          <div className="usage-account-name-wrap">
            <span className={`usage-status-dot ${isActive ? 'usage-status-dot--active' : ''}`} aria-hidden="true" />
            <h3>{accountName}</h3>
            {isActive && <span className="usage-active-label">Conta ativa</span>}
          </div>
          <span className="usage-estimate-label">Estimativa local</span>
        </div>

        <div className="usage-manual-figure">
          <div className="usage-manual-count-wrap">
            <strong className="usage-manual-count tabular-nums">{account.used}</strong>
            <span className="usage-manual-unit">/ {account.limit} sessões</span>
          </div>
          <span className="usage-window-label">janela de {account.windowDurationHours || 3}h</span>
        </div>

        <div
          className="usage-progress usage-progress--manual"
          role="progressbar"
          aria-label={`${accountName} — sessões estimadas`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className="usage-progress-fill" style={{ width: `${percent}%` }} />
        </div>

        <div className="usage-manual-status-row">
          <span className="usage-manual-status">
            {isCritical ? 'Limite atingido' : isWarning ? 'Limite próximo' : 'Dentro do limite'}
          </span>
          {remaining && (
            <span className="usage-reset-label">
              <Clock aria-hidden="true" />
              reseta em {remaining}
            </span>
          )}
        </div>

        <div className="usage-manual-controls" aria-label={`Controles da estimativa de ${accountName}`}>
          <div className="usage-stepper" role="group" aria-label={`Ajustar sessões de ${accountName}`}>
            <button
              type="button"
              className="usage-icon-button"
              onClick={() => void onDecrement(accountKey)}
              aria-label={`Diminuir uso de ${accountName}`}
              title="Diminuir sessão registrada"
            >
              <Minus aria-hidden="true" />
            </button>
            <span className="usage-stepper-value tabular-nums" aria-live="polite">{account.used}</span>
            <button
              type="button"
              className="usage-icon-button"
              onClick={() => void onIncrement(accountKey)}
              aria-label={`Aumentar uso de ${accountName}`}
              title="Aumentar sessão registrada"
            >
              <Plus aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            className="usage-button usage-button--quiet"
            onClick={() => void onReset(accountKey)}
            aria-label={`Zerar uso estimado de ${accountName}`}
          >
            <RotateCcw aria-hidden="true" />
            Zerar
          </button>
        </div>

        <div className="usage-limit-field">
          <label htmlFor={`usage-limit-${accountKey}`}>Limite de sessões por janela</label>
          <div className="usage-limit-input-wrap">
            <input
              id={`usage-limit-${accountKey}`}
              name={`usage-limit-${accountKey}`}
              type="number"
              min="5"
              max="200"
              inputMode="numeric"
              value={account.limit}
              onChange={(event) => void onUpdateLimit(
                accountKey,
                Number.parseInt(event.currentTarget.value, 10) || 40
              )}
            />
            <span>sessões</span>
          </div>
          <p>Janela local: {account.windowDurationHours || 3} horas.</p>
        </div>
      </article>
    )
  }

  const realFetchedLabel = formatTimestamp(realUsage?.fetchedAt)
  const providerSourceLabel = realUsage?.source === 'codex-oauth' ? 'OAuth do Codex' : 'Aguardando fonte'

  return (
    <section className="usage-panel" aria-labelledby="usage-heading" aria-busy={!usage || !realUsage || isRefreshingRealUsage}>
      <div className="usage-scroll">
        <div className="usage-shell">
          <header className="usage-header">
            <div className="usage-heading-copy">
              <h1 id="usage-heading">Uso e quotas</h1>
              <p>Acompanhe as janelas publicadas pelo provedor e mantenha uma referência local para alternar entre contas.</p>
            </div>
            <div className="usage-header-actions">
              <div className="usage-source-meta" aria-live="polite">
                <span>{providerSourceLabel}</span>
                {realFetchedLabel && <span>Atualizado em {realFetchedLabel}</span>}
              </div>
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
            <div className={`usage-handoff ${activePercent >= 100 ? 'usage-handoff--critical' : ''}`} role="status">
              <div className="usage-handoff-copy">
                <AlertTriangle aria-hidden="true" />
                <div>
                  <strong>{activePercent >= 100 ? 'Limite de sessões atingido!' : 'Limite de sessões próximo!'}</strong>
                  <span>A estimativa local da conta ativa chegou a {activePercent}%.</span>
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
              <div>
                <h2 id="usage-provider-heading">Quotas do provedor</h2>
                <p>Percentuais, janelas e estados retornados na última consulta.</p>
              </div>
              <span className="usage-section-note">Fonte primária</span>
            </div>

            {realUsage ? (
              <div className="usage-provider-grid">
                {accountKeys.map(renderProviderAccount)}
              </div>
            ) : (
              <div className="usage-loading" role="status" aria-live="polite">
                <RefreshCw className="usage-loading-icon usage-spin" aria-hidden="true" />
                <div>
                  <strong>Consultando quotas do provedor…</strong>
                  <span>Os dados aparecerão quando a primeira consulta terminar.</span>
                </div>
              </div>
            )}
          </section>

          <details className="usage-details">
            <summary className="usage-details-summary">
              <span className="usage-details-summary-copy">
                <span className="usage-details-title"><Settings2 aria-hidden="true" />Estimativas locais</span>
                <span className="usage-details-description">Contador ajustável para orientar a alternância de contas.</span>
              </span>
              <span className="usage-details-summary-note">Secundário</span>
              <ChevronDown className="usage-details-chevron" aria-hidden="true" />
            </summary>

            <div className="usage-details-body">
              <p className="usage-details-disclaimer">Estes números são registros locais e não representam tokens ou quotas oficiais do provedor.</p>
              {usage ? (
                <div className="usage-manual-grid">
                  {accountKeys.map(renderManualAccount)}
                  <article className="usage-antigravity">
                    <div className="usage-antigravity-copy">
                      <span className="usage-antigravity-icon"><Sparkles aria-hidden="true" /></span>
                      <div>
                        <h3>Antigravity</h3>
                        <p>Sessões registradas localmente.</p>
                      </div>
                    </div>
                    <div className="usage-antigravity-actions">
                      <strong className="usage-antigravity-count tabular-nums">{usage.antigravity.sessionCount}</strong>
                      <span>sessões</span>
                      <button
                        type="button"
                        className="usage-icon-button usage-icon-button--accent"
                        onClick={() => void onIncrement('antigravity')}
                        aria-label="Aumentar sessões registradas do Antigravity"
                        title="Aumentar sessão registrada"
                      >
                        <Plus aria-hidden="true" />
                      </button>
                    </div>
                  </article>
                </div>
              ) : (
                <div className="usage-manual-loading" role="status">Carregando estimativas locais…</div>
              )}
            </div>
          </details>
        </div>
      </div>
    </section>
  )
}
