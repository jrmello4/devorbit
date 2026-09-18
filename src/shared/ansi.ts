/**
 * Limpeza de sequências de escape ECMA-48 usada em qualquer texto que venha
 * de um PTY. Além de CSI (7 e 8 bits) e OSC, cobre as sequências de string
 * DCS/SOS/PM/APC — antes só o introduzidor era removido e o payload vazava —
 * e os escapes de dois caracteres (Fe). Sequências não terminadas perdem
 * apenas o introduzidor: o restante continua sujeito às validações de quem
 * chama, nunca é silenciosamente engolido.
 */

const ANSI_ESCAPE_PATTERN = new RegExp(
  [
    // CSI: introduzidor 7/8 bits, parâmetros 0x30-0x3F, intermediários 0x20-0x2F, final 0x40-0x7E.
    '(?:\\u001B\\[|\\u009B)[0-?]*[ -/]*[@-~]',
    // OSC: introduzidor 7/8 bits, payload até BEL, ST (ESC \) ou ST de 8 bits.
    '(?:\\u001B\\]|\\u009D)[^\\u0007\\u001B\\u009C]*(?:\\u0007|\\u001B\\\\|\\u009C)',
    // DCS/SOS/PM/APC 7 e 8 bits: payload até ST.
    '(?:\\u001B[PX^_]|[\\u0090\\u0098\\u009E\\u009F])[^\\u001B\\u009C]*(?:\\u001B\\\\|\\u009C)',
    // Escapes de um byte (Fp/Fe) e com intermediários (designações), incluindo
    // introduzidores truncados: nunca deixa o ESC cru no texto.
    '\\u001B[ -/]*[0-~]',
  ].join('|'),
  'g',
)

/** Remove sequências de escape ECMA-48, preservando o texto imprimível. */
export function stripAnsiEscapes(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, '')
}
