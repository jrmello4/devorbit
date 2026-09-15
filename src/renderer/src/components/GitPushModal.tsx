import React, { useState, useEffect } from 'react'
import {
  X,
  UploadCloud,
  GitBranch,
  FileCode,
  AlertCircle,
  ArrowUpCircle,
  Loader2,
} from 'lucide-react'
import type { GitChange, Project } from '../types'
import { AccessibleDialog } from './AccessibleDialog'

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
  const [changedFiles, setChangedFiles] = useState<GitChange[]>([])
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [isLoadingFiles, setIsLoadingFiles] = useState(false)
  const [isPushing, setIsPushing] = useState(false)

  useEffect(() => {
    if (project && isOpen) setCommitMessage(`feat: atualizações no ${project.name}`)
  }, [project, isOpen])

  // Carrega lista de arquivos modificados ao abrir
  useEffect(() => {
    let isMounted = true
    if (project && isOpen && project.git.hasChanges) {
      setIsLoadingFiles(true)
      window.devorbit
        ?.getGitChanges(project.path)
        .then((files) => {
          if (isMounted) {
            setChangedFiles(files || [])
            setSelectedPaths((files || []).map((file) => file.path))
          }
        })
        .catch(() => {
          if (isMounted) {
            setChangedFiles([])
            setSelectedPaths([])
          }
        })
        .finally(() => {
          if (isMounted) setIsLoadingFiles(false)
        })
    } else {
      setChangedFiles([])
      setSelectedPaths([])
    }
    return () => {
      isMounted = false
    }
  }, [project, isOpen])

  if (!isOpen || !project) return null

  const handlePush = async () => {
    if (!project) return
    setIsPushing(true)
    try {
      // Se houver alterações locais, envia a mensagem de commit
      const msgToSend = project.git.hasChanges
        ? commitMessage.trim() || `update: ${project.name}`
        : undefined

      if (project.git.hasChanges && selectedPaths.length === 0) {
        onNotify('Selecione pelo menos um arquivo para criar o commit.', 'error')
        return
      }

      const result = await window.devorbit?.pushGit(
        project.path,
        msgToSend,
        project.git.hasChanges ? { selectedPaths } : undefined,
      )

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
  const handleDialogClose = () => {
    if (!isPushing) onClose()
  }

  return (
    <AccessibleDialog
      isOpen={isOpen}
      titleId="git-push-dialog-title"
      onClose={handleDialogClose}
      className="w-full max-w-lg bg-white border border-stone-200 rounded-[10px] shadow-[0_18px_42px_rgba(28,25,23,0.14)] overflow-hidden flex flex-col max-h-[calc(100dvh-48px)] motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-150"
    >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200 bg-stone-50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-[8px] bg-[#edf3e8] text-[#3e562f] border border-[#cbd8bf]">
              <UploadCloud className="w-5 h-5" />
            </div>
            <div>
                <h2 id="git-push-dialog-title" className="text-base font-bold text-stone-900 flex items-center gap-2">
                Subir para o GitHub
                <span className="text-xs px-2 py-0.5 rounded-full bg-stone-100 text-stone-700 font-mono flex items-center gap-1 border border-stone-200">
                  <GitBranch className="w-3 h-3 text-stone-500" />
                  {git.branch}
                </span>
              </h2>
              <p className="text-xs text-stone-600 truncate max-w-xs" title={project.name}>{project.name}</p>
            </div>
          </div>
          <button
            onClick={handleDialogClose}
            disabled={isPushing}
            aria-label="Fechar envio para o GitHub"
            className="p-1.5 rounded-lg text-stone-500 hover:text-stone-900 hover:bg-stone-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-4 flex-1 min-h-0 text-sm text-stone-900">
          {/* Status summary */}
          <div className="flex flex-wrap gap-2">
            {git.ahead > 0 && (
              <span className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200">
                <ArrowUpCircle className="w-3.5 h-3.5" />
                {git.ahead} commit(s) local pronto(s) para push
              </span>
            )}
            {git.hasChanges && (
              <span className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-lg bg-amber-50 text-amber-800 border border-amber-200">
                <AlertCircle className="w-3.5 h-3.5" />
                {git.modifiedCount + git.untrackedCount} arquivo(s) com alterações locais
              </span>
            )}
          </div>

          {/* Commit Message Input (se houver alterações locais) */}
          {git.hasChanges && (
            <div>
              <label htmlFor="git-commit-message" className="font-semibold text-stone-800 block mb-1.5 text-xs">
                Mensagem do Commit:
              </label>
              <input
                id="git-commit-message"
                name="git-commit-message"
                type="text"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder="Ex: feat: adiciona nova funcionalidade"
                disabled={isPushing}
                aria-describedby="git-commit-message-help"
                className="w-full bg-white border border-stone-300 rounded-[8px] px-3.5 py-2 text-sm text-stone-900 placeholder-stone-500 focus:border-[#3e562f] focus:ring-1 focus:ring-[#3e562f]/30 focus:outline-none transition-[border-color,box-shadow]"
                autoFocus
              />
              <p id="git-commit-message-help" className="text-xs text-stone-600 mt-1">
                Somente os arquivos selecionados abaixo serão adicionados e commitados antes do envio.
              </p>
            </div>
          )}

          {/* Changed Files List */}
          {git.hasChanges && (
            <div>
              <label className="font-semibold text-stone-700 block mb-1.5 text-xs flex items-center gap-1.5">
                <FileCode className="w-3.5 h-3.5 text-stone-500" />
                Arquivos a serem enviados:
              </label>
              <div className="bg-stone-50 border border-stone-200 rounded-[8px] p-2.5 max-h-36 overflow-y-auto space-y-1 font-mono text-xs">
                {isLoadingFiles ? (
                  <p className="text-stone-600 text-xs py-1 text-center">
                    Listando alterações...
                  </p>
                ) : changedFiles.length === 0 ? (
                  <p className="text-stone-600 text-xs py-1 text-center">
                    Nenhum arquivo listado.
                  </p>
                ) : (
                  changedFiles.map((file) => (
                    <label
                      key={`${file.status}:${file.path}`}
                      className="flex items-center gap-2 text-stone-700 py-0.5 px-1 rounded hover:bg-stone-100 truncate"
                    >
                      <input
                        type="checkbox"
                        checked={selectedPaths.includes(file.path)}
                        onChange={() => setSelectedPaths((current) => current.includes(file.path)
                          ? current.filter((path) => path !== file.path)
                          : [...current, file.path])}
                        disabled={isPushing}
                        aria-label={`Selecionar ${file.path}`}
                      />
                      <span className="text-[10px] font-bold text-stone-500">{file.status.trim() || '  '}</span>
                      <span className="truncate" title={file.path}>{file.path}</span>
                    </label>
                  ))
                )}
              </div>
            </div>
          )}

          {!git.hasChanges && git.ahead > 0 && (
            <div className="p-3 rounded-[8px] bg-stone-50 border border-stone-200 text-xs text-stone-700">
              Você já possui commits criados localmente prontos para subir. Clique no botão abaixo para enviar ao GitHub.
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-stone-200 bg-stone-50">
          <button
            onClick={handleDialogClose}
            disabled={isPushing}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold text-stone-600 hover:text-stone-900 hover:bg-stone-100 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handlePush}
            disabled={isPushing}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-[#3e562f] text-white hover:bg-[#334827] disabled:opacity-50 transition-[background-color,color,opacity] cursor-pointer"
          >
            {isPushing ? (
              <>
                <Loader2 className="w-3.5 h-3.5 motion-safe:animate-spin" />
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
    </AccessibleDialog>
  )
}
