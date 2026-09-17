import { once } from 'node:events'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAgentBridgeRuntime,
  type AgentBridgeRuntime,
} from '../src/main/agent-bridge-runtime'
import type { AgentBridgeHandlers } from '../src/main/agent-bridge'
import { parseAgentBridgeEvent, type AgentBridgeEvent } from '../src/shared/agent-bridge-event'

interface Fixture {
  runtime: AgentBridgeRuntime
  events: AgentBridgeEvent[]
  start: () => Promise<net.Server>
  request: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>
  close: () => Promise<void>
}

const openFixtures: Fixture[] = []

function createFixture(
  handlers: AgentBridgeHandlers,
  onEvent?: (event: AgentBridgeEvent) => void,
): Fixture {
  const events: AgentBridgeEvent[] = []
  const sockets: net.Socket[] = []
  let server: net.Server | null = null
  let closed = false
  const runtime = createAgentBridgeRuntime({
    handlers,
    cliDirectory: 'C:\\fixture\\cli',
    onEvent: (event) => {
      events.push(event)
      onEvent?.(event)
    },
  })

  const fixture: Fixture = {
    runtime,
    events,
    start: async () => {
      const next = runtime.start()
      server = next
      closed = false
      next.once('close', () => {
        closed = true
      })
      if (!next.listening) await once(next, 'listening')
      return next
    },
    request: async (payload) => {
      const socket = net.connect(runtime.pipeName)
      sockets.push(socket)
      socket.setNoDelay(true)
      await once(socket, 'connect')
      const line = new Promise<string>((resolve, reject) => {
        let buffer = ''
        socket.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8')
          const index = buffer.indexOf('\n')
          if (index !== -1) resolve(buffer.slice(0, index))
        })
        socket.once('error', reject)
      })
      socket.write(`${JSON.stringify(payload)}\n`)
      const response = JSON.parse(await line) as Record<string, unknown>
      socket.end()
      return response
    },
    close: async () => {
      for (const socket of sockets.splice(0)) socket.destroy()
      runtime.stop()
      if (server && !closed) {
        await Promise.race([
          new Promise<void>((resolve) => {
            if (closed) {
              resolve()
              return
            }
            server?.once('close', () => resolve())
          }),
          new Promise<void>((resolve) => {
            setTimeout(resolve, 1_000)
          }),
        ])
      }
    },
  }
  openFixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of openFixtures.splice(0)) {
    await fixture.close()
  }
})

describe('createAgentBridgeRuntime', () => {
  it('exposes a session-scoped env with the pipe, token and CLI directory on PATH', () => {
    const runtime = createAgentBridgeRuntime({ handlers: {}, cliDirectory: 'C:\\fixture\\cli' })
    const env = runtime.env()

    expect(runtime.pipeName).toContain('devorbit-')
    expect(runtime.token).toMatch(/^[0-9a-f]{64}$/)
    expect(runtime.sessionId).toMatch(/^[0-9a-f]{24}$/)
    expect(env.DEVORBIT_BRIDGE_PIPE).toBe(runtime.pipeName)
    expect(env.DEVORBIT_BRIDGE_TOKEN).toBe(runtime.token)
    expect(env.DEVORBIT_SESSION_ID).toBe(runtime.sessionId)
    expect(env.PATH?.startsWith('C:\\fixture\\cli')).toBe(true)
  })

  it('starts idempotently, stops and can start again', async () => {
    const fixture = createFixture({ ask: async () => ({ status: 'completed' }) })
    const first = await fixture.start()
    expect(fixture.runtime.start()).toBe(first)

    await fixture.close()
    expect(first.listening).toBe(false)

    const restarted = await fixture.start()
    expect(restarted).not.toBe(first)
    expect(restarted.listening).toBe(true)
  })

  it('emits pending then completed for an ask handler and returns the handler result', async () => {
    const ask = async () => ({ status: 'completed', summary: 'resultado ok', payload: 42 })
    const fixture = createFixture({ ask })
    await fixture.start()

    const response = await fixture.request({
      type: 'ask',
      token: fixture.runtime.token,
      sessionId: fixture.runtime.sessionId,
      id: 'req/ask 1',
      target: 'agy',
      prompt: 'implemente a tarefa',
      timeoutMs: 1_000,
    })

    expect(response).toMatchObject({ ok: true, id: 'req/ask 1', result: { status: 'completed', payload: 42 } })
    expect(fixture.events).toHaveLength(2)
    const [pending, completed] = fixture.events
    expect(pending).toMatchObject({
      requestId: 'req-ask-1',
      source: 'devorbit',
      target: 'agy',
      status: 'pending',
    })
    expect(completed).toMatchObject({
      requestId: 'req-ask-1',
      source: 'devorbit',
      target: 'agy',
      status: 'completed',
      summary: 'resultado ok',
    })
    expect(completed.updatedAt).toBeGreaterThanOrEqual(pending.createdAt as number)
    for (const event of fixture.events) {
      expect(parseAgentBridgeEvent(event)).toEqual({ kind: 'event', event })
    }
  })

  it('maps blocked results and normalizes unsafe request ids and targets', async () => {
    const fixture = createFixture({
      send: async () => ({ status: 'blocked', summary: 'sem permissao' }),
    })
    await fixture.start()

    const response = await fixture.request({
      type: 'send',
      token: fixture.runtime.token,
      sessionId: fixture.runtime.sessionId,
      id: 'req//send 2',
      target: 'my agent!!',
      prompt: 'rode os testes',
    })

    expect(response).toMatchObject({ ok: true })
    expect(fixture.events.map((event) => event.status)).toEqual(['pending', 'blocked'])
    expect(fixture.events[0]).toMatchObject({ requestId: 'req--send-2', target: 'my-agent--' })
    expect(fixture.events[1]).toMatchObject({ summary: 'sem permissao' })
    for (const event of fixture.events) {
      expect(parseAgentBridgeEvent(event).kind).toBe('event')
    }
  })

  it('falls back to bridge-target when the request targets devorbit itself', async () => {
    const fixture = createFixture({ ask: async () => ({ status: 'completed' }) })
    await fixture.start()

    await fixture.request({
      type: 'ask',
      token: fixture.runtime.token,
      sessionId: fixture.runtime.sessionId,
      target: 'devorbit',
      prompt: 'responda',
    })

    expect(fixture.events[0]?.target).toBe('bridge-target')
    expect(fixture.events[1]?.target).toBe('bridge-target')
  })

  it('emits pending then failed with a sanitized summary when the handler throws', async () => {
    const fixture = createFixture({
      ask: async () => {
        throw new Error('boom\nstack=sk-live-abcdef123456')
      },
    })
    await fixture.start()

    const response = await fixture.request({
      type: 'ask',
      token: fixture.runtime.token,
      sessionId: fixture.runtime.sessionId,
      target: 'agy',
      prompt: 'falhe',
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'HANDLER_ERROR' } })
    expect(fixture.events.map((event) => event.status)).toEqual(['pending', 'failed'])
    const failed = fixture.events[1]
    expect(failed.summary).toContain('boom')
    expect(failed.summary).not.toContain('\n')
    expect(failed.updatedAt).toBeGreaterThanOrEqual(fixture.events[0].createdAt as number)
    expect(parseAgentBridgeEvent(failed).kind).toBe('event')
  })

  it('does not emit events for operations without a handler', async () => {
    const fixture = createFixture({ ask: async () => ({ status: 'completed' }) })
    await fixture.start()

    const response = await fixture.request({
      type: 'list',
      token: fixture.runtime.token,
      sessionId: fixture.runtime.sessionId,
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'NOT_IMPLEMENTED' } })
    expect(fixture.events).toEqual([])
  })

  it('keeps serving when the onEvent telemetry callback throws', async () => {
    const fixture = createFixture(
      { ask: async () => ({ status: 'completed', summary: 'segue o jogo' }) },
      () => {
        throw new Error('telemetria quebrada')
      },
    )
    await fixture.start()

    const response = await fixture.request({
      type: 'ask',
      token: fixture.runtime.token,
      sessionId: fixture.runtime.sessionId,
      target: 'agy',
      prompt: 'continue',
    })

    expect(response).toMatchObject({ ok: true, result: { summary: 'segue o jogo' } })
    expect(fixture.events).toHaveLength(2)
    expect(fixture.events[1]).toMatchObject({ status: 'completed', summary: 'segue o jogo' })
  })

  it('emits distinct pending events for concurrent requests', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fixture = createFixture({
      send: async () => {
        await gate
        return { status: 'completed' }
      },
    })
    await fixture.start()

    const first = fixture.request({
      type: 'send',
      token: fixture.runtime.token,
      sessionId: fixture.runtime.sessionId,
      id: 'req-a',
      target: 'agy',
      prompt: 'primeira',
    })
    const second = fixture.request({
      type: 'send',
      token: fixture.runtime.token,
      sessionId: fixture.runtime.sessionId,
      id: 'req-b',
      target: 'opencode',
      prompt: 'segunda',
    })

    await expect.poll(() => fixture.events.filter((event) => event.status === 'pending')).toHaveLength(2)
    expect(new Set(fixture.events.map((event) => event.requestId)).size).toBe(2)
    release?.()
    await Promise.all([first, second])
    expect(fixture.events.filter((event) => event.status === 'completed')).toHaveLength(2)
  })

  it('aborts the handler context when the client disconnects', async () => {
    let aborted = false
    let started = false
    const fixture = createFixture({
      ask: async (_request, context) => {
        started = true
        context?.signal.addEventListener('abort', () => {
          aborted = true
        }, { once: true })
        await new Promise((resolve) => setTimeout(resolve, 5_000))
        return { status: 'completed' }
      },
    })
    await fixture.start()
    const socket = net.connect(fixture.runtime.pipeName)
    try {
      await once(socket, 'connect')
      socket.write(`${JSON.stringify({
        type: 'ask',
        token: fixture.runtime.token,
        sessionId: fixture.runtime.sessionId,
        target: 'agy',
        prompt: 'desconecte',
        timeoutMs: 1_000,
      })}\n`)
      await expect.poll(() => started, { timeout: 5_000 }).toBe(true)
      socket.destroy()
      await expect.poll(() => aborted, { timeout: 5_000 }).toBe(true)
    } finally {
      socket.destroy()
    }
  })

  it('does not start queued bridge requests after a disconnect', async () => {
    const started: string[] = []
    let aborted = false
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fixture = createFixture({
      ask: async (request, context) => {
        started.push(request.prompt)
        context?.signal.addEventListener('abort', () => {
          aborted = true
        }, { once: true })
        await gate
        return { status: 'completed' }
      },
    })
    await fixture.start()
    const socket = net.connect(fixture.runtime.pipeName)
    try {
      await once(socket, 'connect')
      const message = (prompt: string) => `${JSON.stringify({
        type: 'ask',
        token: fixture.runtime.token,
        sessionId: fixture.runtime.sessionId,
        target: 'agy',
        prompt,
        timeoutMs: 1_000,
      })}\n`
      socket.write(message('primeira'))
      socket.write(message('segunda'))
      await expect.poll(() => started.length, { timeout: 5_000 }).toBe(1)
      socket.destroy()
      await expect.poll(() => aborted, { timeout: 5_000 }).toBe(true)
      release()
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(started).toEqual(['primeira'])
    } finally {
      socket.destroy()
      release()
    }
  })
})
