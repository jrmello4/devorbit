import net from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { serializeAgentBridgeMessage } from '../src/main/agent-bridge'
import { createBridgeService, type BridgeCycleOutcome, type BridgeService, type BridgeServiceDependencies } from '../src/main/bridge-service'
import { sendAgentInstruction } from '../src/main/agent-instruction'
import type { TerminalEvent } from '../src/main/terminal-session'

interface BridgeResponse {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

function dependencies(overrides: Partial<BridgeServiceDependencies> = {}): BridgeServiceDependencies {
  return {
    cliDirectory: '/cli',
    hasTerminal: () => true,
    waitAgentReady: async () => ({ timedOut: false }),
    waitTurnResult: () => {
      const promise = Promise.resolve({ result: 'CONCLUIDO: worker pronto' }) as ReturnType<BridgeServiceDependencies['waitTurnResult']>
      promise.cancel = () => undefined
      return promise
    },
    sendInstruction: async () => ({ acked: true, attempts: 1 }),
    onEvent: () => undefined,
    onMcpHandshake: () => true,
    isCurrentLaunch: (_terminalId, launchId) => launchId === 'launch-current',
    ...overrides,
  }
}

async function startService(
  overrides: Partial<BridgeServiceDependencies> = {},
  options: Parameters<typeof createBridgeService>[1] = {},
): Promise<{ service: BridgeService; close: () => void }> {
  const service = createBridgeService(dependencies(overrides), options)
  service.registerAgent('coordinator', { provider: 'opencode', model: 'm', projectPath: '/p' })
  service.registerAgent('worker', { provider: 'agy', model: 'm', projectPath: '/p' })
  service.runtime.start()
  return { service, close: () => service.runtime.stop() }
}

function connect(pipeName: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipeName)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function request(socket: net.Socket, message: unknown): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    let pending = ''
    const onData = (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      const newline = pending.indexOf('\n')
      if (newline === -1) return
      socket.off('data', onData)
      try {
        resolve(JSON.parse(pending.slice(0, newline)) as BridgeResponse)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    socket.on('data', onData)
    socket.write(serializeAgentBridgeMessage(message))
  })
}

async function handshake(service: BridgeService, socket: net.Socket): Promise<void> {
  const response = await request(socket, {
    type: 'mcp-handshake',
    token: service.runtime.token,
    sessionId: service.runtime.sessionId,
    terminalId: 'coordinator',
    launchId: 'launch-current',
    pid: 123,
  })
  expect(response).toMatchObject({ ok: true, result: { terminalId: 'coordinator', launchId: 'launch-current' } })
}

function callerFields(launchId = 'launch-current'): Record<string, string> {
  return { originTerminalId: 'coordinator', originLaunchId: launchId }
}

describe('Agent Bridge caller identity', () => {
  it('lists caller identity and allows a normal ask to an already-ready worker', async () => {
    const outcomes: BridgeCycleOutcome[] = []
    const { service, close } = await startService({ onOutcome: (outcome) => outcomes.push(outcome) })
    const socket = await connect(service.runtime.pipeName)
    try {
      await handshake(service, socket)
      const before = await request(socket, {
        type: 'list', token: service.runtime.token, sessionId: service.runtime.sessionId, ...callerFields(),
      })
      expect(before).toMatchObject({ ok: true })
      const beforeAgents = before.result as Array<Record<string, unknown>>
      expect(beforeAgents.find((agent) => agent.id === 'coordinator')).toMatchObject({ self: true, delegable: false })
      expect(beforeAgents.find((agent) => agent.id === 'worker')).toMatchObject({ status: 'ready', self: false, delegable: true })

      const bootstrap = await request(socket, {
        type: 'ask', token: service.runtime.token, sessionId: service.runtime.sessionId,
        target: 'worker', prompt: 'bootstrap worker', ...callerFields(),
      })
      expect(bootstrap).toMatchObject({ ok: true, result: { status: 'completed', origin: 'coordinator', destination: 'worker' } })
      await new Promise((resolve) => setTimeout(resolve, 0))

      const after = await request(socket, {
        type: 'list', token: service.runtime.token, sessionId: service.runtime.sessionId, ...callerFields(),
      })
      const afterAgents = after.result as Array<Record<string, unknown>>
      expect(afterAgents.find((agent) => agent.id === 'coordinator')).toMatchObject({ self: true, delegable: false })
      expect(afterAgents.find((agent) => agent.id === 'worker')).toMatchObject({ status: 'ready', self: false, delegable: true })
      expect(outcomes).toContainEqual(expect.objectContaining({ source: 'coordinator', target: 'worker' }))

      const legacy = await request(socket, {
        type: 'list', token: service.runtime.token, sessionId: service.runtime.sessionId,
      })
      expect((legacy.result as Array<Record<string, unknown>>).every((agent) => agent.self === false)).toBe(true)
    } finally {
      socket.destroy()
      close()
    }
  })

  it('rejects a stale caller launch before listing or delegating', async () => {
    const { service, close } = await startService()
    const socket = await connect(service.runtime.pipeName)
    try {
      await handshake(service, socket)
      const response = await request(socket, {
        type: 'list', token: service.runtime.token, sessionId: service.runtime.sessionId,
        ...callerFields('launch-stale'),
      })
      expect(response).toMatchObject({ ok: false, error: { code: 'CALLER_IDENTITY_STALE' } })
    } finally {
      socket.destroy()
      close()
    }
  })

  it('keeps the last accepted caller after a rejected replay handshake', async () => {
    let acceptHandshake = true
    const { service, close } = await startService({ onMcpHandshake: () => acceptHandshake })
    const socket = await connect(service.runtime.pipeName)
    try {
      await handshake(service, socket)
      acceptHandshake = false
      const rejected = await request(socket, {
        type: 'mcp-handshake', token: service.runtime.token, sessionId: service.runtime.sessionId,
        terminalId: 'coordinator', launchId: 'launch-current', pid: 123,
      })
      expect(rejected).toMatchObject({ ok: false, error: { code: 'HANDLER_ERROR' } })
      acceptHandshake = true
      const list = await request(socket, {
        type: 'list', token: service.runtime.token, sessionId: service.runtime.sessionId, ...callerFields(),
      })
      expect(list).toMatchObject({ ok: true })
      expect((list.result as Array<Record<string, unknown>>).find((agent) => agent.id === 'coordinator')).toMatchObject({ self: true })
    } finally {
      socket.destroy()
      close()
    }
  })

  it('aborts delivery when the turn deadline wins before readiness, preserving the original failure code', async () => {
    const listeners = new Set<(event: TerminalEvent) => void>()
    const writes: string[] = []
    const subscribe = (listener: (event: TerminalEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
    const { service, close } = await startService({
      subscribe,
      sendInstruction: (input) => sendAgentInstruction({
        hasTerminal: () => true,
        waitReady: () => new Promise<{ timedOut: boolean }>(() => undefined),
        write: (_id, content) => { writes.push(content); return true },
        subscribe,
        now: () => Date.now(),
      }, { ...input, provider: 'codex', timeoutMs: 5_000 }),
    }, { sendIdleMs: 1_000, sendOverallMs: 1_000 })
    const socket = await connect(service.runtime.pipeName)
    try {
      await handshake(service, socket)
      const response = await request(socket, {
        type: 'send', token: service.runtime.token, sessionId: service.runtime.sessionId,
        target: 'worker', prompt: 'wait for readiness', ...callerFields(),
      })
      expect(response).toMatchObject({ ok: false, error: { code: 'AGENT_NOT_READY' } })
      expect(writes).toEqual([])
    } finally {
      socket.destroy()
      close()
      for (const listener of listeners) listener({ id: 'worker', type: 'exit', code: 0 })
    }
  })

  it.each(['send', 'ask', 'run', 'wait'] as const)('rejects %s from a caller to itself, including provider aliases', async (type) => {
    const runHeadlessTurn = vi.fn(async () => ({ status: 'completed' as const, summary: 'should not run' }))
    const { service, close } = await startService({ runHeadlessTurn })
    const socket = await connect(service.runtime.pipeName)
    try {
      await handshake(service, socket)
      const response = await request(socket, {
        type,
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'opencode',
        ...(type === 'wait' ? { timeoutMs: 100 } : { prompt: 'self delegation' }),
        ...callerFields(),
      })
      expect(response).toMatchObject({ ok: false, error: { code: 'SELF_DELEGATION_NOT_ALLOWED' } })
      expect(runHeadlessTurn).not.toHaveBeenCalled()
    } finally {
      socket.destroy()
      close()
    }
  })
})
