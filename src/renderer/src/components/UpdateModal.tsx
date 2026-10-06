import React, { useEffect, useState } from 'react'
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
  const [isStartingDownload, setIsStartingDownload] = useState(false)

  // O botão "Baixar" só fica ocupado até o estado refletir o download em andamento.
  useEffect(() => {
    if (state?.status === 'downloading' || state?.status === 'downloaded') {
      setIsStartingDownload(false)
    }
  }, [state?.status])

  useEffect(() => {
    if (!isOpen) setIsStartingDownload(false)
  }, [isOpen])

  if (!state) return null
  const downloading = state.status === 'downloading'
  const downloaded = state.status === 'downloaded'

  const handleDownload = () => {
    setIsStartingDownload(true)
    onDownload()
  }

  return (
    <AccessibleDialog
      isOpen={isOpen}
      titleId="update-title"
      onClose={onClose}
      className="dialog-shell dialog--sm flex flex-col overflow-hidden"
    >
      <div className="dialog-shell__header">
        <h2 id="update-title" className="text-lg font-semibold text-[var(--text-primary)]">
          {downloaded ? 'Atualização pronta' : downloading ? 'Baixando atualização' : 'Nova versão disponível'}
        </h2>
        <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
          {downloaded
            ? `A versão ${state.version ?? 'nova'} foi baixada. Reinicie o app para concluir a atualização.`
            : downloading
              ? `Baixando a versão ${state.version ?? 'nova'}${state.progress === undefined ? '…' : `: ${state.progress}%`}`
              : `A versão ${state.version ?? 'nova'} está disponível. O download começará automaticamente.`}
        </p>
      </div>
      <div className="dialog-shell__body">
        {downloading && (
          <>
            <div className="h-2 overflow-hidden rounded-full bg-[var(--surface-selected)]" aria-label={`Download ${state.progress ?? 0}%`}>
              <div className="h-full bg-[var(--color-accent-strong)] transition-[width]" style={{ width: `${state.progress ?? 0}%` }} />
            </div>
            <p className="mt-3 text-xs text-[var(--color-text-muted)]">
              Você pode fechar esta janela — o download continua em segundo plano.
            </p>
          </>
        )}
      </div>
      <footer className="dialog-shell__footer">
        <div className="ms-auto flex items-center justify-end gap-2">
          {!downloaded && (
            <button type="button" className="btn btn--secondary" onClick={onClose}>
              {downloading ? 'Ocultar' : 'Agora não'}
            </button>
          )}
          {downloaded ? (
            <button type="button" autoFocus className="btn btn--primary" onClick={onInstall}>
              <RefreshCw size={16} aria-hidden="true" />Reiniciar e atualizar
            </button>
          ) : !downloading ? (
            <button
              type="button"
              autoFocus
              className="btn btn--primary"
              onClick={handleDownload}
              disabled={isStartingDownload}
              aria-busy={isStartingDownload}
            >
              <Download size={16} aria-hidden="true" />
              {isStartingDownload ? 'Baixando…' : 'Baixar atualização'}
            </button>
          ) : null}
        </div>
      </footer>
    </AccessibleDialog>
  )
}
