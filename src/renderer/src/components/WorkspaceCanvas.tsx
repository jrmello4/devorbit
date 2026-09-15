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
import type { Project } from "../types";
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
}
interface CanvasConnection {
  id: string;
  from: string;
  to: string;
}
interface CanvasState {
  version: 2;
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  viewport: { x: number; y: number; zoom: number };
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
}

const WORLD_WIDTH = 5200;
const WORLD_HEIGHT = 3400;
const MIN_ZOOM = 0.45;
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
  version: 2,
  viewport: { x: 40, y: 36, zoom: 1 },
  connections: [],
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
function sanitizeNode(
  value: Partial<CanvasNode>,
  fallback: CanvasNode,
): CanvasNode {
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
      ? clamp(value.x as number, -WORLD_WIDTH, WORLD_WIDTH)
      : fallback.x,
    y: Number.isFinite(value.y)
      ? clamp(value.y as number, -WORLD_HEIGHT, WORLD_HEIGHT)
      : fallback.y,
    width: Number.isFinite(value.width)
      ? clamp(value.width as number, 220, 1100)
      : fallback.width,
    height: Number.isFinite(value.height)
      ? clamp(value.height as number, 150, 850)
      : fallback.height,
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
  };
}
function read(id: string): CanvasState {
  const fallback = defaults();
  try {
    const raw = JSON.parse(
      window.localStorage.getItem(key(id)) || "",
    ) as Partial<CanvasState> & LegacyCanvas;
    if (raw.version === 2 && Array.isArray(raw.nodes)) {
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
      return {
        version: 2,
        nodes,
        connections: Array.isArray(raw.connections)
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
          : [],
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

export const WorkspaceCanvas: React.FC<{
  project: Project;
  workbench: React.ReactNode;
  browser?: React.ReactNode;
  agentAccount?: "account1" | "account2";
  renderAgent?: (node: CanvasNode, onResult: (result: string) => void) => React.ReactNode;
  onSendAgentTask?: (node: CanvasNode, prompt: string) => void;
  onCreateAgentWorktree?: (node: CanvasNode) => void;
}> = ({
  project,
  workbench,
  browser,
  agentAccount = "account1",
  renderAgent,
  onSendAgentTask,
  onCreateAgentWorktree,
}) => {
  const [canvas, setCanvas] = useState<CanvasState>(() => read(project.id));
  const [selected, setSelected] = useState<string[]>([]);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [gesture, setGesture] = useState<{
    type: "drag" | "resize" | "pan";
    sx: number;
    sy: number;
    nodes?: CanvasNode[];
    viewport?: CanvasState["viewport"];
    id?: string;
  } | null>(null);
  const canvasRef = useRef(canvas);
  const viewportRef = useRef<HTMLDivElement>(null);
  const persistTimerRef = useRef<number | null>(null);
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
  }, [project.id]);
  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);
  const selectNode = useCallback(
    (id: string, additive = false) => {
      if (connectFrom && connectFrom !== id) {
        update(
          (current) =>
            current.connections.some(
              (connection) =>
                (connection.from === connectFrom && connection.to === id) ||
                (connection.from === id && connection.to === connectFrom),
            )
              ? current
              : {
                  ...current,
                  connections: [
                    ...current.connections,
                    {
                      id: "link-" + Date.now().toString(36),
                      from: connectFrom,
                      to: id,
                    },
                  ],
                },
          true,
        );
        setConnectFrom(null);
        setSelected([id]);
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
    [connectFrom, update],
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
  const addAgent = useCallback(() => {
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
            title: "Agente de implementação",
            role: "Implementação",
            account: agentAccount,
            x,
            y,
            width: 440,
            height: 320,
            z: Math.max(0, ...current.nodes.map((node) => node.z)) + 1,
          },
        ],
      }),
      true,
    );
    setSelected([id]);
  }, [agentAccount, update]);
  const createSquad = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const view = canvasRef.current.viewport;
    const originX = snap(((rect?.width || 1100) / 2 - view.x) / view.zoom - 380);
    const originY = snap(((rect?.height || 700) / 2 - view.y) / view.zoom - 260);
    const noteId = nodeId();
    const roles: AgentRole[] = ["Coordenador", "Implementação", "Revisão", "Testes"];
    const agents = roles.map((role, index) => ({
      id: nodeId(), kind: "agent" as const, title: "Agente: " + role, role, account: agentAccount,
      x: originX + 390 + (index % 2) * 430, y: originY + Math.floor(index / 2) * 300,
      width: 400, height: 270, z: index + 2,
    }));
    update((current) => ({
      ...current,
      nodes: [...current.nodes, { id: noteId, kind: "note", title: "Plano da tarefa", content: "# Objetivo\n\nDescreva a tarefa, critérios de aceite e limites aqui.\n\n# Entregáveis\n\n- Implementação\n- Revisão\n- Testes", x: originX, y: originY + 130, width: 350, height: 290, z: 1 }, ...agents.map((agent) => ({ ...agent, z: Math.max(0, ...current.nodes.map((node) => node.z)) + agent.z }))],
      connections: [...current.connections, ...agents.map((agent) => ({ id: "link-" + noteId + "-" + agent.id, from: noteId, to: agent.id }))],
    }), true);
    setSelected([noteId, ...agents.map((agent) => agent.id)]);
  }, [agentAccount, update]);
  const deleteSelected = useCallback(() => {
    const removable = new Set(
      selected.filter((id) =>
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
      }),
      true,
    );
    setSelected([]);
  }, [selected, update]);
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
  }, [update]);
  const zoom = useCallback(
    (amount: number) =>
      update(
        (current) => ({
          ...current,
          viewport: {
            ...current.viewport,
            zoom: clamp(current.viewport.zoom + amount, MIN_ZOOM, MAX_ZOOM),
          },
        }),
        true,
      ),
    [update],
  );
  useEffect(() => {
    if (!gesture) return;
    const move = (event: PointerEvent) => {
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
        const worldX = dx / canvasRef.current.viewport.zoom;
        const worldY = dy / canvasRef.current.viewport.zoom;
        const moved = new Map(
          gesture.nodes.map((node) => [
            node.id,
            { x: snap(node.x + worldX), y: snap(node.y + worldY) },
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
                    clamp(initial.width + dx / current.viewport.zoom, 220, 1100),
                  ),
                  height: snap(
                    clamp(initial.height + dy / current.viewport.zoom, 150, 850),
                  ),
                },
          ),
        }));
      }
    };
    const up = () => {
      flush();
      setGesture(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [flush, gesture, update]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true]")) return;
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
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteSelected, duplicateSelected, update, zoom]);
  const nodeMap = useMemo(
    () => new Map(canvas.nodes.map((node) => [node.id, node])),
    [canvas.nodes],
  );
  const canDelete = selected.some((id) => nodeMap.get(id)?.kind === "note");
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
  const sendAgentTask = (agent: CanvasNode) => {
    const linkedNotes = canvas.connections
      .filter((link) => link.from === agent.id || link.to === agent.id)
      .map((link) => nodeMap.get(link.from === agent.id ? link.to : link.from))
      .filter((node): node is CanvasNode => Boolean(node?.kind === "note" && node.content?.trim()));
    if (!linkedNotes.length || !onSendAgentTask) return;
    const prompt = [
      `Você atua como ${agent.role || "Implementação"} neste projeto.`,
      "Execute a tarefa usando o contexto conectado abaixo.",
      ...linkedNotes.map((note) => `\n## ${note.title}\n${note.content}`),
      "\nAo terminar, imprima uma única linha no formato: DEVORBIT_RESULT: resumo objetivo do que foi feito, validado ou bloqueado.",
    ].join("\n");
    onSendAgentTask(agent, prompt);
    update((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === agent.id ? { ...node, content: "Tarefa enviada agora" } : node) }), true);
  };
  const reportAgentResult = (agentId: string, result: string) => {
    update((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === agentId ? { ...node, content: result } : node) }), true);
  };
  const moveFromMinimap = (event: React.PointerEvent<SVGSVGElement>) => {
    const map = event.currentTarget.getBoundingClientRect();
    const host = viewportRef.current?.getBoundingClientRect();
    if (!host) return;
    const worldX = ((event.clientX - map.left) / map.width) * WORLD_WIDTH;
    const worldY = ((event.clientY - map.top) / map.height) * WORLD_HEIGHT;
    update((current) => ({ ...current, viewport: { ...current.viewport, x: host.width / 2 - worldX * current.viewport.zoom, y: host.height / 2 - worldY * current.viewport.zoom } }), true);
  };
  return (
    <div
      ref={viewportRef}
      className={
        "workspace-canvas v2" + (gesture?.type === "pan" ? " is-panning" : "")
      }
      data-canvas-project-id={project.id}
      onPointerDown={(event) => {
        if (
          event.target !== event.currentTarget &&
          !(event.target as HTMLElement).classList.contains(
            "workspace-canvas-grid",
          )
        )
          return;
        if (event.button === 1 || event.shiftKey) {
          event.preventDefault();
          setGesture({
            type: "pan",
            sx: event.clientX,
            sy: event.clientY,
            viewport: canvas.viewport,
          });
        } else {
          setSelected([]);
          setConnectFrom(null);
        }
      }}
      onWheel={(event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        zoom(event.deltaY > 0 ? -0.1 : 0.1);
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
        <button type="button" onClick={addAgent} title="Criar agente">
          <Terminal size={14} /> Agente
        </button>
        <button type="button" onClick={createSquad} title="Criar squad de agentes conectado a uma tarefa">
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
          if (event.button === 1 || event.shiftKey) {
            event.preventDefault();
            setGesture({
              type: "pan",
              sx: event.clientX,
              sy: event.clientY,
              viewport: canvas.viewport,
            });
          } else {
            setSelected([]);
            setConnectFrom(null);
          }
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
            const x1 = from.x + from.width;
            const y1 = from.y + from.height / 2;
            const x2 = to.x;
            const y2 = to.y + to.height / 2;
            const curve = Math.max(70, Math.abs(x2 - x1) * 0.4);
            return (
              <path
                key={connection.id}
                d={`M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`}
              />
            );
          })}
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
                (connectFrom === node.id ? " is-connecting" : "")
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
                event.stopPropagation();
                selectNode(node.id, event.ctrlKey || event.metaKey);
              }}
            >
              <header>
                <strong>
                  {nodeMeta[node.kind].icon}
                  {node.title}
                </strong>
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
                      value={node.account || agentAccount}
                      aria-label="Conta Codex"
                      onPointerDown={(event) => event.stopPropagation()}
                      onChange={(event) =>
                        update(
                          (current) => ({
                            ...current,
                            nodes: current.nodes.map((item) =>
                              item.id === node.id ? { ...item, account: event.target.value as "account1" | "account2" } : item,
                            ),
                          }),
                          true,
                        )
                      }
                    ><option value="account1">C1</option><option value="account2">C2</option></select>
                  </label>
                )}
                {node.kind === "agent" && (
                  <button
                    type="button"
                    className="canvas-send-task"
                    aria-label={"Enviar tarefa para " + node.title}
                    title="Enviar as notas conectadas ao agente"
                    disabled={!canvas.connections.some((link) => (link.from === node.id || link.to === node.id) && nodeMap.get(link.from === node.id ? link.to : link.from)?.kind === "note")}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => sendAgentTask(node)}
                  ><Send size={13} /></button>
                )}
                <button
                  data-canvas-drag-handle
                  type="button"
                  className="canvas-drag"
                  aria-label={"Mover " + node.title}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!selected.includes(node.id)) setSelected([node.id]);
                    const nodes = (
                      selected.includes(node.id) ? selected : [node.id]
                    )
                      .map((id) =>
                        canvasRef.current.nodes.find((item) => item.id === id),
                      )
                      .filter((item): item is CanvasNode => Boolean(item));
                    setGesture({
                      type: "drag",
                      sx: event.clientX,
                      sy: event.clientY,
                      nodes,
                    });
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
                  <>{renderAgent?.(node, (result) => reportAgentResult(node.id, result)) || <div className="canvas-agent-empty">Terminal do agente indisponível.</div>}{node.content && <div className="canvas-agent-result" title={node.content}>{node.content}</div>}</>
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
                  event.preventDefault();
                  event.stopPropagation();
                  setGesture({
                    type: "resize",
                    sx: event.clientX,
                    sy: event.clientY,
                    id: node.id,
                    nodes: [node],
                  });
                }}
              >
                <Maximize2 size={12} />
              </button>
            </section>
          ))}
      </div>
      <div className="workspace-canvas-minimap" aria-label="Minimapa do canvas">
        <svg viewBox={`0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}`} onPointerDown={moveFromMinimap} role="img">
          {canvas.nodes.map((node) => <rect key={node.id} x={node.x} y={node.y} width={node.width} height={node.height} className={'minimap-node ' + node.kind} />)}
          {(() => { const host = viewportRef.current?.getBoundingClientRect(); const width = (host?.width || 900) / canvas.viewport.zoom; const height = (host?.height || 650) / canvas.viewport.zoom; return <rect className="minimap-viewport" x={-canvas.viewport.x / canvas.viewport.zoom} y={-canvas.viewport.y / canvas.viewport.zoom} width={width} height={height} /> })()}
        </svg>
      </div>
      <div className="workspace-canvas-hint">
        <MousePointer2 size={12} /> Arraste para mover · Shift + arrastar para
        navegar · Ctrl + roda para zoom · Ctrl+D duplica notas
      </div>
      {canDelete && (
        <button
          className="workspace-canvas-delete"
          type="button"
          onClick={deleteSelected}
        >
          <Trash2 size={14} /> Excluir{" "}
          {selected.length > 1 ? "selecionados" : "nota"}
        </button>
      )}
    </div>
  );
};
