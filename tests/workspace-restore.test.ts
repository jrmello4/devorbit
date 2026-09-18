import { describe, expect, it } from 'vitest'
import { resolveRestorableProjectId } from '../src/renderer/src/components/workspace-restore'

describe('workspace restore gating', () => {
  const ids = ['proj-1', 'proj-2']

  it('restores once when enabled and the configured project exists', () => {
    expect(resolveRestorableProjectId({ restoreWorkspace: true, restoreProjectId: 'proj-2' }, ids, false)).toBe('proj-2')
  })

  it('never restores twice (refresh/re-render não reabre)', () => {
    expect(resolveRestorableProjectId({ restoreWorkspace: true, restoreProjectId: 'proj-1' }, ids, true)).toBeUndefined()
  })

  it('does nothing when disabled or unconfigured', () => {
    expect(resolveRestorableProjectId(undefined, ids, false)).toBeUndefined()
    expect(resolveRestorableProjectId(null, ids, false)).toBeUndefined()
    expect(resolveRestorableProjectId({ restoreWorkspace: false, restoreProjectId: 'proj-1' }, ids, false)).toBeUndefined()
    expect(resolveRestorableProjectId({ restoreWorkspace: true }, ids, false)).toBeUndefined()
  })

  it('ignores a configured project that no longer exists', () => {
    expect(resolveRestorableProjectId({ restoreWorkspace: true, restoreProjectId: 'gone' }, ids, false)).toBeUndefined()
  })
})
