import fs from 'node:fs/promises'
import type {
  RealAccountUsage,
  RealUsageMetric,
  RealUsageState,
} from '../renderer/src/types'
import { getAuthFilePaths } from './account-profiles'

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODEX_SCOPE = 'openid profile email'
const REQUEST_TIMEOUT_MS = 12_000
const REFRESH_BUFFER_MS = 5 * 60 * 1000
const AUTH_FILE_MAX_BYTES = 2 * 1024 * 1024
export const USAGE_RESPONSE_MAX_BYTES = 1 * 1024 * 1024

type AccountId = 'account1' | 'account2'

interface AuthCredentials {
  accessToken: string
  refreshToken?: string
  idToken?: string
  accountId?: string
  expiresAt?: string
}

interface AuthDocument {
  filePath: string
  value: Record<string, unknown>
  credentials: AuthCredentials
  nestedTokens: boolean
}

interface ParsedUsage {
  plan?: string
  metrics: RealUsageMetric[]
}

class UsageRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function boundedPercent(value: unknown): number | undefined {
  const parsed = finiteNumber(value)
  if (parsed === undefined || parsed < 0 || parsed > 100) return undefined
  return Math.round(parsed * 10) / 10
}

function decodeJwtExpiry(token: string | undefined): number | undefined {
  if (!token) return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
    const exp = finiteNumber(payload.exp)
    return exp === undefined ? undefined : exp * 1000
  } catch {
    return undefined
  }
}

function getExpiryMs(credentials: AuthCredentials): number | undefined {
  const explicit = credentials.expiresAt ? Date.parse(credentials.expiresAt) : Number.NaN
  if (Number.isFinite(explicit)) return explicit
  return decodeJwtExpiry(credentials.accessToken) ?? decodeJwtExpiry(credentials.idToken)
}

async function readAuthDocument(account: AccountId): Promise<AuthDocument | undefined> {
  for (const file of getAuthFilePaths(account)) {
    try {
      const stat = await fs.stat(file)
      if (!stat.isFile() || stat.size <= 0 || stat.size > AUTH_FILE_MAX_BYTES) continue
      const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
      if (!isRecord(parsed)) continue

      const nested = isRecord(parsed.tokens) ? parsed.tokens : undefined
      const source = nested || parsed
      const accessToken = nonEmptyString(source.access_token)
      if (!accessToken) continue

      return {
        filePath: file,
        value: parsed,
        nestedTokens: Boolean(nested),
        credentials: {
          accessToken,
          ...(nonEmptyString(source.refresh_token) ? { refreshToken: source.refresh_token as string } : {}),
          ...(nonEmptyString(source.id_token) ? { idToken: source.id_token as string } : {}),
          ...(nonEmptyString(source.account_id) ? { accountId: source.account_id as string } : {}),
          ...(nonEmptyString(source.expires_at) ? { expiresAt: source.expires_at as string } : {}),
        },
      }
    } catch {
      // Try the next compatible path (only account 1 has a legacy fallback).
    }
  }
  return undefined
}

async function atomicallyWriteAuthFile(file: string, value: Record<string, unknown>): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  let renamed = false
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
    await fs.rename(temporary, file)
    renamed = true
  } finally {
    if (!renamed) await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  maxBytes = USAGE_RESPONSE_MAX_BYTES
): Promise<{ response: Response; payload: unknown }> {
  const controller = new AbortController()
  let timeoutTriggered = false
  let sizeLimitTriggered = false
  const timer = setTimeout(() => {
    timeoutTriggered = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const headers = response.headers as Headers | undefined
    const contentLength = Number(headers?.get('content-length') || 0)
    if (contentLength > maxBytes) {
      sizeLimitTriggered = true
      controller.abort()
      throw new Error('resposta da OpenAI excede o limite permitido')
    }

    let rawBody: string
    if (response.body) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let received = 0
      let body = ''
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          received += chunk.value.byteLength
          if (received > maxBytes) {
            sizeLimitTriggered = true
            controller.abort()
            throw new Error('resposta da OpenAI excede o limite permitido')
          }
          body += decoder.decode(chunk.value, { stream: true })
        }
        rawBody = body + decoder.decode()
      } finally {
        reader.releaseLock()
      }
    } else {
      const compatibleResponse = response as Response & { json?: () => Promise<unknown> }
      if (typeof response.text === 'function') {
        rawBody = await response.text()
      } else if (typeof compatibleResponse.json === 'function') {
        rawBody = JSON.stringify(await compatibleResponse.json())
      } else {
        throw new Error('resposta da OpenAI sem corpo')
      }
      if (Buffer.byteLength(rawBody, 'utf8') > maxBytes) {
        sizeLimitTriggered = true
        throw new Error('resposta da OpenAI excede o limite permitido')
      }
    }

    try {
      return { response, payload: JSON.parse(rawBody) as unknown }
    } catch {
      throw new Error('resposta JSON da OpenAI inválida')
    }
  } catch (error: unknown) {
    if (timeoutTriggered) throw new Error('tempo limite excedido')
    if (sizeLimitTriggered) throw new Error('resposta da OpenAI excede o limite permitido')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function parseResetAt(window: Record<string, unknown>, nowMs: number): number | undefined {
  const absolute = finiteNumber(window.reset_at)
  if (absolute !== undefined) return absolute > 1_000_000_000_000 ? absolute : absolute * 1000
  const relative = finiteNumber(window.reset_after_seconds)
  return relative === undefined ? undefined : nowMs + Math.max(0, relative) * 1000
}

function formatWindowLabel(seconds: number | undefined): string {
  if (seconds === 18_000) return 'Janela de 5h'
  if (seconds === 604_800) return 'Janela semanal'
  if (!seconds || seconds <= 0) return 'Janela de uso'
  const hours = Math.round(seconds / 3600)
  if (hours >= 24 && hours % 24 === 0) return `Janela de ${hours / 24}d`
  return `Janela de ${hours}h`
}

function appendWindow(
  metrics: RealUsageMetric[],
  id: string,
  label: string,
  windowValue: unknown,
  nowMs: number
): void {
  if (!isRecord(windowValue)) return
  const percent = boundedPercent(windowValue.used_percent)
  if (percent === undefined) return
  const windowSeconds = finiteNumber(windowValue.limit_window_seconds)
  const resetAt = parseResetAt(windowValue, nowMs)
  metrics.push({
    id,
    label: label || formatWindowLabel(windowSeconds),
    percent,
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(windowSeconds !== undefined && windowSeconds > 0 ? { windowSeconds } : {}),
  })
}

/** Parses the lossless percentage fields returned by Codex's usage endpoint. */
export function parseCodexUsagePayload(payload: unknown, nowMs = Date.now()): ParsedUsage {
  if (!isRecord(payload)) return { metrics: [] }
  const metrics: RealUsageMetric[] = []
  const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : undefined
  if (rateLimit) {
    const primary = isRecord(rateLimit.primary_window) ? rateLimit.primary_window : undefined
    const secondary = isRecord(rateLimit.secondary_window) ? rateLimit.secondary_window : undefined
    appendWindow(metrics, 'primary', formatWindowLabel(finiteNumber(primary?.limit_window_seconds)), primary, nowMs)
    appendWindow(metrics, 'secondary', formatWindowLabel(finiteNumber(secondary?.limit_window_seconds)), secondary, nowMs)
  }

  const codeReview = isRecord(payload.code_review_rate_limit) ? payload.code_review_rate_limit : undefined
  if (codeReview) {
    appendWindow(metrics, 'code-review', 'Code review · janela semanal', codeReview.primary_window, nowMs)
  }

  if (Array.isArray(payload.additional_rate_limits)) {
    payload.additional_rate_limits.forEach((entry, index) => {
      if (!isRecord(entry)) return
      const name = nonEmptyString(entry.limit_name) || nonEmptyString(entry.metered_feature) || `Limite adicional ${index + 1}`
      const limit = isRecord(entry.rate_limit) ? entry.rate_limit : undefined
      if (!limit) return
      appendWindow(metrics, `additional-${index}-primary`, `${name} · ${formatWindowLabel(finiteNumber(isRecord(limit.primary_window) ? limit.primary_window.limit_window_seconds : undefined))}`, limit.primary_window, nowMs)
      appendWindow(metrics, `additional-${index}-secondary`, `${name} · ${formatWindowLabel(finiteNumber(isRecord(limit.secondary_window) ? limit.secondary_window.limit_window_seconds : undefined))}`, limit.secondary_window, nowMs)
    })
  }

  const credits = isRecord(payload.credits) ? payload.credits : undefined
  if (credits) {
    const balance = nonEmptyString(credits.balance)
    const unlimited = credits.unlimited === true
    if (balance || unlimited) {
      metrics.push({
        id: 'credits',
        label: 'Créditos',
        value: unlimited ? 'Ilimitado' : balance,
      })
    }
  }

  return {
    plan: nonEmptyString(payload.plan_type),
    metrics,
  }
}

async function fetchUsagePayload(credentials: AuthCredentials): Promise<{ payload: unknown; credentials: AuthCredentials }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
    'User-Agent': 'codex-cli',
  }
  if (credentials.accountId) headers['ChatGPT-Account-Id'] = credentials.accountId
  const { response, payload } = await fetchJsonWithTimeout(CODEX_USAGE_URL, { headers })
  if (response.ok) return { payload, credentials }
  throw new UsageRequestError(`consulta recusada (${response.status})`, response.status)
}

async function fetchAccountUsage(account: AccountId): Promise<RealAccountUsage> {
  const base: RealAccountUsage = { account, status: 'not_configured', metrics: [] }
  const document = await readAuthDocument(account)
  if (!document) {
    return { ...base, message: 'Conta ainda não autenticada pelo Codex.' }
  }

  let credentials = document.credentials
  try {
    const expiry = getExpiryMs(credentials)
    if (expiry !== undefined && expiry <= Date.now() + REFRESH_BUFFER_MS) {
      // The refresh endpoint is intentionally only reached for the official
      // auth.openai.com host; tokens never leave that flow or enter app state.
      // A token can still be accepted during the refresh buffer. Keep the
      // current token as a fallback so a temporary refresh 401 does not hide
      // a valid usage response; the request itself remains the authority.
      try {
        credentials = await refreshCredentialsForAccount(document, account)
      } catch {
        credentials = document.credentials
      }
    }
    let response: { payload: unknown; credentials: AuthCredentials }
    try {
      response = await fetchUsagePayload(credentials)
    } catch (error: unknown) {
      if (error instanceof UsageRequestError && error.status === 401 && document.credentials.refreshToken) {
        try {
          credentials = await refreshCredentialsForAccount(document, account)
          response = await fetchUsagePayload(credentials)
        } catch {
          throw new Error('Token expirado ou revogado. Use “Conectar Agora” para autenticar esta conta novamente.')
        }
      } else {
        throw error
      }
    }
    const parsed = parseCodexUsagePayload(response.payload)
    if (parsed.metrics.length === 0) {
      return {
        ...base,
        status: 'error',
        fetchedAt: new Date().toISOString(),
        message: 'A resposta da OpenAI não trouxe janelas de uso com porcentagem.',
      }
    }
    return {
      account,
      status: 'ready',
      ...(parsed.plan ? { plan: parsed.plan } : {}),
      metrics: parsed.metrics,
      fetchedAt: new Date().toISOString(),
    }
  } catch (error: unknown) {
    const message = error instanceof UsageRequestError && error.status === 401
      ? 'Token expirado ou revogado. Use “Conectar Agora” para autenticar esta conta novamente.'
      : error instanceof Error
        ? error.message
        : 'falha desconhecida ao consultar a OpenAI'
    return {
      ...base,
      status: 'error',
      fetchedAt: new Date().toISOString(),
      message: message.slice(0, 240),
    }
  }
}

// Kept separate so the account-specific auth path is always used when a
// refresh writes the rotated refresh token back to disk.
async function refreshCredentialsForAccount(document: AuthDocument, account: AccountId): Promise<AuthCredentials> {
  if (!document.credentials.refreshToken) throw new Error('token de atualização ausente')

  const { response, payload } = await fetchJsonWithTimeout(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: document.credentials.refreshToken,
        scope: CODEX_SCOPE,
      }),
  })
  if (!response.ok) throw new Error(`refresh recusado (${response.status})`)
  const body: unknown = payload
  if (!isRecord(body) || !nonEmptyString(body.access_token)) throw new Error('resposta de refresh inválida')

  const expiresIn = finiteNumber(body.expires_in)
  const next: AuthCredentials = {
    ...document.credentials,
    accessToken: body.access_token as string,
    ...(nonEmptyString(body.refresh_token) ? { refreshToken: body.refresh_token as string } : {}),
    ...(nonEmptyString(body.id_token) ? { idToken: body.id_token as string } : {}),
    ...(expiresIn !== undefined ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() } : {}),
  }
  const updated = JSON.parse(JSON.stringify(document.value)) as Record<string, unknown>
  const target = document.nestedTokens && isRecord(updated.tokens) ? updated.tokens as Record<string, unknown> : updated
  target.access_token = next.accessToken
  if (next.refreshToken) target.refresh_token = next.refreshToken
  if (next.idToken) target.id_token = next.idToken
  if (next.expiresAt) target.expires_at = next.expiresAt
  updated.last_refresh = new Date().toISOString()
  await atomicallyWriteAuthFile(document.filePath, updated).catch((error: unknown) => {
    console.warn(
      '[Codex usage] Falha ao persistir credenciais atualizadas:',
      error instanceof Error ? error.message : 'erro desconhecido'
    )
  })
  return next
}

let cachedUsage: RealUsageState | undefined
let cachedAt = 0
let usageRequestInFlight: Promise<RealUsageState> | null = null

export function getRealUsage(force = false): Promise<RealUsageState> {
  if (!force && cachedUsage && Date.now() - cachedAt < 30_000) return Promise.resolve(cachedUsage)
  if (usageRequestInFlight) return usageRequestInFlight

  const operation = Promise.all([
    fetchAccountUsage('account1'),
    fetchAccountUsage('account2'),
  ]).then(([account1, account2]) => {
    const result: RealUsageState = {
      source: 'codex-oauth',
      fetchedAt: new Date().toISOString(),
      accounts: { account1, account2 },
    }
    cachedUsage = result
    cachedAt = Date.now()
    return result
  })
  const trackedOperation = operation.finally(() => {
    if (usageRequestInFlight === trackedOperation) usageRequestInFlight = null
  })
  usageRequestInFlight = trackedOperation
  return trackedOperation
}
