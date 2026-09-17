import { describe, expect, it } from 'vitest'
import { calculateAuditMetrics, type AuditEntry } from '../src/renderer/src/components/AuditDashboard'

const entries: AuditEntry[] = [
  {
    id: 'audit-1',
    category: 'audit',
    title: 'Contrato validado',
    description: 'O contrato foi revisado.',
    status: 'verified',
  },
  {
    id: 'audit-2',
    category: 'audit',
    title: 'Ponto pendente',
    description: 'Ainda exige revisão.',
    status: 'open',
  },
  {
    id: 'debt-1',
    category: 'debt',
    title: 'Atualizar documentação',
    description: 'A documentação está incompleta.',
    status: 'in-progress',
  },
  {
    id: 'debt-2',
    category: 'debt',
    title: 'Remover duplicação',
    description: 'A duplicação foi removida.',
    status: 'resolved',
  },
  {
    id: 'gain-1',
    category: 'gain',
    title: 'Tempo poupado',
    description: 'Fluxo automatizado.',
    status: 'verified',
    value: { amount: 2.5, unit: 'h' },
  },
  {
    id: 'gain-2',
    category: 'gain',
    title: 'Itens cobertos',
    description: 'Cobertura ampliada.',
    status: 'open',
    value: { amount: 4, unit: 'itens' },
  },
  {
    id: 'gain-3',
    category: 'gain',
    title: 'Sem valor',
    description: 'Registro qualitativo.',
    status: 'verified',
  },
]

describe('calculateAuditMetrics', () => {
  it('calcula contagens por categoria a partir dos estados dos registros', () => {
    const metrics = calculateAuditMetrics(entries)

    expect(metrics.total).toBe(7)
    expect(metrics.audit).toEqual({ total: 2, resolved: 1, open: 1 })
    expect(metrics.debt).toEqual({ total: 2, resolved: 1, open: 1 })
    expect(metrics.gain.total).toBe(3)
    expect(metrics.gain.confirmed).toBe(2)
    expect(metrics.gain.pending).toBe(1)
  })

  it('soma apenas valores finitos e mantém unidades explicáveis', () => {
    const metrics = calculateAuditMetrics([
      ...entries,
      {
        id: 'gain-4',
        category: 'gain',
        title: 'Outro tempo poupado',
        description: 'Mais uma melhoria.',
        status: 'verified',
        value: { amount: 1.25, unit: 'h' },
      },
      {
        id: 'gain-5',
        category: 'gain',
        title: 'Valor inválido',
        description: 'Não entra na soma.',
        status: 'verified',
        value: { amount: Number.NaN, unit: 'h' },
      },
    ])

    expect(metrics.gain.valueByUnit).toEqual({ h: 3.75, itens: 4 })
  })

  it('retorna métricas vazias sem score derivado', () => {
    expect(calculateAuditMetrics([])).toEqual({
      total: 0,
      audit: { total: 0, resolved: 0, open: 0 },
      debt: { total: 0, resolved: 0, open: 0 },
      gain: { total: 0, confirmed: 0, pending: 0, valueByUnit: {} },
    })
  })
})
