import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Bot,
  Crown,
  Edit2,
  FileCode2,
  FileText,
  GitBranch,
  Globe2,
  Grip,
  Link2,
  MousePointer2,
  NotebookPen,
  RotateCcw,
  Send,
  Settings2,
  Terminal,
  Trash2,
  Unlink,
  Users,
  X,
} from "lucide-react";
import type { AgentProvider, AgentProviderId, Project } from "../types";
import type { AgentResult } from "../../../shared/agent-result";
import type {
  ContinuityEvent,
  OrchestrationRole,
  OrchestrationState,
} from "../../../shared/orchestration-continuity";
import type {
  CustomTerminalPreset,
  TerminalNodeRuntimeConfig,
  TerminalPresetDefinition,
} from "../../../shared/terminal-presets";
import {
  CUSTOM_TERMINAL_PRESET_LIMIT,
  createTerminalNodeConfig,
  getTerminalPreset,
  resolveTerminalLaunch,
  sanitizeCustomTerminalPreset,
  sanitizeTerminalNodeConfig,
} from "../../../shared/terminal-presets";
import {
  addSquadMember,
  CANVAS_ZOOM_LEVELS,
  collectSquadAnchorIds,
  computeCanvasFocus,
  computeFocusViewport,
  computeSquadRegions,
  createsAgentCycle,
  inferCanvasEdgeKind,
  parseSquadAnchorId,
  removeSquadMember,
  resolveCanvasNodeSlot,
  renameSquad,
  sanitizeAgentCycles,
  sanitizeCanvasEdges,
  setSquadCoordinator,
  setSquadObjective,
  squadAnchorId,
  squadCoordinatedBy,
  squadForNode,
  stepZoomLevel,
  toggleSquadCollapsed,
} from "./workspace-request-helpers";
import { AgentCreationDialog } from "./AgentCreationDialog";
import { CanvasToolbar, type CanvasZoomPreset } from "./CanvasToolbar";
import { CanvasNodeInspector } from "./CanvasNodeInspector";
import {
  agentNodeBlockedLabel,
  agentNodeSetupMessage,
  isAgentNodeConfigured,
  isCoordinatorRole,
  requiresCodexAccount,
  resolveAgentProvider,
  resolveSquadCoordinator,
  sanitizeAgentRole,
  type AgentCreationSpec,
  type SquadCreationSpec,
} from "./agent-creation-helpers";
import { agentSendPolicy } from "./agent-send-policy";
import {
  CANVAS_STATE_VERSION,
  READABLE_CANVAS_VERSIONS,
  TERMINAL_COMMAND_INVALID_HINT,
  buildQuickDeployChips,
  canvasEdgeLabel,
  defaultCanvasEdgeKind,
  formatArgsInput,
  isOrderingEdgeKind,
  isTerminalCommandTextRejected,
  migrateCanvasNodesForTerminals,
  migrateCanvasStateV5,
  parseArgsInput,
  slugifyCustomPresetId,
  terminalNodeTitle,
  type CanvasEdgeKind,
  deleteCustomTerminalPreset,
  renameCustomTerminalPreset,
} from "./terminal-node-helpers";
import { CanvasNodeCard } from "./CanvasNodeCard";
import { CanvasMinimap } from "./CanvasMinimap";
import { CanvasRadialMenu, type CanvasRadialItem } from "./CanvasRadialMenu";
import "./WorkspaceCanvas.css";

export type NodeKind = "workbench" | "browser" | "note" | "agent" | "terminal";
export type AgentRole = "Coordenador" | "Implementação" | "Revisão" | "Testes";
export interface CanvasNode {
  id: string;
  kind: NodeKind;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  content?: string;
  /** Papel built-in ou string custom; orquestração só reconhece built-ins. */
  role?: string;
  account?: "account1" | "account2";
  provider?: AgentProviderId;
  terminal?: TerminalNodeRuntimeConfig;
}
export interface CanvasConnection {
  id: string;
  from: string;
  to: string;
  /** Semântica da aresta; ausente = 'flow' (comportamento v2–v4). */
  kind?: CanvasEdgeKind;
  /** Rótulo opcional exibido na aresta. */
  label?: string;
}
export interface CanvasSquad {
  id: string;
  title: string;
  objective?: string;
  /** Ausente = sem coordenador; sempre um membro quando definido. */
  coordinatorNodeId?: string;
  memberNodeIds: string[];
  collapsed?: boolean;
}
interface CanvasState {
  version: typeof CANVAS_STATE_VERSION;
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  squads: CanvasSquad[];
  viewport: { x: number; y: number; zoom: number };
}
interface ConnectionDraft {
  from: string;
  x: number;
  y: number;
  pointerId: number;
}
interface CanvasGesture {
  type: "drag" | "resize" | "pan";
  sx: number;
  sy: number;
  nodes?: CanvasNode[];
  viewport?: CanvasState["viewport"];
  id?: string;
  pointerId: number;
}
type OrchestrationPhase =
  | "planning"
  | "specialist"
  | "finalizing"
  | "complete"
  | "blocked";
export type AgentProgressState = "queued" | "running" | "completed" | "blocked";
export interface AgentProgress {
  state: AgentProgressState;
  label: string;
}
export interface OrchestrationNote {
  id: string;
  title: string;
  content: string;
}
export interface OrchestrationAgent {
  id: string;
  title: string;
  role: string;
  notes: OrchestrationNote[];
}
interface OrchestrationResult {
  agentId: string;
  title: string;
  role: string;
  content: string;
}
interface OrchestrationRun {
  id: string;
  projectId: string;
  coordinatorId: string;
  coordinatorTitle: string;
  notes: OrchestrationNote[];
  specialists: OrchestrationAgent[];
  phase: OrchestrationPhase;
  specialistIndex: number;
  expectedAgentId: string;
  expectedTaskId?: string;
  plan: string;
  results: OrchestrationResult[];
  lastHandledResult?: string;
}
interface LegacyCanvas {
  cards?: Array<{
    id?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    z?: number;
  }>;
  note?: string;
  squads?: unknown;
}
/**
 * Rascunho dos campos de texto do painel do terminal (comando, argumentos,
 * diretório). A digitação NÃO passa pelo sanitize — o commit acontece em
 * blur/Enter, para não apagar o texto sob o cursor com %, ! ou comandos longos.
 */
interface TerminalFieldDraft {
  nodeId: string;
  command: string;
  args: string;
  cwd: string;
}

const WORLD_WIDTH = 5200;
const WORLD_HEIGHT = 3400;
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 1.6;
const GRID = 20;
/** Geometria efêmera do cartão compacto (não persiste em width/height). */
export const COMPACT_NODE_WIDTH = 320;
export const COMPACT_NODE_HEIGHT = 130;
const fixedKinds = new Set<NodeKind>(["workbench", "browser"]);
const nodeMeta: Record<NodeKind, { label: string; meta: string; icon: React.ReactNode }> = {
  workbench: { label: "Editor e terminal", meta: "WORKBENCH", icon: <FileCode2 size={13} /> },
  browser: { label: "Navegador do projeto", meta: "BROWSER", icon: <Globe2 size={13} /> },
  note: { label: "Nota", meta: "INTEL", icon: <NotebookPen size={13} /> },
  agent: { label: "Agente", meta: "AGENTE", icon: <Bot size={13} /> },
  terminal: { label: "Terminal", meta: "TERMINAL", icon: <Terminal size={13} /> },
};
const defaults = (): CanvasState => ({
  version: CANVAS_STATE_VERSION,
  viewport: { x: 40, y: 36, zoom: 1 },
  connections: [],
  squads: [],
  nodes: [
    {
      id: "workbench",
      kind: "workbench",
      title: "Editor e terminal",
      x: 40,
      y: 40,
      width: 700,
      height: 570,
      z: 1,
    },
    {
      id: "note-handoff",
      kind: "note",
      title: "Handoff",
      x: 780,
      y: 40,
      width: 330,
      height: 270,
      z: 2,
      content: "",
    },
    {
      id: "browser",
      kind: "browser",
      title: "Navegador do projeto",
      x: 780,
      y: 350,
      width: 360,
      height: 360,
      z: 3,
    },
  ],
});
const key = (id: string) => "devorbit:workspace-canvas:" + id;
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const snap = (value: number) => Math.round(value / GRID) * GRID;
const nodeId = () =>
  "note-" +
  Date.now().toString(36) +
  "-" +
  Math.random().toString(36).slice(2, 7);

/** Default compacto: apenas Agent/Terminal nascem resumidos. */
export function isCompactByDefault(node: Pick<CanvasNode, "kind">): boolean {
  return node.kind === "agent" || node.kind === "terminal";
}

/**
 * Geometria efêmera de exibição: cartão compacto vira 320x130 sem tocar em
 * `width`/`height` persistidos. Usado por arestas, região de squad, fit e
 * minimap para alinhar a geometria derivada ao DOM compacto.
 */
export function nodeDisplayGeometry(node: CanvasNode, compact: boolean): CanvasNode {
  return compact
    ? { ...node, width: COMPACT_NODE_WIDTH, height: COMPACT_NODE_HEIGHT }
    : node;
}

const orchestrationRoleOrder: readonly string[] = [
  "Implementação",
  "Revisão",
  "Testes",
];
const legacyOrchestrationResultInstruction =
  "Esta etapa faz parte de uma orquestração automática. Ao concluir, imprima uma única linha iniciada por DEVORBIT_RESULT: e seguida de um resumo objetivo. Use DEVORBIT_RESULT: CONCLUIDO: para uma etapa concluída; se não puder continuar, use DEVORBIT_RESULT: BLOQUEADO: e explique o motivo. Não aguarde outro clique para encaminhar a próxima etapa.";
export const orchestrationResultInstruction = legacyOrchestrationResultInstruction &&
  'Emita primeiro uma única linha com JSON compacto: DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"resumo objetivo"}. Use outcome completed, blocked ou failed e summary objetivo, sem quebras de linha e com no máximo 1000 caracteres. Emita imediatamente depois o espelho legado DEVORBIT_RESULT: CONCLUIDO: <resumo>, DEVORBIT_RESULT: BLOQUEADO: <motivo> ou DEVORBIT_RESULT: FALHA: <motivo>. O JSON vem primeiro e não aguarde outro clique para encaminhar a próxima etapa.';

/**
 * A instrução de resultado SEMPRE vem primeiro no prompt do agente. Assim
 * qualquer truncamento de prefixo (limite do turno/IPC) preserva o contrato
 * DEVORBIT_RESULT intacto e corta apenas o corpo de notas/resultados.
 */
export function composeAgentPrompt(lines: string[]): string {
  return [
    orchestrationResultInstruction,
    ...lines.filter((line) => line !== orchestrationResultInstruction),
  ].join("\n");
}
const orchestrationRunId = () =>
  "orchestration-" +
  Date.now().toString(36) +
  "-" +
    Math.random().toString(36).slice(2, 7);
const agentProviderIds: AgentProviderId[] = [
  "codex",
  "opencode",
  "claude",
  "gemini",
  "aider",
  "agy",
  "custom",
];
function isAgentProviderId(value: unknown): value is AgentProviderId {
  return typeof value === "string" && agentProviderIds.includes(value as AgentProviderId);
}
const connectionPath = (
  from: { x: number; y: number; width: number; height: number },
  toX: number,
  toY: number,
) => {
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const distance = Math.abs(toX - x1);
  const curve = Math.max(70, distance * 0.4);
  if (toX >= x1)
    return `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${toX - curve} ${toY}, ${toX} ${toY}`;
  return `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${toX + curve} ${toY}, ${toX} ${toY}`;
};
function closestElement(target: unknown, selector: string): Element | null {
  return target instanceof Element ? target.closest(selector) : null;
}
function sanitizeNode(
  value: Partial<CanvasNode>,
  fallback: CanvasNode,
  defaultProvider: AgentProviderId | null = null,
): CanvasNode {
  const width = Number.isFinite(value.width)
    ? clamp(value.width as number, 220, 1100)
    : fallback.width;
  const height = Number.isFinite(value.height)
    ? clamp(value.height as number, 150, 850)
    : fallback.height;
  const kind =
    value.kind === "workbench" ||
    value.kind === "browser" ||
    value.kind === "note" ||
    value.kind === "agent" ||
    value.kind === "terminal"
      ? value.kind
      : fallback.kind;
  // Escolha explícita do nó sempre vence; o executor padrão só preenche nó de
  // agente sem provider (nós antigos), nunca sobrescreve um provider válido.
  const provider = resolveAgentProvider(value.provider, fallback.provider, kind, defaultProvider);
  // Config de Smart Terminal: só existe em nó terminal e sempre sai saneada
  // (lixo de versões antigas vira undefined).
  const terminal =
    kind === "terminal" ? sanitizeTerminalNodeConfig(value.terminal) : undefined;
  return {
    id: typeof value.id === "string" ? value.id : fallback.id,
    kind,
    title:
      typeof value.title === "string" && value.title.trim()
        ? value.title.slice(0, 80)
        : fallback.title,
    x: Number.isFinite(value.x)
      ? clamp(value.x as number, 0, WORLD_WIDTH - width)
      : fallback.x,
    y: Number.isFinite(value.y)
      ? clamp(value.y as number, 0, WORLD_HEIGHT - height)
      : fallback.y,
    width,
    height,
    z: Number.isFinite(value.z) ? (value.z as number) : fallback.z,
    content:
      typeof value.content === "string"
        ? value.content.slice(0, 24000)
        : fallback.content,
    role:
      typeof value.role === "string" && value.role.trim()
        ? sanitizeAgentRole(value.role)
        : fallback.role,
    account:
      value.account === "account2"
        ? "account2"
        : value.account === "account1"
          ? "account1"
          : fallback.account,
    provider,
    terminal,
  };
}
/**
 * Saneia squads v5: membros livres (sem teto 4/32), papéis vivem nos nós,
 * coordenador OPCIONAL e sempre membro, objetivo e collapse persistidos.
 * Squad sem membro válido é descartado; coordenador inválido vira ausente —
 * nunca promove substituto.
 */
export function sanitizeSquads(value: unknown, nodes: readonly CanvasNode[]): CanvasSquad[] {
  if (!Array.isArray(value)) return [];
  const agentNodeIds = new Set(nodes.filter((node) => node.kind === "agent").map((node) => node.id));
  const result: CanvasSquad[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<CanvasSquad>;
    const memberNodeIds = Array.isArray(raw.memberNodeIds)
      ? [...new Set(raw.memberNodeIds.filter((id): id is string => typeof id === "string" && agentNodeIds.has(id)))]
      : [];
    if (
      typeof raw.id !== "string" ||
      typeof raw.title !== "string" ||
      !raw.title.trim() ||
      memberNodeIds.length === 0
    ) continue;
    const coordinatorNodeId =
      typeof raw.coordinatorNodeId === "string" && memberNodeIds.includes(raw.coordinatorNodeId)
        ? raw.coordinatorNodeId
        : undefined;
    result.push({
      id: raw.id.slice(0, 80),
      title: raw.title.trim().slice(0, 80),
      objective: typeof raw.objective === "string" ? raw.objective.slice(0, 2000) : "",
      memberNodeIds,
      ...(coordinatorNodeId ? { coordinatorNodeId } : {}),
      collapsed: raw.collapsed === true,
    });
  }
  return result;
}
export type RawCanvasState =
  | ({
      version?: number;
      nodes?: unknown;
      connections?: unknown;
      viewport?: CanvasState["viewport"];
    } & LegacyCanvas)
  | null;

/**
 * Restaura o estado persistido (fixture de restore testável): migra v2–v4 para
 * v5 sem perder nós, posições, arestas nem squads legados; entrada inválida cai
 * no canvas default. É o mesmo caminho usado pelo localStorage em `read`.
 */
export function parseCanvasState(
  raw: RawCanvasState,
  defaultProvider: AgentProviderId | null = null,
): CanvasState {
  const fallback = defaults();
  if (!raw || typeof raw !== "object") return fallback;
  {
    if (
      (READABLE_CANVAS_VERSIONS as readonly number[]).includes(raw.version ?? -1) &&
      Array.isArray(raw.nodes)
    ) {
      // Migração v3 → v4: nós sem terminal passam intactos; nós terminal
      // recebem a config saneada (inválida sai sem terminal).
      const migratedNodes = migrateCanvasNodesForTerminals(
        raw.nodes as readonly { kind?: unknown; terminal?: unknown }[],
      );
      const nodes = migratedNodes.map((node, index) =>
        sanitizeNode(
          // O sanitize revalida kind/terminal; o escopo de types aqui é só o
          // transporte da migração v3 → v4.
          node as Partial<CanvasNode>,
          fallback.nodes[index] || {
            id: nodeId(),
            kind: "note",
            title: "Nota",
            x: 220 + index * 30,
            y: 220 + index * 30,
            width: 330,
            height: 240,
            z: index + 1,
            content: "",
          },
          defaultProvider,
        ),
      );
      const ids = new Set(nodes.map((node) => node.id));
      const agentIds = new Set(nodes.filter((node) => node.kind === "agent").map((node) => node.id));
      // Migração v4 → v5 não-destrutiva: arestas ganham tipo default e squads
      // ganham objetivo/coordenador opcional/collapse sem perder posições.
      const migratedState = migrateCanvasStateV5(raw);
      // Canvas v2 nunca teve squads explícitos. Não inferimos participação
      // por conexões: ela só passa a existir após confirmação do usuário.
      const squads = raw.version !== 2 ? sanitizeSquads(migratedState.squads, nodes) : [];
      const anchorIds = collectSquadAnchorIds(squads);
      const validConnections = migratedState.connections.filter(
        (connection): connection is CanvasConnection =>
          Boolean(
            connection &&
            typeof connection === "object" &&
            typeof (connection as CanvasConnection).id === "string" &&
            typeof (connection as CanvasConnection).from === "string" &&
            typeof (connection as CanvasConnection).to === "string",
          ),
      );
      return {
        version: CANVAS_STATE_VERSION,
        nodes,
        // Saneia arestas persistidas: ciclos de ordenação agente-agente são
        // descartados na ordem armazenada; vínculos Nota→Squad sobrevivem via
        // âncora `squad:<id>`.
        connections: sanitizeCanvasEdges(validConnections, ids, agentIds, anchorIds),
        squads,
        viewport: {
          x: Number.isFinite(raw.viewport?.x)
            ? raw.viewport!.x
            : fallback.viewport.x,
          y: Number.isFinite(raw.viewport?.y)
            ? raw.viewport!.y
            : fallback.viewport.y,
          zoom: Number.isFinite(raw.viewport?.zoom)
            ? clamp(raw.viewport!.zoom, MIN_ZOOM, MAX_ZOOM)
            : 1,
        },
      };
    }
    if (Array.isArray(raw.cards)) {
      const legacy = new Map(raw.cards.map((card) => [card.id, card]));
      return {
        ...fallback,
        nodes: fallback.nodes.map((node) =>
          sanitizeNode(
            {
              ...node,
              ...legacy.get(node.kind),
              content: node.kind === "note" ? raw.note : undefined,
            },
            node,
            defaultProvider,
          ),
        ),
      };
    }
    return fallback;
  }
}

export interface CanvasStorageLike {
  getItem(storageKey: string): string | null;
}

export interface CanvasStorageWriter {
  setItem(storageKey: string, value: string): void;
}

/** Leitura real do workspace (mesmo caminho do localStorage, injetável em teste). */
export function readCanvasState(
  storage: CanvasStorageLike,
  projectId: string,
  defaultProvider: AgentProviderId | null = null,
): CanvasState {
  try {
    return parseCanvasState(
      JSON.parse(storage.getItem(key(projectId)) || "null") as RawCanvasState,
      defaultProvider,
    );
  } catch {
    /* clean canvas */
    return defaults();
  }
}

/** Gravação real do workspace: JSON do estado v5 na chave do projeto. */
export function persistCanvasState(
  storage: CanvasStorageWriter,
  projectId: string,
  state: CanvasState,
): void {
  try {
    storage.setItem(key(projectId), JSON.stringify(state));
  } catch {
    /* optional */
  }
}

function read(id: string, defaultProvider: AgentProviderId | null = null): CanvasState {
  return readCanvasState(window.localStorage, id, defaultProvider);
}

export interface SquadCreationPlanOptions {
  defaultExecutor?: AgentProviderId | null;
  /** Gerador de id injetável (determinístico em teste). */
  createId?: () => string;
  /**
   * Quando true, cria a nota "Plano da tarefa" ligada à âncora do squad.
   * Default false: o squad nasce independente e sem nota; o objetivo persiste
   * no próprio squad e a nota só existe por ação explícita do usuário.
   */
  createNote?: boolean;
}

export interface SquadCreationPlan {
  agents: CanvasNode[];
  note: CanvasNode | null;
  connections: CanvasConnection[];
  squad: CanvasSquad;
  selectedIds: string[];
}

/**
 * Monta a criação de um squad de forma pura e testável: agentes, squad e
 * arestas de coordenação. A Nota (e o vínculo Note→Squad) só entra quando
 * `createNote` é explicitamente verdadeiro — o default é squad sem nota.
 */
export function planSquadCreation(
  spec: SquadCreationSpec,
  layout: { originX: number; originY: number; zBase: number },
  options: SquadCreationPlanOptions = {},
): SquadCreationPlan {
  const createId = options.createId ?? nodeId;
  const participants = spec.participants;
  const squadId = "squad-" + createId().slice(5);
  const objective = (spec.objective ?? "").trim().slice(0, 2000);
  const columns = participants.length <= 2 ? participants.length : participants.length <= 4 ? 2 : 3;
  const cellWidth = 460;
  const cellHeight = 320;
  const gapX = 40;
  const gapY = 40;
  const agents: CanvasNode[] = participants.map((participant, index) => {
    const role = sanitizeAgentRole(participant.role);
    const provider = participant.provider ?? options.defaultExecutor ?? undefined;
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      id: createId(),
      kind: "agent",
      title: participant.title?.trim().slice(0, 80) || (role === "Implementação" ? "Agente de implementação" : "Agente: " + role),
      role,
      ...(participant.account ? { account: participant.account } : {}),
      ...(provider ? { provider } : {}),
      x: clamp(layout.originX + column * (cellWidth + gapX), 0, WORLD_WIDTH - cellWidth),
      y: clamp(layout.originY + row * (cellHeight + gapY), 0, WORLD_HEIGHT - cellHeight),
      width: cellWidth,
      height: cellHeight,
      z: layout.zBase + index + 2,
    };
  });
  // Coordenador explícito ou ausente — nunca inferido por papel.
  const coordinatorChoice = resolveSquadCoordinator(spec);
  const coordinator =
    coordinatorChoice.valid && coordinatorChoice.index !== null
      ? agents[coordinatorChoice.index]
      : undefined;
  const connections: CanvasConnection[] = coordinator
    ? agents
        .filter((agent) => agent.id !== coordinator.id)
        .map((agent) => ({
          id: "link-" + coordinator.id + "-" + agent.id,
          from: coordinator.id,
          to: agent.id,
          kind: "coordination" as const,
        }))
    : [];
  let note: CanvasNode | null = null;
  if (options.createNote) {
    note = {
      id: createId(),
      kind: "note",
      title: "Plano da tarefa",
      content: objective
        ? "# Objetivo\n\n" + objective
        : "# Objetivo\n\nDescreva a tarefa, critérios de aceite e limites aqui.\n\n# Entregáveis\n\n- Implementação\n- Revisão\n- Testes",
      x: layout.originX,
      y: layout.originY,
      width: 340,
      height: 300,
      z: layout.zBase + 1,
    };
    connections.unshift({
      id: "link-" + note.id + "-" + squadId,
      from: note.id,
      to: squadAnchorId(squadId),
      kind: "membership",
      ...(objective ? { label: "objetivo" } : {}),
    });
  }
  const squad: CanvasSquad = {
    id: squadId,
    title: spec.title.trim(),
    objective,
    memberNodeIds: agents.map((agent) => agent.id),
    ...(coordinator ? { coordinatorNodeId: coordinator.id } : {}),
    collapsed: false,
  };
  const selectedIds = note
    ? [note.id, ...agents.map((agent) => agent.id)]
    : agents.map((agent) => agent.id);
  return { agents, note, connections, squad, selectedIds };
}

/**
 * Guarda de integridade do squad v5: o modelo exige ao menos um membro. Squad
 * vazio não é desenhado por `computeSquadRegions` e é descartado por
 * `sanitizeSquads` no reload (perde título/objetivo). Remover o último membro
 * é bloqueado; remover quem não é membro é inócuo.
 */
export function canRemoveSquadMember(
  squad: Pick<CanvasSquad, "memberNodeIds">,
  nodeId: string,
): boolean {
  if (!squad.memberNodeIds.includes(nodeId)) return false;
  return squad.memberNodeIds.length > 1;
}

function connectedNotes(
  state: Pick<CanvasState, "nodes" | "connections">,
  nodeIdValue: string,
): OrchestrationNote[] {
  const noteIds = new Set(
    state.connections
      .filter(
        (connection) =>
          connection.from === nodeIdValue || connection.to === nodeIdValue,
      )
      .map((connection) =>
        connection.from === nodeIdValue ? connection.to : connection.from,
      ),
  );
  return state.nodes
    .filter(
      (node) =>
        node.kind === "note" &&
        noteIds.has(node.id) &&
        Boolean(node.content?.trim()),
    )
    .map((node) => ({
      id: node.id,
      title: node.title,
      content: node.content!.trim(),
    }));
}

/**
 * Contexto de orquestração de um membro. Preserva as notas ligadas
 * diretamente ao agente (legado) e soma as notas ligadas à âncora do squad
 * (`squad:<id>`) e o objetivo explícito da squad, para que uma Note→Squad
 * alimente a equipe sem exigir cabo direto ao nó. O objetivo só entra como
 * nota sintética quando nenhuma nota já o carrega, evitando duplicação.
 * Retorno vazio = sem contexto: a orquestração não deve iniciar.
 */
export function orchestrationContextNotes(
  state: Pick<CanvasState, "nodes" | "connections">,
  memberNodeId: string,
  squad?: Pick<CanvasSquad, "id" | "objective"> | null,
): OrchestrationNote[] {
  const notes = new Map<string, OrchestrationNote>();
  for (const note of connectedNotes(state, memberNodeId)) notes.set(note.id, note);
  if (squad) {
    const anchor = squadAnchorId(squad.id);
    const anchoredNoteIds = new Set(
      state.connections
        .filter((connection) => connection.from === anchor || connection.to === anchor)
        .map((connection) => (connection.from === anchor ? connection.to : connection.from)),
    );
    for (const node of state.nodes) {
      if (node.kind !== "note" || !anchoredNoteIds.has(node.id) || !node.content?.trim()) continue;
      notes.set(node.id, { id: node.id, title: node.title, content: node.content.trim() });
    }
    const objective = (squad.objective ?? "").trim();
    if (objective && ![...notes.values()].some((note) => note.content.includes(objective))) {
      notes.set("squad-objective-" + squad.id, {
        id: "squad-objective-" + squad.id,
        title: "Objetivo da squad",
        content: objective,
      });
    }
  }
  return [...notes.values()];
}

/**
 * Contexto usado no envio manual de um membro: se ele pertence a um squad,
 * herda o contexto da squad (Note→Squad + objetivo); agente avulso mantém
 * apenas as notas ligadas diretamente a ele (comportamento legado).
 */
export function memberContextNotes(
  state: Pick<CanvasState, "nodes" | "connections" | "squads">,
  memberNodeId: string,
): OrchestrationNote[] {
  const squad = squadForNode(state.squads, memberNodeId);
  return squad
    ? orchestrationContextNotes(state, memberNodeId, squad)
    : connectedNotes(state, memberNodeId);
}

/**
 * Papel efetivo na orquestração. Papel custom NUNCA é reescrito para
 * "Implementação": ele mantém o texto do usuário e fica neutro na ordenação
 * (prioridade 999, tie-break por título), sem virar Coordenador.
 */
function orchestrationAgentRole(node: CanvasNode): string {
  return sanitizeAgentRole(node.role);
}

function continuityRoleFor(role: string | undefined, isCoordinator = false): OrchestrationRole {
  if (isCoordinator || role === "Coordenador") return "coordinator";
  if (role === "Revisão") return "reviewer";
  if (role === "Testes") return "tester";
  return "implementer";
}

const CONTINUITY_TRANSIENT_PATTERN = /limite|rate.?limit|quota|esgot|indispon|overload|429|503/i;

function continuityEventMessage(event: ContinuityEvent): string {
  const from = event.fromSeatId ? ` de ${event.fromSeatId}` : "";
  switch (event.type) {
    case "role.handoff":
      return `Continuidade: papel ${event.role ?? ""} assumido por ${event.toSeatId ?? "substituto"}${from}. ${event.reason}`.trim();
    case "handoff.blocked":
      return `Continuidade: handoff bloqueado (${event.reason}).`;
    case "seat.circuit.open":
      return `Continuidade: assento ${event.fromSeatId ?? ""} em circuit breaker.`;
    default:
      return event.reason;
  }
}

export function orderSpecialistsByGraph(
  specialists: OrchestrationAgent[],
  connections: readonly CanvasConnection[],
): OrchestrationAgent[] {
  if (specialists.length <= 1) return specialists;

  const ids = new Set(specialists.map((s) => s.id));
  const specialistMap = new Map(specialists.map((s) => [s.id, s]));

  // Só arestas de ordenação (flow legado, delegation, dependency) impõem
  // sequência; coordenação/contexto/membership não reordenam especialistas.
  const relevantConnections = connections.filter(
    (c) =>
      ids.has(c.from) &&
      ids.has(c.to) &&
      c.from !== c.to &&
      isOrderingEdgeKind(defaultCanvasEdgeKind(c.kind)),
  );

  const safeConnections = sanitizeAgentCycles(relevantConnections, ids);

  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const id of ids) {
    inDegree.set(id, 0);
    outgoing.set(id, []);
  }

  for (const conn of safeConnections) {
    outgoing.get(conn.from)!.push(conn.to);
    inDegree.set(conn.to, (inDegree.get(conn.to) || 0) + 1);
  }

  const rolePriority = (role: string): number => {
    const idx = orchestrationRoleOrder.indexOf(role);
    return idx >= 0 ? idx : 999;
  };

  const tieBreak = (aId: string, bId: string): number => {
    const a = specialistMap.get(aId)!;
    const b = specialistMap.get(bId)!;
    const rOrder = rolePriority(a.role) - rolePriority(b.role);
    if (rOrder !== 0) return rOrder;
    return a.title.localeCompare(b.title);
  };

  const ready: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) ready.push(id);
  }
  ready.sort(tieBreak);

  const result: OrchestrationAgent[] = [];
  while (ready.length > 0) {
    const currentId = ready.shift()!;
    result.push(specialistMap.get(currentId)!);

    for (const nextId of outgoing.get(currentId) || []) {
      const nextDeg = (inDegree.get(nextId) || 1) - 1;
      inDegree.set(nextId, nextDeg);
      if (nextDeg === 0) {
        ready.push(nextId);
        ready.sort(tieBreak);
      }
    }
  }

  if (result.length < specialists.length) {
    const visited = new Set(result.map((s) => s.id));
    const remaining = specialists.filter((s) => !visited.has(s.id));
    remaining.sort((a, b) => tieBreak(a.id, b.id));
    result.push(...remaining);
  }

  return result;
}

export function discoverSpecialists(
  state: Pick<CanvasState, "nodes" | "connections">,
  coordinator: CanvasNode,
  notes: OrchestrationNote[] = connectedNotes(state, coordinator.id),
  squad?: Pick<CanvasSquad, "memberNodeIds"> | null,
): OrchestrationAgent[] {
  const nodeMap = new Map(state.nodes.map((node) => [node.id, node]));

  // Squad-first: quando o coordenador pertence a um squad explícito, os
  // especialistas são exatamente os membros (menos o coordenador) — sem
  // depender de alcançabilidade por cabos e sem inferir participação.
  if (squad && squad.memberNodeIds.length > 0) {
    const memberIds = new Set(squad.memberNodeIds.filter((id) => id !== coordinator.id));
    const rawSpecialists = state.nodes
      .filter((node) => node.kind === "agent" && memberIds.has(node.id))
      .map((node) => ({
        id: node.id,
        title: node.title,
        role: orchestrationAgentRole(node),
        notes: connectedNotes(state, node.id),
      }));
    const internalConnections = state.connections.filter(
      (connection) =>
        memberIds.has(connection.from) &&
        memberIds.has(connection.to) &&
        isOrderingEdgeKind(defaultCanvasEdgeKind(connection.kind)),
    );
    return orderSpecialistsByGraph(rawSpecialists, internalConnections);
  }

  const adjacency = new Map<string, string[]>();
  for (const conn of state.connections) {
    const list = adjacency.get(conn.from);
    if (list) {
      list.push(conn.to);
    } else {
      adjacency.set(conn.from, [conn.to]);
    }
  }

  const seedIds = [coordinator.id, ...notes.map((n) => n.id)];
  const visited = new Set<string>(seedIds);
  const queue: string[] = [...seedIds];
  const reachableAgentIds = new Set<string>();

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const neighbors = adjacency.get(currentId) || [];
    for (const neighborId of neighbors) {
      if (!visited.has(neighborId)) {
        visited.add(neighborId);
        queue.push(neighborId);
        const node = nodeMap.get(neighborId);
        if (
          node &&
          node.kind === "agent" &&
          node.id !== coordinator.id &&
          !isCoordinatorRole(node.role)
        ) {
          reachableAgentIds.add(neighborId);
        }
      }
    }
  }

  const rawSpecialists = state.nodes
    .filter((node) => reachableAgentIds.has(node.id))
    .map((node) => ({
      id: node.id,
      title: node.title,
      role: orchestrationAgentRole(node),
      notes: connectedNotes(state, node.id),
    }));

  return orderSpecialistsByGraph(rawSpecialists, state.connections);
}

function mergeOrchestrationNotes(
  ...groups: OrchestrationNote[][]
): OrchestrationNote[] {
  const notes = new Map<string, OrchestrationNote>();
  groups.flat().forEach((note) => notes.set(note.id, note));
  return [...notes.values()];
}

function formatOrchestrationNotes(notes: OrchestrationNote[]): string {
  return notes
    .map((note) => `\n## ${note.title}\n${note.content}`)
    .join("\n");
}

function formatOrchestrationResults(results: OrchestrationResult[]): string {
  if (!results.length) return "Nenhum resultado de agente foi recebido ainda.";
  return results
    .map(
      (result) =>
        `\n### ${result.role} — ${result.title}\n${result.content}`,
    )
    .join("\n");
}

export const WorkspaceCanvas: React.FC<{
  project: Project;
  workbench: React.ReactNode;
  browser?: React.ReactNode;
  agentProviders?: AgentProvider[];
  defaultExecutor?: AgentProviderId | null;
  renderAgent?: (
    node: CanvasNode,
    onResult: (result: AgentResult, taskId?: string) => void,
    onTaskFailure: (taskId: string, message: string) => void,
  ) => React.ReactNode;
  onSendAgentTask?: (node: CanvasNode, prompt: string) => string | undefined;
  onCreateAgentWorktree?: (node: CanvasNode) => void;
  codexAuthStatus?: import("../types").CodexAccountStatus | null;
  onRequestCodexAuth?: (account: "account1" | "account2") => void;
  onSelectionChange?: (node: { id: string; title: string; kind: string } | null) => void;
  pendingNodeRequest?: { kind: 'note' | 'agent' | 'squad' | 'terminal'; nonce: number } | null;
  onPendingNodeConsumed?: (nonce: number) => void;
  onConnectionsChange?: (
    connections: Array<{ id: string; from: string; to: string }>,
    nodes: Array<{ id: string; kind: string }>,
  ) => void;
  onNotify?: (message: string, type?: 'success' | 'error' | 'info') => void;
  terminalPresets?: readonly CustomTerminalPreset[];
  renderTerminal?: (node: CanvasNode) => React.ReactNode;
  onTerminalPresetsSaved?: (presets: readonly CustomTerminalPreset[]) => void;
}> = ({
  project,
  workbench,
  browser,
  agentProviders = [],
  defaultExecutor = null,
  renderAgent,
  onSendAgentTask,
  onCreateAgentWorktree,
  codexAuthStatus = null,
  onRequestCodexAuth,
  onSelectionChange,
  pendingNodeRequest = null,
  onPendingNodeConsumed,
  onConnectionsChange,
  onNotify,
  terminalPresets = [],
  renderTerminal,
  onTerminalPresetsSaved,
}) => {
  const [canvas, setCanvas] = useState<CanvasState>(() => read(project.id, defaultExecutor));
  const [selected, setSelected] = useState<string[]>([]);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [gesture, setGesture] = useState<CanvasGesture | null>(null);
  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft | null>(null);
  const [creationMode, setCreationMode] = useState<"agent" | "squad" | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [selectedSquadId, setSelectedSquadId] = useState<string | null>(null);
  const [quickDeployOpen, setQuickDeployOpen] = useState(false);
  const [presetDraftName, setPresetDraftName] = useState("");
  const [presetSaveStatus, setPresetSaveStatus] = useState("");
  const [terminalDraft, setTerminalDraft] = useState<TerminalFieldDraft | null>(null);
  const [terminalCommandHint, setTerminalCommandHint] = useState("");
  const [orchestration, setOrchestration] = useState<OrchestrationRun | null>(
    null,
  );
  const [agentProgress, setAgentProgress] = useState<
    Record<string, AgentProgress>
  >({});
  const [configNodeId, setConfigNodeId] = useState<string | null>(null);
  // Estado efêmero de compactação por nó (default compacto para Agent/Terminal;
  // nunca persiste em width/height). Resetado ao trocar de projeto.
  const [compactOverrides, setCompactOverrides] = useState<Record<string, boolean>>({});
  const [continuity, setContinuity] = useState<OrchestrationState | null>(null);
  const manualTasksRef = useRef<Set<string>>(new Set());
  const continuityRef = useRef<OrchestrationState | null>(null);
  const continuityLoadedRef = useRef(false);
  const continuityHandledRef = useRef<Set<string>>(new Set());
  const canvasRef = useRef(canvas);
  const orchestrationRef = useRef<OrchestrationRun | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const persistTimerRef = useRef<number | null>(null);
  const gestureCaptureRef = useRef<HTMLElement | null>(null);
  const connectionDraftRef = useRef<ConnectionDraft | null>(null);
  const minimapPointerRef = useRef<number | null>(null);
  const consumedPendingRef = useRef<Set<number>>(new Set());
  const spaceHeldRef = useRef(false);
  const compactOverridesRef = useRef<Record<string, boolean>>(compactOverrides);
  const displayNodesRef = useRef<CanvasNode[]>([]);
  const persist = useCallback(
    (value: CanvasState) => {
      persistCanvasState(window.localStorage, project.id, value);
    },
    [project.id],
  );
  const update = useCallback(
    (updater: (current: CanvasState) => CanvasState, immediately = false) => {
      const next = updater(canvasRef.current);
      canvasRef.current = next;
      setCanvas(next);
      if (immediately) persist(next);
      else {
        if (persistTimerRef.current !== null)
          window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = window.setTimeout(() => {
          persistTimerRef.current = null;
          persist(canvasRef.current);
        }, 160);
      }
    },
    [persist],
  );
  const flush = useCallback(() => {
    if (persistTimerRef.current !== null)
      window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = null;
    persist(canvasRef.current);
  }, [persist]);
  useEffect(() => {
    canvasRef.current = canvas;
  }, [canvas]);
  // Painel de configuração trocou de nó: limpa os rascunhos ("Salvar como
  // preset" e campos de texto) e semeia o rascunho com os valores atuais do
  // nó, para não vazar texto/status entre cartões.
  useEffect(() => {
    setPresetDraftName("");
    setPresetSaveStatus("");
    setTerminalCommandHint("");
    const node = configNodeId
      ? canvasRef.current.nodes.find((item) => item.id === configNodeId)
      : undefined;
    setTerminalDraft(
      node && node.kind === "terminal" && node.terminal
        ? {
            nodeId: node.id,
            command: node.terminal.command ?? "",
            args: formatArgsInput(node.terminal.args),
            cwd: node.terminal.cwd ?? "",
          }
        : null,
    );
  }, [configNodeId]);
  useEffect(() => {
    const next = read(project.id, defaultExecutor);
    canvasRef.current = next;
    setCanvas(next);
    setSelected([]);
    setConnectFrom(null);
    connectionDraftRef.current = null;
    setConnectionDraft(null);
    setGesture(null);
    orchestrationRef.current = null;
    setOrchestration(null);
    setAgentProgress({});
    setConfigNodeId(null);
    setInspectorOpen(false);
    setSelectedSquadId(null);
    setCompactOverrides({});
  }, [project.id, defaultExecutor]);
  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);
  useEffect(() => {
    const lastId = selected[selected.length - 1];
    const node = lastId ? canvas.nodes.find((item) => item.id === lastId) : undefined;
    onSelectionChange?.(node ? { id: node.id, title: node.title, kind: node.kind } : null);
  }, [canvas.nodes, onSelectionChange, selected]);
  useEffect(() => {
    onConnectionsChange?.(
      canvas.connections,
      canvas.nodes.map((node) => ({ id: node.id, kind: node.kind })),
    );
  }, [canvas.connections, canvas.nodes, onConnectionsChange]);
  const connectNodes = useCallback(
    (from: string | null, to: string) => {
      if (!from || from === to) {
        if (from === to) {
          setConnectFrom(null);
          connectionDraftRef.current = null;
          setConnectionDraft(null);
        }
        return;
      }
      const nodes = canvasRef.current.nodes;
      const fromNode = nodes.find((node) => node.id === from);
      const toNode = nodes.find((node) => node.id === to);
      const kind = inferCanvasEdgeKind(fromNode?.kind ?? "", toNode?.kind ?? "");
      const agentIds = new Set(
        nodes.filter((node) => node.kind === "agent").map((node) => node.id),
      );
      // Recusa determinística de ciclo apenas em arestas de ordenação
      // agente-agente (flow legado/delegação/dependência): o main rejeitaria
      // o setPipe e o cabo ficaria desenhado sem piping. Cancela o gesto.
      if (
        isOrderingEdgeKind(kind) &&
        createsAgentCycle(
          canvasRef.current.connections.filter((connection) =>
            isOrderingEdgeKind(defaultCanvasEdgeKind(connection.kind)),
          ),
          agentIds,
          from,
          to,
        )
      ) {
        setConnectFrom(null);
        connectionDraftRef.current = null;
        setConnectionDraft(null);
        return;
      }
      update(
        (current) =>
          current.connections.some(
            (connection) =>
              connection.from === from &&
              connection.to === to &&
              defaultCanvasEdgeKind(connection.kind) === kind,
          )
            ? current
            : {
                ...current,
                connections: [
                  ...current.connections,
                  {
                    id: "link-" + Date.now().toString(36),
                    from,
                    to,
                    kind,
                  },
                ],
              },
        true,
      );
      connectionDraftRef.current = null;
      setConnectionDraft(null);
      setConnectFrom(null);
      // Concluir numa âncora de squad seleciona o squad (não um id virtual).
      const anchoredSquadId = parseSquadAnchorId(to);
      if (anchoredSquadId) {
        setSelected([]);
        setSelectedSquadId(anchoredSquadId);
        setInspectorOpen(true);
      } else {
        setSelected([to]);
      }
    },
    [update],
  );
  const selectNode = useCallback(
    (id: string, additive = false) => {
      if (connectFrom) {
        connectNodes(connectFrom, id);
        return;
      }
      setSelectedSquadId(null);
      setSelected((current) =>
        additive
          ? current.includes(id)
            ? current.filter((value) => value !== id)
            : [...current, id]
          : [id],
      );
    },
    [connectFrom, connectNodes],
  );
  // Selecionar o squad (header da região) mostra o Inspector do squad com
  // node=null; membros continuam arrastáveis porque o header fica na faixa de
  // padding acima dos cartões.
  const selectSquad = useCallback((squadId: string) => {
    setSelectedSquadId(squadId);
    setSelected([]);
    setInspectorOpen(true);
  }, []);
  const addNote = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const view = canvasRef.current.viewport;
    const id = nodeId();
    const x = snap(((rect?.width || 900) / 2 - view.x) / view.zoom - 165);
    const y = snap(((rect?.height || 650) / 2 - view.y) / view.zoom - 120);
    update(
      (current) => ({
        ...current,
        nodes: [
          ...current.nodes,
          {
            id,
            kind: "note",
            title: "Nova nota",
            x,
            y,
            width: 330,
            height: 240,
            z: Math.max(0, ...current.nodes.map((node) => node.z)) + 1,
            content: "",
          },
        ],
      }),
      true,
    );
    setSelected([id]);
  }, [update]);
  const openAgentCreation = useCallback(() => {
    setCreationMode("agent");
  }, []);
  const openSquadCreation = useCallback(() => {
    setCreationMode("squad");
  }, []);
  const addAgent = useCallback((spec: AgentCreationSpec) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const view = canvasRef.current.viewport;
    const id = nodeId();
    const x = snap(((rect?.width || 900) / 2 - view.x) / view.zoom - 220);
    const y = snap(((rect?.height || 650) / 2 - view.y) / view.zoom - 160);
    const provider = spec.provider ?? defaultExecutor ?? undefined;
    const role = sanitizeAgentRole(spec.role);
    update(
      (current) => ({
        ...current,
        nodes: [
          ...current.nodes,
          {
            id,
            kind: "agent",
            title: spec.title?.trim().slice(0, 80) || (role === "Implementação" ? "Agente de implementação" : "Agente: " + role),
            role,
            ...(spec.account ? { account: spec.account } : {}),
            ...(provider ? { provider } : {}),
            x,
            y,
            width: 500,
            height: 360,
            z: Math.max(0, ...current.nodes.map((node) => node.z)) + 1,
          },
        ],
      }),
      true,
    );
    setSelected([id]);
    setCreationMode(null);
  }, [defaultExecutor, update]);
  const openTerminalQuickDeploy = useCallback(() => {
    setQuickDeployOpen(true);
  }, []);
  // Quick Deploy: cria o nó terminal imediatamente com os defaults do preset
  // (comando, auto-start, reinício); o ajuste fino fica no painel Configurar.
  const addTerminalNode = useCallback(
    (
      preset: TerminalPresetDefinition | CustomTerminalPreset,
      position?: { x: number; y: number },
    ) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      const view = canvasRef.current.viewport;
      const id = nodeId();
      const x = snap(
        position?.x ?? ((rect?.width || 900) / 2 - view.x) / view.zoom - 260,
      );
      const y = snap(
        position?.y ?? ((rect?.height || 650) / 2 - view.y) / view.zoom - 160,
      );
      const title = terminalNodeTitle(
        preset,
        canvasRef.current.nodes.map((node) => node.title),
      );
      update(
        (current) => ({
          ...current,
          nodes: [
            ...current.nodes,
            {
              id,
              kind: "terminal" as const,
              title,
              x,
              y,
              width: 520,
              height: 340,
              z: Math.max(0, ...current.nodes.map((node) => node.z)) + 1,
              terminal: createTerminalNodeConfig(preset),
            },
          ],
        }),
        true,
      );
      setSelected([id]);
    },
    [update],
  );
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; kind?: string }>).detail
      if (detail?.projectId && detail.projectId !== project.id) return
      if (detail?.kind === 'note') addNote()
      else if (detail?.kind === 'agent') openAgentCreation()
      else if (detail?.kind === 'squad') openSquadCreation()
      else if (detail?.kind === 'terminal') openTerminalQuickDeploy()
    }
    window.addEventListener('devorbit:create-canvas-node', handler as EventListener)
    return () => window.removeEventListener('devorbit:create-canvas-node', handler as EventListener)
  }, [addNote, openAgentCreation, openSquadCreation, openTerminalQuickDeploy, project.id]);
  useEffect(() => {
    if (!pendingNodeRequest) return
    if (consumedPendingRef.current.has(pendingNodeRequest.nonce)) return
    consumedPendingRef.current.add(pendingNodeRequest.nonce)
    if (pendingNodeRequest.kind === 'note') addNote()
    else if (pendingNodeRequest.kind === 'agent') openAgentCreation()
    else if (pendingNodeRequest.kind === 'terminal') openTerminalQuickDeploy()
    else openSquadCreation()
    onPendingNodeConsumed?.(pendingNodeRequest.nonce)
  }, [addNote, onPendingNodeConsumed, openAgentCreation, openSquadCreation, openTerminalQuickDeploy, pendingNodeRequest]);
  const createSquad = useCallback((spec: SquadCreationSpec) => {
    const participants = spec.participants;
    if (!participants.length) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    const view = canvasRef.current.viewport;
    const existing = canvasRef.current.nodes;
    const margin = 120;
    const fallbackX = snap(((rect?.width || 1100) / 2 - view.x) / view.zoom - 380);
    const fallbackY = snap(((rect?.height || 700) / 2 - view.y) / view.zoom - 260);
    // Layout inicial sensato: à direita do conteúdo existente, sem mover
    // nenhum nó já posicionado. Canvas vazio usa o centro da viewport.
    const originX = existing.length
      ? clamp(snap(Math.max(...existing.map((node) => node.x + node.width)) + margin), 0, WORLD_WIDTH - 1000)
      : clamp(fallbackX, 0, WORLD_WIDTH - 1000);
    const originY = existing.length
      ? clamp(snap(Math.min(...existing.map((node) => node.y))), 0, WORLD_HEIGHT - 800)
      : clamp(fallbackY, 0, WORLD_HEIGHT - 800);
    const zBase = Math.max(0, ...existing.map((node) => node.z));
    // Squad + agentes, sem Nota por padrão. A Nota (e o vínculo Note→Squad)
    // só existem por ação explícita do usuário; o objetivo vive no squad.
    const plan = planSquadCreation(spec, { originX, originY, zBase }, { defaultExecutor });
    update((current) => ({
      ...current,
      nodes: [...current.nodes, ...plan.agents, ...(plan.note ? [plan.note] : [])],
      connections: [...current.connections, ...plan.connections],
      squads: [...current.squads, plan.squad],
    }), true);
    setSelected(plan.selectedIds);
    setCreationMode(null);
  }, [defaultExecutor, update]);
  const deleteNodes = useCallback((ids: string[]) => {
    const removable = new Set(
      ids.filter((id) =>
        canvasRef.current.nodes.find(
          (node) => node.id === id && !fixedKinds.has(node.kind),
        ),
      ),
    );
    if (!removable.size) return;
    update(
      (current) => ({
        ...current,
        nodes: current.nodes.filter((node) => !removable.has(node.id)),
        connections: current.connections.filter(
          (connection) =>
            !removable.has(connection.from) && !removable.has(connection.to),
        ),
        squads: current.squads
          .map((squad) => {
            let next = squad;
            for (const id of removable) next = removeSquadMember(next, id);
            return next;
          })
          .filter((squad) => squad.memberNodeIds.length > 0),
      }),
      true,
    );
    setSelected([]);
    setConnectFrom((current) => current && removable.has(current) ? null : current);
  }, [update]);
  const deleteSelected = useCallback(() => {
    deleteNodes(selected);
  }, [deleteNodes, selected]);
  const duplicateSelected = useCallback(() => {
    const source = canvasRef.current.nodes.find(
      (node) =>
        node.id === selected[selected.length - 1] && node.kind === "note",
    );
    if (!source) return;
    const id = nodeId();
    update(
      (current) => ({
        ...current,
        nodes: [
          ...current.nodes,
          {
            ...source,
            id,
            title: source.title + " (cópia)",
            x: snap(source.x + 40),
            y: snap(source.y + 40),
            z: Math.max(...current.nodes.map((node) => node.z)) + 1,
          },
        ],
      }),
      true,
    );
    setSelected([id]);
  }, [selected, update]);
  // ---- Edição de squad (persistida imediatamente, sem mover nós) ----
  const updateSquadById = useCallback(
    (squadId: string, updater: (squad: CanvasSquad) => CanvasSquad) => {
      update(
        (current) => ({
          ...current,
          squads: current.squads.map((squad) => (squad.id === squadId ? updater(squad) : squad)),
        }),
        true,
      );
    },
    [update],
  );
  const addSquadMemberById = useCallback(
    (squadId: string, nodeIdValue: string) => {
      const node = canvasRef.current.nodes.find(
        (item) => item.id === nodeIdValue && item.kind === "agent",
      );
      if (!node) return;
      updateSquadById(squadId, (squad) => addSquadMember(squad, nodeIdValue));
    },
    [updateSquadById],
  );
  // Cria um agente NOVO ao lado do squad (sem mover nenhum nó existente) e já
  // o adiciona como membro; o fluxo de diálogo continua no radial "Agente".
  const addNewAgentToSquad = useCallback(
    (squadId: string) => {
      const current = canvasRef.current;
      const squad = current.squads.find((item) => item.id === squadId);
      if (!squad) return;
      const members = squad.memberNodeIds
        .map((id) => current.nodes.find((node) => node.id === id))
        .filter((node): node is CanvasNode => Boolean(node));
      const margin = 80;
      const cellWidth = 460;
      const cellHeight = 320;
      const maxRight = members.length ? Math.max(...members.map((node) => node.x + node.width)) : 0;
      const minX = members.length ? Math.min(...members.map((node) => node.x)) : 120;
      const minY = members.length ? Math.min(...members.map((node) => node.y)) : 120;
      const maxBottom = members.length ? Math.max(...members.map((node) => node.y + node.height)) : 0;
      const fitsRight = maxRight + margin + cellWidth <= WORLD_WIDTH;
      const x = clamp(snap(fitsRight ? maxRight + margin : minX), 0, WORLD_WIDTH - cellWidth);
      const y = clamp(snap(fitsRight ? minY : maxBottom + margin), 0, WORLD_HEIGHT - cellHeight);
      const id = nodeId();
      const role = "Implementação";
      const provider = defaultExecutor ?? undefined;
      update(
        (state) => ({
          ...state,
          nodes: [
            ...state.nodes,
            {
              id,
              kind: "agent" as const,
              title: "Agente: " + role,
              role,
              ...(provider ? { provider } : {}),
              x,
              y,
              width: cellWidth,
              height: cellHeight,
              z: Math.max(0, ...state.nodes.map((node) => node.z)) + 1,
            },
          ],
          squads: state.squads.map((item) =>
            item.id === squadId ? addSquadMember(item, id) : item,
          ),
        }),
        true,
      );
      setSelected([id]);
      setSelectedSquadId(null);
    },
    [defaultExecutor, update],
  );
  const removeSquadMemberById = useCallback(
    (squadId: string, nodeIdValue: string) => {
      const squad = canvasRef.current.squads.find((item) => item.id === squadId);
      if (!squad) return;
      // O modelo v5 exige >=1 membro: squad vazio some da região e é
      // descartado no reload, perdendo título/objetivo. Bloqueia o último.
      if (squad.memberNodeIds.includes(nodeIdValue) && !canRemoveSquadMember(squad, nodeIdValue)) {
        onNotify?.(
          "Um squad precisa de ao menos um membro. Adicione outro membro antes de remover o último.",
          "info",
        );
        return;
      }
      updateSquadById(squadId, (current) => removeSquadMember(current, nodeIdValue));
    },
    [onNotify, updateSquadById],
  );
  const setSquadCoordinatorById = useCallback(
    (squadId: string, nodeIdValue: string | null) =>
      updateSquadById(squadId, (squad) => setSquadCoordinator(squad, nodeIdValue)),
    [updateSquadById],
  );
  const renameSquadById = useCallback(
    (squadId: string, title: string) =>
      updateSquadById(squadId, (squad) => renameSquad(squad, title)),
    [updateSquadById],
  );
  const setSquadObjectiveById = useCallback(
    (squadId: string, objective: string) =>
      updateSquadById(squadId, (squad) => setSquadObjective(squad, objective)),
    [updateSquadById],
  );
  const toggleSquadCollapsedById = useCallback(
    (squadId: string) => updateSquadById(squadId, toggleSquadCollapsed),
    [updateSquadById],
  );
  const editSquadObjective = useCallback(
    (squadId: string) => {
      const squad = canvasRef.current.squads.find((item) => item.id === squadId);
      if (!squad) return;
      const next = window.prompt("Objetivo do squad", squad.objective ?? "");
      if (next === null) return;
      updateSquadById(squadId, (current) => setSquadObjective(current, next));
    },
    [updateSquadById],
  );
  // Squad independente da Nota: cria só o vínculo de membros, sem nós novos e
  // sem mover nada. Coordenador fica vazio até escolha explícita no Inspector.
  const createSquadFromSelection = useCallback(() => {
    const agentIds = selected.filter((id) =>
      canvasRef.current.nodes.some((node) => node.id === id && node.kind === "agent"),
    );
    if (!agentIds.length) {
      onNotify?.("Selecione ao menos um agente para criar um squad.", "info");
      return;
    }
    const id = "squad-" + nodeId().slice(5);
    update(
      (current) => ({
        ...current,
        squads: [
          ...current.squads,
          { id, title: "Novo squad", objective: "", memberNodeIds: agentIds, collapsed: false },
        ],
      }),
      true,
    );
    onNotify?.("Squad criado. Defina o coordenador no Inspector.", "success");
  }, [onNotify, selected, update]);
  const squadTargetForSelection = useCallback((): CanvasSquad | undefined => {
    const current = canvasRef.current;
    for (const id of selected) {
      const squad = squadForNode(current.squads, id);
      if (squad) return squad;
    }
    return current.squads.length === 1 ? current.squads[0] : undefined;
  }, [selected]);
  const addSelectionToSquad = useCallback(() => {
    const squad = squadTargetForSelection();
    const agentIds = selected.filter((id) =>
      canvasRef.current.nodes.some((node) => node.id === id && node.kind === "agent"),
    );
    if (!squad || !agentIds.length) return;
    for (const id of agentIds) addSquadMemberById(squad.id, id);
  }, [addSquadMemberById, selected, squadTargetForSelection]);
  const removeSelectionFromSquad = useCallback(() => {
    for (const id of selected) {
      const squad = squadForNode(canvasRef.current.squads, id);
      if (squad) removeSquadMemberById(squad.id, id);
    }
  }, [removeSquadMemberById, selected]);
  const promoteSelectionToCoordinator = useCallback(() => {
    const target = selected[selected.length - 1];
    if (!target) return;
    const membership = squadForNode(canvasRef.current.squads, target);
    if (!membership) return;
    setSquadCoordinatorById(membership.id, target);
  }, [selected, setSquadCoordinatorById]);
  const renameSquadFromPrompt = useCallback(
    (squadId: string) => {
      const squad = canvasRef.current.squads.find((item) => item.id === squadId);
      if (!squad) return;
      const next = window.prompt("Nome do squad", squad.title);
      if (next === null) return;
      renameSquadById(squadId, next);
    },
    [renameSquadById],
  );
  const resetCanvas = useCallback(() => {
    const fresh = defaults();
    update(() => fresh, true);
    setSelected([]);
    setConnectFrom(null);
    connectionDraftRef.current = null;
    setConnectionDraft(null);
  }, [update]);
  const pointerToWorld = useCallback((clientX: number, clientY: number) => {
    const host = viewportRef.current?.getBoundingClientRect();
    const view = canvasRef.current.viewport;
    return {
      x: (clientX - (host?.left || 0) - view.x) / view.zoom,
      y: (clientY - (host?.top || 0) - view.y) / view.zoom,
    };
  }, []);
  const zoomAt = useCallback(
    (amount: number, clientX?: number, clientY?: number) =>
      update(
        (current) => {
          const host = viewportRef.current?.getBoundingClientRect();
          const localX =
            (clientX ?? (host?.left || 0) + (host?.width || 900) / 2) -
            (host?.left || 0);
          const localY =
            (clientY ?? (host?.top || 0) + (host?.height || 650) / 2) -
            (host?.top || 0);
          const nextZoom = clamp(
            current.viewport.zoom + amount,
            MIN_ZOOM,
            MAX_ZOOM,
          );
          if (nextZoom === current.viewport.zoom) return current;
          const worldX =
            (localX - current.viewport.x) / current.viewport.zoom;
          const worldY =
            (localY - current.viewport.y) / current.viewport.zoom;
          return {
            ...current,
            viewport: {
              zoom: nextZoom,
              x: localX - worldX * nextZoom,
              y: localY - worldY * nextZoom,
            },
          };
        },
        true,
      ),
    [update],
  );
  // Níveis discretos de zoom: botões/atalhos andam de nível em nível; a roda
  // com Ctrl/Cmd continua contínua.
  const zoomByLevel = useCallback(
    (direction: 1 | -1) => {
      const current = canvasRef.current.viewport.zoom;
      zoomAt(stepZoomLevel(current, direction) - current);
    },
    [zoomAt],
  );
  const setZoomPreset = useCallback(
    (preset: CanvasZoomPreset) => {
      const target = preset === "close" ? 1.25 : preset === "medium" ? 1 : 0.5;
      zoomAt(target - canvasRef.current.viewport.zoom);
    },
    [zoomAt],
  );
  const setZoomLevel = useCallback(
    (level: number) => {
      zoomAt(clamp(level, MIN_ZOOM, MAX_ZOOM) - canvasRef.current.viewport.zoom);
    },
    [zoomAt],
  );
  useEffect(() => {
    const host = viewportRef.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      const target = event.target;
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        closestElement(target, ".workspace-canvas-card-content")
      )
        return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        zoomAt(
          event.deltaY > 0 ? -0.1 : 0.1,
          event.clientX,
          event.clientY,
        );
        return;
      }
      update((current) => ({
        ...current,
        viewport: {
          ...current.viewport,
          x: current.viewport.x - event.deltaX,
          y: current.viewport.y - event.deltaY,
        },
      }));
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [update, zoomAt]);
  const resetViewport = useCallback(() => {
    update((current) => ({ ...current, viewport: { x: 40, y: 36, zoom: 1 } }), true);
  }, [update]);
  const fitCanvas = useCallback(() => {
    const host = viewportRef.current?.getBoundingClientRect();
    // Geometria efêmera: enquadra os cartões no tamanho real exibido (compacto
    // 320x130), sem depender das dimensões persistidas.
    const nodes = displayNodesRef.current.filter(
      (node) => node.kind !== "browser" || browser,
    );
    if (!host || !nodes.length) return;
    const padding = 100;
    const minX = Math.min(...nodes.map((node) => node.x));
    const minY = Math.min(...nodes.map((node) => node.y));
    const maxX = Math.max(...nodes.map((node) => node.x + node.width));
    const maxY = Math.max(...nodes.map((node) => node.y + node.height));
    const width = Math.max(1, maxX - minX + padding * 2);
    const height = Math.max(1, maxY - minY + padding * 2);
    const nextZoom = clamp(
      Math.min(host.width / width, host.height / height),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    update(
      (current) => ({
        ...current,
        viewport: {
          zoom: nextZoom,
          x: (host.width - (maxX - minX) * nextZoom) / 2 - minX * nextZoom,
          y: (host.height - (maxY - minY) * nextZoom) / 2 - minY * nextZoom,
        },
      }),
      true,
    );
  }, [browser, update]);
  // Estabilidade: se o host mudar de tamanho e nenhum quadro continuar visível
  // (janela redimensionada, chrome escondido, layout trocado), reencaixa o
  // conteúdo em vez de deixar o canvas aparentemente vazio.
  useEffect(() => {
    const host = viewportRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) return;
      const view = canvasRef.current.viewport;
      const nodes = displayNodesRef.current.filter(
        (node) => node.kind !== "browser" || browser,
      );
      if (!nodes.length) return;
      const anyVisible = nodes.some((node) => {
        const left = node.x * view.zoom + view.x;
        const top = node.y * view.zoom + view.y;
        const right = (node.x + node.width) * view.zoom + view.x;
        const bottom = (node.y + node.height) * view.zoom + view.y;
        return right > 0 && bottom > 0 && left < rect.width && top < rect.height;
      });
      if (!anyVisible) fitCanvas();
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [browser, fitCanvas]);
  const beginGesture = useCallback(
    (
      event: React.PointerEvent<HTMLElement>,
      next: Omit<CanvasGesture, "pointerId">,
    ) => {
      gestureCaptureRef.current = event.currentTarget;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* Synthetic events and inactive pointers cannot be captured. */
      }
      setGesture({ ...next, pointerId: event.pointerId });
    },
    [],
  );
  const startPan = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0 && event.button !== 1 && !spaceHeldRef.current)
        return;
      event.preventDefault();
      event.stopPropagation();
      beginGesture(event, {
        type: "pan",
        sx: event.clientX,
        sy: event.clientY,
        viewport: canvasRef.current.viewport,
      });
    },
    [beginGesture],
  );
  const startNodeDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>, node: CanvasNode) => {
      if (event.button !== 0 || spaceHeldRef.current) {
        if (event.button === 1 || spaceHeldRef.current) startPan(event);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) {
        selectNode(node.id, true);
        return;
      }
      const ids = selected.includes(node.id) ? selected : [node.id];
      if (!selected.includes(node.id)) setSelected([node.id]);
      const nodes = ids
        .map((id) => canvasRef.current.nodes.find((item) => item.id === id))
        .filter((item): item is CanvasNode => Boolean(item));
      beginGesture(event, {
        type: "drag",
        sx: event.clientX,
        sy: event.clientY,
        nodes,
      });
    },
    [beginGesture, selectNode, selected, startPan],
  );
  const startResize = useCallback(
    (event: React.PointerEvent<HTMLElement>, node: CanvasNode) => {
      event.preventDefault();
      event.stopPropagation();
      beginGesture(event, {
        type: "resize",
        sx: event.clientX,
        sy: event.clientY,
        id: node.id,
        nodes: [node],
      });
    },
    [beginGesture],
  );
  useEffect(() => {
    if (!gesture) return;
    const move = (event: PointerEvent) => {
      if (event.pointerId !== gesture.pointerId) return;
      const dx = event.clientX - gesture.sx;
      const dy = event.clientY - gesture.sy;
      if (gesture.type === "pan" && gesture.viewport)
        update((current) => ({
          ...current,
          viewport: {
            ...current.viewport,
            x: gesture.viewport!.x + dx,
            y: gesture.viewport!.y + dy,
          },
        }));
      if (gesture.type === "drag" && gesture.nodes) {
        const worldX = dx / (gesture.viewport?.zoom || canvasRef.current.viewport.zoom);
        const worldY = dy / (gesture.viewport?.zoom || canvasRef.current.viewport.zoom);
        const raw = gesture.nodes.map((node) => ({
          node,
          x: snap(node.x + worldX),
          y: snap(node.y + worldY),
        }));
        const minX = Math.min(...raw.map((item) => item.x));
        const minY = Math.min(...raw.map((item) => item.y));
        const maxX = Math.max(...raw.map((item) => item.x + item.node.width));
        const maxY = Math.max(...raw.map((item) => item.y + item.node.height));
        const offsetX = minX < 0 ? -minX : maxX > WORLD_WIDTH ? WORLD_WIDTH - maxX : 0;
        const offsetY = minY < 0 ? -minY : maxY > WORLD_HEIGHT ? WORLD_HEIGHT - maxY : 0;
        const moved = new Map(
          raw.map(({ node, x, y }) => [
            node.id,
            {
              x: clamp(x + offsetX, 0, WORLD_WIDTH - node.width),
              y: clamp(y + offsetY, 0, WORLD_HEIGHT - node.height),
            },
          ]),
        );
        update((current) => ({
          ...current,
          nodes: current.nodes.map((node) =>
            moved.has(node.id)
              ? {
                  ...node,
                  ...moved.get(node.id)!,
                  z: Math.max(...current.nodes.map((item) => item.z)) + 1,
                }
              : node,
          ),
        }));
      }
      if (gesture.type === "resize" && gesture.id && gesture.nodes?.[0]) {
        const initial = gesture.nodes[0];
        update((current) => ({
          ...current,
          nodes: current.nodes.map((node) =>
            node.id !== gesture.id
              ? node
              : {
                  ...node,
                  width: snap(
                    clamp(
                      initial.width + dx / (gesture.viewport?.zoom || current.viewport.zoom),
                      220,
                      Math.min(1100, WORLD_WIDTH - initial.x),
                    ),
                  ),
                  height: snap(
                    clamp(
                      initial.height + dy / (gesture.viewport?.zoom || current.viewport.zoom),
                      150,
                      Math.min(850, WORLD_HEIGHT - initial.y),
                    ),
                  ),
                },
          ),
        }));
      }
    };
    const finish = (event: PointerEvent) => {
      if (event.pointerId !== gesture.pointerId) return;
      try {
        gestureCaptureRef.current?.releasePointerCapture(event.pointerId);
      } catch {
        /* The pointer may already have been released by the browser. */
      }
      gestureCaptureRef.current = null;
      flush();
      setGesture(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [flush, gesture, update]);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const draft = connectionDraftRef.current;
      if (!draft || event.pointerId !== draft.pointerId) return;
      const point = pointerToWorld(event.clientX, event.clientY);
      const next = { ...draft, x: point.x, y: point.y };
      connectionDraftRef.current = next;
      setConnectionDraft(next);
    };
    const finish = (event: PointerEvent) => {
      const draft = connectionDraftRef.current;
      if (!draft || event.pointerId !== draft.pointerId) return;
      const target = document
        .elementFromPoint?.(event.clientX, event.clientY)
        ?.closest<HTMLElement>('[data-canvas-port="target"]');
      const to = target?.dataset.canvasNodeId || null;
      connectionDraftRef.current = null;
      setConnectionDraft(null);
      if (to) connectNodes(draft.from, to);
    };
    const cancel = (event: PointerEvent) => {
      const draft = connectionDraftRef.current;
      if (!draft || event.pointerId !== draft.pointerId) return;
      connectionDraftRef.current = null;
      setConnectionDraft(null);
      setConnectFrom(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [connectNodes, pointerToWorld]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditable = Boolean(
        closestElement(target, "input, textarea, [contenteditable=true]"),
      );
      if (event.code === "Space" && !isEditable) {
        spaceHeldRef.current = true;
        if (target === viewportRef.current) event.preventDefault();
        return;
      }
      if (isEditable) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelected();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelected();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "0") {
        event.preventDefault();
        resetViewport();
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        (event.key === "+" || event.key === "=")
      ) {
        event.preventDefault();
        zoomByLevel(1);
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "-") {
        event.preventDefault();
        zoomByLevel(-1);
      }
      if (event.key === "Escape") {
        setSelected([]);
        setSelectedSquadId(null);
        setConnectFrom(null);
        connectionDraftRef.current = null;
        setConnectionDraft(null);
        setGesture(null);
        setQuickDeployOpen(false);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceHeldRef.current = false;
    };
    const onWindowBlur = () => {
      spaceHeldRef.current = false;
      connectionDraftRef.current = null;
      setConnectionDraft(null);
      setGesture(null);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [deleteSelected, duplicateSelected, resetViewport, update, zoomByLevel]);
  const nodeMap = useMemo(
    () => new Map(canvas.nodes.map((node) => [node.id, node])),
    [canvas.nodes],
  );
  // Compactação é estado de UI: o nó cujo painel de configuração está aberto
  // renderiza expandido mesmo que seu override seja compacto.
  const isNodeCompact = useCallback(
    (node: CanvasNode) =>
      node.id !== configNodeId &&
      (typeof compactOverrides[node.id] === "boolean"
        ? compactOverrides[node.id]
        : isCompactByDefault(node)),
    [compactOverrides, configNodeId],
  );
  const toggleNodeCompact = useCallback((nodeIdValue: string) => {
    setCompactOverrides((current) => {
      const node = canvasRef.current.nodes.find((item) => item.id === nodeIdValue);
      const base =
        typeof current[nodeIdValue] === "boolean"
          ? current[nodeIdValue]
          : node
            ? isCompactByDefault(node)
            : false;
      return { ...current, [nodeIdValue]: !base };
    });
  }, []);
  // Geometria derivada usada por arestas, região de squad, fit e minimap:
  // 320x130 quando compacto, sem tocar nas dimensões persistidas.
  const displayNodes = useMemo(
    () => canvas.nodes.map((node) => nodeDisplayGeometry(node, isNodeCompact(node))),
    [canvas.nodes, isNodeCompact],
  );
  const displayNodeMap = useMemo(
    () => new Map(displayNodes.map((node) => [node.id, node])),
    [displayNodes],
  );
  useEffect(() => {
    compactOverridesRef.current = compactOverrides;
  }, [compactOverrides]);
  useEffect(() => {
    displayNodesRef.current = displayNodes;
  }, [displayNodes]);
  const quickDeployChips = useMemo(
    () => buildQuickDeployChips(terminalPresets),
    [terminalPresets],
  );
  // Rótulo do cabeçalho do cartão terminal: preset resolvido (ou aviso de
  // preset apagado), nunca cor isolada — o texto carrega o estado.
  const terminalMetaLabel = useCallback(
    (node: CanvasNode) => {
      if (!node.terminal) return nodeMeta.terminal.meta;
      const resolved = resolveTerminalLaunch(node.terminal, terminalPresets);
      return resolved.missing ? "Preset ausente" : resolved.label;
    },
    [terminalPresets],
  );
  // Patch de config do terminal do nó: toda mudança passa pelo sanitize
  // compartilhado antes de persistir.
  const updateTerminalNode = useCallback(
    (id: string, patch: (current: TerminalNodeRuntimeConfig) => Partial<TerminalNodeRuntimeConfig>) => {
      update(
        (current) => ({
          ...current,
          nodes: current.nodes.map((item) => {
            if (item.id !== id || item.kind !== "terminal" || !item.terminal) return item;
            const next = sanitizeTerminalNodeConfig({
              ...item.terminal,
              ...patch(item.terminal),
            });
            return next ? { ...item, terminal: next } : item;
          }),
        }),
        true,
      );
    },
    [update],
  );
  const renameTerminalNode = useCallback(
    (id: string, title: string) => {
      update(
        (current) => ({
          ...current,
          nodes: current.nodes.map((item) =>
            item.id === id ? { ...item, title: title.slice(0, 80) } : item,
          ),
        }),
        true,
      );
    },
    [update],
  );
  const updateNode = useCallback(
    (id: string, patch: Partial<CanvasNode>) => {
      update(
        (current) => ({
          ...current,
          nodes: current.nodes.map((item) => (item.id === id ? { ...item, ...patch } : item)),
        }),
        true,
      );
    },
    [update],
  );
  const disconnectNodeLinks = useCallback(
    (id: string) => {
      update(
        (current) => ({
          ...current,
          connections: current.connections.filter((link) => link.from !== id && link.to !== id),
        }),
        true,
      );
    },
    [update],
  );
  const focusNode = useCallback(
    (id: string) => {
      const node = canvasRef.current.nodes.find((item) => item.id === id);
      const host = viewportRef.current?.getBoundingClientRect();
      if (!node || !host) return;
      update(
        (current) => ({
          ...current,
          viewport: {
            ...current.viewport,
            x: host.width / 2 - (node.x + node.width / 2) * current.viewport.zoom,
            y: host.height / 2 - (node.y + node.height / 2) * current.viewport.zoom,
          },
        }),
        true,
      );
    },
    [update],
  );
  const focusSelected = useCallback(() => {
    const nodes = selected
      .map((id) => canvasRef.current.nodes.find((node) => node.id === id))
      .filter((node): node is CanvasNode => Boolean(node));
    const host = viewportRef.current?.getBoundingClientRect();
    if (!nodes.length || !host) return;
    const viewport = computeFocusViewport(nodes, host, {
      padding: 120,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
    });
    if (!viewport) return;
    update((current) => ({ ...current, viewport }), true);
  }, [selected, update]);
  // Digitação nos campos de texto: só o rascunho local muda (ver comentário de
  // TerminalFieldDraft). O commit com sanitize acontece em blur/Enter.
  const setTerminalDraftField = useCallback(
    (nodeId: string, field: "command" | "args" | "cwd", value: string) => {
      setTerminalDraft((current) => {
        if (current && current.nodeId === nodeId) {
          const next = { ...current };
          next[field] = value;
          return next;
        }
        const node = canvasRef.current.nodes.find((item) => item.id === nodeId);
        const terminal = node && node.kind === "terminal" ? node.terminal : undefined;
        const seeded: TerminalFieldDraft = {
          nodeId,
          command: terminal?.command ?? "",
          args: formatArgsInput(terminal?.args),
          cwd: terminal?.cwd ?? "",
        };
        seeded[field] = value;
        return seeded;
      });
    },
    [],
  );
  // Commit do rascunho do painel: valida o comando (aviso pt-BR em vez de
  // descartar), envia comando/argumentos e — quando o modo é "Diretório
  // próprio" — o cwd, tudo pelo sanitize compartilhado.
  const commitTerminalFields = useCallback(
    (node: CanvasNode) => {
      const config = node.terminal;
      const draft = terminalDraft && terminalDraft.nodeId === node.id ? terminalDraft : null;
      if (!config || !draft) return;
      const command = draft.command.trim();
      if (isTerminalCommandTextRejected(command)) {
        setTerminalCommandHint(TERMINAL_COMMAND_INVALID_HINT);
        return;
      }
      const cwd = draft.cwd.trim();
      setTerminalCommandHint("");
      updateTerminalNode(node.id, () => ({
        command: command || undefined,
        args: parseArgsInput(draft.args),
        ...(config.cwdMode === "custom" ? { cwd: cwd || undefined } : {}),
      }));
      setTerminalDraft(null);
    },
    [terminalDraft, updateTerminalNode],
  );
  const saveTerminalPreset = useCallback(
    async (node: CanvasNode) => {
      const config = node.terminal;
      if (!config?.command) {
        setPresetSaveStatus("Defina um comando antes de salvar o preset.");
        return;
      }
      const name = presetDraftName.trim();
      if (!name) {
        setPresetSaveStatus("Informe um nome para o preset.");
        return;
      }
      if (terminalPresets.length >= CUSTOM_TERMINAL_PRESET_LIMIT) {
        setPresetSaveStatus(`Limite de ${CUSTOM_TERMINAL_PRESET_LIMIT} presets personalizados atingido.`);
        return;
      }
      const id = slugifyCustomPresetId(
        name,
        terminalPresets.map((preset) => preset.id),
      );
      const preset = sanitizeCustomTerminalPreset({
        id,
        name,
        command: config.command,
        args: config.args,
        resumeCommand: config.resumeCommand,
        resumeArgs: config.resumeArgs,
        defaultAutoStart: config.autoStart,
        defaultMonitorActivity: config.monitorActivity,
        defaultRestartBehavior: config.restartBehavior,
      });
      if (!id || !preset) {
        setPresetSaveStatus("Nome inválido para o preset.");
        return;
      }
      try {
        const saved = await window.devorbit.saveConfig({
          terminalPresets: [...terminalPresets, preset],
        });
        onTerminalPresetsSaved?.(saved.terminalPresets ?? [...terminalPresets, preset]);
        setPresetDraftName("");
        setPresetSaveStatus(`Preset "${preset.name}" salvo.`);
      } catch (error) {
        setPresetSaveStatus("Não foi possível salvar o preset: " + (error instanceof Error ? error.message : String(error)));
      }
    },
    [onTerminalPresetsSaved, presetDraftName, terminalPresets],
  );

  const renameCustomPreset = useCallback(
    async (presetId: string, newName: string) => {
      const res = renameCustomTerminalPreset(terminalPresets, presetId, newName);
      if (res.error) {
        setPresetSaveStatus(res.error);
        return;
      }
      try {
        const saved = await window.devorbit.saveConfig({
          terminalPresets: res.presets,
        });
        onTerminalPresetsSaved?.(saved.terminalPresets ?? res.presets);
        setPresetSaveStatus(`Preset renomeado para "${res.updated?.name}".`);
      } catch (error) {
        setPresetSaveStatus("Não foi possível renomear o preset: " + (error instanceof Error ? error.message : String(error)));
      }
    },
    [onTerminalPresetsSaved, terminalPresets],
  );

  const deleteCustomPresetAction = useCallback(
    async (presetId: string) => {
      const res = deleteCustomTerminalPreset(terminalPresets, presetId);
      if (res.error) {
        setPresetSaveStatus(res.error);
        return;
      }
      try {
        const saved = await window.devorbit.saveConfig({
          terminalPresets: res.presets,
        });
        onTerminalPresetsSaved?.(saved.terminalPresets ?? res.presets);
        setPresetSaveStatus(`Preset "${res.deleted?.name}" excluído.`);
      } catch (error) {
        setPresetSaveStatus("Não foi possível excluir o preset: " + (error instanceof Error ? error.message : String(error)));
      }
    },
    [onTerminalPresetsSaved, terminalPresets],
  );
  const squadRegions = useMemo(
    () => computeSquadRegions(canvas.squads, displayNodes),
    [displayNodes, canvas.squads],
  );
  const squadById = useMemo(
    () => new Map(canvas.squads.map((squad) => [squad.id, squad])),
    [canvas.squads],
  );
  // Geometria virtual da âncora de squad (`squad:<id>`) para desenhar arestas
  // que não terminam em nó — ex.: vínculo Nota→Squad.
  const squadAnchorGeometry = useMemo(() => {
    const map = new Map<string, { x: number; y: number; width: number; height: number }>();
    for (const region of squadRegions) {
      map.set(squadAnchorId(region.id), {
        x: region.x,
        y: region.y,
        width: region.width,
        height: 28,
      });
    }
    return map;
  }, [squadRegions]);
  // Membros de squads recolhidos continuam MONTADOS (sessões de terminal
  // preservadas): o cartão só fica oculto por wrapper, nunca desmonta.
  const collapsedMemberIds = useMemo(() => {
    const ids = new Set<string>();
    for (const squad of canvas.squads) {
      if (!squad.collapsed) continue;
      for (const id of squad.memberNodeIds) ids.add(id);
    }
    return ids;
  }, [canvas.squads]);
  const canvasFocus = useMemo(
    () => computeCanvasFocus(selected, canvas.connections),
    [selected, canvas.connections],
  );
  const inspectorNode = selected.length === 1 ? nodeMap.get(selected[0]) ?? null : null;
  // Squad inspecionável: seleção explícita do header ou contexto do nó.
  const inspectorSquad = useMemo(() => {
    if (selectedSquadId) return squadById.get(selectedSquadId) ?? null;
    if (inspectorNode) return squadForNode(canvas.squads, inspectorNode.id) ?? null;
    return null;
  }, [canvas.squads, inspectorNode, selectedSquadId, squadById]);
  const inspectorSquadMembers = useMemo(
    () =>
      inspectorSquad
        ? inspectorSquad.memberNodeIds
            .map((id) => nodeMap.get(id))
            .filter((node): node is CanvasNode => Boolean(node))
        : [],
    [inspectorSquad, nodeMap],
  );
  useEffect(() => {
    if (selectedSquadId && !squadById.has(selectedSquadId)) setSelectedSquadId(null);
  }, [selectedSquadId, squadById]);
  const isOrchestrationCoordinatorNode = useCallback(
    (node: CanvasNode) => {
      if (squadCoordinatedBy(canvas.squads, node.id)) return true;
      return !squadForNode(canvas.squads, node.id) && isCoordinatorRole(node.role);
    },
    [canvas.squads],
  );
  useEffect(() => {
    if (selected.length === 1) setInspectorOpen(true);
  }, [selected]);
  const orchestrationActive = Boolean(
    orchestration &&
      orchestration.phase !== "complete" &&
      orchestration.phase !== "blocked",
  );
  const orchestrationTarget = orchestration
    ? nodeMap.get(orchestration.expectedAgentId)
    : undefined;
  const orchestrationStatusText = orchestration
    ? orchestration.phase === "planning"
      ? "Coordenador preparando o plano"
      : orchestration.phase === "specialist"
        ? `Executando ${orchestrationTarget?.role || "agente especialista"}`
        : orchestration.phase === "finalizing"
          ? "Coordenador consolidando resultados"
          : orchestration.phase === "blocked"
            ? "Orquestração interrompida"
            : "Orquestração concluída"
    : "";
  const deletableSelection = selected.filter((id) => {
    const node = nodeMap.get(id);
    return node && !fixedKinds.has(node.kind);
  });
  const canDelete = deletableSelection.length > 0;
  const sendPolicyFor = (node: CanvasNode) =>
    agentSendPolicy({
      configured: isAgentNodeConfigured(node, agentProviders),
      configuredMessage: agentNodeSetupMessage(node, agentProviders),
      orchestrationActive,
      noteCount: memberContextNotes(canvas, node.id).length,
      progressState: agentProgress[node.id]?.state ?? null,
    });
  // Nota ausente é o único bloqueio que mantém o botão clicável: o clique
  // precisa acontecer para avisar o usuário. Os demais bloqueios desativam.
  const sendDisabledFor = (node: CanvasNode) => {
    const policy = sendPolicyFor(node);
    return policy.disabled && policy.blocker !== "note";
  };
  const removeLinks = () => {
    const ids = new Set(selected);
    update(
      (current) => ({
        ...current,
        connections: current.connections.filter(
          (link) => !ids.has(link.from) && !ids.has(link.to),
        ),
      }),
      true,
    );
  };
  const commitOrchestration = useCallback((next: OrchestrationRun | null) => {
    orchestrationRef.current = next;
    setOrchestration(next);
  }, []);
  const dispatchAgentTask = useCallback(
    (
      agent: CanvasNode,
      prompt: string,
      progress?: AgentProgress,
    ): string | null => {
      if (!onSendAgentTask) return null;
      if (!isAgentNodeConfigured(agent, agentProviders)) {
        setAgentProgress((current) => ({
          ...current,
          [agent.id]: { state: "blocked", label: agentNodeBlockedLabel },
        }));
        return null;
      }
      if (progress) {
        setAgentProgress((current) => ({ ...current, [agent.id]: progress }));
      }
      const taskId = onSendAgentTask(agent, prompt);
      if (!taskId) return null;
      update(
        (current) => ({
          ...current,
          nodes: current.nodes.map((node) =>
            node.id === agent.id
              ? { ...node, content: progress?.label || "Tarefa enviada agora" }
              : node,
          ),
        }),
        true,
      );
      return taskId;
    },
    [agentProviders, onSendAgentTask, update],
  );
  const markOrchestrationBlocked = useCallback(
    (run: OrchestrationRun, agentId: string) => {
      const next = { ...run, phase: "blocked" as const, expectedAgentId: agentId };
      commitOrchestration(next);
      setAgentProgress((current) => ({
        ...current,
        [agentId]: { state: "blocked", label: "Agente indisponível" },
      }));
    },
    [commitOrchestration],
  );
  const dispatchOrchestrationTask = useCallback(
    (
      run: OrchestrationRun,
      agent: CanvasNode,
      prompt: string,
      progress: AgentProgress,
    ): boolean => {
      const taskId = dispatchAgentTask(agent, prompt, progress);
      if (!taskId) {
        markOrchestrationBlocked(run, agent.id);
        return false;
      }
      commitOrchestration({ ...run, expectedTaskId: taskId });
      return true;
    },
    [commitOrchestration, dispatchAgentTask, markOrchestrationBlocked],
  );
  const reportAgentTaskFailure = useCallback(
    (agentId: string, taskId: string, message: string) => {
      void window.devorbit
        .reportOrchestrationTurn(project.path, {
          seatId: agentId,
          outcome: "failed",
          summary: message,
          transient: CONTINUITY_TRANSIENT_PATTERN.test(message),
        })
        .catch(() => undefined);
      if (manualTasksRef.current.delete(agentId)) {
        setAgentProgress((current) => ({
          ...current,
          [agentId]: { state: "blocked", label: message || "A tarefa falhou" },
        }));
      }
      const run = orchestrationRef.current;
      if (
        !run ||
        run.projectId !== project.id ||
        run.phase === "complete" ||
        run.phase === "blocked" ||
        run.expectedAgentId !== agentId ||
        (run.expectedTaskId !== undefined && run.expectedTaskId !== taskId)
      )
        return;
      markOrchestrationBlocked(
        { ...run, lastHandledResult: `failure:${taskId}:${message}` },
        agentId,
      );
    },
    [markOrchestrationBlocked, project.id, project.path],
  );
  const startCoordinatorOrchestration = useCallback(
    (coordinator: CanvasNode, squad?: CanvasSquad | null) => {
      const previous = orchestrationRef.current;
      if (
        previous &&
        previous.phase !== "complete" &&
        previous.phase !== "blocked"
      )
        return;
      if (!onSendAgentTask) return;
      const current = canvasRef.current;
      const currentCoordinator = current.nodes.find(
        (node) => node.id === coordinator.id && node.kind === "agent",
      );
      if (!currentCoordinator) return;
      const activeSquad =
        squad ?? squadCoordinatedBy(current.squads, currentCoordinator.id) ?? null;
      // Contexto explícito: notas diretas ao coordenador (legado), notas da
      // âncora do squad e objetivo da squad. Vazio não inicia a orquestração.
      const notes = orchestrationContextNotes(current, currentCoordinator.id, activeSquad);
      if (!notes.length) {
        onNotify?.(
          activeSquad
            ? "Conecte uma nota com conteúdo (ou defina o objetivo do squad) para iniciar a orquestração."
            : "Conecte uma nota com conteúdo ao coordenador para iniciar a orquestração.",
          "info",
        );
        return;
      }
      // Squad-first: membros explícitos do squad; sem squad, alcançabilidade
      // por cabos (comportamento legado) permanece.
      const specialists = discoverSpecialists(
        current,
        currentCoordinator,
        notes,
        activeSquad,
      );
      const run: OrchestrationRun = {
        id: orchestrationRunId(),
        projectId: project.id,
        coordinatorId: currentCoordinator.id,
        coordinatorTitle: currentCoordinator.title,
        notes,
        specialists,
        phase: "planning",
        specialistIndex: -1,
        expectedAgentId: currentCoordinator.id,
        plan: "",
        results: [],
      };
      commitOrchestration(run);
      setAgentProgress({
        [currentCoordinator.id]: {
          state: "running",
          label: "Planejando tarefa",
        },
        ...Object.fromEntries(
          specialists.map((specialist) => [specialist.id, {
            state: "queued" as const,
            label: "Aguardando coordenador",
          }]),
        ),
      });
      const specialistRoles = specialists.length
        ? specialists.map((specialist) => specialist.role).join(" → ")
        : "nenhuma etapa especialista; o coordenador concluirá sozinho";
      const prompt = composeAgentPrompt([
        `Você atua como Coordenador neste projeto (${currentCoordinator.title}).`,
        "Esta é a primeira etapa automática de uma execução em sequência.",
        "Analise a tarefa conectada, transforme-a em um plano executável e defina critérios claros para implementação, revisão e testes.",
        `As próximas etapas automáticas são: ${specialistRoles}.`,
        "Não aguarde outro clique para encaminhar o trabalho: o aplicativo fará isso quando você devolver o plano.",
        "## Tarefa e contexto conectado",
        formatOrchestrationNotes(notes),
      ]);
      dispatchOrchestrationTask(run, currentCoordinator, prompt, {
        state: "running",
        label: "Planejando tarefa",
      });
    },
    [
      commitOrchestration,
      dispatchOrchestrationTask,
      markOrchestrationBlocked,
      onNotify,
      onSendAgentTask,
      project.id,
    ],
  );
  const sendAgentTask = useCallback(
    (agent: CanvasNode) => {
      const currentRun = orchestrationRef.current;
      if (
        currentRun &&
        currentRun.phase !== "complete" &&
        currentRun.phase !== "blocked"
      )
        return;
      // Função de coordenação é explícita: coordenador do squad OU papel
      // built-in "Coordenador" fora de squad. Papel custom nunca dispara.
      const coordinatingSquad = squadCoordinatedBy(canvasRef.current.squads, agent.id);
      const squadMembership = squadForNode(canvasRef.current.squads, agent.id);
      const isOrchestrationCoordinator = coordinatingSquad
        ? true
        : !squadMembership && isCoordinatorRole(agent.role);
      if (isOrchestrationCoordinator) {
        startCoordinatorOrchestration(agent, coordinatingSquad ?? null);
        return;
      }
      const current = canvasRef.current;
      const currentAgent = current.nodes.find(
        (node) => node.id === agent.id && node.kind === "agent",
      );
      if (!currentAgent || !onSendAgentTask) return;
      const currentProgress = agentProgress[currentAgent.id];
      if (
        currentProgress?.state === "queued" ||
        currentProgress?.state === "running"
      )
        return;
      const linkedNotes = memberContextNotes(current, currentAgent.id);
      if (!linkedNotes.length) {
        onNotify?.(
          squadMembership
            ? "Conecte uma nota com conteúdo (ou defina o objetivo do squad) antes de enviar a tarefa."
            : "Conecte uma nota com conteúdo a este agente antes de enviar a tarefa.",
          "info",
        );
        return;
      }
      manualTasksRef.current.add(currentAgent.id);
      const prompt = composeAgentPrompt([
        `Você atua como ${currentAgent.role || "Implementação"} neste projeto.`,
        "Execute a tarefa usando o contexto conectado abaixo.",
        formatOrchestrationNotes(linkedNotes),
      ]);
      const taskId = dispatchAgentTask(currentAgent, prompt, {
        state: "running",
        label: "Aguardando resultado",
      });
      if (!taskId) manualTasksRef.current.delete(currentAgent.id);
    },
    [
      agentProgress,
      dispatchAgentTask,
      onNotify,
      onSendAgentTask,
      startCoordinatorOrchestration,
    ],
  );
  const reportAgentResult = useCallback(
    (agentId: string, result: AgentResult, taskId?: string) => {
      const normalizedResult = result.summary.trim().slice(0, 1000);
      void window.devorbit
        .reportOrchestrationTurn(project.path, {
          seatId: agentId,
          outcome: result.outcome,
          summary: normalizedResult,
        })
        .catch(() => undefined);
      update(
        (current) => ({
          ...current,
          nodes: current.nodes.map((node) =>
            node.id === agentId
              ? { ...node, content: normalizedResult }
              : node,
          ),
        }),
        true,
      );
      if (manualTasksRef.current.delete(agentId)) {
        setAgentProgress((current) => ({
          ...current,
          [agentId]: { state: "completed", label: "Resultado recebido" },
        }));
      }
      if (!normalizedResult) return;
      const run = orchestrationRef.current;
      if (
        !run ||
        run.projectId !== project.id ||
        run.phase === "complete" ||
        run.phase === "blocked" ||
        run.expectedAgentId !== agentId ||
        (run.expectedTaskId !== undefined && run.expectedTaskId !== taskId)
      )
        return;
      const resultKey = `${run.id}:${run.phase}:${agentId}:${taskId || "legacy"}:${normalizedResult}`;
      if (run.lastHandledResult === resultKey) return;

      if (result.outcome === "blocked" || result.outcome === "failed") {
        markOrchestrationBlocked(
          { ...run, lastHandledResult: resultKey },
          agentId,
        );
        return;
      }

      if (run.phase === "planning") {
        const planRun = {
          ...run,
          plan: normalizedResult,
          lastHandledResult: resultKey,
        };
        setAgentProgress((current) => ({
          ...current,
          [agentId]: { state: "completed", label: "Plano concluído" },
        }));
        if (!run.specialists.length) {
          const finalRun: OrchestrationRun = {
            ...planRun,
            phase: "finalizing",
            expectedAgentId: run.coordinatorId,
            expectedTaskId: undefined,
          };
          setAgentProgress((current) => ({
            ...current,
            [agentId]: {
              state: "running",
              label: "Executando tarefa",
            },
          }));
          const coordinatorNode = canvasRef.current.nodes.find(
            (node) => node.id === run.coordinatorId && node.kind === "agent",
          );
          const finalPrompt = composeAgentPrompt([
            `Você atua como Coordenador neste projeto (${run.coordinatorTitle}).`,
            "Não há especialistas conectados. Execute agora todo o plano que você preparou e entregue o resultado final.",
            "Faça as alterações, validações e correções necessárias sem aguardar outro clique.",
            "## Tarefa e contexto conectado",
            formatOrchestrationNotes(run.notes),
            "## Plano preparado",
            normalizedResult,
          ]);
          if (
            !coordinatorNode ||
            !dispatchOrchestrationTask(finalRun, coordinatorNode, finalPrompt, {
              state: "running",
              label: "Executando tarefa",
            })
          ) {
            markOrchestrationBlocked(finalRun, run.coordinatorId);
          }
          return;
        }
        const firstSpecialist = run.specialists[0];
        const nextRun: OrchestrationRun = {
          ...planRun,
          phase: "specialist",
          specialistIndex: 0,
          expectedAgentId: firstSpecialist.id,
          expectedTaskId: undefined,
        };
        setAgentProgress((current) => ({
          ...current,
          [firstSpecialist.id]: {
            state: "running",
            label: `${firstSpecialist.role} em execução`,
          },
        }));
        const specialistNotes = mergeOrchestrationNotes(
          run.notes,
          firstSpecialist.notes,
        );
        const specialistPrompt = composeAgentPrompt([
          `Você atua como ${firstSpecialist.role} neste projeto (${firstSpecialist.title}).`,
          "Esta é a próxima etapa automática; execute sua parte sem aguardar novos cliques.",
          "Use o plano do coordenador e o contexto da tarefa para produzir uma entrega concreta.",
          "## Tarefa e contexto conectado",
          formatOrchestrationNotes(specialistNotes),
          "## Plano do coordenador",
          nextRun.plan,
          "## Resultados anteriores",
          formatOrchestrationResults(nextRun.results),
        ]);
        const firstSpecialistNode = canvasRef.current.nodes.find(
          (node) => node.id === firstSpecialist.id && node.kind === "agent",
        );
        if (
          !firstSpecialistNode ||
          !dispatchOrchestrationTask(
            nextRun,
            firstSpecialistNode,
            specialistPrompt,
            {
              state: "running",
              label: `${firstSpecialist.role} em execução`,
            },
          )
        ) {
          markOrchestrationBlocked(nextRun, firstSpecialist.id);
        }
        return;
      }

      if (run.phase === "specialist") {
        const specialist = run.specialists[run.specialistIndex];
        if (!specialist || specialist.id !== agentId) return;
        const nextResults = [
          ...run.results,
          {
            agentId,
            title: specialist.title,
            role: specialist.role,
            content: normalizedResult,
          },
        ];
        const specialistRun = {
          ...run,
          results: nextResults,
          lastHandledResult: resultKey,
        };
        setAgentProgress((current) => ({
          ...current,
          [agentId]: { state: "completed", label: "Etapa concluída" },
        }));
        const nextSpecialist = run.specialists[run.specialistIndex + 1];
        if (nextSpecialist) {
          const nextRun: OrchestrationRun = {
            ...specialistRun,
            specialistIndex: run.specialistIndex + 1,
            expectedAgentId: nextSpecialist.id,
            expectedTaskId: undefined,
          };
          setAgentProgress((current) => ({
            ...current,
            [nextSpecialist.id]: {
              state: "running",
              label: `${nextSpecialist.role} em execução`,
            },
          }));
          const specialistNotes = mergeOrchestrationNotes(
            run.notes,
            nextSpecialist.notes,
          );
          const specialistPrompt = composeAgentPrompt([
            `Você atua como ${nextSpecialist.role} neste projeto (${nextSpecialist.title}).`,
            "Esta é a próxima etapa automática; execute sua parte sem aguardar novos cliques.",
            "Considere o plano do coordenador e todos os resultados anteriores antes de trabalhar.",
            "## Tarefa e contexto conectado",
            formatOrchestrationNotes(specialistNotes),
            "## Plano do coordenador",
            nextRun.plan,
            "## Resultados anteriores",
            formatOrchestrationResults(nextRun.results),
          ]);
          const nextSpecialistNode = canvasRef.current.nodes.find(
            (node) => node.id === nextSpecialist.id && node.kind === "agent",
          );
          if (
            !nextSpecialistNode ||
            !dispatchOrchestrationTask(
              nextRun,
              nextSpecialistNode,
              specialistPrompt,
              {
                state: "running",
                label: `${nextSpecialist.role} em execução`,
              },
            )
          ) {
            markOrchestrationBlocked(nextRun, nextSpecialist.id);
          }
          return;
        }
        const finalRun: OrchestrationRun = {
          ...specialistRun,
          phase: "finalizing",
          expectedAgentId: run.coordinatorId,
          expectedTaskId: undefined,
        };
        setAgentProgress((current) => ({
          ...current,
          [run.coordinatorId]: {
            state: "running",
            label: "Consolidando resultados",
          },
        }));
        const finalPrompt = composeAgentPrompt([
          `Você é o Coordenador na etapa final deste projeto (${run.coordinatorTitle}).`,
          "Esta etapa automática encerra a execução. Consolide o plano e os resultados dos especialistas, valide o que foi entregue e registre pendências ou bloqueios restantes.",
          "## Tarefa e contexto conectado",
          formatOrchestrationNotes(run.notes),
          "## Plano original",
          run.plan,
          "## Resultados dos especialistas",
          formatOrchestrationResults(nextResults),
        ]);
        const coordinator = canvasRef.current.nodes.find(
          (node) => node.id === run.coordinatorId && node.kind === "agent",
        );
        if (
          !coordinator ||
          !dispatchOrchestrationTask(finalRun, coordinator, finalPrompt, {
            state: "running",
            label: "Consolidando resultados",
          })
        ) {
          markOrchestrationBlocked(finalRun, run.coordinatorId);
        }
        return;
      }

      if (run.phase === "finalizing") {
        const completeRun: OrchestrationRun = {
          ...run,
          phase: "complete",
          lastHandledResult: resultKey,
        };
        commitOrchestration(completeRun);
        setAgentProgress((current) => ({
          ...current,
          [agentId]: {
            state: "completed",
            label: "Orquestração concluída",
          },
        }));
      }
    },
    [
      commitOrchestration,
      dispatchAgentTask,
      markOrchestrationBlocked,
      project.id,
      update,
    ],
  );
  const startConnection = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, node: CanvasNode) => {
      event.preventDefault();
      event.stopPropagation();
      const point = pointerToWorld(event.clientX, event.clientY);
      const draft = { from: node.id, x: point.x, y: point.y, pointerId: event.pointerId };
      connectionDraftRef.current = draft;
      setConnectionDraft(draft);
      setConnectFrom(node.id);
    },
    [pointerToWorld],
  );
  const chooseConnectionSource = useCallback((id: string) => {
    connectionDraftRef.current = null;
    setConnectionDraft(null);
    setConnectFrom(id);
  }, []);
  const moveFromMinimap = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    const map = event.currentTarget.getBoundingClientRect();
    const host = viewportRef.current?.getBoundingClientRect();
    if (!host) return;
    const worldX = ((event.clientX - map.left) / map.width) * WORLD_WIDTH;
    const worldY = ((event.clientY - map.top) / map.height) * WORLD_HEIGHT;
    update(
      (current) => ({
        ...current,
        viewport: {
          ...current.viewport,
          x: host.width / 2 - worldX * current.viewport.zoom,
          y: host.height / 2 - worldY * current.viewport.zoom,
        },
      }),
      true,
    );
  }, [update]);
  const startMinimapNavigation = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      event.preventDefault();
      event.stopPropagation();
      minimapPointerRef.current = event.pointerId;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* Synthetic events and inactive pointers cannot be captured. */
      }
      moveFromMinimap(event);
    },
    [moveFromMinimap],
  );
  const continueMinimapNavigation = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (minimapPointerRef.current !== event.pointerId) return;
      event.preventDefault();
      moveFromMinimap(event);
    },
    [moveFromMinimap],
  );
  const finishMinimapNavigation = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (minimapPointerRef.current !== event.pointerId) return;
      minimapPointerRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* The pointer may already have been released by the browser. */
      }
    },
    [],
  );

  // Assinatura estável dos assentos elegíveis do canvas; evita loop de sync.
  const continuitySeatSignature = canvas.nodes
    .filter((node) => node.kind === "agent" && node.provider)
    .map((node) => {
      const isCoordinator = Boolean(squadCoordinatedBy(canvas.squads, node.id));
      return `${node.id}:${node.provider}:${continuityRoleFor(node.role, isCoordinator)}:${node.account || ""}`;
    })
    .sort()
    .join("|");

  useEffect(() => {
    continuityRef.current = continuity;
  }, [continuity]);

  // Estado de continuidade do projeto + reação auditável a handoffs.
  useEffect(() => {
    let alive = true;
    const apply = (next: OrchestrationState | null) => {
      continuityRef.current = next;
      continuityLoadedRef.current = continuityLoadedRef.current || next !== null;
      if (alive) setContinuity(next);
    };
    const refresh = async () => {
      try {
        apply(await window.devorbit.getOrchestrationState(project.path));
      } catch {
        /* continuidade é opcional */
      }
    };
    void refresh();
    const unsubscribe = window.devorbit.onOrchestrationEvent((event) => {
      if (!alive) return;
      if (
        event.type === "role.handoff" ||
        event.type === "handoff.blocked" ||
        event.type === "seat.circuit.open"
      ) {
        onNotify?.(
          continuityEventMessage(event),
          event.type === "role.handoff" ? "success" : "info",
        );
      }
      if (event.type === "role.handoff" && event.toSeatId) {
        const prompt = event.nextAction?.prompt;
        const target = canvasRef.current.nodes.find(
          (node) => node.id === event.toSeatId && node.kind === "agent",
        );
        if (
          !target ||
          !prompt ||
          continuityHandledRef.current.has(event.id)
        ) {
          return;
        }
        continuityHandledRef.current.add(event.id);
        dispatchAgentTask(target, prompt, {
          state: "running",
          label: "Retomando após handoff",
        });
      }
      void refresh();
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [dispatchAgentTask, onNotify, project.path]);

  // Registra/atualiza assentos dos agentes configurados (id = nó do canvas).
  useEffect(() => {
    if (!continuityLoadedRef.current) return;
    const nodes = canvasRef.current.nodes.filter(
      (node) => node.kind === "agent" && node.provider,
    );
    const activeIds = new Set(nodes.map((node) => node.id));
    for (const node of nodes) {
      void window.devorbit
        .upsertOrchestrationSeat(project.path, {
          id: node.id,
          provider: node.provider as AgentProviderId,
          role: continuityRoleFor(
            node.role,
            Boolean(squadCoordinatedBy(canvasRef.current.squads, node.id)),
          ),
          ...(node.account ? { account: node.account } : {}),
        })
        .catch(() => undefined);
    }
    const knownSeats = continuityRef.current?.seats ?? {};
    for (const seatId of Object.keys(knownSeats)) {
      const stillExists = canvasRef.current.nodes.some(
        (node) => node.id === seatId,
      );
      if (!activeIds.has(seatId) && !stillExists) {
        void window.devorbit
          .removeOrchestrationSeat(project.path, seatId)
          .catch(() => undefined);
      }
    }
  }, [continuitySeatSignature, project.path]);

  const toggleContinuity = useCallback(
    (enabled: boolean) => {
      void window.devorbit
        .setOrchestrationContinuity(project.path, enabled)
        .then((next) => {
          continuityRef.current = next;
          setContinuity(next);
          onNotify?.(
            enabled
              ? "Continuidade multi-provedor ativada."
              : "Continuidade multi-provedor desativada.",
            "info",
          );
        })
        .catch((error) =>
          onNotify?.(
            "Não foi possível alterar a continuidade: " +
              (error instanceof Error ? error.message : String(error)),
            "error",
          ),
        );
    },
    [onNotify, project.path],
  );

  const radialItems = useMemo<CanvasRadialItem[]>(
    () => [
      {
        id: "terminal",
        label: "Terminal",
        icon: Terminal,
        onSelect: openTerminalQuickDeploy,
      },
      {
        id: "agent",
        label: "Agente",
        icon: Bot,
        onSelect: openAgentCreation,
      },
      {
        id: "squad",
        label: "Squad",
        icon: Users,
        onSelect: openSquadCreation,
      },
      {
        id: "squad-selection",
        label: "Squad c/ seleção",
        icon: Users,
        disabled: !selected.some((id) =>
          canvas.nodes.some((node) => node.id === id && node.kind === "agent"),
        ),
        disabledReason: "Selecione ao menos um agente para criar um squad",
        onSelect: createSquadFromSelection,
      },
      {
        id: "squad-add",
        label: "Adicionar à squad",
        icon: Users,
        disabled: !squadTargetForSelection(),
        disabledReason: "Selecione agentes de um squad (ou tenha um único squad)",
        onSelect: addSelectionToSquad,
      },
      {
        id: "squad-remove",
        label: "Remover da squad",
        icon: Unlink,
        disabled: !selected.some((id) => Boolean(squadForNode(canvas.squads, id))),
        disabledReason: "Selecione membros de um squad para remover",
        onSelect: removeSelectionFromSquad,
      },
      {
        id: "squad-coordinator",
        label: "Tornar coordenador",
        icon: Crown,
        disabled: !selected.some((id) => Boolean(squadForNode(canvas.squads, id))),
        disabledReason: "Selecione um membro do squad para coordenar",
        onSelect: promoteSelectionToCoordinator,
      },
      {
        id: "squad-rename",
        label: "Renomear squad",
        icon: Edit2,
        disabled: !squadTargetForSelection(),
        disabledReason: "Selecione um membro do squad (ou tenha um único squad)",
        onSelect: () => {
          const squad = squadTargetForSelection();
          if (squad) renameSquadFromPrompt(squad.id);
        },
      },
      {
        id: "note",
        label: "Nota",
        icon: NotebookPen,
        onSelect: addNote,
      },
      {
        id: "connect",
        label: "Conectar",
        icon: Link2,
        disabled: !selected.length || Boolean(connectFrom),
        disabledReason: connectFrom
          ? "Escolha o destino do nó atual"
          : "Selecione um nó do canvas para conectar",
        onSelect: () => {
          const source = selected[selected.length - 1];
          if (source) setConnectFrom(source);
        },
      },
      {
        id: "duplicate",
        label: "Duplicar",
        icon: FileText,
        disabled: nodeMap.get(selected[selected.length - 1])?.kind !== "note",
        disabledReason: "Duplicar só está disponível para notas selecionadas",
        onSelect: duplicateSelected,
      },
      {
        id: "unlink",
        label: "Desvincular",
        icon: Unlink,
        disabled: !selected.some((id) =>
          canvas.connections.some((link) => link.from === id || link.to === id),
        ),
        disabledReason: "Selecione um nó com conexões para desvincular",
        onSelect: removeLinks,
      },
      {
        id: "reset",
        label: "Resetar",
        icon: RotateCcw,
        onSelect: resetCanvas,
      },
    ],
    [
      addNote,
      canvas.connections,
      connectFrom,
      duplicateSelected,
      nodeMap,
      openAgentCreation,
      openSquadCreation,
      openTerminalQuickDeploy,
      removeLinks,
      resetCanvas,
      selected,
    ],
  );

  return (
    <div
      ref={viewportRef}
      className={
        "workspace-canvas v2" +
        (gesture?.type === "pan" ? " is-panning" : "") +
        (gesture?.type === "drag" ? " is-dragging" : "") +
        (connectFrom ? " is-connection-pending" : "")
      }
      data-canvas-project-id={project.id}
      tabIndex={0}
      aria-label="Área de trabalho do canvas"
      onPointerDown={(event) => {
        const target = event.target;
        if (
          closestElement(
            target,
            ".workspace-canvas-card, .workspace-canvas-radial, .workspace-canvas-view-hud, .workspace-canvas-minimap",
          )
        )
          return;
        const targetElement = target instanceof Element ? target : null;
        if (
          event.target !== event.currentTarget &&
          !(targetElement?.classList.contains("workspace-canvas-grid") ||
            targetElement?.classList.contains("workspace-canvas-world") ||
            targetElement?.classList.contains("workspace-canvas-connections"))
        )
          return;
        if (event.button === 0) {
          setSelected([]);
          setSelectedSquadId(null);
          setConnectFrom(null);
          connectionDraftRef.current = null;
          setConnectionDraft(null);
        }
        startPan(event);
      }}
    >
      <div className="workspace-canvas-grid" />
      <CanvasRadialMenu items={radialItems} label="Menu do canvas" />
      <CanvasToolbar
        projectName={project.name}
        zoom={canvas.viewport.zoom}
        zoomLevels={CANVAS_ZOOM_LEVELS}
        onSetZoom={setZoomLevel}
        onZoomIn={() => zoomByLevel(1)}
        onZoomOut={() => zoomByLevel(-1)}
        onResetViewport={resetViewport}
        onFitCanvas={fitCanvas}
        onSetZoomPreset={setZoomPreset}
        onOpenAgentCreation={openAgentCreation}
        onOpenSquadCreation={openSquadCreation}
        onAddNote={addNote}
        onOpenTerminalQuickDeploy={openTerminalQuickDeploy}
        onResetCanvas={resetCanvas}
        selectionCount={selected.length}
        hasSelection={selected.length > 0}
        canDelete={canDelete}
        onDeleteSelected={deleteSelected}
        onFocusSelected={focusSelected}
        isFocusModeActive={canvasFocus.active}
        isInspectorOpen={inspectorOpen}
        onToggleInspector={() => setInspectorOpen((current) => !current)}
        isConnecting={Boolean(connectFrom)}
        onStartConnection={() => {
          const source = selected[selected.length - 1];
          if (source) setConnectFrom(source);
        }}
        onRemoveLinks={removeLinks}
      />
      <div
        className="workspace-canvas-world"
        style={{
          width: WORLD_WIDTH,
          height: WORLD_HEIGHT,
          transform: `translate(${canvas.viewport.x}px, ${canvas.viewport.y}px) scale(${canvas.viewport.zoom})`,
        }}
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.button === 0) {
            setSelected([]);
            setConnectFrom(null);
            connectionDraftRef.current = null;
            setConnectionDraft(null);
          }
          startPan(event);
        }}
      >
        {squadRegions.map((region) => {
          const squad = squadById.get(region.id);
          const memberCount = squad?.memberNodeIds.length ?? 0;
          return (
            <div
              key={region.id}
              className={
                "canvas-squad-region" +
                (region.collapsed ? " is-collapsed" : "") +
                (selectedSquadId === region.id ? " is-selected" : "")
              }
              data-canvas-squad-id={region.id}
              data-collapsed={region.collapsed ? "true" : "false"}
              data-selected={selectedSquadId === region.id ? "true" : "false"}
              style={{
                left: region.x,
                top: region.y,
                width: region.width,
                height: region.height,
                pointerEvents: "none",
                ...(selectedSquadId === region.id
                  ? {
                      outline: "2px solid var(--color-accent-strong, #3b82f6)",
                      outlineOffset: 2,
                    }
                  : {}),
              }}
            >
              {/* Âncora visual do squad: arestas Nota→Squad terminam aqui. */}
              <span
                className="canvas-squad-region-anchor"
                data-canvas-squad-anchor={squadAnchorId(region.id)}
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: "100%",
                  height: 28,
                  pointerEvents: "none",
                }}
                aria-hidden="true"
              />
              <button
                type="button"
                className="canvas-squad-region-label"
                data-canvas-squad-header={region.id}
                aria-pressed={selectedSquadId === region.id}
                aria-label={"Selecionar squad " + region.title}
                title="Selecionar squad e abrir o Inspector"
                onClick={() => selectSquad(region.id)}
                style={{
                  pointerEvents: "auto",
                  background: "transparent",
                  border: 0,
                  cursor: "pointer",
                  font: "inherit",
                  color: "inherit",
                  textAlign: "left",
                }}
              >
                <Users size={11} aria-hidden="true" />
                SQUAD · {region.title}
                {region.collapsed ? ` · ${memberCount} membro(s)` : ""}
                {!region.coordinatorNodeId ? " · sem coordenador" : ""}
              </button>
              <span
                className="canvas-squad-region-actions"
                style={{
                  position: "absolute",
                  top: 2,
                  right: 4,
                  display: "flex",
                  gap: 4,
                  pointerEvents: "auto",
                }}
              >
                {/* Alvo discreto: liga uma Nota existente à âncora squad:<id>
                    sem bloquear a seleção do header nem o drag dos membros. */}
                <button
                  type="button"
                  className={"canvas-squad-anchor-port" + (connectFrom ? " is-available" : "")}
                  data-canvas-port="target"
                  data-canvas-node-id={squadAnchorId(region.id)}
                  aria-label={"Conectar nota ao squad " + region.title}
                  title="Arraste uma conexão até aqui para vincular a nota ao squad"
                  disabled={!connectFrom}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={() => connectNodes(connectFrom, squadAnchorId(region.id))}
                  style={{ fontSize: 10, padding: "1px 6px", cursor: connectFrom ? "crosshair" : "default" }}
                >
                  Nota
                </button>
                <button
                  type="button"
                  onClick={() => addNewAgentToSquad(region.id)}
                  aria-label={"Criar agente e adicionar ao squad " + region.title}
                  title="Cria um agente novo ao lado do squad (sem mover os existentes)"
                  style={{ fontSize: 10, padding: "1px 6px", cursor: "pointer" }}
                >
                  + Agente
                </button>
                <button
                  type="button"
                  onClick={() => renameSquadFromPrompt(region.id)}
                  aria-label={"Renomear squad " + region.title}
                  title="Renomear squad"
                  style={{ fontSize: 10, padding: "1px 6px", cursor: "pointer" }}
                >
                  Renomear
                </button>
                <button
                  type="button"
                  onClick={() => editSquadObjective(region.id)}
                  aria-label={"Editar objetivo do squad " + region.title}
                  title={squad?.objective ? "Objetivo: " + squad.objective : "Definir objetivo do squad"}
                  style={{ fontSize: 10, padding: "1px 6px", cursor: "pointer" }}
                >
                  Objetivo
                </button>
                <button
                  type="button"
                  onClick={() => toggleSquadCollapsedById(region.id)}
                  aria-label={
                    region.collapsed
                      ? "Expandir squad " + region.title
                      : "Recolher squad " + region.title
                  }
                  aria-expanded={!region.collapsed}
                  title={region.collapsed ? "Expandir squad" : "Recolher squad"}
                  style={{ fontSize: 10, padding: "1px 6px", cursor: "pointer" }}
                >
                  {region.collapsed ? "Expandir" : "Recolher"}
                </button>
              </span>
            </div>
          );
        })}
        <svg
          className="workspace-canvas-connections"
          width={WORLD_WIDTH}
          height={WORLD_HEIGHT}
          aria-hidden="true"
        >
          <defs>
            <marker
              id="canvas-edge-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="canvas-edge-arrowhead" />
            </marker>
          </defs>
          {canvas.connections.map((connection) => {
            const from =
              displayNodeMap.get(connection.from) ?? squadAnchorGeometry.get(connection.from);
            const to = displayNodeMap.get(connection.to) ?? squadAnchorGeometry.get(connection.to);
            if (!from || !to) return null;
            const kind = defaultCanvasEdgeKind(connection.kind);
            const label = canvasEdgeLabel(kind, connection.label);
            const midX = (from.x + from.width + to.x) / 2;
            const midY = (from.y + from.height / 2 + to.y + to.height / 2) / 2;
            return (
              <g
                key={connection.id}
                className={"canvas-edge edge-" + kind}
                data-edge-kind={kind}
                data-edge-label={label}
              >
                <path
                  className="canvas-edge-path"
                  d={connectionPath(from, to.x, to.y + to.height / 2)}
                  markerEnd={kind === "visual" ? undefined : "url(#canvas-edge-arrow)"}
                />
                {connection.label && (
                  <text
                    className="canvas-edge-label"
                    x={midX}
                    y={midY - 4}
                    textAnchor="middle"
                    style={{ fontSize: 10, pointerEvents: "none" }}
                  >
                    {connection.label}
                  </text>
                )}
                <title>{label}</title>
              </g>
            );
          })}
          {connectionDraft && displayNodeMap.get(connectionDraft.from) && (
            <path
              className="workspace-canvas-connection-preview"
              d={connectionPath(
                displayNodeMap.get(connectionDraft.from)!,
                connectionDraft.x,
                connectionDraft.y,
              )}
            />
          )}
        </svg>
        {canvas.nodes
          .filter((node) => node.kind !== "browser" || browser)
          .map((node) => {
            const slot = resolveCanvasNodeSlot(node.id, collapsedMemberIds, canvasFocus);
            // Wrapper SEMPRE presente e estável (mesma posição/key na lista):
            // collapse/atenuação mudam só classe/style. Alternar entre retornar
            // o cartão direto e embrulhá-lo trocaria o tipo do elemento e
            // desmontaria CanvasNodeCard/WorkspaceTerminal, matando a sessão.
            return (
              <div
                key={node.id}
                className={
                  "canvas-node-slot" +
                  (slot.hidden ? " is-collapsed" : "") +
                  (slot.dimmed ? " is-dimmed" : "")
                }
                data-canvas-node-slot={node.id}
                data-collapsed={slot.hidden ? "true" : "false"}
                data-dimmed={slot.dimmed ? "true" : "false"}
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: 0,
                  height: 0,
                  ...(slot.hidden
                    ? { visibility: "hidden" as const, pointerEvents: "none" as const }
                    : {}),
                  ...(slot.dimmed ? { opacity: 0.32 } : {}),
                }}
              >
            <CanvasNodeCard
              node={node}
              isSelected={selected.includes(node.id)}
              isConnecting={connectFrom === node.id}
              isConnectionTargetAvailable={Boolean(connectFrom && connectFrom !== node.id)}
              isConfigOpen={configNodeId === node.id}
              isCompact={isNodeCompact(node)}
              onToggleCompact={toggleNodeCompact}
              progress={agentProgress[node.id]}
              agentProviders={agentProviders}
              quickDeployChips={quickDeployChips}
              terminalPresets={terminalPresets}
              terminalDraft={terminalDraft}
              terminalCommandHint={terminalCommandHint}
              presetDraftName={presetDraftName}
              presetSaveStatus={presetSaveStatus}
              nodeMeta={nodeMeta}
              spaceHeld={spaceHeldRef.current}
              isSendDisabled={node.kind === 'agent' ? sendDisabledFor(node) : false}
              sendTitle={
                node.kind === 'agent'
                  ? sendPolicyFor(node).disabled
                    ? sendPolicyFor(node).reason
                    : isOrchestrationCoordinatorNode(node)
                      ? 'Iniciar orquestração com as notas conectadas'
                      : 'Enviar as notas conectadas ao agente'
                  : undefined
              }
              isSquadCoordinator={node.kind === 'agent' ? isOrchestrationCoordinatorNode(node) : undefined}
              onSelect={selectNode}
              onStartPan={startPan}
              onStartNodeDrag={startNodeDrag}
              onStartResize={startResize}
              onStartConnection={startConnection}
              onChooseConnectionSource={chooseConnectionSource}
              onConnectNodes={(targetId) => connectNodes(connectFrom, targetId)}
              onDeleteNode={(id) => deleteNodes([id])}
              onToggleConfig={(id) => setConfigNodeId((curr) => (curr === id ? null : id))}
              onDisconnectLinks={disconnectNodeLinks}
              onFocusNode={focusNode}
              onUpdateGeometry={(id, geom) =>
                update((current) => ({
                  ...current,
                  nodes: current.nodes.map((n) => (n.id === id ? { ...n, ...geom } : n)),
                }))
              }
              onUpdateTitle={(id, title) => renameTerminalNode(id, title)}
              onUpdateRole={(id, role) => updateNode(id, { role })}
              onUpdateProvider={(id, provider) => updateNode(id, { provider })}
              onUpdateAccount={(id, account) => updateNode(id, { account })}
              onUpdateContent={(id, content) =>
                update((current) => ({
                  ...current,
                  nodes: current.nodes.map((n) => (n.id === id ? { ...n, content } : n)),
                }))
              }
              onSendTask={sendAgentTask}
              onIsolateWorktree={onCreateAgentWorktree}
              onUpdateTerminalNode={updateTerminalNode}
              onSetTerminalDraftField={setTerminalDraftField}
              onCommitTerminalFields={commitTerminalFields}
              onSetTerminalDraft={setTerminalDraft}
              onSetTerminalCommandHint={setTerminalCommandHint}
              onSetPresetDraftName={setPresetDraftName}
              onSetPresetSaveStatus={setPresetSaveStatus}
              onSavePreset={saveTerminalPreset}
              onRenameCustomPreset={renameCustomPreset}
              onDeleteCustomPreset={deleteCustomPresetAction}
              workbench={workbench}
              browser={browser}
              renderAgent={
                renderAgent
                  ? (n) =>
                      renderAgent(
                        n,
                        (res, taskId) => reportAgentResult(n.id, res, taskId),
                        (taskId, msg) => reportAgentTaskFailure(n.id, taskId, msg),
                      )
                  : undefined
              }
              renderTerminal={renderTerminal}
            />
              </div>
            );
          })}
      </div>
      <CanvasMinimap
        viewport={canvas.viewport}
        nodes={displayNodes}
        worldWidth={WORLD_WIDTH}
        worldHeight={WORLD_HEIGHT}
        viewportWidth={viewportRef.current?.getBoundingClientRect()?.width || 900}
        viewportHeight={viewportRef.current?.getBoundingClientRect()?.height || 650}
        onPointerDown={startMinimapNavigation}
        onPointerMove={continueMinimapNavigation}
        onPointerUp={finishMinimapNavigation}
      />
      {connectFrom && (
        <div
          className="workspace-canvas-connection-status"
          role="status"
          aria-live="polite"
          style={{ pointerEvents: 'auto' }}
        >
          <Link2 size={13} aria-hidden="true" />
          <span>Conexão iniciada. Arraste até uma porta ou escolha o destino. Esc cancela.</span>
          <select
            aria-label="Selecionar nó de destino para conexão"
            defaultValue=""
            onChange={(event) => {
              const targetId = event.target.value;
              if (targetId) {
                connectNodes(connectFrom, targetId);
              }
            }}
            style={{
              pointerEvents: 'auto',
              fontSize: '11px',
              padding: '2px 6px',
              borderRadius: '4px',
              border: '1px solid var(--ops-border-strong, #555)',
              background: 'var(--ops-bg-panel, #222)',
              color: 'var(--text-primary, #fff)',
              cursor: 'pointer',
            }}
          >
            <option value="" disabled>
              Destino por teclado...
            </option>
            {canvas.nodes
              .filter((targetNode) => targetNode.id !== connectFrom)
              .map((targetNode) => (
                <option key={targetNode.id} value={targetNode.id}>
                  {targetNode.title} ({targetNode.kind === 'agent' ? targetNode.role : targetNode.kind})
                </option>
              ))}
          </select>
          <button
            type="button"
            onClick={() => {
              setConnectFrom(null);
              setConnectionDraft(null);
            }}
            style={{
              pointerEvents: 'auto',
              fontSize: '11px',
              padding: '2px 8px',
              borderRadius: '4px',
              border: '1px solid var(--ops-border-strong, #555)',
              background: 'transparent',
              color: 'var(--text-primary, #fff)',
              cursor: 'pointer',
            }}
            aria-label="Cancelar conexão"
          >
            Cancelar
          </button>
        </div>
      )}
      {continuity && (
        <div
          className="workspace-canvas-continuity-status"
          data-orchestration-continuity={continuity.policy.enabled ? "on" : "off"}
          role="status"
          aria-live="polite"
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={continuity.policy.enabled}
              onChange={(event) => toggleContinuity(event.target.checked)}
              aria-label="Ativar continuidade multi-provedor"
            />
            <span>
              <strong>Continuidade multi-provedor</strong>
              <small>
                {Object.keys(continuity.seats).length} assento(s) ·{" "}
                {continuity.policy.enabled ? "ativa" : "opt-in desligado"}
              </small>
            </span>
          </label>
        </div>
      )}
      {orchestration && (
        <div
          className={
            "workspace-canvas-orchestration-status orchestration-" +
            orchestration.phase
          }
          data-orchestration-phase={orchestration.phase}
          role="status"
          aria-live="polite"
        >
          <Terminal size={14} aria-hidden="true" />
          <span>
            <strong>{orchestrationStatusText}</strong>
            <small>
              {orchestration.phase === "specialist"
                ? `Etapa ${orchestration.specialistIndex + 1} de ${orchestration.specialists.length}`
                : orchestration.phase === "finalizing"
                  ? `${orchestration.results.length} resultado(s) recebido(s)`
                  : orchestration.phase === "complete"
                    ? "Todas as etapas foram processadas automaticamente"
                    : orchestration.phase === "blocked"
                      ? "Revise o cartão indicado e tente novamente"
                      : `${orchestration.specialists.length} etapa(s) especialista(s) na fila`}
            </small>
          </span>
        </div>
      )}
      <div className="workspace-canvas-hint">
        <MousePointer2 size={12} /> Arraste o cabeçalho para mover · Arraste o
        fundo para navegar · Espaço ou botão do meio também navega · Roda move
        · Ctrl/Cmd + roda aplica zoom · Ctrl+D duplica notas
      </div>
      {canDelete && (
        <button
          className="workspace-canvas-delete"
          type="button"
          onClick={deleteSelected}
        >
          <Trash2 size={14} /> Excluir{" "}
          {deletableSelection.length > 1 ? "selecionados" : nodeMap.get(deletableSelection[0])?.kind === "agent" ? "terminal" : "nota"}
        </button>
      )}
      {quickDeployOpen && (
        <div
          className="canvas-quick-deploy"
          role="dialog"
          aria-modal="true"
          aria-label="Novo terminal"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            if (event.target === event.currentTarget) setQuickDeployOpen(false);
          }}
        >
          <div className="canvas-quick-deploy-panel">
            <header>
              <strong><Terminal size={14} aria-hidden="true" /> Novo Terminal</strong>
              <button
                type="button"
                aria-label="Fechar"
                title="Fechar"
                onClick={() => setQuickDeployOpen(false)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </header>
            <p>Escolha um preset para criar o terminal. Depois ajuste comando, diretório e reinício em Configurar.</p>
            <div className="canvas-quick-deploy-chips">
              {quickDeployChips.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  className="canvas-quick-deploy-chip"
                  title={chip.description}
                  onClick={() => {
                    addTerminalNode(chip.preset);
                    setQuickDeployOpen(false);
                  }}
                >
                  <span className="canvas-quick-deploy-chip-icon" aria-hidden="true">
                    {chip.icon ?? <Terminal size={13} />}
                  </span>
                  <span className="canvas-quick-deploy-chip-label">{chip.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {creationMode && (
        <AgentCreationDialog
          isOpen
          mode={creationMode}
          providers={agentProviders}
          defaultProvider={defaultExecutor}
          codexAuthStatus={codexAuthStatus}
          onClose={() => setCreationMode(null)}
          onRequestCodexAuth={onRequestCodexAuth}
          onCreateAgent={addAgent}
          onCreateSquad={createSquad}
        />
      )}
      {/* Inspector só configura o nó: o terminal vivo permanece montado no
          CanvasNodeCard, então abrir/fechar o painel não perde sessão. */}
      <CanvasNodeInspector
        isOpen={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        node={inspectorNode}
        squad={inspectorSquad}
        squadMembers={inspectorSquadMembers}
        availableAgentsForSquad={canvas.nodes.filter((node) => node.kind === "agent")}
        onUpdateSquadTitle={(squadId, title) => renameSquadById(squadId, title)}
        onSetSquadObjective={(squadId, objective) => setSquadObjectiveById(squadId, objective)}
        onSetSquadCoordinator={(squadId, coordinatorNodeId) =>
          setSquadCoordinatorById(squadId, coordinatorNodeId)
        }
        onAddSquadMember={(squadId, memberId) => addSquadMemberById(squadId, memberId)}
        onRemoveSquadMember={(squadId, memberId) => removeSquadMemberById(squadId, memberId)}
        onToggleSquadCollapsed={(squadId) => toggleSquadCollapsedById(squadId)}
        onCreateAgentForSquad={(squadId) => addNewAgentToSquad(squadId)}
        agentProviders={agentProviders}
        codexAuthStatus={codexAuthStatus}
        onRequestCodexAuth={onRequestCodexAuth}
        onUpdateTitle={(id, title) => renameTerminalNode(id, title)}
        onUpdateRole={(id, role) => updateNode(id, { role: sanitizeAgentRole(role) })}
        onUpdateProvider={(id, provider) => updateNode(id, { provider })}
        onUpdateAccount={(id, account) => updateNode(id, { account })}
        onUpdateContent={(id, content) => updateNode(id, { content: content.slice(0, 24000) })}
        onDeleteNode={(id) => deleteNodes([id])}
        onFocusNode={focusNode}
        onDisconnectLinks={disconnectNodeLinks}
        onSendTask={sendAgentTask}
        onIsolateWorktree={onCreateAgentWorktree}
        terminalPresets={terminalPresets}
        quickDeployChips={quickDeployChips}
        onUpdateTerminalNode={updateTerminalNode}
        progress={inspectorNode ? agentProgress[inspectorNode.id] : undefined}
      />
    </div>
  );
};
