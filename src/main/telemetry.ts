import { randomUUID } from 'node:crypto'

export type TelemetryValue = string | number | boolean | null | TelemetryValue[] | { [key: string]: TelemetryValue }
export type TelemetryAttributes = Record<string, unknown>
export type TelemetrySpanStatus = 'unset' | 'ok' | 'error'

export interface TelemetryError {
  name: string
  message: string
}

export interface TelemetrySpanRecord {
  id: string
  name: string
  startTime: number
  endTime: number
  durationMs: number
  status: TelemetrySpanStatus
  attributes: Record<string, TelemetryValue>
  error?: TelemetryError
}

export interface TelemetrySpanEndOptions {
  status?: TelemetrySpanStatus
  error?: unknown
  attributes?: TelemetryAttributes
}

export interface TelemetrySpan {
  readonly id: string
  readonly name: string
  readonly startTime: number
  setAttribute: (key: string, value: unknown) => void
  setAttributes: (attributes: TelemetryAttributes) => void
  setStatus: (status: TelemetrySpanStatus, error?: unknown) => void
  end: (options?: TelemetrySpanEndOptions) => TelemetrySpanRecord
}

export interface TelemetryOptions {
  maxSpans?: number
  clock?: () => number
  idFactory?: () => string
  onSpanEnd?: (span: TelemetrySpanRecord) => void
}

const REDACTED = '[REDACTED]'
const SENSITIVE_KEY = /(?:prompt|token|env|secret|password|authorization|api[-_]?key|credential|cookie)/iu

function safeKey(key: string): string {
  return key.trim().slice(0, 200)
}

function redactValue(value: unknown, key: string | undefined, seen: WeakSet<object>, depth: number): TelemetryValue {
  if (key && SENSITIVE_KEY.test(key)) return REDACTED
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined') return REDACTED
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  if (depth > 8) return '[TRUNCATED]'
  if (value instanceof Date) return value.toISOString()
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, undefined, seen, depth + 1))
  const output: Record<string, TelemetryValue> = {}
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[safeKey(entryKey)] = redactValue(entryValue, entryKey, seen, depth + 1)
  }
  return output
}

export function redactTelemetryValue(value: unknown, key?: string): TelemetryValue {
  return redactValue(value, key, new WeakSet<object>(), 0)
}

export function redactTelemetryAttributes(attributes: TelemetryAttributes): Record<string, TelemetryValue> {
  const output: Record<string, TelemetryValue> = {}
  for (const [key, value] of Object.entries(attributes)) output[safeKey(key)] = redactTelemetryValue(value, key)
  return output
}

function errorFrom(value: unknown): TelemetryError {
  if (value instanceof Error) return { name: value.name || 'Error', message: value.message.slice(0, 1_000) }
  return { name: 'Error', message: String(value).slice(0, 1_000) }
}

export class Telemetry {
  private readonly maxSpans: number
  private readonly clock: () => number
  private readonly idFactory: () => string
  private readonly onSpanEnd?: (span: TelemetrySpanRecord) => void
  private readonly records: TelemetrySpanRecord[] = []

  constructor(options: TelemetryOptions = {}) {
    const maxSpans = options.maxSpans ?? 1_000
    if (!Number.isInteger(maxSpans) || maxSpans < 1) throw new RangeError('Telemetry maxSpans must be positive.')
    this.maxSpans = maxSpans
    this.clock = options.clock ?? Date.now
    this.idFactory = options.idFactory ?? randomUUID
    this.onSpanEnd = options.onSpanEnd
  }

  startSpan(name: string, attributes: TelemetryAttributes = {}): TelemetrySpan {
    if (typeof name !== 'string' || name.trim().length === 0) throw new TypeError('Telemetry span name is required.')
    const id = this.idFactory()
    const startTime = this.clock()
    const values = redactTelemetryAttributes(attributes)
    let ended = false
    let endedRecord: TelemetrySpanRecord | undefined
    let status: TelemetrySpanStatus = 'unset'
    let spanError: TelemetryError | undefined
    const end = (options: TelemetrySpanEndOptions = {}): TelemetrySpanRecord => {
      if (ended) return endedRecord as TelemetrySpanRecord
      ended = true
      if (options.attributes) Object.assign(values, redactTelemetryAttributes(options.attributes))
      if (options.status) status = options.status
      if (options.error !== undefined) {
        status = 'error'
        spanError = errorFrom(options.error)
      }
      if (status === 'unset') status = 'ok'
      const endTime = Math.max(startTime, this.clock())
      const record = this.buildRecord(id, name, startTime, endTime, status, values, spanError)
      endedRecord = record
      this.records.push(record)
      while (this.records.length > this.maxSpans) this.records.shift()
      try {
        this.onSpanEnd?.(record)
      } catch {
        return record
      }
      return record
    }
    const span: TelemetrySpan = {
      id,
      name,
      startTime,
      setAttribute: (key, value) => {
        values[safeKey(key)] = redactTelemetryValue(value, key)
      },
      setAttributes: (next) => {
        Object.assign(values, redactTelemetryAttributes(next))
      },
      setStatus: (next, error) => {
        status = next
        if (error !== undefined) spanError = errorFrom(error)
      },
      end,
    }
    return span
  }

  async withSpan<T>(
    name: string,
    task: (span: TelemetrySpan) => T | Promise<T>,
    attributes?: TelemetryAttributes,
  ): Promise<T>
  async withSpan<T>(
    name: string,
    attributes: TelemetryAttributes,
    task: (span: TelemetrySpan) => T | Promise<T>,
  ): Promise<T>
  async withSpan<T>(
    name: string,
    taskOrAttributes: ((span: TelemetrySpan) => T | Promise<T>) | TelemetryAttributes,
    attributesOrTask: TelemetryAttributes | ((span: TelemetrySpan) => T | Promise<T>) = {},
  ): Promise<T> {
    let task: ((span: TelemetrySpan) => T | Promise<T>)
    let attributes: TelemetryAttributes
    if (typeof taskOrAttributes === 'function') {
      task = taskOrAttributes
      attributes = typeof attributesOrTask === 'function' ? {} : attributesOrTask
    } else {
      attributes = taskOrAttributes
      if (typeof attributesOrTask !== 'function') throw new TypeError('Telemetry span task is required.')
      task = attributesOrTask
    }
    const span = this.startSpan(name, attributes)
    try {
      const result = await task(span)
      span.end({ status: 'ok' })
      return result
    } catch (error) {
      span.end({ status: 'error', error })
      throw error
    }
  }

  getSpans(): TelemetrySpanRecord[] {
    return this.records.map((record) => ({
      ...record,
      attributes: { ...record.attributes },
      ...(record.error ? { error: { ...record.error } } : {}),
    }))
  }

  clear(): void {
    this.records.length = 0
  }

  private buildRecord(
    id: string,
    name: string,
    startTime: number,
    endTime: number,
    status: TelemetrySpanStatus,
    attributes: Record<string, TelemetryValue>,
    error?: TelemetryError,
  ): TelemetrySpanRecord {
    return {
      id,
      name,
      startTime,
      endTime,
      durationMs: Math.max(0, endTime - startTime),
      status,
      attributes: { ...attributes },
      ...(error ? { error: { ...error } } : {}),
    }
  }
}

export { Telemetry as TelemetryCollector }

export function createTelemetry(options: TelemetryOptions = {}): Telemetry {
  return new Telemetry(options)
}
