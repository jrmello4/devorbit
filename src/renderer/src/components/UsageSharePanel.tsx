import React, { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type {
  UsageQuotaSnapshotView,
  UsageShareState,
  UsageShareWindowId,
} from '../../../shared/usage-contract'
import {
  computeUsageRows,
  formatRelativeReset,
  formatTokenCount,
  summarizeAdapters,
  type UsageShareRow,
} from './usage-share-helpers'

const windowOptions: Array<{ id: UsageShareWindowId; label: string }> = [
  { id: 'day', label: 'Hoje' },
  { id: 'week', label: '7 dias' },
  { id: 'all', label: 'Tudo' },
]

const EMPTY_STATE_MESSAGE = 'O uso aparece aqui conforme você trabalha com os agentes.'
const UNAVAILABLE_MESSAGE = 'O acompanhamento de uso não está disponível neste momento.'

const formatProviderLabel = (provider: string) =>
  provider.length > 0 ? provider.charAt(0).toUpperCase() + provider.slice(1) : provider

const formatPercentLabel = (percent: number) => `${String(percent).replace('.', ',')}%`

const formatAccountLabel = (accountId: string | undefined) => {
  if (!accountId) return 'Conta'
  const match = /^account(\d+)$/i.exec(accountId)
  return match ? `Conta ${match[1]}` : accountId
}

const formatGeneratedAt = (generatedAt: string): string | null => {
  const time = Date.parse(generatedAt)
  if (Number.isNaN(time)) return null
  return new Date(time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

/** Janela vazia: nenhum evento (turno, token ou quota) em nenhuma janela. */
const hasAnyEvent = (state: UsageShareState) =>
  state.quota.length > 0 ||
  Object.values(state.windows).some(
    (entry) => entry.models.length > 0 || entry.totalTokens > 0 || entry.totalTurns > 0,
  )

const renderShareRow = (row: UsageShareRow) => (
  <li key={`${row.provider}-${row.model}`} className="usage-share-row">
    <div className="usage-share-row-head">
      <span className="usage-share-model" title={`${row.model} · ${formatProviderLabel(row.provider)}`}>{row.model}</span>
      <span className="usage-share-tokens tabular-nums">{formatTokenCount(row.totalTokens)} tokens</span>
      <span className="usage-share-percent tabular-nums">{formatPercentLabel(row.percent)}</span>
    </div>
    <div
      className="usage-share-bar"
      role="progressbar"
      aria-label={`Participação do modelo ${row.model}`}
      aria-valuenow={Math.round(row.percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${formatPercentLabel(row.percent)} dos tokens`}
    >
      <div className="usage-share-bar-fill" style={{ width: `${Math.min(100, Math.max(0, row.percent))}%` }} />
    </div>
    <div className="usage-share-row-meta">
      <span>
        {formatProviderLabel(row.provider)} · Entrada {formatTokenCount(row.inputTokens)} · Saída {formatTokenCount(row.outputTokens)} · Cache {formatTokenCount(row.cacheTokens)}
      </span>
      <span>{row.turns === 1 ? '1 turno' : `${row.turns} turnos`}</span>
    </div>
  </li>
)

/** Percent principal do card: primeira janela com número publicado. */
const getPrimaryQuotaPercent = (snapshot: UsageQuotaSnapshotView): number | undefined =>
  snapshot.windows.find((entry) => typeof entry.percent === 'number' && Number.isFinite(entry.percent))?.percent

const getQuotaTone = (percent: number | undefined) => {
  if (percent === undefined) return 'usage-share-quota-dot--muted'
  if (percent >= 90) return 'usage-share-quota-dot--critical'
  if (percent >= 75) return 'usage-share-quota-dot--warning'
  return 'usage-share-quota-dot--ok'
}

const renderQuotaCard = (snapshot: UsageQuotaSnapshotView, now: number) => {
  const primaryPercent = getPrimaryQuotaPercent(snapshot)
  const tone = getQuotaTone(primaryPercent)

  return (
    <div
      key={`${snapshot.provider}-${snapshot.accountId ?? 'default'}`}
      className="usage-share-quota-card"
    >
      <div className="usage-share-quota-head">
        <span
          className={`usage-share-quota-dot ${tone}`}
          title={primaryPercent === undefined ? 'Sem quota publicada' : `${formatPercentLabel(primaryPercent)} na janela principal`}
          aria-hidden="true"
        />
        <span className="usage-share-quota-account">
          {formatProviderLabel(snapshot.provider)} · {formatAccountLabel(snapshot.accountId)}
        </span>
        {primaryPercent !== undefined && (
          <span className="usage-share-quota-percent tabular-nums">{formatPercentLabel(primaryPercent)}</span>
        )}
      </div>

      {primaryPercent !== undefined && (
        <div
          className="usage-progress usage-share-quota-bar"
          role="progressbar"
          aria-label={`Quota de ${formatProviderLabel(snapshot.provider)} ${formatAccountLabel(snapshot.accountId)}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(primaryPercent)}
        >
          <div
            className={`usage-progress-fill ${primaryPercent >= 90 ? 'usage-progress-fill--critical' : primaryPercent >= 75 ? 'usage-progress-fill--warning' : ''}`}
            style={{ width: `${Math.min(100, Math.max(0, primaryPercent))}%` }}
          />
        </div>
      )}

      {/* Janelas (5h/semanal) como linhas limpas: rótulo · % · renovação */}
      <ul className="usage-share-quota-windows">
        {snapshot.windows.map((entry, index) => {
          const resetLabel = formatRelativeReset(entry.resetAt, now)
          return (
            <li key={entry.id || entry.label || index}>
              <span>{entry.label}</span>
              <span className="tabular-nums">
                {typeof entry.percent === 'number' && Number.isFinite(entry.percent) ? formatPercentLabel(entry.percent) : '—'}
                {resetLabel ? ` · ${resetLabel}` : ''}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export interface UsageSharePanelProps {
  initialState?: UsageShareState | null
  initialLoading?: boolean
}

export const UsageSharePanel: React.FC<UsageSharePanelProps> = ({
  initialState = null,
  initialLoading,
}) => {
  const [state, setState] = useState<UsageShareState | null>(initialState)
  const [isLoading, setIsLoading] = useState(initialLoading ?? !initialState)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isUnavailable, setIsUnavailable] = useState(false)
  const [selectedWindow, setSelectedWindow] = useState<UsageShareWindowId>('day')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (initialState !== null && initialLoading === false) return
    if (!window?.devorbit?.getUsageShare) return
    let cancelled = false
    window.devorbit
      .getUsageShare()
      .then((share) => {
        if (cancelled) return
        setState(share)
        setIsUnavailable(false)
      })
      .catch(() => {
        if (cancelled) return
        setIsUnavailable(true)
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    try {
      const share = await window.devorbit.refreshUsage()
      setState(share)
      setIsUnavailable(false)
    } catch {
      setIsUnavailable(true)
    } finally {
      setIsRefreshing(false)
    }
  }, [])

  const activeShareWindow = state?.windows[selectedWindow]
  const rows = activeShareWindow ? computeUsageRows(activeShareWindow) : []
  const isEmpty = state ? !hasAnyEvent(state) : false
  const adaptersSummary = state ? summarizeAdapters(state.adapters) : ''
  const generatedLabel = state ? formatGeneratedAt(state.generatedAt) : null

  return (
    <section className="usage-share usage-section" aria-labelledby="usage-share-heading">
      {/* Cabeçalho único: título + janela + atualizar */}
      <div className="usage-section-heading">
        <h2 id="usage-share-heading">Uso por modelo</h2>
        <div className="usage-share-toolbar">
          <div className="usage-share-segmented" role="group" aria-label="Janela de uso">
            {windowOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={selectedWindow === option.id}
                onClick={() => setSelectedWindow(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="usage-button usage-button--quiet"
            onClick={() => void handleRefresh()}
            disabled={isRefreshing}
            aria-busy={isRefreshing}
            aria-label={isRefreshing ? 'Atualizando uso por modelo' : 'Atualizar uso por modelo'}
          >
            <RefreshCw className={isRefreshing ? 'usage-spin' : ''} aria-hidden="true" />
            {isRefreshing ? 'Atualizando…' : 'Atualizar'}
          </button>
        </div>
      </div>

      {isLoading ? (
        <p className="usage-share-note" role="status">Consultando uso…</p>
      ) : isUnavailable || !state ? (
        <p className="usage-share-note" role="status">{UNAVAILABLE_MESSAGE}</p>
      ) : isEmpty ? (
        <p className="usage-share-note">{EMPTY_STATE_MESSAGE}</p>
      ) : (
        <>
          {rows.length > 0 ? (
            <ul className="usage-share-rows" role="list" aria-label="Participação de uso por modelo">
              {rows.map(renderShareRow)}
            </ul>
          ) : (
            <p className="usage-share-note">Sem registros nesta janela.</p>
          )}

          {state.quota.length > 0 && (
            <div className="usage-share-quota">
              <h3>Quota por conta</h3>
              <div className="usage-share-quota-grid">
                {state.quota.map((snapshot) => renderQuotaCard(snapshot, now))}
              </div>
            </div>
          )}

          {(adaptersSummary || generatedLabel) && (
            <footer className="usage-share-footer">
              {adaptersSummary && <span>{adaptersSummary}</span>}
              {generatedLabel && <span>Dados de {generatedLabel}</span>}
            </footer>
          )}
        </>
      )}
    </section>
  )
}
