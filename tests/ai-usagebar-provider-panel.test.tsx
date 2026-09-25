import fs from 'fs'
import path from 'path'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  AiUsagebarProviderPanel,
  ENTRY_ERROR_FALLBACK,
  executeVendorToggle,
  formatMetricDisplay,
  formatResetCredits,
  formatResetTime,
  formatWindowDuration,
  mapSeverityTone,
  validateAndTrimApiKey,
} from '../src/renderer/src/components/AiUsagebarProviderPanel'
import type {
  AiUsagebarEntry,
  AiUsagebarMetric,
  AiUsagebarReport,
  AiUsagebarSection,
  AiUsagebarSnapshot,
  AiUsagebarVendor,
} from '../src/shared/ai-usagebar-contract'

describe('AiUsagebarProviderPanel - Helpers Puros', () => {
  describe('validateAndTrimApiKey', () => {
    it('remove espaços de ponta de chaves válidas', () => {
      const result = validateAndTrimApiKey('   sk-valid-api-key-12345   ')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.apiKey).toBe('sk-valid-api-key-12345')
      }
    })

    it('rejeita chaves vazias ou apenas com espaços', () => {
      expect(validateAndTrimApiKey('')).toEqual({
        ok: false,
        error: 'Informe uma chave não vazia.',
      })
      expect(validateAndTrimApiKey('    \t   ')).toEqual({
        ok: false,
        error: 'Informe uma chave não vazia.',
      })
    })

    it('rejeita chaves com quebras de linha ou bytes nulos', () => {
      expect(validateAndTrimApiKey('sk-part1\nsk-part2')).toMatchObject({
        ok: false,
      })
      expect(validateAndTrimApiKey('sk-part1\r\nsk-part2')).toMatchObject({
        ok: false,
      })
      expect(validateAndTrimApiKey('sk-part1\0tail')).toMatchObject({
        ok: false,
      })
    })

    it('rejeita chaves que excedem 8192 caracteres', () => {
      const oversized = 'a'.repeat(8193)
      expect(validateAndTrimApiKey(oversized)).toMatchObject({
        ok: false,
      })
    })
  })

  describe('formatMetricDisplay', () => {
    it('respeita headline="value" exibindo valor monetário ou textual como primário', () => {
      const metric: AiUsagebarMetric = {
        label: 'Créditos restantes',
        headline: 'value',
        value: '$13.67 remaining',
        percent: 98,
        detail: 'de $900 total',
      }

      const result = formatMetricDisplay(metric)
      expect(result.headlineType).toBe('value')
      expect(result.primaryText).toBe('$13.67 remaining')
      expect(result.secondaryText).toBe('de $900 total')
      expect(result.percent).toBe(98)
    })

    it('respeita headline="percent" exibindo percentual como primário e valor como secundário', () => {
      const metric: AiUsagebarMetric = {
        label: 'Cota de 5 horas',
        headline: 'percent',
        percent: 42.4,
        value: '42 mensagens',
      }

      const result = formatMetricDisplay(metric)
      expect(result.headlineType).toBe('percent')
      expect(result.primaryText).toBe('42%')
      expect(result.secondaryText).toBe('42 mensagens')
      expect(result.percent).toBe(42.4)
    })

    it('usa headline="value" quando valor existe e percentual está ausente', () => {
      const metric: AiUsagebarMetric = {
        label: 'Saldo',
        value: '$50.00',
      }

      const result = formatMetricDisplay(metric)
      expect(result.headlineType).toBe('value')
      expect(result.primaryText).toBe('$50.00')
    })
  })

  describe('mapSeverityTone', () => {
    it('mapeia severidades nominais do upstream', () => {
      expect(mapSeverityTone('critical')).toBe('critical')
      expect(mapSeverityTone('danger')).toBe('critical')
      expect(mapSeverityTone('high')).toBe('warning')
      expect(mapSeverityTone('warn')).toBe('warning')
      expect(mapSeverityTone('mid')).toBe('mid')
      expect(mapSeverityTone('low')).toBe('ok')
      expect(mapSeverityTone('ok')).toBe('ok')
    })

    it('infere severidade a partir de percentuais quando severidade nominal está ausente', () => {
      expect(mapSeverityTone(undefined, 95)).toBe('critical')
      expect(mapSeverityTone(undefined, 80)).toBe('warning')
      expect(mapSeverityTone(undefined, 30)).toBe('ok')
      expect(mapSeverityTone(undefined, undefined)).toBe('default')
    })
  })

  describe('formatWindowDuration', () => {
    it('formata segundos em horas ou dias exatos', () => {
      expect(formatWindowDuration(18000)).toBe('5h')
      expect(formatWindowDuration(604800)).toBe('7d')
      expect(formatWindowDuration(3600)).toBe('1h')
      expect(formatWindowDuration(1800)).toBe('30m')
      expect(formatWindowDuration(undefined)).toBeNull()
    })
  })

  describe('formatResetTime', () => {
    it('formata timestamps ISO válidos', () => {
      const iso = '2026-09-25T18:00:00Z'
      const formatted = formatResetTime(iso)
      expect(formatted).toBeTruthy()
      expect(formatResetTime(undefined)).toBeNull()
    })
  })

  describe('formatResetCredits', () => {
    it('formata objetos com available ou count', () => {
      expect(formatResetCredits({ available: 3 })).toBe('Resets disponíveis: 3')
      expect(formatResetCredits({ count: 5 })).toBe('Resets disponíveis: 5')
      expect(formatResetCredits(null)).toBeNull()
    })
  })

  describe('executeVendorToggle', () => {
    it('um toggle por vendor não pode ser chamado duas vezes enquanto promise está pendente, depois reabilita', async () => {
      let resolvePromise!: () => void
      const onToggleProvider = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolvePromise = resolve
          })
      )

      const pendingMap: Record<string, boolean> = {}
      const setPending = (id: string, isPending: boolean) => {
        if (isPending) pendingMap[id] = true
        else delete pendingMap[id]
      }
      const setActionError = vi.fn()

      // Primeiro clique: dispara toggle e marca pending
      const firstCallPromise = executeVendorToggle(
        'vendor-1',
        true,
        pendingMap,
        setPending,
        setActionError,
        onToggleProvider
      )

      expect(pendingMap['vendor-1']).toBe(true)
      expect(onToggleProvider).toHaveBeenCalledTimes(1)

      // Segundo clique com promise pendente: deve ser ignorado sem duplicar chamada
      const secondCallResult = await executeVendorToggle(
        'vendor-1',
        false,
        pendingMap,
        setPending,
        setActionError,
        onToggleProvider
      )

      expect(secondCallResult).toBe(false)
      expect(onToggleProvider).toHaveBeenCalledTimes(1)

      // Libera promise inicial
      resolvePromise()
      const firstCallResult = await firstCallPromise
      expect(firstCallResult).toBe(true)
      expect(pendingMap['vendor-1']).toBeUndefined()

      // Terceiro clique: vendor já reabilitado, deve executar normalmente
      const thirdCallPromise = executeVendorToggle(
        'vendor-1',
        false,
        pendingMap,
        setPending,
        setActionError,
        onToggleProvider
      )
      expect(onToggleProvider).toHaveBeenCalledTimes(2)
      resolvePromise()
      await thirdCallPromise
    })

    it('limpa pending em finally e repassa erro quando onToggleProvider rejeita', async () => {
      const onToggleProvider = vi.fn().mockRejectedValue(new Error('Erro no backend'))
      const pendingMap: Record<string, boolean> = {}
      const setPending = (id: string, isPending: boolean) => {
        if (isPending) pendingMap[id] = true
        else delete pendingMap[id]
      }
      const setActionError = vi.fn()

      const result = await executeVendorToggle(
        'vendor-err',
        true,
        pendingMap,
        setPending,
        setActionError,
        onToggleProvider
      )

      expect(result).toBe(false)
      expect(setActionError).toHaveBeenCalledWith('Erro no backend')
      expect(pendingMap['vendor-err']).toBeUndefined()
    })

    it('integração helper + callback: bloqueia duas invocações no mesmo tick mutando a ref sincronamente', async () => {
      let resolvePromise!: () => void
      const onToggleProvider = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolvePromise = resolve
          })
      )

      // Simula exatamente o comportamento do componente (pendingTogglesRef.current + React state updater)
      const pendingTogglesRef = { current: {} as Record<string, boolean> }
      const scheduledStateUpdates: Array<Record<string, boolean>> = []
      const setPendingToggles = (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => {
        // No React, setState é assíncrono e só agenda o update
        const prev = scheduledStateUpdates[scheduledStateUpdates.length - 1] || {}
        scheduledStateUpdates.push(updater(prev))
      }
      const setActionError = vi.fn()

      const createHandler = () => async (vendorId: string, enabled: boolean) => {
        return await executeVendorToggle(
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

      const handler = createHandler()

      // Dispara duas invocações estritamente concorrentes no mesmo tick (antes de qualquer re-render)
      const promise1 = handler('vendor-same-tick', true)
      const promise2 = handler('vendor-same-tick', false)

      // A segunda chamada é bloqueada de imediato pois pendingTogglesRef.current foi mutado sincronamente na primeira
      const res2 = await promise2
      expect(res2).toBe(false)
      expect(onToggleProvider).toHaveBeenCalledTimes(1)

      // pendingTogglesRef e state refletem que o vendor está pendente
      expect(pendingTogglesRef.current['vendor-same-tick']).toBe(true)
      expect(scheduledStateUpdates[0]).toEqual({ 'vendor-same-tick': true })

      // Libera o gate e só então aguarda a conclusão da primeira operação
      resolvePromise()
      const res1 = await promise1
      expect(res1).toBe(true)

      // Após a conclusão, o ref foi limpo e o state scheduled também refletiu a remoção
      expect(pendingTogglesRef.current['vendor-same-tick']).toBeUndefined()
      expect(scheduledStateUpdates[scheduledStateUpdates.length - 1]).toEqual({})

      // Nova invocação após conclusão agora é aceita
      const promise3 = handler('vendor-same-tick', false)
      expect(onToggleProvider).toHaveBeenCalledTimes(2)
      resolvePromise()
      await promise3
    })

    it('compara estritamente com true (=== true), evitando que propriedades herdadas de Object.prototype pareçam pendentes', async () => {
      const onToggleProvider = vi.fn().mockResolvedValue(undefined)
      const pendingMap: Record<string, boolean> = {}
      const setPending = vi.fn()
      const setActionError = vi.fn()

      // IDs arbitrários ou herdados como 'toString' ou 'constructor' não devem ser tratados como pendentes
      const resultToString = await executeVendorToggle(
        'toString',
        true,
        pendingMap,
        setPending,
        setActionError,
        onToggleProvider
      )

      expect(resultToString).toBe(true)
      expect(onToggleProvider).toHaveBeenCalledWith({ vendorId: 'toString', enabled: true })
    })
  })
})

describe('AiUsagebarProviderPanel - Estados Globais do Componente', () => {
  it('renderiza estado de carregamento quando loading=true sem snapshot prévio', () => {
    const html = renderToStaticMarkup(createElement(AiUsagebarProviderPanel, { loading: true }))

    expect(html).toContain('Consultando provedores e telemetria de uso…')
    expect(html).toContain('ai-usagebar-loading-container')
  })

  it('renderiza estado vazio quando não há provedores nem entradas de uso', () => {
    const snapshot: AiUsagebarSnapshot = {
      state: 'ready',
      vendors: [],
      report: { schema_version: 1, entries: [] },
      stale: false,
    }

    const html = renderToStaticMarkup(createElement(AiUsagebarProviderPanel, { snapshot }))

    expect(html).toContain('Nenhum provedor configurado no momento.')
    expect(html).toContain('ai-usagebar-empty-container')
  })

  it('renderiza alerta de estado degraded com mensagem apropriada', () => {
    const snapshot: AiUsagebarSnapshot = {
      state: 'degraded',
      message: 'Falha ao consultar alguns provedores remotos.',
      vendors: [],
      stale: true,
    }

    const html = renderToStaticMarkup(createElement(AiUsagebarProviderPanel, { snapshot }))

    expect(html).toContain('ai-usagebar-alert--warning')
    expect(html).toContain('Falha ao consultar alguns provedores remotos.')
    expect(html).toContain('ai-usagebar-badge--degraded')
  })

  it('renderiza alerta de erro/indisponibilidade quando state=error', () => {
    const snapshot: AiUsagebarSnapshot = {
      state: 'error',
      message: 'Binário ai-usagebar não encontrado.',
      vendors: [],
      stale: false,
    }

    const html = renderToStaticMarkup(createElement(AiUsagebarProviderPanel, { snapshot }))

    expect(html).toContain('ai-usagebar-alert--error')
    expect(html).toContain('Binário ai-usagebar não encontrado.')
    expect(html).toContain('ai-usagebar-badge--error')
  })
})

describe('AiUsagebarProviderPanel - Provedores Futuros e Tolerância', () => {
  it('renderiza provedor futuro e campos arbitrários sem necessidade de código específico', () => {
    const futureVendor: AiUsagebarVendor = {
      id: 'quantum-ai-2030',
      name: 'Quantum AI Research',
      short_name: 'quantum',
      kind: 'apikey',
      enabled: true,
      configured: true,
      needs_credential: false,
      env: 'QUANTUM_API_KEY',
      future_field_tier: 'HyperScale',
    }

    const futureEntry: AiUsagebarEntry = {
      id: 'quantum-ai-2030',
      name: 'Quantum AI Research',
      display_name: 'Quantum AI Enterprise',
      icon: '⚛',
      brand: 'quantum',
      plan: 'Quantum Unlimited',
      status: 'ready',
      stale: false,
      sections: [
        {
          type: 'metric',
          label: 'Qubits Utilizados',
          headline: 'value',
          value: '1.024 Qubits',
          percent: 50,
          detail: 'de 2.048 Qubits',
          severity: 'ok',
        },
      ],
    }

    const snapshot: AiUsagebarSnapshot = {
      state: 'ready',
      version: '1.24.0',
      vendors: [futureVendor],
      report: {
        schema_version: 1,
        entries: [futureEntry],
      },
      stale: false,
    }

    const html = renderToStaticMarkup(createElement(AiUsagebarProviderPanel, { snapshot }))

    expect(html).toContain('Quantum AI Enterprise')
    expect(html).toContain('Quantum Unlimited')
    expect(html).toContain('⚛')
    expect(html).toContain('1.024 Qubits')
    expect(html).toContain('Qubits Utilizados')
    expect(html).toContain('quantum')
    expect(html).toContain('v1.24.0')
  })

  it('renderiza corretamente entradas com erro pontual e dados em cache (stale)', () => {
    const errorEntry: AiUsagebarEntry = {
      id: 'failing-provider',
      name: 'Failing Provider',
      status: 'error',
      error: '401 Unauthorized: token expirado',
      stale: true,
      sections: [],
    }

    const snapshot: AiUsagebarSnapshot = {
      state: 'ready',
      vendors: [],
      report: {
        schema_version: 1,
        entries: [errorEntry],
      },
      stale: false,
    }

    const html = renderToStaticMarkup(createElement(AiUsagebarProviderPanel, { snapshot }))

    expect(html).toContain('ai-usagebar-entry-card--error')
    expect(html).toContain('ai-usagebar-entry-card--stale')
    // Erro cru do upstream NUNCA vai ao DOM; entra o texto genérico.
    expect(html).not.toContain('401 Unauthorized: token expirado')
    expect(html).toContain(ENTRY_ERROR_FALLBACK)
    expect(html).toContain('Stale')
  })
})

describe('AiUsagebarProviderPanel - Seções Ordenadas, Agrupamento e Blocos', () => {
  it('renderiza seções mistas: métrica agrupada, text, block, spacer e unknown', () => {
    const complexEntry: AiUsagebarEntry = {
      id: 'advanced-ai',
      name: 'Advanced AI',
      status: 'ready',
      sections: [
        {
          type: 'metric',
          label: 'Modelo Rápido',
          group: 'Detalhamento',
          headline: 'percent',
          percent: 85,
          value: '85k tokens',
          severity: 'high',
          window_secs: 18000,
        },
        {
          type: 'text',
          label: 'Tier da Conta',
          value: 'Enterprise Pro',
        },
        {
          type: 'spacer',
        },
        {
          type: 'block',
          label: 'Avisos da Conta',
          body: ['Manutenção agendada para domingo', 'Limites dobrados neste fim de semana'],
        },
        {
          type: 'custom_unrecognized_section',
          label: 'Dado Futuro',
          value: 'Valor arbitrário',
        },
      ],
      reset_credits: { available: 2 },
    }

    const snapshot: AiUsagebarSnapshot = {
      state: 'ready',
      vendors: [],
      report: {
        schema_version: 1,
        entries: [complexEntry],
      },
      stale: false,
    }

    const html = renderToStaticMarkup(createElement(AiUsagebarProviderPanel, { snapshot }))

    // Métrica agrupada
    expect(html).toContain('[Detalhamento]')
    expect(html).toContain('Modelo Rápido')
    expect(html).toContain('85%')
    expect(html).toContain('Janela: 5h')
    expect(html).toContain('ai-usagebar-progress-fill--warning')

    // Seção Text
    expect(html).toContain('Tier da Conta')
    expect(html).toContain('Enterprise Pro')

    // Seção Spacer
    expect(html).toContain('ai-usagebar-spacer-row')

    // Seção Block
    expect(html).toContain('Avisos da Conta')
    expect(html).toContain('Manutenção agendada para domingo')
    expect(html).toContain('Limites dobrados neste fim de semana')

    // Seção Desconhecida
    expect(html).toContain('Dado Futuro')
    expect(html).toContain('Valor arbitrário')

    // Resets disponíveis
    expect(html).toContain('Resets disponíveis: 2')
  })
})

describe('AiUsagebarProviderPanel - Catálogo Dinâmico e Segurança de Chaves', () => {
  it('renderiza múltiplos provedores dinamicamente com suporte a toggle e formulário de chave', () => {
    const vendors: AiUsagebarVendor[] = Array.from({ length: 15 }, (_, i) => ({
      id: `vendor-${i + 1}`,
      name: `Vendor Test ${i + 1}`,
      kind: i % 2 === 0 ? 'apikey' : 'oauth',
      enabled: i < 5,
      configured: i < 8,
      needs_credential: i % 2 === 0 && i >= 8,
      env: i % 2 === 0 ? `VENDOR_${i + 1}_KEY` : undefined,
      login: i % 2 !== 0 ? `vendor-${i + 1} login` : undefined,
    }))

    const snapshot: AiUsagebarSnapshot = {
      state: 'ready',
      vendors,
      report: { schema_version: 1, entries: [] },
      stale: false,
    }

    const onToggle = vi.fn()
    const onSubmitKey = vi.fn()

    const html = renderToStaticMarkup(
      createElement(AiUsagebarProviderPanel, {
        snapshot,
        onToggleProvider: onToggle,
        onSubmitApiKey: onSubmitKey,
      })
    )

    // Renderizou os 15 provedores
    for (let i = 1; i <= 15; i++) {
      expect(html).toContain(`Vendor Test ${i}`)
    }

    // Provedores apikey exibem formulário com input password
    expect(html).toContain('type="password"')
    expect(html).toContain('Salvar Chave')

    // Só os 8 apikey com env têm formulário; nenhum oauth entra na lista.
    expect(html.match(/type="password"/g)).toHaveLength(8)
    expect(html).not.toContain('Chave de API para Vendor Test 2')

    // Nunca expõe valores prévios de chaves (sempre input vazio para digitação)
    expect(html).not.toContain('value="sk-')
    expect(html).not.toContain('value="secret')
  })

  it('exibe botões de ação e estados de loading/refreshing/detecting', () => {
    const snapshot: AiUsagebarSnapshot = {
      state: 'ready',
      vendors: [],
      report: { schema_version: 1, entries: [] },
      stale: false,
    }

    const onRefresh = vi.fn()
    const onDetect = vi.fn()

    const html = renderToStaticMarkup(
      createElement(AiUsagebarProviderPanel, {
        snapshot,
        refreshing: true,
        detecting: true,
        onRefresh,
        onDetect,
      })
    )

    expect(html).toContain('Atualizando…')
    expect(html).toContain('Detectando…')
    expect(html).toContain('disabled=""')
  })

  it('desabilita o botão Atualizar quando detecting=true mesmo se refreshing e loading forem false', () => {
    const snapshot: AiUsagebarSnapshot = {
      state: 'ready',
      vendors: [],
      report: { schema_version: 1, entries: [] },
      stale: false,
    }

    const htmlDetecting = renderToStaticMarkup(
      createElement(AiUsagebarProviderPanel, {
        snapshot,
        refreshing: false,
        loading: false,
        detecting: true,
        onRefresh: vi.fn(),
        onDetect: vi.fn(),
      })
    )

    // O botão Atualizar deve estar desabilitado durante detecting
    const detectingButton = htmlDetecting.match(/<button\b[^>]*aria-label="Atualizar quotas de uso"[^>]*>/)
    expect(detectingButton).not.toBeNull()
    expect(detectingButton![0]).toContain('disabled=""')

    const htmlIdle = renderToStaticMarkup(
      createElement(AiUsagebarProviderPanel, {
        snapshot,
        refreshing: false,
        loading: false,
        detecting: false,
        onRefresh: vi.fn(),
        onDetect: vi.fn(),
      })
    )

    // O botão Atualizar não deve estar desabilitado quando ocioso
    const idleButton = htmlIdle.match(/<button\b[^>]*aria-label="Atualizar quotas de uso"[^>]*>/)
    expect(idleButton).not.toBeNull()
    expect(idleButton![0]).not.toContain('disabled=""')
  })

  it('renderiza o input de toggle do provedor como disabled e aria-busy quando o toggle estiver pendente', () => {
    const snapshot: AiUsagebarSnapshot = {
      state: 'ready',
      vendors: [{ id: 'provider-1', name: 'Provider 1', enabled: true }],
      report: { schema_version: 1, entries: [] },
      stale: false,
    }

    const html = renderToStaticMarkup(
      createElement(AiUsagebarProviderPanel, {
        snapshot,
        onToggleProvider: vi.fn(),
        initialPendingToggles: { 'provider-1': true },
      })
    )

    const pendingInput = html.match(/<input\b[^>]*id="[^"]*provider-1"[^>]*>/)
    expect(pendingInput).not.toBeNull()
    expect(pendingInput![0]).toContain('disabled=""')
    expect(pendingInput![0]).toContain('aria-busy="true"')
  })

  it('não desabilita checkbox para provedores com IDs de propriedades herdadas de Object.prototype', () => {
    const snapshot: AiUsagebarSnapshot = {
      state: 'ready',
      vendors: [{ id: 'toString', name: 'ToString Provider', enabled: true }],
      report: { schema_version: 1, entries: [] },
      stale: false,
    }

    const html = renderToStaticMarkup(
      createElement(AiUsagebarProviderPanel, {
        snapshot,
        onToggleProvider: vi.fn(),
      })
    )

    // O input do toString não deve estar desabilitado nem com aria-busy
    const toStringInput = html.match(/<input\b[^>]*id="[^"]*toString"[^>]*>/)
    expect(toStringInput).not.toBeNull()
    expect(toStringInput![0]).not.toContain('disabled=""')
    expect(toStringInput![0]).not.toContain('aria-busy="true"')
  })

  it('renderiza botão "Remover Chave" quando o provedor está configurado e onRemoveApiKey é fornecido', () => {
    const configuredVendor: AiUsagebarVendor = {
      id: 'openai',
      name: 'OpenAI',
      kind: 'apikey',
      configured: true,
      enabled: true,
      env: 'OPENAI_API_KEY',
    }
    const unconfiguredVendor: AiUsagebarVendor = {
      id: 'anthropic',
      name: 'Anthropic',
      kind: 'apikey',
      configured: false,
      enabled: true,
      env: 'ANTHROPIC_API_KEY',
    }

    const snapshot: AiUsagebarSnapshot = {
      state: 'ready',
      vendors: [configuredVendor, unconfiguredVendor],
      report: { schema_version: 1, entries: [] },
      stale: false,
    }

    const onRemoveKey = vi.fn()

    const html = renderToStaticMarkup(
      createElement(AiUsagebarProviderPanel, {
        snapshot,
        onRemoveApiKey: onRemoveKey,
        onSubmitApiKey: vi.fn(),
      })
    )

    expect(html).toContain('Remover Chave')
    expect(html).toContain('Remover chave de API de OpenAI')
    expect(html).not.toContain('Remover chave de API de Anthropic')
  })

  it('OAuth/local configurado não exibe formulário nem remoção de chave', () => {
    const oauthConfigured: AiUsagebarVendor = {
      id: 'openai',
      name: 'OpenAI (OAuth)',
      kind: 'oauth',
      configured: true,
      enabled: true,
    }
    const localWithEnv: AiUsagebarVendor = {
      id: 'commandcode',
      name: 'Command Code',
      kind: 'local',
      configured: true,
      enabled: true,
      env: 'COMMANDCODE_API_KEY',
    }
    const apikeyVendor: AiUsagebarVendor = {
      id: 'openrouter',
      name: 'OpenRouter',
      kind: 'apikey',
      configured: false,
      enabled: true,
      env: 'OPENROUTER_API_KEY',
    }

    const snapshot: AiUsagebarSnapshot = {
      state: 'ready',
      vendors: [oauthConfigured, localWithEnv, apikeyVendor],
      report: { schema_version: 1, entries: [] },
      stale: false,
    }

    const html = renderToStaticMarkup(
      createElement(AiUsagebarProviderPanel, {
        snapshot,
        onSubmitApiKey: vi.fn(),
        onRemoveApiKey: vi.fn(),
      })
    )

    // OAuth/local seguem listados e configurados, mas sem chave gerenciada.
    expect(html).toContain('OpenAI (OAuth)')
    expect(html).toContain('Command Code')
    expect(html).not.toContain('Chave de API para OpenAI (OAuth)')
    expect(html).not.toContain('Chave de API para Command Code')
    expect(html).not.toContain('Remover chave de API de OpenAI (OAuth)')
    expect(html).not.toContain('Remover chave de API de Command Code')

    // Fluxo apikey preservado: só o openrouter ganha input + salvar.
    expect(html).toContain('Chave de API para OpenRouter')
    expect(html).toContain('Salvar Chave')
    expect(html.match(/type="password"/g)).toHaveLength(1)
  })
})

describe('AiUsagebarProviderPanel - Código Defensivo e Tolerância a Dados Corrompidos', () => {
  it('renderiza sem falhar quando entry.sections contém elementos nulos, indefinidos ou tipos malformados', () => {
    const corruptedEntry: AiUsagebarEntry = {
      id: 'corrupted-provider',
      name: 'Corrupted Provider',
      status: 'ready',
      // Simula upstream com seções contendo null, primitives ou tipo ausente
      sections: [
        null as unknown as AiUsagebarSection,
        undefined as unknown as AiUsagebarSection,
        12345 as unknown as AiUsagebarSection,
        'string-invalida' as unknown as AiUsagebarSection,
        {
          type: 'text',
          label: 'Seção Válida',
          value: 'Dado Seguro',
        },
        {
          type: undefined as unknown as string,
          label: 'Sem tipo',
          value: 'Fallback',
        },
      ],
    }

    const snapshot: AiUsagebarSnapshot = {
      state: 'ready',
      vendors: [],
      report: {
        schema_version: 1,
        entries: [corruptedEntry],
      },
      stale: false,
    }

    expect(() => {
      const html = renderToStaticMarkup(createElement(AiUsagebarProviderPanel, { snapshot }))
      expect(html).toContain('Seção Válida')
      expect(html).toContain('Dado Seguro')
      expect(html).toContain('Sem tipo')
    }).not.toThrow()
  })

  it('limita aria-valuenow na faixa de 0 a 100 mesmo com percentuais extremos', () => {
    const overEntry: AiUsagebarEntry = {
      id: 'over-quota',
      name: 'Over Quota',
      status: 'ready',
      sections: [
        {
          type: 'metric',
          label: 'Uso Extremo',
          percent: 135.8,
          headline: 'percent',
        },
      ],
    }

    const snapshot: AiUsagebarSnapshot = {
      state: 'ready',
      vendors: [],
      report: { schema_version: 1, entries: [overEntry] },
      stale: false,
    }

    const html = renderToStaticMarkup(createElement(AiUsagebarProviderPanel, { snapshot }))

    // aria-valuenow não deve ultrapassar 100
    expect(html).toContain('aria-valuenow="100"')
    expect(html).toContain('aria-valuemax="100"')
    expect(html).toContain('136%')
  })
})

describe('AiUsagebarProviderPanel - Validações de Acessibilidade e Estilo', () => {
  it('garante que a classe .sr-only está declarada no CSS com propriedades acessíveis', () => {
    const cssPath = path.resolve(__dirname, '../src/renderer/src/components/AiUsagebarProviderPanel.css')
    const cssContent = fs.readFileSync(cssPath, 'utf-8')

    expect(cssContent).toContain('.sr-only')
    expect(cssContent).toContain('position: absolute')
    expect(cssContent).toContain('clip: rect(0, 0, 0, 0)')
    expect(cssContent).toContain('overflow: hidden')
  })

  it('aceita callbacks assíncronos rejeitados sem provocar exceções no ciclo de renderização', () => {
    const rejectingCallback = vi.fn(async () => {
      throw new Error('Falha de rede simulada')
    })

    const snapshot: AiUsagebarSnapshot = {
      state: 'ready',
      vendors: [{ id: 'p1', name: 'P1', kind: 'apikey', configured: true }],
      report: { schema_version: 1, entries: [] },
      stale: false,
    }

    expect(() => {
      renderToStaticMarkup(
        createElement(AiUsagebarProviderPanel, {
          snapshot,
          onRefresh: rejectingCallback,
          onDetect: rejectingCallback,
          onToggleProvider: rejectingCallback,
          onSubmitApiKey: rejectingCallback,
          onRemoveApiKey: rejectingCallback,
        })
      )
    }).not.toThrow()
  })
})

