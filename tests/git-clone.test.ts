import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}))

import { cloneGitRepository } from '../src/main/git'
import { validateCloneInput, validateFolderName } from '../src/main/validation'

let parentDir = ''

beforeEach(async () => {
  parentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-clone-'))
  execFileMock.mockReset()
})

afterEach(async () => {
  await fs.rm(parentDir, { recursive: true, force: true })
})

function mockCloneSuccess() {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout: '', stderr: 'Cloning into...' })
  })
}

describe('validateFolderName', () => {
  it('aceita nome simples', () => {
    expect(validateFolderName('meu-projeto')).toBe('meu-projeto')
  })
  it('recusa traversal', () => {
    expect(() => validateFolderName('../x')).toThrow()
    expect(() => validateFolderName('a/b')).toThrow()
    expect(() => validateFolderName('.git')).toThrow()
  })
})

describe('validateCloneInput', () => {
  it('recusa URL sem https', () => {
    expect(() => validateCloneInput({ parentDir, folderName: 'x', remoteUrl: 'http://github.com/a/b.git' })).toThrow()
  })
})

describe('cloneGitRepository', () => {
  it('clona para pasta nova', async () => {
    mockCloneSuccess()
    const result = await cloneGitRepository({ parentDir, folderName: 'novo', remoteUrl: 'https://github.com/a/b.git' })
    expect(result.success).toBe(true)
    expect(result.path).toBe(path.join(await fs.realpath(parentDir), 'novo'))
    expect(execFileMock).toHaveBeenCalledOnce()
  })

  it('recusa pasta existente com arquivos', async () => {
    await fs.mkdir(path.join(parentDir, 'cheia'))
    await fs.writeFile(path.join(parentDir, 'cheia', 'a.txt'), 'x')
    const result = await cloneGitRepository({ parentDir, folderName: 'cheia', remoteUrl: 'https://github.com/a/b.git' })
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/não está vazia/)
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('recusa destino que já é repo', async () => {
    await fs.mkdir(path.join(parentDir, 'repo', '.git'), { recursive: true })
    const result = await cloneGitRepository({ parentDir, folderName: 'repo', remoteUrl: 'https://github.com/a/b.git' })
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Use Pull/)
  })
})
