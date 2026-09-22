/**
 * Helpers puros dos Smart Terminals no canvas: migração de esquema (v3 → v4),
 * chips do Quick Deploy, título de nó, parser de argumentos e slug de preset
 * personalizado. Sem DOM — cobertos por testes unitários diretos.
 */

import type {
  CustomTerminalPreset,
  ResolvedTerminalLaunch,
  TerminalNodeRuntimeConfig,
  TerminalPresetDefinition,
} from '../../../shared/terminal-presets'
import {
  CUSTOM_TERMINAL_PRESET_LIMIT,
  CUSTOM_TERMINAL_PRESET_PREFIX,
  TERMINAL_PRESETS,
  sanitizeTerminalNodeConfig,
} from '../../../shared/terminal-presets'

export { CUSTOM_TERMINAL_PRESET_LIMIT }

/** Versão atual do esquema do canvas no localStorage. */
export const CANVAS_STATE_VERSION = 4

/** Versões legíveis pela migração: v2/v3 (sem terminal) e v4 (com terminal). */
export const READABLE_CANVAS_VERSIONS = [2, 3, 4] as const

export interface RawCanvasNodeLike {
  kind?: unknown
  terminal?: unknown
}

/**
 * Nós migrados são NÃO-DESTRUTIVOS: todo campo de origem (id, título,
 * geometria, conteúdo, role, provider…) atravessa a migração intacta — só o
 * campo `terminal` é normalizado. `sanitizeNode` (no canvas) continua sendo a
 * autoridade final de validação.
 */
export interface MigratedCanvasNodeLike {
  kind: unknown
  terminal?: TerminalNodeRuntimeConfig
  [field: string]: unknown
}

/**
 * Passo de migração v3 → v4: nós antigos não têm campo terminal; nós
 * 'terminal' recebem a config saneada (lixo de versões antigas sai do campo).
 * Nenhum outro campo é tocado: v3 carregado não pode ser sobrescrito pelo
 * persist() seguinte com dados de default.
 */
export function migrateCanvasNodesForTerminals(
  rawNodes: readonly RawCanvasNodeLike[],
): MigratedCanvasNodeLike[] {
  return rawNodes.map((node) => {
    if (!node || typeof node !== 'object') return { kind: (node as RawCanvasNodeLike | null)?.kind }
    // O spread é de Record<string, unknown> de propósito: preserva TODOS os
    // campos de origem sem arrastar o `terminal?: unknown` do tipo bruto para
    // dentro do tipo migrado (que tipa terminal como config saneada).
    const source = node as Record<string, unknown>
    const migrated: MigratedCanvasNodeLike = { ...source, kind: source.kind }
    if (source.kind !== 'terminal') return migrated
    const terminal = sanitizeTerminalNodeConfig(source.terminal)
    if (terminal) migrated.terminal = terminal
    else delete migrated.terminal
    return migrated
  })
}

export interface QuickDeployChip {
  /** Identificador estável para o React key: id do preset. */
  id: string
  label: string
  icon?: string
  description: string
  preset: TerminalPresetDefinition | CustomTerminalPreset
}

/** Chips do Quick Deploy: os seis presets embutidos + os personalizados. */
export function buildQuickDeployChips(
  customPresets: readonly CustomTerminalPreset[] = [],
): QuickDeployChip[] {
  const builtinChips: QuickDeployChip[] = TERMINAL_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    description: preset.description,
    preset,
  }))
  const customChips: QuickDeployChip[] = customPresets.map((preset) => ({
    id: preset.id,
    label: preset.name,
    icon: preset.icon,
    description: [preset.command, ...(preset.args ?? [])].join(' '),
    preset,
  }))
  return [...builtinChips, ...customChips]
}

/**
 * Título do nó de terminal com dedupe simples: "Codex", "Codex 2", "Codex 3"…
 * Case-insensitive contra os títulos já em uso no canvas.
 */
export function terminalNodeTitle(
  preset: TerminalPresetDefinition | CustomTerminalPreset,
  existingTitles: readonly string[] = [],
): string {
  const base = ('label' in preset ? preset.label : preset.name).trim() || 'Terminal'
  if (!existingTitles.length) return base
  const taken = new Set(existingTitles.map((title) => title.trim().toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  let index = 2
  while (taken.has((base + ' ' + index).toLowerCase())) index += 1
  return base + ' ' + index
}

/**
 * Parser do campo "Argumentos": divide por espaço em branco; aspas duplas
 * agrupam um argumento com espaços. Vazio/só espaço → undefined (campo
 * opcional na config).
 */
export function parseArgsInput(input: string): string[] | undefined {
  const args: string[] = []
  let current = ''
  let quoted = false
  for (const char of input) {
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) args.push(current)
  return args.length > 0 ? args : undefined
}

const SLUG_SEPARATOR = '-'

/**
 * Slug para ids de preset personalizado ("custom:meu-comando"). Remove
 * acentos, minúsculas, troca separadores por hífen e garante o padrão
 * ^custom:[a-z0-9][a-z0-9-]{0,48}$. Colisões recebem sufixo -2, -3… Retorno
 * vazio = nome sem nenhum caractere aproveitável.
 */
export function slugifyCustomPresetId(
  name: string,
  existingIds: readonly string[] = [],
): string {
  const normalized = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, SLUG_SEPARATOR)
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/^-+|-+$/g, '')
  if (!normalized || !/^[a-z0-9]/.test(normalized)) return ''
  const taken = new Set(existingIds)
  if (!taken.has(CUSTOM_TERMINAL_PRESET_PREFIX + normalized)) {
    return CUSTOM_TERMINAL_PRESET_PREFIX + normalized
  }
  let index = 2
  while (taken.has(CUSTOM_TERMINAL_PRESET_PREFIX + normalized + SLUG_SEPARATOR + index)) index += 1
  return CUSTOM_TERMINAL_PRESET_PREFIX + normalized + SLUG_SEPARATOR + index
}

export interface TerminalCommandSelection {
  command?: string
  args?: string[]
}

/**
 * Seleção comando/args de um start do tipo comando. O par de retomada
 * (resumeCommand/resumeArgs) só entra quando `allowResume` — ou seja, apenas
 * no Reinício explícito com restartBehavior 'resume'. O primeiro start
 * (auto-start do mount) sempre usa o comando primário.
 */
export function selectTerminalCommand(
  resolved: Pick<
    ResolvedTerminalLaunch,
    'command' | 'args' | 'resumeCommand' | 'resumeArgs' | 'restartBehavior'
  >,
  allowResume: boolean,
): TerminalCommandSelection {
  const resumeCommand =
    allowResume && resolved.restartBehavior === 'resume' ? resolved.resumeCommand : undefined
  if (!resumeCommand) return { command: resolved.command, args: resolved.args }
  return { command: resumeCommand, args: resolved.resumeArgs ?? resolved.args }
}

/** Comprimento máximo do comando, espelhando o sanitize compartilhado. */
export const TERMINAL_COMMAND_MAX_LENGTH = 512

/**
 * true quando texto não-vazio seria rejeitado pelo sanitize compartilhado
 * (%/!/controle) ou excede o limite. Texto vazio NÃO é rejeição: limpar o
 * campo é uma intenção válida (comando volta ao default do preset).
 * Verificação por code point (e não regex) para os caracteres de controle.
 */
export function isTerminalCommandTextRejected(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (trimmed.length > TERMINAL_COMMAND_MAX_LENGTH) return true
  for (const char of trimmed) {
    if (char === '%' || char === '!') return true
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x1f) return true
  }
  return false
}

/** Aviso curto (pt-BR) exibido quando o texto digitado seria descartado. */
export const TERMINAL_COMMAND_INVALID_HINT = 'Caracteres não permitidos: % !'

/**
 * Formata a lista de argumentos para o campo de texto, repondo aspas em
 * argumentos com espaço para o round-trip parseArgsInput ⇄ formatArgsInput
 * ser estável.
 */
export function formatArgsInput(args?: readonly string[]): string {
  if (!args?.length) return ''
  return args
    .map((arg) => (/\s/.test(arg) ? '"' + arg + '"' : arg))
    .join(' ')
}

/**
 * Verifica se um id pertence a um preset personalizado do usuário.
 */
export function isCustomTerminalPresetId(presetId: string): boolean {
  return presetId.startsWith(CUSTOM_TERMINAL_PRESET_PREFIX)
}

/**
 * Exclui um preset customizado. Presets nativos/embutidos nunca podem ser excluídos.
 */
export function deleteCustomTerminalPreset(
  presets: readonly CustomTerminalPreset[],
  presetId: string,
): { presets: CustomTerminalPreset[]; deleted?: CustomTerminalPreset; error?: string } {
  if (!isCustomTerminalPresetId(presetId)) {
    return { presets: [...presets], error: 'Não é permitido excluir presets nativos do sistema.' }
  }
  const found = presets.find((p) => p.id === presetId)
  if (!found) {
    return { presets: [...presets], error: 'Preset não encontrado.' }
  }
  return {
    presets: presets.filter((p) => p.id !== presetId),
    deleted: found,
  }
}

/**
 * Renomeia um preset customizado. Presets nativos não podem ser renomeados.
 * Valida tamanho e colisão de nomes.
 */
export function renameCustomTerminalPreset(
  presets: readonly CustomTerminalPreset[],
  presetId: string,
  rawNewName: string,
): { presets: CustomTerminalPreset[]; updated?: CustomTerminalPreset; error?: string } {
  if (!isCustomTerminalPresetId(presetId)) {
    return { presets: [...presets], error: 'Não é permitido renomear presets nativos do sistema.' }
  }
  const target = presets.find((p) => p.id === presetId)
  if (!target) {
    return { presets: [...presets], error: 'Preset não encontrado.' }
  }
  const newName = rawNewName.trim().slice(0, 60)
  if (!newName) {
    return { presets: [...presets], error: 'O nome do preset não pode ser vazio.' }
  }
  const hasConflict = presets.some(
    (p) => p.id !== presetId && p.name.trim().toLowerCase() === newName.toLowerCase(),
  )
  if (hasConflict) {
    return { presets: [...presets], error: 'Já existe outro preset com este nome.' }
  }
  const updated: CustomTerminalPreset = { ...target, name: newName }
  return {
    presets: presets.map((p) => (p.id === presetId ? updated : p)),
    updated,
  }
}
