export const EVOLUTION_HISTORY_VERSION = 1 as const

export const EVOLUTION_RECORD_KINDS = [
  'baseline',
  'remediation',
  'gain',
  'agent-reflection',
] as const

export type EvolutionRecordKind = (typeof EVOLUTION_RECORD_KINDS)[number] | 'reflection'
export type EvolutionRecordType = EvolutionRecordKind

export type EvolutionJsonValue =
  | string
  | number
  | boolean
  | null
  | EvolutionJsonValue[]
  | { [key: string]: EvolutionJsonValue }

export type EvolutionJsonObject = Record<string, EvolutionJsonValue>
export type EvolutionInputObject = Record<string, unknown>

export interface EvolutionRecord {
  readonly version: typeof EVOLUTION_HISTORY_VERSION
  readonly id: string
  readonly kind: EvolutionRecordKind
  readonly type: EvolutionRecordType
  readonly recordedAt: string
  readonly timestamp: string
  readonly data: EvolutionJsonObject
  readonly payload: EvolutionJsonObject
  readonly telemetry?: EvolutionJsonObject
  readonly metadata?: EvolutionJsonObject
}

export interface EvolutionRecordInput {
  readonly [key: string]: unknown
  readonly id?: string
  readonly kind?: EvolutionRecordKind
  readonly type?: EvolutionRecordType
  readonly recordedAt?: string
  readonly timestamp?: string
  readonly data?: EvolutionInputObject
  readonly payload?: EvolutionInputObject
  readonly telemetry?: EvolutionInputObject
  readonly metadata?: EvolutionInputObject
}

export interface EvolutionRecordOptions {
  readonly id?: string
  readonly recordedAt?: string
  readonly timestamp?: string
  readonly telemetry?: EvolutionInputObject
  readonly metadata?: EvolutionInputObject
}

export type EvolutionBaselineInput = EvolutionRecordOptions
export type EvolutionRemediationInput = EvolutionRecordOptions
export type EvolutionGainInput = EvolutionRecordOptions
export type EvolutionAgentReflectionInput = EvolutionRecordOptions

export interface EvolutionReadOptions {
  readonly limit?: number
  readonly kind?: EvolutionRecordKind | readonly EvolutionRecordKind[]
  readonly type?: EvolutionRecordType | readonly EvolutionRecordType[]
}

export const EVOLUTION_REDACTED = '[REDACTED]'

const SENSITIVE_KEY = /(?:api[-_]?key|authorization|bearer|cookie|credential|env(?:ironment)?|password|private[-_]?key|prompt|secret|token)/iu
const MAX_REDACTION_DEPTH = 8

const SECRET_VALUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // PRIMEIRO: blocos completos de chave privada (PEM/OpenSSH) — o corpo base64
  // poderia casar outros padrões por acaso; substituir o bloco inteiro antes
  // evita vazamento parcial. Conservador: bloco SEM o END correspondente não é
  // redigido (truncado = provável colagem incompleta, não segredo inteiro).
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    EVOLUTION_REDACTED,
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, `Bearer ${EVOLUTION_REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, EVOLUTION_REDACTED],
  [/\b(?:sk|key|token)-[A-Za-z0-9_-]{8,}\b/gu, EVOLUTION_REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}\b/gu, EVOLUTION_REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}\b/gu, EVOLUTION_REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{8,}\b/gu, EVOLUTION_REDACTED],
  [/\bnpm_[A-Za-z0-9]{8,}\b/gu, EVOLUTION_REDACTED],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/gu, EVOLUTION_REDACTED],
  // Formas de chave com underscore (Stripe etc.) que o padrão com `-` não pega.
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/gu, EVOLUTION_REDACTED],
  // AWS access key ID e Google API key (formas ancoradas, baixo falso-positivo).
  [/\bAKIA[0-9A-Z]{16}\b/gu, EVOLUTION_REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/gu, EVOLUTION_REDACTED],
  // user:password em URL (host e path preservados; padrões SEM captura para o
  // callback devolver a substituição literal com o '@' incluído).
  [/\bhttps:\/\/[^\s:@/]+:[^\s@/]+@/gu, `https://${EVOLUTION_REDACTED}@`],
  [/\bhttp:\/\/[^\s:@/]+:[^\s@/]+@/gu, `http://${EVOLUTION_REDACTED}@`],
  [/((?:api[_-]?key|token|secret|password|authorization)["'\s:=]+)[^\s"',}]+/giu, `$1${EVOLUTION_REDACTED}`],
]

const PLACEHOLDER_LIKE = /^(?:\*+|x{4,}|<[^>]+>|example|changeme|your[-_]?token|placeholder|dummy|redacted)/iu

function isPlaceholderSecret(candidate: string): boolean {
  return PLACEHOLDER_LIKE.test(candidate.trim())
}

export function redactSecretText(text: string): string {
  let output = text
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, (match, prefix?: string) => {
      const secret = typeof prefix === 'string' && prefix.length > 0 ? match.slice(prefix.length) : match
      if (isPlaceholderSecret(secret) || isPlaceholderSecret(match)) return match
      return typeof prefix === 'string' && prefix.length > 0 ? `${prefix}${EVOLUTION_REDACTED}` : replacement
    })
  }
  return output
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function safeKey(key: string): string {
  return key.trim().slice(0, 200)
}

function redactValue(
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>,
  depth: number,
): EvolutionJsonValue {
  if (key && SENSITIVE_KEY.test(key)) return EVOLUTION_REDACTED
  if (value === null) return null
  if (typeof value === 'string') return redactSecretText(value)
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined') return EVOLUTION_REDACTED
  if (typeof value === 'function' || typeof value === 'symbol') return '[UNSUPPORTED]'
  if (depth >= MAX_REDACTION_DEPTH) return '[TRUNCATED]'
  if (value instanceof Date) return value.toISOString()
  if (seen.has(value)) return '[CIRCULAR]'

  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, undefined, seen, depth + 1))
  }

  const output: EvolutionJsonObject = {}
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[safeKey(entryKey)] = redactValue(entryValue, entryKey, seen, depth + 1)
  }
  return output
}

export function redactEvolutionValue(value: unknown, key?: string): EvolutionJsonValue {
  return redactValue(value, key, new WeakSet<object>(), 0)
}

export function redactEvolutionObject(value: EvolutionInputObject): EvolutionJsonObject {
  return redactEvolutionValue(value) as EvolutionJsonObject
}

export function isEvolutionRecordKind(value: unknown): value is EvolutionRecordKind {
  return value === 'baseline'
    || value === 'remediation'
    || value === 'gain'
    || value === 'agent-reflection'
    || value === 'reflection'
}

interface EvolutionRecordDraft {
  readonly version: typeof EVOLUTION_HISTORY_VERSION
  readonly id: string
  readonly kind: EvolutionRecordKind
  readonly recordedAt: string
  readonly data: EvolutionJsonObject
  readonly telemetry?: EvolutionJsonObject
  readonly metadata?: EvolutionJsonObject
}

function addAliases(record: Omit<EvolutionRecord, 'type' | 'timestamp' | 'payload'>): EvolutionRecord {
  const withAliases = record as Omit<EvolutionRecord, 'type' | 'timestamp' | 'payload'> & Partial<EvolutionRecord>
  Object.defineProperties(withAliases, {
    type: {
      configurable: false,
      enumerable: false,
      get: () => record.kind,
    },
    timestamp: {
      configurable: false,
      enumerable: false,
      get: () => record.recordedAt,
    },
    payload: {
      configurable: false,
      enumerable: false,
      get: () => record.data,
    },
  })
  return withAliases as EvolutionRecord
}

export function createEvolutionRecord(draft: EvolutionRecordDraft): EvolutionRecord {
  return addAliases({
    version: EVOLUTION_HISTORY_VERSION,
    id: draft.id,
    kind: draft.kind,
    recordedAt: draft.recordedAt,
    data: draft.data,
    ...(draft.telemetry === undefined ? {} : { telemetry: draft.telemetry }),
    ...(draft.metadata === undefined ? {} : { metadata: draft.metadata }),
  })
}

export function copyEvolutionRecord(record: EvolutionRecord): EvolutionRecord {
  return createEvolutionRecord({
    version: EVOLUTION_HISTORY_VERSION,
    id: record.id,
    kind: record.kind,
    recordedAt: record.recordedAt,
    data: redactEvolutionObject(record.data),
    ...(record.telemetry === undefined ? {} : { telemetry: redactEvolutionObject(record.telemetry) }),
    ...(record.metadata === undefined ? {} : { metadata: redactEvolutionObject(record.metadata) }),
  })
}
