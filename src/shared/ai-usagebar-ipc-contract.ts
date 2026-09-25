import type {
  AiUsagebarApiKeyChange,
  AiUsagebarDetectReport,
  AiUsagebarProviderChange,
  AiUsagebarSnapshot,
} from './ai-usagebar-contract'

export const AI_USAGEBAR_IPC_CHANNELS = {
  snapshot: 'devorbit:aiUsagebarSnapshot',
  refresh: 'devorbit:aiUsagebarRefresh',
  detect: 'devorbit:aiUsagebarDetect',
  setProvider: 'devorbit:aiUsagebarSetProvider',
  setApiKey: 'devorbit:aiUsagebarSetApiKey',
  removeApiKey: 'devorbit:aiUsagebarRemoveApiKey',
} as const

export type AiUsagebarIpcChannel = typeof AI_USAGEBAR_IPC_CHANNELS[keyof typeof AI_USAGEBAR_IPC_CHANNELS]

export type AiUsagebarIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'unavailable' | 'invalid' | 'failed'; message: string }

export type AiUsagebarSnapshotResult = AiUsagebarIpcResult<AiUsagebarSnapshot>
export type AiUsagebarDetectResult = AiUsagebarIpcResult<AiUsagebarDetectReport>
export type AiUsagebarProviderChangeRequest = AiUsagebarProviderChange
export type AiUsagebarApiKeyRequest = AiUsagebarApiKeyChange
