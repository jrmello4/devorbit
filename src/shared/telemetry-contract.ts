export type TelemetrySpanStatus = 'unset' | 'ok' | 'error'

export interface TelemetrySpanView {
  id: string
  name: string
  startTime: number
  endTime: number
  durationMs: number
  status: TelemetrySpanStatus
  attributes: Record<string, unknown>
  error?: { name: string; message: string }
}
