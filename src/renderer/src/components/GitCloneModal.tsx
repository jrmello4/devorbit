import React, { useEffect, useState } from 'react'
import { GitPullRequest, Loader2, X } from 'lucide-react'
import type { AppConfig } from '../types'
import { AccessibleDialog } from './AccessibleDialog'

interface GitCloneModalProps {
  isOpen: boolean
  config: AppConfig | null
  onClose: () => void
  onCloned: () => void | Promise<void>
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void
}

function suggestFolderName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  const last = trimmed.split('/').pop() || ''
  return last.replace(/\.git$/i, '')
}

export const GitCloneModal: React.FC<GitCloneModalProps> = ({ isOpen, config, onClose, onCloned, onNotify }) => {
  const [parentDir, setParentDir] = useState('')
  const [folderName, setFolderName] = useState('')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [isCloning, setIsCloning] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    const first = config?.projectDirs?.[0] || ''
    setParentDir(first)
    setFolderName('')
    setRemoteUrl('')
  }, [isOpen, config])

  useEffect(() => {
    if (!folderName && remoteUrl) setFolderName(suggestFolderName(remoteUrl))
  }, [remoteUrl, folderName])

  if (!isOpen) return null

  const canSubmit = Boolean(parentDir.trim() && folderName.trim() && remoteUrl.trim()) && !isCloning

  const handleClose = () => {
    if (!isCloning) onClose()
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    setIsCloning(true)
    try {
      const result = await window.devorbit?.cloneGitRepository({
        parentDir: parentDir.trim(),
        folderName: folderName.trim(),
        remoteUrl: remoteUrl.trim(),
      })
      if (result?.success) {
        await onCloned()
        onNotify(result.message || 'Repositório clonado!', 'success')
        onClose()
      } else {
        onNotify(result?.message || 'Erro ao clonar repositório.', 'error')
      }
    } catch (err: unknown) {
      onNotify(`Erro ao clonar: ${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setIsCloning(false)
    }
  }

  return (
    <AccessibleDialog
      isOpen={isOpen}
      titleId="git-clone-dialog-title"
      onClose={handleClose}
      className="w-full max-w-lg bg-white border border-stone-200 rounded-[10px] shadow-[0_18px_42px_rgba(28,25,23,0.14)] overflow-hidden flex flex-col max-h-[calc(100dvh-48px)]"
    >
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200 bg-stone-50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-[8px] bg-[#edf3e8] text-[#3e562f] border border-[#cbd8bf]">
              <GitPullRequest className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <h2 id="git-clone-dialog-title" className="text-base font-bold text-stone-900">Clonar por link</h2>
              <p className="text-xs text-stone-600">Baixa a main mais recente mesmo sem .git local</p>
            </div>
          </div>
          <button type="button" onClick={handleClose} disabled={isCloning} aria-label="Fechar clonagem" className="p-1.5 rounded-lg text-stone-500 hover:text-stone-900 hover:bg-stone-100">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
        <div className="p-6 space-y-4 text-sm text-stone-900">
          <div>
            <label htmlFor="git-clone-parent" className="mb-1.5 block text-xs font-semibold text-stone-800">Pasta monitorada</label>
            <select id="git-clone-parent" value={parentDir} onChange={(e) => setParentDir(e.target.value)} disabled={isCloning} className="w-full rounded-[8px] border border-stone-300 bg-white px-3.5 py-2 text-sm">
              {(config?.projectDirs || []).map((dir) => <option key={dir} value={dir}>{dir}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="git-clone-url" className="mb-1.5 block text-xs font-semibold text-stone-800">Link HTTPS do repositório</label>
            <input id="git-clone-url" type="url" value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} placeholder="https://github.com/usuario/projeto.git" disabled={isCloning} className="w-full rounded-[8px] border border-stone-300 bg-white px-3.5 py-2 text-sm placeholder-stone-500" />
          </div>
          <div>
            <label htmlFor="git-clone-name" className="mb-1.5 block text-xs font-semibold text-stone-800">Nome da pasta</label>
            <input id="git-clone-name" value={folderName} onChange={(e) => setFolderName(e.target.value)} placeholder="meu-projeto" disabled={isCloning} className="w-full rounded-[8px] border border-stone-300 bg-white px-3.5 py-2 text-sm" />
            <p className="mt-1 text-xs text-stone-600">Se a pasta já existir vazia, o clone entra nela. Pasta com arquivos ou .git é recusada.</p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-stone-200 bg-stone-50 px-6 py-3">
          <button type="button" onClick={handleClose} disabled={isCloning} className="rounded-lg px-4 py-1.5 text-xs font-semibold text-stone-600 hover:bg-stone-100">Cancelar</button>
          <button type="submit" disabled={!canSubmit} className="flex items-center gap-1.5 rounded-lg bg-[#3e562f] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#334827] disabled:opacity-50">
            {isCloning ? <><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Clonando...</> : 'Clonar main recente'}
          </button>
        </div>
      </form>
    </AccessibleDialog>
  )
}
