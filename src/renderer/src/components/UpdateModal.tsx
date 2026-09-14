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
    <AccessibleDialog isOpen={isOpen} titleId="update-title" onClose={downloading ? () => undefined : onClose} className="w-full max-w-md rounded-xl border border-stone-300 bg-[#fdfcf9] p-6 shadow-2xl">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-[#e7eee1] p-2 text-[#3e562f]"><RefreshCw size={20} aria-hidden="true" /></div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#607157]">Atualizações do DevOrbit</p>
          <h2 id="update-title" className="mt-1 text-lg font-semibold text-stone-900">
            {downloaded ? 'Atualização pronta' : downloading ? 'Baixando atualização automaticamente' : 'Nova versão disponível'}
          </h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            {downloaded
              ? `A versão ${state.version ?? 'nova'} foi baixada. Reinicie o app para concluir a atualização.`
              : downloading
                ? `Baixando a versão ${state.version ?? 'nova'}${state.progress === undefined ? '…' : `: ${state.progress}%`}`
                : `A versão ${state.version ?? 'nova'} está disponível. O download começará automaticamente.`}
          </p>
        </div>
      </div>
      {downloading && <div className="mt-5 h-2 overflow-hidden rounded-full bg-stone-200" aria-label={`Download ${state.progress ?? 0}%`}><div className="h-full bg-[#3e562f] transition-[width]" style={{ width: `${state.progress ?? 0}%` }} /></div>}
      <div className="mt-6 flex justify-end gap-3">
        {!downloading && !downloaded && <button type="button" className="rounded-md px-3 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100" onClick={onClose}>Agora não</button>}
        {downloaded ? <button type="button" autoFocus className="inline-flex items-center gap-2 rounded-md bg-[#3e562f] px-4 py-2 text-sm font-semibold text-white hover:bg-[#304624]" onClick={onInstall}><RefreshCw size={16} aria-hidden="true" />Reiniciar e atualizar</button> : !downloading && <button type="button" autoFocus className="inline-flex items-center gap-2 rounded-md bg-[#3e562f] px-4 py-2 text-sm font-semibold text-white hover:bg-[#304624]" onClick={onDownload}><Download size={16} aria-hidden="true" />Baixar atualização</button>}
      </div>
    </AccessibleDialog>
  )
}
