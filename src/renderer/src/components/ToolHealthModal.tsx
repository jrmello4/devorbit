import React, { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, RefreshCw, Wrench, X } from 'lucide-react'
import type { ToolHealth } from '../types'
import { AccessibleDialog } from './AccessibleDialog'

interface ToolHealthModalProps {
  isOpen: boolean
  onClose: () => void
}

const stateLabels = {
  ready: 'Pronto',
  fallback: 'Alternativa disponível',
  missing: 'Não encontrado',
} as const

export const ToolHealthModal: React.FC<ToolHealthModalProps> = ({ isOpen, onClose }) => {
  const [items, setItems] = useState<ToolHealth[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')

  const loadHealth = useCallback(async () => {
    setIsLoading(true)
    setError('')
    try {
      setItems(await window.devorbit.getToolHealth())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isOpen) void loadHealth()
  }, [isOpen, loadHealth])

  return (
    <AccessibleDialog isOpen={isOpen} titleId="tool-health-title" onClose={onClose}>
      <div className="w-[min(760px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-stone-200 bg-stone-50 px-6 py-5">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[#3e562f]">
              <Wrench className="h-4 w-4" aria-hidden="true" />
              <span className="text-[11px] font-bold uppercase tracking-[0.12em]">Saúde do workspace</span>
            </div>
            <h2 id="tool-health-title" className="text-lg font-bold text-stone-900">Diagnóstico de ferramentas</h2>
            <p className="mt-1 max-w-xl text-xs leading-5 text-stone-600">
              Confira se cada programa foi encontrado. <strong>Em uso</strong> é o caminho que o DevOrbit abrirá;{' '}
              <strong>Configurado</strong> é o valor definido em Configurações, quando houver.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-stone-500 hover:bg-stone-200 hover:text-stone-900" aria-label="Fechar diagnóstico">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="max-h-[min(60vh,520px)] overflow-y-auto p-5">
          {error && <div role="alert" className="mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>{error}</span></div>}
          {isLoading && !items.length ? (
            <div className="flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm text-stone-600" role="status"><RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> Verificando ferramentas…</div>
          ) : (
            <div className="grid gap-2">
              {items.map((item) => {
                const isReady = item.state === 'ready'
                const isFallback = item.state === 'fallback'
                const effectivePath = item.effectivePath || ''
                const configuredPath = item.isConfigured && item.configuredPath ? item.configuredPath : ''
                return (
                  <article key={item.id} className="rounded-xl border border-stone-200 bg-white p-3 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="font-semibold text-stone-900">{item.label}</h3>
                        <p className="mt-0.5 text-xs text-stone-600">{item.message}</p>
                        <dl className="mt-1.5 space-y-0.5 text-[11px]">
                          <div className="flex min-w-0 items-baseline gap-1.5">
                            <dt className="shrink-0 font-semibold text-stone-500">Em uso:</dt>
                            <dd
                              className={`min-w-0 truncate font-mono ${effectivePath ? 'text-stone-600' : 'text-stone-400'}`}
                              title={effectivePath || 'Nenhum caminho efetivo detectado'}
                            >
                              {effectivePath || 'Não detectado'}
                            </dd>
                          </div>
                          <div className="flex min-w-0 items-baseline gap-1.5">
                            <dt className="shrink-0 font-semibold text-stone-500">Configurado:</dt>
                            <dd
                              className={`min-w-0 truncate font-mono ${configuredPath ? 'text-stone-600' : 'text-stone-400'}`}
                              title={configuredPath || 'Padrão (detecção automática)'}
                            >
                              {configuredPath || 'Padrão (detecção automática)'}
                            </dd>
                          </div>
                        </dl>
                      </div>
                      <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-bold ${isReady ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : isFallback ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-red-200 bg-red-50 text-red-800'}`}>
                        {isReady ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> : <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />}
                        {stateLabels[item.state]}
                      </span>
                    </div>
                  </article>
                )
              })}
              {!items.length && !error && <p className="rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm text-stone-600">Nenhuma ferramenta foi verificada.</p>}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-stone-200 bg-stone-50 px-5 py-3">
          <button type="button" onClick={() => void loadHealth()} disabled={isLoading} className="flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-2 text-xs font-semibold text-stone-700 hover:border-[#9eb28f] hover:text-stone-900 disabled:opacity-50">
            <RefreshCw className={isLoading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} aria-hidden="true" /> Atualizar
          </button>
          <button type="button" onClick={onClose} className="rounded-lg bg-[#3e562f] px-4 py-2 text-xs font-semibold text-white hover:bg-[#334827]">Fechar</button>
        </footer>
      </div>
    </AccessibleDialog>
  )
}