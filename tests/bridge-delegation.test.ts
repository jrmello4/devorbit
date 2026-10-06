import { describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import { serializeAgentBridgeMessage } from '../src/main/agent-bridge'
import { createBridgeService, type BridgeServiceDependencies, type BridgeService } from '../src/main/bridge-service'
import type { AgentBridgeEvent } from '../src/shared/agent-bridge-event'
import { sendAgentInstruction } from '../src/main/agent-instruction'
import type { TerminalEvent } from '../src/main/terminal-session'

interface BridgeResponse {
  ok: boolean
  result?: Record<string, unknown>
  error?: { code: string; message: string }
}

function createDependencies(overrides: Partial<BridgeServiceDependencies> = {}): BridgeServiceDependencies {
  return {
    cliDirectory: '/cli',
    hasTerminal: (id) => id === 'agent-1' || id === 'agent-2',
    waitAgentReady: async () => ({ timedOut: false }),
    waitTurnResult: () => {
      const promise = Promise.resolve({ result: 'CONCLUIDO: ok' }) as ReturnType<BridgeServiceDependencies['waitTurnResult']>
      promise.cancel = () => undefined
      return promise
    },
    sendInstruction: async () => ({ acked: true, attempts: 1 }),
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
  it('roundtrip autenticado observa entrega, submit, resultado com nonce e worker pronto; eco não conclui', async () => {
    const listeners = new Set<(event: TerminalEvent) => void>()
    const subscribe = (listener: (event: TerminalEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
    const emit = (data: string) => { for (const listener of [...listeners]) listener({ id: 'agent-1', type: 'data', data }) }
    let content = ''
    let nonce = ''
    const phases: string[] = []
    const deps = createDependencies({ subscribe,
      onDiagnostic: event => phases.push(event.phase),
      sendInstruction: input => {
        nonce = input.turnId
        return sendAgentInstruction({ hasTerminal: () => true, waitReady: async () => ({ timedOut: false }),
          subscribe, now: () => Date.now(), write: (_id, data) => {
            if (data !== '\r') { content = data; emit(data); return true }
            setTimeout(() => emit(`\r\n• DEVORBIT_RESULT_${nonce}: {"version":1,"outcome":"completed","summary":"DEVORBIT_BRIDGE_OK"}\r\n`), 0)
            return true
          } }, { ...input, provider: 'codex', echoSettleMs: 10, ackTimeoutMs: 100 })
      },
    })
    const { service, close } = await startService(deps)
    const socket = await connect(service.runtime.pipeName)
    try {
      expect(service.listAgents()[0]).toMatchObject({ status: 'ready', terminalExists: true, operational: true })
      const response = await request(socket, { type: 'ask', token: service.runtime.token, sessionId: service.runtime.sessionId,
        target: 'agent-1', prompt: 'Responda apenas DEVORBIT_BRIDGE_OK. Não altere arquivos.', timeoutMs: 2000 })
      expect(response).toMatchObject({ ok: true, result: { status: 'completed', summary: 'DEVORBIT_BRIDGE_OK',
        diagnostic: { turnId: nonce, terminalId: 'agent-1' } } })
      expect(service.listAgents()[0]).toMatchObject({ status: 'ready', operational: true })
      expect(phases).toEqual(expect.arrayContaining(['content_written', 'submit_sent', 'acked', 'result_marker_seen', 'result_parsed', 'turn_completed']))
      expect(content).toContain(`DEVORBIT_RESULT_${nonce}:`)
      expect(content).not.toContain('{"version"')
    } finally { socket.destroy(); await close() }
  })

  it('fatal de modelo no startup é distinto de um terminal operacional e recusa delegação', async () => {
    const listeners = new Set<(event: TerminalEvent) => void>()
    const { service, close } = await startService(createDependencies({ waitAgentReady: () => new Promise(() => undefined), subscribe: listener => {
      listeners.add(listener); return () => { listeners.delete(listener) }
    } }))
    const socket = await connect(service.runtime.pipeName)
    try {
      for (const data of ['Error: unknown mo', 'del']) {
        for (const listener of [...listeners]) listener({ id: 'agent-1', type: 'data', data })
      }
      expect(service.listAgents()[0]).toMatchObject({ status: 'failed', reason: 'model_configuration_error', operational: false })
      for (const listener of [...listeners]) listener({ id: 'agent-1', type: 'exit', code: 1 })
      expect(service.listAgents()[0]).toMatchObject({ status: 'stopped', failureCode: 'AGENT_STARTUP_CONFIGURATION_INVALID' })
      const response = await request(socket, { type: 'ask', token: service.runtime.token, sessionId: service.runtime.sessionId,
        target: 'agent-1', prompt: 'não executar' })
      expect(response).toMatchObject({ ok: false, error: { code: 'AGENT_STARTUP_FAILED', data: {
        phase: 'target_validation', status: 'stopped', turnCreated: false,
        failureCode: 'AGENT_STARTUP_CONFIGURATION_INVALID',
      } } })
    } finally { socket.destroy(); await close() }
  })
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
