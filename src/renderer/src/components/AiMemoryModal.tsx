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
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [copied, setCopied] = useState(false)

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
      }
    } catch (err: any) {
      onNotify(`Erro ao carregar memória: ${err.message}`, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      const res = await window.devorbit?.saveProjectMemory(project.path, content)
      if (res?.success) {
        setExists(true)
        setLastUpdated(new Date().toISOString())
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
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-3xl bg-[#0e1322] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-purple-500/20 text-purple-300 border border-purple-500/30 shadow-sm shadow-purple-500/20">
              <Brain className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white">
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
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Memória contínua compartilhada entre Codex, Antigravity, Claude e ChatGPT
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="px-6 py-2.5 bg-slate-900/40 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
          {/* Quick Insert Badges */}
          <div className="flex items-center gap-1.5 overflow-x-auto text-[11px]">
            <span className="text-slate-500 text-xs mr-1">Inserir:</span>
            <button
              type="button"
              onClick={() => insertSnippet('🎯 Objetivo Atual', 'O que estamos implementando')}
              className="px-2 py-0.5 rounded-md bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-all cursor-pointer"
            >
              + Objetivo
            </button>
            <button
              type="button"
              onClick={() => insertSnippet('🧭 Onde Paramos', 'Ponto exato da última alteração')}
              className="px-2 py-0.5 rounded-md bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-all cursor-pointer"
            >
              + Onde Paramos
            </button>
            <button
              type="button"
              onClick={() => insertSnippet('⚠️ O que Falhou', 'Soluções descartadas para a IA não repetir')}
              className="px-2 py-0.5 rounded-md bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-all cursor-pointer"
            >
              + O que Falhou
            </button>
            <button
              type="button"
              onClick={() => insertSnippet('📋 Próximos Passos', '[ ] Passo 1')}
              className="px-2 py-0.5 rounded-md bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-all cursor-pointer"
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
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-indigo-600/20 text-indigo-300 border border-indigo-500/40 hover:bg-indigo-600/30 transition-all cursor-pointer disabled:opacity-50"
              title="Analisa branches, commits recentes e arquivos alterados para rascunhar o handoff"
            >
              <Sparkles className={`w-3.5 h-3.5 ${isGenerating ? 'animate-spin' : ''}`} />
              <span>{isGenerating ? 'Puxando...' : 'Puxar do Git'}</span>
            </button>

            <button
              type="button"
              onClick={handleCopyHandoff}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-all cursor-pointer"
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
            <div className="flex-1 flex flex-col items-center justify-center text-slate-500">
              <RefreshCw className="w-6 h-6 animate-spin mb-2 text-purple-400" />
              <span className="text-xs">Carregando memória do projeto...</span>
            </div>
          ) : (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Descreva o contexto do projeto, o objetivo atual e onde paramos para que qualquer IA continue de onde você parou..."
              className="w-full flex-1 min-h-[340px] bg-slate-950/80 border border-slate-800 rounded-xl p-4 font-mono text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-purple-500/80 focus:ring-1 focus:ring-purple-500/40 resize-none leading-relaxed transition-all"
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3.5 border-t border-slate-800 bg-slate-900/40 text-xs">
          <div className="flex items-center gap-2 text-slate-500">
            <Clock className="w-3.5 h-3.5" />
            <span>
              {lastUpdated
                ? `Última atualização: ${new Date(lastUpdated).toLocaleString('pt-BR')}`
                : 'Ainda não salvo em disco'}
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-xl text-xs font-semibold text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
            >
              Cancelar
            </button>

            <button
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-semibold bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-600/30 transition-all cursor-pointer disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{isSaving ? 'Salvando...' : 'Salvar Memória'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
