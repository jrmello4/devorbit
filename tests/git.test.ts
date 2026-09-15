import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}))

import { getGitBranches, getGitChanges, getGitStatus, pushGit, syncGit } from '../src/main/git'

interface ExecCall {
  command: string
  args: string[]
  options: Record<string, unknown>
}

let repoPath = ''
let aliasParent = ''
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
  aliasParent = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-git-alias-'))
  await fs.mkdir(path.join(repoPath, '.git'))
  calls = []
  execFileMock.mockReset()
})

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true })
  await fs.rm(aliasParent, { recursive: true, force: true })
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

describe('pushGit selection safety', () => {
  it('stages only the explicitly selected currently listed paths', async () => {
    respondWithGitOutput((command, args) => {
      if (command !== 'git') throw new Error(`unexpected command: ${command}`)
      if (args[0] === 'status') return { stdout: ' M src/main/git.ts\0?? notes.txt\0' }
      if (args[0] === 'add') return {}
      if (args[0] === 'commit') return {}
      if (args[0] === 'push') return { stderr: 'Everything up-to-date\n' }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    })

    const result = await pushGit(repoPath, 'select one file', {
      selectedPaths: ['src/main/git.ts'],
    })

    expect(result.success).toBe(true)
    expect(calls.map((call) => call.args)).toEqual([
      ['status', '--porcelain=v1', '-z'],
      ['add', '--', 'src/main/git.ts'],
      ['commit', '-m', 'select one file'],
      ['push'],
    ])
  })

  it('fails closed when the commit selection is missing or empty', async () => {
    for (const options of [undefined, { selectedPaths: [] }]) {
      calls = []

      const result = await pushGit(repoPath, 'requires selection', options)

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/selecione|selecion/i)
      expect(calls).toHaveLength(0)
    }
  })

  it('fails closed when a selected path is no longer listed by Git', async () => {
    respondWithGitOutput((command, args) => {
      if (command === 'git' && args[0] === 'status') return { stdout: ' M current.ts\0' }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    })

    const result = await pushGit(repoPath, 'stale selection', {
      selectedPaths: ['missing.ts'],
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('não estão mais listados')
    expect(calls.map((call) => call.args)).toEqual([
      ['status', '--porcelain=v1', '-z'],
    ])
  })

  it('refuses staged changes outside the selected status entries', async () => {
    respondWithGitOutput((command, args) => {
      if (command === 'git' && args[0] === 'status') {
        return { stdout: 'M  selected.ts\0A  unrelated.ts\0' }
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    })

    const result = await pushGit(repoPath, 'keep scope narrow', {
      selectedPaths: ['selected.ts'],
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('preparadas fora')
    expect(result.output).toContain('unrelated.ts')
    expect(calls.map((call) => call.args)).toEqual([
      ['status', '--porcelain=v1', '-z'],
    ])
  })

  it('rejects unsafe pathspecs before invoking Git', async () => {
    const result = await pushGit(repoPath, 'unsafe selection', {
      selectedPaths: ['../outside'],
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/selecione|selecion/i)
    expect(calls).toHaveLength(0)
  })

  it('parses NUL-delimited paths without losing spaces or rename pairs', async () => {
    respondWithGitOutput((command, args) => {
      if (command === 'git' && args[0] === 'status') {
        return { stdout: ' M folder/file with spaces.ts\0R  renamed.ts\0original.ts\0' }
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    })

    const changes = await getGitChanges(repoPath)

    expect(changes).toEqual([
      { path: 'folder/file with spaces.ts', status: ' M' },
      { path: 'renamed.ts', status: 'R ', stagingPaths: ['renamed.ts', 'original.ts'] },
    ])
    expect(calls[0].args).toEqual(['status', '--porcelain=v1', '-z'])
  })
})

describe('Git mutation serialization', () => {
  it('serializes a refreshed status fetch behind an in-flight push', async () => {
    const events: string[] = []
    let releasePush!: () => void
    let pushStarted!: () => void
    const pushRelease = new Promise<void>((resolve) => { releasePush = resolve })
    const pushStartedPromise = new Promise<void>((resolve) => { pushStarted = resolve })

    execFileMock.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
      ) => {
        const operation = args[0]
        events.push(`${operation}:start`)
        if (operation === 'push') {
          pushStarted()
          void pushRelease.then(() => {
            events.push('push:end')
            callback(null, { stdout: '', stderr: '' })
          })
          return
        }
        if (operation === 'status') {
          callback(null, { stdout: '## main\n', stderr: '' })
          return
        }
        if (operation === 'fetch') {
          events.push('fetch:end')
          callback(null, { stdout: '', stderr: '' })
          return
        }
        if (operation === 'add' || operation === 'commit') {
          callback(null, { stdout: '', stderr: '' })
          return
        }
        throw new Error(`unexpected command: ${args.join(' ')}`)
      }
    )

    const pushPromise = pushGit(repoPath)
    await pushStartedPromise
    const statusPromise = getGitStatus(repoPath, true)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(events).not.toContain('fetch:start')
    releasePush()

    await expect(pushPromise).resolves.toMatchObject({ success: true })
    await expect(statusPromise).resolves.toMatchObject({ isRepo: true, branch: 'main' })
    expect(events).not.toContain('add:start')
    expect(events).not.toContain('commit:start')
    expect(events.indexOf('push:end')).toBeLessThan(events.indexOf('fetch:start'))
  })

  it.skipIf(process.platform !== 'win32')('shares the lock with a junction alias on branch refresh', async () => {
    const aliasPath = path.join(aliasParent, 'repo-alias')
    await fs.symlink(repoPath, aliasPath, 'junction')

    const events: string[] = []
    let releasePush!: () => void
    let pushStarted!: () => void
    const pushRelease = new Promise<void>((resolve) => { releasePush = resolve })
    const pushStartedPromise = new Promise<void>((resolve) => { pushStarted = resolve })

    execFileMock.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
      ) => {
        const operation = args[0]
        events.push(`${operation}:start`)
        if (operation === 'push') {
          pushStarted()
          void pushRelease.then(() => {
            events.push('push:end')
            callback(null, { stdout: '', stderr: '' })
          })
          return
        }
        if (operation === 'fetch') {
          events.push('fetch:end')
          callback(null, { stdout: '', stderr: '' })
          return
        }
        if (operation === 'for-each-ref') {
          callback(null, {
            stdout: args.includes('refs/heads') ? 'main\0*\0\0abc1234\n' : '',
            stderr: '',
          })
          return
        }
        throw new Error(`unexpected command: ${args.join(' ')}`)
      }
    )

    const pushPromise = pushGit(repoPath)
    await pushStartedPromise
    const branchesPromise = getGitBranches(aliasPath, true)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(events).not.toContain('fetch:start')
    releasePush()

    await expect(pushPromise).resolves.toMatchObject({ success: true })
    await expect(branchesPromise).resolves.toEqual([
      { name: 'main', isCurrent: true, isRemote: false, commit: 'abc1234' },
    ])
    expect(events.indexOf('push:end')).toBeLessThan(events.indexOf('fetch:start'))
  })
})
