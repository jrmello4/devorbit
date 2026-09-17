import { AUDIT_DEBT_SEVERITIES } from './audit-contract'
import type { AuditDebtSeverity, AuditSnapshot } from './audit-contract'

export type FindingSeverityCounts = {
  [severity in AuditDebtSeverity]: number
}

export interface AuditReportSummary {
  projectPath: string
  generatedAt: string
  filesScanned: number
  linesScanned: number
  cyclomaticComplexity: number
  debtMinutes: number
  findingCount: number
  findingCountsBySeverity: FindingSeverityCounts
}

/** `delta` is after minus before; `reduction` is before minus after. */
export interface GainMetric {
  before: number
  after: number
  delta: number
  reduction: number
}

export interface FindingSeverityComparison {
  before: FindingSeverityCounts
  after: FindingSeverityCounts
  delta: FindingSeverityCounts
  reduction: FindingSeverityCounts
}

export interface GainReport {
  version: 1
  projectPath: string
  before: AuditReportSummary
  after: AuditReportSummary
  debtMinutes: GainMetric
  findingCount: GainMetric
  complexity: GainMetric
  findingCountsBySeverity: FindingSeverityComparison
  coverageDelta?: number
}

/** The report contains only JSON primitives, arrays, and plain objects. */
export type JsonSafeGainReport = GainReport

function emptyFindingSeverityCounts(): FindingSeverityCounts {
  return { low: 0, medium: 0, high: 0, critical: 0 }
}

export function countFindingsBySeverity(snapshot: AuditSnapshot): FindingSeverityCounts {
  const counts = emptyFindingSeverityCounts()
  for (const finding of snapshot.findings) counts[finding.severity] += 1
  return counts
}

function subtractFindingSeverityCounts(left: FindingSeverityCounts, right: FindingSeverityCounts): FindingSeverityCounts {
  return {
    low: left.low - right.low,
    medium: left.medium - right.medium,
    high: left.high - right.high,
    critical: left.critical - right.critical,
  }
}

function summarizeSnapshot(snapshot: AuditSnapshot): AuditReportSummary {
  return {
    projectPath: snapshot.projectPath,
    generatedAt: snapshot.generatedAt,
    filesScanned: snapshot.filesScanned,
    linesScanned: snapshot.linesScanned,
    cyclomaticComplexity: snapshot.cyclomaticComplexity,
    debtMinutes: snapshot.estimatedDebtMinutes,
    findingCount: snapshot.findings.length,
    findingCountsBySeverity: countFindingsBySeverity(snapshot),
  }
}

function compareMetric(before: number, after: number): GainMetric {
  return {
    before,
    after,
    delta: after - before,
    reduction: before - after,
  }
}

export function createGainReport(beforeSnapshot: AuditSnapshot, afterSnapshot: AuditSnapshot, coverageDelta?: number): GainReport {
  const before = summarizeSnapshot(beforeSnapshot)
  const after = summarizeSnapshot(afterSnapshot)
  const findingCountsBySeverity: FindingSeverityComparison = {
    before: before.findingCountsBySeverity,
    after: after.findingCountsBySeverity,
    delta: subtractFindingSeverityCounts(after.findingCountsBySeverity, before.findingCountsBySeverity),
    reduction: subtractFindingSeverityCounts(before.findingCountsBySeverity, after.findingCountsBySeverity),
  }

  return {
    version: 1,
    projectPath: after.projectPath,
    before,
    after,
    debtMinutes: compareMetric(before.debtMinutes, after.debtMinutes),
    findingCount: compareMetric(before.findingCount, after.findingCount),
    complexity: compareMetric(before.cyclomaticComplexity, after.cyclomaticComplexity),
    findingCountsBySeverity,
    ...(coverageDelta === undefined ? {} : { coverageDelta }),
  }
}

export function toJsonSafeGainReport(report: GainReport): JsonSafeGainReport {
  const cloneSummary = (summary: AuditReportSummary): AuditReportSummary => ({
    ...summary,
    findingCountsBySeverity: { ...summary.findingCountsBySeverity },
  })
  const cloneMetric = (metric: GainMetric): GainMetric => ({ ...metric })

  return {
    version: report.version,
    projectPath: report.projectPath,
    before: cloneSummary(report.before),
    after: cloneSummary(report.after),
    debtMinutes: cloneMetric(report.debtMinutes),
    findingCount: cloneMetric(report.findingCount),
    complexity: cloneMetric(report.complexity),
    findingCountsBySeverity: {
      before: { ...report.findingCountsBySeverity.before },
      after: { ...report.findingCountsBySeverity.after },
      delta: { ...report.findingCountsBySeverity.delta },
      reduction: { ...report.findingCountsBySeverity.reduction },
    },
    ...(report.coverageDelta === undefined ? {} : { coverageDelta: report.coverageDelta }),
  }
}

function formatDelta(value: number): string {
  return value > 0 ? `+${value}` : `${value}`
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/[\r\n]+/gu, ' ')
}

function escapeMarkdownCode(value: string): string {
  return value.replaceAll('`', '\\`').replace(/[\r\n]+/gu, ' ')
}

export function renderGainReportMarkdown(report: GainReport): string {
  const lines = [
    '# Audit gain report',
    '',
    `Project: \`${escapeMarkdownCode(report.projectPath)}\``,
    `Before snapshot: ${escapeMarkdownCell(report.before.generatedAt)}`,
    `After snapshot: ${escapeMarkdownCell(report.after.generatedAt)}`,
    '',
    '| Metric | Before | After | Delta | Reduction |',
    '| --- | ---: | ---: | ---: | ---: |',
    `| Debt minutes | ${report.debtMinutes.before} | ${report.debtMinutes.after} | ${formatDelta(report.debtMinutes.delta)} | ${formatDelta(report.debtMinutes.reduction)} |`,
    `| Findings | ${report.findingCount.before} | ${report.findingCount.after} | ${formatDelta(report.findingCount.delta)} | ${formatDelta(report.findingCount.reduction)} |`,
    `| Cyclomatic complexity | ${report.complexity.before} | ${report.complexity.after} | ${formatDelta(report.complexity.delta)} | ${formatDelta(report.complexity.reduction)} |`,
    '',
    '## Findings by severity',
    '',
    '| Severity | Before | After | Delta | Reduction |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...AUDIT_DEBT_SEVERITIES.map((severity) => {
      const counts = report.findingCountsBySeverity
      return `| ${severity} | ${counts.before[severity]} | ${counts.after[severity]} | ${formatDelta(counts.delta[severity])} | ${formatDelta(counts.reduction[severity])} |`
    }),
  ]

  if (report.coverageDelta !== undefined) {
    lines.push('', '## Coverage', '', `Coverage delta (percentage points): ${formatDelta(report.coverageDelta)}`)
  }

  return `${lines.join('\n')}\n`
}

export function renderGainReportJson(report: GainReport): string {
  const serialized = JSON.stringify(toJsonSafeGainReport(report), null, 2)
  if (serialized === undefined) throw new Error('Gain report could not be serialized as JSON.')
  return serialized
}
