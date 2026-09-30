import { beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'

const electronPaths = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  default: {
    app: { getPath: () => electronPaths.userData },
  },
}))

const { spawnPtyMock } = vi.hoisted(() => ({ spawnPtyMock: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: spawnPtyMock }))

import { normalizeAgentInstructionPayload, normalizeAgentTurnPrompt } from '../src/main/ipc/terminal-ipc'
import { TURN_MAX_PROMPT_CHARS } from '../src/main/agent-turn'
import { composeAgentPrompt } from '../src/renderer/src/components/WorkspaceCanvas'

beforeEach(() => {
  electronPaths.userData = os.tmpdir()
})

describe('normalizeAgentTurnPrompt (canvas → IPC)', () => {
  it('teto do turno é 65_536 (64 KiB): protege contra acidentes, não contra handoffs completos', () => {
    expect(TURN_MAX_PROMPT_CHARS).toBe(65_536)
  })

  it('aceita 60k chars integralmente (handoff completo do canvas)', () => {
    const long = 'x'.repeat(60_000)
    expect(normalizeAgentTurnPrompt(long)).toBe(long)
    expect(normalizeAgentTurnPrompt(long)).toHaveLength(60_000)
  })

  it('trunca em 65_536 em vez de rejeitar a tarefa do canvas', () => {
    const long = 'x'.repeat(70_000)
    const normalized = normalizeAgentTurnPrompt(long)
    expect(normalized.length).toBe(65_536)
    expect(normalized).toBe(long.slice(0, 65_536))
  })

  it('preserva prompts dentro do limite', () => {
    expect(normalizeAgentTurnPrompt('tarefa objetiva')).toBe('tarefa objetiva')
  })

  it('rejeita prompt vazio ou não-string', () => {
    expect(() => normalizeAgentTurnPrompt('   ')).toThrow(/Prompt/)
    expect(() => normalizeAgentTurnPrompt(42)).toThrow(/Prompt/)
    expect(() => normalizeAgentTurnPrompt(undefined)).toThrow(/Prompt/)
  })

  it('preserva a instrução DEVORBIT_RESULT ao truncar prompt gigante do canvas', () => {
    const prompt = composeAgentPrompt([
      'Você atua como Revisão neste projeto.',
      '## Tarefa e contexto conectado',
      'nota: ' + 'a'.repeat(80_000),
    ])
    expect(prompt.length).toBeGreaterThan(65_536)

    const normalized = normalizeAgentTurnPrompt(prompt)
    expect(normalized.length).toBe(65_536)
    expect(normalized).toContain('DEVORBIT_RESULT')
    // A instrução abre o prompt; o truncamento corta só o corpo de notas.
    expect(normalized.indexOf('DEVORBIT_RESULT')).toBeLessThan(200)
    // O corpo excedente foi cortado, não a instrução.
    expect(normalized).not.toContain('a'.repeat(80_000))
  })
})

describe('normalizeAgentInstructionPayload (canal devorbit:submitAgentInstruction)', () => {
  it('aceita payload válido preservando o conteúdo verbatim (multiline incluída)', () => {
    const payload = normalizeAgentInstructionPayload({
      turnId: ' task-9 ',
      content: 'linha 1\nlinha 2\nDEVORBIT_RESULT: ...',
    })
    expect(payload.turnId).toBe('task-9')
    expect(payload.content).toBe('linha 1\nlinha 2\nDEVORBIT_RESULT: ...')
  })

  it('rejeita payload malformado (não-objeto, turnId vazio, conteúdo vazio)', () => {
    expect(() => normalizeAgentInstructionPayload(null)).toThrow(/instrução/i)
    expect(() => normalizeAgentInstructionPayload('tarefa')).toThrow(/instrução/i)
    expect(() => normalizeAgentInstructionPayload({ content: 'tarefa' })).toThrow(/turnId/i)
    expect(() => normalizeAgentInstructionPayload({ turnId: 'task-1' })).toThrow(/conteúdo/i)
    expect(() => normalizeAgentInstructionPayload({ turnId: 'task-1', content: '   ' })).toThrow(/conteúdo/i)
  })

  it('trunca turnId e conteúdo no mesmo teto do turno (65_536)', () => {
    const payload = normalizeAgentInstructionPayload({
      turnId: 't'.repeat(500),
      content: 'x'.repeat(70_000),
    })
    expect(payload.turnId.length).toBe(128)
    expect(payload.content.length).toBe(65_536)
  })

  it('não corta conteúdo de 60k (handoff completo chega verbatim ao canal)', () => {
    const payload = normalizeAgentInstructionPayload({
      turnId: 'task-60k',
      content: 'y'.repeat(60_000),
    })
    expect(payload.content).toHaveLength(60_000)
  })
})
