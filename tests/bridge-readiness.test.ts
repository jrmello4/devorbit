import { describe, expect, it } from 'vitest'
import net from 'node:net'
import { serializeAgentBridgeMessage } from '../src/main/agent-bridge'
import { createBridgeService, type BridgeServiceDependencies } from '../src/main/bridge-service'

interface BridgeResponse {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

function createDependencies(overrides: Partial<BridgeServiceDependencies> = {}): {
  dependencies: BridgeServiceDependencies
  order: string[]
} {
  const order: string[] = []
  const dependencies: BridgeServiceDependencies = {
    cliDirectory: process.cwd(),
    hasTerminal: (id) => id === 'agent-1',
    writeTerminal: () => {
      order.push('write')
      return true
    },
    waitTurnResult: () => {
      order.push('waiter')
      const promise = Promise.resolve({ result: 'CONCLUIDO: ok' }) as ReturnType<BridgeServiceDependencies['waitTurnResult']>
      promise.cancel = () => undefined
      return promise
    },
    waitTerminalReady: async () => {
      order.push('ready')
    },
    onEvent: () => undefined,
    ...overrides,
  }
  return { dependencies, order }
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

describe('bridge MCP readiness', () => {
  it('agent.send waits for PTY readiness before arming the waiter and writing', async () => {
    const { dependencies, order } = createDependencies()
    const service = createBridgeService(dependencies)
    service.registerAgent('agent-1', { provider: 'opencode', model: 'm', projectPath: '/p' })
    service.runtime.start()
    const socket = await connect(service.runtime.pipeName)
    try {
      const response = await request(socket, {
        type: 'send',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'faça algo',
      })
      expect(response).toMatchObject({ ok: true })
      expect(order).toEqual(['ready', 'waiter', 'write'])
    } finally {
      socket.destroy()
      service.runtime.stop()
    }
  })

  it('agent.ask waits for PTY readiness and returns the structured outcome', async () => {
    const { dependencies, order } = createDependencies()
    const service = createBridgeService(dependencies)
    service.registerAgent('agent-1', { provider: 'opencode', model: 'm', projectPath: '/p' })
    service.runtime.start()
    const socket = await connect(service.runtime.pipeName)
    try {
      const response = await request(socket, {
        type: 'ask',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'faça algo',
      })
      expect(response).toMatchObject({ ok: true })
      expect(response.result).toMatchObject({ status: 'completed', summary: 'CONCLUIDO: ok' })
      expect(order).toEqual(['ready', 'waiter', 'write'])
    } finally {
      socket.destroy()
      service.runtime.stop()
    }
  })

  it('does not write when readiness fails', async () => {
    const { dependencies, order } = createDependencies({
      waitTerminalReady: async () => {
        order.push('ready')
        throw new Error('sessão não ficou pronta')
      },
    })
    const service = createBridgeService(dependencies)
    service.registerAgent('agent-1', { provider: 'opencode', model: 'm', projectPath: '/p' })
    service.runtime.start()
    const socket = await connect(service.runtime.pipeName)
    try {
      const response = await request(socket, {
        type: 'send',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'faça algo',
      })
      expect(response.ok).toBe(false)
      expect(order).toEqual(['ready'])
    } finally {
      socket.destroy()
      service.runtime.stop()
    }
  })
})
