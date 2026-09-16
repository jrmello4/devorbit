import { describe, expect, it } from 'vitest'
import {
  beginCompanionTerminalStart,
  createCompanionSentinel,
  handleCompanionTerminalEvent,
  onCompanionEvent,
  registerCompanionTerminal,
  resetCompanionForTests,
  summarizeTerminalEnd,
  unregisterCompanionTerminal,
  type CompanionSummary,
} from '../src/main/companion'

describe('summarizeTerminalEnd', () => {
  it('celebrates a clean exit with the delivered result', () => {
    const summary = summarizeTerminalEnd({
      terminalId: 'agent-1',
      projectPath: 'C:\\work\\demo',
      code: 0,
      outputTail: 'tudo pronto\nDEVORBIT_RESULT: CONCLUIDO: testes verdes',
    })
    expect(summary).toMatchObject({ terminalId: 'agent-1', projectPath: 'C:\\work\\demo', outcome: 'completed', code: 0 })
    expect(summary.message).toContain('testes verdes')
    expect(summary.message).toContain('demo')
    expect(summary.message).not.toContain('agent-1')
    expect(summary.suggestion).toBeTruthy()
    expect(summary.actions.map((action) => action.id)).toEqual(['view-workspace', 'dismiss'])
  })

  it('flags a blocked marker as needing help', () => {
    const summary = summarizeTerminalEnd({
      terminalId: 'agent-2',
      code: 0,
      outputTail: 'travei aqui\nDEVORBIT_RESULT: BLOQUEADO: falta a chave da API',
    })
    expect(summary.outcome).toBe('blocked')
    expect(summary.message).toContain('falta a chave da API')
    expect(summary.projectPath).toBeUndefined()
  })

  it('reports non-zero exits as failures', () => {
    const summary = summarizeTerminalEnd({ terminalId: 'shell-1', code: 1, outputTail: 'boom' })
    expect(summary).toMatchObject({ outcome: 'failed', code: 1 })
  })

  it('reports terminal errors without inventing an exit code', () => {
    const summary = summarizeTerminalEnd({ terminalId: 'shell-2', errored: true, errorMessage: 'spawn ENOENT' })
    expect(summary).toMatchObject({ outcome: 'failed' })
    expect(summary.code).toBeUndefined()
    expect(summary.message).toContain('spawn ENOENT')
  })
})

describe('companion sentinel', () => {
  it('buffers output and summarizes on exit', () => {
    const summaries: CompanionSummary[] = []
    const sentinel = createCompanionSentinel((summary) => summaries.push(summary))
    sentinel.handleTerminalEvent({ id: 'a1', type: 'data', data: 'trabalhando...\n' })
    sentinel.handleTerminalEvent({ id: 'a1', type: 'data', data: 'DEVORBIT_RESULT: CONCLUIDO: feito' })
    expect(sentinel.pendingCount()).toBe(1)
    sentinel.handleTerminalEvent({ id: 'a1', type: 'exit', code: 0 })
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ terminalId: 'a1', outcome: 'completed' })
    expect(summaries[0].message).toContain('feito')
    expect(sentinel.pendingCount()).toBe(0)
  })

  it('ignores resize noise and tracks sessions independently', () => {
    const summaries: CompanionSummary[] = []
    const sentinel = createCompanionSentinel((summary) => summaries.push(summary))
    sentinel.handleTerminalEvent({ id: 'a1', type: 'resize', cols: 80, rows: 24 })
    sentinel.handleTerminalEvent({ id: 'a1', type: 'data', data: 'x' })
    sentinel.handleTerminalEvent({ id: 'b2', type: 'exit', code: 2 })
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ terminalId: 'b2', outcome: 'failed', code: 2 })
    sentinel.reset()
    expect(sentinel.pendingCount()).toBe(0)
  })

  it('carries the owning project into the summary and forgets it after', () => {
    const summaries: CompanionSummary[] = []
    const sentinel = createCompanionSentinel((summary) => summaries.push(summary))
    sentinel.registerTerminal('a1', { projectPath: 'C:\\work\\demo' })
    sentinel.handleTerminalEvent({ id: 'a1', type: 'data', data: 'done' })
    sentinel.handleTerminalEvent({ id: 'a1', type: 'exit', code: 0 })
    expect(summaries).toHaveLength(1)
    expect(summaries[0].projectPath).toBe('C:\\work\\demo')
    // Segunda saída sem novo registro: contexto já foi consumido.
    sentinel.handleTerminalEvent({ id: 'a1', type: 'exit', code: 0 })
    expect(summaries).toHaveLength(2)
    expect(summaries[1].projectPath).toBeUndefined()
  })

  it('emits exactly one summary for error followed by exit', () => {
    const summaries: CompanionSummary[] = []
    const sentinel = createCompanionSentinel((summary) => summaries.push(summary))
    sentinel.registerTerminal('a1', { projectPath: 'C:\\work\\demo' })
    sentinel.handleTerminalEvent({ id: 'a1', type: 'error', data: 'spawn ENOENT' })
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ outcome: 'failed', projectPath: 'C:\\work\\demo' })
    sentinel.handleTerminalEvent({ id: 'a1', type: 'exit', code: 1 })
    expect(summaries).toHaveLength(1)
  })

  it('drops context on the suppressed exit: later exits retain nothing', () => {
    const summaries: CompanionSummary[] = []
    const sentinel = createCompanionSentinel((summary) => summaries.push(summary))
    sentinel.registerTerminal('a1', { projectPath: 'C:\\work\\demo' })
    sentinel.handleTerminalEvent({ id: 'a1', type: 'error', data: 'spawn ENOENT' })
    sentinel.handleTerminalEvent({ id: 'a1', type: 'exit', code: 1 })
    // Terceiro exit sem re-registration: exatamente um resumo no total e
    // nenhum projectPath retido em qualquer saída posterior.
    sentinel.handleTerminalEvent({ id: 'a1', type: 'exit', code: 0 })
    expect(summaries).toHaveLength(2)
    expect(summaries[1].projectPath).toBeUndefined()
    expect(summaries[1]).toMatchObject({ terminalId: 'a1', outcome: 'completed' })
  })

  it('starts fresh on re-registration without mixing sessions', () => {
    const summaries: CompanionSummary[] = []
    const sentinel = createCompanionSentinel((summary) => summaries.push(summary))
    sentinel.handleTerminalEvent({ id: 'a1', type: 'data', data: 'stale output' })
    sentinel.registerTerminal('a1', { projectPath: 'C:\\work\\novo' })
    sentinel.handleTerminalEvent({ id: 'a1', type: 'exit', code: 0 })
    expect(summaries).toHaveLength(1)
    expect(summaries[0].message).not.toContain('stale output')
    expect(summaries[0].projectPath).toBe('C:\\work\\novo')
  })

  it('unregisters terminals without emitting', () => {
    const summaries: CompanionSummary[] = []
    const sentinel = createCompanionSentinel((summary) => summaries.push(summary))
    sentinel.registerTerminal('a1', { projectPath: 'C:\\work\\demo' })
    sentinel.unregisterTerminal('a1')
    sentinel.handleTerminalEvent({ id: 'a1', type: 'exit', code: 0 })
    expect(summaries[0].projectPath).toBeUndefined()
  })
})

describe('companion module lifecycle', () => {
  it('suppresses stale exits and drops context after the first summary', () => {
    resetCompanionForTests()
    const summaries: CompanionSummary[] = []
    const unsubscribe = onCompanionEvent((summary) => summaries.push(summary))
    try {
      registerCompanionTerminal('t1', { projectPath: 'C:\\work\\demo' })
      handleCompanionTerminalEvent({ id: 't1', type: 'data', data: 'done' })
      handleCompanionTerminalEvent({ id: 't1', type: 'exit', code: 0 })
      expect(summaries).toHaveLength(1)
      expect(summaries[0].projectPath).toBe('C:\\work\\demo')
      // Segundo e terceiro exits sem re-registro: tardios, sem resumo algum
      // (logo, sem projectPath vazado).
      handleCompanionTerminalEvent({ id: 't1', type: 'exit', code: 0 })
      handleCompanionTerminalEvent({ id: 't1', type: 'exit', code: 0 })
      expect(summaries).toHaveLength(1)
    } finally {
      unsubscribe()
      resetCompanionForTests()
    }
  })

  it('clears state on stop so late events never emit', () => {
    resetCompanionForTests()
    const summaries: CompanionSummary[] = []
    const unsubscribe = onCompanionEvent((summary) => summaries.push(summary))
    try {
      registerCompanionTerminal('t2', { projectPath: 'C:\\work\\demo' })
      handleCompanionTerminalEvent({ id: 't2', type: 'data', data: 'half done' })
      unregisterCompanionTerminal('t2')
      handleCompanionTerminalEvent({ id: 't2', type: 'exit', code: 0 })
      expect(summaries).toHaveLength(0)
    } finally {
      unsubscribe()
      resetCompanionForTests()
    }
  })

  it('ignores data for unknown terminals', () => {
    resetCompanionForTests()
    const summaries: CompanionSummary[] = []
    const unsubscribe = onCompanionEvent((summary) => summaries.push(summary))
    try {
      handleCompanionTerminalEvent({ id: 'ghost', type: 'data', data: 'x'.repeat(100) })
      registerCompanionTerminal('ghost', { projectPath: 'C:\\work\\demo' })
      handleCompanionTerminalEvent({ id: 'ghost', type: 'exit', code: 0 })
      expect(summaries).toHaveLength(1)
      expect(summaries[0].message).not.toContain('xxx')
    } finally {
      unsubscribe()
      resetCompanionForTests()
    }
  })

  it('suppresses a late error after stop (tombstone)', () => {
    resetCompanionForTests()
    const summaries: CompanionSummary[] = []
    const unsubscribe = onCompanionEvent((summary) => summaries.push(summary))
    try {
      registerCompanionTerminal('t3', { projectPath: 'C:\\work\\demo' })
      handleCompanionTerminalEvent({ id: 't3', type: 'data', data: 'working' })
      unregisterCompanionTerminal('t3')
      handleCompanionTerminalEvent({ id: 't3', type: 'error', data: 'EPIPE write failed' })
      expect(summaries).toHaveLength(0)
    } finally {
      unsubscribe()
      resetCompanionForTests()
    }
  })

  it('announces a spawn error for a never-registered id', () => {
    resetCompanionForTests()
    const summaries: CompanionSummary[] = []
    const unsubscribe = onCompanionEvent((summary) => summaries.push(summary))
    try {
      handleCompanionTerminalEvent({ id: 'fresh', type: 'error', data: 'spawn ENOENT' })
      expect(summaries).toHaveLength(1)
      expect(summaries[0]).toMatchObject({ terminalId: 'fresh', outcome: 'failed' })
      expect(summaries[0].projectPath).toBeUndefined()
    } finally {
      unsubscribe()
      resetCompanionForTests()
    }
  })

  it('re-registration clears the tombstone and announces again', () => {
    resetCompanionForTests()
    const summaries: CompanionSummary[] = []
    const unsubscribe = onCompanionEvent((summary) => summaries.push(summary))
    try {
      registerCompanionTerminal('t4', { projectPath: 'C:\\work\\demo' })
      unregisterCompanionTerminal('t4')
      handleCompanionTerminalEvent({ id: 't4', type: 'error', data: 'late error' })
      expect(summaries).toHaveLength(0)
      registerCompanionTerminal('t4', { projectPath: 'C:\\work\\demo' })
      handleCompanionTerminalEvent({ id: 't4', type: 'error', data: 'spawn ENOENT' })
      expect(summaries).toHaveLength(1)
      expect(summaries[0]).toMatchObject({ terminalId: 't4', outcome: 'failed' })
      expect(summaries[0].projectPath).toBe('C:\\work\\demo')
    } finally {
      unsubscribe()
      resetCompanionForTests()
    }
  })

  it('a new start attempt clears the tombstone so spawn failures surface', () => {
    resetCompanionForTests()
    const summaries: CompanionSummary[] = []
    const unsubscribe = onCompanionEvent((summary) => summaries.push(summary))
    try {
      registerCompanionTerminal('t5', { projectPath: 'C:\\work\\demo' })
      unregisterCompanionTerminal('t5')
      beginCompanionTerminalStart('t5')
      handleCompanionTerminalEvent({ id: 't5', type: 'error', data: 'spawn ENOENT' })
      expect(summaries).toHaveLength(1)
      expect(summaries[0].outcome).toBe('failed')
    } finally {
      unsubscribe()
      resetCompanionForTests()
    }
  })

  it('stop of a never-registered id does not silence a later spawn error', () => {
    resetCompanionForTests()
    const summaries: CompanionSummary[] = []
    const unsubscribe = onCompanionEvent((summary) => summaries.push(summary))
    try {
      unregisterCompanionTerminal('never-lived')
      handleCompanionTerminalEvent({ id: 'never-lived', type: 'error', data: 'spawn ENOENT' })
      expect(summaries).toHaveLength(1)
    } finally {
      unsubscribe()
      resetCompanionForTests()
    }
  })
})
