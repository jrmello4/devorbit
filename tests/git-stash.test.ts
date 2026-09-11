import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}))

import { stashSwitchGitBranch, stashSyncGit } from '../src/main/git'

let repoPath = ''
let popShouldFail = false
let statusOutputs: string[] = []

function mockSequence() {
  execFileMock.mockImplementation(
    (
      command: string,
      args: string[],
      options: Record<string, unknown>,
      callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      if (command === 'git' && args[0] === 'status') {
        callback(null, { stdout: statusOutputs.shift() ?? '', stderr: '' })
        return
      }
      if (command === 'git' && args[0] === 'stash' && args[1] === 'pop' && popShouldFail) {
        callback(Object.assign(new Error('conflict'), { stderr: 'CONFLICT (content): Merge conflict' }), { stdout: '', stderr: '' })
        return
      }
      if (command === 'git' && args[0] === 'pull') {
        callback(null, { stdout: 'Already up to date.\n', stderr: '' })
        return
      }
      if (command === 'git' && (args[0] === 'stash' || args[0] === 'switch')) {
        callback(null, { stdout: 'ok', stderr: '' })
        return
      }
      if (command === 'git' && args[0] === 'for-each-ref') {
        callback(null, { stdout: 'main\0*\0\0abc1234\n', stderr: '' })
        return
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    }
  )
}

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-stash-'))
  await fs.mkdir(path.join(repoPath, '.git'))
  popShouldFail = false
  statusOutputs = []
  execFileMock.mockReset()
  mockSequence()
})

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true })
})

describe('stashSyncGit', () => {
  it('faz pull direto quando a árvore está limpa', async () => {
    statusOutputs = ['', '']
    const result = await stashSyncGit(repoPath)
    expect(result.success).toBe(true)
    const stashCalls = execFileMock.mock.calls.filter((call) => (call[1] as string[])[0] === 'stash')
    expect(stashCalls).toHaveLength(0)
  })

  it('guarda stash, puxa e restaura quando há alterações', async () => {
    statusOutputs = [' M file.txt\n', '']
    const result = await stashSyncGit(repoPath)
    expect(result.success).toBe(true)
    expect(result.message).toMatch(/restauradas do stash/)
    const sequence = execFileMock.mock.calls.map((call) => (call[1] as string[]).slice(0, 2).join(' '))
    expect(sequence).toEqual(['status --porcelain=v1', 'stash push', 'status --porcelain=v1', 'pull --ff-only', 'stash pop'])
  })

  it('mantém o stash e avisa quando o pop conflita', async () => {
    statusOutputs = [' M file.txt\n', '']
    popShouldFail = true
    const result = await stashSyncGit(repoPath)
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/stash "devorbit"/)
  })

  it('recusa pasta sem git', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-plain-'))
    try {
      const result = await stashSyncGit(plain)
      expect(result.success).toBe(false)
    } finally {
      await fs.rm(plain, { recursive: true, force: true })
    }
  })
})

describe('stashSwitchGitBranch', () => {
  it('troca direto quando a árvore está limpa', async () => {
    statusOutputs = ['']
    const result = await stashSwitchGitBranch(repoPath, 'main')
    expect(result.success).toBe(true)
  })
})
