import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}))

import { getGitInitPreview, initGitRepository } from '../src/main/git-init'

interface ExecCall {
  command: string
  args: string[]
}

let projectPath = ''
let calls: ExecCall[] = []

function respondWithGitOutput(outputFor: (args: string[]) => { stdout?: string; stderr?: string }) {
  execFileMock.mockImplementation(
    (
      command: string,
      args: string[],
      _options: Record<string, unknown>,
      callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      calls.push({ command, args })
      const result = outputFor(args)
      callback(null, { stdout: result.stdout ?? '', stderr: result.stderr ?? '' })
    }
  )
}

beforeEach(async () => {
  projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-git-init-'))
  await fs.writeFile(path.join(projectPath, 'README.md'), '# projeto\n')
  calls = []
  execFileMock.mockReset()
})

afterEach(async () => {
  await fs.rm(projectPath, { recursive: true, force: true })
})

describe('git initialization safety flow', () => {
  it('previews and initializes a directory with no repository', async () => {
    respondWithGitOutput((args) => {
      if (args[0] === 'init') return { stdout: 'Initialized empty Git repository' }
      if (args[0] === 'status') return { stdout: '?? README.md\n' }
      throw new Error(`unexpected git ${args.join(' ')}`)
    })

    const preview = await getGitInitPreview(projectPath)
    expect(preview.canInitialize).toBe(true)
    expect(preview.fileCount).toBe(1)
    expect(preview.files).toContain('README.md')
    expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/)

    const result = await initGitRepository(projectPath)
    expect(result.success).toBe(true)
    expect(result.initialized).toBe(true)
    expect(result.commitCreated).toBe(false)
    expect(calls.map((call) => call.args)).toEqual([
      ['init', '--initial-branch', 'main'],
      ['status', '--short', '--untracked-files=all'],
    ])
  })

  it('never overwrites an existing repository', async () => {
    await fs.mkdir(path.join(projectPath, '.git'))

    const result = await initGitRepository(projectPath)

    expect(result.success).toBe(false)
    expect(result.initialized).toBe(false)
    expect(result.message).toContain('já possui um repositório Git')
    expect(calls).toHaveLength(0)
  })

  it('rejects non-HTTPS remote URLs before spawning Git', async () => {
    await expect(initGitRepository(projectPath, { remoteUrl: 'http://github.com/user/repo.git' })).rejects.toThrow(
      'HTTPS'
    )
    expect(calls).toHaveLength(0)
  })

  it('rejects shell-like branch names before spawning Git', async () => {
    await expect(initGitRepository(projectPath, { branch: 'main && whoami' })).rejects.toThrow(
      'Nome de branch inválido'
    )
    expect(calls).toHaveLength(0)
  })

  it('requires explicit confirmation before staging all files', async () => {
    const result = await initGitRepository(projectPath, { initialCommit: true })

    expect(result.success).toBe(false)
    expect(result.message).toContain('Confirme a pré-visualização')
    expect(calls).toHaveLength(0)
  })

  it('keeps the local commit when a non-fast-forward push is rejected', async () => {
    execFileMock.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
      ) => {
        calls.push({ command: 'git', args })
        if (args[0] === 'push') {
          callback(Object.assign(new Error('rejected'), { stderr: '! [rejected] main -> main (fetch first)' }))
          return
        }
        callback(null, { stdout: args[0] === 'status' ? '?? README.md\n' : '', stderr: '' })
      }
    )

    const result = await initGitRepository(projectPath, {
      remoteUrl: 'https://github.com/user/repo.git',
      initialCommit: true,
      commitMessage: 'chore: first commit',
      push: true,
      confirmAllFiles: true,
      previewFingerprint: (await getGitInitPreview(projectPath)).fingerprint,
    })

    expect(result.success).toBe(false)
    expect(result.initialized).toBe(true)
    expect(result.commitCreated).toBe(true)
    expect(result.pushed).toBe(false)
    expect(result.message).toContain('remote já possui histórico')
    expect(calls.map((call) => call.args)).toEqual([
      ['ls-remote', '--refs', 'https://github.com/user/repo.git'],
      ['init', '--initial-branch', 'main'],
      ['status', '--short', '--untracked-files=all'],
      ['remote', 'add', 'origin', 'https://github.com/user/repo.git'],
      ['add', '-A'],
      ['status', '--short'],
      ['commit', '-m', 'chore: first commit'],
      ['push', '--set-upstream', 'origin', 'main'],
    ])
    expect(calls.flatMap((call) => call.args)).not.toContain('--force')
  })

  it('refuses a remote that already has refs, even on another branch', async () => {
    respondWithGitOutput((args) => {
      if (args[0] === 'ls-remote') return { stdout: 'abc123\trefs/heads/master\n' }
      throw new Error(`unexpected git ${args.join(' ')}`)
    })

    const preview = await getGitInitPreview(projectPath)
    const result = await initGitRepository(projectPath, {
      remoteUrl: 'https://github.com/user/repo.git',
      initialCommit: true,
      push: true,
      confirmAllFiles: true,
      previewFingerprint: preview.fingerprint,
    })

    expect(result.success).toBe(false)
    expect(result.initialized).toBe(false)
    expect(result.message).toContain('remote já possui histórico')
    expect(calls).toEqual([
      { command: 'git', args: ['ls-remote', '--refs', 'https://github.com/user/repo.git'] },
    ])
  })

  it('invalidates a stale preview before staging files', async () => {
    respondWithGitOutput((args) => {
      if (args[0] === 'init') return { stdout: 'Initialized empty Git repository' }
      if (args[0] === 'status') return { stdout: '?? README.md\n?? NEW.txt\n' }
      throw new Error(`unexpected git ${args.join(' ')}`)
    })

    const preview = await getGitInitPreview(projectPath)
    await fs.writeFile(path.join(projectPath, 'NEW.txt'), 'added after preview\n')
    const result = await initGitRepository(projectPath, {
      initialCommit: true,
      confirmAllFiles: true,
      previewFingerprint: preview.fingerprint,
    })

    expect(result.success).toBe(false)
    expect(result.initialized).toBe(false)
    expect(result.commitCreated).toBe(false)
    expect(result.message).toContain('mudaram')
    expect(calls).toHaveLength(0)
  })

  it('reports that git was not initialized when git init itself fails', async () => {
    execFileMock.mockImplementation(
      (
        command: string,
        args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
      ) => {
        calls.push({ command, args })
        callback(Object.assign(new Error('git init failed'), { stderr: 'fatal: permission denied' }))
      }
    )

    const result = await initGitRepository(projectPath)

    expect(result.success).toBe(false)
    expect(result.initialized).toBe(false)
    expect(result.message).toContain('Não foi possível criar o repositório')
  })

  it('blocks a commit when the preview is truncated', async () => {
    await Promise.all(
      Array.from({ length: 501 }, (_, index) =>
        fs.writeFile(path.join(projectPath, `file-${index}.txt`), String(index))
      )
    )

    respondWithGitOutput(() => {
      throw new Error('git should not be called for an incomplete preview')
    })

    const preview = await getGitInitPreview(projectPath)
    expect(preview.truncated).toBe(true)
    const result = await initGitRepository(projectPath, {
      initialCommit: true,
      confirmAllFiles: true,
      previewFingerprint: preview.fingerprint,
    })

    expect(result.success).toBe(false)
    expect(result.initialized).toBe(false)
    expect(result.message).toContain('prévia está incompleta')
    expect(calls).toHaveLength(0)
  }, 15_000)

  it('keeps the initialized state visible when the first commit fails', async () => {
    execFileMock.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
      ) => {
        calls.push({ command: 'git', args })
        if (args[0] === 'commit') {
          callback(Object.assign(new Error('identity unknown'), { stderr: 'Author identity unknown' }))
          return
        }
        callback(null, { stdout: args[0] === 'status' ? '?? README.md\n' : '', stderr: '' })
      }
    )

    const preview = await getGitInitPreview(projectPath)
    const result = await initGitRepository(projectPath, {
      initialCommit: true,
      confirmAllFiles: true,
      previewFingerprint: preview.fingerprint,
    })

    expect(result.success).toBe(false)
    expect(result.initialized).toBe(true)
    expect(result.commitCreated).toBe(false)
    expect(result.message).toContain('Repositório criado')
    expect(result.preview.isRepository).toBe(true)
    expect(result.preview.canInitialize).toBe(false)
  })
})
