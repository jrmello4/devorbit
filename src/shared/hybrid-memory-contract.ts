export type HybridMemoryKind = 'operational' | 'episodic' | 'reflexive'

export interface HybridMemoryView {
  id: string
  kind: HybridMemoryKind
  content: string
  tags: string[]
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface HybridMemoryWrite {
  kind: HybridMemoryKind
  content: string
  tags?: readonly string[]
  metadata?: Record<string, unknown>
}
