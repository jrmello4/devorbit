import { describe, expect, it } from 'vitest'
import {
  AGENT_BRIDGE_ID_MAX_CHARS,
  AGENT_BRIDGE_SUMMARY_MAX_CHARS,
  AGENT_BRIDGE_TIMESTAMP_MAX,
  assertAgentBridgeEvent,
  canTransitionAgentBridgeEvent,
  parseAgentBridgeEvent,
  parseAgentBridgeEventJson,
  serializeAgentBridgeEvent,
  transitionAgentBridgeEvent,
  type AgentBridgeEvent,
} from '../src/shared/agent-bridge-event'

const minimal = (): AgentBridgeEvent => ({
  requestId: 'req-1',
  source: 'agent-coordenador',
  target: 'agy',
  status: 'pending',
})

const full = (): AgentBridgeEvent => ({
  ...minimal(),
  createdAt: 1_000,
  updatedAt: 2_000,
  summary: 'delegação iniciada',
})

const invalidReason = (value: unknown): string => {
  const parsed = parseAgentBridgeEvent(value)
  return parsed.kind === 'invalid' ? parsed.reason : 'accepted'
}

describe('agent bridge event contract', () => {
  it('accepts a minimal pending event and round-trips JSON', () => {
    const event = assertAgentBridgeEvent(minimal())
    expect(event).toEqual(minimal())

    const serialized = serializeAgentBridgeEvent(event)
    expect(parseAgentBridgeEventJson(serialized)).toEqual({ kind: 'event', event: minimal() })
    expect(JSON.parse(serialized)).toEqual(minimal())
  })

  it('accepts timestamps and summary, trimming the summary', () => {
    const parsed = parseAgentBridgeEvent({ ...full(), summary: '  concluído sem erros  ' })
    expect(parsed).toEqual({
      kind: 'event',
      event: { ...full(), summary: 'concluído sem erros' },
    })
  })

  it('accepts the id and summary boundaries', () => {
    const id = 'a'.repeat(AGENT_BRIDGE_ID_MAX_CHARS)
    expect(parseAgentBridgeEvent({ ...minimal(), requestId: id })).toEqual({
      kind: 'event',
      event: { ...minimal(), requestId: id },
    })

    const summary = 's'.repeat(AGENT_BRIDGE_SUMMARY_MAX_CHARS)
    expect(parseAgentBridgeEvent({ ...minimal(), summary })).toEqual({
      kind: 'event',
      event: { ...minimal(), summary },
    })
    expect(parseAgentBridgeEvent({ ...minimal(), summary: `${summary}s` })).toEqual({
      kind: 'invalid',
      reason: 'invalid-summary',
    })
  })

  it('rejects values that are not plain objects', () => {
    expect(invalidReason(null)).toBe('not-object')
    expect(invalidReason('event')).toBe('not-object')
    expect(invalidReason([])).toBe('not-object')
    expect(invalidReason(new Date())).toBe('invalid-request-id')
  })

  it('rejects unknown fields to keep the contract strict', () => {
    expect(invalidReason({ ...minimal(), extra: true })).toBe('unknown-field')
  })

  it('rejects malformed request ids, sources and targets', () => {
    expect(invalidReason({ ...minimal(), requestId: undefined })).toBe('invalid-request-id')
    expect(invalidReason({ ...minimal(), requestId: '' })).toBe('invalid-request-id')
    expect(invalidReason({ ...minimal(), requestId: 'a'.repeat(AGENT_BRIDGE_ID_MAX_CHARS + 1) })).toBe('invalid-request-id')
    expect(invalidReason({ ...minimal(), requestId: '-req' })).toBe('invalid-request-id')
    expect(invalidReason({ ...minimal(), requestId: 'req 1' })).toBe('invalid-request-id')

    expect(invalidReason({ ...minimal(), source: '' })).toBe('invalid-source')
    expect(invalidReason({ ...minimal(), source: 42 })).toBe('invalid-source')
    expect(invalidReason({ ...minimal(), target: '' })).toBe('invalid-target')
    expect(invalidReason({ ...minimal(), target: 'a/b' })).toBe('invalid-target')
  })

  it('rejects delegation to the source itself', () => {
    expect(invalidReason({ ...minimal(), target: 'agent-coordenador' })).toBe('self-target')
  })

  it('rejects unknown statuses', () => {
    expect(invalidReason({ ...minimal(), status: 'running' })).toBe('invalid-status')
    expect(invalidReason({ ...minimal(), status: 'PENDING' })).toBe('invalid-status')
    expect(invalidReason({ ...minimal(), status: undefined })).toBe('invalid-status')
  })

  it('rejects invalid timestamps and updatedAt before createdAt', () => {
    expect(invalidReason({ ...minimal(), createdAt: -1 })).toBe('invalid-timestamp')
    expect(invalidReason({ ...minimal(), createdAt: 1.5 })).toBe('invalid-timestamp')
    expect(invalidReason({ ...minimal(), createdAt: Number.NaN })).toBe('invalid-timestamp')
    expect(invalidReason({ ...minimal(), createdAt: '1000' })).toBe('invalid-timestamp')
    expect(invalidReason({ ...minimal(), updatedAt: AGENT_BRIDGE_TIMESTAMP_MAX + 1 })).toBe('invalid-timestamp')
    expect(invalidReason({ ...minimal(), createdAt: 2_000, updatedAt: 1_000 })).toBe('invalid-timestamp')
  })

  it('rejects invalid summaries', () => {
    expect(invalidReason({ ...minimal(), summary: '' })).toBe('invalid-summary')
    expect(invalidReason({ ...minimal(), summary: '   ' })).toBe('invalid-summary')
    expect(invalidReason({ ...minimal(), summary: 'linha\nquebrada' })).toBe('invalid-summary')
    expect(invalidReason({ ...minimal(), summary: 'escape\u001b[31m' })).toBe('invalid-summary')
    expect(invalidReason({ ...minimal(), summary: 42 })).toBe('invalid-summary')
  })

  it('never exposes undefined keys when serializing', () => {
    const serialized = serializeAgentBridgeEvent(minimal())
    expect(serialized).toBe('{"requestId":"req-1","source":"agent-coordenador","target":"agy","status":"pending"}')
  })

  it('throws with the validation reason through assert/serialize', () => {
    expect(() => assertAgentBridgeEvent({ ...minimal(), status: 'running' })).toThrowError(
      /invalid-status/,
    )
    try {
      serializeAgentBridgeEvent({ ...minimal(), requestId: '-bad' })
      expect.unreachable('serialização deveria falhar para evento inválido')
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid-request-id' })
    }
  })

  it('parses JSON strings and rejects malformed or non-string input', () => {
    expect(parseAgentBridgeEventJson('{')).toEqual({ kind: 'invalid', reason: 'invalid-json' })
    expect(parseAgentBridgeEventJson('null')).toEqual({ kind: 'invalid', reason: 'not-object' })
    expect(parseAgentBridgeEventJson(undefined)).toEqual({ kind: 'invalid', reason: 'invalid-json' })
    expect(parseAgentBridgeEventJson(JSON.stringify(full()))).toEqual({ kind: 'event', event: full() })
  })
})

describe('agent bridge event transitions', () => {
  it('allows pending to reach any terminal status only', () => {
    expect(canTransitionAgentBridgeEvent('pending', 'completed')).toBe(true)
    expect(canTransitionAgentBridgeEvent('pending', 'blocked')).toBe(true)
    expect(canTransitionAgentBridgeEvent('pending', 'failed')).toBe(true)
    expect(canTransitionAgentBridgeEvent('pending', 'pending')).toBe(false)
    expect(canTransitionAgentBridgeEvent('completed', 'failed')).toBe(false)
    expect(canTransitionAgentBridgeEvent('blocked', 'completed')).toBe(false)
    expect(canTransitionAgentBridgeEvent('failed', 'blocked')).toBe(false)
  })

  it('transitions pending events preserving identity and applying summary/updatedAt', () => {
    const next = transitionAgentBridgeEvent(full(), {
      status: 'completed',
      summary: 'resultado recebido',
      updatedAt: 3_000,
    })
    expect(next).toEqual({ ...full(), status: 'completed', summary: 'resultado recebido', updatedAt: 3_000 })
    expect(serializeAgentBridgeEvent(next)).toContain('"status":"completed"')
  })

  it('supports blocked and failed terminal transitions', () => {
    expect(transitionAgentBridgeEvent(minimal(), { status: 'blocked', summary: 'sem permissão' })).toMatchObject({
      status: 'blocked',
      summary: 'sem permissão',
    })
    expect(transitionAgentBridgeEvent(minimal(), { status: 'failed' })).toMatchObject({ status: 'failed' })
  })

  it('rejects leaving a terminal state or repeating the current state', () => {
    const completed = transitionAgentBridgeEvent(minimal(), { status: 'completed' })
    for (const status of ['pending', 'completed', 'blocked', 'failed'] as const) {
      expect(() => transitionAgentBridgeEvent(completed, { status })).toThrowError(/Transição/)
    }
    expect(() => transitionAgentBridgeEvent(minimal(), { status: 'pending' })).toThrowError(/Transição/)
    try {
      transitionAgentBridgeEvent(completed, { status: 'failed' })
      expect.unreachable('transição terminal deveria falhar')
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid-transition' })
    }
  })

  it('rejects unknown runtime statuses even when cast', () => {
    try {
      transitionAgentBridgeEvent(minimal(), { status: 'running' as never })
      expect.unreachable('status desconhecido deveria falhar')
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid-transition' })
    }
  })

  it('validates the resulting event before returning it', () => {
    expect(() =>
      transitionAgentBridgeEvent(minimal(), { status: 'completed', summary: 's'.repeat(AGENT_BRIDGE_SUMMARY_MAX_CHARS + 1) }),
    ).toThrowError(/invalid-summary/)
    expect(() =>
      transitionAgentBridgeEvent(full(), { status: 'completed', updatedAt: 500 }),
    ).toThrowError(/invalid-timestamp/)
  })

  it('rejects invalid input events before attempting a transition', () => {
    expect(() => transitionAgentBridgeEvent({ ...minimal(), target: 'agent-coordenador' }, { status: 'completed' })).toThrowError(
      /self-target/,
    )
  })
})

describe('agent bridge event — metadados de delegação', () => {
  it('aceita origem, destino, profundidade e resultado estruturado', () => {
    const event = {
      ...minimal(),
      status: 'completed' as const,
      origin: 'agent-coordenador',
      destination: 'agy',
      depth: 2,
      result: { outcome: 'completed' as const, summary: 'ok', artifacts: ['a.md'] },
    }
    expect(parseAgentBridgeEvent(event)).toEqual({ kind: 'event', event })
    expect(JSON.parse(serializeAgentBridgeEvent(event))).toEqual(event)
  })

  it('rejeita metadados de delegação malformados', () => {
    expect(invalidReason({ ...minimal(), origin: 'bad/origin' })).toBe('invalid-origin')
    expect(invalidReason({ ...minimal(), destination: 42 })).toBe('invalid-destination')
    expect(invalidReason({ ...minimal(), depth: -1 })).toBe('invalid-depth')
    expect(invalidReason({ ...minimal(), depth: 1.5 })).toBe('invalid-depth')
    expect(invalidReason({ ...minimal(), result: { outcome: 'pending' } })).toBe('invalid-result')
    expect(invalidReason({ ...minimal(), result: { outcome: 'completed', extra: true } })).toBe('invalid-result')
  })

  it('transições carregam destino e resultado', () => {
    const next = transitionAgentBridgeEvent(minimal(), {
      status: 'completed',
      destination: 'agy',
      result: { outcome: 'completed', summary: 'ok' },
    })
    expect(next).toMatchObject({ destination: 'agy', result: { outcome: 'completed', summary: 'ok' } })
  })
})
