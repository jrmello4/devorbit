import { describe, expect, it, vi } from 'vitest'
import { createPipeCallQueue } from '../src/renderer/src/components/pipe-ipc-queue'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

describe('pipe call queue', () => {
  it('preserves clear -> add order per source', async () => {
    const observed: Array<[string, string | null]> = []
    const gate = deferred()
    const send = vi.fn(async (from: string, to: string | null) => {
      observed.push([from, to])
      if (to === null) await gate.promise
    })
    const queue = createPipeCallQueue(send)
    const first = queue('t1', null)
    const second = queue('t1', 't2')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send).toHaveBeenLastCalledWith('t1', null)
    gate.resolve()
    await first
    await second
    expect(observed).toEqual([
      ['t1', null],
      ['t1', 't2'],
    ])
  })

  it('survives two rapid fanout changes in order', async () => {
    const observed: Array<[string, string | null]> = []
    const send = vi.fn(async (from: string, to: string | null) => {
      observed.push([from, to])
    })
    const queue = createPipeCallQueue(send)
    // Primeira reconciliação: limpa e adiciona t2.
    const p1 = queue('t1', null)
    const p2 = queue('t1', 't2')
    // Segunda mudança rápida antes de terminar: limpa e adiciona t3.
    const p3 = queue('t1', null)
    const p4 = queue('t1', 't3')
    await Promise.all([p1, p2, p3, p4])
    expect(observed).toEqual([
      ['t1', null],
      ['t1', 't2'],
      ['t1', null],
      ['t1', 't3'],
    ])
  })

  it('keeps independent sources parallel and survives failures', async () => {
    const observed: Array<[string, string | null]> = []
    const send = vi.fn(async (from: string, to: string | null) => {
      observed.push([from, to])
      if (from === 'bad') throw new Error('ipc down')
    })
    const queue = createPipeCallQueue(send)
    await Promise.all([queue('bad', 'x'), queue('good', 'y'), queue('bad', null)])
    expect(observed).toEqual([
      ['bad', 'x'],
      ['good', 'y'],
      ['bad', null],
    ])
  })
})
