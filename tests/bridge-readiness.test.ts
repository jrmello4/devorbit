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

  it('abort durante a INSTRUÇÃO (context.signal via sendInstruction): sem retry, sem outcome, próximo send funciona', async () => {
    const stack = createInstructionStack()
    const outcomes: { taskId: string; summary: string }[] = []
    let waiterStarted = 0
    let releaseFirstWaiter: (() => void) | undefined
    let resolveFirstWaiter!: (value: { result?: string; error?: string }) => void
    const { dependencies } = createDependencies({
      sendInstruction: stack.sendInstruction,
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
        releaseFirstWaiter = () => resolveFirstWaiter({ result: 'CONCLUIDO: tarde' })
        promise.cancel = () => resolveFirstWaiter({ error: 'A espera do resultado foi cancelada.' })
        return promise
      },
      onOutcome: (outcome) => {
        outcomes.push({ taskId: outcome.taskId, summary: outcome.summary })
      },
    })
    const { service, close } = await startService(dependencies)
    const socket = await connect(service.runtime.pipeName)
    // Fases de orquestração capturadas para auditar a fase `cancelled`.
    const logs: unknown[][] = []
    const logSpy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      logs.push(args)
    })
    try {
      const abortedSend = request(socket, {
        type: 'send',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'primeira',
      })
      void abortedSend.catch(() => undefined)
      // Prontidão (~100ms de silêncio) → conteúdo + Enter escritos.
      await expect.poll(() => stack.writes.length, { timeout: 5_000 }).toBe(2)
      // Desconectar aborta o context.signal do handler DURANTE o awaiting_ack:
      // sendAgentInstruction para, devolve cancelled e o Bridge propaga o erro
      // (code `cancelled` no serviço; o fio mantém o HANDLER_ERROR genérico).
      socket.destroy()
      // Passado o ack timeout (200ms): NENHUM retry_submit — writes ficam em 2.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(stack.writes).toEqual(['primeira', '\r'])
      // Fase `cancelled` (não `failed`/`retry_submit`) nos logs da instrução abortada.
      expect(logs.some((args) => args.includes('cancelled'))).toBe(true)
      // Ciclo cancelado: waiter descartado, release tardio ignorado, NADA
      // persistido como outcome.
      releaseFirstWaiter?.()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(outcomes).toEqual([])

      // O ciclo cancelado não trava o alvo: o próximo send no MESMO terminal
      // executa (lock liberado, sem "já possui uma tarefa aguardando").
      const nextSocket = await connect(service.runtime.pipeName)
      try {
        const secondPromise = request(nextSocket, {
          type: 'send',
          token: service.runtime.token,
          sessionId: service.runtime.sessionId,
          target: 'agent-1',
          prompt: 'segunda',
        })
        await expect.poll(() => stack.writes.length, { timeout: 5_000 }).toBe(4)
        expect(stack.writes.slice(2)).toEqual(['segunda', '\r'])
        await new Promise((resolve) => setTimeout(resolve, 30))
        stack.emit({ id: 'agent-1', type: 'data', data: 'segunda\r\n> ' })
        const second = await secondPromise
        const errs = vi.spyOn(console, 'error').mockImplementation(() => {})
      console.log('SECOND_RESPONSE:', JSON.stringify(second))
      errs.mockRestore()
      expect(second).toMatchObject({ ok: true, result: { accepted: true, target: 'agent-1' } })
        // Só o ciclo do segundo send emite outcome.
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(outcomes).toEqual([expect.objectContaining({ summary: 'CONCLUIDO: segunda' })])
      } finally {
        nextSocket.destroy()
      }
    } finally {
      logSpy.mockRestore()
      close()
    }
  })

  it('ask com instrução cancelada: signal chega à instrução, waiter cancelado e erro propagado sem outcome', async () => {
    const outcomes: { taskId: string; summary: string }[] = []
    let cancelCalls = 0
    let seenSignal: AbortSignal | undefined
    let waiterCalls = 0
    let instructionCalls = 0
    const { dependencies } = createDependencies({
      sendInstruction: async (input) => {
        instructionCalls += 1
        if (instructionCalls > 1) return { acked: true, attempts: 1 }
        // O context.signal da requisição flui até a instrução.
        seenSignal = input.signal
        return { acked: false, attempts: 1, cancelled: true, error: 'Envio da instrução foi cancelado.' }
      },
      waitTurnResult: () => {
        waiterCalls += 1
        if (waiterCalls > 1) {
          const promise = Promise.resolve({ result: 'CONCLUIDO: ok' }) as ReturnType<BridgeServiceDependencies['waitTurnResult']>
          promise.cancel = () => undefined
          return promise
        }
        const promise = new Promise<{ result?: string }>(() => undefined) as ReturnType<BridgeServiceDependencies['waitTurnResult']>
        promise.cancel = () => {
          cancelCalls += 1
        }
        return promise
      },
      onOutcome: (outcome) => {
        outcomes.push({ taskId: outcome.taskId, summary: outcome.summary })
      },
    })
    const { service, close } = await startService(dependencies)
    const socket = await connect(service.runtime.pipeName)
    try {
      const response = await request(socket, {
        type: 'ask',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'vai ser cancelada',
      })
      // O cancelamento é erro na resposta (o fio mantém o HANDLER_ERROR genérico
      // do runtime; o code `cancelled` vive no erro lançado dentro do serviço).
      expect(response.ok).toBe(false)
      expect(response.error?.code).toBe('HANDLER_ERROR')
      // O signal da requisição chegou à instrução e o waiter foi cancelado.
      expect(seenSignal).toBeInstanceOf(AbortSignal)
      expect(seenSignal?.aborted).toBe(false)
      expect(cancelCalls).toBe(1)
      // Cancelamento nunca vira outcome persistido.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(outcomes).toEqual([])

      // O alvo não fica travado: o próximo ask no MESMO terminal funciona.
      const second = await request(socket, {
        type: 'ask',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'segunda',
      })
      expect(second).toMatchObject({ ok: true, result: { status: 'completed', summary: 'CONCLUIDO: ok' } })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(outcomes).toEqual([expect.objectContaining({ summary: 'CONCLUIDO: ok' })])
    } finally {
      socket.destroy()
      close()
    }
  })

  it('send com instrução cancelada: ciclo cancelado e o próximo send não é bloqueado', async () => {
    let instructionCalls = 0
    const { dependencies } = createDependencies({
      sendInstruction: async () => {
        instructionCalls += 1
        if (instructionCalls > 1) return { acked: true, attempts: 1 }
        return { acked: false, attempts: 0, cancelled: true, error: 'Envio da instrução foi cancelado.' }
      },
    })
    const { service, close } = await startService(dependencies)
    const socket = await connect(service.runtime.pipeName)
    try {
      const first = await request(socket, {
        type: 'send',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'primeira',
      })
      expect(first.ok).toBe(false)
      // O cancelamento não deixa pendência: o próximo send executa em vez de
      // falhar com "já possui uma tarefa aguardando".
      const second = await request(socket, {
        type: 'send',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'segunda',
      })
      expect(second).toMatchObject({ ok: true, result: { accepted: true, target: 'agent-1' } })
    } finally {
      socket.destroy()
      close()
    }
  })
})


describe('cancelamento não contamina cache/reflexão (migração AbortSignal)', () => {
  const CANCELsummary = 'A espera do resultado foi cancelada.'

  it('outcome de cancelamento NÃO é cacheado nem refletido; wait seguinte recebe resultado fresco', async () => {
    const reflections: Array<{ target: string; outcome: { status: string; summary: string } }> = []
    const waiters: Array<(w: { result?: string; error?: string }) => void> = []
    let mode: 'cancelled' | 'ok' = 'cancelled'
    const { dependencies } = createDependencies({
      hasTerminal: (id) => id === 'agent-1',
      waitTurnResult: () => {
        const promise = new Promise<{ result?: string; error?: string }>((resolve) => {
          waiters.push((w) => resolve(w))
        }) as Promise<{ result?: string; error?: string }> & { cancel: () => void }
        promise.cancel = () => waiters.at(-1)?.({ error: CANCELsummary })
        return promise as never
      },
      sendInstruction: (input) => {
        void input
        if (mode === 'cancelled') {
          return Promise.resolve({ acked: false, attempts: 0, cancelled: true, error: 'Envio da instrução foi cancelado.' })
        }
        return Promise.resolve({ acked: true, attempts: 1 })
      },
      onReflection: (target, outcome) => {
        reflections.push({ target, outcome })
      },
    })
    const { service, close } = await startService(dependencies)
    const socket = await connect(service.runtime.pipeName)
    try {
      // Send #1: instrução cancelada → ciclo descartado; waiter fica armado.
      const first = await request(socket, {
        type: 'send',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        prompt: 'tarefa cancelada',
      })
      expect(first).toMatchObject({ ok: false })
      // Waiter resolve com o ERRO DE CANCELAMENTO (padrão do pending.cancel):
      // a migração não pode cachear nem refletir esse outcome.
      waiters.at(-1)?.({ error: CANCELsummary })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(reflections).toHaveLength(0)

      // Um wait seguinte NÃO pode receber o cancelamento do cache: com mode
      // 'ok' e o waiter ainda pendente, o wait NÃO resolve imediatamente com o
      // summary cancelado (cache serviria na hora).
      mode = 'ok'
      const waitPromise = request(socket, {
        type: 'wait',
        token: service.runtime.token,
        sessionId: service.runtime.sessionId,
        target: 'agent-1',
        timeoutMs: 400,
      })
      const raced = await Promise.race([
        waitPromise.then(() => 'resolved'),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 150)),
      ])
      expect(raced).toBe('pending')
      // Resolve o waiter real: sucesso fresco é o que deve voltar.
      waiters.at(-1)?.({ result: 'CONCLUIDO: fresco' })
      const settled = await waitPromise
      expect(settled).toMatchObject({ ok: true, result: { summary: 'CONCLUIDO: fresco' } })
      expect(reflections).toHaveLength(1)
      expect(reflections[0].outcome.summary).toBe('CONCLUIDO: fresco')
    } finally {
      socket.destroy()
      close()
    }
  })
})
