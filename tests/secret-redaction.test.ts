import { describe, expect, it } from 'vitest'
import { redactTelemetryValue } from '../src/main/telemetry'
import { redactAuditValue } from '../src/main/audit-ledger'
import { redactEvolutionValue } from '../src/shared/evolution-history'

describe('value-based secret redaction', () => {
  it('redacts bearer, jwt and common api keys inside generic strings and arrays', () => {
    const samples = [
      'Authorization: Bearer abcdefghijklmnop',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'key sk-live-abcdef123456',
      'token ghp_abcdefghij1234567890',
      'glpat-abcdefgh123456',
      'npm_abcdefghij123456',
      'xoxb-abcdefghij123456',
      'api_key=sk-live-abcdef123456',
    ]

    for (const sample of samples) {
      expect(redactTelemetryValue(sample)).not.toMatch(/abcdefghijklmnop|dEJOz|sk-live-abcdef123456|ghp_abcdefghij|glpat-abcdefgh|npm_abcdefghij|xoxb-abcdefghij/u)
      expect(redactAuditValue(sample)).not.toMatch(/abcdefghijklmnop|sk-live-abcdef123456|ghp_abcdefghij/u)
      expect(redactEvolutionValue(sample)).not.toMatch(/abcdefghijklmnop|sk-live-abcdef123456|ghp_abcdefghij/u)
    }

    expect(redactTelemetryValue({ headers: ['Bearer abcdefghijklmnop'] })).toEqual({
      headers: ['Bearer [REDACTED]'],
    })
    expect(redactAuditValue({ nested: [{ note: 'api_key=sk-live-abcdef123456' }] })).toEqual({
      nested: [{ note: 'api_key=[REDACTED]' }],
    })
    expect(redactEvolutionValue(['Bearer abcdefghijklmnop'])).toEqual(['Bearer [REDACTED]'])
  })

  it('keeps placeholders and short non-secrets intact', () => {
    const safe = [
      'Bearer',
      'Bearer <token>',
      'token=***',
      'api_key=example',
      'secret=changeme',
      'use xxxx for redaction',
      'sk-ab',
      'nothing sensitive here',
    ]
    for (const sample of safe) {
      expect(redactTelemetryValue(sample)).toBe(sample)
      expect(redactAuditValue(sample)).toBe(sample)
      expect(redactEvolutionValue(sample)).toBe(sample)
    }
  })

  it('still redacts sensitive keys entirely', () => {
    expect(redactTelemetryValue({ apiKey: 'sk-live-abcdef123456' }, 'apiKey')).toBe('[REDACTED]')
    expect(redactAuditValue({ prompt: 'do not persist' }, 'prompt')).toBe('[REDACTED]')
    expect(redactEvolutionValue({ nested: { token: 'abc' } })).toEqual({ nested: { token: '[REDACTED]' } })
  })
})
