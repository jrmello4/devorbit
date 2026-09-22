import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, open, rm } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'

export type AuditJsonValue = string | number | boolean | null | AuditJsonValue[] | { [key: string]: AuditJsonValue }

export interface AuditAppendInput {
  type: string
  [key: string]: unknown
}

export interface AuditEntry extends Record<string, AuditJsonValue> {
  id: string
  timestamp: string
  type: string
}

export interface AuditReadOptions {
  limit?: number
}

export interface AuditLedgerOptions {
  filePath?: string
  path?: string
  maxReadEntries?: number
  clock?: () => number
  idFactory?: () => string
}

const REDACTED = '[REDACTED]'
const SENSITIVE_KEY = /(?:prompt|token|env|secret|password|authorization|api[-_]?key|credential|cookie)/iu

const SECRET_VALUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, `Bearer ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, REDACTED],
  [/\b(?:sk|key|token)-[A-Za-z0-9_-]{8,}\b/gu, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}\b/gu, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}\b/gu, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{8,}\b/gu, REDACTED],
  [/\bnpm_[A-Za-z0-9]{8,}\b/gu, REDACTED],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/gu, REDACTED],
  [/((?:api[_-]?key|token|secret|password|authorization)["'\s:=]+)[^\s"',}]+/giu, `$1${REDACTED}`],
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
      return typeof prefix === 'string' && prefix.length > 0 ? `${prefix}${REDACTED}` : replacement
    })
  }
  return output
}

function jsonValue(value: unknown, key: string | undefined, seen: WeakSet<object>, depth: number): AuditJsonValue {
  if (key && SENSITIVE_KEY.test(key)) return REDACTED
  if (value === null) return null
  if (typeof value === 'string') return redactSecretText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined') return REDACTED
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  if (depth > 8) return '[TRUNCATED]'
  if (value instanceof Date) return value.toISOString()
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, undefined, seen, depth + 1))
  const output: Record<string, AuditJsonValue> = {}
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[entryKey] = jsonValue(entryValue, entryKey, seen, depth + 1)
  }
  return output
}

export function redactAuditValue(value: unknown, key?: string): AuditJsonValue {
  return jsonValue(value, key, new WeakSet<object>(), 0)
}

export function redactAuditRecord(record: Record<string, unknown>): Record<string, AuditJsonValue> {
  const output: Record<string, AuditJsonValue> = {}
  for (const [key, value] of Object.entries(record)) output[key] = redactAuditValue(value, key)
  return output
}

function assertLimit(value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError('Audit read limit must be a non-negative integer.')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEntry(line: string): AuditEntry | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    if (!isRecord(parsed) || typeof parsed.id !== 'string' || typeof parsed.timestamp !== 'string' || typeof parsed.type !== 'string') {
      return undefined
    }
    return redactAuditRecord(parsed) as AuditEntry
  } catch {
    return undefined
  }
}

export class AuditLedger {
  readonly filePath: string
  private readonly maxReadEntries: number
  private readonly clock: () => number
  private readonly idFactory: () => string
  private pending: Promise<void> = Promise.resolve()

  constructor(filePathOrOptions: string | AuditLedgerOptions, options: AuditLedgerOptions = {}) {
    const configured = typeof filePathOrOptions === 'string'
      ? { ...options, filePath: filePathOrOptions }
      : filePathOrOptions
    const filePath = configured.filePath ?? configured.path
    if (!filePath || filePath.trim().length === 0) throw new TypeError('Audit ledger file path is required.')
    const maxReadEntries = configured.maxReadEntries ?? 100
    assertLimit(maxReadEntries)
    if (maxReadEntries === 0) throw new RangeError('Audit ledger maxReadEntries must be positive.')
    this.filePath = path.resolve(filePath)
    this.maxReadEntries = maxReadEntries
    this.clock = configured.clock ?? Date.now
    this.idFactory = configured.idFactory ?? randomUUID
  }

  append(input: AuditAppendInput): Promise<AuditEntry> {
    if (!isRecord(input) || typeof input.type !== 'string' || input.type.trim().length === 0) {
      return Promise.reject(new TypeError('Audit entry type is required.'))
    }
    return this.enqueue(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true })
      const entry = {
        ...redactAuditRecord(input),
        id: this.idFactory(),
        timestamp: new Date(this.clock()).toISOString(),
      } as AuditEntry
      await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8')
      return entry
    })
  }

  record(input: AuditAppendInput): Promise<AuditEntry> {
    return this.append(input)
  }

  appendEvent(type: string, data?: unknown): Promise<AuditEntry> {
    return this.append({
      type,
      ...(data !== undefined ? { data } : {}),
    })
  }

  async read(options: AuditReadOptions | number = {}): Promise<AuditEntry[]> {
    await this.pending
    const requestedLimit = typeof options === 'number' ? options : options.limit
    const limit = requestedLimit ?? this.maxReadEntries
    assertLimit(limit)
    const boundedLimit = Math.min(limit, this.maxReadEntries)
    if (boundedLimit === 0) return []
    const retained: AuditEntry[] = []
    const stream = createReadStream(this.filePath, { encoding: 'utf8' })
    const reader = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of reader) {
        if (typeof line !== 'string' || line.trim().length === 0) continue
        const entry = parseEntry(line)
        if (!entry) continue
        retained.push(entry)
        if (retained.length > boundedLimit) retained.shift()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    } finally {
      reader.close()
      stream.destroy()
    }
    return retained
  }

  latest(limit = this.maxReadEntries): Promise<AuditEntry[]> {
    return this.read({ limit })
  }

  flush(): Promise<void> {
    return this.pending
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.pending.then(operation)
    this.pending = current.then(() => undefined, () => undefined)
    return current
  }
}

export { AuditLedger as AppendOnlyAuditLedger }

export function createAuditLedger(options: string | AuditLedgerOptions): AuditLedger {
  return new AuditLedger(options)
}

export const createAppendOnlyAuditLedger = createAuditLedger
