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
  RefreshCw,
} from 'lucide-react'
import type {
  AppConfig,
  UsageTrackerState,
  AccountUsage,
  RealUsageState,
} from '../types'

interface UsageBarProps {
  usage: UsageTrackerState | null
  config: AppConfig | null
  onIncrement: (target: 'account1' | 'account2' | 'antigravity') => Promise<void>
  onDecrement: (target: 'account1' | 'account2') => Promise<void>
  onReset: (target: 'account1' | 'account2') => Promise<void>
  onUpdateLimit: (account: 'account1' | 'account2', limit: number) => Promise<void>
  onSwitchAccount: () => Promise<void>
  isSwitchingAccount?: boolean
  realUsage: RealUsageState | null
  onRefreshRealUsage: () => Promise<void>
  isRefreshingRealUsage?: boolean
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
  realUsage,
  onRefreshRealUsage,
  isRefreshingRealUsage = false,
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

  const formatRealReset = (resetAt?: number) => {
    if (!resetAt) return null
    const remainingMs = Math.max(0, resetAt - now)
    if (remainingMs <= 0) return 'reset disponível'
    const totalMinutes = Math.ceil(remainingMs / 60000)
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return hours > 0 ? `reseta em ${hours}h ${minutes}m` : `reseta em ${minutes}m`
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
          aria-label={`${name} — sessões estimadas`}
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

        {/* Contagem local: não representa tokens oficiais */}
        <span
          className={`tabular-nums font-mono text-[11px] font-bold ${
            isCritical ? 'text-red-400' : isWarning ? 'text-amber-300' : 'text-slate-200'
          }`}
        >
          {acc.used}/{acc.limit}
        </span>
        <span className="hidden text-[9px] font-medium uppercase tracking-wide text-slate-500 xl:inline">estimado</span>

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
      {/* Esquerda: medidores locais de sessão */}
      <div className="flex min-w-0 max-w-full items-center gap-2 overflow-x-auto py-0.5">
        <span className="mr-1 flex shrink-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
          <Zap className="h-3.5 w-3.5 text-amber-300" /> Uso local (estimado)
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
              {activePercent >= 100 ? 'Limite de sessões atingido!' : 'Limite de sessões próximo!'}
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
                <span className="font-bold text-white">Contador local (não tokens)</span>
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
                  Limite de sessões por janela (3h):
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

      {realUsage && (
        <div className="basis-full rounded-xl border border-cyan-400/20 bg-cyan-500/[0.04] px-3 py-2.5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[11px]">
              <CheckCircle2 className="h-3.5 w-3.5 text-cyan-300" aria-hidden="true" />
              <span className="font-semibold uppercase tracking-[0.12em] text-cyan-100">Uso real do Codex</span>
              <span className="text-[10px] text-slate-500">OAuth · endpoint compatível com ai-usagebar</span>
              <span className="text-[10px] text-slate-500">atualizado {new Date(realUsage.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <button
              type="button"
              onClick={() => void onRefreshRealUsage()}
              disabled={isRefreshingRealUsage}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-cyan-400/25 bg-cyan-500/10 px-2.5 text-[11px] font-semibold text-cyan-100 transition-colors hover:border-cyan-300/50 hover:bg-cyan-500/20 disabled:cursor-wait disabled:opacity-60"
            >
              <RefreshCw className={`h-3 w-3 ${isRefreshingRealUsage ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" />
              {isRefreshingRealUsage ? 'Consultando…' : 'Atualizar uso real'}
            </button>
          </div>

          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {(['account1', 'account2'] as const).map((accountKey) => {
              const account = realUsage.accounts[accountKey]
              const accountName = accountKey === 'account1'
                ? config?.chatGptAccount1Name || 'Codex #1'
                : config?.chatGptAccount2Name || 'Codex #2'
              const metrics = account.metrics
                .filter((metric): metric is typeof metric & { percent: number } => metric.percent !== undefined)
                .slice(0, 2)
              return (
                <div key={accountKey} className="rounded-lg border border-slate-800/80 bg-slate-950/35 px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[11px] font-semibold text-slate-200">{accountName}</span>
                    <span className={`shrink-0 text-[10px] font-medium ${account.status === 'ready' ? 'text-emerald-300' : account.status === 'not_configured' ? 'text-amber-300' : 'text-rose-300'}`}>
                      {account.status === 'ready' ? account.plan ? `Ativa · ${account.plan}` : 'Ativa' : account.status === 'not_configured' ? 'Não autenticada' : 'Indisponível'}
                    </span>
                  </div>
                  {metrics.length > 0 ? (
                    <div className="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {metrics.map((metric) => (
                        <div key={`${accountKey}-${metric.id}`} className="min-w-0">
                          <div className="flex items-center justify-between gap-2 text-[10px] text-slate-400">
                            <span className="truncate">{metric.label}</span>
                            <span className="font-mono font-bold text-cyan-200">{metric.percent}%</span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-800" role="progressbar" aria-label={`${accountName} — ${metric.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={metric.percent}>
                            <div className={`h-full rounded-full ${metric.percent >= 90 ? 'bg-rose-400' : metric.percent >= 75 ? 'bg-amber-300' : 'bg-cyan-400'}`} style={{ width: `${metric.percent}%` }} />
                          </div>
                          {metric.resetAt && <span className="mt-0.5 block text-[9px] text-slate-500">{formatRealReset(metric.resetAt)}</span>}
                        </div>
                      ))}
                    </div>
                  ) : account.status === 'ready' ? (
                    <p className="mt-1.5 text-[10px] text-slate-400">A conta respondeu, mas não publicou uma janela percentual.</p>
                  ) : (
                    <p className="mt-1.5 truncate text-[10px] text-slate-500" title={account.message}>{account.message}</p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
