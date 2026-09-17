export type LlmProviderId = 'anthropic' | 'openai' | 'glm' | 'kimi' | 'minimax' | 'deepseek' | 'ollama' | 'vllm'

export interface LlmMessageView {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmCompletionRequestView {
  messages: readonly LlmMessageView[]
  provider?: LlmProviderId
  fallback?: readonly LlmProviderId[]
  model?: string
  maxOutputTokens?: number
  temperature?: number
}

export interface LlmRouteView {
  ok: boolean
  provider?: LlmProviderId
  completion?: { content: string; model: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number }; finishReason?: string }
  attempts: readonly { provider: LlmProviderId; status: string; retries: number; latencyMs: number; error?: { code: string; message: string; status?: number } }[]
  context: { inputTokens: number; requestedOutputTokens: number; totalRequestedTokens: number; contextWindow: number; remainingTokens: number; withinLimit: boolean }
  cost: { inputTokens: number; outputTokens: number; inputCost: number; outputCost: number; totalCost: number; currency: string }
  error?: { code: string; message: string }
}
