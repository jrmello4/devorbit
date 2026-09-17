import { describe, expect, it, vi } from 'vitest'
import {
  buildOtlpTracePayload,
  createOtlpExporter,
  normalizeOtlpEndpoint,
  readOtlpOptionsFromEnv,
  redactOtlpText,
} from '../src/main/telemetry-otlp'
import type { TelemetrySpanRecord } from '../src/main/telemetry'

const span = (overrides: Partial<TelemetrySpanRecord> = {}): TelemetrySpanRecord => ({
  id: 'span-1',
  name: 'ipc.devorbit:getConfig',
  startTime: 1_000,
  endTime: 1_050,
  durationMs: 50,
  status: 'ok',
  attributes: { channel: 'devorbit:getConfig', counts: [1, 2], nested: { ok: true } },
  ...overrides,
})

describe('OTLP exporter configuration', () => {
  it('normalizes endpoints and rejects invalid or missing configuration', () => {
    expect(normalizeOtlpEndpoint('https://collector.example/otlp')).toBe('https://collector.example/otlp/v1/traces')
    expect(normalizeOtlpEndpoint('https://collector.example/otlp/v1/traces')).toBe('https://collector.example/otlp/v1/traces')
    expect(normalizeOtlpEndpoint('http://127.0.0.1:4318')).toBe('http://127.0.0.1:4318/v1/traces')
    expect(normalizeOtlpEndpoint('')).toBeUndefined()
    expect(normalizeOtlpEndpoint('ftp://collector.example')).toBeUndefined()
    expect(normalizeOtlpEndpoint('not a url')).toBeUndefined()
  })

  it('reads configuration from the environment and stays disabled without an endpoint', () => {
    expect(readOtlpOptionsFromEnv({})).toEqual({})
    expect(readOtlpOptionsFromEnv({
      DEVORBIT_OTLP_ENDPOINT: 'https://collector.example',
      DEVORBIT_OTLP_TOKEN: 'otlp-token',
      DEVORBIT_OTLP_TIMEOUT_MS: '1500',
    })).toEqual({ endpoint: 'https://collector.example', token: 'otlp-token', timeoutMs: 1500 })

    const fetchImpl = vi.fn()
    const exporter = createOtlpExporter({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(exporter.enabled).toBe(false)
    expect(exporter.endpoint).toBeUndefined()
  })

  it('stays disabled when the configured endpoint is invalid', async () => {
    const fetchImpl = vi.fn()
    const exporter = createOtlpExporter({ endpoint: 'not a url', fetchImpl: fetchImpl as unknown as typeof fetch })

    const result = await exporter.exportSpan(span())
    expect(result).toEqual({ ok: false, error: 'otlp-disabled' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('OTLP exporter transport', () => {
  it('posts an OTLP payload with the bearer token only in the header', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }))
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example/otlp',
      token: 'otlp-secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await exporter.exportSpan(span({ status: 'error', error: { name: 'Error', message: 'boom sk-live-abcdef123456' } }))

    expect(result).toEqual({ ok: true, status: 200 })
    expect(exporter.endpoint).toBe('https://collector.example/otlp/v1/traces')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://collector.example/otlp/v1/traces')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer otlp-secret-token')
    const body = String(init.body)
    expect(body).not.toContain('otlp-secret-token')
    expect(body).not.toContain('sk-live-abcdef123456')
    const payload = JSON.parse(body) as {
      resourceSpans: Array<{ resource: { attributes: Array<{ value: { stringValue: string } }> }; scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>
    }
    expect(payload.resourceSpans[0].resource.attributes[0].value.stringValue).toBe('devorbit')
    const exported = payload.resourceSpans[0].scopeSpans[0].spans[0]
    expect(exported.name).toBe('ipc.devorbit:getConfig')
    expect(exported.traceId).toMatch(/^[0-9a-f]{32}$/u)
    expect(exported.spanId).toMatch(/^[0-9a-f]{16}$/u)
    expect(exported.startTimeUnixNano).toBe('1000000000')
    expect(exported.endTimeUnixNano).toBe('1050000000')
    expect(exported.status).toMatchObject({ code: 2 })
  })

  it('reports http failures without throwing', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }))
    const exporter = createOtlpExporter({ endpoint: 'https://collector.example', fetchImpl: fetchImpl as unknown as typeof fetch })

    await expect(exporter.exportSpan(span())).resolves.toEqual({ ok: false, status: 503, error: 'otlp-http-503' })
  })

  it('aborts when the configured timeout elapses', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const exporter = createOtlpExporter({
      endpoint: 'https://collector.example',
      timeoutMs: 50,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(exporter.exportSpan(span())).resolves.toMatchObject({ ok: false, error: 'otlp-timeout' })
  })

  it('redacts secrets from transport errors and payload text', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect failed with Bearer abcdefghijklmnop and api_key=sk-live-abcdef123456')
    })
    const exporter = createOtlpExporter({ endpoint: 'https://collector.example', fetchImpl: fetchImpl as unknown as typeof fetch })

    const result = await exporter.exportSpan(span())
    expect(result.ok).toBe(false)
    expect(result.error).not.toContain('abcdefghijklmnop')
    expect(result.error).not.toContain('sk-live-abcdef123456')
    expect(result.error).toContain('[REDACTED]')
    expect(redactOtlpText('token=topsecret value')).toBe('token=[REDACTED] value')
  })

  it('builds a deterministic payload for the same span', () => {
    const first = buildOtlpTracePayload(span(), 'devorbit')
    const second = buildOtlpTracePayload(span(), 'devorbit')
    expect(first).toEqual(second)
  })
})
