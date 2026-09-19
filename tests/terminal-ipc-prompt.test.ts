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

import { normalizeAgentTurnPrompt } from '../src/main/ipc/terminal-ipc'
import { composeAgentPrompt } from '../src/renderer/src/components/WorkspaceCanvas'

beforeEach(() => {
  electronPaths.userData = os.tmpdir()
})

describe('normalizeAgentTurnPrompt (canvas → IPC)', () => {
  it('trunca no teto do turno em vez de rejeitar a tarefa do canvas', () => {
    const long = 'x'.repeat(20_000)
    const normalized = normalizeAgentTurnPrompt(long)
    expect(normalized.length).toBe(8_000)
    expect(normalized).toBe(long.slice(0, 8_000))
  })

  it('preserva prompts dentro do limite', () => {
    expect(normalizeAgentTurnPrompt('tarefa objetiva')).toBe('tarefa objetiva')
  })

  it('rejeita prompt vazio ou não-string', () => {
    expect(() => normalizeAgentTurnPrompt('   ')).toThrow(/Prompt/)
    expect(() => normalizeAgentTurnPrompt(42)).toThrow(/Prompt/)
    expect(() => normalizeAgentTurnPrompt(undefined)).toThrow(/Prompt/)
  })

  it('preserva a instrução DEVORBIT_RESULT ao truncar prompt grande do canvas', () => {
    const prompt = composeAgentPrompt([
      'Você atua como Revisão neste projeto.',
      '## Tarefa e contexto conectado',
      'nota: ' + 'a'.repeat(20_000),
    ])
    expect(prompt.length).toBeGreaterThan(8_000)

    const normalized = normalizeAgentTurnPrompt(prompt)
    expect(normalized.length).toBe(8_000)
    expect(normalized).toContain('DEVORBIT_RESULT')
    // A instrução abre o prompt; o truncamento corta só o corpo de notas.
    expect(normalized.indexOf('DEVORBIT_RESULT')).toBeLessThan(200)
    // O corpo excedente foi cortado, não a instrução.
    expect(normalized).not.toContain('a'.repeat(20_000))
  })
})
