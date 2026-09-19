export const AGENT_BRIDGE_EVENT_STATUSES = ['pending', 'completed', 'blocked', 'failed'] as const

export type AgentBridgeEventStatus = (typeof AGENT_BRIDGE_EVENT_STATUSES)[number]

export const AGENT_BRIDGE_TERMINAL_STATUSES = ['completed', 'blocked', 'failed'] as const

export type AgentBridgeTerminalStatus = (typeof AGENT_BRIDGE_TERMINAL_STATUSES)[number]

export const AGENT_BRIDGE_ID_MAX_CHARS = 80
export const AGENT_BRIDGE_SUMMARY_MAX_CHARS = 500
export const AGENT_BRIDGE_TIMESTAMP_MAX = 8_640_000_000_000_000
export const AGENT_BRIDGE_DEPTH_MAX = 64
export const AGENT_BRIDGE_RESULT_MAX_ARTIFACTS = 16
export const AGENT_BRIDGE_ARTIFACT_MAX_CHARS = 240

/** Resultado estruturado de uma delegação, anexado ao evento terminal. */
export interface AgentBridgeEventResult {
  outcome: AgentBridgeTerminalStatus
  summary?: string
  artifacts?: string[]
}

export interface AgentBridgeEvent {
  requestId: string
  /** Quem originou a delegação (terminal/agente) — `devorbit` quando o app. */
  source: string
  /** Destino resolvido que executou o turno. */
  target: string
  status: AgentBridgeEventStatus
  /** Alias explícito de `source` no vocabulário de delegação (origem). */
  origin?: string
  /** Alias explícito de `target` no vocabulário de delegação (destino). */
  destination?: string
  /** Profundidade da cadeia de delegação (0 = chamada direta). */
  depth?: number
  createdAt?: number
  updatedAt?: number
  summary?: string
  result?: AgentBridgeEventResult
}

export type AgentBridgeEventInvalidReason =
  | 'invalid-json'
  | 'not-object'
  | 'unknown-field'
  | 'invalid-request-id'
  | 'invalid-source'
  | 'invalid-target'
  | 'self-target'
  | 'invalid-status'
  | 'invalid-origin'
  | 'invalid-destination'
  | 'invalid-depth'
  | 'invalid-timestamp'
  | 'invalid-summary'
  | 'invalid-result'

export type AgentBridgeEventParse =
  | { kind: 'event'; event: AgentBridgeEvent }
  | { kind: 'invalid'; reason: AgentBridgeEventInvalidReason }

export interface AgentBridgeEventTransition {
  status: AgentBridgeEventStatus
  summary?: string
  updatedAt?: number
  /** Destino resolvido (id do terminal) quando difere do alvo pedido. */
  destination?: string
  /** Resultado estruturado anexado à transição terminal. */
  result?: AgentBridgeEventResult
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const STATUS_SET: ReadonlySet<string> = new Set(AGENT_BRIDGE_EVENT_STATUSES)
const TERMINAL_STATUS_SET: ReadonlySet<string> = new Set(AGENT_BRIDGE_TERMINAL_STATUSES)
const EVENT_KEYS: ReadonlySet<string> = new Set([
  'requestId',
  'source',
  'target',
  'status',
  'origin',
  'destination',
  'depth',
  'createdAt',
  'updatedAt',
  'summary',
  'result',
])
const RESULT_KEYS: ReadonlySet<string> = new Set(['outcome', 'summary', 'artifacts'])

const TRANSITIONS: Record<AgentBridgeEventStatus, readonly AgentBridgeEventStatus[]> = {
  pending: ['completed', 'blocked', 'failed'],
  completed: [],
  blocked: [],
  failed: [],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function parseId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (!value || value.length > AGENT_BRIDGE_ID_MAX_CHARS) return undefined
  return ID_PATTERN.test(value) ? value : undefined
}

function parseTimestamp(value: unknown): { ok: true; value?: number } | { ok: false } {
  if (value === undefined) return { ok: true }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > AGENT_BRIDGE_TIMESTAMP_MAX
  ) {
    return { ok: false }
  }
  return { ok: true, value }
}

function parseSummary(value: unknown): { ok: true; value?: string } | { ok: false } {
  if (value === undefined) return { ok: true }
  if (typeof value !== 'string') return { ok: false }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > AGENT_BRIDGE_SUMMARY_MAX_CHARS || hasControlCharacters(trimmed)) {
    return { ok: false }
  }
  return { ok: true, value: trimmed }
}

function parseDepth(value: unknown): { ok: true; value?: number } | { ok: false } {
  if (value === undefined) return { ok: true }
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > AGENT_BRIDGE_DEPTH_MAX) {
    return { ok: false }
  }
  return { ok: true, value: value as number }
}

function parseArtifacts(value: unknown): { ok: true; value?: string[] } | { ok: false } {
  if (value === undefined) return { ok: true }
  if (!Array.isArray(value) || value.length > AGENT_BRIDGE_RESULT_MAX_ARTIFACTS) return { ok: false }
  const artifacts: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') return { ok: false }
    const trimmed = entry.trim()
    if (!trimmed || trimmed.length > AGENT_BRIDGE_ARTIFACT_MAX_CHARS || hasControlCharacters(trimmed)) {
      return { ok: false }
    }
    artifacts.push(trimmed)
  }
  return { ok: true, value: artifacts.length > 0 ? artifacts : undefined }
}

function parseResult(value: unknown): { ok: true; value?: AgentBridgeEventResult } | { ok: false } {
  if (value === undefined) return { ok: true }
  if (!isRecord(value)) return { ok: false }
  if (Object.keys(value).some((key) => !RESULT_KEYS.has(key))) return { ok: false }
  if (typeof value.outcome !== 'string' || !TERMINAL_STATUS_SET.has(value.outcome)) return { ok: false }
  const summary = parseSummary(value.summary)
  if (!summary.ok) return { ok: false }
  const artifacts = parseArtifacts(value.artifacts)
  if (!artifacts.ok) return { ok: false }
  return {
    ok: true,
    value: {
      outcome: value.outcome as AgentBridgeTerminalStatus,
      ...(summary.value !== undefined ? { summary: summary.value } : {}),
      ...(artifacts.value !== undefined ? { artifacts: artifacts.value } : {}),
    },
  }
}

export function parseAgentBridgeEvent(value: unknown): AgentBridgeEventParse {
  if (!isRecord(value)) return { kind: 'invalid', reason: 'not-object' }
  if (Object.keys(value).some((key) => !EVENT_KEYS.has(key))) {
    return { kind: 'invalid', reason: 'unknown-field' }
  }

  const requestId = parseId(value.requestId)
  if (!requestId) return { kind: 'invalid', reason: 'invalid-request-id' }

  const source = parseId(value.source)
  if (!source) return { kind: 'invalid', reason: 'invalid-source' }

  const target = parseId(value.target)
  if (!target) return { kind: 'invalid', reason: 'invalid-target' }
  if (source === target) return { kind: 'invalid', reason: 'self-target' }

  let origin: string | undefined
  if (value.origin !== undefined) {
    const parsedOrigin = parseId(value.origin)
    if (!parsedOrigin) return { kind: 'invalid', reason: 'invalid-origin' }
    origin = parsedOrigin
  }
  let destination: string | undefined
  if (value.destination !== undefined) {
    const parsedDestination = parseId(value.destination)
    if (!parsedDestination) return { kind: 'invalid', reason: 'invalid-destination' }
    destination = parsedDestination
  }
  const depth = parseDepth(value.depth)
  if (!depth.ok) return { kind: 'invalid', reason: 'invalid-depth' }
  const result = parseResult(value.result)
  if (!result.ok) return { kind: 'invalid', reason: 'invalid-result' }

  if (typeof value.status !== 'string' || !STATUS_SET.has(value.status)) {
    return { kind: 'invalid', reason: 'invalid-status' }
  }

  const createdAt = parseTimestamp(value.createdAt)
  if (!createdAt.ok) return { kind: 'invalid', reason: 'invalid-timestamp' }
  const updatedAt = parseTimestamp(value.updatedAt)
  if (!updatedAt.ok) return { kind: 'invalid', reason: 'invalid-timestamp' }
  if (
    createdAt.value !== undefined &&
    updatedAt.value !== undefined &&
    updatedAt.value < createdAt.value
  ) {
    return { kind: 'invalid', reason: 'invalid-timestamp' }
  }

  const summary = parseSummary(value.summary)
  if (!summary.ok) return { kind: 'invalid', reason: 'invalid-summary' }

  return {
    kind: 'event',
    event: {
      requestId,
      source,
      target,
      status: value.status as AgentBridgeEventStatus,
      ...(origin !== undefined ? { origin } : {}),
      ...(destination !== undefined ? { destination } : {}),
      ...(depth.value !== undefined ? { depth: depth.value } : {}),
      ...(createdAt.value !== undefined ? { createdAt: createdAt.value } : {}),
      ...(updatedAt.value !== undefined ? { updatedAt: updatedAt.value } : {}),
      ...(summary.value !== undefined ? { summary: summary.value } : {}),
      ...(result.value !== undefined ? { result: result.value } : {}),
    },
  }
}

export function assertAgentBridgeEvent(value: unknown): AgentBridgeEvent {
  const parsed = parseAgentBridgeEvent(value)
  if (parsed.kind === 'invalid') {
    throw Object.assign(new Error(`Evento de delegação inválido (${parsed.reason}).`), {
      code: parsed.reason,
    })
  }
  return parsed.event
}

export function serializeAgentBridgeEvent(value: unknown): string {
  return JSON.stringify(assertAgentBridgeEvent(value))
}

export function parseAgentBridgeEventJson(text: unknown): AgentBridgeEventParse {
  if (typeof text !== 'string') return { kind: 'invalid', reason: 'invalid-json' }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { kind: 'invalid', reason: 'invalid-json' }
  }
  return parseAgentBridgeEvent(value)
}

export function canTransitionAgentBridgeEvent(
  from: AgentBridgeEventStatus,
  to: AgentBridgeEventStatus,
): boolean {
  return TRANSITIONS[from]?.includes(to) === true
}

export function transitionAgentBridgeEvent(
  value: unknown,
  next: AgentBridgeEventTransition,
): AgentBridgeEvent {
  const current = assertAgentBridgeEvent(value)
  if (!canTransitionAgentBridgeEvent(current.status, next.status)) {
    throw Object.assign(
      new Error(`Transição de delegação inválida: ${current.status} → ${String(next.status)}.`),
      { code: 'invalid-transition' },
    )
  }
  return assertAgentBridgeEvent({
    ...current,
    status: next.status,
    ...(next.summary !== undefined ? { summary: next.summary } : {}),
    ...(next.updatedAt !== undefined ? { updatedAt: next.updatedAt } : {}),
    ...(next.destination !== undefined ? { destination: next.destination } : {}),
    ...(next.result !== undefined ? { result: next.result } : {}),
  })
}
