import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  disposeProjectHybridMemory,
  listProjectHybridMemory,
  rememberProjectHybridMemory,
  searchProjectHybridMemory,
} from '../src/main/project-hybrid-memory'

const roots: string[] = []

async function trySymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, 'junction')
    return true
  } catch {
    try {
      await fs.symlink(target, linkPath, 'dir')
      return true
    } catch {
      return false
    }
  }
}

beforeEach(async () => {
  await disposeProjectHybridMemory()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-phm-'))
  roots.push(root)
})

afterEach(async () => {
  await disposeProjectHybridMemory()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('project-hybrid-memory path canonicalization', () => {
  it('reuses one store across path aliases that resolve to the same project', async () => {
    const root = roots[0]
    const real = path.join(root, 'project')
    await fs.mkdir(real, { recursive: true })
    const alias = path.join(root, 'alias')
    if (!(await trySymlink(real, alias))) return

    await rememberProjectHybridMemory(real, { kind: 'operational', content: 'via real' })
    await rememberProjectHybridMemory(alias, { kind: 'episodic', content: 'via alias' })

    const viaReal = await listProjectHybridMemory(real)
    const viaAlias = await listProjectHybridMemory(alias)
    expect(viaReal).toHaveLength(2)
    expect(viaAlias).toHaveLength(2)
    expect((await searchProjectHybridMemory(alias, 'via real')).length).toBeGreaterThan(0)
  })

  it('normalizes dotted and trailing separators to the same store', async () => {
    const root = roots[0]
    const real = path.join(root, 'project')
    await fs.mkdir(real, { recursive: true })

    await rememberProjectHybridMemory(real, { kind: 'operational', content: 'alpha' })
    await rememberProjectHybridMemory(path.join(real, '.'), { kind: 'episodic', content: 'beta' })
    await rememberProjectHybridMemory(`${real}${path.sep}`, { kind: 'reflexive', content: 'gamma' })

    expect(await listProjectHybridMemory(real)).toHaveLength(3)
  })

  it('matches case-insensitive aliases on Windows', async (context) => {
    if (process.platform !== 'win32') {
      context.skip()
      return
    }
    const root = roots[0]
    const real = path.join(root, 'Project')
    await fs.mkdir(real, { recursive: true })
    const flipped = real.replace('Project', 'project')

    await rememberProjectHybridMemory(real, { kind: 'operational', content: 'cased' })
    expect(await listProjectHybridMemory(flipped)).toHaveLength(1)
  })

  it('falls back safely when the project path does not exist yet', async () => {
    const missing = path.join(roots[0], 'does', 'not', 'exist')
    const entry = await rememberProjectHybridMemory(missing, { kind: 'operational', content: 'created' })
    expect(entry.content).toBe('created')
    expect(await listProjectHybridMemory(missing)).toHaveLength(1)
  })

  it('remember resolves a concrete view entry (add awaited once)', async () => {
    const root = roots[0]
    const real = path.join(root, 'project')
    await fs.mkdir(real, { recursive: true })

    const entry = await rememberProjectHybridMemory(real, { kind: 'operational', content: 'sync-view' })
    expect(entry).toMatchObject({ kind: 'operational', content: 'sync-view' })
    expect(typeof entry.id).toBe('string')
    expect(entry).not.toBeInstanceOf(Promise)
  })
})
