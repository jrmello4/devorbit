/**
 * Contrato de IPC da superfície ai-memory no main process (FASE 3).
 *
 * Esta superfície é consumida pela futura UI (Shell #2 via preload/types) e
 * testável sem Electron: o registrador é injetado. Nenhum canal transforma
 * ausência do ai-memory em erro impeditivo — toda falha vira resposta
 * estruturada `{ ok: false, ... }`.
 *
 * Canais (IpcInvokeChannel em renderer/src/types fica para o Shell #2;
 * aqui são constantes tipadas como string, convertidas com cast local).
 */

import type { AiMemoryConfig, AiMemoryProjectConfig, AiMemoryStatus } from './ai-memory-contract'
export type { AiMemoryConfig, AiMemoryStatus } from './ai-memory-contract'

/** Canais invoke disponíveis (prefixo consistente `devorbit:aiMemory`). */
export const AI_MEMORY_IPC_CHANNELS = {
  status: 'devorbit:aiMemoryStatus',
  doctor: 'devorbit:aiMemoryDoctor',
  query: 'devorbit:aiMemoryQuery',
  briefing: 'devorbit:aiMemoryBriefing',
  recent: 'devorbit:aiMemoryRecent',
  handoffs: 'devorbit:aiMemoryHandoffs',
  enableProject: 'devorbit:aiMemoryEnableProject',
  migrateLegacy: 'devorbit:aiMemoryMigrateLegacy',
  migrationStatus: 'devorbit:aiMemoryMigrationStatus',
  getProjectStatus: 'devorbit:aiMemoryProjectStatus',
  takeover: 'devorbit:aiMemoryTakeover',
  publishSquadState: 'devorbit:aiMemoryPublishSquadState',
} as const

export type AiMemoryIpcChannel =
  (typeof AI_MEMORY_IPC_CHANNELS)[keyof typeof AI_MEMORY_IPC_CHANNELS]

/** Resposta estruturada padrão: falha de memória NUNCA vira throw no IPC. */
export interface AiMemoryIpcResult<T> {
  ok: boolean
  /** Motivo estruturado quando ok=false (ex.: 'disabled', 'unavailable'). */
  reason?: string
  message?: string
  data?: T
}

export interface AiMemoryProjectRef {
  projectPath: string
}

/** Visão estrutural do MigrationOutcome (compatível com main/ai-memory-migration). */
export interface AiMemoryMigrationOutcomeView {
  status: 'migrated' | 'already-migrated' | 'skipped-empty' | 'failed' | 'disabled' | 'unavailable'
  paths: string[]
  message?: string
}

/** Visão estrutural do TakeoverPlan (compatível com main/ai-memory-takeover). */
export interface AiMemoryTakeoverPlanView {
  instruction: string
  pendingTasks: Array<{ id: string; title: string; status: string }>
  evidence?: { branch?: string; head?: string; dirtyFiles?: string[] }
  sourcesLoaded: { state: boolean; briefing: boolean; handoffs: boolean }
}

/**
 * Snapshot consolidado do squad — espelho estrutural do SquadSnapshot do
 * main (main importa esta visão quando necessário; shared nunca importa main).
 */
export interface AiMemorySquadSnapshotView {
  id: string
  objective: string
  plan?: string
  members: Array<{ id: string; title?: string; role?: string; status: string; terminalId?: string; provider?: string; model?: string }>
  tasks?: Array<{ id: string; title: string; status: string; memberId?: string; requestId?: string; description?: string }>
  files?: readonly string[]
  decisions?: readonly string[]
  failures?: readonly string[]
  discardedApproaches?: readonly string[]
  blockers?: readonly string[]
  nextSteps?: readonly string[]
  updatedAt?: string
}

export interface AiMemoryEnableProjectRequest {
  /** Caminho CANÔNICO validado no main (renderer não fornece entry). */
  projectPath: string
  enabled: boolean
}

/** Marker (`.ai-memory.toml`) após o enable — conflito impede a migração. */
export interface AiMemoryMarkerView {
  status: 'created' | 'unchanged' | 'updated' | 'preserved' | 'conflict' | 'disabled'
  configured: boolean
  path?: string
  conflicts?: string[]
  missingFields?: string[]
}

export interface AiMemoryEnableProjectResult {
  config: AiMemoryConfig
  status: AiMemoryStatus
  /** Opt-in efetivo do projeto (derivado de config.projects[identity].enabled). */
  isProjectEnabled: boolean
  /** Marker garantido após o reconfigure (quando `enabled`). */
  marker?: AiMemoryMarkerView
  /** Migração rodada SOMENTE com opt-in + marker sem conflito. */
  migration?: AiMemoryMigrationOutcomeView
}

export interface AiMemoryMigrationStatusResult {
  /** Estado da receipt local (não depende do sidecar). */
  receipt: 'absent' | 'present' | 'error'
  message?: string
  concludedAt?: string
  paths?: string[]
}

/**
 * Status do projeto para o dashboard: SOMENTE `projectPath` — a identidade é
 * SEMPRE derivada no main (escopo do serviço); renderer nunca a fornece.
 */
export type AiMemoryProjectStatusRequest = AiMemoryProjectRef

export interface AiMemoryProjectStatusResult {
  /** Opt-in do projeto (config + identidade derivada no main). */
  isProjectEnabled: boolean
  /** Estado do serviço sidecar (running/unavailable/...). */
  status: AiMemoryStatus
  /** Receipt de migração local (não depende do sidecar). */
  migration: AiMemoryMigrationStatusResult
}

export interface AiMemoryTakeoverRequest {
  projectPath: string
  squadId: string
  survivingAgent: string
}

/** Leitura (query): SOMENTE campos documentados e bounded. */
export interface AiMemoryQueryRequest extends AiMemoryProjectRef {
  query?: string
  limit?: number
}

export interface AiMemoryRecentRequest extends AiMemoryProjectRef {
  limit?: number
}

export interface AiMemoryIpcContract {
  status: () => Promise<AiMemoryIpcResult<AiMemoryStatus>>
  doctor: () => Promise<AiMemoryIpcResult<{ ok: boolean; message?: string }>>
  query: (request: AiMemoryQueryRequest) => Promise<AiMemoryIpcResult<unknown>>
  briefing: (request: AiMemoryProjectRef) => Promise<AiMemoryIpcResult<unknown>>
  recent: (request: AiMemoryRecentRequest) => Promise<AiMemoryIpcResult<unknown>>
  handoffs: (request: AiMemoryProjectRef) => Promise<AiMemoryIpcResult<unknown>>
  enableProject: (request: AiMemoryEnableProjectRequest) => Promise<AiMemoryIpcResult<AiMemoryEnableProjectResult>>
  migrateLegacy: (request: AiMemoryProjectRef) => Promise<AiMemoryIpcResult<AiMemoryMigrationOutcomeView>>
  migrationStatus: (request: AiMemoryProjectRef) => Promise<AiMemoryIpcResult<AiMemoryMigrationStatusResult>>
  getProjectStatus: (request: AiMemoryProjectStatusRequest) => Promise<AiMemoryIpcResult<AiMemoryProjectStatusResult>>
  takeover: (request: AiMemoryTakeoverRequest) => Promise<AiMemoryIpcResult<AiMemoryTakeoverPlanView | null>>
  publishSquadState: (request: { projectPath: string; snapshot: AiMemorySquadSnapshotView }) => Promise<AiMemoryIpcResult<{ path: string; published: boolean }>>
}