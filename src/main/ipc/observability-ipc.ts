import path from 'node:path'
import { auditProject } from '../audit-engine'
import type { EvolutionStore } from '../evolution-store'
import type { HITLManager, HitlRequest } from '../hitl'
import { completeLlm } from '../llm-runtime'
import { validateProjectPath } from '../project-paths'
import {
  listProjectHybridMemory,
  rememberProjectHybridMemory,
  searchProjectHybridMemory,
} from '../project-hybrid-memory'
import { runProcess } from '../process-runner'
import { RipgrepIndexer } from '../ripgrep-indexer'
import type { Telemetry } from '../telemetry'
import { loadConfig } from '../config'
import { createGainReport } from '../../shared/gain-report'
import type { AuditSnapshot } from '../../shared/audit-contract'
import type { DiagnosticProcessRequest, DiagnosticProcessResult } from '../../shared/diagnostic-process'
import type { EvolutionRecord } from '../../shared/evolution-history'
import type { HybridMemoryKind, HybridMemoryWrite } from '../../shared/hybrid-memory-contract'
import type { LlmCompletionRequestView } from '../../shared/llm-contract'
import type { TextSearchRequest, TextSearchResult } from '../../shared/text-search-contract'
import type { IpcRegistrar } from './registrar'

export interface ObservabilityIpcDependencies {
  evolutionStore: EvolutionStore
  telemetry: Telemetry
  hitl: HITLManager
  sanitizeHitlRequest: (request: HitlRequest) => HitlRequest
}

const DIAGNOSTIC_COMMANDS = new Set(['git', 'git.exe', 'npm', 'npm.cmd', 'node', 'node.exe', 'rg', 'rg.exe'])

export function validateDiagnosticRequest(input: unknown): DiagnosticProcessRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Diagnóstico inválido.')
  const value = input as Record<string, unknown>
  if (typeof value.command !== 'string' || !DIAGNOSTIC_COMMANDS.has(path.basename(value.command).toLowerCase())) {
    throw new Error('Comando de diagnóstico não permitido.')
  }
  if (typeof value.projectPath !== 'string') throw new Error('Projeto de diagnóstico inválido.')
  if (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 32 || value.args.some((item) => typeof item !== 'string' || item.length > 4096))) {
    throw new Error('Argumentos de diagnóstico inválidos.')
  }
  if (value.timeoutMs !== undefined && (typeof value.timeoutMs !== 'number' || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 5_000 || value.timeoutMs > 120_000)) {
    throw new Error('Timeout de diagnóstico inválido.')
  }
  return {
    command: value.command,
    ...(Array.isArray(value.args) ? { args: value.args as string[] } : {}),
    projectPath: value.projectPath,
    ...(value.timeoutMs !== undefined ? { timeoutMs: value.timeoutMs as number } : {}),
  }
}

export function registerObservabilityIpc(register: IpcRegistrar, dependencies: ObservabilityIpcDependencies): void {
  const { evolutionStore, telemetry, hitl } = dependencies

  register('devorbit:getProjectAudit', async (_event, projectPath: string) => {
    const snapshot = await auditProject(await validateProjectPath(projectPath))
    const previous = (await evolutionStore.list({ kind: 'baseline', limit: 20 })).reverse().find((record) => record.data.projectPath === snapshot.projectPath)
    const previousSnapshot = previous?.data.snapshot
    if (previousSnapshot && typeof previousSnapshot === 'object' && !Array.isArray(previousSnapshot)) {
      const gain = createGainReport(previousSnapshot as unknown as AuditSnapshot, snapshot)
      await evolutionStore.recordGain({ projectPath: snapshot.projectPath, report: gain })
    }
    await evolutionStore.recordBaseline({ projectPath: snapshot.projectPath, snapshot })
    return snapshot
  })

  register('devorbit:getEvolutionHistory', async (_event, limit?: unknown): Promise<EvolutionRecord[]> => {
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200)) throw new Error('Limite de histórico inválido.')
    return await evolutionStore.latest(limit ?? 50)
  })

  register('devorbit:runDiagnostic', async (_event, input: unknown): Promise<DiagnosticProcessResult> => {
    const request = validateDiagnosticRequest(input)
    const safePath = await validateProjectPath(request.projectPath)
    const approval = await hitl.request({
      prompt: `Autorizar diagnóstico ${path.basename(request.command)} no projeto ${path.basename(safePath)}?`,
      metadata: {
        operation: 'process.run',
        command: path.basename(request.command),
        args: request.args?.join(' ').slice(0, 300) || '[sem argumentos]',
        project: path.basename(safePath),
      },
    })
    if (approval.state !== 'approved') throw new Error(`Diagnóstico ${approval.state}.`)
    return await runProcess({
      command: request.command,
      args: request.args,
      cwd: safePath,
      timeoutMs: request.timeoutMs,
    })
  })

  register('devorbit:getTelemetrySpans', (_event, limit?: unknown) => {
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500)) {
      throw new Error('Limite de telemetria inválido.')
    }
    const spans = telemetry.getSpans()
    return spans.slice(-(limit ?? 100))
  })

  register('devorbit:getHybridMemory', async (_event, projectPath: string, kind?: unknown) => {
    if (kind !== undefined && kind !== 'operational' && kind !== 'episodic' && kind !== 'reflexive') throw new Error('Tipo de memória inválido.')
    return await listProjectHybridMemory(await validateProjectPath(projectPath), kind as HybridMemoryKind | undefined)
  })

  register('devorbit:rememberHybridMemory', async (_event, projectPath: string, input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Memória híbrida inválida.')
    const value = input as Record<string, unknown>
    if (value.kind !== 'operational' && value.kind !== 'episodic' && value.kind !== 'reflexive') throw new Error('Tipo de memória inválido.')
    if (typeof value.content !== 'string' || !value.content.trim() || value.content.length > 20_000) throw new Error('Conteúdo de memória inválido.')
    if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > 32 || value.tags.some((tag) => typeof tag !== 'string' || tag.length > 100))) throw new Error('Tags de memória inválidas.')
    const safeInput: HybridMemoryWrite = {
      kind: value.kind,
      content: value.content,
      ...(Array.isArray(value.tags) ? { tags: value.tags as string[] } : {}),
      ...(value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata) ? { metadata: value.metadata as Record<string, unknown> } : {}),
    }
    return await rememberProjectHybridMemory(await validateProjectPath(projectPath), safeInput)
  })

  register('devorbit:searchHybridMemory', async (_event, projectPath: string, query: unknown, limit?: unknown) => {
    if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new Error('Consulta de memória inválida.')
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)) throw new Error('Limite de memória inválido.')
    return await searchProjectHybridMemory(await validateProjectPath(projectPath), query, limit as number | undefined)
  })

  register('devorbit:completeLlm', async (_event, input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Solicitação LLM inválida.')
    const value = input as Record<string, unknown>
    if (!Array.isArray(value.messages) || value.messages.length === 0 || value.messages.length > 64) throw new Error('Mensagens LLM inválidas.')
    if (value.messages.some((message) => !message || typeof message !== 'object' || Array.isArray(message) || !['system', 'user', 'assistant'].includes((message as Record<string, unknown>).role as string) || typeof (message as Record<string, unknown>).content !== 'string' || ((message as Record<string, unknown>).content as string).length > 20_000)) {
      throw new Error('Conteúdo das mensagens LLM inválido.')
    }
    if (value.maxOutputTokens !== undefined && (typeof value.maxOutputTokens !== 'number' || !Number.isInteger(value.maxOutputTokens) || value.maxOutputTokens < 1 || value.maxOutputTokens > 32_000)) throw new Error('Limite de saída LLM inválido.')
    const request = value as unknown as LlmCompletionRequestView
    return await completeLlm(await loadConfig(), request)
  })

  register('devorbit:searchProjectText', async (_event, input: unknown): Promise<TextSearchResult> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Busca textual inválida.')
    const value = input as Record<string, unknown>
    if (typeof value.projectPath !== 'string' || typeof value.query !== 'string' || !value.query.trim() || value.query.length > 500) throw new Error('Consulta textual inválida.')
    if (value.globs !== undefined && (!Array.isArray(value.globs) || value.globs.length > 20 || value.globs.some((glob) => typeof glob !== 'string' || glob.length > 200))) throw new Error('Filtros de busca inválidos.')
    if (value.maxResults !== undefined && (typeof value.maxResults !== 'number' || !Number.isInteger(value.maxResults) || value.maxResults < 1 || value.maxResults > 500)) throw new Error('Limite de busca inválido.')
    const request = value as unknown as TextSearchRequest
    const safePath = await validateProjectPath(request.projectPath)
    const indexer = new RipgrepIndexer({ maxResults: request.maxResults })
    try {
      return await indexer.search({ root: safePath, query: request.query, fixedStrings: request.fixedStrings === true, ignoreCase: request.ignoreCase === true, globs: request.globs, maxResults: request.maxResults })
    } finally {
      indexer.dispose()
    }
  })

  register('devorbit:getHitlRequests', () => hitl.listRequests().map(dependencies.sanitizeHitlRequest))

  register('devorbit:approveHitl', (_event, id: unknown, reason?: unknown) => {
    if (typeof id !== 'string' || id.trim().length === 0) throw new Error('ID de aprovação inválido.')
    if (reason !== undefined && typeof reason !== 'string') throw new Error('Motivo de aprovação inválido.')
    return dependencies.sanitizeHitlRequest(hitl.approve(id, reason === undefined ? {} : { reason }))
  })

  register('devorbit:rejectHitl', (_event, id: unknown, reason?: unknown) => {
    if (typeof id !== 'string' || id.trim().length === 0) throw new Error('ID de aprovação inválido.')
    if (reason !== undefined && typeof reason !== 'string') throw new Error('Motivo de rejeição inválido.')
    return dependencies.sanitizeHitlRequest(hitl.reject(id, reason === undefined ? {} : { reason }))
  })
}
