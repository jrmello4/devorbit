import type { IpcRegistrar } from './registrar'
import type { AiUsagebarDetectReport, AiUsagebarSnapshot } from '../../shared/ai-usagebar-contract'
import {
  AI_USAGEBAR_IPC_CHANNELS,
  type AiUsagebarIpcResult,
} from '../../shared/ai-usagebar-ipc-contract'

export interface AiUsagebarIpcOperations {
  snapshot(): Promise<AiUsagebarSnapshot>
  refresh(): Promise<AiUsagebarSnapshot>
  /** Explicit user action only: upstream detect mutates its config. */
  detect(): Promise<AiUsagebarDetectReport>
  setProviderEnabled(vendorId: string, enabled: boolean): Promise<AiUsagebarSnapshot>
  setApiKey(vendorId: string, apiKey: string): Promise<AiUsagebarSnapshot>
  removeApiKey(vendorId: string): Promise<AiUsagebarSnapshot>
}

function success<T>(data: T): AiUsagebarIpcResult<T> {
  return { ok: true, data }
}

function failure<T>(reason: 'unavailable' | 'invalid' | 'failed', message: string): AiUsagebarIpcResult<T> {
  return { ok: false, reason, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validVendorId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && /^[a-zA-Z0-9][a-zA-Z0-9_.:@+-]*$/.test(value)
}

function safeFailureMessage(error: unknown): string {
  // Do not surface process stderr, credential paths, or arbitrary CLI output.
  const text = error instanceof Error ? error.message : ''
  if (/timeout|timed out|tempo limite/i.test(text)) return 'A consulta de uso excedeu o tempo limite.'
  if (/unavailable|not found|indispon[ií]vel|n[aã]o encontrado/i.test(text)) return 'O serviço de quotas não está disponível.'
  return 'Não foi possível concluir a operação de quotas.'
}

export function registerAiUsagebarIpc(register: IpcRegistrar, operations: AiUsagebarIpcOperations): void {
  const invoke = async <T>(action: () => Promise<T>): Promise<AiUsagebarIpcResult<T>> => {
    try {
      return success(await action())
    } catch (error) {
      return failure(/unavailable|not found|indispon[ií]vel|n[aã]o encontrado/i.test(error instanceof Error ? error.message : '')
        ? 'unavailable'
        : 'failed', safeFailureMessage(error))
    }
  }

  register(AI_USAGEBAR_IPC_CHANNELS.snapshot as never, async () => await invoke(() => operations.snapshot()))
  register(AI_USAGEBAR_IPC_CHANNELS.refresh as never, async () => await invoke(() => operations.refresh()))
  register(AI_USAGEBAR_IPC_CHANNELS.detect as never, async () => await invoke(() => operations.detect()))

  register(AI_USAGEBAR_IPC_CHANNELS.setProvider as never, async (_event, request: unknown) => {
    if (!isRecord(request) || !validVendorId(request.vendorId) || typeof request.enabled !== 'boolean') {
      return failure('invalid', 'Configuração de provider inválida.')
    }
    return await invoke(() => operations.setProviderEnabled(request.vendorId as string, request.enabled as boolean))
  })

  register(AI_USAGEBAR_IPC_CHANNELS.setApiKey as never, async (_event, request: unknown) => {
    if (!isRecord(request) || !validVendorId(request.vendorId) || typeof request.apiKey !== 'string') {
      return failure('invalid', 'Credencial de provider inválida.')
    }
    const apiKey = request.apiKey
    if (apiKey.trim().length === 0 || apiKey.length > 8_192 || /[\r\n\0]/.test(apiKey)) {
      return failure('invalid', 'A chave informada é inválida.')
    }
    // The secret is passed to main only for this call and never echoed back.
    return await invoke(() => operations.setApiKey(request.vendorId as string, apiKey.trim()))
  })

  register(AI_USAGEBAR_IPC_CHANNELS.removeApiKey as never, async (_event, request: unknown) => {
    if (!isRecord(request) || !validVendorId(request.vendorId)) {
      return failure('invalid', 'Provider inválido.')
    }
    return await invoke(() => operations.removeApiKey(request.vendorId as string))
  })
}
