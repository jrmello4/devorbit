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
import type { CustomTerminalPreset } from '../src/shared/terminal-presets'

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

  it('exports a clean profile without missing default project directories', async () => {
    const defaultProjectDirs = [
      path.join(os.homedir(), 'projects'),
      path.join(os.homedir(), 'Documents'),
    ]
    const originalStat = fs.stat
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (target, ...args) => {
      if (defaultProjectDirs.includes(String(target))) {
        const error = Object.assign(new Error('missing default directory'), { code: 'ENOENT' })
        throw error
      }
      return originalStat.call(fs, target, ...args)
    })

    try {
      const exported = await exportConfigJson()
      expect(JSON.parse(exported).projectDirs).toEqual([])

      const imported = await importConfigJson(exported)
      expect(imported.projectDirs).toEqual([])
      await expect(
        importConfigJson(JSON.stringify({ projectDirs: [path.join(temporaryUserData, 'arbitrary-missing')] })),
      ).rejects.toThrow()
    } finally {
      statSpy.mockRestore()
    }
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

    // Mesmo sem safeStorage no ambiente de teste, o arquivo público não pode
    // conter o segredo em texto claro.
    const persisted = await fs.readFile(path.join(temporaryUserData, 'config.json'), 'utf-8')
    expect(persisted).not.toContain(secret)

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

  it('round-trips automation through save/load/export/import with field-wise merge', async () => {
    const saved = await saveConfig({
      automation: {
        defaultExecutor: 'opencode',
        autoStartExecutor: true,
        restoreWorkspace: true,
        restoreProjectId: 'proj-1',
      },
    })
    expect(saved.automation).toMatchObject({
      defaultExecutor: 'opencode',
      autoStartExecutor: true,
      restoreWorkspace: true,
      restoreProjectId: 'proj-1',
    })

    // Atualização parcial não descarta as chaves já salvas.
    await saveConfig({ automation: { defaultCodexAccount: 'account2' } })
    const merged = await loadConfig()
    expect(merged.automation).toMatchObject({
      defaultExecutor: 'opencode',
      autoStartExecutor: true,
      restoreWorkspace: true,
      restoreProjectId: 'proj-1',
      defaultCodexAccount: 'account2',
    })

    const exported = await exportConfigJson()
    const imported = await importConfigJson(exported)
    expect(imported.automation?.defaultExecutor).toBe('opencode')

    // `undefined` explícito limpa o campo no merge (executor -> nenhum).
    await saveConfig({ automation: { defaultExecutor: undefined, restoreProjectId: undefined } })
    const cleared = await loadConfig()
    expect(cleared.automation?.defaultExecutor).toBeUndefined()
    expect(cleared.automation?.restoreProjectId).toBeUndefined()
    expect(cleared.automation?.defaultCodexAccount).toBe('account2')
  })

  it('drops invalid automation values on load', async () => {
    await fs.writeFile(
      path.join(temporaryUserData, 'config.json'),
      JSON.stringify({
        automation: {
          defaultExecutor: 'not-a-provider',
          defaultCodexAccount: 'account9',
          autoStartExecutor: 'yes',
          restoreProjectId: 42,
        },
      })
    )
    expect((await loadConfig()).automation).toBeUndefined()
  })

  it('round-trips terminalPresets through save/load/export/import', async () => {
    const presets: CustomTerminalPreset[] = [
      {
        id: 'custom:dev-server',
        name: 'Servidor de dev',
        command: 'npm',
        args: ['run', 'dev'],
        resumeCommand: 'npm',
        resumeArgs: ['run', 'dev'],
        defaultAutoStart: true,
        defaultMonitorActivity: true,
        defaultRestartBehavior: 'resume',
      },
      { id: 'custom:lint', name: 'Lint', command: 'npm', args: ['run', 'lint'] },
    ]
    const saved = await saveConfig({ projectDirs: [], terminalPresets: presets })
    expect(saved.terminalPresets).toEqual(presets)

    const loaded = await loadConfig()
    expect(loaded.terminalPresets).toEqual(presets)

    // A lista é trocada por inteiro: salvar de novo substitui os presets.
    const replaced = await saveConfig({ terminalPresets: [presets[1]] })
    expect(replaced.terminalPresets).toEqual([presets[1]])

    const imported = await importConfigJson(await exportConfigJson())
    expect(imported.terminalPresets).toEqual([presets[1]])
  })

  it('drops malformed terminalPresets entries on load', async () => {
    await fs.writeFile(
      path.join(temporaryUserData, 'config.json'),
      JSON.stringify({
        terminalPresets: [
          { id: 'sem-prefixo', name: 'Sem prefixo', command: 'x' },
          { id: 'custom:ok', name: 'Ok', command: 'ok.exe' },
          { id: 'custom:ok', name: 'Duplicado', command: 'dup.exe' },
          { id: 'custom:sempreset', name: 'Sem comando' },
          { id: 'custom:comando', name: 'Comando ruim', command: 'npm%injection' },
          'preset',
        ],
      })
    )
    expect((await loadConfig()).terminalPresets).toEqual([
      { id: 'custom:ok', name: 'Ok', command: 'ok.exe' },
    ])
  })

  it('preserves terminalPresets when saving unrelated keys and clears on empty list', async () => {
    const preset = { id: 'custom:dev-server', name: 'Servidor de dev', command: 'npm' }
    await saveConfig({ terminalPresets: [preset] })
    await saveConfig({ chatGptAccount1Name: 'Minha Conta' })
    expect((await loadConfig()).terminalPresets).toEqual([preset])
    expect((await loadConfig()).chatGptAccount1Name).toBe('Minha Conta')

    // Lista vazia explícita limpa os presets (chave some do arquivo).
    const cleared = await saveConfig({ terminalPresets: [] })
    expect(cleared.terminalPresets).toBeUndefined()
    expect((await loadConfig()).terminalPresets).toBeUndefined()
    expect(JSON.parse(await fs.readFile(path.join(temporaryUserData, 'config.json'), 'utf-8')).terminalPresets).toBeUndefined()
  })
})
