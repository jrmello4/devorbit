import {
  applyUnifiedDiff,
  applyUnifiedDiffAsync,
  applyUnifiedDiffToFiles,
  createUnifiedDiff,
  parseUnifiedDiff,
} from '../src/shared/unified-diff'
import { describe, expect, it } from 'vitest'

describe('unified diff', () => {
  it('generates deterministic line hunks with context', () => {
    const before = 'alpha\nbeta\ngamma\n'
    const after = 'alpha\ndelta\ngamma\n'
    const expected = [
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1,3 +1,3 @@',
      ' alpha',
      '-beta',
      '+delta',
      ' gamma',
      '',
    ].join('\n')

    expect(createUnifiedDiff(before, after, { filePath: 'src/example.ts', contextLines: 1 })).toBe(expected)
    expect(createUnifiedDiff(before, after, { filePath: 'src/example.ts', contextLines: 1 })).toBe(expected)
  })

  it('applies a hunk by unique context after the original line moved', () => {
    const original = 'one\ntwo\nthree\n'
    const changed = 'one\nupdated\nthree\n'
    const patch = createUnifiedDiff(original, changed, { filePath: 'file.txt', contextLines: 1 })
    const moved = 'prefix\none\ntwo\nthree\n'
    const result = applyUnifiedDiff(moved, patch)

    expect(result.status).toBe('applied')
    expect(result.content).toBe('prefix\none\nupdated\nthree\n')
    expect(result.conflicts).toHaveLength(0)
  })

  it('reports ambiguous context instead of trusting the header line', () => {
    const patch = createUnifiedDiff('a\nb\n', 'a\nc\n', { filePath: 'file.txt', contextLines: 1 })
    const result = applyUnifiedDiff('a\nb\na\nb\n', patch)

    expect(result.status).toBe('conflict')
    expect(result.ok).toBe(false)
    expect(result.conflicts[0]).toMatchObject({ reason: 'context-ambiguous', candidates: [1, 3] })
    expect(result.content).toBe('a\nb\na\nb\n')
  })

  it('reports changed context and keeps the source untouched', () => {
    const patch = createUnifiedDiff('a\nb\nc\n', 'a\nx\nc\n', { filePath: 'file.txt', contextLines: 1 })
    const result = applyUnifiedDiff('a\nchanged\nc\n', patch)

    expect(result.status).toBe('conflict')
    expect(result.conflicts[0]?.reason).toBe('context-not-found')
    expect(result.content).toBe('a\nchanged\nc\n')
  })

  it('runs syntax validation before committing the candidate', () => {
    const source = 'const value = 1\n'
    const patch = createUnifiedDiff(source, 'const value = ;\n', { filePath: 'file.ts' })
    const result = applyUnifiedDiff(source, patch, {
      validateSyntax: (content) => !content.includes('= ;'),
    })

    expect(result.status).toBe('validation-failed')
    expect(result.applied).toBe(false)
    expect(result.content).toBe(source)
    expect(result.conflicts[0]?.reason).toBe('validation-failed')
  })

  it('supports an asynchronous validation hook atomically', async () => {
    const source = 'export const value = 1\n'
    const patch = createUnifiedDiff(source, 'export const value = 2\n', { filePath: 'file.ts' })
    const result = await applyUnifiedDiffAsync(source, patch, {
      syntaxValidator: async (content) => content.includes('value = 2'),
    })

    expect(result.status).toBe('applied')
    expect(result.content).toBe('export const value = 2\n')
  })

  it('preserves the target trailing newline marker', () => {
    const source = ''
    const target = 'new file\n'
    const patch = createUnifiedDiff(source, target, { filePath: 'new.txt' })
    const result = applyUnifiedDiff(source, patch)

    expect(result.status).toBe('applied')
    expect(result.content).toBe(target)
  })

  it('parses multiple files and applies them without partial commit on conflict', () => {
    const first = createUnifiedDiff('a\nb\n', 'a\nc\n', { filePath: 'one.txt' })
    const second = createUnifiedDiff('x\ny\n', 'x\nz\n', { filePath: 'two.txt' })
    const patch = `${first}${second}`
    const parsed = parseUnifiedDiff(patch)
    const result = applyUnifiedDiffToFiles({ 'one.txt': 'a\nb\n', 'two.txt': 'x\nchanged\n' }, patch)

    expect(parsed.files).toHaveLength(2)
    expect(result.status).toBe('conflict')
    expect(result.files).toEqual({ 'one.txt': 'a\nb\n', 'two.txt': 'x\nchanged\n' })
  })
})
