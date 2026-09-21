/**
 * Contrato compartilhado do rastreamento de uso por modelo (usage share).
 *
 * Três fontes alimentam o mesmo store de eventos no main:
 * - Camada A (universal): turnos e sessões registrados pelo próprio DevOrbit
 *   via presets/turns — funciona com qualquer CLI atual ou futuro.
 * - Camada B (tokens reais): adaptadores leem os stores locais de cada CLI
 *   (transcripts do Claude, rollouts do Codex, storage do OpenCode) de forma
 *   incremental e somente leitura. Nada sai da máquina.
 * - Quota: snapshots de janela/limite por conta (hoje: Codex via OAuth).
 *
 * Um evento é imutável e carrega dedupeKey; agregação é derivada na leitura.
 */

/** Evento de turno agente registrado no sendAgentTurn / start provider. */
export interface UsageTurnEvent {
  kind: 'turn'
  at: string
  terminalId: string
  provider: string
  model: string
  tier?: string
  outcome: 'completed' | 'blocked' | 'failed'
  durationMs?: number
}

/** Evento de sessão de terminal com provider (start → exit). */
export interface UsageSessionEvent {
  kind: 'session'
  at: string
  terminalId: string
  provider: string
  presetId?: string
  durationMs: number
}

/** Evento de tokens reais, de adaptador local ou do roteador LLM interno. */
export interface UsageTokenEvent {
  kind: 'tokens'
  at: string
  source: 'claude-transcripts' | 'codex-rollouts' | 'opencode-storage' | 'gemini-local' | 'llm-router'
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** Estável por registro (arquivo+offset ou id de mensagem): idempotência. */
  dedupeKey: string
}

/** Snapshot de quota/janela de uma conta (percentuais publicados pelo provider). */
export interface UsageQuotaEvent {
  kind: 'quota'
  at: string
  provider: string
  accountId?: string
  windows: Array<{ id: string; label: string; percent?: number; resetAt?: string }>
}

export type UsageEvent = UsageTurnEvent | UsageSessionEvent | UsageTokenEvent | UsageQuotaEvent

/** Participação de um modelo dentro de uma janela. */
export interface UsageModelShare {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  totalTokens: number
  turns: number
  sessions: number
  activeMs: number
}

export type UsageShareWindowId = 'day' | 'week' | 'all'

export interface UsageShareWindow {
  window: UsageShareWindowId
  since: string
  totalTokens: number
  totalTurns: number
  models: UsageModelShare[]
}

export interface UsageQuotaSnapshotView {
  provider: string
  accountId?: string
  at: string
  windows: Array<{ id: string; label: string; percent?: number; resetAt?: string }>
}

export interface UsageAdapterStatus {
  source: 'claude-transcripts' | 'codex-rollouts' | 'opencode-storage' | 'gemini-local' | 'llm-router'
  status: 'ok' | 'empty' | 'error' | 'missing'
  lastScanAt?: string
  message?: string
}

export interface UsageShareState {
  windows: Record<UsageShareWindowId, UsageShareWindow>
  quota: UsageQuotaSnapshotView[]
  adapters: UsageAdapterStatus[]
  generatedAt: string
}

/** Estado incremental dos adaptadores (offsets por arquivo), persistido. */
export interface UsageScanState {
  offsets: Record<string, number>
}

export interface UsageScanResult {
  events: UsageTokenEvent[]
  state: UsageScanState
  statuses: UsageAdapterStatus[]
}

export interface UsageSourceDirs {
  claude?: string
  codex?: string
  opencode?: string
  gemini?: string
}
