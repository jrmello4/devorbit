import { readFile, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HybridMemory } from '../src/main/hybrid-memory'

describe('HybridMemory', () => {
  it('persists the three memory kinds atomically and searches lexically', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devorbit-memory-'))
    const filePath = path.join(directory, 'memory.json')
    try {
      let now = Date.parse('2026-01-01T00:00:00.000Z')
      const memory = new HybridMemory({ filePath, clock: () => now, idFactory: (() => {
        let index = 0
        return () => `memory-${++index}`
      })() })
      await memory.add({ kind: 'operational', content: 'Build command is npm run build', tags: ['build'] })
      now += 1_000
      await memory.add({ kind: 'episodic', content: 'A validação da release passed', tags: ['release'] })
      now += 1_000
      await memory.add({ kind: 'reflexive', content: 'Prefer small focused changes', tags: ['decision'] })

      const matches = await memory.search('validação release')
      expect(matches[0].entry.kind).toBe('episodic')
      expect(matches[0].matchedTerms).toContain('validacao')
      expect(await memory.list()).toHaveLength(3)

      const restored = new HybridMemory(filePath)
      expect((await restored.get('memory-1'))?.content).toContain('npm run build')
      expect((await restored.search('small changes'))[0].entry.kind).toBe('reflexive')
      expect(await readFile(filePath, 'utf8')).not.toContain('.tmp')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('recovers entries from the backup when the main file disappears', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devorbit-memory-'))
    const filePath = path.join(directory, 'memory.json')
    try {
      const memory = new HybridMemory(filePath)
      await memory.add({ kind: 'operational', content: 'first entry' })
      await memory.add({ kind: 'episodic', content: 'second entry' })

      await rm(filePath, { force: true })
      const restored = new HybridMemory(filePath)
      const entries = await restored.list()
      expect(entries).toHaveLength(1)
      expect(entries[0].content).toBe('first entry')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('upserts and removes entries without leaving stale search results', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devorbit-memory-'))
    try {
      const memory = new HybridMemory(path.join(directory, 'memory.json'))
      await memory.upsert({ id: 'same', kind: 'operational', content: 'old value' })
      await memory.upsert({ id: 'same', kind: 'operational', content: 'new value' })
      expect((await memory.get('same'))?.content).toBe('new value')
      expect(await memory.remove('same')).toBe(true)
      expect(await memory.search('new value')).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
