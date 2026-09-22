import React from 'react'
import type { CanvasNode } from './WorkspaceCanvas'

export interface CanvasMinimapProps {
  viewport: { x: number; y: number; zoom: number }
  nodes: readonly CanvasNode[]
  worldWidth: number
  worldHeight: number
  viewportWidth: number
  viewportHeight: number
  onPointerDown: (event: React.PointerEvent<SVGSVGElement>) => void
  onPointerMove: (event: React.PointerEvent<SVGSVGElement>) => void
  onPointerUp: (event: React.PointerEvent<SVGSVGElement>) => void
}

export const CanvasMinimap: React.FC<CanvasMinimapProps> = React.memo(
  function CanvasMinimap({
    viewport,
    nodes,
    worldWidth,
    worldHeight,
    viewportWidth,
    viewportHeight,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  }) {
    const width = (viewportWidth || 900) / viewport.zoom
    const height = (viewportHeight || 650) / viewport.zoom

    return (
      <div className="workspace-canvas-minimap" aria-label="Minimapa do canvas">
        <svg
          viewBox={`0 0 ${worldWidth} ${worldHeight}`}
          preserveAspectRatio="none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          role="img"
          aria-label="Navegar pelo minimapa"
        >
          {nodes.map((node) => (
            <rect
              key={node.id}
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              className={'minimap-node ' + node.kind}
            />
          ))}
          <rect
            className="minimap-viewport"
            x={-viewport.x / viewport.zoom}
            y={-viewport.y / viewport.zoom}
            width={width}
            height={height}
          />
        </svg>
      </div>
    )
  },
)
