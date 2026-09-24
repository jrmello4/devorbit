import React from 'react'
import { AlertTriangle, Check, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import { AccessibleDialog } from './AccessibleDialog'
import './EvolutionPanels.css'

export type HitlRisk = 'low' | 'medium' | 'high' | 'critical'

export interface HitlEvidence {
  label: string
  value?: string
  redacted?: boolean
}

export interface HitlApprovalRequest {
  id: string
  title: string
  summary: string
  risk: HitlRisk
  evidence: readonly HitlEvidence[]
}

export interface HitlApprovalDialogProps {
  isOpen: boolean
  request: HitlApprovalRequest | null
  onClose: () => void
  onApprove: (request: HitlApprovalRequest) => void | Promise<void>
  onReject: (request: HitlApprovalRequest) => void | Promise<void>
  isSubmitting?: boolean
}

const riskDetails: Record<HitlRisk, {
  label: string
  description: string
  Icon: typeof ShieldCheck
}> = {
  low: {
    label: 'Baixo',
    description: 'Ação com impacto limitado e reversível.',
    Icon: ShieldCheck,
  },
  medium: {
    label: 'Médio',
    description: 'Ação que pode alterar o estado do workspace.',
    Icon: AlertTriangle,
  },
  high: {
    label: 'Alto',
    description: 'Ação com impacto relevante em dados ou ferramentas.',
    Icon: ShieldAlert,
  },
  critical: {
    label: 'Crítico',
    description: 'Ação que exige revisão humana antes de continuar.',
    Icon: ShieldAlert,
  },
}

export const HitlApprovalDialog: React.FC<HitlApprovalDialogProps> = ({
  isOpen,
  request,
  onClose,
  onApprove,
  onReject,
  isSubmitting = false,
}) => {
  if (!isOpen || !request) return null

  const risk = riskDetails[request.risk]
  const RiskIcon = risk.Icon
  const titleId = 'hitl-approval-title-' + request.id

  const approve = () => {
    void onApprove(request)
  }

  const reject = () => {
    void onReject(request)
  }

  return (
    <AccessibleDialog
      isOpen={isOpen}
      titleId={titleId}
      onClose={isSubmitting ? () => undefined : onClose}
      className="evolution-dialog evolution-dialog--hitl"
    >
      <header className="evolution-dialog__header">
        <div className="evolution-dialog__heading">
          <span className="evolution-dialog__eyebrow">
            <RiskIcon aria-hidden="true" />
            Aprovação humana
          </span>
          <h2 id={titleId}>{request.title}</h2>
          <p>{request.summary}</p>
        </div>
        <button
          type="button"
          className="evolution-icon-button"
          onClick={onClose}
          disabled={isSubmitting}
          aria-label="Fechar aprovação"
        >
          <X aria-hidden="true" />
        </button>
      </header>

      <div className="evolution-dialog__body">
        <section className="hitl-risk" data-risk={request.risk} aria-labelledby={titleId + '-risk'}>
          <div className="hitl-risk__heading">
            <span id={titleId + '-risk'}>Risco da ação</span>
            <strong>{risk.label}</strong>
          </div>
          <p>{risk.description}</p>
        </section>

        <section className="hitl-evidence" aria-labelledby={titleId + '-evidence'}>
          <div className="evolution-section-heading">
            <h3 id={titleId + '-evidence'}>Evidência redigida</h3>
          </div>
          {request.evidence.length > 0 ? (
            <dl className="hitl-evidence__list">
              {request.evidence.map((item, index) => (
                <div className="hitl-evidence__item" key={item.label + '-' + index}>
                  <dt>{item.label}</dt>
                  <dd
                    data-redacted={item.redacted ? 'true' : 'false'}
                    aria-label={item.redacted ? 'Conteúdo redigido' : undefined}
                  >
                    {item.redacted ? 'Conteúdo redigido' : item.value || 'Não informado'}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="evolution-empty">Nenhuma evidência foi anexada a esta solicitação.</p>
          )}
        </section>
      </div>

      <footer className="evolution-dialog__footer">
        <button
          type="button"
          className="evolution-button evolution-button--quiet"
          onClick={reject}
          disabled={isSubmitting}
        >
          <X aria-hidden="true" />
          Rejeitar ação
        </button>
        <button
          type="button"
          className="evolution-button evolution-button--primary"
          onClick={approve}
          disabled={isSubmitting}
          aria-busy={isSubmitting}
        >
          <Check aria-hidden="true" />
          {isSubmitting ? 'Processando…' : 'Aprovar ação'}
        </button>
      </footer>
    </AccessibleDialog>
  )
}
