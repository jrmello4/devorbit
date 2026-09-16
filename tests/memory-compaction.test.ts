import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  activeCompactionCount,
  cancelAllMemoryCompactions,
  cancelMemoryCompaction,
  compactMemoryContent,
  compactProjectMemory,
  needsCompaction,
  scheduleMemoryCompaction,
  syncMemorySchedulers,
} from '../src/main/memory'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

async function makeProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-compact-'))
  temporaryDirectories.push(root)
  await fs.mkdir(path.join(root, '.devorbit'), { recursive: true })
  return root
}

describe('needsCompaction', () => {
  it('ignores healthy content', () => {
    expect(needsCompaction('# Title\n\n- item one\n- item two\n')).toBe(false)
    expect(needsCompaction('')).toBe(false)
    expect(needsCompaction(undefined)).toBe(false)
  })

  it('flags repeated blank lines, duplicate bullets and oversize files', () => {
    expect(needsCompaction('a\n\n\nb')).toBe(true)
    expect(needsCompaction('- same\n- same\n')).toBe(true)
    expect(needsCompaction('x'.repeat(12_001))).toBe(true)
  })
})

describe('compactMemoryContent', () => {
  it('preserves headers and first occurrences in order', () => {
    const { content, report } = compactMemoryContent(
      '# Handoff\n\n\n- passo um\n- passo um\n- passo dois\n'
    )
    expect(report.compacted).toBe(true)
    expect(report.removedLines).toBe(2)
    expect(content).toBe('# Handoff\n\n- passo um\n- passo dois\n')
  })

  it('truncates beyond the budget with a marker', () => {
    const { content, report } = compactMemoryContent('a'.repeat(13_000))
    expect(report.truncated).toBe(true)
    expect(content.length).toBeLessThanOrEqual(12_000)
    expect(content).toContain('compactada automaticamente')
  })

  it('keeps the truncated result within budget and idempotent', () => {
    const manyUnique = Array.from({ length: 3000 }, (_, index) => `- passo ${index} com detalhe suficiente para volume`).join('\n')
    const { content } = compactMemoryContent(`# Título\n\n${manyUnique}\n`)
    expect(content.length).toBeLessThanOrEqual(12_000)
    expect(needsCompaction(content)).toBe(false)
    const second = compactMemoryContent(content)
    expect(second.report.compacted).toBe(false)
    expect(second.content).toBe(content)
  })

  it('leaves compact content untouched', () => {
    const input = '# Title\n\n- one\n- two\n'
    const { content, report } = compactMemoryContent(input)
    expect(report.compacted).toBe(false)
    expect(content).toBe(input)
  })
})

describe('compactProjectMemory', () => {
  it('compacts the file on disk without touching safe paths', async () => {
    const root = await makeProject()
    await fs.writeFile(path.join(root, '.devorbit', 'memory.md'), '# M\n\n\n- dup\n- dup\n')
    const result = await compactProjectMemory(root)
    expect(result.success).toBe(true)
    expect(result.compacted).toBe(true)
    expect(await fs.readFile(path.join(root, '.devorbit', 'memory.md'), 'utf-8')).toBe('# M\n\n- dup\n')
  })

  it('reports a no-op when already compact', async () => {
    const root = await makeProject()
    await fs.writeFile(path.join(root, '.devorbit', 'memory.md'), '# M\n\n- one\n')
    const result = await compactProjectMemory(root)
    expect(result).toMatchObject({ success: true, compacted: false })
  })

  it('resolves as a no-op for projects without memory.md', async () => {
    const root = await makeProject()
    const result = await compactProjectMemory(root)
    expect(result).toMatchObject({ success: true, compacted: false })
    expect(result.message).toMatch(/Sem memória/)
    await expect(compactProjectMemory(root)).resolves.toMatchObject({ success: true })
  })

  it('refuses an invalid project path', async () => {
    const result = await compactProjectMemory(path.join(os.tmpdir(), 'definitely-missing-devorbit-dir'))
    expect(result.success).toBe(false)
  })
})

describe('scheduleMemoryCompaction', () => {
  it('runs periodically and cancels cleanly', async () => {
    vi.useFakeTimers()
    try {
      const root = await makeProject()
      const runs: string[] = []
      const cancel = scheduleMemoryCompaction(root, 60_000, async (target) => {
        runs.push(target)
      })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(runs).toEqual([root])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(runs).toEqual([root, root])
      cancel()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(runs).toEqual([root, root])
      cancelMemoryCompaction(root)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('syncMemorySchedulers lifecycle', () => {
  it('schedules active projects and cancels removed ones', async () => {
    vi.useFakeTimers()
    try {
      cancelAllMemoryCompactions()
      const runs: string[] = []
      const runner = async (target: string) => {
        runs.push(target)
      }
      syncMemorySchedulers(['proj-a', 'proj-b'], runner)
      expect(activeCompactionCount()).toBe(2)
      await vi.advanceTimersByTimeAsync(15 * 60_000)
      expect(runs.sort()).toEqual(['proj-a', 'proj-b'])
      syncMemorySchedulers(['proj-a'], runner)
      expect(activeCompactionCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(15 * 60_000)
      expect(runs.filter((entry) => entry === 'proj-b')).toHaveLength(1)
      expect(runs.filter((entry) => entry === 'proj-a')).toHaveLength(2)
      cancelAllMemoryCompactions()
      expect(activeCompactionCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores blank entries', () => {
    cancelAllMemoryCompactions()
    syncMemorySchedulers(['', '  ', 'proj-c'], async () => undefined)
    expect(activeCompactionCount()).toBe(1)
    cancelAllMemoryCompactions()
  })

  it('never lets invalid entries break the scan cycle', () => {
    cancelAllMemoryCompactions()
    const runs: string[] = []
    expect(() =>
      syncMemorySchedulers(
        ['proj-ok', null, undefined, 42, 'a\0b', {}, []] as unknown as string[],
        async (target) => {
          runs.push(target)
        }
      )
    ).not.toThrow()
    expect(activeCompactionCount()).toBe(1)
    cancelAllMemoryCompactions()
    expect(runs).toEqual([])
  })
})
