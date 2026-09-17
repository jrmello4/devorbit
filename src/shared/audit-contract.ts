export const AUDIT_DEBT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
export type AuditDebtSeverity = (typeof AUDIT_DEBT_SEVERITIES)[number]

export interface AuditFinding {
  id: string
  severity: AuditDebtSeverity
  category: 'complexity' | 'smell' | 'architecture'
  file: string
  line: number
  message: string
  evidence: string
  estimatedMinutes: number
}

export interface AuditSnapshot {
  version: 1
  projectPath: string
  generatedAt: string
  filesScanned: number
  linesScanned: number
  cyclomaticComplexity: number
  findings: AuditFinding[]
  estimatedDebtMinutes: number
}

export interface GainMeasurement {
  version: 1
  measuredAt: string
  linesProblematicRemoved: number
  findingReduction: number
  complexityReduction: number
  coverageDelta?: number
}
