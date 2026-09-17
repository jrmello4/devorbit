export const AGENT_BRIDGE_EVENT_STATUSES = ['pending', 'completed', 'blocked', 'failed'] as const

export type AgentBridgeEventStatus = (typeof AGENT_BRIDGE_EVENT_STATUSES)[number]

export const AGENT_BRIDGE_ID_MAX_CHARS = 80
export const AGENT_BRIDGE_SUMMARY_MAX_CHARS = 500
export const AGENT_BRIDGE_TIMESTAMP_MAX = 8_640_000_000_000_000

export interface AgentBridgeEvent {
  requestId: string
  source: string
  target: string
  status: AgentBridgeEventStatus
  createdAt?: number
  updatedAt?: number
  summary?: string
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
  | 'invalid-timestamp'
  | 'invalid-summary'

export type AgentBridgeEventParse =
  | { kind: 'event'; event: AgentBridgeEvent }
  | { kind: 'invalid'; reason: AgentBridgeEventInvalidReason }

export interface AgentBridgeEventTransition {
  status: AgentBridgeEventStatus
  summary?: string
  updatedAt?: number
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const STATUS_SET: ReadonlySet<string> = new Set(AGENT_BRIDGE_EVENT_STATUSES)
const EVENT_KEYS: ReadonlySet<string> = new Set([
  'requestId',
  'source',
  'target',
  'status',
  'createdAt',
  'updatedAt',
  'summary',
])

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
      ...(createdAt.value !== undefined ? { createdAt: createdAt.value } : {}),
      ...(updatedAt.value !== undefined ? { updatedAt: updatedAt.value } : {}),
      ...(summary.value !== undefined ? { summary: summary.value } : {}),
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
  })
}
