/**
 * Superfície IPC ai-memory do main process (FASE 3) — status/config/leitura
 * (query/briefing/recent/handoffs)/doctor + migração legacy idempotente
 * (opt-in explícito) + takeover/squad state.
 *
 * Sem Electron nem imports concretos do serviço: TODAS as dependências são
 * injetadas (padrão `ConfigIpcDependencies`), então os testes usam um
 * registrador fake. Nenhum canal transforma ausência do ai-memory em erro
 * impeditivo — toda falha vira resposta estruturada `{ ok: false, ... }`.
 *
 * Segurança:
 * - todo `projectPath` é validado/canonicalizado no main ANTES de qualquer uso
 *   (`validateProjectPath` real por padrão; injetável para teste) — o renderer
 *   nunca define escopo, entry ou escopo global;
 * - enable deriva o `AiMemoryProjectConfig` do caminho validado +
 *   `resolveScope`; após o reconfigure o marker é garantido e CONFLITO com
 *   marker de terceiros impede a migração (surface estruturada, sem throw);
 * - query/recent aceitam SOMENTE campos documentados e bounded — extraArgs do
 *   renderer nunca sobrescrevem workspace/project nem pedem escopo global;
 * - squadId/survivingAgent e snapshots são bound/sanitizados/redigidos antes
 *   da persistência (evidência histórica explícita; outcomes recuperáveis).
 *
 * NÃO é registrado aqui: index.ts/preload/types ficam para o Shell #2; os
 * canais são `IpcInvokeChannel` por cast local até os types serem estendidos.
 */

import path from 'node:path'
import type { IpcRegistrar } from './registrar'
import type { IpcInvokeChannel } from '../../renderer/src/types'
import { validateProjectPath } from '../project-paths'
import {
  AI_MEMORY_CLI_COMMANDS,
  AI_MEMORY_MCP_TOOLS,
  type AiMemoryConfig,
  type AiMemoryMcpToolName,
  type AiMemoryProjectConfig,
  type AiMemoryScope,
  type AiMemoryStatus,
} from '../../shared/ai-memory-contract'
import {
  AI_MEMORY_IPC_CHANNELS,
  type AiMemoryEnableProjectRequest,
  type AiMemoryEnableProjectResult,
  type AiMemoryIpcResult,
  type AiMemoryMarkerView,
  type AiMemoryMigrationStatusResult,
  type AiMemoryMigrationOutcomeView,
  type AiMemoryProjectRef,
  type AiMemoryProjectStatusRequest,
  type AiMemoryProjectStatusResult,
  type AiMemoryQueryRequest,
  type AiMemoryRecentRequest,
  type AiMemoryTakeoverPlanView,
  type AiMemoryTakeoverRequest,
} from '../../shared/ai-memory-ipc-contract'
import {
  migrateProjectLegacyMemory,
  readMigrationReceiptState,
  type LegacyMemoryFiles,
  type MigrationMemoryClient,
} from '../ai-memory-migration'
import { buildTakeoverPlan, fallbackTakeoverPlan, type TakeoverGitInspector } from '../ai-memory-takeover'
import {
  SquadMemoryPublisher,
  sanitizeSnapshot,
  sanitizeSnapshotText,
  squadStatePagePath,
  syncScopeOf,
  type SquadSnapshot,
} from '../ai-memory-sync'

/** Visão mínima do AiMemoryService para esta superfície (injetável em teste). */
export interface AiMemoryIpcService {
  status(): AiMemoryStatus
  client(): MigrationMemoryClient | undefined
  resolveScope(projectPath: string): Promise<AiMemoryScope>
  isProjectEnabled(identity: string): boolean
  reconfigure(config: AiMemoryConfig): Promise<AiMemoryStatus>
  /** Garante o marker `.ai-memory.toml` — conflito de terceiros impede migração. */
  ensureProjectMarker(projectPath: string): Promise<AiMemoryEnsureMarkerResult>
  /** Health check de transporte (opcional — ausente = fallback via status state). */
  health?(): Promise<{ ok: boolean; message?: string }>
}

type AiMemoryEnsureMarkerResult = {
  status: AiMemoryMarkerView['status']
  configured: boolean
  path?: string
  conflicts?: string[]
  missingFields?: string[]
}

/** Runner da CLI (doctor); injetável — default usa o binário do status(). */
export type AiMemoryDoctorRunner = (
  args: readonly string[]
) => Promise<{ code: number | null; stdout: string; stderr: string }>

export interface AiMemoryIpcDependencies {
  service: AiMemoryIpcService
  userDataDir: string
  loadAiMemoryConfig: () => Promise<AiMemoryConfig>
  setProjectEnabled: (entry: AiMemoryProjectConfig, enabled: boolean) => Promise<AiMemoryConfig>
  /**
   * Validação/canonização de caminho (TODOS os canais com projectPath).
   * Produção usa o `validateProjectPath` real por padrão; injetável em teste.
   */
  validator?: (input: unknown) => Promise<string>
  /** Doctor injetável; default roda a CLI do binaryPath do status(). */
  doctorRunner?: AiMemoryDoctorRunner
  /** Leitura segura do legado (injetável para teste). */
  readLegacyFiles?: (projectPath: string) => Promise<LegacyMemoryFiles>
  /** Identidade para a receipt de migrationStatus (injetável; default usa o escopo do serviço). */
  identityFor?: (projectPath: string) => Promise<string>
  /**
   * Inspector Git do takeover (injetável para teste; default de produção =
   * `createTakeoverGitInspector` read-only dentro de `buildTakeoverPlan`).
   * Recebe SEMPRE o caminho canônico validado no main.
   */
  gitInspector?: TakeoverGitInspector
}

function ok<T>(data: T): AiMemoryIpcResult<T> {
  return { ok: true, data }
}

function failResult<T>(reason: string, message?: string): AiMemoryIpcResult<T> {
  return { ok: false, reason, ...(message !== undefined ? { message } : {}) }
}

/** Limites das leituras bounded (query/recent). */
const QUERY_MAX_CHARS = 2_000
const QUERY_LIMIT_MAX = 50

/** Gate das operações com escopo: falhas viram resultado, nunca throw. */
type ScopeGate = { ok: false; reason: string; message?: string } | { ok: true; scope: AiMemoryScope; client: MigrationMemoryClient }

/** Statuses de marker que autorizam a migração (conflito/preservado NÃO). */
const MARKER_MIGRATION_READY = new Set(['created', 'updated', 'unchanged'])

/**
 * Registra todos os canais. Cada handler captura qualquer erro e devolve
 * resposta estruturada — ausência/falha do ai-memory nunca impede a UI.
 */
export function registerAiMemoryIpc(
  register: IpcRegistrar,
  deps: AiMemoryIpcDependencies
): void {
  const service = deps.service
  const scopeCache = new Map<string, AiMemoryScope>()
  /** Publisher por workspace/project: fila interna serializa snapshots concorrentes. */
  const publishers = new Map<string, SquadMemoryPublisher>()

  const canonicalPath = async (input: unknown): Promise<string | undefined> => {
    try {
      return await (deps.validator ? deps.validator(input) : validateProjectPath(input))
    } catch {
      return undefined
    }
  }

  const withValidatedPath = async (input: unknown): Promise<string | AiMemoryIpcResult<never>> => {
    const projectPath = await canonicalPath(input)
    if (projectPath === undefined) {
      return failResult('invalid-path', 'Caminho de projeto inválido ou fora das pastas monitoradas.')
    }
    return projectPath
  }

  const isPathResult = (value: string | AiMemoryIpcResult<never>): value is string =>
    typeof value === 'string'

  const scopeOf = async (projectPath: string): Promise<AiMemoryScope> => {
    const cached = scopeCache.get(projectPath)
    if (cached) return cached
    const scope = await service.resolveScope(projectPath)
    scopeCache.set(projectPath, scope)
    return scope
  }

  const readGate = async (projectPath: string): Promise<ScopeGate> => {
    if (service.status().state !== 'running') {
      return { ok: false, reason: 'unavailable', message: service.status().message }
    }
    const scope = await scopeOf(projectPath)
    if (!service.isProjectEnabled(scope.identity)) {
      return { ok: false, reason: 'disabled', message: 'Projeto sem opt-in para o ai-memory.' }
    }
    const client = service.client()
    if (!client) return { ok: false, reason: 'unavailable', message: 'Cliente MCP indisponível.' }
    return { ok: true, scope, client }
  }

  const callScopeTool = async (
    projectPath: string,
    tool: AiMemoryMcpToolName,
    extraArgs: Record<string, unknown>
  ): Promise<AiMemoryIpcResult<unknown>> => {
    try {
      const gate = await readGate(projectPath)
      if (!gate.ok) return failResult(gate.reason, gate.message)
      const result = await gate.client.callTool(tool, {
        workspace: gate.scope.workspace,
        project: gate.scope.project,
        ...extraArgs,
      })
      return ok({
        text: result.text,
        isError: result.isError,
        ...(result.json !== undefined ? { json: result.json } : {}),
      })
    } catch (error) {
      return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }

  const defaultDoctorRunner = async (): Promise<AiMemoryDoctorRunner | undefined> => {
    const binaryPath = service.status().binaryPath
    if (!binaryPath) return undefined
    const { createAiMemoryCliRunner } = await import('../ai-memory-client')
    const cliRunner = createAiMemoryCliRunner({ binaryPath })
    return async (args) => await cliRunner(args)
  }

  register(
    AI_MEMORY_IPC_CHANNELS.status as IpcInvokeChannel,
    async (): Promise<AiMemoryIpcResult<AiMemoryStatus>> => {
      try {
        return ok(service.status())
      } catch (error) {
        return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  register(
    AI_MEMORY_IPC_CHANNELS.doctor as IpcInvokeChannel,
    async (): Promise<AiMemoryIpcResult<{ ok: boolean; message?: string }>> => {
      try {
        const status = service.status()
        if (status.owned) {
          const runner = deps.doctorRunner ?? (await defaultDoctorRunner())
          if (!runner) {
            return ok({ ok: false, message: 'Binário CLI do ai-memory não descoberto; doctor indisponível.' })
          }
          const dataDir = path.join(deps.userDataDir, 'ai-memory', 'data')
          const result = await runner(['--data-dir', dataDir, AI_MEMORY_CLI_COMMANDS.doctor])
          const healthy = result.code === 0
          const details = (result.stderr || result.stdout).trim().slice(0, 2_000)
          return ok({
            ok: healthy,
            ...(healthy
              ? (details ? { message: details } : {})
              : { message: details || 'Falha na verificação do ai-memory doctor.' }),
          })
        }

        // Serviço externo/não-gerenciado: não inspeciona data-dir local nem exige CLI local.
        // Usa o health() injetado do serviço para checar a saúde real do endpoint.
        if (service.health) {
          const health = await service.health()
          const endpointInfo = status.endpoint ? ` (${status.endpoint})` : ''
          const fallbackMessage = health.ok
            ? `Serviço ai-memory externo saudável${endpointInfo}.`
            : `Serviço ai-memory externo indisponível${endpointInfo}.`
          return ok({
            ok: health.ok,
            message: health.message || fallbackMessage,
          })
        }

        const running = status.state === 'running'
        return ok({
          ok: running,
          message:
            status.message ||
            (running
              ? `Serviço ai-memory externo em execução${status.endpoint ? ` (${status.endpoint})` : ''}.`
              : 'Serviço ai-memory externo indisponível.'),
        })
      } catch (error) {
        return ok({ ok: false, message: error instanceof Error ? error.message : String(error) })
      }
    }
  )

  register(
    AI_MEMORY_IPC_CHANNELS.query as IpcInvokeChannel,
    async (_event, request: AiMemoryQueryRequest) => {
      try {
        const pathOr = await withValidatedPath(request?.projectPath)
        if (!isPathResult(pathOr)) return pathOr
        // SOMENTE campos documentados e bounded; workspace/project SEMPRE vêm
        // do escopo resolvido no main — o renderer não sobrescreve nem pede
        // escopo global.
        const args: Record<string, unknown> = {}
        if (typeof request.query === 'string' && request.query.trim()) {
          args.query = sanitizeSnapshotText(request.query, QUERY_MAX_CHARS)
        }
        if (typeof request.limit === 'number' && Number.isFinite(request.limit)) {
          args.limit = Math.max(1, Math.min(QUERY_LIMIT_MAX, Math.floor(request.limit)))
        }
        return await callScopeTool(pathOr, AI_MEMORY_MCP_TOOLS.query, args)
      } catch (error) {
        return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  register(
    AI_MEMORY_IPC_CHANNELS.briefing as IpcInvokeChannel,
    async (_event, request: AiMemoryProjectRef) => {
      try {
        const pathOr = await withValidatedPath(request?.projectPath)
        if (!isPathResult(pathOr)) return pathOr
        return await callScopeTool(pathOr, AI_MEMORY_MCP_TOOLS.briefing, {})
      } catch (error) {
        return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  register(
    AI_MEMORY_IPC_CHANNELS.recent as IpcInvokeChannel,
    async (_event, request: AiMemoryRecentRequest) => {
      try {
        const pathOr = await withValidatedPath(request?.projectPath)
        if (!isPathResult(pathOr)) return pathOr
        const args: Record<string, unknown> = {}
        if (typeof request?.limit === 'number' && Number.isFinite(request.limit)) {
          args.limit = Math.max(1, Math.min(QUERY_LIMIT_MAX, Math.floor(request.limit)))
        }
        return await callScopeTool(pathOr, AI_MEMORY_MCP_TOOLS.recent, args)
      } catch (error) {
        return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  register(
    AI_MEMORY_IPC_CHANNELS.handoffs as IpcInvokeChannel,
    async (_event, request: AiMemoryProjectRef) => {
      try {
        const pathOr = await withValidatedPath(request?.projectPath)
        if (!isPathResult(pathOr)) return pathOr
        return await callScopeTool(pathOr, AI_MEMORY_MCP_TOOLS.handoffList, {})
      } catch (error) {
        return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  register(
    AI_MEMORY_IPC_CHANNELS.enableProject as IpcInvokeChannel,
    async (_event, request: AiMemoryEnableProjectRequest): Promise<AiMemoryIpcResult<AiMemoryEnableProjectResult>> => {
      try {
        if (typeof request?.enabled !== 'boolean' || typeof request?.projectPath !== 'string') {
          return failResult('invalid-request')
        }
        const pathOr = await withValidatedPath(request.projectPath)
        if (!isPathResult(pathOr)) return pathOr
        const projectPath = pathOr
        const scope = await scopeOf(projectPath)
        // Opt-in EXPLÍCITO: entry derivado do caminho VALIDADO + resolveScope —
        // o renderer NUNCA fornece identity/workspace/project/path.
        const entry: AiMemoryProjectConfig = {
          identity: scope.identity,
          workspace: scope.workspace,
          project: scope.project,
          path: projectPath,
          enabled: request.enabled,
        }
        const config = await deps.setProjectEnabled(entry, request.enabled)
        const status = await service.reconfigure(config)
        if (!request.enabled) return ok({ config, status })
        // Marker garantido DEPOIS do reconfigure: conflito com marker de
        // terceiros impede a migração (surface estruturada, sem throw).
        const marker = await service.ensureProjectMarker(projectPath)
        const markerView: AiMemoryMarkerView = {
          status: marker.status,
          configured: marker.configured,
          ...(marker.path !== undefined ? { path: marker.path } : {}),
          ...(marker.conflicts !== undefined ? { conflicts: marker.conflicts } : {}),
          ...(marker.missingFields !== undefined ? { missingFields: marker.missingFields } : {}),
        }
        if (!MARKER_MIGRATION_READY.has(marker.status)) {
          return ok({ config, status, marker: markerView })
        }
        const migration = await migrateProjectLegacyMemory({
          userDataDir: deps.userDataDir,
          projectPath,
          scope,
          client: service.client(),
          isProjectEnabled: (identity) => service.isProjectEnabled(identity),
          ...(deps.readLegacyFiles ? { readLegacyFiles: deps.readLegacyFiles } : {}),
        })
        return ok({ config, status, marker: markerView, migration })
      } catch (error) {
        return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  register(
    AI_MEMORY_IPC_CHANNELS.migrateLegacy as IpcInvokeChannel,
    async (_event, request: AiMemoryProjectRef): Promise<AiMemoryIpcResult<AiMemoryMigrationOutcomeView>> => {
      try {
        const pathOr = await withValidatedPath(request?.projectPath)
        if (!isPathResult(pathOr)) return pathOr
        const projectPath = pathOr
        if (service.status().state !== 'running') {
          return ok({
            status: 'unavailable',
            paths: [],
            message: 'Serviço ai-memory indisponível: migração ficará pendente (legado preservado).',
          })
        }
        const scope = await scopeOf(projectPath)
        const outcome = await migrateProjectLegacyMemory({
          userDataDir: deps.userDataDir,
          projectPath,
          scope,
          client: service.client(),
          isProjectEnabled: (identity) => service.isProjectEnabled(identity),
          ...(deps.readLegacyFiles ? { readLegacyFiles: deps.readLegacyFiles } : {}),
        })
        return ok(outcome)
      } catch (error) {
        return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  register(
    AI_MEMORY_IPC_CHANNELS.migrationStatus as IpcInvokeChannel,
    async (_event, request: AiMemoryProjectRef): Promise<AiMemoryIpcResult<AiMemoryMigrationStatusResult>> => {
      try {
        const pathOr = await withValidatedPath(request?.projectPath)
        if (!isPathResult(pathOr)) return pathOr
        const projectPath = pathOr
        const identityFor =
          deps.identityFor ??
          (async () => {
            const scope = await scopeOf(projectPath)
            return scope.identity
          })
        const identity = await identityFor(projectPath)
        const state = await readMigrationReceiptState(deps.userDataDir, identity)
        if (state.status === 'present') {
          return ok({
            receipt: 'present',
            concludedAt: state.receipt.concludedAt,
            paths: state.receipt.paths,
          })
        }
        if (state.status === 'absent') return ok({ receipt: 'absent' })
        return ok({ receipt: 'error', message: state.message })
      } catch (error) {
        return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  register(
    AI_MEMORY_IPC_CHANNELS.getProjectStatus as IpcInvokeChannel,
    async (
      _event,
      request: AiMemoryProjectStatusRequest
    ): Promise<AiMemoryIpcResult<AiMemoryProjectStatusResult>> => {
      try {
        // Bounded: request só projectPath; identidade SEMPRE derivada no main.
        const pathOr = await withValidatedPath(request?.projectPath)
        if (!isPathResult(pathOr)) return pathOr
        const scope = await scopeOf(pathOr)
        const isProjectEnabled = service.isProjectEnabled(scope.identity)
        const status = service.status()
        const state = await readMigrationReceiptState(deps.userDataDir, scope.identity)
        const migration: AiMemoryMigrationStatusResult =
          state.status === 'present'
            ? { receipt: 'present', concludedAt: state.receipt.concludedAt, paths: state.receipt.paths }
            : state.status === 'absent'
              ? { receipt: 'absent' }
              : { receipt: 'error', message: state.message }
        return ok({ isProjectEnabled, status, migration })
      } catch (error) {
        return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  register(
    AI_MEMORY_IPC_CHANNELS.takeover as IpcInvokeChannel,
    async (_event, request: AiMemoryTakeoverRequest): Promise<AiMemoryIpcResult<AiMemoryTakeoverPlanView | null>> => {
      try {
        if (typeof request?.projectPath !== 'string' || !request.projectPath) {
          return failResult('invalid-request')
        }
        // squadId/survivingAgent bound + sanitizados (sem prompt bruto/carga).
        const squadId = sanitizeSnapshotText(String(request?.squadId ?? ''), 200)
        const survivingAgent = sanitizeSnapshotText(String(request?.survivingAgent ?? ''), 200)
        if (!squadId || !survivingAgent) return failResult('invalid-request')
        const pathOr = await withValidatedPath(request.projectPath)
        if (!isPathResult(pathOr)) return pathOr
        if (service.status().state !== 'running') {
          // Ausência do ai-memory NÃO impede: plano mínimo verification-first.
          return ok(fallbackTakeoverPlan({ squadId, survivingAgent }))
        }
        const gate = await readGate(pathOr)
        if (!gate.ok) return failResult(gate.reason, gate.message)
        const plan = await buildTakeoverPlan(
          syncScopeOf(gate.scope),
          gate.client,
          {
            squadId,
            survivingAgent,
            // SOMENTE o caminho canônico validado chega ao inspector Git — o
            // path cru do renderer nunca é usado como cwd de evidência.
            projectPath: pathOr,
            ...(deps.gitInspector ? { git: deps.gitInspector } : {}),
          }
        )
        return ok(plan ?? null)
      } catch (error) {
        return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  register(
    AI_MEMORY_IPC_CHANNELS.publishSquadState as IpcInvokeChannel,
    async (_event, request: { projectPath: string; snapshot: unknown }) => {
      try {
        const pathOr = await withValidatedPath(request?.projectPath)
        if (!isPathResult(pathOr)) return pathOr
        // Snapshot validado/sanitizado/redigido ANTES de qualquer escrita.
        const snapshot = sanitizeSnapshot(request?.snapshot) as SquadSnapshot | undefined
        if (!snapshot) return failResult('invalid-snapshot', 'Snapshot do squad inválido após sanitização.')
        const gate = await readGate(pathOr)
        if (!gate.ok) return failResult(gate.reason, gate.message)
        const scopeKey = `${gate.scope.workspace}/${gate.scope.project}`
        let publisher = publishers.get(scopeKey)
        if (!publisher) {
          publisher = new SquadMemoryPublisher(syncScopeOf(gate.scope), gate.client)
          publishers.set(scopeKey, publisher)
        }
        const published = await publisher.publish(snapshot)
        return ok({ path: squadStatePagePath(snapshot.id), published })
      } catch (error) {
        return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}