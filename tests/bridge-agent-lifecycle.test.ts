import { describe, expect, it } from 'vitest'
import net from 'node:net'
import { serializeAgentBridgeMessage } from '../src/main/agent-bridge'
import { createBridgeService, type BridgeServiceDependencies } from '../src/main/bridge-service'
import { createTerminalReadiness } from '../src/main/terminal-readiness'
import type { TerminalEvent } from '../src/main/terminal-session'

interface BridgeResponse {
  ok: boolean
  id?: string
  result?: Record<string, unknown>
  error?: { code: string; message: string; data?: Record<string, unknown> }
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
      if (newline < 0) return
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

function createHarness(options: { startupTimeoutMs?: number; neverReady?: boolean } = {}) {
  const listeners = new Set<(event: TerminalEvent) => void>()
  const subscribe = (listener: (event: TerminalEvent) => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const emit = (event: TerminalEvent): void => {
    for (const listener of [...listeners]) listener(event)
  }
  let terminalExists = true
  const startupTimeoutMs = options.startupTimeoutMs ?? 500
  const readiness = createTerminalReadiness(subscribe, { quietMs: 100, timeoutMs: startupTimeoutMs })
  let activeTurnId: string | undefined
  const dependencies: BridgeServiceDependencies = {
    cliDirectory: process.cwd(),
    hasTerminal: (id) => id === 'codex-worker' && terminalExists,
    subscribe,
    waitAgentReady: options.neverReady
      ? () => new Promise(() => undefined)
      : (id, waitOptions) => readiness.waitReady(id, waitOptions),
    waitTurnResult: () => {
      const pending = new Promise<{ result: string }>(() => undefined) as ReturnType<BridgeServiceDependencies['waitTurnResult']>
      pending.cancel = () => undefined
      return pending
    },
    sendInstruction: async (input) => {
      activeTurnId = input.turnId
      input.onPhase?.({
        kind: 'instruction', terminalId: input.terminalId, turnId: input.turnId,
        provider: input.provider ?? 'codex', phase: 'submit_sent', at: Date.now(), attempt: 1,
      })
      input.onPhase?.({
        kind: 'instruction', terminalId: input.terminalId, turnId: input.turnId,
        provider: input.provider ?? 'codex', phase: 'acked', at: Date.now(), attempt: 1,
      })
      return { acked: true, attempts: 1 }
    },
    onEvent: () => undefined,
  }
  const service = createBridgeService(dependencies, { startupTimeoutMs })
  service.registerAgent('codex-worker', { provider: 'codex', model: 'configured', projectPath: '/workspace' })
  service.runtime.start()
  const close = (socket?: net.Socket): void => {
    socket?.destroy()
    service.runtime.stop()
  }
  return {
    service,
    emit,
    exit: () => {
      terminalExists = false
      emit({ id: 'codex-worker', type: 'exit', code: 0 })
    },
    close,
    finishTurn: (summary: string) => {
      if (!activeTurnId) throw new Error('No active Bridge turn.')
      emit({
        id: 'codex-worker',
        type: 'data',
        data: `DEVORBIT_RESULT_${activeTurnId}:${JSON.stringify({ version: 1, outcome: 'completed', summary })}`,
      })
    },
  }
}

describe('Agent Bridge runtime readiness lifecycle', () => {
  it('registers Codex as starting, then publishes ready from the shared PTY readiness detector', async () => {
    const h = createHarness()
    try {
      expect(h.service.listAgents()[0]).toMatchObject({ provider: 'codex', status: 'starting', operational: false, terminalExists: true })
      h.emit({ id: 'codex-worker', type: 'data', data: 'Codex TUI prompt\n› ' })
      await expect.poll(() => h.service.listAgents()[0]?.status, { timeout: 1_000 }).toBe('ready')
      expect(h.service.listAgents()[0]).toMatchObject({ status: 'ready', operational: true, terminalExists: true })
      h.emit({ id: 'codex-worker', type: 'data', data: '\r\n› ' })
      expect(h.service.listAgents()[0]?.status).toBe('starting')
      await expect.poll(() => h.service.listAgents()[0]?.status, { timeout: 1_000 }).toBe('ready')
    } finally {
      h.close()
    }
  })

  it('moves starting to failed with AGENT_STARTUP_TIMEOUT when no provider output arrives', async () => {
    const h = createHarness({ startupTimeoutMs: 150 })
    try {
      await expect.poll(() => h.service.listAgents()[0]?.status, { timeout: 1_000 }).toBe('failed')
      expect(h.service.listAgents()[0]).toMatchObject({
        status: 'failed', operational: false, failureCode: 'AGENT_STARTUP_TIMEOUT',
      })
    } finally {
      h.close()
    }
  })

  it('reports a fatal startup message as failed instead of later promoting quiet output to ready', async () => {
    const h = createHarness()
    try {
      h.emit({ id: 'codex-worker', type: 'data', data: 'Error: unknown model requested\n' })
      expect(h.service.listAgents()[0]).toMatchObject({
        status: 'failed', operational: false, failureCode: 'AGENT_STARTUP_CONFIGURATION_INVALID',
      })
      await new Promise((resolve) => setTimeout(resolve, 130))
      expect(h.service.listAgents()[0]?.status).toBe('failed')
    } finally {
      h.close()
    }
  })

  it('rejects ask for a starting target before creating a turn and preserves safe validation data', async () => {
    const h = createHarness({ neverReady: true })
    const socket = await connect(h.service.runtime.pipeName)
    try {
      const response = await request(socket, {
        id: 'request-7', type: 'ask', token: h.service.runtime.token, sessionId: h.service.runtime.sessionId,
        target: 'codex-worker', prompt: 'must not leak',
      })
      expect(response).toMatchObject({
        ok: false,
        id: 'request-7',
        error: {
          code: 'AGENT_NOT_READY',
          data: {
            errorCode: 'AGENT_NOT_READY', phase: 'target_validation', requestId: 'request-7',
            agentId: 'codex-worker', provider: 'codex', status: 'starting', operational: false, turnCreated: false,
          },
        },
      })
    } finally {
      h.close(socket)
    }
  })

  it('marks an active task busy/operational, restores ready on completion, then stops on PTY exit', async () => {
    const h = createHarness()
    const socket = await connect(h.service.runtime.pipeName)
    try {
      h.emit({ id: 'codex-worker', type: 'data', data: 'Codex TUI prompt\n› ' })
      await expect.poll(() => h.service.listAgents()[0]?.status, { timeout: 1_000 }).toBe('ready')
      const responsePromise = request(socket, {
        type: 'ask', token: h.service.runtime.token, sessionId: h.service.runtime.sessionId,
        target: 'codex-worker', prompt: 'test turn',
      })
      await expect.poll(() => h.service.listAgents()[0]?.status, { timeout: 1_000 }).toBe('busy')
      expect(h.service.listAgents()[0]?.operational).toBe(true)
      h.finishTurn('structured result')
      expect(await responsePromise).toMatchObject({ ok: true, result: { status: 'completed', summary: 'structured result' } })
      expect(h.service.listAgents()[0]).toMatchObject({ status: 'ready', operational: true })
      h.exit()
      expect(h.service.listAgents()[0]).toMatchObject({ status: 'stopped', operational: false, terminalExists: false })
    } finally {
      h.close(socket)
    }
  })
})
