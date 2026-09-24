import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { choice, TypeSafeClient } from '@typesafe-ai/sdk'
import type { Fetch } from '@typesafe-ai/sdk'
import { stripAnsiEscapes } from '../shared/ansi'
import type { AgentProvider, AgentProviderId, AppConfig } from '../renderer/src/types'
import { AGENT_PROVIDER_ID_LIST } from '../shared/agent-provider-contract'

const execFileAsync = promisify(execFile)

const MAX_COMMAND_LENGTH = 4096
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.bat', '.cmd', '.com', '.exe'])

export const AGENT_CLI_AUTH_MESSAGE = 'A autenticação é gerenciada pelo próprio CLI.'

export interface AgentCliDefinition {
  id: AgentProviderId
  label: string
  aliases: readonly string[]
  defaultCommand: string
}

export type AgentCliResolution = Pick<
  AgentProvider,
  'id' | 'label' | 'state' | 'path' | 'message'
>

export type AgentCliConfiguredCommands = Partial<
  Record<AgentProviderId, string | undefined>
>

export const AGENT_CLI_PROVIDER_IDS = AGENT_PROVIDER_ID_LIST

export const AGENT_CLI_PROVIDERS = {
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    aliases: ['codex', 'codex.cmd', 'codex.exe'],
    defaultCommand: 'codex.cmd',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    aliases: ['opencode', 'opencode.cmd', 'opencode.exe'],
    defaultCommand: 'opencode.cmd',
  },
  opencode2: {
    id: 'opencode2',
    label: 'OpenCode 2',
    aliases: ['opencode2', 'opencode2.cmd', 'opencode2.exe'],
    defaultCommand: 'opencode2.cmd',
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    aliases: [
      'claude',
      'claude.cmd',
      'claude.exe',
      'claude-code',
      'claude-code.cmd',
      'claude-code.exe',
    ],
    defaultCommand: 'claude.cmd',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    aliases: ['gemini', 'gemini.cmd', 'gemini.exe'],
    defaultCommand: 'gemini.cmd',
  },
  aider: {
    id: 'aider',
    label: 'Aider',
    aliases: ['aider', 'aider.cmd', 'aider.exe'],
    defaultCommand: 'aider.cmd',
  },
  agy: {
    id: 'agy',
    label: 'Antigravity',
    aliases: [
      'agy',
      'agy.cmd',
      'agy.exe',
      'antigravity',
      'antigravity.cmd',
      'antigravity.exe',
    ],
    defaultCommand: 'agy.cmd',
  },
  'command-code': {
    id: 'command-code',
    label: 'Command Code',
    aliases: ['command-code', 'command-code.cmd', 'command-code.exe', 'cmdc', 'cmdc.cmd', 'cmdc.exe'],
    defaultCommand: 'cmdc.cmd',
  },
  custom: {
    id: 'custom',
    label: 'Outro CLI',
    aliases: [],
    defaultCommand: '',
  },
} as const satisfies Record<AgentProviderId, AgentCliDefinition>

export const AGENT_PROVIDER_IDS = AGENT_CLI_PROVIDER_IDS
export const AGENT_PROVIDERS = AGENT_CLI_PROVIDERS

/**
 * Roteador de modelos por turno (FASE 3, padrão Elyra/BYOK).
 *
 * Tarefas mecânicas (grep, leitura de arquivos, compilação, resumos simples)
 * vão para modelos ultraleves e econômicos; refatoração complexa, arquitetura
 * e revisão vão para modelos de raciocínio profundo. O roteamento é por turno:
 * cada prompt é classificado de forma independente e determinística.
 */
export type TaskComplexity = 'mechanical' | 'deep'

export type ModelTier = 'fast' | 'deep'

export interface ModelTierDefinition {
  tier: ModelTier
  label: string
  models: readonly string[]
}

export const MODEL_TIERS = {
  fast: {
    tier: 'fast',
    label: 'Ultraleve e econômico',
    models: ['claude-haiku', 'gpt-4o-mini', 'ollama-local'],
  },
  deep: {
    tier: 'deep',
    label: 'Raciocínio profundo',
    models: ['gpt-6-astra', 'claude-sonnet'],
  },
} as const satisfies Record<ModelTier, ModelTierDefinition>

const MECHANICAL_PATTERNS = [
  /\bgrep\b/i,
  /leia?\s+(os?\s+|as?\s+)?arquivos?/i,
  /list(e|ar)?\s+.*arquivos?/i,
  /\bread\s+files?\b/i,
  /compil(ar|ação|e|ation|ing)/i,
  /\b(build|tsc|lint|testes?\s+rápidos?)\b/i,
  /resumo\s+simples/i,
  /\b(list(ar)?|show|print)\b.*\b(files?|arquivos?)\b/i,
  /^ *(ls|cat|dir|type|find|grep|rg)\b/im,
]

const DEEP_PATTERNS = [
  /refator/i,
  /refactor/i,
  /arquitet/i,
  /architect/i,
  /revis/i,
  /review/i,
  /design\s+(do\s+)?sistema/i,
  /migr/i,
  /otimiz/i,
  /segurança|vulnerabilidade/i,
]

export function classifyTaskComplexity(prompt: unknown): TaskComplexity {
  if (typeof prompt !== 'string' || !prompt.trim()) return 'mechanical'
  const text = prompt.trim()
  if (DEEP_PATTERNS.some((pattern) => pattern.test(text))) return 'deep'
  if (MECHANICAL_PATTERNS.some((pattern) => pattern.test(text))) return 'mechanical'
  // Prompt longo sem vocabulário mecânico explícito tende a exigir raciocínio.
  return text.length > 240 ? 'deep' : 'mechanical'
}

export interface ClassificationExplanation {
  complexity: TaskComplexity
  tier: ModelTier
  matchedMechanical: string[]
  matchedDeep: string[]
}

/** Explica a decisão do roteador (auditoria da escolha por turno). */
export function explainClassification(prompt: unknown): ClassificationExplanation {
  const text = typeof prompt === 'string' ? prompt.trim() : ''
  const matchedDeep = text ? DEEP_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source) : []
  const matchedMechanical = text && matchedDeep.length === 0
    ? MECHANICAL_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source)
    : []
  const complexity = classifyTaskComplexity(prompt)
  return {
    complexity,
    tier: complexity === 'deep' ? 'deep' : 'fast',
    matchedMechanical,
    matchedDeep,
  }
}

export function routeTaskToTier(prompt: unknown): ModelTier {
  return classifyTaskComplexity(prompt) === 'deep' ? 'deep' : 'fast'
}

export function tierModels(tier: ModelTier): readonly string[] {
  return MODEL_TIERS[tier].models
}

/**
 * Piloto TypeSafe em MODO SOMBRA (FASE 3).
 *
 * Classifica o prompt em `fast` | `deep` | `review` apenas para observação:
 * a decisão que o produto toma hoje (`classifyTaskComplexity` -> fast/deep)
 * permanece intacta. A fronteira é injetável (`ShadowJudge`) para testes com
 * cliente fake; a chave vive só no env do processo main (`TYPESAFE_API_KEY`)
 * e o piloto só liga com `DEVORBIT_TYPESAFE_SHADOW=1`.
 *
 * Garantias: nunca lança, timeout próprio, cache limitado por hash (o prompt
 * cru nunca é persistido), circuit breaker e fallback silencioso. Antes de
 * qualquer chamada externa o state passa por `redactPromptForJudgment`:
 * credenciais (chaves, bearer, senhas) e caminhos absolutos da máquina nunca
 * chegam ao SDK.
 */
export const SHADOW_TIERS = ['fast', 'deep', 'review'] as const
export type ShadowTier = (typeof SHADOW_TIERS)[number]

export const SHADOW_MAX_STATE_CHARS = 4_000
export const SHADOW_DEFAULT_TIMEOUT_MS = 2_500
export const SHADOW_CONFIDENCE_FLOOR = 0.6
export const SHADOW_PROBABILITY_TOLERANCE = 1e-3
export const SHADOW_CACHE_MAX_ENTRIES = 100
export const SHADOW_CACHE_TTL_MS = 10 * 60_000
export const SHADOW_BREAKER_FAILURE_THRESHOLD = 5
export const SHADOW_BREAKER_COOLDOWN_MS = 60_000
export const SHADOW_MAX_OBSERVATIONS = 200

export type ShadowOutcome =
  | 'ok'
  | 'skipped'
  | 'timeout'
  | 'invalid'
  | 'error'
  | 'circuit-open'

export interface ShadowJudgment {
  tier: ShadowTier
  confidence: number
  probabilities: Record<ShadowTier, number>
}

export interface ShadowClassification extends ShadowJudgment {
  confident: boolean
  cacheHit: boolean
  latencyMs: number
}

/** Registro de observação da sombra: nunca contém o prompt em texto. */
export interface ShadowObservation {
  at: number
  promptChars: number
  heuristicTier: ModelTier
  outcome: ShadowOutcome
  tier?: ShadowTier
  confidence?: number
  cacheHit: boolean
  latencyMs: number
}

/**
 * Fronteira injetável: recebe o state já sanitizado e sinaliza cancelamento.
 * Devolve a resposta crua do julgamento (validada antes do uso).
 */
export type ShadowJudge = (state: string, signal: AbortSignal) => Promise<unknown>

export interface ShadowDependencies {
  judge?: ShadowJudge
  timeoutMs?: number
  cacheTtlMs?: number
  cacheMaxEntries?: number
  breakerFailureThreshold?: number
  breakerCooldownMs?: number
  now?: () => number
}

const SHADOW_ENV_FLAG = 'DEVORBIT_TYPESAFE_SHADOW'

/** Variáveis do piloto que nunca podem ser herdadas por processos filhos. */
export const SHADOW_ENV_VARIABLES = ['TYPESAFE_API_KEY', SHADOW_ENV_FLAG] as const

interface ShadowEnvSnapshot {
  apiKey?: string
  enabled: boolean
}

function scrubShadowEnv(env: NodeJS.ProcessEnv): void {
  for (const name of SHADOW_ENV_VARIABLES) delete env[name]
}

function captureShadowEnv(env: NodeJS.ProcessEnv): ShadowEnvSnapshot {
  const snapshot: ShadowEnvSnapshot = {
    apiKey: env.TYPESAFE_API_KEY?.trim() || undefined,
    enabled: env[SHADOW_ENV_FLAG] === '1',
  }
  // Remove do ambiente imediatamente: a chave passa a viver só na memória
  // deste módulo (main), nunca no env herdado por PTYs/CLIs filhos.
  scrubShadowEnv(env)
  return snapshot
}

// Captura no load do main, antes de qualquer spawn de agente/terminal.
let shadowEnvSnapshot: ShadowEnvSnapshot = captureShadowEnv(process.env)

/** Somente testes: substitui o snapshot capturado do ambiente do main. */
export function setShadowEnvSnapshotForTests(snapshot: {
  apiKey?: string
  enabled?: boolean
}): void {
  shadowEnvSnapshot = {
    apiKey: typeof snapshot.apiKey === 'string' ? snapshot.apiKey.trim() || undefined : undefined,
    enabled: snapshot.enabled === true,
  }
}

const SHADOW_TIER_QUESTIONS = {
  tier: choice(
    'O pedido exige raciocínio de engenharia (arquitetura, mudança ampla, migração), é execução mecânica (localizar/ler/listar, rodar build/testes, ajuste local óbvio) ou é revisão/análise crítica de código ou design existente?',
    {
      fast: {
        what: 'Execução mecânica e local: buscar, ler, listar, rodar build/testes, resumo simples, ajuste óbvio',
        not_for: 'Decisões de design, mudanças multi-arquivo ou análise crítica',
        examples: ['grep por TODO em src', 'liste os arquivos do projeto', 'rode os testes rápidos'],
      },
      deep: {
        what: 'Mudança ampla com decisão de engenharia: arquitetura, refatoração multi-arquivo, migração, integração entre componentes',
        not_for: 'Comando único, consulta pontual ou edição trivial',
        examples: ['refatore a camada de cache', 'proponha a arquitetura do serviço de filas', 'migre o estado global'],
      },
      review: {
        what: 'Avaliação crítica do que já existe: revisão de PR/diff/design com julgamento de qualidade, riscos ou segurança',
        not_for: 'Escrever a mudança em si',
        examples: ['revise este PR com foco em segurança', 'analise os riscos deste diff'],
      },
    }
  ),
} as const

// Sanitização de saída de terminal exige casar códigos de controle.
/* eslint-disable no-control-regex */
const UNSAFE_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
/* eslint-enable no-control-regex */

/** Remove ANSI/controles, apara e limita o state do julgamento. */
export function sanitizePromptForJudgment(prompt: unknown): string | undefined {
  if (typeof prompt !== 'string') return undefined
  const cleaned = stripAnsiEscapes(prompt)
    .replace(UNSAFE_CONTROL_PATTERN, '')
    .trim()
  if (!cleaned) return undefined
  return cleaned.length > SHADOW_MAX_STATE_CHARS
    ? cleaned.slice(0, SHADOW_MAX_STATE_CHARS)
    : cleaned
}

export const SHADOW_REDACTED = '[segredo omitido]'
export const SHADOW_REDACTED_PATH = '[caminho local omitido]'

/**
 * Política explícita de redação do state antes de QUALQUER chamada ao
 * TypeSafe: reaproveita `redactSecrets` (sk-/api_key) e cobre bearer token,
 * campos de segredo nomeados (pt/en, com ou sem quotes) e caminhos absolutos
 * da máquina (Windows, UNC e diretórios pessoais POSIX). O prompt cru nunca é
 * enviado, cacheado nem registrado.
 */
const PROMPT_REDACTION_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${SHADOW_REDACTED}`],
  [
    /(\\?["']?\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token|password|passwd|pwd|senha)\b\\?["']?\s*[:=]\s*)(?:\\?"(?:\\.|[^"\\])*\\?"|\\?'(?:\\.|[^'\\])*\\?'|[^\s,;}]+)/gi,
    `$1${SHADOW_REDACTED}`,
  ],
  // Tokens crus reconhecíveis de provedores/CI.
  [/\bghp_[A-Za-z0-9]{20,}/g, SHADOW_REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, SHADOW_REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, SHADOW_REDACTED],
  [/\bnpm_[A-Za-z0-9]{20,}/g, SHADOW_REDACTED],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, SHADOW_REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, SHADOW_REDACTED],
  // Caminhos absolutos da máquina: Windows, UNC e qualquer POSIX absoluto
  // (conservador: `/tmp`, `/var`, `/workspace`, ...), fora de URLs e rotas
  // relativas — o `/` não pode vir colado a alfanumérico, `:`, `.`, `/` ou `<`.
  [/\\\\[^\s"'`<>|]+/g, SHADOW_REDACTED_PATH],
  [/\b[A-Za-z]:[\\/][^\s"'`<>|]+/g, SHADOW_REDACTED_PATH],
  [/(?<![A-Za-z0-9:/.<])\/[^\s"'`<>|]+/g, SHADOW_REDACTED_PATH],
]

export function redactPromptForJudgment(value: string): string {
  if (!value) return value
  let redacted = redactSecrets(value)
  for (const [pattern, replacement] of PROMPT_REDACTION_RULES) {
    redacted = redacted.replace(pattern, replacement)
  }
  return redacted
}

interface ShadowCacheEntry {
  judgment: ShadowJudgment
  expiresAt: number
}

const shadowCache = new Map<string, ShadowCacheEntry>()
const shadowObservations: ShadowObservation[] = []
let shadowConsecutiveFailures = 0
let shadowOpenUntil = 0
// undefined = ainda não resolvido; null = resolvido sem judge (piloto desligado).
let defaultShadowJudge: ShadowJudge | null | undefined

class ShadowTimeoutError extends Error {}

function resolveShadowJudge(): ShadowJudge | undefined {
  if (defaultShadowJudge === undefined) {
    defaultShadowJudge =
      shadowEnvSnapshot.apiKey && shadowEnvSnapshot.enabled
        ? buildTypeSafeShadowJudge(shadowEnvSnapshot.apiKey)
        : null
  }
  return defaultShadowJudge ?? undefined
}

export function isShadowRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // `process.env` foi limpo no load; o snapshot preserva a decisão do main.
  if (env === process.env) return shadowEnvSnapshot.enabled && Boolean(shadowEnvSnapshot.apiKey)
  return env[SHADOW_ENV_FLAG] === '1' && Boolean(env.TYPESAFE_API_KEY?.trim())
}

function buildTypeSafeShadowJudge(apiKey: string, fetchImpl?: Fetch): ShadowJudge {
  const client = new TypeSafeClient({
    apiKey,
    timeout: SHADOW_DEFAULT_TIMEOUT_MS,
    retry: { maxRetries: 0 },
    logLevel: 'warn',
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })

  return async (state, signal) => {
    const { answers } = await client.systemOne(
      { state: { prompt: state }, questions: SHADOW_TIER_QUESTIONS },
      { signal }
    )
    return answers.tier
  }
}

/**
 * Judge de produção: a chave é lida do ambiente do main e imediatamente
 * removida dele (o judge guarda a chave só na memória). `logLevel: 'warn'`
 * (o SDK não redige corpos em `debug`), sem retries e com timeout curto — a
 * sombra nunca pode competir com o turno real.
 */
export function createTypeSafeShadowJudge(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: Fetch
): ShadowJudge | undefined {
  const snapshot = env === process.env ? { ...shadowEnvSnapshot } : captureShadowEnv(env)
  if (!snapshot.apiKey || !snapshot.enabled) return undefined
  return buildTypeSafeShadowJudge(snapshot.apiKey, fetchImpl)
}

function parseShadowJudgment(raw: unknown): ShadowJudgment | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>

  // Contrato da primitiva: ChoiceAnswer com type explícito.
  if (record.type !== 'choice') return undefined

  const tier = record.choice
  if (typeof tier !== 'string' || !(SHADOW_TIERS as readonly string[]).includes(tier)) {
    return undefined
  }

  const confidence = record.confidence
  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return undefined
  }

  const rawProbabilities = record.probabilities
  if (typeof rawProbabilities !== 'object' || rawProbabilities === null) return undefined
  // Chaves exatas: distribuição com opção extra/desconhecida é payload inválido.
  const probabilityKeys = Object.keys(rawProbabilities)
  if (
    probabilityKeys.length !== SHADOW_TIERS.length ||
    probabilityKeys.some((key) => !(SHADOW_TIERS as readonly string[]).includes(key))
  ) {
    return undefined
  }
  const probabilities: Record<ShadowTier, number> = { fast: 0, deep: 0, review: 0 }
  for (const known of SHADOW_TIERS) {
    const value = (rawProbabilities as Record<string, unknown>)[known]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      return undefined
    }
    probabilities[known] = value
  }

  // Distribuição coerente: soma ~1 e a opção escolhida é o máximo.
  const sum = SHADOW_TIERS.reduce((total, known) => total + probabilities[known], 0)
  if (Math.abs(sum - 1) > SHADOW_PROBABILITY_TOLERANCE) return undefined
  const top = Math.max(...SHADOW_TIERS.map((known) => probabilities[known]))
  if (probabilities[tier as ShadowTier] + SHADOW_PROBABILITY_TOLERANCE < top) return undefined

  return { tier: tier as ShadowTier, confidence, probabilities }
}

export type ShadowObservationListener = (observation: Readonly<ShadowObservation>) => void

const shadowObservationListeners = new Set<ShadowObservationListener>()

function recordShadowObservation(observation: ShadowObservation): void {
  shadowObservations.push(observation)
  while (shadowObservations.length > SHADOW_MAX_OBSERVATIONS) shadowObservations.shift()
  for (const listener of shadowObservationListeners) {
    try {
      listener({ ...observation })
    } catch {
      // Um listener com defeito nunca pode derrubar a sombra.
    }
  }
}

function readShadowCache(key: string, now: number): ShadowJudgment | undefined {
  const entry = shadowCache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= now) {
    shadowCache.delete(key)
    return undefined
  }
  // Reinsere para manter ordem LRU de inserção no Map.
  shadowCache.delete(key)
  shadowCache.set(key, entry)
  return entry.judgment
}

function writeShadowCache(
  key: string,
  judgment: ShadowJudgment,
  now: number,
  ttlMs: number,
  maxEntries: number
): void {
  shadowCache.delete(key)
  shadowCache.set(key, { judgment, expiresAt: now + ttlMs })
  while (shadowCache.size > maxEntries) {
    const oldest = shadowCache.keys().next()
    if (oldest.done) break
    shadowCache.delete(oldest.value)
  }
}

function registerShadowSuccess(): void {
  shadowConsecutiveFailures = 0
  shadowOpenUntil = 0
}

function registerShadowFailure(now: number, threshold: number, cooldownMs: number): void {
  shadowConsecutiveFailures += 1
  if (shadowConsecutiveFailures >= threshold) shadowOpenUntil = now + cooldownMs
}

/**
 * Classificação sombra de um prompt. Retorna `undefined` em qualquer caminho
 * degradado (sem judge, timeout, resposta inválida, erro, circuito aberto) —
 * nunca lança e nunca altera o roteamento do produto.
 */
export async function classifyPromptShadow(
  prompt: unknown,
  deps: ShadowDependencies = {}
): Promise<ShadowClassification | undefined> {
  const now = deps.now ?? Date.now
  const heuristicTier: ModelTier = classifyTaskComplexity(prompt) === 'deep' ? 'deep' : 'fast'
  // Redação antes da fronteira externa: judge fake/SDK não veem credenciais
  // nem caminhos locais; cache indexa pelo hash do texto já redigido.
  const sanitizedState = sanitizePromptForJudgment(prompt)
  const state = sanitizedState ? redactPromptForJudgment(sanitizedState) : undefined

  const observe = (
    outcome: ShadowOutcome,
    extra: { judgment?: ShadowJudgment; cacheHit?: boolean; startedAt?: number } = {}
  ): ShadowClassification | undefined => {
    const at = now()
    recordShadowObservation({
      at,
      promptChars: state?.length ?? 0,
      heuristicTier,
      outcome,
      cacheHit: extra.cacheHit ?? false,
      latencyMs: extra.startedAt === undefined ? 0 : Math.max(0, at - extra.startedAt),
      ...(extra.judgment
        ? { tier: extra.judgment.tier, confidence: extra.judgment.confidence }
        : {}),
    })
    if (!extra.judgment) return undefined
    return {
      ...extra.judgment,
      confident: extra.judgment.confidence >= SHADOW_CONFIDENCE_FLOOR,
      cacheHit: extra.cacheHit ?? false,
      latencyMs: extra.startedAt === undefined ? 0 : Math.max(0, at - extra.startedAt),
    }
  }

  if (!state) return observe('skipped')

  const currentNow = now()
  if (shadowOpenUntil > currentNow) return observe('circuit-open')

  const judge = deps.judge ?? resolveShadowJudge()
  if (!judge) return observe('skipped')

  const cacheKey = createHash('sha256').update(state).digest('hex')
  const cached = readShadowCache(cacheKey, currentNow)
  if (cached) return observe('ok', { judgment: cached, cacheHit: true })

  const startedAt = now()
  const timeoutMs = Math.max(50, deps.timeoutMs ?? SHADOW_DEFAULT_TIMEOUT_MS)
  const threshold = deps.breakerFailureThreshold ?? SHADOW_BREAKER_FAILURE_THRESHOLD
  const cooldownMs = deps.breakerCooldownMs ?? SHADOW_BREAKER_COOLDOWN_MS

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new ShadowTimeoutError('Julgamento da sombra excedeu o timeout.'))
      }, timeoutMs)
      judge(state, controller.signal).then(resolve, reject)
    })

    const judgment = parseShadowJudgment(raw)
    if (!judgment) {
      registerShadowFailure(now(), threshold, cooldownMs)
      return observe('invalid', { startedAt })
    }

    registerShadowSuccess()
    writeShadowCache(
      cacheKey,
      judgment,
      startedAt,
      deps.cacheTtlMs ?? SHADOW_CACHE_TTL_MS,
      deps.cacheMaxEntries ?? SHADOW_CACHE_MAX_ENTRIES
    )
    return observe('ok', { judgment, startedAt })
  } catch (error) {
    registerShadowFailure(now(), threshold, cooldownMs)
    return observe(error instanceof ShadowTimeoutError ? 'timeout' : 'error', { startedAt })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
  }
}

/** Observações (sem prompt cru) para o piloto; janela limitada em memória. */
export function getShadowObservations(): readonly ShadowObservation[] {
  return [...shadowObservations]
}

/**
 * Assinatura mínima para um futuro consumidor local: recebe a observação
 * agregada já existente (tamanho do state, tier, confiança, outcome, latência)
 * — nunca prompt, state, hash, path, token ou resposta crua. Retorna a função
 * de remoção do listener.
 */
export function onShadowObservation(listener: ShadowObservationListener): () => void {
  shadowObservationListeners.add(listener)
  return () => {
    shadowObservationListeners.delete(listener)
  }
}

export function getShadowRoutingStats(): {
  cacheSize: number
  consecutiveFailures: number
  circuitOpenUntil: number
} {
  return {
    cacheSize: shadowCache.size,
    consecutiveFailures: shadowConsecutiveFailures,
    circuitOpenUntil: shadowOpenUntil,
  }
}

/** Zera cache, circuit breaker, observações e judge memoizado (testes). */
export function resetShadowRoutingState(): void {
  shadowCache.clear()
  shadowObservations.length = 0
  shadowConsecutiveFailures = 0
  shadowOpenUntil = 0
  defaultShadowJudge = undefined
}

/**
 * Seleção EXPLÍCITA: o provedor escolhido é o único elegível no turno.
 * Nunca troca automaticamente para outro provedor (em especial Codex).
 * Lista vazia = indisponível; a UI recebe erro estruturado com motivo.
 */
export function orderProvidersForTask(
  preferred: AgentProviderId,
  readyIds: readonly AgentProviderId[]
): AgentProviderId[] {
  return readyIds.includes(preferred) ? [preferred] : []
}

export type ProviderUnavailableCode = 'provider-not-ready' | 'provider-missing'

export interface ProviderUnavailableError {
  code: ProviderUnavailableCode
  provider: AgentProviderId
  message: string
}

/**
 * Erro estruturado (motivo) quando o provedor explícito não pode executar.
 * `undefined` = pronto. Nunca sugere nem substitui por outro provedor.
 */
export function providerUnavailableError(
  preferred: AgentProviderId,
  health: readonly { id: AgentProviderId; state: string }[]
): ProviderUnavailableError | undefined {
  const status = health.find((item) => item.id === preferred)
  if (status?.state === 'ready') return undefined
  const label = providerDefinition(preferred).label
  return {
    code: status ? 'provider-not-ready' : 'provider-missing',
    provider: preferred,
    message:
      `${label} não está disponível (${status ? 'CLI ausente ou não executável' : 'provedor não reconhecido'}). ` +
      'Nenhum outro provedor será usado automaticamente; ajuste o caminho em Configurações ou instale o CLI.',
  }
}

const CONFIGURED_COMMAND_KEYS: Record<
  AgentProviderId,
  keyof AppConfig['customPaths']
> = {
  codex: 'codex',
  opencode: 'opencode',
  opencode2: 'opencode2',
  claude: 'claude',
  gemini: 'gemini',
  aider: 'aider',
  agy: 'agy',
  'command-code': 'commandCode',
  custom: 'customAgent',
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 31 || code === 127) return true
  }
  return false
}

interface WindowsPathContext {
  home: string
  appData: string
  localAppData: string
  programFiles: string
  programFilesX86: string
  virtualEnv: string | undefined
}

function winJoin(...parts: string[]): string {
  return path.win32.join(...parts)
}

function isWindowsAbsolute(value: string): boolean {
  return path.win32.isAbsolute(value)
}

function getAbsoluteEnvironmentPath(
  name: string,
  fallback: string
): string {
  const value = process.env[name]?.trim()
  return value && isWindowsAbsolute(value) ? value : fallback
}

function getWindowsPathContext(): WindowsPathContext {
  const home = getAbsoluteEnvironmentPath('USERPROFILE', os.homedir())
  return {
    home,
    appData: getAbsoluteEnvironmentPath(
      'APPDATA',
      winJoin(home, 'AppData', 'Roaming')
    ),
    localAppData: getAbsoluteEnvironmentPath(
      'LOCALAPPDATA',
      winJoin(home, 'AppData', 'Local')
    ),
    programFiles: getAbsoluteEnvironmentPath(
      'ProgramFiles',
      winJoin('C:', 'Program Files')
    ),
    programFilesX86: getAbsoluteEnvironmentPath(
      'ProgramFiles(x86)',
      winJoin('C:', 'Program Files (x86)')
    ),
    virtualEnv: process.env.VIRTUAL_ENV?.trim() &&
      isWindowsAbsolute(process.env.VIRTUAL_ENV.trim())
      ? process.env.VIRTUAL_ENV.trim()
      : undefined,
  }
}

function isSupportedExecutable(file: string): boolean {
  const value = file.trim()
  if (!value || value.length > MAX_COMMAND_LENGTH || !isWindowsAbsolute(value)) {
    return false
  }
  if (hasControlCharacters(value)) return false
  return WINDOWS_EXECUTABLE_EXTENSIONS.has(path.win32.extname(value).toLowerCase())
}

function isSafeAlias(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)
}

function normalizeConfiguredCommand(command: string | undefined): string | null {
  if (typeof command !== 'string') return null

  let value = command.trim()
  if (!value || value.length > MAX_COMMAND_LENGTH) return null
  if (hasControlCharacters(value)) return null

  if (value.startsWith('"') || value.endsWith('"')) {
    if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) {
      return null
    }
    value = value.slice(1, -1).trim()
  }

  if (!value || value.includes('"')) return null
  if (isWindowsAbsolute(value)) return value
  if (!isSafeAlias(value)) return null
  return value
}

async function fileExists(file: string): Promise<boolean> {
  try {
    const stats = await fs.stat(file)
    return stats.isFile()
  } catch {
    return false
  }
}

async function findOnPath(alias: string): Promise<string | null> {
  if (process.platform !== 'win32' || !isSafeAlias(alias)) return null

  try {
    const { stdout } = await execFileAsync('where.exe', [alias], {
      shell: false,
      timeout: 5000,
      windowsHide: true,
    })
    const candidates = String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => isSupportedExecutable(line))

    for (const candidate of candidates) {
      if (await fileExists(candidate)) return candidate
    }
  } catch {
    // A missing alias is a normal result for an availability probe.
  }
  return null
}

function uniquePaths(candidates: string[]): string[] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = candidate.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function executableNames(provider: AgentCliDefinition): string[] {
  const names = provider.aliases.flatMap((alias) => {
    const extension = path.win32.extname(alias).toLowerCase()
    return WINDOWS_EXECUTABLE_EXTENSIONS.has(extension)
      ? [alias]
      : [alias + '.cmd', alias + '.bat', alias + '.exe']
  })
  return uniquePaths(names)
}

function addBinCandidates(
  candidates: string[],
  bin: string | undefined,
  provider: AgentCliDefinition
): void {
  if (!bin || !isWindowsAbsolute(bin)) return
  for (const name of executableNames(provider)) {
    candidates.push(winJoin(bin, name))
  }
}

function getKnownPathCandidates(
  provider: AgentCliDefinition,
  context: WindowsPathContext
): string[] {
  const candidates: string[] = []
  const scriptBins = [
    winJoin(context.appData, 'npm'),
    winJoin(context.localAppData, 'pnpm'),
    winJoin(context.localAppData, 'Yarn', 'bin'),
    winJoin(context.home, 'scoop', 'shims'),
  ]

  for (const bin of scriptBins) addBinCandidates(candidates, bin, provider)

  switch (provider.id) {
    case 'codex':
      candidates.push(
        winJoin(context.localAppData, 'OpenAI', 'Codex', 'bin', 'codex.exe'),
        winJoin(context.localAppData, 'OpenAI', 'Codex', 'codex.exe')
      )
      break
    case 'opencode':
      candidates.push(
        winJoin(context.home, '.opencode', 'bin', 'opencode.exe'),
        winJoin(context.localAppData, 'opencode', 'opencode.exe')
      )
      break
    case 'opencode2':
      candidates.push(
        winJoin(context.home, '.opencode', 'bin', 'opencode2.exe'),
        winJoin(context.localAppData, 'opencode', 'opencode2.exe')
      )
      break
    case 'claude':
      candidates.push(
        winJoin(context.home, '.local', 'bin', 'claude.exe'),
        winJoin(context.localAppData, 'Programs', 'Claude Code', 'claude.exe'),
        winJoin(context.localAppData, 'Programs', 'claude-code', 'claude.exe')
      )
      break
    case 'gemini':
      candidates.push(
        winJoin(context.home, '.local', 'bin', 'gemini.exe'),
        winJoin(context.home, '.gemini', 'bin', 'gemini.exe'),
        winJoin(context.localAppData, 'Programs', 'Gemini CLI', 'gemini.exe')
      )
      break
    case 'aider':
      candidates.push(
        winJoin(context.home, '.local', 'bin', 'aider.exe'),
        winJoin(context.home, 'pipx', 'bin', 'aider.exe'),
        winJoin(context.appData, 'Python', 'Scripts', 'aider.exe')
      )
      addBinCandidates(
        candidates,
        context.virtualEnv && winJoin(context.virtualEnv, 'Scripts'),
        provider
      )
      break
    case 'agy':
      candidates.push(
        winJoin(context.localAppData, 'agy', 'bin', 'agy.exe'),
        winJoin(context.localAppData, 'agy', 'agy.exe'),
        winJoin(
          context.localAppData,
          'Programs',
          'Antigravity',
          'antigravity.exe'
        ),
        winJoin(context.programFiles, 'Antigravity', 'antigravity.exe'),
        winJoin(context.programFiles, 'Antigravity', 'agy.exe'),
        winJoin(context.programFilesX86, 'Antigravity', 'antigravity.exe'),
        winJoin(context.programFilesX86, 'Antigravity', 'agy.exe')
      )
      break
    case 'command-code':
      candidates.push(
        winJoin(context.localAppData, 'command-code', 'bin', 'command-code.exe'),
        winJoin(context.localAppData, 'command-code', 'command-code.exe'),
        winJoin(context.localAppData, 'command-code', 'cmdc.exe'),
        winJoin(context.programFiles, 'Command Code', 'command-code.exe'),
        winJoin(context.programFilesX86, 'Command Code', 'command-code.exe')
      )
      break
    case 'custom':
      break
  }

  return uniquePaths(candidates)
}

async function findVersionedExecutable(
  root: string,
  executable: string
): Promise<string | null> {
  if (process.platform !== 'win32' || !isWindowsAbsolute(root)) return null

  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const candidate = winJoin(root, entry.name, executable)
          if (!isSupportedExecutable(candidate)) return null
          try {
            const stats = await fs.stat(candidate)
            return stats.isFile()
              ? { path: candidate, modifiedAt: stats.mtimeMs }
              : null
          } catch {
            return null
          }
        })
    )

    return candidates
      .filter(
        (candidate): candidate is { path: string; modifiedAt: number } =>
          candidate !== null
      )
      .sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.path || null
  } catch {
    return null
  }
}

async function resolveKnownPath(
  provider: AgentCliDefinition,
  context: WindowsPathContext
): Promise<string | null> {
  for (const candidate of getKnownPathCandidates(provider, context)) {
    if (await fileExists(candidate)) return candidate
  }

  if (provider.id === 'codex') {
    return findVersionedExecutable(
      winJoin(context.localAppData, 'OpenAI', 'Codex', 'bin'),
      'codex.exe'
    )
  }

  if (provider.id === 'aider') {
    const pythonRoots = [
      winJoin(context.appData, 'Python'),
      winJoin(context.localAppData, 'Programs', 'Python'),
    ]
    for (const root of pythonRoots) {
      try {
        const entries = await fs.readdir(root, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const candidate = winJoin(root, entry.name, 'Scripts', 'aider.exe')
          if (await fileExists(candidate)) return candidate
        }
      } catch {
        // Optional package-manager directories may not exist.
      }
    }
  }

  return null
}

function providerDefinition(provider: AgentProviderId): AgentCliDefinition {
  return AGENT_CLI_PROVIDERS[provider]
}

function configuredCommand(
  config: AppConfig,
  provider: AgentProviderId
): string | undefined {
  const key = CONFIGURED_COMMAND_KEYS[provider]
  return config.customPaths?.[key]
}

async function resolveProviderPath(
  provider: AgentCliDefinition,
  configured: string | undefined
): Promise<string | null> {
  if (process.platform !== 'win32') return null

  const command = normalizeConfiguredCommand(configured)
  if (command) {
    const resolved = isWindowsAbsolute(command)
      ? (await fileExists(command) ? command : null)
      : await findOnPath(command)
    if (resolved) return resolved
  }

  if (provider.id === 'custom') return null

  for (const alias of provider.aliases) {
    const resolved = await findOnPath(alias)
    if (resolved) return resolved
  }

  return resolveKnownPath(provider, getWindowsPathContext())
}

function resolutionMessage(
  provider: AgentCliDefinition,
  resolvedPath: string | null
): string {
  return resolvedPath
    ? provider.label +
      ' instalado em ' +
      resolvedPath +
      '. ' +
      AGENT_CLI_AUTH_MESSAGE
    : provider.label + ' ausente. ' + AGENT_CLI_AUTH_MESSAGE
}

function statusCommand(
  provider: AgentCliDefinition,
  configured: string | undefined
): string {
  return normalizeConfiguredCommand(configured) || provider.defaultCommand
}

export async function resolveAgentProviderCommand(
  config: AppConfig,
  provider: AgentProviderId
): Promise<{ path: string | null; message: string }> {
  const definition = providerDefinition(provider)
  const resolvedPath = await resolveProviderPath(
    definition,
    configuredCommand(config, provider)
  )
  return {
    path: resolvedPath,
    message: resolutionMessage(definition, resolvedPath),
  }
}

/**
 * BYOK (Bring Your Own Keys): chaves vêm do ambiente ou de `modelRouting` no
 * config. Chaves NUNCA aparecem em mensagens, logs ou retornos — só o modelo
 * escolhido e um booleano `authConfigured` saem deste módulo.
 */
export interface ModelRoutingConfig {
  fastModel?: string
  deepModel?: string
  openaiApiKey?: string
  anthropicApiKey?: string
  geminiApiKey?: string
}

const MAX_MODEL_NAME_LENGTH = 200
const MAX_API_KEY_LENGTH = 500

function cleanModelName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_MODEL_NAME_LENGTH || /[\s"']/.test(trimmed)) return undefined
  return trimmed
}

function cleanApiKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_API_KEY_LENGTH || /\s/.test(trimmed)) return undefined
  return trimmed
}

export function validateModelRoutingConfig(value: unknown): ModelRoutingConfig | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuração de modelos inválida.')
  const source = value as Record<string, unknown>
  const result: ModelRoutingConfig = {}
  const fastModel = cleanModelName(source.fastModel)
  const deepModel = cleanModelName(source.deepModel)
  const openaiApiKey = cleanApiKey(source.openaiApiKey)
  const anthropicApiKey = cleanApiKey(source.anthropicApiKey)
  const geminiApiKey = cleanApiKey(source.geminiApiKey)
  if (fastModel) result.fastModel = fastModel
  if (deepModel) result.deepModel = deepModel
  if (openaiApiKey) result.openaiApiKey = openaiApiKey
  if (anthropicApiKey) result.anthropicApiKey = anthropicApiKey
  if (geminiApiKey) result.geminiApiKey = geminiApiKey
  return Object.keys(result).length > 0 ? result : undefined
}

export interface ModelAuthStatus {
  model: string
  authConfigured: boolean
}

export function resolveModelForTier(
  tier: ModelTier,
  routing?: ModelRoutingConfig,
  env: NodeJS.ProcessEnv = process.env
): ModelAuthStatus {
  const configured = tier === 'fast' ? routing?.fastModel : routing?.deepModel
  const fallback = tier === 'fast' ? MODEL_TIERS.fast.models[1] : MODEL_TIERS.deep.models[1]
  const model = cleanModelName(configured) || fallback
  const key = cleanApiKey(routing?.openaiApiKey) || cleanApiKey(env.OPENAI_API_KEY)
    || cleanApiKey(routing?.anthropicApiKey) || cleanApiKey(env.ANTHROPIC_API_KEY)
    || cleanApiKey(routing?.geminiApiKey) || cleanApiKey(env.GEMINI_API_KEY)
  return { model, authConfigured: Boolean(key) }
}

/** Remove qualquer material de chave antes de expor objetos em IPC/logs. */
export function redactSecrets<T>(value: T): T {
  if (typeof value === 'string') {
    return value
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[chave omitida]')
      .replace(/(api[_-]?key["'\s:=]+)(["']?)[^"'\s,}]+(["']?)/gi, '$1[chave omitida]') as T
  }
  if (Array.isArray(value)) return value.map(redactSecrets) as T
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (/api[_-]?key|secret|token/i.test(key)) {
        output[key] = '[chave omitida]'
      } else {
        output[key] = redactSecrets(entry)
      }
    }
    return output as T
  }
  return value
}

/**
 * Só erros transitórios (rate limit, indisponibilidade, rede, pipe quebrado)
 * autorizam fallback para o próximo provedor. Erros permanentes (auth,
 * requisição inválida, binário ausente) falham direto sem mascarar a causa.
 */
const TRANSIENT_PATTERNS = [
  /rate[\s_-]?limit/i,
  /too many requests/i,
  /\b429\b/,
  /\b503\b/,
  /\b502\b/,
  /overloaded/i,
  /unavailable/i,
  /temporar/i,
  /timeout|timed out/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENETUNREACH/i,
  /socket hang up/i,
  /service degraded/i,
]

const PERMANENT_PATTERNS = [
  /invalid[\s_-]*api[\s_-]*key|incorrect api key|authentication/i,
  /permission denied|forbidden|\b401\b|\b403\b/i,
  /not found.*model|model.*not found/i,
]

/**
 * Binário ausente (ENOENT) = provedor indisponível: autoriza tentar o próximo
 * provedor da ordem (cada um no máximo uma vez — sem repetição).
 */
const UNAVAILABLE_BINARY_PATTERNS = [/ENOENT/i, /command not found/i, /not recognized as .*command/i]

export function isTransientProviderError(error: unknown): boolean {
  const rawText = error instanceof Error
    ? `${error.message} ${(error as NodeJS.ErrnoException).code || ''}`
    : String(error ?? '')
  const text = stripAnsiEscapes(rawText)
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(text))) return false
  if (UNAVAILABLE_BINARY_PATTERNS.some((pattern) => pattern.test(text))) return true
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * Extrai da cauda de saída a última linha com sinal transitório (rate limit,
 * 429, indisponibilidade). Retorna undefined para texto permanente ou limpo —
 * inclusive quando há padrão permanente junto (auth prevalece: sem retry).
 * A cor de terminal é removida antes da classificação e do retorno para que a
 * linha exibida na UI não carregue códigos de escape.
 */
export function findTransientSnippet(tail: unknown, maxLength = 300): string | undefined {
  if (typeof tail !== 'string' || !tail.trim()) return undefined
  const cleanedTail = stripAnsiEscapes(tail)
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(cleanedTail))) return undefined
  const lines = cleanedTail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(line))) {
      return line.slice(0, maxLength)
    }
  }
  return undefined
}

/** Prova de saúde real: executa `<cli> --version` com timeout (presença do binário não basta). */export async function probeProviderCommand(commandPath: string, timeoutMs = 8000): Promise<{ ok: boolean; detail: string }> {
  if (typeof commandPath !== 'string' || !commandPath.trim()) {
    return { ok: false, detail: 'Comando vazio.' }
  }
  try {
    const { stdout } = await execFileAsync(commandPath, ['--version'], {
      timeout: timeoutMs,
      windowsHide: true,
    })
    return { ok: true, detail: String(stdout || '').trim().slice(0, 200) || 'Respondeu a --version.' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, detail: message.slice(0, 200) }
  }
}

export interface AgentTurnResolution {
  tier: ModelTier
  model: string
  authConfigured: boolean
  provider: AgentProviderId
  /** Nunca há fallback automático: provedor explícito ou erro estruturado. */
  fellBack: false
  available: boolean
  error?: ProviderUnavailableError
  reason: string
  explanation: ClassificationExplanation
}

/**
 * Resolução por turno: recebe o prompt e o provedor EXPLÍCITO, seleciona
 * tier/modelo. Não executa nada — só decide. Quando o provedor não está
 * pronto, devolve `available: false` + `error` estruturado (a UI decide).
 * Chaves nunca saem daqui.
 */
export async function resolveAgentTurn(
  config: AppConfig,
  preferred: AgentProviderId,
  prompt: unknown,
  shadowDeps?: ShadowDependencies
): Promise<AgentTurnResolution> {
  const explanation = explainClassification(prompt)
  // SOMBRA (piloto TypeSafe): observa fast/deep/review sem alterar a decisão
  // do produto. Fire-and-forget — nunca bloqueia nem lança no caminho do turno.
  void classifyPromptShadow(prompt, shadowDeps).catch(() => undefined)
  const routing = config.modelRouting
  const { model, authConfigured } = resolveModelForTier(explanation.tier, routing)
  const health = await getAgentProviderHealth(config)
  const unavailable = providerUnavailableError(preferred, health)
  return {
    tier: explanation.tier,
    model,
    authConfigured,
    provider: preferred,
    fellBack: false,
    available: !unavailable,
    ...(unavailable ? { error: unavailable } : {}),
    reason: unavailable
      ? unavailable.message
      : `Turno ${explanation.tier} encaminhado para ${preferred}.`,
    explanation,
  }
}

export interface TurnAttempt {
  provider: AgentProviderId
  ok: boolean
  error?: string
}

export interface TurnExecution<T> {
  provider: AgentProviderId
  result: T
  attempts: TurnAttempt[]
}

/**
 * Executa o turno do provedor EXPLÍCITO. Não há tentativa de outro provedor:
 * uma falha (transitória ou permanente) retorna o erro com `attempts` para a
 * UI. `attempts` fica no erro para auditoria — nenhum segredo é incluído.
 */
export async function executeExplicitAgentTurn<T>(
  provider: AgentProviderId,
  execute: (provider: AgentProviderId) => Promise<T>
): Promise<TurnExecution<T>> {
  const attempts: TurnAttempt[] = []
  try {
    const result = await execute(provider)
    attempts.push({ provider, ok: true })
    return { provider, result, attempts }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    attempts.push({ provider, ok: false, error: redactSecrets(message).slice(0, 300) })
    throw Object.assign(
      new Error(`Turno falhou com ${provider}: ${redactSecrets(message).slice(0, 200)}`),
      { code: 'provider-failed', provider, attempts }
    )
  }
}

/**
 * Resolve APENAS o provedor explícito — nunca troca para outro CLI quando o
 * escolhido está ausente. `path: null` + mensagem acionável para a UI.
 */
export async function resolveAgentProviderWithFallback(
  config: AppConfig,
  preferred: AgentProviderId
): Promise<{
  path: string | null
  message: string
  provider: AgentProviderId
  fellBack: false
}> {
  const resolution = await resolveAgentProviderCommand(config, preferred)
  return { ...resolution, provider: preferred, fellBack: false }
}

/**
 * Cache de saúde dos providers para polling periódico (timer do index.ts).
 *
 * O probing de PATH é caro (`where.exe` por alias + ~40 fs.stat por provider)
 * e o resultado raramente muda: o timer só re-resolve um provider após o TTL
 * (120s para `ready`, 300s para `missing` — ausência é o caminho caro e o mais
 * estável). A chave inclui o comando configurado: trocar o path em
 * Configurações invalida a entrada naturalmente.
 *
 * OPT-IN por segurança: o default NÃO usa cache. Resolução por turno
 * (`resolveAgentTurn`) e launcher continuam frescos — turnos corretos primeiro.
 */
const AGENT_PROVIDER_HEALTH_READY_TTL_MS = 120_000
const AGENT_PROVIDER_HEALTH_MISSING_TTL_MS = 300_000

interface ProviderHealthCacheEntry {
  item: AgentProvider
  at: number
  /** providerId + comando configurado na hora da resolução. */
  key: string
}

const providerHealthCache = new Map<AgentProviderId, ProviderHealthCacheEntry>()

/** Limpa o cache de saúde (ex.: depois de mudar paths/config de providers). */
export function invalidateAgentProviderHealthCache(): void {
  providerHealthCache.clear()
}

export interface AgentProviderHealthOptions {
  /** Usa o cache por TTL (polling periódico); default é sempre fresco. */
  useCache?: boolean
}

export async function getAgentProviderHealth(
  config: AppConfig,
  options: AgentProviderHealthOptions = {}
): Promise<AgentProvider[]> {
  const useCache = options.useCache === true
  return Promise.all(
    AGENT_CLI_PROVIDER_IDS.map(async (providerId) => {
      const definition = providerDefinition(providerId)
      const configured = configuredCommand(config, providerId)
      const cacheKey = `${providerId}:${configured ?? ''}`
      const cached = providerHealthCache.get(providerId)
      if (useCache && cached && cached.key === cacheKey) {
        const ttl = cached.item.state === 'ready'
          ? AGENT_PROVIDER_HEALTH_READY_TTL_MS
          : AGENT_PROVIDER_HEALTH_MISSING_TTL_MS
        if (Date.now() - cached.at < ttl) return cached.item
      }
      const resolution = await resolveAgentProviderCommand(config, providerId)
      const item: AgentProvider = {
        id: providerId,
        label: definition.label,
        command: statusCommand(definition, configured),
        state: resolution.path ? 'ready' : 'missing',
        path: resolution.path || undefined,
        message: resolution.message,
      }
      providerHealthCache.set(providerId, { item, at: Date.now(), key: cacheKey })
      return item
    })
  )
}

/**
 * Monta o env do processo filho para o turno: modelo/tier sempre, chaves
 * BYOK por família somente quando presentes. Chaves nunca retornam ao renderer.
 *
 * Fronteira de segurança: as variáveis do piloto TypeSafe são removidas do
 * ambiente-base (inclusive `process.env`) — CLIs/PTYs nunca as herdam.
 */
export function buildAgentTurnEnv(
  provider: AgentProviderId | string,
  model: string,
  tier: ModelTier,
  routing?: ModelRoutingConfig,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  scrubShadowEnv(baseEnv)
  const env: NodeJS.ProcessEnv = {
    DEVORBIT_MODEL: model,
    DEVORBIT_MODEL_TIER: tier,
  }
  const pick = (configValue?: string, ...names: string[]): string | undefined => {
    if (configValue && configValue.trim()) return configValue.trim()
    for (const name of names) {
      const value = baseEnv[name]
      if (value && value.trim()) return value.trim()
    }
    return undefined
  }
  const openai = pick(routing?.openaiApiKey, 'OPENAI_API_KEY')
  const anthropic = pick(routing?.anthropicApiKey, 'ANTHROPIC_API_KEY')
  const gemini = pick(routing?.geminiApiKey, 'GEMINI_API_KEY')
  const assign = (name: string, value: string | undefined) => {
    if (value) env[name] = value
  }
  switch (provider) {
    case 'opencode':
    case 'opencode2':
    case 'claude':
      assign('ANTHROPIC_API_KEY', anthropic)
      break
    case 'codex':
    case 'command-code':
      assign('OPENAI_API_KEY', openai)
      break
    case 'gemini':
    case 'agy':
      assign('GEMINI_API_KEY', gemini)
      break
    case 'aider':
      assign('OPENAI_API_KEY', openai)
      assign('ANTHROPIC_API_KEY', anthropic)
      break
    case 'custom':
      break
  }
  return env
}

/**
 * Flag de modelo reconhecida por provedor para o spawn interativo.
 * `null` = sem flag documentada: o modelo vai só via env (DEVORBIT_MODEL).
 * Contrato do CLI custom: ler `DEVORBIT_MODEL` / `DEVORBIT_MODEL_TIER` do
 * ambiente; chaves BYOK chegam nas vars padrão da família (ex.
 * ANTHROPIC_API_KEY) — nunca em argv, log ou retorno IPC.
 */
const PROVIDER_MODEL_FLAGS: Record<string, string | null> = {
  codex: null,
  opencode: '--model',
  opencode2: '--model',
  claude: '--model',
  gemini: '--model',
  aider: '--model',
  agy: '--model',
  'command-code': '--model',
  custom: null,
}

export interface ProviderInvocation {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** Executável resolvido do provedor (ex: C:\bin\opencode.cmd ou /usr/bin/opencode) */
  executablePath?: string
  /** Argumentos nativos do provedor (ex: ['--model', 'claude-sonnet']), sem wrappers do cmd.exe */
  nativeArgs?: string[]
}

/**
 * Adapter: produz o argv/env exato passado ao startTerminal para o modelo do
 * turno. No Windows os CLIs resolvem para wrappers .cmd — a flag do modelo é
 * encaminhada através do `call` (shims .cmd repassam `%*` ao executável real)
 * para a seleção valer também no caminho padrão; o env é sempre enviado como
 * redundância. Sem flag documentada (codex/custom), vale o contrato
 * env-only: o CLI lê `DEVORBIT_MODEL` / `DEVORBIT_MODEL_TIER` (+ BYOK da
 * família). Chaves nunca vão em argv.
 */
export function resolveProviderInvocation(
  provider: AgentProviderId | string,
  commandPath: string,
  model: string,
  tier: ModelTier,
  routing?: ModelRoutingConfig,
  baseEnv: NodeJS.ProcessEnv = process.env
): ProviderInvocation {
  if (typeof model !== 'string' || !/^[\w][\w.:+-]{0,199}$/.test(model)) {
    throw new Error('Modelo do turno inválido.')
  }
  const env = buildAgentTurnEnv(provider, model, tier, routing, baseEnv)
  const flag = PROVIDER_MODEL_FLAGS[provider]
  const nativeArgs = flag ? [flag, model] : []
  if (/\.(?:cmd|bat)$/i.test(commandPath)) {
    // Wrapper Windows: `cmd /k call <shim> --model m` com CADA parte como arg
    // separado. O node-pty escapa aspas internas de um arg único como \" —
    // literal para o cmd, que não acha o shim ("não é reconhecido"); com args
    // separados ele cita o caminho corretamente.
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/q', '/k', 'call', commandPath, ...nativeArgs],
      env,
      executablePath: commandPath,
      nativeArgs,
    }
  }
  return {
    command: commandPath,
    args: nativeArgs,
    env,
    executablePath: commandPath,
    nativeArgs,
  }
}
