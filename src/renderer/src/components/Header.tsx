import React from 'react'
import { Search, RefreshCw, Minus, Square, X, Orbit, Command, Moon, Sun } from 'lucide-react'
import type { ThemeMode } from '../theme'
interface HeaderProps {
  search: string
  setSearch: (value: string) => void
  onOpenCommandPalette: () => void
  onRefresh: () => void
  isRefreshing: boolean
  theme: ThemeMode
  onToggleTheme: () => void
}
export const Header: React.FC<HeaderProps> = ({search, setSearch, onOpenCommandPalette, onRefresh, isRefreshing, theme, onToggleTheme}) => (
  <header className="app-titlebar titlebar-drag">
    <a href="#main" className="skip-link">Ir para área de trabalho</a>
    <div className="app-brand"><Orbit size={21} strokeWidth={1.7} aria-hidden="true"/><strong>DevOrbit</strong></div>
    <span className="titlebar-location">Workspace local</span>
    <div className="global-search titlebar-no-drag">
      <Search size={15} aria-hidden="true"/>
      <label className="sr-only" htmlFor="project-search">Buscar projeto, pasta, branch ou tecnologia</label>
      <input id="project-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar projeto, pasta, branch ou tecnologia…" autoComplete="off"/>
      {search && <button type="button" className="icon-button" aria-label="Limpar busca" onClick={() => setSearch('')}><X size={14} aria-hidden="true"/></button>}
      <button type="button" className="search-shortcut" onClick={onOpenCommandPalette} aria-label="Abrir ações rápidas" title="Ações rápidas (Ctrl+K)"><Command size={12} aria-hidden="true"/><kbd>Ctrl K</kbd></button>
    </div>
    <button type="button" className="icon-button titlebar-no-drag" onClick={onRefresh} disabled={isRefreshing} aria-label="Atualizar projetos" title="Atualizar (Ctrl+R)"><RefreshCw size={15} className={isRefreshing ? 'spin' : ''} aria-hidden="true"/></button>
    <button type="button" className="icon-button titlebar-no-drag" onClick={onToggleTheme} aria-label={theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro'} title={theme === 'light' ? 'Tema escuro' : 'Tema claro'}>{theme === 'light' ? <Moon size={15} aria-hidden="true"/> : <Sun size={15} aria-hidden="true"/>}</button>
    <div className="window-controls titlebar-no-drag">
      <button type="button" aria-label="Minimizar janela" onClick={() => window.devorbit?.windowControl('minimize')}><Minus size={14} aria-hidden="true"/></button>
      <button type="button" aria-label="Maximizar janela" onClick={() => window.devorbit?.windowControl('maximize')}><Square size={12} aria-hidden="true"/></button>
      <button type="button" aria-label="Fechar janela" onClick={() => window.devorbit?.windowControl('close')}><X size={16} aria-hidden="true"/></button>
    </div>
  </header>
)
