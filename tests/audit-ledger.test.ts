import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AuditLedger } from '../src/main/audit-ledger'

describe('AuditLedger', () => {
  it('appends JSONL records with prompt, token, and env redacted', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devorbit-ledger-'))
    const filePath = path.join(directory, 'audit.jsonl')
    try {
      const ledger = new AuditLedger({ filePath, maxReadEntries: 2, idFactory: () => 'entry-1' })
      await Promise.all([
        ledger.append({ type: 'request', prompt: 'secret prompt', token: 'secret token', env: { API_KEY: 'secret' } }),
        ledger.append({ type: 'result', data: { value: 'safe' } }),
      ])
      const entries = await ledger.read({ limit: 2 })
      expect(entries).toHaveLength(2)
      expect(JSON.stringify(entries)).not.toContain('secret prompt')
      expect(JSON.stringify(entries)).not.toContain('secret token')
      expect(JSON.stringify(entries)).not.toContain('API_KEY')
      expect(entries[0].type).toBe('request')
      const lines = (await readFile(filePath, 'utf8')).trim().split(/\r?\n/)
      expect(lines).toHaveLength(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns only the bounded newest records', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devorbit-ledger-'))
    try {
      const ledger = new AuditLedger(path.join(directory, 'audit.jsonl'), { maxReadEntries: 3 })
      await ledger.append({ type: 'one' })
      await ledger.append({ type: 'two' })
      await ledger.append({ type: 'three' })
      await ledger.append({ type: 'four' })
      expect((await ledger.read(2)).map((entry) => entry.type)).toEqual(['three', 'four'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
