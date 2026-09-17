import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EvolutionStore } from '../src/main/evolution-store'

describe('EvolutionStore', () => {
  it('records all evolution kinds and redacts sensitive telemetry recursively', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devorbit-evolution-'))
    try {
      let now = Date.parse('2026-01-01T00:00:00.000Z')
      const store = new EvolutionStore({
        directory,
        idFactory: (() => {
          let index = 0
          return () => `evolution-${++index}`
        })(),
        clock: () => now,
      })

      const baseline = await store.recordBaseline({ projectPath: 'C:/work/app', prompt: 'do not persist this' }, {
        telemetry: { durationMs: 12, token: 'secret-token' },
      })
      now += 1_000
      const remediation = await store.recordRemediation({ findingId: 'finding-1', action: 'replace unsafe path' })
      now += 1_000
      const gain = await store.recordGain({ findingReduction: 2, nested: { apiKey: 'secret-key', value: 3 } })
      now += 1_000
      const reflection = await store.recordAgentReflection({ summary: 'Keep the change bounded' })

      expect([baseline.kind, remediation.kind, gain.kind, reflection.kind]).toEqual([
        'baseline',
        'remediation',
        'gain',
        'agent-reflection',
      ])
      expect(baseline.type).toBe('baseline')
      expect(baseline.timestamp).toBe(baseline.recordedAt)
      expect(baseline.payload).toEqual(baseline.data)

      const records = await store.read()
      expect(records).toHaveLength(4)
      expect(JSON.stringify(records)).not.toContain('do not persist this')
      expect(JSON.stringify(records)).not.toContain('secret-token')
      expect(JSON.stringify(records)).not.toContain('secret-key')
      expect(records.find((record) => record.kind === 'gain')?.data.nested).toEqual({
        apiKey: '[REDACTED]',
        value: 3,
      })

      const persisted = JSON.parse(await readFile(path.join(directory, 'evolution-history.json'), 'utf8')) as {
        version: number
        records: Array<Record<string, unknown>>
      }
      expect(persisted.version).toBe(1)
      expect(persisted.records).toHaveLength(4)
      expect(persisted.records[0]).not.toHaveProperty('payload')
      expect(await readFile(path.join(directory, 'evolution-history.json'), 'utf8')).not.toContain('.tmp')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps persistence and reads bounded while serializing concurrent writes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devorbit-evolution-'))
    try {
      const store = new EvolutionStore({ directory, maxRecords: 3, maxReadRecords: 2 })
      await Promise.all([
        store.record({ kind: 'baseline', data: { index: 1 } }),
        store.record({ kind: 'remediation', data: { index: 2 } }),
        store.record({ kind: 'gain', data: { index: 3 } }),
        store.record({ kind: 'agent-reflection', data: { index: 4 } }),
      ])

      expect((await store.read()).map((record) => record.data.index)).toEqual([3, 4])
      expect((await store.read({ limit: 99 })).map((record) => record.data.index)).toEqual([3, 4])
      expect((await store.read({ kind: 'gain', limit: 10 })).map((record) => record.kind)).toEqual(['gain'])

      const restored = new EvolutionStore({ directory, maxRecords: 3 })
      expect((await restored.read()).map((record) => record.data.index)).toEqual([2, 3, 4])
      await restored.close()
      expect(restored.isClosed).toBe(true)
      await expect(restored.record({ kind: 'gain', data: { index: 5 } })).rejects.toThrow('closed')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('recovers the previous history from the backup when the main file disappears or is corrupt', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devorbit-evolution-'))
    try {
      const store = new EvolutionStore({ directory })
      await store.record({ kind: 'baseline', data: { index: 1 } })
      await store.record({ kind: 'remediation', data: { index: 2 } })
      await store.record({ kind: 'gain', data: { index: 3 } })
      const mainFile = path.join(directory, 'evolution-history.json')

      await rm(mainFile, { force: true })
      const recoveredFromBackup = new EvolutionStore({ directory })
      expect((await recoveredFromBackup.read()).map((record) => record.data.index)).toEqual([1, 2])
      await recoveredFromBackup.close()

      await store.record({ kind: 'gain', data: { index: 4 } })
      await writeFile(mainFile, '{broken', 'utf8')
      const recoveredFromCorruption = new EvolutionStore({ directory })
      const records = await recoveredFromCorruption.read()
      expect(records.length).toBeGreaterThan(0)
      expect(records.map((record) => record.data.index)).not.toContain('{broken')
      await recoveredFromCorruption.close()
      const quarantined = (await readdir(directory)).some((entry) => entry.startsWith('evolution-history.json.corrupt-'))
      expect(quarantined).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('supports Disposable-compatible shutdown and validates unsafe bounds', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devorbit-evolution-'))
    try {
      expect(() => new EvolutionStore({ directory, maxRecords: 0 })).toThrow('positive')
      expect(() => new EvolutionStore({ directory, fileName: '../outside.json' })).toThrow('under its directory')

      const store = new EvolutionStore(directory)
      await store.recordReflection({ observation: 'bounded history' })
      store.dispose()
      expect(store.isClosed).toBe(true)
      await expect(store.append({ kind: 'reflection', data: { observation: 'rejected' } })).rejects.toThrow('closed')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
