import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const userDataPath = vi.hoisted(() => ({ value: '' }))

vi.mock('electron', () => ({
  default: {
    app: {
      getPath: () => userDataPath.value,
    },
  },
}))

import { loadConfig, saveConfig } from '../src/main/config'

let temporaryUserData = ''

beforeEach(async () => {
  temporaryUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-config-'))
  userDataPath.value = temporaryUserData
})

afterEach(async () => {
  await fs.rm(temporaryUserData, { recursive: true, force: true })
})

describe('config persistence hardening', () => {
  it('normalizes malformed persisted values before they reach the scanner', async () => {
    await fs.writeFile(
      path.join(temporaryUserData, 'config.json'),
      JSON.stringify({
        projectDirs: 'not-an-array',
        activeChatGptAccount: 'account3',
        chatGptAccount1Name: 42,
        customPaths: {
          wt: `bad\0path`,
          codex: 'codex.cmd',
        },
      })
    )

    const config = await loadConfig()

    expect(config.projectDirs).toEqual([
      path.join(os.homedir(), 'projects'),
      path.join(os.homedir(), 'Documents'),
    ])
    expect(config.activeChatGptAccount).toBe('account1')
    expect(config.chatGptAccount1Name).toBe('Conta 1 (Principal)')
    expect(config.customPaths.codex).toBe('codex.cmd')
    expect(config.customPaths.wt).toBe('wt.exe')
  })

  it('preserves an explicit empty list of monitored folders', async () => {
    const saved = await saveConfig({ projectDirs: [] })

    expect(saved.projectDirs).toEqual([])
    expect((await loadConfig()).projectDirs).toEqual([])
  })
})
