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

import { exportConfigJson, importConfigJson, loadConfig, saveConfig } from '../src/main/config'

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

  it('serializa a inicialização concorrente do primeiro config.json', async () => {
    const configs = await Promise.all([loadConfig(), loadConfig(), loadConfig()])

    expect(configs).toHaveLength(3)
    expect(configs.every((config) => Array.isArray(config.projectDirs))).toBe(true)
    await expect(fs.readFile(path.join(temporaryUserData, 'config.json'), 'utf-8')).resolves.toMatch(/projectDirs/)
  })

  it('exports valid JSON that can be reimported', async () => {
    await saveConfig({ projectDirs: [], chatGptAccount1Name: 'Minha Conta' })
    const exported = await exportConfigJson()
    const parsed = JSON.parse(exported)
    expect(parsed.chatGptAccount1Name).toBe('Minha Conta')

    await saveConfig({ chatGptAccount1Name: 'Outra' })
    const imported = await importConfigJson(exported)
    expect(imported.chatGptAccount1Name).toBe('Minha Conta')
    expect(imported.projectDirs).toEqual([])
  })

  it('backs up the previous file before importing', async () => {
    await saveConfig({ chatGptAccount1Name: 'Antiga' })
    await importConfigJson(JSON.stringify({ chatGptAccount1Name: 'Nova', projectDirs: [] }))
    const backup = JSON.parse(await fs.readFile(path.join(temporaryUserData, 'config.json.bak'), 'utf-8'))
    expect(backup.chatGptAccount1Name).toBe('Antiga')
  })

  it('rejects malformed import payloads', async () => {
    await expect(importConfigJson('{invalid')).rejects.toThrow('inválido')
    await expect(importConfigJson('')).rejects.toThrow('inválido')
    await expect(importConfigJson(JSON.stringify({ projectDirs: ['/missing-dir-xyz'] }))).rejects.toThrow()
  })
})
