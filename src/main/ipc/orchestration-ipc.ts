import {
  ORCHESTRATION_ROLES,
  type ContinuityQuota,
  type OrchestrationRole,
} from '../../shared/orchestration-continuity'
import { validateProjectPath } from '../project-paths'
import { isAgentProviderId } from '../validation'
import type { OrchestrationService } from '../orchestration-service'
import type { IpcRegistrar } from './registrar'

export interface OrchestrationIpcDependencies {
  service: OrchestrationService
}

function assertRole(value: unknown): OrchestrationRole {
  if (typeof value !== 'string' || !(ORCHESTRATION_ROLES as readonly string[]).includes(value)) {
    throw new Error('Papel de orquestração inválido.')
  }
  return value as OrchestrationRole
}

function assertSeatId(value: unknown, label = 'Assento'): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || value.includes('\0')) {
    throw new Error(`${label} inválido.`)
  }
  return value.trim()
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Texto inválido.')
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, max)
}

function quotaFromPercent(percent: number | undefined, observedAt: string): ContinuityQuota {
  if (percent === undefined) {
    return { status: 'unknown', source: 'manual', observedAt }
  }
  return {
    status: percent >= 95 ? 'exhausted' : percent >= 80 ? 'warning' : 'ok',
    source: 'manual',
    percent,
    observedAt,
  }
}

export function registerOrchestrationIpc(register: IpcRegistrar, dependencies: OrchestrationIpcDependencies): void {
  const { service } = dependencies

  register('devorbit:getOrchestrationState', async (_event, projectPath: unknown) => {
    return (await service.bindProject(await validateProjectPath(projectPath))) ?? null
  })

  register('devorbit:setOrchestrationContinuity', async (_event, projectPath: unknown, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Estado de continuidade inválido.')
    await service.bindProject(await validateProjectPath(projectPath))
    return await service.setEnabled(enabled)
  })

  register('devorbit:upsertOrchestrationSeat', async (_event, projectPath: unknown, input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Assento inválido.')
    const value = input as Record<string, unknown>
    const id = assertSeatId(value.id)
    if (!isAgentProviderId(value.provider)) throw new Error('Provider do assento inválido.')
    const role = assertRole(value.role)
    const account = value.account === 'account1' || value.account === 'account2' ? value.account : undefined
    const model = optionalText(value.model, 200)
    const tier = value.tier === 'fast' || value.tier === 'deep' ? value.tier : undefined
    await service.bindProject(await validateProjectPath(projectPath))
    return await service.upsertSeat({
      id,
      provider: value.provider,
      role,
      ...(account ? { account } : {}),
      ...(model ? { model } : {}),
      ...(tier ? { tier } : {}),
    })
  })

  register('devorbit:removeOrchestrationSeat', async (_event, projectPath: unknown, seatId: unknown) => {
    await service.bindProject(await validateProjectPath(projectPath))
    return await service.removeSeat(assertSeatId(seatId))
  })

  register('devorbit:assignOrchestrationRole', async (_event, projectPath: unknown, role: unknown, seatId: unknown) => {
    const safeRole = assertRole(role)
    const safeSeatId = seatId === undefined || seatId === null ? undefined : assertSeatId(seatId)
    await service.bindProject(await validateProjectPath(projectPath))
    return await service.assignRole(safeRole, safeSeatId)
  })

  register('devorbit:reportOrchestrationTurn', async (_event, projectPath: unknown, input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Relatório de turno inválido.')
    const value = input as Record<string, unknown>
    const seatId = assertSeatId(value.seatId)
    if (value.outcome !== 'completed' && value.outcome !== 'blocked' && value.outcome !== 'failed') {
      throw new Error('Desfecho de turno inválido.')
    }
    const role = value.role === undefined || value.role === null ? undefined : assertRole(value.role)
    const summary = optionalText(value.summary, 1_000)
    const branch = optionalText(value.branch, 200)
    const commit = optionalText(value.commit, 200)
    await service.bindProject(await validateProjectPath(projectPath))
    return await service.reportTurnResult({
      seatId,
      outcome: value.outcome,
      transient: value.transient === true,
      ...(role ? { role } : {}),
      ...(summary ? { summary } : {}),
      ...(branch ? { branch } : {}),
      ...(commit ? { commit } : {}),
    })
  })

  register('devorbit:reportOrchestrationQuota', async (_event, projectPath: unknown, seatId: unknown, percent: unknown) => {
    const safeSeatId = assertSeatId(seatId)
    if (percent !== undefined && percent !== null && (typeof percent !== 'number' || !Number.isFinite(percent))) {
      throw new Error('Percentual de quota inválido.')
    }
    const bounded = typeof percent === 'number' ? Math.min(100, Math.max(0, percent)) : undefined
    await service.bindProject(await validateProjectPath(projectPath))
    return await service.reportQuota(safeSeatId, quotaFromPercent(bounded, new Date().toISOString()))
  })
}
