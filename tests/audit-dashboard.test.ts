import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AuditDashboard,
  calculateAuditMetrics,
  countBySeverity,
  filterAuditEntries,
  sortAuditEntries,
  type AuditEntry,
  type AuditSeverity,
} from '../src/renderer/src/components/AuditDashboard'

function debtEntry(index: number, severity: AuditSeverity): AuditEntry {
  return {
    id: 'debt-' + index,
    category: 'debt',
    title: 'Problema ' + String(index).padStart(3, '0'),
    description: 'src/main/file-' + index + '.ts:' + index,
    status: 'open',
    severity,
    evidence: 'file-' + index + '.ts:' + index,
    value: { amount: 5, unit: 'min' },
  }
}

describe('audit dashboard data', () => {
  it('sorts by severity and filters by category/severity', () => {
    const entries = [
      debtEntry(1, 'low'),
      debtEntry(2, 'critical'),
      debtEntry(3, 'medium'),
      { id: 'gain-1', category: 'gain' as const, title: 'Ganho', description: 'x', status: 'verified' as const, severity: 'info' as const },
    ]
    expect(sortAuditEntries(entries).map((entry) => entry.id)).toEqual(['debt-2', 'debt-3', 'debt-1', 'gain-1'])
    expect(filterAuditEntries(entries, 'debt').map((entry) => entry.id)).toEqual(['debt-2', 'debt-3', 'debt-1'])
    expect(filterAuditEntries(entries, 'debt', 'critical').map((entry) => entry.id)).toEqual(['debt-2'])
    expect(filterAuditEntries(entries, 'gain').map((entry) => entry.id)).toEqual(['gain-1'])
    expect(countBySeverity(entries).critical).toBe(1)
    expect(calculateAuditMetrics(entries).debt.open).toBe(3)
  })

  it('renders every debt item with plain Portuguese labels', () => {
    const entries = Array.from({ length: 181 }, (_, index) => debtEntry(index, index < 5 ? 'critical' : 'medium'))
    const html = renderToStaticMarkup(React.createElement(AuditDashboard, { data: { entries } }))
    expect((html.match(/class="evolution-entry"/g) || []).length).toBe(181)
    expect(html).toContain('Problemas encontrados')
    expect(html).toContain('Problemas em aberto')
    expect(html).not.toContain('Spans IPC')
    expect(html).not.toContain('fórmula visível')
    expect(html).not.toContain('Visão explicável')
    expect(html).toContain('Críticos')
  })
})
