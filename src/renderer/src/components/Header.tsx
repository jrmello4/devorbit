import React from 'react'
import { Search, RefreshCw, Minus, Square, X, Orbit, Command } from 'lucide-react'
interface HeaderProps {
  search: string
  setSearch: (value: string) => void
  onOpenCommandPalette: () => void
  onRefresh: () => void
  isRefreshing: boolean
}
export const Header: React.FC<HeaderProps> = ({search, setSearch, onOpenCommandPalette, onRefresh, isRefreshing}) => (
  <header className="app-titlebar titlebar-drag">
    <a href="#main" className="skip-link">Ir para área de trabalho</a>
    <div className="app-brand"><Orbit size={21} strokeWidth={1.7}/><strong>DevOrbit</strong></div>
    <span className="titlebar-location">Workspace local</span>
    <div className="global-search titlebar-no-drag">
      <Search size={15} aria-hidden="true"/>
      <label className="sr-only" htmlFor="project-search">Buscar projetos</label>
      <input id="project-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar projeto, pasta ou branch…" autoComplete="off"/>
      {search && <button className="icon-button" aria-label="Limpar busca" onClick={() => setSearch('')}><X size={14}/></button>}
      <button className="search-shortcut" onClick={onOpenCommandPalette} aria-label="Abrir ações rápidas" title="Ações rápidas (Ctrl+K)"><Command size={12}/><kbd>Ctrl K</kbd></button>
    </div>
    <button className="icon-button titlebar-no-drag" onClick={onRefresh} disabled={isRefreshing} aria-label="Atualizar projetos" title="Atualizar (Ctrl+R)"><RefreshCw size={15} className={isRefreshing ? 'spin' : ''}/></button>
    <div className="window-controls titlebar-no-drag">
      <button aria-label="Minimizar janela" onClick={() => window.devorbit?.windowControl('minimize')}><Minus size={14}/></button>
      <button aria-label="Maximizar janela" onClick={() => window.devorbit?.windowControl('maximize')}><Square size={12}/></button>
      <button aria-label="Fechar janela" onClick={() => window.devorbit?.windowControl('close')}><X size={16}/></button>
    </div>
  </header>
)
