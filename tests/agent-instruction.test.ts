import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendAgentInstruction, type AgentInstructionDeps } from '../src/main/agent-instruction'
import { AGENT_SUBMIT_SEQUENCE } from '../src/shared/agent-instruction-contract'
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from '../src/main/terminal-paste-mode'
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

/** Espera real (timers do host) suficiente para atravessar o settle do eco. */
const waitMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('sendAgentInstruction (submissão centralizada)', () => {
  it('C1: escreve o conteúdo e UMA sequência de submit, nessa ordem; saída APÓS o settle confirma', async () => {
    const harness = createInstructionHarness()
    const pending = sendAgentInstruction(harness.deps, {
      terminalId: 't1',
      turnId: 'task-c1',
      content: 'revise a arquitetura',
      provider: 'codex',
      ackTimeoutMs: 5_000,
      echoSettleMs: 10,
    })
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2))
    await waitMs(30)
    // O redraw pós-settle (mesmo contendo o eco do prompt) confirma o ack.
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

      // Prontidão resolvendo de verdade → escreve; saída depois do settle → ack.
      const pending = sendAgentInstruction(harness.deps, {
        terminalId: 't1',
        turnId: 'task-c2b',
        content: 'tarefa',
        provider: 'codex',
        ackTimeoutMs: 200,
        echoSettleMs: 10,
      })
      readyGate.resolve?.({ timedOut: false })
      await vi.advanceTimersByTimeAsync(1)
      expect(harness.writes.length).toBeGreaterThan(0)
      // Atravessa o settle do eco e arma o observador de ack.
      await vi.advanceTimersByTimeAsync(20)
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
      echoSettleMs: 5,
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

  it('C4: redraw do prompt depois do settle → ack na primeira tentativa', async () => {
    const harness = createInstructionHarness()
    const pending = sendAgentInstruction(harness.deps, {
      terminalId: 't1',
      turnId: 'task-c4',
      content: 'tarefa',
      provider: 'codex',
      ackTimeoutMs: 5_000,
      echoSettleMs: 10,
    })
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2))
    await waitMs(30)
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
      echoSettleMs: 10,
    })
    const pendingSecond = sendAgentInstruction(second.deps, {
      terminalId: 't2',
      turnId: 'task-b',
      content: 'instrução do segundo',
      provider: 'claude',
      ackTimeoutMs: 5_000,
      echoSettleMs: 10,
    })
    await vi.waitFor(() => {
      expect(first.writes).toHaveLength(2)
      expect(second.writes).toHaveLength(2)
    })
    await waitMs(30)
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

  it('C7: conteúdo multiline vai verbatim com um único submit (nada por linha) sem a capability', async () => {
    const harness = createInstructionHarness()
    const content = 'linha 1\nlinha 2\nlinha 3'
    const pending = sendAgentInstruction(harness.deps, {
      terminalId: 't1',
      turnId: 'task-c7',
      content,
      provider: 'codex',
      ackTimeoutMs: 5_000,
      echoSettleMs: 10,
    })
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2))
    await waitMs(30)
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

  it('ACK PÓS-SUBMIT: eco do conteúdo NÃO confirma mais — retry só do Enter, ack só com saída após o settle', async () => {
    const harness = createInstructionHarness()
    harness.deps.write = vi.fn((id: string, data: string) => {
      harness.writes.push({ id, data })
      // O CLI ecoa o conteúdo no mesmo ciclo da escrita (corrida com o PTY).
      if (data !== AGENT_SUBMIT_SEQUENCE) {
        harness.emit({ id, type: 'data', data: `${data}\r\n> ` })
      }
      return true
    })
    const pending = sendAgentInstruction(harness.deps, {
      terminalId: 't1',
      turnId: 'task-echo-nao-ack',
      content: 'tarefa com eco',
      provider: 'codex',
      ackTimeoutMs: 80,
      echoSettleMs: 30,
    })
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2))
    // Tentativa 1: o eco chegou antes do observador (settle) e nada mais sai →
    // timeout → retry de APENAS o Enter.
    await vi.waitFor(() => expect(harness.writes).toHaveLength(3))
    expect(harness.writes[2]).toEqual({ id: 't1', data: AGENT_SUBMIT_SEQUENCE })
    // Tentativa 2: saída real DEPOIS do settle → ack.
    await waitMs(60)
    harness.emit({ id: 't1', type: 'data', data: 'agente processando…' })
    await expect(pending).resolves.toMatchObject({ acked: true, attempts: 2 })
    // Conteúdo NUNCA reenviado: o retry é só o Enter.
    expect(harness.writes).toEqual([
      { id: 't1', data: 'tarefa com eco' },
      { id: 't1', data: AGENT_SUBMIT_SEQUENCE },
      { id: 't1', data: AGENT_SUBMIT_SEQUENCE },
    ])
  })

  it('ECHO SETTLE (comportamento): redraw no settle não acka; saída pós-settle acka na mesma tentativa', async () => {
    const harness = createInstructionHarness()
    const pending = sendAgentInstruction(harness.deps, {
      terminalId: 't1',
      turnId: 'task-settle2',
      content: 'tarefa',
      provider: 'codex',
      ackTimeoutMs: 5_000,
      echoSettleMs: 50,
    })
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2))
    await waitMs(10)
    harness.emit({ id: 't1', type: 'data', data: '> redraw do Enter' })
    await waitMs(70)
    // Observador já armado (settle passou): a PRIMEIRA saída pós-settle acka.
    harness.emit({ id: 't1', type: 'data', data: 'agente começou a trabalhar' })
    const result = await pending
    expect(result).toMatchObject({ acked: true, attempts: 1 })
    // O redraw dentro do settle não disparou retry: apenas UM Enter.
    expect(harness.writes).toHaveLength(2)
  })

  it('BRACKETED PASTE: multiline + capability ativa → bloco ESC[200~…ESC[201~ numa escrita + Enter único', async () => {
    const harness = createInstructionHarness()
    harness.deps.isBracketedPasteEnabled = () => true
    const content = 'passo 1\npasso 2\nDEVORBIT_RESULT: …'
    const pending = sendAgentInstruction(harness.deps, {
      terminalId: 't1',
      turnId: 'task-paste-on',
      content,
      provider: 'codex',
      ackTimeoutMs: 5_000,
      echoSettleMs: 10,
    })
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2))
    await waitMs(30)
    harness.emit({ id: 't1', type: 'data', data: 'tui recebeu o paste' })
    await expect(pending).resolves.toMatchObject({ acked: true, attempts: 1 })
    expect(harness.writes).toEqual([
      { id: 't1', data: `${BRACKETED_PASTE_START}${content}${BRACKETED_PASTE_END}` },
      { id: 't1', data: AGENT_SUBMIT_SEQUENCE },
    ])
  })

  it('BRACKETED PASTE: conteúdo de 1 linha NÃO é embrulhado mesmo com capability ativa', async () => {
    const harness = createInstructionHarness()
    harness.deps.isBracketedPasteEnabled = () => true
    const pending = sendAgentInstruction(harness.deps, {
      terminalId: 't1',
      turnId: 'task-paste-oneline',
      content: 'tarefa de uma linha',
      provider: 'codex',
      ackTimeoutMs: 5_000,
      echoSettleMs: 10,
    })
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2))
    await waitMs(30)
    harness.emit({ id: 't1', type: 'data', data: 'ack' })
    await expect(pending).resolves.toMatchObject({ acked: true, attempts: 1 })
    expect(harness.writes).toEqual([
      { id: 't1', data: 'tarefa de uma linha' },
      { id: 't1', data: AGENT_SUBMIT_SEQUENCE },
    ])
  })

  it('BRACKETED PASTE: sem o dep injetado, multiline continua verbatim (ausente = false)', async () => {
    const harness = createInstructionHarness()
    const content = 'a\nb'
    const pending = sendAgentInstruction(harness.deps, {
      terminalId: 't1',
      turnId: 'task-paste-off',
      content,
      provider: 'codex',
      ackTimeoutMs: 5_000,
      echoSettleMs: 10,
    })
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2))
    await waitMs(30)
    harness.emit({ id: 't1', type: 'data', data: 'ack' })
    await expect(pending).resolves.toMatchObject({ acked: true, attempts: 1 })
    expect(harness.writes[0]).toEqual({ id: 't1', data: content })
  })

  it('LOGS: content_written traz paste= e length= e NENHUM log carrega o conteúdo', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      const harness = createInstructionHarness()
      harness.deps.isBracketedPasteEnabled = () => true
      const content = 'primeira linha\nsegunda linha'
      const pending = sendAgentInstruction(harness.deps, {
        terminalId: 't1',
        turnId: 'task-logs',
        content,
        provider: 'codex',
        ackTimeoutMs: 5_000,
        echoSettleMs: 10,
      })
      await vi.waitFor(() => expect(harness.writes).toHaveLength(2))
      await waitMs(30)
      harness.emit({ id: 't1', type: 'data', data: 'ack' })
      await expect(pending).resolves.toMatchObject({ acked: true })

      // console.info usa placeholders: os valores chegam como args separados.
      const contentWrittenCall = infoSpy.mock.calls.find((call) => call.includes('content_written'))
      expect(contentWrittenCall).toBeTruthy()
      expect(contentWrittenCall?.some((part) => String(part) === ' paste=bracketed')).toBe(true)
      expect(contentWrittenCall?.some((part) => String(part) === ` length=${content.length}`)).toBe(true)
      for (const call of infoSpy.mock.calls) {
        for (const part of call) {
          expect(String(part)).not.toContain(content)
          expect(String(part)).not.toContain('primeira linha')
        }
      }
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('ECO SÍNCRONO NO ENTER: saída no mesmo ciclo da escrita do Enter não confirma mais (nova corrida)', async () => {
    const harness = createInstructionHarness()
    harness.deps.write = vi.fn((id: string, data: string) => {
      harness.writes.push({ id, data })
      // O CLI ecoa no MESMO ciclo da escrita do Enter (antes do settle começar).
      if (data === AGENT_SUBMIT_SEQUENCE) harness.emit({ id, type: 'data', data: 'echo imediato' })
      return true
    })
    const pending = sendAgentInstruction(harness.deps, {
      terminalId: 't1',
      turnId: 'task-sync',
      content: 'tarefa',
      provider: 'codex',
      ackTimeoutMs: 80,
      echoSettleMs: 30,
    })
    // Tentativa 1 não acka (eco imediato cai fora da janela); retry do Enter.
    await vi.waitFor(() => expect(harness.writes).toHaveLength(3))
    await waitMs(60)
    harness.emit({ id: 't1', type: 'data', data: 'saída real do CLI' })
    await expect(pending).resolves.toMatchObject({ acked: true, attempts: 2 })
    expect(harness.writes).toEqual([
      { id: 't1', data: 'tarefa' },
      { id: 't1', data: AGENT_SUBMIT_SEQUENCE },
      { id: 't1', data: AGENT_SUBMIT_SEQUENCE },
    ])
  })
})

afterEach(() => {
  vi.useRealTimers()
})
