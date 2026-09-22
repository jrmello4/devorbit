import fs from 'node:fs/promises'
import path from 'node:path'
import { HybridMemory, type HybridMemoryInput, type HybridMemoryKind } from './hybrid-memory'
import type { HybridMemoryView, HybridMemoryWrite } from '../shared/hybrid-memory-contract'

const stores = new Map<string, HybridMemory>()

function normalizePathForComparison(value: string): string {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function canonicalizeProjectPath(projectPath: string): Promise<string> {
  const resolved = path.resolve(projectPath)
  try {
    return await fs.realpath(resolved)
  } catch {
    return resolved
  }
}

async function storeFor(projectPath: string): Promise<HybridMemory> {
  const canonical = await canonicalizeProjectPath(projectPath)
  const key = normalizePathForComparison(canonical)
  const existing = stores.get(key)
  if (existing) return existing
  const store = new HybridMemory(path.join(canonical, '.devorbit', 'memory.json'), { maxEntries: 500 })
  stores.set(key, store)
  return store
}

function view(entry: Awaited<ReturnType<HybridMemory['add']>>): HybridMemoryView {
  return entry
}

export async function listProjectHybridMemory(projectPath: string, kind?: HybridMemoryKind): Promise<HybridMemoryView[]> {
  const store = await storeFor(projectPath)
  return (await store.list(kind)).map(view)
}

export async function rememberProjectHybridMemory(projectPath: string, input: HybridMemoryWrite): Promise<HybridMemoryView> {
  const store = await storeFor(projectPath)
  const entry = await store.add(input as HybridMemoryInput)
  return view(entry)
}

export async function searchProjectHybridMemory(projectPath: string, query: string, limit?: number): Promise<Awaited<ReturnType<HybridMemory['search']>>> {
  return (await storeFor(projectPath)).search(query, { ...(limit === undefined ? {} : { limit }) })
}

export async function disposeProjectHybridMemory(): Promise<void> {
  await Promise.all([...stores.values()].map((store) => store.flush()))
  stores.clear()
}
