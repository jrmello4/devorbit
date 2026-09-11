import React, { useEffect, useId, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  FileCode,
  GitBranch,
  GitCommit,
  Loader2,
  UploadCloud,
  X,
} from 'lucide-react'
import type { Project } from '../types'
import { AccessibleDialog } from './AccessibleDialog'

export interface GitInitPreviewData {
  path: string
  canInitialize: boolean
  isRepository: boolean
  branch: string
  fileCount: number
  files: string[]
  truncated: boolean
  fingerprint: string
  message: string
}

export interface GitInitFormOptions {
  branch: string
  remoteUrl?: string
  initialCommit: boolean
  commitMessage?: string
  push: boolean
  confirmAllFiles: boolean
  previewFingerprint?: string
}

export interface GitInitResultData {
  success: boolean
  initialized: boolean
  commitCreated: boolean
  pushed: boolean
  preview?: GitInitPreviewData
  message: string
  output?: string
}

interface GitInitModalProps {
  isOpen: boolean
  project: Project | null
  onClose: () => void
  onPreview: (projectPath: string, branch: string) => Promise<GitInitPreviewData>
  onInit: (projectPath: string, options: GitInitFormOptions) => Promise<GitInitResultData>
  onProjectUpdated: () => void | Promise<void>
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void
}

export const GitInitModal: React.FC<GitInitModalProps> = ({
  isOpen,
  project,
  onClose,
  onPreview,
  onInit,
  onProjectUpdated,
  onNotify,
}) => {
  const descriptionId = useId()
  const onPreviewRef = useRef(onPreview)
  const onNotifyRef = useRef(onNotify)
  useEffect(() => { onPreviewRef.current = onPreview }, [onPreview])
  useEffect(() => { onNotifyRef.current = onNotify }, [onNotify])
  const [branch, setBranch] = useState('main')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [initialCommit, setInitialCommit] = useState(false)
  const [commitMessage, setCommitMessage] = useState('chore: inicializa repositório')
  const [push, setPush] = useState(false)
  const [confirmAllFiles, setConfirmAllFiles] = useState(false)
  const [preview, setPreview] = useState<GitInitPreviewData | null>(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [isInitializing, setIsInitializing] = useState(false)

  useEffect(() => {
    let mounted = true
    if (!isOpen || !project) {
      setPreview(null)
      return () => { mounted = false }
    }

    setBranch('main')
    setRemoteUrl('')
    setInitialCommit(false)
    setCommitMessage('chore: inicializa repositório')
    setPush(false)
    setConfirmAllFiles(false)
    setIsLoadingPreview(true)

    onPreviewRef.current(project.path, 'main')
      .then((result) => {
        if (mounted) setPreview(result)
      })
      .catch((error: unknown) => {
        if (mounted) {
          setPreview(null)
          onNotifyRef.current(`Não foi possível analisar a pasta: ${error instanceof Error ? error.message : String(error)}`, 'error')
        }
      })
      .finally(() => {
        if (mounted) setIsLoadingPreview(false)
      })

    return () => { mounted = false }
  }, [isOpen, project])

  useEffect(() => {
    if (!initialCommit) {
      setPush(false)
      setConfirmAllFiles(false)
    }
  }, [initialCommit])

  if (!isOpen || !project) return null

  const canSubmit = Boolean(
    preview?.canInitialize &&
    !isLoadingPreview &&
    !isInitializing &&
    (!initialCommit || (confirmAllFiles && commitMessage.trim().length > 0 && !preview.truncated && Boolean(preview.fingerprint))) &&
    (!push || remoteUrl.trim().length > 0)
  )

  const handleClose = () => {
    if (!isInitializing) onClose()
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmit || !project) return

    setIsInitializing(true)
    try {
      const result = await onInit(project.path, {
        branch: branch.trim() || 'main',
        remoteUrl: remoteUrl.trim() || undefined,
        initialCommit,
        commitMessage: initialCommit ? commitMessage.trim() : undefined,
        push,
        confirmAllFiles,
        previewFingerprint: preview?.fingerprint,
      })
      if (result.success) {
        await onProjectUpdated()
        onNotify(result.message, 'success')
        onClose()
      } else {
        // A failed attempt must never carry an old acknowledgement into a
        // retry. The backend may have refreshed the preview or created `.git`
        // before failing the commit/push, so require an explicit re-review.
        setConfirmAllFiles(false)
        if (result.preview) setPreview(result.preview)
        if (result.initialized) await onProjectUpdated()
        onNotify(result.message, 'error')
      }
    } catch (error: unknown) {
      onNotify(`Não foi possível criar o repositório: ${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setIsInitializing(false)
    }
  }

  return (
    <AccessibleDialog
      isOpen={isOpen}
      titleId="git-init-dialog-title"
      onClose={handleClose}
      className="w-full max-w-xl bg-white border border-stone-200 rounded-[10px] shadow-[0_18px_42px_rgba(28,25,23,0.14)] overflow-hidden flex flex-col max-h-[calc(100dvh-48px)] motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-150"
    >
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200 bg-stone-50">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="p-2 rounded-[8px] bg-[#edf3e8] text-[#3e562f] border border-[#cbd8bf]">
              <GitBranch className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 id="git-init-dialog-title" className="text-base font-bold text-stone-900">Adicionar Git ao projeto</h2>
              <p className="text-xs text-stone-600 truncate" title={project.name}>{project.name}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={isInitializing}
            aria-label="Fechar inicialização do Git"
            className="p-1.5 rounded-lg text-stone-500 hover:text-stone-900 hover:bg-stone-100 transition-colors"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-4 flex-1 min-h-0 text-sm text-stone-900" aria-describedby={descriptionId}>
          <p id={descriptionId} className="text-stone-700 text-xs leading-relaxed">
            O DevOrbit criará um repositório novo nesta pasta sem apagar ou substituir arquivos existentes.
            Revise a prévia abaixo antes de escolher o primeiro commit.
          </p>

          <div className="rounded-[8px] border border-stone-200 bg-stone-50 p-3" aria-live="polite" aria-busy={isLoadingPreview}>
            <div className="flex items-center gap-2 text-xs font-semibold text-stone-800">
              {isLoadingPreview ? <Loader2 className="h-4 w-4 text-[#3e562f] motion-safe:animate-spin" aria-hidden="true" /> : preview?.canInitialize ? <CheckCircle2 className="h-4 w-4 text-emerald-700" aria-hidden="true" /> : <AlertCircle className="h-4 w-4 text-amber-700" aria-hidden="true" />}
              <span>{isLoadingPreview ? 'Analisando arquivos...' : preview?.message || 'A prévia ainda não está disponível.'}</span>
            </div>
            {preview && !isLoadingPreview && (
              <>
                <div className="mt-2 flex items-center gap-2 text-xs text-stone-600">
                  <FileCode className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{preview.fileCount} arquivo(s) encontrado(s)</span>
                  <span aria-hidden="true">·</span>
                  <span>branch {branch.trim() || 'main'}</span>
                </div>
                {preview.truncated && (
                  <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs leading-relaxed text-amber-800">
                    A prévia foi limitada porque há muitos arquivos ou uma pasta não pôde ser lida.
                    O commit inicial fica bloqueado até que a lista completa possa ser revisada.
                  </p>
                )}
                {preview.files.length > 0 && (
                  <div className="mt-2 max-h-28 overflow-y-auto rounded-lg border border-stone-200 bg-white p-2 font-mono text-[11px] text-stone-700" aria-label="Prévia de arquivos">
                    {preview.files.map((file) => <div key={file} className="truncate py-0.5" title={file}>{file}</div>)}
                    {preview.truncated && <div className="pt-1 text-amber-800">… prévia incompleta; commit bloqueado</div>}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="git-init-branch" className="mb-1.5 block text-xs font-semibold text-stone-800">Branch inicial</label>
              <input id="git-init-branch" name="branch" value={branch} onChange={(event) => setBranch(event.target.value)} disabled={isInitializing} className="w-full rounded-[8px] border border-stone-300 bg-white px-3.5 py-2 text-sm text-stone-900 focus:border-[#3e562f] focus:outline-none focus:ring-1 focus:ring-[#3e562f]/30" />
            </div>
            <div>
              <label htmlFor="git-init-remote" className="mb-1.5 block text-xs font-semibold text-stone-800">Remote HTTPS <span className="font-normal text-stone-600">(opcional)</span></label>
              <input id="git-init-remote" name="remoteUrl" type="url" value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} placeholder="https://github.com/usuario/projeto.git" disabled={isInitializing} className="w-full rounded-[8px] border border-stone-300 bg-white px-3.5 py-2 text-sm text-stone-900 placeholder-stone-500 focus:border-[#3e562f] focus:outline-none focus:ring-1 focus:ring-[#3e562f]/30" />
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-[8px] border border-stone-200 bg-stone-50 p-3">
            <input type="checkbox" checked={initialCommit} onChange={(event) => setInitialCommit(event.target.checked)} disabled={isInitializing || isLoadingPreview || Boolean(preview?.truncated)} className="mt-0.5 h-4 w-4 accent-[#3e562f]" />
            <span><span className="block text-xs font-semibold text-stone-800">Criar primeiro commit</span><span className="mt-0.5 block text-xs text-stone-600">Todos os arquivos não ignorados poderão ser adicionados com <code>git add -A</code>.</span></span>
          </label>

          {initialCommit && (
            <div className="space-y-3 rounded-[8px] border border-[#cbd8bf] bg-[#f4f7f1] p-3">
              <div>
                <label htmlFor="git-init-commit-message" className="mb-1.5 block text-xs font-semibold text-stone-800">Mensagem do commit</label>
                <input id="git-init-commit-message" name="commitMessage" value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} disabled={isInitializing} className="w-full rounded-[8px] border border-stone-300 bg-white px-3.5 py-2 text-sm text-stone-900 focus:border-[#3e562f] focus:outline-none focus:ring-1 focus:ring-[#3e562f]/30" />
              </div>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input type="checkbox" checked={confirmAllFiles} onChange={(event) => setConfirmAllFiles(event.target.checked)} disabled={isInitializing} className="mt-0.5 h-4 w-4 accent-[#3e562f]" />
                <span className="text-xs text-stone-700">Confirmo que revisei a prévia e aceito que todos os arquivos não ignorados sejam incluídos no commit.</span>
              </label>
              <label className={`flex cursor-pointer items-start gap-2.5 ${remoteUrl.trim() ? '' : 'opacity-60'}`}>
                <input type="checkbox" checked={push} onChange={(event) => setPush(event.target.checked)} disabled={isInitializing || !remoteUrl.trim()} className="mt-0.5 h-4 w-4 accent-[#3e562f]" />
                <span><span className="block text-xs font-semibold text-stone-800">Enviar para o remote após o commit</span><span className="mt-0.5 block text-xs text-stone-600">O push nunca usa force. Um remote com histórico será recusado.</span></span>
              </label>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-stone-200 bg-stone-50 px-6 py-3">
          <button type="button" onClick={handleClose} disabled={isInitializing} className="rounded-lg px-4 py-1.5 text-xs font-semibold text-stone-600 hover:bg-stone-100 hover:text-stone-900 transition-colors">Cancelar</button>
          <button type="submit" disabled={!canSubmit} className="flex items-center gap-1.5 rounded-lg bg-[#3e562f] px-4 py-1.5 text-xs font-semibold text-white transition-[background-color,color,opacity] hover:bg-[#334827] disabled:cursor-not-allowed disabled:opacity-50">
            {isInitializing ? <><Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" /> Processando...</> : push ? <><UploadCloud className="h-3.5 w-3.5" aria-hidden="true" /> Criar e enviar</> : initialCommit ? <><GitCommit className="h-3.5 w-3.5" aria-hidden="true" /> Criar e commitar</> : <><GitBranch className="h-3.5 w-3.5" aria-hidden="true" /> Criar repositório</>}
          </button>
        </div>
      </form>
    </AccessibleDialog>
  )
}
