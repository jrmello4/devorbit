import React, { useState, useId, useRef } from 'react'
import {
  RefreshCw,
  Search,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Key,
  ShieldAlert,
  Zap,
  Info,
  Trash2,
} from 'lucide-react'
import type {
  AiUsagebarApiKeyChange,
  AiUsagebarEntry,
  AiUsagebarMetric,
  AiUsagebarMetricSection,
  AiUsagebarProviderChange,
  AiUsagebarSection,
  AiUsagebarSnapshot,
  AiUsagebarVendor,
} from '../../../shared/ai-usagebar-contract'
import './AiUsagebarProviderPanel.css'

export interface AiUsagebarProviderPanelProps {
  snapshot?: AiUsagebarSnapshot | null
  loading?: boolean
  refreshing?: boolean
  detecting?: boolean
  onRefresh?: () => void | Promise<void>
  onDetect?: () => void | Promise<void>
  onToggleProvider?: (change: AiUsagebarProviderChange) => void | Promise<void>
  onSubmitApiKey?: (change: AiUsagebarApiKeyChange) => void | Promise<void>
  onRemoveApiKey?: (vendorId: string) => void | Promise<void>
  className?: string
  initialPendingToggles?: Record<string, boolean>
}

/**
 * Executa o toggle de provider garantindo bloqueio contra cliques concorrentes
 * no mesmo vendor enquanto a promise estiver pendente. Limpa o estado em finally
 * e preserva captura de erros.
 */
export async function executeVendorToggle(
  vendorId: string,
  enabled: boolean,
  pendingMap: Record<string, boolean>,
  setPending: (vendorId: string, isPending: boolean) => void,
  setActionError: (msg: string) => void,
  onToggleProvider?: (change: AiUsagebarProviderChange) => void | Promise<void>
): Promise<boolean> {
  if (pendingMap[vendorId] === true) return false
  setActionError('')
  setPending(vendorId, true)
  try {
    await onToggleProvider?.({ vendorId, enabled })
    return true
  } catch (error) {
    setActionError(
      error instanceof Error ? error.message : 'Falha ao alterar status do provedor.'
    )
    return false
  } finally {
    setPending(vendorId, false)
  }
}

/** Valida e remove espaços da chave de API antes do envio. */
export function validateAndTrimApiKey(raw: string): { ok: true; apiKey: string } | { ok: false; error: string } {
  const key = (raw || '').trim()
  if (!key) {
    return { ok: false, error: 'Informe uma chave não vazia.' }
  }
  if (key.length > 8192 || /[\r\n\0]/.test(key)) {
    return { ok: false, error: 'A chave informada é inválida ou contém quebras de linha.' }
  }
  return { ok: true, apiKey: key }
}

/**
 * Texto genérico para erro por entry: nunca injeta `entry.error` cru
 * (path/body do upstream) no DOM. O status/card do provider segue indicando
 * a falha específica.
 */
export const ENTRY_ERROR_FALLBACK =
  'Não foi possível consultar este provedor. Verifique credenciais e configuração.'

/** Formata exibição da métrica respeitando metric.headline ('value' vs 'percent'). */
export function formatMetricDisplay(metric: AiUsagebarMetric): {
  headlineType: 'value' | 'percent'
  primaryText: string
  secondaryText?: string
  percent?: number
} {
  const isValueHeadline = metric.headline === 'value'
  const hasValue =
    metric.value !== undefined && metric.value !== null && String(metric.value).trim() !== ''
  const hasPercent = typeof metric.percent === 'number' && !Number.isNaN(metric.percent)

  if (isValueHeadline && hasValue) {
    return {
      headlineType: 'value',
      primaryText: String(metric.value),
      secondaryText: metric.detail || (hasPercent ? `${Math.round(metric.percent!)}%` : undefined),
      percent: hasPercent ? metric.percent : undefined,
    }
  }

  if (hasPercent) {
    return {
      headlineType: 'percent',
      primaryText: `${Math.round(metric.percent!)}%`,
      secondaryText: hasValue ? String(metric.value) : metric.detail,
      percent: metric.percent,
    }
  }

  return {
    headlineType: 'value',
    primaryText: hasValue ? String(metric.value) : metric.detail || '—',
    secondaryText: metric.detail && hasValue ? metric.detail : undefined,
  }
}

/** Mapeia a severidade para tom visual (ok, mid, warning, critical, default). */
export function mapSeverityTone(severity?: string, percent?: number): string {
  if (severity) {
    const s = severity.toLowerCase()
    if (s.includes('critical') || s.includes('danger') || s.includes('red')) return 'critical'
    if (s.includes('high') || s.includes('warn') || s.includes('orange') || s.includes('amber')) {
      return 'warning'
    }
    if (s.includes('mid') || s.includes('yellow')) return 'mid'
    if (
      s.includes('low') ||
      s.includes('ok') ||
      s.includes('good') ||
      s.includes('green') ||
      s.includes('blue')
    ) {
      return 'ok'
    }
  }
  if (typeof percent === 'number') {
    if (percent >= 90) return 'critical'
    if (percent >= 75) return 'warning'
    return 'ok'
  }
  return 'default'
}

/** Formata data de reset em formato legível local. */
export function formatResetTime(resetAt?: string): string | null {
  if (!resetAt) return null
  const time = Date.parse(resetAt)
  if (Number.isNaN(time)) return resetAt
  return new Date(time).toLocaleString('pt-BR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Formata duração da janela em segundos (ex: 5h, 7d). */
export function formatWindowDuration(windowSecs?: number): string | null {
  if (typeof windowSecs !== 'number' || windowSecs <= 0) return null
  if (windowSecs % 86400 === 0) return `${windowSecs / 86400}d`
  if (windowSecs % 3600 === 0) return `${windowSecs / 3600}h`
  if (windowSecs > 3600) {
    const h = Math.floor(windowSecs / 3600)
    const m = Math.floor((windowSecs % 3600) / 60)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  return `${Math.floor(windowSecs / 60)}m`
}

/** Formata dados de créditos de reset bancados caso disponíveis. */
export function formatResetCredits(credits: unknown): string | null {
  if (!credits || typeof credits !== 'object') return null
  const record = credits as Record<string, unknown>
  if (typeof record.available === 'number') {
    return `Resets disponíveis: ${record.available}`
  }
  if (typeof record.count === 'number') {
    return `Resets disponíveis: ${record.count}`
  }
  return 'Resets bancados disponíveis'
}

export const AiUsagebarProviderPanel: React.FC<AiUsagebarProviderPanelProps> = ({
  snapshot,
  loading = false,
  refreshing = false,
  detecting = false,
  onRefresh,
  onDetect,
  onToggleProvider,
  onSubmitApiKey,
  onRemoveApiKey,
  className = '',
  initialPendingToggles,
}) => {
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({})
  const [keyErrors, setKeyErrors] = useState<Record<string, string>>({})
  const [actionError, setActionError] = useState<string>('')
  const pendingTogglesRef = useRef<Record<string, boolean>>(
    initialPendingToggles ? { ...initialPendingToggles } : {}
  )
  const [pendingToggles, setPendingToggles] = useState<Record<string, boolean>>(
    initialPendingToggles || {}
  )
  const baseId = useId()

  const handleKeySubmit = async (vendorId: string, e: React.FormEvent) => {
    e.preventDefault()
    const raw = keyInputs[vendorId] || ''
    const validation = validateAndTrimApiKey(raw)
    if (!validation.ok) {
      setKeyErrors((prev) => ({ ...prev, [vendorId]: validation.error }))
      return
    }
    setKeyErrors((prev) => ({ ...prev, [vendorId]: '' }))
    // Regra estrita de segurança: input limpa imediatamente após submit e nunca exibe chave salva
    setKeyInputs((prev) => ({ ...prev, [vendorId]: '' }))

    try {
      await onSubmitApiKey?.({ vendorId, apiKey: validation.apiKey })
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Falha ao salvar a chave de API.'
      setKeyErrors((prev) => ({ ...prev, [vendorId]: msg }))
    }
  }

  const handleRemoveKey = async (vendorId: string) => {
    setKeyErrors((prev) => ({ ...prev, [vendorId]: '' }))
    try {
      await onRemoveApiKey?.(vendorId)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Falha ao remover a chave de API.'
      setKeyErrors((prev) => ({ ...prev, [vendorId]: msg }))
    }
  }

  const handleRefresh = async () => {
    setActionError('')
    try {
      await onRefresh?.()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Falha ao atualizar quotas de uso.')
    }
  }

  const handleDetect = async () => {
    setActionError('')
    try {
      await onDetect?.()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Falha ao detectar credenciais locais.')
    }
  }

  const handleToggle = async (vendorId: string, enabled: boolean) => {
    await executeVendorToggle(
      vendorId,
      enabled,
      pendingTogglesRef.current,
      (id, isPending) => {
        if (isPending) {
          pendingTogglesRef.current[id] = true
          setPendingToggles((prev) => ({ ...prev, [id]: true }))
        } else {
          delete pendingTogglesRef.current[id]
          setPendingToggles((prev) => {
            const next = { ...prev }
            delete next[id]
            return next
          })
        }
      },
      setActionError,
      onToggleProvider
    )
  }

  const entries = snapshot?.report?.entries || []
  const vendors = snapshot?.vendors || []
  const state = snapshot?.state || (loading ? 'starting' : 'unavailable')
  const isStale = snapshot?.stale === true
  const isEmpty = !loading && entries.length === 0 && vendors.length === 0

  return (
    <section
      className={`ai-usagebar-panel ${className}`.trim()}
      aria-labelledby={`${baseId}-panel-title`}
    >
      <header className="ai-usagebar-header">
        <div className="ai-usagebar-title-group">
          <h2 id={`${baseId}-panel-title`} className="ai-usagebar-title">
            Provedores & Quotas de IA
          </h2>
          {snapshot?.version && (
            <span className="ai-usagebar-version" title="Versão do ai-usagebar">
              v{snapshot.version}
            </span>
          )}
          <span
            className={`ai-usagebar-badge ai-usagebar-badge--${state}`}
            role="status"
            aria-label={`Status do serviço: ${state}`}
          >
            {state === 'ready' && <CheckCircle2 size={12} aria-hidden="true" />}
            {state === 'degraded' && <AlertTriangle size={12} aria-hidden="true" />}
            {(state === 'error' || state === 'unavailable') && (
              <AlertCircle size={12} aria-hidden="true" />
            )}
            {state}
          </span>
          {isStale && (
            <span className="ai-usagebar-badge ai-usagebar-badge--degraded" title="Dados em cache">
              Cache
            </span>
          )}
        </div>

        <div className="ai-usagebar-actions">
          {onDetect && (
            <button
              type="button"
              className="ai-usagebar-btn"
              onClick={() => void handleDetect()}
              disabled={detecting || loading}
              aria-label="Detectar credenciais locais"
            >
              <Search
                size={14}
                className={detecting ? 'ai-usagebar-spin' : ''}
                aria-hidden="true"
              />
              {detecting ? 'Detectando…' : 'Detectar'}
            </button>
          )}
          {onRefresh && (
            <button
              type="button"
              className="ai-usagebar-btn ai-usagebar-btn--primary"
              onClick={() => void handleRefresh()}
              disabled={refreshing || loading || detecting}
              aria-label="Atualizar quotas de uso"
            >
              <RefreshCw
                size={14}
                className={refreshing ? 'ai-usagebar-spin' : ''}
                aria-hidden="true"
              />
              {refreshing ? 'Atualizando…' : 'Atualizar'}
            </button>
          )}
        </div>
      </header>

      {/* Alerta de erro de ação assíncrona dispensável */}
      {actionError && (
        <div className="ai-usagebar-alert ai-usagebar-alert--error" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{actionError}</span>
          <button
            type="button"
            className="ai-usagebar-alert-dismiss"
            onClick={() => setActionError('')}
            aria-label="Dispensar aviso de erro"
          >
            ×
          </button>
        </div>
      )}

      {/* Alertas globais de status degraded / error */}
      {state === 'degraded' && (
        <div className="ai-usagebar-alert ai-usagebar-alert--warning" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>
            {snapshot?.message ||
              'O serviço de acompanhamento está degradado. Algumas métricas podem estar desatualizadas.'}
          </span>
        </div>
      )}

      {(state === 'error' || state === 'unavailable') && !loading && (
        <div className="ai-usagebar-alert ai-usagebar-alert--error" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>
            {snapshot?.message ||
              'O serviço ai-usagebar está indisponível ou encontrou erro de inicialização.'}
          </span>
        </div>
      )}

      {/* Estado Carregando */}
      {loading && !snapshot && (
        <div className="ai-usagebar-loading-container" role="status" aria-live="polite">
          <RefreshCw size={24} className="ai-usagebar-spin" aria-hidden="true" />
          <p>Consultando provedores e telemetria de uso…</p>
        </div>
      )}

      {/* Estado Vazio */}
      {isEmpty && (
        <div className="ai-usagebar-empty-container">
          <Info size={24} aria-hidden="true" />
          <p>Nenhum provedor configurado no momento.</p>
        </div>
      )}

      {/* Seção 1: Cards de Uso de Provedores Ativos */}
      {entries.length > 0 && (
        <div className="ai-usagebar-entries-container">
          <h3 className="ai-usagebar-section-title">Uso & Quotas</h3>
          <div className="ai-usagebar-entries-grid" role="list">
            {entries.map((entry) => {
              const displayName = entry.display_name || entry.name
              const hasError = entry.status === 'error' || Boolean(entry.error)
              const cardClass = [
                'ai-usagebar-entry-card',
                hasError ? 'ai-usagebar-entry-card--error' : '',
                entry.stale ? 'ai-usagebar-entry-card--stale' : '',
              ]
                .filter(Boolean)
                .join(' ')

              // Suporta seções ordenadas se existirem, senão converte metrics para seções
              const rawSections =
                entry.sections && Array.isArray(entry.sections) && entry.sections.length > 0
                  ? entry.sections
                  : (entry.metrics || [])
                      .filter((m): m is AiUsagebarMetric => Boolean(m && typeof m === 'object'))
                      .map(
                        (m): AiUsagebarMetricSection => ({
                          ...m,
                          type: 'metric',
                        })
                      )

              const sectionsToRender = rawSections.filter(
                (s): s is AiUsagebarSection => Boolean(s && typeof s === 'object')
              )

              return (
                <article key={entry.id} className={cardClass} role="listitem">
                  <div className="ai-usagebar-entry-head">
                    <div className="ai-usagebar-entry-identity">
                      {entry.icon && (
                        <span className="ai-usagebar-entry-icon" aria-hidden="true">
                          {entry.icon}
                        </span>
                      )}
                      <div>
                        <div className="ai-usagebar-entry-name">{displayName}</div>
                        {entry.brand && entry.brand !== entry.id && (
                          <div className="ai-usagebar-tag" title="Marca do provedor">
                            {entry.brand}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="ai-usagebar-entry-meta">
                      {entry.plan && (
                        <span className="ai-usagebar-tag ai-usagebar-tag--plan">{entry.plan}</span>
                      )}
                      {entry.stale && (
                        <span
                          className="ai-usagebar-tag ai-usagebar-tag--stale"
                          title="Resposta em cache"
                        >
                          Stale
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Banner de erro específico da entrada (texto genérico) */}
                  {hasError && (
                    <div className="ai-usagebar-entry-error-banner" role="alert">
                      <ShieldAlert size={14} aria-hidden="true" />
                      <span>{ENTRY_ERROR_FALLBACK}</span>
                    </div>
                  )}

                  {/* Lista de seções ordenadas e métricas */}
                  <div className="ai-usagebar-sections-list">
                    {sectionsToRender.map((section, idx) => {
                      if (!section || typeof section !== 'object') {
                        return null
                      }
                      const sectionType = typeof section.type === 'string' ? section.type : ''

                      if (sectionType === 'metric') {
                        const m = section as AiUsagebarMetricSection
                        const { headlineType, primaryText, secondaryText, percent } =
                          formatMetricDisplay(m)
                        const tone = mapSeverityTone(m.severity, percent)
                        const resetLabel = formatResetTime(m.reset_at)
                        const windowLabel = formatWindowDuration(m.window_secs)
                        const metricLabel = String(m.label || '')
                        const metricGroup = m.group ? String(m.group) : undefined

                        return (
                          <div
                            key={m.id || `${metricLabel}-${idx}`}
                            className="ai-usagebar-metric-row"
                          >
                            <div className="ai-usagebar-metric-head">
                              <div>
                                {metricGroup && (
                                  <span className="ai-usagebar-metric-group">[{metricGroup}]</span>
                                )}
                                <span className="ai-usagebar-metric-label">{metricLabel}</span>
                              </div>
                              <div className="ai-usagebar-metric-value-container">
                                <span className="ai-usagebar-metric-primary">{primaryText}</span>
                                {secondaryText && (
                                  <span className="ai-usagebar-metric-secondary">
                                    {headlineType === 'value'
                                      ? `(${secondaryText})`
                                      : secondaryText}
                                  </span>
                                )}
                              </div>
                            </div>

                            {typeof percent === 'number' && (
                              <div
                                className="ai-usagebar-progress-track"
                                role="progressbar"
                                aria-label={metricLabel || 'Quota'}
                                aria-valuenow={Math.min(100, Math.max(0, Math.round(percent)))}
                                aria-valuemin={0}
                                aria-valuemax={100}
                              >
                                <div
                                  className={`ai-usagebar-progress-fill ai-usagebar-progress-fill--${tone}`}
                                  style={{
                                    width: `${Math.min(100, Math.max(0, percent))}%`,
                                  }}
                                />
                              </div>
                            )}

                            {(resetLabel || windowLabel) && (
                              <div className="ai-usagebar-metric-footer">
                                {windowLabel && <span>Janela: {windowLabel}</span>}
                                {resetLabel && <span>Reseta: {resetLabel}</span>}
                              </div>
                            )}
                          </div>
                        )
                      }

                      if (sectionType === 'text') {
                        const rec = section as Record<string, unknown>
                        const label = rec.label !== undefined ? String(rec.label) : ''
                        const val = rec.value !== undefined ? String(rec.value) : ''
                        return (
                          <div key={`text-${idx}`} className="ai-usagebar-text-row">
                            <span className="ai-usagebar-text-label">{label}</span>
                            <span className="ai-usagebar-text-val">{val}</span>
                          </div>
                        )
                      }

                      if (sectionType === 'block') {
                        const rec = section as Record<string, unknown>
                        const label = rec.label !== undefined ? String(rec.label) : ''
                        const body = rec.body
                        const bodyLines = Array.isArray(body)
                          ? body.map((line) => String(line))
                          : [String(body ?? '')]
                        return (
                          <div key={`block-${idx}`} className="ai-usagebar-block-row">
                            <div className="ai-usagebar-block-label">{label}</div>
                            {bodyLines.map((line, lineIdx) => (
                              <p key={lineIdx} className="ai-usagebar-block-body">
                                {line}
                              </p>
                            ))}
                          </div>
                        )
                      }

                      if (sectionType === 'spacer') {
                        return <hr key={`spacer-${idx}`} className="ai-usagebar-spacer-row" />
                      }

                      // Seção desconhecida do upstream: exibe sem falhar
                      const rec = section as Record<string, unknown>
                      return (
                        <div key={`unknown-${idx}`} className="ai-usagebar-text-row">
                          <span className="ai-usagebar-text-label">
                            {String(rec.label || sectionType)}
                          </span>
                          <span className="ai-usagebar-text-val">
                            {String(rec.value || rec.text || '')}
                          </span>
                        </div>
                      )
                    })}
                  </div>

                  {/* Resets bancados estruturados */}
                  {entry.reset_credits !== undefined && entry.reset_credits !== null && (
                    <div className="ai-usagebar-reset-credits">
                      <Zap size={12} aria-hidden="true" />
                      <span>{formatResetCredits(entry.reset_credits)}</span>
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        </div>
      )}

      {/* Seção 2: Catálogo de Provedores e Configuração */}
      {vendors.length > 0 && (
        <div className="ai-usagebar-catalog-container">
          <h3 className="ai-usagebar-section-title">Catálogo de Provedores</h3>
          <div className="ai-usagebar-catalog-list" role="list">
            {vendors.map((vendor) => {
              const vendorInputId = `${baseId}-vendor-${vendor.id}`
              const keyInputId = `${baseId}-key-${vendor.id}`
              const isEnabled = vendor.enabled === true
              // Chave gerenciada SÓ para vendor apikey com env key declarado:
              // OAuth/local "configured" não é chave de API do DevOrbit.
              const acceptsKey =
                vendor.kind === 'apikey' &&
                typeof vendor.env === 'string' &&
                vendor.env.trim().length > 0

              return (
                <div key={vendor.id} className="ai-usagebar-vendor-row" role="listitem">
                  <div className="ai-usagebar-vendor-main">
                    <div className="ai-usagebar-vendor-info">
                      <span className="ai-usagebar-vendor-title">{vendor.name}</span>
                      {vendor.kind && (
                        <span className="ai-usagebar-tag">{String(vendor.kind)}</span>
                      )}
                      {vendor.configured !== undefined && (
                        <span
                          className={`ai-usagebar-tag ${vendor.configured ? 'ai-usagebar-tag--plan' : ''}`}
                        >
                          {vendor.configured ? 'Configurado' : 'Pendente'}
                        </span>
                      )}
                    </div>

                    {onToggleProvider && (
                      <label className="ai-usagebar-vendor-toggle">
                        <input
                          id={vendorInputId}
                          type="checkbox"
                          checked={isEnabled}
                          disabled={pendingToggles[vendor.id] === true}
                          aria-busy={pendingToggles[vendor.id] === true ? 'true' : undefined}
                          onChange={(e) => void handleToggle(vendor.id, e.target.checked)}
                          aria-label={`Habilitar ou desabilitar provedor ${vendor.name}`}
                        />
                        <span>{isEnabled ? 'Ativo' : 'Inativo'}</span>
                      </label>
                    )}
                  </div>

                  <div className="ai-usagebar-vendor-details">
                    {vendor.env && <span>Env: {String(vendor.env)}</span>}
                    {vendor.login && <span>Login: {String(vendor.login)}</span>}
                    {vendor.needs_credential && (
                      <span className="ai-usagebar-tag ai-usagebar-tag--stale">Requer chave</span>
                    )}
                  </div>

                  {/* Formulário de chave de API para provedores que a utilizam */}
                  {acceptsKey && (onSubmitApiKey || onRemoveApiKey) && (
                    <form
                      className="ai-usagebar-key-form"
                      onSubmit={(e) => void handleKeySubmit(vendor.id, e)}
                    >
                      {onSubmitApiKey && (
                        <>
                          <label htmlFor={keyInputId} className="sr-only">
                            Chave de API para {vendor.name}
                          </label>
                          <input
                            id={keyInputId}
                            type="password"
                            className="ai-usagebar-key-input"
                            placeholder="Adicionar ou atualizar chave de API..."
                            value={keyInputs[vendor.id] || ''}
                            onChange={(e) => {
                              const val = e.target.value
                              setKeyInputs((prev) => ({ ...prev, [vendor.id]: val }))
                            }}
                            autoComplete="off"
                            spellCheck="false"
                          />
                          <button type="submit" className="ai-usagebar-btn">
                            <Key size={12} aria-hidden="true" />
                            Salvar Chave
                          </button>
                        </>
                      )}
                      {vendor.configured && onRemoveApiKey && (
                        <button
                          type="button"
                          className="ai-usagebar-btn ai-usagebar-btn--danger"
                          onClick={() => void handleRemoveKey(vendor.id)}
                          aria-label={`Remover chave de API de ${vendor.name}`}
                        >
                          <Trash2 size={12} aria-hidden="true" />
                          Remover Chave
                        </button>
                      )}
                      {keyErrors[vendor.id] && (
                        <span className="ai-usagebar-key-error" role="alert">
                          <AlertCircle size={12} aria-hidden="true" />
                          {keyErrors[vendor.id]}
                        </span>
                      )}
                    </form>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}
