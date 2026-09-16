import { describe, expect, it } from 'vitest'
import { canSubmitInitDock, classifyDiffLine, isInitPushAvailable } from '../src/renderer/src/components/git-dock-helpers'

describe('git dock init push', () => {
  it('só habilita o push com commit e remote', () => {
    expect(isInitPushAvailable('https://github.com/a/b.git', true)).toBe(true)
    expect(isInitPushAvailable('', true)).toBe(false)
    expect(isInitPushAvailable('   ', true)).toBe(false)
    expect(isInitPushAvailable('https://github.com/a/b.git', false)).toBe(false)
  })

  it('exige remote quando o push está marcado', () => {
    const base = {
      canInitialize: true,
      truncated: false,
      fingerprint: 'a'.repeat(64),
      isLoading: false,
      isBusy: false,
      initialCommit: true,
      commitMessage: 'chore: init',
      confirmed: true,
      remoteUrl: '',
    }
    expect(canSubmitInitDock({ ...base, push: false })).toBe(true)
    expect(canSubmitInitDock({ ...base, push: true })).toBe(false)
    expect(canSubmitInitDock({ ...base, push: true, remoteUrl: 'https://github.com/a/b.git' })).toBe(true)
  })

  it('bloqueia commit sem confirmação, mensagem ou prévia', () => {
    const base = {
      canInitialize: true,
      truncated: false,
      fingerprint: 'a'.repeat(64),
      isLoading: false,
      isBusy: false,
      initialCommit: true,
      commitMessage: 'chore: init',
      confirmed: true,
      push: false,
      remoteUrl: '',
    }
    expect(canSubmitInitDock({ ...base, confirmed: false })).toBe(false)
    expect(canSubmitInitDock({ ...base, commitMessage: '  ' })).toBe(false)
    expect(canSubmitInitDock({ ...base, truncated: true })).toBe(false)
    expect(canSubmitInitDock({ ...base, fingerprint: undefined })).toBe(false)
  })
})

describe('git dock diff', () => {
  it('classifica linhas do diff para colorir', () => {
    expect(classifyDiffLine('+nova')).toBe('add')
    expect(classifyDiffLine('-antiga')).toBe('del')
    expect(classifyDiffLine('@@ -1 +1 @@')).toBe('hunk')
    expect(classifyDiffLine('diff --git a/x b/x')).toBe('meta')
    expect(classifyDiffLine(' contexto')).toBe('context')
  })
})
