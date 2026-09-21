import fs from 'node:fs/promises'
import { dialog, type BrowserWindow } from 'electron'
import {
  exportConfigJson,
  importConfigJson,
  loadConfig,
  saveConfig,
  toSafeConfig,
  validateConfigUpdatesForSave,
} from '../config'
import { cancelCodexLogin, checkCodexAuthStatus, startCodexDeviceLogin, type CodexAuthProgress } from '../codex-auth'
import { copyProjectContext, getToolHealth } from '../launcher'
import { generateMemoryFromGit, getProjectMemory, saveProjectMemory } from '../memory'
import { validateProjectPath } from '../project-paths'
import { downloadUpdate, getUpdateState, installUpdate } from '../updater'
import { getRealUsage } from '../usage-real'
import { testToolPath, validateCodexAccount } from '../validation'
import { validateConfigUpdates } from '../validation'
import type { UsageEvent } from '../../shared/usage-contract'
import type { IpcRegistrar } from './registrar'
import type { AppConfig, RealUsageState } from '../../renderer/src/types'

/** Ponto de injeção do registro de uso (quota Codex) — opcional e best-effort. */
export interface UsageQuotaRecorder {
  recordUsageEvents: (events: UsageEvent[]) => Promise<void>
}

export interface ConfigIpcDependencies {
  getWindow: () => BrowserWindow | null
  sendCodexAuthProgress: (progress: CodexAuthProgress) => void
  /** Alimenta a continuidade com a quota OAuth real do Codex (por conta). */
  onRealUsage?: (usage: RealUsageState) => void
  usage?: UsageQuotaRecorder
}

/**
 * Converte as métricas de uma conta Codex em um evento de quota do store de
 * uso. Só contas 'ready' com janelas geram snapshot — um evento vazio de conta
 * com erro apagaria o último snapshot válido (agregação é latest-wins).
 */
function quotaEventsFromRealUsage(state: RealUsageState): UsageEvent[] {
  const events: UsageEvent[] = []
  for (const accountKey of ['account1', 'account2'] as const) {
    const account = state.accounts[accountKey]
    if (!account || account.status !== 'ready' || !Array.isArray(account.metrics) || account.metrics.length === 0) continue
    const windows = account.metrics
      .filter((metric) => typeof metric.id === 'string' && metric.id.trim() && typeof metric.label === 'string')
      .map((metric) => ({
        id: metric.id,
        label: metric.label,
        // Clamp em 0..100: percentual fora da faixa derrubaria o evento
        // INTEIRO na validação do store (e com ele a outra conta).
        ...(typeof metric.percent === 'number' && Number.isFinite(metric.percent)
          ? { percent: Math.max(0, Math.min(100, Math.round(metric.percent * 10) / 10)) }
          : {}),
        ...(typeof metric.resetAt === 'number' && Number.isFinite(metric.resetAt) ? { resetAt: new Date(metric.resetAt).toISOString() } : {}),
      }))
      .filter((window) => window.percent !== undefined || window.resetAt !== undefined)
    // Conta sem janelas válidas não gera evento: latest-wins apagaria o
    // último snapshot bom dessa conta.
    if (windows.length === 0) continue
    events.push({
      kind: 'quota',
      at: state.fetchedAt,
      provider: 'codex',
      accountId: accountKey,
      windows,
    })
  }
  return events
}

/**
 * Grava os snapshots de quota — apenas em fetch fresco. O cache de 30s do
 * getRealUsage devolve o MESMO fetchedAt; dedupe por fetchedAt cobre tanto o
 * cache quanto o join da requisição em voo. Best-effort, sem lançar.
 */
function recordCodexQuotaUsage(
  usage: UsageQuotaRecorder | undefined,
  lastRecordedFetchedAt: { value?: string },
  state: RealUsageState,
): void {
  if (!usage) return
  try {
    if (typeof state?.fetchedAt !== 'string' || state.fetchedAt.length === 0) return
    if (state.fetchedAt === lastRecordedFetchedAt.value) return
    const events = quotaEventsFromRealUsage(state)
    if (events.length === 0) return
    lastRecordedFetchedAt.value = state.fetchedAt
    void usage.recordUsageEvents(events).catch(() => undefined)
  } catch {
    // Uso é telemetria: nunca propaga erro para o chamador do getRealUsage.
  }
}

export function registerConfigIpc(register: IpcRegistrar, dependencies: ConfigIpcDependencies): void {
  // fetchedAt muda só em fetch fresco: cache hit devolve o mesmo valor.
  const lastRecordedQuotaFetchedAt: { value?: string } = {}

  register('devorbit:copyProjectContext', async (_event, projectPath: string) => {
    return await copyProjectContext(await validateProjectPath(projectPath))
  })

  register('devorbit:getConfig', async () => {
    return toSafeConfig(await loadConfig())
  })

  register('devorbit:getUpdateState', () => getUpdateState())
  register('devorbit:downloadUpdate', () => downloadUpdate())
  register('devorbit:installUpdate', async () => {
    return await installUpdate()
  })

  register('devorbit:saveConfig', async (_event, updates: Partial<AppConfig>) => {
    return toSafeConfig(await saveConfig(await validateConfigUpdatesForSave(updates)))
  })

  register('devorbit:exportConfig', async () => {
    const window = dependencies.getWindow()
    if (!window) throw new Error('Janela indisponível.')
    const result = await dialog.showSaveDialog(window, {
      title: 'Exportar configurações do DevOrbit',
      defaultPath: 'devorbit-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { success: false, message: 'Exportação cancelada.' }
    await fs.writeFile(result.filePath, await exportConfigJson(), 'utf-8')
    return { success: true, message: `Configurações exportadas para ${result.filePath}` }
  })

  register('devorbit:importConfig', async () => {
    const window = dependencies.getWindow()
    if (!window) throw new Error('Janela indisponível.')
    const result = await dialog.showOpenDialog(window, {
      title: 'Importar configurações do DevOrbit',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return { success: false, message: 'Importação cancelada.' }
    const raw = await fs.readFile(result.filePaths[0], 'utf-8')
    await importConfigJson(raw)
    return { success: true, message: 'Configurações importadas! Backup anterior salvo em config.json.bak.' }
  })

  register('devorbit:testToolPath', async (_event, toolPath: string) => {
    return await testToolPath(toolPath)
  })

  register('devorbit:getToolHealth', async () => {
    return await getToolHealth(await loadConfig())
  })

  register('devorbit:selectDirectory', async () => {
    const window = dependencies.getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
      title: 'Selecione uma pasta de projetos para monitorar',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  register('devorbit:getCodexAuthStatus', async () => {
    return await checkCodexAuthStatus()
  })

  register(
    'devorbit:startCodexLogin',
    async (_event, account: 'account1' | 'account2') => {
      const safeAccount = validateCodexAccount(account)
      await startCodexDeviceLogin(safeAccount, (progress: CodexAuthProgress) => {
        dependencies.sendCodexAuthProgress(progress)
      })
      return { success: true }
    }
  )

  register('devorbit:cancelCodexLogin', async () => {
    await cancelCodexLogin()
    return { success: true }
  })

  register('devorbit:getProjectMemory', async (_event, projectPath: string) => {
    return await getProjectMemory(await validateProjectPath(projectPath))
  })

  register(
    'devorbit:saveProjectMemory',
    async (_event, projectPath: string, content: string) => {
      if (typeof content !== 'string' || content.length > 2_000_000) {
        throw new Error('Conteúdo da memória inválido ou grande demais.')
      }
      return await saveProjectMemory(await validateProjectPath(projectPath), content)
    }
  )

  register('devorbit:generateMemoryFromGit', async (_event, projectPath: string) => {
    return await generateMemoryFromGit(await validateProjectPath(projectPath))
  })

  register('devorbit:getRealUsage', async (_event, force?: boolean) => {
    if (force !== undefined && typeof force !== 'boolean') {
      throw new Error('Opção de atualização de uso inválida.')
    }
    const usage = await getRealUsage(force === true)
    try {
      dependencies.onRealUsage?.(usage)
    } catch {
      // A telemetria de continuidade nunca quebra a leitura de uso.
    }
    recordCodexQuotaUsage(dependencies.usage, lastRecordedQuotaFetchedAt, usage)
    return usage
  })
}
