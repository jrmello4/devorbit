/**
 * Quota do Claude Code via endpoint OAuth de usage.
 *
 * Fonte descoberta por pesquisa (não documentada oficialmente, forma
 * confirmada pela comunidade): GET https://api.anthropic.com/api/oauth/usage
 * com Bearer token do claudeAiOauth (~/.claude/.credentials.json) e header
 * anthropic-beta: oauth-2025-04-20. Resposta: {"five_hour":{"utilization",
 * "resets_at"},"seven_day":{...}}.
 *
 * O endpoint é limitado por token (~poucas chamadas e depois 429, alguns
 * usuários relatam 429 persistente). Por isso o poller é conservador por
 * design: intervalo mínimo longo entre chamadas e cooldown longo após 429.
 * Best-effort: qualquer falha vira null, nunca derruba o fluxo de uso.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { UsageQuotaEvent } from '../shared/usage-contract'

const CLAUDE_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const CLAUDE_USAGE_BETA_HEADER = 'oauth-2025-04-20'
const REQUEST_TIMEOUT_MS = 10_000

/** Intervalo mínimo entre chamadas bem-sucedidas. */
const SUCCESS_MIN_INTERVAL_MS = 30 * 60_000
/** Cooldown após 429: o endpoint documenta limite agressivo por token. */
const RATE_LIMIT_COOLDOWN_MS = 6 * 60 * 60_000
/** Cooldown após outros erros (rede, formato). */
const ERROR_COOLDOWN_MS = 60 * 60_000

export interface ClaudeUsageWindow {
  utilization?: number
  resets_at?: string
}

interface ClaudeUsagePayload {
  five_hour?: ClaudeUsageWindow
  seven_day?: ClaudeUsageWindow
  [key: string]: unknown
}

export interface ClaudeQuotaPollerOptions {
  credentialsPath: string
  fetchImpl?: typeof fetch
  now?: () => number
  /** Injeta o intervalo mínimo em testes. */
  successMinIntervalMs?: number
}

export interface ClaudeQuotaPoller {
  /** Devolve o evento de quota quando vale a pena consultar; null quando
   * silenciado por throttle/cooldown ou sem credencial. Nunca lança. */
  check(): Promise<UsageQuotaEvent | null>
}

/** Extrai o accessToken do claudeAiOauth; formatos alternativos tolerados. */
export async function readClaudeOAuthAccessToken(credentialsPath: string): Promise<string | null> {
  let content: string
  try {
    content = await fs.readFile(credentialsPath, 'utf-8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const source = parsed as Record<string, unknown>
  const oauth = typeof source.claudeAiOauth === 'object' && source.claudeAiOauth !== null
    ? source.claudeAiOauth as Record<string, unknown>
    : undefined
  const token = oauth?.accessToken ?? source.accessToken
  return typeof token === 'string' && token.length > 0 ? token : null
}

function mapWindow(id: string, label: string, window: ClaudeUsageWindow | undefined): { id: string; label: string; percent?: number; resetAt?: string } {
  const entry: { id: string; label: string; percent?: number; resetAt?: string } = { id, label }
  if (typeof window?.utilization === 'number' && Number.isFinite(window.utilization)) {
    entry.percent = Math.max(0, Math.min(100, Math.round(window.utilization * 10) / 10))
  }
  if (typeof window?.resets_at === 'string' && window.resets_at) entry.resetAt = window.resets_at
  return entry
}

export function parseClaudeUsagePayload(payload: unknown, at: string): UsageQuotaEvent | null {
  if (typeof payload !== 'object' || payload === null) return null
  const source = payload as ClaudeUsagePayload
  const windows = [
    mapWindow('five_hour', '5 horas', source.five_hour),
    mapWindow('seven_day', 'Semanal', source.seven_day),
  ].filter((window) => window.percent !== undefined || window.resetAt !== undefined)
  if (windows.length === 0) return null
  return {
    kind: 'quota',
    at,
    provider: 'claude',
    windows,
  }
}

export function createClaudeQuotaPoller(options: ClaudeQuotaPollerOptions): ClaudeQuotaPoller {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const successMinIntervalMs = options.successMinIntervalMs ?? SUCCESS_MIN_INTERVAL_MS
  let lastSuccessAt = 0
  let silentUntil = 0

  return {
    async check(): Promise<UsageQuotaEvent | null> {
      const timestamp = now()
      if (timestamp < silentUntil) return null
      if (lastSuccessAt !== 0 && timestamp - lastSuccessAt < successMinIntervalMs) return null

      const token = await readClaudeOAuthAccessToken(options.credentialsPath)
      if (!token) {
        // Sem credencial não há reason para retentar antes do próximo ciclo.
        silentUntil = timestamp + ERROR_COOLDOWN_MS
        return null
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await fetchImpl(CLAUDE_USAGE_ENDPOINT, {
          method: 'GET',
          headers: {
            Authorization: 'Bearer ' + token,
            'anthropic-beta': CLAUDE_USAGE_BETA_HEADER,
          },
          signal: controller.signal,
        })
        if (response.status === 429) {
          silentUntil = timestamp + RATE_LIMIT_COOLDOWN_MS
          return null
        }
        if (!response.ok) {
          silentUntil = timestamp + ERROR_COOLDOWN_MS
          return null
        }
        const payload: unknown = await response.json()
        const event = parseClaudeUsagePayload(payload, new Date(timestamp).toISOString())
        if (!event) {
          silentUntil = timestamp + ERROR_COOLDOWN_MS
          return null
        }
        lastSuccessAt = timestamp
        return event
      } catch {
        silentUntil = timestamp + ERROR_COOLDOWN_MS
        return null
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

/** Caminho padrão das credenciais do Claude Code. */
export function defaultClaudeCredentialsPath(homedir: string, env: NodeJS.ProcessEnv = process.env): string {
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(homedir, '.claude')
  return path.join(claudeDir, '.credentials.json')
}
