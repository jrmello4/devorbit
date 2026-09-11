import React, { useState, useEffect } from 'react'
import {
  Sparkles,
  Zap,
  RotateCcw,
  Plus,
  Minus,
  AlertTriangle,
  ArrowRightLeft,
  Settings2,
  ChevronDown,
  Clock,
  CheckCircle2,
} from 'lucide-react'
import type { AppConfig, UsageTrackerState, AccountUsage } from '../types'

interface UsageBarProps {
  usage: UsageTrackerState | null
  config: AppConfig | null
  onIncrement: (target: 'account1' | 'account2' | 'antigravity') => Promise<void>
  onDecrement: (target: 'account1' | 'account2') => Promise<void>
  onReset: (target: 'account1' | 'account2') => Promise<void>
  onUpdateLimit: (account: 'account1' | 'account2', limit: number) => Promise<void>
  onSwitchAccount: () => Promise<void>
  isSwitchingAccount?: boolean
}

export const UsageBar: React.FC<UsageBarProps> = ({
  usage,
  config,
  onIncrement,
  onDecrement,
  onReset,
  onUpdateLimit,
  onSwitchAccount,
  isSwitchingAccount = false,
}) => {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [now, setNow] = useState(Date.now())

  // Atualiza timer regressivo a cada 10 segundos
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000)
    return () => clearInterval(timer)
  }, [])

  if (!usage) return null

  const getRemainingTime = (acc: AccountUsage) => {
    if (!acc.windowStart || acc.used === 0) return null
    const durationMs = (acc.windowDurationHours || 3) * 3600 * 1000
    const remainingMs = Math.max(0, acc.windowStart + durationMs - now)
    if (remainingMs <= 0) return 'Reset iminente'

    const totalMinutes = Math.floor(remainingMs / 60000)
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    if (hours > 0) {
      return `${hours}h ${minutes}m`
    }
    return `${minutes}m`
  }

  const renderMeter = (
    accountKey: 'account1' | 'account2',
    name: string,
    colorClass: string
  ) => {
    const acc = usage[accountKey]
    const percent = acc.limit > 0 ? Math.min(100, Math.round((acc.used / acc.limit) * 100)) : 0
    const isWarning = percent >= 75 && percent < 100
    const isCritical = percent >= 100
    const remaining = getRemainingTime(acc)
    const isActive =
      (accountKey === 'account1' && config?.activeChatGptAccount === 'account1') ||
      (accountKey === 'account2' && config?.activeChatGptAccount === 'account2')

    return (
      <div
          className={`flex min-h-11 items-center gap-2 rounded-xl border px-3 py-2 text-xs transition-[border-color,box-shadow,background-color] ${
          isActive
            ? 'border-indigo-400/50 bg-indigo-500/[0.08] shadow-sm shadow-indigo-500/10'
            : 'border-[var(--color-border-subtle)]/70 bg-slate-950/30 hover:border-slate-600'
        }`}
      >
        <span className="flex shrink-0 items-center gap-1.5 font-semibold text-slate-200">
          <span className={`h-1.5 w-1.5 rounded-full ${isActive ? 'bg-indigo-300' : 'bg-slate-600'}`} aria-hidden="true" />
          {name}
          {isActive && <span className="text-[10px] font-medium text-indigo-300">ativa</span>}
        </span>

        {/* Barra de Progresso Cápsula */}
        <div
          className="relative h-2 w-16 overflow-hidden rounded-full border border-slate-700/50 bg-slate-800 sm:w-20"
          role="progressbar"
          aria-label={`${name} — uso da cota`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            className={`h-full rounded-full transition-[width,background-color,box-shadow] duration-300 ${
              isCritical
                ? 'bg-red-500 shadow-sm shadow-red-500/50'
                : isWarning
                ? 'bg-amber-400 shadow-sm shadow-amber-400/50'
                : colorClass
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>

        {/* Contagem e Timer */}
        <span
          className={`tabular-nums font-mono text-[11px] font-bold ${
            isCritical ? 'text-red-400' : isWarning ? 'text-amber-300' : 'text-slate-200'
          }`}
        >
          {acc.used}/{acc.limit}
        </span>

        {remaining && (
          <span className="hidden items-center gap-1 font-mono text-[10px] text-[var(--color-text-muted)] md:inline-flex">
            <Clock className="h-2.5 w-2.5 text-slate-500" />
            {remaining}
          </span>
        )}

        {/* Micro-controles + / - */}
        <div className="ms-0.5 flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => onDecrement(accountKey)}
            aria-label={`Diminuir uso de ${name}`}
            className="min-h-8 min-w-8 rounded-lg p-1.5 text-slate-400 transition-[color,background-color] hover:bg-white/5 hover:text-slate-200 cursor-pointer"
          >
            <Minus className="w-2.5 h-2.5" />
          </button>
          <button
            type="button"
            onClick={() => onIncrement(accountKey)}
            aria-label={`Aumentar uso de ${name}`}
            className="min-h-8 min-w-8 rounded-lg p-1.5 text-slate-400 transition-[color,background-color] hover:bg-white/5 hover:text-slate-200 cursor-pointer"
          >
            <Plus className="w-2.5 h-2.5" />
          </button>
        </div>
      </div>
    )
  }

  const activeAccount = config?.activeChatGptAccount || 'account1'
  const activeUsage = usage[activeAccount]
  const activePercent = Math.round((activeUsage.used / activeUsage.limit) * 100)
  const showHandoffAlert = activePercent >= 80

  return (
    <div className="titlebar-no-drag border-b border-[var(--color-border-subtle)]/55 bg-[var(--color-bg-toolbar)]/75 px-4 py-2.5 backdrop-blur-lg sm:px-5 lg:px-6">
      <div className="mx-auto flex w-full max-w-[1680px] flex-wrap items-center justify-between gap-2.5">
      {/* Esquerda: Medidores de Quota */}
      <div className="flex min-w-0 max-w-full items-center gap-2 overflow-x-auto py-0.5">
        <span className="mr-1 flex shrink-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
          <Zap className="h-3.5 w-3.5 text-amber-300" /> Quotas
        </span>

        {renderMeter(
          'account1',
          config?.chatGptAccount1Name || 'Codex #1',
          'bg-indigo-500'
        )}
        {renderMeter(
          'account2',
          config?.chatGptAccount2Name || 'Codex #2',
          'bg-teal-400'
        )}

        {/* Antigravity Badge */}
        <div className="hidden min-h-11 items-center gap-1.5 rounded-xl border border-[var(--color-border-subtle)]/70 bg-slate-950/25 px-3 text-xs text-slate-300 lg:flex">
          <Sparkles className="h-3.5 w-3.5 text-indigo-300 motion-safe:animate-pulse" />
          <span className="font-semibold text-slate-200">Antigravity</span>
          <span className="text-[10px] font-medium text-emerald-300">Livre · Gemini</span>
        </div>
      </div>

      {/* Direita: Alerta de Troca Inteligente & Configuração rápida */}
      <div className="flex items-center gap-2">
        {showHandoffAlert && (
          <div role="status" className="flex items-center gap-1.5 rounded-xl border border-amber-400/35 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-200 motion-safe:animate-pulse">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-300" />
            <span className="hidden sm:inline">
              {activePercent >= 100 ? 'Limite Atingido!' : 'Limite Próximo!'}
            </span>
            <button
              onClick={() => void onSwitchAccount()}
              disabled={isSwitchingAccount}
              aria-busy={isSwitchingAccount}
              className="ms-1 flex items-center gap-1 underline underline-offset-2 text-amber-100 hover:text-white disabled:cursor-wait disabled:opacity-60 cursor-pointer"
              title="Alternar para a outra conta imediatamente"
            >
              <ArrowRightLeft className="w-3 h-3" />
              <span>
                Alternar para {activeAccount === 'account1' ? 'Conta 2' : 'Conta 1'}
              </span>
            </button>
          </div>
        )}

        {/* Botão de Ajustes Rápidos da Barra */}
        <div className="relative">
          <button
            onClick={() => setPopoverOpen(!popoverOpen)}
            aria-expanded={popoverOpen}
            aria-controls="usage-settings-popover"
            aria-label="Configurar limites de uso e reset manual"
            className="min-h-10 min-w-10 rounded-xl border border-[var(--color-border-subtle)]/60 p-2 text-slate-400 transition-[color,background-color] hover:bg-white/5 hover:text-slate-200"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>

          {popoverOpen && (
            <div id="usage-settings-popover" className="surface-panel absolute end-0 top-12 z-50 w-72 space-y-3 rounded-2xl p-4 text-xs">
              <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)]/70 pb-3">
                <span className="font-bold text-white">Configurar Cotas IA</span>
                <button
                  onClick={() => setPopoverOpen(false)}
                  aria-label="Fechar configurações de quota"
                  className="flex min-h-8 min-w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Reset manual */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Resetar Conta 1:</span>
                  <button
                    onClick={() => onReset('account1')}
                    className="flex items-center gap-1 rounded-lg bg-slate-800/80 px-2.5 py-1.5 text-[11px] text-slate-200 hover:bg-slate-700"
                  >
                    <RotateCcw className="w-2.5 h-2.5" /> Zerar
                  </button>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Resetar Conta 2:</span>
                  <button
                    onClick={() => onReset('account2')}
                    className="flex items-center gap-1 rounded-lg bg-slate-800/80 px-2.5 py-1.5 text-[11px] text-slate-200 hover:bg-slate-700"
                  >
                    <RotateCcw className="w-2.5 h-2.5" /> Zerar
                  </button>
                </div>
              </div>

              {/* Ajuste de Limite Máximo */}
              <div className="space-y-1.5 border-t border-[var(--color-border-subtle)]/70 pt-3">
                <span className="text-slate-400 text-[11px] block">
                  Limite por Janela (mensagens / 3h):
                </span>
                <div className="flex items-center gap-2">
                  <label htmlFor="usage-limit-account-1" className="text-[11px] text-slate-400">C1:</label>
                  <input
                    id="usage-limit-account-1"
                    name="usage-limit-account-1"
                    type="number"
                    min="5"
                    max="200"
                    value={usage.account1.limit}
                    onChange={(e) =>
                      onUpdateLimit('account1', parseInt(e.target.value) || 40)
                    }
                    className="w-16 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-base text-white sm:text-xs"
                  />
                  <label htmlFor="usage-limit-account-2" className="text-[11px] text-slate-400">C2:</label>
                  <input
                    id="usage-limit-account-2"
                    name="usage-limit-account-2"
                    type="number"
                    min="5"
                    max="200"
                    value={usage.account2.limit}
                    onChange={(e) =>
                      onUpdateLimit('account2', parseInt(e.target.value) || 40)
                    }
                    className="w-16 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-base text-white sm:text-xs"
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  )
}
