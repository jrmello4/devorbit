import React, { useRef, useState } from 'react'
import { X, Trash2, Check, Edit2 } from 'lucide-react'
import type {
  AgentProviderId,
  AppConfig,
  AutomationConfig,
  CodexAccountStatus,
  CustomTerminalPreset,
  ModelRoutingBaseUrlKey,
  ModelRoutingConfig,
  ModelRoutingSecretKey,
} from '../types'
import { MODEL_ROUTING_SECRET_KEYS } from '../types'
import {
  CUSTOM_TERMINAL_PRESET_LIMIT,
  deleteCustomTerminalPreset,
  isCustomTerminalPresetId,
  renameCustomTerminalPreset,
} from './terminal-node-helpers'
import { AccessibleDialog } from './AccessibleDialog'

interface SettingsModalProps {
  isOpen: boolean
  suspended?: boolean
  onClose: () => void
  config: AppConfig | null
  onSaveConfig: (updated: Partial<AppConfig>) => Promise<void>
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void
  authStatus?: CodexAccountStatus | null
  onOpenAuthModal?: (account: 'account1' | 'account2') => void
  projects?: Array<{ id: string; name: string }>
}

const AGENT_PATH_FIELDS: Array<{ key: 'opencode' | 'opencode2' | 'claude' | 'gemini' | 'aider' | 'commandCode' | 'customAgent'; label: string; hint: string }> = [
  { key: 'opencode', label: 'OpenCode', hint: 'opencode.cmd / opencode.exe' },
  { key: 'opencode2', label: 'OpenCode 2', hint: 'opencode2.cmd / opencode2.exe' },
  { key: 'claude', label: 'Claude Code', hint: 'claude.cmd / claude.exe' },
  { key: 'gemini', label: 'Gemini CLI', hint: 'gemini.cmd / gemini.exe' },
  { key: 'aider', label: 'Aider', hint: 'aider.cmd / aider.exe' },
  { key: 'commandCode', label: 'Command Code', hint: 'cmdc.cmd / command-code.exe' },
  { key: 'customAgent', label: 'Outro CLI', hint: 'Comando ou caminho do agente' },
]

const EXECUTOR_OPTIONS: Array<{ value: AgentProviderId; label: string }> = [
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'opencode2', label: 'OpenCode 2' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'gemini', label: 'Gemini CLI' },
  { value: 'aider', label: 'Aider' },
  { value: 'agy', label: 'Antigravity' },
  { value: 'command-code', label: 'Command Code' },
  { value: 'custom', label: 'Agente local' },
]

const ROUTING_SECRET_FIELDS: ReadonlyArray<{ key: ModelRoutingSecretKey; label: string; hasKey: keyof ModelRoutingConfig }> = [
  { key: 'openaiApiKey', label: 'OpenAI', hasKey: 'hasOpenaiKey' },
  { key: 'anthropicApiKey', label: 'Anthropic', hasKey: 'hasAnthropicKey' },
  { key: 'geminiApiKey', label: 'Gemini', hasKey: 'hasGeminiKey' },
  { key: 'deepseekApiKey', label: 'DeepSeek', hasKey: 'hasDeepseekKey' },
  { key: 'glmApiKey', label: 'GLM', hasKey: 'hasGlmKey' },
  { key: 'kimiApiKey', label: 'Kimi', hasKey: 'hasKimiKey' },
  { key: 'minimaxApiKey', label: 'MiniMax', hasKey: 'hasMinimaxKey' },
  { key: 'vllmApiKey', label: 'vLLM', hasKey: 'hasVllmKey' },
]

const ROUTING_BASE_URL_FIELDS: ReadonlyArray<{ key: ModelRoutingBaseUrlKey; label: string }> = [
  { key: 'openaiBaseUrl', label: 'OpenAI' },
  { key: 'anthropicBaseUrl', label: 'Anthropic' },
  { key: 'geminiBaseUrl', label: 'Gemini' },
  { key: 'deepseekBaseUrl', label: 'DeepSeek' },
  { key: 'glmBaseUrl', label: 'GLM' },
  { key: 'kimiBaseUrl', label: 'Kimi' },
  { key: 'minimaxBaseUrl', label: 'MiniMax' },
  { key: 'ollamaBaseUrl', label: 'Ollama (local)' },
  { key: 'vllmBaseUrl', label: 'vLLM (local)' },
]

function blankApiKeyInputs(): Record<ModelRoutingSecretKey, string> {
  return Object.fromEntries(MODEL_ROUTING_SECRET_KEYS.map((key) => [key, ''])) as Record<ModelRoutingSecretKey, string>
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  suspended = false,
  onClose,
  config,
  onSaveConfig,
  onNotify,
  authStatus,
  onOpenAuthModal,
  projects = [],
}) => {
  const [projectDirs, setProjectDirs] = useState<string[]>([])
  const [account1Name, setAccount1Name] = useState('')
  const [account2Name, setAccount2Name] = useState('')
  const [customPaths, setCustomPaths] = useState<AppConfig['customPaths']>({})
  const [automation, setAutomation] = useState<AutomationConfig>({})
  const [modelRouting, setModelRouting] = useState<ModelRoutingConfig>({})
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<ModelRoutingSecretKey, string>>(blankApiKeyInputs)
  const [clearedApiKeys, setClearedApiKeys] = useState<ModelRoutingSecretKey[]>([])
  const [terminalPresets, setTerminalPresets] = useState<CustomTerminalPreset[]>([])
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null)
  const [editingPresetName, setEditingPresetName] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [testingTool, setTestingTool] = useState<string | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const initializedConfigRef = useRef<AppConfig | null>(null)

  React.useEffect(() => {
    if (!isOpen) {
      initializedConfigRef.current = null
      setAutomation({})
      setModelRouting({})
      setApiKeyInputs(blankApiKeyInputs())
      setClearedApiKeys([])
      setTerminalPresets([])
      setEditingPresetId(null)
      setEditingPresetName('')
      return
    }

    if (config && !suspended && initializedConfigRef.current !== config) {
      setProjectDirs(config.projectDirs)
      setAccount1Name(config.chatGptAccount1Name)
      setAccount2Name(config.chatGptAccount2Name)
      setCustomPaths(config.customPaths)
      setAutomation(config.automation ?? {})
      setModelRouting(config.modelRouting ?? {})
      setApiKeyInputs(blankApiKeyInputs())
      setClearedApiKeys([])
      setTerminalPresets(config.terminalPresets ?? [])
      setEditingPresetId(null)
      setEditingPresetName('')
      setIsDirty(false)
      initializedConfigRef.current = config
    }
  }, [config, isOpen, suspended])

  if (!isOpen || !config) return null

  const handleClose = () => {
    if (isDirty && !isSaving) {
      const shouldDiscard = window.confirm('Descartar as alterações não salvas?')
      if (!shouldDiscard) return
    }
    onClose()
  }

  const handleAddDirectory = async () => {
    try {
      const selected = await window.devorbit?.selectDirectory()
      if (selected && !projectDirs.includes(selected)) {
        setProjectDirs([...projectDirs, selected])
        setIsDirty(true)
      }
    } catch (err: any) {
      onNotify(`Erro ao selecionar pasta: ${err.message}`, 'error')
    }
  }

  const handleRemoveDirectory = (dirToRemove: string) => {
    setProjectDirs(projectDirs.filter((d) => d !== dirToRemove))
    setIsDirty(true)
  }

  const updateCustomPath = (key: keyof AppConfig['customPaths'], value: string) => {
    setCustomPaths((current) => ({ ...current, [key]: value }))
    setIsDirty(true)
  }

  const updateAutomation = (patch: Partial<AutomationConfig>) => {
    setAutomation((current) => ({ ...current, ...patch }))
    setIsDirty(true)
  }

  const updateRoutingField = (patch: Partial<ModelRoutingConfig>) => {
    setModelRouting((current) => ({ ...current, ...patch }))
    setIsDirty(true)
  }

  const updateApiKeyInput = (key: ModelRoutingSecretKey, value: string) => {
    setApiKeyInputs((current) => ({ ...current, [key]: value }))
    setClearedApiKeys((current) => current.filter((entry) => entry !== key))
    setIsDirty(true)
  }

  const clearApiKey = (key: ModelRoutingSecretKey) => {
    setApiKeyInputs((current) => ({ ...current, [key]: '' }))
    setClearedApiKeys((current) => (current.includes(key) ? current : [...current, key]))
    setIsDirty(true)
  }

  const buildRoutingUpdates = (): ModelRoutingConfig => {
    const updates: ModelRoutingConfig = {}
    const fastModel = modelRouting.fastModel?.trim()
    const deepModel = modelRouting.deepModel?.trim()
    if (fastModel) updates.fastModel = fastModel
    if (deepModel) updates.deepModel = deepModel
    for (const field of ROUTING_BASE_URL_FIELDS) {
      const value = modelRouting[field.key]?.trim() ?? ''
      if (value) updates[field.key] = value
      else if (config?.modelRouting?.[field.key]) updates[field.key] = ''
    }
    for (const field of ROUTING_SECRET_FIELDS) {
      const value = apiKeyInputs[field.key]?.trim()
      if (value) updates[field.key] = value
      else if (clearedApiKeys.includes(field.key)) updates[field.key] = ''
    }
    return updates
  }

  const handleTestTool = async (key: keyof AppConfig['customPaths']) => {
    const value = customPaths[key]
    if (!value?.trim() || testingTool) return
    setTestingTool(key)
    try {
      const result = await window.devorbit?.testToolPath(value)
      onNotify(result?.message || 'Teste concluído.', result?.ok ? 'success' : 'error')
    } catch (err: any) {
      onNotify(`Erro ao testar: ${err.message}`, 'error')
    } finally {
      setTestingTool(null)
    }
  }

  // Ação por linha revelada no hover (e no foco via teclado).
  const rowActionClass = 'shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-50 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 motion-safe:transition-opacity cursor-pointer'

  const renderToolTestButton = (key: keyof AppConfig['customPaths']) => (
    <button
      type="button"
      onClick={() => void handleTestTool(key)}
      disabled={testingTool === key || !customPaths[key]?.trim()}
      className={rowActionClass}
    >
      {testingTool === key ? 'Testando…' : 'Testar'}
    </button>
  )

  const handleExport = async () => {
    try {
      const result = await window.devorbit?.exportConfig()
      onNotify(result?.message || 'Exportação concluída.', result?.success ? 'success' : 'info')
    } catch (err: any) {
      onNotify(`Erro ao exportar: ${err.message}`, 'error')
    }
  }

  const handleImport = async () => {
    try {
      const result = await window.devorbit?.importConfig()
      if (result?.success) {
        await onSaveConfig({})
        onNotify(result.message || 'Configurações importadas!', 'success')
      } else {
        onNotify(result?.message || 'Importação cancelada.', 'info')
      }
    } catch (err: any) {
      onNotify(`Erro ao importar: ${err.message}`, 'error')
    }
  }

  const handleStartRenamePreset = (preset: CustomTerminalPreset) => {
    if (!isCustomTerminalPresetId(preset.id)) {
      onNotify('Presets nativos do sistema não podem ser renomeados.', 'error')
      return
    }
    setEditingPresetId(preset.id)
    setEditingPresetName(preset.name)
  }

  const handleCommitRenamePreset = (presetId: string) => {
    if (!editingPresetName.trim()) {
      onNotify('O nome do preset não pode ser vazio.', 'error')
      return
    }
    const res = renameCustomTerminalPreset(terminalPresets, presetId, editingPresetName)
    if (res.error) {
      onNotify(res.error, 'error')
      return
    }
    setTerminalPresets(res.presets)
    setEditingPresetId(null)
    setEditingPresetName('')
    setIsDirty(true)
    onNotify(`Preset renomeado para "${res.updated?.name}".`, 'success')
  }

  const handleDeletePreset = (preset: CustomTerminalPreset) => {
    if (!isCustomTerminalPresetId(preset.id)) {
      onNotify('Presets nativos do sistema não podem ser excluídos.', 'error')
      return
    }
    const confirmed = window.confirm(`Tem certeza que deseja excluir o preset "${preset.name}"?`)
    if (!confirmed) return
    const res = deleteCustomTerminalPreset(terminalPresets, preset.id)
    if (res.error) {
      onNotify(res.error, 'error')
      return
    }
    setTerminalPresets(res.presets)
    if (editingPresetId === preset.id) {
      setEditingPresetId(null)
      setEditingPresetName('')
    }
    setIsDirty(true)
    onNotify(`Preset "${preset.name}" excluído.`, 'info')
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      await onSaveConfig({
        projectDirs,
        chatGptAccount1Name: account1Name,
        chatGptAccount2Name: account2Name,
        customPaths,
        modelRouting: buildRoutingUpdates(),
        terminalPresets,
        automation: {
          defaultExecutor: automation.defaultExecutor || undefined,
          defaultCodexAccount:
            automation.defaultExecutor === 'codex'
              ? automation.defaultCodexAccount || undefined
              : undefined,
          autoStartExecutor: automation.autoStartExecutor,
          restoreWorkspace: automation.restoreWorkspace,
          restoreProjectId: automation.restoreWorkspace
            ? automation.restoreProjectId || undefined
            : undefined,
        },
      })
      setIsDirty(false)
      onNotify('Configurações salvas com sucesso!', 'success')
      onClose()
    } catch (err: any) {
      onNotify(`Erro ao salvar configurações: ${err.message}`, 'error')
    } finally {
      setIsSaving(false)
    }
  }

  const inputClass = 'w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-3 py-1.5 text-xs text-[var(--text-primary)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus-ring)]/30'
  const monoInputClass = 'mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus-ring)]/30'

  return (
    <AccessibleDialog
      isOpen={isOpen && !suspended}
      titleId="settings-dialog-title"
      onClose={handleClose}
      className="w-full max-w-2xl bg-[var(--color-bg-panel)] border border-[var(--color-border-subtle)] rounded-[10px] shadow-[0_18px_42px_rgba(28,25,23,0.14)] overflow-hidden flex flex-col max-h-[calc(100dvh-48px)]"
    >
      {/* Cabeçalho único */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border-subtle)]">
        <h2 id="settings-dialog-title" className="text-base font-bold text-[var(--text-primary)]">Configurações do DevOrbit</h2>
        <button
          onClick={handleClose}
          aria-label="Fechar configurações"
          className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] motion-safe:transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Corpo: seções separadas por espaço + divisória 1px */}
      <div className="p-6 overflow-y-auto space-y-6 flex-1 text-sm text-[var(--text-primary)]">
        {/* Pastas de projetos */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold">Pastas de projetos</h3>
            <button
              onClick={handleAddDirectory}
              className="px-2.5 py-1 rounded-md text-xs font-semibold bg-[var(--surface-selected)] text-[var(--color-accent-strong)] border border-[var(--color-border-subtle)] hover:bg-[var(--surface-hover)] motion-safe:transition-colors cursor-pointer"
            >
              Adicionar pasta
            </button>
          </div>
          <div className="space-y-1">
            {projectDirs.map((dir) => (
              <div key={dir} className="group flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--surface-hover)]">
                <span className="truncate font-mono text-xs text-[var(--color-text-secondary)]" title={dir}>{dir}</span>
                <button
                  onClick={() => handleRemoveDirectory(dir)}
                  aria-label={`Remover pasta ${dir}`}
                  title="Remover pasta"
                  className="min-w-6 min-h-6 p-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--surface-hover)] rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 motion-safe:transition-opacity shrink-0 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            {projectDirs.length === 0 && (
              <p className="px-2 text-xs text-[var(--color-text-muted)]">Nenhuma pasta monitorada.</p>
            )}
          </div>
        </section>

        {/* Contas do ChatGPT Plus */}
        <section className="pt-5 border-t border-[var(--color-border-subtle)]">
          <h3 className="font-semibold mb-1">Contas do ChatGPT Plus</h3>
          <p className="text-xs text-[var(--color-text-muted)] mb-3">Nomes exibidos nos atalhos de alternância do header.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="chatgpt-account-1" className="text-xs text-[var(--color-text-secondary)] block mb-1">Conta 1:</label>
              <input
                id="chatgpt-account-1"
                name="chatgpt-account-1"
                type="text"
                value={account1Name}
                onChange={(e) => {
                  setAccount1Name(e.target.value)
                  setIsDirty(true)
                }}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="chatgpt-account-2" className="text-xs text-[var(--color-text-secondary)] block mb-1">Conta 2:</label>
              <input
                id="chatgpt-account-2"
                name="chatgpt-account-2"
                type="text"
                value={account2Name}
                onChange={(e) => {
                  setAccount2Name(e.target.value)
                  setIsDirty(true)
                }}
                className={inputClass}
              />
            </div>
          </div>
        </section>

        {/* Contas OpenAI Codex */}
        <section className="pt-5 border-t border-[var(--color-border-subtle)]">
          <h3 className="font-semibold mb-3">OpenAI Codex</h3>
          <div className="space-y-2">
            {(['account1', 'account2'] as const).map((accountKey) => {
              const status = authStatus?.[accountKey]
              const name = accountKey === 'account1' ? (account1Name || 'Conta 1') : (account2Name || 'Conta 2')
              const browserName = accountKey === 'account1' ? 'Chrome' : 'Brave'
              return (
                <div key={accountKey} className="flex items-center justify-between gap-3 py-1.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      title={status?.connected ? 'Autenticada e pronta para uso' : 'Não autenticada'}
                      aria-label={status?.connected ? 'Autenticada e pronta para uso' : 'Não autenticada'}
                      role="img"
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${status?.connected ? 'bg-[var(--color-success)]' : 'bg-[var(--color-warning)] motion-safe:animate-pulse'}`}
                    />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold truncate">
                        {name} ({browserName})
                      </div>
                      {status && !status.browserOk && (
                        <div className="text-xs text-[var(--color-danger)] truncate" title={status.browserPath}>
                          {browserName} não encontrado — ajuste o caminho abaixo
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpenAuthModal?.(accountKey)}
                    className="shrink-0 px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--surface-muted)] hover:bg-[var(--surface-hover)] text-[var(--color-text-secondary)] border border-[var(--color-border-subtle)] motion-safe:transition-colors cursor-pointer"
                  >
                    {status?.connected ? 'Reconectar' : 'Conectar'}
                  </button>
                </div>
              )
            })}
          </div>
        </section>

        {/* Executáveis e ferramentas */}
        <section className="pt-5 border-t border-[var(--color-border-subtle)]">
          <h3 className="font-semibold mb-1">Executáveis</h3>
          <p className="text-xs text-[var(--color-text-muted)] mb-3">Detectados no PATH; preencha só quando instalado fora do PATH.</p>

          <div className="space-y-1.5">
            {([
              { key: 'codex' as const, label: 'Codex CLI' },
              { key: 'agy' as const, label: 'Antigravity CLI' },
              { key: 'wt' as const, label: 'Windows Terminal' },
            ]).map((tool) => (
              <div key={tool.key} className="group flex items-center gap-2">
                <label htmlFor={'tool-path-' + tool.key} className="w-40 shrink-0 text-xs text-[var(--color-text-secondary)]">{tool.label}</label>
                <input
                  id={'tool-path-' + tool.key}
                  value={customPaths[tool.key] || ''}
                  onChange={(event) => updateCustomPath(tool.key, event.target.value)}
                  className="flex-1 min-w-0 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus-ring)]/30"
                />
                {renderToolTestButton(tool.key)}
              </div>
            ))}

            {AGENT_PATH_FIELDS.map((field) => (
              <div key={field.key} className="group flex items-center gap-2">
                <label htmlFor={'tool-path-' + field.key} className="w-40 shrink-0 text-xs text-[var(--color-text-secondary)]">{field.label}</label>
                <input
                  id={'tool-path-' + field.key}
                  value={customPaths[field.key] || ''}
                  placeholder={field.hint}
                  onChange={(event) => updateCustomPath(field.key, event.target.value)}
                  className="flex-1 min-w-0 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus-ring)]/30"
                />
                {renderToolTestButton(field.key)}
              </div>
            ))}

            {([
              { key: 'mimo' as const, label: 'Xiaomi MiMo AI' },
              { key: 'brave' as const, label: 'Navegador Brave' },
              { key: 'vscode' as const, label: 'Visual Studio Code' },
            ]).map((tool) => (
              <div key={tool.key} className="group flex items-center justify-between gap-3 py-1">
                <span className="text-xs text-[var(--color-text-secondary)]">{tool.label}</span>
                <span className="truncate font-mono text-xs text-[var(--color-text-muted)]" title={customPaths[tool.key] || 'Não detectado'}>
                  {customPaths[tool.key] || 'Não detectado'}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* Roteamento de modelos (BYOK) */}
        <section className="pt-5 border-t border-[var(--color-border-subtle)]">
          <h3 className="font-semibold mb-1">Roteamento de modelos (BYOK)</h3>
          <p className="text-xs text-[var(--color-text-muted)] mb-3">Chaves criptografadas no sistema; deixe vazio para manter a credencial salva.</p>

          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="routing-fast-model" className="text-xs text-[var(--color-text-secondary)] block mb-1">
                  Modelo rápido (fast):
                </label>
                <input
                  id="routing-fast-model"
                  name="routing-fast-model"
                  value={modelRouting.fastModel || ''}
                  placeholder="ex.: gpt-4o-mini"
                  onChange={(event) => updateRoutingField({ fastModel: event.target.value })}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="routing-deep-model" className="text-xs text-[var(--color-text-secondary)] block mb-1">
                  Modelo profundo (deep):
                </label>
                <input
                  id="routing-deep-model"
                  name="routing-deep-model"
                  value={modelRouting.deepModel || ''}
                  placeholder="ex.: claude-sonnet"
                  onChange={(event) => updateRoutingField({ deepModel: event.target.value })}
                  className={inputClass}
                />
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {ROUTING_SECRET_FIELDS.map((field) => {
                const configured = Boolean(config.modelRouting?.[field.hasKey])
                const markedForRemoval = clearedApiKeys.includes(field.key)
                return (
                  <div key={field.key}>
                    <label htmlFor={'routing-key-' + field.key} className="text-xs text-[var(--color-text-secondary)]">
                      {field.label}
                      {configured && !markedForRemoval && !apiKeyInputs[field.key] ? ' · configurada' : ''}
                    </label>
                    <div className="flex items-start gap-2">
                      <input
                        id={'routing-key-' + field.key}
                        name={'routing-key-' + field.key}
                        type="password"
                        autoComplete="off"
                        value={apiKeyInputs[field.key]}
                        placeholder={configured && !markedForRemoval ? 'Preencha para substituir' : 'Não configurada'}
                        onChange={(event) => updateApiKeyInput(field.key, event.target.value)}
                        className={monoInputClass}
                      />
                      {configured && !markedForRemoval && (
                        <button
                          type="button"
                          onClick={() => clearApiKey(field.key)}
                          className="mt-1 shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-danger)] hover:bg-[var(--surface-hover)] motion-safe:transition-colors cursor-pointer"
                        >
                          Remover
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            <div>
              <p className="text-xs font-semibold text-[var(--color-text-secondary)] mb-2">URLs base (gateways próprios)</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {ROUTING_BASE_URL_FIELDS.map((field) => (
                  <div key={field.key}>
                    <label htmlFor={'routing-url-' + field.key} className="text-xs text-[var(--color-text-secondary)]">
                      {field.label}
                    </label>
                    <input
                      id={'routing-url-' + field.key}
                      name={'routing-url-' + field.key}
                      value={modelRouting[field.key] || ''}
                      placeholder="URL padrão do provedor"
                      onChange={(event) => updateRoutingField({ [field.key]: event.target.value } as Partial<ModelRoutingConfig>)}
                      className={monoInputClass}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Automação */}
        <section className="pt-5 border-t border-[var(--color-border-subtle)]">
          <h3 className="font-semibold mb-3">Automação</h3>

          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="automation-default-executor" className="text-xs text-[var(--color-text-secondary)] block mb-1">
                  Executor padrão:
                </label>
                <select
                  id="automation-default-executor"
                  name="automation-default-executor"
                  value={automation.defaultExecutor || ''}
                  onChange={(event) => {
                    const value = event.target.value
                    updateAutomation({ defaultExecutor: value ? (value as AgentProviderId) : undefined })
                  }}
                  className={inputClass}
                >
                  <option value="">Nenhum</option>
                  {EXECUTOR_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              {automation.defaultExecutor === 'codex' && (
                <div>
                  <label htmlFor="automation-default-codex-account" className="text-xs text-[var(--color-text-secondary)] block mb-1">
                    Conta Codex padrão:
                  </label>
                  <select
                    id="automation-default-codex-account"
                    name="automation-default-codex-account"
                    value={automation.defaultCodexAccount || ''}
                    onChange={(event) => {
                      const value = event.target.value
                      updateAutomation({ defaultCodexAccount: value ? (value as 'account1' | 'account2') : undefined })
                    }}
                    className={inputClass}
                  >
                    <option value="">Nenhuma</option>
                    <option value="account1">{account1Name || 'Conta 1'}</option>
                    <option value="account2">{account2Name || 'Conta 2'}</option>
                  </select>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="automation-auto-start-executor" className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)] cursor-pointer">
                <input
                  id="automation-auto-start-executor"
                  name="automation-auto-start-executor"
                  type="checkbox"
                  checked={Boolean(automation.autoStartExecutor)}
                  onChange={(event) => updateAutomation({ autoStartExecutor: event.target.checked })}
                  className="h-3.5 w-3.5 accent-[var(--color-accent-strong)]"
                />
                Iniciar executor automaticamente ao abrir o terminal
              </label>
              <label htmlFor="automation-restore-workspace" className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)] cursor-pointer">
                <input
                  id="automation-restore-workspace"
                  name="automation-restore-workspace"
                  type="checkbox"
                  checked={Boolean(automation.restoreWorkspace)}
                  onChange={(event) => updateAutomation({ restoreWorkspace: event.target.checked })}
                  className="h-3.5 w-3.5 accent-[var(--color-accent-strong)]"
                />
                Restaurar workspace ao abrir o app
              </label>
            </div>

            {automation.restoreWorkspace && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="automation-restore-project" className="text-xs text-[var(--color-text-secondary)] block mb-1">
                    Projeto a restaurar:
                  </label>
                  <select
                    id="automation-restore-project"
                    name="automation-restore-project"
                    value={automation.restoreProjectId || ''}
                    onChange={(event) => {
                      const value = event.target.value
                      updateAutomation({ restoreProjectId: value || undefined })
                    }}
                    className={inputClass}
                  >
                    <option value="">Nenhum</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Presets de terminal personalizados */}
        <section className="pt-5 border-t border-[var(--color-border-subtle)]">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold">Presets de terminal</h3>
            <span className="text-xs font-mono text-[var(--color-text-muted)]">
              {terminalPresets.length} / {CUSTOM_TERMINAL_PRESET_LIMIT}
            </span>
          </div>

          {terminalPresets.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)]">
              Nenhum preset personalizado. Salve configurações de nós de terminal no Canvas para reutilizá-las aqui.
            </p>
          ) : (
            <div className="space-y-1">
              {terminalPresets.map((preset) => {
                const isEditing = editingPresetId === preset.id
                if (isEditing) {
                  return (
                    <div key={preset.id} className="flex items-center gap-2 py-1.5">
                      <input
                        type="text"
                        value={editingPresetName}
                        onChange={(e) => setEditingPresetName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            handleCommitRenamePreset(preset.id)
                          } else if (e.key === 'Escape') {
                            setEditingPresetId(null)
                            setEditingPresetName('')
                          }
                        }}
                        className="w-full max-w-xs rounded border border-[var(--color-accent)] bg-[var(--color-bg-panel)] px-2 py-1 text-xs text-[var(--text-primary)] focus:outline-none"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => handleCommitRenamePreset(preset.id)}
                        className="px-2 py-1 text-xs font-medium rounded bg-[var(--color-accent-strong)] text-[var(--color-accent-contrast)] hover:opacity-90 cursor-pointer"
                      >
                        Salvar
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingPresetId(null)
                          setEditingPresetName('')
                        }}
                        className="px-2 py-1 text-xs rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] text-[var(--color-text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                      >
                        Cancelar
                      </button>
                    </div>
                  )
                }
                return (
                  <div key={preset.id} className="group flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--surface-hover)]">
                    <div className="min-w-0">
                      <span className="block truncate text-xs font-semibold" title={preset.name}>{preset.name}</span>
                      <span className="block truncate font-mono text-[11px] text-[var(--color-text-muted)]">
                        {preset.command || 'shell'}{preset.args && preset.args.length > 0 ? ` ${preset.args.join(' ')}` : ''}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleStartRenamePreset(preset)}
                        aria-label={`Renomear preset ${preset.name}`}
                        title="Renomear preset"
                        className={rowActionClass}
                      >
                        <Edit2 className="inline h-3 w-3" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeletePreset(preset)}
                        aria-label={`Excluir preset ${preset.name}`}
                        title="Excluir preset"
                        className="p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--surface-hover)] rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 motion-safe:transition-opacity cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>

      {/* Rodapé */}
      <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-[var(--color-border-subtle)]">
        <span className="me-auto flex items-center gap-2">
          <button
            type="button"
            onClick={handleExport}
            className="px-3 py-1.5 rounded-md text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] motion-safe:transition-colors"
          >
            Exportar
          </button>
          <button
            type="button"
            onClick={handleImport}
            className="px-3 py-1.5 rounded-md text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] motion-safe:transition-colors"
          >
            Importar
          </button>
        </span>
        <button
          onClick={handleClose}
          className="px-4 py-1.5 rounded-md text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] motion-safe:transition-colors"
        >
          Cancelar
        </button>
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-md text-xs font-semibold bg-[var(--color-accent-strong)] text-[var(--color-accent-contrast)] hover:bg-[var(--color-accent-hover)] motion-safe:transition-colors cursor-pointer"
        >
          <Check className="w-3.5 h-3.5" />
          <span>{isSaving ? 'Salvando...' : 'Salvar Alterações'}</span>
        </button>
      </div>
    </AccessibleDialog>
  )
}
