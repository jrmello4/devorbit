import { describe, expect, it, vi } from 'vitest'
import {
  buildAgentTurnEnv,
  createResultWaiter,
  resetTurnQueues,
  sendAgentTurn,
  spawnAgentProviderTerminal,
  type TurnDependencies,
  type TurnWaiter,
} from '../src/main/agent-turn'
import type { AgentProviderId, AppConfig } from '../src/renderer/src/types'
import type { TerminalEvent } from '../src/main/terminal-session'

function createHarness(options: {
  waiters?: TurnWaiter[]
  spawns?: Array<{ id: string; provider: AgentProviderId }>
  failSpawn?: (provider: AgentProviderId) => Error | null
  tier?: 'fast' | 'deep'
  model?: string
} = {}) {
  const sessions = new Map<string, { provider: AgentProviderId; model: string }>()
  const live = new Set<string>()
  const spawns: Array<{ id: string; provider: AgentProviderId }> = options.spawns || []
  const writes: Array<{ id: string; input: string }> = []
  const waiters = [...(options.waiters || [])]
  const failSpawn = options.failSpawn || (() => null)
  const deps: TurnDependencies = {
    getSession: (id) => sessions.get(id),
    setSession: (id, session) => sessions.set(id, session),
    clearSession: (id) => sessions.delete(id),
    hasTerminal: (id) => live.has(id),
    spawn: vi.fn(async (id: string, turn: { provider: AgentProviderId; model: string; tier: 'fast' | 'deep' }) => {
      const failure = failSpawn(turn.provider)
      if (failure) throw failure
      live.add(id)
      spawns.push({ id, provider: turn.provider })
    }),
    write: vi.fn((id: string, input: string) => {
      writes.push({ id, input })
      return live.has(id)
    }),
    waitResult: vi.fn(async () => waiters.shift() || { timedOut: true }),
    resolveTurn: async (provider: AgentProviderId) => ({
      tier: options.tier || 'fast',
      model: options.model || 'gpt-4o-mini',
      provider,
      fellBack: false,
    }),
    // Seleção explícita: só o provedor escolhido, nunca outro em fallback.
    orderProviders: (preferred, ready) => (ready.includes(preferred) ? [preferred] : []),
    readyProviders: async () => ['opencode', 'codex', 'claude'] as AgentProviderId[],
  }
  return { deps, sessions, live, spawns, writes }
}

describe('buildAgentTurnEnv', () => {
  it('applies model/tier and maps BYOK keys per family without leaking', () => {
    const env = buildAgentTurnEnv('claude', 'claude-sonnet', 'deep', { anthropicApiKey: 'sk-ant-secret-123' }, {})
    expect(env).toMatchObject({
      DEVORBIT_MODEL: 'claude-sonnet',
      DEVORBIT_MODEL_TIER: 'deep',
      ANTHROPIC_API_KEY: 'sk-ant-secret-123',
    })
    expect(env.OPENAI_API_KEY).toBeUndefined()
  })

  it('prefers config keys over process env', () => {
    const env = buildAgentTurnEnv('codex', 'gpt-4o-mini', 'fast', { openaiApiKey: 'sk-cfg' }, { OPENAI_API_KEY: 'sk-env' } as NodeJS.ProcessEnv)
    expect(env.OPENAI_API_KEY).toBe('sk-cfg')
  })

  it('omits key vars when nothing is configured', () => {
    const env = buildAgentTurnEnv('agy', 'x', 'fast', undefined, {})
    expect(env).toEqual({ DEVORBIT_MODEL: 'x', DEVORBIT_MODEL_TIER: 'fast' })
  })
})

describe('sendAgentTurn', () => {
  it('two prompts can route to different tiers with their own env', async () => {
    resetTurnQueues()
    const seen: Array<{ tier: string; model: string }> = []
    const first = createHarness({
      tier: 'fast',
      model: 'gpt-4o-mini',
      waiters: [{ result: 'CONCLUIDO: ok' }],
    })
    const outcomeFast = await sendAgentTurn(first.deps, {
      terminalId: 'turn-one',
      provider: 'opencode',
      prompt: 'liste os arquivos',
    })
    expect(outcomeFast).toMatchObject({ provider: 'opencode', tier: 'fast', model: 'gpt-4o-mini' })
    seen.push({ tier: outcomeFast.tier, model: outcomeFast.model })

    resetTurnQueues()
    const second = createHarness({
      tier: 'deep',
      model: 'claude-sonnet',
      waiters: [{ result: 'CONCLUIDO: plano pronto' }],
    })
    const outcomeDeep = await sendAgentTurn(second.deps, {
      terminalId: 'turn-two',
      provider: 'opencode',
      prompt: 'refatore a arquitetura do cache',
    })
    seen.push({ tier: outcomeDeep.tier, model: outcomeDeep.model })
    expect(seen).toEqual([
      { tier: 'fast', model: 'gpt-4o-mini' },
      { tier: 'deep', model: 'claude-sonnet' },
    ])
    resetTurnQueues()
  })

  it('does not fail over to another provider on a transient post-spawn error', async () => {
    resetTurnQueues()
    const harness = createHarness({
      waiters: [{ error: 'request failed 429 rate limit, retry later' }],
    })
    await expect(sendAgentTurn(harness.deps, {
      terminalId: 'turn-no-failover',
      provider: 'opencode',
      prompt: 'faça algo',
    })).rejects.toThrow(/rate limit/i)
    expect(harness.spawns).toEqual([{ id: 'turn-no-failover', provider: 'opencode' }])
    expect(harness.writes.map((entry) => entry.id)).toEqual(['turn-no-failover'])
    resetTurnQueues()
  })

  it('does not fail over when the CLI prints rate limit and exits 0 without a marker', async () => {
    resetTurnQueues()
    const harness = createHarness({
      waiters: [{ code: 0, tail: 'working...\nError: 429 rate limit exceeded, retry later' }],
    })
    await expect(sendAgentTurn(harness.deps, {
      terminalId: 'turn-text-no-failover',
      provider: 'opencode',
      prompt: 'faça algo',
    })).rejects.toThrow(/rate limit/i)
    expect(harness.spawns).toHaveLength(1)
    expect(harness.spawns[0]).toEqual({ id: 'turn-text-no-failover', provider: 'opencode' })
    resetTurnQueues()
  })

  it('does not retry when the output shows a permanent auth error', async () => {
    resetTurnQueues()
    const harness = createHarness({
      waiters: [{ code: 1, tail: 'Error: invalid api key for provider' }],
    })
    await expect(sendAgentTurn(harness.deps, {
      terminalId: 'turn-text-perm',
      provider: 'opencode',
      prompt: 'faça algo',
    })).rejects.toThrow('invalid api key')
    expect(harness.spawns).toHaveLength(1)
    resetTurnQueues()
  })

  it('does not retry permanent errors', async () => {
    resetTurnQueues()
    const harness = createHarness({
      waiters: [{ error: 'invalid api key for provider' }],
    })
    await expect(sendAgentTurn(harness.deps, {
      terminalId: 'turn-perm',
      provider: 'opencode',
      prompt: 'faça algo',
    })).rejects.toThrow('invalid api key')
    expect(harness.spawns).toHaveLength(1)
    resetTurnQueues()
  })

  it('returns blocked markers without failover', async () => {
    resetTurnQueues()
    const harness = createHarness({
      waiters: [{ blocked: 'BLOQUEADO: sem credencial' }],
    })
    const outcome = await sendAgentTurn(harness.deps, {
      terminalId: 'turn-blocked',
      provider: 'opencode',
      prompt: 'faça algo',
    })
    expect(outcome.blocked).toBe('BLOQUEADO: sem credencial')
    expect(harness.spawns).toHaveLength(1)
    resetTurnQueues()
  })

  it('does not advance or fail over after an invalid result without a legacy mirror', async () => {
    resetTurnQueues()
    const harness = createHarness({ waiters: [{ code: 0, invalidResult: 'invalid-json' }] })
    harness.deps.orderProviders = () => ['opencode', 'claude'] as AgentProviderId[]
    await expect(sendAgentTurn(harness.deps, {
      terminalId: 'turn-invalid-result',
      provider: 'opencode',
      prompt: 'faÃ§a algo',
    })).rejects.toThrow('Resultado DEVORBIT_RESULT')
    expect(harness.spawns).toHaveLength(1)
    resetTurnQueues()
  })

  it('reuses a running terminal with matching provider and model', async () => {
    resetTurnQueues()
    const harness = createHarness({
      model: 'gpt-4o-mini',
      waiters: [{ result: 'ok' }],
    })
    harness.live.add('turn-reuse')
    harness.sessions.set('turn-reuse', { provider: 'opencode', model: 'gpt-4o-mini' })
    await sendAgentTurn(harness.deps, { terminalId: 'turn-reuse', provider: 'opencode', prompt: 'oi' })
    expect(harness.spawns).toHaveLength(0)
    resetTurnQueues()
  })

  it('rejects a spawn that returns a different provider (explicit provider enforced)', async () => {
    resetTurnQueues()
    const harness = createHarness({ waiters: [{ result: 'CONCLUIDO: ok' }] })
    harness.deps.spawn = vi.fn(async (id: string) => {
      harness.live.add(id)
      harness.spawns.push({ id, provider: 'claude' as AgentProviderId })
      return { provider: 'claude' as AgentProviderId }
    })
    await expect(sendAgentTurn(harness.deps, {
      terminalId: 'turn-provider-swap',
      provider: 'opencode',
      prompt: 'refatore a arquitetura',
    })).rejects.toMatchObject({ code: 'provider-mismatch', provider: 'opencode' })
    expect(harness.writes).toHaveLength(0)
    expect(harness.sessions.has('turn-provider-swap')).toBe(false)
    resetTurnQueues()
  })

  it('never spawns another provider even if the ordered list is stale', async () => {
    resetTurnQueues()
    const harness = createHarness({
      waiters: [{ error: '429 rate limit exceeded' }],
    })
    harness.deps.orderProviders = () => ['opencode', 'claude'] as AgentProviderId[]
    await expect(sendAgentTurn(harness.deps, {
      terminalId: 'turn-stale-list',
      provider: 'opencode',
      prompt: 'faça algo',
    })).rejects.toThrow('rate limit')
    expect(harness.spawns).toEqual([{ id: 'turn-stale-list', provider: 'opencode' }])
    resetTurnQueues()
  })
})

describe('waiter integrado ao turno via eventos reais', () => {  function createLiveHarness() {
    const listeners = new Set<(event: TerminalEvent) => void>()
    const base = createHarness({
      waiters: [],
    })
    base.deps.waitResult = createResultWaiter((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    })
    const emit = (event: TerminalEvent) => listeners.forEach((listener) => listener(event))
    return { ...base, emit }
  }

  it('rate limit impresso + exit 0 falham sem trocar de provedor', async () => {
    resetTurnQueues()
    const harness = createLiveHarness()
    const pending = sendAgentTurn(harness.deps, {
      terminalId: 'turn-live-no-failover',
      provider: 'opencode',
      prompt: 'faça algo',
    })
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThan(0))
    harness.emit({ id: 'turn-live-no-failover', type: 'data', data: 'Error: 429 rate limit exceeded\n' })
    harness.emit({ id: 'turn-live-no-failover', type: 'exit', code: 0 })
    await expect(pending).rejects.toThrow(/rate limit/i)
    expect(harness.spawns).toEqual([{ id: 'turn-live-no-failover', provider: 'opencode' }])
    expect(harness.writes).toHaveLength(1)
    resetTurnQueues()
  })

  it('texto permanente de autenticação não retenta no fluxo real', async () => {
    resetTurnQueues()
    const harness = createLiveHarness()
    const pending = sendAgentTurn(harness.deps, {
      terminalId: 'turn-live-perm',
      provider: 'opencode',
      prompt: 'faça algo',
    })
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThan(0))
    harness.emit({ id: 'turn-live-perm', type: 'data', data: 'Error: invalid api key\n' })
    harness.emit({ id: 'turn-live-perm', type: 'exit', code: 1 })
    await expect(pending).rejects.toThrow('invalid api key')
    expect(harness.spawns).toHaveLength(1)
    resetTurnQueues()
  })

  it('arma o waiter antes de escrever para não perder uma resposta síncrona do PTY', async () => {
    resetTurnQueues()
    const harness = createLiveHarness()
    harness.deps.write = vi.fn((id: string) => {
      harness.emit({
        id,
        type: 'data',
        data: 'DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"resposta imediata"}\n',
      })
      return true
    })

    await expect(sendAgentTurn(harness.deps, {
      terminalId: 'turn-live-sync-result',
      provider: 'opencode',
      prompt: 'faça algo',
    })).resolves.toMatchObject({ result: 'resposta imediata' })
    resetTurnQueues()
  })
})

describe('createResultWaiter', () => {
  it('resolves on DEVORBIT_RESULT markers from real event flow', async () => {
    const listeners = new Set<(event: TerminalEvent) => void>()
    const wait = createResultWaiter((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    })
    const pending = wait('wait-one', { idleMs: 5000, overallMs: 5000 })
    listeners.forEach((listener) => listener({ id: 'other', type: 'data', data: 'noise' }))
    listeners.forEach((listener) => listener({ id: 'wait-one', type: 'data', data: 'working...\nDEVORBIT_RESULT: CONCLUIDO: pronto\n' }))
    await expect(pending).resolves.toMatchObject({ result: 'CONCLUIDO: pronto' })
    expect(listeners.size).toBe(0)
  })

  it('detects blocked markers', async () => {
    const listeners = new Set<(event: TerminalEvent) => void>()
    const wait = createResultWaiter((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    })
    const pending = wait('wait-two', { idleMs: 5000, overallMs: 5000 })
    listeners.forEach((listener) => listener({ id: 'wait-two', type: 'data', data: 'DEVORBIT_RESULT: BLOQUEADO: sem acesso\n' }))
    await expect(pending).resolves.toMatchObject({ blocked: 'BLOQUEADO: sem acesso' })
  })

  it('prefers valid JSON over the legacy mirror and maps failed without success', async () => {
    const listeners = new Set<(event: TerminalEvent) => void>()
    const wait = createResultWaiter((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    })
    const pending = wait('wait-json', { idleMs: 5000, overallMs: 5000 })
    listeners.forEach((listener) => listener({
      id: 'wait-json',
      type: 'data',
      data: 'DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"JSON venceu"}\nDEVORBIT_RESULT: BLOQUEADO: espelho\n',
    }))
    await expect(pending).resolves.toMatchObject({ result: 'JSON venceu' })
  })

  it('rejects versionless JSON and falls back to a later valid legacy mirror', async () => {
    const listeners = new Set<(event: TerminalEvent) => void>()
    const wait = createResultWaiter((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    })
    const pending = wait('wait-no-ver', { idleMs: 5000, overallMs: 5000 })
    listeners.forEach((listener) => listener({
      id: 'wait-no-ver',
      type: 'data',
      data: 'DEVORBIT_RESULT: {"outcome":"completed","summary":"sem version"}\nDEVORBIT_RESULT: CONCLUIDO: espelho legado\n',
    }))
    await expect(pending).resolves.toMatchObject({ result: 'CONCLUIDO: espelho legado' })
  })

  it('returns an uncertain invalid result on exit instead of advancing', async () => {
    const listeners = new Set<(event: TerminalEvent) => void>()
    const wait = createResultWaiter((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    })
    const pending = wait('wait-invalid', { idleMs: 5000, overallMs: 5000 })
    listeners.forEach((listener) => listener({
      id: 'wait-invalid',
      type: 'data',
      data: 'DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":oops}\n',
    }))
    listeners.forEach((listener) => listener({ id: 'wait-invalid', type: 'exit', code: 0 }))
    await expect(pending).resolves.toMatchObject({ code: 0, invalidResult: 'invalid-json' })
  })

  it('carries the tail on exit without a marker for text classification', async () => {
    const listeners = new Set<(event: TerminalEvent) => void>()
    const wait = createResultWaiter((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    })
    const pending = wait('wait-three', { idleMs: 5000, overallMs: 5000 })
    listeners.forEach((listener) => listener({ id: 'wait-three', type: 'data', data: 'Error: 429 rate limit exceeded' }))
    listeners.forEach((listener) => listener({ id: 'wait-three', type: 'exit', code: 0 }))
    await expect(pending).resolves.toMatchObject({ code: 0, tail: expect.stringContaining('rate limit') })
  })
})

describe('spawnAgentProviderTerminal', () => {
  const config = { customPaths: {} } as AppConfig

  function createSpawnDeps(options: {
    healthProvider?: AgentProviderId
    healthPath?: string | null
    starts?: Array<{ id: string; command: string; args: string[] }>
  } = {}) {
    const starts: Array<{ id: string; command: string; args: string[] }> =
      options.starts || []
    return {
      starts,
      deps: {
        resolveWithFallback: vi.fn(async (_config: AppConfig, _candidate: AgentProviderId) => ({
          path: options.healthPath === undefined ? 'C:\\cli\\agent.cmd' : options.healthPath,
          message: 'ok',
          provider: (options.healthProvider || 'claude') as AgentProviderId,
        })),
        startTerminal: vi.fn(async (id: string, spawnOptions: { command: string; args: string[] }) => {
          starts.push({ id, command: spawnOptions.command, args: spawnOptions.args })
          return { id, pid: 4242 }
        }),
        assertLive: vi.fn(),
      },
    }
  }

  it('rejects a health resolution that swaps the explicit provider', async () => {
    const { deps, starts } = createSpawnDeps({ healthProvider: 'claude', healthPath: 'C:\\cli\\agent.cmd' })
    await expect(
      spawnAgentProviderTerminal(
        deps,
        { id: 't1', candidate: 'opencode', model: 'claude-sonnet', tier: 'deep', cols: 120, rows: 32 },
        config
      )
    ).rejects.toMatchObject({ code: 'provider-mismatch', provider: 'opencode' })
    expect(starts).toHaveLength(0)
    expect(deps.assertLive).not.toHaveBeenCalled()
  })

  it('spawns the explicit provider when the resolution matches', async () => {
    const { deps, starts } = createSpawnDeps({ healthProvider: 'opencode', healthPath: 'C:\\cli\\agent.cmd' })
    const spawned = await spawnAgentProviderTerminal(
      deps,
      { id: 't1', candidate: 'opencode', model: 'gpt-4o-mini', tier: 'fast', cols: 120, rows: 32 },
      config
    )
    expect(spawned.provider).toBe('opencode')
    expect(spawned.command).toBe('C:\\cli\\agent.cmd')
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({
      id: 't1',
      args: ['/d', '/q', '/k', 'call "C:\\cli\\agent.cmd" --model gpt-4o-mini'],
    })
    expect(deps.assertLive).toHaveBeenCalledOnce()
  })

  it('surfaces missing binaries without spawning', async () => {
    const { deps, starts } = createSpawnDeps({ healthProvider: 'opencode', healthPath: null })
    await expect(
      spawnAgentProviderTerminal(
        deps,
        { id: 't1', candidate: 'opencode', model: 'gpt-4o-mini', tier: 'fast', cols: 120, rows: 32 },
        config
      )
    ).rejects.toThrow()
    expect(starts).toHaveLength(0)
  })
})
