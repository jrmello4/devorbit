import { stripAnsiEscapes } from './ansi'

export const AGENT_RESULT_PREFIX = 'DEVORBIT_RESULT:'
export const AGENT_RESULT_VERSION = 1
export const AGENT_RESULT_MAX_FRAME_CHARS = 4_096
export const AGENT_RESULT_MAX_SUMMARY_CHARS = 1_000

export type AgentResultOutcome = 'completed' | 'blocked' | 'failed'

export interface AgentResult {
  format: 'json' | 'legacy'
  version: 1 | 0
  outcome: AgentResultOutcome
  summary: string
}

export type AgentResultInvalidReason =
  | 'empty'
  | 'frame-too-large'
  | 'invalid-json'
  | 'invalid-schema'
  | 'invalid-summary'
  | 'invalid-version'

export type AgentResultParse =
  | { kind: 'result'; result: AgentResult }
  | { kind: 'invalid'; reason: AgentResultInvalidReason }
  | { kind: 'none' }

export type AgentResultScanEvent = AgentResultParse

const outcomes = new Set<AgentResultOutcome>(['completed', 'blocked', 'failed'])
const legacyPrefixes: Array<{ prefix: string; outcome: AgentResultOutcome }> = [
  { prefix: 'CONCLUIDO:', outcome: 'completed' },
  { prefix: 'COMPLETED:', outcome: 'completed' },
  { prefix: 'BLOQUEADO:', outcome: 'blocked' },
  { prefix: 'BLOCKED:', outcome: 'blocked' },
  { prefix: 'FALHA:', outcome: 'failed' },
  { prefix: 'FAILURE:', outcome: 'failed' },
  { prefix: 'ERRO:', outcome: 'failed' },
  { prefix: 'ERROR:', outcome: 'failed' },
]

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function parseSummary(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  if (value.length > AGENT_RESULT_MAX_SUMMARY_CHARS || hasControlCharacters(value)) return undefined
  return value.trim()
}

function parseJsonBody(body: string): AgentResultParse {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return { kind: 'invalid', reason: 'invalid-json' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'invalid', reason: 'invalid-schema' }
  }
  const record = value as Record<string, unknown>
  if (record.version !== AGENT_RESULT_VERSION) {
    return { kind: 'invalid', reason: 'invalid-version' }
  }
  if (Object.keys(record).some((key) => !['version', 'outcome', 'summary'].includes(key))) {
    return { kind: 'invalid', reason: 'invalid-schema' }
  }
  if (typeof record.outcome !== 'string' || !outcomes.has(record.outcome as AgentResultOutcome)) {
    return { kind: 'invalid', reason: 'invalid-schema' }
  }
  const summary = parseSummary(record.summary)
  if (!summary) return { kind: 'invalid', reason: 'invalid-summary' }
  return {
    kind: 'result',
    result: { format: 'json', version: AGENT_RESULT_VERSION, outcome: record.outcome as AgentResultOutcome, summary },
  }
}

function parseLegacyBody(body: string): AgentResultParse {
  const normalized = body.trim()
  if (!normalized) return { kind: 'invalid', reason: 'empty' }
  const upper = normalized.toLocaleUpperCase()
  const prefix = legacyPrefixes.find((item) => upper.startsWith(item.prefix))
  const summary = normalized.slice(0, AGENT_RESULT_MAX_SUMMARY_CHARS)
  if (!summary) return { kind: 'invalid', reason: 'invalid-summary' }
  return {
    kind: 'result',
    result: { format: 'legacy', version: 0, outcome: prefix?.outcome ?? 'completed', summary },
  }
}

/**
 * Parses one complete physical DEVORBIT_RESULT line. A saída de PTY chega
 * colorida: a limpeza ECMA-48 (src/shared/ansi.ts) roda antes do parse e antes
 * do limite de frame — decoração não pode invalidar um frame legítimo. Linhas
 * longas sem marcador continuam sendo ruído (`none`), nunca resultado inválido.
 */
export function parseAgentResultLine(line: string): AgentResultParse {
  const candidate = stripAnsiEscapes(line).trimStart()
  if (!candidate.startsWith(AGENT_RESULT_PREFIX)) return { kind: 'none' }
  if (candidate.length > AGENT_RESULT_MAX_FRAME_CHARS) return { kind: 'invalid', reason: 'frame-too-large' }
  const body = candidate.slice(AGENT_RESULT_PREFIX.length).trim()
  if (!body) return { kind: 'invalid', reason: 'empty' }
  if (body.startsWith('{') || body.startsWith('[')) return parseJsonBody(body)
  return parseLegacyBody(body)
}

export function createLegacyAgentResult(outcome: AgentResultOutcome, summary: string): AgentResult {
  const normalized = summary.trim().slice(0, AGENT_RESULT_MAX_SUMMARY_CHARS) || 'Resultado sem resumo.'
  return { format: 'legacy', version: 0, outcome, summary: normalized }
}

export interface AgentResultScanner {
  push: (chunk: string) => AgentResultScanEvent[]
  finish: () => AgentResultScanEvent[]
  reset: () => void
}

/** Incremental parser shared by PTY consumers. JSON must precede its mirror. */
export function createAgentResultScanner(): AgentResultScanner {
  let buffer = ''
  let resolved = false
  let invalidReason: AgentResultInvalidReason | undefined
  let invalidEmitted = false

  const reset = () => {
    buffer = ''
    resolved = false
    invalidReason = undefined
    invalidEmitted = false
  }

  const consumeLine = (line: string): AgentResultScanEvent[] => {
    if (resolved) return []
    const parsed = parseAgentResultLine(line)
    if (parsed.kind === 'none') return []
    if (parsed.kind === 'invalid') {
      invalidReason = invalidReason || parsed.reason
      if (invalidEmitted) return []
      invalidEmitted = true
      return [parsed]
    }
    resolved = true
    return [parsed]
  }

  const push = (chunk: string): AgentResultScanEvent[] => {
    if (resolved || !chunk) return []
    buffer += chunk
    if (buffer.length > AGENT_RESULT_MAX_FRAME_CHARS * 2) buffer = buffer.slice(-AGENT_RESULT_MAX_FRAME_CHARS * 2)
    const lines = buffer.split(/\r\n|\n|\r/)
    buffer = lines.pop() || ''
    return lines.flatMap(consumeLine)
  }

  const finish = (): AgentResultScanEvent[] => {
    if (resolved) return []
    const events = buffer ? consumeLine(buffer) : []
    buffer = ''
    if (events.length) return events
    if (invalidReason && !invalidEmitted) {
      invalidEmitted = true
      return [{ kind: 'invalid', reason: invalidReason }]
    }
    return []
  }

  return { push, finish, reset }
}
