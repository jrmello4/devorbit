import { describe, expect, it } from 'vitest'
import {
  AGENT_RESULT_MAX_FILES_CHANGED_ITEMS,
  AGENT_RESULT_MAX_FRAME_CHARS,
  AGENT_RESULT_MAX_HANDOFF_CHARS,
  composeAgentResultContent,
  createAgentResultScanner,
  createLegacyAgentResult,
  parseAgentResultLine,
} from '../src/shared/agent-result'
import { orchestrationResultInstruction } from '../src/renderer/src/components/WorkspaceCanvas'

describe('shared agent result protocol (src/shared/agent-result.ts)', () => {
  describe('parseAgentResultLine', () => {
    it('accepts JSON result with version 1 for completed, blocked and failed outcomes', () => {
      const completed = parseAgentResultLine('DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"tudo pronto"}')
      expect(completed).toEqual({
        kind: 'result',
        result: {
          format: 'json',
          version: 1,
          outcome: 'completed',
          summary: 'tudo pronto',
        },
      })

      const blocked = parseAgentResultLine('DEVORBIT_RESULT: {"version":1,"outcome":"blocked","summary":"falta permissao"}')
      expect(blocked).toEqual({
        kind: 'result',
        result: {
          format: 'json',
          version: 1,
          outcome: 'blocked',
          summary: 'falta permissao',
        },
      })

      const failed = parseAgentResultLine('DEVORBIT_RESULT: {"version":1,"outcome":"failed","summary":"os testes falharam"}')
      expect(failed).toEqual({
        kind: 'result',
        result: {
          format: 'json',
          version: 1,
          outcome: 'failed',
          summary: 'os testes falharam',
        },
      })
    })

    it('rejects JSON without version as invalid-version', () => {
      expect(parseAgentResultLine('DEVORBIT_RESULT: {"outcome":"completed","summary":"sem versao"}')).toEqual({
        kind: 'invalid',
        reason: 'invalid-version',
      })
    })

    it('accepts JSON result with version: 1 explicitly provided', () => {
      const withVersion = parseAgentResultLine('DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"com versao"}')
      expect(withVersion).toEqual({
        kind: 'result',
        result: {
          format: 'json',
          version: 1,
          outcome: 'completed',
          summary: 'com versao',
        },
      })
    })

    it('rejects JSON result with unsupported version or unexpected fields', () => {
      const wrongVersion = parseAgentResultLine('DEVORBIT_RESULT: {"version":2,"outcome":"completed","summary":"invalido"}')
      expect(wrongVersion).toEqual({ kind: 'invalid', reason: 'invalid-version' })

      const extraFields = parseAgentResultLine('DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"ok","extra":"field"}')
      expect(extraFields).toEqual({ kind: 'invalid', reason: 'invalid-schema' })
    })

    it('rejects JSON result with invalid outcome or empty summary', () => {
      const badOutcome = parseAgentResultLine('DEVORBIT_RESULT: {"version":1,"outcome":"unknown","summary":"ok"}')
      expect(badOutcome).toEqual({ kind: 'invalid', reason: 'invalid-schema' })

      const emptySummary = parseAgentResultLine('DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"   "}')
      expect(emptySummary).toEqual({ kind: 'invalid', reason: 'invalid-summary' })
    })

    it('still parses legacy payloads without the structured fields (tolerant schema)', () => {
      const parsed = parseAgentResultLine('DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"payload antigo"}')
      expect(parsed).toEqual({
        kind: 'result',
        result: { format: 'json', version: 1, outcome: 'completed', summary: 'payload antigo' },
      })
    })

    it('accepts the structured handoff fields (handoff, filesChanged, testsExecuted, remainingIssues)', () => {
      const parsed = parseAgentResultLine(
        'DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"pronto","handoff":"linhas\\nescapadas contam","filesChanged":["src/a.ts","src/b.ts"],"testsExecuted":"vitest run: 42 ok","remainingIssues":"flaky test 3"}',
      )
      expect(parsed).toEqual({
        kind: 'result',
        result: {
          format: 'json',
          version: 1,
          outcome: 'completed',
          summary: 'pronto',
          handoff: 'linhas\nescapadas contam',
          filesChanged: ['src/a.ts', 'src/b.ts'],
          testsExecuted: 'vitest run: 42 ok',
          remainingIssues: 'flaky test 3',
        },
      })
    })

    it('does NOT truncate a handoff longer than 1000 chars (mission criterion: content after char 1000 survives)', () => {
      const tailMarker = 'CAUDA-PRESERVADA-APOS-CARACTERE-1000'
      const handoff = 'h'.repeat(4900) + '|' + tailMarker
      expect(handoff.length).toBeGreaterThan(1000)
      const parsed = parseAgentResultLine(
        `DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"ok","handoff":"${handoff}"}`,
      )
      expect(parsed.kind).toBe('result')
      if (parsed.kind !== 'result') return
      expect(parsed.result.handoff).toBe(handoff)
      expect(parsed.result.handoff!.length).toBe(handoff.length)
      // O conteúdo depois do caractere 1000 chega íntegro ao consumidor.
      expect(parsed.result.handoff!.slice(1000)).toContain(tailMarker)
    })

    it('applies the generous protective cap to the handoff (200k) without rejecting the frame', () => {
      const handoff = 'h'.repeat(AGENT_RESULT_MAX_HANDOFF_CHARS + 10_000)
      const parsed = parseAgentResultLine(
        `DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"ok","handoff":"${handoff}"}`,
      )
      expect(parsed.kind).toBe('result')
      if (parsed.kind !== 'result') return
      expect(parsed.result.handoff!.length).toBe(AGENT_RESULT_MAX_HANDOFF_CHARS)
    })

    it('caps filesChanged items (count and length) but keeps them structured', () => {
      const files = Array.from({ length: AGENT_RESULT_MAX_FILES_CHANGED_ITEMS + 20 }, (_, i) => `f${i}/` + 'p'.repeat(600))
      const parsed = parseAgentResultLine(
        `DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"ok","filesChanged":${JSON.stringify(files)}}`,
      )
      expect(parsed.kind).toBe('result')
      if (parsed.kind !== 'result') return
      expect(parsed.result.filesChanged!.length).toBe(AGENT_RESULT_MAX_FILES_CHANGED_ITEMS)
      expect(parsed.result.filesChanged![0].length).toBeLessThanOrEqual(500)
    })

    it('rejects structured fields with the wrong type as invalid-schema', () => {
      const wrongHandoff = parseAgentResultLine('DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"ok","handoff":42}')
      expect(wrongHandoff).toEqual({ kind: 'invalid', reason: 'invalid-schema' })

      const wrongFiles = parseAgentResultLine('DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"ok","filesChanged":"src/a.ts"}')
      expect(wrongFiles).toEqual({ kind: 'invalid', reason: 'invalid-schema' })

      const wrongFileItem = parseAgentResultLine('DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"ok","filesChanged":[7]}')
      expect(wrongFileItem).toEqual({ kind: 'invalid', reason: 'invalid-schema' })

      const wrongTests = parseAgentResultLine('DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"ok","testsExecuted":true}')
      expect(wrongTests).toEqual({ kind: 'invalid', reason: 'invalid-schema' })

      const wrongIssues = parseAgentResultLine('DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"ok","remainingIssues":{"text":"x"}}')
      expect(wrongIssues).toEqual({ kind: 'invalid', reason: 'invalid-schema' })
    })

    it('keeps the summary capped at 1000 chars', () => {
      const longSummary = 's'.repeat(1200)
      const parsed = parseAgentResultLine(
        `DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"${longSummary}"}`,
      )
      expect(parsed).toEqual({ kind: 'invalid', reason: 'invalid-summary' })
    })

    it('streams a large handoff frame split across chunks through the scanner', () => {
      const handoff = ('contexto '.repeat(559) + 'contexto').trim() // ~5031 chars, sem espaço na ponta
      expect(handoff.length).toBeGreaterThan(4_096)
      const frame = `DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"ok","handoff":"${handoff}"}`
      expect(frame.length).toBeGreaterThan(4_096)
      const scanner = createAgentResultScanner()
      const events = [
        ...scanner.push(frame.slice(0, 2000)),
        ...scanner.push(frame.slice(2000, 5000)),
        ...scanner.push(frame.slice(5000)),
        ...scanner.finish(),
      ]
      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('result')
      if (events[0].kind === 'result') expect(events[0].result.handoff).toBe(handoff)
    })

    it('parses legacy formats cleanly', () => {
      const completed = parseAgentResultLine('DEVORBIT_RESULT: CONCLUIDO: feito com sucesso')
      expect(completed).toEqual({
        kind: 'result',
        result: {
          format: 'legacy',
          version: 0,
          outcome: 'completed',
          summary: 'CONCLUIDO: feito com sucesso',
        },
      })

      const blocked = parseAgentResultLine('DEVORBIT_RESULT: BLOQUEADO: sem token')
      expect(blocked).toEqual({
        kind: 'result',
        result: {
          format: 'legacy',
          version: 0,
          outcome: 'blocked',
          summary: 'BLOQUEADO: sem token',
        },
      })

      const failed = parseAgentResultLine('DEVORBIT_RESULT: FALHA: quebrou')
      expect(failed).toEqual({
        kind: 'result',
        result: {
          format: 'legacy',
          version: 0,
          outcome: 'failed',
          summary: 'FALHA: quebrou',
        },
      })
    })

    it('returns none for lines not starting with DEVORBIT_RESULT', () => {
      expect(parseAgentResultLine('Building project...')).toEqual({ kind: 'none' })
      expect(parseAgentResultLine('random log message')).toEqual({ kind: 'none' })
    })

    it('accepts PTY ANSI colors around and inside the marker without loosening the schema', () => {
      const colored = parseAgentResultLine('\u001b[32mDEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"tudo pronto"}\u001b[0m')
      expect(colored).toEqual({
        kind: 'result',
        result: { format: 'json', version: 1, outcome: 'completed', summary: 'tudo pronto' },
      })

      const coloredInside = parseAgentResultLine('DEVORBIT_RESULT:\u001b[0m \u001b[1m{"version":1,"outcome":"blocked","summary":"falta permissao"}\u001b[0m')
      expect(coloredInside).toEqual({
        kind: 'result',
        result: { format: 'json', version: 1, outcome: 'blocked', summary: 'falta permissao' },
      })

      const coloredValue = parseAgentResultLine('DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"cor \u001b[31mvermelha\u001b[0m ok"}')
      expect(coloredValue).toEqual({
        kind: 'result',
        result: { format: 'json', version: 1, outcome: 'completed', summary: 'cor vermelha ok' },
      })

      const coloredLegacy = parseAgentResultLine('\u001b[1;32mDEVORBIT_RESULT: CONCLUIDO: entrega ok\u001b[0m')
      expect(coloredLegacy).toEqual({
        kind: 'result',
        result: { format: 'legacy', version: 0, outcome: 'completed', summary: 'CONCLUIDO: entrega ok' },
      })
    })

    it('accepts ECMA-48 sequences beyond SGR: 8-bit CSI, OSC, DCS and colon params', () => {
      const eightBit = parseAgentResultLine('\u009b32mDEVORBIT_RESULT: CONCLUIDO: oito bits\u009b0m')
      expect(eightBit).toEqual({
        kind: 'result',
        result: { format: 'legacy', version: 0, outcome: 'completed', summary: 'CONCLUIDO: oito bits' },
      })

      const oscBefore = parseAgentResultLine(
        '\u001b]0;título da janela\u0007DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"com título"}'
      )
      expect(oscBefore).toEqual({
        kind: 'result',
        result: { format: 'json', version: 1, outcome: 'completed', summary: 'com título' },
      })

      const dcsBefore = parseAgentResultLine('\u001bP1;2|payload\u001b\\DEVORBIT_RESULT: CONCLUIDO: depois do dcs')
      expect(dcsBefore).toEqual({
        kind: 'result',
        result: { format: 'legacy', version: 0, outcome: 'completed', summary: 'CONCLUIDO: depois do dcs' },
      })

      const colonParams = parseAgentResultLine('\u001b[38:5:196mDEVORBIT_RESULT: CONCLUIDO: colon param\u001b[0m')
      expect(colonParams).toEqual({
        kind: 'result',
        result: { format: 'legacy', version: 0, outcome: 'completed', summary: 'CONCLUIDO: colon param' },
      })
    })

    it('applies the frame limit to the stripped frame and ignores long noise', () => {
      const summary = 'x'.repeat(600)
      const decoratedSummary = [...`DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"${summary}"}`]
        .map((character) => `\u001b[38:5:196m${character}\u001b[0m`)
        .join('')
      // O limite vale para o frame LIMPO de ANSI: um título OSC longo (limpo
      // pelo strip) empurra o comprimento bruto acima do teto sem invalidar.
      const oscPad = `\u001b]0;${'p'.repeat(AGENT_RESULT_MAX_FRAME_CHARS)}\u0007`
      const decorated = `${oscPad}\u001b[32m${decoratedSummary}`
      expect(decorated.length).toBeGreaterThan(AGENT_RESULT_MAX_FRAME_CHARS)
      const parsed = parseAgentResultLine(decorated)
      expect(parsed.kind).toBe('result')
      if (parsed.kind === 'result') expect(parsed.result.summary).toBe(summary)

      expect(parseAgentResultLine('x'.repeat(AGENT_RESULT_MAX_FRAME_CHARS + 10))).toEqual({ kind: 'none' })
      expect(parseAgentResultLine(`DEVORBIT_RESULT: ${'x'.repeat(AGENT_RESULT_MAX_FRAME_CHARS)}`)).toEqual({
        kind: 'invalid',
        reason: 'frame-too-large',
      })
    })

    it('still rejects malformed colored frames and ignores colored noise', () => {
      expect(parseAgentResultLine('\u001b[32mDEVORBIT_RESULT:\u001b[0m')).toEqual({ kind: 'invalid', reason: 'empty' })
      expect(parseAgentResultLine('\u001b[32mDEVORBIT_RESULT: {"version":0,"outcome":"completed","summary":"x"}\u001b[0m')).toEqual({
        kind: 'invalid',
        reason: 'invalid-version',
      })
      expect(parseAgentResultLine('\u001b[32mtudo certo\u001b[0m')).toEqual({ kind: 'none' })
    })
  })

  describe('createAgentResultScanner', () => {
    it('streams colored frames split across chunks and ignores colored noise', () => {
      const scanner = createAgentResultScanner()
      const events = [
        ...scanner.push('\u001b[33mAviso: aguarde\u001b[0m\n'),
        ...scanner.push('\u001b[32mDEVORBIT_RES'),
        ...scanner.push('ULT: {"version":1,"outcome":"comp'),
        ...scanner.push('leted","summary":"fragmen'),
        ...scanner.push('tado"}\u001b[0m\n'),
        ...scanner.push('DEVORBIT_RESULT: CONCLUIDO: espelho legado\n'),
        ...scanner.finish(),
      ]

      expect(events).toEqual([
        {
          kind: 'result',
          result: { format: 'json', version: 1, outcome: 'completed', summary: 'fragmentado' },
        },
      ])
    })

    it('streams chunks and extracts a version 1 result before its legacy mirror', () => {
      const scanner = createAgentResultScanner()
      const events = [
        ...scanner.push('Iniciando...\n'),
        ...scanner.push('DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"sucesso total"}\n'),
        ...scanner.push('DEVORBIT_RESULT: CONCLUIDO: espelho legado\n'),
        ...scanner.finish(),
      ]

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        kind: 'result',
        result: {
          format: 'json',
          version: 1,
          outcome: 'completed',
          summary: 'sucesso total',
        },
      })
    })

    it('delivers a complete JSON frame when the PTY omits the trailing newline', () => {
      const scanner = createAgentResultScanner()

      expect(scanner.push('DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"sem enter"}')).toEqual([
        {
          kind: 'result',
          result: {
            format: 'json',
            version: 1,
            outcome: 'completed',
            summary: 'sem enter',
          },
        },
      ])
    })

    it('streams chunks and detects a blocked version 1 outcome', () => {
      const scanner = createAgentResultScanner()
      const events = [
        ...scanner.push('DEVORBIT_RESULT: {"version":1,"outcome":"blocked","summary":"preciso de ajuda"}\n'),
        ...scanner.finish(),
      ]

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        kind: 'result',
        result: {
          format: 'json',
          version: 1,
          outcome: 'blocked',
          summary: 'preciso de ajuda',
        },
      })
    })

    it('streams chunks and detects a failed version 1 outcome', () => {
      const scanner = createAgentResultScanner()
      const events = [
        ...scanner.push('DEVORBIT_RESULT: {"version":1,"outcome":"failed","summary":"falha de teste"}\n'),
        ...scanner.finish(),
      ]

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        kind: 'result',
        result: {
          format: 'json',
          version: 1,
          outcome: 'failed',
          summary: 'falha de teste',
        },
      })
    })

    it('rejects versionless JSON and falls back to a later valid legacy mirror', () => {
      const scanner = createAgentResultScanner()
      const events = [
        ...scanner.push('DEVORBIT_RESULT: {"outcome":"completed","summary":"sem versao"}\n'),
        ...scanner.push('DEVORBIT_RESULT: CONCLUIDO: espelho legado\n'),
        ...scanner.finish(),
      ]

      expect(events).toEqual([
        { kind: 'invalid', reason: 'invalid-version' },
        {
          kind: 'result',
          result: {
            format: 'legacy',
            version: 0,
            outcome: 'completed',
            summary: 'CONCLUIDO: espelho legado',
          },
        },
      ])
    })
  })

  describe('createLegacyAgentResult', () => {
    it('creates a legacy result object', () => {
      const legacy = createLegacyAgentResult('completed', 'resumo manual')
      expect(legacy).toEqual({
        format: 'legacy',
        version: 0,
        outcome: 'completed',
        summary: 'resumo manual',
      })
    })
  })
})

describe('orchestration instruction contract', () => {
  it('embeds a structured JSON example with version 1 accepted by parseJsonBody', () => {
    const example = orchestrationResultInstruction.match(/DEVORBIT_RESULT:\s*(\{[^}]*\})/)
    expect(example).not.toBeNull()
    expect(parseAgentResultLine(`DEVORBIT_RESULT: ${example![1]}`)).toEqual({
      kind: 'result',
      result: {
        format: 'json',
        version: 1,
        outcome: 'completed',
        summary: 'resumo objetivo',
        handoff: 'contexto técnico completo para o próximo agente continuar a tarefa',
      },
    })
  })

  it('documents the optional structured fields to the agent', () => {
    expect(orchestrationResultInstruction).toContain('handoff')
    expect(orchestrationResultInstruction).toContain('filesChanged')
    expect(orchestrationResultInstruction).toContain('testsExecuted')
    expect(orchestrationResultInstruction).toContain('remainingIssues')
  })
})

describe('composeAgentResultContent (bloco completo para o próximo agente)', () => {
  const structuredResult = (): Parameters<typeof composeAgentResultContent>[0] => ({
    format: 'json',
    version: 1,
    outcome: 'completed',
    summary: 'Implementado e testado.',
    handoff: 'Estado detalhado: decidi usar X porque Y; próximos passos Z.',
    filesChanged: ['src/a.ts', 'src/b.ts'],
    testsExecuted: 'npx vitest run: 12 ok',
    remainingIssues: 'Nenhuma.',
  })

  it('legacy result (só summary) sai idêntico ao summary', () => {
    const content = composeAgentResultContent(createLegacyAgentResult('completed', 'resumo simples'), 24_000)
    expect(content).toBe('resumo simples')
  })

  it('inclui todas as seções estruturadas na ordem summary → handoff → arquivos → testes → pendências', () => {
    const content = composeAgentResultContent(structuredResult(), 24_000)
    expect(content).toContain('Implementado e testado.')
    expect(content.indexOf('## Handoff para o próximo agente')).toBeGreaterThan(0)
    expect(content.indexOf('## Arquivos alterados')).toBeGreaterThan(content.indexOf('## Handoff'))
    expect(content.indexOf('## Testes executados')).toBeGreaterThan(content.indexOf('## Arquivos alterados'))
    expect(content.indexOf('## Pendências')).toBeGreaterThan(content.indexOf('## Testes executados'))
    expect(content).toContain('- src/a.ts')
    expect(content).toContain('Nenhuma.')
  })

  it('preserva handoff >1000 chars íntegro (critério da missão: conteúdo após o caractere 1000)', () => {
    const tailMarker = 'CAUDA-PRESERVADA-APOS-CARACTERE-1000'
    const result = { ...structuredResult(), handoff: 'h'.repeat(4900) + '|' + tailMarker }
    const content = composeAgentResultContent(result, 24_000)
    expect(content.length).toBeGreaterThan(5000)
    expect(content.slice(1000)).toContain(tailMarker)
  })

  it('com cap pequeno prioriza o handoff: descarta secundários antes de cortar o handoff', () => {
    const result = structuredResult()
    const summaryAndHandoff = `${result.summary}\n\n## Handoff para o próximo agente\n${result.handoff}`
    const content = composeAgentResultContent(result, summaryAndHandoff.length + 10)
    expect(content).toBe(summaryAndHandoff)
  })

  it('corta no cap do destino apenas como último recurso (handoff incluído)', () => {
    const result = { ...structuredResult(), handoff: 'h'.repeat(5000) }
    const content = composeAgentResultContent(result, 3000)
    expect(content.length).toBe(3000)
    expect(content).toContain('## Handoff para o próximo agente')
  })
})
