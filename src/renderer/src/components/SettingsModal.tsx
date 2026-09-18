import React, { useRef, useState } from 'react'
import {
  X,
  FolderPlus,
  Trash2,
  Settings,
  Folder,
  Check,
  Bot,
  Globe,
  Sparkles,
  Terminal,
  Code2,
} from 'lucide-react'
import type { AppConfig, CodexAccountStatus } from '../types'
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
}

const AGENT_PATH_FIELDS: Array<{ key: 'opencode' | 'claude' | 'gemini' | 'aider' | 'customAgent'; label: string; hint: string }> = [
  { key: 'opencode', label: 'OpenCode', hint: 'opencode.cmd / opencode.exe' },
  { key: 'claude', label: 'Claude Code', hint: 'claude.cmd / claude.exe' },
  { key: 'gemini', label: 'Gemini CLI', hint: 'gemini.cmd / gemini.exe' },
  { key: 'aider', label: 'Aider', hint: 'aider.cmd / aider.exe' },
  { key: 'customAgent', label: 'Outro CLI', hint: 'Comando ou caminho do agente' },
]

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  suspended = false,
  onClose,
  config,
  onSaveConfig,
  onNotify,
  authStatus,
  onOpenAuthModal,
}) => {
  const [projectDirs, setProjectDirs] = useState<string[]>([])
  const [account1Name, setAccount1Name] = useState('')
  const [account2Name, setAccount2Name] = useState('')
  const [customPaths, setCustomPaths] = useState<AppConfig['customPaths']>({})
  const [isSaving, setIsSaving] = useState(false)
  const [testingTool, setTestingTool] = useState<string | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const initializedConfigRef = useRef<AppConfig | null>(null)

  React.useEffect(() => {
    if (!isOpen) {
      initializedConfigRef.current = null
      return
    }

    if (config && !suspended && initializedConfigRef.current !== config) {
      setProjectDirs(config.projectDirs)
      setAccount1Name(config.chatGptAccount1Name)
      setAccount2Name(config.chatGptAccount2Name)
      setCustomPaths(config.customPaths)
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

  const renderToolTestButton = (key: keyof AppConfig['customPaths']) => (
    <button
      type="button"
      onClick={() => void handleTestTool(key)}
      disabled={testingTool === key || !customPaths[key]?.trim()}
      className="mt-1.5 shrink-0 rounded-[5px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2.5 py-1.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:text-[var(--text-primary)] disabled:opacity-50"
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

  const handleSave = async () => {
    setIsSaving(true)
    try {
      await onSaveConfig({
        projectDirs,
        chatGptAccount1Name: account1Name,
        chatGptAccount2Name: account2Name,
        customPaths,
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

  return (
    <AccessibleDialog
      isOpen={isOpen && !suspended}
      titleId="settings-dialog-title"
      onClose={handleClose}
      className="w-full max-w-2xl bg-[var(--color-bg-panel)] border border-[var(--color-border-subtle)] rounded-[10px] shadow-[0_18px_42px_rgba(28,25,23,0.14)] overflow-hidden flex flex-col max-h-[calc(100dvh-48px)]"
    >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border-subtle)] bg-[var(--surface-muted)]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-[8px] bg-[var(--surface-selected)] text-[var(--color-accent-strong)] border border-[var(--color-border-subtle)]">
              <Settings className="w-5 h-5" />
            </div>
            <div>
              <h2 id="settings-dialog-title" className="text-base font-bold text-[var(--text-primary)]">Configurações do DevOrbit</h2>
              <p className="text-xs text-[var(--color-text-secondary)]">Pastas monitoradas, contas e executáveis</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            aria-label="Fechar configurações"
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 text-sm text-[var(--text-primary)]">
          {/* Pastas de Projetos */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold text-[var(--text-primary)] flex items-center gap-2">
                <Folder className="w-4 h-4 text-[var(--color-accent-strong)]" />
                Pastas de Projetos Monitoradas
              </h3>
              <button
                onClick={handleAddDirectory}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-[var(--surface-selected)] text-[var(--color-accent-strong)] border border-[var(--color-border-subtle)] hover:bg-[var(--surface-hover)] transition-[background-color,border-color,color] cursor-pointer"
              >
                <FolderPlus className="w-3.5 h-3.5" />
                Adicionar Pasta
              </button>
            </div>
            <p className="text-xs text-[var(--color-text-secondary)] mb-3">
              O DevOrbit varrerá as pastas abaixo em busca de repositórios Git e projetos.
            </p>

            <div className="space-y-2">
              {projectDirs.map((dir) => (
                <div
                  key={dir}
                  className="flex items-center justify-between px-3.5 py-2.5 rounded-[8px] bg-[var(--surface-muted)] border border-[var(--color-border-subtle)] text-xs"
                >
                  <span className="font-mono text-[var(--color-text-secondary)] truncate me-2" title={dir}>{dir}</span>
                  <button
                    onClick={() => handleRemoveDirectory(dir)}
                    aria-label={`Remover pasta ${dir}`}
                    className="min-w-6 min-h-6 p-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--surface-hover)] rounded transition-colors shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Nomes das Contas ChatGPT */}
          <div className="pt-4 border-t border-[var(--color-border-subtle)]">
              <h3 className="font-semibold text-[var(--text-primary)] block mb-1">
                Contas do ChatGPT Plus (Brave)
              </h3>
            <p className="text-xs text-[var(--color-text-secondary)] mb-3">
              Personalize o nome dos dois atalhos para facilitar a alternância no header.
            </p>

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
                  className="w-full bg-[var(--color-bg-panel)] border border-[var(--color-border-subtle)] rounded-lg px-3 py-1.5 text-xs text-[var(--text-primary)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus-ring)]/30"
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
                  className="w-full bg-[var(--color-bg-panel)] border border-[var(--color-border-subtle)] rounded-lg px-3 py-1.5 text-xs text-[var(--text-primary)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus-ring)]/30"
                />
              </div>
            </div>
            <div className="mt-3 rounded-[8px] border border-[var(--color-border-subtle)] bg-[var(--surface-selected)] px-3.5 py-3 text-xs text-[var(--color-text-secondary)]">
              Cada conta abre o ChatGPT em um perfil persistente e isolado do navegador. Na primeira abertura,
              faça login nessa janela; as próximas alternâncias reutilizarão a mesma sessão sem misturar cookies.
            </div>
          </div>

          {/* Status e Conexão das Contas OpenAI Codex */}
          <div className="pt-4 border-t border-[var(--color-border-subtle)]">
              <h3 className="font-semibold text-[var(--text-primary)] block mb-1">
                Status & Conexão do OpenAI Codex (Multi-Conta)
              </h3>
            <p className="text-xs text-[var(--color-text-secondary)] mb-3">
              O Codex CLI isola credenciais por pasta sem exigir login/logout repetidos.
            </p>

            <div className="space-y-2.5">
              {/* Conta 1 */}
              <div className="flex items-center justify-between p-3 rounded-[8px] bg-[var(--surface-muted)] border border-[var(--color-border-subtle)]">
                <div className="flex items-center gap-2.5">
                  <div
                    className={`w-2.5 h-2.5 rounded-full ${
                      authStatus?.account1?.connected
                        ? 'bg-[var(--color-success)]'
                        : 'bg-[var(--color-warning)] motion-safe:animate-pulse'
                    }`}
                  />
                  <div>
                    <div className="text-xs font-semibold text-[var(--text-primary)]">
                      {account1Name || 'Conta 1'} (Chrome)
                    </div>
                    <div className="text-xs text-[var(--color-text-secondary)] font-mono">
                      {authStatus?.account1?.connected
                        ? 'Autenticada e pronta para uso'
                        : 'Não autenticada'}
                    </div>
                    {authStatus && (
                      <div className={`text-xs font-mono ${authStatus.account1.browserOk ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-danger)]'}`} title={authStatus.account1.browserPath}>
                        {authStatus.account1.browserOk
                          ? 'Chrome detectado'
                          : 'Chrome não encontrado — ajuste o caminho abaixo'}
                      </div>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => onOpenAuthModal?.('account1')}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[var(--surface-muted)] hover:bg-[var(--surface-hover)] text-[var(--color-text-secondary)] border border-[var(--color-border-subtle)] transition-[background-color,border-color,color] cursor-pointer"
                >
                  {authStatus?.account1?.connected ? 'Reconectar' : 'Conectar Agora'}
                </button>
              </div>

              {/* Conta 2 */}
              <div className="flex items-center justify-between p-3 rounded-[8px] bg-[var(--surface-muted)] border border-[var(--color-border-subtle)]">
                <div className="flex items-center gap-2.5">
                  <div
                    className={`w-2.5 h-2.5 rounded-full ${
                      authStatus?.account2?.connected
                        ? 'bg-[var(--color-success)]'
                        : 'bg-[var(--color-warning)] motion-safe:animate-pulse'
                    }`}
                  />
                  <div>
                    <div className="text-xs font-semibold text-[var(--text-primary)]">
                      {account2Name || 'Conta 2'} (Brave)
                    </div>
                    <div className="text-xs text-[var(--color-text-secondary)] font-mono">
                      {authStatus?.account2?.connected
                        ? 'Autenticada e pronta para uso'
                        : 'Não autenticada (Requer login inicial)'}
                    </div>
                    {authStatus && (
                      <div className={`text-xs font-mono ${authStatus.account2.browserOk ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-danger)]'}`} title={authStatus.account2.browserPath}>
                        {authStatus.account2.browserOk
                          ? 'Brave detectado'
                          : 'Brave não encontrado — ajuste o caminho abaixo'}
                      </div>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => onOpenAuthModal?.('account2')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-[background-color,border-color,color,box-shadow] cursor-pointer ${
                    authStatus?.account2?.connected
                      ? 'bg-[var(--surface-muted)] hover:bg-[var(--surface-hover)] text-[var(--color-text-secondary)] border border-[var(--color-border-subtle)]'
                      : 'bg-[var(--surface-selected)] text-[var(--color-accent-strong)] border border-[var(--color-border-subtle)] hover:bg-[var(--surface-hover)]'
                  }`}
                >
                  {authStatus?.account2?.connected
                    ? 'Reconectar'
                    : 'Conectar no Brave Agora 🚀'}
                </button>
              </div>
            </div>
          </div>

          {/* Caminhos Detectados das Ferramentas */}
          <div className="pt-4 border-t border-[var(--color-border-subtle)]">
              <h3 className="font-semibold text-[var(--text-primary)] block mb-1">
                Executáveis e Ferramentas Detectadas
              </h3>
            <p className="text-xs text-[var(--color-text-secondary)] mb-3">
              Os CLIs do canvas são detectados automaticamente no PATH e iniciados no terminal interno. O DevOrbit nunca copia credenciais entre provedores.
            </p>

            <div className="space-y-2 text-xs">
              <div className="rounded-lg bg-[var(--surface-muted)] border border-[var(--color-border-subtle)] p-3">
                <label htmlFor="tool-path-codex" className="flex items-center gap-2 text-[var(--color-text-secondary)] font-medium">
                  <Bot className="w-3.5 h-3.5 text-[var(--color-accent-strong)]" /> Codex CLI
                </label>
                <div className="flex items-start gap-2">
                  <input id="tool-path-codex" value={customPaths.codex || ''} onChange={(event) => updateCustomPath('codex', event.target.value)} className="mt-1.5 w-full rounded-[5px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus-ring)]/30" />
                  {renderToolTestButton('codex')}
                </div>
              </div>

              <div className="rounded-lg bg-[var(--surface-muted)] border border-[var(--color-border-subtle)] p-3">
                <label htmlFor="tool-path-agy" className="flex items-center gap-2 text-[var(--color-text-secondary)] font-medium">
                  <Sparkles className="w-3.5 h-3.5 text-[var(--color-accent-strong)]" /> Antigravity CLI
                </label>
                <div className="flex items-start gap-2">
                  <input id="tool-path-agy" value={customPaths.agy || ''} onChange={(event) => updateCustomPath('agy', event.target.value)} className="mt-1.5 w-full rounded-[5px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus-ring)]/30" />
                  {renderToolTestButton('agy')}
                </div>
              </div>

              <div className="rounded-lg bg-[var(--surface-selected)] border border-[var(--color-border-subtle)] p-3">
                <div className="flex items-center gap-2 text-[var(--color-text-secondary)] font-medium">
                  <Bot className="w-3.5 h-3.5 text-[var(--color-accent-strong)]" /> Agentes locais do canvas
                </div>
                <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                  O DevOrbit procura automaticamente estes CLIs no PATH. Preencha um caminho apenas quando ele estiver instalado fora do PATH.
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {AGENT_PATH_FIELDS.map((field) => (
                    <div key={field.key}>
                      <label htmlFor={'tool-path-' + field.key} className="text-[11px] font-semibold text-[var(--color-text-secondary)]">{field.label}</label>
                      <div className="flex items-start gap-2">
                        <input id={'tool-path-' + field.key} value={customPaths[field.key] || ''} placeholder={field.hint} onChange={(event) => updateCustomPath(field.key, event.target.value)} className="mt-1.5 w-full rounded-[5px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus-ring)]/30" />
                        {renderToolTestButton(field.key)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between p-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--color-border-subtle)]">
                <span className="flex items-center gap-2 text-[var(--color-text-secondary)] font-medium">
                  <Bot className="w-3.5 h-3.5 text-[var(--color-accent-strong)]" /> Xiaomi MiMo AI
                </span>
                <span className="font-mono text-[var(--color-text-secondary)] truncate max-w-xs" title={customPaths.mimo || 'Não detectado'}>{customPaths.mimo || 'Não detectado'}</span>
              </div>

              <div className="flex items-center justify-between p-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--color-border-subtle)]">
                <span className="flex items-center gap-2 text-[var(--color-text-secondary)] font-medium">
                  <Globe className="w-3.5 h-3.5 text-[var(--color-accent-strong)]" /> Navegador Brave
                </span>
                <span className="font-mono text-[var(--color-text-secondary)] truncate max-w-xs" title={customPaths.brave || 'Não detectado'}>{customPaths.brave || 'Não detectado'}</span>
              </div>

              <div className="flex items-center justify-between p-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--color-border-subtle)]">
                <span className="flex items-center gap-2 text-[var(--color-text-secondary)] font-medium">
                  <Code2 className="w-3.5 h-3.5 text-[var(--color-accent-strong)]" /> Visual Studio Code
                </span>
                <span className="font-mono text-[var(--color-text-secondary)] truncate max-w-xs" title={customPaths.vscode || 'Não detectado'}>{customPaths.vscode || 'Não detectado'}</span>
              </div>

              <div className="rounded-lg bg-[var(--surface-muted)] border border-[var(--color-border-subtle)] p-3">
                <label htmlFor="tool-path-wt" className="flex items-center gap-2 text-[var(--color-text-secondary)] font-medium">
                  <Terminal className="w-3.5 h-3.5 text-[var(--color-accent-strong)]" /> Windows Terminal
                </label>
                <div className="flex items-start gap-2">
                  <input id="tool-path-wt" value={customPaths.wt || ''} onChange={(event) => updateCustomPath('wt', event.target.value)} className="mt-1.5 w-full rounded-[5px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus-ring)]/30" />
                  {renderToolTestButton('wt')}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-[var(--color-border-subtle)] bg-[var(--surface-muted)]">
          <span className="me-auto flex items-center gap-2">
            <button
              type="button"
              onClick={handleExport}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors"
            >
              Exportar
            </button>
            <button
              type="button"
              onClick={handleImport}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors"
            >
              Importar
            </button>
          </span>
          <button
            onClick={handleClose}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-[var(--color-accent-strong)] text-[var(--color-accent-contrast)] hover:bg-[var(--color-accent-hover)] shadow-sm shadow-[var(--color-accent-strong)]/20 transition-[background-color,color,box-shadow,opacity] cursor-pointer"
          >
            <Check className="w-3.5 h-3.5" />
            <span>{isSaving ? 'Salvando...' : 'Salvar Alterações'}</span>
          </button>
        </div>
    </AccessibleDialog>
  )
}
