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
      className="w-full max-w-2xl bg-white border border-stone-200 rounded-[10px] shadow-[0_18px_42px_rgba(28,25,23,0.14)] overflow-hidden flex flex-col max-h-[calc(100dvh-48px)]"
    >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200 bg-stone-50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-[8px] bg-[#edf3e8] text-[#3e562f] border border-[#cbd8bf]">
              <Settings className="w-5 h-5" />
            </div>
            <div>
              <h2 id="settings-dialog-title" className="text-base font-bold text-stone-900">Configurações do DevOrbit</h2>
              <p className="text-xs text-stone-600">Pastas monitoradas, contas e executáveis</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            aria-label="Fechar configurações"
            className="p-1.5 rounded-lg text-stone-500 hover:text-stone-900 hover:bg-stone-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 text-sm text-stone-900">
          {/* Pastas de Projetos */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold text-stone-800 flex items-center gap-2">
                <Folder className="w-4 h-4 text-[#3e562f]" />
                Pastas de Projetos Monitoradas
              </h3>
              <button
                onClick={handleAddDirectory}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-[#edf3e8] text-[#3e562f] border border-[#bdcfb0] hover:bg-[#e3ecdc] transition-[background-color,border-color,color] cursor-pointer"
              >
                <FolderPlus className="w-3.5 h-3.5" />
                Adicionar Pasta
              </button>
            </div>
            <p className="text-xs text-stone-600 mb-3">
              O DevOrbit varrerá as pastas abaixo em busca de repositórios Git e projetos.
            </p>

            <div className="space-y-2">
              {projectDirs.map((dir) => (
                <div
                  key={dir}
                  className="flex items-center justify-between px-3.5 py-2.5 rounded-[8px] bg-stone-50 border border-stone-200 text-xs"
                >
                  <span className="font-mono text-stone-700 truncate me-2" title={dir}>{dir}</span>
                  <button
                    onClick={() => handleRemoveDirectory(dir)}
                    aria-label={`Remover pasta ${dir}`}
                    className="min-w-6 min-h-6 p-1 text-stone-500 hover:text-red-700 hover:bg-stone-100 rounded transition-colors shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Nomes das Contas ChatGPT */}
          <div className="pt-4 border-t border-stone-200">
              <h3 className="font-semibold text-stone-800 block mb-1">
                Contas do ChatGPT Plus (Brave)
              </h3>
            <p className="text-xs text-stone-600 mb-3">
              Personalize o nome dos dois atalhos para facilitar a alternância no header.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="chatgpt-account-1" className="text-xs text-stone-600 block mb-1">Conta 1:</label>
                <input
                  id="chatgpt-account-1"
                  name="chatgpt-account-1"
                  type="text"
                  value={account1Name}
                  onChange={(e) => {
                    setAccount1Name(e.target.value)
                    setIsDirty(true)
                  }}
                  className="w-full bg-white border border-stone-300 rounded-lg px-3 py-1.5 text-xs text-stone-900 focus:border-[#3e562f] focus:outline-none focus:ring-1 focus:ring-[#3e562f]/30"
                />
              </div>
              <div>
                <label htmlFor="chatgpt-account-2" className="text-xs text-stone-600 block mb-1">Conta 2:</label>
                <input
                  id="chatgpt-account-2"
                  name="chatgpt-account-2"
                  type="text"
                  value={account2Name}
                  onChange={(e) => {
                    setAccount2Name(e.target.value)
                    setIsDirty(true)
                  }}
                  className="w-full bg-white border border-stone-300 rounded-lg px-3 py-1.5 text-xs text-stone-900 focus:border-[#3e562f] focus:outline-none focus:ring-1 focus:ring-[#3e562f]/30"
                />
              </div>
            </div>
            <div className="mt-3 rounded-[8px] border border-[#cbd8bf] bg-[#f4f7f1] px-3.5 py-3 text-xs text-stone-700">
              Cada conta abre o ChatGPT em um perfil persistente e isolado do navegador. Na primeira abertura,
              faça login nessa janela; as próximas alternâncias reutilizarão a mesma sessão sem misturar cookies.
            </div>
          </div>

          {/* Status e Conexão das Contas OpenAI Codex */}
          <div className="pt-4 border-t border-stone-200">
              <h3 className="font-semibold text-stone-800 block mb-1">
                Status & Conexão do OpenAI Codex (Multi-Conta)
              </h3>
            <p className="text-xs text-stone-600 mb-3">
              O Codex CLI isola credenciais por pasta sem exigir login/logout repetidos.
            </p>

            <div className="space-y-2.5">
              {/* Conta 1 */}
              <div className="flex items-center justify-between p-3 rounded-[8px] bg-stone-50 border border-stone-200">
                <div className="flex items-center gap-2.5">
                  <div
                    className={`w-2.5 h-2.5 rounded-full ${
                      authStatus?.account1?.connected
                        ? 'bg-emerald-600'
                        : 'bg-amber-700 motion-safe:animate-pulse'
                    }`}
                  />
                  <div>
                    <div className="text-xs font-semibold text-stone-900">
                      {account1Name || 'Conta 1'} (Chrome)
                    </div>
                    <div className="text-xs text-stone-600 font-mono">
                      {authStatus?.account1?.connected
                        ? 'Autenticada e pronta para uso'
                        : 'Não autenticada'}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => onOpenAuthModal?.('account1')}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-stone-100 hover:bg-stone-200 text-stone-700 border border-stone-300 transition-[background-color,border-color,color] cursor-pointer"
                >
                  {authStatus?.account1?.connected ? 'Reconectar' : 'Conectar Agora'}
                </button>
              </div>

              {/* Conta 2 */}
              <div className="flex items-center justify-between p-3 rounded-[8px] bg-stone-50 border border-stone-200">
                <div className="flex items-center gap-2.5">
                  <div
                    className={`w-2.5 h-2.5 rounded-full ${
                      authStatus?.account2?.connected
                        ? 'bg-emerald-600'
                        : 'bg-amber-700 motion-safe:animate-pulse'
                    }`}
                  />
                  <div>
                    <div className="text-xs font-semibold text-stone-900">
                      {account2Name || 'Conta 2'} (Brave)
                    </div>
                    <div className="text-xs text-stone-600 font-mono">
                      {authStatus?.account2?.connected
                        ? 'Autenticada e pronta para uso'
                        : 'Não autenticada (Requer login inicial)'}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => onOpenAuthModal?.('account2')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-[background-color,border-color,color,box-shadow] cursor-pointer ${
                    authStatus?.account2?.connected
                      ? 'bg-stone-100 hover:bg-stone-200 text-stone-700 border border-stone-300'
                      : 'bg-[#edf3e8] text-[#3e562f] border border-[#bdcfb0] hover:bg-[#e3ecdc]'
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
          <div className="pt-4 border-t border-stone-200">
              <h3 className="font-semibold text-stone-800 block mb-1">
                Executáveis e Ferramentas Detectadas
              </h3>
            <p className="text-xs text-stone-600 mb-3">
              Ajuste os executáveis usados para abrir ferramentas. Codex e Antigravity sempre iniciam no Prompt de Comando.
            </p>

            <div className="space-y-2 text-xs">
              <div className="rounded-lg bg-stone-50 border border-stone-200 p-3">
                <label htmlFor="tool-path-codex" className="flex items-center gap-2 text-stone-700 font-medium">
                  <Bot className="w-3.5 h-3.5 text-[#3e562f]" /> Codex CLI
                </label>
                <input id="tool-path-codex" value={customPaths.codex || ''} onChange={(event) => updateCustomPath('codex', event.target.value)} className="mt-1.5 w-full rounded-[5px] border border-stone-300 bg-white px-2.5 py-1.5 font-mono text-xs text-stone-800 focus:border-[#3e562f] focus:outline-none focus:ring-1 focus:ring-[#3e562f]/30" />
              </div>

              <div className="rounded-lg bg-stone-50 border border-stone-200 p-3">
                <label htmlFor="tool-path-agy" className="flex items-center gap-2 text-stone-700 font-medium">
                  <Sparkles className="w-3.5 h-3.5 text-[#3e562f]" /> Antigravity CLI
                </label>
                <input id="tool-path-agy" value={customPaths.agy || ''} onChange={(event) => updateCustomPath('agy', event.target.value)} className="mt-1.5 w-full rounded-[5px] border border-stone-300 bg-white px-2.5 py-1.5 font-mono text-xs text-stone-800 focus:border-[#3e562f] focus:outline-none focus:ring-1 focus:ring-[#3e562f]/30" />
              </div>

              <div className="flex items-center justify-between p-2 rounded-lg bg-stone-50 border border-stone-200">
                <span className="flex items-center gap-2 text-stone-700 font-medium">
                  <Bot className="w-3.5 h-3.5 text-[#3e562f]" /> Xiaomi MiMo AI
                </span>
                <span className="font-mono text-stone-600 truncate max-w-xs" title={customPaths.mimo || 'Não detectado'}>{customPaths.mimo || 'Não detectado'}</span>
              </div>

              <div className="flex items-center justify-between p-2 rounded-lg bg-stone-50 border border-stone-200">
                <span className="flex items-center gap-2 text-stone-700 font-medium">
                  <Globe className="w-3.5 h-3.5 text-[#3e562f]" /> Navegador Brave
                </span>
                <span className="font-mono text-stone-600 truncate max-w-xs" title={customPaths.brave || 'Não detectado'}>{customPaths.brave || 'Não detectado'}</span>
              </div>

              <div className="flex items-center justify-between p-2 rounded-lg bg-stone-50 border border-stone-200">
                <span className="flex items-center gap-2 text-stone-700 font-medium">
                  <Code2 className="w-3.5 h-3.5 text-[#3e562f]" /> Visual Studio Code
                </span>
                <span className="font-mono text-stone-600 truncate max-w-xs" title={customPaths.vscode || 'Não detectado'}>{customPaths.vscode || 'Não detectado'}</span>
              </div>

              <div className="rounded-lg bg-stone-50 border border-stone-200 p-3">
                <label htmlFor="tool-path-wt" className="flex items-center gap-2 text-stone-700 font-medium">
                  <Terminal className="w-3.5 h-3.5 text-[#3e562f]" /> Windows Terminal
                </label>
                <input id="tool-path-wt" value={customPaths.wt || ''} onChange={(event) => updateCustomPath('wt', event.target.value)} className="mt-1.5 w-full rounded-[5px] border border-stone-300 bg-white px-2.5 py-1.5 font-mono text-xs text-stone-800 focus:border-[#3e562f] focus:outline-none focus:ring-1 focus:ring-[#3e562f]/30" />
              </div>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-stone-200 bg-stone-50">
          <button
            onClick={handleClose}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold text-stone-600 hover:text-stone-900 hover:bg-stone-100 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-[#3e562f] text-white hover:bg-[#334827] shadow-sm shadow-[#3e562f]/20 transition-[background-color,color,box-shadow,opacity] cursor-pointer"
          >
            <Check className="w-3.5 h-3.5" />
            <span>{isSaving ? 'Salvando...' : 'Salvar Alterações'}</span>
          </button>
        </div>
    </AccessibleDialog>
  )
}
