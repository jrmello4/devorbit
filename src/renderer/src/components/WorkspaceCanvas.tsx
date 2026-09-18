import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FileText,
  Globe,
  Grip,
  Link2,
  Maximize2,
  Minus,
  MousePointer2,
  Plus,
  RotateCcw,
  Send,
  StickyNote,
  Terminal,
  Trash2,
  Unlink,
} from "lucide-react";
import type { AgentProvider, AgentProviderId, Project } from "../types";
import type { AgentResult } from "../../../shared/agent-result";
import { createsAgentCycle, sanitizeAgentCycles } from "./workspace-request-helpers";
import { AgentCreationDialog } from "./AgentCreationDialog";
import {
  agentNodeBlockedLabel,
  agentNodeSetupMessage,
  isAgentNodeConfigured,
  requiresCodexAccount,
  type AgentCreationSpec,
  type SquadCreationSpec,
} from "./agent-creation-helpers";
import { agentSendPolicy } from "./agent-send-policy";
import "./WorkspaceCanvas.css";

type NodeKind = "workbench" | "browser" | "note" | "agent";
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
  role?: AgentRole;
  account?: "account1" | "account2";
  provider?: AgentProviderId;
}
interface CanvasConnection {
  id: string;
  from: string;
  to: string;
}
export interface CanvasSquad {
  id: string;
  title: string;
  coordinatorNodeId: string;
  memberNodeIds: string[];
}
interface CanvasState {
  version: 3;
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
type AgentProgressState = "queued" | "running" | "completed" | "blocked";
interface AgentProgress {
  state: AgentProgressState;
  label: string;
}
interface OrchestrationNote {
  id: string;
  title: string;
  content: string;
}
interface OrchestrationAgent {
  id: string;
  title: string;
  role: AgentRole;
  notes: OrchestrationNote[];
}
interface OrchestrationResult {
  agentId: string;
  title: string;
  role: AgentRole;
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

const WORLD_WIDTH = 5200;
const WORLD_HEIGHT = 3400;
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 1.6;
const GRID = 20;
const fixedKinds = new Set<NodeKind>(["workbench", "browser"]);
const nodeMeta: Record<NodeKind, { label: string; icon: React.ReactNode }> = {
  workbench: { label: "Editor e terminal", icon: <Terminal size={13} /> },
  browser: { label: "Navegador do projeto", icon: <Globe size={13} /> },
  note: { label: "Nota", icon: <StickyNote size={13} /> },
  agent: { label: "Agente", icon: <Terminal size={13} /> },
};
const defaults = (): CanvasState => ({
  version: 3,
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
const orchestrationRoleOrder: AgentRole[] = [
  "Implementação",
  "Revisão",
  "Testes",
];
const legacyOrchestrationResultInstruction =
  "Esta etapa faz parte de uma orquestração automática. Ao concluir, imprima uma única linha iniciada por DEVORBIT_RESULT: e seguida de um resumo objetivo. Use DEVORBIT_RESULT: CONCLUIDO: para uma etapa concluída; se não puder continuar, use DEVORBIT_RESULT: BLOQUEADO: e explique o motivo. Não aguarde outro clique para encaminhar a próxima etapa.";
export const orchestrationResultInstruction = legacyOrchestrationResultInstruction &&
  'Emita primeiro uma única linha com JSON compacto: DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"resumo objetivo"}. Use outcome completed, blocked ou failed e summary objetivo, sem quebras de linha e com no máximo 1000 caracteres. Emita imediatamente depois o espelho legado DEVORBIT_RESULT: CONCLUIDO: <resumo>, DEVORBIT_RESULT: BLOQUEADO: <motivo> ou DEVORBIT_RESULT: FALHA: <motivo>. O JSON vem primeiro e não aguarde outro clique para encaminhar a próxima etapa.';
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
const connectionPath = (from: CanvasNode, toX: number, toY: number) => {
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
): CanvasNode {
  const width = Number.isFinite(value.width)
    ? clamp(value.width as number, 220, 1100)
    : fallback.width;
  const height = Number.isFinite(value.height)
    ? clamp(value.height as number, 150, 850)
    : fallback.height;
  return {
    id: typeof value.id === "string" ? value.id : fallback.id,
    kind:
      value.kind === "workbench" ||
      value.kind === "browser" ||
      value.kind === "note" ||
      value.kind === "agent"
        ? value.kind
        : fallback.kind,
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
      value.role === "Coordenador" ||
      value.role === "Implementação" ||
      value.role === "Revisão" ||
      value.role === "Testes"
        ? value.role
        : fallback.role,
    account:
      value.account === "account2"
        ? "account2"
        : value.account === "account1"
          ? "account1"
          : fallback.account,
    provider: isAgentProviderId(value.provider)
      ? value.provider
      : fallback.provider,
  };
}
function sanitizeSquads(value: unknown, nodes: readonly CanvasNode[]): CanvasSquad[] {
  if (!Array.isArray(value)) return [];
  const nodeIds = new Set(nodes.map((node) => node.id));
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
      typeof raw.coordinatorNodeId !== "string" ||
      !agentNodeIds.has(raw.coordinatorNodeId) ||
      !memberNodeIds.includes(raw.coordinatorNodeId)
    ) continue;
    result.push({
      id: raw.id.slice(0, 80),
      title: raw.title.trim().slice(0, 80),
      coordinatorNodeId: raw.coordinatorNodeId,
      memberNodeIds: memberNodeIds.slice(0, 32),
    });
  }
  return result.slice(0, 100);
}
function read(id: string): CanvasState {
  const fallback = defaults();
  try {
    const raw = JSON.parse(
      window.localStorage.getItem(key(id)) || "",
    ) as { version?: number; nodes?: unknown; connections?: unknown; viewport?: CanvasState["viewport"] } & LegacyCanvas;
    if ((raw.version === 2 || raw.version === 3) && Array.isArray(raw.nodes)) {
      const nodes = raw.nodes.map((node, index) =>
        sanitizeNode(
          node,
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
        ),
      );
      const ids = new Set(nodes.map((node) => node.id));
      const agentIds = new Set(nodes.filter((node) => node.kind === "agent").map((node) => node.id));
      const validConnections = Array.isArray(raw.connections)
        ? raw.connections.filter(
            (connection): connection is CanvasConnection =>
              Boolean(
                connection &&
                typeof connection.id === "string" &&
                typeof connection.from === "string" &&
                typeof connection.to === "string" &&
                connection.from !== connection.to &&
                ids.has(connection.from) &&
                ids.has(connection.to),
              ),
          )
        : [];
      return {
        version: 3,
        nodes,
        // Saneia ciclos agente-agente persistidos: nenhum ciclo visual pode
        // ficar sem aresta de piping correspondente no main.
        connections: sanitizeAgentCycles(validConnections, agentIds),
        // Canvas v2 nunca teve squads explícitos. Não inferimos participação
        // por conexões: ela só passa a existir após confirmação do usuário.
        squads: raw.version === 3 ? sanitizeSquads(raw.squads, nodes) : [],
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
          ),
        ),
      };
    }
  } catch {
    /* clean canvas */
  }
  return fallback;
}

function connectedNotes(state: CanvasState, nodeIdValue: string): OrchestrationNote[] {
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

function orchestrationAgentRole(node: CanvasNode): AgentRole {
  return node.role === "Revisão" || node.role === "Testes"
    ? node.role
    : "Implementação";
}

function discoverSpecialists(
  state: CanvasState,
  coordinator: CanvasNode,
  notes: OrchestrationNote[],
): OrchestrationAgent[] {
  const noteIds = new Set(notes.map((note) => note.id));
  const directlyConnected = new Set(
    state.connections
      .filter(
        (connection) =>
          connection.from === coordinator.id || connection.to === coordinator.id,
      )
      .map((connection) =>
        connection.from === coordinator.id ? connection.to : connection.from,
      ),
  );
  const noteConnectedAgentIds = new Set(
    state.connections.flatMap((connection) => {
      if (!noteIds.has(connection.from) && !noteIds.has(connection.to)) return [];
      return [connection.from, connection.to];
    }),
  );
  return state.nodes
    .filter(
      (node) =>
        node.kind === "agent" &&
        node.id !== coordinator.id &&
        node.role !== "Coordenador" &&
        (directlyConnected.has(node.id) || noteConnectedAgentIds.has(node.id)),
    )
    .map((node) => ({
      id: node.id,
      title: node.title,
      role: orchestrationAgentRole(node),
      notes: connectedNotes(state, node.id),
    }))
    .sort((left, right) => {
      const leftOrder = orchestrationRoleOrder.indexOf(left.role);
      const rightOrder = orchestrationRoleOrder.indexOf(right.role);
      return leftOrder - rightOrder;
    });
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
  pendingNodeRequest?: { kind: 'note' | 'agent' | 'squad'; nonce: number } | null;
  onPendingNodeConsumed?: (nonce: number) => void;
  onConnectionsChange?: (
    connections: Array<{ id: string; from: string; to: string }>,
    nodes: Array<{ id: string; kind: string }>,
  ) => void;
}> = ({
  project,
  workbench,
  browser,
  agentProviders = [],
  renderAgent,
  onSendAgentTask,
  onCreateAgentWorktree,
  codexAuthStatus = null,
  onRequestCodexAuth,
  onSelectionChange,
  pendingNodeRequest = null,
  onPendingNodeConsumed,
  onConnectionsChange,
}) => {
  const [canvas, setCanvas] = useState<CanvasState>(() => read(project.id));
  const [selected, setSelected] = useState<string[]>([]);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [gesture, setGesture] = useState<CanvasGesture | null>(null);
  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft | null>(null);
  const [creationMode, setCreationMode] = useState<"agent" | "squad" | null>(null);
  const [orchestration, setOrchestration] = useState<OrchestrationRun | null>(
    null,
  );
  const [agentProgress, setAgentProgress] = useState<
    Record<string, AgentProgress>
  >({});
  const manualTasksRef = useRef<Set<string>>(new Set());
  const canvasRef = useRef(canvas);
  const orchestrationRef = useRef<OrchestrationRun | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const persistTimerRef = useRef<number | null>(null);
  const gestureCaptureRef = useRef<HTMLElement | null>(null);
  const connectionDraftRef = useRef<ConnectionDraft | null>(null);
  const minimapPointerRef = useRef<number | null>(null);
  const consumedPendingRef = useRef<Set<number>>(new Set());
  const spaceHeldRef = useRef(false);
  const persist = useCallback(
    (value: CanvasState) => {
      try {
        window.localStorage.setItem(key(project.id), JSON.stringify(value));
      } catch {
        /* optional */
      }
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
  useEffect(() => {
    const next = read(project.id);
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
  }, [project.id]);
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
      const agentIds = new Set(
        canvasRef.current.nodes.filter((node) => node.kind === "agent").map((node) => node.id),
      );
      // Recusa determinística de ciclo agente-agente: o main rejeitaria o
      // setPipe e o cabo ficaria desenhado sem piping. Cancela o gesto.
      if (createsAgentCycle(canvasRef.current.connections, agentIds, from, to)) {
        setConnectFrom(null);
        connectionDraftRef.current = null;
        setConnectionDraft(null);
        return;
      }
      update(
        (current) =>
          current.connections.some(
            (connection) =>
              (connection.from === from && connection.to === to) ||
              (connection.from === to && connection.to === from),
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
                  },
                ],
              },
        true,
      );
      connectionDraftRef.current = null;
      setConnectionDraft(null);
      setConnectFrom(null);
      setSelected([to]);
    },
    [update],
  );
  const selectNode = useCallback(
    (id: string, additive = false) => {
      if (connectFrom) {
        connectNodes(connectFrom, id);
        return;
      }
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
    update(
      (current) => ({
        ...current,
        nodes: [
          ...current.nodes,
          {
            id,
            kind: "agent",
            title: spec.role === "Implementação" ? "Agente de implementação" : "Agente: " + spec.role,
            role: spec.role,
            ...(spec.account ? { account: spec.account } : {}),
            ...(spec.provider ? { provider: spec.provider } : {}),
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
  }, [update]);
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; kind?: string }>).detail
      if (detail?.projectId && detail.projectId !== project.id) return
      if (detail?.kind === 'note') addNote()
      else if (detail?.kind === 'agent') openAgentCreation()
      else if (detail?.kind === 'squad') openSquadCreation()
    }
    window.addEventListener('devorbit:create-canvas-node', handler as EventListener)
    return () => window.removeEventListener('devorbit:create-canvas-node', handler as EventListener)
  }, [addNote, openAgentCreation, openSquadCreation, project.id]);
  useEffect(() => {
    if (!pendingNodeRequest) return
    if (consumedPendingRef.current.has(pendingNodeRequest.nonce)) return
    consumedPendingRef.current.add(pendingNodeRequest.nonce)
    if (pendingNodeRequest.kind === 'note') addNote()
    else if (pendingNodeRequest.kind === 'agent') openAgentCreation()
    else openSquadCreation()
    onPendingNodeConsumed?.(pendingNodeRequest.nonce)
  }, [addNote, onPendingNodeConsumed, openAgentCreation, openSquadCreation, pendingNodeRequest]);
  const createSquad = useCallback((spec: SquadCreationSpec) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const view = canvasRef.current.viewport;
    const originX = snap(((rect?.width || 1100) / 2 - view.x) / view.zoom - 380);
    const originY = snap(((rect?.height || 700) / 2 - view.y) / view.zoom - 260);
    const noteId = nodeId();
    const squadId = "squad-" + nodeId().slice(5);
    const agents = spec.participants.map((participant, index) => ({
      id: nodeId(), kind: "agent" as const, title: "Agente: " + participant.role, role: participant.role as AgentRole,
      ...(participant.account ? { account: participant.account } : {}), ...(participant.provider ? { provider: participant.provider } : {}),
      x: originX + 390 + (index % 2) * 430, y: originY + Math.floor(index / 2) * 300,
      width: 500, height: 340, z: index + 2,
    }));
    const coordinator = agents.find((agent) => agent.role === "Coordenador") || agents[0];
    update((current) => ({
      ...current,
      nodes: [...current.nodes, { id: noteId, kind: "note", title: "Plano da tarefa", content: "# Objetivo\n\nDescreva a tarefa, critérios de aceite e limites aqui.\n\n# Entregáveis\n\n- Implementação\n- Revisão\n- Testes", x: originX, y: originY + 130, width: 350, height: 290, z: 1 }, ...agents.map((agent) => ({ ...agent, z: Math.max(0, ...current.nodes.map((node) => node.z)) + agent.z }))],
      connections: [...current.connections, ...agents.map((agent) => ({ id: "link-" + noteId + "-" + agent.id, from: noteId, to: agent.id }))],
      squads: [...current.squads, { id: squadId, title: spec.title.trim(), coordinatorNodeId: coordinator.id, memberNodeIds: agents.map((agent) => agent.id) }],
    }), true);
    setSelected([noteId, ...agents.map((agent) => agent.id)]);
    setCreationMode(null);
  }, [update]);
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
          .map((squad) => ({
            ...squad,
            memberNodeIds: squad.memberNodeIds.filter((nodeIdValue) => !removable.has(nodeIdValue)),
          }))
          .filter((squad) => !removable.has(squad.coordinatorNodeId) && squad.memberNodeIds.length > 0),
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
  const zoom = useCallback((amount: number) => zoomAt(amount), [zoomAt]);
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
  const fitCanvas = useCallback(() => {
    const host = viewportRef.current?.getBoundingClientRect();
    const nodes = canvasRef.current.nodes.filter(
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
        update(
          (current) => ({ ...current, viewport: { x: 40, y: 36, zoom: 1 } }),
          true,
        );
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        (event.key === "+" || event.key === "=")
      ) {
        event.preventDefault();
        zoom(0.1);
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "-") {
        event.preventDefault();
        zoom(-0.1);
      }
      if (event.key === "Escape") {
        setSelected([]);
        setConnectFrom(null);
        connectionDraftRef.current = null;
        setConnectionDraft(null);
        setGesture(null);
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
  }, [deleteSelected, duplicateSelected, update, zoom]);
  const nodeMap = useMemo(
    () => new Map(canvas.nodes.map((node) => [node.id, node])),
    [canvas.nodes],
  );
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
      noteCount: connectedNotes(canvas, node.id).length,
      progressState: agentProgress[node.id]?.state ?? null,
    });
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
    [markOrchestrationBlocked, project.id],
  );
  const startCoordinatorOrchestration = useCallback(
    (coordinator: CanvasNode) => {
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
      const notes = connectedNotes(current, currentCoordinator.id);
      if (!notes.length) return;
      const specialists = discoverSpecialists(
        current,
        currentCoordinator,
        notes,
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
      const prompt = [
        `Você atua como Coordenador neste projeto (${currentCoordinator.title}).`,
        "Esta é a primeira etapa automática de uma execução em sequência.",
        "Analise a tarefa conectada, transforme-a em um plano executável e defina critérios claros para implementação, revisão e testes.",
        `As próximas etapas automáticas são: ${specialistRoles}.`,
        "Não aguarde outro clique para encaminhar o trabalho: o aplicativo fará isso quando você devolver o plano.",
        "## Tarefa e contexto conectado",
        formatOrchestrationNotes(notes),
        orchestrationResultInstruction,
      ].join("\n");
      dispatchOrchestrationTask(run, currentCoordinator, prompt, {
        state: "running",
        label: "Planejando tarefa",
      });
    },
    [
      commitOrchestration,
      dispatchOrchestrationTask,
      markOrchestrationBlocked,
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
      if (agent.role === "Coordenador") {
        startCoordinatorOrchestration(agent);
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
      const linkedNotes = connectedNotes(current, currentAgent.id);
      if (!linkedNotes.length) return;
      manualTasksRef.current.add(currentAgent.id);
      const prompt = [
        `Você atua como ${currentAgent.role || "Implementação"} neste projeto.`,
        "Execute a tarefa usando o contexto conectado abaixo.",
        formatOrchestrationNotes(linkedNotes),
        orchestrationResultInstruction,
      ].join("\n");
      const taskId = dispatchAgentTask(currentAgent, prompt, {
        state: "running",
        label: "Aguardando resultado",
      });
      if (!taskId) manualTasksRef.current.delete(currentAgent.id);
    },
    [
      agentProgress,
      dispatchAgentTask,
      onSendAgentTask,
      startCoordinatorOrchestration,
    ],
  );
  const reportAgentResult = useCallback(
    (agentId: string, result: AgentResult, taskId?: string) => {
      const normalizedResult = result.summary.trim().slice(0, 1000);
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
          const finalPrompt = [
            `Você atua como Coordenador neste projeto (${run.coordinatorTitle}).`,
            "Não há especialistas conectados. Execute agora todo o plano que você preparou e entregue o resultado final.",
            "Faça as alterações, validações e correções necessárias sem aguardar outro clique.",
            "## Tarefa e contexto conectado",
            formatOrchestrationNotes(run.notes),
            "## Plano preparado",
            normalizedResult,
            orchestrationResultInstruction,
          ].join("\n");
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
        const specialistPrompt = [
          `Você atua como ${firstSpecialist.role} neste projeto (${firstSpecialist.title}).`,
          "Esta é a próxima etapa automática; execute sua parte sem aguardar novos cliques.",
          "Use o plano do coordenador e o contexto da tarefa para produzir uma entrega concreta.",
          "## Tarefa e contexto conectado",
          formatOrchestrationNotes(specialistNotes),
          "## Plano do coordenador",
          nextRun.plan,
          "## Resultados anteriores",
          formatOrchestrationResults(nextRun.results),
          orchestrationResultInstruction,
        ].join("\n");
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
          const specialistPrompt = [
            `Você atua como ${nextSpecialist.role} neste projeto (${nextSpecialist.title}).`,
            "Esta é a próxima etapa automática; execute sua parte sem aguardar novos cliques.",
            "Considere o plano do coordenador e todos os resultados anteriores antes de trabalhar.",
            "## Tarefa e contexto conectado",
            formatOrchestrationNotes(specialistNotes),
            "## Plano do coordenador",
            nextRun.plan,
            "## Resultados anteriores",
            formatOrchestrationResults(nextRun.results),
            orchestrationResultInstruction,
          ].join("\n");
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
        const finalPrompt = [
          `Você é o Coordenador na etapa final deste projeto (${run.coordinatorTitle}).`,
          "Esta etapa automática encerra a execução. Consolide o plano e os resultados dos especialistas, valide o que foi entregue e registre pendências ou bloqueios restantes.",
          "## Tarefa e contexto conectado",
          formatOrchestrationNotes(run.notes),
          "## Plano original",
          run.plan,
          "## Resultados dos especialistas",
          formatOrchestrationResults(nextResults),
          orchestrationResultInstruction,
        ].join("\n");
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
            ".workspace-canvas-card, .workspace-canvas-toolbar, .workspace-canvas-minimap",
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
          setConnectFrom(null);
          connectionDraftRef.current = null;
          setConnectionDraft(null);
        }
        startPan(event);
      }}
    >
      <div className="workspace-canvas-grid" />
      <div
        className="workspace-canvas-toolbar"
        role="toolbar"
        aria-label="Ferramentas do canvas"
      >
        <button type="button" onClick={addNote} title="Criar nota">
          <Plus size={14} /> Nota
        </button>
        <button type="button" onClick={openAgentCreation} title="Criar agente">
          <Terminal size={14} /> Agente
        </button>
        <button type="button" onClick={openSquadCreation} title="Criar squad de agentes conectado a uma tarefa">
          <Terminal size={14} /> Squad
        </button>
        <button
          type="button"
          onClick={() => {
            const source = selected[selected.length - 1];
            if (source) setConnectFrom(source);
          }}
          disabled={!selected.length || Boolean(connectFrom)}
          title="Conectar o nó selecionado a outro"
        >
          <Link2 size={14} /> {connectFrom ? "Escolha o destino" : "Conectar"}
        </button>
        <button
          type="button"
          onClick={duplicateSelected}
          disabled={nodeMap.get(selected[selected.length - 1])?.kind !== "note"}
          title="Duplicar nota selecionada"
        >
          <FileText size={14} /> Duplicar
        </button>
        <button
          type="button"
          onClick={removeLinks}
          disabled={!selected.length}
          title="Remover conexões do item selecionado"
        >
          <Unlink size={14} />
        </button>
        <span className="workspace-canvas-toolbar-separator" />
        <button
          type="button"
          onClick={() => zoom(-0.1)}
          aria-label="Diminuir zoom"
        >
          <Minus size={15} />
        </button>
        <output aria-label="Zoom do canvas">
          {Math.round(canvas.viewport.zoom * 100)}%
        </output>
        <button
          type="button"
          onClick={() => zoom(0.1)}
          aria-label="Aumentar zoom"
        >
          <Plus size={15} />
        </button>
        <button
          type="button"
          onClick={fitCanvas}
          aria-label="Encaixar conteúdo no canvas"
          title="Encaixar conteúdo no canvas"
        >
          <Maximize2 size={14} />
        </button>
        <button
          type="button"
          onClick={resetCanvas}
          title="Restaurar layout inicial"
        >
          <RotateCcw size={14} />
        </button>
      </div>
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
        <svg
          className="workspace-canvas-connections"
          width={WORLD_WIDTH}
          height={WORLD_HEIGHT}
          aria-hidden="true"
        >
          {canvas.connections.map((connection) => {
            const from = nodeMap.get(connection.from);
            const to = nodeMap.get(connection.to);
            if (!from || !to) return null;
            return (
              <path
                key={connection.id}
                d={connectionPath(from, to.x, to.y + to.height / 2)}
              />
            );
          })}
          {connectionDraft && nodeMap.get(connectionDraft.from) && (
            <path
              className="workspace-canvas-connection-preview"
              d={connectionPath(
                nodeMap.get(connectionDraft.from)!,
                connectionDraft.x,
                connectionDraft.y,
              )}
            />
          )}
        </svg>
        {canvas.nodes
          .filter((node) => node.kind !== "browser" || browser)
          .map((node) => (
            <section
              key={node.id}
              className={
                "workspace-canvas-card canvas-" +
                node.kind +
                (selected.includes(node.id) ? " is-selected" : "") +
                (connectFrom === node.id ? " is-connecting" : "") +
                (agentProgress[node.id]
                  ? " has-agent-progress progress-" + agentProgress[node.id].state
                  : "")
              }
              data-canvas-card={node.kind}
                data-canvas-node-id={node.id}
                style={{
                  left: node.x,
                top: node.y,
                width: node.width,
                height: node.height,
                zIndex: node.z,
              }}
              onPointerDown={(event) => {
                if (event.button === 1 || spaceHeldRef.current) {
                  startPan(event);
                  return;
                }
                event.stopPropagation();
                selectNode(node.id, event.ctrlKey || event.metaKey);
              }}
            >
              <button
                type="button"
                className={
                  "canvas-port canvas-port-source" +
                  (connectFrom === node.id ? " is-active" : "")
                }
                data-canvas-port="source"
                data-canvas-node-id={node.id}
                aria-label={"Iniciar conexão a partir de " + node.title}
                aria-pressed={connectFrom === node.id}
                onPointerDown={(event) => startConnection(event, node)}
                onClick={() => chooseConnectionSource(node.id)}
              >
                <span aria-hidden="true" />
              </button>
              <button
                type="button"
                className={
                  "canvas-port canvas-port-target" +
                  (connectFrom && connectFrom !== node.id ? " is-available" : "")
                }
                data-canvas-port="target"
                data-canvas-node-id={node.id}
                aria-label={"Conectar a " + node.title}
                disabled={!connectFrom || connectFrom === node.id}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={() => connectNodes(connectFrom, node.id)}
              >
                <span aria-hidden="true" />
              </button>
              <header
                onPointerDown={(event) => {
                  const target = event.target;
                  if (
                    closestElement(
                      target,
                      "button, input, select, textarea, a, [contenteditable=true]",
                    )
                  )
                    return;
                  startNodeDrag(event, node);
                }}
              >
                <strong>
                  {nodeMeta[node.kind].icon}
                  {node.title}
                </strong>
                {node.kind === "agent" && agentProgress[node.id] && (
                  <span
                    className={
                      "canvas-agent-progress progress-" +
                      agentProgress[node.id].state
                    }
                    data-agent-progress={agentProgress[node.id].state}
                    role="status"
                    aria-label={
                      "Status da tarefa: " + agentProgress[node.id].label
                    }
                  >
                    <i aria-hidden="true" />
                    {agentProgress[node.id].label}
                  </span>
                )}
                {node.kind === "agent" && (
                  <button type="button" className="canvas-send-task" title="Criar worktree isolado" aria-label={"Isolar " + node.title} onPointerDown={(event) => event.stopPropagation()} onClick={() => onCreateAgentWorktree?.(node)}>WT</button>
                )}
                {node.kind === "agent" && (
                  <label className="canvas-agent-role">
                    <span className="sr-only">Papel e conta do agente</span>
                    <select
                      value={node.role || "Implementação"}
                      onPointerDown={(event) => event.stopPropagation()}
                      onChange={(event) =>
                        update(
                          (current) => ({
                            ...current,
                            nodes: current.nodes.map((item) =>
                              item.id === node.id
                                ? { ...item, role: event.target.value as AgentRole, title: "Agente: " + event.target.value }
                                : item,
                            ),
                          }),
                          true,
                        )
                      }
                    >
                      <option>Coordenador</option><option>Implementação</option><option>Revisão</option><option>Testes</option>
                    </select>
                    <select
                      value={node.provider || ""}
                      aria-label="Provedor do agente"
                      onPointerDown={(event) => event.stopPropagation()}
                      onChange={(event) =>
                        update(
                          (current) => ({
                            ...current,
                            nodes: current.nodes.map((item) => {
                              if (item.id !== node.id) return item;
                              const nextProvider = event.target.value
                                ? (event.target.value as AgentProviderId)
                                : undefined;
                              return {
                                ...item,
                                provider: nextProvider,
                                account:
                                  nextProvider && requiresCodexAccount(nextProvider)
                                    ? item.account
                                    : undefined,
                              };
                            }),
                          }),
                          true,
                        )
                      }
                    >
                      <option value="">Configurar provider</option>
                      {agentProviders.map((provider) => (
                        <option key={provider.id} value={provider.id} disabled={provider.state !== "ready"}>
                          {provider.label}{provider.state !== "ready" ? " (não encontrado)" : ""}
                        </option>
                      ))}
                    </select>
                    <select
                      value={requiresCodexAccount(node.provider ?? null) ? node.account || "" : ""}
                      aria-label="Conta Codex"
                      title={
                        requiresCodexAccount(node.provider ?? null)
                          ? "Conta Codex deste agente"
                          : "A conta só se aplica ao provider Codex"
                      }
                      disabled={!requiresCodexAccount(node.provider ?? null)}
                      onPointerDown={(event) => event.stopPropagation()}
                      onChange={(event) =>
                        update(
                          (current) => ({
                            ...current,
                            nodes: current.nodes.map((item) =>
                              item.id === node.id
                                ? {
                                    ...item,
                                    account: event.target.value
                                      ? (event.target.value as "account1" | "account2")
                                      : undefined,
                                  }
                                : item,
                            ),
                          }),
                          true,
                        )
                      }
                    ><option value="">—</option><option value="account1">C1</option><option value="account2">C2</option></select>
                  </label>
                )}
                {node.kind === "agent" && (
                  <button
                    type="button"
                    className="canvas-send-task"
                    data-agent-send
                    aria-label={"Enviar tarefa para " + node.title}
                    title={
                      sendPolicyFor(node).disabled
                        ? sendPolicyFor(node).reason
                        : node.role === "Coordenador"
                          ? "Iniciar orquestração com as notas conectadas"
                          : "Enviar as notas conectadas ao agente"
                    }
                    disabled={sendPolicyFor(node).disabled}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => sendAgentTask(node)}
                  ><Send size={13} /></button>
                )}
                {!fixedKinds.has(node.kind) && (
                  <button
                    type="button"
                    className="canvas-delete-node"
                    aria-label={"Excluir " + node.title}
                    title={node.kind === "agent" ? "Excluir terminal do agente" : "Excluir nota"}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => deleteNodes([node.id])}
                  ><Trash2 size={13} /></button>
                )}
                <button
                  data-canvas-drag-handle
                  type="button"
                  className="canvas-drag"
                  aria-label={"Mover " + node.title}
                  onPointerDown={(event) => {
                    startNodeDrag(event, node);
                  }}
                >
                  <Grip size={14} />
                </button>
              </header>
              <div className="workspace-canvas-card-content">
                {node.kind === "workbench" ? (
                  workbench
                ) : node.kind === "browser" ? (
                  browser
                ) : node.kind === "agent" ? (
                  isAgentNodeConfigured(node, agentProviders) ? (
                    <>{renderAgent?.(node, (result, taskId) => reportAgentResult(node.id, result, taskId), (taskId, message) => reportAgentTaskFailure(node.id, taskId, message)) || <div className="canvas-agent-empty">Terminal do agente indisponível.</div>}{node.content && <div className="canvas-agent-result" title={node.content}>{node.content}</div>}</>
                  ) : (
                    <div className="canvas-agent-empty" role="status">
                      <p>{agentNodeSetupMessage(node, agentProviders)}</p>
                    </div>
                  )
                ) : (
                  <textarea
                    data-canvas-note-editor
                    value={node.content || ""}
                    onChange={(event) =>
                      update((current) => ({
                        ...current,
                        nodes: current.nodes.map((item) =>
                          item.id === node.id
                            ? {
                                ...item,
                                content: event.target.value.slice(0, 24000),
                              }
                            : item,
                        ),
                      }))
                    }
                    placeholder="Tarefa, decisões, contexto e próximos passos…"
                    aria-label={node.title}
                  />
                )}
              </div>
              <button
                data-canvas-resize-handle
                className="workspace-canvas-resize"
                type="button"
                aria-label={"Redimensionar " + node.title}
                onPointerDown={(event) => {
                  startResize(event, node);
                }}
              >
                <Maximize2 size={12} />
              </button>
            </section>
          ))}
      </div>
      <div className="workspace-canvas-minimap" aria-label="Minimapa do canvas">
        <svg
          viewBox={`0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}`}
          onPointerDown={startMinimapNavigation}
          onPointerMove={continueMinimapNavigation}
          onPointerUp={finishMinimapNavigation}
          onPointerCancel={finishMinimapNavigation}
          role="img"
          tabIndex={0}
          aria-label="Navegar pelo minimapa"
        >
          {canvas.nodes.map((node) => <rect key={node.id} x={node.x} y={node.y} width={node.width} height={node.height} className={'minimap-node ' + node.kind} />)}
          {(() => { const host = viewportRef.current?.getBoundingClientRect(); const width = (host?.width || 900) / canvas.viewport.zoom; const height = (host?.height || 650) / canvas.viewport.zoom; return <rect className="minimap-viewport" x={-canvas.viewport.x / canvas.viewport.zoom} y={-canvas.viewport.y / canvas.viewport.zoom} width={width} height={height} /> })()}
        </svg>
      </div>
      {connectFrom && (
        <div className="workspace-canvas-connection-status" role="status" aria-live="polite">
          <Link2 size={13} />
          <span>Conexão iniciada. Arraste até uma porta ou escolha o destino. Esc cancela.</span>
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
      {creationMode && (
        <AgentCreationDialog
          isOpen
          mode={creationMode}
          providers={agentProviders}
          codexAuthStatus={codexAuthStatus}
          onClose={() => setCreationMode(null)}
          onRequestCodexAuth={onRequestCodexAuth}
          onCreateAgent={addAgent}
          onCreateSquad={createSquad}
        />
      )}
    </div>
  );
};
