import React, { useState, useEffect, useRef } from 'react'
import {
  X,
  Bot,
  Copy,
  Check,
  ExternalLink,
  Loader2,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Globe,
  ShieldCheck,
} from 'lucide-react'
import type { AppConfig, CodexAuthProgress } from '../types'
import { AccessibleDialog } from './AccessibleDialog'

interface CodexAuthModalProps {
  isOpen: boolean
  account: 'account1' | 'account2'
  onClose: () => void
  onSuccess: () => void
  config: AppConfig | null
}

export const CodexAuthModal: React.FC<CodexAuthModalProps> = ({
  isOpen,
  account,
  onClose,
  onSuccess,
  config,
}) => {
  const isAccount2 = account === 'account2'
  const accountLabel = isAccount2
    ? config?.chatGptAccount2Name || 'Conta 2 (Brave)'
    : config?.chatGptAccount1Name || 'Conta 1 (Chrome)'
  const browserName = isAccount2 ? 'Brave' : 'Google Chrome'

  const [status, setStatus] = useState<CodexAuthProgress['status']>('idle')
  const [authUrl, setAuthUrl] = useState<string>('')
  const [copied, setCopied] = useState(false)
  const [message, setMessage] = useState('')
  const [browserReopenError, setBrowserReopenError] = useState('')
  const successTimerRef = useRef<number | null>(null)
  const onSuccessRef = useRef(onSuccess)

  useEffect(() => {
    onSuccessRef.current = onSuccess
  }, [onSuccess])

  useEffect(() => {
    if (!isOpen) return

    const unsubscribe = window.devorbit?.onCodexAuthProgress?.((progress) => {
      if (progress.account === account) {
        setStatus(progress.status)
        if (progress.verificationUrl) {
          setAuthUrl(progress.verificationUrl)
        }
        if (progress.message) {
          setMessage(progress.message)
        }
        if (progress.status === 'success') {
          if (successTimerRef.current !== null) {
            window.clearTimeout(successTimerRef.current)
          }
          successTimerRef.current = window.setTimeout(() => {
            successTimerRef.current = null
            onSuccessRef.current()
          }, 1800)
        }
      }
    })

    // Register the progress listener before starting the process so fast
    // startup/error events cannot be lost between the two calls.
    void handleStartLogin()

    return () => {
      unsubscribe?.()
      if (successTimerRef.current !== null) {
        window.clearTimeout(successTimerRef.current)
        successTimerRef.current = null
      }
    }
  }, [account, isOpen])

  if (!isOpen) return null

  const handleStartLogin = async () => {
    setStatus('starting')
    setMessage(`Iniciando conexão oficial com a OpenAI para ${accountLabel}...`)
    setAuthUrl('')
    setBrowserReopenError('')
    try {
      await window.devorbit?.startCodexLogin(account)
    } catch (err: any) {
      setStatus('error')
      setMessage(`Falha ao iniciar login: ${err instanceof Error ? err.message : String(err || 'erro desconhecido')}`)
    }
  }

  const handleCopyUrl = async () => {
    if (!authUrl) return
    try {
      await navigator.clipboard.writeText(authUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch (err: unknown) {
      setCopied(false)
      setBrowserReopenError(`Não foi possível copiar o link de autorização: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleOpenBrowserAgain = async () => {
    if (!authUrl) return
    try {
      const result = await window.devorbit?.launchTool(isAccount2 ? 'brave' : 'chrome', '', {
        account,
        url: authUrl,
      })
      if (!result?.success) {
        setBrowserReopenError(result?.message || 'Falha ao reabrir o navegador.')
        setMessage(result?.message || `Não foi possível reabrir o ${browserName}.`)
      }
    } catch (err: unknown) {
      setBrowserReopenError(`Falha ao abrir o ${browserName}: ${err instanceof Error ? err.message : String(err || 'erro desconhecido')}`)
      setMessage(`Falha ao abrir o ${browserName}: ${err instanceof Error ? err.message : String(err || 'erro desconhecido')}`)
    }
  }

  const handleCancel = () => {
    void window.devorbit?.cancelCodexLogin().catch(() => undefined)
    onClose()
  }

  return (
    <AccessibleDialog
      isOpen={isOpen}
      titleId="codex-auth-dialog-title"
      onClose={handleCancel}
      className="w-full max-w-lg max-h-[calc(100dvh-48px)] bg-[var(--color-bg-panel)] border border-[var(--color-border-subtle)] rounded-[10px] shadow-[0_18px_42px_rgba(28,25,23,0.14)] overflow-hidden flex flex-col motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-200"
    >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border-subtle)] bg-[var(--surface-muted)]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-[8px] bg-[var(--surface-selected)] text-[var(--color-accent-strong)] border border-[var(--color-border-subtle)]">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <h2 id="codex-auth-dialog-title" className="text-base font-bold text-[var(--text-primary)]">
                Conectar OpenAI Codex
              </h2>
              <p className="text-xs text-[var(--color-text-secondary)]">
                {accountLabel} • Sessão isolada permanente
              </p>
            </div>
          </div>
          <button
            onClick={handleCancel}
            aria-label="Cancelar conexão do Codex"
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5 overflow-y-auto min-h-0 text-sm text-[var(--text-primary)]">
          {/* Status: Success */}
          {status === 'success' ? (
            <div className="py-8 flex flex-col items-center justify-center text-center space-y-3">
              <div className="w-16 h-16 rounded-full bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] border border-[color-mix(in_srgb,var(--color-success)_35%,transparent)] flex items-center justify-center text-[var(--color-success)]">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <h3 className="text-lg font-bold text-[var(--text-primary)]">
                {accountLabel} Conectada com Sucesso!
              </h3>
              <p className="text-xs text-[var(--color-text-secondary)] max-w-xs">
                As credenciais foram salvas e isoladas. Agora você pode abrir o Codex no terminal em qualquer projeto com 1 clique, sem deslogar da outra conta!
              </p>
            </div>
          ) : status === 'error' ? (
            /* Status: Error */
            <div className="py-6 flex flex-col items-center justify-center text-center space-y-3">
              <div className="w-12 h-12 rounded-full bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] border border-[color-mix(in_srgb,var(--color-danger)_35%,transparent)] flex items-center justify-center text-[var(--color-danger)]">
                <AlertCircle className="w-6 h-6" />
              </div>
              <h3 className="text-base font-bold text-[var(--text-primary)]">Falha na Autenticação</h3>
              <p className="text-xs text-[var(--color-danger)] max-w-sm">{message}</p>
              <button
                onClick={handleStartLogin}
                className="mt-2 flex items-center gap-2 px-4 py-2 rounded-[8px] bg-[var(--surface-muted)] hover:bg-[var(--surface-hover)] text-[var(--color-text-secondary)] text-xs font-semibold border border-[var(--color-border-subtle)] transition-[background-color,color] cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Tentar Novamente
              </button>
            </div>
          ) : (
            /* Status: Starting or Waiting Browser Approval */
            <>
              {/* Box de Instruções */}
              <div className="space-y-3">
                <div className="flex items-start gap-3 p-3.5 rounded-[8px] bg-[var(--surface-muted)] border border-[var(--color-border-subtle)]">
                  <div className="w-6 h-6 rounded-full bg-[var(--surface-selected)] text-[var(--color-accent-strong)] font-bold text-xs flex items-center justify-center shrink-0 mt-0.5 border border-[var(--color-border-subtle)]">
                    <Globe className="w-3.5 h-3.5" />
                  </div>
                  <div className="text-xs text-[var(--color-text-secondary)] space-y-1">
                    <p className="font-semibold text-[var(--text-primary)]">
                      Abrindo autorização no {browserName}
                    </p>
                    <p className="text-[var(--color-text-secondary)]">
                      Disparamos a página oficial de login da OpenAI no seu navegador <strong>{browserName}</strong>, onde a conta selecionada está ativa.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-3.5 rounded-[8px] bg-[var(--surface-muted)] border border-[var(--color-border-subtle)]">
                  <div className="w-6 h-6 rounded-full bg-[var(--surface-selected)] text-[var(--color-accent-strong)] font-bold text-xs flex items-center justify-center shrink-0 mt-0.5 border border-[var(--color-border-subtle)]">
                    <ShieldCheck className="w-3.5 h-3.5" />
                  </div>
                  <div className="text-xs text-[var(--color-text-secondary)] space-y-1">
                    <p className="font-semibold text-[var(--text-primary)]">
                      Clique em &quot;Continuar&quot; no navegador
                    </p>
                    <p className="text-[var(--color-text-secondary)]">
                      Na aba do {browserName}, basta autorizar o Codex clicando no botão <strong>Continuar</strong>. O DevOrbit detectará a resposta automaticamente!
                    </p>
                  </div>
                </div>
              </div>

              {/* Botões de Apoio */}
              <div className="p-4 rounded-[10px] bg-[var(--surface-selected)] border border-[var(--color-border-subtle)] text-center space-y-3">
                <span className="text-[11px] uppercase tracking-wider font-semibold text-[var(--color-accent-strong)] block">
                  Link de Autorização Direto
                </span>

                <div className="flex items-center justify-center gap-2">
                  <button
                    onClick={handleCopyUrl}
                    disabled={!authUrl}
                    className="flex items-center gap-2 px-3.5 py-2 rounded-[8px] bg-[var(--color-bg-panel)] hover:bg-[var(--surface-hover)] text-[var(--color-text-secondary)] border border-[var(--color-border-subtle)] text-xs font-medium transition-[background-color,color,border-color,opacity] cursor-pointer disabled:opacity-50"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-[var(--color-success)]" />
                        <span className="text-[var(--color-success)] font-semibold">Link Copiado!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copiar Link de Autorização</span>
                      </>
                    )}
                  </button>

                  <button
                    onClick={handleOpenBrowserAgain}
                    disabled={!authUrl}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-[8px] bg-[var(--surface-selected)] hover:bg-[var(--surface-hover)] text-[var(--color-accent-strong)] border border-[var(--color-border-subtle)] text-xs font-semibold transition-[background-color,border-color,color] cursor-pointer disabled:opacity-50"
                  >
                    <span>Reabrir {browserName}</span>
                    <ExternalLink className="w-3 h-3" />
                  </button>
                </div>

                {browserReopenError && (
                  <p className="text-xs text-[var(--color-danger)]" role="alert">
                    {browserReopenError}
                  </p>
                )}

                <p className="text-[11px] text-[var(--color-text-secondary)]">
                  💡 Caso o Google Chrome também tenha aberto por ser o navegador padrão, você pode fechá-lo e confirmar na janela do <strong>{browserName}</strong>.
                </p>
              </div>

              {/* Loading Status */}
              <div className="flex items-center justify-center gap-2.5 text-xs text-[var(--color-text-secondary)] py-1">
                <Loader2 className="w-4 h-4 motion-safe:animate-spin text-[var(--color-accent-strong)]" />
                <span>Aguardando você clicar em Continuar na aba do {browserName}...</span>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-6 py-3.5 border-t border-[var(--color-border-subtle)] bg-[var(--surface-muted)] gap-2">
          <button
            onClick={handleCancel}
            className="px-4 py-2 rounded-[8px] text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
          >
            {status === 'success' ? 'Fechar' : 'Cancelar'}
          </button>
        </div>
    </AccessibleDialog>
  )
}
