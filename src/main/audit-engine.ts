import fs from 'node:fs/promises'
import path from 'node:path'
import type { AuditDebtSeverity, AuditFinding, AuditSnapshot, GainMeasurement } from '../shared/audit-contract'

const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx'])
const IGNORED_DIRECTORIES = new Set(['.git', 'dist', 'dist-electron', 'node_modules', 'release', 'artifacts'])
const COMPLEXITY_PATTERN = /\b(if|else\s+if|for|while|catch|case|&&|\|\||\?)\b/gu
const SMELL_PATTERNS: Array<{ pattern: RegExp; category: AuditFinding['category']; severity: AuditDebtSeverity; message: string; minutes: number }> = [
  { pattern: /\bTODO\b/gu, category: 'smell', severity: 'low', message: 'TODO pendente no código-fonte.', minutes: 15 },
  { pattern: /\bFIXME\b/gu, category: 'smell', severity: 'medium', message: 'FIXME indica uma correção pendente.', minutes: 30 },
  { pattern: /:\s*any\b/gu, category: 'smell', severity: 'medium', message: 'Tipo any reduz a segurança estática.', minutes: 20 },
  { pattern: /console\.log\s*\(/gu, category: 'smell', severity: 'low', message: 'Log direto pode vazar contexto operacional.', minutes: 10 },
]

/** Métricas do motor são heurísticas de regex, não medição formal de débito. */
export const AUDIT_METRICS_METHOD = 'heuristic-regex' as const
export const AUDIT_METRICS_DISCLAIMER = 'Métricas baseadas em heurísticas de regex; não representam medição formal de débito.'

interface SourceFile {
  relativePath: string
  content: string
}

async function collectSourceFiles(root: string, directory = root): Promise<SourceFile[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files: SourceFile[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) files.push(...await collectSourceFiles(root, path.join(directory, entry.name)))
      continue
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
    const absolutePath = path.join(directory, entry.name)
    const relativePath = path.relative(root, absolutePath).split(path.sep).join('/')
    files.push({ relativePath, content: await fs.readFile(absolutePath, 'utf8') })
  }
  return files
}

function severityForComplexity(value: number): AuditDebtSeverity {
  if (value >= 30) return 'critical'
  if (value >= 20) return 'high'
  if (value >= 12) return 'medium'
  return 'low'
}

function addFinding(findings: AuditFinding[], finding: Omit<AuditFinding, 'id'>): void {
  findings.push({ ...finding, id: `${finding.category}:${finding.file}:${finding.line}:${findings.length + 1}` })
}

function auditFile(source: SourceFile, findings: AuditFinding[]): { lines: number; complexity: number } {
  const lines = source.content.split(/\r?\n/u)
  const complexity = 1 + [...source.content.matchAll(COMPLEXITY_PATTERN)].length
  const complexitySeverity = severityForComplexity(complexity)
  if (complexity >= 12) {
    addFinding(findings, {
      severity: complexitySeverity,
      category: 'complexity',
      file: source.relativePath,
      line: 1,
      message: `Complexidade ciclomática aproximada: ${complexity}.`,
      evidence: `branches=${complexity - 1}`,
      estimatedMinutes: complexity * 5,
    })
  }
  for (const rule of SMELL_PATTERNS) {
    for (const match of source.content.matchAll(rule.pattern)) {
      const line = source.content.slice(0, match.index || 0).split(/\r?\n/u).length
      addFinding(findings, {
        severity: rule.severity,
        category: rule.category,
        file: source.relativePath,
        line,
        message: rule.message,
        evidence: match[0],
        estimatedMinutes: rule.minutes,
      })
    }
  }
  if (source.relativePath.startsWith('src/main/') && /from ['"]\.\.\/renderer\//u.test(source.content)) {
    addFinding(findings, {
      severity: 'high',
      category: 'architecture',
      file: source.relativePath,
      line: 1,
      message: 'Processo principal importa diretamente o renderer.',
      evidence: 'cross-layer import',
      estimatedMinutes: 60,
    })
  }
  return { lines: lines.length, complexity }
}

export async function auditProject(projectPath: string): Promise<AuditSnapshot> {
  const root = await fs.realpath(projectPath)
  const sources = await collectSourceFiles(root)
  const findings: AuditFinding[] = []
  let linesScanned = 0
  let cyclomaticComplexity = 0
  for (const source of sources) {
    const result = auditFile(source, findings)
    linesScanned += result.lines
    cyclomaticComplexity += result.complexity
  }
  return {
    version: 1,
    projectPath: root,
    generatedAt: new Date().toISOString(),
    filesScanned: sources.length,
    linesScanned,
    cyclomaticComplexity,
    findings,
    estimatedDebtMinutes: findings.reduce((total, finding) => total + finding.estimatedMinutes, 0),
  }
}

function findingIdentity(finding: AuditFinding): string {
  return `${finding.file}:${finding.message}`
}

export function calculateGain(before: AuditSnapshot, after: AuditSnapshot, coverageDelta?: number): GainMeasurement {
  const beforeFindings = new Set(before.findings.map(findingIdentity))
  const afterFindings = new Set(after.findings.map(findingIdentity))
  let linesProblematicRemoved = 0
  for (const item of beforeFindings) if (!afterFindings.has(item)) linesProblematicRemoved += 1
  return {
    version: 1,
    measuredAt: new Date().toISOString(),
    linesProblematicRemoved,
    findingReduction: before.findings.length - after.findings.length,
    complexityReduction: before.cyclomaticComplexity - after.cyclomaticComplexity,
    ...(coverageDelta === undefined ? {} : { coverageDelta }),
  }
}

export function renderAuditMarkdown(snapshot: AuditSnapshot): string {
  const rows = snapshot.findings.length === 0
    ? '| Nenhum | - | - | - |\n|---|---|---|---|'
    : snapshot.findings.map((finding) => `| ${finding.severity} | ${finding.file}:${finding.line} | ${finding.category} | ${finding.message} |`).join('\n')
  return [
    `# Auditoria ${snapshot.projectPath}`,
    '',
    `Gerado em ${snapshot.generatedAt}. Arquivos: ${snapshot.filesScanned}. Linhas: ${snapshot.linesScanned}. Complexidade: ${snapshot.cyclomaticComplexity}. Débito estimado: ${snapshot.estimatedDebtMinutes} minutos.`,
    `Método: ${AUDIT_METRICS_METHOD}. ${AUDIT_METRICS_DISCLAIMER}`,
    '',
    '| Severidade | Local | Categoria | Evidência |',
    '|---|---|---|---|',
    rows,
    '',
  ].join('\n')
}
