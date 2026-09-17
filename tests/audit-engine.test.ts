import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { auditProject, calculateGain, renderAuditMarkdown } from '../src/main/audit-engine'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function fixture(content: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-audit-'))
  roots.push(root)
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'sample.ts'), content)
  return root
}

describe('audit engine', () => {
  it('measures complexity, smells and technical debt', async () => {
    const root = await fixture('export function sample(value: any) { if (value) { console.log(value) } } // TODO')
    const snapshot = await auditProject(root)
    expect(snapshot.version).toBe(1)
    expect(snapshot.filesScanned).toBe(1)
    expect(snapshot.findings.map((finding) => finding.category)).toContain('smell')
    expect(snapshot.estimatedDebtMinutes).toBeGreaterThan(0)
    expect(renderAuditMarkdown(snapshot)).toContain('Débito estimado')
  })

  it('calculates measurable gain between snapshots', () => {
    const base = { version: 1 as const, projectPath: 'x', generatedAt: 'a', filesScanned: 1, linesScanned: 10, cyclomaticComplexity: 12, findings: [{ id: 'a', severity: 'medium' as const, category: 'smell' as const, file: 'a.ts', line: 1, message: 'x', evidence: 'x', estimatedMinutes: 20 }], estimatedDebtMinutes: 20 }
    const after = { ...base, generatedAt: 'b', cyclomaticComplexity: 4, findings: [] }
    expect(calculateGain(base, after, 8)).toMatchObject({ linesProblematicRemoved: 1, findingReduction: 1, complexityReduction: 8, coverageDelta: 8 })
  })
})
