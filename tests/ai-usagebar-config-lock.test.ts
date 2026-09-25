import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createConfigWriteLock, sharedConfigWriteLock } from '../src/main/ai-usagebar-config-lock'

describe('createConfigWriteLock', () => {
  it('serializes concurrent writes to the same path', async () => {
    const lock = createConfigWriteLock()
    const order: number[] = []
    let counter = 0

    const task = (p: string, delay: number) => lock.withConfigLock(p, async () => {
      const id = counter++
      order.push(id)
      await new Promise((r) => setTimeout(r, delay))
      order.push(id + 0.5)
      return id
    })

    await Promise.all([
      task('/a/config.toml', 10),
      task('/a/config.toml', 5),
      task('/a/config.toml', 1),
    ])
    expect(order).toEqual([0, 0.5, 1, 1.5, 2, 2.5])
  })

  it('allows concurrent writes to different paths', async () => {
    const lock = createConfigWriteLock()
    const timeline: string[] = []

    const task = (p: string, label: string, delay: number) => lock.withConfigLock(p, async () => {
      timeline.push(`${label}-start`)
      await new Promise((r) => setTimeout(r, delay))
      timeline.push(`${label}-end`)
    })

    await Promise.all([task('/a', 'a', 20), task('/b', 'b', 5)])
    expect(timeline).toEqual(['a-start', 'b-start', 'b-end', 'a-end'])
  })

  it('propagates errors without blocking the queue', async () => {
    const lock = createConfigWriteLock()

    await expect(
      lock.withConfigLock('/x', async () => { throw new Error('boom') }),
    ).rejects.toThrow('boom')

    const result = await lock.withConfigLock('/x', async () => 42)
    expect(result).toBe(42)
  })

  it('cleans up tails entry when queue drains', async () => {
    const lock = createConfigWriteLock()
    await lock.withConfigLock('/cleanup-test', async () => 1)
    await lock.withConfigLock('/cleanup-test', async () => 2)
  })

  it('normalizes path aliases to the same queue (deterministic serialization)', async () => {
    const lock = createConfigWriteLock()
    const order: string[] = []
    const alias = path.resolve('/alias-test/../alias-test/sub/../config.toml')
    const direct = path.resolve('/alias-test/config.toml')

    const tasks = [
      lock.withConfigLock(alias, async () => {
        order.push('alias-start')
        await new Promise((r) => setTimeout(r, 10))
        order.push('alias-end')
      }),
      lock.withConfigLock(direct, async () => {
        order.push('direct-start')
        await new Promise((r) => setTimeout(r, 5))
        order.push('direct-end')
      }),
    ]

    if (process.platform === 'win32') {
      const upper = direct.replace(/[a-z]/g, (c) => c.toUpperCase())
      tasks.push(
        lock.withConfigLock(upper, async () => {
          order.push('upper-start')
          await new Promise((r) => setTimeout(r, 3))
          order.push('upper-end')
        }),
      )
    }

    await Promise.all(tasks)

    if (process.platform === 'win32') {
      expect(order).toEqual(['alias-start', 'alias-end', 'direct-start', 'direct-end', 'upper-start', 'upper-end'])
    } else {
      expect(order).toEqual(['alias-start', 'alias-end', 'direct-start', 'direct-end'])
    }
  })
})

describe('sharedConfigWriteLock singleton', () => {
  it('is the same instance when imported from different call sites', async () => {
    const { sharedConfigWriteLock: a } = await import('../src/main/ai-usagebar-config-lock')
    const { sharedConfigWriteLock: b } = await import('../src/main/ai-usagebar-config-lock')
    expect(a).toBe(b)
    expect(a).toBe(sharedConfigWriteLock)
  })

  it('serializes writes through the shared instance', async () => {
    const order: number[] = []
    let c = 0

    await Promise.all([
      sharedConfigWriteLock.withConfigLock('/singleton-serialize-test', async () => {
        const id = c++; order.push(id); await new Promise((r) => setTimeout(r, 10)); order.push(id + 0.5)
      }),
      sharedConfigWriteLock.withConfigLock('/singleton-serialize-test', async () => {
        const id = c++; order.push(id); await new Promise((r) => setTimeout(r, 5)); order.push(id + 0.5)
      }),
    ])
    expect(order).toEqual([0, 0.5, 1, 1.5])
  })
})
