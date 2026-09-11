import React, { useState, useEffect } from 'react'
import {
  X,
  Brain,
  Sparkles,
  Save,
  Copy,
  Check,
  FileText,
  Clock,
  RefreshCw,
  FolderGit2,
  AlertTriangle,
} from 'lucide-react'
import type { Project } from '../types'
import { AccessibleDialog } from './AccessibleDialog'

interface AiMemoryModalProps {
  isOpen: boolean
  project: Project | null
  onClose: () => void
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void
}

export const AiMemoryModal: React.FC<AiMemoryModalProps> = ({
  isOpen,
  project,
  onClose,
  onNotify,
}) => {
  const [content, setContent] = useState('')
  const [lastUpdated, setLastUpdated] = useState<string | undefined>(undefined)
  const [exists, setExists] = useState(false)
  const [stale, setStale] = useState<boolean | 'unknown'>('unknown')
  const [sourceCommit, setSourceCommit] = useState<string | undefined>(undefined)
  const [generatedAt, setGeneratedAt] = useState<string | undefined>(undefined)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [isDirty, setIsDirty] = useState(false)

  useEffect(() => {
    if (isOpen && project) loadMemory()
  }, [isOpen, project?.path])

  if (!isOpen || !project) return null

  const loadMemory = async () => {
    setIsLoading(true)
    try {
      const mem = await window.devorbit?.getProjectMemory(project.path)
      if (mem) {
        setContent(mem.content)
        setLastUpdated(mem.lastUpdated)
        setExists(mem.exists)
        setStale(mem.stale ?? 'unknown')
        setSourceCommit(mem.sourceCommit)
        setGeneratedAt(mem.generatedAt)
      }
      setIsDirty(false)
    } catch (err: any) {
      onNotify(`Erro ao carregar memória: ${err.message}`, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  const handleClose = () => {
    if (isSaving || isGenerating) return
    if (isDirty && !window.confirm('Descartar as alterações não salvas da memória?')) return
    onClose()
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      const res = await window.devorbit?.saveProjectMemory(project.path, content)
      if (res?.success) {
        setExists(true)
        setLastUpdated(new Date().toISOString())
        await loadMemory()
        onNotify('Memória da IA salva em .devorbit/memory.md (sem sobrescrever CONTEXT.md)!', 'success')
      } else {
        onNotify(res?.message || 'Falha ao salvar memória', 'error')
      }
    } catch (err: any) {
      onNotify(`Erro: ${err.message}`, 'error')
    } finally {
      setIsSaving(false)
    }
  }

  const handleGenerateFromGit = async () => {
    setIsGenerating(true)
    try {
      const drafted = await window.devorbit?.generateMemoryFromGit(project.path)
      if (drafted) {
        setContent(drafted)
        setIsDirty(true)
        onNotify('Handoff rascunhado a partir dos dados do Git!', 'info')
      }
    } catch (err: any) {
      onNotify(`Falha ao gerar pelo Git: ${err.message}`, 'error')
    } finally {
      setIsGenerating(false)
    }
  }

  const handleCopyHandoff = () => {
    if (!content) return
    navigator.clipboard.writeText(content)
    setCopied(true)
    onNotify('Handoff da IA copiado para a área de transferência!', 'success')
    setTimeout(() => setCopied(false), 2500)
  }

  const insertSnippet = (title: string, placeholder: string) => {
    setContent((prev) => `${prev.trim()}\n\n### ${title}\n- ${placeholder}\n`)
    setIsDirty(true)
  }

  return (
    <AccessibleDialog
      isOpen={isOpen}
      titleId="ai-memory-dialog-title"
      onClose={handleClose}
      className="w-full max-w-3xl bg-[var(--color-bg-panel)] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] motion-safe:animate-in fade-in zoom-in-95 duration-200"
    >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-purple-500/20 text-purple-300 border border-purple-500/30 shadow-sm shadow-purple-500/20">
              <Brain aria-hidden="true" className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="ai-memory-dialog-title" className="text-base font-bold text-white">
                  AI Memory & Handoff
                </h2>
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                  {project.name}
                </span>
                {exists ? (
                  <span className="text-[10px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full font-medium">
                    Ativa
                  </span>
                ) : (
                  <span className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded-full font-medium">
                    Rascunho
                  </span>
                )}
                {stale === true && (
                  <span className="text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded-full font-medium">
                    Desatualizada
                  </span>
                )}
                {stale === false && exists && (
                  <span className="text-[10px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full font-medium">
                    Atualizada
                  </span>
                )}
                {stale === 'unknown' && exists && (
                  <span className="text-[10px] text-slate-400 bg-slate-500/10 border border-slate-500/30 px-2 py-0.5 rounded-full font-medium">
                    Status desconhecido
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Memória contínua compartilhada entre Codex, Antigravity, Claude e ChatGPT
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            aria-label="Fechar memória da IA"
            className="min-w-8 min-h-8 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X aria-hidden="true" className="w-4 h-4" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="px-6 py-2.5 bg-slate-900/40 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
          {/* Quick Insert Badges */}
          <div className="flex items-center gap-1.5 overflow-x-auto text-[11px]">
            <span className="text-slate-400 text-xs me-1">Inserir:</span>
            <button
              type="button"
              onClick={() => insertSnippet('🎯 Objetivo Atual', 'O que estamos implementando')}
              className="px-2 py-0.5 rounded-md bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors cursor-pointer"
            >
              + Objetivo
            </button>
            <button
              type="button"
              onClick={() => insertSnippet('🧭 Onde Paramos', 'Ponto exato da última alteração')}
              className="px-2 py-0.5 rounded-md bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors cursor-pointer"
            >
              + Onde Paramos
            </button>
            <button
              type="button"
              onClick={() => insertSnippet('⚠️ O que Falhou', 'Soluções descartadas para a IA não repetir')}
              className="px-2 py-0.5 rounded-md bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors cursor-pointer"
            >
              + O que Falhou
            </button>
            <button
              type="button"
              onClick={() => insertSnippet('📋 Próximos Passos', '[ ] Passo 1')}
              className="px-2 py-0.5 rounded-md bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors cursor-pointer"
            >
              + Próximos Passos
            </button>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleGenerateFromGit}
              disabled={isGenerating}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-indigo-600/20 text-indigo-300 border border-indigo-500/40 hover:bg-indigo-600/30 transition-colors cursor-pointer disabled:opacity-50"
              title="Analisa branches, commits recentes e arquivos alterados para rascunhar o handoff"
            >
              <Sparkles aria-hidden="true" className={`w-3.5 h-3.5 ${isGenerating ? 'motion-safe:animate-spin' : ''}`} />
              <span>{isGenerating ? 'Puxando...' : 'Puxar do Git'}</span>
            </button>

            <button
              type="button"
              onClick={handleCopyHandoff}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors cursor-pointer"
              title="Copiar texto formatado para colar em qualquer chat de IA"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-300">Copiado</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copiar</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Editor Area */}
        <div className="p-6 flex-1 overflow-y-auto flex flex-col min-h-[300px]">
          {isLoading ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400">
              <RefreshCw aria-hidden="true" className="w-6 h-6 motion-safe:animate-spin mb-2 text-purple-400" />
              <span className="text-xs">Carregando memória do projeto...</span>
            </div>
          ) : (
            <>
            <label htmlFor="ai-memory-content" className="sr-only">Conteúdo da memória e handoff</label>
            <textarea
              id="ai-memory-content"
              name="ai-memory-content"
              value={content}
              onChange={(e) => { setContent(e.target.value); setIsDirty(true) }}
              placeholder="Descreva o contexto do projeto, o objetivo atual e onde paramos para que qualquer IA continue de onde você parou..."
              className="w-full flex-1 min-h-[340px] bg-slate-950/80 border border-slate-800 rounded-xl p-4 font-mono text-xs text-slate-200 placeholder-slate-500 focus:border-purple-500/80 focus:ring-1 focus:ring-purple-500/40 resize-none leading-relaxed transition-[border-color,box-shadow]"
            />
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3.5 border-t border-slate-800 bg-slate-900/40 text-xs">
          <div className="flex items-center gap-2 text-slate-400">
            <Clock aria-hidden="true" className="w-3.5 h-3.5" />
            <span>
              {lastUpdated
                ? `Última atualização: ${new Date(lastUpdated).toLocaleString('pt-BR')}`
                : 'Ainda não salvo em disco'}
            </span>
            {sourceCommit && (
              <span className="text-slate-400" title={sourceCommit}>
                • Git {sourceCommit.slice(0, 7)}
              </span>
            )}
            {generatedAt && (
              <span className="hidden lg:inline text-slate-400">
                • Snapshot {new Date(generatedAt).toLocaleString('pt-BR')}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={handleClose}
              className="px-4 py-1.5 rounded-xl text-xs font-semibold text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
            >
              Cancelar
            </button>

            <button
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-semibold bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-600/30 transition-[background-color,box-shadow] cursor-pointer disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{isSaving ? 'Salvando...' : 'Salvar Memória'}</span>
            </button>
          </div>
        </div>
    </AccessibleDialog>
  )
}
