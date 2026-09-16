import { describe, expect, it, vi, afterEach } from 'vitest'
import type { AppConfig } from '../src/renderer/src/types'
import {
  classifyTaskComplexity,
  executeAgentTurnWithFallback,
  explainClassification,
  findTransientSnippet,
  isTransientProviderError,
  orderProvidersForTask,
  redactSecrets,
  resolveAgentTurn,
  resolveModelForTier,
  resolveProviderInvocation,
  routeTaskToTier,
  selectProviderWithFallback,
  tierModels,
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

describe('multi-provider fallback', () => {
  const health = (ready: string[]) =>
    (['codex', 'opencode', 'claude', 'gemini', 'aider', 'agy', 'custom'] as const).map((id) => ({
      id,
      state: ready.includes(id) ? 'ready' : 'missing',
    }))

  it('keeps the preferred provider when ready', () => {
    expect(selectProviderWithFallback('opencode', health(['codex', 'opencode']))).toEqual({
      provider: 'opencode',
      fellBack: false,
    })
  })

  it('falls back to the next ready provider when the preferred is missing', () => {
    const selected = selectProviderWithFallback('opencode', health(['codex', 'claude']))
    expect(selected.provider).toBe('codex')
    expect(selected.fellBack).toBe(true)
  })

  it('orders preferred first and preserves deterministic fallback order', () => {
    expect(orderProvidersForTask('gemini', ['codex', 'gemini', 'claude'])).toEqual([
      'gemini',
      'codex',
      'claude',
    ])
  })

  it('returns the preferred id when nothing is ready', () => {
    expect(selectProviderWithFallback('codex', health([]))).toEqual({
      provider: 'codex',
      fellBack: false,
    })
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
})

describe('executeAgentTurnWithFallback', () => {
  it('fails over from a rate-limited primary to the fallback', async () => {
    const calls: string[] = []
    const execution = await executeAgentTurnWithFallback(['opencode', 'codex'], async (provider) => {
      calls.push(provider)
      if (provider === 'opencode') throw new Error('429 rate limit exceeded')
      return `ok-${provider}`
    })
    expect(execution.provider).toBe('codex')
    expect(execution.result).toBe('ok-codex')
    expect(execution.attempts).toEqual([
      { provider: 'opencode', ok: false, error: '429 rate limit exceeded' },
      { provider: 'codex', ok: true },
    ])
    expect(calls).toEqual(['opencode', 'codex'])
  })

  it('does not retry permanent errors', async () => {
    const calls: string[] = []
    await expect(
      executeAgentTurnWithFallback(['opencode', 'codex'], async (provider) => {
        calls.push(provider)
        throw new Error('invalid api key')
      })
    ).rejects.toThrow('Turno falhou em 1 provedor')
    expect(calls).toEqual(['opencode'])
  })

  it('aggregates when every provider fails transiently', async () => {
    await expect(
      executeAgentTurnWithFallback(['aider', 'agy'] as never, async () => {
        throw new Error('service unavailable')
      })
    ).rejects.toThrow('Turno falhou em 2 provedor')
  })
})
