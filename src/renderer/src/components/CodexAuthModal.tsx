import React, { useState, useEffect } from 'react'
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

  useEffect(() => {
    if (!isOpen) return
    handleStartLogin()

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
          setTimeout(() => {
            onSuccess()
          }, 1800)
        }
      }
    })

    return () => {
      unsubscribe?.()
    }
  }, [account, isOpen])

  if (!isOpen) return null

  const handleStartLogin = async () => {
    setStatus('starting')
    setMessage(`Iniciando conexão oficial com a OpenAI para ${accountLabel}...`)
    setAuthUrl('')
    try {
      await window.devorbit?.startCodexLogin(account)
    } catch (err: any) {
      setStatus('error')
      setMessage(`Falha ao iniciar login: ${err.message}`)
    }
  }

  const handleCopyUrl = () => {
    if (!authUrl) return
    navigator.clipboard.writeText(authUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  const handleOpenBrowserAgain = () => {
    if (authUrl) {
      window.devorbit?.launchTool(isAccount2 ? 'brave' : 'chrome', '', { url: authUrl })
    }
  }

  const handleCancel = () => {
    window.devorbit?.cancelCodexLogin()
    onClose()
  }

  return (
    <AccessibleDialog
      isOpen={isOpen}
      titleId="codex-auth-dialog-title"
      onClose={handleCancel}
      className="w-full max-w-lg bg-[var(--color-bg-panel)] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-200"
    >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-teal-500/20 text-teal-300 border border-teal-500/30">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <h2 id="codex-auth-dialog-title" className="text-base font-bold text-white">
                Conectar OpenAI Codex
              </h2>
              <p className="text-xs text-slate-400">
                {accountLabel} • Sessão isolada permanente
              </p>
            </div>
          </div>
          <button
            onClick={handleCancel}
            aria-label="Cancelar conexão do Codex"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5 text-sm">
          {/* Status: Success */}
          {status === 'success' ? (
            <div className="py-8 flex flex-col items-center justify-center text-center space-y-3">
              <div className="w-16 h-16 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-lg shadow-emerald-500/20">
                <CheckCircle2 className="w-8 h-8 motion-safe:animate-bounce" />
              </div>
              <h3 className="text-lg font-bold text-white">
                {accountLabel} Conectada com Sucesso!
              </h3>
              <p className="text-xs text-slate-400 max-w-xs">
                As credenciais foram salvas e isoladas. Agora você pode abrir o Codex no terminal em qualquer projeto com 1 clique, sem deslogar da outra conta!
              </p>
            </div>
          ) : status === 'error' ? (
            /* Status: Error */
            <div className="py-6 flex flex-col items-center justify-center text-center space-y-3">
              <div className="w-12 h-12 rounded-full bg-red-500/20 border border-red-500/40 flex items-center justify-center text-red-400">
                <AlertCircle className="w-6 h-6" />
              </div>
              <h3 className="text-base font-bold text-white">Falha na Autenticação</h3>
              <p className="text-xs text-red-400/90 max-w-sm">{message}</p>
              <button
                onClick={handleStartLogin}
                className="mt-2 flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition-[background-color,color] cursor-pointer"
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
                <div className="flex items-start gap-3 p-3.5 rounded-xl bg-slate-900/90 border border-slate-800">
                  <div className="w-6 h-6 rounded-full bg-teal-500/20 text-teal-300 font-bold text-xs flex items-center justify-center shrink-0 mt-0.5 border border-teal-500/40">
                    <Globe className="w-3.5 h-3.5" />
                  </div>
                  <div className="text-xs text-slate-300 space-y-1">
                    <p className="font-semibold text-white">
                      Abrindo autorização no {browserName}
                    </p>
                    <p className="text-slate-400">
                      Disparamos a página oficial de login da OpenAI no seu navegador <strong>{browserName}</strong>, onde a conta selecionada está ativa.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-3.5 rounded-xl bg-slate-900/90 border border-slate-800">
                  <div className="w-6 h-6 rounded-full bg-indigo-500/20 text-indigo-300 font-bold text-xs flex items-center justify-center shrink-0 mt-0.5 border border-indigo-500/40">
                    <ShieldCheck className="w-3.5 h-3.5" />
                  </div>
                  <div className="text-xs text-slate-300 space-y-1">
                    <p className="font-semibold text-white">
                      Clique em &quot;Continuar&quot; no navegador
                    </p>
                    <p className="text-slate-400">
                      Na aba do {browserName}, basta autorizar o Codex clicando no botão <strong>Continuar</strong>. O DevOrbit detectará a resposta automaticamente!
                    </p>
                  </div>
                </div>
              </div>

              {/* Botões de Apoio */}
              <div className="p-4 rounded-2xl bg-gradient-to-b from-[#161d31] to-[#101626] border border-teal-500/30 text-center space-y-3">
                <span className="text-[11px] uppercase tracking-wider font-semibold text-teal-400 block">
                  Link de Autorização Direto
                </span>

                <div className="flex items-center justify-center gap-2">
                  <button
                    onClick={handleCopyUrl}
                    disabled={!authUrl}
                    className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium transition-[background-color,color,border-color,opacity] cursor-pointer disabled:opacity-50"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-300 font-semibold">Link Copiado!</span>
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
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-teal-600/20 hover:bg-teal-600/30 text-teal-300 border border-teal-500/40 text-xs font-semibold transition-[background-color,border-color,color] cursor-pointer disabled:opacity-50"
                  >
                    <span>Reabrir {browserName}</span>
                    <ExternalLink className="w-3 h-3" />
                  </button>
                </div>

                <p className="text-[11px] text-slate-400">
                  💡 Caso o Google Chrome também tenha aberto por ser o navegador padrão, você pode fechá-lo e confirmar na janela do <strong>{browserName}</strong>.
                </p>
              </div>

              {/* Loading Status */}
              <div className="flex items-center justify-center gap-2.5 text-xs text-slate-400 py-1">
                <Loader2 className="w-4 h-4 motion-safe:animate-spin text-teal-400" />
                <span>Aguardando você clicar em Continuar na aba do {browserName}...</span>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-6 py-3.5 border-t border-slate-800 bg-slate-900/40 gap-2">
          <button
            onClick={handleCancel}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
          >
            {status === 'success' ? 'Fechar' : 'Cancelar'}
          </button>
        </div>
    </AccessibleDialog>
  )
}
