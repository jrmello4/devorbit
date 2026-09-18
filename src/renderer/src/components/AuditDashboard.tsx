import React, { useId, useMemo } from 'react'
import { Activity, ClipboardCheck, Clock3, FileCheck2, TrendingDown, TrendingUp } from 'lucide-react'
import './EvolutionPanels.css'

export type AuditCategory = 'audit' | 'debt' | 'gain'
export type AuditStatus = 'open' | 'in-progress' | 'resolved' | 'verified'
export type AuditSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical'

export interface AuditEntry {
  id: string
  category: AuditCategory
  title: string
  description: string
  status: AuditStatus
  severity?: AuditSeverity
  evidence?: string
  value?: {
    amount: number
    unit: string
  }
}

export interface AuditDashboardData {
  entries: readonly AuditEntry[]
  updatedAt?: string
  telemetry?: { spans: number; errors: number; averageDurationMs: number }
}

export interface AuditCategoryMetrics {
  total: number
  resolved: number
  open: number
}

export interface AuditGainMetrics {
  total: number
  confirmed: number
  pending: number
  valueByUnit: Readonly<Record<string, number>>
}

export interface AuditDashboardMetrics {
  total: number
  audit: AuditCategoryMetrics
  debt: AuditCategoryMetrics
  gain: AuditGainMetrics
}

function isResolved(status: AuditStatus): boolean {
  return status === 'resolved' || status === 'verified'
}

const severityOrder: Record<AuditSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
}

/** Ordena por gravidade (crítico primeiro) e depois por título. */
export function sortAuditEntries(entries: readonly AuditEntry[]): AuditEntry[] {
  return [...entries].sort((left, right) => {
    const bySeverity = severityOrder[left.severity || 'info'] - severityOrder[right.severity || 'info']
    if (bySeverity !== 0) return bySeverity
    return left.title.localeCompare(right.title, 'pt-BR')
  })
}

export type AuditSeverityFilter = AuditSeverity | 'all'

/** Filtra por categoria e, opcionalmente, por gravidade (débitos). */
export function filterAuditEntries(
  entries: readonly AuditEntry[],
  category: AuditCategory,
  severity: AuditSeverityFilter = 'all',
): AuditEntry[] {
  return sortAuditEntries(entries.filter((entry) => entry.category === category && (severity === 'all' || (entry.severity || 'info') === severity)))
}

export function countBySeverity(entries: readonly AuditEntry[]): Record<AuditSeverity, number> {
  const counts: Record<AuditSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  for (const entry of entries) counts[entry.severity || 'info'] += 1
  return counts
}

function getCategoryMetrics(entries: readonly AuditEntry[], category: 'audit' | 'debt'): AuditCategoryMetrics {
  const scopedEntries = entries.filter((entry) => entry.category === category)
  const resolved = scopedEntries.filter((entry) => isResolved(entry.status)).length
  return {
    total: scopedEntries.length,
    resolved,
    open: scopedEntries.length - resolved,
  }
}

export function calculateAuditMetrics(entries: readonly AuditEntry[]): AuditDashboardMetrics {
  const gainEntries = entries.filter((entry) => entry.category === 'gain')
  const valueByUnit: Record<string, number> = {}

  for (const entry of gainEntries) {
    const amount = entry.value?.amount
    const unit = entry.value?.unit.trim()
    if (typeof amount !== 'number' || !Number.isFinite(amount) || !unit) continue
    valueByUnit[unit] = (valueByUnit[unit] || 0) + amount
  }

  const confirmed = gainEntries.filter((entry) => entry.status === 'verified').length
  return {
    total: entries.length,
    audit: getCategoryMetrics(entries, 'audit'),
    debt: getCategoryMetrics(entries, 'debt'),
    gain: {
      total: gainEntries.length,
      confirmed,
      pending: gainEntries.length - confirmed,
      valueByUnit,
    },
  }
}

const categoryDetails: Record<AuditCategory, {
  title: string
  description: string
  Icon: typeof ClipboardCheck
}> = {
  audit: {
    title: 'Revisões',
    description: 'Revisões já registradas neste projeto.',
    Icon: ClipboardCheck,
  },
  debt: {
    title: 'Problemas encontrados',
    description: 'Itens que ainda precisam de correção, do mais grave ao mais leve.',
    Icon: TrendingDown,
  },
  gain: {
    title: 'Melhorias registradas',
    description: 'Resultados alcançados depois das correções.',
    Icon: TrendingUp,
  },
}

const statusLabels: Record<AuditStatus, string> = {
  open: 'Em aberto',
  'in-progress': 'Em andamento',
  resolved: 'Resolvido',
  verified: 'Verificado',
}

const severityLabels: Record<AuditSeverity, string> = {
  info: 'Informativo',
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  critical: 'Crítico',
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(value)
}

function formatGainValues(valueByUnit: Readonly<Record<string, number>>): string {
  const values = Object.entries(valueByUnit)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([unit, amount]) => formatNumber(amount) + ' ' + unit)
  return values.length > 0 ? values.join(' · ') : 'Sem valor informado'
}

interface MetricCardProps {
  label: string
  value: string
  detail: string
  explanation: string
  tone: 'neutral' | 'warning' | 'positive'
  Icon: typeof ClipboardCheck
}

const MetricCard: React.FC<MetricCardProps> = ({ label, value, detail, explanation, tone, Icon }) => (
  <article className="evolution-metric-card" data-tone={tone}>
    <div className="evolution-metric-card__header">
      <span>{label}</span>
      <Icon aria-hidden="true" />
    </div>
    <strong className="evolution-metric-card__value">{value}</strong>
    <span className="evolution-metric-card__detail">{detail}</span>
    <p>{explanation}</p>
  </article>
)

interface EntryListProps {
  category: AuditCategory
  entries: readonly AuditEntry[]
  severityFilter?: AuditSeverityFilter
  onSeverityFilterChange?: (severity: AuditSeverityFilter) => void
}

const EntryList: React.FC<EntryListProps> = ({ category, entries, severityFilter = 'all', onSeverityFilterChange }) => {
  const details = categoryDetails[category]
  const Icon = details.Icon
  const categoryEntries = entries.filter((entry) => entry.category === category)
  const visibleEntries = filterAuditEntries(entries, category, category === 'debt' ? severityFilter : 'all')
  const severityCounts = countBySeverity(categoryEntries)
  const showFilter = category === 'debt' && categoryEntries.length > 8 && onSeverityFilterChange

  const filterOptions: Array<{ value: AuditSeverityFilter; label: string }> = [
    { value: 'all', label: 'Todos' },
    { value: 'critical', label: 'Críticos' },
    { value: 'high', label: 'Altos' },
    { value: 'medium', label: 'Médios' },
    { value: 'low', label: 'Baixos' },
  ]

  return (
    <section className="evolution-entry-section" aria-labelledby={'audit-section-' + category}>
      <header className="evolution-entry-section__header">
        <div>
          <span className="evolution-dialog__eyebrow">
            <Icon aria-hidden="true" />
            {details.title}
          </span>
          <h2 id={'audit-section-' + category}>{details.title}</h2>
          <p>{details.description}</p>
        </div>
        <span className="evolution-count-badge" aria-label={categoryEntries.length + ' itens'}>{categoryEntries.length}</span>
      </header>
      {showFilter && (
        <div className="evolution-severity-filter" role="group" aria-label="Filtrar por gravidade">
          {filterOptions.map((option) => {
            const count = option.value === 'all' ? categoryEntries.length : severityCounts[option.value]
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={severityFilter === option.value}
                onClick={() => onSeverityFilterChange(option.value)}
              >
                {option.label} <small>{count}</small>
              </button>
            )
          })}
        </div>
      )}
      {visibleEntries.length > 0 ? (
        <>
          {category === 'debt' && severityFilter !== 'all' && (
            <p className="evolution-entry-filter-note">
              Mostrando {visibleEntries.length} de {categoryEntries.length} problemas.
            </p>
          )}
          <div className="evolution-entry-list">
            {visibleEntries.map((entry) => {
              const severity = entry.severity || 'info'
              return (
                <article className="evolution-entry" data-severity={severity} key={entry.id}>
                  <div className="evolution-entry__topline">
                    <span className="evolution-status" data-status={entry.status}>
                      {statusLabels[entry.status]}
                    </span>
                    <span className="evolution-severity" data-severity={severity}>
                      {severityLabels[severity]}
                    </span>
                  </div>
                  <h3>{entry.title}</h3>
                  <p>{entry.description}</p>
                  {entry.evidence && (
                    <p className="evolution-entry__evidence">
                      <strong>Onde:</strong> {entry.evidence}
                    </p>
                  )}
                  {entry.value && Number.isFinite(entry.value.amount) && entry.value.unit.trim() && (
                    <p className="evolution-entry__value">
                      Tempo estimado: {formatNumber(entry.value.amount)} {entry.value.unit}
                    </p>
                  )}
                </article>
              )
            })}
          </div>
        </>
      ) : (
        <p className="evolution-empty">Nenhum item nesta categoria.</p>
      )}
    </section>
  )
}

export interface AuditDashboardProps {
  data: AuditDashboardData
  className?: string
}

export const AuditDashboard: React.FC<AuditDashboardProps> = ({ data, className = '' }) => {
  const metrics = useMemo(() => calculateAuditMetrics(data.entries), [data.entries])
  const headingId = useId()
  const [debtSeverity, setDebtSeverity] = React.useState<AuditSeverityFilter>('all')
  const updatedLabel = data.updatedAt ? 'Atualizado em ' + data.updatedAt : 'Atualização não informada'

  return (
    <main className={'evolution-dashboard ' + className.trim()} aria-labelledby={headingId}>
      <header className="evolution-dashboard__header">
        <div>
          <span className="evolution-dialog__eyebrow">
            <FileCheck2 aria-hidden="true" />
            Revisão do projeto
          </span>
          <h1 id={headingId}>Auditoria</h1>
          <p>Problemas encontrados e melhorias registradas neste projeto.</p>
        </div>
        <time className="evolution-dashboard__updated">{updatedLabel}</time>
      </header>

      <section className="evolution-metric-grid" aria-label="Resumo da auditoria">
        <MetricCard
          label="Revisões"
          value={String(metrics.audit.total)}
          detail={metrics.audit.resolved + ' concluídas · ' + metrics.audit.open + ' em andamento'}
          explanation="Revisões já feitas neste projeto."
          tone="neutral"
          Icon={ClipboardCheck}
        />
        <MetricCard
          label="Problemas em aberto"
          value={String(metrics.debt.open)}
          detail={metrics.debt.resolved + ' corrigidos de ' + metrics.debt.total}
          explanation="Itens que ainda precisam de correção."
          tone="warning"
          Icon={Clock3}
        />
        <MetricCard
          label="Melhorias registradas"
          value={String(metrics.gain.total)}
          detail={metrics.gain.confirmed + ' confirmadas · ' + metrics.gain.pending + ' pendentes'}
          explanation={'Tempo economizado: ' + formatGainValues(metrics.gain.valueByUnit) + '.'}
          tone="positive"
          Icon={TrendingUp}
        />
        <MetricCard
          label="Atividade"
          value={String(data.telemetry?.spans || 0)}
          detail={(data.telemetry?.errors || 0) + ' falhas · ' + Math.round(data.telemetry?.averageDurationMs || 0) + ' ms em média'}
          explanation="Ações recentes do aplicativo neste projeto."
          tone={data.telemetry?.errors ? 'warning' : 'neutral'}
          Icon={Activity}
        />
      </section>

      <div className="evolution-entry-grid">
        <EntryList category="audit" entries={data.entries} />
        <EntryList
          category="debt"
          entries={data.entries}
          severityFilter={debtSeverity}
          onSeverityFilterChange={setDebtSeverity}
        />
        <EntryList category="gain" entries={data.entries} />
      </div>
    </main>
  )
}
