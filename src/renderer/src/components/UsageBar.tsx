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
}

export const UsageBar: React.FC<UsageBarProps> = ({
  usage,
  config,
  onIncrement,
  onDecrement,
  onReset,
  onUpdateLimit,
  onSwitchAccount,
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
          className={`flex items-center gap-2 px-2.5 py-1 rounded-xl border transition-[border-color,box-shadow,background-color] text-xs ${
          isActive
            ? 'bg-slate-900/95 border-indigo-500/50 shadow-sm shadow-indigo-500/10'
            : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
        }`}
      >
        <span className="font-semibold text-slate-300 shrink-0">{name}:</span>

        {/* Barra de Progresso Cápsula */}
        <div
          className="w-16 sm:w-20 h-2 rounded-full bg-slate-800 overflow-hidden relative border border-slate-700/50"
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
          className={`font-mono text-[11px] font-bold ${
            isCritical ? 'text-red-400' : isWarning ? 'text-amber-300' : 'text-slate-200'
          }`}
        >
          {acc.used}/{acc.limit}
        </span>

        {remaining && (
          <span className="hidden md:inline-flex items-center gap-1 text-[10px] text-slate-400 font-mono">
            <Clock className="w-2.5 h-2.5 text-slate-400" />
            {remaining}
          </span>
        )}

        {/* Micro-controles + / - */}
        <div className="flex items-center gap-0.5 ml-0.5">
          <button
            type="button"
            onClick={() => onDecrement(accountKey)}
            aria-label={`Diminuir uso de ${name}`}
            className="min-w-6 min-h-6 p-0.5 rounded text-slate-400 hover:text-slate-300 hover:bg-slate-800 transition-[color,background-color] cursor-pointer"
          >
            <Minus className="w-2.5 h-2.5" />
          </button>
          <button
            type="button"
            onClick={() => onIncrement(accountKey)}
            aria-label={`Aumentar uso de ${name}`}
            className="min-w-6 min-h-6 p-0.5 rounded text-slate-400 hover:text-slate-300 hover:bg-slate-800 transition-[color,background-color] cursor-pointer"
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
    <div className="titlebar-no-drag px-4 py-1.5 bg-[var(--color-bg-toolbar)] border-b border-slate-800/60 flex flex-wrap items-center justify-between gap-2">
      {/* Esquerda: Medidores de Quota */}
      <div className="flex items-center gap-2 overflow-x-auto py-0.5">
        <span className="text-[11px] font-semibold text-slate-400 flex items-center gap-1 mr-1 shrink-0">
          <Zap className="w-3.5 h-3.5 text-amber-400" /> Quotas:
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
        <div className="hidden lg:flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-slate-900/60 border border-slate-800 text-xs text-slate-300">
          <Sparkles className="w-3.5 h-3.5 text-indigo-400 motion-safe:animate-pulse" />
          <span className="font-semibold text-slate-200">Antigravity:</span>
          <span className="text-[10px] text-emerald-400 font-medium">Livre (Gemini)</span>
        </div>
      </div>

      {/* Direita: Alerta de Troca Inteligente & Configuração rápida */}
      <div className="flex items-center gap-2">
        {showHandoffAlert && (
          <div role="status" className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-300 text-xs font-semibold motion-safe:animate-pulse">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="hidden sm:inline">
              {activePercent >= 100 ? 'Limite Atingido!' : 'Limite Próximo!'}
            </span>
            <button
              onClick={onSwitchAccount}
              className="flex items-center gap-1 underline underline-offset-2 ml-1 text-amber-200 hover:text-white cursor-pointer"
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
            className="min-w-8 min-h-8 p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-[color,background-color]"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>

          {popoverOpen && (
            <div id="usage-settings-popover" className="absolute end-0 top-7 w-64 p-3 bg-[var(--color-bg-popover)] border border-slate-700 rounded-xl shadow-2xl z-50 text-xs space-y-3">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                <span className="font-bold text-white">Configurar Cotas IA</span>
                <button
                  onClick={() => setPopoverOpen(false)}
                  aria-label="Fechar configurações de quota"
                  className="min-w-6 min-h-6 flex items-center justify-center text-slate-400 hover:text-white"
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
                    className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px]"
                  >
                    <RotateCcw className="w-2.5 h-2.5" /> Zerar
                  </button>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Resetar Conta 2:</span>
                  <button
                    onClick={() => onReset('account2')}
                    className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px]"
                  >
                    <RotateCcw className="w-2.5 h-2.5" /> Zerar
                  </button>
                </div>
              </div>

              {/* Ajuste de Limite Máximo */}
              <div className="border-t border-slate-800 pt-2 space-y-1.5">
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
                    className="w-16 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-white"
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
                    className="w-16 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-white"
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
