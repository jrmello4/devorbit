import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  RipgrepIndexer,
  searchWithRipgrep,
} from '../src/main/ripgrep-indexer'

const tempBase = fs.realpathSync.native(
  fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'devorbit-rg-')),
)
const fakeRg = path.join(tempBase, 'fake-rg.cjs')
const node = process.execPath
const indexers: RipgrepIndexer[] = []

const fakeRgSource = [
  "const fs = require('node:fs')",
  "const scenario = process.env.FAKE_RG_SCENARIO || ''",
  'const emit = (value) => { process.stdout.write(JSON.stringify(value) + "\\n") }',
  'const match = (line, file) => ({ type: "match", data: { path: { text: file }, lines: { text: "linha " + line + "\\n" }, line_number: line, absolute_offset: 0, submatches: [{ match: { text: "linha" }, start: 0, end: 5 }] } })',
  'if (process.env.FAKE_RG_ARGS) fs.writeFileSync(process.env.FAKE_RG_ARGS, JSON.stringify(process.argv.slice(2)))',
  "if (scenario === 'matches') { emit({ type: 'begin', data: { path: { text: 'src/a.ts' } } }); emit(match(3, 'src/a.ts')); emit(match(7, 'src/b.ts')); emit({ type: 'summary', data: { stats: {} } }); process.exit(0) }",
  "if (scenario === 'nomatch') process.exit(1)",
  "if (scenario === 'error') { process.stderr.write('rg: fixture failure\\n'); process.exit(2) }",
  "if (scenario === 'garbage') { process.stdout.write('not json\\n'); emit(match(1, 'src/g.ts')); process.exit(0) }",
  "if (scenario === 'many') { for (let i = 1; i <= 50; i += 1) emit(match(i, 'src/f.ts')); process.exit(0) }",
  "if (scenario === 'slow') { let i = 1; setInterval(() => { emit(match(i, 'src/s.ts')); i += 1 }, 5) }",
].join('\n')

beforeAll(() => {
  fs.writeFileSync(fakeRg, fakeRgSource, 'utf8')
})

afterEach(() => {
  for (const indexer of indexers.splice(0)) indexer.dispose()
})

afterAll(() => {
  fs.rmSync(tempBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function createIndexer(scenario: string, extra: Record<string, unknown> = {}): RipgrepIndexer {
  const indexer = new RipgrepIndexer({
    command: node,
    argsPrefix: [fakeRg],
    env: { ...process.env, FAKE_RG_SCENARIO: scenario },
    ...extra,
  })
  indexers.push(indexer)
  return indexer
}

describe('RipgrepIndexer', () => {
  it('parses ripgrep JSON matches into a serializable result and forwards search flags', async () => {
    const argsFile = path.join(tempBase, 'args.json')
    const indexer = createIndexer('matches', {
      env: { ...process.env, FAKE_RG_SCENARIO: 'matches', FAKE_RG_ARGS: argsFile },
    })

    const result = await indexer.search({
      root: tempBase,
      query: 'linha',
      fixedStrings: true,
      ignoreCase: true,
      globs: ['*.ts'],
    })

    expect(result).toMatchObject({
      root: tempBase,
      query: 'linha',
      status: 'ok',
      truncated: false,
      exitCode: 0,
    })
    expect(result.matches).toEqual([
      { path: 'src/a.ts', line: 3, column: 1, text: 'linha 3' },
      { path: 'src/b.ts', line: 7, column: 1, text: 'linha 7' },
    ])
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
    expect(JSON.parse(fs.readFileSync(argsFile, 'utf8'))).toEqual([
      '--json',
      '--no-messages',
      '--fixed-strings',
      '--ignore-case',
      '--glob',
      '*.ts',
      '--',
      'linha',
      tempBase,
    ])
  })

  it('treats exit code 1 as a successful search without matches', async () => {
    const result = await createIndexer('nomatch').search({ root: tempBase, query: 'nada' })

    expect(result).toMatchObject({ status: 'ok', exitCode: 1, matches: [], truncated: false })
  })

  it('maps ripgrep failures to a structured error', async () => {
    const result = await createIndexer('error').search({ root: tempBase, query: 'falha' })

    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(2)
    expect(result.error).toContain('rg: fixture failure')
  })

  it('skips malformed JSON lines without failing the search', async () => {
    const result = await createIndexer('garbage').search({ root: tempBase, query: 'linha' })

    expect(result.status).toBe('ok')
    expect(result.matches).toEqual([
      { path: 'src/g.ts', line: 1, column: 1, text: 'linha 1' },
    ])
  })

  it('truncates the result list at maxResults', async () => {
    const result = await createIndexer('many').search({
      root: tempBase,
      query: 'linha',
      maxResults: 5,
    })

    expect(result.status).toBe('truncated')
    expect(result.truncated).toBe(true)
    expect(result.matches).toHaveLength(5)
    expect(result.matches[4]).toMatchObject({ path: 'src/f.ts', line: 5 })
  })

  it('bounds the raw ripgrep output through maxOutputBytes', async () => {
    const indexer = createIndexer('slow', { maxOutputBytes: 2_048 })
    const result = await indexer.search({
      root: tempBase,
      query: 'linha',
      timeoutMs: 5_000,
    })

    expect(result.status).toBe('truncated')
    expect(result.truncated).toBe(true)
    expect(result.matches.length).toBeGreaterThan(0)
  })

  it('times out long searches deterministically', async () => {
    const startedAt = Date.now()
    const result = await createIndexer('slow').search({
      root: tempBase,
      query: 'linha',
      timeoutMs: 200,
    })

    expect(result.status).toBe('timed-out')
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  })

  it('cancels a search through the abort signal', async () => {
    const controller = new AbortController()
    const pending = createIndexer('slow').search({
      root: tempBase,
      query: 'linha',
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 120)

    const result = await pending
    expect(result.status).toBe('cancelled')
  })

  it('cancels an in-flight search when the indexer is disposed', async () => {
    const indexer = createIndexer('slow')
    const pending = indexer.search({ root: tempBase, query: 'linha' })
    setTimeout(() => indexer.dispose(), 100)

    const result = await pending
    expect(result.status).toBe('cancelled')
    expect(indexer.disposed).toBe(true)
  })

  it('reports a missing ripgrep binary as a structured failure', async () => {
    const indexer = new RipgrepIndexer({ command: 'devorbit-ripgrep-missing-xyz' })
    indexers.push(indexer)

    const result = await indexer.search({ root: tempBase, query: 'x' })

    expect(result.status).toBe('failed')
    expect(result.error).toBeTruthy()
  })

  it('validates inputs and rejects calls after disposal', async () => {
    const indexer = createIndexer('matches')

    await expect(indexer.search({ root: '   ', query: 'x' })).rejects.toThrow(/Raiz/)
    await expect(indexer.search({ root: tempBase, query: '' })).rejects.toThrow(/Consulta/)

    indexer.dispose()
    await expect(indexer.search({ root: tempBase, query: 'x' })).rejects.toThrow(/indisponível/)
  })

  it('exposes an on-demand helper that disposes the indexer', async () => {
    const result = await searchWithRipgrep(
      { root: tempBase, query: 'linha' },
      {
        command: node,
        argsPrefix: [fakeRg],
        env: { ...process.env, FAKE_RG_SCENARIO: 'matches' },
      },
    )

    expect(result.status).toBe('ok')
    expect(result.matches).toHaveLength(2)
  })
})
