import { describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import { serializeAgentBridgeMessage } from '../src/main/agent-bridge'
import { createBridgeService, type BridgeServiceDependencies, type BridgeService } from '../src/main/bridge-service'
import type { AgentBridgeEvent } from '../src/shared/agent-bridge-event'

interface BridgeResponse {
  ok: boolean
  result?: Record<string, unknown>
  error?: { code: string; message: string }
}

function createDependencies(overrides: Partial<BridgeServiceDependencies> = {}): BridgeServiceDependencies {
  return {
    cliDirectory: '/cli',
    hasTerminal: (id) => id === 'agent-1' || id === 'agent-2',
    writeTerminal: () => true,
    waitTurnResult: () => {
      const promise = Promise.resolve({ result: 'CONCLUIDO: ok' }) as ReturnType<BridgeServiceDependencies['waitTurnResult']>
      promise.cancel = () => undefined
      return promise
    },
    waitTerminalReady: async () => undefined,
    onEvent: () => undefined,
    ...overrides,
  }
}

async function startService(
  dependencies: BridgeServiceDependencies,
  options?: Parameters<typeof createBridgeService>[1],
): Promise<{ service: BridgeService; close: () => Promise<void> }> {
  const service = createBridgeService(dependencies, options)
  service.registerAgent('agent-1', { provider: 'opencode', model: 'm', projectPath: '/p' })
  service.registerAgent('agent-2', { provider: 'opencode', model: 'm', projectPath: '/p' })
  service.runtime.start()
  return {
    service,
    close: async () => {
      service.runtime.stop()
    },
  }
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

describe('bridge delegation — origem/destino/resultado e guardrails', () => {
  it('propaga origem, destino e resultado estruturado na resposta', async () => {
    const { service, close } = await startService(createDependencies())
    const socket = await connect(service.runtime.pipeName)
    try {
      const response = await request(socket, {
        type: 'ask',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'faça algo',
        origin: 'agent-9',
      })
      expect(response.result).toMatchObject({
        status: 'completed',
        origin: 'agent-9',
        destination: 'agent-1',
        result: { outcome: 'completed' },
      })
    } finally {
      socket.destroy()
      await close()
    }
  })

  it('usa devorbit como origem padrão', async () => {
    const { service, close } = await startService(createDependencies())
    const socket = await connect(service.runtime.pipeName)
    try {
      const response = await request(socket, {
        type: 'send',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'x',
      })
      expect(response.result).toMatchObject({ origin: 'devorbit', destination: 'agent-1', accepted: true })
    } finally {
      socket.destroy()
      await close()
    }
  })

  it('bloqueia alvo fora da allow-list e registra auditoria', async () => {
    const guards: Record<string, unknown>[] = []
    const { service, close } = await startService(
      createDependencies({ onGuard: (audit) => guards.push(audit) }),
      { allowedTargets: ['agent-1'] },
    )
    const socket = await connect(service.runtime.pipeName)
    try {
      const response = await request(socket, {
        type: 'send',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-2',
        prompt: 'x',
      })
      expect(response.ok).toBe(false)
      expect(guards).toHaveLength(1)
      expect(guards[0]).toMatchObject({ kind: 'delegation.guard', code: 'TARGET_NOT_ALLOWED', target: 'agent-2', allowed: false })
    } finally {
      socket.destroy()
      await close()
    }
  })

  it('executa run headless e emite evento com origem/destino/resultado', async () => {
    const events: AgentBridgeEvent[] = []
    const runHeadlessTurn = vi.fn(async () => ({ status: 'completed' as const, summary: 'headless ok', artifacts: ['r.md'] }))
    const { service, close } = await startService(
      createDependencies({ onEvent: (event) => events.push(event), runHeadlessTurn }),
    )
    const socket = await connect(service.runtime.pipeName)
    try {
      const response = await request(socket, {
        type: 'run',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'refatore',
        model: 'gemini-2.0-flash',
        origin: 'agent-7',
      })
      expect(response.ok).toBe(true)
      expect(response.result).toMatchObject({
        status: 'completed',
        origin: 'agent-7',
        destination: 'agent-1',
        result: { outcome: 'completed', summary: 'headless ok', artifacts: ['r.md'] },
      })
      expect(runHeadlessTurn).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ provider: 'opencode' }),
        expect.objectContaining({
          prompt: 'refatore',
          model: 'gemini-2.0-flash',
          origin: 'agent-1',
          depth: 1,
          visited: ['agent-1'],
        }),
      )
      const completed = events.find((event) => event.status === 'completed')
      expect(completed).toMatchObject({
        origin: 'agent-7',
        destination: 'agent-1',
        result: { outcome: 'completed', summary: 'headless ok' },
      })
    } finally {
      socket.destroy()
      await close()
    }
  })

  it('recusa run enquanto uma delegação interativa do mesmo alvo está pendente', async () => {
    let resolvePending!: (value: { result: string }) => void
    const pending = new Promise<{ result: string }>((resolve) => { resolvePending = resolve }) as ReturnType<BridgeServiceDependencies['waitTurnResult']>
    pending.cancel = () => undefined
    const runHeadlessTurn = vi.fn(async () => ({ status: 'completed' as const, summary: 'não deveria iniciar' }))
    const { service, close } = await startService(createDependencies({
      waitTurnResult: () => pending,
      runHeadlessTurn,
    }))
    const socket = await connect(service.runtime.pipeName)
    try {
      const sent = await request(socket, {
        type: 'send', token: service.runtime.token, sessionId: service.runtime.sessionId,
        target: 'agent-1', prompt: 'interativo',
      })
      expect(sent.ok).toBe(true)
      const run = await request(socket, {
        type: 'run', token: service.runtime.token, sessionId: service.runtime.sessionId,
        target: 'agent-1', prompt: 'headless',
      })
      expect(run.ok).toBe(false)
      expect(runHeadlessTurn).not.toHaveBeenCalled()
    } finally {
      resolvePending({ result: 'fim' })
      socket.destroy()
      await close()
    }
  })

  it('bloqueia um ciclo quando o alvo do provedor resolve para um terminal visitado', async () => {
    const guards: Record<string, unknown>[] = []
    const runHeadlessTurn = vi.fn(async () => ({ status: 'completed' as const, summary: 'não deveria iniciar' }))
    const { service, close } = await startService(createDependencies({
      hasTerminal: (id) => id === 'agent-1',
      onGuard: (audit) => guards.push(audit),
      runHeadlessTurn,
    }))
    const socket = await connect(service.runtime.pipeName)
    try {
      const response = await request(socket, {
        type: 'run', token: service.runtime.token, sessionId: service.runtime.sessionId,
        target: 'opencode', prompt: 'auto delegação', depth: 1, visited: ['agent-1'],
      })
      expect(response.ok).toBe(false)
      expect(runHeadlessTurn).not.toHaveBeenCalled()
      expect(guards).toContainEqual(expect.objectContaining({ code: 'CYCLE_BLOCKED', target: 'agent-1' }))
    } finally {
      socket.destroy()
      await close()
    }
  })

  it('responde NOT_IMPLEMENTED para run quando o runner não foi injetado', async () => {
    const { service, close } = await startService(createDependencies())
    const socket = await connect(service.runtime.pipeName)
    try {
      const response = await request(socket, {
        type: 'run',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'x',
      })
      expect(response.ok).toBe(false)
      expect(response.error?.code).toBe('NOT_IMPLEMENTED')
    } finally {
      socket.destroy()
      await close()
    }
  })
})
