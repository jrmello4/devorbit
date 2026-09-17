import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const clipboardWrite = vi.hoisted(() => vi.fn())
const userDataPath = vi.hoisted(() => ({ value: '' }))
const execFileMock = vi.hoisted(() => vi.fn())
const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  default: {
    clipboard: { writeText: clipboardWrite },
    shell: { openPath: vi.fn(async () => '') },
    app: { getPath: () => userDataPath.value },
  },
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: spawnMock,
}))

import { copyProjectContext, launchTool } from '../src/main/launcher'

let projectPath = ''
let temporaryUserData = ''

function mockGit() {
  execFileMock.mockImplementation(
    (
      command: string,
      args: string[],
      options: Record<string, unknown>,
      callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      if (command !== 'git') throw new Error(`unexpected command: ${command}`)
      if (args[0] === 'status' && args.includes('-b')) {
        callback(null, { stdout: '## main...origin/main\n M src/index.ts\n', stderr: '' })
        return
      }
      if (args[0] === 'status') {
        callback(null, { stdout: ' M src/index.ts\n', stderr: '' })
        return
      }
      if (args[0] === 'log') {
        callback(null, { stdout: 'abc1234 (2026-09-01) feat: fixture commit\n', stderr: '' })
        return
      }
      callback(null, { stdout: '', stderr: '' })
    }
  )
}

function mockVisibleSpawn({ failWindowsTerminal = false } = {}) {
  spawnMock.mockImplementation((command: string) => {
    const child: { once: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> } = {
      once: vi.fn((event: string, callback: () => void) => {
        if (event === 'error' && failWindowsTerminal && command === 'wt.exe') {
          callback()
        }
        if (event === 'spawn' && !(failWindowsTerminal && command === 'wt.exe')) {
          callback()
        }
        return child
      }),
      unref: vi.fn(),
    }
    return child
  })
}

beforeEach(async () => {
  temporaryUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-launcher-user-'))
  userDataPath.value = temporaryUserData
  projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-launcher-proj-'))
  clipboardWrite.mockReset()
  execFileMock.mockReset()
  spawnMock.mockReset()
  mockGit()
})

afterEach(async () => {
  await fs.rm(projectPath, { recursive: true, force: true })
  await fs.rm(temporaryUserData, { recursive: true, force: true })
})

describe('copyProjectContext', () => {
  it('inclui branch, commit e descrição do package.json', async () => {
    await fs.mkdir(path.join(projectPath, '.git'))
    await fs.writeFile(
      path.join(projectPath, 'package.json'),
      JSON.stringify({ name: 'demo', description: 'Projeto de demonstração' })
    )

    const result = await copyProjectContext(projectPath)

    expect(result.success).toBe(true)
    expect(result.context).toContain('demo')
    expect(result.context).toContain('Projeto de demonstração')
    expect(result.context).toContain('main')
    expect(result.context).toContain('abc1234')
    expect(clipboardWrite).toHaveBeenCalledOnce()
  })

  it('funciona sem git nem package.json', async () => {
    const result = await copyProjectContext(projectPath)

    expect(result.success).toBe(true)
    expect(result.context).toContain(path.basename(projectPath))
    expect(result.context).not.toContain('Branch Git')
  })

  it('corta a memória gigante dentro do teto', async () => {
    await fs.mkdir(path.join(projectPath, '.git'))
    await fs.mkdir(path.join(projectPath, '.devorbit'), { recursive: true })
    await fs.writeFile(path.join(projectPath, '.devorbit', 'memory.md'), 'x'.repeat(20000))

    const result = await copyProjectContext(projectPath)

    expect(result.success).toBe(true)
    expect(result.context.length).toBeLessThanOrEqual(8100)
    expect(result.context).toMatch(/cortad/)
  })
})

describe('launchTool', () => {
  it('mantém o terminal visível e usa PowerShell quando o Windows Terminal não está disponível', async () => {
    mockVisibleSpawn({ failWindowsTerminal: true })

    const result = await launchTool('terminal', projectPath)

    expect(result).toMatchObject({ success: true })
    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      'wt.exe',
      ['-d', projectPath],
      expect.objectContaining({ detached: true, windowsHide: false })
    )
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'powershell.exe',
      ['-NoExit'],
      expect.objectContaining({ cwd: projectPath, detached: true, windowsHide: false })
    )
  })

  it('resolve um VS Code real a partir de um wrapper code.cmd configurado', async () => {
    const wrapperDirectory = path.join(temporaryUserData, 'vscode', 'bin')
    const wrapper = path.join(wrapperDirectory, 'code.cmd')
    const executable = path.join(temporaryUserData, 'vscode', 'Code.exe')
    await fs.mkdir(wrapperDirectory, { recursive: true })
    await fs.writeFile(wrapper, '@echo off')
    await fs.writeFile(executable, 'fixture')
    await fs.writeFile(
      path.join(temporaryUserData, 'config.json'),
      JSON.stringify({ customPaths: { vscode: wrapper } })
    )
    mockVisibleSpawn()

    const result = await launchTool('vscode', projectPath)

    expect(result).toMatchObject({ success: true })
    expect(spawnMock).toHaveBeenCalledWith(
      executable,
      [projectPath],
      expect.objectContaining({ detached: true, windowsHide: false })
    )
  })

  it.skipIf(process.platform !== 'win32')('encaminha um wrapper code.cmd pelo CMD sem duplicar as aspas', async () => {
    const wrapper = path.join(temporaryUserData, 'code.cmd')
    await fs.writeFile(
      path.join(temporaryUserData, 'config.json'),
      JSON.stringify({ customPaths: { vscode: wrapper } })
    )
    await fs.writeFile(wrapper, '@echo off')
    mockVisibleSpawn()

    const result = await launchTool('vscode', projectPath)

    expect(result).toMatchObject({ success: true })
    expect(spawnMock).toHaveBeenCalledWith(
      process.env.ComSpec || 'cmd.exe',
      expect.arrayContaining([
        '/d',
        '/s',
        '/c',
        expect.stringContaining(wrapper),
        expect.stringContaining(projectPath),
      ]),
      expect.objectContaining({ detached: true, windowsHide: false, windowsVerbatimArguments: true })
    )
  })

  it.skipIf(process.platform !== 'win32')('preserva o caminho do Antigravity ao abrir a sessÃ£o CMD', async () => {
    const directory = await fs.mkdtemp(path.join(temporaryUserData, 'agy space & '))
    const executable = path.join(directory, 'agy.exe')
    await fs.writeFile(executable, 'fixture')
    await fs.writeFile(
      path.join(temporaryUserData, 'config.json'),
      JSON.stringify({ customPaths: { agy: executable, wt: 'wt.exe' } })
    )
    mockVisibleSpawn()

    const result = await launchTool('agy', projectPath)

    expect(result).toMatchObject({ success: true })
    expect(spawnMock).toHaveBeenCalledWith(
      'wt.exe',
      expect.arrayContaining([
        'cmd.exe',
        '/d',
        '/k',
        expect.stringContaining(`"${executable}"`),
      ]),
      expect.objectContaining({ detached: true, windowsHide: false, windowsVerbatimArguments: true })
    )
  })

  it.skipIf(process.platform !== 'win32')('recusa um wrapper com expansÃ£o de variÃ¡vel do CMD', async () => {
    const wrapper = path.join(temporaryUserData, 'code%PATH%.cmd')
    await fs.writeFile(wrapper, '@echo off')
    await fs.writeFile(
      path.join(temporaryUserData, 'config.json'),
      JSON.stringify({ customPaths: { vscode: wrapper } })
    )
    mockVisibleSpawn()

    const result = await launchTool('vscode', projectPath)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Caminhos com % ou !')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('exige conta explícita no codex-cli e nunca assume account1', async () => {
    mockVisibleSpawn()

    const result = await launchTool('codex-cli', projectPath)

    expect(result).toMatchObject({ success: false, fallback: false })
    expect(result.account).toBeUndefined()
    expect(result.message).toContain('conta Codex')
    expect(result.needsAuth).toBeUndefined()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('ignora um caminho antigo do Brave quando encontra a instalação padrão atual', async () => {
    const previousProgramFiles = process.env.ProgramFiles
    const defaultBrowser = path.join(
      temporaryUserData,
      'BraveSoftware',
      'Brave-Browser',
      'Application',
      'brave.exe'
    )
    process.env.ProgramFiles = temporaryUserData
    await fs.mkdir(path.dirname(defaultBrowser), { recursive: true })
    await fs.writeFile(defaultBrowser, 'fixture')
    await fs.writeFile(
      path.join(temporaryUserData, 'config.json'),
      JSON.stringify({ customPaths: { brave: path.join(temporaryUserData, 'old-brave.exe') } })
    )
    mockVisibleSpawn()

    try {
      const result = await launchTool('brave', projectPath)

      expect(result).toMatchObject({ success: true })
      expect(spawnMock).toHaveBeenCalledWith(
        defaultBrowser,
        expect.any(Array),
        expect.objectContaining({ detached: true, windowsHide: false })
      )
    } finally {
      if (previousProgramFiles === undefined) delete process.env.ProgramFiles
      else process.env.ProgramFiles = previousProgramFiles
    }
  })
})
