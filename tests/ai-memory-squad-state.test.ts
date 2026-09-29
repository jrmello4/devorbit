import { describe, expect, it } from 'vitest'
import {
  extractAiMemoryPageBody,
  legacySquadStatePagePath,
  squadStatePagePath,
} from '../src/main/ai-memory-squad-state'

describe('ai-memory-squad-state (módulo neutro)', () => {
  describe('paths do snapshot do squad', () => {
    it('squadStatePagePath gera o path canônico com slug e extensão .md', () => {
      expect(squadStatePagePath('squad-1')).toBe('squads/squad-1/state.md')
    })

    it('squadStatePagePath sanitiza caracteres inválidos e limita o slug', () => {
      expect(squadStatePagePath('Squad A/B')).toBe('squads/squad-a-b/state.md')
      expect(squadStatePagePath('***')).toBe('squads/squad/state.md')
      expect(squadStatePagePath(`${'a'.repeat(100)} b`)).toBe(
        `squads/${'a'.repeat(80)}/state.md`
      )
    })

    it('legacySquadStatePagePath gera o path legado (v1.0.43) sem extensão', () => {
      expect(legacySquadStatePagePath('squad-1')).toBe('squads/squad-1/state')
      expect(legacySquadStatePagePath('Squad A/B')).toBe('squads/squad-a-b/state')
    })
  })

  describe('extractAiMemoryPageBody', () => {
    it('usa o body do JSON quando é string', () => {
      expect(
        extractAiMemoryPageBody({ text: '{"body":"estado"}', json: { path: 'p', body: 'estado' }, isError: false })
      ).toBe('estado')
    })

    it('devolve vazio em erro, JSON sem body string, e cai para text sem json', () => {
      expect(extractAiMemoryPageBody({ text: 'qualquer', json: { body: 'x' }, isError: true })).toBe('')
      expect(extractAiMemoryPageBody({ text: '{"body":1}', json: { body: 1 }, isError: false })).toBe('')
      expect(extractAiMemoryPageBody({ text: 'texto cru', isError: false })).toBe('texto cru')
    })
  })
})
