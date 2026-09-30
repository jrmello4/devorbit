import { describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import { serializeAgentBridgeMessage } from '../src/main/agent-bridge'
import { createBridgeService, type BridgeInstructionInput, type BridgeServiceDependencies } from '../src/main/bridge-service'
import { sendAgentInstruction } from '../src/main/agent-instruction'
import { createTerminalReadiness } from '../src/main/terminal-readiness'
import type { TerminalEvent } from '../src/main/terminal-session'

interface BridgeResponse {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
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
      if (newline !== -1) {
        socket.off('data', onData)
        try {
          resolve(JSON.parse(pending.slice(0, newline)) as BridgeResponse)
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
    }
    socket.on('data', onData)
    socket.write(serializeAgentBridgeMessage(message))
  })
}

function createDependencies(overrides: Partial<BridgeServiceDependencies> = {}): {
  dependencies: BridgeServiceDependencies
  order: string[]
  instructions: BridgeInstructionInput[]
} {
  const order: string[] = []
  const instructions: BridgeInstructionInput[] = []
  const dependencies: BridgeServiceDependencies = {
    cliDirectory: process.cwd(),
    hasTerminal: (id) => id === 'agent-1',
    waitTurnResult: () => {
      order.push('waiter')
      const promise = Promise.resolve({ result: 'CONCLUIDO: ok' }) as ReturnType<BridgeServiceDependencies['waitTurnResult']>
      promise.cancel = () => undefined
      return promise
    },
    sendInstruction: (input) => {
      order.push('instruction')
      instructions.push(input)
      return Promise.resolve({ acked: true, attempts: 1 })
    },
    onEvent: () => undefined,
    ...overrides,
  }
  return { dependencies, order, instructions }
}

/**
 * Pilha REAL de instrução (sendAgentInstruction + createTerminalReadiness) sobre
 * um barramento de eventos de PTY falso — espelha o wiring de index.ts com
 * tempos curtos. `emit` simula a saída do terminal; `writes` registra cada
 * escrita feita no "PTY".
 */
function createInstructionStack(): {
  sendInstruction: BridgeServiceDependencies['sendInstruction']
  writes: string[]
  emit: (event: TerminalEvent) => void
} {
  const listeners = new Set<(event: TerminalEvent) => void>()
  const writes: string[] = []
  const subscribe = (listener: (event: TerminalEvent) => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const readiness = createTerminalReadiness(subscribe)
  const sendInstruction: BridgeServiceDependencies['sendInstruction'] = (input) => sendAgentInstruction(
    {
      hasTerminal: (id) => id === 'agent-1',
      waitReady: readiness.waitReady,
      write: (_id, data) => {
        writes.push(data)
        return true
      },
      subscribe,
      now: () => Date.now(),
    },
    // Tempos curtos apenas para o teste: quietude 100ms (módulo impõe mínimo),
    // prontidão em 500ms, settle de eco 20ms e ack em 200ms.
    { ...input, provider: input.provider ?? 'unknown', quietMs: 100, timeoutMs: 500, ackTimeoutMs: 200, echoSettleMs: 20 },
  )
  const emit = (event: TerminalEvent): void => {
    for (const listener of [...listeners]) listener(event)
  }
  return { sendInstruction, writes, emit }
}

async function startService(dependencies: BridgeServiceDependencies): Promise<{
  service: ReturnType<typeof createBridgeService>
  close: () => void
}> {
  const service = createBridgeService(dependencies)
  service.registerAgent('agent-1', { provider: 'opencode', model: 'm', projectPath: '/p' })
  service.runtime.start()
  return { service, close: () => service.runtime.stop() }
}

describe('bridge instruction path — send/ask via sendInstruction (sendAgentInstruction)', () => {
  it('agent.send arma o waiter antes da instrução e envia turno determinístico', async () => {
    const { dependencies, order, instructions } = createDependencies()
    const { service, close } = await startService(dependencies)
    const socket = await connect(service.runtime.pipeName)
    try {
      const response = await request(socket, {
        type: 'send',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'faça algo',
      })
      expect(response).toMatchObject({ ok: true, result: { accepted: true, target: 'agent-1' } })
      // O waiter do resultado é armado ANTES do sendInstruction: o ack e o
      // DEVORBIT_RESULT são observadores independentes do mesmo barramento.
      expect(order).toEqual(['waiter', 'instruction'])
      expect(instructions[0]).toMatchObject({
        terminalId: 'agent-1',
        turnId: 'bridge_agent-1_1',
        content: 'faça algo',
        provider: 'opencode',
      })
      expect(typeof instructions[0].since).toBe('number')
    } finally {
      socket.destroy()
      close()
    }
  })

  it('agent.send com TUI nunca pronta falha com erro explícito e ZERO writes no PTY', async () => {
    const stack = createInstructionStack()
    const { dependencies } = createDependencies({ sendInstruction: stack.sendInstruction })
    const { service, close } = await startService(dependencies)
    const socket = await connect(service.runtime.pipeName)
    // O servidor do bridge responde erro genérico; o erro EXPLÍCITO vai para o
    // log de orquestração ([orchestration]) — capturamos para validá-lo.
    const logs: unknown[][] = []
    const logSpy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      logs.push(args)
    })
    // TUI em boot contínuo: saída a cada 30ms impede a quietude de 100ms até o
    // timeout de prontidão (500ms) estourar.
    const booting = setInterval(() => stack.emit({ id: 'agent-1', type: 'data', data: 'booting...' }), 30)
    try {
      const response = await request(socket, {
        type: 'send',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'faça algo',
      })
      clearInterval(booting)
      expect(response.ok).toBe(false)
      expect(response.error?.code).toBe('HANDLER_ERROR')
      expect(logs.some((args) => args.join(' ').includes('não ficou pronta'))).toBe(true)
      // Prontidão por timeout NÃO autoriza escrita: nem conteúdo nem Enter.
      expect(stack.writes).toEqual([])
    } finally {
      logSpy.mockRestore()
      clearInterval(booting)
      socket.destroy()
      close()
    }
  })

  it('agent.ask com TUI pronta escreve conteúdo + UM Enter e o waiter recebe o resultado', async () => {
    const stack = createInstructionStack()
    const { dependencies } = createDependencies({ sendInstruction: stack.sendInstruction })
    const { service, close } = await startService(dependencies)
    const socket = await connect(service.runtime.pipeName)
    try {
      const responsePromise = request(socket, {
        type: 'ask',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'faça algo',
      })
      // Prontidão por silêncio desde a âncora (~100ms), depois conteúdo + Enter.
      await expect.poll(() => stack.writes.length, { timeout: 5_000 }).toBe(2)
      expect(stack.writes).toEqual(['faça algo', '\r'])
      // O eco/redraw da TUI confirma o ack (emitido após o settle de 20ms);
      // o waiter (fake) já devolve o resultado.
      await new Promise((resolve) => setTimeout(resolve, 30))
      stack.emit({ id: 'agent-1', type: 'data', data: 'faça algo\r\n> ' })
      const response = await responsePromise
      expect(response).toMatchObject({ ok: true })
      expect(response.result).toMatchObject({ status: 'completed', summary: 'CONCLUIDO: ok' })
    } finally {
      socket.destroy()
      close()
    }
  })

  it('retry de submit reenvia APENAS o Enter: conteúdo 1×, Enter 2×', async () => {
    const stack = createInstructionStack()
    const { dependencies } = createDependencies({ sendInstruction: stack.sendInstruction })
    const { service, close } = await startService(dependencies)
    const socket = await connect(service.runtime.pipeName)
    try {
      const responsePromise = request(socket, {
        type: 'ask',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'faça algo',
      })
      await expect.poll(() => stack.writes.length, { timeout: 5_000 }).toBe(2)
      // Sem eco na 1ª tentativa: após o timeout de ack (200ms) o retry envia
      // somente o Enter — reenviar o conteúdo duplicaria a tarefa.
      await expect.poll(() => stack.writes.length, { timeout: 5_000 }).toBe(3)
      expect(stack.writes).toEqual(['faça algo', '\r', '\r'])
      // Ack chega na 2ª tentativa (após o settle de eco).
      await new Promise((resolve) => setTimeout(resolve, 30))
      stack.emit({ id: 'agent-1', type: 'data', data: '> ' })
      const response = await responsePromise
      expect(response.result).toMatchObject({ status: 'completed', summary: 'CONCLUIDO: ok' })
    } finally {
      socket.destroy()
      close()
    }
  })

  it('falha de instrução cancela o ciclo pendente: o próximo send não é bloqueado', async () => {
    const stack = createInstructionStack()
    const { dependencies } = createDependencies({ sendInstruction: stack.sendInstruction })
    const { service, close } = await startService(dependencies)
    const socket = await connect(service.runtime.pipeName)
    const booting = setInterval(() => stack.emit({ id: 'agent-1', type: 'data', data: 'booting...' }), 30)
    try {
      const failed = await request(socket, {
        type: 'send',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'primeira',
      })
      clearInterval(booting)
      expect(failed.ok).toBe(false)
      // O ciclo cancelado não pode deixar pending: um novo send no mesmo alvo
      // executa em vez de falhar com "já possui uma tarefa aguardando".
      const secondPromise = request(socket, {
        type: 'send',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'segunda',
      })
      // Agora pronta (silêncio): conteúdo + Enter escritos; o eco (após o
      // settle) confirma o ack.
      await expect.poll(() => stack.writes.length, { timeout: 5_000 }).toBe(2)
      expect(stack.writes).toEqual(['segunda', '\r'])
      await new Promise((resolve) => setTimeout(resolve, 30))
      stack.emit({ id: 'agent-1', type: 'data', data: 'segunda\r\n> ' })
      const second = await secondPromise
      expect(second).toMatchObject({ ok: true, result: { accepted: true } })
    } finally {
      clearInterval(booting)
      socket.destroy()
      close()
    }
  })

  it('abort de ask via context.signal não persiste outcome nem trava o alvo', async () => {
    const outcomes: { taskId: string; summary: string }[] = []
    let waiterStarted = 0
    let releaseFirstWaiter: (() => void) | undefined
    let resolveFirstWaiter!: (value: { result?: string; error?: string }) => void
    const { dependencies } = createDependencies({
      waitTurnResult: () => {
        waiterStarted += 1
        if (waiterStarted > 1) {
          const promise = Promise.resolve({ result: 'CONCLUIDO: segunda' }) as ReturnType<BridgeServiceDependencies['waitTurnResult']>
          promise.cancel = () => undefined
          return promise
        }
        const promise = new Promise<{ result?: string }>((resolve) => {
          resolveFirstWaiter = resolve
        }) as ReturnType<BridgeServiceDependencies['waitTurnResult']>
        releaseFirstWaiter = () => resolveFirstWaiter({ result: 'CONCLUIDO: tarde demais' })
        // Mesmo contrato do waiter real: cancel resolve com erro de cancelamento.
        promise.cancel = () => resolveFirstWaiter({ error: 'A espera do resultado foi cancelada.' })
        return promise
      },
      onOutcome: (outcome) => {
        outcomes.push({ taskId: outcome.taskId, summary: outcome.summary })
      },
    })
    const { service, close } = await startService(dependencies)
    const socket = await connect(service.runtime.pipeName)
    try {
      const abortedAsk = request(socket, {
        type: 'ask',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'vai ser abortada',
      })
      // A resposta nunca chega (socket destruído); rejeição é esperada.
      void abortedAsk.catch(() => undefined)
      await expect.poll(() => waiterStarted, { timeout: 5_000 }).toBe(1)
      // Desconectar aborta o context.signal do handler (runtime do bridge):
      // o waiter é cancelado e o ask encerra sem cache nem outcome persistido.
      socket.destroy()

      const nextSocket = await connect(service.runtime.pipeName)
      try {
        const next = await request(nextSocket, {
          type: 'ask',
          token: service.runtime.token,
          sessionId: service.runtime.sessionId,
          target: 'agent-1',
          prompt: 'segunda',
        })
        expect(next).toMatchObject({ ok: true, result: { status: 'completed', summary: 'CONCLUIDO: segunda' } })
        // Só o ciclo do segundo ask emite outcome; o abortado não vira "sucesso"
        // nem "falha" persistida — e o release do 1º waiter é ignorado.
        releaseFirstWaiter?.()
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(outcomes).toEqual([expect.objectContaining({ summary: 'CONCLUIDO: segunda' })])
      } finally {
        nextSocket.destroy()
      }
    } finally {
      close()
    }
  })
})
