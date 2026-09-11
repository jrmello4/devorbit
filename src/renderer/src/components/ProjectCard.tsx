import React, { useState } from 'react'
import {
  Folder,
  GitBranch,
  GitPullRequest,
  RefreshCw,
  Terminal,
  Code2,
  Copy,
  Check,
  Bot,
  Globe,
  Sparkles,
  AlertCircle,
  FolderOpen,
  UploadCloud,
  Brain,
} from 'lucide-react'
import type { Project, AppConfig } from '../types'

interface ProjectCardProps {
  project: Project
  config: AppConfig | null
  onSync: (projectPath: string) => Promise<void>
  onOpenPushModal: (project: Project) => void
  onOpenGitInit: (project: Project) => void
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void
  onOpenAuthModal?: (account: 'account1' | 'account2') => void
  onOpenMemory?: (project: Project) => void
  onUsageUpdate?: () => void
}

export const ProjectCard: React.FC<ProjectCardProps> = ({
  project,
  config,
  onSync,
  onOpenPushModal,
  onOpenGitInit,
  onNotify,
  onOpenAuthModal,
  onOpenMemory,
  onUsageUpdate,
}) => {
  const [isSyncing, setIsSyncing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [launchingTool, setLaunchingTool] = useState<string | null>(null)

  const handleSync = async () => {
    setIsSyncing(true)
    try {
      await onSync(project.path)
    } finally {
      setIsSyncing(false)
    }
  }

  const handleLaunch = async (
    tool:
      | 'agy'
      | 'mimo'
      | 'brave'
      | 'chrome'
      | 'codex-desktop'
      | 'codex-cli'
      | 'vscode'
      | 'terminal'
      | 'folder'
  ) => {
    setLaunchingTool(tool)
    try {
      const res = await window.devorbit?.launchTool(tool, project.path, {
        account: config?.activeChatGptAccount,
      })
      if (res?.success) {
        onNotify(res.message || 'Ferramenta iniciada!', 'success')
        onUsageUpdate?.()
      } else {
        if (res?.needsAuth) {
          onOpenAuthModal?.((res.account as any) || config?.activeChatGptAccount || 'account1')
        }
        onNotify(
          res?.message || 'Erro ao iniciar ferramenta.',
          res?.needsAuth ? 'info' : 'error'
        )
      }
    } catch (err: any) {
      onNotify(`Erro: ${err.message}`, 'error')
    } finally {
      setTimeout(() => setLaunchingTool(null), 600)
    }
  }

  const handleCopyContext = async () => {
    try {
      const res = await window.devorbit?.copyProjectContext(project.path)
      if (res?.success) {
        setCopied(true)
        onNotify('Contexto do projeto copiado para a área de transferência!', 'success')
        onUsageUpdate?.()
        setTimeout(() => setCopied(false), 2000)
      } else {
        onNotify(res?.context || 'Falha ao copiar contexto', 'error')
      }
    } catch (err: any) {
      onNotify(`Erro: ${err.message}`, 'error')
    }
  }

  const { git } = project
  const needsPull = git.isRepo && git.behind > 0
  const hasLocalChanges = git.isRepo && git.hasChanges
  const hasRemoteChanges = git.isRepo && git.ahead > 0
  const primaryAction = needsPull ? 'pull' : hasLocalChanges || hasRemoteChanges ? 'push' : 'pull'

  return (
    <div
      className={`surface-card group relative flex min-w-0 flex-col rounded-[18px] transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-2xl hover:shadow-indigo-950/30 ${
        needsPull
          ? 'border-sky-400/50 hover:border-sky-300/80 shadow-sky-500/10'
          : hasLocalChanges
          ? 'border-amber-400/35 hover:border-amber-300/70'
          : 'hover:border-slate-600'
      } p-5`}
    >
      {/* Top section: Title, Parent Dir, and Git status badge */}
      <div>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-lg font-semibold tracking-tight text-white transition-colors group-hover:text-cyan-100" title={project.name}>
                {project.name}
              </h3>
              <span className="shrink-0 rounded-full border border-[var(--color-border-subtle)]/80 bg-slate-950/35 px-2 py-1 text-[10px] font-semibold text-[var(--color-text-muted)]">
                {project.parentDir}
              </span>
            </div>
            <p className="mt-1 truncate text-[13px] text-[var(--color-text-muted)]" title={project.path}>
              {project.path}
            </p>
          </div>

          {/* Quick buttons */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => onOpenMemory?.(project)}
              aria-label={`Abrir memória de sessão e handoff de ${project.name}`}
              className="min-h-10 min-w-10 rounded-xl p-2 text-slate-400 transition-[color,background-color] hover:bg-violet-500/10 hover:text-violet-200 cursor-pointer"
            >
              <Brain className="w-4 h-4 text-violet-400" />
            </button>
            <button
              onClick={() => handleLaunch('folder')}
              aria-label={`Abrir ${project.name} no Windows Explorer`}
              className="min-h-10 min-w-10 rounded-xl p-2 text-slate-400 transition-[color,background-color] hover:bg-white/5 hover:text-slate-100 cursor-pointer"
            >
              <FolderOpen className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tech Stack & Git Badges */}
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {project.techs.map((tech) => (
            <span
              key={tech.id}
              className="rounded-md border px-2 py-1 text-[11px] font-semibold text-slate-200"
              style={{
                backgroundColor: `${tech.color}18`,
                borderColor: `${tech.color}40`,
              }}
            >
              {tech.label}
            </span>
          ))}

          {/* Git Status Badge */}
          {git.isRepo ? (
            <div className="ms-auto flex items-center gap-2">
              <span className="flex items-center gap-1 font-mono text-[11px] text-[var(--color-text-muted)]">
                <GitBranch className="h-3 w-3 text-slate-500" />
                {git.branch}
              </span>

              {needsPull ? (
                <span className="flex items-center gap-1 rounded-md border border-sky-400/30 bg-sky-500/10 px-2 py-1 text-[11px] font-semibold text-sky-200">
                  <GitPullRequest className="h-3 w-3 text-sky-300 motion-safe:animate-pulse" />
                  {git.behind} pull pendente
                </span>
              ) : hasLocalChanges ? (
                <span className="flex items-center gap-1 rounded-md border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-[11px] font-semibold text-amber-200">
                  <AlertCircle className="h-3 w-3 text-amber-300" />
                  {git.modifiedCount + git.untrackedCount} alterado(s)
                </span>
              ) : (
                <span className="flex items-center gap-1 rounded-md border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold text-emerald-200">
                  <Check className="h-3 w-3 text-emerald-300" />
                  Sincronizado
                </span>
              )}
            </div>
          ) : (
            <span className="ms-auto rounded-md border border-slate-600/60 bg-slate-950/25 px-2 py-1 text-[11px] font-semibold text-slate-400">Sem Git</span>
          )}
        </div>
      </div>

      {/* Action Buttons Section */}
      <div className="mt-3 space-y-3 border-t border-[var(--color-border-subtle)]/70 pt-4">
        {/* Sync & Push Git row if it is a git repo */}
        {git.isRepo && (
          <div className="flex items-center justify-between gap-2">
            {/* Sync Git (Pull) */}
            <button
              onClick={handleSync}
              disabled={isSyncing}
                className={`flex min-h-10 flex-1 min-w-0 items-center justify-center gap-1.5 rounded-xl border px-2.5 text-xs font-semibold transition-[color,background-color,border-color,box-shadow,opacity] cursor-pointer ${
                primaryAction === 'pull'
                  ? 'border-sky-400/45 bg-sky-500/20 text-sky-100 shadow-sm shadow-sky-500/15 hover:border-sky-300/70 hover:bg-sky-500/30'
                  : 'border-[var(--color-border-subtle)]/80 bg-slate-950/35 text-slate-300 hover:border-slate-600 hover:bg-slate-900/70 hover:text-white'
              }`}
              title="Executar git pull para puxar a versão mais recente do GitHub"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isSyncing ? 'motion-safe:animate-spin text-sky-400' : ''}`}
              />
              <span className="truncate">{isSyncing ? 'Puxando...' : needsPull ? 'Pull (Novo)' : 'Pull'}</span>
            </button>

            {/* Push to GitHub Button */}
            <button
              onClick={() => onOpenPushModal(project)}
                className={`flex min-h-10 flex-1 min-w-0 items-center justify-center gap-1.5 rounded-xl border px-2.5 text-xs font-semibold transition-[color,background-color,border-color,box-shadow] cursor-pointer ${
                primaryAction === 'push'
                  ? 'border-emerald-400/45 bg-emerald-500/20 text-emerald-100 shadow-sm shadow-emerald-500/15 hover:border-emerald-300/70 hover:bg-emerald-500/30'
                  : 'border-[var(--color-border-subtle)]/80 bg-slate-950/35 text-slate-400 hover:border-slate-600 hover:bg-slate-900/70 hover:text-slate-200'
              }`}
              title="Subir alterações locais para o GitHub (Commit & Push)"
            >
              <UploadCloud className="w-3.5 h-3.5 text-emerald-400" />
              <span className="truncate">
                {git.hasChanges ? 'Subir (Push)' : git.ahead > 0 ? `Push (${git.ahead})` : 'Push'}
              </span>
            </button>

            {/* Copy Context Button */}
            <button
              onClick={handleCopyContext}
              className={`flex min-h-10 items-center gap-1 rounded-xl border px-2.5 text-xs font-semibold transition-[color,background-color,border-color] shrink-0 cursor-pointer ${
                copied
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                  : 'bg-slate-950/35 text-slate-400 border-[var(--color-border-subtle)]/80 hover:bg-slate-900/70 hover:text-slate-200 hover:border-slate-600'
              }`}
              title="Copiar resumo do projeto e status do Git formatado para o ChatGPT/Codex"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-[11px]">Copiado</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span className="text-[11px]">Contexto</span>
                </>
              )}
            </button>

            {/* AI Memory Button */}
            <button
              onClick={() => onOpenMemory?.(project)}
              className="flex min-h-10 items-center gap-1 rounded-xl border border-violet-400/30 bg-violet-500/10 px-2.5 text-xs font-semibold text-violet-200 transition-[color,background-color,border-color] hover:border-violet-300/60 hover:bg-violet-500/20 shrink-0 cursor-pointer"
              title="Abrir Memória de Sessão & Handoff (.devorbit/memory.md)"
            >
              <Brain className="w-3.5 h-3.5 text-violet-400" />
              <span className="text-[11px]">Memória</span>
            </button>
          </div>
        )}

        {/* Action row for projects without Git */}
        {!git.isRepo && (
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => onOpenGitInit(project)}
              className="flex min-h-10 items-center gap-1.5 rounded-xl border border-orange-400/45 bg-orange-500/15 px-3 text-xs font-semibold text-orange-100 shadow-sm shadow-orange-500/10 transition-[color,background-color,border-color] hover:border-orange-300/70 hover:bg-orange-500/25 shrink-0 cursor-pointer"
              title="Criar um repositório Git nesta pasta e, opcionalmente, vinculá-lo a um remote"
            >
              <GitBranch className="w-3.5 h-3.5 text-orange-300" aria-hidden="true" />
              <span className="text-[11px]">Adicionar Git</span>
            </button>
            <button
              onClick={handleCopyContext}
              className={`flex min-h-10 items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition-[color,background-color,border-color] shrink-0 cursor-pointer ${
                copied
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                  : 'bg-slate-950/35 text-slate-400 border-[var(--color-border-subtle)]/80 hover:bg-slate-900/70 hover:text-slate-200 hover:border-slate-600'
              }`}
              title="Copiar resumo do projeto formatado para o ChatGPT/Codex"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-[11px]">Copiado</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span className="text-[11px]">Contexto</span>
                </>
              )}
            </button>
            <button
              onClick={() => onOpenMemory?.(project)}
              className="flex min-h-10 items-center gap-1.5 rounded-xl border border-violet-400/30 bg-violet-500/10 px-3 text-xs font-semibold text-violet-200 transition-[color,background-color,border-color] hover:border-violet-300/60 hover:bg-violet-500/20 shrink-0 cursor-pointer"
              title="Abrir Memória de Sessão & Handoff (.devorbit/memory.md)"
            >
              <Brain className="w-3.5 h-3.5 text-violet-400" />
              <span className="text-[11px]">Memória</span>
            </button>
          </div>
        )}

        {/* Row 1: AI Assistants */}
        <div className="space-y-2">
          <div className="flex items-center justify-between px-0.5 text-[11px] font-semibold text-[var(--color-text-muted)]">
            <span className="uppercase tracking-[0.1em]">Assistentes IA</span>
            <span className="text-[10px] text-slate-500">
              Conta ativa: {config?.activeChatGptAccount === 'account2' ? 'Conta 2' : 'Conta 1'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {/* Codex Desktop App */}
            <button
              onClick={() => handleLaunch('codex-desktop')}
              disabled={launchingTool === 'codex-desktop'}
              className="group/btn flex min-h-14 min-w-0 flex-col items-center justify-center rounded-xl border border-[var(--color-border-subtle)]/75 bg-slate-950/30 p-2 text-slate-300 transition-[color,background-color,border-color,transform] hover:border-emerald-400/55 hover:bg-emerald-950/20 hover:text-white cursor-pointer"
              title="Abrir no aplicativo oficial OpenAI Codex Desktop"
            >
              <Bot className="mb-1 h-4 w-4 text-emerald-300 transition-transform group-hover/btn:scale-110" />
              <span className="text-[11px] font-semibold">Codex App</span>
            </button>

            {/* Codex CLI (Multi-conta) */}
            <button
              onClick={() => handleLaunch('codex-cli')}
              disabled={launchingTool === 'codex-cli'}
              className="group/btn flex min-h-14 min-w-0 flex-col items-center justify-center rounded-xl border border-[var(--color-border-subtle)]/75 bg-slate-950/30 p-2 text-slate-300 transition-[color,background-color,border-color,transform] hover:border-teal-400/55 hover:bg-teal-950/20 hover:text-white cursor-pointer"
              title={`Abrir Codex CLI no terminal já conectado com ${config?.activeChatGptAccount === 'account2' ? 'Conta 2 (Brave)' : 'Conta 1 (Chrome)'} sem precisar deslogar!`}
            >
              <Terminal className="mb-1 h-4 w-4 text-teal-300 transition-transform group-hover/btn:scale-110" />
              <span className="text-[11px] font-semibold">
                Codex {config?.activeChatGptAccount === 'account2' ? '#2' : '#1'}
              </span>
            </button>

            {/* Antigravity CLI (Gemini) */}
            <button
              onClick={() => handleLaunch('agy')}
              disabled={launchingTool === 'agy'}
              className="group/btn flex min-h-14 min-w-0 flex-col items-center justify-center rounded-xl border border-[var(--color-border-subtle)]/75 bg-slate-950/30 p-2 text-slate-300 transition-[color,background-color,border-color,transform] hover:border-indigo-400/55 hover:bg-indigo-950/20 hover:text-white cursor-pointer"
              title="Abrir no Antigravity CLI (Gemini) no Windows Terminal"
            >
              <Sparkles className="mb-1 h-4 w-4 text-indigo-300 transition-transform group-hover/btn:scale-110" />
              <span className="text-[11px] font-semibold">Antigravity</span>
            </button>

            {/* Xiaomi MiMo AI */}
            <button
              onClick={() => handleLaunch('mimo')}
              disabled={launchingTool === 'mimo'}
              className="group/btn flex min-h-14 min-w-0 flex-col items-center justify-center rounded-xl border border-[var(--color-border-subtle)]/75 bg-slate-950/30 p-2 text-slate-300 transition-[color,background-color,border-color,transform] hover:border-orange-400/55 hover:bg-orange-950/20 hover:text-white cursor-pointer"
              title="Abrir no Xiaomi MiMo AI"
            >
              <Bot className="mb-1 h-4 w-4 text-orange-300 transition-transform group-hover/btn:scale-110" />
              <span className="text-[11px] font-semibold">MiMo AI</span>
            </button>
          </div>
        </div>

        {/* Row 2: IDEs & Browsers */}
        <div className="grid grid-cols-2 gap-2 border-t border-[var(--color-border-subtle)]/45 pt-3 sm:grid-cols-4">
          {/* VS Code */}
          <button
            onClick={() => handleLaunch('vscode')}
            disabled={launchingTool === 'vscode'}
            className="flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-[var(--color-border-subtle)]/65 bg-slate-950/20 px-2 text-[11px] font-semibold text-slate-400 transition-[color,background-color,border-color] hover:border-sky-400/45 hover:bg-sky-950/15 hover:text-sky-200"
            title="Abrir no VS Code"
          >
            <Code2 className="w-3.5 h-3.5 text-sky-400" />
            <span>VS Code</span>
          </button>

          {/* Terminal */}
          <button
            onClick={() => handleLaunch('terminal')}
            disabled={launchingTool === 'terminal'}
            className="flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-[var(--color-border-subtle)]/65 bg-slate-950/20 px-2 text-[11px] font-semibold text-slate-400 transition-[color,background-color,border-color] hover:border-violet-400/45 hover:bg-violet-950/15 hover:text-violet-200"
            title="Abrir terminal na pasta"
          >
            <Terminal className="w-3.5 h-3.5 text-purple-400" />
            <span>Terminal</span>
          </button>

          {/* Chrome (Conta 1) */}
          <button
            onClick={() => handleLaunch('chrome')}
            disabled={launchingTool === 'chrome'}
            className="flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-[var(--color-border-subtle)]/65 bg-slate-950/20 px-2 text-[11px] font-semibold text-slate-400 transition-[color,background-color,border-color] hover:border-blue-400/45 hover:bg-blue-950/15 hover:text-blue-200"
            title="Abrir ChatGPT no Google Chrome (Conta 1)"
          >
            <Globe className="w-3.5 h-3.5 text-blue-400" />
            <span>Chrome #1</span>
          </button>

          {/* Brave (Conta 2) */}
          <button
            onClick={() => handleLaunch('brave')}
            disabled={launchingTool === 'brave'}
            className="flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-[var(--color-border-subtle)]/65 bg-slate-950/20 px-2 text-[11px] font-semibold text-slate-400 transition-[color,background-color,border-color] hover:border-amber-400/45 hover:bg-amber-950/15 hover:text-amber-200"
            title="Abrir ChatGPT no Brave (Conta 2)"
          >
            <Globe className="w-3.5 h-3.5 text-amber-400" />
            <span>Brave #2</span>
          </button>
        </div>
      </div>
    </div>
  )
}
