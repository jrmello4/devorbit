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
  Edit2,
  Check,
  Users,
  Crown,
  FolderMinus,
  FolderPlus,
  Plus,
  RefreshCw,
} from 'lucide-react'
import './CanvasInspector.css'
import type { CanvasNode, AgentProgress, NodeKind, CanvasSquad } from './WorkspaceCanvas'
import type { AgentProvider, AgentProviderId, CodexAccountId, CodexAccountStatus } from '../types'
import {
  createTerminalNodeConfig,
  resolveTerminalTheme,
  type CustomTerminalPreset,
  type TerminalNodeRuntimeConfig,
  type TerminalThemeId,
  TERMINAL_THEMES,
} from '../../../shared/terminal-presets'
import type { QuickDeployChip } from './terminal-node-helpers'
import { formatArgsInput, parseArgsInput } from './terminal-node-helpers'
import {
  agentTerminalDefaultCommand,
  BUILT_IN_AGENT_ROLES,
  codexManagedTerminalLabel,
} from './agent-creation-helpers'

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
  onSurvivorTakeover?: (squadId: string, memberId: string) => Promise<void> | void
  isTakingOver?: boolean

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
  /** Patch do terminal de um nó AGENTE (cria a config base quando ausente). */
  onUpdateAgentTerminalNode?: (
    id: string,
    updater: (current: TerminalNodeRuntimeConfig | undefined) => Partial<TerminalNodeRuntimeConfig>,
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

// Clean pass: contador do objetivo fica visível perto do limite mesmo sem foco
const OBJECTIVE_NEAR_LIMIT = 1800

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
  onSurvivorTakeover,
  isTakingOver = false,
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
  onUpdateAgentTerminalNode,
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
  const [selectedSurvivorId, setSelectedSurvivorId] = useState('')

  // Rastreamento para sincronização de objetivo e squad sem sobrescrever digitação
  const [prevSquadId, setPrevSquadId] = useState<string | null>(squad?.id ?? null)
  const [prevObjective, setPrevObjective] = useState<string | null>(squad?.objective ?? '')
  const [draftObjective, setDraftObjective] = useState<string>(squad?.objective ?? '')
  const isObjectiveDirtyRef = useRef<boolean>(false)

  // Clean pass: contadores de caracteres só aparecem com o campo em foco
  const [objectiveFieldFocused, setObjectiveFieldFocused] = useState(false)
  const [noteFieldFocused, setNoteFieldFocused] = useState(false)

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
            <span className="canvas-inspector-kind is-squad">
              <Users size={13} aria-hidden="true" />
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

        {/* Corpo da Squad — campos agrupados por espaço, sem caixas aninhadas */}
        <div className="canvas-inspector-body">
          {/* Linha de contexto: membros + recolhimento (sem título de seção) */}
          <div className="canvas-inspector-meta-row">
            <span>{squad.memberNodeIds.length} membro(s) vinculados</span>
            {(onToggleSquadCollapse || onToggleSquadCollapsed) && (
              <button
                type="button"
                className="canvas-inspector-ghost-btn"
                onClick={() => (onToggleSquadCollapse || onToggleSquadCollapsed)?.(squad.id)}
                title={squad.collapsed ? 'Expandir nós da squad no canvas' : 'Recolher nós da squad no canvas'}
              >
                {squad.collapsed ? (
                  <>
                    <FolderPlus size={12} aria-hidden="true" />
                    <span>Expandir</span>
                  </>
                ) : (
                  <>
                    <FolderMinus size={12} aria-hidden="true" />
                    <span>Recolher</span>
                  </>
                )}
              </button>
            )}
          </div>

          {/* Objetivo */}
          <div className="canvas-inspector-field">
            <label htmlFor="squad-objective-textarea">Objetivo</label>
            <textarea
              id="squad-objective-textarea"
              rows={3}
              maxLength={2000}
              value={draftObjective}
              onChange={(e) => {
                isObjectiveDirtyRef.current = true
                setDraftObjective(e.target.value)
              }}
              onFocus={() => setObjectiveFieldFocused(true)}
              onBlur={() => {
                setObjectiveFieldFocused(false)
                handleCommitSquadObjective()
              }}
              placeholder="Descreva o objetivo, critérios e limites deste squad..."
              className="canvas-inspector-textarea"
            />
            {(objectiveFieldFocused ||
              isObjectiveDirtyRef.current ||
              draftObjective.length >= OBJECTIVE_NEAR_LIMIT) && (
              <div className="canvas-inspector-char-count">
                {(objectiveFieldFocused || draftObjective.length >= OBJECTIVE_NEAR_LIMIT) && (
                  <span>{draftObjective.length}/2000 caracteres</span>
                )}
                {draftObjective !== (squad.objective ?? '') && (
                  <button
                    type="button"
                    className="canvas-inspector-save-objective"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={handleCommitSquadObjective}
                  >
                    Salvar objetivo
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Coordenador — ajuda longa virou tooltip no rótulo */}
          <div className="canvas-inspector-field">
            <label htmlFor="squad-coordinator-select" title="Lidera e dispara a orquestração; sem coordenador, os agentes operam de forma avulsa.">
              Coordenador
            </label>
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

          {/* Membros + adicionar (uma única superfície, um título) */}
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
                        <Bot size={13} className="canvas-inspector-member-icon" aria-hidden="true" />
                        <span className="canvas-inspector-member-title" title={member.title}>
                          {member.title}
                        </span>
                        <span className="canvas-inspector-member-role-text">
                          {member.role || 'Implementação'}
                        </span>
                        {isCoord && (
                          <span className="canvas-inspector-coordinator-text" title="Coordenador da squad">
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
                        {onSurvivorTakeover && (
                          <button
                            type="button"
                            className="canvas-inspector-btn-action"
                            onClick={() => onSurvivorTakeover(squad.id, member.id)}
                            title={`Sincronizar ${member.title} com o estado da squad (Takeover)`}
                            aria-label={`Sincronizar ${member.title} como sobrevivente da squad`}
                            disabled={isTakingOver}
                          >
                            <RefreshCw size={11} aria-hidden="true" className={isTakingOver ? 'animate-spin' : ''} />
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
              <p className="canvas-inspector-empty-hint canvas-inspector-restriction-hint">
                Squads exigem ao menos 1 membro ativo. O último membro não pode ser removido.
              </p>
            )}
            {onAddSquadMember && (
              <div id="inspector-add-member" className="canvas-inspector-add-member-row">
                {candidateAgentsToAdd.length > 0 ? (
                  <>
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
                  </>
                ) : (
                  <p className="canvas-inspector-empty-hint">
                    Não há outros agentes avulsos no canvas para adicionar a esta squad.
                  </p>
                )}
              </div>
            )}
            {onCreateAgentForSquad && (
              <button
                type="button"
                onClick={() => onCreateAgentForSquad(squad.id)}
                className="canvas-inspector-ghost-btn"
                title="Criar novo agente e vincular a esta squad"
                aria-label="Criar novo agente para a squad"
              >
                <Plus size={12} aria-hidden="true" />
                <span>Criar novo agente</span>
              </button>
            )}

            {squad.memberNodeIds.length > 0 && onSurvivorTakeover && (
              <div className="canvas-inspector-field" style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--ops-border, #333)' }}>
                <label htmlFor="squad-survivor-select">Sincronização de Sobrevivente (Takeover)</label>
                <p className="canvas-inspector-empty-hint">
                  Sincroniza um agente sobrevivente com o estado durável do squad, decisões e Git atual via ai-memory.
                </p>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' }}>
                  <select
                    id="squad-survivor-select"
                    aria-label="Selecionar agente sobrevivente para takeover"
                    value={
                      selectedSurvivorId ||
                      squad.memberNodeIds.find((id) => id !== squad.coordinatorNodeId) ||
                      squad.memberNodeIds[0] ||
                      ''
                    }
                    onChange={(e) => setSelectedSurvivorId(e.target.value)}
                    className="canvas-inspector-select"
                    style={{ flex: 1 }}
                  >
                    {members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.title} ({member.role || 'Implementação'})
                        {member.id === squad.coordinatorNodeId ? ' — Coordenador' : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="canvas-inspector-btn canvas-inspector-btn-primary"
                    onClick={() => {
                      const targetId =
                        selectedSurvivorId ||
                        squad.memberNodeIds.find((id) => id !== squad.coordinatorNodeId) ||
                        squad.memberNodeIds[0]
                      if (targetId) onSurvivorTakeover(squad.id, targetId)
                    }}
                    disabled={isTakingOver}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    <RefreshCw size={12} aria-hidden="true" className={isTakingOver ? 'animate-spin' : ''} />
                    <span>{isTakingOver ? 'Sincronizando...' : 'Takeover'}</span>
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
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
          <span className="canvas-inspector-kind">
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
              <label htmlFor="agent-role-input" title="Preset ou customizado">
                Papel
              </label>
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

        {/* Terminal do Agente — mesmos campos do Smart Terminal. O Codex não
            os expõe: o terminal dele é gerenciado pela conta do DevOrbit. */}
        {node.provider === 'codex' && (
          <div className="canvas-inspector-field" data-agent-terminal="managed">
            <label>Terminal</label>
            <div className="canvas-inspector-live-notice" role="note">
              <span className="canvas-inspector-live-dot" aria-hidden="true" />
              <span>{codexManagedTerminalLabel(node.account)}</span>
            </div>
          </div>
        )}
        {node.provider && node.provider !== 'codex' && onUpdateAgentTerminalNode && (
          <div className="canvas-inspector-field" data-agent-terminal="editable">
            <label>Terminal do Agente</label>
            <div className="canvas-inspector-field">
              <label htmlFor="agent-terminal-command-input">Comando</label>
              <input
                id="agent-terminal-command-input"
                type="text"
                value={node.terminal?.command || ''}
                placeholder={
                  agentTerminalDefaultCommand(node.provider) || 'ex.: meu-cli'
                }
                onChange={(e) => {
                  const val = e.target.value
                  onUpdateAgentTerminalNode(node.id, () => ({ command: val }))
                }}
                className="canvas-inspector-input"
              />
              <p className="canvas-inspector-empty-hint">
                {agentTerminalDefaultCommand(node.provider)
                  ? `Vazio inicia o CLI padrão do provedor (${agentTerminalDefaultCommand(node.provider)}) ao abrir o agente.`
                  : 'Defina o comando do CLI personalizado para iniciá-lo ao abrir o agente.'}
              </p>
            </div>
            <div className="canvas-inspector-field">
              <label htmlFor="agent-terminal-args-input">Argumentos</label>
              <input
                id="agent-terminal-args-input"
                type="text"
                value={formatArgsInput(node.terminal?.args)}
                placeholder="ex.: --port 3000"
                onChange={(e) => {
                  const parsed = parseArgsInput(e.target.value)
                  onUpdateAgentTerminalNode(node.id, () => ({ args: parsed }))
                }}
                className="canvas-inspector-input"
              />
            </div>
            <div className="canvas-inspector-field">
              <label>Executar em</label>
              <div className="canvas-inspector-radio-row">
                <label className="canvas-inspector-radio-label">
                  <input
                    type="radio"
                    name="agent-terminal-cwd-mode"
                    checked={(node.terminal?.cwdMode ?? 'workspace') === 'workspace'}
                    onChange={() =>
                      onUpdateAgentTerminalNode(node.id, () => ({
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
                    name="agent-terminal-cwd-mode"
                    checked={node.terminal?.cwdMode === 'custom'}
                    onChange={() =>
                      onUpdateAgentTerminalNode(node.id, () => ({ cwdMode: 'custom' }))
                    }
                  />
                  <span>Customizado</span>
                </label>
              </div>
              {node.terminal?.cwdMode === 'custom' && (
                <input
                  type="text"
                  value={node.terminal.cwd || ''}
                  placeholder="C:\caminho\do\diretorio"
                  onChange={(e) => {
                    const val = e.target.value
                    onUpdateAgentTerminalNode(node.id, () => ({ cwd: val }))
                  }}
                  className="canvas-inspector-input"
                  aria-label="Caminho personalizado do agente"
                />
              )}
            </div>
          </div>
        )}

            {/* Status Real de Execução — ponto + rótulo; estado detalhado no tooltip */}
            {progress && (
              <div
                className="canvas-inspector-status-box"
                data-status={progress.state}
                title={`Estado: ${progress.state}`}
              >
                <span className="canvas-inspector-status-dot" aria-hidden="true" />
                <span className="canvas-inspector-status-label">{progress.label}</span>
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
              {squad && onSurvivorTakeover && (
                <button
                  type="button"
                  className="canvas-inspector-btn"
                  onClick={() => onSurvivorTakeover(squad.id, node.id)}
                  title={`Sincronizar ${node.title} com o estado da squad ${squad.title} (Takeover)`}
                  disabled={isTakingOver}
                >
                  <RefreshCw size={13} aria-hidden="true" className={isTakingOver ? 'animate-spin' : ''} />
                  <span>{isTakingOver ? 'Sincronizando...' : 'Sincronizar Sobrevivente (Takeover)'}</span>
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
              <span className="canvas-inspector-live-dot" aria-hidden="true" />
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

                {/* Tema de Cores */}
                <div className="canvas-inspector-field">
                  <label htmlFor="terminal-theme-select">
                    Tema de cores
                    {/* Pontinho da família do tema selecionado: preview
                        imediato da cor ao lado do nome (o xterm completo muda
                        no terminal vivo via updateTheme). */}
                    <span
                      className="canvas-inspector-theme-dot"
                      style={{ backgroundColor: resolveTerminalTheme(node.terminal?.theme).accent }}
                      aria-hidden="true"
                    />
                  </label>
                  <select
                    id="terminal-theme-select"
                    aria-label="Tema de cores do terminal"
                    value={node.terminal.theme || 'carbon'}
                    onChange={(e) => {
                      const nextTheme = e.target.value as TerminalThemeId
                      onUpdateTerminalNode(node.id, () => ({ theme: nextTheme }))
                    }}
                    className="canvas-inspector-select"
                  >
                    {TERMINAL_THEMES.map((theme) => (
                      <option key={theme.id} value={theme.id}>
                        {theme.label}
                      </option>
                    ))}
                  </select>
                  <div
                    className="canvas-inspector-theme-swatches"
                    role="radiogroup"
                    aria-label="Paleta do tema do terminal"
                  >
                    {TERMINAL_THEMES.map((theme) => {
                      const isSelected = (node.terminal?.theme || 'carbon') === theme.id
                      return (
                        <button
                          key={theme.id}
                          type="button"
                          role="radio"
                          aria-checked={isSelected}
                          aria-label={`Tema ${theme.label}`}
                          title={`Tema ${theme.label}`}
                          className={`canvas-inspector-theme-swatch${isSelected ? ' is-selected' : ''}`}
                          style={{
                            backgroundColor: theme.xterm.background,
                            borderColor: theme.accent,
                          }}
                          onClick={() => {
                            onUpdateTerminalNode(node.id, () => ({ theme: theme.id }))
                          }}
                        >
                          <span
                            className="canvas-inspector-theme-swatch-dot"
                            style={{ backgroundColor: theme.accent }}
                            aria-hidden="true"
                          />
                        </button>
                      )
                    })}
                  </div>
                </div>

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
                onFocus={() => setNoteFieldFocused(true)}
                onBlur={() => setNoteFieldFocused(false)}
                className="canvas-inspector-textarea"
              />
              {/* Clean pass: estatísticas só durante a edição */}
              {noteFieldFocused && (
                <div className="canvas-inspector-char-count">
                  <span>{(node.content || '').length} caracteres</span>
                  <span>{(node.content || '').split(/\s+/).filter(Boolean).length} palavras</span>
                </div>
              )}
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
