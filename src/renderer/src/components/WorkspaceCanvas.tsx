import React, { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Globe, Grip, Maximize2, StickyNote, Terminal } from 'lucide-react'
import type { Project } from '../types'
import './WorkspaceCanvas.css'

type CardKind = 'workbench' | 'browser' | 'notes'
interface Card { id: CardKind; x: number; y: number; width: number; height: number; z: number }
interface StoredCanvas { cards: Card[]; note: string }
const defaults: Card[] = [
  { id: 'workbench', x: 28, y: 28, width: 680, height: 560, z: 1 },
  { id: 'notes', x: 730, y: 28, width: 310, height: 240, z: 2 },
  { id: 'browser', x: 730, y: 288, width: 310, height: 300, z: 3 },
]
const key = (id: string) => 'devorbit:workspace-canvas:' + id
function read(id: string): StoredCanvas {
  try {
    const value = JSON.parse(window.localStorage.getItem(key(id)) || '') as Partial<StoredCanvas>
    if (Array.isArray(value.cards) && value.cards.length === defaults.length) {
      const cards = defaults.map((fallback) => {
        const candidate = value.cards?.find((card) => card?.id === fallback.id)
        if (!candidate) return fallback
        return {
          id: fallback.id,
          x: Number.isFinite(candidate.x) ? Math.max(8, candidate.x) : fallback.x,
          y: Number.isFinite(candidate.y) ? Math.max(8, candidate.y) : fallback.y,
          width: Number.isFinite(candidate.width) ? Math.max(220, Math.min(980, candidate.width)) : fallback.width,
          height: Number.isFinite(candidate.height) ? Math.max(150, Math.min(760, candidate.height)) : fallback.height,
          z: Number.isFinite(candidate.z) ? candidate.z : fallback.z,
        }
      })
      return { cards, note: typeof value.note === 'string' ? value.note.slice(0, 12000) : '' }
    }
  } catch { /* use defaults */ }
  return { cards: defaults, note: '' }
}
const labels: Record<CardKind, { label: string; icon: React.ReactNode }> = {
  workbench: { label: 'Editor e terminais', icon: <Terminal size={13} /> },
  browser: { label: 'Navegador do projeto', icon: <Globe size={13} /> },
  notes: { label: 'Notas e handoff', icon: <StickyNote size={13} /> },
}
export const WorkspaceCanvas: React.FC<{ project: Project; workbench: React.ReactNode; browser?: React.ReactNode }> = ({ project, workbench, browser }) => {
  const [state, setState] = useState<StoredCanvas>(() => read(project.id))
  const [drag, setDrag] = useState<{ id: CardKind; sx: number; sy: number; card: Card } | null>(null)
  const [resize, setResize] = useState<{ id: CardKind; sx: number; sy: number; card: Card } | null>(null)
  const stateRef = useRef(state)
  const persistTimerRef = useRef<number | null>(null)
  const persistCanvas = useCallback((canvas: StoredCanvas) => {
    try { window.localStorage.setItem(key(project.id), JSON.stringify(canvas)) } catch { /* optional */ }
  }, [project.id])
  const flushPersist = useCallback(() => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
    }
    persistCanvas(stateRef.current)
  }, [persistCanvas])
  const schedulePersist = useCallback(() => {
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current)
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null
      persistCanvas(stateRef.current)
    }, 120)
  }, [persistCanvas])
  const updateState = useCallback((updater: (current: StoredCanvas) => StoredCanvas) => {
    const next = updater(stateRef.current)
    stateRef.current = next
    setState(next)
  }, [])
  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => {
    // Notes remain durable as the user types. Card geometry is persisted by the
    // trailing gesture debounce and flushed when the component unmounts.
    persistCanvas(state)
  }, [persistCanvas, state.note])
  useEffect(() => {
    const persistBeforePageHide = () => flushPersist()
    window.addEventListener('pagehide', persistBeforePageHide)
    return () => {
      window.removeEventListener('pagehide', persistBeforePageHide)
      flushPersist()
    }
  }, [flushPersist])
  useEffect(() => {
    if (!drag) return
    const move = (event: PointerEvent) => {
      updateState((current) => ({ ...current, cards: current.cards.map((card) => card.id !== drag.id ? card : { ...card, x: Math.max(8, drag.card.x + event.clientX - drag.sx), y: Math.max(8, drag.card.y + event.clientY - drag.sy), z: Math.max(...current.cards.map((item) => item.z)) + 1 }) }))
      schedulePersist()
    }
    const up = () => { flushPersist(); setDrag(null) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [drag, flushPersist, schedulePersist, updateState])
  useEffect(() => {
    if (!resize) return
    const move = (event: PointerEvent) => {
      updateState((current) => ({ ...current, cards: current.cards.map((card) => card.id !== resize.id ? card : { ...card, width: Math.max(220, Math.min(980, resize.card.width + event.clientX - resize.sx)), height: Math.max(150, Math.min(760, resize.card.height + event.clientY - resize.sy)), z: Math.max(...current.cards.map((item) => item.z)) + 1 }) }))
      schedulePersist()
    }
    const up = () => { flushPersist(); setResize(null) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [resize, flushPersist, schedulePersist, updateState])
  return <div className="workspace-canvas" data-canvas-project-id={project.id}>
    <div className="workspace-canvas-grid" />
    {state.cards.filter((card) => card.id !== 'browser' || browser).map((card) => <section key={card.id} className={'workspace-canvas-card canvas-' + card.id} data-canvas-card={card.id} style={{ left: card.x, top: card.y, width: card.width, height: card.height, zIndex: card.z }}>
      <header><strong>{labels[card.id].icon}{labels[card.id].label}</strong><button data-canvas-drag-handle type="button" aria-label={'Mover ' + labels[card.id].label} onPointerDown={(event) => { event.preventDefault(); setDrag({ id: card.id, sx: event.clientX, sy: event.clientY, card }) }}><Grip size={14} /></button></header>
      <div className="workspace-canvas-card-content">{card.id === 'workbench' ? workbench : card.id === 'browser' ? browser : <textarea data-canvas-note-editor value={state.note} onChange={(event) => updateState((current) => ({ ...current, note: event.target.value.slice(0, 12000) }))} placeholder="Tarefa, decisões, próximos passos…" />}</div>
      <button className="workspace-canvas-resize" data-canvas-resize-handle type="button" aria-label={'Redimensionar ' + labels[card.id].label} onPointerDown={(event) => { event.preventDefault(); setResize({ id: card.id, sx: event.clientX, sy: event.clientY, card }) }}><Maximize2 size={12} /></button>
    </section>)}
    <div className="workspace-canvas-legend"><FileText size={12} /> Layout salvo neste projeto · papéis: Coordenador, Código, Revisão e Testes</div>
  </div>
}
