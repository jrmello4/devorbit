import React, { useEffect, useId, useMemo, useState } from 'react'
import './EvolutionPanels.css'

export type DiffLineKind = 'add' | 'del' | 'context' | 'hunk' | 'meta'
export type DiffViewMode = 'inline' | 'side-by-side'

export interface SerializableDiffLine {
  kind: DiffLineKind
  content: string
  oldLine?: number
  newLine?: number
}

export interface SerializableDiff {
  filePath: string
  oldLabel?: string
  newLabel?: string
  lines: readonly SerializableDiffLine[]
}

export interface DiffLineStats {
  additions: number
  deletions: number
  context: number
}

export interface SideBySideDiffRow {
  kind: 'change' | 'context' | 'meta'
  left: SerializableDiffLine | null
  right: SerializableDiffLine | null
}

export interface DiffViewerProps {
  diff: SerializableDiff
  initialMode?: DiffViewMode
  onModeChange?: (mode: DiffViewMode) => void
}

export function getDiffLineStats(lines: readonly SerializableDiffLine[]): DiffLineStats {
  return lines.reduce<DiffLineStats>(
    (stats, line) => {
      if (line.kind === 'add') stats.additions += 1
      else if (line.kind === 'del') stats.deletions += 1
      else if (line.kind === 'context') stats.context += 1
      return stats
    },
    { additions: 0, deletions: 0, context: 0 },
  )
}

export function toSideBySideRows(lines: readonly SerializableDiffLine[]): SideBySideDiffRow[] {
  const rows: SideBySideDiffRow[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (line.kind === 'hunk' || line.kind === 'meta') {
      rows.push({ kind: 'meta', left: line, right: null })
      index += 1
      continue
    }

    if (line.kind === 'context') {
      rows.push({ kind: 'context', left: line, right: line })
      index += 1
      continue
    }

    const deleted: SerializableDiffLine[] = []
    const added: SerializableDiffLine[] = []
    while (index < lines.length && (lines[index].kind === 'del' || lines[index].kind === 'add')) {
      const changedLine = lines[index]
      if (changedLine.kind === 'del') deleted.push(changedLine)
      else added.push(changedLine)
      index += 1
    }

    const size = Math.max(deleted.length, added.length)
    for (let offset = 0; offset < size; offset += 1) {
      rows.push({
        kind: 'change',
        left: deleted[offset] || null,
        right: added[offset] || null,
      })
    }
  }

  return rows
}

function lineKindClass(kind: DiffLineKind): string {
  if (kind === 'add') return 'diff-viewer__line--add'
  if (kind === 'del') return 'diff-viewer__line--del'
  if (kind === 'hunk') return 'diff-viewer__line--hunk'
  if (kind === 'meta') return 'diff-viewer__line--meta'
  return 'diff-viewer__line--context'
}

function lineNumber(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
  diff,
  initialMode = 'inline',
  onModeChange,
}) => {
  const [mode, setMode] = useState<DiffViewMode>(initialMode)
  const headingId = useId()
  const stats = useMemo(() => getDiffLineStats(diff.lines), [diff.lines])
  const sideBySideRows = useMemo(() => toSideBySideRows(diff.lines), [diff.lines])

  useEffect(() => {
    setMode(initialMode)
  }, [initialMode])

  const changeMode = (nextMode: DiffViewMode) => {
    setMode(nextMode)
    onModeChange?.(nextMode)
  }

  return (
    <section className="diff-viewer" aria-labelledby={headingId}>
      <header className="diff-viewer__toolbar">
        <div className="diff-viewer__heading">
          <h2 id={headingId}>Alterações</h2>
          <code title={diff.filePath}>{diff.filePath}</code>
        </div>
        <div className="diff-viewer__controls">
          <span className="diff-viewer__stats" aria-label={stats.additions + ' adições e ' + stats.deletions + ' remoções'}>
            <span className="diff-viewer__stat diff-viewer__stat--add">+{stats.additions}</span>
            <span className="diff-viewer__stat diff-viewer__stat--del">−{stats.deletions}</span>
          </span>
          <div className="diff-viewer__mode" role="group" aria-label="Modo de visualização">
            <button
              type="button"
              className="evolution-button evolution-button--small"
              aria-pressed={mode === 'inline'}
              onClick={() => changeMode('inline')}
            >
              Inline
            </button>
            <button
              type="button"
              className="evolution-button evolution-button--small"
              aria-pressed={mode === 'side-by-side'}
              onClick={() => changeMode('side-by-side')}
            >
              Lado a lado
            </button>
          </div>
        </div>
      </header>

      <div className="diff-viewer__surface">
        {diff.lines.length > 0 ? (
          mode === 'inline' ? (
            <table className="diff-viewer__table">
              <caption className="evolution-visually-hidden">Diff inline de {diff.filePath}</caption>
              <tbody>
                {diff.lines.map((line, index) => (
                  <tr className={lineKindClass(line.kind)} key={line.kind + '-' + index}>
                    <td className="diff-viewer__gutter">{lineNumber(line.oldLine)}</td>
                    <td className="diff-viewer__gutter">{lineNumber(line.newLine)}</td>
                    <td className="diff-viewer__marker" aria-hidden="true">
                      {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : line.kind === 'context' ? ' ' : '·'}
                    </td>
                    <td className="diff-viewer__content">
                      <code>{line.content || ' '}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="diff-viewer__table diff-viewer__table--side">
              <caption className="evolution-visually-hidden">Diff lado a lado de {diff.filePath}</caption>
              <thead>
                <tr>
                  <th scope="col" colSpan={2}>{diff.oldLabel || 'Antes'}</th>
                  <th scope="col" colSpan={2}>{diff.newLabel || 'Depois'}</th>
                </tr>
              </thead>
              <tbody>
                {sideBySideRows.map((row, index) => row.kind === 'meta' ? (
                  <tr className="diff-viewer__line--meta" key={'meta-' + index}>
                    <td className="diff-viewer__gutter" colSpan={4}>
                      <code>{row.left?.content || ''}</code>
                    </td>
                  </tr>
                ) : (
                  <tr key={row.kind + '-' + index}>
                    <td className={'diff-viewer__gutter ' + (row.left ? lineKindClass(row.left.kind) : 'diff-viewer__line--empty')}>
                      {lineNumber(row.left?.oldLine)}
                    </td>
                    <td className={'diff-viewer__content ' + (row.left ? lineKindClass(row.left.kind) : 'diff-viewer__line--empty')}>
                      <code>{row.left?.content || ' '}</code>
                    </td>
                    <td className={'diff-viewer__gutter ' + (row.right ? lineKindClass(row.right.kind) : 'diff-viewer__line--empty')}>
                      {lineNumber(row.right?.newLine)}
                    </td>
                    <td className={'diff-viewer__content ' + (row.right ? lineKindClass(row.right.kind) : 'diff-viewer__line--empty')}>
                      <code>{row.right?.content || ' '}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <p className="evolution-empty">Nenhuma alteração para exibir.</p>
        )}
      </div>
    </section>
  )
}
