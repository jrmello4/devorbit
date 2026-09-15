import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}))

import { generateMemoryFromGit, getProjectMemory, saveProjectMemory } from '../src/main/memory'

let projectPath = ''
let gitStatus = '## main\n'
let memoryWritten = false
const externalPaths: string[] = []

beforeEach(async () => {
  projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-memory-'))
  await fs.mkdir(path.join(projectPath, '.git'))
  gitStatus = '## main\n'
  memoryWritten = false
  externalPaths.length = 0
  execFileMock.mockReset()
  execFileMock.mockImplementation(
    (
      command: string,
      args: string[],
      _options: Record<string, unknown>,
      callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      if (command !== 'git') {
        callback(new Error(`unexpected command: ${command}`))
        return
      }

      if (args[0] === 'rev-parse') {
        callback(null, { stdout: 'abc123\n', stderr: '' })
      } else if (args[0] === 'status' && args.includes('--short')) {
        callback(null, { stdout: gitStatus.replace(/^## main\n/, ' M src/main/index.ts\n'), stderr: '' })
      } else if (args[0] === 'status') {
        const includesMemory = memoryWritten && !args.includes(':(exclude).devorbit/memory.md')
        callback(null, {
          stdout: `${gitStatus}${includesMemory ? '?? .devorbit/memory.md\n' : ''}`,
          stderr: '',
        })
      } else if (args[0] === 'log') {
        callback(null, { stdout: 'abc123 Add feature\n', stderr: '' })
      } else {
        callback(new Error(`unexpected git args: ${args.join(' ')}`))
      }
    }
  )
})

afterEach(async () => {
  await Promise.all([
    fs.rm(projectPath, { recursive: true, force: true }),
    ...externalPaths.map((externalPath) => fs.rm(externalPath, { recursive: true, force: true })),
  ])
})

async function createLink(
  target: string,
  linkPath: string,
  type: 'dir' | 'file' | 'junction'
): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, type)
    return true
  } catch (err: any) {
    if (process.platform === 'win32' && ['EACCES', 'EPERM'].includes(err?.code)) return false
    throw err
  }
}

describe('generated memory metadata', () => {
  it('marks a generated snapshot stale after the Git status changes', async () => {
    const generated = await generateMemoryFromGit(projectPath)
    const memoryPath = path.join(projectPath, '.devorbit', 'memory.md')
    await fs.mkdir(path.dirname(memoryPath), { recursive: true })
    await fs.writeFile(memoryPath, generated, 'utf-8')
    memoryWritten = true

    const current = await getProjectMemory(projectPath)
    expect(current.exists).toBe(true)
    expect(current.stale).toBe(false)
    expect(current.sourceCommit).toBe('abc123')
    expect(current.generatedAt).toEqual(expect.any(String))

    gitStatus = '## main\n M changed.ts\n'
    const changed = await getProjectMemory(projectPath)
    expect(changed.stale).toBe(true)
  })
})

describe('memory persistence safety', () => {
  it('serializes concurrent saves and leaves no temporary files', async () => {
    const contents = Array.from({ length: 12 }, (_, index) => `concurrent save ${index}`)
    const results = await Promise.all(contents.map((content) => saveProjectMemory(projectPath, content)))

    expect(results.every((result) => result.success)).toBe(true)
    const memoryDir = path.join(projectPath, '.devorbit')
    const saved = await fs.readFile(path.join(memoryDir, 'memory.md'), 'utf-8')
    expect(contents).toContain(saved)
    expect((await fs.readdir(memoryDir)).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  it('cleans up the temporary file when the final rename fails', async () => {
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('forced rename failure'))

    try {
      const result = await saveProjectMemory(projectPath, 'should not persist')

      expect(result.success).toBe(false)
      const memoryDir = path.join(projectPath, '.devorbit')
      expect((await fs.readdir(memoryDir)).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
      await expect(fs.access(path.join(memoryDir, 'memory.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      rename.mockRestore()
    }
  })

  it('rejects a symlinked or junction .devorbit directory', async (context) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-memory-outside-'))
    externalPaths.push(outside)
    const outsideMemory = path.join(outside, 'memory.md')
    await fs.writeFile(outsideMemory, 'outside project memory', 'utf-8')

    const memoryDir = path.join(projectPath, '.devorbit')
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    if (!(await createLink(outside, memoryDir, linkType))) return context.skip()

    const loaded = await getProjectMemory(projectPath)
    expect(loaded.exists).toBe(false)
    expect(loaded.content).not.toContain('outside project memory')

    const saved = await saveProjectMemory(projectPath, 'must be rejected')
    expect(saved.success).toBe(false)
    expect(await fs.readFile(outsideMemory, 'utf-8')).toBe('outside project memory')
  })

  it('rejects a symlinked memory file', async (context) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-memory-file-outside-'))
    externalPaths.push(outside)
    const outsideMemory = path.join(outside, 'memory.md')
    await fs.writeFile(outsideMemory, 'outside file memory', 'utf-8')

    const memoryDir = path.join(projectPath, '.devorbit')
    await fs.mkdir(memoryDir)
    if (!(await createLink(outsideMemory, path.join(memoryDir, 'memory.md'), 'file'))) return context.skip()

    const loaded = await getProjectMemory(projectPath)
    expect(loaded.exists).toBe(false)
    expect(loaded.content).not.toContain('outside file memory')

    const saved = await saveProjectMemory(projectPath, 'must be rejected')
    expect(saved.success).toBe(false)
    expect(await fs.readFile(outsideMemory, 'utf-8')).toBe('outside file memory')
  })
})
