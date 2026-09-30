import { stripAnsiEscapes } from './ansi'

export const AGENT_RESULT_PREFIX = 'DEVORBIT_RESULT:'
export const AGENT_RESULT_VERSION = 1
/**
 * Teto do frame físico (uma linha PTY). Pior caso legítimo: os TRÊS campos
 * longos cheios (handoff + testsExecuted + remainingIssues = 3 × 200k) já
 * escapados para JSON (pior caso 2x, pois \n e \" viram dois caracteres) +
 * filesChanged (100 × 500) + summary — ≈ 1,3M. Frames acima disso são ruído,
 * não resultado. (Cap antigo de 512k rejeitava payload legítimo.)
 */
export const AGENT_RESULT_MAX_FRAME_CHARS = 1_600_000
export const AGENT_RESULT_MAX_SUMMARY_CHARS = 1_000
/**
 * Cap generoso de proteção para os textos longos do resultado estruturado
 * (handoff/testsExecuted/remainingIssues). NÃO é truncamento de negócio: o
 * handoff viaja íntegro até aqui; quem consome aplica o cap do próprio
 * destino (ex.: nó do canvas, 24k) priorizando o handoff.
 */
export const AGENT_RESULT_MAX_HANDOFF_CHARS = 200_000
/** Teto de itens de filesChanged (proteção contra payload descontrolado). */
export const AGENT_RESULT_MAX_FILES_CHANGED_ITEMS = 100
/** Teto por caminho em filesChanged (caminhos reais nunca chegam perto). */
export const AGENT_RESULT_MAX_FILE_PATH_CHARS = 500

export type AgentResultOutcome = 'completed' | 'blocked' | 'failed'

export interface AgentResult {
  format: 'json' | 'legacy'
  version: 1 | 0
  outcome: AgentResultOutcome
  summary: string
  /**
   * Contexto completo para o PRÓXIMO agente (decisões, estado, próximos
   * passos). Sem truncamento até o cap de proteção — o summary curto é só UI.
   */
  handoff?: string
  filesChanged?: string[]
  testsExecuted?: string
  remainingIssues?: string
}

export type AgentResultInvalidReason =
  | 'empty'
  | 'frame-too-large'
  | 'invalid-json'
  | 'invalid-schema'
  | 'invalid-summary'
  | 'invalid-version'

export type AgentResultParse =
  | { kind: 'result'; result: AgentResult }
  | { kind: 'invalid'; reason: AgentResultInvalidReason }
  | { kind: 'none' }

export type AgentResultScanEvent = AgentResultParse

const outcomes = new Set<AgentResultOutcome>(['completed', 'blocked', 'failed'])
const legacyPrefixes: Array<{ prefix: string; outcome: AgentResultOutcome }> = [
  { prefix: 'CONCLUIDO:', outcome: 'completed' },
  { prefix: 'COMPLETED:', outcome: 'completed' },
  { prefix: 'BLOQUEADO:', outcome: 'blocked' },
  { prefix: 'BLOCKED:', outcome: 'blocked' },
  { prefix: 'FALHA:', outcome: 'failed' },
  { prefix: 'FAILURE:', outcome: 'failed' },
  { prefix: 'ERRO:', outcome: 'failed' },
  { prefix: 'ERROR:', outcome: 'failed' },
]

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function parseSummary(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  if (value.length > AGENT_RESULT_MAX_SUMMARY_CHARS || hasControlCharacters(value)) return undefined
  return value.trim()
}

class AgentResultSchemaError extends Error {}

const jsonAllowedKeys = new Set([
  'version',
  'outcome',
  'summary',
  'handoff',
  'filesChanged',
  'testsExecuted',
  'remainingIssues',
])

/**
 * Campo de texto longo opcional (handoff/testsExecuted/remainingIssues).
 * Diferente do summary (1 linha de UI), aceita caracteres de controle vindos
 * de escapes JSON válidos (\n, \t) — o frame físico continua sendo 1 linha,
 * e um controle cru dentro da string quebraria o JSON.parse de qualquer forma.
 * Ausente/vazio → undefined; tipo errado → schema inválido.
 */
function parseOptionalLongText(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new AgentResultSchemaError()
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, AGENT_RESULT_MAX_HANDOFF_CHARS)
}

function parseFilesChanged(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new AgentResultSchemaError()
  const items = value
    .map((item) => {
      if (typeof item !== 'string') throw new AgentResultSchemaError()
      return item.trim()
    })
    .filter(Boolean)
    .map((item) => item.slice(0, AGENT_RESULT_MAX_FILE_PATH_CHARS))
  if (!items.length) return undefined
  return items.slice(0, AGENT_RESULT_MAX_FILES_CHANGED_ITEMS)
}

function parseJsonBody(body: string): AgentResultParse {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return { kind: 'invalid', reason: 'invalid-json' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'invalid', reason: 'invalid-schema' }
  }
  const record = value as Record<string, unknown>
  if (record.version !== AGENT_RESULT_VERSION) {
    return { kind: 'invalid', reason: 'invalid-version' }
  }
  // Allowlist estendida: campos estruturados do handoff entre agentes são
  // OPCIONAIS — payloads antigos (só version/outcome/summary) continuam
  // parseando (tolerância retroativa dentro da mesma versão do schema).
  if (Object.keys(record).some((key) => !jsonAllowedKeys.has(key))) {
    return { kind: 'invalid', reason: 'invalid-schema' }
  }
  if (typeof record.outcome !== 'string' || !outcomes.has(record.outcome as AgentResultOutcome)) {
    return { kind: 'invalid', reason: 'invalid-schema' }
  }
  const summary = parseSummary(record.summary)
  if (!summary) return { kind: 'invalid', reason: 'invalid-summary' }
  let handoff: string | undefined
  let filesChanged: string[] | undefined
  let testsExecuted: string | undefined
  let remainingIssues: string | undefined
  try {
    handoff = parseOptionalLongText(record.handoff)
    filesChanged = parseFilesChanged(record.filesChanged)
    testsExecuted = parseOptionalLongText(record.testsExecuted)
    remainingIssues = parseOptionalLongText(record.remainingIssues)
  } catch (error) {
    if (error instanceof AgentResultSchemaError) return { kind: 'invalid', reason: 'invalid-schema' }
    throw error
  }
  const result: AgentResult = {
    format: 'json',
    version: AGENT_RESULT_VERSION,
    outcome: record.outcome as AgentResultOutcome,
    summary,
  }
  if (handoff !== undefined) result.handoff = handoff
  if (filesChanged !== undefined) result.filesChanged = filesChanged
  if (testsExecuted !== undefined) result.testsExecuted = testsExecuted
  if (remainingIssues !== undefined) result.remainingIssues = remainingIssues
  return { kind: 'result', result }
}

function parseLegacyBody(body: string): AgentResultParse {
  const normalized = body.trim()
  if (!normalized) return { kind: 'invalid', reason: 'empty' }
  const upper = normalized.toLocaleUpperCase()
  const prefix = legacyPrefixes.find((item) => upper.startsWith(item.prefix))
  const summary = normalized.slice(0, AGENT_RESULT_MAX_SUMMARY_CHARS)
  if (!summary) return { kind: 'invalid', reason: 'invalid-summary' }
  return {
    kind: 'result',
    result: { format: 'legacy', version: 0, outcome: prefix?.outcome ?? 'completed', summary },
  }
}

/**
 * Parses one complete physical DEVORBIT_RESULT line. A saída de PTY chega
 * colorida: a limpeza ECMA-48 (src/shared/ansi.ts) roda antes do parse e antes
 * do limite de frame — decoração não pode invalidar um frame legítimo. Linhas
 * longas sem marcador continuam sendo ruído (`none`), nunca resultado inválido.
 */
export function parseAgentResultLine(line: string): AgentResultParse {
  const candidate = stripAnsiEscapes(line).trimStart()
  if (!candidate.startsWith(AGENT_RESULT_PREFIX)) return { kind: 'none' }
  if (candidate.length > AGENT_RESULT_MAX_FRAME_CHARS) return { kind: 'invalid', reason: 'frame-too-large' }
  const body = candidate.slice(AGENT_RESULT_PREFIX.length).trim()
  if (!body) return { kind: 'invalid', reason: 'empty' }
  if (body.startsWith('{') || body.startsWith('[')) return parseJsonBody(body)
  return parseLegacyBody(body)
}

export function createLegacyAgentResult(outcome: AgentResultOutcome, summary: string): AgentResult {
  const normalized = summary.trim().slice(0, AGENT_RESULT_MAX_SUMMARY_CHARS) || 'Resultado sem resumo.'
  return { format: 'legacy', version: 0, outcome, summary: normalized }
}

/**
 * Serializa o resultado estruturado no bloco de texto COMPLETO destinado ao
 * PRÓXIMO agente: summary + handoff + arquivos alterados + testes + pendências.
 * `cap` é o limite do DESTINO (ex.: conteúdo do nó do canvas). Quando o bloco
 * estoura, o handoff tem prioridade: campos secundários são descartados antes
 * de qualquer corte no handoff. Resultado legado (só summary) sai idêntico.
 */
export function composeAgentResultContent(result: AgentResult, cap: number): string {
  const summary = result.summary?.trim() ?? ''
  const parts: string[] = summary ? [summary] : []
  const secondary: string[] = []
  if (result.handoff?.trim()) parts.push(`## Handoff para o próximo agente\n${result.handoff.trim()}`)
  if (result.filesChanged?.length) {
    secondary.push(
      `## Arquivos alterados\n${result.filesChanged.map((file) => `- ${file}`).join('\n')}`,
    )
  }
  if (result.testsExecuted?.trim()) secondary.push(`## Testes executados\n${result.testsExecuted.trim()}`)
  if (result.remainingIssues?.trim()) secondary.push(`## Pendências\n${result.remainingIssues.trim()}`)
  const base = parts.join('\n\n')
  const full = [base, ...secondary].filter(Boolean).join('\n\n')
  if (full.length <= cap) return full
  let content = base
  for (const section of secondary) {
    const candidate = content ? `${content}\n\n${section}` : section
    if (candidate.length > cap) break
    content = candidate
  }
  return content.slice(0, cap)
}

export interface AgentResultScanner {
  push: (chunk: string) => AgentResultScanEvent[]
  finish: () => AgentResultScanEvent[]
  reset: () => void
}

/** Incremental parser shared by PTY consumers. JSON must precede its mirror. */
export function createAgentResultScanner(): AgentResultScanner {
  let buffer = ''
  let resolved = false
  let invalidReason: AgentResultInvalidReason | undefined
  let invalidEmitted = false

  const reset = () => {
    buffer = ''
    resolved = false
    invalidReason = undefined
    invalidEmitted = false
  }

  const consumeLine = (line: string): AgentResultScanEvent[] => {
    if (resolved) return []
    const parsed = parseAgentResultLine(line)
    if (parsed.kind === 'none') return []
    if (parsed.kind === 'invalid') {
      invalidReason = invalidReason || parsed.reason
      if (invalidEmitted) return []
      invalidEmitted = true
      return [parsed]
    }
    resolved = true
    return [parsed]
  }

  const push = (chunk: string): AgentResultScanEvent[] => {
    if (resolved || !chunk) return []
    buffer += chunk
    if (buffer.length > AGENT_RESULT_MAX_FRAME_CHARS * 2) buffer = buffer.slice(-AGENT_RESULT_MAX_FRAME_CHARS * 2)
    const lines = buffer.split(/\r\n|\n|\r/)
    buffer = lines.pop() || ''
    const events = lines.flatMap(consumeLine)
    if (events.length || resolved || !buffer) return events

    // Alguns CLIs desenham o frame no PTY sem emitir newline. O JSON é o
    // primeiro e autoritativo frame do contrato; quando ele já fecha, pode
    // ser entregue imediatamente sem exigir Enter ou o encerramento do PTY.
    const candidate = stripAnsiEscapes(buffer).trimStart()
    const body = candidate.startsWith(AGENT_RESULT_PREFIX)
      ? candidate.slice(AGENT_RESULT_PREFIX.length).trim()
      : ''
    if (body.startsWith('{') && body.endsWith('}')) {
      const parsed = parseAgentResultLine(buffer)
      if (parsed.kind === 'result') {
        resolved = true
        buffer = ''
        return [parsed]
      }
    }
    return events
  }

  const finish = (): AgentResultScanEvent[] => {
    if (resolved) return []
    const events = buffer ? consumeLine(buffer) : []
    buffer = ''
    if (events.length) return events
    if (invalidReason && !invalidEmitted) {
      invalidEmitted = true
      return [{ kind: 'invalid', reason: invalidReason }]
    }
    return []
  }

  return { push, finish, reset }
}
