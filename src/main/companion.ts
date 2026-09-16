import path from 'node:path'
import type { TerminalEvent } from './terminal-session'

/**
 * DevOrbit Companion (FASE 3, inspirado no Ombro): sentinela em segundo plano
 * que monitora a atividade dos terminais e resume tarefas finalizadas ou
 * bloqueios com sugestões de próximas ações. Não executa nada por conta
 * própria — só observa eventos do PTY e despacha resumos.
 */
export type CompanionOutcome = 'completed' | 'blocked' | 'failed'

export interface CompanionAction {
  id: 'view-workspace' | 'dismiss'
  label: string
}

export interface CompanionSummary {
  terminalId: string
  projectPath?: string
  outcome: CompanionOutcome
  title: string
  message: string
  suggestion: string
  code?: number | null
  actions: CompanionAction[]
}

export const COMPANION_TAIL_CHARS = 4_000
export const COMPANION_MAX_SESSIONS = 50

const BLOCKED_PATTERNS = [
  /DEVORBIT_RESULT:\s*BLOQUEADO:/i,
  /^\s*\[?\s*(BLOQUEADO|BLOCKED|FALHA|FAILURE|ERRO|ERROR)\s*[\]:-]/im,
]

const RESULT_PATTERN = /DEVORBIT_RESULT:[ \t]*([^\r\n]+)/i

function detectBlocked(output: string): string | undefined {
  const resultMatch = output.match(RESULT_PATTERN)
  if (resultMatch && BLOCKED_PATTERNS.some((pattern) => pattern.test(resultMatch[0]))) {
    return resultMatch[1].trim().slice(0, 200)
  }
  const lines = output.split(/\r?\n/).slice(-12)
  for (const line of lines) {
    if (BLOCKED_PATTERNS.some((pattern) => pattern.test(line))) {
      return line.trim().slice(0, 200)
    }
  }
  return undefined
}

function detectResult(output: string): string | undefined {
  const match = output.match(RESULT_PATTERN)
  const value = match?.[1]?.trim()
  return value ? value.slice(0, 200) : undefined
}

export function summarizeTerminalEnd(input: {
  terminalId: string
  projectPath?: string
  code?: number | null
  errored?: boolean
  errorMessage?: string
  outputTail?: string
}): CompanionSummary {
  const output = input.outputTail || ''
  const blockedReason = detectBlocked(output)
  const result = detectResult(output)
  const location = input.projectPath ? `no projeto ${path.basename(input.projectPath)}` : 'no terminal'
  const actions: CompanionAction[] = [
    { id: 'view-workspace', label: 'Ver ambiente' },
    { id: 'dismiss', label: 'Dispensar' },
  ]
  const base = {
    terminalId: input.terminalId,
    ...(input.projectPath ? { projectPath: input.projectPath } : {}),
    actions,
  }

  if (blockedReason) {
    return {
      ...base,
      outcome: 'blocked',
      title: 'Agente bloqueado',
      message: `Agente bloqueado ${location}: ${blockedReason}`,
      suggestion: 'Abra o ambiente, resolva o bloqueio e reenvie a tarefa ao agente.',
      ...(input.code !== undefined ? { code: input.code } : {}),
    }
  }
  if (input.errored) {
    return {
      ...base,
      outcome: 'failed',
      title: 'Terminal com erro',
      message: `Terminal com erro ${location}${input.errorMessage ? `: ${input.errorMessage.slice(0, 200)}` : '.'}`,
      suggestion: 'Verifique a mensagem de erro no terminal e reinicie a sessão se preciso.',
    }
  }
  if (typeof input.code === 'number' && input.code !== 0) {
    return {
      ...base,
      outcome: 'failed',
      title: 'Processo encerrado com falha',
      message: `Processo encerrado com falha ${location} (código ${input.code})${result ? `: ${result}` : '.'}`,
      suggestion: 'Confira a saída do terminal, ajuste e execute novamente.',
      code: input.code,
    }
  }
  return {
    ...base,
    outcome: 'completed',
    title: 'Tarefa finalizada',
    message: result
      ? `Tarefa finalizada ${location}: ${result}`
      : `Tarefa finalizada ${location} com código 0.`,
    suggestion: 'Revise o resultado no canvas e encadeie a próxima etapa.',
    ...(input.code !== undefined ? { code: input.code } : {}),
  }
}

export interface CompanionSentinel {
  handleTerminalEvent: (event: TerminalEvent) => void
  registerTerminal: (id: string, context: { projectPath: string }) => void
  unregisterTerminal: (id: string) => void
  reset: () => void
  pendingCount: () => number
}

export function createCompanionSentinel(
  onSummary: (summary: CompanionSummary) => void
): CompanionSentinel {
  const tails = new Map<string, string>()
  const errors = new Map<string, string>()
  const contexts = new Map<string, { projectPath: string }>()
  // Mensagens de erro já anunciadas por id: um exit subsequente sem saída
  // nova não gera segundo resumo (error + exit = exatamente um resumo).
  const announcedErrors = new Map<string, string>()

  function remember(id: string, map: Map<string, string>, value: string): void {
    map.delete(id)
    map.set(id, value)
    while (map.size > COMPANION_MAX_SESSIONS) {
      const oldest = map.keys().next()
      if (oldest.done) break
      map.delete(oldest.value)
    }
  }

  function clearTerminalState(id: string): void {
    tails.delete(id)
    errors.delete(id)
    announcedErrors.delete(id)
  }

  function takeContext(id: string): { projectPath?: string } {
    const context = contexts.get(id)
    contexts.delete(id)
    return context ? { projectPath: context.projectPath } : {}
  }

  function peekContext(id: string): { projectPath?: string } {
    const context = contexts.get(id)
    return context ? { projectPath: context.projectPath } : {}
  }

  return {
    registerTerminal(id: string, context: { projectPath: string }): void {
      // Nova sessão no mesmo id: não mistura tail/erro da sessão anterior.
      clearTerminalState(id)
      contexts.delete(id)
      contexts.set(id, { projectPath: context.projectPath })
      while (contexts.size > COMPANION_MAX_SESSIONS) {
        const oldest = contexts.keys().next()
        if (oldest.done) break
        contexts.delete(oldest.value)
      }
    },
    unregisterTerminal(id: string): void {
      // Stop sem exit: nada mais chegará para este id.
      clearTerminalState(id)
      contexts.delete(id)
    },
    handleTerminalEvent(event: TerminalEvent): void {
      if (event.type === 'data' && typeof event.data === 'string') {
        remember(event.id, tails, ((tails.get(event.id) || '') + event.data).slice(-COMPANION_TAIL_CHARS))
        return
      }
      if (event.type === 'error') {
        const message = typeof event.data === 'string' ? event.data : ''
        remember(event.id, errors, message)
        remember(event.id, announcedErrors, message)
        tails.delete(event.id)
        onSummary(summarizeTerminalEnd({
          terminalId: event.id,
          ...peekContext(event.id),
          errored: true,
          errorMessage: message || undefined,
          outputTail: undefined,
        }))
        return
      }
      if (event.type === 'exit') {
        const outputTail = tails.get(event.id)
        const errorMessage = errors.get(event.id)
        const announced = announcedErrors.get(event.id)
        clearTerminalState(event.id)
        if (
          announced !== undefined &&
          outputTail === undefined &&
          errorMessage !== undefined &&
          announced === errorMessage
        ) {
          // O erro já foi anunciado e nada novo aconteceu: sem duplicata.
          // Consome o contexto aqui também — nada pode ficar retido para
          // saídas posteriores deste id.
          takeContext(event.id)
          return
        }
        onSummary(summarizeTerminalEnd({
          terminalId: event.id,
          ...takeContext(event.id),
          code: event.code,
          ...(errorMessage ? { errored: true, errorMessage } : {}),
          outputTail,
        }))
      }
    },
    reset(): void {
      tails.clear()
      errors.clear()
      contexts.clear()
      announcedErrors.clear()
    },
    pendingCount(): number {
      return tails.size
    },
  }
}

const summaryListeners = new Set<(summary: CompanionSummary) => void>()
let sentinel: CompanionSentinel | null = null
// Terminais vivos conhecidos: data/exit de ids fora daqui são tardios e nunca
// geram resumo (ex.: após stop).
const liveTerminalIds = new Set<string>()
// Tombstones: ids explicitamente parados/desregistrados. Late error desses ids
// é no-op; erro de spawn de id nunca vivo (sem tombstone) continua anunciado.
const stoppedTerminalIds = new Set<string>()

function ensureSentinel(): CompanionSentinel {
  if (!sentinel) {
    sentinel = createCompanionSentinel((summary) => {
      for (const listener of summaryListeners) {
        try {
          listener(summary)
        } catch {
          // Um listener com defeito nunca pode derrubar a sentinela.
        }
      }
    })
  }
  return sentinel
}

export function onCompanionEvent(listener: (summary: CompanionSummary) => void): () => void {
  summaryListeners.add(listener)
  return () => summaryListeners.delete(listener)
}

/** Registra o projeto dono de um terminal (ação Ver ambiente do toast). */
export function registerCompanionTerminal(id: string, context: { projectPath: string }): void {
  stoppedTerminalIds.delete(id)
  liveTerminalIds.add(id)
  ensureSentinel().registerTerminal(id, context)
}

/** Esquece terminal parado/removido; eventos tardios viram no-ops. */
export function unregisterCompanionTerminal(id: string): void {
  const wasLive = liveTerminalIds.delete(id)
  // Só marca tombstone para ids que estavam vivos: stops de ids nunca
  // registrados não podem silenciar um futuro erro de spawn legítimo.
  if (wasLive) stoppedTerminalIds.add(id)
  if (sentinel) sentinel.unregisterTerminal(id)
}

export function unregisterAllCompanionTerminals(): void {
  liveTerminalIds.clear()
  stoppedTerminalIds.clear()
  if (sentinel) sentinel.reset()
}

/**
 * Novo start do mesmo id (restart/failover/reabertura): remove o tombstone,
 * para que uma falha de spawn desse start seja anunciada normalmente.
 */
export function beginCompanionTerminalStart(id: string): void {
  stoppedTerminalIds.delete(id)
}

/** Encaminha um evento do PTY para a sentinela (chamado pelo main). */
export function handleCompanionTerminalEvent(event: TerminalEvent): void {
  const isLive = liveTerminalIds.has(event.id)
  if (event.type === 'data' && !isLive) return
  if (event.type === 'exit') {
    if (!isLive) return
    liveTerminalIds.delete(event.id)
    ensureSentinel().handleTerminalEvent(event)
    return
  }
  if (event.type === 'error') {
    // Late error de id parado: no-op. Erro de spawn para id nunca vivo
    // (sem tombstone) segue anunciado.
    if (!isLive && stoppedTerminalIds.has(event.id)) return
    ensureSentinel().handleTerminalEvent(event)
    return
  }
  ensureSentinel().handleTerminalEvent(event)
}

/** Zera todo o estado do módulo (testes). */
export function resetCompanionForTests(): void {
  liveTerminalIds.clear()
  stoppedTerminalIds.clear()
  sentinel = null
}
