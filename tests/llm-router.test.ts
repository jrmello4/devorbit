import {
  calculateContextUsage,
  calculateLlmCost,
  createLlmRouter,
  DEFAULT_LLM_ENDPOINTS,
  LLM_PROVIDER_IDS,
  type LlmProviderConfig,
} from '../src/main/llm-router'
import { describe, expect, it } from 'vitest'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function openAiBody(content: string, model = 'test-model') {
  return { model, choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }
}

describe('llm router', () => {
  it('exposes all configured providers and uses injectable fetch without logging prompts', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const prompt = 'segredo do prompt que não deve ser impresso'
    const config: LlmProviderConfig[] = LLM_PROVIDER_IDS.map((id) => ({
      id,
      baseUrl: `https://example.test/${id}`,
      model: `${id}-model`,
      apiKey: id === 'ollama' || id === 'vllm' ? undefined : () => `${id}-secret-key`,
    }))
    const router = createLlmRouter({ providers: config, retry: { maxRetries: 0 } }, {
      fetch: async (input, init) => {
        calls.push({ url: String(input), init })
        return jsonResponse(input.toString().includes('/api/chat') ? { model: 'ollama-model', message: { content: 'ok' }, prompt_eval_count: 10, eval_count: 4 } : openAiBody('ok'))
      },
    })

    expect(router.getProviderIds()).toEqual(LLM_PROVIDER_IDS)
    const result = await router.complete({ provider: 'openai', messages: [{ role: 'user', content: prompt }] })

    expect(result.ok).toBe(true)
    expect(result.provider).toBe('openai')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: 'Bearer openai-secret-key' })
    expect(JSON.stringify(router.getCircuitStates())).not.toContain('openai-secret-key')
    expect(JSON.stringify(result)).not.toContain('openai-secret-key')
    expect(result.completion?.content).toBe('ok')
  })

  it('retries transient errors and falls back in the declared order', async () => {
    const calls: string[] = []
    const router = createLlmRouter({
      providers: [
        { id: 'openai', baseUrl: 'https://example.test/openai', model: 'first' },
        { id: 'ollama', baseUrl: 'https://example.test/ollama', model: 'second' },
      ],
      fallbackOrder: ['openai', 'ollama'],
      retry: { maxRetries: 1, baseDelayMs: 0 },
    }, {
      sleep: async () => undefined,
      fetch: async (input) => {
        calls.push(String(input))
        if (calls.length <= 2) return jsonResponse({ error: 'busy' }, 503)
        if (String(input).includes('/ollama/')) return jsonResponse({ model: 'second', message: { content: 'fallback' }, prompt_eval_count: 2, eval_count: 1 })
        return jsonResponse({ model: 'second', choices: [{ message: { content: 'fallback' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } })
      },
    })

    const result = await router.complete({ messages: [{ role: 'user', content: 'hello' }] })

    expect(result.ok).toBe(true)
    expect(result.provider).toBe('ollama')
    expect(calls).toHaveLength(3)
    expect(result.attempts.map((attempt) => [attempt.provider, attempt.status, attempt.retries])).toEqual([
      ['openai', 'failed', 1],
      ['ollama', 'success', 0],
    ])
  })

  it('opens a circuit after failures and probes after cooldown', async () => {
    let now = 1_000
    let calls = 0
    const router = createLlmRouter({
      providers: [{ id: 'deepseek', baseUrl: 'https://example.test/deepseek', model: 'test' }],
      retry: { maxRetries: 0 },
      circuitBreaker: { failureThreshold: 1, cooldownMs: 100 },
    }, {
      now: () => now,
      fetch: async () => {
        calls += 1
        if (calls === 1) return jsonResponse({ error: 'down' }, 500)
        return jsonResponse(openAiBody('recovered'))
      },
    })

    const first = await router.complete({ messages: [{ role: 'user', content: 'one' }] })
    const second = await router.complete({ messages: [{ role: 'user', content: 'two' }] })
    now += 101
    const third = await router.complete({ messages: [{ role: 'user', content: 'three' }] })

    expect(first.ok).toBe(false)
    expect(second.attempts[0]?.status).toBe('circuit-open')
    expect(third.ok).toBe(true)
    expect(calls).toBe(2)
    expect(router.getCircuitStates()[0]).toMatchObject({ state: 'closed', failures: 0 })
  })

  it('calculates context and monetary cost deterministically', () => {
    const context = calculateContextUsage(
      { messages: [{ role: 'user', content: '12345678' }], maxOutputTokens: 10 },
      { contextWindow: 20 },
    )
    const cost = calculateLlmCost({ inputTokens: 1_000, outputTokens: 500 }, { inputPerMillionTokens: 2, outputPerMillionTokens: 4 })

    expect(context.inputTokens).toBe(8)
    expect(context.totalRequestedTokens).toBe(18)
    expect(context.remainingTokens).toBe(2)
    expect(context.withinLimit).toBe(true)
    expect(cost).toMatchObject({ inputCost: 0.002, outputCost: 0.002, totalCost: 0.004, currency: 'USD' })
  })

  it('skips a provider whose context is too small without calling fetch', async () => {
    let calls = 0
    const router = createLlmRouter({
      providers: [
        { id: 'openai', baseUrl: 'https://example.test/openai', model: 'small', contextWindow: 5 },
        { id: 'vllm', baseUrl: 'https://example.test/vllm', model: 'large', contextWindow: 1_000 },
      ],
      fallbackOrder: ['openai', 'vllm'],
      retry: { maxRetries: 0 },
    }, {
      fetch: async () => {
        calls += 1
        return jsonResponse(openAiBody('large'))
      },
    })

    const result = await router.complete({ messages: [{ role: 'user', content: 'a prompt longer than five tokens' }], maxOutputTokens: 100 })

    expect(result.ok).toBe(true)
    expect(result.provider).toBe('vllm')
    expect(result.attempts[0]).toMatchObject({ status: 'skipped', error: { code: 'context-limit' } })
    expect(calls).toBe(1)
  })

  it('uses the configured default endpoints when a base URL is omitted', () => {
    expect(DEFAULT_LLM_ENDPOINTS.anthropic).toContain('anthropic')
    expect(DEFAULT_LLM_ENDPOINTS.gemini).toContain('generativelanguage.googleapis.com')
    expect(DEFAULT_LLM_ENDPOINTS.ollama).toContain('11434')
    expect(DEFAULT_LLM_ENDPOINTS.vllm).toContain('8000')
  })

  it('routes to gemini using OpenAI compatible protocol', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const router = createLlmRouter({
      providers: [{ id: 'gemini', apiKey: () => 'gemini-key' }],
    }, {
      fetch: async (input, init) => {
        calls.push({ url: String(input), init })
        return jsonResponse(openAiBody('gemini-answer', 'gemini-1.5-flash'))
      },
    })

    const result = await router.complete({ provider: 'gemini', messages: [{ role: 'user', content: 'hello gemini' }] })
    expect(result.ok).toBe(true)
    expect(result.provider).toBe('gemini')
    expect(result.completion?.content).toBe('gemini-answer')
    expect(calls[0]?.url).toContain('googleapis.com')
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: 'Bearer gemini-key' })
  })
})
