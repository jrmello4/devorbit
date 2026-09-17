import { describe, expect, it } from 'vitest'
import { Semaphore, SemaphoreAbortError, SemaphoreTimeoutError } from '../src/main/semaphore'

describe('Semaphore', () => {
  it('grants permits in FIFO order and releases idempotently', async () => {
    const semaphore = new Semaphore(1)
    const first = await semaphore.acquire()
    const order: string[] = []
    const second = semaphore.acquire().then((permit) => {
      order.push('second')
      return permit
    })
    const third = semaphore.acquire().then((permit) => {
      order.push('third')
      return permit
    })

    expect(semaphore.activeCount).toBe(1)
    expect(semaphore.pendingCount).toBe(2)
    first.release()
    const secondPermit = await second
    expect(order).toEqual(['second'])
    secondPermit()
    const thirdPermit = await third
    expect(order).toEqual(['second', 'third'])
    thirdPermit.release()
    thirdPermit.release()
    expect(semaphore.activeCount).toBe(0)
  })

  it('removes timed out and aborted waiters without disturbing FIFO', async () => {
    const semaphore = new Semaphore(1)
    const held = await semaphore.acquire()
    const controller = new AbortController()
    const aborted = semaphore.acquire({ signal: controller.signal })
    const timedOut = semaphore.acquire({ timeoutMs: 10 })
    const next = semaphore.acquire()
    controller.abort()
    await expect(aborted).rejects.toBeInstanceOf(SemaphoreAbortError)
    await expect(timedOut).rejects.toBeInstanceOf(SemaphoreTimeoutError)
    held.release()
    const permit = await next
    permit.release()
    expect(semaphore.pendingCount).toBe(0)
  })

  it('releases a permit when an exclusive task fails', async () => {
    const semaphore = new Semaphore({ limit: 1 })
    await expect(semaphore.runExclusive(async () => {
      throw new Error('failure')
    })).rejects.toThrow('failure')
    expect(semaphore.activeCount).toBe(0)
    const permit = await semaphore.acquire()
    permit.release()
  })
})
