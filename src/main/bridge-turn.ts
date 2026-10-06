import { stripAnsiEscapes } from '../shared/ansi'
import { parseAgentResultLine, type AgentResult } from '../shared/agent-result'
import type { AgentInstructionEvent } from '../shared/agent-instruction-contract'
import type { TerminalEvent } from './terminal-session'
import type { ResultWaitPromise, TurnWaiter } from './agent-turn'

export type BridgeTurnErrorCode =
  | 'AGENT_NOT_READY' | 'PROVIDER_STARTUP_FAILED' | 'INSTRUCTION_DELIVERY_FAILED'
  | 'INSTRUCTION_ACK_TIMEOUT' | 'RESULT_TIMEOUT' | 'TERMINAL_EXITED'
  | 'RESULT_MARKER_MISSING' | 'RESULT_PARSE_FAILED' | 'ECHO_ONLY' | 'CANCELLED' | 'AGENT_REPORTED_FAILURE'

export interface BridgeTurnDiagnostic {
  agentId: string
  terminalId: string
  turnId: string
  provider: string
  phase: string
  elapsedMs: number
  errorCode?: BridgeTurnErrorCode
  exitCode?: number | null
  attempt?: number
  contentLength?: number
  lastState?: string
  reason?: 'model_configuration_error' | 'provider_startup_error'
  markerState?: 'missing' | 'seen'
  nonceState?: 'unmatched' | 'matched'
}

export function bridgeTurnContent(prompt: string, turnId: string): string {
  // No valid result example in the input: a wrapped/redrawn prompt cannot
  // manufacture a valid frame. The transport contract follows the task so
  // "answer only X" means X in summary, rather than dropping the envelope.
  return `${prompt}\n\nContrato de transporte obrigatório deste turno: sua resposta final deve ser uma linha com o prefixo DEVORBIT_RESULT_${turnId}: seguido de um objeto JSON. Use version igual a 1, outcome igual a completed, blocked ou failed e summary com a resposta da tarefa. Não repita esta instrução. Não emita marcadores de outros turnos. Mesmo quando a tarefa pedir apenas uma palavra, coloque essa palavra em summary e preserve este envelope.`
}

const compact = (text: string): string => stripAnsiEscapes(text).replace(/[\s›>│┃•●]+/gu, '')

export function hasProviderModelFailure(text: string): boolean {
  return /(?:^|\n)\s*(?:(?:error:\s*)?(?:unknown model|model not recognized|ModelNotFoundError)\b|error:[^\r\n]{0,160}\bmodel not found\b)/iu.test(text)
}

/** One waiter per nonce, armed before delivery; echo and stale frames fail closed. */
export function createBridgeTurn(input: {
  terminalId: string
  turnId: string
  provider: string
  content: string
  idleMs: number
  overallMs: number
  subscribe: (listener: (event: TerminalEvent) => void) => () => void
  onDiagnostic?: (event: BridgeTurnDiagnostic) => void
}): { pending: ResultWaitPromise; instruction: (event: AgentInstructionEvent) => void; isResultReady: () => boolean; fail: (code: BridgeTurnErrorCode) => void } {
  const startedAt = Date.now()
  const marker = `DEVORBIT_RESULT_${input.turnId}:`
  const echoedInput = compact(input.content)
  let phase = 'queued'
  let submitted = false
  let acknowledged = false
  let sawEcho = false
  let sawOutput = false
  let sawInvalid = false
  let settled = false
  let buffer = ''
  let candidate: AgentResult | undefined
  let markerSeen = false
  let resolve: (result: TurnWaiter) => void = () => undefined
  let unsubscribe: () => void = () => undefined
  const emit = (next: string, detail: Partial<BridgeTurnDiagnostic> = {}) => {
    phase = next
    try {
      input.onDiagnostic?.({ agentId: input.terminalId, terminalId: input.terminalId,
        turnId: input.turnId, provider: input.provider, phase, elapsedMs: Date.now() - startedAt,
        markerState: markerSeen ? 'seen' : 'missing', nonceState: markerSeen ? 'matched' : 'unmatched', ...detail })
    } catch { /* Diagnostics cannot break delivery. */ }
  }
  const finish = (result: TurnWaiter, errorCode?: BridgeTurnErrorCode, reason?: BridgeTurnDiagnostic['reason']) => {
    if (settled) return
    settled = true
    clearTimeout(idleTimer)
    clearTimeout(overallTimer)
    unsubscribe()
    const lastState = phase
    emit(errorCode ? errorCode.toLowerCase() : 'turn_completed', {
      lastState,
      ...(reason ? { reason } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(result.code !== undefined ? { exitCode: result.code } : {}),
    })
    resolve({ ...result, ...(errorCode ? { errorCode, phase } : {}), diagnostic: {
      agentId: input.terminalId, terminalId: input.terminalId, turnId: input.turnId,
      provider: input.provider, phase, lastState, elapsedMs: Date.now() - startedAt,
      markerState: markerSeen ? 'seen' : 'missing', nonceState: markerSeen ? 'matched' : 'unmatched',
      ...(reason ? { reason } : {}),
      ...(errorCode ? { errorCode } : {}), ...(result.code !== undefined ? { exitCode: result.code } : {}),
    } })
  }
  const timeout = () => finish({ timedOut: true }, !submitted ? 'AGENT_NOT_READY'
    : !acknowledged && candidate ? 'INSTRUCTION_ACK_TIMEOUT' : sawInvalid ? 'RESULT_PARSE_FAILED'
      : sawEcho && !sawOutput ? 'ECHO_ONLY' : sawOutput ? 'RESULT_MARKER_MISSING' : 'RESULT_TIMEOUT')
  let idleTimer = setTimeout(timeout, Math.max(1000, input.idleMs))
  const overallTimer = setTimeout(timeout, Math.max(1000, input.overallMs))
  const pending = new Promise<TurnWaiter>((done) => { resolve = done }) as ResultWaitPromise
  pending.cancel = () => finish({}, 'CANCELLED')
  const completeCandidate = () => {
    if (!candidate || !acknowledged || settled) return
    emit('provider_running') // A nonce-bound validated response proves execution.
    emit('result_parsed')
    if (candidate.outcome === 'completed') finish({ result: candidate.summary, structured: candidate })
    else if (candidate.outcome === 'blocked') finish({ blocked: candidate.summary, structured: candidate })
    else finish({ error: 'O agente reportou falha.', structured: candidate }, 'AGENT_REPORTED_FAILURE')
  }
  unsubscribe = input.subscribe((event) => {
    if (event.id !== input.terminalId || settled) return
    if (event.type === 'exit') { finish({ code: event.code ?? null }, 'TERMINAL_EXITED'); return }
    if (event.type === 'error') { finish({}, 'PROVIDER_STARTUP_FAILED', 'provider_startup_error'); return }
    if (event.type !== 'data' || !event.data) return
    const text = stripAnsiEscapes(event.data)
    const normalized = compact(text)
    // Compare rendered fragments against the normalized input, rather than
    // removing whole prompt strings. ANSI, line wrapping and redraw prefixes
    // do not change this fingerprint. Ambiguous short fragments prove nothing.
    const echo = normalized.length >= 12 && echoedInput.includes(normalized)
    if (echo) sawEcho = true
    if (!submitted) return
    // A marker (or any of its fragments) also occurs in the instruction.
    // Retain the stream before filtering echo evidence so a provider frame
    // split between marker and JSON is not lost. The instruction contains no
    // valid frame: only a complete nonce-bound JSON object can settle a turn.
    buffer = (buffer + event.data).slice(-1_600_000)
    // Fatal provider messages must be standalone output lines, not phrases
    // quoted in the submitted task or redraw of its wrapped input.
    const outputLines = text.split(/[\r\n]/u).filter(line => {
      const fragment = compact(line)
      return fragment.length >= 12 && !echoedInput.includes(fragment)
    }).join('\n')
    if (hasProviderModelFailure(outputLines)) { finish({}, 'PROVIDER_STARTUP_FAILED', 'model_configuration_error'); return }
    if (!echo && normalized.length >= 12 && !sawOutput) {
      sawOutput = true
      emit('provider_output_seen') // Output is evidence; not proof of execution.
    }
    if (!echo) {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(timeout, Math.max(1000, input.idleMs))
    }
    const rendered = stripAnsiEscapes(buffer).replace(/[\r\n]/gu, '')
    // Only this nonce is eligible. JSON can be physically wrapped by a TUI;
    // collect its complete object while discarding visual newlines inside it.
    const start = rendered.lastIndexOf(marker)
    if (start < 0) return
    let body = rendered.slice(start + marker.length).trimStart()
    if (!body.startsWith('{')) {
      // A prose mention in echo is not a candidate and cannot settle a turn.
      if (body.length > 128) buffer = ''
      return
    }
    markerSeen = true
    emit('result_candidate')
    emit('result_marker_seen')
    emit('nonce_matched')
    sawInvalid = true
    body = body.replace(/[\r\n]/gu, '')
    let depth = 0
    let quoted = false
    let escaped = false
    for (let index = 0; index < body.length; index += 1) {
      const char = body[index]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === '{') depth += 1
      else if (char === '}' && --depth === 0) {
        const parsed = parseAgentResultLine(`DEVORBIT_RESULT: ${body.slice(0, index + 1)}`)
        if (parsed.kind === 'result' && parsed.result.format === 'json') {
          sawInvalid = false
          candidate = parsed.result
          completeCandidate()
        } else {
          sawInvalid = true
          emit('result_parse_failed', { errorCode: 'RESULT_PARSE_FAILED' })
        }
        buffer = ''
        break
      }
    }
  })
  emit('task_created')
  return { pending, fail: (code) => finish({}, code), isResultReady: () => candidate !== undefined, instruction: (event) => {
    if (settled) return
    emit(event.phase, { attempt: event.attempt, ...(event.length !== undefined ? { contentLength: event.length } : {}) })
    if (event.phase === 'submit_sent') submitted = true
    if (event.phase === 'acked') { acknowledged = true; completeCandidate() }
  } }
}
