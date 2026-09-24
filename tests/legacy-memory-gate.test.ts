import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLegacyMemoryWriteGuard, saveProjectMemory, compactProjectMemory } from '../src/main/memory'
import {
  disposeProjectHybridMemory,
  listProjectHybridMemory,
  rememberProjectHybridMemory,
  setProjectHybridMemoryWriteGuard,
} from '../src/main/project-hybrid-memory'
import { readMigrationReceiptState } from '../src/main/ai-memory-migration'
import { migrationReceiptPath } from '../src/main/ai-memory-migration'

const roots: string[] = []
const userDataDirs: string[] = []

beforeEach(async () => {
  await disposeProjectHybridMemory()
  setLegacyMemoryWriteGuard(null)
  setProjectHybridMemoryWriteGuard(null)
})

afterEach(async () => {
  setLegacyMemoryWriteGuard(null)
  setProjectHybridMemoryWriteGuard(null)
  await disposeProjectHybridMemory()
  for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true })
  for (const dir of userDataDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function projectOf(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-gate-'))
  roots.push(root)
  return root
}

function userDataOf(dir: string): string {
  userDataDirs.push(dir)
  return dir
}

async function receiptDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-gate-ud-'))
  return userDataOf(dir)
}

describe('gate read-only pós-migração — memory.md (saveProjectMemory)', () => {
  it('sem guard: comportamento legado integral (escrita permitida)', async () => {
    const project = await projectOf()
    const result = await saveProjectMemory(project, '# conteúdo')
    expect(result.success).toBe(true)
    await expect(fs.readFile(path.join(project, '.devorbit', 'memory.md'), 'utf-8')).resolves.toContain('# conteúdo')
  })

  it('receipt verificada: save recusa, NADA é escrito (sem dual-write)', async () => {
    const project = await projectOf()
    setLegacyMemoryWriteGuard(async () => true)
    const result = await saveProjectMemory(project, '# novo')
    expect(result.success).toBe(false)
    expect(result.message).toContain('somente leitura')
    await expect(fs.access(path.join(project, '.devorbit', 'memory.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('guard lança (erro real de receipt): save falha fechado com mensagem acionável', async () => {
    const project = await projectOf()
    setLegacyMemoryWriteGuard(async () => {
      throw new Error('EACCES simulado')
    })
    const result = await saveProjectMemory(project, '# novo')
    expect(result.success).toBe(false)
    expect(result.message).toContain('incerto')
    await expect(fs.access(path.join(project, '.devorbit'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('guard false (receipt ausente): legado preservado', async () => {
    const project = await projectOf()
    setLegacyMemoryWriteGuard(async () => false)
    const result = await saveProjectMemory(project, '# legado ok')
    expect(result.success).toBe(true)
  })

  it('compactação pós-migração: receipt verificada → no-op sem reescrita', async () => {
    const project = await projectOf()
    await saveProjectMemory(project, '- a\n- a\n- a\n')
    setLegacyMemoryWriteGuard(async () => true)
    const report = await compactProjectMemory(project)
    expect(report.success).toBe(true)
    expect(report.compacted).toBe(false)
    expect(report.message).toContain('compactação legacy desabilitada')
  })

  it('compactação com guard em erro real: fail-closed, também não reescreve', async () => {
    const project = await projectOf()
    await saveProjectMemory(project, '- a\n- a\n')
    setLegacyMemoryWriteGuard(async () => {
      throw new Error('io')
    })
    const report = await compactProjectMemory(project)
    expect(report.compacted).toBe(false)
    expect(report.message).toContain('incerto')
  })
})

describe('gate de project-hybrid-memory (memory.json)', () => {
  it('sem guard: legado integral (memória e leitura)', async () => {
    const project = await projectOf()
    const entry = await rememberProjectHybridMemory(project, {
      kind: 'episodic',
      content: 'evento legado',
    })
    expect(entry.content).toBe('evento legado')
  })

  it('receipt verificada: remember RECUSA (sem dual-write), list PRESERVA leitura', async () => {
    const project = await projectOf()
    // Entrada legada escrita ANTES do gate (nada é apagado depois).
    await rememberProjectHybridMemory(project, { kind: 'episodic', content: 'histórico' })
    setProjectHybridMemoryWriteGuard(async () => true)
    await expect(
      rememberProjectHybridMemory(project, { kind: 'episodic', content: 'novo' }),
    ).rejects.toThrow('somente leitura')
    const entries = await listProjectHybridMemory(project)
    expect(entries).toHaveLength(1)
    expect(entries[0].content).toBe('histórico')
  })

  it('guard em erro real: fail-closed com mensagem de incerteza; leitura segue', async () => {
    const project = await projectOf()
    await rememberProjectHybridMemory(project, { kind: 'operational', content: 'antigo' })
    setProjectHybridMemoryWriteGuard(async () => {
      throw new Error('io')
    })
    await expect(
      rememberProjectHybridMemory(project, { kind: 'episodic', content: 'novo' }),
    ).rejects.toThrow('incerto')
    const entries = await listProjectHybridMemory(project)
    expect(entries).toHaveLength(1)
  })

  it('guard false (receipt ausente): escrita legada segue funcionando', async () => {
    const project = await projectOf()
    setProjectHybridMemoryWriteGuard(async () => false)
    const entry = await rememberProjectHybridMemory(project, {
      kind: 'operational',
      content: 'ainda legado',
    })
    expect(entry.kind).toBe('operational')
  })
})

describe('readMigrationReceiptState', () => {
  it('receipt ausente → "absent" (migração não concluída)', async () => {
    const userData = await receiptDir()
    const state = await readMigrationReceiptState(userData, 'identity-x')
    expect(state.status).toBe('absent')
  })

  it('erro real de leitura (receipt é diretório) → "error" — nunca "present" nem "absent"', async () => {
    const userData = await receiptDir()
    const receipt = migrationReceiptPath(userData, 'identity-1')
    await fs.mkdir(receipt, { recursive: true })
    const state = await readMigrationReceiptState(userData, 'identity-1')
    expect(state.status).toBe('error')
    if (state.status === 'error') {
      expect(state.message.length).toBeGreaterThan(0)
    }
  })
})