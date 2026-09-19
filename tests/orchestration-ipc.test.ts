import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createEmptyOrchestrationState,
  type OrchestrationState,
} from '../src/shared/orchestration-continuity'
import { validateProjectPath } from '../src/main/project-paths'

vi.mock('../src/main/project-paths', () => ({
  validateProjectPath: vi.fn(async (value: unknown) => String(value)),
}))

import { registerOrchestrationIpc } from '../src/main/ipc/orchestration-ipc'
import { createOrchestrationService } from '../src/main/orchestration-service'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const states = new Map<string, OrchestrationState>()

function buildHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  const service = createOrchestrationService({
    readState: async (projectPath) => states.get(projectPath) ?? createEmptyOrchestrationState(projectPath),
    writeState: async (projectPath, state) => {
      states.set(projectPath, state)
    },
    onEvent: () => undefined,
    now: () => 1_000,
    id: () => 'evt-1',
  })
  registerOrchestrationIpc(
    ((channel: string, handler: Handler) => handlers.set(channel, handler)) as never,
    { service },
  )
  return handlers
}

let handlers: Map<string, Handler>

beforeEach(() => {
  states.clear()
  handlers = buildHandlers()
})

function handler(channel: string): Handler {
  const found = handlers.get(channel)
  if (!found) throw new Error(`Handler ausente: ${channel}`)
  return found
}

describe('orchestration IPC · contrato projectPath primeiro', () => {
  it('getOrchestrationState valida o projeto e devolve o estado', async () => {
    const state = (await handler('devorbit:getOrchestrationState')(null, 'C:/project')) as OrchestrationState
    expect(validateProjectPath).toHaveBeenCalledWith('C:/project')
    expect(state.policy.enabled).toBe(false)
  })

  it('setOrchestrationContinuity exige boolean e alterna o opt-in', async () => {
    const state = (await handler('devorbit:setOrchestrationContinuity')(null, 'C:/project', true)) as OrchestrationState
    expect(state.policy.enabled).toBe(true)
    await expect(handler('devorbit:setOrchestrationContinuity')(null, 'C:/project', 'yes')).rejects.toThrow()
  })

  it('upsertOrchestrationSeat registra e removeOrchestrationSeat limpa', async () => {
    const created = (await handler('devorbit:upsertOrchestrationSeat')(null, 'C:/project', {
      id: 'agent-1',
      provider: 'codex',
      account: 'account1',
      role: 'coordinator',
    })) as OrchestrationState
    expect(created.seats['agent-1']).toMatchObject({ provider: 'codex', account: 'account1', role: 'coordinator' })

    const removed = (await handler('devorbit:removeOrchestrationSeat')(null, 'C:/project', 'agent-1')) as OrchestrationState
    expect(removed.seats['agent-1']).toBeUndefined()

    await expect(
      handler('devorbit:upsertOrchestrationSeat')(null, 'C:/project', { id: 'x', provider: 'invalido', role: 'coordinator' }),
    ).rejects.toThrow(/Provider/)
  })

  it('assignOrchestrationRole liga papel e assento', async () => {
    await handler('devorbit:upsertOrchestrationSeat')(null, 'C:/project', { id: 'agent-1', provider: 'agy', role: 'reviewer' })
    const state = (await handler('devorbit:assignOrchestrationRole')(null, 'C:/project', 'reviewer', 'agent-1')) as OrchestrationState
    expect(state.roles.reviewer.seatId).toBe('agent-1')
    await expect(handler('devorbit:assignOrchestrationRole')(null, 'C:/project', 'papel-errado', 'agent-1')).rejects.toThrow()
  })

  it('reportOrchestrationTurn registra checkpoint e desfecho', async () => {
    await handler('devorbit:upsertOrchestrationSeat')(null, 'C:/project', { id: 'agent-1', provider: 'codex', role: 'coordinator' })
    const state = (await handler('devorbit:reportOrchestrationTurn')(null, 'C:/project', {
      seatId: 'agent-1',
      role: 'coordinator',
      outcome: 'completed',
      summary: 'plano concluído',
    })) as OrchestrationState
    expect(state.checkpoint).toMatchObject({ role: 'coordinator', summary: 'plano concluído' })
    await expect(
      handler('devorbit:reportOrchestrationTurn')(null, 'C:/project', { seatId: 'agent-1', outcome: 'invalido' }),
    ).rejects.toThrow()
  })

  it('reportOrchestrationQuota valida percentual e atualiza quota', async () => {
    await handler('devorbit:upsertOrchestrationSeat')(null, 'C:/project', { id: 'agent-1', provider: 'codex', account: 'account1', role: 'coordinator' })
    const state = (await handler('devorbit:reportOrchestrationQuota')(null, 'C:/project', 'agent-1', 99)) as OrchestrationState
    expect(state.seats['agent-1'].quota).toMatchObject({ status: 'exhausted', percent: 99 })
    await expect(handler('devorbit:reportOrchestrationQuota')(null, 'C:/project', 'agent-1', '99')).rejects.toThrow()
  })
})
