/**
 * Sync DevOrbit → ai-memory (FASE 3): persistência de eventos terminais do
 * Agent Bridge e publicação do snapshot consolidado do squad.
 *
 * Contratos fixados na coordenação:
 * - Persistência alimenta-se do OUTCOME CONSOLIDADO do Bridge
 *   (`BridgeCycleOutcome`, uma vez por ciclo lógico, taskId estável) — NUNCA
 *   do evento externo de `send` (`{accepted:true}` sem summary) nem de waits
 *   repetidos em cache. Pending não gera página de evento; quando existe
 *   associação explícita requestId→tarefa, pending projeta in-progress no
 *   snapshot `squads/<id>/state` (applyBridgeEventToSnapshot).
 * - Nenhum prompt bruto do Bridge é persistido; descrição/responsabilidade
 *   vem do snapshot (UI/Canvas), nunca do tráfego.
 * - Fila serializada EM MEMÓRIA por página (escritas MCP nunca concorrentes
 *   para o mesmo path) e gravação idempotente por caminho determinístico.
 * - Falha de memória NUNCA quebra o Bridge: toda escrita é fire-and-forget
 *   com erro engolido/logado via retorno booleano.
 * - Dedupe por taskId (um outcome = uma página).
 * - Snapshot do squad: página ai-memory `squads/<id>/state` — a ÚNICA fonte
 *   durável; nada em .devorbit e nenhuma terceira memória. Sem associação
 *   confiável, só o registro episódico por projeto é gravado; squad não é
 *   inventado.
 * - Segredo: redação via `redactSecretText` (shared/evolution-history).
 */

import { createHash } from 'node:crypto'
import { redactSecretText } from '../shared/evolution-history'
import { buildTakeoverPlan as buildSquadTakeoverPlan, type TakeoverGitInspector, type TakeoverPlan } from './ai-memory-takeover'
import {
  AI_MEMORY_MCP_TOOLS,
  type AiMemoryScope,
} from '../shared/ai-memory-contract'

/** Limites reaproveitados do contrato do bridge event. */
export const SYNC_SUMMARY_MAX_CHARS = 500
export const SYNC_MAX_ARTIFACTS = 16
export const SYNC_ARTIFACT_MAX_CHARS = 240
/** Teto do body da página de sessão (episódico acumulado). */
export const SYNC_SESSION_BODY_MAX_CHARS = 60_000
/** Teto de taskId/target no body (nunca entram crus). */
export const SYNC_ID_MAX_CHARS = 200
export const SYNC_TARGET_MAX_CHARS = 300
/** Timeout default do flush (drain de shutdown). */
export const SYNC_FLUSH_DEFAULT_TIMEOUT_MS = 5_000

/**
 * Tags das páginas de outcome do Bridge: 'historical' marca evidência não
 * confiável a confirmar contra o checkout; 'devorbit-bridge' mantém a página
 * recuperável/filtrável — nunca um filtro que a oculte das buscas.
 */
export const SYNC_BRIDGE_PAGE_TAGS = ['devorbit-bridge', 'historical'] as const

/** Client mínimo (subconjunto de AiMemoryClient). */
export interface SyncMemoryClient {
  callTool(
    name: typeof AI_MEMORY_MCP_TOOLS[keyof typeof AI_MEMORY_MCP_TOOLS],
    args: Record<string, unknown>
  ): Promise<{ text: string; json?: unknown; isError: boolean }>
}

export interface SyncScope {
  workspace: string
  project: string
}

/* ------------------------------------------------------------------ */
/* Sessão episódica do Bridge (consumo por outcome consolidado)        */
/* ------------------------------------------------------------------ */

/**
 * Registro consumido pelo sync. Estruturalmente compatível com
 * `BridgeCycleOutcome` (src/main/bridge-service.ts) — o produtor define o tipo
 * canônico; aqui é a visão mínima para testes e Shell #2.
 */
export interface BridgeOutcomeRecord {
  taskId: string
  target: string
  projectPath?: string
  status: 'completed' | 'blocked' | 'failed'
  summary: string
  artifacts?: string[]
}

export function isCancellationSummary(summary: string | undefined): boolean {
  if (!summary) return false
  const normalized = summary.trim().toLowerCase()
  return normalized.startsWith('a espera da ponte foi cancelada')
}

function sanitizeText(value: string, maxChars: number): string {
  let sanitized = ''
  for (const character of value) {
    const code = character.charCodeAt(0)
    sanitized += code <= 0x1f || code === 0x7f ? ' ' : character
  }
  return redactSecretText(sanitized.trim().slice(0, maxChars))
}

/**
 * Path determinístico da página de sessão por taskId (ciclo lógico).
 *
 * O slug legível (`slugSource`, tipicamente o taskId já sanitizado) é
 * PRESERVADO; a identidade anti-colisão é o hash curto do taskId RAW
 * (case-sensitive) passado em `rawHashSource`. Ids raw distintos que
 * sanitizam para o mesmo slug (ex.: tab vs espaço) nunca colidem. Para ids já
 * limpos o slug continua legível e o path continua determinístico; o dedupe do
 * `handle` continua pelo taskId raw.
 */
export function bridgeOutcomePagePath(slugSource: string, rawHashSource: string = slugSource): string {
  const slug = slugSource
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'sem-task-id'
  const rawHash = createHash('sha256').update(rawHashSource).digest('hex').slice(0, 12)
  return `sessions/bridge-${slug}-${rawHash}.md`
}

export interface BridgeOutcomePage {
  path: string
  body: string
}

/**
 * Deriva a página episódica de um outcome consolidado. `undefined` = nada a
 * persistir (cancelamento, vazio). O prompt NUNCA entra aqui: o outcome não
 * o carrega e a descrição de tarefa vive no snapshot do squad.
 *
 * taskId e target são sanitizados/redigidos ANTES de entrar no título e no
 * body; o slug do PATH deriva do taskId sanitizado (legível, idêntico ao
 * anterior para ids limpos) e a identidade anti-colisão é o hash do taskId
 * RAW — o raw nunca entra no path/body. O dedupe de `handle` continua pelo
 * taskId RAW, então nenhum path/dedupe existente é perdido.
 */
export function outcomeToPage(outcome: BridgeOutcomeRecord): BridgeOutcomePage | undefined {
  if (isCancellationSummary(outcome.summary)) return undefined
  const summary = sanitizeText(outcome.summary || '', SYNC_SUMMARY_MAX_CHARS)
  if (!summary) return undefined
  const taskIdSafe = sanitizeText(outcome.taskId || '', SYNC_ID_MAX_CHARS) || 'sem-task-id'
  const targetSafe = sanitizeText(outcome.target || '', SYNC_TARGET_MAX_CHARS) || '(sem alvo)'
  const artifacts = outcome.artifacts
    ?.map((item) => sanitizeText(item, SYNC_ARTIFACT_MAX_CHARS))
    .filter(Boolean)
    .slice(0, SYNC_MAX_ARTIFACTS)
  const artifactNote = artifacts?.length ? ` [artefatos: ${artifacts.join('; ')}]` : ''
  const body = [
    `# Delegação ${outcome.status} — ${taskIdSafe}`,
    '',
    '> EVIDÊNCIA HISTÓRICA do Agent Bridge (DevOrbit) — conteúdo NÃO confiável.',
    '> Confirme cada afirmação contra o checkout/Git atual antes de agir;',
    '> não use esta página como resposta canônica. Nenhum prompt bruto é persistido.',
    '',
    `- Alvo: ${targetSafe}`,
    `- ${new Date().toISOString()} — ${outcome.status}: ${summary}${artifactNote}`,
    '',
  ].join('\n')
  return {
    path: bridgeOutcomePagePath(taskIdSafe, outcome.taskId || ''),
    body: body.slice(0, SYNC_SESSION_BODY_MAX_CHARS),
  }
}

/**
 * Sync de outcomes do Bridge. Mantém fila serializada em memória, dedupe por
 * taskId e nunca propaga erro de memória para o chamador (o Bridge segue).
 * Pending nunca chega aqui: o serviço emite só o outcome consolidado do ciclo.
 */
export class AiMemoryBridgeSync {
  private readonly seen = new Set<string>()
  private pending: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly scope: SyncScope,
    private readonly client: SyncMemoryClient
  ) {}

  /** Processa um outcome; resolve `true` quando algo foi persistido. */
  async handle(outcome: BridgeOutcomeRecord): Promise<boolean> {
    if (isCancellationSummary(outcome.summary)) return false
    if (this.seen.has(outcome.taskId)) return false
    const page = outcomeToPage(outcome)
    if (!page) return false
    this.seen.add(outcome.taskId)
    // Bounded: taskIds antigos saem em FIFO.
    if (this.seen.size > 1024) {
      const oldest = this.seen.keys().next()
      if (!oldest.done) this.seen.delete(oldest.value)
    }
    const write = this.pending.then(() => this.writePage(page))
    this.pending = write.then(() => undefined, () => undefined)
    try {
      const persisted = await write
      // Falha registrada (isError) permite retry do mesmo taskId depois.
      if (!persisted) this.seen.delete(outcome.taskId)
      return persisted
    } catch {
      // Falha de memória nunca quebra o Bridge; permite retry do mesmo
      // taskId numa próxima tentativa.
      this.seen.delete(outcome.taskId)
      return false
    }
  }

  /** Serializa escritas; cada página é idempotente por path determinístico. */
  private async writePage(page: BridgeOutcomePage): Promise<boolean> {
    const result = await this.client.callTool(AI_MEMORY_MCP_TOOLS.writePage, {
      workspace: this.scope.workspace,
      project: this.scope.project,
      path: page.path,
      body: page.body,
      // 'historical' marca evidência não confiável; 'devorbit-bridge' mantém
      // a página filtrável/recuperável (NUNCA um filtro que a oculte, como
      // 'do-not-answer-from').
      tags: [...SYNC_BRIDGE_PAGE_TAGS],
    })
    return !result.isError
  }

  /**
   * Drena APENAS as escritas JÁ enfileiradas no momento da chamada —
   * bounded/sem throw: espera no máx. `timeoutMs`
   * (default `SYNC_FLUSH_DEFAULT_TIMEOUT_MS`); timeout não lança. Não
   * consome novos outcomes, não re-lê e não faz retry: o index pode aguardar
   * este drain antes de parar o sidecar.
   */
  async flush(timeoutMs: number = SYNC_FLUSH_DEFAULT_TIMEOUT_MS): Promise<void> {
    const queued = this.pending
    const bound =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : SYNC_FLUSH_DEFAULT_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        queued,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, bound)
        }),
      ])
    } catch {
      // `queued` nunca rejeita (erros já são engolidos na fila); defesa extra.
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

/* ------------------------------------------------------------------ */
/* Snapshot consolidado do squad                                       */
/* ------------------------------------------------------------------ */

export interface SquadMemberState {
  id: string
  title?: string
  role?: string
  status: 'done' | 'in-progress' | 'pending' | 'blocked'
  terminalId?: string
  provider?: string
  model?: string
}

/**
 * Tarefa consolidada do squad. `requestId` só entra aqui por ASSOCIAÇÃO
 * EXPLÍCITA (UI/Canvas/Shell #2) — nunca inferida do tráfego do Bridge.
 */
export interface SquadTask {
  id: string
  title: string
  status: 'done' | 'in-progress' | 'pending' | 'blocked'
  memberId?: string
  requestId?: string
  /** Descrição/responsabilidade fornecida pelo snapshot — JAMAIS prompt bruto. */
  description?: string
}

export interface SquadSnapshot {
  id: string
  objective: string
  plan?: string
  members: readonly SquadMemberState[]
  tasks?: readonly SquadTask[]
  /** Arquivos tocados/observados (redigidos). */
  files?: readonly string[]
  decisions?: readonly string[]
  failures?: readonly string[]
  discardedApproaches?: readonly string[]
  blockers?: readonly string[]
  nextSteps?: readonly string[]
  updatedAt?: string
}

function redactList(items: readonly string[] | undefined, max: number): string[] | undefined {
  if (!items?.length) return undefined
  return items
    .map((item) => sanitizeText(item, 300))
    .filter(Boolean)
    .slice(0, max)
}

/** Sanitização/redação de texto de snapshot (exportada para o IPC). */
export function sanitizeSnapshotText(value: string, maxChars: number): string {
  return sanitizeText(value, maxChars)
}

const SNAPSHOT_STATUSES = new Set(['done', 'in-progress', 'pending', 'blocked'])
const SNAPSHOT_MAX_MEMBERS = 64
const SNAPSHOT_MAX_TASKS = 256

/**
 * Valida e sanitiza o snapshot vindo da UI ANTES de qualquer persistência:
 * - campos obrigatórios (id, objective) ausentes → `undefined` (nada publicado);
 * - status inválido de membro/tarefa → entrada DESCARTADA;
 * - arrays limitados (membros 64, tarefas 256, seções 32) e strings cap+redigidas.
 * Nunca lança; o chamador decide como tratar `undefined`.
 */
export function sanitizeSnapshot(snapshot: unknown): SquadSnapshot | undefined {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined
  const raw = snapshot as Record<string, unknown>
  const id = typeof raw.id === 'string' ? sanitizeText(raw.id, 200) : ''
  const objective = typeof raw.objective === 'string' ? sanitizeText(raw.objective, 2_000) : ''
  if (!id || !objective) return undefined
  const plan = typeof raw.plan === 'string' ? sanitizeText(raw.plan, 2_000) : undefined
  const members: SquadMemberState[] = []
  if (Array.isArray(raw.members)) {
    for (const item of raw.members.slice(0, SNAPSHOT_MAX_MEMBERS)) {
      if (typeof item !== 'object' || item === null) continue
      const member = item as Record<string, unknown>
      const memberId = typeof member.id === 'string' ? sanitizeText(member.id, 200) : ''
      const status = typeof member.status === 'string' ? member.status : ''
      if (!memberId || !SNAPSHOT_STATUSES.has(status)) continue
      members.push({
        id: memberId,
        status: status as SquadMemberState['status'],
        ...(typeof member.title === 'string' ? { title: sanitizeText(member.title, 200) } : {}),
        ...(typeof member.role === 'string' ? { role: sanitizeText(member.role, 200) } : {}),
        ...(typeof member.terminalId === 'string' ? { terminalId: sanitizeText(member.terminalId, 100) } : {}),
        ...(typeof member.provider === 'string' ? { provider: sanitizeText(member.provider, 100) } : {}),
        ...(typeof member.model === 'string' ? { model: sanitizeText(member.model, 100) } : {}),
      })
    }
  }
  const tasks: SquadTask[] = []
  if (Array.isArray(raw.tasks)) {
    for (const item of raw.tasks.slice(0, SNAPSHOT_MAX_TASKS)) {
      if (typeof item !== 'object' || item === null) continue
      const task = item as Record<string, unknown>
      const taskId = typeof task.id === 'string' ? sanitizeText(task.id, 200) : ''
      const title = typeof task.title === 'string' ? sanitizeText(task.title, 200) : ''
      const status = typeof task.status === 'string' ? task.status : ''
      if (!taskId || !title || !SNAPSHOT_STATUSES.has(status)) continue
      tasks.push({
        id: taskId,
        title,
        status: status as SquadTask['status'],
        ...(typeof task.memberId === 'string' ? { memberId: sanitizeText(task.memberId, 200) } : {}),
        ...(typeof task.requestId === 'string' ? { requestId: sanitizeText(task.requestId, 200) } : {}),
        ...(typeof task.description === 'string' ? { description: sanitizeText(task.description, 2_000) } : {}),
      })
    }
  }
  const section = (key: string): string[] | undefined => {
    const items = raw[key]
    if (!Array.isArray(items)) return undefined
    const sanitized = items
      .filter((item): item is string => typeof item === 'string')
      .map((item) => sanitizeText(item, 300))
      .filter(Boolean)
      .slice(0, 32)
    return sanitized.length > 0 ? sanitized : undefined
  }
  const files = section('files')
  const decisions = section('decisions')
  const failures = section('failures')
  const discardedApproaches = section('discardedApproaches')
  const blockers = section('blockers')
  const nextSteps = section('nextSteps')
  return {
    id,
    objective,
    ...(plan !== undefined && plan ? { plan } : {}),
    members,
    ...(tasks.length > 0 ? { tasks } : {}),
    ...(files ? { files } : {}),
    ...(decisions ? { decisions } : {}),
    ...(failures ? { failures } : {}),
    ...(discardedApproaches ? { discardedApproaches } : {}),
    ...(blockers ? { blockers } : {}),
    ...(nextSteps ? { nextSteps } : {}),
    ...(typeof raw.updatedAt === 'string' && raw.updatedAt.trim() ? { updatedAt: raw.updatedAt.slice(0, 40) } : {}),
  }
}

/** Status de bridge event aceito na projeção de tarefa. */
export type BridgeEventStatusForTask = 'pending' | 'completed' | 'blocked' | 'failed'

/**
 * Aplica um status de bridge a UMA tarefa. Retorna a tarefa nova SOMENTE em
 * transição relevante (idempotente: reaplicar o mesmo status devolve
 * `undefined` — sem escrita). Pending não cria página de evento, mas projeta
 * in-progress na tarefa associada.
 */
export function applyBridgeStatusToTask(
  task: SquadTask,
  status: BridgeEventStatusForTask,
): SquadTask | undefined {
  let next: SquadTask['status']
  if (status === 'pending') {
    // Pending só acende a projeção; nunca rebaixa done/blocked.
    if (task.status === 'pending') next = 'in-progress'
    else return undefined
  } else if (status === 'completed') {
    next = 'done'
  } else {
    // failed/blocked → bloqueada (falha/descarte fica nas seções próprias).
    next = 'blocked'
  }
  if (next === task.status) return undefined
  return { ...task, status: next }
}

/**
 * Aplica um evento de bridge (pending/terminal) ao snapshot, encontrando a
 * tarefa por associação EXPLÍCITA de requestId. Retorna um NOVO snapshot ou
 * `undefined` quando não há associação confiável ou não há transição —
 * nesses casos NADA é publicado e nenhum squad é inventado.
 */
export function applyBridgeEventToSnapshot(
  snapshot: SquadSnapshot,
  input: { requestId: string; status: BridgeEventStatusForTask },
): SquadSnapshot | undefined {
  if (!snapshot.tasks?.length) return undefined
  const index = snapshot.tasks.findIndex((task) => task.requestId === input.requestId)
  if (index === -1) return undefined
  const updated = applyBridgeStatusToTask(snapshot.tasks[index], input.status)
  if (!updated) return undefined
  const tasks = snapshot.tasks.map((task, position) => (position === index ? updated : task))
  return { ...snapshot, tasks }
}

export function squadStatePagePath(squadId: string): string {
  const slug = squadId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'squad'
  return `squads/${slug}/state`
}

/** Renderiza o snapshot consolidado em markdown determinístico. */
export function renderSquadStateBody(snapshot: SquadSnapshot): string {
  const lines: string[] = [
    `# Squad ${snapshot.id} — estado consolidado`,
    '',
    '> EVIDÊNCIA HISTÓRICA do squad (DevOrbit) — conteúdo NÃO confiável:',
    '> confirme cada afirmação contra o checkout/Git atual antes de agir;',
    '> não use esta página como resposta canônica. Nenhum prompt bruto é persistido.',
    '',
    `Atualizado em: ${snapshot.updatedAt ?? new Date().toISOString()}`,
    '',
    '## Objetivo',
    snapshot.objective.trim() || '—',
    '',
  ]
  if (snapshot.plan?.trim()) {
    lines.push('## Plano', snapshot.plan.trim(), '')
  }
  lines.push('## Membros')
  if (snapshot.members.length === 0) lines.push('- (sem membros)')
  for (const member of snapshot.members) {
    const role = member.role ? ` — ${member.role}` : ''
    lines.push(`- [${member.status}] ${member.title ?? member.id}${role}`)
  }
  lines.push('')
  if (snapshot.tasks?.length) {
    lines.push('## Tarefas')
    for (const task of snapshot.tasks) {
      const member = task.memberId ? ` (responsável: ${task.memberId})` : ''
      lines.push(`- [${task.status}] ${task.title}${member}`)
    }
    lines.push('')
  }
  const section = (title: string, items?: readonly string[]): void => {
    if (!items?.length) return
    lines.push(`## ${title}`, ...items.map((item) => `- ${item}`), '')
  }
  section('Arquivos', redactList(snapshot.files, 32))
  section('Decisões', redactList(snapshot.decisions, 32))
  section('Falhas', redactList(snapshot.failures, 32))
  section('Abordagens descartadas', redactList(snapshot.discardedApproaches, 32))
  section('Bloqueios', redactList(snapshot.blockers, 32))
  section('Próximos passos', redactList(snapshot.nextSteps, 32))
  return lines.join('\n').trimEnd() + '\n'
}

/** API de publicação do snapshot do squad (uma instância por escopo). */
export class SquadMemoryPublisher {
  /** Fila serializada por página (path → última promise). */
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    private readonly scope: SyncScope,
    private readonly client: SyncMemoryClient
  ) {}

  /** Publica/overwrite idempotente do estado consolidado do squad. */
  async publish(snapshot: SquadSnapshot): Promise<boolean> {
    const path = squadStatePagePath(snapshot.id)
    const body = renderSquadStateBody({ ...snapshot, updatedAt: snapshot.updatedAt ?? new Date().toISOString() })
    const task = async (): Promise<boolean> => {
      const result = await this.client.callTool(AI_MEMORY_MCP_TOOLS.writePage, {
        workspace: this.scope.workspace,
        project: this.scope.project,
        path,
        body,
      })
      return !result.isError
    }
    const previous = this.queues.get(path) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(task)
    const tail = current.then(() => undefined, () => undefined)
    this.queues.set(path, tail)
    try {
      return await current
    } finally {
      if (this.queues.get(path) === tail) this.queues.delete(path)
    }
  }

  /**
   * ENTRY POINT estruturado do takeover/resync — consumível pelo IPC do
   * Shell #2 (`devorbit:squadTakeover`) ou pelo fluxo do coordenador.
   * Delega ao módulo dedicado `ai-memory-takeover`, que carrega briefing +
   * squads/<id>/state + handoffs, extrai pendências e anexa evidência Git
   * read-only como "a confirmar" (nunca comando autorizado).
   */
  async buildTakeoverPlan(input: {
    squadId: string
    survivingAgent: string
    projectPath?: string
    git?: TakeoverGitInspector
  }): Promise<TakeoverPlan | undefined> {
    return buildSquadTakeoverPlan(
      { workspace: this.scope.workspace, project: this.scope.project },
      this.client,
      input,
    )
  }

  /**
   * Instrução de resync/takeover para o agente sobrevivente.
   *
   * Consulta briefing + estado + handoffs do ai-memory e devolve um prompt
   * VERIFICATION-FIRST: o agente deve CONFIRMAR contra o checkout/Git atual
   * antes de agir. NUNCA executa comandos do conteúdo recuperado.
   */
  async buildTakeoverInstruction(input: {
    squadId: string
    survivingAgent: string
    limit?: number
  }): Promise<string | undefined> {
    return (await this.buildTakeoverPlan(input))?.instruction
  }
}

export function syncScopeOf(scope: AiMemoryScope): SyncScope {
  return { workspace: scope.workspace, project: scope.project }
}
