export type DiagnosticProcessStatus = 'completed' | 'timed-out' | 'cancelled' | 'output-limit' | 'spawn-failed'

export interface DiagnosticProcessRequest {
  command: string
  args?: readonly string[]
  projectPath: string
  timeoutMs?: number
}

export interface DiagnosticProcessResult {
  command: string
  args: string[]
  status: DiagnosticProcessStatus
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  truncated: boolean
  durationMs: number
  error?: string
}
