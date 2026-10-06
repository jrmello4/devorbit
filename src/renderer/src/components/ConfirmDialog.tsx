import React, { useId } from 'react'
import { AccessibleDialog } from './AccessibleDialog'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  description?: string
  confirmLabel: string
  cancelLabel?: string
  /** Variante destrutiva: confirmação em tom de danger. */
  danger?: boolean
  /** Enquanto true, bloqueia Escape e os botões (operação em andamento). */
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Confirmação padrão do app: casca .dialog-shell (dialog--sm) + sistema .btn.
 * Escape cancela (ação segura) e o foco inicial vai no botão de cancelar —
 * exceto quando busy, quando o diálogo fica travado até a operação terminar.
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancelar',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}) => {
  const titleId = useId()
  return (
    <AccessibleDialog
      isOpen={open}
      titleId={titleId}
      onClose={() => {
        if (!busy) onCancel()
      }}
      className="dialog--sm"
    >
      <div className="dialog-shell">
        <header className="dialog-shell__header">
          <h2 id={titleId} className="dialog-shell__title">
            {title}
          </h2>
        </header>
        {description && (
          <div className="dialog-shell__body">
            <p>{description}</p>
          </div>
        )}
        <footer className="dialog-shell__footer">
          <button type="button" className="btn btn--secondary" autoFocus onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'btn btn--danger' : 'btn btn--primary'}
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </AccessibleDialog>
  )
}
