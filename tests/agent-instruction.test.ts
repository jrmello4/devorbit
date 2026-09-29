import { describe, expect, it, vi } from 'vitest'
import { sendAgentInstruction, type AgentInstructionDeps } from '../src/main/agent-instruction'
import { AGENT_SUBMIT_SEQUENCE } from '../src/shared/agent-instruction-contract'
import type { TerminalEvent } from '../src/main/terminal-session'

interface InstructionHarness {
  deps: AgentInstructionDeps
  writes: Array<{ id: string; data: string }>
  live: Set<string>
  listeners: Set<(event: TerminalEvent) => void>
  emit: (event: TerminalEvent) => void
}

function createInstructionHarness(options: { terminalIds?: string[] } = {}): InstructionHarness {
  const listeners = new Set<(event: TerminalEvent) => void>()
  const writes: Array<{ id: string; data: string }> = []
  const live = new Set<string>(options.terminalIds ?? ['t1'])
  const deps: AgentInstructionDeps = {
    hasTerminal: (id) => live.has(id),
    waitReady: vi.fn(() => Promise.resolve({ timedOut: false })),
    write: vi.fn((id: string, data: string) => {
      writes.push({ id, data })
      return live.has(id)
    }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    now: () => Date.now(),
  }
  return {
    deps,
    writes,
    live,
    listeners,
    emit: (event) => listeners.forEach((listener) => listener(event)),
  }
}

describe('sendAgentInstruction (submissão centralizada)', () => {
  it('C1: escreve o conteúdo e UMA sequência de submit, nessa ordem, no terminal certo', async () => {
    const harness = createInstructionHarness()
    const pending = sendAgentInstruction(harness.deps, {
      terminalId: 't1',
      turnId: 'task-c1',
      content: 'revise a arquitetura',
      provider: 'codex',
      ackTimeoutMs: 200,
    })
    // O echo do CLI chega logo após o submit.
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2))
    harness.emit({ id: 't1', type: 'data', data: 'revise a arquitetura\r\n> ' })
    await expect(pending).resolves.toMatchObject({ acked: true, attempts: 1 })
    expect(harness.writes).toEqual([
      { id: 't1', data: 'revise a arquitetura' },
      { id: 't1', data: AGENT_SUBMIT_SEQUENCE },
    ])
  })

  it('C2: TUI não pronta (timeout sem quietude) não escreve NADA; prontidão resolvendo libera a escrita', async () => {
    vi.useFakeTimers()
    try {
      const harness = createInstructionHarness()
      const readyGate: { resolve: ((result: { timedOut: boolean }) => void) | null } = { resolve: null }
      harness.deps.waitReady = vi.fn(
        () => new Promise<{ timedOut: boolean }>((resolve) => { readyGate.resolve = resolve })
      )

      const timedOut = sendAgentInstruction(harness.deps, {
        terminalId: 't1',
        turnId: 'task-c2a',
        content: 'tarefa',
        provider: 'codex',
      })
      readyGate.resolve?.({ timedOut: true })
      const failed = await timedOut
      expect(failed).toMatchObject({ acked: false, attempts: 0 })
      expect(failed.error).toMatch(/n(ã|a)o ficou pronta/i)
      expect(harness.writes).toHaveLength(0)

      // Prontidão resolvendo de verdade → escreve.
      const pending = sendAgentInstruction(harness.deps, {
        terminalId: 't1',
        turnId: 'task-c2b',
        content: 'tarefa',
        provider: 'codex',
        ackTimeoutMs: 100,
      })
      readyGate.resolve?.({ timedOut: false })
      await vi.advanceTimersByTimeAsync(1)
      expect(harness.writes.length).toBeGreaterThan(0)
      harness.emit({ id: 't1', type: 'data', data: 'echo' })
      await expect(pending).resolves.toMatchObject({ acked: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('C3: sem ack → um re-submit de apenas o Enter → sem ack de novo → falha explícita', async () => {
    const harness = createInstructionHarness()
    const result = await sendAgentInstruction(harness.deps, {
      terminalId: 't1',
      turnId: 'task-c3',
      content: 'tarefa única',
      provider: 'codex',
      ackTimeoutMs: 30,
      maxSubmitAttempts: 2,
    })
    expect(result).toMatchObject({ acked: false, attempts: 2 })
    expect(result.error).toMatch(/n(ã|a)o confirmou o recebimento/i)
    // Conteúdo UMA vez; Enter duas vezes (submissão + retry). Nada duplicado.
    expect(harness.writes).toEqual([
      { id: 't1', data: 'tarefa única' },
      { id: 't1', data: AGENT_SUBMIT_SEQUENCE },
      { id: 't1', data: AGENT_SUBMIT_SEQUENCE },
    ])
  })

  it('C4: ack pós-submit → nenhuma re-submissão', async () => {
    const harness = createInstructionHarness()
    const pending = sendAgentInstruction(harness.deps, {
      terminalId: 't1',
      turnId: 'task-c4',
      content: 'tarefa',
      provider: 'codex',
      ackTimeoutMs: 5_000,
    })
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2))
    harness.emit({ id: 't1', type: 'data', data: 'redraw do prompt' })
    await expect(pending).resolves.toMatchObject({ acked: true, attempts: 1 })
    expect(harness.writes).toHaveLength(2)
  })

  it('C5: terminal ausente falha sem escrever e sem attempts', async () => {
    const harness = createInstructionHarness()
    harness.live.delete('t1')
    const result = await sendAgentInstruction(harness.deps, {
      terminalId: 't1',
      turnId: 'task-c5',
      content: 'tarefa',
      provider: 'codex',
    })
    expect(result).toMatchObject({ acked: false, attempts: 0 })
    expect(harness.writes).toHaveLength(0)
    expect(result.error).toMatch(/n(ã|a)o existe/i)
  })

  it('C6: instruções simultâneas em dois terminais não cruzam', async () => {
    const first = createInstructionHarness({ terminalIds: ['t1'] })
    const second = createInstructionHarness({ terminalIds: ['t2'] })
    const pendingFirst = sendAgentInstruction(first.deps, {
      terminalId: 't1',
      turnId: 'task-a',
      content: 'instrução do primeiro',
      provider: 'opencode',
      ackTimeoutMs: 5_000,
    })
    const pendingSecond = sendAgentInstruction(second.deps, {
      terminalId: 't2',
      turnId: 'task-b',
      content: 'instrução do segundo',
      provider: 'claude',
      ackTimeoutMs: 5_000,
    })
    await vi.waitFor(() => {
      expect(first.writes).toHaveLength(2)
      expect(second.writes).toHaveLength(2)
    })
    first.emit({ id: 't1', type: 'data', data: 'ack primeiro' })
    second.emit({ id: 't2', type: 'data', data: 'ack segundo' })
    await expect(pendingFirst).resolves.toMatchObject({ acked: true, attempts: 1 })
    await expect(pendingSecond).resolves.toMatchObject({ acked: true, attempts: 1 })
    expect(first.writes).toEqual([
      { id: 't1', data: 'instrução do primeiro' },
      { id: 't1', data: AGENT_SUBMIT_SEQUENCE },
    ])
    expect(second.writes).toEqual([
      { id: 't2', data: 'instrução do segundo' },
      { id: 't2', data: AGENT_SUBMIT_SEQUENCE },
    ])
  })

  it('C7: conteúdo multiline vai verbatim com um único submit (nada por linha)', async () => {
    const harness = createInstructionHarness()
    const content = 'linha 1\nlinha 2\nlinha 3'
    const pending = sendAgentInstruction(harness.deps, {
      terminalId: 't1',
      turnId: 'task-c7',
      content,
      provider: 'codex',
      ackTimeoutMs: 5_000,
    })
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2))
    harness.emit({ id: 't1', type: 'data', data: 'echo multiline' })
    await expect(pending).resolves.toMatchObject({ acked: true, attempts: 1 })
    expect(harness.writes).toEqual([
      { id: 't1', data: content },
      { id: 't1', data: AGENT_SUBMIT_SEQUENCE },
    ])
  })

  it('falha imediatamente quando o terminal recusa a escrita do conteúdo', async () => {
    const harness = createInstructionHarness()
    harness.deps.write = vi.fn((id: string, data: string) => {
      if (data === AGENT_SUBMIT_SEQUENCE) throw new Error('não deveria submeter após recusa')
      harness.writes.push({ id, data })
      return false
    })
    const result = await sendAgentInstruction(harness.deps, {
      terminalId: 't1',
      turnId: 'task-recusa',
      content: 'tarefa',
      provider: 'codex',
    })
    expect(result).toMatchObject({ acked: false, attempts: 1 })
    expect(result.error).toMatch(/recusou o conteúdo/i)
    expect(harness.writes).toHaveLength(1)
  })

  it('reconhece o ack que chega antes do submit terminar (corrida com o PTY)', async () => {
    const harness = createInstructionHarness()
    harness.deps.write = vi.fn((id: string, data: string) => {
      harness.writes.push({ id, data })
      // O CLI ecoa no mesmo ciclo da escrita do Enter.
      if (data === AGENT_SUBMIT_SEQUENCE) harness.emit({ id, type: 'data', data: 'echo imediato' })
      return true
    })
    const result = await sendAgentInstruction(harness.deps, {
      terminalId: 't1',
      turnId: 'task-sync',
      content: 'tarefa',
      provider: 'codex',
      ackTimeoutMs: 5_000,
    })
    expect(result).toMatchObject({ acked: true, attempts: 1 })
    expect(harness.writes).toHaveLength(2)
  })
})
