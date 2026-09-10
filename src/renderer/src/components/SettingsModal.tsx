import React, { useState } from 'react'
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

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  config: AppConfig | null
  onSaveConfig: (updated: Partial<AppConfig>) => Promise<void>
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void
  authStatus?: CodexAccountStatus | null
  onOpenAuthModal?: (account: 'account1' | 'account2') => void
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
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

  React.useEffect(() => {
    if (config && isOpen) {
      setProjectDirs(config.projectDirs)
      setAccount1Name(config.chatGptAccount1Name)
      setAccount2Name(config.chatGptAccount2Name)
      setCustomPaths(config.customPaths)
    }
  }, [config, isOpen])

  if (!isOpen || !config) return null

  const handleAddDirectory = async () => {
    try {
      const selected = await window.devorbit?.selectDirectory()
      if (selected && !projectDirs.includes(selected)) {
        setProjectDirs([...projectDirs, selected])
      }
    } catch (err: any) {
      onNotify(`Erro ao selecionar pasta: ${err.message}`, 'error')
    }
  }

  const handleRemoveDirectory = (dirToRemove: string) => {
    setProjectDirs(projectDirs.filter((d) => d !== dirToRemove))
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
      onNotify('Configurações salvas com sucesso!', 'success')
      onClose()
    } catch (err: any) {
      onNotify(`Erro ao salvar configurações: ${err.message}`, 'error')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl bg-[#0e1322] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
              <Settings className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Configurações do DevOrbit</h2>
              <p className="text-xs text-slate-400">Pastas monitoradas, contas e executáveis</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 text-sm">
          {/* Pastas de Projetos */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="font-semibold text-slate-200 flex items-center gap-2">
                <Folder className="w-4 h-4 text-indigo-400" />
                Pastas de Projetos Monitoradas
              </label>
              <button
                onClick={handleAddDirectory}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-indigo-600/20 text-indigo-300 border border-indigo-500/40 hover:bg-indigo-600/30 transition-all cursor-pointer"
              >
                <FolderPlus className="w-3.5 h-3.5" />
                Adicionar Pasta
              </button>
            </div>
            <p className="text-xs text-slate-500 mb-3">
              O DevOrbit varrerá as pastas abaixo em busca de repositórios Git e projetos.
            </p>

            <div className="space-y-2">
              {projectDirs.map((dir) => (
                <div
                  key={dir}
                  className="flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs"
                >
                  <span className="font-mono text-slate-300 truncate mr-2">{dir}</span>
                  <button
                    onClick={() => handleRemoveDirectory(dir)}
                    className="p-1 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors shrink-0"
                    title="Remover pasta"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Nomes das Contas ChatGPT */}
          <div className="pt-4 border-t border-slate-800/80">
            <label className="font-semibold text-slate-200 block mb-1">
              Contas do ChatGPT Plus (Brave)
            </label>
            <p className="text-xs text-slate-500 mb-3">
              Personalize o nome dos dois atalhos para facilitar a alternância no header.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <span className="text-xs text-slate-400 block mb-1">Conta 1:</span>
                <input
                  type="text"
                  value={account1Name}
                  onChange={(e) => setAccount1Name(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <div>
                <span className="text-xs text-slate-400 block mb-1">Conta 2:</span>
                <input
                  type="text"
                  value={account2Name}
                  onChange={(e) => setAccount2Name(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Status e Conexão das Contas OpenAI Codex */}
          <div className="pt-4 border-t border-slate-800/80">
            <label className="font-semibold text-slate-200 block mb-1">
              Status & Conexão do OpenAI Codex (Multi-Conta)
            </label>
            <p className="text-xs text-slate-500 mb-3">
              O Codex CLI isola credenciais por pasta sem exigir login/logout repetidos.
            </p>

            <div className="space-y-2.5">
              {/* Conta 1 */}
              <div className="flex items-center justify-between p-3 rounded-xl bg-slate-900/80 border border-slate-800">
                <div className="flex items-center gap-2.5">
                  <div
                    className={`w-2.5 h-2.5 rounded-full ${
                      authStatus?.account1?.connected
                        ? 'bg-emerald-400'
                        : 'bg-amber-400 animate-pulse'
                    }`}
                  />
                  <div>
                    <div className="text-xs font-semibold text-white">
                      {account1Name || 'Conta 1'} (Chrome)
                    </div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      {authStatus?.account1?.connected
                        ? 'Autenticada e pronta para uso'
                        : 'Não autenticada'}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => onOpenAuthModal?.('account1')}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-all cursor-pointer"
                >
                  {authStatus?.account1?.connected ? 'Reconectar' : 'Conectar Agora'}
                </button>
              </div>

              {/* Conta 2 */}
              <div className="flex items-center justify-between p-3 rounded-xl bg-slate-900/80 border border-slate-800">
                <div className="flex items-center gap-2.5">
                  <div
                    className={`w-2.5 h-2.5 rounded-full ${
                      authStatus?.account2?.connected
                        ? 'bg-emerald-400'
                        : 'bg-amber-400 animate-pulse'
                    }`}
                  />
                  <div>
                    <div className="text-xs font-semibold text-white">
                      {account2Name || 'Conta 2'} (Brave)
                    </div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      {authStatus?.account2?.connected
                        ? 'Autenticada e pronta para uso'
                        : 'Não autenticada (Requer login inicial)'}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => onOpenAuthModal?.('account2')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                    authStatus?.account2?.connected
                      ? 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
                      : 'bg-teal-500/20 text-teal-300 border border-teal-500/40 hover:bg-teal-500/30 shadow-sm shadow-teal-500/20'
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
          <div className="pt-4 border-t border-slate-800/80">
            <label className="font-semibold text-slate-200 block mb-1">
              Executáveis e Ferramentas Detectadas
            </label>
            <p className="text-xs text-slate-500 mb-3">
              Caminhos do sistema configurados para lançamento direto com 1 clique.
            </p>

            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between p-2 rounded-lg bg-slate-900/60 border border-slate-800">
                <span className="flex items-center gap-2 text-slate-300 font-medium">
                  <Sparkles className="w-3.5 h-3.5 text-indigo-400" /> Antigravity CLI
                </span>
                <span className="font-mono text-slate-500 truncate max-w-xs">{customPaths.agy}</span>
              </div>

              <div className="flex items-center justify-between p-2 rounded-lg bg-slate-900/60 border border-slate-800">
                <span className="flex items-center gap-2 text-slate-300 font-medium">
                  <Bot className="w-3.5 h-3.5 text-orange-400" /> Xiaomi MiMo AI
                </span>
                <span className="font-mono text-slate-500 truncate max-w-xs">{customPaths.mimo}</span>
              </div>

              <div className="flex items-center justify-between p-2 rounded-lg bg-slate-900/60 border border-slate-800">
                <span className="flex items-center gap-2 text-slate-300 font-medium">
                  <Globe className="w-3.5 h-3.5 text-emerald-400" /> Navegador Brave
                </span>
                <span className="font-mono text-slate-500 truncate max-w-xs">{customPaths.brave}</span>
              </div>

              <div className="flex items-center justify-between p-2 rounded-lg bg-slate-900/60 border border-slate-800">
                <span className="flex items-center gap-2 text-slate-300 font-medium">
                  <Code2 className="w-3.5 h-3.5 text-sky-400" /> Visual Studio Code
                </span>
                <span className="font-mono text-slate-500 truncate max-w-xs">{customPaths.vscode}</span>
              </div>

              <div className="flex items-center justify-between p-2 rounded-lg bg-slate-900/60 border border-slate-800">
                <span className="flex items-center gap-2 text-slate-300 font-medium">
                  <Terminal className="w-3.5 h-3.5 text-purple-400" /> Windows Terminal
                </span>
                <span className="font-mono text-slate-500 truncate max-w-xs">{customPaths.wt}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-slate-800 bg-slate-900/50">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-500 shadow-sm shadow-indigo-500/30 transition-all cursor-pointer"
          >
            <Check className="w-3.5 h-3.5" />
            <span>{isSaving ? 'Salvando...' : 'Salvar Alterações'}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
