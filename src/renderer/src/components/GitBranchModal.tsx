import React, { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, GitBranch, RefreshCw, X } from 'lucide-react'
import { AccessibleDialog } from './AccessibleDialog'
import type { GitBranch as GitBranchInfo, Project, SyncResult } from '../types'

interface GitBranchModalProps {
  isOpen: boolean
  project: Project | null
  onClose: () => void
  onSwitch: (projectPath: string, branch: string) => Promise<SyncResult>
  onStashSwitch?: (projectPath: string, branch: string) => Promise<SyncResult>
  onProjectUpdated?: () => Promise<void>
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void
}

export const GitBranchModal: React.FC<GitBranchModalProps> = ({
  isOpen,
  project,
  onClose,
  onSwitch,
  onStashSwitch,
  onProjectUpdated,
  onNotify,
}) => {
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [switchingBranch, setSwitchingBranch] = useState<string | null>(null)
  const [dirtyBranch, setDirtyBranch] = useState<string | null>(null)

  const loadBranches = async (refreshRemote: boolean) => {
    if (!project) return
    setIsLoading(true)
    try {
      const result = await window.devorbit.getGitBranches(project.path, refreshRemote)
      setBranches(result)
    } catch (error: any) {
      onNotify(`Não foi possível listar as branches: ${error.message}`, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (isOpen && project) void loadBranches(true)
  }, [isOpen, project?.path])

  const localBranches = useMemo(() => branches.filter((branch) => !branch.isRemote), [branches])
  const remoteBranches = useMemo(() => branches.filter((branch) => branch.isRemote), [branches])

  if (!isOpen || !project) return null

  const handleSwitch = async (branch: GitBranchInfo) => {
    if (branch.isCurrent || switchingBranch) return
    setSwitchingBranch(branch.name)
    setDirtyBranch(null)
    try {
      const result = await onSwitch(project.path, branch.name)
      if (result.success) {
        onNotify(result.message, 'success')
        await onProjectUpdated?.()
        onClose()
      } else {
        if (onStashSwitch && /alterações locais/i.test(result.message)) setDirtyBranch(branch.name)
        onNotify(result.message, 'error')
      }
    } catch (error: any) {
      onNotify(`Erro ao trocar de branch: ${error.message}`, 'error')
    } finally {
      setSwitchingBranch(null)
    }
  }

  const handleStashSwitch = async (branch: GitBranchInfo) => {
    if (!onStashSwitch || switchingBranch) return
    setSwitchingBranch(branch.name)
    try {
      const result = await onStashSwitch(project.path, branch.name)
      if (result.success) {
        onNotify(result.message, 'success')
        await onProjectUpdated?.()
        onClose()
      } else {
        onNotify(result.message, 'error')
      }
    } catch (error: any) {
      onNotify(`Erro ao trocar de branch com stash: ${error.message}`, 'error')
    } finally {
      setSwitchingBranch(null)
      setDirtyBranch(null)
    }
  }

  return (
    <AccessibleDialog
      isOpen={isOpen}
      titleId="git-branch-dialog-title"
      onClose={onClose}
      className="w-full max-w-xl max-h-[calc(100dvh-48px)] overflow-y-auto rounded-[10px] border border-stone-200 bg-white shadow-[0_18px_42px_rgba(28,25,23,0.14)]"
    >
      <div className="flex items-center justify-between border-b border-stone-200 bg-stone-50 px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded-[8px] border border-[#cbd8bf] bg-[#edf3e8] p-2 text-[#3e562f]">
            <GitBranch className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 id="git-branch-dialog-title" className="truncate text-base font-bold text-stone-900">
              Trocar branch
            </h2>
            <p className="truncate text-xs text-stone-600" title={project.path}>
              {project.name} · atual: <span className="font-mono text-[#3e562f]">{project.git.branch}</span>
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar seletor de branch"
          className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="space-y-4 p-6 text-stone-900">
        <div className="flex items-start gap-2 rounded-[8px] border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs leading-5 text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
          <span>
            A troca é bloqueada quando há arquivos locais alterados. Faça commit ou stash antes; depois de trocar, use o botão <strong>Pull</strong> do card para atualizar a branch escolhida.
          </span>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-600">Branches locais</p>
            <p className="mt-1 text-xs text-stone-600">A branch atual fica marcada e não precisa ser trocada.</p>
          </div>
          <button
            type="button"
            onClick={() => void loadBranches(true)}
            disabled={isLoading || Boolean(switchingBranch)}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-stone-300 bg-stone-100 px-2.5 text-xs font-semibold text-stone-700 transition-colors hover:border-[#9eb28f] hover:text-stone-900 disabled:cursor-wait disabled:opacity-60"
            title="Buscar novas branches no remote"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" />
            Atualizar
          </button>
        </div>

        <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-[8px] border border-stone-200 bg-stone-50 p-2">
          {isLoading && branches.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-stone-600">
              <RefreshCw className="h-4 w-4 motion-safe:animate-spin text-[#3e562f]" aria-hidden="true" />
              Lendo branches…
            </div>
          ) : localBranches.length === 0 ? (
            <p className="py-8 text-center text-xs text-stone-600">Nenhuma branch local encontrada.</p>
          ) : (
            localBranches.map((branch) => (
              <button
                key={`local-${branch.name}`}
                type="button"
                onClick={() => void handleSwitch(branch)}
                disabled={branch.isCurrent || Boolean(switchingBranch)}
                className="flex min-h-10 w-full items-center justify-between gap-3 rounded-lg px-3 text-left text-sm transition-colors hover:bg-[#edf3e8] disabled:cursor-default disabled:opacity-70"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {branch.isCurrent ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-700" aria-hidden="true" /> : <GitBranch className="h-3.5 w-3.5 shrink-0 text-stone-500" aria-hidden="true" />}
                  <span className={`truncate font-mono text-xs ${branch.isCurrent ? 'text-emerald-700' : 'text-stone-800'}`}>{branch.name}</span>
                </span>
                <span className="shrink-0 text-[10px] text-stone-600">
                  {switchingBranch === branch.name ? 'Trocando…' : branch.isCurrent ? 'atual' : branch.upstream ? `→ ${branch.upstream}` : 'trocar'}
                </span>
              </button>
            ))
          )}
        </div>

        {dirtyBranch && onStashSwitch && (
          <div className="flex items-center justify-between gap-3 rounded-[8px] border border-[#cbd8bf] bg-[#f4f7f1] px-3.5 py-3">
            <p className="text-xs leading-5 text-stone-700">
              Há alterações locais. Posso guardá-las em stash, trocar e restaurar.
            </p>
            <button
              type="button"
              onClick={() => {
                const target = [...localBranches, ...remoteBranches].find((b) => b.name === dirtyBranch)
                if (target) void handleStashSwitch(target)
              }}
              disabled={Boolean(switchingBranch)}
              className="shrink-0 rounded-lg bg-[#3e562f] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#334827] disabled:opacity-60"
            >
              Stash + trocar
            </button>
          </div>
        )}

        {remoteBranches.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-600">Branches remotas</p>
            <div className="max-h-36 space-y-1.5 overflow-y-auto rounded-[8px] border border-stone-200 bg-stone-50 p-2">
              {remoteBranches.map((branch) => (
                <button
                  key={`remote-${branch.name}`}
                  type="button"
                  onClick={() => void handleSwitch(branch)}
                  disabled={Boolean(switchingBranch)}
                  className="flex min-h-9 w-full items-center justify-between gap-3 rounded-lg px-3 text-left transition-colors hover:bg-[#edf3e8] disabled:cursor-wait disabled:opacity-60"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <GitBranch className="h-3.5 w-3.5 shrink-0 text-[#3e562f]" aria-hidden="true" />
                    <span className="truncate font-mono text-xs text-[#3e562f]">{branch.name}</span>
                  </span>
                  <span className="shrink-0 text-[10px] text-stone-600">{switchingBranch === branch.name ? 'Criando…' : 'usar'}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </AccessibleDialog>
  )
}
