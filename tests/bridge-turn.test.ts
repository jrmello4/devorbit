import { afterEach, describe, expect, it, vi } from 'vitest'
import { bridgeTurnContent, createBridgeTurn, type BridgeTurnDiagnostic } from '../src/main/bridge-turn'
import type { TerminalEvent } from '../src/main/terminal-session'
import type { AgentInstructionPhase } from '../src/shared/agent-instruction-contract'

afterEach(() => vi.useRealTimers())

function harness() {
  vi.useFakeTimers()
  const listeners = new Set<(event: TerminalEvent) => void>()
  const trace: BridgeTurnDiagnostic[] = []
  const content = bridgeTurnContent('Responda apenas DEVORBIT_BRIDGE_OK. Não altere arquivos.', 'nonce1')
  const turn = createBridgeTurn({ terminalId: 'worker', turnId: 'nonce1', provider: 'codex', content,
    idleMs: 1000, overallMs: 2000, onDiagnostic: event => trace.push(event),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  })
  const phase = (phase: AgentInstructionPhase) => turn.instruction({ kind: 'instruction',
    terminalId: 'worker', turnId: 'nonce1', provider: 'codex', at: Date.now(), attempt: 1, phase })
  const data = (data: string) => { for (const listener of [...listeners]) listener({ id: 'worker', type: 'data', data }) }
  return { ...turn, listeners, trace, content, phase, data }
}

const frame = 'DEVORBIT_RESULT_nonce1: {"version":1,"outcome":"completed","summary":"DEVORBIT_BRIDGE_OK"}'

describe('Bridge turn lifecycle and result provenance', () => {
  it('starts an independent turn on the same terminal after a failed turn and rejects its late result', async () => {
    vi.useFakeTimers()
    const listeners = new Set<(event: TerminalEvent) => void>()
    const start = (turnId: string) => {
      const turn = createBridgeTurn({ terminalId: 'worker', turnId, provider: 'codex',
        content: bridgeTurnContent('A task', turnId), idleMs: 1000, overallMs: 2000,
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
      })
      for (const phase of ['submit_sent', 'acked'] as const) turn.instruction({ kind: 'instruction',
        terminalId: 'worker', turnId, provider: 'codex', at: Date.now(), attempt: 1, phase })
      return turn
    }
    const data = (text: string) => { for (const listener of [...listeners]) listener({ id: 'worker', type: 'data', data: text }) }
    const first = start('nonce1')
    data('Worker output without a result marker')
    await vi.advanceTimersByTimeAsync(1000)
    expect(await first.pending).toMatchObject({ errorCode: 'RESULT_MARKER_MISSING' })
    expect(listeners.size).toBe(0)
    const second = start('nonce2')
    data(frame)
    expect(second.isResultReady()).toBe(false)
    data(frame.replace('nonce1', 'nonce2').replace('DEVORBIT_BRIDGE_OK', 'DEVORBIT_SECOND_TURN_OK'))
    expect(await second.pending).toMatchObject({ result: 'DEVORBIT_SECOND_TURN_OK', diagnostic: { turnId: 'nonce2' } })
    expect(listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores input echo, a stale nonce and a marker before submit; validates a post-submit result after acknowledgement', async () => {
    const h = harness()
    h.phase('content_written')
    h.data(`${h.content}\r\n`)
    h.data(frame)
    expect(h.isResultReady()).toBe(false)
    h.phase('submit_sent')
    h.data(frame.replace('nonce1', 'old-turn'))
    expect(h.isResultReady()).toBe(false)
    h.data(`\r\n• ${frame}\r\n`)
    expect(h.isResultReady()).toBe(true)
    let done = false
    void h.pending.then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)
    h.phase('acked')
    expect(await h.pending).toMatchObject({ result: 'DEVORBIT_BRIDGE_OK', diagnostic: { turnId: 'nonce1', phase: 'turn_completed' } })
    expect(h.listeners.size).toBe(0)
    expect(h.trace.some(event => event.phase === 'nonce_matched' && event.nonceState === 'matched')).toBe(true)
    expect(JSON.stringify(h.trace)).not.toContain('Responda apenas')
  })

  it('handles fragmented ANSI and visual JSON wrapping without accepting the legacy protocol echoed by a TUI', async () => {
    const h = harness()
    h.phase('submit_sent')
    h.phase('acked')
    h.data('\nDEVORBIT_RESULT: BLOQUEADO: ou DEVORBIT_RESULT: FALHA:,\n')
    expect(h.isResultReady()).toBe(false)
    h.data('\n\x1b[')
    h.data('32m• DEVORBIT_RESULT_nonce1: {"version":1,"outcome":"completed",\r\n')
    h.data('"summary":"DEVORBIT_\r\nBRIDGE_OK"}\x1b[0m')
    expect(await h.pending).toMatchObject({ result: 'DEVORBIT_BRIDGE_OK' })
  })

  it('does not let a prose mention of this nonce hide the real result in the same PTY chunk', async () => {
    const h = harness()
    h.phase('submit_sent')
    h.phase('acked')
    h.data(`${h.content}\r\n${frame}\r\n`)
    expect(await h.pending).toMatchObject({ result: 'DEVORBIT_BRIDGE_OK' })
  })

  it('reassembles a marker itself wrapped by a terminal and ignores a stale complete frame', async () => {
    const h = harness()
    h.phase('submit_sent')
    h.phase('acked')
    h.data(frame.replace('nonce1', 'old-turn'))
    h.data(frame.replace('nonce1:', 'non\r\nce1:'))
    expect(await h.pending).toMatchObject({ result: 'DEVORBIT_BRIDGE_OK' })
  })

  it('retains a result marker chunk that also occurs in the instruction until the JSON arrives', async () => {
    const h = harness()
    h.phase('submit_sent')
    h.phase('acked')
    h.data('DEVORBIT_RESULT_nonce1:')
    h.data(' {"version":1,"outcome":"completed","summary":"DEVORBIT_BRIDGE_OK"}')
    expect(h.isResultReady()).toBe(true)
    expect(await h.pending).toMatchObject({ result: 'DEVORBIT_BRIDGE_OK' })
  })

  it('does not turn the echoed protocol followed by an unmarked JSON object into a result', async () => {
    const h = harness()
    h.phase('submit_sent')
    h.phase('acked')
    for (let index = 0; index < h.content.length; index += 20) h.data(h.content.slice(index, index + 20))
    h.data('\n{"version":1,"outcome":"completed","summary":"unmarked"}')
    expect(h.isResultReady()).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await h.pending).toMatchObject({ errorCode: 'RESULT_MARKER_MISSING' })
  })

  it('does not confuse task text about an unknown model with a fatal provider message', async () => {
    const h = harness()
    h.phase('submit_sent')
    h.phase('acked')
    h.data('Discussão sobre unknown model na documentação.\n')
    expect(h.isResultReady()).toBe(false)
    h.data('Error: unknown model requested\n')
    expect(await h.pending).toMatchObject({ errorCode: 'PROVIDER_STARTUP_FAILED' })
  })

  it.each([
    ['no output', '', 'RESULT_TIMEOUT'],
    ['unmarked output', 'O agente respondeu sem o envelope do turno.', 'RESULT_MARKER_MISSING'],
    ['invalid schema', 'DEVORBIT_RESULT_nonce1: {"version":1,"outcome":"unexpected","summary":"x"}', 'RESULT_PARSE_FAILED'],
  ])('distinguishes %s', async (_name, output, errorCode) => {
    const h = harness()
    h.phase('submit_sent')
    h.phase('acked')
    h.data(output)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await h.pending).toMatchObject({ errorCode, diagnostic: { errorCode, provider: 'codex', terminalId: 'worker' } })
    expect(h.listeners.size).toBe(0)
  })

  it('rejects wrapped ANSI input echo without classifying it as a result', async () => {
    const h = harness()
    h.phase('submit_sent')
    h.phase('acked')
    for (let index = 0; index < h.content.length; index += 45) {
      h.data(`\x1b[32m› ${h.content.slice(index, index + 45)}\x1b[0m\r\n`)
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(await h.pending).toMatchObject({ errorCode: 'ECHO_ONLY' })
  })

  it('preserves exit code and cancellation separately and releases observers', async () => {
    const h = harness()
    for (const listener of [...h.listeners]) listener({ id: 'worker', type: 'exit', code: 7 })
    expect(await h.pending).toMatchObject({ errorCode: 'TERMINAL_EXITED', diagnostic: { exitCode: 7 } })
    const cancelled = harness()
    cancelled.pending.cancel()
    expect(await cancelled.pending).toMatchObject({ errorCode: 'CANCELLED' })
    expect(cancelled.listeners.size).toBe(0)
  })
})
