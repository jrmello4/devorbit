import { describe, expect, it, vi } from 'vitest'
import type { AgentProvider } from '../src/renderer/src/types'
import type { AgentResult } from '../src/shared/agent-result'
import type {
  AgentProgress,
  CanvasNode,
  CanvasState,
  OrchestrationRun,
} from '../src/renderer/src/components/WorkspaceCanvas'
import {
  AGENT_NODE_CONTENT_MAX_CHARS,
  agentResultContinuitySummary,
  agentResultNodeContent,
  composeAgentPrompt,
  dispatchAgentTask,
  dispatchOrchestrationTask,
  orchestrationResultInstruction,
  orchestrationRunId,
  reportAgentTaskFailure,
  formatOrchestrationResultsWithinBudget,
  trimHeadWithNote,
} from '../src/renderer/src/components/canvas/agent-dispatch'

const readyProviders: AgentProvider[] = [
  { id: 'claude', label: 'Claude', command: 'claude', state: 'ready', message: '' },
]

const agentNode = (overrides: Partial<CanvasNode> = {}): CanvasNode => ({
  id: 'agent-1',
  kind: 'agent',
  title: 'Agente Um',
  x: 0,
  y: 0,
  width: 320,
  height: 200,
  z: 1,
  provider: 'claude',
  ...overrides,
})

const makeDeps = () => {
  const progressByAgent: Record<string, AgentProgress> = {}
  const updates: Array<{ next: CanvasState; immediately: boolean }> = []
  const state: { nodes: CanvasNode[] } = {
    nodes: [agentNode(), agentNode({ id: 'agent-2', title: 'Agente Dois' })],
  }
  return {
    progressByAgent,
    updates,
    onSendAgentTask: vi.fn((_node: CanvasNode, _prompt: string): string | undefined => 'task-123'),
    agentProviders: readyProviders,
    setAgentProgress: vi.fn(
      (updater: (current: Record<string, AgentProgress>) => Record<string, AgentProgress>) => {
        Object.assign(progressByAgent, updater(progressByAgent))
      },
    ),
    update: vi.fn((updater: (current: CanvasState) => CanvasState, immediately = false) => {
      const next = updater(state as CanvasState)
      updates.push({ next, immediately })
    }),
  }
}

type Deps = ReturnType<typeof makeDeps>

const makeRun = (overrides: Partial<OrchestrationRun> = {}): OrchestrationRun => ({
  id: 'orchestration-abc-def',
  projectId: 'proj-1',
  coordinatorId: 'coord-1',
  coordinatorTitle: 'Coordenador',
  notes: [],
  specialists: [],
  phase: 'specialist',
  specialistIndex: 0,
  expectedAgentId: 'agent-1',
  plan: 'plano',
  results: [],
  ...overrides,
})

describe('composeAgentPrompt (contrato DEVORBIT_RESULT)', () => {
  it('gera DEVORBIT_RESULT JSON válido na primeira linha, com espelho legado', () => {
    const prompt = composeAgentPrompt(['Notas da etapa', 'Contexto extra'])
    const lines = prompt.split('\n')

    expect(lines[0]).toBe(orchestrationResultInstruction)
    // A instrução abre com o marcador e o JSON compacto vem logo nele.
    expect(lines[0].startsWith('Emita primeiro uma única linha com JSON compacto: DEVORBIT_RESULT: {')).toBe(true)
    const jsonMatch = lines[0].match(/DEVORBIT_RESULT:\s*(\{[^}]*\})/)
    expect(jsonMatch).not.toBeNull()
    const json = JSON.parse(jsonMatch?.[1] ?? '{}') as {
      version: number
      outcome: string
      summary: string
      handoff?: string
    }
    expect(json).toEqual({
      version: 1,
      outcome: 'completed',
      summary: 'resumo objetivo',
      handoff: 'contexto técnico completo para o próximo agente continuar a tarefa',
    })
    // Espelho legado presente na instrução.
    expect(lines[0]).toContain('DEVORBIT_RESULT: CONCLUIDO: <resumo>')
    // Corpo preservado, na ordem, depois da instrução.
    expect(lines.slice(1)).toEqual(['Notas da etapa', 'Contexto extra'])
  })

  it('remove linha de instrução duplicada do corpo e mantém a primeira', () => {
    const prompt = composeAgentPrompt([orchestrationResultInstruction, 'passo 1'])
    expect(prompt.split('\n')).toEqual([orchestrationResultInstruction, 'passo 1'])
  })

  it('orchestrationRunId gera id com prefixo orchestration- e valores únicos', () => {
    const first = orchestrationRunId()
    const second = orchestrationRunId()
    expect(first).toMatch(/^orchestration-[0-9a-z]+-[0-9a-z]+$/)
    expect(second).not.toBe(first)
  })
})

describe('dispatchAgentTask', () => {
  it('propaga o taskId retornado por onSendAgentTask', () => {
    const deps = makeDeps()
    const agent = agentNode()

    const taskId = dispatchAgentTask(deps, agent, 'faça a tarefa', {
      state: 'running',
      label: 'Executando etapa',
    })

    expect(taskId).toBe('task-123')
    expect(deps.onSendAgentTask).toHaveBeenCalledTimes(1)
    expect(deps.onSendAgentTask).toHaveBeenCalledWith(agent, 'faça a tarefa')
  })

  it('retorna null quando onSendAgentTask não está configurado', () => {
    const deps = makeDeps()

    const taskId = dispatchAgentTask({ ...deps, onSendAgentTask: null }, agentNode(), 'prompt')

    expect(taskId).toBeNull()
    expect(deps.setAgentProgress).not.toHaveBeenCalled()
    expect(deps.update).not.toHaveBeenCalled()
  })

  it('bloqueia progresso e não despacha quando o agente não está configurado', () => {
    const deps = makeDeps()
    const unconfigured = agentNode({ provider: undefined })

    const taskId = dispatchAgentTask(deps, unconfigured, 'prompt')

    expect(taskId).toBeNull()
    expect(deps.onSendAgentTask).not.toHaveBeenCalled()
    expect(deps.update).not.toHaveBeenCalled()
    expect(deps.progressByAgent['agent-1']).toEqual({
      state: 'blocked',
      label: 'Configure provider e conta',
    })
  })

  it('marca progresso informado e rotula o cartão com persistência imediata', () => {
    const deps = makeDeps()

    dispatchAgentTask(deps, agentNode(), 'prompt', {
      state: 'running',
      label: 'Executando etapa',
    })

    expect(deps.progressByAgent['agent-1']).toEqual({
      state: 'running',
      label: 'Executando etapa',
    })
    expect(deps.updates).toHaveLength(1)
    expect(deps.updates[0]?.immediately).toBe(true)
    const updated = deps.updates[0]?.next.nodes.find((node) => node.id === 'agent-1')
    expect(updated?.content).toBe('Executando etapa')
    // Outros nós intocados.
    const other = deps.updates[0]?.next.nodes.find((node) => node.id === 'agent-2')
    expect(other?.content).toBeUndefined()
  })

  it('sem progress usa rótulo padrão do cartão; falha do send não commita', () => {
    const failing = makeDeps()
    failing.onSendAgentTask.mockReturnValueOnce(undefined)

    const taskId = dispatchAgentTask(failing, agentNode(), 'prompt')

    expect(taskId).toBeNull()
    expect(failing.updates).toHaveLength(0)

    const ok = makeDeps()
    dispatchAgentTask(ok, agentNode(), 'prompt')
    const updated = ok.updates[0]?.next.nodes.find((node) => node.id === 'agent-1')
    expect(updated?.content).toBe('Tarefa enviada agora')
  })
})

describe('dispatchOrchestrationTask', () => {
  it('grava expectedTaskId no run quando o despacho tem sucesso', () => {
    const markBlocked = vi.fn()
    const commit = vi.fn()
    const run = makeRun()

    const result = dispatchOrchestrationTask(
      {
        dispatchAgentTask: () => 'task-9',
        markOrchestrationBlocked: markBlocked,
        commitOrchestration: commit,
      },
      run,
      agentNode(),
      'prompt da etapa',
      { state: 'running', label: 'Etapa 1' },
    )

    expect(result).toBe(true)
    expect(markBlocked).not.toHaveBeenCalled()
    expect(commit).toHaveBeenCalledWith({ ...run, expectedTaskId: 'task-9' })
  })

  it('marca o run como bloqueado quando o despacho falha', () => {
    const markBlocked = vi.fn()
    const commit = vi.fn()
    const run = makeRun()

    const result = dispatchOrchestrationTask(
      {
        dispatchAgentTask: () => null,
        markOrchestrationBlocked: markBlocked,
        commitOrchestration: commit,
      },
      run,
      agentNode(),
      'prompt da etapa',
      { state: 'running', label: 'Etapa 1' },
    )

    expect(result).toBe(false)
    expect(commit).not.toHaveBeenCalled()
    expect(markBlocked).toHaveBeenCalledWith(run, 'agent-1')
  })
})

describe('reportAgentTaskFailure (continuidade da orquestração)', () => {
  type TurnInput = {
    seatId: string
    outcome: 'failed'
    summary: string
    transient: boolean
  }

  const baseDeps = () => {
    const progressByAgent: Record<string, AgentProgress> = {}
    return {
      progressByAgent,
      manualTasks: new Set<string>(),
      currentRun: null as OrchestrationRun | null,
      blocked: [] as Array<{ run: OrchestrationRun; agentId: string }>,
      reportOrchestrationTurn: vi.fn(
        (_projectPath: string, _input: TurnInput) => Promise.resolve<unknown>(null),
      ),
      setAgentProgress: vi.fn(
        (updater: (current: Record<string, AgentProgress>) => Record<string, AgentProgress>) => {
          Object.assign(progressByAgent, updater(progressByAgent))
        },
      ),
    }
  }

  const failureDeps = (deps: ReturnType<typeof baseDeps>) => ({
    projectId: 'proj-1',
    projectPath: 'C:/proj',
    manualTasks: deps.manualTasks,
    getOrchestrationRun: () => deps.currentRun,
    setAgentProgress: deps.setAgentProgress,
    markOrchestrationBlocked: (run: OrchestrationRun, agentId: string) =>
      deps.blocked.push({ run, agentId }),
    reportOrchestrationTurn: deps.reportOrchestrationTurn,
  })

  it('reporta reportOrchestrationTurn com seat, outcome failed e transitoriedade', async () => {
    const deps = baseDeps()

    reportAgentTaskFailure(failureDeps(deps), 'agent-1', 'task-1', 'boom inesperado')
    await Promise.resolve()

    expect(deps.reportOrchestrationTurn).toHaveBeenCalledTimes(1)
    expect(deps.reportOrchestrationTurn).toHaveBeenCalledWith('C:/proj', {
      seatId: 'agent-1',
      outcome: 'failed',
      summary: 'boom inesperado',
      transient: false,
    })
  })

  it('classifica mensagens de limite/quota como transientes e engole rejeição do report', async () => {
    const deps = baseDeps()
    deps.reportOrchestrationTurn.mockRejectedValueOnce(new Error('ipc down'))

    reportAgentTaskFailure(failureDeps(deps), 'agent-1', 'task-1', 'rate limit atingido (429)')

    const input = deps.reportOrchestrationTurn.mock.calls[0]?.[1]
    expect(input?.transient).toBe(true)
    expect(input?.outcome).toBe('failed')
    expect(input?.summary).toBe('rate limit atingido (429)')
    // O .catch(() => undefined) do módulo neutraliza a rejeição propagada.
    const turn = deps.reportOrchestrationTurn.mock.results[0]?.value as Promise<unknown>
    await expect(turn).rejects.toThrow('ipc down')
  })

  it('consome tarefa manual e bloqueia progresso com a mensagem (ou fallback)', () => {
    const deps = baseDeps()
    deps.manualTasks.add('agent-1')

    reportAgentTaskFailure(failureDeps(deps), 'agent-1', 'task-1', '')

    expect(deps.manualTasks.has('agent-1')).toBe(false)
    expect(deps.progressByAgent['agent-1']).toEqual({
      state: 'blocked',
      label: 'A tarefa falhou',
    })
  })

  it('não bloqueia progresso de tarefa que não é manual', () => {
    const deps = baseDeps()

    reportAgentTaskFailure(failureDeps(deps), 'agent-1', 'task-1', 'boom')

    expect(deps.setAgentProgress).not.toHaveBeenCalled()
  })

  it('marca a orquestração como bloqueada quando a falha é do agente/tarefa esperados', () => {
    const deps = baseDeps()
    const run = makeRun({ expectedTaskId: 'task-1' })
    deps.currentRun = run

    reportAgentTaskFailure(failureDeps(deps), 'agent-1', 'task-1', 'boom')

    expect(deps.blocked).toHaveLength(1)
    expect(deps.blocked[0]?.agentId).toBe('agent-1')
    expect(deps.blocked[0]?.run).toEqual({ ...run, lastHandledResult: 'failure:task-1:boom' })
  })

  it('ignora runs de outro projeto, fases terminais ou expectedTaskId divergente', () => {
    const deps = baseDeps()

    const blockedCountFor = (run: OrchestrationRun | null) => {
      deps.blocked.length = 0
      deps.currentRun = run
      reportAgentTaskFailure(failureDeps(deps), 'agent-1', 'task-1', 'boom')
      return deps.blocked.length
    }

    expect(blockedCountFor(makeRun({ projectId: 'outro-proj', expectedTaskId: 'task-1' }))).toBe(0)
    expect(blockedCountFor(null)).toBe(0)
    expect(blockedCountFor(makeRun({ phase: 'complete', expectedTaskId: 'task-1' }))).toBe(0)
    expect(blockedCountFor(makeRun({ phase: 'blocked', expectedTaskId: 'task-1' }))).toBe(0)
    expect(blockedCountFor(makeRun({ expectedAgentId: 'outro-agente' }))).toBe(0)
    expect(blockedCountFor(makeRun({ expectedTaskId: 'task-2' }))).toBe(0)
  })
})

describe('resultado estruturado: nó completo vs continuidade curta (handoff entre agentes)', () => {
  const tailMarker = 'CAUDA-PRESERVADA-APOS-CARACTERE-1000'
  const structuredResult: AgentResult = {
    format: 'json',
    version: 1,
    outcome: 'completed',
    summary: 'Implementado.',
    handoff: 'h'.repeat(4900) + '|' + tailMarker,
    filesChanged: ['src/a.ts', 'src/b.ts'],
    testsExecuted: 'npx vitest run: 12 ok',
    remainingIssues: 'Nenhuma.',
  }

  it('nó do agente recebe o resultado COMPLETO com handoff >1000 chars (cauda preservada)', () => {
    const content = agentResultNodeContent(structuredResult)
    expect(content.length).toBeGreaterThan(1000)
    expect(content).toContain('Implementado.')
    expect(content).toContain('## Handoff para o próximo agente')
    expect(content).toContain(tailMarker)
    expect(content).toContain('- src/a.ts')
    expect(content).toContain('## Pendências')
    expect(content.length).toBeLessThanOrEqual(AGENT_NODE_CONTENT_MAX_CHARS)
  })

  it('continuidade (reportOrchestrationTurn) recebe summary curto ≤1000, nunca o handoff', () => {
    const summary = agentResultContinuitySummary(structuredResult)
    expect(summary).toBe('Implementado.')
    expect(summary.length).toBeLessThanOrEqual(1000)
    expect(summary).not.toContain(tailMarker)
  })

  it('summary longo (>1000) é cortado em 1000 na continuidade e respeita o cap do nó no conteúdo', () => {
    const longSummary = 's'.repeat(1400)
    const legacy = { ...structuredResult, summary: longSummary }
    expect(agentResultContinuitySummary(legacy).length).toBe(1000)
    const content = agentResultNodeContent(legacy)
    expect(content.startsWith('s'.repeat(1000))).toBe(true)
    expect(content).toContain('## Handoff para o próximo agente')
    expect(content.length).toBeLessThanOrEqual(AGENT_NODE_CONTENT_MAX_CHARS)
  })
})

describe('Orçamento de montagem do prompt de orquestração', () => {
  const result = (role: string, title: string, content: string) => ({ role, title, content });

  it('prioriza os resultados MAIS RECENTES quando o orçamento estoura e anota a omissão', () => {
    const results = [
      result('Implementação', 'Etapa 1 (antiga)', 'R'.repeat(2000)),
      result('Implementação', 'Etapa 2', 'S'.repeat(2000)),
      result('Revisão', 'Etapa 3 (recente)', 'T'.repeat(2000)),
    ];
    const formatted = formatOrchestrationResultsWithinBudget(results, 5000);
    // Mais recente sempre presente; mais antigo omitido com nota.
    expect(formatted).toContain('Etapa 3 (recente)');
    expect(formatted).toContain('Etapa 2');
    expect(formatted).not.toContain('Etapa 1 (antiga)');
    expect(formatted).toContain('omitido(s) por orçamento');
    expect(formatted.length).toBeLessThanOrEqual(5000 + 200);
  });

  it('sem resultados mantém a mensagem; sem estouro não há nota de omissão', () => {
    expect(formatOrchestrationResultsWithinBudget([], 1000)).toContain('Nenhum resultado');
    const small = [result('Implementação', 'Única', 'ok')];
    const formatted = formatOrchestrationResultsWithinBudget(small, 1000);
    expect(formatted).toContain('Única');
    expect(formatted).not.toContain('omitido(s)');
  });

  it('trimHeadWithNote preserva o cabeçalho (objetivo) e anota o corte', () => {
    const text = 'OBJETIVO-NO-TOPO\n' + 'x'.repeat(5000);
    const trimmed = trimHeadWithNote(text, 1000);
    expect(trimmed.startsWith('OBJETIVO-NO-TOPO')).toBe(true);
    expect(trimmed).toContain('truncada por orçamento');
    expect(trimHeadWithNote('curto', 1000)).toBe('curto');
  });
})
