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

import {
  exportConfigJson,
  getConfigRecoveryState,
  importConfigJson,
  loadConfig,
  saveConfig,
} from '../src/main/config'

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
    expect(getConfigRecoveryState()).toBeNull()
  })

  it('preserves invalid JSON before writing valid defaults', async () => {
    const invalidContent = '{"privateToken":"local-secret"'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await fs.writeFile(path.join(temporaryUserData, 'config.json'), invalidContent)

    const config = await loadConfig()
    const backup = await fs.readFile(
      path.join(temporaryUserData, 'config.json.corrupt.bak'),
      'utf-8'
    )
    const persisted = JSON.parse(
      await fs.readFile(path.join(temporaryUserData, 'config.json'), 'utf-8')
    )
    const recovery = getConfigRecoveryState()

    expect(persisted).toEqual(config)
    expect(backup).toBe(invalidContent)
    expect(recovery).toMatchObject({ recovered: true, reason: 'invalid-json' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Recuperacao concluida'))
    expect(warn.mock.calls.flat().join(' ')).not.toContain('local-secret')
  })

  it('backs up invalid JSON before saveConfig recovers it', async () => {
    const invalidContent = '{invalid'
    await fs.writeFile(path.join(temporaryUserData, 'config.json'), invalidContent)

    const saved = await saveConfig({ projectDirs: [] })
    const backup = await fs.readFile(
      path.join(temporaryUserData, 'config.json.corrupt.bak'),
      'utf-8'
    )

    expect(saved.projectDirs).toEqual([])
    expect(backup).toBe(invalidContent)
    expect(getConfigRecoveryState()).toMatchObject({
      recovered: true,
      reason: 'invalid-json',
      backupPath: path.join(temporaryUserData, 'config.json.corrupt.bak'),
    })
  })

  it('does not overwrite invalid JSON when its backup cannot be created', async () => {
    const invalidContent = '{invalid-and-should-remain'
    const configPath = path.join(temporaryUserData, 'config.json')
    await fs.writeFile(configPath, invalidContent)
    await fs.mkdir(`${configPath}.corrupt.bak`)

    await expect(loadConfig()).rejects.toThrow('preservar a configuracao invalida')
    expect(await fs.readFile(configPath, 'utf-8')).toBe(invalidContent)
    expect(getConfigRecoveryState()).toBeNull()
  })

  it('persists a valid Codex account selection per project', async () => {
    const saved = await saveConfig({
      projectAccounts: {
        projectA: 'account2',
        projectB: 'account1',
      },
    })

    expect(saved.projectAccounts).toEqual({ projectA: 'account2', projectB: 'account1' })

    await fs.writeFile(
      path.join(temporaryUserData, 'config.json'),
      JSON.stringify({ ...saved, projectAccounts: { projectA: 'account2', invalid: 'account3' } })
    )
    expect((await loadConfig()).projectAccounts).toEqual({ projectA: 'account2' })
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

  it('round-trips modelRouting through save/load/export/import', async () => {
    const secret = `sk-test-${'x'.repeat(16)}`
    const saved = await saveConfig({
      projectDirs: [temporaryUserData],
      modelRouting: { fastModel: 'ministral-3b', openaiApiKey: secret },
    })
    expect(saved.modelRouting).toMatchObject({ fastModel: 'ministral-3b' })

    const loaded = await loadConfig()
    expect(loaded.modelRouting?.fastModel).toBe('ministral-3b')
    expect(loaded.modelRouting?.openaiApiKey).toBe(secret)

    // Atualização parcial não descarta chaves já salvas.
    await saveConfig({ modelRouting: { deepModel: 'claude-sonnet' } })
    const merged = await loadConfig()
    expect(merged.modelRouting).toMatchObject({
      fastModel: 'ministral-3b',
      deepModel: 'claude-sonnet',
      openaiApiKey: secret,
    })

    const exported = await exportConfigJson()
    const imported = await importConfigJson(exported)
    expect(imported.modelRouting?.deepModel).toBe('claude-sonnet')

    // O segredo persiste no arquivo do usuário, mas nenhuma visão
    // serializada para logs o expõe em claro.
    const { redactSecrets } = await import('../src/main/agent-providers')
    expect(redactSecrets(exported)).not.toContain(secret)
    expect(JSON.stringify(saved)).toContain(secret)
  })

  it('drops invalid modelRouting values on load', async () => {
    await fs.writeFile(
      path.join(temporaryUserData, 'config.json'),
      JSON.stringify({ modelRouting: { fastModel: 'has space', openaiApiKey: '   ' } })
    )
    expect((await loadConfig()).modelRouting).toBeUndefined()
  })
})
