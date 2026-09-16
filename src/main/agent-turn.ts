import type { AgentProviderId, AppConfig } from '../renderer/src/types'
import type { TerminalEvent } from './terminal-session'
import {
  buildAgentTurnEnv,
  findTransientSnippet,
  isTransientProviderError,
  resolveAgentProviderWithFallback,
  resolveProviderInvocation,
  type ModelRoutingConfig,
  type ModelTier,
} from './agent-providers'

export { buildAgentTurnEnv }

export interface SpawnAgentTerminal {
  id: string
  pid: number | undefined
}

export interface SpawnAgentTerminalDeps {
  resolveWithFallback: (
    config: AppConfig,
    candidate: AgentProviderId
  ) => Promise<{ path: string | null; message: string; provider: AgentProviderId }>
  startTerminal: (
    id: string,
    options: { command: string; args: string[]; env: NodeJS.ProcessEnv; cols: number; rows: number }
  ) => Promise<SpawnAgentTerminal>
  assertLive: () => void
}

/**
 * Spawna o CLI de um turno usando SEMPRE o provedor efetivo devolvido pelo
 * resolver (health pode trocar o candidato entre a resolução e o spawn).
 * Uma única tentativa por chamada — o retry vive em executeAgentTurnWithFallback.
 */
export async function spawnAgentProviderTerminal(
  deps: SpawnAgentTerminalDeps,
  input: {
    id: string
    candidate: AgentProviderId
    model: string
    tier: ModelTier
    routing?: ModelRoutingConfig
    cols: number
    rows: number
  },
  config: AppConfig
): Promise<{ started: SpawnAgentTerminal; provider: AgentProviderId; command: string }> {
  const resolved = await deps.resolveWithFallback(config, input.candidate)
  if (!resolved.path) throw new Error(resolved.message)
  if (/[%!]/.test(resolved.path)) {
    throw new Error('O caminho do provedor contém caracteres que o terminal não pode executar com segurança.')
  }
  const invocation = resolveProviderInvocation(
    resolved.provider,
    resolved.path,
    input.model,
    input.tier,
    input.routing
  )
  deps.assertLive()
  const started = await deps.startTerminal(input.id, {
    command: invocation.command,
    args: invocation.args,
    env: invocation.env,
    cols: input.cols,
    rows: input.rows,
  })
  return { started, provider: resolved.provider, command: resolved.path }
}

/**
 * Fronteira real de execução do turno (FASE 3): um turno = entregar o prompt,
 * aguardar o marcador DEVORBIT_RESULT (ou erro/saída), classificar o desfecho
 * e só então fazer failover — apenas para erros transitórios. O spawn do
 * processo é só o começo; rate limit reportado pelo CLI DEPOIS do spawn cai
 * aqui, não no caminho de start.
 *
 * Sem PTYs duplicados: todas as tentativas reutilizam o mesmo terminal id
 * (stop + start), e os turnos do mesmo terminal são serializados.
 */
export const TURN_RESULT_PATTERN = /DEVORBIT_RESULT:[ \t]*([^\r\n]+)/i
export const TURN_BLOCKED_PATTERN = /BLOQUEADO/i
export const TURN_DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000
export const TURN_DEFAULT_OVERALL_TIMEOUT_MS = 30 * 60_000
export const TURN_MAX_PROMPT_CHARS = 8_000

export interface TurnResolution {
  tier: ModelTier
  model: string
  provider: AgentProviderId
  fellBack: boolean
}

export interface TurnAttemptRecord {
  provider: AgentProviderId
  ok: boolean
  error?: string
}

export interface TurnOutcome {
  provider: AgentProviderId
  model: string
  tier: ModelTier
  result?: string
  blocked?: string
  attempts: TurnAttemptRecord[]
}

export interface TurnWaiter {
  result?: string
  blocked?: string
  error?: string
  code?: number | null
  timedOut?: boolean
  idleTimedOut?: boolean
  /** Cauda de saída para classificar texto transitório sem marcador. */
  tail?: string
}

export interface TurnDependencies {
  getSession: (id: string) => { provider: AgentProviderId; model: string } | undefined
  setSession: (id: string, session: { provider: AgentProviderId; model: string }) => void
  clearSession: (id: string) => void
  hasTerminal: (id: string) => boolean
  // Devolve o provedor EFETIVO do spawn quando a resolução de saúde troca o
  // candidato (opencode -> claude); void quando o spawn é o próprio candidato.
  spawn: (
    id: string,
    turn: { provider: AgentProviderId; model: string; tier: ModelTier }
  ) => Promise<{ provider?: AgentProviderId } | void>
  write: (id: string, input: string) => boolean
  waitResult: (id: string, timeouts: { idleMs: number; overallMs: number }) => Promise<TurnWaiter>
  resolveTurn: (provider: AgentProviderId, prompt: string) => Promise<TurnResolution>
  orderProviders: (preferred: AgentProviderId, ready: AgentProviderId[]) => AgentProviderId[]
  readyProviders: () => Promise<AgentProviderId[]>
}

const turnQueues = new Map<string, Promise<unknown>>()

export function resetTurnQueues(): void {
  turnQueues.clear()
}

function outcomeFromWait(waiter: TurnWaiter): { result?: string; blocked?: string; error?: string } {
  if (waiter.blocked) return { blocked: waiter.blocked }
  if (waiter.result) return { result: waiter.result }
  if (waiter.error) return { error: waiter.error }
  // CLI imprimiu rate limit/indisponibilidade e saiu sem marcador (mesmo com
  // código 0): texto transitório na cauda também autoriza failover.
  const transient = findTransientSnippet(waiter.tail)
  if (transient) return { error: transient }
  if (waiter.timedOut || waiter.idleTimedOut) {
    return { error: waiter.idleTimedOut ? 'Turno sem saída por tempo demais (stall).' : 'Tempo limite do turno excedido.' }
  }
  if (typeof waiter.code === 'number' && waiter.code !== 0) {
    const lastLine = typeof waiter.tail === 'string'
      ? waiter.tail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)?.slice(0, 200)
      : undefined
    return { error: `Processo terminou com código ${waiter.code}${lastLine ? `: ${lastLine}` : '.'}` }
  }
  return { error: 'Turno encerrado sem resultado.' }
}

export async function sendAgentTurn(
  deps: TurnDependencies,
  input: {
    terminalId: string
    provider: AgentProviderId
    prompt: string
    timeouts?: { idleMs?: number; overallMs?: number }
  }
): Promise<TurnOutcome> {
  const prompt = input.prompt.slice(0, TURN_MAX_PROMPT_CHARS)
  if (!prompt.trim()) throw new Error('Prompt do turno vazio.')
  const idleMs = input.timeouts?.idleMs ?? TURN_DEFAULT_IDLE_TIMEOUT_MS
  const overallMs = input.timeouts?.overallMs ?? TURN_DEFAULT_OVERALL_TIMEOUT_MS

  const previous = turnQueues.get(input.terminalId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  turnQueues.set(input.terminalId, previous.then(() => gate).catch(() => undefined).then(() => undefined))
  await previous.catch(() => undefined)
  try {
    return await runTurn(deps, input.terminalId, input.provider, prompt, idleMs, overallMs)
  } finally {
    release()
  }
}

async function runTurn(
  deps: TurnDependencies,
  terminalId: string,
  preferred: AgentProviderId,
  prompt: string,
  idleMs: number,
  overallMs: number
): Promise<TurnOutcome> {
  const turn = await deps.resolveTurn(preferred, prompt)
  const ready = await deps.readyProviders()
  const ordered = deps.orderProviders(turn.provider, ready)
  if (ordered.length === 0) throw new Error('Nenhum provedor disponível para o turno.')
  const attempts: TurnAttemptRecord[] = []
  // Provedores efetivamente tentados: evita repetir um provedor que já foi
  // usado via fallback de saúde quando ele reaparece como candidato seguinte.
  const attemptedProviders = new Set<AgentProviderId>()
  let lastError = 'falha desconhecida'

  for (const candidate of ordered) {
    if (attemptedProviders.has(candidate)) continue
    const session = deps.getSession(terminalId)
    let effective: AgentProviderId = candidate
    try {
      if (!deps.hasTerminal(terminalId) || !session || session.provider !== candidate || session.model !== turn.model) {
        // Mesmo id: stop + start reutiliza a sessão (sem PTYs duplicados).
        // O spawn pode resolver um provedor diferente do candidato; sessão e
        // desfecho usam o efetivo devolvido, e o candidato é só o id tentado.
        const spawnResult = await deps.spawn(terminalId, { provider: candidate, model: turn.model, tier: turn.tier })
        effective = spawnResult?.provider ?? candidate
        deps.setSession(terminalId, { provider: effective, model: turn.model })
      } else {
        effective = session.provider
      }
      attemptedProviders.add(effective)
      if (!deps.write(terminalId, prompt + '\r')) {
        throw new Error('O terminal recusou a tarefa (ENETUNREACH).')
      }
      const waiter = await deps.waitResult(terminalId, { idleMs, overallMs })
      const outcome = outcomeFromWait(waiter)
      if (outcome.blocked !== undefined) {
        attempts.push({ provider: effective, ok: true })
        return { provider: effective, model: turn.model, tier: turn.tier, blocked: outcome.blocked, attempts }
      }
      if (outcome.result !== undefined) {
        attempts.push({ provider: effective, ok: true })
        return { provider: effective, model: turn.model, tier: turn.tier, result: outcome.result, attempts }
      }
      throw new Error((outcome as { error: string }).error)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      attempts.push({ provider: effective, ok: false, error: message.slice(0, 300) })
      lastError = message
      deps.clearSession(terminalId)
      if (!isTransientProviderError(error)) break
    }
  }
  throw Object.assign(new Error(`Turno falhou: ${lastError.slice(0, 200)}`), { attempts })
}

/** Espera o marcador DEVORBIT_RESULT sobre eventos reais do PTY. */
export function createResultWaiter(
  subscribe: (listener: (event: TerminalEvent) => void) => () => void
): (id: string, timeouts: { idleMs: number; overallMs: number }) => Promise<TurnWaiter> {
  return (id, timeouts) => new Promise<TurnWaiter>((resolve) => {
    let settled = false
    let buffer = ''
    const tail = () => buffer.split('\n').slice(-20).join('\n').slice(-2000)
    const finish = (value: TurnWaiter) => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
      clearTimeout(overallTimer)
      unsubscribe()
      resolve(value)
    }
    const poke = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => finish({ timedOut: true, idleTimedOut: true, tail: tail() }), Math.max(1000, timeouts.idleMs))
    }
    let idleTimer = setTimeout(() => finish({ timedOut: true, idleTimedOut: true, tail: tail() }), Math.max(1000, timeouts.idleMs))
    const overallTimer = setTimeout(() => finish({ timedOut: true, tail: tail() }), Math.max(5000, timeouts.overallMs))
    const unsubscribe = subscribe((event) => {
      if (event.id !== id) return
      if (event.type === 'data' && typeof event.data === 'string') {
        buffer = (buffer + event.data).slice(-16_000)
        poke()
        const match = buffer.match(TURN_RESULT_PATTERN)
        if (match?.[1]?.trim()) {
          const text = match[1].trim()
          if (TURN_BLOCKED_PATTERN.test(text)) finish({ blocked: text.slice(0, 500) })
          else finish({ result: text.slice(0, 1000) })
        }
        return
      }
      if (event.type === 'error') {
        finish({ error: typeof event.data === 'string' && event.data ? event.data.slice(0, 500) : 'Erro no terminal.' })
        return
      }
      if (event.type === 'exit') {
        const match = buffer.match(TURN_RESULT_PATTERN)
        if (match?.[1]?.trim()) {
          const text = match[1].trim()
          if (TURN_BLOCKED_PATTERN.test(text)) finish({ blocked: text.slice(0, 500) })
          else finish({ result: text.slice(0, 1000) })
        } else {
          finish({ code: event.code, tail: tail() })
        }
      }
    })
  })
}
