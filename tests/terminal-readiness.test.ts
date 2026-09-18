import { describe, expect, it, vi } from 'vitest'
import { createTerminalReadiness } from '../src/main/terminal-readiness'
import type { TerminalEvent } from '../src/main/terminal-session'

function createBus() {
  const listeners = new Set<(event: TerminalEvent) => void>()
  const readiness = createTerminalReadiness(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    { quietMs: 1000, timeoutMs: 5000 },
  )
  return {
    readiness,
    listeners,
    emit: (event: TerminalEvent) => listeners.forEach((listener) => listener(event)),
  }
}

describe('terminal readiness cache', () => {
  it('marca pronto após a quietude e não paga a janela de novo', async () => {
    vi.useFakeTimers()
    try {
      const bus = createBus()
      let settled = false
      const pending = bus.readiness.waitReady('t1').then(() => { settled = true })
      bus.emit({ id: 't1', type: 'data', data: 'desenhando' })
      await vi.advanceTimersByTimeAsync(900)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
      await pending
      expect(settled).toBe(true)
      expect(bus.readiness.isReady('t1')).toBe(true)

      // Segunda espera resolve na hora, sem timers.
      await bus.readiness.waitReady('t1')
      expect(bus.listeners.size).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolve imediatamente quando a última saída já passou da quietude', async () => {
    vi.useFakeTimers()
    try {
      const bus = createBus()
      bus.emit({ id: 't2', type: 'data', data: 'saída antiga' })
      await vi.advanceTimersByTimeAsync(1500)
      let settled = false
      await bus.readiness.waitReady('t2').then(() => { settled = true })
      expect(settled).toBe(true)
      expect(bus.readiness.isReady('t2')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('invalida a prontidão quando o PTY reinicia e volta a exigir quietude', async () => {
    vi.useFakeTimers()
    try {
      const bus = createBus()
      bus.emit({ id: 't3', type: 'data', data: 'primeira sessão' })
      await vi.advanceTimersByTimeAsync(1200)
      await bus.readiness.waitReady('t3')
      expect(bus.readiness.isReady('t3')).toBe(true)

      bus.readiness.invalidate('t3')
      expect(bus.readiness.isReady('t3')).toBe(false)

      let settled = false
      const pending = bus.readiness.waitReady('t3').then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(4000)
      expect(settled).toBe(false)
      bus.emit({ id: 't3', type: 'data', data: 'nova sessão' })
      await vi.advanceTimersByTimeAsync(1100)
      await pending
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('exit/erro também invalidam a prontidão', async () => {
    const bus = createBus()
    const pending = bus.readiness.waitReady('t4', { quietMs: 100, timeoutMs: 5000 })
    bus.emit({ id: 't4', type: 'data', data: 'vivo' })
    await pending
    expect(bus.readiness.isReady('t4')).toBe(true)
    bus.emit({ id: 't4', type: 'exit', code: 0 })
    expect(bus.readiness.isReady('t4')).toBe(false)
  })
})
