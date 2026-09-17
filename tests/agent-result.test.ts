import { describe, expect, it } from 'vitest'
import {
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
      },
    })
  })
})
