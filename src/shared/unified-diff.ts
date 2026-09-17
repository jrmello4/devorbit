export type UnifiedDiffLineKind = 'context' | 'add' | 'remove'

export interface UnifiedDiffLine {
  kind: UnifiedDiffLineKind
  text: string
  noNewlineAtEnd?: 'old' | 'new' | 'both'
}

export interface UnifiedDiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  heading?: string
  lines: readonly UnifiedDiffLine[]
}

export interface UnifiedDiffFile {
  oldPath: string
  newPath: string
  hunks: readonly UnifiedDiffHunk[]
}

export interface UnifiedDiffDocument {
  files: readonly UnifiedDiffFile[]
}

export interface UnifiedDiffOptions {
  filePath?: string
  oldPath?: string
  newPath?: string
  contextLines?: number
  context?: number
}

export type UnifiedDiffValidationOutcome =
  | boolean
  | void
  | string
  | { valid: boolean; message?: string }

export type UnifiedDiffValidationResult = UnifiedDiffValidationOutcome | Promise<UnifiedDiffValidationOutcome>

export type UnifiedDiffValidationHook = (
  content: string,
  context: { source: string; diff: UnifiedDiffDocument }
) => UnifiedDiffValidationResult

export interface ApplyUnifiedDiffOptions {
  validate?: UnifiedDiffValidationHook
  validateSyntax?: UnifiedDiffValidationHook
  syntaxValidator?: UnifiedDiffValidationHook
}

export type UnifiedDiffConflictReason =
  | 'context-not-found'
  | 'context-ambiguous'
  | 'unanchored-insertion'
  | 'invalid-diff'
  | 'validation-failed'

export interface UnifiedDiffConflict {
  filePath?: string
  hunkIndex: number
  reason: UnifiedDiffConflictReason
  message: string
  expected: readonly string[]
  candidates: readonly number[]
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}

export interface UnifiedDiffHunkResult {
  hunkIndex: number
  status: 'applied' | 'conflict'
  position?: number
  candidates: readonly number[]
}

export interface ApplyUnifiedDiffResult {
  status: 'applied' | 'unchanged' | 'conflict' | 'invalid' | 'validation-failed'
  ok: boolean
  applied: boolean
  changed: boolean
  content: string
  conflicts: readonly UnifiedDiffConflict[]
  hunks: readonly UnifiedDiffHunkResult[]
  diff?: UnifiedDiffDocument
  error?: string
}

export interface ApplyUnifiedDiffToFilesResult {
  status: 'applied' | 'unchanged' | 'conflict' | 'invalid' | 'validation-failed'
  ok: boolean
  applied: boolean
  changed: boolean
  files: Readonly<Record<string, string>>
  conflicts: readonly UnifiedDiffConflict[]
  hunks: readonly UnifiedDiffHunkResult[]
  diff?: UnifiedDiffDocument
  error?: string
}

interface TextLines {
  lines: string[]
  eol: string
  trailingNewline: boolean
}

interface DiffOp {
  kind: UnifiedDiffLineKind
  text: string
  oldIndex?: number
  newIndex?: number
}

const HUNK_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/
const DEFAULT_CONTEXT_LINES = 3

function splitText(value: string): TextLines {
  const trailingNewline = /(?:\r\n|\n|\r)$/.test(value)
  const eol = value.includes('\r\n') ? '\r\n' : value.includes('\r') ? '\r' : '\n'
  const normalized = value.replace(/\r\n|\r/g, '\n')
  const parts = normalized.split('\n')
  if (trailingNewline) parts.pop()
  return { lines: parts.length === 1 && parts[0] === '' ? [] : parts, eol, trailingNewline }
}

function normalizedDiffLines(value: string): string[] {
  return splitText(value).lines
}

function backtrackDiff(trace: readonly Map<number, number>[], a: readonly string[], b: readonly string[], depth: number): DiffOp[] {
  let x = a.length
  let y = b.length
  const result: DiffOp[] = []

  for (let d = depth; d > 0; d -= 1) {
    const previous = trace[d]
    const k = x - y
    const down = k === -d || (k !== d && (previous?.get(k - 1) ?? -1) < (previous?.get(k + 1) ?? -1))
    const previousK = down ? k + 1 : k - 1
    const previousX = previous?.get(previousK) ?? 0
    const previousY = previousX - previousK

    while (x > previousX && y > previousY) {
      result.push({ kind: 'context', text: a[x - 1] ?? '' })
      x -= 1
      y -= 1
    }

    if (x === previousX) {
      result.push({ kind: 'add', text: b[y - 1] ?? '' })
      y -= 1
    } else {
      result.push({ kind: 'remove', text: a[x - 1] ?? '' })
      x -= 1
    }
  }

  while (x > 0 && y > 0) {
    result.push({ kind: 'context', text: a[x - 1] ?? '' })
    x -= 1
    y -= 1
  }
  while (x > 0) {
    result.push({ kind: 'remove', text: a[x - 1] ?? '' })
    x -= 1
  }
  while (y > 0) {
    result.push({ kind: 'add', text: b[y - 1] ?? '' })
    y -= 1
  }

  return result.reverse()
}

function computeDiff(a: readonly string[], b: readonly string[]): DiffOp[] {
  const max = a.length + b.length
  const trace: Map<number, number>[] = []
  let vector = new Map<number, number>([[1, 0]])

  for (let depth = 0; depth <= max; depth += 1) {
    trace.push(new Map(vector))
    let completed = false
    const next = new Map(vector)

    for (let k = -depth; k <= depth; k += 2) {
      const down = k === -depth || (k !== depth && (vector.get(k - 1) ?? -1) < (vector.get(k + 1) ?? -1))
      let x = down ? (vector.get(k + 1) ?? 0) : (vector.get(k - 1) ?? 0) + 1
      let y = x - k
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x += 1
        y += 1
      }
      next.set(k, x)
      if (x >= a.length && y >= b.length) {
        completed = true
        break
      }
    }

    if (completed) return backtrackDiff(trace, a, b, depth)
    vector = next
  }

  return []
}

function resolveContext(options: UnifiedDiffOptions): number {
  const value = options.contextLines ?? options.context ?? DEFAULT_CONTEXT_LINES
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : DEFAULT_CONTEXT_LINES
}

function formatPath(value: string, prefix: 'a' | 'b'): string {
  if (value === '/dev/null' || value.startsWith(`${prefix}/`)) return value
  return `${prefix}/${value}`
}

function formatRange(start: number, count: number): string {
  return `${start}${count === 1 ? '' : `,${count}`}`
}

function hunkHeader(oldStart: number, oldCount: number, newStart: number, newCount: number): string {
  return `@@ -${formatRange(oldStart, oldCount)} +${formatRange(newStart, newCount)} @@`
}

function operationIndexes(operations: readonly DiffOp[]): DiffOp[] {
  let oldIndex = 0
  let newIndex = 0
  return operations.map((operation) => {
    const indexed = { ...operation, oldIndex, newIndex }
    if (operation.kind !== 'add') oldIndex += 1
    if (operation.kind !== 'remove') newIndex += 1
    return indexed
  })
}

function markerForOperation(
  operation: DiffOp,
  before: TextLines,
  after: TextLines
): 'old' | 'new' | 'both' | undefined {
  const oldEnd = operation.oldIndex === before.lines.length - 1 && !before.trailingNewline
  const newEnd = operation.newIndex === after.lines.length - 1 && !after.trailingNewline
  if (operation.kind === 'context' && oldEnd && newEnd) return 'both'
  if ((operation.kind === 'context' || operation.kind === 'remove') && oldEnd) return 'old'
  if ((operation.kind === 'context' || operation.kind === 'add') && newEnd) return 'new'
  return undefined
}

function createHunks(operations: readonly DiffOp[], before: TextLines, after: TextLines, context: number): UnifiedDiffHunk[] {
  const indexed = operationIndexes(operations)
  const changes = indexed.flatMap((operation, index) => operation.kind === 'context' ? [] : [index])
  const hunks: UnifiedDiffHunk[] = []
  let changeCursor = 0

  while (changeCursor < changes.length) {
    const firstChange = changes[changeCursor] ?? 0
    let lastChange = firstChange
    changeCursor += 1
    while (changeCursor < changes.length) {
      const nextChange = changes[changeCursor] ?? lastChange
      if (nextChange - lastChange > context * 2 + 1) break
      lastChange = nextChange
      changeCursor += 1
    }

    const start = Math.max(0, firstChange - context)
    const end = Math.min(indexed.length, lastChange + context + 1)
    const lines = indexed.slice(start, end).map((operation) => ({
      kind: operation.kind,
      text: operation.text,
      noNewlineAtEnd: markerForOperation(operation, before, after),
    }))
    const oldBefore = indexed.slice(0, start).filter((operation) => operation.kind !== 'add').length
    const newBefore = indexed.slice(0, start).filter((operation) => operation.kind !== 'remove').length
    const oldCount = lines.filter((line) => line.kind !== 'add').length
    const newCount = lines.filter((line) => line.kind !== 'remove').length

    hunks.push({
      oldStart: oldCount === 0 ? oldBefore : oldBefore + 1,
      oldCount,
      newStart: newCount === 0 ? newBefore : newBefore + 1,
      newCount,
      lines,
    })
  }

  return hunks
}

function renderHunk(hunk: UnifiedDiffHunk): string[] {
  const output = [hunkHeader(hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount)]
  for (const line of hunk.lines) {
    output.push(`${line.kind === 'context' ? ' ' : line.kind === 'add' ? '+' : '-'}${line.text}`)
    if (line.noNewlineAtEnd) output.push('\\ No newline at end of file')
  }
  return output
}

export function createUnifiedDiff(
  before: string,
  after: string,
  options?: UnifiedDiffOptions
): string
export function createUnifiedDiff(
  before: string,
  after: string,
  filePath?: string,
  options?: UnifiedDiffOptions
): string
export function createUnifiedDiff(
  before: string,
  after: string,
  pathOrOptions: string | UnifiedDiffOptions = {},
  explicitOptions: UnifiedDiffOptions = {}
): string {
  if (before === after) return ''
  const options = typeof pathOrOptions === 'string'
    ? { ...explicitOptions, filePath: pathOrOptions }
    : pathOrOptions
  const beforeLines = splitText(before)
  const afterLines = splitText(after)
  const oldPath = formatPath(options.oldPath ?? options.filePath ?? 'file', 'a')
  const newPath = formatPath(options.newPath ?? options.filePath ?? 'file', 'b')
  const hunks = createHunks(computeDiff(beforeLines.lines, afterLines.lines), beforeLines, afterLines, resolveContext(options))
  return [
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    ...hunks.flatMap(renderHunk),
  ].join('\n') + '\n'
}

export const generateUnifiedDiff = createUnifiedDiff
export const buildUnifiedDiff = createUnifiedDiff

function unquotePath(value: string): string {
  const tab = value.indexOf('\t')
  const candidate = (tab >= 0 ? value.slice(0, tab) : value).trim()
  if (candidate.length >= 2 && candidate.startsWith('"') && candidate.endsWith('"')) {
    return candidate.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\')
  }
  return candidate
}

function cleanPatchPath(value: string): string {
  const path = unquotePath(value)
  if (path === '/dev/null') return path
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2)
  return path
}

function parseCount(value: string | undefined): number {
  return value === undefined ? 1 : Number(value)
}

function makeInvalidDiff(message: string): never {
  throw new Error(message)
}

export function parseUnifiedDiff(input: string): UnifiedDiffDocument {
  if (typeof input !== 'string') makeInvalidDiff('Diff unificado inválido.')
  const lines = input.replace(/\r\n|\r/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  const files: UnifiedDiffFile[] = []
  let index = 0

  while (index < lines.length) {
    const current = lines[index] ?? ''
    if (
      !current ||
      current.startsWith('diff --git ') ||
      current.startsWith('index ') ||
      current.startsWith('new file mode ') ||
      current.startsWith('deleted file mode ') ||
      current.startsWith('similarity index ') ||
      current.startsWith('rename from ') ||
      current.startsWith('rename to ')
    ) {
      index += 1
      continue
    }
    if (!current.startsWith('--- ')) makeInvalidDiff('Cabeçalho de arquivo ausente no diff unificado.')
    const oldPath = cleanPatchPath(current.slice(4))
    index += 1
    const newHeader = lines[index]
    if (!newHeader?.startsWith('+++ ')) makeInvalidDiff('Cabeçalho de arquivo novo ausente no diff unificado.')
    const newPath = cleanPatchPath(newHeader.slice(4))
    index += 1
    const hunks: UnifiedDiffHunk[] = []

    while (index < lines.length && (lines[index] ?? '').startsWith('@@ ')) {
      const header = lines[index] ?? ''
      const match = HUNK_PATTERN.exec(header)
      if (!match) makeInvalidDiff('Cabeçalho de hunk inválido.')
      const oldStart = Number(match[1])
      const oldCount = parseCount(match[2])
      const newStart = Number(match[3])
      const newCount = parseCount(match[4])
      if (
        !Number.isInteger(oldStart) || oldStart < 0 ||
        !Number.isInteger(oldCount) || oldCount < 0 ||
        !Number.isInteger(newStart) || newStart < 0 ||
        !Number.isInteger(newCount) || newCount < 0
      ) makeInvalidDiff('Intervalo de hunk inválido.')
      index += 1
      const hunkLines: UnifiedDiffLine[] = []
      let oldSeen = 0
      let newSeen = 0
      while (oldSeen < oldCount || newSeen < newCount) {
        const line = lines[index]
        if (line === undefined) makeInvalidDiff('Hunk truncado.')
        if (line === '\\ No newline at end of file') {
          const previous = hunkLines.at(-1)
          if (!previous) makeInvalidDiff('Marcador de fim de linha sem linha anterior.')
          previous.noNewlineAtEnd = previous.kind === 'context' ? 'both' : previous.kind === 'add' ? 'new' : 'old'
          index += 1
          continue
        }
        const prefix = line[0]
        if (prefix !== ' ' && prefix !== '+' && prefix !== '-') makeInvalidDiff('Linha de hunk inválida.')
        const kind: UnifiedDiffLineKind = prefix === ' ' ? 'context' : prefix === '+' ? 'add' : 'remove'
        if (kind !== 'add') oldSeen += 1
        if (kind !== 'remove') newSeen += 1
        if (oldSeen > oldCount || newSeen > newCount) makeInvalidDiff('Contagem de linhas do hunk inválida.')
        hunkLines.push({ kind, text: line.slice(1) })
        index += 1
      }
      while (lines[index] === '\\ No newline at end of file') {
        const previous = hunkLines.at(-1)
        if (!previous) makeInvalidDiff('Marcador de fim de linha sem linha anterior.')
        previous.noNewlineAtEnd = previous.kind === 'context' ? 'both' : previous.kind === 'add' ? 'new' : 'old'
        index += 1
      }
      hunks.push({ oldStart, oldCount, newStart, newCount, heading: match[5] || undefined, lines: hunkLines })
    }
    if (hunks.length === 0) makeInvalidDiff('Arquivo sem hunks no diff unificado.')
    files.push({ oldPath, newPath, hunks })
  }

  return { files }
}

function countOldLines(hunk: UnifiedDiffHunk): number {
  return hunk.lines.filter((line) => line.kind !== 'add').length
}

function countNewLines(hunk: UnifiedDiffHunk): number {
  return hunk.lines.filter((line) => line.kind !== 'remove').length
}

function hunkExpectedOldLines(hunk: UnifiedDiffHunk): string[] {
  return hunk.lines.filter((line) => line.kind !== 'add').map((line) => line.text)
}

function hunkExpectedNewLines(hunk: UnifiedDiffHunk): string[] {
  return hunk.lines.filter((line) => line.kind !== 'remove').map((line) => line.text)
}

function findMatches(lines: readonly string[], expected: readonly string[]): number[] {
  if (expected.length === 0) return []
  const matches: number[] = []
  for (let index = 0; index <= lines.length - expected.length; index += 1) {
    let matchesAtPosition = true
    for (let offset = 0; offset < expected.length; offset += 1) {
      if (lines[index + offset] !== expected[offset]) {
        matchesAtPosition = false
        break
      }
    }
    if (matchesAtPosition) matches.push(index)
  }
  return matches
}

function emptyApplyResult(content: string, diff?: UnifiedDiffDocument): ApplyUnifiedDiffResult {
  return { status: 'unchanged', ok: true, applied: false, changed: false, content, conflicts: [], hunks: [], diff }
}

function conflictForHunk(
  filePath: string | undefined,
  hunk: UnifiedDiffHunk,
  hunkIndex: number,
  reason: UnifiedDiffConflictReason,
  candidates: readonly number[],
  message: string
): UnifiedDiffConflict {
  return {
    filePath,
    hunkIndex,
    reason,
    message,
    expected: hunkExpectedOldLines(hunk),
    candidates,
    oldStart: hunk.oldStart,
    oldCount: hunk.oldCount,
    newStart: hunk.newStart,
    newCount: hunk.newCount,
  }
}

function validateResult(result: UnifiedDiffValidationOutcome): { valid: boolean; message?: string } {
  if (result === undefined || result === true) return { valid: true }
  if (result === false) return { valid: false, message: 'Validação sintática rejeitou o patch.' }
  if (typeof result === 'string') return { valid: false, message: result || 'Validação sintática rejeitou o patch.' }
  return result
}

function chooseValidationHook(options: ApplyUnifiedDiffOptions): UnifiedDiffValidationHook | undefined {
  return options.validate ?? options.validateSyntax ?? options.syntaxValidator
}

function isPromiseLike(value: unknown): value is Promise<UnifiedDiffValidationOutcome> {
  return !!value && typeof value === 'object' && 'then' in value && typeof value.then === 'function'
}

function applyFileDocument(
  source: string,
  file: UnifiedDiffFile,
  fileIndex: number
): { content?: string; conflicts: UnifiedDiffConflict[]; hunks: UnifiedDiffHunkResult[] } {
  const sourceLines = splitText(source)
  const lines = [...sourceLines.lines]
  const conflicts: UnifiedDiffConflict[] = []
  const hunkResults: UnifiedDiffHunkResult[] = []

  for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex += 1) {
    const hunk = file.hunks[hunkIndex]
    if (countOldLines(hunk) !== hunk.oldCount || countNewLines(hunk) !== hunk.newCount) {
      const conflict = conflictForHunk(file.newPath || file.oldPath, hunk, hunkIndex, 'invalid-diff', [], 'Contagem de linhas do hunk não corresponde ao cabeçalho.')
      conflicts.push(conflict)
      hunkResults.push({ hunkIndex, status: 'conflict', candidates: [] })
      return { conflicts, hunks: hunkResults }
    }
    const expected = hunkExpectedOldLines(hunk)
    const matches = findMatches(lines, expected)
    let position: number | undefined

    if (expected.length === 0) {
      if (lines.length === 0) position = 0
      else {
        const conflict = conflictForHunk(file.newPath || file.oldPath, hunk, hunkIndex, 'unanchored-insertion', [], 'Inserção sem contexto não pode ser localizada com segurança.')
        conflicts.push(conflict)
        hunkResults.push({ hunkIndex, status: 'conflict', candidates: [] })
        return { conflicts, hunks: hunkResults }
      }
    } else if (matches.length === 1) {
      position = matches[0]
    } else if (matches.length === 0) {
      const conflict = conflictForHunk(file.newPath || file.oldPath, hunk, hunkIndex, 'context-not-found', [], 'Contexto do hunk não foi encontrado no conteúdo atual.')
      conflicts.push(conflict)
      hunkResults.push({ hunkIndex, status: 'conflict', candidates: [] })
      return { conflicts, hunks: hunkResults }
    } else {
      const candidateLines = matches.map((match) => match + 1)
      const conflict = conflictForHunk(file.newPath || file.oldPath, hunk, hunkIndex, 'context-ambiguous', candidateLines, 'Contexto do hunk ocorre em mais de uma posição.')
      conflicts.push(conflict)
      hunkResults.push({ hunkIndex, status: 'conflict', candidates: candidateLines })
      return { conflicts, hunks: hunkResults }
    }

    const replacement = hunkExpectedNewLines(hunk)
    lines.splice(position ?? 0, expected.length, ...replacement)
    hunkResults.push({ hunkIndex, status: 'applied', position: (position ?? 0) + 1, candidates: [(position ?? 0) + 1] })
  }

  const hasNewNoNewlineMarker = file.hunks.some((hunk) => hunk.lines.some((line) => line.noNewlineAtEnd === 'new' || line.noNewlineAtEnd === 'both'))
  const lastHunk = file.hunks.at(-1)
  const lastNewLine = lastHunk ? [...lastHunk.lines].reverse().find((line) => line.kind !== 'remove') : undefined
  const trailingNewline = hasNewNoNewlineMarker ? false : lastNewLine?.kind === 'add' ? true : sourceLines.trailingNewline
  const content = lines.join(sourceLines.eol) + (trailingNewline && lines.length > 0 ? sourceLines.eol : '')
  return { content, conflicts, hunks: hunkResults }
}

function parseForApplication(source: string, patch: string): { source: string; patch: string } {
  const firstLooksLikePatch = /^(?:diff --git |--- )/m.test(source) && !/^(?:diff --git |--- )/m.test(patch)
  return firstLooksLikePatch ? { source: patch, patch: source } : { source, patch }
}

export function applyUnifiedDiff(sourceInput: string, patchInput: string, options: ApplyUnifiedDiffOptions = {}): ApplyUnifiedDiffResult {
  const { source, patch } = parseForApplication(sourceInput, patchInput)
  let diff: UnifiedDiffDocument
  try {
    diff = parseUnifiedDiff(patch)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Diff unificado inválido.'
    return { status: 'invalid', ok: false, applied: false, changed: false, content: source, conflicts: [], hunks: [], error: message }
  }
  if (diff.files.length === 0) return emptyApplyResult(source, diff)
  if (diff.files.length !== 1) {
    return { status: 'invalid', ok: false, applied: false, changed: false, content: source, conflicts: [], hunks: [], diff, error: 'A aplicação em uma string exige um único arquivo no diff.' }
  }

  const applied = applyFileDocument(source, diff.files[0], 0)
  if (applied.conflicts.length > 0 || applied.content === undefined) {
    return {
      status: 'conflict',
      ok: false,
      applied: false,
      changed: false,
      content: source,
      conflicts: applied.conflicts,
      hunks: applied.hunks,
      diff,
    }
  }

  const content = applied.content
  const hook = chooseValidationHook(options)
  if (hook) {
    try {
      const result = hook(content, { source, diff })
      if (isPromiseLike(result)) {
        return { status: 'validation-failed', ok: false, applied: false, changed: false, content: source, conflicts: [], hunks: applied.hunks, diff, error: 'Validação assíncrona exige applyUnifiedDiffAsync.' }
      }
      const validation = validateResult(result)
      if (!validation.valid) {
        const conflict = conflictForHunk(diff.files[0].newPath, diff.files[0].hunks[0]!, 0, 'validation-failed', [], validation.message || 'Validação sintática rejeitou o patch.')
        return { status: 'validation-failed', ok: false, applied: false, changed: false, content: source, conflicts: [conflict], hunks: applied.hunks, diff, error: validation.message }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Validação sintática falhou.'
      return { status: 'validation-failed', ok: false, applied: false, changed: false, content: source, conflicts: [], hunks: applied.hunks, diff, error: message }
    }
  }

  return { status: content === source ? 'unchanged' : 'applied', ok: true, applied: content !== source, changed: content !== source, content, conflicts: [], hunks: applied.hunks, diff }
}

export async function applyUnifiedDiffAsync(sourceInput: string, patchInput: string, options: ApplyUnifiedDiffOptions = {}): Promise<ApplyUnifiedDiffResult> {
  const { source, patch } = parseForApplication(sourceInput, patchInput)
  let diff: UnifiedDiffDocument
  try {
    diff = parseUnifiedDiff(patch)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Diff unificado inválido.'
    return { status: 'invalid', ok: false, applied: false, changed: false, content: source, conflicts: [], hunks: [], error: message }
  }
  if (diff.files.length === 0) return emptyApplyResult(source, diff)
  if (diff.files.length !== 1) {
    return { status: 'invalid', ok: false, applied: false, changed: false, content: source, conflicts: [], hunks: [], diff, error: 'A aplicação em uma string exige um único arquivo no diff.' }
  }
  const applied = applyFileDocument(source, diff.files[0], 0)
  if (applied.conflicts.length > 0 || applied.content === undefined) {
    return { status: 'conflict', ok: false, applied: false, changed: false, content: source, conflicts: applied.conflicts, hunks: applied.hunks, diff }
  }
  const content = applied.content
  const hook = chooseValidationHook(options)
  if (hook) {
    try {
      const validation = validateResult(await Promise.resolve(hook(content, { source, diff })) as UnifiedDiffValidationOutcome)
      if (!validation.valid) {
        const conflict = conflictForHunk(diff.files[0].newPath, diff.files[0].hunks[0]!, 0, 'validation-failed', [], validation.message || 'Validação sintática rejeitou o patch.')
        return { status: 'validation-failed', ok: false, applied: false, changed: false, content: source, conflicts: [conflict], hunks: applied.hunks, diff, error: validation.message }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Validação sintática falhou.'
      return { status: 'validation-failed', ok: false, applied: false, changed: false, content: source, conflicts: [], hunks: applied.hunks, diff, error: message }
    }
  }
  return { status: content === source ? 'unchanged' : 'applied', ok: true, applied: content !== source, changed: content !== source, content, conflicts: [], hunks: applied.hunks, diff }
}

export const applyPatch = applyUnifiedDiff
export const applyUnifiedPatch = applyUnifiedDiff

function filePathCandidates(file: UnifiedDiffFile): string[] {
  return [...new Set([file.newPath, file.oldPath].filter((value) => value && value !== '/dev/null'))]
}

export function applyUnifiedDiffToFiles(
  filesInput: Readonly<Record<string, string>>,
  patch: string,
  options: ApplyUnifiedDiffOptions = {}
): ApplyUnifiedDiffToFilesResult {
  let diff: UnifiedDiffDocument
  try {
    diff = parseUnifiedDiff(patch)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Diff unificado inválido.'
    return { status: 'invalid', ok: false, applied: false, changed: false, files: filesInput, conflicts: [], hunks: [], error: message }
  }
  if (diff.files.length === 0) return { status: 'unchanged', ok: true, applied: false, changed: false, files: filesInput, conflicts: [], hunks: [], diff }
  const files = { ...filesInput }
  const conflicts: UnifiedDiffConflict[] = []
  const hunkResults: UnifiedDiffHunkResult[] = []
  const pendingValidation: Array<{ path: string; content: string; source: string }> = []

  for (const [fileIndex, file] of diff.files.entries()) {
    const candidates = filePathCandidates(file)
    const path = candidates.find((candidate) => candidate in files) ?? candidates[0]
    const source = path && path in files ? files[path] : ''
    if (!path || (file.oldPath !== '/dev/null' && file.newPath !== '/dev/null' && !(path in files))) {
      conflicts.push(conflictForHunk(file.newPath || file.oldPath, file.hunks[0]!, 0, 'context-not-found', [], 'Arquivo do patch não foi encontrado.') )
      continue
    }
    const applied = applyFileDocument(source, file, fileIndex)
    conflicts.push(...applied.conflicts)
    hunkResults.push(...applied.hunks)
    if (applied.content === undefined || applied.conflicts.length > 0) continue
    const targetPath = file.newPath === '/dev/null' ? file.oldPath : file.newPath
    if (file.newPath === '/dev/null') delete files[path]
    else files[targetPath] = applied.content
    pendingValidation.push({ path: targetPath, content: applied.content, source })
  }

  if (conflicts.length > 0) return { status: 'conflict', ok: false, applied: false, changed: false, files: filesInput, conflicts, hunks: hunkResults, diff }
  const hook = chooseValidationHook(options)
  if (hook) {
    try {
      for (const item of pendingValidation) {
        const raw = hook(item.content, { source: item.source, diff })
        if (isPromiseLike(raw)) return { status: 'validation-failed', ok: false, applied: false, changed: false, files: filesInput, conflicts: [], hunks: hunkResults, diff, error: 'Validação assíncrona exige applyUnifiedDiffAsync.' }
        const result = validateResult(raw)
        if (!result.valid) return { status: 'validation-failed', ok: false, applied: false, changed: false, files: filesInput, conflicts: [], hunks: hunkResults, diff, error: result.message }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Validação sintática falhou.'
      return { status: 'validation-failed', ok: false, applied: false, changed: false, files: filesInput, conflicts: [], hunks: hunkResults, diff, error: message }
    }
  }
  const changed = JSON.stringify(files) !== JSON.stringify(filesInput)
  return { status: changed ? 'applied' : 'unchanged', ok: true, applied: changed, changed, files, conflicts: [], hunks: hunkResults, diff }
}
