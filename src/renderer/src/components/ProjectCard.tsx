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
  ExternalLink,
  Sparkles,
  AlertCircle,
  FolderOpen,
} from 'lucide-react'
import type { Project, AppConfig } from '../types'

interface ProjectCardProps {
  project: Project
  config: AppConfig | null
  onSync: (projectPath: string) => Promise<void>
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void
}

export const ProjectCard: React.FC<ProjectCardProps> = ({
  project,
  config,
  onSync,
  onNotify,
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
    tool: 'agy' | 'mimo' | 'brave' | 'vscode' | 'terminal' | 'folder'
  ) => {
    setLaunchingTool(tool)
    try {
      const res = await window.devorbit?.launchTool(tool, project.path, {
        account: config?.activeChatGptAccount,
      })
      if (res?.success) {
        onNotify(res.message || 'Ferramenta iniciada!', 'success')
      } else {
        onNotify(res?.message || 'Erro ao iniciar ferramenta.', 'error')
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

  return (
    <div
      className={`group relative rounded-2xl bg-gradient-to-b from-[#111624] to-[#0c101a] border transition-all duration-200 hover:shadow-xl hover:shadow-indigo-500/5 ${
        needsPull
          ? 'border-sky-500/50 hover:border-sky-400/80 shadow-sky-500/10'
          : hasLocalChanges
          ? 'border-amber-500/30 hover:border-amber-400/60'
          : 'border-slate-800/80 hover:border-slate-700'
      } p-4 flex flex-col justify-between`}
    >
      {/* Top section: Title, Parent Dir, and Git status badge */}
      <div>
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-white text-base truncate group-hover:text-indigo-300 transition-colors">
                {project.name}
              </h3>
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700/60 shrink-0">
                {project.parentDir}
              </span>
            </div>
            <p className="text-xs text-slate-500 truncate mt-0.5" title={project.path}>
              {project.path}
            </p>
          </div>

          {/* Quick folder open button */}
          <button
            onClick={() => handleLaunch('folder')}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition-colors shrink-0"
            title="Abrir no Windows Explorer"
          >
            <FolderOpen className="w-4 h-4" />
          </button>
        </div>

        {/* Tech Stack & Git Badges */}
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          {project.techs.map((tech) => (
            <span
              key={tech.id}
              className="text-[11px] font-medium px-2 py-0.5 rounded-md text-slate-200 border"
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
            <div className="flex items-center gap-1.5 ml-auto">
              <span className="flex items-center gap-1 text-[11px] text-slate-400 font-mono">
                <GitBranch className="w-3 h-3 text-slate-500" />
                {git.branch}
              </span>

              {needsPull ? (
                <span className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md bg-sky-500/15 text-sky-300 border border-sky-500/30">
                  <GitPullRequest className="w-3 h-3 text-sky-400 animate-pulse" />
                  {git.behind} pull pendente
                </span>
              ) : hasLocalChanges ? (
                <span className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/30">
                  <AlertCircle className="w-3 h-3 text-amber-400" />
                  {git.modifiedCount + git.untrackedCount} alterado(s)
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  <Check className="w-3 h-3 text-emerald-400" />
                  Sincronizado
                </span>
              )}
            </div>
          ) : (
            <span className="text-[10px] text-slate-500 ml-auto italic">Sem Git</span>
          )}
        </div>
      </div>

      {/* Action Buttons Section */}
      <div className="pt-3 border-t border-slate-800/80 mt-2 space-y-2">
        {/* Sync Git row if it is a git repo */}
        {git.isRepo && (
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={handleSync}
              disabled={isSyncing}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                needsPull
                  ? 'bg-sky-500/20 text-sky-200 border border-sky-500/40 hover:bg-sky-500/30 hover:border-sky-400 shadow-sm shadow-sky-500/20'
                  : 'bg-slate-900/90 text-slate-300 border border-slate-800 hover:border-slate-700 hover:text-white'
              }`}
              title="Executar git pull para puxar a versão mais recente do GitHub"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin text-sky-400' : ''}`}
              />
              <span>{isSyncing ? 'Puxando do GitHub...' : needsPull ? 'Atualizar com GitHub (Pull)' : 'Sync Git (Pull)'}</span>
            </button>

            {/* Copy Context Button */}
            <button
              onClick={handleCopyContext}
              className={`flex items-center gap-1 py-1.5 px-2.5 rounded-lg text-xs font-medium border transition-all ${
                copied
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                  : 'bg-slate-900/90 text-slate-400 border-slate-800 hover:text-slate-200 hover:border-slate-700'
              }`}
              title="Copiar resumo do projeto e status do Git formatado para o ChatGPT/Codex"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-[11px]">Copiado!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span className="text-[11px]">Contexto</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* AI & IDE Quick Launch Grid */}
        <div className="grid grid-cols-5 gap-1.5">
          {/* Antigravity (Gemini CLI) */}
          <button
            onClick={() => handleLaunch('agy')}
            disabled={launchingTool === 'agy'}
            className="flex flex-col items-center justify-center p-2 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-indigo-500/50 hover:bg-indigo-950/20 transition-all text-slate-300 hover:text-white group/btn cursor-pointer"
            title="Abrir no Antigravity CLI (Gemini) no Windows Terminal"
          >
            <Sparkles className="w-4 h-4 text-indigo-400 group-hover/btn:scale-110 transition-transform mb-1" />
            <span className="text-[10px] font-medium">Antigravity</span>
          </button>

          {/* Xiaomi MiMo AI */}
          <button
            onClick={() => handleLaunch('mimo')}
            disabled={launchingTool === 'mimo'}
            className="flex flex-col items-center justify-center p-2 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-orange-500/50 hover:bg-orange-950/20 transition-all text-slate-300 hover:text-white group/btn cursor-pointer"
            title="Abrir no Xiaomi MiMo AI"
          >
            <Bot className="w-4 h-4 text-orange-400 group-hover/btn:scale-110 transition-transform mb-1" />
            <span className="text-[10px] font-medium">MiMo AI</span>
          </button>

          {/* Brave (ChatGPT / Codex) */}
          <button
            onClick={() => handleLaunch('brave')}
            disabled={launchingTool === 'brave'}
            className="flex flex-col items-center justify-center p-2 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-emerald-500/50 hover:bg-emerald-950/20 transition-all text-slate-300 hover:text-white group/btn cursor-pointer"
            title={`Abrir ChatGPT/Codex no Brave (${config?.activeChatGptAccount === 'account2' ? 'Conta 2' : 'Conta 1'})`}
          >
            <Globe className="w-4 h-4 text-emerald-400 group-hover/btn:scale-110 transition-transform mb-1" />
            <span className="text-[10px] font-medium">ChatGPT</span>
          </button>

          {/* VS Code */}
          <button
            onClick={() => handleLaunch('vscode')}
            disabled={launchingTool === 'vscode'}
            className="flex flex-col items-center justify-center p-2 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-sky-500/50 hover:bg-sky-950/20 transition-all text-slate-300 hover:text-white group/btn cursor-pointer"
            title="Abrir no Visual Studio Code"
          >
            <Code2 className="w-4 h-4 text-sky-400 group-hover/btn:scale-110 transition-transform mb-1" />
            <span className="text-[10px] font-medium">VS Code</span>
          </button>

          {/* Terminal */}
          <button
            onClick={() => handleLaunch('terminal')}
            disabled={launchingTool === 'terminal'}
            className="flex flex-col items-center justify-center p-2 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-purple-500/50 hover:bg-purple-950/20 transition-all text-slate-300 hover:text-white group/btn cursor-pointer"
            title="Abrir no Windows Terminal nesta pasta"
          >
            <Terminal className="w-4 h-4 text-purple-400 group-hover/btn:scale-110 transition-transform mb-1" />
            <span className="text-[10px] font-medium">Terminal</span>
          </button>
        </div>
      </div>
    </div>
  )
}
