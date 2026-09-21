import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveWindowsScriptLaunch } from '../src/main/terminal-launch'
import {
  testToolPath,
  validateCodexAccount,
  validateConfigUpdates,
  validateFiniteNumber,
  validateGitInitOptions,
  validateGitPushOptions,
  validateHttpsUrl,
  validateLaunchTool,
  validateProjectDirs,
  validateTerminalStartOptions,
  validateWindowAction,
} from '../src/main/validation'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('IPC input validation', () => {
  it('accepts supported enum values and rejects values outside the allowlists', () => {
    expect(validateLaunchTool('codex-cli')).toBe('codex-cli')
    expect(validateCodexAccount('account2')).toBe('account2')
    expect(validateWindowAction('maximize')).toBe('maximize')

    expect(() => validateLaunchTool('powershell')).toThrow('Ferramenta inválida')
    expect(() => validateCodexAccount('account3')).toThrow('Conta do Codex inválida')
    expect(() => validateWindowAction('reload')).toThrow('Ação de janela inválida')
  })

  it('only accepts HTTPS URLs without embedded credentials', () => {
    expect(validateHttpsUrl('https://github.com/example/repo')).toBe('https://github.com/example/repo')
    expect(validateHttpsUrl('  HTTPS://GitHub.com/example/repo  ')).toBe(
      'https://github.com/example/repo'
    )

    expect(() => validateHttpsUrl('http://github.com/example/repo')).toThrow(
      'A URL deve usar HTTPS'
    )
    expect(() => validateHttpsUrl('https://user:password@example.com/repo')).toThrow(
      'não pode conter credenciais'
    )
    expect(() => validateHttpsUrl('javascript:alert(1)')).toThrow('A URL deve usar HTTPS')
    expect(() => validateHttpsUrl('not a URL')).toThrow('URL inválida')
  })

  it('validates Git initialization options before they reach the main process', () => {
    expect(validateGitInitOptions({
      branch: 'feature/conta-segura',
      remoteUrl: 'https://github.com/example/repo.git',
      initialCommit: true,
      commitMessage: 'chore: inicia projeto',
      push: true,
      confirmAllFiles: true,
      previewFingerprint: 'A'.repeat(64),
    })).toMatchObject({
      branch: 'feature/conta-segura',
      remoteUrl: 'https://github.com/example/repo.git',
      initialCommit: true,
      push: true,
      confirmAllFiles: true,
      previewFingerprint: 'a'.repeat(64),
    })

    expect(() => validateGitInitOptions({ branch: 'main && whoami' })).toThrow(
      'Nome de branch inválido'
    )
    expect(() => validateGitInitOptions({ push: true })).not.toThrow()
    expect(() => validateGitInitOptions({ commitMessage: '' })).toThrow(
      'Mensagem do commit inválida'
    )
  })

  it('validates and deduplicates explicitly selected Git push paths', () => {
    expect(validateGitPushOptions({ selectedPaths: ['src/app.ts', 'README.md', 'src/app.ts'] }))
      .toEqual({ selectedPaths: ['src/app.ts', 'README.md'] })
    expect(validateGitPushOptions(undefined)).toEqual({})
    expect(() => validateGitPushOptions({ selectedPaths: ['../outside'] })).toThrow('Caminho de arquivo')
    expect(() => validateGitPushOptions({ selectedPaths: [''] })).toThrow('Caminho de arquivo')
    expect(() => validateGitPushOptions({ selectedPaths: ['a\0b'] })).toThrow('Caminho de arquivo')
  })

  it('rejects non-finite and out-of-range numeric values', () => {
    expect(validateFiniteNumber(3, 'Limite')).toBe(3)
    expect(validateFiniteNumber(2, 'Quantidade', { minimum: 1, integer: true })).toBe(2)

    expect(() => validateFiniteNumber(Number.NaN, 'Limite')).toThrow('Limite inválido')
    expect(() => validateFiniteNumber(Number.POSITIVE_INFINITY, 'Limite')).toThrow('Limite inválido')
    expect(() => validateFiniteNumber(-1, 'Limite')).toThrow('Limite inválido')
    expect(() => validateFiniteNumber(1.5, 'Quantidade', { integer: true })).toThrow(
      'Quantidade inválido'
    )
    expect(validateFiniteNumber(200, 'Limite', { minimum: 5, maximum: 200, integer: true })).toBe(200)
    expect(() => validateFiniteNumber(201, 'Limite', { minimum: 5, maximum: 200, integer: true })).toThrow('Limite inválido')
    expect(() => validateFiniteNumber(4, 'Limite', { minimum: 5, maximum: 200, integer: true })).toThrow('Limite inválido')
  })

  it('validates BYOK model routing without accepting garbage', async () => {
    expect(await validateConfigUpdates({ modelRouting: { fastModel: 'ministral-3b' } })).toEqual({
      modelRouting: { fastModel: 'ministral-3b' },
    })
    expect(await validateConfigUpdates({ modelRouting: {} })).toEqual({ modelRouting: undefined })
    await expect(validateConfigUpdates({ modelRouting: 'nope' })).rejects.toThrow(
      'Configuração de modelos inválida'
    )
  })

  it('validates automation updates and rejects garbage', async () => {
    expect(
      await validateConfigUpdates({
        automation: {
          defaultExecutor: 'agy',
          defaultCodexAccount: 'account2',
          autoStartExecutor: true,
          restoreWorkspace: false,
          restoreProjectId: 'proj-1',
        },
      })
    ).toEqual({
      automation: {
        defaultExecutor: 'agy',
        defaultCodexAccount: 'account2',
        autoStartExecutor: true,
        restoreWorkspace: false,
        restoreProjectId: 'proj-1',
      },
    })
    // `null` limpa o campo para o merge do config.
    expect(await validateConfigUpdates({ automation: { defaultExecutor: null } })).toEqual({
      automation: { defaultExecutor: undefined },
    })
    // Payload do SettingsModal manda booleanos `undefined` quando intocados.
    expect(
      await validateConfigUpdates({
        automation: { defaultExecutor: undefined, autoStartExecutor: undefined, restoreWorkspace: undefined },
      })
    ).toEqual({ automation: {} })
    await expect(validateConfigUpdates({ automation: { defaultExecutor: 'nope' } })).rejects.toThrow(/Provedor/)
    await expect(validateConfigUpdates({ automation: { defaultCodexAccount: 'account9' } })).rejects.toThrow(/Conta/)
    await expect(validateConfigUpdates({ automation: { autoStartExecutor: 'yes' } })).rejects.toThrow(/executor/)
    await expect(validateConfigUpdates({ automation: { restoreWorkspace: 1 } })).rejects.toThrow(/workspace/)
  })

  it('validates terminalPresets updates: lista vazia limpa, lixo rejeitado', async () => {
    const preset = { id: 'custom:review', name: 'Codex Review', command: 'codex' }
    expect(await validateConfigUpdates({ terminalPresets: [preset] })).toEqual({ terminalPresets: [preset] })
    // Lista vazia é limpeza explícita via IPC (apagar o último preset).
    expect(await validateConfigUpdates({ terminalPresets: [] })).toEqual({ terminalPresets: [] })
    await expect(validateConfigUpdates({ terminalPresets: 'nope' })).rejects.toThrow(/Presets/)
    expect(
      await validateConfigUpdates({ terminalPresets: [{ id: 'ruim', name: 'x', command: 'codex' }] })
    ).toEqual({ terminalPresets: [] })
  })

  it('canonicalizes project directories and removes duplicate paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-validation-'))
    temporaryDirectories.push(root)
    const projects = path.join(root, 'projects')
    await fs.mkdir(projects)

    const result = await validateProjectDirs([
      projects,
      path.join(root, 'nested', '..', 'projects'),
    ])

    expect(result).toHaveLength(1)
    expect(await fs.realpath(projects)).toBe(result[0])
  })

  it('checks tool paths against the filesystem and PATH', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-validation-'))
    temporaryDirectories.push(root)
    const exe = path.join(root, 'tool.exe')
    await fs.writeFile(exe, 'fixture')

    const found = await testToolPath(exe)
    expect(found).toMatchObject({ path: exe, ok: true })

    const missing = await testToolPath(path.join(root, 'missing.exe'))
    expect(missing).toMatchObject({ path: path.join(root, 'missing.exe'), ok: false })

    const unknownCommand = await testToolPath('definitely-not-a-real-command-xyz')
    expect(unknownCommand.ok).toBe(false)

    await expect(testToolPath('')).rejects.toThrow('inválido')
    await expect(testToolPath('a\0b')).rejects.toThrow('inválido')
  })

  it('rejects missing, file, and overlong project directory entries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-validation-'))
    temporaryDirectories.push(root)
    const file = path.join(root, 'not-a-directory.txt')
    await fs.writeFile(file, 'fixture')

    await expect(validateProjectDirs([path.join(root, 'missing')])).rejects.toThrow(
      'não existe ou não é uma pasta'
    )
    await expect(validateProjectDirs([file])).rejects.toThrow(
      'não existe ou não é uma pasta'
    )
    await expect(validateProjectDirs(Array.from({ length: 17 }, () => root))).rejects.toThrow(
      'no máximo 16 pastas'
    )
  })
})

describe('opções de start do terminal (Smart Terminals)', () => {
  it('aceita comando, args e cwd válidos e devolve undefined sem opções', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-validation-'))
    temporaryDirectories.push(root)

    expect(await validateTerminalStartOptions({
      command: ' npm ',
      args: ['run', 'dev'],
      cwd: root,
    })).toEqual({ command: 'npm', args: ['run', 'dev'], cwd: await fs.realpath(root) })
    expect(await validateTerminalStartOptions(undefined)).toBeUndefined()
    expect(await validateTerminalStartOptions(null)).toBeUndefined()
    expect(await validateTerminalStartOptions({})).toBeUndefined()
  })

  it('canonicaliza traversal com .. para o diretório absoluto existente', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-validation-'))
    temporaryDirectories.push(root)
    await fs.mkdir(path.join(root, 'sub'))

    const result = await validateTerminalStartOptions({ cwd: path.join(root, 'sub', '..') })
    expect(result?.cwd).toBe(await fs.realpath(root))
  })

  it('rejeita %, !, NUL, caractere de controle e comando acima de 512', async () => {
    await expect(validateTerminalStartOptions({ command: 'npm%i' })).rejects.toThrow('Comando do terminal inválido')
    await expect(validateTerminalStartOptions({ command: 'node!x' })).rejects.toThrow('Comando do terminal inválido')
    await expect(validateTerminalStartOptions({ command: 'bad\0cmd' })).rejects.toThrow('Comando do terminal inválido')
    await expect(validateTerminalStartOptions({ command: 'bad\u001fcmd' })).rejects.toThrow('Comando do terminal inválido')
    await expect(validateTerminalStartOptions({ command: 'a'.repeat(513) })).rejects.toThrow('Comando do terminal inválido')
    await expect(validateTerminalStartOptions('nope')).rejects.toThrow('Opções de início do terminal inválidas')
  })

  it('rejeita mais de 16 args e arg acima de 256; 16 args passam', async () => {
    await expect(validateTerminalStartOptions({ args: Array.from({ length: 17 }, () => 'a') })).rejects.toThrow(
      'Argumentos do terminal inválidos'
    )
    await expect(validateTerminalStartOptions({ args: ['a'.repeat(257)] })).rejects.toThrow(
      'Argumento do terminal inválido'
    )
    const sixteen = Array.from({ length: 16 }, (_, index) => `arg-${index}`)
    expect((await validateTerminalStartOptions({ args: sixteen }))?.args).toHaveLength(16)
  })

  it('exige que o cwd exista e seja uma pasta', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-validation-'))
    temporaryDirectories.push(root)
    const file = path.join(root, 'arquivo.txt')
    await fs.writeFile(file, 'fixture')

    await expect(validateTerminalStartOptions({ cwd: path.join(root, 'missing') })).rejects.toThrow(
      'não existe ou não é uma pasta'
    )
    await expect(validateTerminalStartOptions({ cwd: file })).rejects.toThrow(
      'não existe ou não é uma pasta'
    )
  })
})

describe('resolveWindowsScriptLaunch (wrap cmd.exe)', () => {
  const originalComSpec = process.env.ComSpec

  afterEach(() => {
    if (originalComSpec === undefined) delete process.env.ComSpec
    else process.env.ComSpec = originalComSpec
  })

  it('embrulha .cmd/.bat via ComSpec, sem diferenciar caixa', () => {
    process.env.ComSpec = 'C:\\Windows\\system32\\cmd.exe'
    expect(resolveWindowsScriptLaunch('tool.cmd')).toEqual({
      command: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/q', '/k', 'call "tool.cmd"'],
    })
    expect(resolveWindowsScriptLaunch('tool.CMD', ['--flag'])).toEqual({
      command: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/q', '/k', 'call "tool.CMD"', '--flag'],
    })
    expect(resolveWindowsScriptLaunch('setup.BaT', ['a', 'b']).args.slice(-2)).toEqual(['a', 'b'])
  })

  it('mantém comando comum intocado, mesmo com metacaracteres nos args', () => {
    process.env.ComSpec = 'C:\\Windows\\system32\\cmd.exe'
    expect(resolveWindowsScriptLaunch('codex', ['--flag', 'a&b'])).toEqual({
      command: 'codex',
      args: ['--flag', 'a&b'],
    })
  })

  it('cai no cmd.exe padrão sem ComSpec', () => {
    delete process.env.ComSpec
    expect(resolveWindowsScriptLaunch('tool.cmd').command).toBe('cmd.exe')
  })

  it('rejeita aspas no comando e metacaracteres nos args do caminho embrulhado', () => {
    expect(() => resolveWindowsScriptLaunch('to"ol.cmd')).toThrow('aspas')
    expect(() => resolveWindowsScriptLaunch('tool.bat', ['a&b'])).toThrow('metacaracteres')
    expect(() => resolveWindowsScriptLaunch('tool.cmd', ['ok', 'a|b'])).toThrow('metacaracteres')
    expect(() => resolveWindowsScriptLaunch('tool.cmd', ['a<b'])).toThrow('metacaracteres')
    expect(() => resolveWindowsScriptLaunch('tool.cmd', ['a^b'])).toThrow('metacaracteres')
    expect(() => resolveWindowsScriptLaunch('tool.cmd', ['a"b'])).toThrow('metacaracteres')
  })
})
