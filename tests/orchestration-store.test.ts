import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createEmptyOrchestrationState,
  defaultContinuityPolicy,
} from '../src/shared/orchestration-continuity'
import {
  getOrchestrationFilePath,
  readOrchestrationState,
  updateOrchestrationState,
  writeOrchestrationState,
} from '../src/main/orchestration-store'
import { reportSeatFailure, setEnabled, upsertSeat, type EngineContext } from '../src/main/orchestration-engine'

let projectDir = ''
const ctx: EngineContext = { now: 1_000, id: () => 'evt' }

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-orchestration-'))
})

afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true })
})

describe('orchestration store · persistência por projeto', () => {
  it('inicia desligado (opt-in) quando não há arquivo', async () => {
    const state = await readOrchestrationState(projectDir)
    expect(state.projectId).toBeTruthy()
    expect(state.policy.enabled).toBe(false)
    expect(state.policy.preserveActiveAgents).toBe(true)
    expect(state.events).toEqual([])
  })

  it('grava e relê estado em .devorbit/orchestration.json', async () => {
    let state = await readOrchestrationState(projectDir)
    state = setEnabled(state, true, ctx).state
    state = upsertSeat(state, { id: 'agent-1', provider: 'codex', account: 'account1', role: 'coordinator' }, ctx).state
    state = reportSeatFailure(state, 'agent-1', { now: 2_000, id: () => 'evt-2' }).state

    await writeOrchestrationState(projectDir, state)
    const persistedPath = getOrchestrationFilePath(projectDir)
    expect(await fs.readFile(persistedPath, 'utf-8')).toContain('"enabled": true')

    const read = await readOrchestrationState(projectDir)
    expect(read.policy.enabled).toBe(true)
    expect(read.seats['agent-1']).toMatchObject({ provider: 'codex', account: 'account1', role: 'coordinator', failures: 1 })
  })

  it('preserva e relê o estado quando o arquivo corrompe', async () => {
    const file = getOrchestrationFilePath(projectDir)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{ isto não é json', 'utf-8')

    const state = await readOrchestrationState(projectDir)
    expect(state.policy.enabled).toBe(false)
    expect(await fs.readFile(`${file}.corrupt.bak`, 'utf-8')).toBe('{ isto não é json')
  })

  it('updateOrchestrationState aplica mutação serializada e persiste', async () => {
    const base = await readOrchestrationState(projectDir)
    await writeOrchestrationState(projectDir, setEnabled(base, true, ctx).state)
    const next = await updateOrchestrationState(projectDir, (current) =>
      upsertSeat(current, { id: 'agent-2', provider: 'agy', role: 'reviewer' }, ctx).state,
    )
    expect(next.seats['agent-2']).toBeDefined()
    const reread = await readOrchestrationState(projectDir)
    expect(reread.seats['agent-2']).toBeDefined()
    expect(reread.policy.enabled).toBe(true)
  })

  it('tolera .devorbit sendo um arquivo em vez de diretório', async () => {
    await fs.writeFile(path.join(projectDir, '.devorbit'), 'not a directory', 'utf-8')
    const state = await readOrchestrationState(projectDir)
    expect(state.policy).toEqual(defaultContinuityPolicy())
  })
})
