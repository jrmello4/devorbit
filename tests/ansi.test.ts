import { describe, expect, it } from 'vitest'
import { stripAnsiEscapes } from '../src/shared/ansi'

describe('shared ANSI/ECMA-48 cleanup (src/shared/ansi.ts)', () => {
  it('removes CSI with parameters, private markers and intermediates', () => {
    expect(stripAnsiEscapes('\u001b[31mvermelho\u001b[0m')).toBe('vermelho')
    expect(stripAnsiEscapes('\u001b[38:5:196mcor\u001b[m')).toBe('cor')
    expect(stripAnsiEscapes('\u001b[?25lcursor\u001b[?25h')).toBe('cursor')
    expect(stripAnsiEscapes('\u001b[<1;2mprivado\u001b[>0m')).toBe('privado')
    expect(stripAnsiEscapes('\u001b[1;2 mcom intermediário')).toBe('com intermediário')
  })

  it('removes 8-bit CSI introducers', () => {
    expect(stripAnsiEscapes('\u009b32mverde\u009b0m')).toBe('verde')
  })

  it('removes OSC terminated by BEL, ST and 8-bit ST', () => {
    expect(stripAnsiEscapes('\u001b]0;título da janela\u0007texto')).toBe('texto')
    expect(stripAnsiEscapes('\u001b]8;;https://exemplo.dev\u001b\\link\u001b]8;;\u001b\\')).toBe('link')
    expect(stripAnsiEscapes('\u009d0;título\u009ctexto')).toBe('texto')
  })

  it('removes DCS, SOS, PM and APC string payloads (7 e 8 bits)', () => {
    expect(stripAnsiEscapes('\u001bP1;2|payload\u001b\\texto')).toBe('texto')
    expect(stripAnsiEscapes('\u001bXpayload\u001b\\texto')).toBe('texto')
    expect(stripAnsiEscapes('\u001b^payload\u001b\\texto')).toBe('texto')
    expect(stripAnsiEscapes('\u001b_payload\u001b\\texto')).toBe('texto')
    expect(stripAnsiEscapes('\u0090payload\u009ctexto')).toBe('texto')
    expect(stripAnsiEscapes('\u0098payload\u009ctexto')).toBe('texto')
  })

  it('removes two-character escapes and keeps unterminated strings harmless', () => {
    expect(stripAnsiEscapes('\u001b7texto\u001b8')).toBe('texto')
    expect(stripAnsiEscapes('\u001bPpayload sem terminador')).toBe('payload sem terminador')
    expect(stripAnsiEscapes('\u001b]0;sem terminador')).toBe('0;sem terminador')
  })

  it('leaves printable text untouched', () => {
    expect(stripAnsiEscapes('DEVORBIT_RESULT: CONCLUIDO: tudo ok')).toBe('DEVORBIT_RESULT: CONCLUIDO: tudo ok')
    expect(stripAnsiEscapes('acentos, emoji ✅ e pontuação — intactos')).toBe('acentos, emoji ✅ e pontuação — intactos')
    expect(stripAnsiEscapes('')).toBe('')
  })
})
