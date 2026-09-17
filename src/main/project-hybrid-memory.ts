import path from 'node:path'
import { HybridMemory, type HybridMemoryInput, type HybridMemoryKind } from './hybrid-memory'
import type { HybridMemoryView, HybridMemoryWrite } from '../shared/hybrid-memory-contract'

const stores = new Map<string, HybridMemory>()

function storeFor(projectPath: string): HybridMemory {
  const key = path.resolve(projectPath)
  const existing = stores.get(key)
  if (existing) return existing
  const store = new HybridMemory(path.join(key, '.devorbit', 'memory.json'), { maxEntries: 500 })
  stores.set(key, store)
  return store
}

function view(entry: Awaited<ReturnType<HybridMemory['add']>>): HybridMemoryView {
  return entry
}

export async function listProjectHybridMemory(projectPath: string, kind?: HybridMemoryKind): Promise<HybridMemoryView[]> {
  return (await storeFor(projectPath).list(kind)).map(view)
}

export async function rememberProjectHybridMemory(projectPath: string, input: HybridMemoryWrite): Promise<HybridMemoryView> {
  const value: HybridMemoryInput = input
  return view(await storeFor(projectPath).add(value))
}

export async function searchProjectHybridMemory(projectPath: string, query: string, limit?: number): Promise<Awaited<ReturnType<HybridMemory['search']>>> {
  return storeFor(projectPath).search(query, { ...(limit === undefined ? {} : { limit }) })
}

export async function disposeProjectHybridMemory(): Promise<void> {
  await Promise.all([...stores.values()].map((store) => store.flush()))
  stores.clear()
}
