import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}))

import { getGitBranches, switchGitBranch } from '../src/main/git'

let repoPath = ''
let calls: Array<{ args: string[] }> = []

function respondWithGitOutput(outputFor: (args: string[]) => { stdout?: string; stderr?: string }) {
  execFileMock.mockImplementation(
    (
      _command: string,
      args: string[],
      _options: Record<string, unknown>,
      callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      calls.push({ args })
      const result = outputFor(args)
      callback(null, { stdout: result.stdout ?? '', stderr: result.stderr ?? '' })
    }
  )
}

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-branches-'))
  await fs.mkdir(path.join(repoPath, '.git'))
  calls = []
  execFileMock.mockReset()
})

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true })
})

describe('Git branch management', () => {
  it('lists current, local and remote branches without exposing the symbolic HEAD ref', async () => {
    respondWithGitOutput((args) => {
      if (args[0] !== 'for-each-ref') throw new Error(`unexpected command: ${args.join(' ')}`)
      if (args.includes('refs/heads')) {
        return { stdout: 'main\0*\0origin/main\0abc1234\nfeature/ui\0\0\0def5678\n' }
      }
      return { stdout: 'origin/HEAD\0\0\0abc1234\norigin/main\0\0\0abc1234\norigin/feature/ui\0\0\0def5678\n' }
    })

    const branches = await getGitBranches(repoPath)

    expect(branches).toEqual([
      { name: 'main', isCurrent: true, isRemote: false, upstream: 'origin/main', commit: 'abc1234' },
      { name: 'feature/ui', isCurrent: false, isRemote: false, commit: 'def5678' },
      { name: 'origin/feature/ui', isCurrent: false, isRemote: true, commit: 'def5678' },
      { name: 'origin/main', isCurrent: false, isRemote: true, commit: 'abc1234' },
    ])
  })

  it('refuses to switch when the working tree is dirty', async () => {
    respondWithGitOutput((args) => {
      if (args[0] === 'status') return { stdout: ' M src/App.tsx\n' }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    })

    const result = await switchGitBranch(repoPath, 'main')

    expect(result.success).toBe(false)
    expect(result.message).toContain('Troca recusada')
    expect(calls).toHaveLength(1)
  })

  it('switches an existing local branch with no-guess semantics', async () => {
    respondWithGitOutput((args) => {
      if (args[0] === 'status') return { stdout: '' }
      if (args[0] === 'for-each-ref' && args.includes('refs/heads')) {
        return { stdout: 'feature/ui\0*\0origin/feature/ui\0abc1234\nmain\0\0origin/main\0def5678\n' }
      }
      if (args[0] === 'for-each-ref') return { stdout: 'origin/main\0\0\0def5678\n' }
      if (args[0] === 'switch') return { stdout: "Switched to branch 'main'\n" }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    })

    const result = await switchGitBranch(repoPath, 'main')

    expect(result.success).toBe(true)
    expect(result.message).toContain('main')
    expect(calls.map(({ args }) => args)).toContainEqual(['switch', '--no-guess', 'main'])
  })

  it('creates a local tracking branch when only the remote branch exists', async () => {
    respondWithGitOutput((args) => {
      if (args[0] === 'status') return { stdout: '' }
      if (args[0] === 'for-each-ref' && args.includes('refs/heads')) return { stdout: '' }
      if (args[0] === 'for-each-ref') return { stdout: 'origin/main\0\0\0def5678\n' }
      if (args[0] === 'switch') return { stdout: "branch 'main' set up to track 'origin/main'\n" }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    })

    const result = await switchGitBranch(repoPath, 'main')

    expect(result.success).toBe(true)
    expect(result.message).toContain('acompanhando origin/main')
    expect(calls.map(({ args }) => args)).toContainEqual(['switch', '--track', '-c', 'main', 'origin/main'])
  })

  it('validates a branch name before invoking Git', async () => {
    await expect(switchGitBranch(repoPath, 'main && whoami')).rejects.toThrow('Nome de branch inválido')
    expect(calls).toHaveLength(0)
  })
})
