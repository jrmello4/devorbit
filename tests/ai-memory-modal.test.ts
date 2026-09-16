import { describe, expect, it } from 'vitest'
import { appendGitMemory } from '../src/renderer/src/components/AiMemoryModal'

describe('appendGitMemory - Preservação de notas ao puxar do Git', () => {
  it('preserva notas existentes e anexa o rascunho do Git com separador claro', () => {
    const existing = '### Notas de Arquitetura\n- Usar SQLite local\n- Evitar chamadas redundantes'
    const gitDraft = '<!-- devorbit-memory -->\n# 🧠 AI Memory & Handoff\n### 🎯 Objetivo Atual\n- Branch main'

    const result = appendGitMemory(existing, gitDraft)

    expect(result).toBe(`${existing}\n\n---\n\n${gitDraft}`)
    expect(result).toContain(existing)
    expect(result).toContain(gitDraft)
    expect(result).toContain('\n\n---\n\n')
  })

  it('adota o rascunho do Git diretamente quando não há notas prévias (conteúdo vazio)', () => {
    const gitDraft = '# 🧠 AI Memory & Handoff\n- Rascunho inicial'

    expect(appendGitMemory('', gitDraft)).toBe(gitDraft)
    expect(appendGitMemory('   \n\t  ', gitDraft)).toBe(gitDraft)
  })

  it('preserva notas existentes sem adicionar separador se o rascunho do Git for vazio', () => {
    const existing = 'Minhas anotações importantes'

    expect(appendGitMemory(existing, '')).toBe(existing)
    expect(appendGitMemory(existing, '   \n  ')).toBe(existing)
  })

  it('evita duplicação se o mesmo rascunho gerado já estiver presente nas notas', () => {
    const gitDraft = '### 🎯 Objetivo Atual\n- Branch main'
    const existing = `Notas prévias\n\n---\n\n${gitDraft}`

    const result = appendGitMemory(existing, gitDraft)

    expect(result).toBe(existing)
  })

  it('evita duplicação de traços markdown se as notas já terminam com ---', () => {
    const existing = 'Notas do projeto\n\n---'
    const gitDraft = '### 🎯 Handoff Git'

    const result = appendGitMemory(existing, gitDraft)

    expect(result).toBe('Notas do projeto\n\n---\n\n### 🎯 Handoff Git')
    expect(result).not.toContain('------')
  })

  it('evita duplicação de traços markdown se o rascunho do Git já inicia com ---', () => {
    const existing = 'Notas do projeto'
    const gitDraft = '---\n### 🎯 Handoff Git'

    const result = appendGitMemory(existing, gitDraft)

    expect(result).toBe('Notas do projeto\n\n---\n### 🎯 Handoff Git')
    expect(result).not.toContain('------')
  })

  it('retorna string vazia sem separador quando ambos forem vazios', () => {
    expect(appendGitMemory('', '')).toBe('')
    expect(appendGitMemory('   ', '   ')).toBe('')
  })
})
