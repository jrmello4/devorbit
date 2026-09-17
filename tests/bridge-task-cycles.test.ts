import { describe, expect, it, vi } from 'vitest'
import { BridgeTaskCycles } from '../src/main/bridge-task-cycles'

describe('BridgeTaskCycles', () => {
  it('invalidates cached outcomes when a new cycle begins', () => {
    const cycles = new BridgeTaskCycles<string>()
    const first = cycles.begin('t1')
    expect(cycles.cacheOutcome('t1', first, { status: 'completed', summary: 'first' })).toBe(true)
    expect(cycles.cachedOutcome('t1')).toEqual({ status: 'completed', summary: 'first' })

    const second = cycles.begin('t1')
    expect(second).toBe(first + 1)
    expect(cycles.cachedOutcome('t1')).toBeUndefined()
  })

  it('ignores late completions from an older generation', () => {
    const cycles = new BridgeTaskCycles<string>()
    const oldGeneration = cycles.begin('t1')
    cycles.setPending('t1', oldGeneration, 'payload', { cancel: vi.fn() }, true)
    cycles.begin('t1')

    expect(cycles.complete('t1', oldGeneration, { status: 'completed', summary: 'stale' })).toBe(false)
    expect(cycles.cachedOutcome('t1')).toBeUndefined()
  })

  it('associates pending work with the current generation only', () => {
    const cycles = new BridgeTaskCycles<string>()
    const generation = cycles.begin('t1')
    cycles.setPending('t1', generation, 'payload', { cancel: vi.fn() }, true)

    expect(cycles.hasPending('t1')).toBe(true)
    expect(cycles.pendingFor('t1', generation)?.payload).toBe('payload')
    expect(cycles.pendingFor('t1', generation + 1)).toBeUndefined()

    expect(cycles.complete('t1', generation, { status: 'completed', summary: 'done' })).toBe(true)
    expect(cycles.hasPending('t1')).toBe(false)
    expect(cycles.cachedOutcome('t1')).toEqual({ status: 'completed', summary: 'done' })
  })

  it('cancels queued work and never caches a cancelled ask', () => {
    const cancel = vi.fn()
    const cycles = new BridgeTaskCycles<string>()
    const generation = cycles.begin('t1')
    cycles.setPending('t1', generation, 'payload', { cancel }, false)

    expect(cycles.cancelPending('t1')).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cycles.cancelPending('t1')).toBe(false)
    expect(cycles.complete('t1', generation, { status: 'failed', summary: 'aborted' })).toBe(true)
    expect(cycles.cachedOutcome('t1')).toEqual({ status: 'failed', summary: 'aborted' })
  })

  it('expires cached outcomes and bounds the cache', () => {
    let now = 1_000
    const cycles = new BridgeTaskCycles<string>({ ttlMs: 50, maxEntries: 2, now: () => now })
    const generation = cycles.begin('t1')
    cycles.cacheOutcome('t1', generation, { status: 'completed', summary: 'one' })
    now += 51

    expect(cycles.cachedOutcome('t1')).toBeUndefined()

    now += 1
    cycles.cacheOutcome('t1', generation, { status: 'completed', summary: 'one' })
    cycles.cacheOutcome('t2', cycles.begin('t2'), { status: 'completed', summary: 'two' })
    cycles.cacheOutcome('t3', cycles.begin('t3'), { status: 'completed', summary: 'three' })
    expect(cycles.cachedOutcome('t1')).toBeUndefined()
    expect(cycles.cachedOutcome('t3')).toEqual({ status: 'completed', summary: 'three' })
  })

  it('keeps generations independent per target', () => {
    const cycles = new BridgeTaskCycles<string>()
    const a = cycles.begin('t1')
    const b = cycles.begin('t2')

    expect(a).toBe(1)
    expect(b).toBe(1)
    cycles.cacheOutcome('t1', a, { status: 'completed', summary: 'a' })
    cycles.cacheOutcome('t2', b, { status: 'completed', summary: 'b' })
    cycles.begin('t1')
    expect(cycles.cachedOutcome('t1')).toBeUndefined()
    expect(cycles.cachedOutcome('t2')).toEqual({ status: 'completed', summary: 'b' })
  })
})
