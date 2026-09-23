import fs from 'node:fs/promises'
import path from 'node:path'
import {
  getShadowObservations,
  onShadowObservation,
  SHADOW_MAX_OBSERVATIONS,
  type ShadowObservation,
  type ShadowOutcome,
  type ShadowTier,
} from './agent-providers'

export const SHADOW_ROUTING_METRICS_FILENAME = 'typesafe-shadow-routing-metrics.json'
export const SHADOW_ROUTING_METRICS_MAX_BYTES = 8_192
export const SHADOW_ROUTING_METRICS_FLUSH_INTERVAL_MS = 30_000

type AgreementBucket = {
  total: number
  agreed: number
  rate: number
}

export interface ShadowRoutingMetricsReport {
  total: number
  agreement: {
    fast: AgreementBucket
    deep: AgreementBucket
    total: AgreementBucket
  }
  reviewRate: number
  outcomes: Record<ShadowOutcome, number>
  cacheHits: number
  latencyMs: {
    count: number
    min: number
    max: number
    mean: number
    p50: number
    p95: number
  }
}

const SHADOW_OUTCOMES: readonly ShadowOutcome[] = [
  'ok',
  'skipped',
  'timeout',
  'invalid',
  'error',
  'circuit-open',
]
const SHADOW_TIERS: readonly ShadowTier[] = ['fast', 'deep', 'review']

function emptyAgreement(): AgreementBucket {
  return { total: 0, agreed: 0, rate: 0 }
}

function emptyOutcomes(): Record<ShadowOutcome, number> {
  return {
    ok: 0,
    skipped: 0,
    timeout: 0,
    invalid: 0,
    error: 0,
    'circuit-open': 0,
  }
}

function rate(agreed: number, total: number): number {
  return total === 0 ? 0 : agreed / total
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index] ?? 0
}

function isShadowTier(value: unknown): value is ShadowTier {
  return typeof value === 'string' && SHADOW_TIERS.includes(value as ShadowTier)
}

function isShadowOutcome(value: unknown): value is ShadowOutcome {
  return typeof value === 'string' && SHADOW_OUTCOMES.includes(value as ShadowOutcome)
}

function finalizeAgreement(bucket: AgreementBucket): AgreementBucket {
  return { ...bucket, rate: rate(bucket.agreed, bucket.total) }
}

/**
 * Produz somente números derivados das observações da sombra. Nenhum campo de
 * entrada textual é copiado para o relatório.
 */
export function aggregateShadowObservations(
  observations: readonly ShadowObservation[]
): ShadowRoutingMetricsReport {
  const recent = observations.slice(-SHADOW_MAX_OBSERVATIONS)
  const outcomes = emptyOutcomes()
  const fast = emptyAgreement()
  const deep = emptyAgreement()
  const latencies: number[] = []
  let cacheHits = 0
  let reviewCount = 0
  let judgedCount = 0

  for (const observation of recent) {
    if (isShadowOutcome(observation.outcome)) outcomes[observation.outcome] += 1
    if (observation.cacheHit === true) cacheHits += 1

    if (observation.outcome !== 'ok' || !isShadowTier(observation.tier)) continue
    judgedCount += 1
    if (observation.tier === 'review') reviewCount += 1

    if (observation.heuristicTier === 'fast' || observation.heuristicTier === 'deep') {
      const bucket = observation.heuristicTier === 'fast' ? fast : deep
      bucket.total += 1
      if (observation.tier === observation.heuristicTier) bucket.agreed += 1
    }

    if (Number.isFinite(observation.latencyMs) && observation.latencyMs >= 0) {
      latencies.push(observation.latencyMs)
    }
  }

  latencies.sort((left, right) => left - right)
  const latencyTotal = latencies.reduce((sum, value) => sum + value, 0)
  const latencyMs = {
    count: latencies.length,
    min: latencies[0] ?? 0,
    max: latencies.at(-1) ?? 0,
    mean: latencies.length === 0 ? 0 : latencyTotal / latencies.length,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
  }
  const totalAgreement = {
    total: fast.total + deep.total,
    agreed: fast.agreed + deep.agreed,
    rate: 0,
  }

  return {
    total: recent.length,
    agreement: {
      fast: finalizeAgreement(fast),
      deep: finalizeAgreement(deep),
      total: finalizeAgreement(totalAgreement),
    },
    reviewRate: rate(reviewCount, judgedCount),
    outcomes,
    cacheHits,
    latencyMs,
  }
}

export function getShadowRoutingMetricsPath(userDataPath: string): string {
  return path.join(userDataPath, SHADOW_ROUTING_METRICS_FILENAME)
}

let writeQueue: Promise<void> = Promise.resolve()
let metricsUserDataPath: string | undefined
let flushTimer: NodeJS.Timeout | undefined
/**
 * Só há o que gravar depois de uma observação nova (o agregado é derivado
 * exclusivamente delas): sem dirty, o flush periódico de 30s não escreve.
 */
let metricsDirty = false
let unsubscribeObservations: (() => void) | undefined

function enqueueWrite(operation: () => Promise<void>): Promise<void> {
  const next = writeQueue.catch(() => undefined).then(operation)
  writeQueue = next.catch(() => undefined)
  return next
}

async function writeReportFile(filePath: string, report: ShadowRoutingMetricsReport): Promise<void> {
  const content = JSON.stringify(report)
  if (Buffer.byteLength(content, 'utf8') > SHADOW_ROUTING_METRICS_MAX_BYTES) return

  const temporaryPath = `${filePath}.tmp`
  let renamed = false
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const handle = await fs.open(temporaryPath, 'w')
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporaryPath, filePath)
    renamed = true
  } catch {
    // Métricas são auxiliares: uma falha de disco nunca afeta o turno.
  } finally {
    if (!renamed) await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

/** Grava o relatório agregado atual sem expor o caminho ou o erro em logs. */
export function writeShadowRoutingMetrics(
  userDataPath: string,
  observations: readonly ShadowObservation[] = getShadowObservations()
): Promise<void> {
  if (!userDataPath.trim()) return Promise.resolve()
  const report = aggregateShadowObservations(observations)
  return enqueueWrite(() => writeReportFile(getShadowRoutingMetricsPath(userDataPath), report))
}

/** Inicializa a fotografia vazia e mantém o relatório atualizado durante a sessão. */
export function startShadowRoutingMetrics(
  userDataPath: string,
  intervalMs = SHADOW_ROUTING_METRICS_FLUSH_INTERVAL_MS
): void {
  if (flushTimer && metricsUserDataPath === userDataPath) return
  if (flushTimer) clearInterval(flushTimer)
  if (!unsubscribeObservations) {
    // Qualquer observação nova muta o agregado: marca o relatório como sujo.
    unsubscribeObservations = onShadowObservation(() => {
      metricsDirty = true
    })
  }
  metricsUserDataPath = userDataPath
  void writeShadowRoutingMetrics(userDataPath)
  flushTimer = setInterval(() => {
    if (!metricsUserDataPath || !metricsDirty) return
    metricsDirty = false
    void writeShadowRoutingMetrics(metricsUserDataPath)
  }, Math.max(1_000, intervalMs))
  flushTimer.unref?.()
}

export function isShadowRoutingMetricsRunning(): boolean {
  return flushTimer !== undefined
}

/** Para novas gravações e, se houver mudança pendente, atualiza uma última vez. */
export function stopShadowRoutingMetrics(): Promise<void> {
  if (flushTimer) clearInterval(flushTimer)
  flushTimer = undefined
  if (unsubscribeObservations) {
    unsubscribeObservations()
    unsubscribeObservations = undefined
  }
  const userDataPath = metricsUserDataPath
  metricsUserDataPath = undefined
  if (!userDataPath) return Promise.resolve()
  if (metricsDirty) {
    metricsDirty = false
    return writeShadowRoutingMetrics(userDataPath)
  }
  // Sem mudança pendente: apenas aguarda escritas já enfileiradas (ex.: a
  // fotografia inicial) antes de devolver.
  return writeQueue.catch(() => undefined)
}
