import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}))

import { generateMemoryFromGit, getProjectMemory } from '../src/main/memory'

let projectPath = ''
let gitStatus = '## main\n'
let memoryWritten = false

beforeEach(async () => {
  projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-memory-'))
  await fs.mkdir(path.join(projectPath, '.git'))
  gitStatus = '## main\n'
  memoryWritten = false
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
  await fs.rm(projectPath, { recursive: true, force: true })
})

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
