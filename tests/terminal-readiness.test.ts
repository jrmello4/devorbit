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

  it('timeout NÃO marca pronto: TUI que nunca cala esgota o teto sem cachear', async () => {
    vi.useFakeTimers()
    try {
      const bus = createBus()
      const pending = bus.readiness.waitReady('t5').then((result) => result)
      // Frames a cada 900ms (< quietude de 1000ms): a janela nunca fecha.
      for (let index = 0; index < 6; index += 1) {
        bus.emit({ id: 't5', type: 'data', data: `frame ${index}` })
        await vi.advanceTimersByTimeAsync(900)
      }
      await expect(pending).resolves.toEqual({ timedOut: true })
      // Timeout não cacheia: isReady segue falso.
      expect(bus.readiness.isReady('t5')).toBe(false)

      let settled = false
      const second = bus.readiness.waitReady('t5').then((result) => { settled = true; return result })
      await vi.advanceTimersByTimeAsync(2000)
      expect(settled).toBe(false)
      bus.emit({ id: 't5', type: 'data', data: 'a TUI finalmente calou' })
      await vi.advanceTimersByTimeAsync(1000)
      await expect(second).resolves.toEqual({ timedOut: false })
      expect(bus.readiness.isReady('t5')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sem saída registrada e sem since, exige a primeira saída (TUI lenta não é pronta por omissão)', async () => {
    vi.useFakeTimers()
    try {
      const bus = createBus()
      let settled = false
      const pending = bus.readiness.waitReady('t5-silent').then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(3000)
      expect(settled).toBe(false)
      bus.emit({ id: 't5-silent', type: 'data', data: 'primeira saída do boot' })
      await vi.advanceTimersByTimeAsync(1000)
      await pending
      expect(settled).toBe(true)
      expect(bus.readiness.isReady('t5-silent')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('qualquer saída remove o estado pronto (pronto é um estado que expira)', async () => {
    vi.useFakeTimers()
    try {
      const bus = createBus()
      bus.emit({ id: 't6', type: 'data', data: 'boot' })
      await vi.advanceTimersByTimeAsync(1500)
      await bus.readiness.waitReady('t6')
      expect(bus.readiness.isReady('t6')).toBe(true)

      bus.emit({ id: 't6', type: 'data', data: 'TUI entrou em streaming' })
      expect(bus.readiness.isReady('t6')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('since exige silêncio DEPOIS da âncora (spawn novo não aceita silêncio antigo)', async () => {
    vi.useFakeTimers()
    try {
      const bus = createBus()
      // Silêncio antigo: banner do cmd imprimiu há 2s.
      bus.emit({ id: 't7', type: 'data', data: 'banner do cmd.exe' })
      await vi.advanceTimersByTimeAsync(2000)

      const anchor = Date.now()
      let settled = false
      const pending = bus.readiness.waitReady('t7', { since: anchor }).then((result) => { settled = true; return result })
      await vi.advanceTimersByTimeAsync(900)
      expect(settled).toBe(false)
      // Silêncio absoluto desde a âncora completa a quietude (sem saída nova).
      await vi.advanceTimersByTimeAsync(200)
      await expect(pending).resolves.toEqual({ timedOut: false })
      expect(bus.readiness.isReady('t7')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sessão idle reutilizada em cache resolve na hora mesmo com since', async () => {
    vi.useFakeTimers()
    try {
      const bus = createBus()
      bus.emit({ id: 't8', type: 'data', data: 'boot da TUI' })
      await vi.advanceTimersByTimeAsync(1500)
      await bus.readiness.waitReady('t8')

      // Turno novo (since = agora) numa sessão idle: cache válido → sem latência.
      let settled = false
      await bus.readiness.waitReady('t8', { since: Date.now() }).then(() => { settled = true })
      expect(settled).toBe(true)
      expect(bus.listeners.size).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('paste exige quietude fresca mesmo quando o terminal já estava em cache', async () => {
    vi.useFakeTimers()
    try {
      const bus = createBus()
      bus.emit({ id: 'paste', type: 'data', data: 'boot' })
      await vi.advanceTimersByTimeAsync(1500)
      await bus.readiness.waitReady('paste')
      let settled = false
      const pending = bus.readiness.waitReady('paste', { since: Date.now(), requireFresh: true, quietMs: 250 })
        .then(result => { settled = true; return result })
      await vi.advanceTimersByTimeAsync(200)
      expect(settled).toBe(false)
      bus.emit({ id: 'paste', type: 'data', data: 'redraw do paste' })
      await vi.advanceTimersByTimeAsync(200)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(100)
      expect(await pending).toEqual({ timedOut: false })
    } finally { vi.useRealTimers() }
  })

  it('TUI ocupada (streaming após since) espera o silêncio real', async () => {
    vi.useFakeTimers()
    try {
      const bus = createBus()
      const anchor = Date.now()
      let settled = false
      const pending = bus.readiness.waitReady('t9', { since: anchor }).then((result) => { settled = true; return result })
      for (let index = 0; index < 4; index += 1) {
        bus.emit({ id: 't9', type: 'data', data: `frame ${index}` })
        await vi.advanceTimersByTimeAsync(700)
        expect(settled).toBe(false)
      }
      await vi.advanceTimersByTimeAsync(1000)
      await expect(pending).resolves.toEqual({ timedOut: false })
    } finally {
      vi.useRealTimers()
    }
  })
})
