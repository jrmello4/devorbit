import { describe, expect, it } from 'vitest'
import { redactTelemetryValue } from '../src/main/telemetry'
import { redactAuditValue } from '../src/main/audit-ledger'
import { redactEvolutionValue, redactSecretText } from '../src/shared/evolution-history'

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

describe('shape-based redaction families (hardening)', () => {
  it('redacts AWS AKIA access-key IDs', () => {
    const out = redactEvolutionValue('aws_access_key_id=AKIAIOSFODNN7EXAMPLE region=us-east-1')
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(out).toContain('aws_access_key_id=[REDACTED]')
    expect(out).toContain('region=us-east-1')
    // Vizinhos de forma parecida mas sem o shape AKIA permanecem intactos.
    expect(redactEvolutionValue('ASIAIOSFODNN7EXAMPLE')).toBe('ASIAIOSFODNN7EXAMPLE')
  })

  it('redacts Google AIza API keys', () => {
    const key = `AIza${'A1-b_z9'.repeat(5)}` // 35 chars na classe [0-9A-Za-z_-]
    const out = redactEvolutionValue(`google api key ${key} no fim`)
    expect(out).not.toContain(key)
    expect(out).toContain('[REDACTED] no fim')
    // Menos de 35 chars não é redigido (forma incompleta = não-chave).
    expect(redactEvolutionValue('AIzaSyABC123')).toBe('AIzaSyABC123')
  })

  it('redacts sk_live/rk_live/sk_test underscore forms without touching neighbors', () => {
    for (const token of ['sk_live_abcdefghijklmnop', 'rk_live_abcdefghijklmnop', 'sk_test_abcdefghijklmnop']) {
      expect(redactEvolutionValue(`charge ${token} ok`)).toBe('charge [REDACTED] ok')
    }
    // Prefixo parecido dentro de palavra não recebe boundary → intacto.
    expect(redactEvolutionValue('risk_test_abcdefghijklmnop')).toBe('risk_test_abcdefghijklmnop')
    // Família com traço: comportamento PRÉ-EXISTENTE — o padrão `sk-…` com
    // classe greedy redige o token INTEIRO (sem segmentação).
    expect(redactEvolutionValue('sk-ant-api03-abcdefghij')).toBe('[REDACTED]')
  })

  it('redacts complete PEM/OpenSSH private-key blocks (multiline) and keeps partial blocks', () => {
    const body = [
      'config anterior preservada',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG9jYXN0ZXI=',
      'trailing comment line with words',
      '-----END OPENSSH PRIVATE KEY-----',
      'config posterior preservada',
    ].join('\n')
    const out = redactSecretText(body)
    expect(out).toContain('config anterior preservada')
    expect(out).toContain('config posterior preservada')
    expect(out).not.toContain('b3BlbnNzaC1rZXktdjE')
    expect(out).not.toContain('PRIVATE KEY-----')
    expect(out).toContain('[REDACTED]')
    // Bloco INCOMPLETO (sem END) não é redigido — conservador.
    const partial = ['assim:', '-----BEGIN RSA PRIVATE KEY-----', 'MIIEpAIBAAKCAQ'].join('\n')
    expect(redactSecretText(partial)).toBe(partial)
    // Mesma redação via redactEvolutionValue (consistente entre helpers).
    expect(redactEvolutionValue(body)).toBe(out)
  })

  it('redacts user:password in URLs preserving host and path; plain URLs untouched', () => {
    const text =
      'mirror em https://admin:S3cr3t!@db.example.com/internal e http://ci:token2@ci.local:8080/job'
    const out = redactEvolutionValue(text)
    expect(out).toContain('https://[REDACTED]@db.example.com/internal')
    expect(out).toContain('http://[REDACTED]@ci.local:8080/job')
    expect(out).not.toContain('S3cr3t')
    expect(out).not.toContain('token2')
    // URL sem userinfo permanece intacta.
    expect(redactEvolutionValue('https://db.example.com/public')).toBe('https://db.example.com/public')
    expect(redactEvolutionValue('http://ci.local:8080/job')).toBe('http://ci.local:8080/job')
  })

  it('keeps ordinary placeholder/example text intact in the new families', () => {
    const safe = [
      'sk_live_EXAMPLE_PLACEHOLDER sem forma mínima',
      'token=example',
      'password=changeme',
      'AKIA-short',
      'AIza curto',
    ]
    for (const sample of safe) {
      expect(redactEvolutionValue(sample)).toBe(sample)
    }
  })
})
