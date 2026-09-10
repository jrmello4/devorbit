import React, { useState, useEffect } from 'react'
import {
  X,
  UploadCloud,
  GitBranch,
  FileCode,
  Check,
  AlertCircle,
  ArrowUpCircle,
  Loader2,
} from 'lucide-react'
import type { Project } from '../types'

interface GitPushModalProps {
  isOpen: boolean
  onClose: () => void
  project: Project | null
  onSuccess: () => void
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void
}

export const GitPushModal: React.FC<GitPushModalProps> = ({
  isOpen,
  onClose,
  project,
  onSuccess,
  onNotify,
}) => {

  const [commitMessage, setCommitMessage] = useState('')
  const [changedFiles, setChangedFiles] = useState<string[]>([])
  const [isLoadingFiles, setIsLoadingFiles] = useState(false)
  const [isPushing, setIsPushing] = useState(false)

  useEffect(() => {
    if (project && isOpen) setCommitMessage(`feat: atualizações no ${project.name}`)
  }, [project, isOpen])

  // Carrega lista de arquivos modificados ao abrir
  useEffect(() => {
    let isMounted = true
    if (project && project.git.hasChanges) {
      setIsLoadingFiles(true)
      window.devorbit
        ?.getGitChanges(project.path)
        .then((files) => {
          if (isMounted) {
            setChangedFiles(files || [])
          }
        })
        .finally(() => {
          if (isMounted) setIsLoadingFiles(false)
        })
    } else {
      setChangedFiles([])
    }
    return () => {
      isMounted = false
    }
  }, [project])

  if (!isOpen || !project) return null

  const handlePush = async () => {
    if (!project) return
    setIsPushing(true)
    try {
      // Se houver alterações locais, envia a mensagem de commit
      const msgToSend = project.git.hasChanges
        ? commitMessage.trim() || `update: ${project.name}`
        : undefined

      const result = await window.devorbit?.pushGit(project.path, msgToSend)

      if (result?.success) {
        onNotify(result.message || 'Subido para o GitHub com sucesso!', 'success')
        onSuccess()
        onClose()
      } else {
        onNotify(result?.message || 'Erro ao subir para o GitHub', 'error')
      }
    } catch (err: any) {
      onNotify(`Erro no push: ${err.message}`, 'error')
    } finally {
      setIsPushing(false)
    }
  }

  const { git } = project

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg bg-[#0e1322] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-sky-500/20 text-sky-400 border border-sky-500/30">
              <UploadCloud className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                Subir para o GitHub
                <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono flex items-center gap-1">
                  <GitBranch className="w-3 h-3 text-slate-400" />
                  {git.branch}
                </span>
              </h2>
              <p className="text-xs text-slate-400 truncate max-w-xs">{project.name}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={isPushing}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-4 flex-1 text-sm">
          {/* Status summary */}
          <div className="flex flex-wrap gap-2">
            {git.ahead > 0 && (
              <span className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                <ArrowUpCircle className="w-3.5 h-3.5" />
                {git.ahead} commit(s) local pronto(s) para push
              </span>
            )}
            {git.hasChanges && (
              <span className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-lg bg-amber-500/15 text-amber-300 border border-amber-500/30">
                <AlertCircle className="w-3.5 h-3.5" />
                {git.modifiedCount + git.untrackedCount} arquivo(s) com alterações locais
              </span>
            )}
          </div>

          {/* Commit Message Input (se houver alterações locais) */}
          {git.hasChanges && (
            <div>
              <label className="font-semibold text-slate-200 block mb-1.5 text-xs">
                Mensagem do Commit:
              </label>
              <input
                type="text"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder="Ex: feat: adiciona nova funcionalidade"
                disabled={isPushing}
                className="w-full bg-slate-900 border border-slate-700/80 rounded-xl px-3.5 py-2 text-xs text-slate-200 placeholder-slate-500 focus:border-sky-500 focus:ring-1 focus:ring-sky-500/50 focus:outline-none transition-all"
                autoFocus
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Todas as alterações locais serão adicionadas (`git add -A`) e commitadas automaticamente antes do envio.
              </p>
            </div>
          )}

          {/* Changed Files List */}
          {git.hasChanges && (
            <div>
              <label className="font-semibold text-slate-300 block mb-1.5 text-xs flex items-center gap-1.5">
                <FileCode className="w-3.5 h-3.5 text-slate-400" />
                Arquivos a serem enviados:
              </label>
              <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-2.5 max-h-36 overflow-y-auto space-y-1 font-mono text-xs">
                {isLoadingFiles ? (
                  <p className="text-slate-500 text-[11px] py-1 text-center">
                    Listando alterações...
                  </p>
                ) : changedFiles.length === 0 ? (
                  <p className="text-slate-500 text-[11px] py-1 text-center">
                    Nenhum arquivo listado.
                  </p>
                ) : (
                  changedFiles.map((file, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-2 text-slate-300 py-0.5 px-1 rounded hover:bg-slate-900 truncate"
                    >
                      <span className="text-sky-400 text-[10px] font-bold">●</span>
                      <span className="truncate">{file}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {!git.hasChanges && git.ahead > 0 && (
            <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800 text-xs text-slate-300">
              Você já possui commits criados localmente prontos para subir. Clique no botão abaixo para enviar ao GitHub.
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-slate-800 bg-slate-900/50">
          <button
            onClick={onClose}
            disabled={isPushing}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handlePush}
            disabled={isPushing}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-sky-600 text-white hover:bg-sky-500 shadow-md shadow-sky-500/20 disabled:opacity-50 transition-all cursor-pointer"
          >
            {isPushing ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Subindo para o GitHub...</span>
              </>
            ) : (
              <>
                <UploadCloud className="w-3.5 h-3.5" />
                <span>Subir para o GitHub (Push)</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
