import { describe, expect, it } from 'vitest'
import type {
  UsageAdapterStatus,
  UsageModelShare,
  UsageShareWindow,
} from '../src/shared/usage-contract'
import {
  computeUsageRows,
  formatRelativeReset,
  formatTokenCount,
  summarizeAdapters,
} from '../src/renderer/src/components/usage-share-helpers'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const makeModel = (overrides: Partial<UsageModelShare> = {}): UsageModelShare => ({
  provider: 'codex',
  model: 'gpt-5-codex',
  inputTokens: 0,
  outputTokens: 0,
  cacheTokens: 0,
  totalTokens: 0,
  turns: 0,
  sessions: 0,
  activeMs: 0,
  ...overrides,
})

const makeWindow = (overrides: Partial<UsageShareWindow> = {}): UsageShareWindow => ({
  window: 'day',
  since: '2026-09-21T00:00:00.000Z',
  totalTokens: 0,
  totalTurns: 0,
  models: [],
  ...overrides,
})

describe('computeUsageRows', () => {
  it('calcula percentuais com um decimal na base de tokens e ordena desc', () => {
    const rows = computeUsageRows(makeWindow({
      totalTokens: 3000,
      totalTurns: 10,
      models: [
        makeModel({ model: 'a', totalTokens: 1000, turns: 2 }),
        makeModel({ model: 'b', totalTokens: 2000, turns: 8 }),
      ],
    }))

    expect(rows.map((row) => row.model)).toEqual(['b', 'a'])
    expect(rows[0].percent).toBe(66.7)
    expect(rows[1].percent).toBe(33.3)
    expect(rows[0].totalTokens).toBe(2000)
    expect(rows[0].turns).toBe(8)
  })

  it('usa turnos como base quando a janela não tem tokens reais', () => {
    const rows = computeUsageRows(makeWindow({
      totalTokens: 0,
      totalTurns: 4,
      models: [
        makeModel({ model: 'com-turnos', totalTokens: 0, turns: 3 }),
        makeModel({ model: 'poucos-turnos', totalTokens: 0, turns: 1 }),
      ],
    }))

    expect(rows.map((row) => row.model)).toEqual(['com-turnos', 'poucos-turnos'])
    expect(rows[0].percent).toBe(75)
    expect(rows[1].percent).toBe(25)
  })

  it('retorna 0% para todas as linhas quando a base é zero', () => {
    const rows = computeUsageRows(makeWindow({
      totalTokens: 0,
      totalTurns: 0,
      models: [makeModel({ turns: 5 })],
    }))

    expect(rows).toHaveLength(1)
    expect(rows[0].percent).toBe(0)
  })

  it('retorna lista vazia para janela sem modelos', () => {
    expect(computeUsageRows(makeWindow({ totalTokens: 500, totalTurns: 3 }))).toEqual([])
  })

  it('propaga entrada, saída e cache por linha', () => {
    const rows = computeUsageRows(makeWindow({
      totalTokens: 100,
      totalTurns: 1,
      models: [makeModel({ inputTokens: 60, outputTokens: 30, cacheTokens: 10, totalTokens: 100, turns: 1 })],
    }))

    expect(rows[0].inputTokens).toBe(60)
    expect(rows[0].outputTokens).toBe(30)
    expect(rows[0].cacheTokens).toBe(10)
  })
})

describe('formatTokenCount', () => {
  it('mantém inteiros pequenos sem sufixo', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(847)).toBe('847')
    expect(formatTokenCount(999)).toBe('999')
  })

  it('compacta milhares com vírgula e um decimal só quando necessário', () => {
    expect(formatTokenCount(1000)).toBe('1k')
    expect(formatTokenCount(12000)).toBe('12k')
    expect(formatTokenCount(12400)).toBe('12,4k')
    expect(formatTokenCount(999_400)).toBe('999,4k')
  })

  it('compacta milhões com vírgula decimal', () => {
    expect(formatTokenCount(999_999)).toBe('1M')
    expect(formatTokenCount(3_000_000)).toBe('3M')
    expect(formatTokenCount(3_100_000)).toBe('3,1M')
    expect(formatTokenCount(45_600_000)).toBe('45,6M')
  })

  it('trata valores inválidos como zero', () => {
    expect(formatTokenCount(-5)).toBe('0')
    expect(formatTokenCount(Number.NaN)).toBe('0')
  })
})

describe('formatRelativeReset', () => {
  const now = Date.parse('2026-09-21T12:00:00.000Z')

  it('formata contagem regressiva futura em horas e minutos', () => {
    expect(formatRelativeReset('2026-09-21T14:15:00.000Z', now)).toBe('renova em 2h 15min')
    expect(formatRelativeReset('2026-09-21T14:00:00.000Z', now)).toBe('renova em 2h')
    expect(formatRelativeReset(new Date(now + 30_000).toISOString(), now)).toBe('renova em 1min')
  })

  it('retorna null para passado, ausente ou inválido', () => {
    expect(formatRelativeReset('2026-09-21T11:59:00.000Z', now)).toBeNull()
    expect(formatRelativeReset('2026-09-21T12:00:00.000Z', now)).toBeNull()
    expect(formatRelativeReset(undefined, now)).toBeNull()
    expect(formatRelativeReset('não-é-data', now)).toBeNull()
  })
})

describe('summarizeAdapters', () => {
  const adapter = (
    source: UsageAdapterStatus['source'],
    status: UsageAdapterStatus['status'],
  ): UsageAdapterStatus => ({ source, status })

  it('agrupa múltiplas fontes ok do mesmo tipo', () => {
    expect(summarizeAdapters([
      adapter('claude-transcripts', 'ok'),
      adapter('claude-transcripts', 'ok'),
    ])).toBe('Claude: 2 fontes ok')
  })

  it('resume cada fonte com o essencial', () => {
    expect(summarizeAdapters([adapter('codex-rollouts', 'empty')])).toBe('Codex: sem dados')
    expect(summarizeAdapters([adapter('gemini-local', 'missing')])).toBe('Gemini: não instalado')
    expect(summarizeAdapters([adapter('opencode-storage', 'ok')])).toBe('OpenCode: ok')
    expect(summarizeAdapters([adapter('llm-router', 'error')])).toBe('DevOrbit: erro')
  })

  it('dá prioridade a erro dentro do mesmo grupo e junta grupos com ·', () => {
    expect(summarizeAdapters([
      adapter('codex-rollouts', 'error'),
      adapter('codex-rollouts', 'ok'),
      adapter('claude-transcripts', 'ok'),
    ])).toBe('Codex: erro · Claude: ok')
  })

  it('mistura sem dados com não instalado como sem dados', () => {
    expect(summarizeAdapters([
      adapter('codex-rollouts', 'empty'),
      adapter('codex-rollouts', 'missing'),
    ])).toBe('Codex: sem dados')
  })

  it('retorna string vazia sem adaptadores', () => {
    expect(summarizeAdapters([])).toBe('')
  })
})

describe('UsageSharePanel semântica acessível', () => {
  it('renderiza lista semântica (ul/li) e barra de progresso com role progressbar e ARIA', async () => {
    const React = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { UsageSharePanel } = await import('../src/renderer/src/components/UsageSharePanel')

    const mockState = {
      windows: {
        day: {
          window: 'day' as const,
          since: '2026-09-22T00:00:00.000Z',
          totalTokens: 5000,
          totalTurns: 10,
          models: [
            makeModel({ model: 'gpt-5-codex', totalTokens: 3500, turns: 7 }),
            makeModel({ model: 'claude-3-7-sonnet', totalTokens: 1500, turns: 3 }),
          ],
        },
        week: makeWindow({ window: 'week' }),
        all: makeWindow({ window: 'all' }),
      },
      quota: [],
      adapters: [],
      generatedAt: '2026-09-22T10:00:00.000Z',
    }

    const html = renderToStaticMarkup(
      React.createElement(UsageSharePanel, {
        initialState: mockState,
      }),
    )

    // Lista semântica
    expect(html).toContain('role="list"')
    expect(html).toContain('<ul class="usage-share-rows"')
    expect(html).toContain('<li class="usage-share-row"')

    // Progressbar acessível
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuenow="70"')
    expect(html).toContain('aria-valuemin="0"')
    expect(html).toContain('aria-valuemax="100"')
    expect(html).toContain('aria-valuetext="70% dos tokens"')
  })
})
