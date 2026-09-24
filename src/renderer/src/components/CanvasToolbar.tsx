import React, { useEffect, useRef, useState } from 'react'
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
  ChevronDown,
  Check,
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

/** Item do dropdown de zoom: um preset aplicável + marcação do nível atual. */
interface CanvasZoomMenuItem {
  key: string
  percent: number
  label: string
  active: boolean
  apply: () => void
}

const ZOOM_ACTIVE_EPSILON = 0.05

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

  // Dropdown de presets de zoom (25–150%): aberto pelo ▾; −/+ e o % ficam
  // sempre visíveis e funcionais fora do menu.
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false)
  const zoomMenuRef = useRef<HTMLDivElement | null>(null)
  const zoomTriggerRef = useRef<HTMLButtonElement | null>(null)

  // Fecha o menu com clique-fora ou Esc; Esc devolve o foco ao gatilho.
  useEffect(() => {
    if (!zoomMenuOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      if (zoomMenuRef.current && !zoomMenuRef.current.contains(event.target as Node)) {
        setZoomMenuOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setZoomMenuOpen(false)
        zoomTriggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [zoomMenuOpen])

  // Itens do menu: níveis discretos quando fornecidos; sem eles, os três
  // presets nomeados legados (Perto/Médio/Longe) mantêm a API compatível.
  const zoomMenuItems: CanvasZoomMenuItem[] =
    zoomLevels && zoomLevels.length > 0
      ? zoomLevels.map((lvl) => {
          const percent = Math.round(lvl * 100)
          return {
            key: `level-${lvl}`,
            percent,
            label: `${percent}%`,
            active: Math.abs(zoom - lvl) < ZOOM_ACTIVE_EPSILON,
            apply: () => {
              if (onSetZoom) {
                onSetZoom(lvl)
              } else if (onSetZoomPreset) {
                if (lvl > 1.15) onSetZoomPreset('close')
                else if (lvl < 0.7) onSetZoomPreset('far')
                else onSetZoomPreset('medium')
              }
            },
          }
        })
      : [
          {
            key: 'close',
            percent: 125,
            label: 'Perto',
            active: zoom > 1.15,
            apply: () => {
              if (onSetZoom) onSetZoom(1.25)
              else if (onSetZoomPreset) onSetZoomPreset('close')
            },
          },
          {
            key: 'medium',
            percent: 100,
            label: 'Médio',
            active: Math.abs(zoom - 1.0) < 0.1,
            apply: () => {
              if (onSetZoom) onSetZoom(1.0)
              else if (onSetZoomPreset) onSetZoomPreset('medium')
            },
          },
          {
            key: 'far',
            percent: 50,
            label: 'Longe',
            active: zoom < 0.65,
            apply: () => {
              if (onSetZoom) onSetZoom(0.5)
              else if (onSetZoomPreset) onSetZoomPreset('far')
            },
          },
        ]

  return (
    <nav
      className="canvas-toolbar"
      role="toolbar"
      aria-label="Barra de ferramentas do canvas"
      data-canvas-toolbar=""
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Grupo de Criação: únicos com texto curto (descoberta de novos nós);
          demais grupos são ícone + tooltip com aria-label preservado. */}
      <div className="canvas-toolbar-group" role="group" aria-label="Criar nós">
        {triggerCreateAgent && (
          <button
            type="button"
            className="canvas-toolbar-btn"
            onClick={triggerCreateAgent}
            aria-label="Novo agente"
            title="Adicionar agente ao canvas"
          >
            <Bot size={13} aria-hidden="true" />
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
            <Terminal size={13} aria-hidden="true" />
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
            <NotebookPen size={13} aria-hidden="true" />
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
            <Users size={13} aria-hidden="true" />
            <span className="canvas-toolbar-btn-text">Squad</span>
          </button>
        )}
      </div>

      <div className="canvas-toolbar-separator" aria-hidden="true" />

      {/* Grupo de Conexão: ⇄ Conectar com estado ativo; ações de seleção
          continuam condicionadas a haver seleção. */}
      <div className="canvas-toolbar-group" role="group" aria-label="Conexão e seleção">
        {onStartConnection && (
          <button
            type="button"
            className={`canvas-toolbar-btn canvas-toolbar-btn-icon ${isConnecting ? 'is-active' : ''}`}
            onClick={onStartConnection}
            disabled={effectiveSelectionCount === 0}
            aria-label="Conectar nós selecionados"
            aria-pressed={isConnecting}
            title={
              effectiveSelectionCount > 0
                ? 'Conectar com outro nó'
                : 'Selecione um nó para conectar'
            }
          >
            <Link2 size={14} aria-hidden="true" />
          </button>
        )}
        {effectiveSelectionCount > 0 && onRemoveLinks && (
          <button
            type="button"
            className="canvas-toolbar-btn canvas-toolbar-btn-icon"
            onClick={onRemoveLinks}
            aria-label="Desvincular nós"
            title="Desconectar conexões do nó selecionado"
          >
            <Unlink size={14} aria-hidden="true" />
          </button>
        )}
        {effectiveSelectionCount > 0 && onDeleteSelected && effectiveCanDelete && (
          <button
            type="button"
            className="canvas-toolbar-btn canvas-toolbar-btn-icon canvas-toolbar-btn-danger"
            onClick={onDeleteSelected}
            aria-label={`Excluir ${effectiveSelectionCount} nó(s) selecionado(s)`}
            title="Excluir selecionados"
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="canvas-toolbar-separator" aria-hidden="true" />

      {/* Grupo de Zoom: − % ＋ sempre visíveis; ▾ abre os presets */}
      <div className="canvas-toolbar-group" role="group" aria-label="Controle de zoom">
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

        {(onSetZoom || onSetZoomPreset) && (
          <div className="canvas-toolbar-zoom-presets" ref={zoomMenuRef}>
            <button
              type="button"
              ref={zoomTriggerRef}
              className="canvas-toolbar-btn canvas-toolbar-btn-icon canvas-toolbar-zoom-trigger"
              onClick={() => setZoomMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={zoomMenuOpen}
              aria-label="Escolher nível de zoom"
              title="Escolher nível de zoom (25% a 150%)"
            >
              <ChevronDown size={13} aria-hidden="true" />
            </button>
            {/* Menu popover de presets: fica no DOM (oculto) para leitura
                estática/testes; `hidden` o tira da árvore de acessibilidade. */}
            <div
              className="canvas-toolbar-zoom-menu"
              role="menu"
              aria-label="Níveis de zoom"
              hidden={!zoomMenuOpen}
            >
              {zoomMenuItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.active}
                  className={`canvas-toolbar-zoom-option ${item.active ? 'is-active' : ''}`}
                  onClick={() => {
                    item.apply()
                    setZoomMenuOpen(false)
                  }}
                  aria-label={`Zoom ${item.percent}%`}
                  title={`Definir zoom para ${item.percent}%`}
                >
                  <span className="canvas-toolbar-zoom-check" aria-hidden="true">
                    {item.active ? <Check size={12} /> : null}
                  </span>
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="canvas-toolbar-separator" aria-hidden="true" />

      {/* Grupo de Foco e Navegação */}
      <div className="canvas-toolbar-group" role="group" aria-label="Foco e navegação">
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
            className={`canvas-toolbar-btn canvas-toolbar-btn-icon ${isFocusModeActive ? 'is-active' : ''}`}
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
            <Crosshair size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Grupo do Inspector & Reset */}
      {(onToggleInspector || onResetCanvas) && (
        <>
          <div className="canvas-toolbar-separator" aria-hidden="true" />
          <div className="canvas-toolbar-group" role="group" aria-label="Painéis e estado">
            {onToggleInspector && (
              <button
                type="button"
                className={`canvas-toolbar-btn canvas-toolbar-btn-icon ${isInspectorOpen ? 'is-active' : ''}`}
                onClick={onToggleInspector}
                aria-label="Alternar painel de inspeção"
                aria-expanded={isInspectorOpen}
                title="Abrir/fechar Inspector lateral"
              >
                <SlidersHorizontal size={14} aria-hidden="true" />
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
        </>
      )}
    </nav>
  )
}
