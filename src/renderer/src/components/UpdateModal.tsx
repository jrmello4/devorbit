import React from 'react'
import { Download, RefreshCw } from 'lucide-react'
import { AccessibleDialog } from './AccessibleDialog'
import type { UpdateState } from '../types'

interface UpdateModalProps {
  state: UpdateState | null
  isOpen: boolean
  onClose: () => void
  onDownload: () => void
  onInstall: () => void
}

export const UpdateModal: React.FC<UpdateModalProps> = ({ state, isOpen, onClose, onDownload, onInstall }) => {
  if (!state) return null
  const downloading = state.status === 'downloading'
  const downloaded = state.status === 'downloaded'

  return (
    <AccessibleDialog isOpen={isOpen} titleId="update-title" onClose={downloading ? () => undefined : onClose} className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] p-6 shadow-2xl">
      <div>
        <h2 id="update-title" className="text-lg font-semibold text-[var(--text-primary)]">
          {downloaded ? 'Atualização pronta' : downloading ? 'Baixando atualização automaticamente' : 'Nova versão disponível'}
        </h2>
        <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">
          {downloaded
            ? `A versão ${state.version ?? 'nova'} foi baixada. Reinicie o app para concluir a atualização.`
            : downloading
              ? `Baixando a versão ${state.version ?? 'nova'}${state.progress === undefined ? '…' : `: ${state.progress}%`}`
              : `A versão ${state.version ?? 'nova'} está disponível. O download começará automaticamente.`}
        </p>
      </div>
      {downloading && <div className="mt-5 h-2 overflow-hidden rounded-full bg-[var(--surface-selected)]" aria-label={`Download ${state.progress ?? 0}%`}><div className="h-full bg-[var(--color-accent-strong)] transition-[width]" style={{ width: `${state.progress ?? 0}%` }} /></div>}
      <div className="mt-6 flex justify-end gap-3">
        {!downloading && !downloaded && <button type="button" className="rounded-md px-3 py-2 text-sm font-medium text-[var(--color-text-secondary)] hover:bg-[var(--surface-hover)]" onClick={onClose}>Agora não</button>}
        {downloaded ? <button type="button" autoFocus className="inline-flex items-center gap-2 rounded-md bg-[var(--color-accent-strong)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] hover:bg-[var(--color-accent-hover)]" onClick={onInstall}><RefreshCw size={16} aria-hidden="true" />Reiniciar e atualizar</button> : !downloading && <button type="button" autoFocus className="inline-flex items-center gap-2 rounded-md bg-[var(--color-accent-strong)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] hover:bg-[var(--color-accent-hover)]" onClick={onDownload}><Download size={16} aria-hidden="true" />Baixar atualização</button>}
      </div>
    </AccessibleDialog>
  )
}
