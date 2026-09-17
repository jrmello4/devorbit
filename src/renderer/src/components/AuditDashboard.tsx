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
    title: 'Auditoria',
    description: 'Achados registrados na revisão do workspace.',
    Icon: ClipboardCheck,
  },
  debt: {
    title: 'Débito',
    description: 'Itens que ainda precisam de uma decisão ou correção.',
    Icon: TrendingDown,
  },
  gain: {
    title: 'Ganho',
    description: 'Resultados registrados com unidade e evidência.',
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
}

const EntryList: React.FC<EntryListProps> = ({ category, entries }) => {
  const details = categoryDetails[category]
  const Icon = details.Icon
  const categoryEntries = entries.filter((entry) => entry.category === category)

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
        <span className="evolution-count-badge">{categoryEntries.length}</span>
      </header>
      {categoryEntries.length > 0 ? (
        <div className="evolution-entry-list">
          {categoryEntries.map((entry) => {
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
                    <strong>Evidência:</strong> {entry.evidence}
                  </p>
                )}
                {entry.value && Number.isFinite(entry.value.amount) && entry.value.unit.trim() && (
                  <p className="evolution-entry__value">
                    Ganho informado: {formatNumber(entry.value.amount)} {entry.value.unit}
                  </p>
                )}
              </article>
            )
          })}
        </div>
      ) : (
        <p className="evolution-empty">Nenhum registro nesta categoria.</p>
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
  const updatedLabel = data.updatedAt ? 'Atualizado em ' + data.updatedAt : 'Atualização não informada'

  return (
    <main className={'evolution-dashboard ' + className.trim()} aria-labelledby={headingId}>
      <header className="evolution-dashboard__header">
        <div>
          <span className="evolution-dialog__eyebrow">
            <FileCheck2 aria-hidden="true" />
            Visão explicável
          </span>
          <h1 id={headingId}>Auditoria e evolução</h1>
          <p>Contagens derivadas dos registros recebidos, com a fórmula visível em cada métrica.</p>
        </div>
        <time className="evolution-dashboard__updated">{updatedLabel}</time>
      </header>

      <section className="evolution-metric-grid" aria-label="Métricas do workspace">
        <MetricCard
          label="Auditoria"
          value={String(metrics.audit.total)}
          detail={metrics.audit.resolved + ' resolvidos · ' + metrics.audit.open + ' em aberto'}
          explanation="Total = registros com categoria de auditoria."
          tone="neutral"
          Icon={ClipboardCheck}
        />
        <MetricCard
          label="Débito aberto"
          value={String(metrics.debt.open)}
          detail={metrics.debt.resolved + ' resolvidos de ' + metrics.debt.total}
          explanation="Em aberto = total de débito − itens resolvidos."
          tone="warning"
          Icon={Clock3}
        />
        <MetricCard
          label="Ganho registrado"
          value={String(metrics.gain.total)}
          detail={metrics.gain.confirmed + ' confirmados · ' + metrics.gain.pending + ' pendentes'}
          explanation={'Soma dos valores informados: ' + formatGainValues(metrics.gain.valueByUnit) + '.'}
          tone="positive"
          Icon={TrendingUp}
        />
        <MetricCard
          label="Observabilidade"
          value={String(data.telemetry?.spans || 0)}
          detail={(data.telemetry?.errors || 0) + ' erros · ' + Math.round(data.telemetry?.averageDurationMs || 0) + ' ms médios'}
          explanation="Spans IPC persistidos com atributos sensíveis redigidos."
          tone={data.telemetry?.errors ? 'warning' : 'neutral'}
          Icon={Activity}
        />
      </section>

      <div className="evolution-entry-grid">
        <EntryList category="audit" entries={data.entries} />
        <EntryList category="debt" entries={data.entries} />
        <EntryList category="gain" entries={data.entries} />
      </div>
    </main>
  )
}
