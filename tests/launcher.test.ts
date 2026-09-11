import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const clipboardWrite = vi.hoisted(() => vi.fn())
const userDataPath = vi.hoisted(() => ({ value: '' }))
const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  default: {
    clipboard: { writeText: clipboardWrite },
    shell: { openPath: vi.fn(async () => '') },
    app: { getPath: () => userDataPath.value },
  },
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: vi.fn(),
}))

import { copyProjectContext } from '../src/main/launcher'

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

beforeEach(async () => {
  temporaryUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-launcher-user-'))
  userDataPath.value = temporaryUserData
  projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-launcher-proj-'))
  clipboardWrite.mockReset()
  execFileMock.mockReset()
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
