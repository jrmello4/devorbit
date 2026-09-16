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

export function appendGitMemory(existingContent: string, generatedDraft: string): string {
  const trimmedDraft = (generatedDraft || '').trim()
  const trimmedExisting = (existingContent || '').trim()

  if (!trimmedDraft && !trimmedExisting) {
    return ''
  }

  if (!trimmedDraft) {
    return existingContent
  }

  if (!trimmedExisting) {
    return trimmedDraft
  }

  if (trimmedExisting.includes(trimmedDraft)) {
    return existingContent
  }

  if (trimmedExisting.endsWith('---')) {
    return `${trimmedExisting}\n\n${trimmedDraft}`
  }

  if (trimmedDraft.startsWith('---')) {
    return `${trimmedExisting}\n\n${trimmedDraft}`
  }

  return `${trimmedExisting}\n\n---\n\n${trimmedDraft}`
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

  const handleReload = async () => {
    if (isLoading || isSaving || isGenerating) return
    if (isDirty && !window.confirm('Descartar as alterações não salvas e recarregar a memória do disco?')) {
      return
    }
    await loadMemory()
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
        const hadContent = content.trim().length > 0
        const updated = appendGitMemory(content, drafted)

        if (hadContent && updated === content && drafted.trim().length > 0) {
          onNotify('O resumo gerado pelo Git já está presente na memória.', 'info')
        } else {
          setContent(updated)
          setIsDirty(true)
          if (hadContent) {
            onNotify('Handoff do Git anexado à memória existente, preservando suas anotações!', 'info')
          } else {
            onNotify('Handoff rascunhado a partir dos dados do Git!', 'info')
          }
        }
      }
    } catch (err: any) {
      onNotify(`Falha ao gerar pelo Git: ${err.message}`, 'error')
    } finally {
      setIsGenerating(false)
    }
  }

  const handleCopyHandoff = async () => {
    if (!content) return
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      onNotify('Handoff da IA copiado para a área de transferência!', 'success')
      setTimeout(() => setCopied(false), 2500)
    } catch (err: unknown) {
      setCopied(false)
      onNotify(`Não foi possível copiar o handoff: ${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  const insertSnippet = (title: string, placeholder: string) => {
    setContent((prev) => {
      const trimmed = prev.trim()
      return trimmed ? `${trimmed}\n\n### ${title}\n- ${placeholder}\n` : `### ${title}\n- ${placeholder}\n`
    })
    setIsDirty(true)
  }

  return (
    <AccessibleDialog
      isOpen={isOpen}
      titleId="ai-memory-dialog-title"
      onClose={handleClose}
      className="w-full max-w-3xl bg-white border border-stone-200 rounded-[10px] shadow-[0_18px_42px_rgba(28,25,23,0.14)] overflow-hidden flex flex-col max-h-[calc(100dvh-48px)]"
    >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200 bg-stone-50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-[8px] bg-[#edf3e8] text-[#3e562f] border border-[#cbd8bf]">
              <Brain aria-hidden="true" className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="ai-memory-dialog-title" className="text-base font-bold text-stone-900">
                  Memória e handoff
                </h2>
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-[4px] bg-white text-stone-700 border border-stone-300">
                  {project.name}
                </span>
                {exists ? (
                  <span className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-[4px] font-medium">
                    Ativa
                  </span>
                ) : (
                  <span className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-[4px] font-medium">
                    Rascunho
                  </span>
                )}
                {stale === true && (
                  <span className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-[4px] font-medium">
                    Desatualizada
                  </span>
                )}
                {stale === false && exists && (
                  <span className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-[4px] font-medium">
                    Atualizada
                  </span>
                )}
                {stale === 'unknown' && exists && (
                  <span className="text-[10px] text-stone-600 bg-stone-100 border border-stone-300 px-2 py-0.5 rounded-[4px] font-medium">
                    Status desconhecido
                  </span>
                )}
              </div>
              <p className="text-xs text-stone-600 mt-0.5">
                Memória contínua compartilhada entre Codex, Antigravity, Claude e ChatGPT
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            aria-label="Fechar memória da IA"
            className="min-w-8 min-h-8 inline-flex items-center justify-center rounded-lg text-stone-500 hover:text-stone-900 hover:bg-stone-100 transition-colors"
          >
            <X aria-hidden="true" className="w-4 h-4" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="px-6 py-2.5 bg-[#f0f1ed] border-b border-stone-200 flex flex-wrap items-center justify-between gap-2">
          {/* Quick Insert Badges */}
          <div className="flex items-center gap-1.5 overflow-x-auto text-[11px]">
            <span className="text-stone-600 text-xs me-1">Inserir:</span>
            <button
              type="button"
              onClick={() => insertSnippet('Objetivo atual', 'O que estamos implementando')}
              className="px-2 py-0.5 rounded-[4px] bg-white hover:bg-[#eceee7] text-stone-700 border border-stone-300 transition-colors cursor-pointer"
            >
              + Objetivo
            </button>
            <button
              type="button"
              onClick={() => insertSnippet('Onde paramos', 'Ponto exato da última alteração')}
              className="px-2 py-0.5 rounded-[4px] bg-white hover:bg-[#eceee7] text-stone-700 border border-stone-300 transition-colors cursor-pointer"
            >
              + Onde Paramos
            </button>
            <button
              type="button"
              onClick={() => insertSnippet('O que falhou', 'Soluções descartadas para a IA não repetir')}
              className="px-2 py-0.5 rounded-[4px] bg-white hover:bg-[#eceee7] text-stone-700 border border-stone-300 transition-colors cursor-pointer"
            >
              + O que Falhou
            </button>
            <button
              type="button"
              onClick={() => insertSnippet('Próximos passos', '[ ] Passo 1')}
              className="px-2 py-0.5 rounded-[4px] bg-white hover:bg-[#eceee7] text-stone-700 border border-stone-300 transition-colors cursor-pointer"
            >
              + Próximos Passos
            </button>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void handleReload()}
              disabled={isLoading || isSaving || isGenerating}
              className="flex items-center gap-1.5 rounded-[6px] border border-stone-300 bg-white px-3 py-1 text-xs font-semibold text-stone-700 transition-colors hover:bg-[#eceee7] disabled:cursor-wait disabled:opacity-50"
              title="Reler a memória e recalcular se ela está desatualizada em relação ao Git"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" />
              Atualizar
            </button>

            <button
              type="button"
              onClick={handleGenerateFromGit}
              disabled={isGenerating}
              className="flex items-center gap-1.5 px-3 py-1 rounded-[6px] text-xs font-semibold bg-[#edf3e8] text-[#3e562f] border border-[#bdcfb0] hover:bg-[#e3ecdc] transition-colors cursor-pointer disabled:opacity-50"
              title="Analisa branches, commits recentes e arquivos alterados para rascunhar o handoff. Preserva anotações existentes."
              aria-label="Puxar handoff do Git (preserva anotações existentes)"
            >
              <Sparkles aria-hidden="true" className={`w-3.5 h-3.5 ${isGenerating ? 'motion-safe:animate-spin' : ''}`} />
              <span>{isGenerating ? 'Puxando...' : 'Puxar do Git'}</span>
            </button>

            <button
              type="button"
              onClick={handleCopyHandoff}
              className="flex items-center gap-1.5 px-3 py-1 rounded-[6px] text-xs font-semibold bg-white hover:bg-[#eceee7] text-stone-700 border border-stone-300 transition-colors cursor-pointer"
              title="Copiar texto formatado para colar em qualquer chat de IA"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-700" />
                  <span className="text-emerald-700">Copiado</span>
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
            <div className="flex-1 flex flex-col items-center justify-center text-stone-600">
              <RefreshCw aria-hidden="true" className="w-6 h-6 motion-safe:animate-spin mb-2 text-[#3e562f]" />
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
              className="w-full flex-1 min-h-[340px] bg-white border border-stone-300 rounded-[8px] p-4 font-mono text-xs text-stone-800 placeholder:text-stone-500 focus:border-[#3e562f] focus:ring-1 focus:ring-[#3e562f]/30 resize-none leading-relaxed transition-[border-color,box-shadow]"
            />
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3.5 border-t border-stone-200 bg-stone-50 text-xs">
          <div className="flex items-center gap-2 text-stone-600">
            <Clock aria-hidden="true" className="w-3.5 h-3.5" />
            <span>
              {lastUpdated
                ? `Última atualização: ${new Date(lastUpdated).toLocaleString('pt-BR')}`
                : 'Ainda não salvo em disco'}
            </span>
            {sourceCommit && (
              <span className="text-stone-600" title={sourceCommit}>
                • Git {sourceCommit.slice(0, 7)}
              </span>
            )}
            {generatedAt && (
              <span className="hidden lg:inline text-stone-600">
                • Snapshot {new Date(generatedAt).toLocaleString('pt-BR')}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={handleClose}
              className="px-4 py-1.5 rounded-[6px] text-xs font-semibold text-stone-600 hover:text-stone-900 hover:bg-stone-100 transition-colors cursor-pointer"
            >
              Cancelar
            </button>

            <button
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-[6px] text-xs font-semibold bg-[#3e562f] hover:bg-[#304426] text-white transition-[background-color,color] cursor-pointer disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{isSaving ? 'Salvando...' : 'Salvar Memória'}</span>
            </button>
          </div>
        </div>
    </AccessibleDialog>
  )
}
