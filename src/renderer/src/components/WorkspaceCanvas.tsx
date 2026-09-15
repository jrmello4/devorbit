import React, { useEffect, useRef, useState } from 'react'
import { FileText, Globe, Grip, StickyNote, Terminal } from 'lucide-react'
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
    if (Array.isArray(value.cards) && value.cards.length === defaults.length) return { cards: value.cards as Card[], note: typeof value.note === 'string' ? value.note.slice(0, 12000) : '' }
  } catch { /* use defaults */ }
  return { cards: defaults, note: '' }
}
const labels: Record<CardKind, { label: string; icon: React.ReactNode }> = {
  workbench: { label: 'Editor e terminais', icon: <Terminal size={13} /> },
  browser: { label: 'Navegador do projeto', icon: <Globe size={13} /> },
  notes: { label: 'Notas e handoff', icon: <StickyNote size={13} /> },
}
export const WorkspaceCanvas: React.FC<{ project: Project; workbench: React.ReactNode; browser: React.ReactNode }> = ({ project, workbench, browser }) => {
  const [state, setState] = useState<StoredCanvas>(() => read(project.id))
  const [drag, setDrag] = useState<{ id: CardKind; sx: number; sy: number; card: Card } | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  useEffect(() => { try { window.localStorage.setItem(key(project.id), JSON.stringify(state)) } catch { /* optional */ } }, [project.id, state])
  useEffect(() => {
    if (!drag) return
    const move = (event: PointerEvent) => setState((current) => ({ ...current, cards: current.cards.map((card) => card.id !== drag.id ? card : { ...card, x: Math.max(8, card.x + event.clientX - drag.sx), y: Math.max(8, card.y + event.clientY - drag.sy), z: Math.max(...current.cards.map((item) => item.z)) + 1 }) }))
    const up = () => setDrag(null)
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [drag])
  return <div ref={canvasRef} className="workspace-canvas" data-canvas-project-id={project.id}>
    <div className="workspace-canvas-grid" />
    {state.cards.map((card) => <section key={card.id} className={'workspace-canvas-card canvas-' + card.id} data-canvas-card={card.id} style={{ left: card.x, top: card.y, width: card.width, height: card.height, zIndex: card.z }}>
      <header><strong>{labels[card.id].icon}{labels[card.id].label}</strong><button data-canvas-drag-handle type="button" aria-label={'Mover ' + labels[card.id].label} onPointerDown={(event) => { event.preventDefault(); setDrag({ id: card.id, sx: event.clientX, sy: event.clientY, card }) }}><Grip size={14} /></button></header>
      <div className="workspace-canvas-card-content">{card.id === 'workbench' ? workbench : card.id === 'browser' ? browser : <textarea data-canvas-note-editor value={state.note} onChange={(event) => setState((current) => ({ ...current, note: event.target.value.slice(0, 12000) }))} placeholder="Tarefa, decisões, próximos passos…" />}</div>
    </section>)}
    <div className="workspace-canvas-legend"><FileText size={12} /> Layout salvo neste projeto · papéis: Coordenador, Código, Revisão e Testes</div>
  </div>
}
