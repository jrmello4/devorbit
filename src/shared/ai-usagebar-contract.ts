/**
 * Tolerant DevOrbit view of ai-usagebar's JSON CLI contracts.
 *
 * Provider-specific fields remain upstream-owned. Unknown fields are allowed
 * so a newer ai-usagebar release can add providers and report metadata without
 * requiring provider-specific renderer code.
 */

export const AI_USAGEBAR_SUPPORTED_SCHEMA_VERSION = 1

export type AiUsagebarServiceState =
  | 'unavailable'
  | 'installing'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'error'

export interface AiUsagebarVendor {
  id: string
  name: string
  short_name?: string
  kind?: 'oauth' | 'apikey' | 'local' | string
  enabled?: boolean
  configured?: boolean
  needs_credential?: boolean
  env?: string
  login?: string
  [key: string]: unknown
}

export interface AiUsagebarVendorCatalog {
  vendors: AiUsagebarVendor[]
  [key: string]: unknown
}

export interface AiUsagebarMetric {
  id?: string
  label: string
  percent?: number
  value?: string | number
  detail?: string
  headline?: 'percent' | 'value' | string
  severity?: string
  reset_at?: string
  window_secs?: number
  group?: string
  [key: string]: unknown
}

export interface AiUsagebarMetricSection extends AiUsagebarMetric {
  type: 'metric'
}

export interface AiUsagebarTextSection {
  type: 'text'
  label: string
  value: string
  [key: string]: unknown
}

export interface AiUsagebarBlockSection {
  type: 'block'
  label: string
  body: string[] | string
  [key: string]: unknown
}

export interface AiUsagebarSpacerSection {
  type: 'spacer'
  [key: string]: unknown
}

export interface AiUsagebarUnknownSection {
  type: string
  [key: string]: unknown
}

export type AiUsagebarSection =
  | AiUsagebarMetricSection
  | AiUsagebarTextSection
  | AiUsagebarBlockSection
  | AiUsagebarSpacerSection
  | AiUsagebarUnknownSection

export interface AiUsagebarEntry {
  id: string
  name: string
  display_name?: string
  short_name?: string
  icon?: string
  brand?: string
  plan?: string
  status?: 'ready' | 'error' | string
  error?: string
  stale?: boolean
  fetched_at?: string
  metrics?: AiUsagebarMetric[]
  sections?: AiUsagebarSection[]
  reset_credits?: unknown
  [key: string]: unknown
}

export interface AiUsagebarReport {
  schema_version: number
  primary?: string | null
  entries: AiUsagebarEntry[]
  [key: string]: unknown
}

export interface AiUsagebarDetectReport {
  enabled: string[]
  known: string[]
  probed: number
  [key: string]: unknown
}

/** Renderer-safe combined state. It never contains credentials or raw stderr. */
export interface AiUsagebarSnapshot {
  state: AiUsagebarServiceState
  version?: string
  vendors: AiUsagebarVendor[]
  report?: AiUsagebarReport
  fetchedAt?: string
  stale: boolean
  message?: string
}

export interface AiUsagebarProviderChange {
  vendorId: string
  enabled: boolean
}

/** A submitted API key is accepted only on the main-process IPC boundary. */
export interface AiUsagebarApiKeyChange {
  vendorId: string
  apiKey: string
}
