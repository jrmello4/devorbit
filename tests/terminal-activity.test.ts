import { describe, expect, it } from 'vitest'
import {
  TERMINAL_ACTIVITY_LABELS,
  createTerminalActivityMonitor,
} from '../src/renderer/src/components/terminal-activity'

describe('monitor de atividade do terminal', () => {
  it('começa em starting sem dados', () => {
    const monitor = createTerminalActivityMonitor()
    expect(monitor.snapshot(1000)).toBe('starting')
  })

  it('dados recentes = running', () => {
    const monitor = createTerminalActivityMonitor({ activeWindowMs: 2000, quietMs: 20000 })
    monitor.push({ type: 'data', at: 1000 })
    expect(monitor.snapshot(2500)).toBe('running')
  })

  it('silêncio dentro de quietMs = waiting; além disso = idle', () => {
    const monitor = createTerminalActivityMonitor({ activeWindowMs: 2000, quietMs: 20000 })
    monitor.push({ type: 'data', at: 1000 })
    expect(monitor.snapshot(2500)).toBe('running')
    expect(monitor.snapshot(3000)).toBe('running')
    expect(monitor.snapshot(3001)).toBe('waiting')
    expect(monitor.snapshot(21_000)).toBe('waiting')
    expect(monitor.snapshot(21_001)).toBe('idle')
  })

  it('novo dado devolve de waiting/idle para running', () => {
    const monitor = createTerminalActivityMonitor({ activeWindowMs: 2000, quietMs: 20000 })
    monitor.push({ type: 'data', at: 1000 })
    expect(monitor.snapshot(30_000)).toBe('idle')
    monitor.push({ type: 'data', at: 30_500 })
    expect(monitor.snapshot(31_000)).toBe('running')
  })

  it('erro = attention persistente até o próximo dado', () => {
    const monitor = createTerminalActivityMonitor({ activeWindowMs: 2000, quietMs: 20000 })
    monitor.push({ type: 'data', at: 1000 })
    monitor.push({ type: 'error', at: 1500 })
    expect(monitor.snapshot(60_000)).toBe('attention')
    monitor.push({ type: 'data', at: 61_000 })
    expect(monitor.snapshot(61_500)).toBe('running')
  })

  it('erro sem dado anterior também vira attention', () => {
    const monitor = createTerminalActivityMonitor()
    monitor.push({ type: 'error', at: 100 })
    expect(monitor.snapshot(200)).toBe('attention')
  })

  it('exit 0 = exited e não é desfeito por dados posteriores', () => {
    const monitor = createTerminalActivityMonitor()
    monitor.push({ type: 'data', at: 100 })
    monitor.push({ type: 'exit', code: 0, at: 200 })
    expect(monitor.snapshot(300)).toBe('exited')
    monitor.push({ type: 'data', at: 400 })
    expect(monitor.snapshot(500)).toBe('exited')
  })

  it('exit diferente de zero = failed (código null/ausente conta como falha)', () => {
    const monitor = createTerminalActivityMonitor()
    monitor.push({ type: 'data', at: 100 })
    monitor.push({ type: 'exit', code: 1, at: 200 })
    expect(monitor.snapshot(300)).toBe('failed')

    const semCodigo = createTerminalActivityMonitor()
    semCodigo.push({ type: 'data', at: 100 })
    semCodigo.push({ type: 'exit', at: 200 })
    expect(semCodigo.snapshot(300)).toBe('failed')
  })

  it('exit vence attention pendente', () => {
    const monitor = createTerminalActivityMonitor()
    monitor.push({ type: 'error', at: 100 })
    monitor.push({ type: 'exit', code: 0, at: 200 })
    expect(monitor.snapshot(300)).toBe('exited')
  })

  it('reset devolve ao estado inicial', () => {
    const monitor = createTerminalActivityMonitor()
    monitor.push({ type: 'data', at: 100 })
    monitor.push({ type: 'exit', code: 3, at: 200 })
    monitor.reset()
    expect(monitor.snapshot(10_000)).toBe('starting')
  })

  it('usa Date.now() quando o evento não traz timestamp', () => {
    const monitor = createTerminalActivityMonitor({ activeWindowMs: 5000, quietMs: 60_000 })
    monitor.push({ type: 'data' })
    expect(['starting', 'running', 'waiting', 'idle']).toContain(monitor.snapshot())
  })

  it('rótulos pt-BR cobrem todos os estados', () => {
    expect(TERMINAL_ACTIVITY_LABELS.starting).toBe('Iniciando')
    expect(TERMINAL_ACTIVITY_LABELS.running).toBe('Executando')
    expect(TERMINAL_ACTIVITY_LABELS.waiting).toBe('Aguardando entrada')
    expect(TERMINAL_ACTIVITY_LABELS.attention).toBe('Atenção')
    expect(TERMINAL_ACTIVITY_LABELS.exited).toBe('Concluído')
    expect(TERMINAL_ACTIVITY_LABELS.failed).toBe('Falhou')
    expect(TERMINAL_ACTIVITY_LABELS.idle).toBe('Parado')
  })
})
