/**
 * Configuração e utilitários LOCAIS do backend ai-usagebar (DevOrbit).
 *
 * Fronteiras:
 * - config/runtime vivem SEMPRE sob o userData fornecido; o cache interno do
 *   upstream usa o default dele (subcommands rejeitam `--cache-dir`);
 * - toda invocação do CLI recebe `--config` explícito;
 * - nenhum segredo entra em logs/erros: mensagens passam por sanitize;
 * - env do filho é allowlist do SO + overlay explícito (chaves de API do
 *   chamador), nunca `process.env` inteiro.
 */

import path from 'node:path'

/** Versão pinada do ai-usagebar suportada por este backend. */
export const AI_USAGEBAR_VERSION = '1.24.0'

/** Asset oficial (Windows x64) do release pinado. */
export const AI_USAGEBAR_WINDOWS_X64_URL =
  'https://github.com/akitaonrails/ai-usagebar/releases/download/v1.24.0/ai-usagebar-windows-x86_64.exe'

/** SHA-256 do asset oficial, verificado antes de qualquer execução. */
export const AI_USAGEBAR_WINDOWS_X64_SHA256 =
  '286f0a480ac5ad6b5da79433b5b5852f4f807da87ffb9ef442dfc87045a4363d'

/** Tetos de saída dos subprocessos (defesa contra relatório gigante). */
export const AI_USAGEBAR_MAX_STDOUT_BYTES = 4 * 1024 * 1024
export const AI_USAGEBAR_MAX_STDERR_BYTES = 64 * 1024
/**
 * Timeout default e TETO de cada comando: `usage --json` serializa vários
 * vendors e cada chamada HTTP pode gastar até 30s. 10s é o limite duro para
 * não travar a UI; `timeoutMs` injetado é sempre clampado a este teto.
 */
export const AI_USAGEBAR_COMMAND_TIMEOUT_MS = 10_000
export const AI_USAGEBAR_COMMAND_TIMEOUT_MIN_MS = 1_000
export const AI_USAGEBAR_COMMAND_TIMEOUT_MAX_MS = 10_000
/** Tamanho máximo exibido em mensagens de erro sanitizadas. */
export const AI_USAGEBAR_ERROR_MAX_CHARS = 400

/** Forma aceitável de um id de vendor (genérico, sem catálogo embutido). */
export const AI_USAGEBAR_VENDOR_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Conteúdo do config criado no primeiro uso (TOML válido, sem defaults). */
export const AI_USAGEBAR_DEFAULT_CONFIG_CONTENT =
  '# ai-usagebar config — arquivo criado pelo DevOrbit; o schema pertence ao upstream.\n'

/** Downloader default: bounded, timeout com AbortController, temp atômico. */
export const AI_USAGEBAR_DOWNLOAD_TIMEOUT_MS = 60_000
export const AI_USAGEBAR_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024

export interface AiUsagebarDownloadOptions {
  timeoutMs?: number
  maxBytes?: number
}

const EXCESS_BYTES_ERROR = 'Download do ai-usagebar excedeu o limite de bytes.'

function declaredContentLength(response: Response): number | undefined {
  try {
    const raw = response.headers.get('content-length')
    if (typeof raw !== 'string' || raw.trim() === '') return undefined
    const value = Number(raw)
    return Number.isFinite(value) && value >= 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Lê o body com cap DURANTE a leitura (stream), sem materializar tudo antes:
 * rejeita Content-Length acima do limite e cancela o reader assim que o total
 * excede. Fallback pós-leitura só para respostas sem stream (mocks exóticos).
 */
async function readBodyBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = declaredContentLength(response)
  if (declared !== undefined && declared > maxBytes) throw new Error(EXCESS_BYTES_ERROR)
  const body = response.body as ReadableStream<Uint8Array> | null | undefined
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike)
        total += chunk.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined)
          throw new Error(EXCESS_BYTES_ERROR)
        }
        chunks.push(chunk)
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // Sem lock para liberar.
      }
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return merged
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) throw new Error(EXCESS_BYTES_ERROR)
  return bytes
}

/**
 * Baixa o binário pinado via `fetch` com timeout duro (AbortController),
 * limite de bytes PROGRESSIVO e escrita ATÔMICA (`<dest>.part` → rename).
 * Nunca escreve fora do destino informado pelo caller.
 */
export async function defaultAiUsagebarDownload(
  url: string,
  destination: string,
  options: AiUsagebarDownloadOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? AI_USAGEBAR_DOWNLOAD_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? AI_USAGEBAR_DOWNLOAD_MAX_BYTES
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const { writeFile, rename, rm } = await import('node:fs/promises')
  const temporary = `${destination}.part`
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'application/octet-stream' },
    })
    if (!response.ok) {
      throw new Error(`Download do ai-usagebar falhou (HTTP ${response.status}).`)
    }
    const bytes = await readBodyBounded(response, maxBytes)
    if (bytes.byteLength === 0) throw new Error('Download do ai-usagebar vazio.')
    await writeFile(temporary, bytes)
    await rename(temporary, destination)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    if (controller.signal.aborted) throw new Error('Download do ai-usagebar excedeu o timeout.')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Clamp do timeout do comando no teto duro. */
export function clampAiUsagebarTimeout(timeoutMs?: number): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return AI_USAGEBAR_COMMAND_TIMEOUT_MS
  }
  return Math.max(
    AI_USAGEBAR_COMMAND_TIMEOUT_MIN_MS,
    Math.min(AI_USAGEBAR_COMMAND_TIMEOUT_MAX_MS, Math.floor(timeoutMs))
  )
}

export interface AiUsagebarPaths {
  root: string
  configPath: string
  runtimeDir: string
  binaryPath: string
}

/** Caminhos determinísticos sob o userData FORNECIDO (nunca outro home). */
export function resolveAiUsagebarPaths(userDataDir: string): AiUsagebarPaths {
  const root = path.join(userDataDir, 'ai-usagebar')
  return {
    root,
    configPath: path.join(root, 'config.toml'),
    runtimeDir: path.join(root, 'runtime'),
    binaryPath: path.join(root, 'runtime', 'ai-usagebar.exe'),
  }
}

/* ------------------------------------------------------------------ */
/* Env mínimo do filho (allowlist + overlay explícito)                 */
/* ------------------------------------------------------------------ */

const BASE_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'path',
  'pathext',
  'comspec',
  'systemroot',
  'systemdrive',
  'windir',
  'process architecture'.replace(' ', '_'),
  'number_of_processors',
  'programdata',
  'programfiles',
  'programfiles(x86)',
  'commonprogramfiles',
  'username',
  'userdomain',
  'userprofile',
  'homedrive',
  'homepath',
  'home',
  'appdata',
  'localappdata',
  'temp',
  'tmp',
  'tmpdir',
  'lang',
  'lc_all',
  'tz',
])

/**
 * Env do subprocesso ai-usagebar: allowlist do SO + overlay do chamador.
 * O overlay é INTENCIONAL (chaves de API por vendor) e nunca é logado.
 */
export function buildAiUsagebarEnv(overlay?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (!BASE_ENV_ALLOWLIST.has(key.toLowerCase())) continue
    env[key] = value
  }
  if (overlay) {
    for (const [key, value] of Object.entries(overlay)) {
      if (value === undefined || value === '') continue
      env[key] = value
    }
  }
  return env
}

/* ------------------------------------------------------------------ */
/* Sanitização de mensagens (sem segredos)                             */
/* ------------------------------------------------------------------ */

/* eslint-disable no-control-regex */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /sk-[A-Za-z0-9._-]{6,}/g,
  /ghp_[A-Za-z0-9]{10,}/g,
  /github_pat_[A-Za-z0-9_]{10,}/g,
  /xox[baprs]-[A-Za-z0-9-]{6,}/g,
  /Bearer\s+[A-Za-z0-9._-]{6,}/gi,
  /(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi,
  /[A-Z]:\\[^\s"')]+/gi,
  /(^|[\s'"(=])\/(?:[^/\s'")]+\/)*[^/\s'")]+/gm,
  /[\u0000-\u001f\u007f]+/g,
]
/* eslint-enable no-control-regex */

/** Remove segredos/controles e limita o tamanho de mensagens exibíveis. */
export function sanitizeAiUsagebarMessage(
  value: unknown,
  maxChars = AI_USAGEBAR_ERROR_MAX_CHARS
): string {
  const raw = typeof value === 'string' ? value : String(value ?? '')
  let text = raw
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '[redacted]')
  }
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

/* ------------------------------------------------------------------ */
/* Edição mínima do config.toml (disable local, sem CLI de disable)    */
/* ------------------------------------------------------------------ */

/** Nome de seção TOML sem quoting/dotted keys: único formato com toggle. */
const AI_USAGEBAR_BARE_SECTION_PATTERN = /^[A-Za-z0-9_-]+$/

function sectionHeaderPattern(section: string): RegExp {
  return new RegExp(`^\\s*\\[\\s*${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]\\s*(?:#.*)?$`)
}

/**
 * Liga/desliga `enabled` na seção do vendor preservando TODO o restante do
 * arquivo (linhas, comentários e outros campos). Não cria o arquivo.
 *
 * Só seções em bare key TOML (`[slug]`) são editáveis: ids especiais como
 * `custom:<id>` (array `[[custom]]`, fora do catálogo `vendors`) não têm
 * toggle upstream e retornam o conteúdo INTACTO em vez de criar `[custom:id]`.
 */
export function setVendorEnabledInConfig(
  content: string,
  section: string,
  enabled: boolean
): string {
  if (!AI_USAGEBAR_BARE_SECTION_PATTERN.test(section)) return content
  const header = sectionHeaderPattern(section)
  const lines = content.split(/\r?\n/)
  const enabledLine = `enabled = ${enabled ? 'true' : 'false'}`
  let headerIndex = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (header.test(lines[index])) {
      headerIndex = index
      break
    }
  }

  if (headerIndex === -1) {
    const suffix = content.endsWith('\n') || content.length === 0 ? '' : '\n'
    return `${content}${suffix}\n[${section}]\n${enabledLine}\n`
  }

  let end = lines.length
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      end = index
      break
    }
  }
  for (let index = headerIndex + 1; index < end; index += 1) {
    if (/^\s*enabled\s*=/.test(lines[index])) {
      const replaced = [...lines]
      replaced[index] = enabledLine
      return replaced.join('\n')
    }
  }
  const inserted = [...lines]
  inserted.splice(headerIndex + 1, 0, enabledLine)
  return inserted.join('\n')
}

/** true quando o id tem forma aceitável (genérico; nenhum catálogo aqui). */
export function isSafeAiUsagebarVendorId(vendorId: string): boolean {
  return AI_USAGEBAR_VENDOR_ID_PATTERN.test(vendorId)
}
