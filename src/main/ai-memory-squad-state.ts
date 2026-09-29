/**
 * Módulo NEUTRO compartilhado entre `ai-memory-sync` e `ai-memory-takeover`.
 *
 * Concentra os símbolos usados por ambos (client/escopo mínimos, extração de
 * resultados MCP, evidência recente do Bridge, tarefas do squad e paths do
 * snapshot `squads/<id>/state.md`) para QUEBRAR a dependência circular
 * `ai-memory-sync ⇄ ai-memory-takeover`: o sync importa daqui e do takeover
 * (one-way), e o takeover importa SOMENTE daqui — nunca mais do sync.
 * Nenhuma lógica própria: as definições são movidas 1:1 de `ai-memory-sync`.
 */

import { redactSecretText } from '../shared/evolution-history'
import {
  AI_MEMORY_MCP_TOOLS,
} from '../shared/ai-memory-contract'

/** Client mínimo (subconjunto de AiMemoryClient). */
export interface SyncMemoryClient {
  callTool(
    name: typeof AI_MEMORY_MCP_TOOLS[keyof typeof AI_MEMORY_MCP_TOOLS],
    args: Record<string, unknown>
  ): Promise<{ text: string; json?: unknown; isError: boolean }>
}

export interface SyncScope {
  workspace: string
  project: string
}

interface SyncToolResultLike {
  text: string
  json?: unknown
  isError: boolean
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Sanitização/redação de texto compartilhada com o sync (não é API pública). */
export function sanitizeText(value: string, maxChars: number): string {
  let sanitized = ''
  for (const character of value) {
    const code = character.charCodeAt(0)
    sanitized += code <= 0x1f || code === 0x7f ? ' ' : character
  }
  return redactSecretText(sanitized.trim().slice(0, maxChars))
}

/**
 * `memory_read_page` devolve `{ path, body }` em JSON.
 * Se houver OBJETO json: usa `body` quando string; caso contrário `''` — o
 * `text` é o JSON serializado e NUNCA deve virar corpo de estado/tarefas.
 * Fallback para `text` só quando não há objeto json.
 */
export function extractAiMemoryPageBody(result: SyncToolResultLike): string {
  if (result.isError) return ''
  if (result.json !== null && typeof result.json === 'object') {
    const body = asRecord(result.json)?.body
    return typeof body === 'string' ? body : ''
  }
  return result.text || ''
}

/** JSON pretty bounded para shapes estruturados sem campo de texto conhecido. */
function renderBoundedJson(value: unknown, maxChars: number): string {
  try {
    const rendered = JSON.stringify(value, null, 2)
    return typeof rendered === 'string' ? rendered.slice(0, maxChars) : ''
  } catch {
    return ''
  }
}

/**
 * `memory_briefing` v2.4.0 é estruturado (ex.: `{ recent, recent_pages_limit }`).
 * Campos de texto conhecidos vêm primeiro; qualquer outro objeto renderiza JSON
 * pretty bounded — NUNCA cai para o text serializado cru quando há json.
 */
export function extractAiMemoryBriefingText(result: SyncToolResultLike, maxChars = 4_000): string {
  if (result.isError) return ''
  const record = asRecord(result.json)
  if (record) {
    for (const key of ['briefing', 'summary', 'text', 'content']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value.slice(0, maxChars)
    }
    return renderBoundedJson(record, maxChars)
  }
  if (Array.isArray(result.json)) return renderBoundedJson(result.json, maxChars)
  return (result.text || '').slice(0, maxChars)
}

/**
 * `memory_handoff_list` devolve `{ handoffs: [...] }`. Lista vazia renderiza
 * mensagem explícita; itens sem summary caem em JSON bounded — nunca no text
 * serializado cru. Fallback para text só quando não há json utilizável.
 */
export function extractAiMemoryHandoffsText(result: SyncToolResultLike, maxChars = 4_000): string {
  if (result.isError) return ''
  const handoffs = asRecord(result.json)?.handoffs
  if (Array.isArray(handoffs)) {
    if (handoffs.length === 0) return '(nenhum handoff aberto)'
    const lines = handoffs
      .slice(0, 50)
      .map((item) => {
        const record = asRecord(item) ?? {}
        const agent =
          typeof record.agent === 'string'
            ? record.agent
            : typeof record.provider === 'string'
              ? record.provider
              : 'handoff'
        const status = typeof record.status === 'string' && record.status ? `[${record.status}] ` : ''
        const summary =
          typeof record.summary === 'string'
            ? record.summary
            : typeof record.description === 'string'
              ? record.description
              : ''
        const id = typeof record.id === 'string' && record.id ? ` (${record.id})` : ''
        return summary ? `- ${status}${agent}: ${sanitizeText(summary, 300)}${id}` : ''
      })
      .filter(Boolean)
    if (lines.length > 0) return lines.join('\n').slice(0, maxChars)
    return renderBoundedJson({ handoffs }, maxChars)
  }
  if (Array.isArray(result.json)) return renderBoundedJson(result.json, maxChars)
  return (result.text || '').slice(0, maxChars)
}

/** Limites da coleta de evidência recente do Bridge. */
export interface BridgeOutcomeHistoryLimits {
  /** Limite do `memory_recent` (default 20). */
  recentLimit?: number
  /** Máximo de páginas lidas (default 4). */
  maxPages?: number
  /** Máximo de caracteres somados dos bodies (default 4_000). */
  maxChars?: number
}

export interface BridgeOutcomeHistoryEntry {
  path: string
  body: string
}

const BRIDGE_RECENT_LIMIT_DEFAULT = 20
const BRIDGE_HISTORY_MAX_PAGES_DEFAULT = 4
const BRIDGE_HISTORY_MAX_CHARS_DEFAULT = 4_000
const BRIDGE_OUTCOME_PATH_PATTERN = /^sessions\/bridge-[a-z0-9._-]+\.md$/
const BRIDGE_PAGE_TAG = 'devorbit-bridge'

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function isBridgeRecentEntry(entry: { path?: string; tags?: string[] }): boolean {
  if (entry.path && BRIDGE_OUTCOME_PATH_PATTERN.test(entry.path)) return true
  return entry.tags?.some((tag) => tag.toLowerCase() === BRIDGE_PAGE_TAG) ?? false
}

function parseRecentEntries(result: SyncToolResultLike): Array<{ path?: string; tags?: string[] }> | undefined {
  const record = asRecord(result.json)
  const pages = record?.pages
  if (!Array.isArray(pages)) return undefined
  const entries: Array<{ path?: string; tags?: string[] }> = []
  for (const page of pages) {
    if (typeof page === 'string') {
      entries.push({ path: page })
      continue
    }
    const item = asRecord(page)
    if (!item) continue
    const entry: { path?: string; tags?: string[] } = {}
    if (typeof item.path === 'string') entry.path = item.path
    if (Array.isArray(item.tags)) {
      entry.tags = item.tags.filter((tag): tag is string => typeof tag === 'string')
    }
    entries.push(entry)
  }
  return entries
}

/**
 * Evidência RECENTE do Bridge no escopo do projeto, para takeover/resync.
 *
 * Não afirma associação exata de squad (as páginas têm taskId/target/status/
 * summary, sem squadId): usa `memory_recent` com limite bounded e seleciona
 * páginas `sessions/bridge-*.md` (ou com tag `devorbit-bridge`), lendo um
 * número pequeno de bodies via `memory_read_page`. Qualquer shape/erro
 * inesperado é fail-open (`[]`).
 */
export async function collectRecentBridgeOutcomeHistory(
  client: SyncMemoryClient,
  scope: SyncScope,
  limits: BridgeOutcomeHistoryLimits = {}
): Promise<BridgeOutcomeHistoryEntry[]> {
  const recentLimit = clampInt(limits.recentLimit, BRIDGE_RECENT_LIMIT_DEFAULT, 1, 50)
  const maxPages = clampInt(limits.maxPages, BRIDGE_HISTORY_MAX_PAGES_DEFAULT, 1, 10)
  const maxChars = clampInt(limits.maxChars, BRIDGE_HISTORY_MAX_CHARS_DEFAULT, 200, 20_000)
  const entries: BridgeOutcomeHistoryEntry[] = []
  const seen = new Set<string>()
  try {
    const recent = await client.callTool(AI_MEMORY_MCP_TOOLS.recent, {
      workspace: scope.workspace,
      project: scope.project,
      limit: recentLimit,
    })
    if (recent.isError) return []
    const candidates = parseRecentEntries(recent)
    if (candidates === undefined) return []
    let used = 0
    for (const candidate of candidates) {
      if (entries.length >= maxPages || used >= maxChars) break
      if (!candidate.path || seen.has(candidate.path)) continue
      if (!isBridgeRecentEntry(candidate)) continue
      seen.add(candidate.path)
      try {
        const page = await client.callTool(AI_MEMORY_MCP_TOOLS.readPage, {
          workspace: scope.workspace,
          project: scope.project,
          path: candidate.path,
        })
        const body = extractAiMemoryPageBody(page)
        if (!body) continue
        const bounded = body.slice(0, maxChars - used)
        if (!bounded) break
        used += bounded.length
        entries.push({ path: candidate.path, body: bounded })
      } catch {
        // Página individual indisponível: segue para a próxima.
      }
    }
  } catch {
    // Fail-open: sem evidência recente.
  }
  return entries
}

/**
 * Tarefa consolidada do squad. `requestId` só entra aqui por ASSOCIAÇÃO
 * EXPLÍCITA (UI/Canvas/Shell #2) — nunca inferida do tráfego do Bridge.
 */
export interface SquadTask {
  id: string
  title: string
  status: 'done' | 'in-progress' | 'pending' | 'blocked'
  memberId?: string
  requestId?: string
  /** Descrição/responsabilidade fornecida pelo snapshot — JAMAIS prompt bruto. */
  description?: string
}

function squadSlug(squadId: string): string {
  return (
    squadId
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'squad'
  )
}

/** Path CANÔNICO do snapshot do squad (única superfície de escrita). */
export function squadStatePagePath(squadId: string): string {
  return `squads/${squadSlug(squadId)}/state.md`
}

/**
 * Path LEGADO (v1.0.43, sem extensão) — somente LEITURA no takeover/resync,
 * como fallback quando o canônico `state.md` ainda não existe/é inutilizável.
 * Nunca é escrito nem apagado por este módulo.
 */
export function legacySquadStatePagePath(squadId: string): string {
  return `squads/${squadSlug(squadId)}/state`
}
