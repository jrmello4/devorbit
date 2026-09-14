import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}))

import { finalizeGitProject } from '../src/main/git'

let repoPath = ''

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-finalize-'))
  await fs.mkdir(path.join(repoPath, '.git'))
  await fs.writeFile(path.join(repoPath, 'sentinel.txt'), 'keep')
  execFileMock.mockReset()
})

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true })
})

function reply(stdout = '', error: Error | null = null) {
  execFileMock.mockImplementationOnce((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
    callback(error, { stdout, stderr: '' })
  })
}

describe('finalizeGitProject safety checks', () => {
  it('keeps ignored files instead of deleting the working tree', async () => {
    reply('')
    reply('!! .env\n')

    const result = await finalizeGitProject(repoPath, { allowRecreatableIgnored: true })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/ignorados importantes/i)
    await expect(fs.access(path.join(repoPath, 'sentinel.txt'))).resolves.toBeUndefined()
  })

  it('requires explicit approval before removing recreatable ignored directories', async () => {
    reply('')
    reply('!! node_modules/\n')

    const result = await finalizeGitProject(repoPath)

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/confirme explicitamente/i)
    await expect(fs.access(path.join(repoPath, 'sentinel.txt'))).resolves.toBeUndefined()
  })

  it('fails closed when the current branch has no upstream', async () => {
    reply('')
    reply('')
    reply('')
    reply('https://github.com/example/repo.git')
    reply('')
    reply('main')
    reply('', new Error('no upstream'))

    const result = await finalizeGitProject(repoPath)

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/branch atual/i)
    await expect(fs.access(path.join(repoPath, 'sentinel.txt'))).resolves.toBeUndefined()
  })

  it('rechecks tracked changes immediately before deleting', async () => {
    reply('')
    reply('')
    reply('')
    reply('https://github.com/example/repo.git')
    reply('')
    reply('main')
    reply('origin/main')
    reply('0\t0')
    reply('main')
    reply('origin/main')
    reply('0\t0')
    reply('')
    reply('')
    reply(' M file.txt')

    const result = await finalizeGitProject(repoPath)

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/alterações locais apareceram/i)
    await expect(fs.access(path.join(repoPath, 'sentinel.txt'))).resolves.toBeUndefined()
  })
})
