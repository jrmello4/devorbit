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
import type { AgentResult } from "../../../../shared/agent-result";
import {
  AGENT_RESULT_MAX_SUMMARY_CHARS,
  composeAgentResultContent,
} from "../../../../shared/agent-result";
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
  'Emita primeiro uma única linha com JSON compacto: DEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"resumo objetivo","handoff":"contexto técnico completo para o próximo agente continuar a tarefa"}. Use outcome completed, blocked ou failed e summary objetivo, sem quebras de linha e com no máximo 1000 caracteres. Inclua opcionalmente no mesmo JSON: handoff (contexto detalhado para o próximo agente — decisões, estado atual, próximos passos; pode ser longo, escapado para caber em uma linha), filesChanged (array de caminhos de arquivo alterados), testsExecuted (o que foi testado e o resultado) e remainingIssues (pendências conhecidas). Emita imediatamente depois o espelho legado DEVORBIT_RESULT: CONCLUIDO: <resumo>, DEVORBIT_RESULT: BLOQUEADO: <motivo> ou DEVORBIT_RESULT: FALHA: <motivo>. O JSON vem primeiro e não aguarde outro clique para encaminhar a próxima etapa.';

/** Cap do conteúdo do nó agente no canvas (mesmo teto da edição manual). */
export const AGENT_NODE_CONTENT_MAX_CHARS = 24_000;

/**
 * Summary CURTO (≤1000) para reportOrchestrationTurn (continuidade/UI).
 * Este é o "summary pequeno" por design: o contexto completo entre
 * especialistas viaja pelo handoff no conteúdo do nó/resultados.
 */
export function agentResultContinuitySummary(result: AgentResult): string {
  return result.summary.trim().slice(0, AGENT_RESULT_MAX_SUMMARY_CHARS);
}

/**
 * Conteúdo COMPLETO do resultado (summary + handoff + arquivos + pendências)
 * para o nó do agente e para run.results — é isto que alimenta a próxima
 * instrução; nunca substituir por agentResultContinuitySummary aqui.
 */
export function agentResultNodeContent(result: AgentResult): string {
  return composeAgentResultContent(result, AGENT_NODE_CONTENT_MAX_CHARS);
}

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

// ---- Orçamento de montagem do prompt de orquestração -----------------------
// O teto de envio é TURN_MAX_PROMPT_CHARS (65.536). Quando o contexto total
// (instrução + notas + plano + resultados) se aproxima dele, o corte cego do
// IPC fatia a CAUDA — exatamente onde estão os resultados mais recentes.
// Estes orçamentos montam as seções para que o total caiba, descartando o
// CONTEÚDO MAIS ANTIGO primeiro (com nota de omissão), nunca o mais novo.

/** Orçamento da seção "Resultados anteriores" no prompt do especialista. */
export const ORCHESTRATION_RESULTS_PROMPT_BUDGET = 30_000;
/** Orçamento da seção "Plano do coordenador" no prompt do especialista. */
export const ORCHESTRATION_PLAN_PROMPT_BUDGET = 20_000;
/** Orçamento da seção de notas conectadas no prompt do especialista. */
export const ORCHESTRATION_NOTES_PROMPT_BUDGET = 10_000;

/** Corta mantendo o CABEÇALHO (objetivo/tarefa vivem no início do texto). */
export function trimHeadWithNote(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n(…seção truncada por orçamento de contexto)`;
}

export interface OrchestrationResultView {
  role: string;
  title: string;
  content: string;
}

/**
 * Formata os resultados anteriores dentro do orçamento, priorizando os MAIS
 * RECENTES (o estado atual da tarefa) — os mais antigos são omitidos com uma
 * nota visível em vez de serem a única coisa que sobrevive a um corte cego.
 */
export function formatOrchestrationResultsWithinBudget(
  results: OrchestrationResultView[],
  budgetChars: number = ORCHESTRATION_RESULTS_PROMPT_BUDGET,
): string {
  if (!results.length) return "Nenhum resultado de agente foi recebido ainda.";
  const ordered = [...results].reverse();
  const included: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const result of ordered) {
    const block = `\n### ${result.role} — ${result.title}\n${result.content}`;
    if (used + block.length > budgetChars) {
      omitted += 1;
      continue;
    }
    included.push(block);
    used += block.length;
  }
  if (included.length === 0) {
    return `(todos os ${results.length} resultados anteriores excederam o orçamento de contexto; consulte o histórico no canvas)`;
  }
  const omissionNote =
    omitted > 0
      ? `(${omitted} resultado(s) mais antigo(s) omitido(s) por orçamento de contexto)\n`
      : "";
  return omissionNote + included.reverse().join("\n");
}
