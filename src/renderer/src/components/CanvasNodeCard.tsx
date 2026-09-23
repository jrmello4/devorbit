import React, { useState, useCallback } from 'react'
import {
  Crown,
  Settings,
  Settings2,
  ChevronDown,
  ChevronRight,
  X,
  Unlink,
  Terminal,
  Trash2,
  Edit2,
  Check,
  GripVertical,
  Send,
  Crosshair,
  Minimize2,
  Maximize2,
  SlidersHorizontal,
  Bot,
  NotebookPen,
} from 'lucide-react'
import type { AgentRole, CanvasNode, NodeKind, AgentProgress } from './WorkspaceCanvas'
import type { AgentProvider, AgentProviderId, CodexAccountId } from '../types'
import type {
  CustomTerminalPreset,
  TerminalNodeRuntimeConfig,
} from '../../../shared/terminal-presets'
import {
  CUSTOM_TERMINAL_PRESET_LIMIT,
  createTerminalNodeConfig,
  resolveTerminalTheme,
  TERMINAL_THEMES,
  type TerminalThemeId,
} from '../../../shared/terminal-presets'
import {
  formatArgsInput,
  isCustomTerminalPresetId,
  isTerminalCommandTextRejected,
  TERMINAL_COMMAND_INVALID_HINT,
  type QuickDeployChip,
} from './terminal-node-helpers'
import {
  isAgentNodeConfigured,
  agentNodeSetupMessage,
} from './agent-creation-helpers'
import { handleCanvasCardKeyboardAction } from './canvas-keyboard-helpers'

export interface CanvasNodeCardProps {
  node: CanvasNode
  isSelected: boolean
  isConnecting: boolean
  isConnectionTargetAvailable: boolean
  isConfigOpen: boolean
  progress?: AgentProgress
  agentProviders?: readonly AgentProvider[]
  quickDeployChips: readonly QuickDeployChip[]
  terminalPresets: readonly CustomTerminalPreset[]
  terminalDraft: { nodeId: string; command: string; args: string; cwd: string } | null
  terminalCommandHint: string
  presetDraftName: string
  presetSaveStatus: string
  nodeMeta: Record<NodeKind, { label: string; meta: string; icon: React.ReactNode }>
  spaceHeld?: boolean
  isSendDisabled?: boolean
  sendTitle?: string
  // Extensões de Compactação, Foco e Inspector
  isCompact?: boolean
  onToggleCompact?: (nodeId: string) => void
  onOpenInspector?: (node: CanvasNode) => void
  isFocused?: boolean
  isDimmed?: boolean
  isSquadCoordinator?: boolean
  isCoordinator?: boolean
  // Handlers
  onSelect: (id: string, multi: boolean) => void
  onStartPan: (event: React.PointerEvent<HTMLElement>) => void
  onStartNodeDrag: (event: React.PointerEvent<HTMLElement>, node: CanvasNode) => void
  onStartResize: (event: React.PointerEvent<HTMLElement>, node: CanvasNode) => void
  onStartConnection: (event: React.PointerEvent<HTMLButtonElement>, node: CanvasNode) => void
  onChooseConnectionSource: (id: string) => void
  onConnectNodes: (to: string) => void
  onDeleteNode: (id: string) => void
  onToggleConfig: (id: string) => void
  onDisconnectLinks: (id: string) => void
  onFocusNode: (id: string) => void
  onUpdateGeometry: (id: string, geometry: Partial<CanvasNode>) => void
  onUpdateTitle: (id: string, title: string) => void
  onUpdateRole?: (id: string, role: AgentRole) => void
  onUpdateProvider?: (id: string, provider: AgentProviderId) => void
  onUpdateAccount?: (id: string, account: CodexAccountId) => void
  onUpdateContent: (id: string, content: string) => void
  onSendTask: (node: CanvasNode) => void
  onIsolateWorktree?: (node: CanvasNode) => void
  onUpdateTerminalNode: (
    id: string,
    updater: (current: TerminalNodeRuntimeConfig) => Partial<TerminalNodeRuntimeConfig>,
  ) => void
  onSetTerminalDraftField: (
    nodeId: string,
    field: 'command' | 'args' | 'cwd',
    value: string,
  ) => void
  onCommitTerminalFields: (node: CanvasNode) => void
  onSetTerminalDraft: (draft: null) => void
  onSetTerminalCommandHint: (hint: string) => void
  onSetPresetDraftName: (name: string) => void
  onSetPresetSaveStatus: (status: string) => void
  onSavePreset: (node: CanvasNode) => void
  onRenameCustomPreset: (presetId: string, newName: string) => void
  onDeleteCustomPreset: (presetId: string) => void
  // Content rendering
  workbench?: React.ReactNode
  browser?: React.ReactNode
  renderAgent?: (node: CanvasNode) => React.ReactNode
  renderTerminal?: (node: CanvasNode) => React.ReactNode
}

function closestElement(element: EventTarget | null, selector: string): Element | null {
  if (!(element instanceof Element)) return null
  return element.closest(selector)
}

function terminalMetaLabel(node: CanvasNode): string {
  const presetId = node.terminal?.presetId
  if (!presetId) return 'TERMINAL'
  return isCustomTerminalPresetId(presetId) ? 'SMART · CUSTOM' : `SMART · ${presetId.toUpperCase()}`
}

export const CanvasNodeCard: React.FC<CanvasNodeCardProps> = React.memo(
  function CanvasNodeCard({
    node,
    isSelected,
    isConnecting,
    isConnectionTargetAvailable,
    isConfigOpen,
    progress,
    agentProviders,
    quickDeployChips,
    terminalPresets,
    terminalDraft,
    terminalCommandHint,
    presetDraftName,
    presetSaveStatus,
    nodeMeta,
    spaceHeld,
    isSendDisabled,
    sendTitle,
    isCompact,
    onToggleCompact,
    onOpenInspector,
    isFocused = false,
    isDimmed = false,
    isSquadCoordinator,
    isCoordinator,
    onSelect,
    onStartPan,
    onStartNodeDrag,
    onStartResize,
    onStartConnection,
    onChooseConnectionSource,
    onConnectNodes,
    onDeleteNode,
    onToggleConfig,
    onDisconnectLinks,
    onFocusNode,
    onUpdateGeometry,
    onUpdateTitle,
    onUpdateRole: _onUpdateRole,
    onUpdateProvider: _onUpdateProvider,
    onUpdateAccount: _onUpdateAccount,
    onUpdateContent,
    onSendTask,
    onIsolateWorktree,
    onUpdateTerminalNode,
    onSetTerminalDraftField,
    onCommitTerminalFields,
    onSetTerminalDraft,
    onSetTerminalCommandHint,
    onSetPresetDraftName,
    onSetPresetSaveStatus,
    onSavePreset,
    onRenameCustomPreset,
    onDeleteCustomPreset,
    workbench,
    browser,
    renderAgent,
    renderTerminal,
  }) {
    const [renamingCustomPreset, setRenamingCustomPreset] = useState(false)
    const [renameDraft, setRenameDraft] = useState('')
    const [localCompact, setLocalCompact] = useState<boolean>(() => {
      return node.kind === 'agent' || node.kind === 'terminal'
    })

    // O coordenador da squad prevalece sobre o texto do papel
    const isActualCoordinator =
      typeof isSquadCoordinator === 'boolean'
        ? isSquadCoordinator
        : (isCoordinator ?? (node.role === 'Coordenador'))

    // O estado compacto pode vir de fora ou ser gerenciado localmente
    const effectiveCompact = typeof isCompact === 'boolean' ? isCompact : localCompact
    const isCompactCard =
      effectiveCompact &&
      (node.kind === 'agent' || node.kind === 'terminal' || node.kind === 'note')

    // Tarefa real do agente: prioriza progress.label (estado ativo/etapa atual),
    // seguido por node.content quando confiável, ou fallback amigável.
    const agentTaskText =
      progress?.label?.trim() ||
      (node.content?.trim() ? node.content.trim() : 'Aguardando atribuição de tarefa...')

    // Comando do terminal formatado para resumo
    const terminalArgsFormatted = Array.isArray(node.terminal?.args)
      ? formatArgsInput(node.terminal.args)
      : typeof (node.terminal?.args as unknown) === 'string'
        ? (node.terminal?.args as unknown as string)
        : ''
    const terminalCommandText =
      node.terminal?.command?.trim()
        ? `${node.terminal.command} ${terminalArgsFormatted}`.trim()
        : 'Shell interativo'

    const toggleCompactMode = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation()
        if (onToggleCompact) {
          onToggleCompact(node.id)
        } else {
          setLocalCompact((c) => !c)
        }
      },
      [node.id, onToggleCompact],
    )

    const currentPresetId = node.terminal?.presetId || ''
    const isCustomPreset = isCustomTerminalPresetId(currentPresetId)
    const customPresetObj = isCustomPreset
      ? terminalPresets.find((p) => p.id === currentPresetId)
      : undefined

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLElement>) => {
        if (event.target === event.currentTarget) {
          const kb = handleCanvasCardKeyboardAction(event, node)
          if (kb) {
            event.preventDefault()
            onUpdateGeometry(node.id, kb.updated)
            return
          }
          if (event.key === 'Enter' || event.key === ' ') {
            onSelect(node.id, event.ctrlKey || event.metaKey)
          } else if (event.key.toLowerCase() === 'c') {
            event.preventDefault()
            onChooseConnectionSource(node.id)
          }
        }
      },
      [node, onChooseConnectionSource, onSelect, onUpdateGeometry],
    )

    const terminalTheme = node.kind === 'terminal' ? resolveTerminalTheme(node.terminal?.theme) : undefined

    const cardClasses = [
      'workspace-canvas-card',
      'canvas-' + node.kind,
      isSelected ? 'is-selected' : '',
      isConnecting ? 'is-connecting' : '',
      isCompactCard ? 'is-compact' : '',
      isConfigOpen ? 'has-config-open' : '',
      isFocused ? 'is-focused-node' : '',
      isDimmed ? 'is-dimmed' : '',
      progress ? 'has-agent-progress progress-' + progress.state : '',
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <section
        tabIndex={0}
        role="region"
        aria-label={`${node.title} (${node.kind === 'agent' ? node.role : node.kind})${effectiveCompact ? ' [recolhido]' : ''}`}
        aria-roledescription="cartão do canvas"
        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowRight Shift+ArrowDown Alt+ArrowRight Alt+ArrowDown"
        title={`${node.title} · Mover: Setas · Redimensionar: Alt+Setas`}
        className={cardClasses}
        data-canvas-card={node.kind}
        data-canvas-node-id={node.id}
        data-is-compact={effectiveCompact ? 'true' : 'false'}
        data-terminal-theme={node.kind === 'terminal' ? (terminalTheme?.id || 'carbon') : undefined}
        style={{
          left: node.x,
          top: node.y,
          width: isCompactCard ? 320 : node.width,
          height: isCompactCard ? 130 : node.height,
          zIndex: node.z,
          ...(terminalTheme
            ? ({
                '--term-accent': terminalTheme.accent,
                '--term-bg': terminalTheme.xterm.background,
              } as React.CSSProperties)
            : {}),
        }}
        onPointerDown={(event) => {
          if (event.button === 1 || spaceHeld) {
            onStartPan(event)
            return
          }
          event.stopPropagation()
          onSelect(node.id, event.ctrlKey || event.metaKey)
        }}
        onKeyDown={handleKeyDown}
      >
        {/* Porta de Conexão de Saída (Source) */}
        <button
          type="button"
          className={'canvas-port canvas-port-source' + (isConnecting ? ' is-active' : '')}
          data-canvas-port="source"
          data-canvas-node-id={node.id}
          aria-label={'Iniciar conexão a partir de ' + node.title}
          aria-pressed={isConnecting}
          onPointerDown={(event) => onStartConnection(event, node)}
          onClick={() => onChooseConnectionSource(node.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onChooseConnectionSource(node.id)
            }
          }}
        >
          <span aria-hidden="true" />
        </button>

        {/* Porta de Conexão de Entrada (Target) */}
        <button
          type="button"
          className={'canvas-port canvas-port-target' + (isConnectionTargetAvailable ? ' is-available' : '')}
          data-canvas-port="target"
          data-canvas-node-id={node.id}
          aria-label={'Conectar a ' + node.title}
          disabled={!isConnectionTargetAvailable}
          onPointerDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={() => onConnectNodes(node.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onConnectNodes(node.id)
            }
          }}
        >
          <span aria-hidden="true" />
        </button>

        {/* Cabeçalho do Card */}
        <header
          className="canvas-card-header"
          onPointerDown={(event) => {
            const target = event.target
            if (closestElement(target, 'button:not([data-canvas-drag-handle]), input, select, textarea, a, [contenteditable=true]')) return
            onStartNodeDrag(event, node)
          }}
        >
          <strong className="canvas-card-title">
            {nodeMeta[node.kind]?.icon || (node.kind === 'agent' ? <Bot size={13} /> : <Terminal size={13} />)}
            <span className="canvas-card-title-text">{node.title}</span>
          </strong>

          <button
            data-canvas-drag-handle=""
            type="button"
            className="canvas-card-drag-handle"
            aria-label={'Mover ' + node.title}
            title="Arraste para mover o cartão"
            onPointerDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onStartNodeDrag(event, node)
            }}
          >
            <GripVertical size={13} aria-hidden="true" />
          </button>

          {/* Badges de Identificação por Tipo */}
          {node.kind === 'agent' && (
            <>
              <span className="canvas-node-meta canvas-role-pill">
                {node.role || 'Implementação'}
              </span>
              {isActualCoordinator && (
                <span className="canvas-command-mark" role="img" aria-label="Coordenador" title="Coordenador da squad">
                  <Crown size={11} aria-hidden="true" className="canvas-icon-gold" />
                </span>
              )}
              {node.provider && (
                <span className="canvas-node-meta canvas-provider-pill" title={`Provedor: ${node.provider}`}>
                  {node.provider.toUpperCase()}
                  {node.account ? ` (${node.account === 'account1' ? 'C1' : 'C2'})` : ''}
                </span>
              )}
            </>
          )}

          {node.kind === 'terminal' && (
            <span className="canvas-node-meta canvas-terminal-pill">
              {terminalMetaLabel(node)}
            </span>
          )}

          {node.kind === 'note' && (
            <span className="canvas-node-meta canvas-note-pill">
              {(node.content || '').length} car.
            </span>
          )}

          {/* Status real do agente (sem animação permanente pesada) */}
          {node.kind === 'agent' && progress && (
            <span
              className={'canvas-agent-progress progress-' + progress.state}
              data-agent-progress={progress.state}
              role="status"
              aria-label={'Status: ' + progress.label}
              title={progress.label}
            >
              <i aria-hidden="true" />
              <span>{progress.label}</span>
            </span>
          )}

          {/* Ações do Cabeçalho */}
          <div className="canvas-card-actions">
            {/* Executar Tarefa do Agente */}
            {node.kind === 'agent' && isAgentNodeConfigured(node, agentProviders ?? []) && (
              <button
                type="button"
                className="canvas-card-action-btn canvas-card-action-run canvas-send-task"
                data-agent-send=""
                aria-label={'Enviar tarefa para ' + node.title}
                title={
                  sendTitle ||
                  (isActualCoordinator
                    ? 'Iniciar orquestração com as notas conectadas'
                    : 'Enviar as notas conectadas ao agente')
                }
                disabled={isSendDisabled}
                onClick={(event) => {
                  event.stopPropagation()
                  onSendTask(node)
                }}
              >
                <Send size={11} aria-hidden="true" />
              </button>
            )}

            {/* Isolar em Worktree */}
            {node.kind === 'agent' && onIsolateWorktree && (
              <button
                type="button"
                className="canvas-card-action-btn"
                aria-label={'Criar worktree para ' + node.title}
                title="Isolar trabalho do agente em um git worktree independente"
                onClick={(event) => {
                  event.stopPropagation()
                  onIsolateWorktree(node)
                }}
              >
                <span className="canvas-card-worktree-mark" aria-hidden="true">WT</span>
              </button>
            )}

            {/* Focar Câmera no Nó */}
            <button
              type="button"
              className="canvas-card-action-btn"
              aria-label={'Focar no nó ' + node.title}
              title="Centralizar câmera neste nó"
              onClick={(event) => {
                event.stopPropagation()
                onFocusNode(node.id)
              }}
            >
              <Crosshair size={11} aria-hidden="true" />
            </button>

            {/* Alternar Modo Compacto / Expandido */}
            {node.kind !== 'workbench' && node.kind !== 'browser' && (
              <button
                type="button"
                className="canvas-card-action-btn canvas-compact-toggle"
                onClick={toggleCompactMode}
                aria-label={effectiveCompact ? (node.kind === 'note' ? 'Expandir nota' : 'Expandir terminal') : 'Recolher cartão'}
                aria-expanded={!effectiveCompact}
                title={effectiveCompact ? (node.kind === 'note' ? 'Expandir nota' : 'Expandir terminal') : 'Recolher cartão'}
              >
                {effectiveCompact ? (
                  <Maximize2 size={11} aria-hidden="true" />
                ) : (
                  <Minimize2 size={11} aria-hidden="true" />
                )}
              </button>
            )}

            {/* Desconectar Links */}
            <button
              type="button"
              className="canvas-card-action-btn"
              aria-label={'Desconectar conexões de ' + node.title}
              title="Desconectar conexões deste nó"
              onClick={(event) => {
                event.stopPropagation()
                onDisconnectLinks(node.id)
              }}
            >
              <Unlink size={11} aria-hidden="true" />
            </button>

            {/* Abrir no Inspector ou Alternar Configuração */}
            <button
              type="button"
              className={'canvas-card-action-btn canvas-agent-config-toggle' + (isConfigOpen ? ' is-active' : '')}
              aria-label={'Configurações de ' + node.title}
              aria-expanded={isConfigOpen}
              title="Abrir configurações e inspeção detalhada"
              onClick={(event) => {
                event.stopPropagation()
                if (onOpenInspector) {
                  onOpenInspector(node)
                } else {
                  onToggleConfig(node.id)
                }
              }}
            >
              <SlidersHorizontal size={11} aria-hidden="true" />
            </button>

            {/* Excluir Nó */}
            {node.kind !== 'workbench' && node.kind !== 'browser' && (
              <button
                type="button"
                className="canvas-card-action-btn canvas-card-action-delete canvas-delete-node"
                aria-label={'Excluir ' + node.title}
                title={node.kind === 'agent' ? 'Excluir agente' : node.kind === 'terminal' ? 'Excluir terminal' : 'Excluir nota'}
                onClick={(event) => {
                  event.stopPropagation()
                  onDeleteNode(node.id)
                }}
              >
                <Trash2 size={11} aria-hidden="true" />
              </button>
            )}
          </div>
        </header>

        {/* Painel Inline de Configuração de Terminal (fallback) */}
        {isConfigOpen && node.kind === 'terminal' && node.terminal && (
          <div className="canvas-agent-config-panel" role="region" aria-label="Configuração do terminal">
            <label className="canvas-agent-config-field">
              <span>Nome</span>
              <input
                value={node.title}
                aria-label="Nome do terminal"
                onChange={(event) => onUpdateTitle(node.id, event.target.value)}
              />
            </label>
            <label className="canvas-agent-config-field">
              <span>Preset</span>
              <select
                aria-label="Preset do terminal"
                value={node.terminal.presetId}
                onChange={(event) => {
                  const chip = quickDeployChips.find((item) => item.id === event.target.value)
                  if (!chip) return
                  onSetTerminalDraft(null)
                  onSetTerminalCommandHint('')
                  onUpdateTerminalNode(node.id, () => {
                    const next = createTerminalNodeConfig(chip.preset)
                    return {
                      ...next,
                      cwdMode: node.terminal!.cwdMode,
                      ...(node.terminal!.cwdMode === 'custom' && node.terminal!.cwd
                        ? { cwd: node.terminal!.cwd }
                        : {}),
                    }
                  })
                }}
              >
                {quickDeployChips.map((chip) => (
                  <option key={chip.id} value={chip.id}>
                    {chip.label}
                  </option>
                ))}
                {!quickDeployChips.some((chip) => chip.id === node.terminal!.presetId) && (
                  <option value={node.terminal.presetId}>{node.terminal.presetId} (ausente)</option>
                )}
              </select>
            </label>

            <label className="canvas-agent-config-field">
              <span>Tema de cores</span>
              <select
                aria-label="Tema de cores do terminal"
                value={node.terminal.theme || 'carbon'}
                onChange={(event) => {
                  const theme = event.target.value as TerminalThemeId
                  onUpdateTerminalNode(node.id, () => ({ theme }))
                }}
              >
                {TERMINAL_THEMES.map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {theme.label}
                  </option>
                ))}
              </select>
            </label>

            {isCustomPreset && customPresetObj && (
              <div
                className="canvas-custom-preset-management"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  padding: '6px 8px',
                  borderRadius: '6px',
                  border: '1px solid var(--ops-border-subtle, #333)',
                  background: 'var(--ops-surface-1, #1a1a1a)',
                  marginBottom: '6px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '11px', color: 'var(--color-text-secondary)' }}>
                    Preset personalizado: <strong>{customPresetObj.name}</strong>
                  </span>
                  <button
                    type="button"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      fontSize: '11px',
                      color: 'var(--color-danger, #ef4444)',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                    }}
                    aria-label={`Excluir preset ${customPresetObj.name}`}
                    onClick={() => {
                      if (window.confirm(`Excluir permanentemente o preset "${customPresetObj.name}"?`)) {
                        onDeleteCustomPreset(customPresetObj.id)
                      }
                    }}
                  >
                    <Trash2 size={12} aria-hidden="true" /> Excluir
                  </button>
                </div>

                {renamingCustomPreset ? (
                  <div style={{ display: 'flex', gap: '4px', marginTop: '2px' }}>
                    <input
                      value={renameDraft}
                      placeholder="Novo nome"
                      aria-label="Novo nome do preset"
                      style={{ flex: 1, fontSize: '11px', padding: '2px 6px' }}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          if (renameDraft.trim()) {
                            onRenameCustomPreset(customPresetObj.id, renameDraft)
                            setRenamingCustomPreset(false)
                          }
                        } else if (e.key === 'Escape') {
                          setRenamingCustomPreset(false)
                        }
                      }}
                    />
                    <button
                      type="button"
                      disabled={!renameDraft.trim()}
                      style={{ fontSize: '11px', padding: '2px 6px', cursor: 'pointer' }}
                      onClick={() => {
                        if (renameDraft.trim()) {
                          onRenameCustomPreset(customPresetObj.id, renameDraft)
                          setRenamingCustomPreset(false)
                        }
                      }}
                    >
                      Salvar
                    </button>
                    <button
                      type="button"
                      style={{ fontSize: '11px', padding: '2px 4px', cursor: 'pointer' }}
                      onClick={() => setRenamingCustomPreset(false)}
                    >
                      Cancelar
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    style={{
                      alignSelf: 'flex-start',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      fontSize: '11px',
                      color: 'var(--color-accent-strong, #3b82f6)',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                    }}
                    onClick={() => {
                      setRenameDraft(customPresetObj.name)
                      setRenamingCustomPreset(true)
                    }}
                  >
                    <Edit2 size={11} aria-hidden="true" /> Renomear preset
                  </button>
                )}
              </div>
            )}

            <label className="canvas-agent-config-field">
              <span>Comando</span>
              <input
                value={terminalDraft?.nodeId === node.id ? terminalDraft.command : node.terminal.command ?? ''}
                aria-label="Comando do terminal"
                placeholder="ex.: npm run dev"
                spellCheck={false}
                onChange={(event) => {
                  const value = event.target.value
                  onSetTerminalDraftField(node.id, 'command', value)
                  onSetTerminalCommandHint(
                    isTerminalCommandTextRejected(value.trim()) ? TERMINAL_COMMAND_INVALID_HINT : '',
                  )
                }}
                onBlur={() => onCommitTerminalFields(node)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    onCommitTerminalFields(node)
                  }
                }}
              />
              {terminalDraft?.nodeId === node.id && terminalCommandHint && (
                <span className="canvas-terminal-save-status" role="status">
                  {terminalCommandHint}
                </span>
              )}
            </label>
            <label className="canvas-agent-config-field">
              <span>Argumentos (separados por espaço)</span>
              <input
                value={terminalDraft?.nodeId === node.id ? terminalDraft.args : formatArgsInput(node.terminal.args)}
                aria-label="Argumentos do comando"
                placeholder="ex.: --port 3000"
                spellCheck={false}
                onChange={(event) => onSetTerminalDraftField(node.id, 'args', event.target.value)}
                onBlur={() => onCommitTerminalFields(node)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    onCommitTerminalFields(node)
                  }
                }}
              />
            </label>
            <div className="canvas-agent-config-field" role="radiogroup" aria-label="Executar em">
              <span>Executar em</span>
              <label className="canvas-terminal-option">
                <input
                  type="radio"
                  name={'terminal-cwd-' + node.id}
                  checked={node.terminal.cwdMode === 'workspace'}
                  onChange={() =>
                    onUpdateTerminalNode(node.id, () => ({ cwdMode: 'workspace', cwd: undefined }))
                  }
                />
                Workspace
              </label>
              <label className="canvas-terminal-option">
                <input
                  type="radio"
                  name={'terminal-cwd-' + node.id}
                  checked={node.terminal.cwdMode === 'custom'}
                  onChange={() => onUpdateTerminalNode(node.id, () => ({ cwdMode: 'custom' }))}
                />
                Diretório próprio
              </label>
              {node.terminal.cwdMode === 'custom' && (
                <input
                  className="canvas-terminal-path"
                  value={terminalDraft?.nodeId === node.id ? terminalDraft.cwd : node.terminal.cwd ?? ''}
                  aria-label="Diretório próprio de execução"
                  placeholder="C:\caminho\do\diretório"
                  spellCheck={false}
                  onChange={(event) => onSetTerminalDraftField(node.id, 'cwd', event.target.value)}
                  onBlur={() => onCommitTerminalFields(node)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      onCommitTerminalFields(node)
                    }
                  }}
                />
              )}
            </div>
            <label className="canvas-terminal-option">
              <input
                type="checkbox"
                checked={node.terminal.autoStart}
                onChange={(event) =>
                  onUpdateTerminalNode(node.id, () => ({ autoStart: event.target.checked }))
                }
              />
              Ao iniciar
            </label>
            <label className="canvas-agent-config-field">
              <span>Ao reiniciar</span>
              <select
                aria-label="Comportamento ao reiniciar"
                value={node.terminal.restartBehavior}
                onChange={(event) =>
                  onUpdateTerminalNode(node.id, () => ({
                    restartBehavior: event.target.value as TerminalNodeRuntimeConfig['restartBehavior'],
                  }))
                }
              >
                <option value="restart">Relançar agente</option>
                <option value="resume">Retomar sessão</option>
                <option value="shell">Shell puro</option>
              </select>
            </label>
            <label className="canvas-terminal-option">
              <input
                type="checkbox"
                checked={node.terminal.monitorActivity}
                onChange={(event) =>
                  onUpdateTerminalNode(node.id, () => ({ monitorActivity: event.target.checked }))
                }
              />
              Monitorar atividade
            </label>
            <div className="canvas-terminal-preset-save">
              <label className="canvas-agent-config-field">
                <span>Salvar como preset</span>
                <input
                  value={presetDraftName}
                  aria-label="Nome do novo preset personalizado"
                  placeholder="Nome do preset"
                  onChange={(event) => {
                    onSetPresetDraftName(event.target.value)
                    onSetPresetSaveStatus('')
                  }}
                />
              </label>
              <button
                type="button"
                className="canvas-terminal-save-button"
                disabled={!presetDraftName.trim()}
                onClick={() => void onSavePreset(node)}
              >
                Salvar preset
              </button>
              {presetSaveStatus && (
                <span className="canvas-terminal-save-status" role="status">
                  {presetSaveStatus}
                </span>
              )}
            </div>
          </div>
        )}

        {/*
          RESUMO ÚTIL E CONCISO PARA MODO COMPACTO (~130px de altura total):
          Exibido apenas em modo compacto para agent, terminal e note.
          O WorkspaceTerminal continua montado na div abaixo com .is-compact-hidden.
        */}
        {isCompactCard && (
          <div
            className="workspace-canvas-card-summary"
            data-canvas-summary={node.kind}
            onPointerDown={(event) => {
              const target = event.target
              if (closestElement(target, 'button, input, select, textarea, a')) return
              onStartNodeDrag(event, node)
            }}
          >
            {node.kind === 'agent' && (
              <>
                <div className="canvas-summary-header-row">
                  <span className="canvas-summary-status" data-agent-status={progress?.state || 'idle'}>
                    <span
                      className={`canvas-status-dot status-${progress?.state || 'idle'}`}
                      aria-hidden="true"
                    />
                    <span>
                      {progress?.label ||
                        (isAgentNodeConfigured(node, agentProviders ?? [])
                          ? 'Configurado'
                          : 'Aguardando configuração')}
                    </span>
                  </span>
                  {node.provider && (
                    <span className="canvas-summary-provider-badge" title={`Provedor: ${node.provider}`}>
                      {node.provider.toUpperCase()}
                      {node.account ? ` (${node.account === 'account1' ? 'C1' : 'C2'})` : ''}
                    </span>
                  )}
                </div>

                <div className="canvas-summary-task" title={agentTaskText}>
                  <span className="canvas-summary-task-label">Tarefa:</span>
                  <span className="canvas-summary-task-text">{agentTaskText}</span>
                </div>

                <div className="canvas-summary-actions">
                  <button
                    type="button"
                    className="canvas-summary-action-btn canvas-summary-btn-terminal"
                    onClick={toggleCompactMode}
                    aria-label="Expandir terminal"
                    title="Expandir cartão e operar terminal interativo"
                  >
                    <Terminal size={12} aria-hidden="true" />
                    <span>Expandir terminal</span>
                  </button>

                  <button
                    type="button"
                    className="canvas-summary-action-btn canvas-summary-btn-inspector"
                    onClick={(event) => {
                      event.stopPropagation()
                      if (onOpenInspector) {
                        onOpenInspector(node)
                      } else {
                        onToggleConfig(node.id)
                      }
                    }}
                    aria-label="Abrir Inspector"
                    title="Abrir detalhes e configurações no Inspector"
                  >
                    <SlidersHorizontal size={12} aria-hidden="true" />
                    <span>Inspector</span>
                  </button>

                  {isAgentNodeConfigured(node, agentProviders ?? []) && onSendTask && (
                    <button
                      type="button"
                      className="canvas-summary-action-btn canvas-summary-btn-send"
                      disabled={isSendDisabled}
                      aria-label={'Enviar tarefa para ' + node.title}
                      title={
                        sendTitle ||
                        (isActualCoordinator
                          ? 'Iniciar orquestração com as notas conectadas'
                          : 'Enviar as notas conectadas ao agente')
                      }
                      onClick={(event) => {
                        event.stopPropagation()
                        onSendTask(node)
                      }}
                    >
                      <Send size={11} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </>
            )}

            {node.kind === 'terminal' && (
              <>
                <div className="canvas-summary-header-row">
                  <span className="canvas-summary-status">
                    <span className="canvas-status-dot status-idle" aria-hidden="true" />
                    <span>{customPresetObj?.name || node.terminal?.presetId || 'Shell'}</span>
                  </span>
                  <span className="canvas-summary-provider-badge">
                    {node.terminal?.autoStart ? 'Auto-início' : 'Manual'}
                  </span>
                </div>

                <div className="canvas-summary-task" title={terminalCommandText}>
                  <span className="canvas-summary-task-label">Comando:</span>
                  <span className="canvas-summary-task-text canvas-summary-task-mono">
                    {terminalCommandText}
                  </span>
                </div>

                <div className="canvas-summary-actions">
                  <button
                    type="button"
                    className="canvas-summary-action-btn canvas-summary-btn-terminal"
                    onClick={toggleCompactMode}
                    aria-label="Expandir terminal"
                    title="Expandir cartão e operar terminal"
                  >
                    <Terminal size={12} aria-hidden="true" />
                    <span>Expandir terminal</span>
                  </button>

                  <button
                    type="button"
                    className="canvas-summary-action-btn canvas-summary-btn-inspector"
                    onClick={(event) => {
                      event.stopPropagation()
                      if (onOpenInspector) {
                        onOpenInspector(node)
                      } else {
                        onToggleConfig(node.id)
                      }
                    }}
                    aria-label="Abrir Inspector"
                    title="Configurar terminal no Inspector"
                  >
                    <SlidersHorizontal size={12} aria-hidden="true" />
                    <span>Inspector</span>
                  </button>
                </div>
              </>
            )}

            {node.kind === 'note' && (
              <>
                <div className="canvas-summary-header-row">
                  <span className="canvas-summary-status">
                    <span className="canvas-status-dot status-idle" aria-hidden="true" />
                    <span>Nota rápida</span>
                  </span>
                  <span className="canvas-summary-provider-badge">
                    {(node.content || '').length} car.
                  </span>
                </div>

                <div className="canvas-summary-task" title={node.content || 'Nota vazia'}>
                  <span className="canvas-summary-task-label">Nota:</span>
                  <span className="canvas-summary-task-text">
                    {node.content?.trim() || 'Nota vazia (clique em Expandir para editar)'}
                  </span>
                </div>

                <div className="canvas-summary-actions">
                  <button
                    type="button"
                    className="canvas-summary-action-btn canvas-summary-btn-terminal"
                    onClick={toggleCompactMode}
                    aria-label="Expandir nota"
                    title="Expandir cartão e editar nota"
                  >
                    <Maximize2 size={12} aria-hidden="true" />
                    <span>Expandir nota</span>
                  </button>

                  <button
                    type="button"
                    className="canvas-summary-action-btn canvas-summary-btn-inspector"
                    onClick={(event) => {
                      event.stopPropagation()
                      if (onOpenInspector) {
                        onOpenInspector(node)
                      } else {
                        onToggleConfig(node.id)
                      }
                    }}
                    aria-label="Abrir Inspector"
                    title="Editar nota no Inspector"
                  >
                    <SlidersHorizontal size={12} aria-hidden="true" />
                    <span>Inspector</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/*
          CONTEÚDO DO CARTÃO:
          CRUCIAL KEEP-ALIVE:
          Esta div NUNCA é desmontada condicionalmente quando compactada!
          Em modo compacto, usamos display/visibility/height CSS via .is-compact
          para que o WorkspaceTerminal e os processos PTY nativos permaneçam 100%
          vivos, conectados e operando em background.
        */}
        <div
          className={'workspace-canvas-card-content' + (effectiveCompact ? ' is-compact-hidden' : '')}
          aria-hidden={effectiveCompact}
        >
          {node.kind === 'workbench' ? (
            workbench
          ) : node.kind === 'browser' ? (
            browser
          ) : node.kind === 'agent' ? (
            isAgentNodeConfigured(node, agentProviders ?? []) ? (
              <>
                {renderAgent?.(node) || <div className="canvas-agent-empty">Terminal do agente indisponível.</div>}
                {node.content && (
                  <div className="canvas-agent-result" title={node.content}>
                    {node.content}
                  </div>
                )}
              </>
            ) : (
              <div className="canvas-agent-empty" role="status">
                <p>{agentNodeSetupMessage(node, agentProviders ?? [])}</p>
              </div>
            )
          ) : node.kind === 'terminal' ? (
            renderTerminal?.(node) || <div className="canvas-agent-empty">Terminal indisponível.</div>
          ) : (
            <textarea
              data-canvas-note-editor=""
              value={node.content || ''}
              placeholder="Escreva anotações ou tarefas para a squad…"
              aria-label={node.title}
              onChange={(event) => onUpdateContent(node.id, event.target.value.slice(0, 24000))}
              onPointerDown={(event) => event.stopPropagation()}
            />
          )}
        </div>

        {/* Handle de redimensionamento (apenas no modo expandido) */}
        {!effectiveCompact && (
          <div
            className="workspace-canvas-resize-handle"
            data-canvas-resize-handle=""
            onPointerDown={(event) => onStartResize(event, node)}
            aria-hidden="true"
          />
        )}
      </section>
    )
  },
)
