import fs from 'node:fs/promises'
import path from 'node:path'
import { HybridMemory, type HybridMemoryInput, type HybridMemoryKind } from './hybrid-memory'
import type { HybridMemoryView, HybridMemoryWrite } from '../shared/hybrid-memory-contract'

const stores = new Map<string, HybridMemory>()

/**
 * Gate read-only pós-migração (FASE 3) — mesma semântica do guard de
 * memory.ts: receipt verificada → memory.json NÃO aceita mais escritas
 * (sem dual-write); erro real ao consultar a receipt → fail-closed; sem
 * guard/receipt ausente → comportamento legado integral. Leitura
 * (list/search) é sempre preservada, mesmo pós-migração.
 */
export type ProjectHybridMemoryWriteGuard = (projectPath: string) => Promise<boolean>

let hybridWriteGuard: ProjectHybridMemoryWriteGuard | null = null

export function setProjectHybridMemoryWriteGuard(guard: ProjectHybridMemoryWriteGuard | null): void {
  hybridWriteGuard = guard
}

type HybridGateState = 'legacy' | 'read-only' | 'uncertain'

async function hybridGateState(projectPath: string): Promise<HybridGateState> {
  if (!hybridWriteGuard) return 'legacy'
  try {
    return (await hybridWriteGuard(projectPath)) ? 'read-only' : 'legacy'
  } catch {
    return 'uncertain'
  }
}

const HYBRID_READ_ONLY_MESSAGE = 'Projeto migrado para o ai-memory: .devorbit/memory.json é somente leitura (histórico preservado).'
const HYBRID_UNCERTAIN_MESSAGE = 'Estado de migração incerto (falha ao consultar receipt do ai-memory): escrita em memory.json bloqueada por segurança.'

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
  // Pós-migração: memory.json fica read-only (sem dual-write). Escrita é
  // RECUSADA com erro descritivo (a leitura/lista continua funcionando);
  // estado incerto também falha fechado. Nada é apagado em nenhum caso.
  const gate = await hybridGateState(projectPath)
  if (gate === 'read-only') throw new Error(HYBRID_READ_ONLY_MESSAGE)
  if (gate === 'uncertain') throw new Error(HYBRID_UNCERTAIN_MESSAGE)
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
