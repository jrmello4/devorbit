import React, { useState, useEffect, useRef } from 'react'
import {
  X,
  Bot,
  Terminal,
  NotebookPen,
  FileCode2,
  Globe2,
  Crosshair,
  Trash2,
  Unlink,
  Send,
  GitBranch,
  CheckCircle2,
  Edit2,
  Check,
  Users,
  Crown,
  FolderMinus,
  FolderPlus,
  Plus,
} from 'lucide-react'
import type { CanvasNode, AgentProgress, NodeKind, CanvasSquad } from './WorkspaceCanvas'
import type { AgentProvider, AgentProviderId, CodexAccountId, CodexAccountStatus } from '../types'
import {
  createTerminalNodeConfig,
  type CustomTerminalPreset,
  type TerminalNodeRuntimeConfig,
} from '../../../shared/terminal-presets'
import type { QuickDeployChip } from './terminal-node-helpers'
import { formatArgsInput, parseArgsInput } from './terminal-node-helpers'
import { BUILT_IN_AGENT_ROLES } from './agent-creation-helpers'

export interface CanvasNodeInspectorProps {
  isOpen: boolean
  onClose: () => void
  node: CanvasNode | null
  // Contrato EXATO OpenCode TASK-03C
  squad?: CanvasSquad | null
  squadMembers?: CanvasNode[]
  availableAgentsForSquad?: CanvasNode[]
  onUpdateSquadTitle?: (squadId: string, title: string) => void
  onSetSquadCoordinator?: (squadId: string, nodeId: string | null) => void
  onRemoveSquadMember?: (squadId: string, nodeId: string) => void
  onAddSquadMember?: (squadId: string, nodeId: string) => void
  onSetSquadObjective?: (squadId: string, objective: string) => void
  onToggleSquadCollapsed?: (squadId: string) => void
  onCreateAgentForSquad?: (squadId: string) => void

  // Aliases compatíveis adicionais
  onRenameSquad?: (squadId: string, title: string) => void
  onUpdateSquadObjective?: (squadId: string, objective: string) => void
  onToggleSquadCollapse?: (squadId: string) => void

  // Provedores e Autenticação
  providers?: readonly AgentProvider[]
  agentProviders?: readonly AgentProvider[]
  codexAuthStatus?: CodexAccountStatus | null
  onRequestCodexAuth?: (account: CodexAccountId) => void
  // Handlers comuns de nó
  onUpdateTitle?: (id: string, title: string) => void
  onUpdateRole?: (id: string, role: string) => void
  onUpdateProvider?: (id: string, provider: AgentProviderId) => void
  onUpdateAccount?: (id: string, account: CodexAccountId) => void
  onUpdateContent?: (id: string, content: string) => void
  onDeleteNode?: (id: string) => void
  onFocusNode?: (id: string) => void
  onDisconnectLinks?: (id: string) => void
  onSendTask?: (node: CanvasNode) => void
  onIsolateWorktree?: (node: CanvasNode) => void
  // Handlers de Terminal
  terminalPresets?: readonly CustomTerminalPreset[]
  quickDeployChips?: readonly QuickDeployChip[]
  onUpdateTerminalNode?: (
    id: string,
    updater: (current: TerminalNodeRuntimeConfig) => Partial<TerminalNodeRuntimeConfig>,
  ) => void
  progress?: AgentProgress
}

const kindLabels: Record<NodeKind, { label: string; icon: React.ReactNode }> = {
  agent: { label: 'Agente', icon: <Bot size={14} /> },
  terminal: { label: 'Terminal', icon: <Terminal size={14} /> },
  note: { label: 'Nota', icon: <NotebookPen size={14} /> },
  workbench: { label: 'Workbench', icon: <FileCode2 size={14} /> },
  browser: { label: 'Navegador', icon: <Globe2 size={14} /> },
}

export const CanvasNodeInspector: React.FC<CanvasNodeInspectorProps> = ({
  isOpen,
  onClose,
  node,
  squad,
  squadMembers = [],
  availableAgentsForSquad = [],
  onUpdateSquadTitle,
  onRenameSquad,
  onUpdateSquadObjective,
  onSetSquadObjective,
  onSetSquadCoordinator,
  onAddSquadMember,
  onRemoveSquadMember,
  onToggleSquadCollapse,
  onToggleSquadCollapsed,
  onCreateAgentForSquad,
  providers,
  agentProviders,
  codexAuthStatus,
  onRequestCodexAuth,
  onUpdateTitle,
  onUpdateRole,
  onUpdateProvider,
  onUpdateAccount,
  onUpdateContent,
  onDeleteNode,
  onFocusNode,
  onDisconnectLinks,
  onSendTask,
  onIsolateWorktree,
  quickDeployChips = [],
  onUpdateTerminalNode,
  progress,
}) => {
  // Estado para Node
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')

  // Estado para Squad
  const [activeTab, setActiveTab] = useState<'node' | 'squad'>('node')
  const [editingSquadTitle, setEditingSquadTitle] = useState(false)
  const [draftSquadTitle, setDraftSquadTitle] = useState('')
  const [selectedAgentToAdd, setSelectedAgentToAdd] = useState('')

  // Rastreamento para sincronização de objetivo e squad sem sobrescrever digitação
  const [prevSquadId, setPrevSquadId] = useState<string | null>(squad?.id ?? null)
  const [prevObjective, setPrevObjective] = useState<string | null>(squad?.objective ?? '')
  const [draftObjective, setDraftObjective] = useState<string>(squad?.objective ?? '')
  const isObjectiveDirtyRef = useRef<boolean>(false)

  // Sincronização direta de estado quando squad.id ou squad.objective mudam:
  // Padrão canônico do React para ajuste de estado baseado em props sem esperar useEffect.
  if (squad && squad.id !== prevSquadId) {
    setPrevSquadId(squad.id)
    setPrevObjective(squad.objective ?? '')
    setDraftObjective(squad.objective ?? '')
    isObjectiveDirtyRef.current = false
    setEditingSquadTitle(false)
    setDraftSquadTitle('')
    setSelectedAgentToAdd('')
  } else if (
    squad &&
    !isObjectiveDirtyRef.current &&
    (squad.objective ?? '') !== prevObjective
  ) {
    setPrevObjective(squad.objective ?? '')
    setDraftObjective(squad.objective ?? '')
  }

  const asideRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (isOpen && asideRef.current) {
      if (!document.activeElement || document.activeElement === document.body) {
        asideRef.current.focus()
      }
    }
  }, [isOpen, squad?.id, node?.id])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !editingTitle && !editingSquadTitle) {
      onClose()
    }
  }

  if (!isOpen || (!node && !squad)) {
    return null
  }

  const allProviders = providers || agentProviders || []
  const members = squadMembers ?? []
  // Filtra fora agentes que já são membros da squad para não oferecer duplicatas
  const currentMemberIds = new Set(squad?.memberNodeIds ?? members.map((m) => m.id))
  const candidateAgentsToAdd = (availableAgentsForSquad ?? []).filter(
    (agent) => !currentMemberIds.has(agent.id),
  )

  // Alterna entre visão de Squad e Nó
  const showSquadView = !node || (Boolean(squad) && activeTab === 'squad')

  // Handlers Squad
  const handleStartSquadRename = () => {
    if (!squad) return
    setDraftSquadTitle(squad.title)
    setEditingSquadTitle(true)
  }

  const handleCommitSquadRename = () => {
    if (!squad) return
    const trimmed = draftSquadTitle.trim()
    if (trimmed) {
      ;(onUpdateSquadTitle || onRenameSquad)?.(squad.id, trimmed)
    }
    setEditingSquadTitle(false)
  }

  const handleCommitSquadObjective = () => {
    if (!squad) return
    isObjectiveDirtyRef.current = false
    setPrevObjective(draftObjective.trim())
    ;(onUpdateSquadObjective || onSetSquadObjective)?.(squad.id, draftObjective.trim())
  }

  // Handlers Node
  const handleStartRename = () => {
    if (!node) return
    setDraftTitle(node.title)
    setEditingTitle(true)
  }

  const handleCommitRename = () => {
    if (!node) return
    const trimmed = draftTitle.trim()
    if (trimmed && onUpdateTitle) {
      onUpdateTitle(node.id, trimmed)
    }
    setEditingTitle(false)
  }

  // ==========================================
  // RENDERIZAÇÃO DO INSPECTOR DE SQUAD
  // ==========================================
  if (showSquadView && squad) {
    return (
      <aside
        ref={asideRef}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="canvas-node-inspector"
        role="region"
        aria-label={`Inspeção da squad ${squad.title}`}
        data-canvas-inspector=""
        onPointerDown={(e) => e.stopPropagation()}
      >
        {node && (
          <div className="canvas-inspector-tab-row" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'node'}
              className={`canvas-inspector-tab-btn ${activeTab === 'node' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('node')}
            >
              Nó ({node.title})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'squad'}
              className={`canvas-inspector-tab-btn ${activeTab === 'squad' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('squad')}
            >
              Squad ({squad.title})
            </button>
          </div>
        )}

        {/* Cabeçalho da Squad */}
        <header className="canvas-inspector-header">
          <div className="canvas-inspector-title-area">
            <span
              className="canvas-inspector-kind-badge"
              style={{ borderColor: 'rgba(234, 179, 8, 0.4)', color: '#facc15' }}
            >
              <Users size={14} aria-hidden="true" />
              <span>Squad</span>
            </span>

            {editingSquadTitle ? (
              <div className="canvas-inspector-title-edit">
                <input
                  type="text"
                  value={draftSquadTitle}
                  onChange={(e) => setDraftSquadTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCommitSquadRename()
                    else if (e.key === 'Escape') setEditingSquadTitle(false)
                  }}
                  autoFocus
                  maxLength={80}
                  aria-label="Editar nome da squad"
                  className="canvas-inspector-title-input"
                />
                <button
                  type="button"
                  className="canvas-inspector-action-icon"
                  onClick={handleCommitSquadRename}
                  aria-label="Salvar nome da squad"
                  title="Salvar"
                >
                  <Check size={13} aria-hidden="true" />
                </button>
              </div>
            ) : (
              <h3 className="canvas-inspector-title" title={squad.title}>
                {squad.title}
                {(onUpdateSquadTitle || onRenameSquad) && (
                  <button
                    type="button"
                    className="canvas-inspector-action-icon"
                    onClick={handleStartSquadRename}
                    aria-label="Renomear squad"
                    title="Renomear squad"
                  >
                    <Edit2 size={12} aria-hidden="true" />
                  </button>
                )}
              </h3>
            )}
          </div>

          <button
            type="button"
            className="canvas-inspector-close"
            onClick={onClose}
            aria-label="Fechar painel de inspeção"
            title="Fechar Inspector"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </header>

        {/* Corpo da Squad */}
        <div className="canvas-inspector-body">
          {/* Status e Recolhimento */}
          <section className="canvas-inspector-section" aria-labelledby="inspector-squad-status">
            <h4 id="inspector-squad-status" className="canvas-inspector-section-title">
              Visão Geral da Squad
            </h4>
            <div className="canvas-inspector-squad-status-row">
              <span>{squad.memberNodeIds.length} membro(s) vinculados</span>
              {(onToggleSquadCollapse || onToggleSquadCollapsed) && (
                <button
                  type="button"
                  className="canvas-inspector-toggle-btn"
                  onClick={() => (onToggleSquadCollapse || onToggleSquadCollapsed)?.(squad.id)}
                  title={squad.collapsed ? 'Expandir nós da squad no canvas' : 'Recolher nós da squad no canvas'}
                >
                  {squad.collapsed ? (
                    <>
                      <FolderPlus size={13} aria-hidden="true" />
                      <span>Expandir</span>
                    </>
                  ) : (
                    <>
                      <FolderMinus size={13} aria-hidden="true" />
                      <span>Recolher</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </section>

          {/* Objetivo da Squad */}
          <section className="canvas-inspector-section" aria-labelledby="inspector-squad-objective">
            <h4 id="inspector-squad-objective" className="canvas-inspector-section-title">
              Objetivo da Squad
            </h4>
            <div className="canvas-inspector-field">
              <label htmlFor="squad-objective-textarea">Objetivo / Metas</label>
              <textarea
                id="squad-objective-textarea"
                rows={3}
                maxLength={2000}
                value={draftObjective}
                onChange={(e) => {
                  isObjectiveDirtyRef.current = true
                  setDraftObjective(e.target.value)
                }}
                onBlur={handleCommitSquadObjective}
                placeholder="Descreva o objetivo, critérios e limites deste squad..."
                className="canvas-inspector-textarea"
              />
              <div className="canvas-inspector-char-count">
                <span>{draftObjective.length}/2000 caracteres</span>
                {draftObjective !== (squad.objective ?? '') && (
                  <button
                    type="button"
                    className="text-[11px] font-semibold text-[var(--ops-accent-strong)] hover:underline"
                    onClick={handleCommitSquadObjective}
                  >
                    Salvar objetivo
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* Coordenador da Squad */}
          <section className="canvas-inspector-section" aria-labelledby="inspector-squad-coord">
            <h4 id="inspector-squad-coord" className="canvas-inspector-section-title">
              Coordenação da Squad
            </h4>
            <div className="canvas-inspector-field">
              <label htmlFor="squad-coordinator-select">Coordenador (Opcional)</label>
              <p className="text-[11px] text-[var(--ops-text-muted)]">
                O coordenador lidera e dispara a orquestração da squad. Se omitido, os agentes operam de forma avulsa.
              </p>
              <select
                id="squad-coordinator-select"
                className="canvas-inspector-select"
                value={squad.coordinatorNodeId || ''}
                onChange={(e) => {
                  const val = e.target.value.trim()
                  onSetSquadCoordinator?.(squad.id, val ? val : null)
                }}
              >
                <option value="">— Sem coordenador (avulso) —</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.title} ({member.role || 'Especialista'})
                  </option>
                ))}
              </select>
            </div>
          </section>

          {/* Membros da Squad */}
          <section className="canvas-inspector-section" aria-labelledby="inspector-squad-members">
            <h4 id="inspector-squad-members" className="canvas-inspector-section-title">
              Membros ({members.length})
            </h4>
            <div className="canvas-inspector-squad-member-list">
              {members.length === 0 ? (
                <p className="canvas-inspector-empty-hint">Nenhum membro vinculado a esta squad.</p>
              ) : (
                members.map((member) => {
                  const isCoord = squad.coordinatorNodeId === member.id
                  const isLastMember = members.length === 1
                  return (
                    <div
                      key={member.id}
                      className={`canvas-inspector-squad-member-item ${isCoord ? 'is-coordinator' : ''}`}
                    >
                      <div className="canvas-inspector-squad-member-info">
                        <Bot size={13} className="text-[var(--ops-text-secondary)]" aria-hidden="true" />
                        <span className="canvas-inspector-member-title" title={member.title}>
                          {member.title}
                        </span>
                        <span className="canvas-inspector-role-badge">
                          {member.role || 'Implementação'}
                        </span>
                        {isCoord && (
                          <span className="canvas-inspector-coordinator-badge">
                            <Crown size={10} aria-hidden="true" /> Coordenador
                          </span>
                        )}
                      </div>

                      <div className="canvas-inspector-squad-member-actions">
                        {!isCoord && onSetSquadCoordinator && (
                          <button
                            type="button"
                            className="canvas-inspector-btn-action"
                            onClick={() => onSetSquadCoordinator(squad.id, member.id)}
                            title="Tornar coordenador"
                            aria-label={`Tornar ${member.title} coordenador`}
                          >
                            <Crown size={11} aria-hidden="true" />
                          </button>
                        )}
                        {onFocusNode && (
                          <button
                            type="button"
                            className="canvas-inspector-btn-action"
                            onClick={() => onFocusNode(member.id)}
                            title="Focar no canvas"
                            aria-label={`Focar ${member.title}`}
                          >
                            <Crosshair size={11} aria-hidden="true" />
                          </button>
                        )}
                        {onRemoveSquadMember && (
                          <button
                            type="button"
                            className="canvas-inspector-btn-action canvas-inspector-btn-action-danger"
                            onClick={() => {
                              if (!isLastMember) {
                                onRemoveSquadMember(squad.id, member.id)
                              }
                            }}
                            disabled={isLastMember}
                            title={
                              isLastMember
                                ? 'A squad requer ao menos 1 membro ativo. O último membro não pode ser removido.'
                                : 'Remover da squad'
                            }
                            aria-label={
                              isLastMember
                                ? `Não é possível remover ${member.title}: a squad requer ao menos 1 membro ativo`
                                : `Remover ${member.title} da squad`
                            }
                          >
                            <Trash2 size={11} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
            {members.length === 1 && (
              <p
                className="canvas-inspector-empty-hint canvas-inspector-restriction-hint"
                style={{ marginTop: '8px' }}
              >
                Squads exigem ao menos 1 membro ativo. O último membro não pode ser removido.
              </p>
            )}
          </section>

          {/* Adicionar Membro */}
          {onAddSquadMember && (
            <section className="canvas-inspector-section" aria-labelledby="inspector-add-member">
              <h4 id="inspector-add-member" className="canvas-inspector-section-title">
                Adicionar Membro à Squad
              </h4>
              {candidateAgentsToAdd.length > 0 ? (
                <div className="canvas-inspector-add-member-row">
                  <select
                    aria-label="Selecionar agente para adicionar à squad"
                    className="canvas-inspector-select"
                    value={selectedAgentToAdd}
                    onChange={(e) => setSelectedAgentToAdd(e.target.value)}
                  >
                    <option value="">Escolha um agente do canvas...</option>
                    {candidateAgentsToAdd.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.title} ({agent.role || 'Agente'})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!selectedAgentToAdd}
                    onClick={() => {
                      if (selectedAgentToAdd) {
                        onAddSquadMember(squad.id, selectedAgentToAdd)
                        setSelectedAgentToAdd('')
                      }
                    }}
                    className="canvas-inspector-btn-primary"
                  >
                    <Plus size={13} aria-hidden="true" />
                    <span>Adicionar</span>
                  </button>
                </div>
              ) : (
                <p className="canvas-inspector-empty-hint">
                  Não há outros agentes avulsos no canvas para adicionar a esta squad.
                </p>
              )}
              {onCreateAgentForSquad && (
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={() => onCreateAgentForSquad(squad.id)}
                    className="canvas-inspector-btn-action"
                    title="Criar novo agente e vincular a esta squad"
                    aria-label="Criar novo agente para a squad"
                  >
                    <Plus size={12} aria-hidden="true" />
                    <span>Criar novo agente para a squad</span>
                  </button>
                </div>
              )}
            </section>
          )}
        </div>

        {/* Rodapé da Squad */}
        <footer className="canvas-inspector-footer">
          <button
            type="button"
            className="canvas-inspector-footer-btn"
            onClick={onClose}
            title="Fechar Inspector"
          >
            <span>Fechar</span>
          </button>
        </footer>
      </aside>
    )
  }

  // Se chegou aqui, node existe
  if (!node) return null

  // ==========================================
  // RENDERIZAÇÃO DO INSPECTOR DE NÓ INDIVIDUAL
  // ==========================================
  return (
    <aside
      ref={asideRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="canvas-node-inspector"
      role="region"
      aria-label={`Inspeção de ${node.title}`}
      data-canvas-inspector=""
      onPointerDown={(e) => e.stopPropagation()}
    >
      {squad && (
        <div className="canvas-inspector-tab-row" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'node'}
            className={`canvas-inspector-tab-btn ${activeTab === 'node' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('node')}
          >
            Nó ({node.title})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'squad'}
            className={`canvas-inspector-tab-btn ${activeTab === 'squad' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('squad')}
          >
            Squad ({squad.title})
          </button>
        </div>
      )}

      {/* Cabeçalho do Inspector */}
      <header className="canvas-inspector-header">
        <div className="canvas-inspector-title-area">
          <span className="canvas-inspector-kind-badge">
            {kindLabels[node.kind]?.icon}
            <span>{kindLabels[node.kind]?.label}</span>
          </span>

          {editingTitle ? (
            <div className="canvas-inspector-title-edit">
              <input
                type="text"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCommitRename()
                  else if (e.key === 'Escape') setEditingTitle(false)
                }}
                autoFocus
                maxLength={80}
                aria-label="Editar nome"
                className="canvas-inspector-title-input"
              />
              <button
                type="button"
                className="canvas-inspector-action-icon"
                onClick={handleCommitRename}
                aria-label="Salvar nome"
                title="Salvar"
              >
                <Check size={13} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <h3 className="canvas-inspector-title" title={node.title}>
              {node.title}
              <button
                type="button"
                className="canvas-inspector-action-icon"
                onClick={handleStartRename}
                aria-label="Renomear"
                title="Renomear"
              >
                <Edit2 size={12} aria-hidden="true" />
              </button>
            </h3>
          )}
        </div>

        <button
          type="button"
          className="canvas-inspector-close"
          onClick={onClose}
          aria-label="Fechar painel de inspeção"
          title="Fechar Inspector"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      {/* Conteúdo Contextual do Inspector */}
      <div className="canvas-inspector-body">
        {/* SESSÃO DE AGENTE */}
        {node.kind === 'agent' && (
          <section className="canvas-inspector-section" aria-labelledby="inspector-agent-settings">
            <h4 id="inspector-agent-settings" className="canvas-inspector-section-title">
              Configuração do Agente
            </h4>

            {/* Papel Customizável */}
            <div className="canvas-inspector-field">
              <label htmlFor="agent-role-input">Papel (preset ou customizado)</label>
              <input
                id="agent-role-input"
                list="inspector-builtin-roles"
                value={node.role || 'Implementação'}
                onChange={(e) => onUpdateRole?.(node.id, e.target.value)}
                placeholder="ex.: Coordenador, Backend, UX, Testes..."
                maxLength={40}
                className="canvas-inspector-input"
              />
              <datalist id="inspector-builtin-roles">
                {BUILT_IN_AGENT_ROLES.map((role) => (
                  <option key={role} value={role} />
                ))}
              </datalist>
            </div>

            {/* Provedor */}
            <div className="canvas-inspector-field">
              <label htmlFor="agent-provider-select">Provedor IA</label>
              <select
                id="agent-provider-select"
                value={node.provider || ''}
                onChange={(e) => onUpdateProvider?.(node.id, e.target.value as AgentProviderId)}
                className="canvas-inspector-select"
              >
                <option value="">— Nenhum —</option>
                {allProviders.map((p) => (
                  <option key={p.id} value={p.id} disabled={p.state !== 'ready'}>
                    {p.label} {p.state !== 'ready' ? '(indisponível)' : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Conta Codex (se aplicável) */}
            {node.provider === 'codex' && (
              <div className="canvas-inspector-field">
                <label htmlFor="agent-account-select">Conta Codex</label>
                <select
                  id="agent-account-select"
                  value={node.account || ''}
                  onChange={(e) => onUpdateAccount?.(node.id, e.target.value as CodexAccountId)}
                  className="canvas-inspector-select"
                >
                  <option value="">— Nenhuma conta —</option>
                  <option value="account1">
                    Conta 1 {codexAuthStatus?.account1?.connected ? '(pronta)' : '(desconectada)'}
                  </option>
                  <option value="account2">
                    Conta 2 {codexAuthStatus?.account2?.connected ? '(pronta)' : '(desconectada)'}
                  </option>
                </select>
                {node.account && !codexAuthStatus?.[node.account]?.connected && onRequestCodexAuth && (
                  <button
                    type="button"
                    className="canvas-inspector-auth-link"
                    onClick={() => onRequestCodexAuth(node.account as CodexAccountId)}
                  >
                    Conectar conta agora
                  </button>
                )}
              </div>
            )}

            {/* Status Real de Execução */}
            {progress && (
              <div className="canvas-inspector-status-box" data-status={progress.state}>
                <span className="canvas-inspector-status-dot" aria-hidden="true" />
                <div className="canvas-inspector-status-meta">
                  <span className="canvas-inspector-status-label">{progress.label}</span>
                  <span className="canvas-inspector-status-sub">Estado: {progress.state}</span>
                </div>
              </div>
            )}

            {/* Ações Especiais de Agente */}
            <div className="canvas-inspector-agent-actions">
              {onSendTask && (
                <button
                  type="button"
                  className="canvas-inspector-btn canvas-inspector-btn-primary"
                  onClick={() => onSendTask(node)}
                >
                  <Send size={13} aria-hidden="true" />
                  <span>Enviar Tarefa ao Agente</span>
                </button>
              )}
              {onIsolateWorktree && (
                <button
                  type="button"
                  className="canvas-inspector-btn"
                  onClick={() => onIsolateWorktree(node)}
                  title="Criar worktree git isolado para este agente"
                >
                  <GitBranch size={13} aria-hidden="true" />
                  <span>Isolar em Worktree Git</span>
                </button>
              )}
            </div>
          </section>
        )}

        {/* SESSÃO DE TERMINAL */}
        {node.kind === 'terminal' && (
          <section className="canvas-inspector-section" aria-labelledby="inspector-terminal-settings">
            <h4 id="inspector-terminal-settings" className="canvas-inspector-section-title">
              Configuração do Terminal
            </h4>
            <div className="canvas-inspector-live-notice" role="status">
              <CheckCircle2 size={13} aria-hidden="true" />
              <span>Sessão PTY permanece viva no card do canvas.</span>
            </div>

            {node.terminal && onUpdateTerminalNode && (
              <>
                {/* Preset */}
                {quickDeployChips.length > 0 && (
                  <div className="canvas-inspector-field">
                    <label htmlFor="terminal-preset-select">Preset</label>
                    <select
                      id="terminal-preset-select"
                      value={node.terminal.presetId || ''}
                      onChange={(e) => {
                        const chip = quickDeployChips.find((c) => c.id === e.target.value)
                        if (chip) {
                          onUpdateTerminalNode(node.id, (current) => {
                            const next = createTerminalNodeConfig(chip.preset)
                            return {
                              ...next,
                              cwdMode: current.cwdMode,
                              ...(current.cwdMode === 'custom' && current.cwd ? { cwd: current.cwd } : {}),
                            }
                          })
                        }
                      }}
                      className="canvas-inspector-select"
                    >
                      {quickDeployChips.map((chip) => (
                        <option key={chip.id} value={chip.id}>
                          {chip.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Comando */}
                <div className="canvas-inspector-field">
                  <label htmlFor="terminal-command-input">Comando</label>
                  <input
                    id="terminal-command-input"
                    type="text"
                    value={node.terminal.command || ''}
                    placeholder="ex.: npm run dev"
                    onChange={(e) => {
                      const val = e.target.value
                      onUpdateTerminalNode(node.id, () => ({ command: val }))
                    }}
                    className="canvas-inspector-input"
                  />
                </div>

                {/* Argumentos */}
                <div className="canvas-inspector-field">
                  <label htmlFor="terminal-args-input">Argumentos</label>
                  <input
                    id="terminal-args-input"
                    type="text"
                    value={formatArgsInput(node.terminal.args)}
                    placeholder="ex.: --port 3000"
                    onChange={(e) => {
                      const parsed = parseArgsInput(e.target.value)
                      onUpdateTerminalNode(node.id, () => ({ args: parsed }))
                    }}
                    className="canvas-inspector-input"
                  />
                </div>

                {/* Diretório CWD */}
                <div className="canvas-inspector-field">
                  <label>Executar em</label>
                  <div className="canvas-inspector-radio-row">
                    <label className="canvas-inspector-radio-label">
                      <input
                        type="radio"
                        name="terminal-cwd-mode"
                        checked={node.terminal.cwdMode === 'workspace'}
                        onChange={() =>
                          onUpdateTerminalNode(node.id, () => ({
                            cwdMode: 'workspace',
                            cwd: undefined,
                          }))
                        }
                      />
                      <span>Workspace</span>
                    </label>
                    <label className="canvas-inspector-radio-label">
                      <input
                        type="radio"
                        name="terminal-cwd-mode"
                        checked={node.terminal.cwdMode === 'custom'}
                        onChange={() =>
                          onUpdateTerminalNode(node.id, () => ({ cwdMode: 'custom' }))
                        }
                      />
                      <span>Customizado</span>
                    </label>
                  </div>
                  {node.terminal.cwdMode === 'custom' && (
                    <input
                      type="text"
                      value={node.terminal.cwd || ''}
                      placeholder="C:\caminho\do\diretorio"
                      onChange={(e) => {
                        const val = e.target.value
                        onUpdateTerminalNode(node.id, () => ({ cwd: val }))
                      }}
                      className="canvas-inspector-input"
                      aria-label="Caminho personalizado"
                    />
                  )}
                </div>

                {/* Comportamento de Reinício */}
                <div className="canvas-inspector-field">
                  <label htmlFor="terminal-restart-behavior">Ao Reiniciar</label>
                  <select
                    id="terminal-restart-behavior"
                    value={node.terminal.restartBehavior || 'restart'}
                    onChange={(e) =>
                      onUpdateTerminalNode(node.id, () => ({
                        restartBehavior: e.target.value as TerminalNodeRuntimeConfig['restartBehavior'],
                      }))
                    }
                    className="canvas-inspector-select"
                  >
                    <option value="restart">Relançar processo</option>
                    <option value="resume">Retomar sessão</option>
                    <option value="shell">Shell interativo</option>
                  </select>
                </div>
              </>
            )}
          </section>
        )}

        {/* SESSÃO DE NOTA */}
        {node.kind === 'note' && (
          <section className="canvas-inspector-section" aria-labelledby="inspector-note-settings">
            <h4 id="inspector-note-settings" className="canvas-inspector-section-title">
              Conteúdo da Nota
            </h4>
            <div className="canvas-inspector-field">
              <label htmlFor="note-content-editor">Texto Markdown / Instruções</label>
              <textarea
                id="note-content-editor"
                value={node.content || ''}
                rows={10}
                placeholder="Escreva anotações ou plano para a squad..."
                onChange={(e) => onUpdateContent?.(node.id, e.target.value)}
                className="canvas-inspector-textarea"
              />
              <div className="canvas-inspector-char-count">
                <span>{(node.content || '').length} caracteres</span>
                <span>{(node.content || '').split(/\s+/).filter(Boolean).length} palavras</span>
              </div>
            </div>
          </section>
        )}
      </div>

      {/* Rodapé com Ações Gerais */}
      <footer className="canvas-inspector-footer">
        {onFocusNode && (
          <button
            type="button"
            className="canvas-inspector-footer-btn"
            onClick={() => onFocusNode(node.id)}
            aria-label={`Centralizar câmera em ${node.title}`}
            title="Centralizar câmera"
          >
            <Crosshair size={13} aria-hidden="true" />
            <span>Focar</span>
          </button>
        )}

        {onDisconnectLinks && (
          <button
            type="button"
            className="canvas-inspector-footer-btn"
            onClick={() => onDisconnectLinks(node.id)}
            aria-label={`Desconectar conexões de ${node.title}`}
            title="Desconectar conexões"
          >
            <Unlink size={13} aria-hidden="true" />
            <span>Desconectar</span>
          </button>
        )}

        {onDeleteNode && node.kind !== 'workbench' && node.kind !== 'browser' && (
          <button
            type="button"
            className="canvas-inspector-footer-btn canvas-inspector-footer-btn-danger"
            onClick={() => {
              onDeleteNode(node.id)
              onClose()
            }}
            aria-label={`Excluir ${node.title}`}
            title="Excluir este nó"
          >
            <Trash2 size={13} aria-hidden="true" />
            <span>Excluir</span>
          </button>
        )}
      </footer>
    </aside>
  )
}
