import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Braces,
  ChevronDown,
  ChevronUp,
  Circle,
  GitCompare,
  ListTree,
  FileText,
  FilePlus,
  Folder,
  FolderPlus,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import type { ProjectFileEntry } from '../types'
import './IntegratedWorkspace.css'

type NotificationType = 'success' | 'error' | 'info'

export interface WorkspaceEditorContext {
  path: string
  content: string
  selection: string
}

export interface WorkspaceEditorProps {
  projectPath: string
  onNotify: (message: string, type?: NotificationType) => void
  onContextChange?: (context: WorkspaceEditorContext) => void
  onDirtyChange?: (dirty: boolean) => void
}

interface EditorTab {
  path: string
  content: string
  savedContent: string
  selectionStart: number
  selectionEnd: number
  isSaving: boolean
}

interface SearchMatch {
  start: number
  end: number
}

interface SearchResults {
  matches: SearchMatch[]
  truncated: boolean
}

interface WorkspaceSymbol {
  name: string
  line: number
  offset: number
}

interface DiffLine {
  type: 'same' | 'added' | 'removed'
  text: string
}

const MAX_EDITOR_CONTENT_BYTES = 1_500_000
const MAX_OPEN_TABS = 12
const MAX_SEARCH_MATCHES = 1_000
const contentEncoder = new TextEncoder()

function fileName(filePath: string): string {
  return filePath.replaceAll('\\', '/').split('/').pop() || filePath
}

function fileDepth(filePath: string): number {
  return Math.max(0, filePath.replaceAll('\\', '/').split('/').length - 1)
}

function isDescendantPath(candidate: string, parent: string): boolean {
  const normalizedCandidate = candidate.replaceAll('\\', '/')
  const normalizedParent = parent.replaceAll('\\', '/').replace(/\/$/, '')
  return normalizedCandidate.startsWith(normalizedParent + '/')
}

function formatBytes(size?: number): string {
  if (size === undefined) return ''
  if (size < 1024) return size + ' B'
  return (size / 1024).toFixed(size < 1024 * 1024 ? 1 : 0) + (size < 1024 * 1024 ? ' KB' : ' MB')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function contentByteLength(content: string): number {
  return contentEncoder.encode(content).byteLength
}

function findSearchResults(content: string, query: string): SearchResults {
  if (!query) return { matches: [], truncated: false }

  const source = content.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  const matches: SearchMatch[] = []
  let offset = 0

  while (offset <= source.length) {
    const start = source.indexOf(needle, offset)
    if (start === -1) return { matches, truncated: false }
    if (matches.length >= MAX_SEARCH_MATCHES) return { matches, truncated: true }
    matches.push({ start, end: start + needle.length })
    offset = start + Math.max(needle.length, 1)
  }

  return { matches, truncated: false }
}


function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&#39;')
}

function highlightCode(content: string): string {
  const tokenPattern = /(\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|(?:\x60)(?:\\.|[^\x60])*(?:\x60)|\b(?:const|let|var|function|return|if|else|for|while|class|interface|type|import|from|export|async|await|new|true|false|null|undefined|public|private|extends|implements|throw|try|catch)\b|\b\d+(?:\.\d+)?\b)/g
  let cursor = 0
  let html = ''
  for (const match of content.matchAll(tokenPattern)) {
    const token = match[0]
    const index = match.index ?? cursor
    html += escapeHtml(content.slice(cursor, index))
    const tokenType = token.startsWith('//') || token.startsWith('/*') ? 'comment'
      : token.startsWith('\'') || token.startsWith('"') || token.startsWith('\x60') ? 'string'
        : /^\d/.test(token) ? 'number' : 'keyword'
    html += '<span class="syntax-' + tokenType + '">' + escapeHtml(token) + '</span>'
    cursor = index + token.length
  }
  html += escapeHtml(content.slice(cursor))
  return html || ' '
}

function extractSymbols(content: string): WorkspaceSymbol[] {
  const symbols: WorkspaceSymbol[] = []
  let offset = 0
  content.split('\n').forEach((line, index) => {
    const markdown = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/)
    const code = line.match(/^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/)
    const match = markdown || code
    if (match) symbols.push({ name: match[1], line: index + 1, offset })
    offset += line.length + 1
  })
  return symbols.slice(0, 300)
}

function buildDiff(previous: string, current: string): DiffLine[] {
  const before = previous.split('\n')
  const after = current.split('\n')
  const lines: DiffLine[] = []
  const length = Math.max(before.length, after.length)
  for (let index = 0; index < length; index += 1) {
    const oldLine = before[index]
    const newLine = after[index]
    if (oldLine === newLine) lines.push({ type: 'same', text: '  ' + (newLine ?? '') })
    else {
      if (oldLine !== undefined) lines.push({ type: 'removed', text: '- ' + oldLine })
      if (newLine !== undefined) lines.push({ type: 'added', text: '+ ' + newLine })
    }
  }
  return lines
}

function preferredFile(entries: ProjectFileEntry[]): ProjectFileEntry | undefined {
  const editable = entries.filter((entry) => entry.kind === 'file' && entry.editable !== false)
  return editable.find((entry) => /(^|[\\/])readme(?:\.md)?$/i.test(entry.path))
    || editable.find((entry) => fileName(entry.path).toLowerCase() === 'package.json')
    || editable[0]
}

export const WorkspaceEditor: React.FC<WorkspaceEditorProps> = ({
  projectPath,
  onNotify,
  onContextChange,
  onDirtyChange,
}) => {
  const [files, setFiles] = useState<ProjectFileEntry[]>([])
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set())
  const [truncatedDirectories, setTruncatedDirectories] = useState<Set<string>>(() => new Set())
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(() => new Set())
  const [tabs, setTabs] = useState<EditorTab[]>([])
  const [activePath, setActivePath] = useState('')
  const [isLoadingFiles, setIsLoadingFiles] = useState(true)
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set())
  const [fileError, setFileError] = useState('')
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [isSymbolsOpen, setIsSymbolsOpen] = useState(false)
  const [isDiffOpen, setIsDiffOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedEntryPath, setSelectedEntryPath] = useState('')
  const [selectedEntryKind, setSelectedEntryKind] = useState<'file' | 'directory' | ''>('')

  const editorRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLPreElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const tabsRef = useRef<EditorTab[]>([])
  const activePathRef = useRef('')
  const projectPathRef = useRef(projectPath)
  const openingPathsRef = useRef<Set<string>>(new Set())
  const searchQueryRef = useRef('')
  const contentLimitWarnedRef = useRef(false)
  const editorId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const editorTextAreaId = 'workspace-editor-' + editorId
  const searchInputId = 'workspace-editor-search-' + editorId

  tabsRef.current = tabs
  activePathRef.current = activePath
  projectPathRef.current = projectPath
  searchQueryRef.current = searchQuery

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.path === activePath),
    [activePath, tabs],
  )
  const searchResults = useMemo(
    () => findSearchResults(activeTab?.content || '', searchQuery),
    [activeTab?.content, searchQuery],
  )
  const activeSymbols = useMemo(
    () => extractSymbols(activeTab?.content || ''),
    [activeTab?.content],
  )
  const diffLines = useMemo(
    () => buildDiff(activeTab?.savedContent || '', activeTab?.content || ''),
    [activeTab?.content, activeTab?.savedContent],
  )

  const activeSearchMatchIndex = useMemo(() => {
    if (!activeTab) return -1
    return searchResults.matches.findIndex((match) => match.start === activeTab.selectionStart)
  }, [activeTab, searchResults.matches])

  const syncHighlightScroll = useCallback(() => {
    if (!highlightRef.current || !editorRef.current) return
    highlightRef.current.scrollTop = editorRef.current.scrollTop
    highlightRef.current.scrollLeft = editorRef.current.scrollLeft
  }, [])

  const focusEditor = useCallback(() => {
    window.requestAnimationFrame(() => editorRef.current?.focus())
  }, [])

  const updateLoadingPath = useCallback((path: string, isLoading: boolean) => {
    setLoadingPaths((current) => {
      const next = new Set(current)
      if (isLoading) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  const openFile = useCallback(async (entry: ProjectFileEntry) => {
    if (entry.kind !== 'file' || entry.editable === false) return

    const openTab = tabsRef.current.find((tab) => tab.path === entry.path)
    if (openTab) {
      setActivePath(openTab.path)
      setFileError('')
      focusEditor()
      return
    }

    if (openingPathsRef.current.has(entry.path)) return
    if (tabsRef.current.length >= MAX_OPEN_TABS) {
      onNotify('Feche uma aba antes de abrir outro arquivo.', 'info')
      return
    }

    openingPathsRef.current.add(entry.path)
    updateLoadingPath(entry.path, true)
    setFileError('')

    try {
      const loaded = await window.devorbit.readProjectFile(projectPath, entry.path)
      if (projectPathRef.current !== projectPath) return
      if (contentByteLength(loaded.content) > MAX_EDITOR_CONTENT_BYTES) {
        throw new Error('Este arquivo excede o limite de 1,5 MB do editor.')
      }

      const loadedPath = loaded.path || entry.path
      setTabs((current) => {
        if (current.some((tab) => tab.path === loadedPath)) return current
        return [
          ...current,
          {
            path: loadedPath,
            content: loaded.content,
            savedContent: loaded.content,
            selectionStart: 0,
            selectionEnd: 0,
            isSaving: false,
          },
        ]
      })
      setActivePath(loadedPath)
      focusEditor()
    } catch (error) {
      if (projectPathRef.current === projectPath) {
        const message = errorMessage(error)
        setFileError(message)
        onNotify('Não foi possível abrir ' + fileName(entry.path) + ': ' + message, 'error')
      }
    } finally {
      openingPathsRef.current.delete(entry.path)
      updateLoadingPath(entry.path, false)
    }
  }, [focusEditor, onNotify, projectPath, updateLoadingPath])

  const loadDirectory = useCallback(async (relativeDirectory: string) => {
    if (loadingDirectories.has(relativeDirectory)) return
    setLoadingDirectories((current) => new Set(current).add(relativeDirectory))

    try {
      const tree = await window.devorbit.listProjectFiles(
        projectPath,
        relativeDirectory || undefined,
      )
      if (projectPathRef.current !== projectPath) return

      setFiles((current) => {
        if (!relativeDirectory) return tree.entries
        if (current.some((entry) => entry.path === relativeDirectory && expandedDirectories.has(relativeDirectory))) {
          return current
        }
        const directoryIndex = current.findIndex((entry) => entry.path === relativeDirectory)
        if (directoryIndex < 0) return current
        const next = current.slice()
        next.splice(directoryIndex + 1, 0, ...tree.entries)
        return next
      })
      setTruncatedDirectories((current) => {
        const next = new Set(current)
        if (tree.truncated) next.add(relativeDirectory)
        else next.delete(relativeDirectory)
        return next
      })
      if (relativeDirectory) {
        setExpandedDirectories((current) => new Set(current).add(relativeDirectory))
      }
    } catch (error) {
      if (projectPathRef.current === projectPath) {
        const message = errorMessage(error)
        setFileError(message)
        onNotify('Não foi possível ler a pasta ' + (relativeDirectory || 'raiz') + ': ' + message, 'error')
      }
    } finally {
      setLoadingDirectories((current) => {
        const next = new Set(current)
        next.delete(relativeDirectory)
        return next
      })
    }
  }, [expandedDirectories, loadingDirectories, onNotify, projectPath])

  const toggleDirectory = useCallback((entry: ProjectFileEntry) => {
    if (entry.kind !== 'directory') return
    if (expandedDirectories.has(entry.path)) {
      setExpandedDirectories((current) => {
        const next = new Set(current)
        for (const directory of next) {
          if (directory === entry.path || isDescendantPath(directory, entry.path)) next.delete(directory)
        }
        return next
      })
      setFiles((current) => current.filter((candidate) => !isDescendantPath(candidate.path, entry.path)))
      setTruncatedDirectories((current) => {
        const next = new Set(current)
        for (const directory of next) {
          if (directory === entry.path || isDescendantPath(directory, entry.path)) next.delete(directory)
        }
        return next
      })
      return
    }
    void loadDirectory(entry.path)
  }, [expandedDirectories, loadDirectory])

  const loadFiles = useCallback(async () => {
    setIsLoadingFiles(true)
    setFileError('')

    try {
      const tree = await window.devorbit.listProjectFiles(projectPath)
      if (projectPathRef.current !== projectPath) return
      setFiles(tree.entries)
      setExpandedDirectories(new Set())
      setLoadingDirectories(new Set())
      setTruncatedDirectories(tree.truncated ? new Set(['']) : new Set())

      if (!activePathRef.current) {
        const initialFile = preferredFile(tree.entries)
        if (initialFile) void openFile(initialFile)
      }
    } catch (error) {
      if (projectPathRef.current === projectPath) {
        const message = errorMessage(error)
        setFileError(message)
        onNotify('Não foi possível ler os arquivos do projeto: ' + message, 'error')
      }
    } finally {
      if (projectPathRef.current === projectPath) setIsLoadingFiles(false)
    }
  }, [onNotify, openFile, projectPath])

  const createEntry = useCallback(async (kind: 'file' | 'directory') => {
    const suggestedParent = files.find((entry) => entry.path === selectedEntryPath)?.kind === 'directory'
      ? selectedEntryPath.replaceAll('\\', '/') + '/'
      : ''
    const requested = window.prompt(kind === 'file' ? 'Caminho do novo arquivo:' : 'Caminho da nova pasta:', suggestedParent)
    if (!requested?.trim()) return
    try {
      if (kind === 'file') {
        const created = await window.devorbit.createProjectFile(projectPath, requested.trim())
        setSelectedEntryPath(created.path)
        setSelectedEntryKind('file')
        onNotify('Arquivo criado: ' + created.path, 'success')
        await loadFiles()
        void openFile({ path: created.path, name: fileName(created.path), kind: 'file', size: 0, editable: true })
      } else {
        const created = await window.devorbit.createProjectDirectory(projectPath, requested.trim())
        setSelectedEntryPath(created.path)
        setSelectedEntryKind('directory')
        onNotify('Pasta criada: ' + created.path, 'success')
        await loadFiles()
      }
    } catch (error) {
      onNotify('Não foi possível criar: ' + errorMessage(error), 'error')
    }
  }, [files, loadFiles, onNotify, openFile, projectPath, selectedEntryPath])

  const moveSelectedEntry = useCallback(async () => {
    if (!selectedEntryPath) return
    const destination = window.prompt('Novo caminho para o item:', selectedEntryPath.replaceAll('\\', '/'))
    if (!destination?.trim() || destination.trim() === selectedEntryPath) return
    const affectedTabs = tabsRef.current.filter((tab) => tab.path === selectedEntryPath || isDescendantPath(tab.path, selectedEntryPath))
    if (affectedTabs.some((tab) => tab.content !== tab.savedContent) && !window.confirm('O item contém alterações não salvas. Renomear ou mover mesmo assim?')) return
    try {
      const moved = await window.devorbit.moveProjectEntry(projectPath, selectedEntryPath, destination.trim())
      const mapPath = (current: string) => current === moved.from
        ? moved.path
        : isDescendantPath(current, moved.from)
          ? moved.path + current.slice(moved.from.length)
          : current
      setTabs((current) => current.map((tab) => ({ ...tab, path: mapPath(tab.path) })))
      setActivePath((current) => mapPath(current))
      setSelectedEntryPath(moved.path)
      onNotify('Item movido para: ' + moved.path, 'success')
      await loadFiles()
    } catch (error) {
      onNotify('Não foi possível renomear ou mover: ' + errorMessage(error), 'error')
    }
  }, [loadFiles, onNotify, projectPath, selectedEntryPath])

  const deleteSelectedEntry = useCallback(async () => {
    if (!selectedEntryPath) return
    const affectedTabs = tabsRef.current.filter((tab) => tab.path === selectedEntryPath || isDescendantPath(tab.path, selectedEntryPath))
    const warning = affectedTabs.some((tab) => tab.content !== tab.savedContent) ? ' Há alterações não salvas que serão perdidas.' : ''
    if (!window.confirm('Excluir ' + selectedEntryPath + '?' + warning)) return
    try {
      await window.devorbit.deleteProjectEntry(projectPath, selectedEntryPath, { recursive: selectedEntryKind === 'directory' })
      const nextTabs = tabsRef.current.filter((tab) => !affectedTabs.includes(tab))
      tabsRef.current = nextTabs
      setTabs(nextTabs)
      if (affectedTabs.some((tab) => tab.path === activePathRef.current)) {
        const nextPath = nextTabs.at(-1)?.path || ''
        activePathRef.current = nextPath
        setActivePath(nextPath)
      }
      setSelectedEntryPath('')
      setSelectedEntryKind('')
      onNotify('Item excluído: ' + selectedEntryPath, 'success')
      await loadFiles()
    } catch (error) {
      onNotify('Não foi possível excluir: ' + errorMessage(error), 'error')
    }
  }, [loadFiles, onNotify, projectPath, selectedEntryKind, selectedEntryPath])

  useEffect(() => {
    onDirtyChange?.(tabs.some((tab) => tab.content !== tab.savedContent))
  }, [onDirtyChange, tabs])

  useEffect(() => {
    tabsRef.current = []
    activePathRef.current = ''
    openingPathsRef.current.clear()
    setFiles([])
    setExpandedDirectories(new Set())
    setTruncatedDirectories(new Set())
    setLoadingDirectories(new Set())
    setTabs([])
    setActivePath('')
    setLoadingPaths(new Set())
    setIsSearchOpen(false)
    setIsSymbolsOpen(false)
    setIsDiffOpen(false)
    setSearchQuery('')
    setSelectedEntryPath('')
    setSelectedEntryKind('')
    void loadFiles()
  }, [loadFiles])

  useEffect(() => {
    if (!isSearchOpen) return
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [isSearchOpen])

  const saveTab = useCallback(async (pathToSave: string) => {
    const tab = tabsRef.current.find((candidate) => candidate.path === pathToSave)
    if (!tab || tab.isSaving || tab.content === tab.savedContent) return

    const contentAtStart = tab.content
    setTabs((current) => current.map((candidate) => (
      candidate.path === pathToSave ? { ...candidate, isSaving: true } : candidate
    )))

    try {
      const saved = await window.devorbit.saveProjectFile(projectPath, pathToSave, contentAtStart)
      if (projectPathRef.current !== projectPath) return

      setTabs((current) => current.map((candidate) => {
        if (candidate.path !== pathToSave) return candidate
        return {
          ...candidate,
          savedContent: saved.content,
          content: candidate.content === contentAtStart ? saved.content : candidate.content,
          isSaving: false,
        }
      }))
      onNotify('Arquivo salvo: ' + fileName(saved.path), 'success')
    } catch (error) {
      if (projectPathRef.current === projectPath) {
        onNotify('Não foi possível salvar o arquivo: ' + errorMessage(error), 'error')
      }
    } finally {
      setTabs((current) => current.map((candidate) => (
        candidate.path === pathToSave ? { ...candidate, isSaving: false } : candidate
      )))
    }
  }, [onNotify, projectPath])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      const key = event.key.toLowerCase()

      if (key === 's') {
        event.preventDefault()
        if (activePathRef.current) void saveTab(activePathRef.current)
        return
      }

      if (key !== 'f' || !activePathRef.current) return
      event.preventDefault()
      const tab = tabsRef.current.find((candidate) => candidate.path === activePathRef.current)
      const selected = tab && tab.selectionEnd > tab.selectionStart
        ? tab.content.slice(tab.selectionStart, tab.selectionEnd).slice(0, 120)
        : ''
      setIsSearchOpen(true)
      if (!searchQueryRef.current && selected) setSearchQuery(selected)
      window.requestAnimationFrame(() => {
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      })
    }

    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [saveTab])

  const updateSelection = useCallback((event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const target = event.currentTarget
    setTabs((current) => current.map((tab) => (
      tab.path === activePathRef.current
        ? { ...tab, selectionStart: target.selectionStart, selectionEnd: target.selectionEnd }
        : tab
    )))
  }, [])

  const handleEditorChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextContent = event.currentTarget.value
    if (contentByteLength(nextContent) > MAX_EDITOR_CONTENT_BYTES) {
      if (!contentLimitWarnedRef.current) {
        onNotify('O conteúdo excede o limite de 1,5 MB do editor.', 'error')
        contentLimitWarnedRef.current = true
      }
      return
    }

    contentLimitWarnedRef.current = false
    const { selectionStart, selectionEnd } = event.currentTarget
    setTabs((current) => current.map((tab) => (
      tab.path === activePathRef.current
        ? { ...tab, content: nextContent, selectionStart, selectionEnd }
        : tab
    )))
  }, [onNotify])

  const closeTab = useCallback((pathToClose: string) => {
    const tab = tabsRef.current.find((candidate) => candidate.path === pathToClose)
    if (!tab) return
    if (tab.isSaving) {
      onNotify('Aguarde o salvamento terminar antes de fechar esta aba.', 'info')
      return
    }
    if (tab.content !== tab.savedContent && !window.confirm('Há alterações não salvas em ' + fileName(tab.path) + '. Fechar a aba e descartar?')) return

    const tabIndex = tabsRef.current.findIndex((candidate) => candidate.path === pathToClose)
    const nextTabs = tabsRef.current.filter((candidate) => candidate.path !== pathToClose)
    tabsRef.current = nextTabs
    setTabs(nextTabs)

    if (activePathRef.current === pathToClose) {
      const nextActiveTab = nextTabs[Math.min(tabIndex, nextTabs.length - 1)]
      const nextActivePath = nextActiveTab?.path || ''
      activePathRef.current = nextActivePath
      setActivePath(nextActivePath)
      if (!nextActivePath) {
        setIsSearchOpen(false)
        setSearchQuery('')
      } else {
        focusEditor()
      }
    }
  }, [focusEditor, onNotify])

  const moveToSearchMatch = useCallback((direction: 1 | -1) => {
    if (!activePathRef.current || searchResults.matches.length === 0) return

    const currentStart = tabsRef.current.find((tab) => tab.path === activePathRef.current)?.selectionStart ?? 0
    let matchIndex: number
    if (direction > 0) {
      matchIndex = searchResults.matches.findIndex((match) => match.start > currentStart)
      if (matchIndex === -1) matchIndex = 0
    } else {
      matchIndex = -1
      for (let index = searchResults.matches.length - 1; index >= 0; index -= 1) {
        if (searchResults.matches[index].start < currentStart) {
          matchIndex = index
          break
        }
      }
      if (matchIndex === -1) matchIndex = searchResults.matches.length - 1
    }

    const match = searchResults.matches[matchIndex]
    setTabs((current) => current.map((tab) => (
      tab.path === activePathRef.current
        ? { ...tab, selectionStart: match.start, selectionEnd: match.end }
        : tab
    )))
    window.requestAnimationFrame(() => {
      const editor = editorRef.current
      if (!editor) return
      editor.focus()
      editor.setSelectionRange(match.start, match.end)
    })
  }, [searchResults.matches])

  const handleSearchSubmit = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    moveToSearchMatch(1)
  }, [moveToSearchMatch])

  const sendToContext = useCallback(() => {
    const tab = tabsRef.current.find((candidate) => candidate.path === activePathRef.current)
    if (!tab) return
    if (!onContextChange) {
      onNotify('O contexto ainda não está conectado a este editor.', 'info')
      return
    }

    onContextChange({
      path: tab.path,
      content: tab.content,
      selection: tab.content.slice(tab.selectionStart, tab.selectionEnd),
    })
    onNotify('Arquivo enviado ao contexto: ' + fileName(tab.path), 'success')
  }, [onContextChange, onNotify])

  const activeIsLoading = activePath ? loadingPaths.has(activePath) : false
  const activeIsDirty = Boolean(activeTab && activeTab.content !== activeTab.savedContent)
  const fileCount = files.filter((entry) => entry.kind === 'file').length
  const searchCountLabel = !searchQuery
    ? 'Digite para buscar'
    : searchResults.matches.length === 0
      ? 'Nenhuma ocorrência'
      : `${activeSearchMatchIndex >= 0 ? activeSearchMatchIndex + 1 : 1}/${searchResults.matches.length}${searchResults.truncated ? '+' : ''}`

  return (
    <section className="workspace-code-area" style={{ height: '100%' }} aria-label="Editor de arquivos do projeto">
      <aside className="workspace-file-panel" aria-label="Arquivos do projeto">
        <div className="workspace-panel-heading">
          <div>
            <strong><Folder size={14} aria-hidden="true" /> Arquivos</strong>
            <span>{fileCount}</span>
          </div>
          <div className="editor-actions">
          <button type="button" className="workspace-icon-button" onClick={() => void createEntry('file')} aria-label="Novo arquivo" title="Novo arquivo"><FilePlus size={14} aria-hidden="true" /></button>
          <button type="button" className="workspace-icon-button" onClick={() => void createEntry('directory')} aria-label="Nova pasta" title="Nova pasta"><FolderPlus size={14} aria-hidden="true" /></button>
          <button type="button" className="workspace-icon-button" onClick={() => void moveSelectedEntry()} disabled={!selectedEntryPath} aria-label="Renomear ou mover item" title="Renomear ou mover"><Pencil size={14} aria-hidden="true" /></button>
          <button type="button" className="workspace-icon-button" onClick={() => void deleteSelectedEntry()} disabled={!selectedEntryPath} aria-label="Excluir item" title="Excluir"><Trash2 size={14} aria-hidden="true" /></button>
          <button
            type="button"
            className="workspace-icon-button"
            onClick={() => void loadFiles()}
            disabled={isLoadingFiles}
            aria-label="Atualizar arquivos"
            title="Atualizar arquivos"
            aria-busy={isLoadingFiles}
          >
            <RefreshCw size={14} aria-hidden="true" />
          </button>
          </div>
        </div>

        <div className="workspace-file-list" role="list" aria-busy={isLoadingFiles}>
          {isLoadingFiles && <p className="workspace-muted" role="status">Lendo arquivos…</p>}
          {!isLoadingFiles && !files.length && <p className="workspace-muted">Nenhum arquivo encontrado.</p>}
          {!isLoadingFiles && files.map((entry) => {
            const isOpen = tabs.some((tab) => tab.path === entry.path)
            const isLoading = loadingPaths.has(entry.path)
            const isDirectory = entry.kind === 'directory'
            const isExpanded = expandedDirectories.has(entry.path)
            const isDirectoryLoading = loadingDirectories.has(entry.path)
            return (
              <button
                type="button"
                key={entry.path}
                className={'workspace-file-row' + (selectedEntryPath === entry.path || activePath === entry.path ? ' selected' : '') + (entry.kind === 'directory' ? ' directory' : '')}
                style={{ paddingLeft: 10 + fileDepth(entry.path) * 12 }}
                onClick={() => { setSelectedEntryPath(entry.path); setSelectedEntryKind(entry.kind); if (isDirectory) toggleDirectory(entry); else void openFile(entry) }}
                disabled={isDirectory ? isDirectoryLoading : entry.editable === false || isLoading}
                title={entry.editable === false ? 'Arquivo somente leitura ou binário' : entry.path}
                aria-current={activePath === entry.path ? 'page' : undefined}
                aria-busy={isDirectory ? isDirectoryLoading : isLoading}
                aria-expanded={isDirectory ? isExpanded : undefined}
              >
                {isDirectory
                  ? <><ChevronDown size={13} aria-hidden="true" style={{ transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)' }} /><Folder size={14} aria-hidden="true" /></>
                  : <FileText size={14} aria-hidden="true" />}
                <span>{entry.name}</span>
                {entry.kind === 'file' && <small>{isOpen ? 'aberto' : formatBytes(entry.size)}</small>}
              </button>
            )
          })}
          {!isLoadingFiles && truncatedDirectories.size > 0 && (
            <p className="workspace-muted" role="status">
              {truncatedDirectories.has('')
                ? 'A raiz do projeto tem mais de 600 itens; alguns não foram exibidos.'
                : 'Uma pasta tem mais de 600 itens; alguns não foram exibidos.'}
            </p>
          )}
        </div>
        {fileError && <p className="workspace-error workspace-file-error" role="alert"><AlertCircle size={13} aria-hidden="true" />{fileError}</p>}
      </aside>

      <section className="workspace-editor-panel" aria-label="Editor de texto">
        {/* Cabeçalho único de 32px (spec do painel): rótulo + abas ao lado +
            ações à direita como ícones de 28px. Os atributos title preservam os
            seletores usados pelo harness (scripts/verify-ui.cjs) — não renomear. */}
        <div className="workspace-panel-heading editor-heading">
          <strong className="editor-heading-label"><FileText size={13} aria-hidden="true" /> Editor</strong>
          {tabs.length > 0 && (
            <div className="editor-tabs" role="tablist" aria-label="Arquivos abertos">
              {tabs.map((tab) => {
                const isActive = tab.path === activePath
                const isDirty = tab.content !== tab.savedContent
                return (
                  <div key={tab.path} className="editor-tab-item">
                    <button
                      type="button"
                      role="tab"
                      className={'workspace-tool-button' + (isActive ? ' active' : '')}
                      onClick={() => { setActivePath(tab.path); focusEditor() }}
                      aria-selected={isActive}
                      aria-controls={editorTextAreaId}
                      title={tab.path}
                    >
                      <FileText size={13} aria-hidden="true" />
                      <span>{fileName(tab.path)}</span>
                      {isDirty && <Circle size={6} fill="currentColor" aria-label="Não salvo" />}
                    </button>
                    <button
                      type="button"
                      className="workspace-icon-button editor-tab-close"
                      onClick={() => closeTab(tab.path)}
                      aria-label={'Fechar aba ' + fileName(tab.path)}
                      title="Fechar aba"
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
          <div className="editor-actions">
            {activeIsDirty && <span className="editor-dirty" title="Alterações não salvas">Não salvo</span>}
            <button
              type="button"
              className={'workspace-icon-button' + (isSearchOpen ? ' active' : '')}
              onClick={() => setIsSearchOpen(true)}
              disabled={!activeTab}
              aria-pressed={isSearchOpen}
              aria-label="Buscar no arquivo atual"
              title="Buscar no arquivo atual (Ctrl+F)"
            >
              <Search size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={'workspace-icon-button' + (isSymbolsOpen ? ' active' : '')}
              onClick={() => setIsSymbolsOpen((current) => !current)}
              disabled={!activeTab}
              aria-pressed={isSymbolsOpen}
              aria-label="Símbolos do arquivo atual"
              title="Mostrar símbolos do arquivo atual"
            >
              <ListTree size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={'workspace-icon-button' + (isDiffOpen ? ' active' : '')}
              onClick={() => setIsDiffOpen((current) => !current)}
              disabled={!activeTab || !activeIsDirty}
              aria-pressed={isDiffOpen}
              aria-label="Ver alterações não salvas"
              title="Ver alterações não salvas"
            >
              <GitCompare size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="workspace-icon-button"
              onClick={sendToContext}
              disabled={!activeTab}
              aria-label="Enviar arquivo ao contexto"
              title="Enviar arquivo ao contexto"
            >
              <Send size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="workspace-icon-button editor-save-button"
              onClick={() => { if (activePath) void saveTab(activePath) }}
              disabled={!activeTab || !activeIsDirty || activeTab.isSaving}
              aria-busy={activeTab?.isSaving || false}
              aria-label={activeTab?.isSaving ? 'Salvando arquivo' : 'Salvar arquivo'}
              title="Salvar arquivo (Ctrl+S)"
            >
              <Save size={15} aria-hidden="true" />
            </button>
          </div>
        </div>

        {isSymbolsOpen && activeTab && (
          <div className="workspace-symbol-list" aria-label="Símbolos do arquivo">
            {activeSymbols.length === 0 && <span className="workspace-muted">Nenhum símbolo encontrado.</span>}
            {activeSymbols.map((symbol) => (
              <button
                key={symbol.offset + symbol.name}
                type="button"
                className="workspace-symbol"
                onClick={() => {
                  setIsSymbolsOpen(false)
                  window.requestAnimationFrame(() => {
                    editorRef.current?.focus()
                    editorRef.current?.setSelectionRange(symbol.offset, symbol.offset + symbol.name.length)
                  })
                }}
                title={'Ir para a linha ' + symbol.line}
              >
                <Braces size={13} aria-hidden="true" /><span>{symbol.name}</span><small>L{symbol.line}</small>
              </button>
            ))}
          </div>
        )}

        {isSearchOpen && (
          <form className="workspace-browser-form" onSubmit={handleSearchSubmit} role="search">
            <label className="sr-only" htmlFor={searchInputId}>Buscar no arquivo atual</label>
            <input
              ref={searchInputRef}
              id={searchInputId}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                moveToSearchMatch(event.shiftKey ? -1 : 1)
              }}
              placeholder="Buscar no arquivo atual"
              spellCheck={false}
              autoComplete="off"
              disabled={!activeTab}
              aria-describedby={searchInputId + '-count'}
            />
            <span id={searchInputId + '-count'} aria-live="polite" style={{ minWidth: 96, color: 'var(--color-text-muted)', fontSize: 10, whiteSpace: 'nowrap' }}>
              {searchCountLabel}
            </span>
            <button type="button" className="workspace-send-button" onClick={() => moveToSearchMatch(-1)} disabled={!searchResults.matches.length} aria-label="Resultado anterior" title="Resultado anterior">
              <ChevronUp size={14} aria-hidden="true" />
            </button>
            <button type="button" className="workspace-send-button" onClick={() => moveToSearchMatch(1)} disabled={!searchResults.matches.length} aria-label="Próximo resultado" title="Próximo resultado">
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            <button type="button" className="workspace-send-button" onClick={() => setIsSearchOpen(false)} aria-label="Fechar busca" title="Fechar busca">
              <X size={14} aria-hidden="true" />
            </button>
          </form>
        )}

        {isDiffOpen && activeTab ? (
          <pre className="workspace-diff-view" aria-label="Alterações não salvas">
            {diffLines.map((line, index) => (
              <span key={index} className={'diff-line ' + line.type}>{line.text}{'\n'}</span>
            ))}
          </pre>
        ) : (
          <div className="workspace-editor-shell">
            <pre
              ref={highlightRef}
              className="workspace-editor-highlight"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: highlightCode(activeTab?.content || '') }}
            />
            <textarea
              ref={editorRef}
              id={editorTextAreaId}
              className="workspace-editor workspace-editor-input"
              value={activeTab?.content || ''}
              onChange={handleEditorChange}
              onSelect={updateSelection}
              onClick={updateSelection}
              onKeyUp={updateSelection}
              onScroll={syncHighlightScroll}
              placeholder="Selecione um arquivo para começar."
              spellCheck={false}
              aria-label={activeTab ? 'Editando ' + activeTab.path : 'Editor de texto'}
              disabled={!activeTab || activeIsLoading}
              role="tabpanel"
              aria-live="off"
            />
          </div>
        )}
        {activeIsLoading && <div className="workspace-editor-loading" role="status">Abrindo arquivo…</div>}
      </section>
    </section>
  )
}
