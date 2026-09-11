import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}))

import { syncGit } from '../src/main/git'

interface ExecCall {
  command: string
  args: string[]
  options: Record<string, unknown>
}

let repoPath = ''
let calls: ExecCall[] = []

function respondWithGitOutput(outputFor: (command: string, args: string[]) => { stdout?: string; stderr?: string }) {
  execFileMock.mockImplementation(
    (
      command: string,
      args: string[],
      options: Record<string, unknown>,
      callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      calls.push({ command, args, options })
      const result = outputFor(command, args)
      callback(null, { stdout: result.stdout ?? '', stderr: result.stderr ?? '' })
    }
  )
}

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-git-'))
  await fs.mkdir(path.join(repoPath, '.git'))
  calls = []
  execFileMock.mockReset()
})

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true })
})

describe('syncGit safety gates', () => {
  it('refuses to pull when the working tree is dirty', async () => {
    respondWithGitOutput((command, args) => {
      if (command === 'git' && args[0] === 'status') {
        return { stdout: ' M src/main/index.ts\n?? scratch.txt\n' }
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    })

    const result = await syncGit(repoPath)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Sincronização recusada')
    expect(result.output).toContain('scratch.txt')
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual(['status', '--porcelain=v1'])
  })

  it('uses fast-forward-only pull when the working tree is clean', async () => {
    respondWithGitOutput((command, args) => {
      if (command === 'git' && args[0] === 'status') return { stdout: '' }
      if (command === 'git' && args[0] === 'pull') {
        return { stdout: 'Already up to date.\n' }
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    })

    const result = await syncGit(repoPath)

    expect(result.success).toBe(true)
    expect(result.message).toContain('versão mais recente')
    expect(calls.map((call) => call.args)).toEqual([
      ['status', '--porcelain=v1'],
      ['pull', '--ff-only'],
    ])
  })
})
