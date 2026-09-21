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
  <div key={`${row.provider}-${row.model}`} className="usage-share-row">
    <div className="usage-share-row-head">
      <span className="usage-share-model" title={row.model}>{row.model}</span>
      <span className="usage-share-provider">{formatProviderLabel(row.provider)}</span>
      <span className="usage-share-tokens tabular-nums">{formatTokenCount(row.totalTokens)} tokens</span>
      <span className="usage-share-percent tabular-nums">{formatPercentLabel(row.percent)}</span>
    </div>
    <div className="usage-share-bar" aria-hidden="true">
      <div className="usage-share-bar-fill" style={{ width: `${Math.min(100, Math.max(0, row.percent))}%` }} />
    </div>
    <div className="usage-share-row-meta">
      <span>
        Entrada {formatTokenCount(row.inputTokens)} · Saída {formatTokenCount(row.outputTokens)} · Cache {formatTokenCount(row.cacheTokens)}
      </span>
      <span>{row.turns === 1 ? '1 turno' : `${row.turns} turnos`}</span>
    </div>
  </div>
)

const renderQuotaChip = (snapshot: UsageQuotaSnapshotView, now: number) => {
  const windowParts = snapshot.windows.map((entry) => (
    typeof entry.percent === 'number' && Number.isFinite(entry.percent)
      ? `${entry.label}: ${formatPercentLabel(entry.percent)}`
      : entry.label
  ))
  const nextResetAt = snapshot.windows
    .map((entry) => entry.resetAt)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .find((value) => Date.parse(value) > now)
  const resetLabel = formatRelativeReset(nextResetAt, now)

  return (
    <div
      key={`${snapshot.provider}-${snapshot.accountId ?? 'default'}`}
      className="usage-share-chip"
    >
      <span className="usage-share-chip-account">
        {formatProviderLabel(snapshot.provider)} · {formatAccountLabel(snapshot.accountId)}
      </span>
      {windowParts.length > 0 && <span className="usage-share-chip-windows">{windowParts.join(' · ')}</span>}
      {resetLabel && <span className="usage-share-chip-reset tabular-nums">{resetLabel}</span>}
    </div>
  )
}

/**
 * Seção "Uso por modelo": participação de cada modelo (Claude, Codex,
 * OpenCode, Gemini/Antigravity ou preset futuro) por janela, quota por conta
 * e estado dos adaptadores. Busca via preload (getUsageShare/refreshUsage).
 */
export const UsageSharePanel: React.FC = () => {
  const [state, setState] = useState<UsageShareState | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isUnavailable, setIsUnavailable] = useState(false)
  const [selectedWindow, setSelectedWindow] = useState<UsageShareWindowId>('day')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
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
      <div className="usage-section-heading">
        <div>
          <h2 id="usage-share-heading">Uso por modelo</h2>
          <p>Participação de cada modelo nos turnos e tokens registrados localmente.</p>
        </div>
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
            <div className="usage-share-rows">{rows.map(renderShareRow)}</div>
          ) : (
            <p className="usage-share-note">Sem registros nesta janela.</p>
          )}

          {state.quota.length > 0 && (
            <div className="usage-share-quota">
              <h3>Quota por conta</h3>
              <div className="usage-share-chips">
                {state.quota.map((snapshot) => renderQuotaChip(snapshot, now))}
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
