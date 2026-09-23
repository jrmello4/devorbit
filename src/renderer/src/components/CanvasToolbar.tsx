import React from 'react'
import {
  Bot,
  Terminal,
  NotebookPen,
  Users,
  Link2,
  Unlink,
  Trash2,
  Minus,
  Plus,
  Maximize2,
  Crosshair,
  SlidersHorizontal,
  RotateCcw,
} from 'lucide-react'

export type CanvasZoomPreset = 'close' | 'medium' | 'far'

export interface CanvasToolbarProps {
  projectName?: string
  zoom: number
  zoomLevels?: readonly number[]
  onSetZoom?: (level: number) => void
  onZoomIn: () => void
  onZoomOut: () => void
  onFit?: () => void
  onFitCanvas?: () => void
  onResetViewport: () => void
  onSetZoomPreset?: (level: CanvasZoomPreset) => void
  // Criar nós
  onCreateAgent?: () => void
  onOpenAgentCreation?: () => void
  onCreateSquad?: () => void
  onOpenSquadCreation?: () => void
  onCreateNote?: () => void
  onAddNote?: () => void
  onCreateTerminal?: () => void
  onOpenTerminalQuickDeploy?: () => void
  onResetCanvas?: () => void
  // Seleção e Ações
  selectionCount?: number
  hasSelection?: boolean
  canDelete?: boolean
  onDeleteSelected?: () => void
  onFocusSelected?: () => void
  isFocusModeActive?: boolean
  // Inspector
  isInspectorOpen?: boolean
  onToggleInspector?: () => void
  // Conexões
  isConnecting?: boolean
  onStartConnection?: () => void
  onRemoveLinks?: () => void
  // Status opcionais
  continuity?: unknown
  orchestration?: unknown
}

export const CanvasToolbar: React.FC<CanvasToolbarProps> = ({
  projectName,
  zoom,
  zoomLevels,
  onSetZoom,
  onZoomIn,
  onZoomOut,
  onFit,
  onFitCanvas,
  onResetViewport,
  onSetZoomPreset,
  onCreateAgent,
  onOpenAgentCreation,
  onCreateSquad,
  onOpenSquadCreation,
  onCreateNote,
  onAddNote,
  onCreateTerminal,
  onOpenTerminalQuickDeploy,
  onResetCanvas,
  selectionCount = 0,
  hasSelection,
  canDelete,
  onDeleteSelected,
  onFocusSelected,
  isFocusModeActive = false,
  isInspectorOpen = false,
  onToggleInspector,
  isConnecting = false,
  onStartConnection,
  onRemoveLinks,
}) => {
  const triggerCreateAgent = onCreateAgent || onOpenAgentCreation
  const triggerCreateSquad = onCreateSquad || onOpenSquadCreation
  const triggerCreateNote = onCreateNote || onAddNote
  const triggerCreateTerminal = onCreateTerminal || onOpenTerminalQuickDeploy
  const triggerFit = onFit || onFitCanvas

  const effectiveSelectionCount = typeof hasSelection === 'boolean'
    ? (hasSelection ? Math.max(1, selectionCount) : 0)
    : selectionCount

  const effectiveCanDelete = typeof canDelete === 'boolean'
    ? canDelete
    : effectiveSelectionCount > 0

  const zoomPercent = Math.round(zoom * 100)

  return (
    <nav
      className="canvas-toolbar"
      role="toolbar"
      aria-label="Barra de ferramentas do canvas"
      data-canvas-toolbar=""
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Grupo de Criação */}
      <div className="canvas-toolbar-group" role="group" aria-label="Criar nós">
        {triggerCreateAgent && (
          <button
            type="button"
            className="canvas-toolbar-btn"
            onClick={triggerCreateAgent}
            aria-label="Novo agente"
            title="Adicionar agente ao canvas"
          >
            <Bot size={14} aria-hidden="true" />
            <span className="canvas-toolbar-btn-text">Agente</span>
          </button>
        )}
        {triggerCreateTerminal && (
          <button
            type="button"
            className="canvas-toolbar-btn"
            onClick={triggerCreateTerminal}
            aria-label="Novo terminal"
            title="Adicionar terminal ao canvas"
          >
            <Terminal size={14} aria-hidden="true" />
            <span className="canvas-toolbar-btn-text">Terminal</span>
          </button>
        )}
        {triggerCreateNote && (
          <button
            type="button"
            className="canvas-toolbar-btn"
            onClick={triggerCreateNote}
            aria-label="Nova nota"
            title="Adicionar nota ao canvas"
          >
            <NotebookPen size={14} aria-hidden="true" />
            <span className="canvas-toolbar-btn-text">Nota</span>
          </button>
        )}
        {triggerCreateSquad && (
          <button
            type="button"
            className="canvas-toolbar-btn"
            onClick={triggerCreateSquad}
            aria-label="Novo squad"
            title="Criar squad de agentes"
          >
            <Users size={14} aria-hidden="true" />
            <span className="canvas-toolbar-btn-text">Squad</span>
          </button>
        )}
      </div>

      <div className="canvas-toolbar-separator" aria-hidden="true" />

      {/* Grupo de Conexão e Edição de Seleção */}
      {effectiveSelectionCount > 0 && (
        <>
          <div className="canvas-toolbar-group" role="group" aria-label="Ações de seleção">
            {onStartConnection && (
              <button
                type="button"
                className={`canvas-toolbar-btn ${isConnecting ? 'is-active' : ''}`}
                onClick={onStartConnection}
                aria-label="Conectar nós selecionados"
                title="Conectar com outro nó"
              >
                <Link2 size={13} aria-hidden="true" />
                <span className="canvas-toolbar-btn-text">Conectar</span>
              </button>
            )}
            {onRemoveLinks && (
              <button
                type="button"
                className="canvas-toolbar-btn"
                onClick={onRemoveLinks}
                aria-label="Desvincular nós"
                title="Desconectar conexões do nó selecionado"
              >
                <Unlink size={13} aria-hidden="true" />
                <span className="canvas-toolbar-btn-text">Desvincular</span>
              </button>
            )}
            {onDeleteSelected && effectiveCanDelete && (
              <button
                type="button"
                className="canvas-toolbar-btn canvas-toolbar-btn-danger"
                onClick={onDeleteSelected}
                aria-label={`Excluir ${effectiveSelectionCount} nó(s) selecionado(s)`}
                title="Excluir selecionados"
              >
                <Trash2 size={13} aria-hidden="true" />
                <span className="canvas-toolbar-btn-text">Excluir</span>
              </button>
            )}
          </div>
          <div className="canvas-toolbar-separator" aria-hidden="true" />
        </>
      )}

      {/* Grupo de Foco e Navegação */}
      <div className="canvas-toolbar-group" role="group" aria-label="Controle de visualização e zoom">
        <button
          type="button"
          className="canvas-toolbar-btn canvas-toolbar-btn-icon"
          onClick={onZoomOut}
          aria-label="Diminuir zoom"
          title="Diminuir zoom (menos)"
        >
          <Minus size={14} aria-hidden="true" />
        </button>

        <button
          type="button"
          className="canvas-toolbar-btn canvas-toolbar-zoom-label"
          onClick={onResetViewport}
          aria-label={`Zoom atual: ${zoomPercent}%. Clique para restaurar para 100%`}
          title="Restaurar zoom inicial (100%)"
        >
          {zoomPercent}%
        </button>

        <button
          type="button"
          className="canvas-toolbar-btn canvas-toolbar-btn-icon"
          onClick={onZoomIn}
          aria-label="Aumentar zoom"
          title="Aumentar zoom (mais)"
        >
          <Plus size={14} aria-hidden="true" />
        </button>

        {(onSetZoomPreset || onSetZoom) && (
          <div className="canvas-toolbar-zoom-presets" role="group" aria-label="Níveis de zoom">
            {zoomLevels && zoomLevels.length > 0 ? (
              zoomLevels.map((lvl) => {
                const percent = Math.round(lvl * 100)
                const isActive = Math.abs(zoom - lvl) < 0.05
                return (
                  <button
                    key={lvl}
                    type="button"
                    className={`canvas-toolbar-chip ${isActive ? 'is-active' : ''}`}
                    onClick={() => {
                      if (onSetZoom) {
                        onSetZoom(lvl)
                      } else if (onSetZoomPreset) {
                        if (lvl > 1.15) onSetZoomPreset('close')
                        else if (lvl < 0.7) onSetZoomPreset('far')
                        else onSetZoomPreset('medium')
                      }
                    }}
                    aria-label={`Zoom ${percent}%`}
                    title={`Definir zoom para ${percent}%`}
                  >
                    {percent}%
                  </button>
                )
              })
            ) : (
              <>
                <button
                  type="button"
                  className={`canvas-toolbar-chip ${zoom > 1.15 ? 'is-active' : ''}`}
                  onClick={() => {
                    if (onSetZoom) onSetZoom(1.25)
                    else if (onSetZoomPreset) onSetZoomPreset('close')
                  }}
                  aria-label="Zoom próximo (125%)"
                  title="Zoom próximo (125%)"
                >
                  Perto
                </button>
                <button
                  type="button"
                  className={`canvas-toolbar-chip ${Math.abs(zoom - 1.0) < 0.1 ? 'is-active' : ''}`}
                  onClick={() => {
                    if (onSetZoom) onSetZoom(1.0)
                    else if (onSetZoomPreset) onSetZoomPreset('medium')
                  }}
                  aria-label="Zoom médio (100%)"
                  title="Zoom médio (100%)"
                >
                  Médio
                </button>
                <button
                  type="button"
                  className={`canvas-toolbar-chip ${zoom < 0.65 ? 'is-active' : ''}`}
                  onClick={() => {
                    if (onSetZoom) onSetZoom(0.5)
                    else if (onSetZoomPreset) onSetZoomPreset('far')
                  }}
                  aria-label="Zoom distante (50%)"
                  title="Zoom distante (50%)"
                >
                  Longe
                </button>
              </>
            )}
          </div>
        )}

        {triggerFit && (
          <button
            type="button"
            className="canvas-toolbar-btn canvas-toolbar-btn-icon"
            onClick={triggerFit}
            aria-label="Encaixar todo o conteúdo na tela"
            title="Encaixar conteúdo"
          >
            <Maximize2 size={13} aria-hidden="true" />
          </button>
        )}

        {onFocusSelected && (
          <button
            type="button"
            className={`canvas-toolbar-btn ${isFocusModeActive ? 'is-active' : ''}`}
            disabled={effectiveSelectionCount === 0}
            onClick={onFocusSelected}
            aria-label={
              effectiveSelectionCount > 1
                ? `Focar ${effectiveSelectionCount} nós selecionados`
                : 'Focar nó selecionado'
            }
            aria-pressed={isFocusModeActive}
            title={
              effectiveSelectionCount > 0
                ? 'Centralizar câmera e focar elementos selecionados'
                : 'Selecione nós para focar'
            }
          >
            <Crosshair size={13} aria-hidden="true" />
            <span className="canvas-toolbar-btn-text">Foco</span>
          </button>
        )}
      </div>

      {/* Grupo do Inspector & Reset */}
      <div className="canvas-toolbar-separator" aria-hidden="true" />
      <div className="canvas-toolbar-group" role="group" aria-label="Painéis e estado">
        {onToggleInspector && (
          <button
            type="button"
            className={`canvas-toolbar-btn ${isInspectorOpen ? 'is-active' : ''}`}
            onClick={onToggleInspector}
            aria-label="Alternar painel de inspeção"
            aria-expanded={isInspectorOpen}
            title="Abrir/fechar Inspector lateral"
          >
            <SlidersHorizontal size={13} aria-hidden="true" />
            <span className="canvas-toolbar-btn-text">Inspector</span>
          </button>
        )}

        {onResetCanvas && (
          <button
            type="button"
            className="canvas-toolbar-btn canvas-toolbar-btn-icon"
            onClick={onResetCanvas}
            aria-label="Resetar layout do canvas"
            title="Resetar layout do canvas"
          >
            <RotateCcw size={13} aria-hidden="true" />
          </button>
        )}
      </div>
    </nav>
  )
}
