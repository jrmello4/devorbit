import type {
  UsageAdapterStatus,
  UsageModelShare,
  UsageShareWindow,
} from '../../../shared/usage-contract'

/** Uma linha da tabela "Uso por modelo": participação de um modelo na janela. */
export interface UsageShareRow {
  provider: string
  model: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  turns: number
  /** Participação na janela, com um decimal (base: tokens; fallback: turnos). */
  percent: number
}

/**
 * Agrega os modelos de uma janela em linhas ordenadas pela métrica de base.
 *
 * Base da participação: tokens reais quando existem (window.totalTokens > 0);
 * sem tokens, participação por turnos (fallback da camada universal, que não
 * lê stores de tokens). Linhas ordenadas de forma decrescente pela métrica
 * usada como base. Linhas sem base de participação (agregado de sessão por
 * provider: model vazio, 0 tokens e 0 turnos) ficam de fora. Model vazio com
 * base de participação cai para o nome do provider. Percentual arredondado
 * para um decimal; com base zero, todas as linhas ficam com 0%.
 */
export function computeUsageRows(shareWindow: UsageShareWindow): UsageShareRow[] {
  const useTokenBasis = shareWindow.totalTokens > 0
  const basisOf = (model: UsageModelShare) => (useTokenBasis ? model.totalTokens : model.turns)
  const basisTotal = useTokenBasis ? shareWindow.totalTokens : shareWindow.totalTurns

  return [...shareWindow.models]
    // Linha só de sessão (agregado por provider, model vazio, sem tokens e sem
    // turnos) não tem base de participação — fica fora do ranking.
    .filter((model) => !(model.model === '' && model.totalTokens === 0 && model.turns === 0))
    .sort((a, b) => basisOf(b) - basisOf(a))
    .map((model) => ({
      provider: model.provider,
      model: model.model || model.provider,
      totalTokens: model.totalTokens,
      inputTokens: model.inputTokens,
      outputTokens: model.outputTokens,
      cacheTokens: model.cacheTokens,
      turns: model.turns,
      percent: basisTotal > 0 ? Math.round((basisOf(model) / basisTotal) * 1000) / 10 : 0,
    }))
}

const formatCompact = (value: number, suffix: string): string => {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded)
    ? `${rounded}${suffix}`
    : `${rounded.toFixed(1).replace('.', ',')}${suffix}`
}

/**
 * Contagem de tokens compacta e amigável para pt-BR:
 * `847`, `12,4k`, `3,1M` — separador decimal por vírgula, um decimal só
 * quando necessário. Valores não finitos ou negativos viram `0`.
 */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0'
  if (count < 1000) return String(Math.round(count))
  if (count < 1_000_000) {
    const thousands = Math.round(count / 100) / 10
    // Arredondou para 1000k? Promove para 1M em vez de exibir "1000k".
    return thousands >= 1000 ? '1M' : formatCompact(thousands, 'k')
  }
  return formatCompact(Math.round(count / 100_000) / 10, 'M')
}

/**
 * Contagem regressiva até a renovação de uma janela de quota, no formato
 * "renova em 2h 15min" / "renova em 40min". Retorna null quando o instante
 * está ausente, é inválido ou já passou (a renovação já está disponível).
 */
export function formatRelativeReset(resetAt: string | undefined, now: number): string | null {
  if (!resetAt) return null
  const resetTime = Date.parse(resetAt)
  if (Number.isNaN(resetTime)) return null
  const remainingMs = resetTime - now
  if (remainingMs <= 0) return null

  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `renova em ${minutes}min`
  return minutes > 0 ? `renova em ${hours}h ${minutes}min` : `renova em ${hours}h`
}

const adapterSourceLabels: Record<UsageAdapterStatus['source'], string> = {
  'claude-transcripts': 'Claude',
  'codex-rollouts': 'Codex',
  'opencode-storage': 'OpenCode',
  'gemini-local': 'Gemini',
  'llm-router': 'DevOrbit',
}

const summarizeAdapterGroup = (group: UsageAdapterStatus[]): string => {
  const errors = group.filter((adapter) => adapter.status === 'error').length
  if (errors > 0) return errors > 1 ? `${errors} erros` : 'erro'
  const ok = group.filter((adapter) => adapter.status === 'ok').length
  if (ok > 0) return ok > 1 ? `${ok} fontes ok` : 'ok'
  if (group.every((adapter) => adapter.status === 'missing')) return 'não instalado'
  return 'sem dados'
}

/**
 * Linha curta em pt-BR com o estado dos adaptadores de uso, agrupada por
 * fonte: "Claude: ok · Codex: sem dados · Gemini: não instalado". Várias
 * fontes ok do mesmo tipo viram "N fontes ok"; erro tem prioridade na
 * síntese. Sem adaptadores, retorna string vazia.
 */
export function summarizeAdapters(adapters: UsageAdapterStatus[]): string {
  const groups = new Map<string, UsageAdapterStatus[]>()
  for (const adapter of adapters) {
    const label = adapterSourceLabels[adapter.source]
    const group = groups.get(label)
    if (group) group.push(adapter)
    else groups.set(label, [adapter])
  }

  const parts: string[] = []
  for (const [label, group] of groups) {
    parts.push(`${label}: ${summarizeAdapterGroup(group)}`)
  }
  return parts.join(' · ')
}
