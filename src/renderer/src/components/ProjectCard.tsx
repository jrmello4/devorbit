import React, { useState } from 'react'
import {
  AlertCircle,
  Bot,
  Check,
  ChevronRight,
  Code2,
  Copy,
  Folder,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Globe,
  Brain,
  Archive,
  Download,
  RefreshCw,
  Sparkles,
  Terminal,
  UploadCloud,
  type LucideIcon,
} from 'lucide-react'
import type { AppConfig, Project } from '../types'
import './ProjectDetail.css'

interface ProjectCardProps {
  project: Project
  config: AppConfig | null
  onSync: (projectPath: string) => Promise<void>
  onStashSync?: (projectPath: string) => Promise<void>
  onOpenPushModal: (project: Project) => void
  onOpenGitInit: (project: Project) => void
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void
  onOpenAuthModal?: (account: 'account1' | 'account2') => void
  onOpenMemory?: (project: Project) => void
  onOpenBranches?: (project: Project) => void
  onUsageUpdate?: () => void
  onRestoreProject?: (project: Project) => Promise<void>
  onFinalizeProject?: (project: Project) => Promise<void>
}

type LaunchTool =
  | 'agy'
  | 'mimo'
  | 'brave'
  | 'chrome'
  | 'codex-desktop'
  | 'codex-cli'
  | 'vscode'
  | 'terminal'
  | 'folder'

export const ProjectCard: React.FC<ProjectCardProps> = ({
  project,
  config,
  onSync,
  onStashSync,
  onOpenPushModal,
  onOpenGitInit,
  onNotify,
  onOpenAuthModal,
  onOpenMemory,
  onOpenBranches,
  onUsageUpdate,
  onRestoreProject,
  onFinalizeProject,
}) => {
  const [isSyncing, setIsSyncing] = useState(false)
  const [isStashing, setIsStashing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [launchingTool, setLaunchingTool] = useState<LaunchTool | null>(null)
  const [isLifecycleBusy, setIsLifecycleBusy] = useState(false)

  const handleSync = async () => {
    setIsSyncing(true)
    try {
      await onSync(project.path)
    } finally {
      setIsSyncing(false)
    }
  }

  const handleStashSync = async () => {
    if (!onStashSync) return
    setIsStashing(true)
    try {
      await onStashSync(project.path)
    } finally {
      setIsStashing(false)
    }
  }

  const handleLaunch = async (tool: LaunchTool) => {
    if (project.lifecycle === 'archived') {
      onNotify('Baixe o projeto antes de abrir as ferramentas.', 'info')
      return
    }
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
          onOpenAuthModal?.(
            (res.account as 'account1' | 'account2') ||
              config?.activeChatGptAccount ||
              'account1'
          )
        }
        onNotify(
          res?.message || 'Erro ao iniciar ferramenta.',
          res?.needsAuth ? 'info' : 'error'
        )
      }
    } catch (err: any) {
      onNotify('Erro: ' + err.message, 'error')
    } finally {
      setTimeout(() => setLaunchingTool(null), 600)
    }
  }

  const handleCopyContext = async () => {
    try {
      const res = await window.devorbit?.copyProjectContext(project.path)
      if (res?.success) {
        setCopied(true)
        onNotify(
          'Contexto do projeto copiado para a área de transferência!',
          'success'
        )
        onUsageUpdate?.()
        setTimeout(() => setCopied(false), 2000)
      } else {
        onNotify(res?.context || 'Falha ao copiar contexto', 'error')
      }
    } catch (err: any) {
      onNotify('Erro: ' + err.message, 'error')
    }
  }

  const { git } = project
  const isArchived = project.lifecycle === 'archived'
  const needsPull = git.isRepo && git.behind > 0
  const hasLocalChanges = git.isRepo && git.hasChanges
  const hasRemoteChanges = git.isRepo && git.ahead > 0
  const changedFiles = git.modifiedCount + git.untrackedCount
  const primaryAction = needsPull
    ? 'pull'
    : hasLocalChanges || hasRemoteChanges
      ? 'push'
      : 'pull'
  const activeAccount = config?.activeChatGptAccount || 'account1'
  const activeAccountLabel =
    activeAccount === 'account2'
      ? config?.chatGptAccount2Name || 'Conta 2'
      : config?.chatGptAccount1Name || 'Conta 1'
  const branchLabel = git.branch || 'sem branch'
  const statusDescription = isArchived
    ? 'Conteúdo local liberado; baixe o projeto quando for trabalhar nele.'
    : !git.isRepo
    ? 'Repositório Git ainda não configurado nesta pasta.'
    : git.behind > 0 && git.ahead > 0
      ? 'O branch local e o remoto divergiram.'
      : git.behind > 0
        ? 'Há commits remotos aguardando pull.'
        : git.ahead > 0
          ? 'Há commits locais aguardando push.'
          : git.hasChanges
            ? 'Existem arquivos locais fora do último commit.'
            : 'Branch local alinhado ao remoto.'

  const renderToolButton = (
    tool: LaunchTool,
    Icon: LucideIcon,
    label: string,
    detail: string,
    title: string
  ) => {
    const isLaunching = launchingTool === tool
    return (
      <button
        type="button"
        onClick={() => handleLaunch(tool)}
        disabled={isLaunching || isArchived}
        aria-busy={isLaunching}
        className="work-tool"
        title={title}
      >
        <span className="work-tool-icon" aria-hidden="true">
          <Icon />
        </span>
        <span className="work-tool-copy">
          <span className="work-tool-title">
            {isLaunching ? 'Abrindo...' : label}
          </span>
          <span className="work-tool-detail">{detail}</span>
        </span>
      </button>
    )
  }

  return (
    <article className="detail-workspace" aria-labelledby={'project-name-' + project.id}>
      <header className="detail-header">
        <div className="detail-project-mark" aria-hidden="true">
          <Folder />
        </div>

        <div className="detail-project-identity">
          <div className="detail-project-heading">
            <h2
              id={'project-name-' + project.id}
              className="detail-project-name"
              title={project.name}
            >
              {project.name}
            </h2>
            <span className="detail-parent-dir" title={'Pasta pai: ' + project.parentDir}>
              {project.parentDir}
            </span>
          </div>
          <p className="detail-project-path" title={project.path}>
            {project.path}
          </p>
          {project.techs.length > 0 && (
            <div className="detail-tech-list" aria-label="Tecnologias do projeto">
              {project.techs.map((tech) => (
                <span key={tech.id} className="detail-tech">
                  {tech.label}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="detail-header-tools">
          <button
            type="button"
            onClick={() => handleLaunch('folder')}
            disabled={launchingTool === 'folder' || isArchived}
            aria-busy={launchingTool === 'folder'}
            className="work-icon-button"
            title="Abrir a pasta no Explorador de Arquivos"
            aria-label={'Abrir ' + project.name + ' no Explorador de Arquivos'}
          >
            <FolderOpen aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onOpenMemory?.(project)}
            disabled={!onOpenMemory || isArchived}
            className="work-icon-button"
            title="Abrir memória de sessão e handoff"
            aria-label={'Abrir memória de sessão e handoff de ' + project.name}
          >
            <Brain aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="detail-status-strip" role="status" aria-live="polite">
        <div className="detail-branch-summary">
          <GitBranch aria-hidden="true" />
          <button
            type="button"
            onClick={() => onOpenBranches?.(project)}
            disabled={!git.isRepo || !onOpenBranches || isArchived}
            className="detail-branch-button"
            title="Listar e trocar branches deste repositório"
            aria-label={
              'Trocar branch de ' + project.name + '; branch atual ' + branchLabel
            }
          >
            <span className="detail-branch-caption">Branch</span>
            <strong>{branchLabel}</strong>
          </button>
        </div>

        <div className="detail-status-metrics">
          {!git.isRepo ? (
            <span className="detail-status-pill detail-status-pill-neutral">
              Sem Git
            </span>
          ) : (
            <>
              {git.behind > 0 && (
                <span className="detail-status-pill detail-status-pill-warning">
                  <GitPullRequest aria-hidden="true" />
                  {git.behind} atrás
                </span>
              )}
              {git.ahead > 0 && (
                <span className="detail-status-pill detail-status-pill-ahead">
                  <UploadCloud aria-hidden="true" />
                  {git.ahead} à frente
                </span>
              )}
              {git.hasChanges && (
                <span className="detail-status-pill detail-status-pill-changes">
                  <AlertCircle aria-hidden="true" />
                  {changedFiles > 0 ? changedFiles + ' arquivo(s)' : 'Alterações locais'}
                </span>
              )}
              {!git.behind && !git.ahead && !git.hasChanges && (
                <span className="detail-status-pill detail-status-pill-ok">
                  <Check aria-hidden="true" />
                  Sincronizado
                </span>
              )}
            </>
          )}
        </div>

        <p className="detail-status-description" title={git.statusMessage || statusDescription}>
          {git.statusMessage || statusDescription}
        </p>
      </div>

      <div className="detail-main">
        <div className="detail-primary-column">
          <section className="work-section" aria-labelledby={'workspace-actions-' + project.id}>
            <div className="work-section-heading">
              <h3 id={'workspace-actions-' + project.id}>Abrir workspace</h3>
              <span className="work-section-meta">Atalhos principais</span>
            </div>
            <div className="work-primary-actions">
              {isArchived ? (
                <button
                  type="button"
                  onClick={async () => {
                    if (!onRestoreProject || isLifecycleBusy) return
                    setIsLifecycleBusy(true)
                    try { await onRestoreProject(project) } finally { setIsLifecycleBusy(false) }
                  }}
                  disabled={!onRestoreProject || isLifecycleBusy}
                  aria-busy={isLifecycleBusy}
                  className="work-primary-action work-primary-action-accent"
                  title="Baixar a versão atual do projeto para esta pasta"
                >
                  <Download aria-hidden="true" />
                  <span className="work-action-copy">
                    <strong>{isLifecycleBusy ? 'Baixando...' : 'Baixar projeto'}</strong>
                    <small>Trazer a versão do GitHub</small>
                  </span>
                  <ChevronRight aria-hidden="true" />
                </button>
              ) : <>
              <button
                type="button"
                onClick={() => handleLaunch('vscode')}
                disabled={launchingTool === 'vscode'}
                aria-busy={launchingTool === 'vscode'}
                className="work-primary-action work-primary-action-accent"
                title="Abrir no VS Code"
              >
                <Code2 aria-hidden="true" />
                <span className="work-action-copy">
                  <strong>{launchingTool === 'vscode' ? 'Abrindo...' : 'VS Code'}</strong>
                  <small>Editor do projeto</small>
                </span>
                <ChevronRight aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => handleLaunch('terminal')}
                disabled={launchingTool === 'terminal'}
                aria-busy={launchingTool === 'terminal'}
                className="work-primary-action"
                title="Abrir terminal na pasta do projeto"
              >
                <Terminal aria-hidden="true" />
                <span className="work-action-copy">
                  <strong>{launchingTool === 'terminal' ? 'Abrindo...' : 'Terminal'}</strong>
                  <small>Executar comandos aqui</small>
                </span>
                <ChevronRight aria-hidden="true" />
              </button>
              </>}
            </div>
          </section>

          <section className="work-section" aria-labelledby={'git-actions-' + project.id}>
            <div className="work-section-heading">
              <h3 id={'git-actions-' + project.id}>Git e contexto</h3>
              <span className="work-section-meta">{git.isRepo ? branchLabel : 'Configuração pendente'}</span>
            </div>

            <div className="work-inline-actions">
              {isArchived ? (
                <p className="work-section-note">O conteúdo foi liberado do computador. O cadastro e o link do GitHub continuam disponíveis para restaurar quando quiser.</p>
              ) : git.isRepo ? (
                <>
                  <button
                    type="button"
                    onClick={handleSync}
                    disabled={isSyncing}
                    aria-busy={isSyncing}
                    className={
                      primaryAction === 'pull'
                        ? 'work-button work-button-primary'
                        : 'work-button'
                    }
                    title="Executar git pull para trazer a versão mais recente"
                  >
                    <RefreshCw className={isSyncing ? 'work-icon-spinning' : ''} aria-hidden="true" />
                    <span>{isSyncing ? 'Puxando...' : needsPull ? 'Puxar mudanças' : 'Atualizar'}</span>
                  </button>
                  {hasLocalChanges && onStashSync && (
                    <button
                      type="button"
                      onClick={handleStashSync}
                      disabled={isStashing || isSyncing}
                      aria-busy={isStashing}
                      className="work-button"
                      title="Guarda as alterações em stash, faz pull e restaura tudo"
                    >
                      <RefreshCw className={isStashing ? 'work-icon-spinning' : ''} aria-hidden="true" />
                      <span>{isStashing ? 'Sincronizando...' : 'Stash + puxar'}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onOpenPushModal(project)}
                    className={
                      primaryAction === 'push'
                        ? 'work-button work-button-primary'
                        : 'work-button'
                    }
                    title="Subir alterações locais para o GitHub"
                  >
                    <UploadCloud aria-hidden="true" />
                    <span>{git.hasChanges ? 'Enviar alterações' : git.ahead > 0 ? 'Enviar commits' : 'Push'}</span>
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => onOpenGitInit(project)}
                  className="work-button work-button-primary"
                  title="Criar um repositório Git nesta pasta"
                >
                  <GitBranch aria-hidden="true" />
                  <span>Adicionar Git</span>
                </button>
              )}

              {!isArchived && git.isRepo && onFinalizeProject && (
                <button
                  type="button"
                  onClick={async () => {
                    if (isLifecycleBusy) return
                    const confirmed = window.confirm(
                      'O DevOrbit só libera a pasta depois de confirmar que ela está limpa e sincronizada com o GitHub. A cópia local e dependências recriáveis como node_modules serão removidas; arquivos ignorados importantes bloqueiam a operação. O cadastro do projeto permanecerá. Continuar?'
                    )
                    if (!confirmed) return
                    setIsLifecycleBusy(true)
                    try { await onFinalizeProject(project) } finally { setIsLifecycleBusy(false) }
                  }}
                  disabled={isLifecycleBusy}
                  aria-busy={isLifecycleBusy}
                  className="work-button"
                  title="Remover a cópia local depois de confirmar que está sincronizada"
                >
                  <Archive aria-hidden="true" />
                  <span>{isLifecycleBusy ? 'Liberando...' : 'Finalizar e liberar espaço'}</span>
                </button>
              )}

              <button
                type="button"
                onClick={handleCopyContext}
                className={copied ? 'work-button work-button-success' : 'work-button'}
                title="Copiar resumo do projeto e status do Git"
              >
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                <span>{copied ? 'Copiado' : 'Copiar contexto'}</span>
              </button>
              <button
                type="button"
                onClick={() => onOpenMemory?.(project)}
                disabled={!onOpenMemory}
                className="work-button"
                title="Abrir Memória de Sessão e Handoff"
              >
                <Brain aria-hidden="true" />
                <span>Memória</span>
              </button>
            </div>

            <p className="work-section-note">{statusDescription}</p>
          </section>
        </div>

        <aside className="detail-tools-column">
          <section className="work-section" aria-labelledby={'ai-tools-' + project.id}>
            <div className="work-section-heading">
              <h3 id={'ai-tools-' + project.id}>Assistentes IA</h3>
              <span className="work-section-meta">{activeAccountLabel}</span>
            </div>
            <div className="work-tool-grid">
              {renderToolButton(
                'codex-desktop',
                Bot,
                'Codex App',
                'Aplicativo',
                'Abrir no aplicativo oficial OpenAI Codex Desktop'
              )}
              {renderToolButton(
                'codex-cli',
                Terminal,
                'Codex ' + (activeAccount === 'account2' ? '#2' : '#1'),
                'CLI · ' + activeAccountLabel,
                'Abrir Codex CLI no terminal conectado com ' + activeAccountLabel
              )}
              {renderToolButton(
                'agy',
                Sparkles,
                'Antigravity',
                'Gemini · CLI',
                'Abrir no Antigravity CLI (Gemini) no Windows Terminal'
              )}
              {renderToolButton(
                'mimo',
                Bot,
                'MiMo AI',
                'Xiaomi',
                'Abrir no Xiaomi MiMo AI'
              )}
            </div>
          </section>

          <section className="work-section" aria-labelledby={'browser-tools-' + project.id}>
            <div className="work-section-heading">
              <h3 id={'browser-tools-' + project.id}>Navegadores</h3>
              <span className="work-section-meta">ChatGPT por conta</span>
            </div>
            <div className="work-tool-grid">
              {renderToolButton(
                'chrome',
                Globe,
                'Chrome #1',
                'Conta 1',
                'Abrir ChatGPT no Google Chrome (Conta 1)'
              )}
              {renderToolButton(
                'brave',
                Globe,
                'Brave #2',
                'Conta 2',
                'Abrir ChatGPT no Brave (Conta 2)'
              )}
            </div>
          </section>
        </aside>
      </div>
    </article>
  )
}
