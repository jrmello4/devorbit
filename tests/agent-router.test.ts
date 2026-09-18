import { describe, expect, it, vi, afterEach } from 'vitest'
import type { AppConfig } from '../src/renderer/src/types'
import {
  SHADOW_ENV_VARIABLES,
  SHADOW_MAX_STATE_CHARS,
  buildAgentTurnEnv,
  classifyPromptShadow,
  classifyTaskComplexity,
  createTypeSafeShadowJudge,
  executeExplicitAgentTurn,
  explainClassification,
  findTransientSnippet,
  getShadowObservations,
  getShadowRoutingStats,
  isShadowRoutingEnabled,
  isTransientProviderError,
  onShadowObservation,
  orderProvidersForTask,
  providerUnavailableError,
  redactPromptForJudgment,
  redactSecrets,
  resetShadowRoutingState,
  resolveAgentProviderCommand,
  resolveAgentProviderWithFallback,
  resolveAgentTurn,
  resolveModelForTier,
  resolveProviderInvocation,
  routeTaskToTier,
  sanitizePromptForJudgment,
  setShadowEnvSnapshotForTests,
  tierModels,
  type ShadowObservationListener,
  validateModelRoutingConfig,
} from '../src/main/agent-providers'

describe('task complexity classifier', () => {
  it('routes mechanical chores to the fast tier', () => {
    expect(classifyTaskComplexity('dê grep em src por TODO')).toBe('mechanical')
    expect(classifyTaskComplexity('leia os arquivos package.json e vite.config.ts')).toBe('mechanical')
    expect(classifyTaskComplexity('compile o projeto com tsc e reporte erros')).toBe('mechanical')
    expect(classifyTaskComplexity('faça um resumo simples das mudanças')).toBe('mechanical')
    expect(classifyTaskComplexity('')).toBe('mechanical')
    expect(classifyTaskComplexity(undefined)).toBe('mechanical')
  })

  it('routes architecture and review to the deep tier', () => {
    expect(classifyTaskComplexity('refatore o módulo de autenticação separando responsabilidades')).toBe('deep')
    expect(classifyTaskComplexity('proponha a arquitetura do novo serviço de filas')).toBe('deep')
    expect(classifyTaskComplexity('revise este PR com foco em segurança')).toBe('deep')
    expect(classifyTaskComplexity('migre o estado global para zustand')).toBe('deep')
  })

  it('deep wins when a prompt mixes both vocabularies', () => {
    expect(classifyTaskComplexity('leia os arquivos e refatore a camada de cache')).toBe('deep')
  })

  it('uses explicit mechanical vocabulary and routes long unknowns to deep', () => {
    expect(classifyTaskComplexity('ls src')).toBe('mechanical')
    expect(explainClassification('leia os arquivos e liste tudo').matchedMechanical.length).toBeGreaterThan(0)
    expect(classifyTaskComplexity('x'.repeat(300))).toBe('deep')
    expect(classifyTaskComplexity('ok')).toBe('mechanical')
  })

  it('explains the routing decision', () => {
    const explained = explainClassification('revise a arquitetura do cache')
    expect(explained.complexity).toBe('deep')
    expect(explained.tier).toBe('deep')
    expect(explained.matchedDeep.length).toBeGreaterThan(0)
    expect(explained.matchedMechanical).toEqual([])
  })
})

describe('model tier routing', () => {
  it('maps tiers to cheap vs reasoning models', () => {
    expect(routeTaskToTier('grep por FIXME')).toBe('fast')
    expect(routeTaskToTier('revise a arquitetura')).toBe('deep')
    expect(tierModels('fast')).toContain('gpt-4o-mini')
    expect(tierModels('deep')).toContain('claude-sonnet')
  })
})

describe('explicit provider selection (no automatic fallback)', () => {
  const health = (ready: string[]) =>
    (['codex', 'opencode', 'claude', 'gemini', 'aider', 'agy', 'custom'] as const).map((id) => ({
      id,
      state: ready.includes(id) ? 'ready' : 'missing',
    }))

  it('selects the explicit provider and nothing else', () => {
    expect(orderProvidersForTask('opencode', ['codex', 'opencode', 'claude'])).toEqual(['opencode'])
    expect(orderProvidersForTask('gemini', ['codex', 'gemini', 'claude'])).toEqual(['gemini'])
    expect(orderProvidersForTask('codex', ['codex', 'opencode'])).toEqual(['codex'])
  })

  it('returns an empty list when the explicit provider is not ready', () => {
    expect(orderProvidersForTask('opencode', ['codex', 'claude'])).toEqual([])
    expect(orderProvidersForTask('codex', [])).toEqual([])
  })

  it('never suggests Codex when another provider was chosen', () => {
    expect(providerUnavailableError('opencode', health(['codex', 'claude']))).toMatchObject({
      code: 'provider-not-ready',
      provider: 'opencode',
    })
    expect(providerUnavailableError('opencode', health(['opencode']))).toBeUndefined()
  })

  it('reports an unknown provider as missing and a known one as not ready', () => {
    const withoutOpencode = health(['claude']).filter((item) => item.id !== 'opencode')
    expect(providerUnavailableError('opencode', withoutOpencode)?.code).toBe('provider-missing')
    expect(providerUnavailableError('opencode', health([]))?.code).toBe('provider-not-ready')
  })

  it('resolveAgentProviderWithFallback resolves only the explicit provider', async () => {
    const config = { customPaths: {} } as AppConfig
    const resolved = await resolveAgentProviderWithFallback(config, 'custom')
    expect(resolved.provider).toBe('custom')
    expect(resolved.fellBack).toBe(false)
    expect(resolved.path).toBeNull()
    expect(resolved.message).toContain('Outro CLI')
    expect(await resolveAgentProviderCommand(config, 'custom')).toMatchObject({ path: null })
  })
})

describe('BYOK model routing without leaking keys', () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
  })

  it('validates routing config and rejects garbage', () => {
    expect(validateModelRoutingConfig(undefined)).toBeUndefined()
    expect(() => validateModelRoutingConfig('nope')).toThrow('Configuração de modelos inválida')
    expect(validateModelRoutingConfig({ fastModel: ' ministral-3b ' })).toEqual({ fastModel: 'ministral-3b' })
    expect(validateModelRoutingConfig({})).toBeUndefined()
  })

  it('prefers configured models and env keys without exposing them', () => {
    process.env.OPENAI_API_KEY = 'sk-test-1234567890'
    const resolved = resolveModelForTier('fast', { fastModel: 'ministral-3b' }, process.env)
    expect(resolved).toEqual({ model: 'ministral-3b', authConfigured: true })
    expect(JSON.stringify(resolved)).not.toContain('sk-test')
  })

  it('falls back to default models without auth', () => {
    const resolved = resolveModelForTier('deep', undefined, {})
    expect(resolved.model).toBe('claude-sonnet')
    expect(resolved.authConfigured).toBe(false)
  })

  it('resolves different tiers for different prompts in production flow', async () => {
    const config = { customPaths: {} } as AppConfig
    const fast = await resolveAgentTurn(config, 'opencode', 'liste os arquivos do projeto')
    expect(fast.tier).toBe('fast')
    expect(fast.model).toBe('gpt-4o-mini')
    const deep = await resolveAgentTurn(config, 'opencode', 'refatore a arquitetura do módulo de cache com testes')
    expect(deep.tier).toBe('deep')
    expect(deep.model).toBe('claude-sonnet')
    for (const turn of [fast, deep]) {
      expect(JSON.stringify(turn)).not.toMatch(/sk-/)
      expect(turn.explanation.matchedDeep.length + turn.explanation.matchedMechanical.length).toBeGreaterThan(0)
    }
  })

  it('redacts key material from any payload', () => {
    expect(redactSecrets('key sk-abcdef1234567890 end')).toBe('key [chave omitida] end')
    expect(redactSecrets({ openaiApiKey: 'sk-secret', model: 'x' })).toEqual({
      openaiApiKey: '[chave omitida]',
      model: 'x',
    })
  })
})

describe('resolveAgentTurn explicit provider', () => {
  const config = { customPaths: {} } as AppConfig

  it('keeps the explicit provider and returns a structured error when unavailable', async () => {
    const turn = await resolveAgentTurn(config, 'custom', 'liste os arquivos')
    expect(turn.provider).toBe('custom')
    expect(turn.fellBack).toBe(false)
    expect(turn.available).toBe(false)
    expect(turn.error).toMatchObject({ code: 'provider-not-ready', provider: 'custom' })
    expect(turn.reason).toContain('Outro CLI')
    expect(turn.tier).toBe('fast')
  })

  it('never resolves to Codex when Codex was not the chosen provider', async () => {
    const turn = await resolveAgentTurn(config, 'custom', 'liste os arquivos')
    expect(turn.provider).not.toBe('codex')
    expect(turn.available || turn.error?.provider === 'custom').toBe(true)
  })

  it('keeps Codex explicit when it is the chosen provider', async () => {
    const turn = await resolveAgentTurn(config, 'codex', 'refatore a arquitetura')
    expect(turn.provider).toBe('codex')
    expect(turn.fellBack).toBe(false)
    if (!turn.available) {
      expect(turn.error).toMatchObject({ provider: 'codex' })
    }
  })
})

describe('resolveProviderInvocation', () => {
  it('passes fast and deep models as provider flags with env', () => {
    const fast = resolveProviderInvocation('opencode', '/usr/bin/opencode', 'gpt-4o-mini', 'fast', undefined, {})
    expect(fast).toMatchObject({
      command: '/usr/bin/opencode',
      args: ['--model', 'gpt-4o-mini'],
      env: { DEVORBIT_MODEL: 'gpt-4o-mini', DEVORBIT_MODEL_TIER: 'fast' },
    })
    const deep = resolveProviderInvocation('claude', '/usr/bin/claude', 'claude-sonnet', 'deep', undefined, {})
    expect(deep.args).toEqual(['--model', 'claude-sonnet'])
    expect(deep.env.DEVORBIT_MODEL_TIER).toBe('deep')
  })

  it('forwards the flag through the Windows .cmd wrapper', () => {
    // No Windows os CLIs resolvem para .cmd: a flag tem que atravessar o
    // `call`, senão o modelo nunca chega ao processo real.
    const invocation = resolveProviderInvocation('opencode', 'C:\\cli\\opencode.cmd', 'gpt-4o-mini', 'fast', undefined, {})
    expect(invocation.command).toContain('cmd')
    expect(invocation.args).toEqual(['/d', '/q', '/k', 'call "C:\\cli\\opencode.cmd" --model gpt-4o-mini'])
    expect(invocation.env.DEVORBIT_MODEL).toBe('gpt-4o-mini')
  })

  it('keeps script wrapping env-only without a documented flag', () => {
    const invocation = resolveProviderInvocation('agy', 'C:\\cli\\agy.cmd', 'x-model', 'fast', undefined, {})
    expect(invocation.args).toEqual(['/d', '/q', '/k', 'call "C:\\cli\\agy.cmd"'])
    expect(invocation.env.DEVORBIT_MODEL).toBe('x-model')
  })

  it('rejects unsafe model names before quoting', () => {
    expect(() => resolveProviderInvocation('opencode', '/usr/bin/opencode', 'm --evil', 'fast')).toThrow('Modelo do turno inválido')
    expect(() => resolveProviderInvocation('opencode', '/usr/bin/opencode', 'm"quote', 'fast')).toThrow('Modelo do turno inválido')
    expect(() => resolveProviderInvocation('opencode', '/usr/bin/opencode', '', 'fast')).toThrow('Modelo do turno inválido')
  })

  it('implements the env-only contract for codex and custom CLIs', () => {
    const codex = resolveProviderInvocation('codex', '/usr/bin/codex', 'gpt-6-astra', 'deep', undefined, {})
    expect(codex).toMatchObject({ command: '/usr/bin/codex', args: [] })
    // CLI custom: contrato explícito só via DEVORBIT_MODEL/_TIER, sem chaves.
    const custom = resolveProviderInvocation(
      'custom',
      '/usr/bin/my-agent',
      'ministral-3b',
      'fast',
      { anthropicApiKey: 'sk-custom-key-123' },
      {}
    )
    expect(custom.args).toEqual([])
    expect(custom.env).toEqual({ DEVORBIT_MODEL: 'ministral-3b', DEVORBIT_MODEL_TIER: 'fast' })
    // aider recebe as duas famílias quando presentes.
    const aider = resolveProviderInvocation(
      'aider',
      '/usr/bin/aider',
      'gpt-4o-mini',
      'fast',
      { openaiApiKey: 'sk-oai', anthropicApiKey: 'sk-ant' },
      {}
    )
    expect(aider.args).toEqual(['--model', 'gpt-4o-mini'])
    expect(aider.env).toMatchObject({ OPENAI_API_KEY: 'sk-oai', ANTHROPIC_API_KEY: 'sk-ant' })
  })

  it('never leaks keys through the invocation payload', () => {
    const invocation = resolveProviderInvocation('claude', '/usr/bin/claude', 'x', 'deep', { anthropicApiKey: 'sk-leak-check-999' }, {})
    expect(JSON.stringify({ command: invocation.command, args: invocation.args })).not.toContain('sk-leak-check-999')
  })
})

describe('transient failure classification', () => {
  it('retries only transient errors', () => {
    expect(isTransientProviderError(new Error('request failed with 429 rate limit'))).toBe(true)
    expect(isTransientProviderError(new Error('model overloaded, try later'))).toBe(true)
    expect(isTransientProviderError(Object.assign(new Error('write failed'), { code: 'EPIPE' }))).toBe(true)
    expect(isTransientProviderError(new Error('invalid api key'))).toBe(false)
    expect(isTransientProviderError(new Error('boom'))).toBe(false)
  })

  it('treats a missing binary as unavailable (failover allowed, once each)', () => {
    expect(isTransientProviderError(new Error('spawn ENOENT'))).toBe(true)
    expect(isTransientProviderError(Object.assign(new Error('spawn failed'), { code: 'ENOENT' }))).toBe(true)
  })
})

describe('findTransientSnippet', () => {
  it('extracts the last transient line from output tails', () => {
    expect(findTransientSnippet('ok\nError: 429 rate limit exceeded\n')).toBe('Error: 429 rate limit exceeded')
    expect(findTransientSnippet('service unavailable, retrying')).toBe('service unavailable, retrying')
    expect(findTransientSnippet('all good\nnothing wrong')).toBeUndefined()
    expect(findTransientSnippet('')).toBeUndefined()
    expect(findTransientSnippet(undefined)).toBeUndefined()
  })

  it('lets permanent text win over transient noise', () => {
    expect(findTransientSnippet('429 rate limit\ninvalid api key')).toBeUndefined()
  })

  it('strips terminal colors before classifying and returning the snippet', () => {
    expect(findTransientSnippet('\u001b[31mError: 429 rate limit exceeded\u001b[0m\n')).toBe(
      'Error: 429 rate limit exceeded'
    )
    expect(findTransientSnippet('\u001b[33m429 rate limit\u001b[0m\n\u001b[31minvalid api key\u001b[0m')).toBeUndefined()
    expect(findTransientSnippet('\u001b]0;título\u0007service unavailable, retrying')).toBe('service unavailable, retrying')
  })
})

describe('executeExplicitAgentTurn', () => {
  it('runs only the explicit provider, even on a transient failure', async () => {
    const calls: string[] = []
    await expect(
      executeExplicitAgentTurn('opencode', async (provider) => {
        calls.push(provider)
        throw new Error('429 rate limit exceeded')
      })
    ).rejects.toThrow('Turno falhou com opencode')
    expect(calls).toEqual(['opencode'])
  })

  it('never swaps to Codex when the explicit provider fails', async () => {
    const calls: string[] = []
    await expect(
      executeExplicitAgentTurn('opencode', async (provider) => {
        calls.push(provider)
        throw new Error('service unavailable')
      })
    ).rejects.toMatchObject({ code: 'provider-failed', provider: 'opencode' })
    expect(calls).toEqual(['opencode'])
    expect(calls).not.toContain('codex')
  })

  it('returns the explicit provider, result and a single successful attempt', async () => {
    const execution = await executeExplicitAgentTurn('claude', async () => 'ok')
    expect(execution).toEqual({
      provider: 'claude',
      result: 'ok',
      attempts: [{ provider: 'claude', ok: true }],
    })
  })
})

describe('TypeSafe shadow tier classification', () => {
  const answer = (tier: string, confidence: number, probabilities?: Record<string, number>) => {
    // Distribuição coerente: soma 1 e a opção escolhida é o máximo.
    const top = Math.max(confidence, 1 / 3)
    const remainder = (1 - top) / 2
    return {
      type: 'choice',
      choice: tier,
      confidence,
      probabilities: probabilities ?? {
        fast: remainder,
        deep: remainder,
        review: remainder,
        [tier]: top,
      },
    }
  }

  const shadowSubscriptions: Array<() => void> = []
  const subscribeShadow = (listener: ShadowObservationListener) => {
    const unsubscribe = onShadowObservation(listener)
    shadowSubscriptions.push(unsubscribe)
    return unsubscribe
  }

  afterEach(() => {
    for (const unsubscribe of shadowSubscriptions.splice(0)) unsubscribe()
    resetShadowRoutingState()
    setShadowEnvSnapshotForTests({ enabled: false })
  })

  it('sanitizes the state: strips ANSI/control chars, trims and caps the length', () => {
    expect(sanitizePromptForJudgment('\u001b[31mgrep\u001b[0m por TODO\u0007')).toBe('grep por TODO')
    expect(sanitizePromptForJudgment('\u001b]0;título\u0007listar arquivos da pasta')).toBe('listar arquivos da pasta')
    expect(sanitizePromptForJudgment('\u001b[38:5:196mrodar testes\u001b[0m')).toBe('rodar testes')
    expect(sanitizePromptForJudgment('\u001bP1;2|payload\u001b\\rodar build')).toBe('rodar build')
    expect(sanitizePromptForJudgment('x'.repeat(SHADOW_MAX_STATE_CHARS + 500))?.length).toBe(
      SHADOW_MAX_STATE_CHARS
    )
    expect(sanitizePromptForJudgment('   ')).toBeUndefined()
    expect(sanitizePromptForJudgment(undefined)).toBeUndefined()
  })

  it('records a high-confidence judgment and never persists the raw prompt', async () => {
    const calls: string[] = []
    const result = await classifyPromptShadow('refatore a camada de cache do projeto', {
      judge: async (state) => {
        calls.push(state)
        return answer('deep', 0.92)
      },
    })

    expect(result).toMatchObject({ tier: 'deep', confident: true, cacheHit: false })
    expect(result?.confidence).toBe(0.92)
    expect(calls).toEqual(['refatore a camada de cache do projeto'])
    expect(getShadowObservations().at(-1)).toMatchObject({
      outcome: 'ok',
      heuristicTier: 'deep',
      tier: 'deep',
      cacheHit: false,
    })
    expect(JSON.stringify(getShadowObservations())).not.toContain('refatore a camada de cache')
  })

  it('keeps low-confidence judgments flagged instead of gating them', async () => {
    const result = await classifyPromptShadow('analise os riscos deste diff', {
      judge: async () => answer('review', 0.3, { fast: 0.33, deep: 0.33, review: 0.34 }),
    })

    expect(result).toMatchObject({ tier: 'review', confident: false })
    expect(result?.probabilities.review).toBe(0.34)
    expect(getShadowObservations().at(-1)).toMatchObject({ outcome: 'ok', tier: 'review' })
  })

  it('times out on a stalled judge and degrades without throwing', async () => {
    const result = await classifyPromptShadow('liste os arquivos do projeto', {
      judge: () => new Promise(() => undefined),
      timeoutMs: 30,
    })

    expect(result).toBeUndefined()
    expect(getShadowObservations().at(-1)?.outcome).toBe('timeout')
    expect(getShadowRoutingStats().consecutiveFailures).toBe(1)
  })

  it('treats malformed answers as invalid', async () => {
    const invalidAnswers: unknown[] = [
      { type: 'choice', choice: 'unknown', confidence: 0.9, probabilities: { fast: 0, deep: 0, review: 0 } },
      { type: 'choice', choice: 'deep', confidence: Number.NaN, probabilities: { fast: 0, deep: 1, review: 0 } },
      { type: 'choice', choice: 'deep', confidence: 0.8 },
      { choice: 'deep', confidence: 0.8, probabilities: { fast: 0.1, deep: 0.8, review: 0.1 } },
      { type: 'score', score: 1.2, confidence: 0.8, probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 } },
      { type: 'choice', choice: 'deep', confidence: 0.5, probabilities: { fast: 0.5, deep: 0.5, review: 0.5 } },
      { type: 'choice', choice: 'deep', confidence: 0.2, probabilities: { fast: 0.6, deep: 0.2, review: 0.2 } },
      {
        type: 'choice',
        choice: 'deep',
        confidence: 0.8,
        probabilities: { fast: 0.1, deep: 0.8, review: 0.05, other: 0.05 },
      },
      null,
    ]

    for (const [index, invalid] of invalidAnswers.entries()) {
      const result = await classifyPromptShadow(`tarefa mecanica numero ${index}`, {
        judge: async () => invalid,
        // Sem abrir o circuito no meio da lista: cada payload é classificado.
        breakerFailureThreshold: invalidAnswers.length + 1,
      })
      expect(result).toBeUndefined()
      expect(getShadowObservations().at(-1)?.outcome).toBe('invalid')
    }
  })

  it('captures judge errors as observations without throwing', async () => {
    const result = await classifyPromptShadow('liste os arquivos', {
      judge: async () => {
        throw new Error('provider down')
      },
    })

    expect(result).toBeUndefined()
    expect(getShadowObservations().at(-1)?.outcome).toBe('error')
  })

  it('skips silently when the pilot is off (no judge, no network)', async () => {
    setShadowEnvSnapshotForTests({ enabled: false })
    const savedKey = process.env.TYPESAFE_API_KEY
    const savedFlag = process.env.DEVORBIT_TYPESAFE_SHADOW
    delete process.env.TYPESAFE_API_KEY
    delete process.env.DEVORBIT_TYPESAFE_SHADOW
    try {
      const result = await classifyPromptShadow('liste os arquivos')
      expect(result).toBeUndefined()
      expect(getShadowObservations().at(-1)?.outcome).toBe('skipped')
    } finally {
      if (savedKey !== undefined) process.env.TYPESAFE_API_KEY = savedKey
      if (savedFlag !== undefined) process.env.DEVORBIT_TYPESAFE_SHADOW = savedFlag
    }
  })

  it('exposes existing aggregate observations to a local listener and supports removal', async () => {
    const seen: Array<Record<string, unknown>> = []
    const unsubscribe = subscribeShadow((observation) => {
      seen.push({ ...observation })
    })

    const result = await classifyPromptShadow('liste os arquivos do projeto', {
      judge: async () => answer('fast', 0.9),
    })

    expect(result?.tier).toBe('fast')
    expect(seen).toHaveLength(1)
    expect(Object.keys(seen[0]).sort()).toEqual([
      'at',
      'cacheHit',
      'confidence',
      'heuristicTier',
      'latencyMs',
      'outcome',
      'promptChars',
      'tier',
    ])
    expect(seen[0]).toMatchObject({
      outcome: 'ok',
      heuristicTier: 'fast',
      tier: 'fast',
      cacheHit: false,
    })
    expect(JSON.stringify(seen)).not.toContain('liste os arquivos')

    unsubscribe()
    await classifyPromptShadow('outro prompt qualquer', {
      judge: async () => answer('fast', 0.9),
    })
    expect(seen).toHaveLength(1)
  })

  it('isolates a faulty listener and never exposes prompt, path or token', async () => {
    const payloads: string[] = []
    subscribeShadow(() => {
      throw new Error('listener quebrado')
    })
    const unsubscribe = subscribeShadow((observation) => {
      payloads.push(JSON.stringify(observation))
    })

    const result = await classifyPromptShadow(
      'chave sk-live-abcdef1234567890 em C:\\Users\\me\\repo\\a.ts',
      { judge: async () => answer('deep', 0.9) }
    )

    expect(result?.tier).toBe('deep')
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).not.toContain('sk-live')
    expect(payloads[0]).not.toContain('C:\\Users')
    expect(payloads[0]).not.toContain('repo')
    unsubscribe()
  })

  it('caches by prompt hash, honors the TTL and stays bounded', async () => {
    let calls = 0
    let clock = 1_000
    const deps = {
      judge: async () => {
        calls += 1
        return answer('fast', 0.9)
      },
      now: () => clock,
      cacheTtlMs: 1_000,
      cacheMaxEntries: 2,
    }

    const first = await classifyPromptShadow('liste os arquivos do projeto', deps)
    expect(first?.cacheHit).toBe(false)
    const second = await classifyPromptShadow('liste os arquivos do projeto', deps)
    expect(second?.cacheHit).toBe(true)
    expect(calls).toBe(1)

    clock += 1_001
    const expired = await classifyPromptShadow('liste os arquivos do projeto', deps)
    expect(expired?.cacheHit).toBe(false)
    expect(calls).toBe(2)

    await classifyPromptShadow('prompt a', deps)
    await classifyPromptShadow('prompt b', deps)
    expect(getShadowRoutingStats().cacheSize).toBe(2)
  })

  it('opens the circuit after consecutive failures and probes again after cooldown', async () => {
    let calls = 0
    let clock = 0
    const deps = {
      judge: async () => {
        calls += 1
        if (calls <= 2) throw new Error('provider down')
        return answer('deep', 0.8)
      },
      now: () => clock,
      breakerFailureThreshold: 2,
      breakerCooldownMs: 1_000,
    }

    expect(await classifyPromptShadow('falha um', deps)).toBeUndefined()
    expect(await classifyPromptShadow('falha dois', deps)).toBeUndefined()
    expect(await classifyPromptShadow('falha tres', deps)).toBeUndefined()
    expect(calls).toBe(2)
    expect(getShadowObservations().at(-1)?.outcome).toBe('circuit-open')

    clock += 1_001
    const recovered = await classifyPromptShadow('recuperado', deps)
    expect(recovered?.tier).toBe('deep')
    expect(getShadowRoutingStats()).toMatchObject({ consecutiveFailures: 0, circuitOpenUntil: 0 })
  })

  it('only builds the production judge with the flag and key in the main env', () => {
    expect(createTypeSafeShadowJudge({})).toBeUndefined()
    expect(createTypeSafeShadowJudge({ TYPESAFE_API_KEY: 'ts-test' })).toBeUndefined()
    expect(
      createTypeSafeShadowJudge({ TYPESAFE_API_KEY: 'ts-test', DEVORBIT_TYPESAFE_SHADOW: '1' })
    ).toBeTypeOf('function')
    expect(
      isShadowRoutingEnabled({ TYPESAFE_API_KEY: 'ts-test', DEVORBIT_TYPESAFE_SHADOW: '1' })
    ).toBe(true)
    expect(isShadowRoutingEnabled({ TYPESAFE_API_KEY: '   ', DEVORBIT_TYPESAFE_SHADOW: '1' })).toBe(
      false
    )
  })

  it('uses the documented request shape through the real SDK boundary (fake fetch, no network)', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const judge = createTypeSafeShadowJudge(
      { TYPESAFE_API_KEY: 'ts-test-key', DEVORBIT_TYPESAFE_SHADOW: '1' },
      async (url, init) => {
        requests.push({ url, init })
        return new Response(
          JSON.stringify({
            model: 'jev-latest',
            answers: {
              tier: {
                type: 'choice',
                choice: 'review',
                confidence: 0.7,
                probabilities: { fast: 0.1, deep: 0.2, review: 0.7 },
              },
            },
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
    )
    if (!judge) throw new Error('judge de produção não construído')

    const raw = await judge('revise este PR com foco em segurança', new AbortController().signal)

    expect(raw).toMatchObject({ choice: 'review', confidence: 0.7 })
    expect(requests[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
    const body = JSON.parse(String(requests[0]?.init?.body)) as {
      model: string
      state: { prompt: string }
      questions: { tier: { type: string; criteria: Record<string, unknown> } }
    }
    expect(body.model).toBe('jev-latest')
    expect(body.state.prompt).toBe('revise este PR com foco em segurança')
    expect(body.questions.tier.type).toBe('choice')
    expect(Object.keys(body.questions.tier.criteria).sort()).toEqual(['deep', 'fast', 'review'])
    const headers = requests[0]?.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer ts-test-key')
    expect(JSON.stringify(raw)).not.toContain('ts-test-key')
  })

  it('exposes the redaction policy as a pure function', () => {
    const output = redactPromptForJudgment(
      [
        'chave: sk-abcdef12345678 senha: "s3cr3t-pass" Bearer abcdefghijklmnop',
        'C:\\Users\\me\\repo\\a.ts /home/me/repo/b.ts /tmp/cache.json /var/log/app.log /workspace/proj/src/app.ts',
        'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 github_pat_11ABCDEFG0abcdefghijklmnopqrst',
        'glpat-abcdefghijklmnopqrst npm_abcdefghijklmnopqrstuvwxyz0123456789',
        'xoxb-123456789012-abcdefghijklmnop xoxp-987654321098-zyxwvutsrqponmlkjih',
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      ].join('\n')
    )

    for (const secret of [
      'sk-abcdef12345678',
      's3cr3t-pass',
      'abcdefghijklmnop',
      'C:\\Users\\me',
      '/home/me',
      '/tmp/cache.json',
      '/var/log/app.log',
      '/workspace/proj',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      'github_pat_11ABCDEFG0abcdefghijklmnopqrst',
      'glpat-abcdefghijklmnopqrst',
      'npm_abcdefghijklmnopqrstuvwxyz0123456789',
      'xoxb-123456789012-abcdefghijklmnop',
      'xoxp-987654321098-zyxwvutsrqponmlkjih',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    ]) {
      expect(output).not.toContain(secret)
    }
    expect(output).toContain('omitido')
  })

  it('redacts secret fields serialized as quoted or escaped JSON', () => {
    const quoted = redactPromptForJudgment(
      '{"password":"segredo-1234","api_key":"sk-live-abcdef123456","client_secret":"cs-9876543210"}'
    )
    for (const secret of ['segredo-1234', 'sk-live-abcdef123456', 'cs-9876543210']) {
      expect(quoted).not.toContain(secret)
    }
    expect(quoted).toContain('"password":')
    expect(quoted).toContain('omitido')

    const escaped = redactPromptForJudgment('{\\"password\\":\\"segredo-5678\\",\\"token\\":\\"tok-abcdef1234\\"}')
    for (const secret of ['segredo-5678', 'tok-abcdef1234']) {
      expect(escaped).not.toContain(secret)
    }
    expect(escaped).toContain('omitido')
  })

  it('redacts prompt secrets before the judge boundary', async () => {
    let seen = ''
    const prompt = [
      'corrija o bug usando a chave sk-live-abcdef1234567890',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdef.ghijkl',
      'senha=hunter2-super-secreta',
      'em C:\\Users\\adenilson.j\\Projects\\DevOrbit\\src\\main\\index.ts',
    ].join('\n')

    const result = await classifyPromptShadow(prompt, {
      judge: async (state) => {
        seen = state
        return answer('deep', 0.9)
      },
    })

    expect(result).toMatchObject({ tier: 'deep', confident: true })
    for (const secret of [
      'sk-live-abcdef1234567890',
      'eyJhbGciOiJIUzI1NiJ9',
      'hunter2-super-secreta',
      'adenilson.j',
      'C:\\Users',
    ]) {
      expect(seen).not.toContain(secret)
    }
    expect(seen).toContain('omitido')
    expect(getShadowObservations().at(-1)).toMatchObject({ outcome: 'ok', tier: 'deep' })
  })

  it('never forwards prompt secrets through the real SDK boundary (fake fetch)', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const judge = createTypeSafeShadowJudge(
      { TYPESAFE_API_KEY: 'ts-test-key', DEVORBIT_TYPESAFE_SHADOW: '1' },
      async (url, init) => {
        requests.push({ url, init })
        return new Response(
          JSON.stringify({
            model: 'jev-latest',
            answers: {
              tier: {
                type: 'choice',
                choice: 'review',
                confidence: 0.7,
                probabilities: { fast: 0.1, deep: 0.2, review: 0.7 },
              },
            },
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
    )
    if (!judge) throw new Error('judge de produção não construído')

    const prompt =
      'revise C:\\Users\\adenilson.j\\repo\\src\\a.ts com token Bearer abcd1234efgh5678 e senha=hunter2-super-secreta usando sk-live-abcdef1234567890'
    const result = await classifyPromptShadow(prompt, { judge })

    expect(result).toMatchObject({ tier: 'review', confident: true })
    expect(requests).toHaveLength(1)
    const body = String(requests[0]?.init?.body)
    for (const secret of [
      'sk-live-abcdef1234567890',
      'abcd1234efgh5678',
      'hunter2-super-secreta',
      'adenilson.j',
    ]) {
      expect(body).not.toContain(secret)
      expect(JSON.stringify(requests[0])).not.toContain(secret)
    }
    expect(body).toContain('omitido')
  })

  it('never forwards POSIX paths or raw provider tokens to the fetch fake', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const judge = createTypeSafeShadowJudge(
      { TYPESAFE_API_KEY: 'ts-test-key', DEVORBIT_TYPESAFE_SHADOW: '1' },
      async (url, init) => {
        requests.push({ url, init })
        return new Response(
          JSON.stringify({
            model: 'jev-latest',
            answers: {
              tier: {
                type: 'choice',
                choice: 'review',
                confidence: 0.7,
                probabilities: { fast: 0.1, deep: 0.2, review: 0.7 },
              },
            },
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
    )
    if (!judge) throw new Error('judge de produção não construído')

    const secrets = [
      '/tmp/devorbit-session/cache.json',
      '/var/log/agent.log',
      '/workspace/proj/src/app.ts',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyzABCD',
      'glpat-abcdefghijklmnopqrst',
      'npm_abcdefghijklmnopqrstuvwxyz0123456789',
      'xoxb-123456789012-abcdefghijklmnopqrstuvwx',
      'xoxp-987654321098-zyxwvutsrqponmlkjihgfedc',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ]
    const result = await classifyPromptShadow(`revise o deploy lendo ${secrets.join(' e ')}`, {
      judge,
    })

    expect(result).toMatchObject({ tier: 'review', confident: true })
    expect(requests).toHaveLength(1)
    const body = String(requests[0]?.init?.body)
    for (const secret of secrets) {
      expect(body).not.toContain(secret)
    }
    expect(body).toContain('omitido')
  })

  it('leaves the product decision untouched when the shadow judge disagrees', async () => {
    const config = { customPaths: {} } as AppConfig
    const turn = await resolveAgentTurn(config, 'opencode', 'liste os arquivos do projeto', {
      judge: async () => answer('review', 0.99),
    })

    expect(turn.tier).toBe('fast')
    expect(turn.model).toBe('gpt-4o-mini')
    await vi.waitFor(() => {
      expect(getShadowObservations().some((entry) => entry.tier === 'review')).toBe(true)
    })
  })
})

describe('TypeSafe env isolation for child processes', () => {
  it('scrubs the pilot variables from the turn env and preserves the others', () => {
    expect(SHADOW_ENV_VARIABLES).toEqual(['TYPESAFE_API_KEY', 'DEVORBIT_TYPESAFE_SHADOW'])

    const baseEnv: NodeJS.ProcessEnv = {
      PATH: 'C:\\tools',
      ANTHROPIC_API_KEY: 'sk-anthropic',
      TYPESAFE_API_KEY: 'ts-secret-key',
      DEVORBIT_TYPESAFE_SHADOW: '1',
    }

    const env = buildAgentTurnEnv('claude', 'claude-sonnet', 'deep', undefined, baseEnv)

    expect(env).toEqual({
      DEVORBIT_MODEL: 'claude-sonnet',
      DEVORBIT_MODEL_TIER: 'deep',
      ANTHROPIC_API_KEY: 'sk-anthropic',
    })
    expect(baseEnv).not.toHaveProperty('TYPESAFE_API_KEY')
    expect(baseEnv).not.toHaveProperty('DEVORBIT_TYPESAFE_SHADOW')
    expect(baseEnv.PATH).toBe('C:\\tools')
  })

  it('keeps the effective PTY env (base merged with the turn env) without the pilot keys', () => {
    const baseEnv: NodeJS.ProcessEnv = {
      PATH: 'C:\\tools',
      TYPESAFE_API_KEY: 'ts-secret-key',
      DEVORBIT_TYPESAFE_SHADOW: '1',
    }

    const invocation = resolveProviderInvocation(
      'claude',
      '/usr/bin/claude',
      'x-model',
      'deep',
      undefined,
      baseEnv
    )
    const childEnv = { ...baseEnv, ...invocation.env }

    expect(childEnv).not.toHaveProperty('TYPESAFE_API_KEY')
    expect(childEnv).not.toHaveProperty('DEVORBIT_TYPESAFE_SHADOW')
    expect(childEnv.PATH).toBe('C:\\tools')
    expect(childEnv.DEVORBIT_MODEL).toBe('x-model')
  })

  it('reads the key for the main-process judge and scrubs the source env', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: 'C:\\tools',
      TYPESAFE_API_KEY: 'ts-judge-key',
      DEVORBIT_TYPESAFE_SHADOW: '1',
    }

    const judge = createTypeSafeShadowJudge(env)

    expect(judge).toBeTypeOf('function')
    expect(env).not.toHaveProperty('TYPESAFE_API_KEY')
    expect(env).not.toHaveProperty('DEVORBIT_TYPESAFE_SHADOW')
    expect(env.PATH).toBe('C:\\tools')
  })

  it('keeps the main-process decision in a snapshot, not in the inherited env', () => {
    setShadowEnvSnapshotForTests({ apiKey: 'ts-snapshot-key', enabled: true })
    try {
      expect(isShadowRoutingEnabled()).toBe(true)
    } finally {
      setShadowEnvSnapshotForTests({ enabled: false })
    }
    expect(isShadowRoutingEnabled()).toBe(false)
  })
})
