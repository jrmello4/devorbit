import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ShadowObservation } from '../src/main/agent-providers'
import {
  aggregateShadowObservations,
  getShadowRoutingMetricsPath,
  isShadowRoutingMetricsRunning,
  startShadowRoutingMetrics,
  stopShadowRoutingMetrics,
  writeShadowRoutingMetrics,
} from '../src/main/shadow-routing-metrics'

const roots: string[] = []

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devorbit-shadow-metrics-'))
  roots.push(root)
  return root
}

function observation(overrides: Partial<ShadowObservation> = {}): ShadowObservation {
  return {
    at: 1,
    promptChars: 20,
    heuristicTier: 'fast',
    outcome: 'ok',
    tier: 'fast',
    confidence: 0.9,
    cacheHit: false,
    latencyMs: 100,
    ...overrides,
  }
}

afterEach(async () => {
  await stopShadowRoutingMetrics()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('shadow routing metrics', () => {
  it('aggregates outcomes, fast/deep agreement, review rate, cache hits and latency', () => {
    const report = aggregateShadowObservations([
      observation({ heuristicTier: 'fast', tier: 'fast', latencyMs: 100 }),
      observation({ heuristicTier: 'fast', tier: 'deep', cacheHit: true, latencyMs: 20 }),
      observation({ heuristicTier: 'deep', tier: 'deep', latencyMs: 300 }),
      observation({ heuristicTier: 'deep', tier: 'review', latencyMs: 500 }),
      observation({ outcome: 'skipped', tier: undefined, confidence: undefined, latencyMs: 0 }),
      observation({ outcome: 'invalid', tier: undefined, confidence: undefined, latencyMs: 0 }),
    ])

    expect(report).toEqual({
      total: 6,
      agreement: {
        fast: { total: 2, agreed: 1, rate: 0.5 },
        deep: { total: 2, agreed: 1, rate: 0.5 },
        total: { total: 4, agreed: 2, rate: 0.5 },
      },
      reviewRate: 0.25,
      outcomes: {
        ok: 4,
        skipped: 1,
        timeout: 0,
        invalid: 1,
        error: 0,
        'circuit-open': 0,
      },
      cacheHits: 1,
      latencyMs: { count: 4, min: 20, max: 500, mean: 230, p50: 100, p95: 500 },
    })
  })

  it('writes one bounded JSON report and excludes every prohibited field', async () => {
    const root = await createTempRoot()
    const forbidden = [
      'prompt-cru-secreto',
      'state-cru-secreto',
      'texto-redigido-secreto',
      'hash-secreto',
      'C:\\Users\\local\\repo',
      'ghp_secret_token',
      'resposta-crua-secreta',
      'excecao-crua-secreta',
      'TYPESAFE_API_KEY=secret',
    ]
    const poisoned = {
      ...observation(),
      prompt: forbidden[0],
      state: forbidden[1],
      redactedState: forbidden[2],
      hash: forbidden[3],
      path: forbidden[4],
      token: forbidden[5],
      rawResponse: forbidden[6],
      exception: forbidden[7],
      key: forbidden[8],
    } as unknown as ShadowObservation

    await writeShadowRoutingMetrics(root, [poisoned])
    const reportPath = getShadowRoutingMetricsPath(root)
    const raw = await readFile(reportPath, 'utf8')
    const report = JSON.parse(raw) as Record<string, unknown>

    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(8_192)
    expect(Object.keys(report)).toEqual([
      'total',
      'agreement',
      'reviewRate',
      'outcomes',
      'cacheHits',
      'latencyMs',
    ])
    for (const value of forbidden) expect(raw).not.toContain(value)
  })

  it('serializes concurrent writes and leaves a valid final report', async () => {
    const root = await createTempRoot()
    await Promise.all([
      writeShadowRoutingMetrics(root, [observation({ latencyMs: 10 })]),
      writeShadowRoutingMetrics(root, [observation({ outcome: 'timeout', tier: undefined, latencyMs: 0 })]),
    ])

    const report = JSON.parse(await readFile(getShadowRoutingMetricsPath(root), 'utf8')) as {
      outcomes: Record<string, number>
    }
    expect(report.outcomes.timeout).toBe(1)
  })

  it('is tolerant of a report path that cannot be written', async () => {
    const root = await createTempRoot()
    const blockedPath = path.join(root, 'existing-file')
    await writeFile(blockedPath, 'preservar')

    await expect(writeShadowRoutingMetrics(blockedPath, [observation()])).resolves.toBeUndefined()
    expect(await readFile(blockedPath, 'utf8')).toBe('preservar')
  })

  it('creates the stable report at startup and flushes on stop', async () => {
    const root = await createTempRoot()
    startShadowRoutingMetrics(root, 1_000)
    await stopShadowRoutingMetrics()

    const report = JSON.parse(await readFile(getShadowRoutingMetricsPath(root), 'utf8')) as {
      total: number
    }
    expect(report.total).toBe(0)
  })

  it('is idempotent when the startup hook is invoked more than once', async () => {
    const root = await createTempRoot()
    startShadowRoutingMetrics(root, 1_000)
    startShadowRoutingMetrics(root, 1_000)

    expect(isShadowRoutingMetricsRunning()).toBe(true)
    await stopShadowRoutingMetrics()
    expect(isShadowRoutingMetricsRunning()).toBe(false)
  })

  it('keeps exactly one metrics initialization call in the Electron main lifecycle', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/main/index.ts'), 'utf8')
    expect(source.match(/\bstartShadowRoutingMetrics\(/g)).toHaveLength(1)
  })
})
