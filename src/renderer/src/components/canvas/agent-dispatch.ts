/**
 * Lógica pura de despacho de tarefas de agentes do canvas do workspace.
 *
 * Extraída de WorkspaceCanvas.tsx para manter o god file enxuto e tornar o
 * contrato testável isoladamente. Nenhuma função aqui toca React diretamente:
 * todo estado/prop do componente entra por um objeto de dependências
 * explícito, e o componente injeta as deps atuais (zero mudança de
 * comportamento).
 */
import type { AgentProvider } from "../../types";
import type {
  AgentProgress,
  CanvasNode,
  CanvasState,
  OrchestrationRun,
} from "../WorkspaceCanvas";
import { agentNodeBlockedLabel, isAgentNodeConfigured } from "../agent-creation-helpers";

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

export const orchestrationRunId = () =>
  "orchestration-" +
  Date.now().toString(36) +
  "-" +
  Math.random().toString(36).slice(2, 7);

/** Mesmo padrão de transitoriedade usado no report de turno de continuidade. */
const CONTINUITY_TRANSIENT_PATTERN = /limite|rate.?limit|quota|esgot|indispon|overload|429|503/i;

/** Dependências do WorkspaceCanvas usadas por dispatchAgentTask. */
export interface AgentTaskDispatchDeps {
  onSendAgentTask:
    | ((node: CanvasNode, prompt: string) => string | undefined)
    | null
    | undefined;
  agentProviders: AgentProvider[];
  setAgentProgress: (
    updater: (current: Record<string, AgentProgress>) => Record<string, AgentProgress>,
  ) => void;
  update: (updater: (current: CanvasState) => CanvasState, immediately?: boolean) => void;
}

/**
 * Valida a configuração do agente, marca progresso, envia a tarefa via
 * onSendAgentTask e rotula o conteúdo do cartão. Retorna o taskId ou null.
 */
export function dispatchAgentTask(
  deps: AgentTaskDispatchDeps,
  agent: CanvasNode,
  prompt: string,
  progress?: AgentProgress,
): string | null {
  const { onSendAgentTask, agentProviders, setAgentProgress, update } = deps;
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
}

/** Dependências de dispatchOrchestrationTask. */
export interface OrchestrationTaskDispatchDeps {
  dispatchAgentTask: (
    agent: CanvasNode,
    prompt: string,
    progress?: AgentProgress,
  ) => string | null;
  markOrchestrationBlocked: (run: OrchestrationRun, agentId: string) => void;
  commitOrchestration: (next: OrchestrationRun | null) => void;
}

/**
 * Despacha uma etapa de orquestração: em caso de falha marca o run como
 * bloqueado; em caso de sucesso grava o expectedTaskId no run.
 */
export function dispatchOrchestrationTask(
  deps: OrchestrationTaskDispatchDeps,
  run: OrchestrationRun,
  agent: CanvasNode,
  prompt: string,
  progress: AgentProgress,
): boolean {
  const taskId = deps.dispatchAgentTask(agent, prompt, progress);
  if (!taskId) {
    deps.markOrchestrationBlocked(run, agent.id);
    return false;
  }
  deps.commitOrchestration({ ...run, expectedTaskId: taskId });
  return true;
}

/** Dependências de reportAgentTaskFailure. */
export interface AgentTaskFailureDeps {
  projectId: string;
  projectPath: string;
  /** Set mutável de tarefas manuais (manualTasksRef.current no componente). */
  manualTasks: Set<string>;
  getOrchestrationRun: () => OrchestrationRun | null;
  setAgentProgress: (
    updater: (current: Record<string, AgentProgress>) => Record<string, AgentProgress>,
  ) => void;
  markOrchestrationBlocked: (run: OrchestrationRun, agentId: string) => void;
  reportOrchestrationTurn: (
    projectPath: string,
    input: {
      seatId: string;
      outcome: "failed";
      summary: string;
      transient: boolean;
    },
  ) => Promise<unknown>;
}

/**
 * Falha de tarefa: reporta o turno de continuidade (reportOrchestrationTurn),
 * bloqueia progresso de tarefa manual e, se a falha for do agente esperado do
 * run atual, marca a orquestração como bloqueada com lastHandledResult.
 */
export function reportAgentTaskFailure(
  deps: AgentTaskFailureDeps,
  agentId: string,
  taskId: string,
  message: string,
): void {
  void deps
    .reportOrchestrationTurn(deps.projectPath, {
      seatId: agentId,
      outcome: "failed",
      summary: message,
      transient: CONTINUITY_TRANSIENT_PATTERN.test(message),
    })
    .catch(() => undefined);
  if (deps.manualTasks.delete(agentId)) {
    deps.setAgentProgress((current) => ({
      ...current,
      [agentId]: { state: "blocked", label: message || "A tarefa falhou" },
    }));
  }
  const run = deps.getOrchestrationRun();
  if (
    !run ||
    run.projectId !== deps.projectId ||
    run.phase === "complete" ||
    run.phase === "blocked" ||
    run.expectedAgentId !== agentId ||
    (run.expectedTaskId !== undefined && run.expectedTaskId !== taskId)
  )
    return;
  deps.markOrchestrationBlocked(
    { ...run, lastHandledResult: `failure:${taskId}:${message}` },
    agentId,
  );
}
