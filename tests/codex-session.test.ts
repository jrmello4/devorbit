import { describe, expect, it } from 'vitest'
import { canReuseCodexSession, type TerminalSessionIdentity } from '../src/shared/codex-session'

const readyCodex = (overrides: Partial<TerminalSessionIdentity> = {}): TerminalSessionIdentity => ({
  provider: 'codex',
  account: 'account1',
  mode: 'codex',
  state: 'ready',
  ...overrides,
})

describe('Codex session identity', () => {
  it('reuses a ready Codex session only while the account is unchanged', () => {
    expect(canReuseCodexSession(readyCodex(), 'codex', 'account1')).toBe(true)
    expect(canReuseCodexSession(readyCodex(), 'codex', 'account2')).toBe(false)
    expect(canReuseCodexSession(readyCodex({ account: 'account2' }), 'codex', 'account1')).toBe(false)
    expect(canReuseCodexSession(readyCodex(), 'codex', null)).toBe(false)
  })

  it('restarts before sending when provider, mode or state changed', () => {
    expect(canReuseCodexSession(readyCodex(), 'opencode', 'account1')).toBe(false)
    expect(canReuseCodexSession(
      readyCodex({ provider: 'opencode', account: null, mode: 'agent' }),
      'codex',
      'account1',
    )).toBe(false)
    expect(canReuseCodexSession(readyCodex({ mode: 'shell' }), 'codex', 'account1')).toBe(false)
    expect(canReuseCodexSession(readyCodex({ state: 'starting' }), 'codex', 'account1')).toBe(false)
    expect(canReuseCodexSession(readyCodex({ state: 'stopped' }), 'codex', 'account1')).toBe(false)
  })
})
