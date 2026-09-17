import { createHash } from 'node:crypto'
import type { TelemetrySpanRecord, TelemetryValue } from './telemetry'

export interface OtlpExporterOptions {
  endpoint?: string
  token?: string
  timeoutMs?: number
  serviceName?: string
  fetchImpl?: typeof fetch
}

export interface OtlpExportResult {
  ok: boolean
  status?: number
  error?: string
}

export interface OtlpExporter {
  readonly enabled: boolean
  readonly endpoint?: string
  exportSpan(span: TelemetrySpanRecord): Promise<OtlpExportResult>
}

export const OTLP_DEFAULT_TIMEOUT_MS = 5_000
export const OTLP_MAX_TIMEOUT_MS = 60_000

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, 'Bearer [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{8,}/gu, '[REDACTED]'],
  [/((?:api[_-]?key|token|secret|password|authorization)["'\s:=]+)[^\s"',}]+/giu, '$1[REDACTED]'],
]

export function redactOtlpText(value: string): string {
  let redacted = value
  for (const [pattern, replacement] of SECRET_PATTERNS) redacted = redacted.replace(pattern, replacement)
  return redacted
}

export function normalizeOtlpEndpoint(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (!url.pathname.endsWith('/v1/traces')) {
    url.pathname = `${url.pathname.replace(/\/$/u, '')}/v1/traces`
  }
  return url.toString()
}

export function readOtlpOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): OtlpExporterOptions {
  const timeoutRaw = Number(env.DEVORBIT_OTLP_TIMEOUT_MS)
  return {
    ...(env.DEVORBIT_OTLP_ENDPOINT ? { endpoint: env.DEVORBIT_OTLP_ENDPOINT } : {}),
    ...(env.DEVORBIT_OTLP_TOKEN ? { token: env.DEVORBIT_OTLP_TOKEN } : {}),
    ...(Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? { timeoutMs: timeoutRaw } : {}),
  }
}

function otlpValue(value: TelemetryValue): Record<string, unknown> {
  if (typeof value === 'string') return { stringValue: value }
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }
  if (value === null) return { stringValue: '' }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(otlpValue) } }
  return {
    kvlistValue: {
      values: Object.entries(value).map(([key, item]) => ({ key, value: otlpValue(item) })),
    },
  }
}

function otlpAttributes(attributes: Record<string, TelemetryValue>): Array<Record<string, unknown>> {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: otlpValue(value) }))
}

function hexId(seed: string, length: number): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, length)
}

export function buildOtlpTracePayload(span: TelemetrySpanRecord, serviceName: string): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: serviceName } }],
        },
        scopeSpans: [
          {
            scope: { name: 'devorbit.telemetry', version: '1' },
            spans: [
              {
                traceId: hexId(`${span.id}:trace`, 32),
                spanId: hexId(`${span.id}:span`, 16),
                name: redactOtlpText(span.name),
                kind: 1,
                startTimeUnixNano: String(span.startTime * 1_000_000),
                endTimeUnixNano: String(span.endTime * 1_000_000),
                attributes: otlpAttributes(span.attributes),
                status: {
                  code: span.status === 'error' ? 2 : 1,
                  ...(span.error ? { message: redactOtlpText(span.error.message) } : {}),
                },
              },
            ],
          },
        ],
      },
    ],
  }
}

export function createOtlpExporter(options: OtlpExporterOptions = {}): OtlpExporter {
  const endpoint = normalizeOtlpEndpoint(options.endpoint)
  const enabled = endpoint !== undefined
  const token = typeof options.token === 'string' ? options.token.trim() : ''
  const serviceName = options.serviceName?.trim() || 'devorbit'
  const timeoutMs = Math.min(
    OTLP_MAX_TIMEOUT_MS,
    Math.max(100, Number.isFinite(options.timeoutMs) ? Math.floor(options.timeoutMs as number) : OTLP_DEFAULT_TIMEOUT_MS),
  )
  const fetchImpl = options.fetchImpl ?? globalThis.fetch

  return {
    enabled,
    ...(endpoint === undefined ? {} : { endpoint }),
    async exportSpan(span: TelemetrySpanRecord): Promise<OtlpExportResult> {
      if (!enabled || endpoint === undefined || typeof fetchImpl !== 'function') {
        return { ok: false, error: 'otlp-disabled' }
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(buildOtlpTracePayload(span, serviceName)),
          signal: controller.signal,
        })
        return response.ok
          ? { ok: true, status: response.status }
          : { ok: false, status: response.status, error: `otlp-http-${response.status}` }
      } catch (error) {
        if (controller.signal.aborted) return { ok: false, error: 'otlp-timeout' }
        const message = redactOtlpText(error instanceof Error ? error.message : String(error))
        return { ok: false, error: message.slice(0, 200) || 'otlp-export-failed' }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
