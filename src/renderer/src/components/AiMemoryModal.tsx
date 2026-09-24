import React, { useCallback, useEffect, useState } from 'react'
import {
  X,
  Clock,
  RefreshCw,
  Search,
  AlertTriangle,
  CheckCircle,
  Info,
} from 'lucide-react'
import type { Project } from '../types'
import { AccessibleDialog } from './AccessibleDialog'
import type {
  AiMemoryEnableProjectResult,
  AiMemoryIpcResult,
  AiMemoryProjectStatusResult,
  AiMemoryMigrationOutcomeView,
  AiMemoryMigrationStatusResult,
} from '../../../shared/ai-memory-ipc-contract'

// ---------------------------------------------------------------------------
// Legacy append (preservado para backward-compat com testes existentes)
// ---------------------------------------------------------------------------

export function appendGitMemory(existingContent: string, generatedDraft: string): string {
  const trimmedDraft = (generatedDraft || '').trim()
  const trimmedExisting = (existingContent || '').trim()

  if (!trimmedDraft && !trimmedExisting) return ''
  if (!trimmedDraft) return existingContent
  if (!trimmedExisting) return trimmedDraft
  if (trimmedExisting.includes(trimmedDraft)) return existingContent
  if (trimmedExisting.endsWith('---')) return `${trimmedExisting}\n\n${trimmedDraft}`
  if (trimmedDraft.startsWith('---')) return `${trimmedExisting}\n\n${trimmedDraft}`
  return `${trimmedExisting}\n\n---\n\n${trimmedDraft}`
}

// ---------------------------------------------------------------------------
// Presentation helpers — renderizam dados IPC conhecidos como React legível;
// fallback expansível para formatos desconhecidos.
// ---------------------------------------------------------------------------

/** Extrai um campo string de um objeto desconhecido de forma segura. */
function strField(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === 'object' && key in obj) {
    const v = (obj as Record<string, unknown>)[key]
    return typeof v === 'string' ? v : undefined
  }
  return undefined
}

/**
 * Extrai um array de items do envelope IPC real do ai-memory.
 *
 * O IPC retorna `{ ok, data: { text, isError, json? } }` — nunca um array direto.
 * O campo `json` é o JSON parsed do texto MCP; pode ser array ou objeto com
 * chave de items (results/pages/items/rows). `text` é parseado em fallback.
 * Limite de segurança: no máximo 200 items para evitar payload gigante na UI.
 */
const IPC_ARRAY_LIMIT = 200
export function extractIpcArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data.slice(0, IPC_ARRAY_LIMIT)
  if (!data || typeof data !== 'object') return []
  const envelope = data as Record<string, unknown>
  // 1. Campo json parsed do MCP (formato real do callScopeTool)
  const json = envelope.json
  if (Array.isArray(json)) return json.slice(0, IPC_ARRAY_LIMIT)
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const jObj = json as Record<string, unknown>
    for (const key of [
      // memory_query v2.4.0: hits é o array principal; global_scope_hits/raw_hits são fallbacks
      'hits', 'global_scope_hits', 'raw_hits',
      // memory_recent: pages; memory_handoff_list: handoffs
      'pages', 'handoffs',
      // Genéricos defensivos
      'results', 'items', 'rows', 'entries',
    ]) {
      if (Array.isArray(jObj[key])) return jObj[key].slice(0, IPC_ARRAY_LIMIT)
    }
  }
  // 2. Fallback: parse text como JSON
  const text = envelope.text
  if (typeof text === 'string' && text.trim()) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed.slice(0, IPC_ARRAY_LIMIT)
      if (parsed && typeof parsed === 'object') {
        for (const key of [
          'hits', 'global_scope_hits', 'raw_hits',
          'pages', 'handoffs', 'results', 'items', 'rows', 'entries',
        ]) {
          if (Array.isArray(parsed[key])) return parsed[key].slice(0, IPC_ARRAY_LIMIT)
        }
      }
    } catch {
      // text não é JSON — sem items
    }
  }
  return []
}

/** Renderiza uma página de memória (path + body + metadata). */
export function renderPage(item: unknown, index: number): React.ReactNode {
  if (typeof item === 'string') {
    return (
      <div key={index} className="p-2 mb-1.5 rounded border border-[var(--color-border-subtle)]">
        <p className="text-xs text-[var(--text-primary)] whitespace-pre-wrap">{item}</p>
      </div>
    )
  }
  if (item && typeof item === 'object') {
    const path = strField(item, 'path')
    const body = strField(item, 'body')
    // memory_query v2.4.0 usa 'snippet' como preview (não body completo).
    const snippet = !body ? strField(item, 'snippet') : undefined
    const updatedAt = strField(item, 'updatedAt') || strField(item, 'updated_at')
    const title = strField(item, 'title') || strField(item, 'name')
    const score = typeof (item as Record<string, unknown>).score === 'number'
      ? (item as Record<string, unknown>).score as number
      : undefined
    return (
      <details key={index} className="p-2 mb-1.5 rounded border border-[var(--color-border-subtle)] group">
        <summary className="text-xs font-semibold text-[var(--text-primary)] cursor-pointer list-none flex items-center gap-1.5">
          <span className="text-[var(--color-text-muted)] group-open:rotate-90 transition-transform text-[10px]">&#9654;</span>
          {title || path || `Item ${index + 1}`}
          {score !== undefined && <span className="text-[10px] text-[var(--color-text-muted)] font-normal">({Math.round(score * 100)}%)</span>}
          {updatedAt && <span className="text-[10px] text-[var(--color-text-muted)] font-normal ml-auto">{updatedAt}</span>}
        </summary>
        {path && !title && <div className="text-[10px] text-[var(--color-text-muted)] mt-1 font-mono">{path}</div>}
        {body && (
          <p className="text-xs text-[var(--text-primary)] whitespace-pre-wrap mt-1.5 leading-relaxed">{body}</p>
        )}
        {!body && snippet && (
          <p className="text-xs text-[var(--color-text-secondary)] italic mt-1.5 leading-relaxed">{snippet}</p>
        )}
        {!body && !snippet && <FallbackJson data={item} />}
      </details>
    )
  }
  return <FallbackJson key={index} data={item} />
}

/** Renderiza um handoff (agent + summary + status). */
export function renderHandoff(item: unknown, index: number): React.ReactNode {
  if (typeof item === 'string') {
    return (
      <div key={index} className="p-2 mb-1.5 rounded border border-[var(--color-border-subtle)]">
        <p className="text-xs text-[var(--text-primary)] whitespace-pre-wrap">{item}</p>
      </div>
    )
  }
  if (item && typeof item === 'object') {
    const agent = strField(item, 'agent') || strField(item, 'provider')
    const summary = strField(item, 'summary') || strField(item, 'description')
    const status = strField(item, 'status')
    const id = strField(item, 'id')
    return (
      <details key={index} className="p-2 mb-1.5 rounded border border-[var(--color-border-subtle)] group">
        <summary className="text-xs font-semibold text-[var(--text-primary)] cursor-pointer list-none flex items-center gap-1.5">
          <span className="text-[var(--color-text-muted)] group-open:rotate-90 transition-transform text-[10px]">&#9654;</span>
          {agent || `Handoff ${index + 1}`}
          {status && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
              status === 'completed' ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
                : status === 'pending' ? 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]'
                  : 'bg-[var(--color-text-muted)]/15 text-[var(--color-text-muted)]'
            }`}>{status}</span>
          )}
        </summary>
        {id && <div className="text-[10px] text-[var(--color-text-muted)] font-mono mt-1">{id}</div>}
        {summary && <p className="text-xs text-[var(--text-primary)] whitespace-pre-wrap mt-1.5 leading-relaxed">{summary}</p>}
        {!summary && <FallbackJson data={item} />}
      </details>
    )
  }
  return <FallbackJson key={index} data={item} />
}

/** Renderiza briefing (texto ou objeto estruturado). */
export function renderBriefingContent(data: unknown): React.ReactNode {
  if (typeof data === 'string') {
    return <p className="text-xs text-[var(--text-primary)] whitespace-pre-wrap leading-relaxed">{data}</p>
  }
  if (data && typeof data === 'object') {
    const summary = strField(data, 'summary') || strField(data, 'text')
    if (summary) {
      return <p className="text-xs text-[var(--text-primary)] whitespace-pre-wrap leading-relaxed">{summary}</p>
    }
    // Objeto sem campo de texto conhecido: renderiza chaves conhecidas + fallback
    const knownKeys = ['summary', 'text', 'pages', 'scope', 'project']
    const entries = Object.entries(data as Record<string, unknown>).filter(([k]) => !knownKeys.includes(k) || typeof (data as Record<string, unknown>)[k] === 'string')
    if (entries.length > 0) {
      return (
        <div className="space-y-1.5">
          {entries.map(([key, val]) => (
            typeof val === 'string' ? (
              <div key={key}>
                <span className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase">{key}</span>
                <p className="text-xs text-[var(--text-primary)] whitespace-pre-wrap leading-relaxed">{val}</p>
              </div>
            ) : null
          ))}
          <FallbackJson data={data} />
        </div>
      )
    }
  }
  return <FallbackJson data={data} />
}

/** Fallback expansível: mostra JSON formatado colapsado por padrão. */
export function FallbackJson({ data }: { data: unknown }): React.ReactNode {
  if (data === null || data === undefined) return null
  let formatted: string
  try {
    formatted = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  } catch {
    formatted = String(data)
  }
  if (!formatted || formatted === '{}') return null
  return (
    <details className="mt-1.5">
      <summary className="text-[10px] text-[var(--color-text-muted)] cursor-pointer">Dados brutos</summary>
      <pre className="whitespace-pre-wrap font-mono text-[10px] text-[var(--color-text-secondary)] mt-1 p-2 rounded bg-[var(--color-bg-panel)] border border-[var(--color-border-subtle)]">{formatted}</pre>
    </details>
  )
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Tab = 'status' | 'activity' | 'briefing' | 'handoffs' | 'doctor' | 'legacy'

interface AiMemoryModalProps {
  isOpen: boolean
  project: Project | null
  onClose: () => void
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mapeia severity do helper para o contrato de onNotify (success|error|info).
 * 'warning' → 'error' (mais visível que info; não é erro de sistema).
 */
export function mapNoticeSeverity(
  type: 'warning' | 'info',
): 'error' | 'info' {
  return type === 'warning' ? 'error' : 'info'
}

/**
 * Extrai notificações de estado do resultado de enableProject.
 * Função pura: testável sem React/DOM.
 *
 * Regras marker:
 *   conflict  → warning (marker conflita, precisa revisão manual)
 *   preserved → info (marker de terceiro preservado)
 *   disabled  → warning (marker desabilitado)
 *   created/unchanged/updated + configured=false → warning (incompleto)
 *   created/unchanged/updated + configured=true → sem aviso
 *
 * Regras migration (quando presente):
 *   failed/disabled/unavailable → warning com message do backend
 *   skipped-empty → info
 *   migrated/already-migrated → sem aviso
 *
 * Regras migration ausente:
 *   marker.configured=true → info (legado não migrado)
 */
export function buildEnableNotice(enableResult: {
  marker?: { status: string; configured?: boolean; conflicts?: string[] }
  migration?: { status: string; message?: string; paths?: string[] }
}): Array<{ message: string; type: 'warning' | 'info' }> {
  const notices: Array<{ message: string; type: 'warning' | 'info' }> = []

  // --- Marker ---
  if (enableResult.marker) {
    const m = enableResult.marker
    if (m.status === 'conflict') {
      notices.push({
        message: `Marker de terceiros conflita (${m.conflicts?.join(', ') || 'workspace/project'}) — revise o .ai-memory.toml e ajuste o escopo manualmente antes de usar captura compartilhada.`,
        type: 'warning',
      })
    } else if (m.status === 'preserved') {
      notices.push({
        message: 'Marker de terceiros preservado — configuração manual necessária para habilitar captura.',
        type: 'info',
      })
    } else if (m.status === 'disabled') {
      notices.push({
        message: 'Marker desabilitado — capture automática não está ativa para este projeto.',
        type: 'warning',
      })
    } else if (m.configured !== true) {
      // created/unchanged/updated mas não configurado: incompleto
      notices.push({
        message: `Marker ${m.status} mas não está completamente configurado. Verifique exclusões e briefing no .ai-memory.toml.`,
        type: 'warning',
      })
    }
  }

  // --- Migration ---
  if (enableResult.migration) {
    const mig = enableResult.migration
    if (mig.status === 'failed' || mig.status === 'disabled' || mig.status === 'unavailable') {
      notices.push({
        message: mig.message || `Migração legado: ${mig.status}.`,
        type: 'warning',
      })
    } else if (mig.status === 'skipped-empty') {
      notices.push({
        message: 'Nenhum dado legado encontrado para migrar.',
        type: 'info',
      })
    }
    // migrated / already-migrated → sem aviso
  } else if (enableResult.marker?.configured) {
    // Migration ausente + marker pronto: avisa sobre legado
    notices.push({
      message: 'Dados legados não foram migrados automaticamente. Use "Migrar agora" na aba Legado.',
      type: 'info',
    })
  }

  return notices
}

const STATUS_TONE: Record<string, string> = {
  running: 'bg-[var(--color-success)]',
  starting: 'bg-[var(--color-warning)]',
  degraded: 'bg-[var(--color-warning)]',
  error: 'bg-[var(--color-danger)]',
  unavailable: 'bg-[var(--color-text-muted)]',
}

const STATUS_LABEL: Record<string, string> = {
  running: 'Rodando',
  starting: 'Iniciando...',
  degraded: 'Degradado',
  error: 'Erro',
  unavailable: 'Indisponível',
}

function unwrap<T>(res: AiMemoryIpcResult<T> | undefined): T | undefined {
  return res?.ok === true ? res.data : undefined
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const AiMemoryModal: React.FC<AiMemoryModalProps> = ({
  isOpen,
  project,
  onClose,
  onNotify,
}) => {
  const [activeTab, setActiveTab] = useState<Tab>('status')
  const [loading, setLoading] = useState(true)
  const [projStatus, setProjStatus] = useState<AiMemoryProjectStatusResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Activity
  const [recentPages, setRecentPages] = useState<unknown[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<unknown[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [recentLoading, setRecentLoading] = useState(false)

  // Briefing
  const [briefing, setBriefing] = useState<unknown>(null)
  const [briefingLoading, setBriefingLoading] = useState(false)

  // Handoffs
  const [handoffs, setHandoffs] = useState<unknown[]>([])
  const [handoffsLoading, setHandoffsLoading] = useState(false)

  // Doctor
  const [doctorResult, setDoctorResult] = useState<{ ok: boolean; message?: string } | null>(null)
  const [doctorLoading, setDoctorLoading] = useState(false)

  // Migration
  const [migrating, setMigrating] = useState(false)
  const [migrationResult, setMigrationResult] = useState<AiMemoryMigrationOutcomeView | null>(null)

  // Opt-in toggle
  const [toggling, setToggling] = useState(false)

  const api = typeof window !== 'undefined' ? window.devorbit : undefined

  // ---- Load on open ----
  useEffect(() => {
    if (!isOpen || !project || !api) return
    setLoading(true)
    setError(null)
    setProjStatus(null)
    setActiveTab('status')
    setRecentPages([])
    setBriefing(null)
    setHandoffs([])
    setDoctorResult(null)
    setMigrationResult(null)
    setSearchQuery('')
    setSearchResults(null)

    const req = { projectPath: project.path }
    void api.getProjectStatus(req).then((res) => {
      if (res.ok && res.data) {
        setProjStatus(res.data)
      } else {
        setError(res.message || res.reason || 'Falha ao carregar status.')
      }
      setLoading(false)
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Erro desconhecido.')
      setLoading(false)
    })
  }, [isOpen, project?.path])

  const handleToggle = useCallback(async () => {
    if (!project || !projStatus || toggling || !api) return
    setToggling(true)
    try {
      const res = await api.aiMemoryEnableProject({
        projectPath: project.path,
        enabled: !projStatus.isProjectEnabled,
      })
      if (res.ok && res.data) {
        // Recaptura o status completo do projeto para garantir sincronia do marker e migration
        try {
          const freshStatus = await api.getProjectStatus({ projectPath: project.path })
          if (freshStatus.ok && freshStatus.data) {
            setProjStatus(freshStatus.data)
          } else {
            setProjStatus({
              ...projStatus,
              isProjectEnabled: !projStatus.isProjectEnabled,
              status: res.data.status,
            })
          }
        } catch {
          setProjStatus({
            ...projStatus,
            isProjectEnabled: !projStatus.isProjectEnabled,
            status: res.data.status,
          })
        }
        // Confirmação explícita do opt-in (não promete que o sidecar está running).
        const wasEnabled = projStatus.isProjectEnabled
        onNotify(
          !wasEnabled
            ? 'Shared AI Memory habilitado para este projeto.'
            : 'Shared AI Memory desabilitado para este projeto.',
          'success',
        )
        // Avisos adicionais sobre marker e migração.
        for (const notice of buildEnableNotice(res.data as AiMemoryEnableProjectResult)) {
          onNotify(notice.message, mapNoticeSeverity(notice.type))
        }
      } else {
        onNotify(res.message || res.reason || 'Falha ao alterar opt-in.', 'error')
        // Rollback: re-fetch server state to desync the optimistic update.
        void api.getProjectStatus({ projectPath: project.path }).then((fresh) => {
          if (fresh.ok && fresh.data) setProjStatus(fresh.data)
        }).catch(() => {})
      }
    } catch (err: unknown) {
      onNotify(`Erro: ${err instanceof Error ? err.message : String(err)}`, 'error')
      // Rollback: re-fetch server state to desync the optimistic update.
      void api.getProjectStatus({ projectPath: project.path }).then((fresh) => {
        if (fresh.ok && fresh.data) setProjStatus(fresh.data)
      }).catch(() => {})
    } finally {
      setToggling(false)
    }
  }, [project?.path, projStatus, toggling, api, onNotify])

  const handleMigrate = useCallback(async () => {
    if (!project || migrating || !api) return
    setMigrating(true)
    setMigrationResult(null)
    try {
      const res = await api.aiMemoryMigrateLegacy({ projectPath: project.path })
      if (res.ok && res.data) {
        setMigrationResult(res.data)
        if (res.data.status === 'migrated' || res.data.status === 'already-migrated') {
          onNotify(res.data.message || 'Migração concluída.', 'success')
          // Recaptura o status do projeto para refletir receipt=present imediatamente e esconder a ação
          try {
            const freshStatus = await api.getProjectStatus({ projectPath: project.path })
            if (freshStatus.ok && freshStatus.data) {
              setProjStatus(freshStatus.data)
            } else {
              setProjStatus((current) => current ? {
                ...current,
                migration: {
                  receipt: 'present',
                  concludedAt: new Date().toISOString(),
                  paths: res.data?.paths || [],
                },
              } : current)
            }
          } catch {
            setProjStatus((current) => current ? {
              ...current,
              migration: {
                receipt: 'present',
                concludedAt: new Date().toISOString(),
                paths: res.data?.paths || [],
              },
            } : current)
          }
        } else {
          onNotify(res.data.message || `Migração: ${res.data.status}`, 'info')
        }
      } else {
        onNotify(res.message || res.reason || 'Falha na migração.', 'error')
      }
    } catch (err: unknown) {
      onNotify(`Erro na migração: ${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setMigrating(false)
    }
  }, [project?.path, migrating, api, onNotify])

  const loadRecent = useCallback(async () => {
    if (!project || !api) return
    setRecentLoading(true)
    try {
      const res = await api.aiMemoryRecent({ projectPath: project.path, limit: 20 })
      setRecentPages(res.ok ? extractIpcArray(res.data) : [])
    } catch {
      setRecentPages([])
    } finally {
      setRecentLoading(false)
    }
  }, [project?.path, api])

  const loadBriefing = useCallback(async () => {
    if (!project || !api) return
    setBriefingLoading(true)
    setBriefing(null)
    try {
      const res = await api.aiMemoryBriefing({ projectPath: project.path })
      if (res.ok && res.data) {
        setBriefing(res.data)
      } else {
        setBriefing(res.message || res.reason || 'Briefing indisponível.')
      }
    } catch {
      setBriefing('Erro ao carregar briefing.')
    } finally {
      setBriefingLoading(false)
    }
  }, [project?.path, api])

  const loadHandoffs = useCallback(async () => {
    if (!project || !api) return
    setHandoffsLoading(true)
    try {
      const res = await api.aiMemoryHandoffs({ projectPath: project.path })
      setHandoffs(res.ok ? extractIpcArray(res.data) : [])
    } catch {
      setHandoffs([])
    } finally {
      setHandoffsLoading(false)
    }
  }, [project?.path, api])

  const handleSearch = useCallback(async () => {
    if (!project || !searchQuery.trim() || !api) return
    setSearching(true)
    try {
      const res = await api.aiMemoryQuery({ projectPath: project.path, query: searchQuery.trim(), limit: 20 })
      setSearchResults(res.ok ? extractIpcArray(res.data) : [])
    } catch {
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }, [project?.path, searchQuery, api])

  const loadDoctor = useCallback(async () => {
    if (!api) return
    setDoctorLoading(true)
    try {
      const res = await api.aiMemoryDoctor()
      setDoctorResult(res.ok && res.data ? res.data : { ok: false, message: res.message || res.reason || 'Falha no diagnóstico.' })
    } catch (err: unknown) {
      setDoctorResult({ ok: false, message: err instanceof Error ? err.message : 'Erro no diagnóstico.' })
    } finally {
      setDoctorLoading(false)
    }
  }, [api])

  if (!isOpen || !project) return null

  const status = projStatus?.status
  const isEnabled = projStatus?.isProjectEnabled ?? false
  const migration = projStatus?.migration
  const receiptPresent =
    migration?.receipt === 'present' ||
    migrationResult?.status === 'migrated' ||
    migrationResult?.status === 'already-migrated'

  const tabs: Array<{ key: Tab; label: string; disabled?: boolean }> = [
    { key: 'status', label: 'Status' },
    { key: 'activity', label: 'Atividade' },
    { key: 'briefing', label: 'Briefing' },
    { key: 'handoffs', label: 'Handoffs' },
    { key: 'doctor', label: 'Doctor' },
    { key: 'legacy', label: 'Legado', disabled: !receiptPresent },
  ]

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const enabledTabs = tabs.filter((t) => !t.disabled)
    const currentIndex = enabledTabs.findIndex((t) => t.key === activeTab)
    if (currentIndex === -1) return

    let nextIndex = -1
    if (e.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % enabledTabs.length
    } else if (e.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + enabledTabs.length) % enabledTabs.length
    } else if (e.key === 'Home') {
      nextIndex = 0
    } else if (e.key === 'End') {
      nextIndex = enabledTabs.length - 1
    }

    if (nextIndex !== -1) {
      e.preventDefault()
      const nextTab = enabledTabs[nextIndex]
      setActiveTab(nextTab.key)
      const nextEl = document.getElementById(`ai-memory-tab-${nextTab.key}`)
      nextEl?.focus()
    }
  }

  return (
    <AccessibleDialog
      isOpen={isOpen}
      titleId="ai-memory-dialog-title"
      onClose={onClose}
      className="w-full max-w-3xl bg-[var(--color-bg-panel)] border border-[var(--color-border-subtle)] rounded-[10px] shadow-[0_18px_42px_rgba(28,25,23,0.14)] overflow-hidden flex flex-col max-h-[calc(100dvh-48px)]"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border-subtle)]">
        <div className="flex items-center gap-2">
          <h2 id="ai-memory-dialog-title" className="text-base font-bold text-[var(--text-primary)]">
            Shared AI Memory
          </h2>
          <span className="text-xs text-[var(--color-text-muted)]">{project.name}</span>
          {status && (
            <span
              role="img"
              aria-label={`Status: ${STATUS_LABEL[status.state] || status.state}`}
              title={status.message || STATUS_LABEL[status.state] || status.state}
              className={`w-2 h-2 rounded-full shrink-0 ${STATUS_TONE[status.state] || 'bg-[var(--color-text-muted)]'}`}
            >
              <span className="sr-only">Status: {STATUS_LABEL[status.state] || status.state}</span>
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="Fechar memória da IA"
          className="min-w-8 min-h-8 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] motion-safe:transition-colors"
        >
          <X aria-hidden="true" className="w-4 h-4" />
        </button>
      </div>

      {/* Tabs */}
      <div
        className="px-6 pt-2 border-b border-[var(--color-border-subtle)] flex gap-1 overflow-x-auto"
        role="tablist"
        aria-label="Seções da memória"
        onKeyDown={handleTabKeyDown}
      >
        {tabs.map((tab) => (
          <button
            key={tab.key}
            id={`ai-memory-tab-${tab.key}`}
            role="tab"
            aria-selected={activeTab === tab.key}
            aria-controls={`ai-memory-panel-${tab.key}`}
            tabIndex={activeTab === tab.key ? 0 : -1}
            aria-disabled={tab.disabled}
            disabled={tab.disabled}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-t-md transition-colors ${
              activeTab === tab.key
                ? 'bg-[var(--color-bg-panel)] text-[var(--text-primary)] border border-[var(--color-border-subtle)] border-b-transparent'
                : 'text-[var(--color-text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
            } ${tab.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div
        id={`ai-memory-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`ai-memory-tab-${activeTab}`}
        tabIndex={0}
        className="flex-1 overflow-y-auto p-6 min-h-[280px] focus:outline-none"
        aria-live="polite"
      >
        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center text-[var(--color-text-muted)]">
            <RefreshCw aria-hidden="true" className="w-6 h-6 motion-safe:animate-spin mb-2 text-[var(--color-accent-strong)]" />
            <span className="text-xs">Carregando status...</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-3 text-center">
            <AlertTriangle className="w-8 h-8 text-[var(--color-warning)]" />
            <p className="text-sm text-[var(--text-primary)]">{error}</p>
            <button
              onClick={() => {
                setError(null)
                setLoading(true)
                void api?.getProjectStatus({ projectPath: project.path }).then((res) => {
                  if (res.ok && res.data) setProjStatus(res.data)
                  else setError(res.message || res.reason || 'Falha ao carregar.')
                  setLoading(false)
                }).catch((e: unknown) => {
                  setError(e instanceof Error ? e.message : 'Erro')
                  setLoading(false)
                })
              }}
              className="px-3 py-1.5 text-xs font-semibold rounded-[6px] bg-[var(--color-bg-toolbar)] border border-[var(--color-border-subtle)] text-[var(--color-text-secondary)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
            >
              Tentar novamente
            </button>
          </div>
        ) : (
          <>
            {/* Tab: Status */}
            {activeTab === 'status' && (
              <div className="space-y-5">
                {/* Opt-in toggle */}
                <div className="flex items-center justify-between p-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-toolbar)]">
                  <div>
                    <div className="text-sm font-semibold text-[var(--text-primary)]">Shared AI Memory</div>
                    <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
                      {isEnabled ? 'Ativado — dados são sincronizados com o sidecar ai-memory.' : 'Desativado — nenhum dado sai deste projeto.'}
                    </div>
                  </div>
                  <button
                    role="switch"
                    aria-checked={isEnabled}
                    onClick={() => void handleToggle()}
                    disabled={toggling}
                    aria-label={isEnabled ? 'Desabilitar Shared AI Memory' : 'Habilitar Shared AI Memory'}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 ${
                      isEnabled ? 'bg-[var(--color-accent-strong)]' : 'bg-[var(--color-text-muted)]'
                    }`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>

                {/* Service status */}
                {status && (
                  <div className="p-3 rounded-lg border border-[var(--color-border-subtle)]">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`w-2 h-2 rounded-full ${STATUS_TONE[status.state] || ''}`} />
                      <span className="text-sm font-semibold text-[var(--text-primary)]">
                        Serviço: {STATUS_LABEL[status.state] || status.state}
                      </span>
                      {status.version && <span className="text-[10px] text-[var(--color-text-muted)]">v{status.version}</span>}
                      {status.owned && <span className="text-[10px] text-[var(--color-text-muted)]">local</span>}
                    </div>
                    {status.message && (
                      <p className="text-xs text-[var(--color-text-muted)] mt-1">{status.message}</p>
                    )}
                    {status.conflict && (
                      <p className="text-xs text-[var(--color-warning)] mt-1 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> Conflito detectado no endpoint.
                      </p>
                    )}
                  </div>
                )}

                {/* Migration */}
                {migration && (
                  <div className="p-3 rounded-lg border border-[var(--color-border-subtle)]">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-semibold text-[var(--text-primary)]">Migração legado</div>
                        <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
                          {migration.receipt === 'present'
                            ? `Concluída${migration.concludedAt ? ` em ${new Date(migration.concludedAt).toLocaleString('pt-BR')}` : ''}.`
                            : migration.receipt === 'error'
                              ? 'Erro na migração anterior.'
                              : 'Nenhum dado legado migrado ainda.'}
                          {migration.message && ` ${migration.message}`}
                        </div>
                      </div>
                      {!receiptPresent && (
                        <button
                          onClick={() => void handleMigrate()}
                          disabled={migrating}
                          className="px-3 py-1.5 text-xs font-semibold rounded-[6px] bg-[var(--surface-selected)] text-[var(--color-accent-strong)] border border-[var(--color-border-subtle)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer disabled:opacity-50"
                        >
                          {migrating ? 'Migrando...' : 'Migrar agora'}
                        </button>
                      )}
                    </div>
                    {migrationResult && (
                      <div className={`mt-2 text-xs p-2 rounded ${
                        migrationResult.status === 'migrated' || migrationResult.status === 'already-migrated'
                          ? 'bg-[var(--color-success)]/10 text-[var(--color-success)]'
                          : 'bg-[var(--color-warning)]/10 text-[var(--color-warning)]'
                      }`}>
                        {migrationResult.status === 'migrated' && `${migrationResult.paths.length} arquivo(s) migrado(s).`}
                        {migrationResult.status === 'already-migrated' && 'Dados já migrados anteriormente.'}
                        {migrationResult.status === 'skipped-empty' && 'Nenhum dado legado encontrado para migrar.'}
                        {migrationResult.status === 'failed' && `Falha: ${migrationResult.message || 'erro desconhecido.'}`}
                        {(migrationResult.status === 'disabled' || migrationResult.status === 'unavailable') && migrationResult.message}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Tab: Activity */}
            {activeTab === 'activity' && (
              <div className="space-y-4">
                {!isEnabled && (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--color-warning)]/10 border border-[var(--color-warning)]/20 text-xs text-[var(--color-warning)]" role="status">
                    <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>
                      Shared AI Memory está desativada para este projeto. Habilite na aba <strong>Status</strong> para buscar ou carregar páginas recentes.
                    </span>
                  </div>
                )}

                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-muted)]" aria-hidden="true" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && void handleSearch()}
                      placeholder="Buscar na memória do projeto..."
                      disabled={!isEnabled}
                      aria-label="Buscar na memória do projeto"
                      className="w-full pl-8 pr-3 py-1.5 text-xs rounded-[6px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] text-[var(--text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-focus-ring)]/30 disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                  </div>
                  <button
                    onClick={() => void handleSearch()}
                    disabled={!isEnabled || searching || !searchQuery.trim()}
                    className="px-3 py-1.5 text-xs font-semibold rounded-[6px] bg-[var(--surface-selected)] text-[var(--color-accent-strong)] border border-[var(--color-border-subtle)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {searching ? 'Buscando...' : 'Buscar'}
                  </button>
                  <button
                    onClick={() => void loadRecent()}
                    disabled={!isEnabled || recentLoading}
                    className="px-3 py-1.5 text-xs font-semibold rounded-[6px] bg-[var(--color-bg-panel)] text-[var(--color-text-secondary)] border border-[var(--color-border-subtle)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {recentLoading ? 'Carregando...' : 'Recentes'}
                  </button>
                </div>

                {/* Search results */}
                {searchResults !== null && (
                  <div>
                    <div className="text-xs text-[var(--color-text-muted)] mb-2">{searchResults.length} resultado(s)</div>
                    {searchResults.length === 0 && (
                      <p className="text-xs text-[var(--color-text-muted)]">Nenhum resultado encontrado.</p>
                    )}
                    {searchResults.map((item, i) => renderPage(item, i))}
                  </div>
                )}

                {/* Recent pages */}
                {searchResults === null && recentPages.length > 0 && (
                  <div>
                    <div className="text-xs text-[var(--color-text-muted)] mb-2">Páginas recentes</div>
                    {recentPages.map((item, i) => renderPage(item, i))}
                  </div>
                )}

                {isEnabled && searchResults === null && recentPages.length === 0 && !recentLoading && (
                  <p className="text-xs text-[var(--color-text-muted)] text-center py-4">
                    Clique em "Recentes" para carregar atividade ou busque por termo.
                  </p>
                )}
              </div>
            )}

            {/* Tab: Briefing */}
            {activeTab === 'briefing' && (
              <div className="space-y-3">
                {!isEnabled && (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--color-warning)]/10 border border-[var(--color-warning)]/20 text-xs text-[var(--color-warning)]" role="status">
                    <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>
                      Shared AI Memory está desativada para este projeto. Habilite na aba <strong>Status</strong> para gerar briefings consolidados.
                    </span>
                  </div>
                )}
                <button
                  onClick={() => void loadBriefing()}
                  disabled={!isEnabled || briefingLoading}
                  className="px-3 py-1.5 text-xs font-semibold rounded-[6px] bg-[var(--surface-selected)] text-[var(--color-accent-strong)] border border-[var(--color-border-subtle)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {briefingLoading ? 'Carregando...' : 'Gerar briefing'}
                </button>
                {briefing !== null && (
                  <div className="p-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-toolbar)]">
                    {typeof briefing === 'string' && briefing.includes('indispon') ? (
                      <p className="text-xs text-[var(--color-warning)]">{briefing}</p>
                    ) : typeof briefing === 'string' && briefing.includes('Erro') ? (
                      <p className="text-xs text-[var(--color-danger)]">{briefing}</p>
                    ) : (
                      renderBriefingContent(briefing)
                    )}
                  </div>
                )}
                {isEnabled && !briefing && !briefingLoading && (
                  <p className="text-xs text-[var(--color-text-muted)] text-center py-4">
                    O briefing consolida estado do projeto, handoffs recentes e contexto para uma sessão nova.
                  </p>
                )}
              </div>
            )}

            {/* Tab: Handoffs */}
            {activeTab === 'handoffs' && (
              <div className="space-y-3">
                {!isEnabled && (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--color-warning)]/10 border border-[var(--color-warning)]/20 text-xs text-[var(--color-warning)]" role="status">
                    <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>
                      Shared AI Memory está desativada para este projeto. Habilite na aba <strong>Status</strong> para visualizar handoffs de agentes.
                    </span>
                  </div>
                )}
                <button
                  onClick={() => void loadHandoffs()}
                  disabled={!isEnabled || handoffsLoading}
                  className="px-3 py-1.5 text-xs font-semibold rounded-[6px] bg-[var(--surface-selected)] text-[var(--color-accent-strong)] border border-[var(--color-border-subtle)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {handoffsLoading ? 'Carregando...' : 'Carregar handoffs'}
                </button>
                {handoffs.length > 0 && (
                  <div>
                    {handoffs.map((item, i) => renderHandoff(item, i))}
                  </div>
                )}
                {isEnabled && !handoffs.length && !handoffsLoading && (
                  <p className="text-xs text-[var(--color-text-muted)] text-center py-4">
                    Nenhum handoff aberto para este projeto.
                  </p>
                )}
              </div>
            )}

            {/* Tab: Doctor */}
            {activeTab === 'doctor' && (
              <div className="space-y-3">
                <button
                  onClick={() => void loadDoctor()}
                  disabled={doctorLoading}
                  className="px-3 py-1.5 text-xs font-semibold rounded-[6px] bg-[var(--surface-selected)] text-[var(--color-accent-strong)] border border-[var(--color-border-subtle)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer disabled:opacity-50"
                >
                  {doctorLoading ? 'Executando...' : 'Executar Doctor'}
                </button>
                {doctorResult && (
                  <div className={`p-3 rounded-lg border text-xs ${
                    doctorResult.ok
                      ? 'border-[var(--color-success)]/30 bg-[var(--color-success)]/5 text-[var(--color-success)]'
                      : 'border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5 text-[var(--color-warning)]'
                  }`}>
                    <div className="flex items-center gap-1.5 font-semibold mb-1">
                      {doctorResult.ok ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                      {doctorResult.ok ? 'Saudável' : 'Problemas detectados'}
                    </div>
                    {doctorResult.message && <pre className="whitespace-pre-wrap font-mono text-[10px]">{doctorResult.message}</pre>}
                  </div>
                )}
                {!doctorResult && !doctorLoading && (
                  <p className="text-xs text-[var(--color-text-muted)] text-center py-4">
                    Execute o doctor para verificar a saúde do ai-memory.
                  </p>
                )}
              </div>
            )}

            {/* Tab: Legacy */}
            {activeTab === 'legacy' && (
              <div className="space-y-3">
                {receiptPresent ? (
                  <>
                    <div className="flex items-center gap-2 p-2 rounded bg-[var(--color-success)]/5 border border-[var(--color-success)]/20 text-xs text-[var(--color-success)]">
                      <Info className="w-3.5 h-3.5 shrink-0" />
                      Dados migrados — conteúdo legado é somente leitura.
                    </div>
                    {migration?.paths && migration.paths.length > 0 && (
                      <div className="text-xs text-[var(--color-text-muted)]">
                        {migration.paths.length} arquivo(s): {migration.paths.slice(0, 5).join(', ')}{migration.paths.length > 5 ? '...' : ''}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-[var(--color-text-muted)] text-center py-4">
                    Nenhum dado legado migrado. Volte à aba Status para migrar.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-6 py-3.5 border-t border-[var(--color-border-subtle)] bg-[var(--surface-muted)] text-xs">
        <div className="flex items-center gap-2 text-[var(--color-text-muted)]">
          <Clock aria-hidden="true" className="w-3.5 h-3.5" />
          <span>
            {status?.version ? `Sidecar v${status.version}` : 'Sem sidecar'}
          </span>
          {status?.endpoint && <span className="text-[var(--color-text-muted)]">• {status.endpoint}</span>}
        </div>
        <button
          onClick={onClose}
          className="px-4 py-1.5 rounded-[6px] text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
        >
          Fechar
        </button>
      </div>
    </AccessibleDialog>
  )
}
