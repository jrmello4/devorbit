import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const usageHome = vi.hoisted(() => ({ value: '' }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => usageHome.value,
    },
  }
})

import { getUsageState, tryReserveUsage } from '../src/main/usage'

let temporaryHome = ''

beforeEach(async () => {
  temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-usage-'))
  usageHome.value = temporaryHome
})

afterEach(async () => {
  await fs.rm(temporaryHome, { recursive: true, force: true })
})

describe('usage tracker persistence', () => {
  it('normalizes malformed persisted values and expires old windows', async () => {
    const usageFile = path.join(temporaryHome, '.devorbit', 'usage.json')
    await fs.mkdir(path.dirname(usageFile), { recursive: true })
    await fs.writeFile(
      usageFile,
      JSON.stringify({
        account1: { used: 4.9, limit: 0, windowDurationHours: 0, windowStart: Date.now() - 4 * 3600 * 1000 },
        account2: { used: -2, limit: Number.NaN, windowDurationHours: Number.POSITIVE_INFINITY },
        antigravity: { sessionCount: 3.8 },
      })
    )

    const state = await getUsageState()

    expect(state.account1).toMatchObject({ used: 0, limit: 1, windowDurationHours: 1 })
    expect(state.account1.windowStart).toBeUndefined()
    expect(state.account2).toMatchObject({ used: 0, limit: 40, windowDurationHours: 3 })
    expect(state.antigravity.sessionCount).toBe(3)
  })

  it('serializes concurrent reservations so a quota is never exceeded', async () => {
    const reservations = await Promise.all(
      Array.from({ length: 50 }, () => tryReserveUsage('account1'))
    )

    expect(reservations.filter(Boolean)).toHaveLength(40)
    expect(reservations.filter((reserved) => !reserved)).toHaveLength(10)
    expect((await getUsageState()).account1.used).toBe(40)
  })
})
