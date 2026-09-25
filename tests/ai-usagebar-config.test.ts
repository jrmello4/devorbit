import { describe, expect, it } from 'vitest'
import { sanitizeAiUsagebarMessage } from '../src/main/ai-usagebar-config'

describe('sanitizeAiUsagebarMessage', () => {
  it('redacts sk-* API keys', () => {
    const result = sanitizeAiUsagebarMessage('Error at sk-abc123def456ghijklmnop')
    expect(result).not.toContain('sk-abc123')
    expect(result).toContain('[redacted]')
  })

  it('redacts Windows absolute paths', () => {
    const result = sanitizeAiUsagebarMessage('Cannot read C:\\Users\\secret\\auth.json')
    expect(result).not.toContain('C:\\Users\\secret')
    expect(result).toContain('[redacted]')
  })

  it('redacts Unix absolute paths after delimiters', () => {
    const result = sanitizeAiUsagebarMessage('ENOENT /home/user/.claude/.credentials.json')
    expect(result).not.toContain('/home/user/.claude')
    expect(result).toContain('[redacted]')
  })

  it('preserves double-slash comments', () => {
    const result = sanitizeAiUsagebarMessage('config has //comment in it')
    expect(result).toContain('//comment')
  })

  it('preserves URLs with protocol', () => {
    const result = sanitizeAiUsagebarMessage('fetch from https://example.com/api')
    expect(result).toContain('https://example.com/api')
  })

  it('redacts Bearer tokens', () => {
    const result = sanitizeAiUsagebarMessage('Authorization: Bearer abcdef1234567890')
    expect(result).not.toContain('abcdef1234567890')
  })

  it('redacts api_key= patterns', () => {
    const result = sanitizeAiUsagebarMessage('env has api_key=secretvalue12345')
    expect(result).not.toContain('secretvalue12345')
  })

  it('truncates long messages to maxChars', () => {
    const long = 'x'.repeat(500)
    const result = sanitizeAiUsagebarMessage(long, 100)
    expect(result.length).toBeLessThanOrEqual(100)
    expect(result).toContain('…')
  })

  it('handles non-string input', () => {
    const result = sanitizeAiUsagebarMessage(42)
    expect(typeof result).toBe('string')
  })

  it('collapses whitespace', () => {
    const result = sanitizeAiUsagebarMessage('too   many    spaces')
    expect(result).toBe('too many spaces')
  })
})
