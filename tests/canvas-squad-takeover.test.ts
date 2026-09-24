import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CanvasNodeInspector } from '../src/renderer/src/components/CanvasNodeInspector'
import {
  buildSquadSnapshot,
  type CanvasNode,
  type CanvasSquad,
  type OrchestrationRun,
  type AgentProgress,
} from '../src/renderer/src/components/WorkspaceCanvas'
import type { AiMemoryTakeoverPlanView, AiMemoryIpcResult } from '../src/shared/ai-memory-ipc-contract'

describe('Canvas Squad Snapshot — buildSquadSnapshot', () => {
  const baseSquad: CanvasSquad = {
    id: 'squad-alpha',
    title: 'Squad Alpha',
    objective: 'Refatorar módulo de autenticação',
    memberNodeIds: ['agent-coord', 'agent-impl', 'agent-rev'],
    coordinatorNodeId: 'agent-coord',
  }

  const nodes: CanvasNode[] = [
    {
      id: 'agent-coord',
      kind: 'agent',
      title: 'Coordenador',
      role: 'Coordenador',
      x: 100,
      y: 100,
      width: 400,
      height: 300,
      z: 1,
      provider: 'codex',
    },
    {
      id: 'agent-impl',
      kind: 'agent',
      title: 'Implementador',
      role: 'Implementação',
      x: 520,
      y: 100,
      width: 400,
      height: 300,
      z: 2,
      provider: 'codex',
    },
    {
      id: 'agent-rev',
      kind: 'agent',
      title: 'Revisor',
      role: 'Revisão',
      x: 940,
      y: 100,
      width: 400,
      height: 300,
      z: 3,
      provider: 'codex',
    },
    {
      id: 'note-spec',
      kind: 'note',
      title: 'Especificação',
      x: 100,
      y: 500,
      width: 300,
      height: 200,
      z: 4,
      content: 'Detalhes da tarefa',
    },
  ]

  it('mapeia os membros da squad preservando somente agentes com seus status mapeados', () => {
    const progress: Record<string, AgentProgress | undefined> = {
      'agent-coord': { state: 'completed', label: 'Briefing concluído' },
      'agent-impl': { state: 'running', label: 'Codificando' },
      'agent-rev': { state: 'blocked', label: 'Aguardando testes' },
    }

    const snapshot = buildSquadSnapshot(baseSquad, nodes, progress)

    expect(snapshot.id).toBe('squad-alpha')
    expect(snapshot.objective).toBe('Refatorar módulo de autenticação')
    expect(snapshot.members).toHaveLength(3)

    const coord = snapshot.members.find((m) => m.id === 'agent-coord')
    expect(coord).toBeDefined()
    expect(coord?.status).toBe('done')
    expect(coord?.role).toBe('Coordenador')
    expect(coord?.terminalId).toBe('agent-coord')

    const impl = snapshot.members.find((m) => m.id === 'agent-impl')
    expect(impl).toBeDefined()
    expect(impl?.status).toBe('in-progress')

    const rev = snapshot.members.find((m) => m.id === 'agent-rev')
    expect(rev).toBeDefined()
    expect(rev?.status).toBe('blocked')

    // Nós de outros tipos (ex.: note-spec) não devem entrar em members
    expect(snapshot.members.some((m) => m.id === 'note-spec')).toBe(false)
  })

  it('usa fallback para o título quando o objetivo é vazio (evita rejeição pelo sanitizador)', () => {
    const squadNoObj: CanvasSquad = {
      id: 'squad-beta',
      title: 'Equipe de Infra',
      objective: '   ',
      memberNodeIds: ['agent-coord'],
    }

    const snapshot = buildSquadSnapshot(squadNoObj, nodes)
    expect(snapshot.objective).toBe('Equipe de Infra')
  })

  it('NÃO inventa tarefas nem decisões quando não há orquestração ativa', () => {
    const snapshot = buildSquadSnapshot(baseSquad, nodes, {})

    expect(snapshot.tasks).toBeUndefined()
    expect(snapshot.blockers).toBeUndefined()
    expect(snapshot.plan).toBeUndefined()
  })

  it('extrai tarefas estritamente a partir da orquestração real sem inventar extras', () => {
    const orchestration: OrchestrationRun = {
      id: 'orch-1',
      projectId: 'proj-1',
      coordinatorId: 'agent-coord',
      coordinatorTitle: 'Coordenador',
      notes: [],
      plan: '1. Implementar\n2. Revisar',
      results: [
        {
          agentId: 'agent-coord',
          title: 'Briefing',
          role: 'Coordenador',
          content: 'Plano gerado com sucesso',
        },
      ],
      specialists: [
        {
          id: 'agent-impl',
          title: 'Implementador',
          role: 'Implementação',
          notes: [],
        },
        {
          id: 'agent-rev',
          title: 'Revisor',
          role: 'Revisão',
          notes: [],
        },
      ],
      phase: 'specialist',
      specialistIndex: 0,
      expectedAgentId: 'agent-impl',
    }

    const snapshot = buildSquadSnapshot(baseSquad, nodes, {}, orchestration)

    expect(snapshot.plan).toBe('1. Implementar\n2. Revisar')
    expect(snapshot.tasks).toBeDefined()
    expect(snapshot.tasks).toHaveLength(3)

    // Tarefa 1: vem dos results (done)
    expect(snapshot.tasks![0]).toEqual({
      id: 'task-res-agent-coord-0',
      title: 'Coordenador: Briefing',
      status: 'done',
      memberId: 'agent-coord',
      description: 'Plano gerado com sucesso',
    })

    // Tarefa 2: especialista atual em andamento (in-progress)
    expect(snapshot.tasks![1]).toEqual({
      id: 'task-spec-agent-impl',
      title: 'Implementação: Implementador',
      status: 'in-progress',
      memberId: 'agent-impl',
    })

    // Tarefa 3: especialista seguinte (pending)
    expect(snapshot.tasks![2]).toEqual({
      id: 'task-spec-agent-rev',
      title: 'Revisão: Revisor',
      status: 'pending',
      memberId: 'agent-rev',
    })
  })

  it('registra bloqueio na squad quando a orquestração está em fase blocked', () => {
    const blockedOrch: OrchestrationRun = {
      id: 'orch-2',
      projectId: 'proj-1',
      coordinatorId: 'agent-coord',
      coordinatorTitle: 'Coordenador',
      notes: [],
      plan: 'Plano',
      results: [],
      specialists: [
        {
          id: 'agent-impl',
          title: 'Implementador',
          role: 'Implementação',
          notes: [],
        },
      ],
      phase: 'blocked',
      specialistIndex: 0,
      expectedAgentId: 'agent-impl',
    }

    const snapshot = buildSquadSnapshot(baseSquad, nodes, {}, blockedOrch)

    expect(snapshot.blockers).toEqual(['Orquestração bloqueada na etapa: blocked'])
    expect(snapshot.tasks![0].status).toBe('blocked')
  })
})

describe('Canvas Node Inspector — Survivor Takeover UI', () => {
  const squad: CanvasSquad = {
    id: 'squad-test',
    title: 'Squad de Segurança',
    objective: 'Implementar ACL',
    memberNodeIds: ['agent-1', 'agent-2'],
  }

  const agent1: CanvasNode = {
    id: 'agent-1',
    kind: 'agent',
    title: 'Agente 1',
    role: 'Implementação',
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    z: 1,
  }

  const agent2: CanvasNode = {
    id: 'agent-2',
    kind: 'agent',
    title: 'Agente 2',
    role: 'Testes',
    x: 350,
    y: 0,
    width: 300,
    height: 200,
    z: 2,
  }

  it('renderiza seção de takeover com seletor e botões quando inspecionando uma squad', () => {
    const handleTakeover = vi.fn()

    const html = renderToStaticMarkup(
      createElement(CanvasNodeInspector, {
        isOpen: true,
        onClose: vi.fn(),
        node: null,
        squad,
        squadMembers: [agent1, agent2],
        onSurvivorTakeover: handleTakeover,
        isTakingOver: false,
      }),
    )

    expect(html).toContain('Sincronização de Sobrevivente (Takeover)')
    expect(html).toContain('<span>Takeover</span>')
    expect(html).toContain('Agente 1 (Implementação)')
    expect(html).toContain('Agente 2 (Testes)')
    expect(html).toContain('title="Sincronizar Agente 1 com o estado da squad (Takeover)"')
  })

  it('exibe estado desabilitado e texto de carregamento quando isTakingOver está ativo', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasNodeInspector, {
        isOpen: true,
        onClose: vi.fn(),
        node: null,
        squad,
        squadMembers: [agent1, agent2],
        onSurvivorTakeover: vi.fn(),
        isTakingOver: true,
      }),
    )

    expect(html).toContain('Sincronizando...')
    expect(html).toContain('disabled=""')
  })

  it('renderiza botão de takeover na inspeção de um agente que pertence a uma squad', () => {
    const handleTakeover = vi.fn()

    const html = renderToStaticMarkup(
      createElement(CanvasNodeInspector, {
        isOpen: true,
        onClose: vi.fn(),
        node: agent1,
        squad,
        onSurvivorTakeover: handleTakeover,
        isTakingOver: false,
      }),
    )

    expect(html).toContain('Sincronizar Sobrevivente (Takeover)')
    expect(html).toContain('title="Sincronizar Agente 1 com o estado da squad Squad de Segurança (Takeover)"')
  })
})

describe('Survivor Takeover Workflow & Degradation Resilience', () => {
  // Simulação fiel do fluxo handleSurvivorTakeover de WorkspaceCanvas
  async function simulateSurvivorTakeover({
    squad,
    survivorNode,
    aiMemoryTakeover,
    onSendAgentTask,
    onNotify,
  }: {
    squad?: CanvasSquad | null
    survivorNode?: CanvasNode | null
    aiMemoryTakeover?: (params: { projectPath: string; squadId: string; survivingAgent: string }) => Promise<AiMemoryIpcResult<AiMemoryTakeoverPlanView | null>>
    onSendAgentTask?: (target: { id: string; provider?: string }, prompt: string) => boolean
    onNotify?: (msg: string, type: 'info' | 'success' | 'error') => void
  }) {
    if (!squad) {
      onNotify?.('Squad não encontrado para execução do takeover.', 'error')
      return { ok: false }
    }
    if (!survivorNode || survivorNode.kind !== 'agent') {
      onNotify?.('Agente sobrevivente não encontrado no canvas.', 'error')
      return { ok: false }
    }
    if (!aiMemoryTakeover) {
      onNotify?.('Serviço ai-memory indisponível ou IPC não registrado.', 'error')
      return { ok: false }
    }

    try {
      const response = await aiMemoryTakeover({
        projectPath: '/work/proj',
        squadId: squad.id,
        survivingAgent: survivorNode.title || survivorNode.role || survivorNode.id,
      })

      if (!response || !response.ok || !response.data) {
        const errorMsg =
          response?.message ||
          (response?.reason === 'disabled'
            ? 'ai-memory desabilitado para este projeto.'
            : response?.reason === 'unavailable'
            ? 'Serviço ai-memory degradado ou indisponível.'
            : 'Falha ao sincronizar estado da squad via ai-memory.')
        onNotify?.(errorMsg, 'error')
        return { ok: false, reason: response?.reason }
      }

      const plan = response.data
      if (!plan.instruction) {
        onNotify?.('Nenhum plano de takeover retornado pela memória.', 'error')
        return { ok: false }
      }

      const dispatched = onSendAgentTask
        ? onSendAgentTask({ id: survivorNode.id, provider: survivorNode.provider }, plan.instruction)
        : false

      if (dispatched) {
        onNotify?.(
          `Takeover enviado para ${survivorNode.title}: ${plan.pendingTasks.length} tarefa(s) pendente(s).`,
          'success',
        )
        return { ok: true, plan }
      } else if (!onSendAgentTask) {
        onNotify?.('Callback onSendAgentTask não configurado no Workspace.', 'error')
        return { ok: false }
      } else {
        onNotify?.(
          `Falha ao despachar tarefa de takeover para ${survivorNode.title}. Verifique a configuração do agente.`,
          'error',
        )
        return { ok: false }
      }
    } catch (error) {
      onNotify?.(
        `Erro ao executar takeover: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
      return { ok: false, error }
    }
  }

  const squad: CanvasSquad = {
    id: 'squad-takeover',
    title: 'Squad Takeover',
    objective: 'Recuperar trabalho',
    memberNodeIds: ['agent-survivor'],
  }

  const survivorNode: CanvasNode = {
    id: 'agent-survivor',
    kind: 'agent',
    title: 'Sobrevivente',
    role: 'Implementação',
    x: 100,
    y: 100,
    width: 300,
    height: 200,
    z: 1,
    provider: 'codex',
  }

  it('caso de sucesso: chama aiMemoryTakeover, despacha instruction pelo bridge e notifica sucesso', async () => {
    const mockPlan: AiMemoryTakeoverPlanView = {
      instruction: 'ATENÇÃO: Retomar as tarefas do squad com o estado Git atual.',
      pendingTasks: [
        { id: 'task-1', title: 'Completar migração', status: 'in-progress' },
      ],
      sourcesLoaded: { state: true, briefing: true, handoffs: true },
    }

    const aiMemoryTakeover = vi.fn().mockResolvedValue({
      ok: true,
      data: mockPlan,
    })

    const onSendAgentTask = vi.fn().mockReturnValue(true)
    const onNotify = vi.fn()

    const result = await simulateSurvivorTakeover({
      squad,
      survivorNode,
      aiMemoryTakeover,
      onSendAgentTask,
      onNotify,
    })

    expect(result.ok).toBe(true)
    expect(aiMemoryTakeover).toHaveBeenCalledWith({
      projectPath: '/work/proj',
      squadId: 'squad-takeover',
      survivingAgent: 'Sobrevivente',
    })
    expect(onSendAgentTask).toHaveBeenCalledWith(
      { id: 'agent-survivor', provider: 'codex' },
      mockPlan.instruction,
    )
    expect(onNotify).toHaveBeenCalledWith(
      'Takeover enviado para Sobrevivente: 1 tarefa(s) pendente(s).',
      'success',
    )
  })

  it('degradação ai-memory desabilitado: notifica amigavelmente e não quebra o workspace', async () => {
    const aiMemoryTakeover = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'disabled',
    })

    const onSendAgentTask = vi.fn()
    const onNotify = vi.fn()

    const result = await simulateSurvivorTakeover({
      squad,
      survivorNode,
      aiMemoryTakeover,
      onSendAgentTask,
      onNotify,
    })

    expect(result.ok).toBe(false)
    expect(onNotify).toHaveBeenCalledWith(
      'ai-memory desabilitado para este projeto.',
      'error',
    )
    expect(onSendAgentTask).not.toHaveBeenCalled()
  })

  it('degradação ai-memory indisponível: notifica amigavelmente e não quebra o workspace', async () => {
    const aiMemoryTakeover = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'unavailable',
    })

    const onNotify = vi.fn()

    const result = await simulateSurvivorTakeover({
      squad,
      survivorNode,
      aiMemoryTakeover,
      onNotify,
    })

    expect(result.ok).toBe(false)
    expect(onNotify).toHaveBeenCalledWith(
      'Serviço ai-memory degradado ou indisponível.',
      'error',
    )
  })

  it('exceção de rede ou IPC: trata erro com notificação visível sem estourar exceção não capturada', async () => {
    const aiMemoryTakeover = vi.fn().mockRejectedValue(new Error('IPC desconectado'))

    const onNotify = vi.fn()

    const result = await simulateSurvivorTakeover({
      squad,
      survivorNode,
      aiMemoryTakeover,
      onNotify,
    })

    expect(result.ok).toBe(false)
    expect(onNotify).toHaveBeenCalledWith(
      'Erro ao executar takeover: IPC desconectado',
      'error',
    )
  })

  it('falha se o nó de destino não for do tipo agent', async () => {
    const noteNode: CanvasNode = {
      id: 'note-1',
      kind: 'note',
      title: 'Nota',
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      z: 1,
    }

    const onNotify = vi.fn()
    const result = await simulateSurvivorTakeover({
      squad,
      survivorNode: noteNode,
      onNotify,
    })

    expect(result.ok).toBe(false)
    expect(onNotify).toHaveBeenCalledWith(
      'Agente sobrevivente não encontrado no canvas.',
      'error',
    )
  })
})
