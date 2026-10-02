import { describe, expect, it } from 'vitest'
import {
  AGENT_RESULT_PROTOCOL_INSTRUCTION,
  parseAgentResultLine,
  withAgentResultProtocol,
} from '../src/shared/agent-result'
import { createResultWaiter } from '../src/main/agent-turn'
import type { TerminalEvent } from '../src/main/terminal-session'

describe('protocolo de resultado do Bridge (send/ask)', () => {
  it('instrução é prosa: nenhuma linha começa com o prefixo e não há exemplo JSON', () => {
    for (const line of AGENT_RESULT_PROTOCOL_INSTRUCTION.split('\n')) {
      expect(parseAgentResultLine(line)).toEqual({ kind: 'none' })
    }
    expect(AGENT_RESULT_PROTOCOL_INSTRUCTION).not.toContain('{"version"')
    expect(AGENT_RESULT_PROTOCOL_INSTRUCTION).toContain('DEVORBIT_RESULT:')
    expect(AGENT_RESULT_PROTOCOL_INSTRUCTION).toContain('version')
    expect(AGENT_RESULT_PROTOCOL_INSTRUCTION).toContain('outcome')
    expect(AGENT_RESULT_PROTOCOL_INSTRUCTION).toContain('summary')
  })

  it('wrapper é idempotente, preserva a tarefa e nunca usa contains como bypass', () => {
    const prompt = 'refatorar o módulo de cobrança'
    const composed = withAgentResultProtocol(prompt)
    expect(composed.startsWith(AGENT_RESULT_PROTOCOL_INSTRUCTION)).toBe(true)
    expect(composed.endsWith(prompt)).toBe(true)
    expect(withAgentResultProtocol(composed)).toBe(composed)
    // A palavra DEVORBIT_RESULT na tarefa não é bypass: a instrução entra.
    const mentioning = 'verifique DEVORBIT_RESULT: no arquivo de log'
    const wrapped = withAgentResultProtocol(mentioning)
    expect(wrapped.startsWith(AGENT_RESULT_PROTOCOL_INSTRUCTION)).toBe(true)
    expect(wrapped.endsWith(mentioning)).toBe(true)
  })

  it('createResultWaiter resolve pelo evento de resposta, nunca pelo eco do prompt', async () => {
    const listeners = new Set<(event: TerminalEvent) => void>()
    const wait = createResultWaiter((listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    })
    const pending = wait('agent-1', { idleMs: 60_000, overallMs: 60_000 })
    let settled = false
    void pending.then(() => {
      settled = true
    })
    const composed = withAgentResultProtocol('fazer a coisa')
    // Eco do prompt composto (multiline; o prefixo aparece só no meio de frases).
    for (const listener of [...listeners]) {
      listener({ id: 'agent-1', type: 'data', data: `${composed}\r\n> ` })
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    // Evento de resposta real (após nova linha, como numa TUI — o fragmento
    // '> ' do eco fica no buffer e não pode colar no marcador) resolve com o
    // resultado estruturado.
    for (const listener of [...listeners]) {
      listener({ id: 'agent-1', type: 'data', data: '\r\nDEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"feito"}\n' })
    }
    const result = await pending
    expect(result.result).toBe('feito')
    expect(result.structured?.outcome).toBe('completed')
  })
})
