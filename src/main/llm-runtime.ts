import type { AppConfig } from '../renderer/src/types'
import { createHash } from 'node:crypto'
import { createLlmRouter, LLM_PROVIDER_IDS, type LlmRequest, type LlmRouteResult } from './llm-router'
import type { LlmCompletionRequestView as SharedLlmRequest } from '../shared/llm-contract'

let routerSignature = ''
let router: ReturnType<typeof createLlmRouter> | undefined

function keyFor(id: string, config: AppConfig): string | undefined {
  if (id === 'openai') return config.modelRouting?.openaiApiKey || process.env.DEVORBIT_OPENAI_API_KEY
  if (id === 'anthropic') return config.modelRouting?.anthropicApiKey || process.env.DEVORBIT_ANTHROPIC_API_KEY
  return process.env[`DEVORBIT_${id.toUpperCase()}_API_KEY`]
}

function keyFingerprint(value: string | undefined): string {
  return createHash('sha256').update(value || '').digest('hex')
}

function getRouter(config: AppConfig): ReturnType<typeof createLlmRouter> {
  const signature = JSON.stringify({
    fastModel: config.modelRouting?.fastModel,
    deepModel: config.modelRouting?.deepModel,
    keys: LLM_PROVIDER_IDS.map((id) => [id, keyFingerprint(keyFor(id, config))]),
  })
  if (router && signature === routerSignature) return router
  routerSignature = signature
  router = createLlmRouter({
    providers: LLM_PROVIDER_IDS.map((id) => ({
      id,
      enabled: true,
      model: id === 'openai' ? config.modelRouting?.fastModel : id === 'anthropic' ? config.modelRouting?.deepModel : undefined,
      apiKeyResolver: () => keyFor(id, config),
    })),
    fallbackOrder: [...LLM_PROVIDER_IDS],
  })
  return router
}

export function completeLlm(config: AppConfig, request: SharedLlmRequest): Promise<LlmRouteResult> {
  return getRouter(config).complete(request as LlmRequest)
}
