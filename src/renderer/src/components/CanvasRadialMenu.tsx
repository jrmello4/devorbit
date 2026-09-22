import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { Plus } from 'lucide-react'
import {
  RADIAL_MENU_DEFAULTS,
  nearestRadialIndex,
  radialItemAngles,
  radialPointFromAngle,
  radialStaggerDelay,
  resolveRadialRadius,
} from './radial-menu-helpers'
import type { RadialMenuTuning } from './radial-menu-helpers'

export interface CanvasRadialItem {
  id: string
  label: string
  icon: ComponentType<{ size?: number | string; strokeWidth?: number; 'aria-hidden'?: boolean }>
  disabled?: boolean
  disabledReason?: string
  onSelect: () => void
}

export interface CanvasRadialMenuProps {
  items: CanvasRadialItem[]
  label?: string
  tuning?: Partial<RadialMenuTuning>
}

const RADIAL_DRAG_THRESHOLD = 14

export const CanvasRadialMenu: React.FC<CanvasRadialMenuProps> = ({
  items,
  label = 'Menu do canvas',
  tuning,
}) => {
  const radius = tuning?.radius ?? RADIAL_MENU_DEFAULTS.radius
  const spread = tuning?.spread ?? RADIAL_MENU_DEFAULTS.spread
  const stagger = tuning?.stagger ?? RADIAL_MENU_DEFAULTS.stagger

  const [open, setOpen] = useState(false)
  const [liveIndex, setLiveIndex] = useState(-1)
  const liveIndexRef = useRef(-1)
  const pointerStartRef = useRef<{ x: number; y: number; moved: boolean; wasOpen: boolean } | null>(
    null,
  )
  const suppressClickRef = useRef(false)

  const angles = useMemo(() => radialItemAngles(items.length, spread), [items.length, spread])
  const resolvedRadius = useMemo(
    () => resolveRadialRadius(radius, items.length, spread),
    [radius, items.length, spread],
  )
  const allowed = useMemo(() => items.map((item) => !item.disabled), [items])

  const setLive = useCallback((index: number) => {
    if (liveIndexRef.current === index) return
    liveIndexRef.current = index
    setLiveIndex(index)
  }, [])

  const closeMenu = useCallback(() => {
    setOpen(false)
    setLive(-1)
  }, [setLive])

  useEffect(() => {
    if (!open) return undefined
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, closeMenu])

  const toggleMenu = useCallback(() => {
    if (open) {
      closeMenu()
      return
    }
    setLive(-1)
    setOpen(true)
  }, [open, closeMenu, setLive])

  const handleCorePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* Synthetic events and inactive pointers cannot be captured. */
    }
    pointerStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      moved: false,
      wasOpen: open,
    }
    suppressClickRef.current = true
    setLive(-1)
    setOpen(true)
  }

  const handleCorePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const start = pointerStartRef.current
    if (!start) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (Math.hypot(dx, dy) < RADIAL_DRAG_THRESHOLD) {
      if (start.moved) setLive(-1)
      return
    }
    start.moved = true
    setLive(nearestRadialIndex(dx, dy, angles, allowed))
  }

  const finishPointer = (event: React.PointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* Synthetic events and inactive pointers cannot be captured. */
    }
    const start = pointerStartRef.current
    pointerStartRef.current = null
    if (cancelled) {
      suppressClickRef.current = false
      if (start?.wasOpen) setLive(-1)
      else closeMenu()
      return
    }
    const index = liveIndexRef.current
    if (start?.moved && index >= 0) {
      const item = items[index]
      closeMenu()
      if (item) item.onSelect()
      return
    }
    if (start?.wasOpen) {
      closeMenu()
      return
    }
    setLive(-1)
  }

  const handleCoreClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    toggleMenu()
  }

  const handleCoreKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggleMenu()
      return
    }
    if (event.key === 'Escape') closeMenu()
  }

  return (
    <div className="workspace-canvas-radial" data-canvas-radial data-open={open}>
      <div
        className="workspace-canvas-radial-arc"
        data-open={open}
        role="menu"
        aria-label={label}
        inert={!open}
      >
        {items.map((item, index) => {
          const Icon = item.icon
          const point = radialPointFromAngle(angles[index], resolvedRadius)
          return (
            <button
              key={item.id}
              className="workspace-canvas-radial-option"
              data-canvas-radial-item={item.id}
              data-live={liveIndex === index ? 'true' : undefined}
              type="button"
              role="menuitem"
              aria-label={item.label}
              aria-disabled={item.disabled || undefined}
              title={item.disabledReason || item.label}
              style={{
                transform: open
                  ? `translate(${point.x}px, ${point.y}px) scale(1)`
                  : 'translate(0px, 0px) scale(0.4)',
                transitionDelay: `${radialStaggerDelay(index, stagger, open)}ms`,
              }}
              onClick={() => {
                if (item.disabled) return
                closeMenu()
                item.onSelect()
              }}
            >
              <Icon size={18} strokeWidth={1.8} aria-hidden />
              <i className="workspace-canvas-radial-label">{item.label}</i>
            </button>
          )
        })}
      </div>
      <button
        className="workspace-canvas-radial-core"
        data-canvas-radial-core
        data-open={open}
        type="button"
        aria-label={open ? `Fechar ${label}` : `Abrir ${label}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={handleCoreClick}
        onKeyDown={handleCoreKeyDown}
        onPointerDown={handleCorePointerDown}
        onPointerMove={handleCorePointerMove}
        onPointerUp={(event) => {
          if (event.button !== 0) return
          finishPointer(event, false)
        }}
        onPointerCancel={(event) => finishPointer(event, true)}
      >
        <Plus size={18} strokeWidth={2} aria-hidden />
      </button>
    </div>
  )
}
