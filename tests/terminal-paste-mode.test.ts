import { describe, expect, it } from 'vitest'
import { createTerminalPasteMode } from '../src/main/terminal-paste-mode'
import type { TerminalEvent } from '../src/main/terminal-session'

const ENABLE = '\x1b[?2004h'
const DISABLE = '\x1b[?2004l'

interface PasteHarness {
  isBracketedPasteEnabled: (id: string) => boolean
  reset: (id: string) => void
  emit: (event: TerminalEvent) => void
  emitData: (id: string, data: string) => void
}

function createPasteHarness(): PasteHarness {
  const listeners = new Set<(event: TerminalEvent) => void>()
  const pasteMode = createTerminalPasteMode((listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  })
  return {
    isBracketedPasteEnabled: pasteMode.isBracketedPasteEnabled,
    reset: pasteMode.reset,
    emit: (event) => listeners.forEach((listener) => listener(event)),
    emitData: (id, data) => listeners.forEach((listener) => listener({ id, type: 'data', data })),
  }
}

describe('createTerminalPasteMode (capability ESC[?2004 no barramento PTY)', () => {
  it('2004h habilita e 2004l desabilita por terminal id', () => {
    const harness = createPasteHarness()
    expect(harness.isBracketedPasteEnabled('t1')).toBe(false)

    harness.emitData('t1', 'boot da TUI… ' + ENABLE)
    expect(harness.isBracketedPasteEnabled('t1')).toBe(true)

    harness.emitData('t1', 'streaming normal sem sequências')
    expect(harness.isBracketedPasteEnabled('t1')).toBe(true)

    harness.emitData('t1', DISABLE + ' prompt bruto de novo')
    expect(harness.isBracketedPasteEnabled('t1')).toBe(false)
  })

  it('chunks arbitrários sem sequência não mudam o estado (varre e descarta)', () => {
    const harness = createPasteHarness()
    harness.emitData('t1', ENABLE)
    for (let index = 0; index < 50; index += 1) {
      harness.emitData('t1', `chunk qualquer ${index} com \x1b[31mcores\x1b[0m e \r\r\nredraws`)
    }
    expect(harness.isBracketedPasteEnabled('t1')).toBe(true)
  })

  it('quando enable e disable aparecem no mesmo chunk, a ÚLTIMA sequência vence', () => {
    const harness = createPasteHarness()
    harness.emitData('t1', `${ENABLE} texto ${DISABLE}`)
    expect(harness.isBracketedPasteEnabled('t1')).toBe(false)

    harness.emitData('t1', `${DISABLE} texto ${ENABLE}`)
    expect(harness.isBracketedPasteEnabled('t1')).toBe(true)
  })

  it('sequência partida entre dois chunks é reconhecida (borda de fatia do PTY)', () => {
    const harness = createPasteHarness()
    const splitAt = 5
    harness.emitData('t1', ENABLE.slice(0, splitAt))
    expect(harness.isBracketedPasteEnabled('t1')).toBe(false)
    harness.emitData('t1', ENABLE.slice(splitAt) + ' resto do frame')
    expect(harness.isBracketedPasteEnabled('t1')).toBe(true)

    // Mesma partição para o disable.
    harness.emitData('t1', DISABLE.slice(0, 8))
    harness.emitData('t1', DISABLE.slice(8))
    expect(harness.isBracketedPasteEnabled('t1')).toBe(false)
  })

  it('sequência completa num chunk não é recontada pela cauda carregada (idempotente)', () => {
    const harness = createPasteHarness()
    harness.emitData('t1', `frame ${DISABLE}`)
    harness.emitData('t1', 'próximo chunk qualquer')
    expect(harness.isBracketedPasteEnabled('t1')).toBe(false)

    harness.emitData('t1', ENABLE)
    harness.emitData('t1', 'outro chunk')
    expect(harness.isBracketedPasteEnabled('t1')).toBe(true)
  })

  it('estados são isolados por terminal id', () => {
    const harness = createPasteHarness()
    harness.emitData('t1', ENABLE)
    harness.emitData('t2', DISABLE)
    expect(harness.isBracketedPasteEnabled('t1')).toBe(true)
    expect(harness.isBracketedPasteEnabled('t2')).toBe(false)
    harness.emitData('t2', ENABLE)
    expect(harness.isBracketedPasteEnabled('t1')).toBe(true)
    expect(harness.isBracketedPasteEnabled('t2')).toBe(true)
  })

  it('exit e error limpam o estado (nova TUI precisa reanunciar 2004h)', () => {
    const harness = createPasteHarness()
    harness.emitData('t1', ENABLE)
    expect(harness.isBracketedPasteEnabled('t1')).toBe(true)

    harness.emit({ id: 't1', type: 'exit', code: 0 })
    expect(harness.isBracketedPasteEnabled('t1')).toBe(false)

    harness.emitData('t1', ENABLE)
    harness.emit({ id: 't1', type: 'error', data: 'pty explodiu' })
    expect(harness.isBracketedPasteEnabled('t1')).toBe(false)
  })

  it('reset limpa o estado mesmo sem exit (stop manual do terminal)', () => {
    const harness = createPasteHarness()
    harness.emitData('t1', ENABLE)
    harness.emitData('t2', ENABLE)
    harness.reset('t1')
    expect(harness.isBracketedPasteEnabled('t1')).toBe(false)
    expect(harness.isBracketedPasteEnabled('t2')).toBe(true)
  })

  it('ignora eventos sem data (resize) e chunks vazios sem quebrar', () => {
    const harness = createPasteHarness()
    harness.emit({ id: 't1', type: 'resize', cols: 120, rows: 32 })
    harness.emitData('t1', '')
    expect(harness.isBracketedPasteEnabled('t1')).toBe(false)

    harness.emitData('t1', ENABLE)
    harness.emit({ id: 't1', type: 'resize', cols: 100, rows: 30 })
    expect(harness.isBracketedPasteEnabled('t1')).toBe(true)
  })
})

describe('filtro de escopo (shouldTrack)', () => {
  it('ignora sequências 2004h/l de terminais NÃO rastreados (shell comum)', () => {
    const listeners: Array<(event: TerminalEvent) => void> = []
    const pasteMode = createTerminalPasteMode((listener) => {
      listeners.push(listener)
      return () => undefined
    }, (id) => id.startsWith('agent-'))
    for (const listener of listeners) listener({ id: 'shell-1', type: 'data', data: '\x1b[?2004h' })
    expect(pasteMode.isBracketedPasteEnabled('shell-1')).toBe(false)
    for (const listener of listeners) listener({ id: 'agent-1', type: 'data', data: '\x1b[?2004h' })
    expect(pasteMode.isBracketedPasteEnabled('agent-1')).toBe(true)
    // disable ecoado no shell não desabilita o agente (e vice-versa)
    for (const listener of listeners) listener({ id: 'shell-1', type: 'data', data: '\x1b[?2004l' })
    expect(pasteMode.isBracketedPasteEnabled('agent-1')).toBe(true)
    for (const listener of listeners) listener({ id: 'agent-1', type: 'data', data: '\x1b[?2004l' })
    expect(pasteMode.isBracketedPasteEnabled('agent-1')).toBe(false)
  })
})
