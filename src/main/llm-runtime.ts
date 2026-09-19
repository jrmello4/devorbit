import type { AppConfig, ModelRoutingBaseUrlKey } from '../renderer/src/types'
import { createHash } from 'node:crypto'
import { createLlmRouter, LLM_PROVIDER_IDS, type LlmProviderId, type LlmRequest, type LlmRouteResult } from './llm-router'
import type { LlmCompletionRequestView as SharedLlmRequest } from '../shared/llm-contract'

let routerSignature = ''
let router: ReturnType<typeof createLlmRouter> | undefined

const PROVIDER_BASE_URL_KEYS: Readonly<Partial<Record<LlmProviderId, ModelRoutingBaseUrlKey>>> = {
  openai: 'openaiBaseUrl',
  anthropic: 'anthropicBaseUrl',
  gemini: 'geminiBaseUrl',
  deepseek: 'deepseekBaseUrl',
  glm: 'glmBaseUrl',
  kimi: 'kimiBaseUrl',
  minimax: 'minimaxBaseUrl',
  ollama: 'ollamaBaseUrl',
  vllm: 'vllmBaseUrl',
}

function configKeyFor(id: LlmProviderId, config: AppConfig): string | undefined {
  const routing = config.modelRouting
  switch (id) {
    case 'openai':
      return routing?.openaiApiKey
    case 'anthropic':
      return routing?.anthropicApiKey
    case 'gemini':
      return routing?.geminiApiKey
    case 'deepseek':
      return routing?.deepseekApiKey
    case 'glm':
      return routing?.glmApiKey
    case 'kimi':
      return routing?.kimiApiKey
    case 'minimax':
      return routing?.minimaxApiKey
    case 'vllm':
      return routing?.vllmApiKey
    default:
      return undefined
  }
}

function keyFor(id: LlmProviderId, config: AppConfig): string | undefined {
  const configured = configKeyFor(id, config)?.trim()
  return configured || process.env[`DEVORBIT_${id.toUpperCase()}_API_KEY`]
}

function baseUrlFor(id: LlmProviderId, config: AppConfig): string | undefined {
  const key = PROVIDER_BASE_URL_KEYS[id]
  const value = key ? config.modelRouting?.[key] : undefined
  return value?.trim() || undefined
}

function modelFor(id: LlmProviderId, config: AppConfig): string | undefined {
  if (id === 'openai') return config.modelRouting?.fastModel
  if (id === 'anthropic') return config.modelRouting?.deepModel
  return undefined
}

function keyFingerprint(value: string | undefined): string {
  return createHash('sha256').update(value || '').digest('hex')
}

function getRouter(config: AppConfig): ReturnType<typeof createLlmRouter> {
  const signature = JSON.stringify({
    fastModel: config.modelRouting?.fastModel,
    deepModel: config.modelRouting?.deepModel,
    baseUrls: LLM_PROVIDER_IDS.map((id) => [id, baseUrlFor(id, config) ?? '']),
    keys: LLM_PROVIDER_IDS.map((id) => [id, keyFingerprint(keyFor(id, config))]),
  })
  if (router && signature === routerSignature) return router
  routerSignature = signature
  router = createLlmRouter({
    providers: LLM_PROVIDER_IDS.map((id) => {
      const baseUrl = baseUrlFor(id, config)
      const model = modelFor(id, config)
      return {
        id,
        enabled: true,
        ...(model ? { model } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        apiKeyResolver: () => keyFor(id, config),
      }
    }),
    fallbackOrder: [...LLM_PROVIDER_IDS],
  })
  return router
}

export function completeLlm(config: AppConfig, request: SharedLlmRequest): Promise<LlmRouteResult> {
  return getRouter(config).complete(request as LlmRequest)
}
