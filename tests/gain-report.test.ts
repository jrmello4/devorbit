import { describe, expect, it } from 'vitest'
import type { AuditSnapshot } from '../src/shared/audit-contract'
import {
  countFindingsBySeverity,
  createGainReport,
  renderGainReportJson,
  renderGainReportMarkdown,
  toJsonSafeGainReport,
} from '../src/shared/gain-report'

function snapshot(overrides: Partial<AuditSnapshot> = {}): AuditSnapshot {
  return {
    version: 1,
    projectPath: 'C:/workspace/demo',
    generatedAt: '2026-09-17T12:00:00.000Z',
    filesScanned: 3,
    linesScanned: 120,
    cyclomaticComplexity: 18,
    findings: [],
    estimatedDebtMinutes: 0,
    ...overrides,
  }
}

function finding(severity: 'low' | 'medium' | 'high' | 'critical', id: string) {
  return {
    id,
    severity,
    category: 'smell' as const,
    file: `src/${id}.ts`,
    line: 1,
    message: id,
    evidence: id,
    estimatedMinutes: 10,
  }
}

describe('shared gain report', () => {
  it('compares debt, total findings, severity counts, complexity and optional coverage', () => {
    const before = snapshot({
      estimatedDebtMinutes: 120,
      findings: [finding('low', 'todo'), finding('medium', 'any'), finding('high', 'boundary'), finding('high', 'api')],
      cyclomaticComplexity: 18,
    })
    const after = snapshot({
      generatedAt: '2026-09-17T13:00:00.000Z',
      estimatedDebtMinutes: 45,
      findings: [finding('medium', 'any'), finding('critical', 'new-risk')],
      cyclomaticComplexity: 11,
    })

    expect(countFindingsBySeverity(before)).toEqual({ low: 1, medium: 1, high: 2, critical: 0 })

    const report = createGainReport(before, after, 8.5)
    expect(report).toMatchObject({
      version: 1,
      projectPath: 'C:/workspace/demo',
      debtMinutes: { before: 120, after: 45, delta: -75, reduction: 75 },
      findingCount: { before: 4, after: 2, delta: -2, reduction: 2 },
      complexity: { before: 18, after: 11, delta: -7, reduction: 7 },
      coverageDelta: 8.5,
    })
    expect(report.findingCountsBySeverity).toEqual({
      before: { low: 1, medium: 1, high: 2, critical: 0 },
      after: { low: 0, medium: 1, high: 0, critical: 1 },
      delta: { low: -1, medium: 0, high: -2, critical: 1 },
      reduction: { low: 1, medium: 0, high: 2, critical: -1 },
    })
  })

  it('omits coverage when it is not supplied and renders bounded Markdown', () => {
    const before = snapshot({ projectPath: 'C:/workspace/a|b`' })
    const after = snapshot({ projectPath: 'C:/workspace/a|b`', generatedAt: '2026-09-17T13:00:00.000Z', cyclomaticComplexity: 16 })
    const report = createGainReport(before, after)
    const markdown = renderGainReportMarkdown(report)

    expect('coverageDelta' in report).toBe(false)
    expect(markdown).toContain('# Audit gain report')
    expect(markdown).toContain('Project: `C:/workspace/a|b\\``')
    expect(markdown).toContain('| Debt minutes | 0 | 0 | 0 | 0 |')
    expect(markdown).toContain('| low | 0 | 0 | 0 | 0 |')
    expect(markdown).not.toContain('Coverage delta')
  })

  it('returns a JSON-safe clone and a parseable JSON rendering', () => {
    const report = createGainReport(
      snapshot({ estimatedDebtMinutes: 30, findings: [finding('critical', 'critical')] }),
      snapshot({ generatedAt: '2026-09-17T13:00:00.000Z', estimatedDebtMinutes: 0 }),
      12,
    )

    const jsonSafe = toJsonSafeGainReport(report)
    expect(jsonSafe).toEqual(report)
    expect(jsonSafe).not.toBe(report)
    expect(jsonSafe.before).not.toBe(report.before)
    expect(JSON.parse(renderGainReportJson(report))).toEqual(jsonSafe)
  })
})
