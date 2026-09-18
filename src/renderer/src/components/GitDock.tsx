import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowUpCircle,
  Check,
  ChevronRight,
  FileCode,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  UploadCloud,
  X,
} from 'lucide-react'
import type { AppConfig, GitBranch as GitBranchInfo, GitChange, GitFileDiff, Project, SyncResult } from '../types'
import { canSubmitInitDock, classifyDiffLine, isInitPushAvailable, splitPreviewLines } from './git-dock-helpers'
import { DiffViewer, type SerializableDiffLine } from './DiffViewer'

export interface GitDockInitPreview {
  path: string
  canInitialize: boolean
  isRepository: boolean
  branch: string
  fileCount: number
  files: string[]
  truncated: boolean
  fingerprint: string
  message: string
}

export interface GitDockInitOptions {
  branch: string
  remoteUrl?: string
  initialCommit: boolean
  commitMessage?: string
  push: boolean
  confirmAllFiles: boolean
  previewFingerprint?: string
}

export interface GitDockInitResult {
  success: boolean
  initialized: boolean
  commitCreated: boolean
  pushed: boolean
  preview?: GitDockInitPreview
  message: string
  output?: string
}

export type GitDockTab = 'push' | 'branches' | 'init' | 'clone'

interface GitDockProps {
  isOpen: boolean
  initialTab?: GitDockTab
  project: Project | null
  config: AppConfig | null
  onClose: () => void
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void
  onProjectUpdated: () => Promise<void> | void
  onSwitch: (projectPath: string, branch: string) => Promise<SyncResult>
  onStashSwitch?: (projectPath: string, branch: string) => Promise<SyncResult>
  onPreview: (projectPath: string, branch: string) => Promise<GitDockInitPreview>
  onInit: (projectPath: string, options: GitDockInitOptions) => Promise<GitDockInitResult>
  onCloned: () => Promise<void> | void
  onPushSuccess?: () => Promise<void> | void
}

function suggestFolderName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  const last = trimmed.split('/').pop() || ''
  return last.replace(/\.git$/i, '')
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem('devorbit:gitdock-collapsed') === '1'
  } catch {
    return false
  }
}

export const GitDock: React.FC<GitDockProps> = ({
  isOpen,
  initialTab = 'push',
  project,
  config,
  onClose,
  onNotify,
  onProjectUpdated,
  onSwitch,
  onStashSwitch,
  onPreview,
  onInit,
  onCloned,
  onPushSuccess,
}) => {
  const [activeTab, setActiveTab] = useState<GitDockTab>(initialTab)
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed())

  // Push state
  const [commitMessage, setCommitMessage] = useState('')
  const [changedFiles, setChangedFiles] = useState<GitChange[]>([])
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [isLoadingFiles, setIsLoadingFiles] = useState(false)
  const [isPushing, setIsPushing] = useState(false)
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null)
  const [fileDiff, setFileDiff] = useState<GitFileDiff | null>(null)
  const [isLoadingDiff, setIsLoadingDiff] = useState(false)
  const [diffError, setDiffError] = useState('')

  // Branches state
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [isLoadingBranches, setIsLoadingBranches] = useState(false)
  const [switchingBranch, setSwitchingBranch] = useState<string | null>(null)
  const [dirtyBranch, setDirtyBranch] = useState<string | null>(null)

  // Init state
  const [initBranch, setInitBranch] = useState('main')
  const [initRemote, setInitRemote] = useState('')
  const [initCommit, setInitCommit] = useState(false)
  const [initMessage, setInitMessage] = useState('chore: inicializa repositório')
  const [initPush, setInitPush] = useState(false)
  const [initConfirm, setInitConfirm] = useState(false)
  const [initPreview, setInitPreview] = useState<GitDockInitPreview | null>(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [isInitializing, setIsInitializing] = useState(false)

  // Clone state
  const [cloneParent, setCloneParent] = useState('')
  const [cloneFolder, setCloneFolder] = useState('')
  const [cloneUrl, setCloneUrl] = useState('')
  const [isCloning, setIsCloning] = useState(false)

  useEffect(() => {
    if (isOpen) setActiveTab(initialTab)
  }, [initialTab, isOpen])

  useEffect(() => {
    try {
      window.localStorage.setItem('devorbit:gitdock-collapsed', collapsed ? '1' : '0')
    } catch {
      // Preferência opcional.
    }
  }, [collapsed])

  useEffect(() => {
    if (project && isOpen && (activeTab === 'push' || activeTab === 'init')) {
      setCommitMessage(`feat: atualizações no ${project.name}`)
    }
  }, [project?.id, project?.name, isOpen, activeTab])

  useEffect(() => {
    if (!isOpen || !project) {
      setCloneParent(config?.projectDirs?.[0] || '')
    } else if (activeTab === 'clone') {
      setCloneParent(config?.projectDirs?.[0] || '')
    }
  }, [isOpen, activeTab, config, project])

  useEffect(() => {
    if (!cloneFolder && cloneUrl) setCloneFolder(suggestFolderName(cloneUrl))
  }, [cloneUrl, cloneFolder])

  const loadChanges = useCallback(async () => {
    if (!project || !project.git.hasChanges) {
      setChangedFiles([])
      setSelectedPaths([])
      setSelectedDiffPath(null)
      setFileDiff(null)
      setDiffError('')
      return
    }
    setIsLoadingFiles(true)
    try {
      const files = await window.devorbit?.getGitChanges(project.path)
      setChangedFiles(files || [])
      setSelectedPaths((files || []).map((file) => file.path))
      setSelectedDiffPath((current) => {
        if (current && (files || []).some((file) => file.path === current)) return current
        return (files || [])[0]?.path || null
      })
    } catch {
      setChangedFiles([])
      setSelectedPaths([])
      setSelectedDiffPath(null)
      setFileDiff(null)
    } finally {
      setIsLoadingFiles(false)
    }
  }, [project])

  useEffect(() => {
    if (isOpen && activeTab === 'push' && project) void loadChanges()
  }, [isOpen, activeTab, project, loadChanges])

  const loadFileDiff = useCallback(async (relativePath: string) => {
    if (!project) return
    setIsLoadingDiff(true)
    setDiffError('')
    try {
      const result = await window.devorbit.getGitFileDiff(project.path, relativePath)
      setFileDiff(result)
    } catch (error: unknown) {
      setFileDiff(null)
      setDiffError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoadingDiff(false)
    }
  }, [project])

  useEffect(() => {
    if (!isOpen || activeTab !== 'push' || !project || !selectedDiffPath) {
      if (!selectedDiffPath) {
        setFileDiff(null)
        setDiffError('')
      }
      return
    }
    void loadFileDiff(selectedDiffPath)
  }, [isOpen, activeTab, project, selectedDiffPath, loadFileDiff, changedFiles.length])

  const loadBranches = useCallback(async (refreshRemote: boolean) => {
    if (!project) return
    setIsLoadingBranches(true)
    try {
      const result = await window.devorbit.getGitBranches(project.path, refreshRemote)
      setBranches(result)
    } catch (error: unknown) {
      onNotify(`Não foi possível listar as branches: ${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setIsLoadingBranches(false)
    }
  }, [project, onNotify])

  useEffect(() => {
    if (isOpen && activeTab === 'branches' && project) void loadBranches(true)
  }, [isOpen, activeTab, project, loadBranches])

  const loadPreview = useCallback(async (projectPath: string, branch: string) => {
    setIsLoadingPreview(true)
    try {
      const result = await onPreview(projectPath, branch)
      setInitPreview(result)
    } catch (error: unknown) {
      setInitPreview(null)
      onNotify(`Não foi possível analisar a pasta: ${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setIsLoadingPreview(false)
    }
  }, [onPreview, onNotify])

  useEffect(() => {
    if (!isOpen || activeTab !== 'init' || !project) return
    setInitBranch('main')
    setInitRemote('')
    setInitCommit(false)
    setInitMessage('chore: inicializa repositório')
    setInitPush(false)
    setInitConfirm(false)
    void loadPreview(project.path, 'main')
  }, [isOpen, activeTab, project, loadPreview])

  useEffect(() => {
    if (!initCommit) {
      setInitPush(false)
      setInitConfirm(false)
    }
  }, [initCommit])

  if (!isOpen) return null

  const localBranches = useMemo(() => branches.filter((branch) => !branch.isRemote), [branches])
  const remoteBranches = useMemo(() => branches.filter((branch) => branch.isRemote), [branches])

  const handleSwitch = async (branch: GitBranchInfo) => {
    if (!project || branch.isCurrent || switchingBranch) return
    setSwitchingBranch(branch.name)
    setDirtyBranch(null)
    try {
      const result = await onSwitch(project.path, branch.name)
      if (result.success) {
        onNotify(result.message, 'success')
        await onProjectUpdated?.()
      } else {
        if (onStashSwitch && /alterações locais/i.test(result.message)) setDirtyBranch(branch.name)
        onNotify(result.message, 'error')
      }
    } catch (error: unknown) {
      onNotify(`Erro ao trocar de branch: ${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setSwitchingBranch(null)
    }
  }

  const handleStashSwitch = async (branch: GitBranchInfo) => {
    if (!project || !onStashSwitch || switchingBranch) return
    setSwitchingBranch(branch.name)
    try {
      const result = await onStashSwitch(project.path, branch.name)
      if (result.success) {
        onNotify(result.message, 'success')
        await onProjectUpdated?.()
      } else {
        onNotify(result.message, 'error')
      }
    } catch (error: unknown) {
      onNotify(`Erro ao trocar de branch com stash: ${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setSwitchingBranch(null)
      setDirtyBranch(null)
    }
  }

  const handlePush = async () => {
    if (!project || isPushing) return
    if (project.git.hasChanges && selectedPaths.length === 0) {
      onNotify('Selecione pelo menos um arquivo para criar o commit.', 'error')
      return
    }
    setIsPushing(true)
    try {
      const msgToSend = project.git.hasChanges
        ? commitMessage.trim() || `update: ${project.name}`
        : undefined
      const result = await window.devorbit?.pushGit(
        project.path,
        msgToSend,
        project.git.hasChanges ? { selectedPaths } : undefined,
      )
      if (result?.success) {
        onNotify(result.message || 'Subido para o GitHub com sucesso!', 'success')
        if (onPushSuccess) await onPushSuccess()
        else await onProjectUpdated?.()
        await loadChanges()
      } else {
        onNotify(result?.message || 'Erro ao subir para o GitHub', 'error')
      }
    } catch (error: unknown) {
      onNotify(`Erro no push: ${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setIsPushing(false)
    }
  }

  const canSubmitInit = canSubmitInitDock({
    canInitialize: Boolean(project && initPreview?.canInitialize),
    truncated: Boolean(initPreview?.truncated),
    fingerprint: initPreview?.fingerprint,
    isLoading: isLoadingPreview,
    isBusy: isInitializing,
    initialCommit: initCommit,
    commitMessage: initMessage,
    confirmed: initConfirm,
    push: initPush,
    remoteUrl: initRemote,
  })
  const pushAvailable = isInitPushAvailable(initRemote, initCommit)

  const handleInit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmitInit || !project) return
    setIsInitializing(true)
    try {
      const result = await onInit(project.path, {
        branch: initBranch.trim() || 'main',
        remoteUrl: initRemote.trim() || undefined,
        initialCommit: initCommit,
        commitMessage: initCommit ? initMessage.trim() : undefined,
        push: initPush,
        confirmAllFiles: initConfirm,
        previewFingerprint: initPreview?.fingerprint,
      })
      if (result.success) {
        await onProjectUpdated()
        onNotify(result.message, 'success')
      } else {
        setInitConfirm(false)
        if (result.preview) setInitPreview(result.preview)
        if (result.initialized) await onProjectUpdated()
        onNotify(result.message, 'error')
      }
    } catch (error: unknown) {
      onNotify(`Não foi possível criar o repositório: ${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setIsInitializing(false)
    }
  }

  const canSubmitClone = Boolean(cloneParent.trim() && cloneFolder.trim() && cloneUrl.trim()) && !isCloning

  const handleClone = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmitClone) return
    setIsCloning(true)
    try {
      const result = await window.devorbit?.cloneGitRepository({
        parentDir: cloneParent.trim(),
        folderName: cloneFolder.trim(),
        remoteUrl: cloneUrl.trim(),
      })
      if (result?.success) {
        await onCloned()
        onNotify(result.message || 'Repositório clonado!', 'success')
        setCloneFolder('')
        setCloneUrl('')
      } else {
        onNotify(result?.message || 'Erro ao clonar repositório.', 'error')
      }
    } catch (error: unknown) {
      onNotify(`Erro ao clonar: ${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setIsCloning(false)
    }
  }

  const tabs: Array<{ id: GitDockTab; label: string }> = [
    { id: 'push', label: 'Push' },
    { id: 'branches', label: 'Branches' },
    { id: 'init', label: 'Init' },
    { id: 'clone', label: 'Clonar' },
  ]

  return (
    <aside
      aria-label="Painel Git não-bloqueante"
      aria-expanded={!collapsed}
      className="git-dock"
      data-collapsed={collapsed ? 'true' : 'false'}
      style={{
        width: collapsed ? 44 : 380,
        flexShrink: 0,
      }}
    >
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-toolbar)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setCollapsed((current) => !current)}
            aria-label={collapsed ? 'Expandir painel Git' : 'Recolher painel Git'}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expandir painel Git' : 'Recolher painel Git'}
            className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            {collapsed ? <PanelRightOpen size={15} aria-hidden="true" /> : <PanelRightClose size={15} aria-hidden="true" />}
          </button>
          {!collapsed && (
            <strong className="truncate text-xs font-bold text-[var(--text-primary)]">
              Git{project ? ` · ${project.name}` : ''}
            </strong>
          )}
        </div>
        {!collapsed && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar painel Git"
            title="Fechar painel Git (o trabalho continua visível)"
            className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {!collapsed && (
        <>
          <div role="tablist" aria-label="Operações Git" className="flex gap-1 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-3 py-2">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${activeTab === tab.id ? 'bg-[var(--color-accent-strong)] text-[var(--color-accent-contrast)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="max-h-[calc(100vh-220px)] min-h-0 flex-1 overflow-y-auto p-4 text-sm text-[var(--text-primary)]">
            {activeTab === 'push' && (
              <div className="space-y-4" role="tabpanel" aria-label="Enviar alterações">
                {!project ? (
                  <p className="text-xs text-[var(--color-text-muted)]">Selecione um projeto para enviar alterações. O painel permanece aberto sem bloquear o editor.</p>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-2">
                      {project.git.ahead > 0 && (
                        <span className="flex items-center gap-1.5 rounded-lg border border-[var(--color-success)] bg-[var(--surface-selected)] px-2.5 py-1 text-xs font-semibold text-[var(--color-success)]">
                          <ArrowUpCircle size={14} aria-hidden="true" />
                          {project.git.ahead} commit(s) pronto(s) para push
                        </span>
                      )}
                      {project.git.hasChanges && (
                        <span className="flex items-center gap-1.5 rounded-lg border border-[var(--color-warning)] bg-[var(--surface-selected)] px-2.5 py-1 text-xs font-semibold text-[var(--color-warning)]">
                          <AlertTriangle size={14} aria-hidden="true" />
                          {project.git.modifiedCount + project.git.untrackedCount} arquivo(s) com alterações
                        </span>
                      )}
                    </div>
                    {project.git.hasChanges && (
                      <div>
                        <label htmlFor="gitdock-commit" className="mb-1.5 block text-xs font-semibold text-[var(--text-primary)]">Mensagem do commit</label>
                        <input
                          id="gitdock-commit"
                          value={commitMessage}
                          onChange={(event) => setCommitMessage(event.target.value)}
                          placeholder="Ex: feat: adiciona nova funcionalidade"
                          disabled={isPushing}
                          className="w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-3 py-2 text-sm"
                        />
                      </div>
                    )}
                    {project.git.hasChanges && (
                      <div>
                        <span className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-secondary)]">
                          <FileCode size={14} aria-hidden="true" /> Arquivos selecionados — clique para ver o diff
                        </span>
                        <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-[var(--color-border-subtle)] bg-[var(--surface-muted)] p-2 font-mono text-xs">
                          {isLoadingFiles ? (
                            <p className="py-2 text-center text-[var(--color-text-muted)]">Listando alterações…</p>
                          ) : changedFiles.length === 0 ? (
                            <p className="py-2 text-center text-[var(--color-text-muted)]">Nenhum arquivo listado.</p>
                          ) : (
                            changedFiles.map((file) => {
                              const isSelected = selectedDiffPath === file.path
                              return (
                                <div key={`${file.status}:${file.path}`} className={`flex items-center gap-2 truncate rounded px-1 py-0.5 ${isSelected ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]'}`}>
                                  <input
                                    type="checkbox"
                                    checked={selectedPaths.includes(file.path)}
                                    onChange={() => setSelectedPaths((current) => current.includes(file.path)
                                      ? current.filter((entry) => entry !== file.path)
                                      : [...current, file.path])}
                                    disabled={isPushing}
                                    aria-label={`Selecionar ${file.path}`}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => setSelectedDiffPath(file.path)}
                                    aria-pressed={isSelected}
                                    title={`Ver diff de ${file.path} contra HEAD`}
                                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                  >
                                    <span className="text-[10px] font-bold text-[var(--color-text-muted)]">{file.status.trim() || '  '}</span>
                                    <span className="truncate text-[var(--color-text-secondary)]" title={file.path}>{file.path}</span>
                                  </button>
                                </div>
                              )
                            })
                          )}
                        </div>
                      </div>
                    )}
                    {project.git.hasChanges && selectedDiffPath && (
                      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)]" aria-label={`Diff de ${selectedDiffPath}`} aria-live="polite">
                        <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-toolbar)] px-3 py-2">
                          <span className="truncate font-mono text-[11px] text-[var(--text-primary)]" title={selectedDiffPath}>{selectedDiffPath}</span>
                          <button
                            type="button"
                            onClick={() => void loadFileDiff(selectedDiffPath)}
                            disabled={isLoadingDiff}
                            className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-60"
                          >
                            <RefreshCw size={12} className={isLoadingDiff ? 'animate-spin' : ''} aria-hidden="true" /> Recarregar diff
                          </button>
                        </div>
                        {isLoadingDiff ? (
                          <p className="px-3 py-4 text-center text-xs text-[var(--color-text-muted)]">Lendo working tree contra HEAD…</p>
                        ) : diffError ? (
                          <p className="px-3 py-3 text-xs text-[var(--color-danger)]" role="alert">{diffError}</p>
                        ) : fileDiff ? (
                          <div className="space-y-2 p-3">
                            <p className="text-[11px] text-[var(--color-text-muted)]">{fileDiff.message}{fileDiff.truncated ? ' (truncado)' : ''}</p>
                            {fileDiff.binary ? (
                              <p className="rounded-md border border-[var(--color-warning)] bg-[var(--surface-selected)] px-2.5 py-2 text-xs text-[var(--color-warning)]">Arquivo binário: diff textual indisponível.</p>
                            ) : (
                              <>
                                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                                  <div className="min-w-0">
                                    <p className="mb-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">HEAD{fileDiff.headExists ? '' : ' (ausente)'}</p>
                                    <pre className="max-h-56 overflow-auto rounded-md border border-[var(--color-border-subtle)] bg-[var(--surface-muted)] p-2 font-mono text-[11px] leading-5 text-[var(--text-primary)]" aria-label="Conteúdo no HEAD">
                                      {(() => {
                                        const { lines, truncated } = splitPreviewLines(fileDiff.headContent || '(sem conteúdo no HEAD)')
                                        return <>{lines.join('\n')}{truncated ? '\n… (truncado)' : ''}</>
                                      })()}
                                    </pre>
                                  </div>
                                  <div className="min-w-0">
                                    <p className="mb-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">Working tree{fileDiff.worktreeExists ? '' : ' (removido)'}</p>
                                    <pre className="max-h-56 overflow-auto rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] p-2 font-mono text-[11px] leading-5 text-[var(--text-primary)]" aria-label="Conteúdo atual">
                                      {(() => {
                                        const { lines, truncated } = splitPreviewLines(fileDiff.worktreeContent || '(sem conteúdo atual)')
                                        return <>{lines.join('\n')}{truncated ? '\n… (truncado)' : ''}</>
                                      })()}
                                    </pre>
                                  </div>
                                </div>
                                <DiffViewer
                                  diff={{
                                    filePath: selectedDiffPath,
                                    oldLabel: 'HEAD',
                                    newLabel: 'Working tree',
                                    lines: fileDiff.diff.split('\n').slice(0, 400).map<SerializableDiffLine>((line) => {
                                      const tone = classifyDiffLine(line)
                                      return {
                                        kind: tone === 'add' ? 'add' : tone === 'del' ? 'del' : tone === 'hunk' ? 'hunk' : tone === 'meta' ? 'meta' : 'context',
                                        content: line || ' ',
                                      }
                                    }),
                                  }}
                                />
                              </>
                            )}
                          </div>
                        ) : (
                          <p className="px-3 py-3 text-xs text-[var(--color-text-muted)]">Selecione um arquivo para ver o conteúdo e o diff.</p>
                        )}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => void handlePush()}
                      disabled={isPushing}
                      className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent-strong)] px-4 py-2 text-xs font-semibold text-[var(--color-accent-contrast)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                    >
                      {isPushing ? <><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Subindo…</> : <><UploadCloud size={14} aria-hidden="true" /> Subir para o GitHub (Push)</>}
                    </button>
                  </>
                )}
              </div>
            )}

            {activeTab === 'branches' && (
              <div className="space-y-4" role="tabpanel" aria-label="Branches">
                {!project ? (
                  <p className="text-xs text-[var(--color-text-muted)]">Selecione um projeto para trocar de branch.</p>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-[var(--color-text-muted)]">Atual: <span className="font-mono text-[var(--color-accent-strong)]">{project.git.branch || 'sem branch'}</span></p>
                      <button
                        type="button"
                        onClick={() => void loadBranches(true)}
                        disabled={isLoadingBranches || Boolean(switchingBranch)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--surface-muted)] px-2.5 py-1.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-60"
                      >
                        <RefreshCw size={13} className={isLoadingBranches ? 'animate-spin' : ''} aria-hidden="true" /> Atualizar
                      </button>
                    </div>
                    <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg border border-[var(--color-border-subtle)] bg-[var(--surface-muted)] p-2">
                      {isLoadingBranches && branches.length === 0 ? (
                        <p className="py-6 text-center text-xs text-[var(--color-text-muted)]">Lendo branches…</p>
                      ) : localBranches.length === 0 ? (
                        <p className="py-6 text-center text-xs text-[var(--color-text-muted)]">Nenhuma branch local encontrada.</p>
                      ) : (
                        localBranches.map((branch) => (
                          <button
                            key={`local-${branch.name}`}
                            type="button"
                            onClick={() => void handleSwitch(branch)}
                            disabled={branch.isCurrent || Boolean(switchingBranch)}
                            className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--surface-hover)] disabled:opacity-70"
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              {branch.isCurrent ? <Check size={14} className="shrink-0 text-[var(--color-success)]" aria-hidden="true" /> : <GitBranch size={14} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true" />}
                              <span className="truncate font-mono text-xs text-[var(--text-primary)]">{branch.name}</span>
                            </span>
                            <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                              {switchingBranch === branch.name ? 'Trocando…' : branch.isCurrent ? 'atual' : 'trocar'}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                    {dirtyBranch && onStashSwitch && (
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--surface-selected)] px-3 py-2.5">
                        <p className="text-xs text-[var(--color-text-secondary)]">Há alterações locais. Guardar em stash e trocar?</p>
                        <button
                          type="button"
                          onClick={() => {
                            const target = [...localBranches, ...remoteBranches].find((entry) => entry.name === dirtyBranch)
                            if (target) void handleStashSwitch(target)
                          }}
                          disabled={Boolean(switchingBranch)}
                          className="shrink-0 rounded-lg bg-[var(--color-accent-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--color-accent-contrast)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
                        >
                          Stash + trocar
                        </button>
                      </div>
                    )}
                    {remoteBranches.length > 0 && (
                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Remotas</p>
                        <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-[var(--color-border-subtle)] bg-[var(--surface-muted)] p-2">
                          {remoteBranches.map((branch) => (
                            <button
                              key={`remote-${branch.name}`}
                              type="button"
                              onClick={() => void handleSwitch(branch)}
                              disabled={Boolean(switchingBranch)}
                              className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] disabled:opacity-60"
                            >
                              <span className="truncate font-mono text-xs text-[var(--color-accent-strong)]">{branch.name}</span>
                              <span className="text-[10px] text-[var(--color-text-muted)]">{switchingBranch === branch.name ? 'Criando…' : 'usar'}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {activeTab === 'init' && (
              <form onSubmit={(event) => void handleInit(event)} className="space-y-3" role="tabpanel" aria-label="Inicializar repositório">
                {!project ? (
                  <p className="text-xs text-[var(--color-text-muted)]">Selecione uma pasta sem Git para inicializar.</p>
                ) : (
                  <>
                    <p className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--surface-muted)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
                      {isLoadingPreview ? 'Analisando arquivos…' : initPreview?.message || 'Prévia indisponível.'}
                    </p>
                    {initPreview && !isLoadingPreview && initPreview.files.length > 0 && (
                      <div className="max-h-28 overflow-y-auto rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] p-2 font-mono text-[11px] text-[var(--color-text-secondary)]">
                        {initPreview.files.map((file) => <div key={file} className="truncate py-0.5" title={file}>{file}</div>)}
                      </div>
                    )}
                    <div className="grid grid-cols-1 gap-3">
                      <div>
                        <label htmlFor="gitdock-init-branch" className="mb-1 block text-xs font-semibold text-[var(--text-primary)]">Branch inicial</label>
                        <input id="gitdock-init-branch" value={initBranch} onChange={(event) => setInitBranch(event.target.value)} disabled={isInitializing} className="w-full rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-sm" />
                      </div>
                      <div>
                        <label htmlFor="gitdock-init-remote" className="mb-1 block text-xs font-semibold text-[var(--text-primary)]">Remote HTTPS (opcional)</label>
                        <input id="gitdock-init-remote" type="url" value={initRemote} onChange={(event) => setInitRemote(event.target.value)} placeholder="https://github.com/usuario/projeto.git" disabled={isInitializing} className="w-full rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-sm" />
                      </div>
                    </div>
                    <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--surface-muted)] p-3">
                      <input type="checkbox" checked={initCommit} onChange={(event) => setInitCommit(event.target.checked)} disabled={isInitializing || isLoadingPreview || Boolean(initPreview?.truncated)} className="mt-0.5 h-4 w-4 accent-[var(--color-accent-strong)]" />
                      <span className="text-xs text-[var(--color-text-secondary)]">Criar primeiro commit com <code>git add -A</code>.</span>
                    </label>
                    {initCommit && (
                      <div className="space-y-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--surface-selected)] p-3">
                        <input value={initMessage} onChange={(event) => setInitMessage(event.target.value)} disabled={isInitializing} aria-label="Mensagem do commit" className="w-full rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-sm" />
                        <label className="flex cursor-pointer items-start gap-2 text-xs text-[var(--color-text-secondary)]">
                          <input type="checkbox" checked={initConfirm} onChange={(event) => setInitConfirm(event.target.checked)} disabled={isInitializing} className="mt-0.5 h-4 w-4 accent-[var(--color-accent-strong)]" />
                          Confirmo que revisei a prévia e aceito incluir todos os arquivos não ignorados.
                        </label>
                        <label className={`flex cursor-pointer items-start gap-2 text-xs ${pushAvailable ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-text-muted)]'}`}>
                          <input
                            type="checkbox"
                            checked={initPush}
                            onChange={(event) => setInitPush(event.target.checked)}
                            disabled={isInitializing || !pushAvailable}
                            aria-label="Enviar para o remote após o commit"
                            className="mt-0.5 h-4 w-4 accent-[var(--color-accent-strong)]"
                          />
                          <span>
                            <span className="block font-semibold">Enviar para o remote após o commit</span>
                            <span className="mt-0.5 block">{pushAvailable ? 'O push nunca usa force. Um remote com histórico será recusado.' : 'Informe o remote HTTPS acima para habilitar o push.'}</span>
                          </span>
                        </label>
                      </div>
                    )}
                    <button type="submit" disabled={!canSubmitInit} className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent-strong)] px-4 py-2 text-xs font-semibold text-[var(--color-accent-contrast)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
                      {isInitializing ? <><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Processando…</> : initPush ? <><UploadCloud size={14} aria-hidden="true" /> Criar e enviar</> : initCommit ? <><GitCommit size={14} aria-hidden="true" /> Criar e commitar</> : <><GitBranch size={14} aria-hidden="true" /> Criar repositório</>}
                    </button>
                  </>
                )}
              </form>
            )}

            {activeTab === 'clone' && (
              <form onSubmit={(event) => void handleClone(event)} className="space-y-3" role="tabpanel" aria-label="Clonar repositório">
                <div>
                  <label htmlFor="gitdock-clone-parent" className="mb-1 block text-xs font-semibold text-[var(--text-primary)]">Pasta monitorada</label>
                  <select id="gitdock-clone-parent" value={cloneParent} onChange={(event) => setCloneParent(event.target.value)} disabled={isCloning} className="w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-3 py-2 text-sm">
                    {(config?.projectDirs || []).map((dir) => <option key={dir} value={dir}>{dir}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="gitdock-clone-url" className="mb-1 block text-xs font-semibold text-[var(--text-primary)]">Link HTTPS</label>
                  <input id="gitdock-clone-url" type="url" value={cloneUrl} onChange={(event) => setCloneUrl(event.target.value)} placeholder="https://github.com/usuario/projeto.git" disabled={isCloning} className="w-full rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-sm" />
                </div>
                <div>
                  <label htmlFor="gitdock-clone-name" className="mb-1 block text-xs font-semibold text-[var(--text-primary)]">Nome da pasta</label>
                  <input id="gitdock-clone-name" value={cloneFolder} onChange={(event) => setCloneFolder(event.target.value)} placeholder="meu-projeto" disabled={isCloning} className="w-full rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-sm" />
                </div>
                <button type="submit" disabled={!canSubmitClone} className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent-strong)] px-4 py-2 text-xs font-semibold text-[var(--color-accent-contrast)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
                  {isCloning ? <><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Clonando…</> : <><GitPullRequest size={14} aria-hidden="true" /> Clonar main recente</>}
                </button>
              </form>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-toolbar)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
            <span className="inline-flex items-center gap-1"><ChevronRight size={12} aria-hidden="true" /> Não-bloqueante: o código continua visível</span>
            <span>Dif lado a lado no editor</span>
          </div>
        </>
      )}
    </aside>
  )
}
