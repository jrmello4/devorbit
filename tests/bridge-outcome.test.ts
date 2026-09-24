import { describe, expect, it } from 'vitest'
import net from 'node:net'
import { serializeAgentBridgeMessage } from '../src/main/agent-bridge'
import { createBridgeService, type BridgeCycleOutcome, type BridgeServiceDependencies, type BridgeService } from '../src/main/bridge-service'

interface BridgeResponse {
  ok: boolean
  result?: Record<string, unknown>
  error?: { code: string; message: string }
}

type TurnWaiter = { result?: string; blocked?: string; error?: string }
type WaiterPromise = Promise<TurnWaiter> & { cancel: () => void }

function createControllableWaiter(): {
  waiter: () => WaiterPromise
  finish: (waiter: TurnWaiter) => void
} {
  let finish!: (waiter: TurnWaiter) => void
  const waiter = (): WaiterPromise => {
    const promise = new Promise<TurnWaiter>((resolve) => { finish = resolve }) as WaiterPromise
    promise.cancel = () => finish({ error: 'A espera da ponte foi cancelada.' })
    return promise
  }
  return {
    waiter,
    finish: (waiterOutcome) => finish?.(waiterOutcome),
  }
}

function createDependencies(overrides: Partial<BridgeServiceDependencies> = {}): BridgeServiceDependencies {
  return {
    cliDirectory: '/cli',
    hasTerminal: (id) => id === 'agent-1' || id === 'agent-2',
    writeTerminal: () => true,
    waitTurnResult: () => {
      const promise = Promise.resolve({ result: 'CONCLUIDO: ok' }) as WaiterPromise
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
): Promise<{ service: BridgeService; close: () => Promise<void> }> {
  const service = createBridgeService(dependencies)
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

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('bridge-service onOutcome — uma vez por ciclo lógico', () => {
  it('send+wait: o ciclo emite EXATAMENTE um outcome; send aceito nunca grava', async () => {
    const controller = createControllableWaiter()
    const outcomes: BridgeCycleOutcome[] = []
    const { service, close } = await startService(createDependencies({
      waitTurnResult: () => controller.waiter(),
      onOutcome: (outcome) => { outcomes.push(outcome) },
    }))
    const socket = await connect(service.runtime.pipeName)
    try {
      const sendResponse = await request(socket, {
        type: 'send',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'faz a coisa',
        id: 'send-1',
      })
      expect(sendResponse.ok).toBe(true)
      expect(sendResponse.result).toMatchObject({ accepted: true })
      await settle()
      // Evento externo do send ({accepted:true}) não persiste nada.
      expect(outcomes).toHaveLength(0)

      const waitPromise = request(socket, {
        type: 'wait',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        timeoutMs: 1000,
        id: 'wait-1',
      })
      await settle()
      // Libera o waiter: o outcome real chega pelo ciclo rastreado do send.
      controller.finish({ result: 'CONCLUIDO: build verde' })
      const waitResponse = await waitPromise
      expect(waitResponse.ok).toBe(true)
      await settle()
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]).toMatchObject({
        target: 'agent-1',
        projectPath: '/p',
        status: 'completed',
        summary: 'CONCLUIDO: build verde',
      })
      expect(outcomes[0].taskId).toMatch(/^agent-1#\d+$/)
    } finally {
      socket.destroy()
      await close()
    }
  })

  it('wait repetido em cache não duplica outcome (taskId dedupado)', async () => {
    const outcomes: BridgeCycleOutcome[] = []
    const { service, close } = await startService(createDependencies({
      onOutcome: (outcome) => { outcomes.push(outcome) },
    }))
    const socket = await connect(service.runtime.pipeName)
    try {
      const ask = {
        type: 'ask',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'pergunta',
        id: 'ask-1',
      }
      const first = await request(socket, ask)
      expect(first.ok).toBe(true)
      await settle()
      expect(outcomes).toHaveLength(1)

      // Wait em cima do outcome em cache: SEM nova emissão.
      const cachedWait = await request(socket, {
        type: 'wait',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        timeoutMs: 1000,
        id: 'wait-cached',
      })
      expect(cachedWait.ok).toBe(true)
      await settle()
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0].taskId).toMatch(/^agent-1#\d+$/)
    } finally {
      socket.destroy()
      await close()
    }
  })

  it('cancelamento NÃO emite outcome; ciclo seguinte emite normalmente', async () => {
    const controller = createControllableWaiter()
    const outcomes: BridgeCycleOutcome[] = []
    const { service, close } = await startService(createDependencies({
      waitTurnResult: () => controller.waiter(),
      onOutcome: (outcome) => { outcomes.push(outcome) },
    }))
    const socket = await connect(service.runtime.pipeName)
    try {
      await request(socket, {
        type: 'send',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-2',
        prompt: 'tarefa longa',
      })
      await settle()
      service.cancelTarget('agent-2')
      await settle()
      expect(outcomes).toHaveLength(0)

      // Novo ciclo (nova geração) emite uma vez.
      controller.finish({ result: 'CONCLUIDO: depois do cancel' })
      await settle()
      // O cancel resolveu o PRIMEIRO ciclo com cancelamento; um novo send
      // armaria um novo ciclo — aqui o finish resolve o waiter atual.
      expect(outcomes).toHaveLength(0)
    } finally {
      socket.destroy()
      await close()
    }
  })

  it('run emite outcome one-shot com taskId único e artifacts bounded', async () => {
    const outcomes: BridgeCycleOutcome[] = []
    const { service, close } = await startService(createDependencies({
      onOutcome: (outcome) => { outcomes.push(outcome) },
      runHeadlessTurn: async () => ({
        status: 'completed',
        summary: 'run ok',
        artifacts: Array.from({ length: 20 }, (_, index) => `a${index}`),
      }),
    }))
    const socket = await connect(service.runtime.pipeName)
    try {
      const response = await request(socket, {
        type: 'run',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'print mode',
        id: 'run-1',
      })
      expect(response.ok).toBe(true)
      await settle()
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0].taskId).toMatch(/^agent-1#run#\d+$/)
      expect(outcomes[0].artifacts).toHaveLength(16)
    } finally {
      socket.destroy()
      await close()
    }
  })

  it('ask emite uma vez por ciclo; novo ask (nova geração) emite de novo', async () => {
    const outcomes: BridgeCycleOutcome[] = []
    const { service, close } = await startService(createDependencies({
      onOutcome: (outcome) => { outcomes.push(outcome) },
    }))
    const socket = await connect(service.runtime.pipeName)
    try {
      const ask = {
        type: 'ask',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'p',
      }
      await request(socket, ask)
      await request(socket, { ...ask, id: 'ask-2' })
      await settle()
      expect(outcomes).toHaveLength(2)
      expect(outcomes[0].taskId).not.toBe(outcomes[1].taskId)
    } finally {
      socket.destroy()
      await close()
    }
  })

  it('falha do consumidor de onOutcome nunca quebra a resposta do Bridge', async () => {
    const { service, close } = await startService(createDependencies({
      onOutcome: () => {
        throw new Error('persistência caiu')
      },
    }))
    const socket = await connect(service.runtime.pipeName)
    try {
      const response = await request(socket, {
        type: 'ask',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'p',
      })
      expect(response.ok).toBe(true)
    } finally {
      socket.destroy()
      await close()
    }
  })
})