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
    orderProviders: (preferred, ready) => {
      const ordered = [preferred, ...ready.filter((id) => id !== preferred)]
      return ordered as AgentProviderId[]
    },
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

  it('fails over on transient post-spawn rate limit reusing the same PTY id', async () => {
    resetTurnQueues()
    const harness = createHarness({
      failSpawn: () => null,
      waiters: [{ error: 'request failed 429 rate limit, retry later' }, { result: 'CONCLUIDO: feito no fallback' }],
    })
    const order = ['opencode', 'claude'] as AgentProviderId[]
    harness.deps.orderProviders = () => order
    const outcome = await sendAgentTurn(harness.deps, {
      terminalId: 'turn-failover',
      provider: 'opencode',
      prompt: 'faça algo',
    })
    expect(outcome.provider).toBe('claude')
    expect(outcome.result).toBe('CONCLUIDO: feito no fallback')
    expect(outcome.attempts).toHaveLength(2)
    expect(outcome.attempts[0]).toMatchObject({ provider: 'opencode', ok: false })
    // Sem PTYs duplicados: todos os spawns usam o mesmo id, um por tentativa.
    expect(harness.spawns).toEqual([
      { id: 'turn-failover', provider: 'opencode' },
      { id: 'turn-failover', provider: 'claude' },
    ])
    expect(harness.writes.map((entry) => entry.id)).toEqual(['turn-failover', 'turn-failover'])
    resetTurnQueues()
  })

  it('fails over when the CLI prints rate limit and exits 0 without a marker', async () => {
    resetTurnQueues()
    const harness = createHarness({
      waiters: [
        { code: 0, tail: 'working...\nError: 429 rate limit exceeded, retry later' },
        { result: 'CONCLUIDO: feito no fallback' },
      ],
    })
    const order = ['opencode', 'claude'] as AgentProviderId[]
    harness.deps.orderProviders = () => order
    const outcome = await sendAgentTurn(harness.deps, {
      terminalId: 'turn-text-failover',
      provider: 'opencode',
      prompt: 'faça algo',
    })
    expect(outcome.provider).toBe('claude')
    expect(outcome.result).toBe('CONCLUIDO: feito no fallback')
    expect(outcome.attempts[0]).toMatchObject({ provider: 'opencode', ok: false })
    expect(outcome.attempts[0].error).toMatch(/rate limit/i)
    expect(harness.spawns.map((entry) => entry.id)).toEqual(['turn-text-failover', 'turn-text-failover'])
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

  it('uses the effective provider returned by spawn for session, attempt and outcome', async () => {
    resetTurnQueues()
    const harness = createHarness({ waiters: [{ result: 'CONCLUIDO: ok' }] })
    // Candidato opencode, mas a resolução de saúde no spawn devolve claude.
    const spawnMock = vi.fn(async (id: string) => {
      harness.live.add(id)
      harness.spawns.push({ id, provider: 'claude' as AgentProviderId })
      return { provider: 'claude' as AgentProviderId }
    })
    harness.deps.spawn = spawnMock
    const outcome = await sendAgentTurn(harness.deps, {
      terminalId: 'turn-effective',
      provider: 'opencode',
      prompt: 'refatore a arquitetura',
    })
    expect(outcome.provider).toBe('claude')
    expect(outcome.result).toBe('CONCLUIDO: ok')
    expect(outcome.attempts).toEqual([{ provider: 'claude', ok: true }])
    expect(harness.sessions.get('turn-effective')).toEqual({ provider: 'claude', model: 'gpt-4o-mini' })
    // Uma única tentativa/sessão: um spawn e uma escrita.
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(harness.spawns).toEqual([{ id: 'turn-effective', provider: 'claude' }])
    expect(harness.writes).toHaveLength(1)
    resetTurnQueues()
  })

  it('does not repeat a provider already attempted via spawn fallback', async () => {
    resetTurnQueues()
    const harness = createHarness({
      waiters: [{ error: '429 rate limit exceeded' }],
    })
    harness.deps.orderProviders = () => ['opencode', 'claude'] as AgentProviderId[]
    // ordered = [opencode, claude]; opencode resolve para claude no spawn.
    // O claude (efetivo) falha transitoriamente; o candidato claude seguinte
    // não pode ser tentado de novo (sem PTY duplicado para o mesmo provedor).
    let spawnCount = 0
    harness.deps.spawn = vi.fn(async (id: string) => {
      spawnCount += 1
      harness.live.add(id)
      return { provider: 'claude' as AgentProviderId }
    })
    await expect(sendAgentTurn(harness.deps, {
      terminalId: 'turn-no-dup',
      provider: 'opencode',
      prompt: 'faça algo',
    })).rejects.toThrow('rate limit')
    expect(spawnCount).toBe(1)
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

  it('rate limit impresso + exit 0 disparam failover real', async () => {
    resetTurnQueues()
    const harness = createLiveHarness()
    const order = ['opencode', 'claude'] as AgentProviderId[]
    harness.deps.orderProviders = () => order
    const pending = sendAgentTurn(harness.deps, {
      terminalId: 'turn-live-failover',
      provider: 'opencode',
      prompt: 'faça algo',
    })
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThan(0))
    harness.emit({ id: 'turn-live-failover', type: 'data', data: 'Error: 429 rate limit exceeded\n' })
    harness.emit({ id: 'turn-live-failover', type: 'exit', code: 0 })
    // A escrita precede a assinatura do waiter no mesmo bloco síncrono:
    // observar writes==2 garante o segundo waiter pronto antes do marcador.
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2))
    harness.emit({ id: 'turn-live-failover', type: 'data', data: 'DEVORBIT_RESULT: CONCLUIDO: feito\n' })
    const outcome = await pending
    expect(outcome.provider).toBe('claude')
    expect(outcome.result).toBe('CONCLUIDO: feito')
    expect(harness.spawns).toHaveLength(2)
    expect(harness.spawns.map((entry) => entry.id)).toEqual(['turn-live-failover', 'turn-live-failover'])
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
    listeners.forEach((listener) => listener({ id: 'wait-one', type: 'data', data: 'working...\nDEVORBIT_RESULT: CONCLUIDO: pronto' }))
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
    listeners.forEach((listener) => listener({ id: 'wait-two', type: 'data', data: 'DEVORBIT_RESULT: BLOQUEADO: sem acesso' }))
    await expect(pending).resolves.toMatchObject({ blocked: 'BLOQUEADO: sem acesso' })
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

  it('uses the effective provider from health resolution, not the candidate', async () => {
    const { deps, starts } = createSpawnDeps({ healthProvider: 'claude', healthPath: 'C:\\cli\\agent.cmd' })
    const spawned = await spawnAgentProviderTerminal(
      deps,
      { id: 't1', candidate: 'opencode', model: 'claude-sonnet', tier: 'deep', cols: 120, rows: 32 },
      config
    )
    // Fallback entre health e spawn: sessão e retorno com claude, 1 tentativa.
    expect(spawned.provider).toBe('claude')
    expect(spawned.command).toBe('C:\\cli\\agent.cmd')
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({
      id: 't1',
      args: ['/d', '/q', '/k', 'call "C:\\cli\\agent.cmd" --model claude-sonnet'],
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
