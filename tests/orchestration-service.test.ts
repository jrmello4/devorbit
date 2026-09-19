import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createEmptyOrchestrationState,
  type ContinuityEvent,
  type OrchestrationState,
} from '../src/shared/orchestration-continuity'
import { createOrchestrationService, type OrchestrationServiceDependencies } from '../src/main/orchestration-service'
import { readOrchestrationState } from '../src/main/orchestration-store'

function memoryStore() {
  const states = new Map<string, OrchestrationState>()
  const readState = async (projectPath: string): Promise<OrchestrationState> =>
    states.get(projectPath) ?? createEmptyOrchestrationState(projectPath)
  const writeState = async (projectPath: string, state: OrchestrationState): Promise<void> => {
    states.set(projectPath, state)
  }
  return { states, readState, writeState }
}

function deps(overrides: Partial<OrchestrationServiceDependencies> = {}) {
  const store = memoryStore()
  const events: ContinuityEvent[] = []
  const handoffs: unknown[] = []
  let now = 1_000
  let sequence = 0
  const service = createOrchestrationService({
    readState: store.readState,
    writeState: store.writeState,
    onEvent: (event) => events.push(event),
    onHandoff: (handoff) => handoffs.push(handoff),
    now: () => now,
    id: () => `evt-${++sequence}`,
    ...overrides,
  })
  return { service, store, events, handoffs, advance: (ms: number) => { now += ms } }
}

async function seed(service: ReturnType<typeof deps>['service']) {
  await service.bindProject('project')
  await service.upsertSeat({ id: 'coord', provider: 'codex', account: 'account1', role: 'coordinator' })
  await service.upsertSeat({ id: 'impl', provider: 'codex', account: 'account2', role: 'implementer' })
  await service.upsertSeat({ id: 'review', provider: 'agy', role: 'reviewer' })
  await service.assignRole('coordinator', 'coord')
  await service.assignRole('implementer', 'impl')
  await service.assignRole('reviewer', 'review')
}

describe('orchestration service · opt-in, quota e handoff', () => {
  it('não faz handoff por quota quando a continuidade está desligada', async () => {
    const { service, handoffs } = deps()
    await seed(service)
    const state = await service.reportQuota('coord', { status: 'exhausted', source: 'codex-oauth', observedAt: new Date().toISOString() })
    expect(state?.seats.coord.quota.status).toBe('exhausted')
    expect(handoffs).toHaveLength(0)
    expect(state?.roles.coordinator.seatId).toBe('coord')
  })

  it('elege substituto para o mesmo papel quando habilitada', async () => {
    const { service, handoffs } = deps()
    await seed(service)
    await service.setEnabled(true)
    const state = await service.reportQuota('coord', { status: 'exhausted', source: 'codex-oauth', observedAt: new Date().toISOString() })

    expect(handoffs).toHaveLength(1)
    expect(handoffs[0]).toMatchObject({ role: 'coordinator', fromSeatId: 'coord', toSeatId: 'impl' })
    expect(state?.roles.coordinator.seatId).toBe('impl')
    expect(state?.roles.implementer.seatId).toBeUndefined()
    expect(state?.seats.review.role).toBe('reviewer')
  })

  it('handoff retoma a próxima ação sintetizada do checkpoint (e2e)', async () => {
    const { service, handoffs } = deps()
    await seed(service)
    await service.reportTurnResult({ seatId: 'coord', role: 'coordinator', outcome: 'completed', summary: 'Plano inicial validado' })
    await service.setEnabled(true)
    const state = await service.reportQuota('coord', { status: 'exhausted', source: 'codex-oauth', observedAt: new Date().toISOString() })

    expect(handoffs).toHaveLength(1)
    const handoff = handoffs[0] as { role: string; toSeatId: string; nextAction?: { prompt: string } }
    expect(handoff).toMatchObject({ role: 'coordinator', toSeatId: 'impl' })
    expect(handoff.nextAction?.prompt).toContain('Plano inicial validado')
    expect(state?.nextAction?.prompt).toContain('Plano inicial validado')
    // Quem não trocou permanece intacto; nenhum sinal de encerramento.
    expect(state?.seats.review.role).toBe('reviewer')
  })

  it('marca falha transitória como quota esgotada e aciona handoff', async () => {
    const { service, handoffs } = deps()
    await seed(service)
    await service.setEnabled(true)
    const state = await service.reportTurnResult({
      seatId: 'coord',
      role: 'coordinator',
      outcome: 'failed',
      summary: 'rate limit 429',
      transient: true,
    })
    expect(state?.seats.coord.quota.status).toBe('exhausted')
    expect(handoffs).toHaveLength(1)
  })

  it('grava checkpoint com o resultado do turno', async () => {
    const { service } = deps()
    await seed(service)
    const state = await service.reportTurnResult({ seatId: 'coord', role: 'coordinator', outcome: 'completed', summary: 'plano pronto' })
    expect(state?.checkpoint).toMatchObject({ role: 'coordinator', summary: 'plano pronto' })
  })

  it('mapeia uso real do Codex por conta para o assento', async () => {
    const { service } = deps()
    await seed(service)
    const state = await service.reportCodexUsage({
      source: 'codex-oauth',
      fetchedAt: new Date().toISOString(),
      accounts: {
        account1: { account: 'account1', status: 'ready', metrics: [{ id: 'primary', label: 'Janela', percent: 97 }] },
        account2: { account: 'account2', status: 'ready', metrics: [{ id: 'primary', label: 'Janela', percent: 20 }] },
      },
    })
    expect(state?.seats.coord.quota).toMatchObject({ status: 'exhausted', percent: 97 })
    expect(state?.seats.impl.quota).toMatchObject({ status: 'ok', percent: 20 })
  })
})

describe('orchestration service · persistência ativa por padrão', () => {
  let projectDir = ''
  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-orchestration-service-'))
  })
  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true })
  })

  it('persiste em .devorbit/orchestration.json sem injetar writeState', async () => {
    const service = createOrchestrationService({
      onEvent: () => undefined,
      now: () => 1_000,
      id: () => 'evt-1',
    })
    await service.bindProject(projectDir)
    await service.setEnabled(true)
    await service.upsertSeat({ id: 'agent-1', provider: 'codex', role: 'coordinator' })

    const persisted = await readOrchestrationState(projectDir)
    expect(persisted.policy.enabled).toBe(true)
    expect(persisted.seats['agent-1']).toMatchObject({ provider: 'codex', role: 'coordinator' })
  })

  it('não escreve quando nenhum projeto está vinculado', async () => {
    const { service, store } = deps()
    const outcome = await service.setEnabled(true)
    expect(outcome).toBeNull()
    expect(store.states.size).toBe(0)
  })
})
