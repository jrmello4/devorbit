export const LLM_PROVIDER_IDS = [
  'anthropic',
  'openai',
  'glm',
  'kimi',
  'minimax',
  'deepseek',
  'ollama',
  'vllm',
] as const

export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number]
export type LLMProviderId = LlmProviderId

export type LlmRole = 'system' | 'user' | 'assistant'

export interface LlmMessage {
  role: LlmRole
  content: string
}

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface LlmCompletion {
  content: string
  model: string
  usage: LlmUsage
  finishReason?: string
}

export interface LlmRequest {
  messages: readonly LlmMessage[]
  provider?: LlmProviderId
  fallback?: readonly LlmProviderId[]
  model?: string
  maxOutputTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export type LLMRequest = LlmRequest

export type LlmApiKeySource = string | (() => string | undefined | Promise<string | undefined>)

export interface LlmPricing {
  inputPerMillionTokens?: number
  outputPerMillionTokens?: number
  inputUsdPerMillion?: number
  outputUsdPerMillion?: number
  currency?: string
}

export interface LlmProviderConfig extends LlmPricing {
  id: LlmProviderId
  baseUrl?: string
  endpoint?: string
  timeoutMs?: number
  model?: string
  contextWindow?: number
  apiKey?: LlmApiKeySource
  apiKeyResolver?: () => string | undefined | Promise<string | undefined>
  headers?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>)
  adapter?: LlmAdapter
  enabled?: boolean
}

export type LLMProviderConfig = LlmProviderConfig

export interface LlmAdapterConfig {
  id: LlmProviderId
  baseUrl: string
  endpoint: string
  model: string
  headers: Readonly<Record<string, string>>
  apiKey?: string
}

export interface LlmAdapterRequest {
  url: string
  init: RequestInit
}

export interface LlmAdapterResponse {
  completion: LlmCompletion
}

export interface LlmAdapter {
  buildRequest: (request: LlmRequest, config: LlmAdapterConfig) => LlmAdapterRequest
  parseResponse: (body: unknown, response: Response, model: string) => LlmAdapterResponse
}

export interface LlmRetryPolicy {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
}

export interface LlmCircuitBreakerPolicy {
  failureThreshold: number
  cooldownMs: number
}

export interface LlmRouterConfig {
  providers: readonly LlmProviderConfig[]
  fallbackOrder?: readonly LlmProviderId[]
  retry?: Partial<LlmRetryPolicy>
  circuitBreaker?: Partial<LlmCircuitBreakerPolicy>
}

export interface LlmFetch {
  (input: string | URL, init?: RequestInit): Promise<Response>
}

export interface LlmRouterDependencies {
  fetch?: LlmFetch
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  random?: () => number
}

export type LlmAttemptStatus = 'success' | 'failed' | 'retrying' | 'skipped' | 'circuit-open' | 'not-configured'

export interface LlmAttempt {
  provider: LlmProviderId
  status: LlmAttemptStatus
  retries: number
  latencyMs: number
  error?: {
    code: string
    message: string
    status?: number
  }
}

export interface LlmContextUsage {
  inputTokens: number
  requestedOutputTokens: number
  totalRequestedTokens: number
  contextWindow: number
  remainingTokens: number
  withinLimit: boolean
}

export interface LlmCost {
  inputTokens: number
  outputTokens: number
  inputCost: number
  outputCost: number
  totalCost: number
  currency: string
}

export interface LlmRouteResult {
  ok: boolean
  provider?: LlmProviderId
  completion?: LlmCompletion
  attempts: readonly LlmAttempt[]
  context: LlmContextUsage
  cost: LlmCost
  error?: {
    code: string
    message: string
  }
}

export interface LlmCircuitState {
  provider: LlmProviderId
  failures: number
  openUntil: number
  state: 'closed' | 'open' | 'half-open'
}

export interface LlmRouter {
  complete: (request: LlmRequest) => Promise<LlmRouteResult>
  route: (request: LlmRequest) => Promise<LlmRouteResult>
  getCircuitStates: () => readonly LlmCircuitState[]
  getProviderIds: () => readonly LlmProviderId[]
}

export const DEFAULT_LLM_RETRY_POLICY: LlmRetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
}

export const DEFAULT_LLM_CIRCUIT_BREAKER_POLICY: LlmCircuitBreakerPolicy = {
  failureThreshold: 3,
  cooldownMs: 30_000,
}

export const DEFAULT_LLM_ENDPOINTS: Readonly<Record<LlmProviderId, string>> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  kimi: 'https://api.moonshot.cn/v1',
  minimax: 'https://api.minimax.chat/v1',
  deepseek: 'https://api.deepseek.com',
  ollama: 'http://127.0.0.1:11434/api',
  vllm: 'http://127.0.0.1:8000/v1',
}

export const DEFAULT_LLM_MODELS: Readonly<Record<LlmProviderId, string>> = {
  anthropic: 'claude-3-5-haiku-latest',
  openai: 'gpt-4o-mini',
  glm: 'glm-4-flash',
  kimi: 'moonshot-v1-8k',
  minimax: 'MiniMax-Text-01',
  deepseek: 'deepseek-chat',
  ollama: 'llama3.2',
  vllm: 'local-model',
}

export const DEFAULT_LLM_CONTEXT_WINDOWS: Readonly<Record<LlmProviderId, number>> = {
  anthropic: 200_000,
  openai: 128_000,
  glm: 128_000,
  kimi: 128_000,
  minimax: 128_000,
  deepseek: 64_000,
  ollama: 32_000,
  vllm: 32_000,
}

export const DEFAULT_LLM_PROVIDER_CONFIGS: Readonly<Record<LlmProviderId, Omit<LlmProviderConfig, 'id' | 'apiKey' | 'apiKeyResolver'>>> = {
  anthropic: { baseUrl: DEFAULT_LLM_ENDPOINTS.anthropic, model: DEFAULT_LLM_MODELS.anthropic, contextWindow: DEFAULT_LLM_CONTEXT_WINDOWS.anthropic },
  openai: { baseUrl: DEFAULT_LLM_ENDPOINTS.openai, model: DEFAULT_LLM_MODELS.openai, contextWindow: DEFAULT_LLM_CONTEXT_WINDOWS.openai },
  glm: { baseUrl: DEFAULT_LLM_ENDPOINTS.glm, model: DEFAULT_LLM_MODELS.glm, contextWindow: DEFAULT_LLM_CONTEXT_WINDOWS.glm },
  kimi: { baseUrl: DEFAULT_LLM_ENDPOINTS.kimi, model: DEFAULT_LLM_MODELS.kimi, contextWindow: DEFAULT_LLM_CONTEXT_WINDOWS.kimi },
  minimax: { baseUrl: DEFAULT_LLM_ENDPOINTS.minimax, model: DEFAULT_LLM_MODELS.minimax, contextWindow: DEFAULT_LLM_CONTEXT_WINDOWS.minimax },
  deepseek: { baseUrl: DEFAULT_LLM_ENDPOINTS.deepseek, model: DEFAULT_LLM_MODELS.deepseek, contextWindow: DEFAULT_LLM_CONTEXT_WINDOWS.deepseek },
  ollama: { baseUrl: DEFAULT_LLM_ENDPOINTS.ollama, model: DEFAULT_LLM_MODELS.ollama, contextWindow: DEFAULT_LLM_CONTEXT_WINDOWS.ollama },
  vllm: { baseUrl: DEFAULT_LLM_ENDPOINTS.vllm, model: DEFAULT_LLM_MODELS.vllm, contextWindow: DEFAULT_LLM_CONTEXT_WINDOWS.vllm },
}

const OPENAI_COMPATIBLE_IDS = new Set<LlmProviderId>(['openai', 'glm', 'kimi', 'minimax', 'deepseek', 'vllm'])
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 507, 529])
const TOKEN_CHARS = 4

class LlmProviderError extends Error {
  readonly code: string
  readonly status?: number
  readonly retryable: boolean
  retries = 0

  constructor(code: string, message: string, retryable: boolean, status?: number) {
    super(message)
    this.name = 'LlmProviderError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

function isProviderId(value: unknown): value is LlmProviderId {
  return typeof value === 'string' && (LLM_PROVIDER_IDS as readonly string[]).includes(value)
}

function normalizeProviderId(value: unknown): LlmProviderId | undefined {
  if (isProviderId(value)) return value
  if (value === 'mini-max' || value === 'minimax') return 'minimax'
  if (value === 'v-llm') return 'vllm'
  return undefined
}

function finitePositive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function normalizeMessages(messages: readonly LlmMessage[]): LlmMessage[] {
  return messages.map((message) => ({ role: message.role, content: message.content }))
}

export function estimateTokenCount(value: string): number {
  if (!value) return 0
  return Math.max(1, Math.ceil(Array.from(value).length / TOKEN_CHARS))
}

export const estimateTokens = estimateTokenCount

function estimateMessageTokens(messages: readonly LlmMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokenCount(message.content) + 4, 2)
}

function providerContextWindow(provider: Pick<LlmProviderConfig, 'contextWindow'> | undefined): number {
  return finitePositive(provider?.contextWindow, Number.POSITIVE_INFINITY)
}

export function calculateContextUsage(
  request: Pick<LlmRequest, 'messages' | 'maxOutputTokens'>,
  provider?: Pick<LlmProviderConfig, 'contextWindow'>
): LlmContextUsage {
  const inputTokens = estimateMessageTokens(request.messages)
  const requestedOutputTokens = Math.max(0, Math.floor(finiteNonNegative(request.maxOutputTokens, 1_024)))
  const contextWindow = providerContextWindow(provider)
  const totalRequestedTokens = inputTokens + requestedOutputTokens
  const remainingTokens = Number.isFinite(contextWindow) ? Math.max(0, contextWindow - totalRequestedTokens) : Number.POSITIVE_INFINITY
  return {
    inputTokens,
    requestedOutputTokens,
    totalRequestedTokens,
    contextWindow,
    remainingTokens,
    withinLimit: totalRequestedTokens <= contextWindow,
  }
}

function pricingValue(primary: number | undefined, alias: number | undefined): number {
  return finiteNonNegative(primary ?? alias, 0)
}

export function calculateLlmCost(
  usage: Pick<LlmUsage, 'inputTokens' | 'outputTokens'>,
  pricing: LlmPricing = {}
): LlmCost {
  const inputTokens = finiteNonNegative(usage.inputTokens, 0)
  const outputTokens = finiteNonNegative(usage.outputTokens, 0)
  const inputRate = pricingValue(pricing.inputPerMillionTokens, pricing.inputUsdPerMillion)
  const outputRate = pricingValue(pricing.outputPerMillionTokens, pricing.outputUsdPerMillion)
  const inputCost = inputTokens / 1_000_000 * inputRate
  const outputCost = outputTokens / 1_000_000 * outputRate
  return {
    inputTokens,
    outputTokens,
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    currency: pricing.currency ?? 'USD',
  }
}

export const calculateCost = calculateLlmCost

function endpointUrl(baseUrl: string, endpoint: string): string {
  if (/^https?:\/\//i.test(endpoint)) return endpoint
  if (/^https?:\/\/[^/]+\/[^/]+$/.test(baseUrl) && endpoint === '') return baseUrl
  if (!endpoint) return baseUrl.replace(/\/+$/, '')
  return `${baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`
}

function readHeaders(value: LlmProviderConfig['headers']): Readonly<Record<string, string>> {
  if (!value) return {}
  const result = typeof value === 'function' ? value() : value
  return Object.fromEntries(Object.entries(result).filter(([key, item]) => typeof key === 'string' && typeof item === 'string'))
}

function baseAdapterHeaders(config: LlmAdapterConfig): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...config.headers }
  if (config.apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === 'authorization' || key.toLowerCase() === 'x-api-key')) {
    headers.Authorization = `Bearer ${config.apiKey}`
  }
  return headers
}

function parseStringContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const text = value.flatMap((part) => {
    if (!part || typeof part !== 'object') return []
    const record = part as Record<string, unknown>
    return typeof record.text === 'string' ? [record.text] : []
  }).join('')
  return text || undefined
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function usageFrom(value: unknown): LlmUsage {
  if (!value || typeof value !== 'object') return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const record = value as Record<string, unknown>
  const inputTokens = numberFrom(record.input_tokens) ?? numberFrom(record.prompt_tokens) ?? numberFrom(record.prompt_eval_count) ?? 0
  const outputTokens = numberFrom(record.output_tokens) ?? numberFrom(record.completion_tokens) ?? numberFrom(record.eval_count) ?? 0
  const totalTokens = numberFrom(record.total_tokens) ?? inputTokens + outputTokens
  return { inputTokens, outputTokens, totalTokens }
}

function parseOpenAiCompletion(body: unknown, response: Response, model: string): LlmAdapterResponse {
  if (!body || typeof body !== 'object') throw new LlmProviderError('invalid-response', 'Resposta do provedor não é um objeto.', false)
  const record = body as Record<string, unknown>
  const choices = Array.isArray(record.choices) ? record.choices : []
  const choice = choices[0]
  if (!choice || typeof choice !== 'object') throw new LlmProviderError('invalid-response', 'Resposta do provedor não contém choices.', false)
  const choiceRecord = choice as Record<string, unknown>
  const message = choiceRecord.message
  const content = message && typeof message === 'object'
    ? parseStringContent((message as Record<string, unknown>).content)
    : parseStringContent(choiceRecord.text)
  if (content === undefined) throw new LlmProviderError('invalid-response', 'Resposta do provedor não contém conteúdo.', false)
  return {
    completion: {
      content,
      model: typeof record.model === 'string' ? record.model : model,
      usage: usageFrom(record.usage),
      finishReason: typeof choiceRecord.finish_reason === 'string' ? choiceRecord.finish_reason : undefined,
    },
  }
}

function parseAnthropicCompletion(body: unknown, response: Response, model: string): LlmAdapterResponse {
  if (!body || typeof body !== 'object') throw new LlmProviderError('invalid-response', 'Resposta do provedor não é um objeto.', false)
  const record = body as Record<string, unknown>
  const content = parseStringContent(record.content)
  if (content === undefined) throw new LlmProviderError('invalid-response', 'Resposta do provedor não contém conteúdo.', false)
  const usageRecord = record.usage && typeof record.usage === 'object' ? record.usage as Record<string, unknown> : {}
  return {
    completion: {
      content,
      model: typeof record.model === 'string' ? record.model : model,
      usage: usageFrom({ input_tokens: usageRecord.input_tokens, output_tokens: usageRecord.output_tokens }),
      finishReason: typeof record.stop_reason === 'string' ? record.stop_reason : undefined,
    },
  }
}

function openAiAdapter(id: LlmProviderId, endpoint: string): LlmAdapter {
  return {
    buildRequest: (request, config) => {
      const headers = baseAdapterHeaders(config)
      return {
        url: endpointUrl(config.baseUrl, config.endpoint || endpoint),
        init: {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: config.model,
            messages: normalizeMessages(request.messages),
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
          }),
        },
      }
    },
    parseResponse: (body, response, model) => parseOpenAiCompletion(body, response, model),
  }
}

function anthropicAdapter(): LlmAdapter {
  return {
    buildRequest: (request, config) => {
      const headers = baseAdapterHeaders(config)
      if (config.apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === 'x-api-key')) headers['x-api-key'] = config.apiKey
      delete headers.Authorization
      headers['anthropic-version'] ??= '2023-06-01'
      const system = request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n')
      return {
        url: endpointUrl(config.baseUrl, config.endpoint || 'messages'),
        init: {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: config.model,
            max_tokens: request.maxOutputTokens ?? 1_024,
            ...(system ? { system } : {}),
            messages: normalizeMessages(request.messages.filter((message) => message.role !== 'system')),
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          }),
        },
      }
    },
    parseResponse: (body, response, model) => parseAnthropicCompletion(body, response, model),
  }
}

function ollamaAdapter(): LlmAdapter {
  return {
    buildRequest: (request, config) => {
      const options = {
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxOutputTokens === undefined ? {} : { num_predict: request.maxOutputTokens }),
      }
      return {
        url: endpointUrl(config.baseUrl, config.endpoint || 'chat'),
        init: {
          method: 'POST',
          headers: baseAdapterHeaders(config),
          body: JSON.stringify({
            model: config.model,
            messages: normalizeMessages(request.messages),
            stream: false,
            ...(Object.keys(options).length > 0 ? { options } : {}),
          }),
        },
      }
    },
    parseResponse: (body, response, model) => {
      if (!body || typeof body !== 'object') throw new LlmProviderError('invalid-response', 'Resposta do provedor não é um objeto.', false)
      const record = body as Record<string, unknown>
      const message = record.message
      const content = message && typeof message === 'object' ? parseStringContent((message as Record<string, unknown>).content) : undefined
      if (content === undefined) throw new LlmProviderError('invalid-response', 'Resposta do provedor não contém conteúdo.', false)
      return { completion: { content, model: typeof record.model === 'string' ? record.model : model, usage: usageFrom(record) } }
    },
  }
}

export function createLlmAdapter(id: LlmProviderId): LlmAdapter {
  if (id === 'anthropic') return anthropicAdapter()
  if (id === 'ollama') return ollamaAdapter()
  if (id === 'openai') return openAiAdapter(id, 'chat/completions')
  if (OPENAI_COMPATIBLE_IDS.has(id)) return openAiAdapter(id, 'chat/completions')
  return openAiAdapter(id, 'chat/completions')
}

export const createProviderAdapter = createLlmAdapter

function defaultConfig(id: LlmProviderId): LlmProviderConfig {
  const config = DEFAULT_LLM_PROVIDER_CONFIGS[id]
  return { id, ...config }
}

function normalizeConfig(input: LlmProviderConfig): LlmProviderConfig {
  const id = normalizeProviderId(input.id)
  if (!id) throw new Error('Provedor LLM inválido.')
  const defaults = defaultConfig(id)
  return {
    ...defaults,
    ...input,
    id,
    baseUrl: input.baseUrl?.trim() || defaults.baseUrl,
    model: input.model?.trim() || defaults.model,
    contextWindow: finitePositive(input.contextWindow, defaults.contextWindow ?? Number.POSITIVE_INFINITY),
  }
}

function createSafeAdapterConfig(runtime: RuntimeProvider, apiKey: string | undefined): LlmAdapterConfig {
  return {
    id: runtime.config.id,
    baseUrl: runtime.config.baseUrl ?? DEFAULT_LLM_ENDPOINTS[runtime.config.id],
    endpoint: runtime.config.endpoint ?? '',
    model: runtime.config.model ?? DEFAULT_LLM_MODELS[runtime.config.id],
    headers: runtime.headers,
    ...(apiKey ? { apiKey } : {}),
  }
}

interface RuntimeProvider {
  config: LlmProviderConfig
  adapter: LlmAdapter
  keySource?: LlmApiKeySource
  headers: Readonly<Record<string, string>>
  circuit: {
    failures: number
    openUntil: number
    probeInFlight: boolean
  }
}

function normalizePolicy(config: LlmRouterConfig): { retry: LlmRetryPolicy; circuitBreaker: LlmCircuitBreakerPolicy } {
  return {
    retry: {
      maxRetries: Math.floor(finiteNonNegative(config.retry?.maxRetries, DEFAULT_LLM_RETRY_POLICY.maxRetries)),
      baseDelayMs: finiteNonNegative(config.retry?.baseDelayMs, DEFAULT_LLM_RETRY_POLICY.baseDelayMs),
      maxDelayMs: finiteNonNegative(config.retry?.maxDelayMs, DEFAULT_LLM_RETRY_POLICY.maxDelayMs),
    },
    circuitBreaker: {
      failureThreshold: Math.max(1, Math.floor(finitePositive(config.circuitBreaker?.failureThreshold, DEFAULT_LLM_CIRCUIT_BREAKER_POLICY.failureThreshold))),
      cooldownMs: finiteNonNegative(config.circuitBreaker?.cooldownMs, DEFAULT_LLM_CIRCUIT_BREAKER_POLICY.cooldownMs),
    },
  }
}

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs)
    if (!signal) return
    const abort = () => {
      clearTimeout(timer)
      reject(new LlmProviderError('aborted', 'Solicitação cancelada.', false))
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

function abortError(): LlmProviderError {
  return new LlmProviderError('aborted', 'Solicitação cancelada.', false)
}

function errorDetails(error: unknown): { code: string; message: string; status?: number; retryable: boolean } {
  if (error instanceof LlmProviderError) return { code: error.code, message: error.message, status: error.status, retryable: error.retryable }
  if (error instanceof Error) return { code: 'network-error', message: error.message.slice(0, 240), retryable: true }
  return { code: 'provider-error', message: 'Falha desconhecida do provedor.', retryable: true }
}

function statusError(response: Response): LlmProviderError {
  const retryable = RETRYABLE_STATUSES.has(response.status) || response.status >= 500
  return new LlmProviderError(`http-${response.status}`, `Provedor respondeu HTTP ${response.status}.`, retryable, response.status)
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new LlmProviderError('invalid-json', 'Resposta do provedor não é JSON válido.', false, response.status)
  }
}

function uniqueProviders(values: readonly (LlmProviderId | undefined)[]): LlmProviderId[] {
  return [...new Set(values.filter((value): value is LlmProviderId => isProviderId(value)))]
}

function requestOrder(request: LlmRequest, config: LlmRouterConfig): LlmProviderId[] {
  return uniqueProviders([
    request.provider,
    ...(request.fallback ?? []),
    ...(config.fallbackOrder ?? []),
    ...config.providers.map((provider) => normalizeProviderId(provider.id)),
  ])
}

function currentCircuitState(provider: RuntimeProvider, now: number): LlmCircuitState {
  if (provider.circuit.openUntil > now) return { provider: provider.config.id, failures: provider.circuit.failures, openUntil: provider.circuit.openUntil, state: 'open' }
  if (provider.circuit.openUntil > 0) return { provider: provider.config.id, failures: provider.circuit.failures, openUntil: provider.circuit.openUntil, state: 'half-open' }
  return { provider: provider.config.id, failures: provider.circuit.failures, openUntil: 0, state: 'closed' }
}

function safeNow(now: () => number): number {
  const value = now()
  return Number.isFinite(value) ? value : Date.now()
}

function backoff(policy: LlmRetryPolicy, retry: number, random: () => number): number {
  const jitter = Math.min(1, Math.max(0, random()))
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** retry)
  return Math.floor(exponential * (0.75 + jitter * 0.25))
}

async function resolveKey(source: LlmApiKeySource | undefined): Promise<string | undefined> {
  if (typeof source === 'function') {
    const value = await source()
    return typeof value === 'string' && value ? value : undefined
  }
  return typeof source === 'string' && source ? source : undefined
}

function defaultContext(): LlmContextUsage {
  return { inputTokens: 0, requestedOutputTokens: 0, totalRequestedTokens: 0, contextWindow: Number.POSITIVE_INFINITY, remainingTokens: Number.POSITIVE_INFINITY, withinLimit: true }
}

function failedResult(attempts: readonly LlmAttempt[], context: LlmContextUsage, code: string, message: string): LlmRouteResult {
  return { ok: false, attempts, context, cost: calculateLlmCost({ inputTokens: 0, outputTokens: 0 }), error: { code, message } }
}

export function createLlmRouter(
  input: LlmRouterConfig | readonly LlmProviderConfig[],
  dependencies: LlmRouterDependencies = {}
): LlmRouter {
  const config: LlmRouterConfig = Array.isArray(input) ? { providers: input } : input as LlmRouterConfig
  const policy = normalizePolicy(config)
  const fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis)
  const sleep = dependencies.sleep ?? defaultSleep
  const now = dependencies.now ?? (() => Date.now())
  const random = dependencies.random ?? Math.random
  const runtimes = new Map<LlmProviderId, RuntimeProvider>()

  for (const raw of config.providers) {
    const normalized = normalizeConfig(raw)
    const headers = readHeaders(normalized.headers)
    const adapter = normalized.adapter ?? createLlmAdapter(normalized.id)
    const keySource = normalized.apiKeyResolver ?? normalized.apiKey
    runtimes.set(normalized.id, {
      config: { ...normalized, apiKey: undefined, apiKeyResolver: undefined },
      adapter,
      keySource,
      headers,
      circuit: { failures: 0, openUntil: 0, probeInFlight: false },
    })
  }

  async function attemptProvider(runtime: RuntimeProvider, request: LlmRequest, context: LlmContextUsage): Promise<{ completion: LlmCompletion; retries: number }> {
    if (request.signal?.aborted) throw abortError()
    const apiKey = await resolveKey(runtime.keySource)
    const adapterRequest = runtime.adapter.buildRequest(request, createSafeAdapterConfig(runtime, apiKey))
    let retries = 0

    while (true) {
      if (request.signal?.aborted) throw abortError()
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const abort = () => controller.abort()
      if (request.signal) {
        if (request.signal.aborted) throw abortError()
        request.signal.addEventListener('abort', abort, { once: true })
      }
      if (runtime.config.endpoint !== 'infinite') timer = setTimeout(() => controller.abort(), finitePositive(runtime.config.timeoutMs, 30_000))
      try {
        const response = await fetcher(adapterRequest.url, { ...adapterRequest.init, signal: controller.signal })
        if (!response.ok) throw statusError(response)
        const body = await responseBody(response)
        const parsed = runtime.adapter.parseResponse(body, response, runtime.config.model ?? DEFAULT_LLM_MODELS[runtime.config.id])
        return { completion: parsed.completion, retries }
      } catch (error) {
        if (controller.signal.aborted && request.signal?.aborted) throw abortError()
        if (controller.signal.aborted && !request.signal?.aborted) throw new LlmProviderError('timeout', 'Tempo limite do provedor excedido.', true)
        const details = errorDetails(error)
        if (!details.retryable || retries >= policy.retry.maxRetries) {
          const finalError = error instanceof LlmProviderError
            ? error
            : new LlmProviderError(details.code, details.message, details.retryable, details.status)
          finalError.retries = retries
          throw finalError
        }
        retries += 1
        await sleep(backoff(policy.retry, retries - 1, random), request.signal)
      } finally {
        if (timer) clearTimeout(timer)
        request.signal?.removeEventListener('abort', abort)
      }
    }
  }

  async function complete(request: LlmRequest): Promise<LlmRouteResult> {
    const attempts: LlmAttempt[] = []
    let lastError: { code: string; message: string } | undefined
    let lastContext = defaultContext()
    const order = requestOrder(request, config)

    if (!Array.isArray(request.messages) || request.messages.length === 0) return failedResult(attempts, lastContext, 'invalid-request', 'A solicitação precisa de pelo menos uma mensagem.')
    if (request.messages.some((message) => !message || !isValidRole(message.role) || typeof message.content !== 'string')) return failedResult(attempts, lastContext, 'invalid-request', 'Mensagem LLM inválida.')

    for (const providerId of order) {
      const runtime = runtimes.get(providerId)
      if (!runtime || runtime.config.enabled === false) {
        attempts.push({ provider: providerId, status: 'not-configured', retries: 0, latencyMs: 0, error: { code: 'not-configured', message: 'Provedor não configurado.' } })
        lastError = { code: 'not-configured', message: 'Provedor não configurado.' }
        continue
      }
      const context = calculateContextUsage(request, runtime.config)
      lastContext = context
      if (!context.withinLimit) {
        attempts.push({ provider: providerId, status: 'skipped', retries: 0, latencyMs: 0, error: { code: 'context-limit', message: 'Solicitação excede a janela de contexto.' } })
        lastError = { code: 'context-limit', message: 'Solicitação excede a janela de contexto.' }
        continue
      }
      const current = safeNow(now)
      if (runtime.circuit.openUntil > current) {
        attempts.push({ provider: providerId, status: 'circuit-open', retries: 0, latencyMs: 0, error: { code: 'circuit-open', message: 'Circuit breaker aberto.' } })
        lastError = { code: 'circuit-open', message: 'Circuit breaker aberto.' }
        continue
      }
      if (runtime.circuit.openUntil > 0) {
        if (runtime.circuit.probeInFlight) {
          attempts.push({ provider: providerId, status: 'circuit-open', retries: 0, latencyMs: 0, error: { code: 'circuit-open', message: 'Circuit breaker aguardando probe.' } })
          continue
        }
        runtime.circuit.probeInFlight = true
      }

      const started = safeNow(now)
      try {
        const result = await attemptProvider(runtime, request, context)
        runtime.circuit.failures = 0
        runtime.circuit.openUntil = 0
        runtime.circuit.probeInFlight = false
        const completion = result.completion
        const usage = completion.usage.totalTokens > 0
          ? completion.usage
          : { ...completion.usage, inputTokens: context.inputTokens, totalTokens: context.inputTokens + completion.usage.outputTokens }
        const finalCompletion = { ...completion, usage }
        attempts.push({ provider: providerId, status: 'success', retries: result.retries, latencyMs: Math.max(0, safeNow(now) - started) })
        return {
          ok: true,
          provider: providerId,
          completion: finalCompletion,
          attempts,
          context: { ...context, totalRequestedTokens: usage.inputTokens + context.requestedOutputTokens, remainingTokens: Number.isFinite(context.contextWindow) ? Math.max(0, context.contextWindow - usage.inputTokens - context.requestedOutputTokens) : Number.POSITIVE_INFINITY },
          cost: calculateLlmCost(usage, runtime.config),
        }
      } catch (error) {
        runtime.circuit.probeInFlight = false
        const details = errorDetails(error)
        if (details.code === 'aborted') {
          attempts.push({ provider: providerId, status: 'failed', retries: error instanceof LlmProviderError ? error.retries : 0, latencyMs: Math.max(0, safeNow(now) - started), error: { code: details.code, message: details.message } })
          return failedResult(attempts, context, details.code, details.message)
        }
        runtime.circuit.failures += 1
        if (runtime.circuit.failures >= policy.circuitBreaker.failureThreshold) runtime.circuit.openUntil = safeNow(now) + policy.circuitBreaker.cooldownMs
        attempts.push({ provider: providerId, status: 'failed', retries: error instanceof LlmProviderError ? error.retries : 0, latencyMs: Math.max(0, safeNow(now) - started), error: { code: details.code, message: details.message, status: details.status } })
        lastError = { code: details.code, message: details.message }
      }
    }

    return failedResult(attempts, lastContext, lastError?.code ?? 'no-provider', lastError?.message ?? 'Nenhum provedor disponível.')
  }

  return {
    complete,
    route: complete,
    getCircuitStates: () => [...runtimes.values()].map((runtime) => currentCircuitState(runtime, safeNow(now))),
    getProviderIds: () => [...runtimes.keys()],
  }
}

function isValidRole(value: unknown): value is LlmRole {
  return value === 'system' || value === 'user' || value === 'assistant'
}

export async function routeLlmRequest(
  router: LlmRouter,
  request: LlmRequest
): Promise<LlmRouteResult> {
  return router.complete(request)
}
