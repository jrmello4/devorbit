import { createElement, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CanvasToolbar } from '../src/renderer/src/components/CanvasToolbar'
import { CanvasNodeInspector } from '../src/renderer/src/components/CanvasNodeInspector'
import { CanvasNodeCard } from '../src/renderer/src/components/CanvasNodeCard'
import { AgentCreationDialog } from '../src/renderer/src/components/AgentCreationDialog'
import type { CanvasNode, CanvasSquad, NodeKind } from '../src/renderer/src/components/WorkspaceCanvas'
import type { AgentProvider } from '../src/renderer/src/types'
import { Bot, Terminal, NotebookPen, FileCode2, Globe2 } from 'lucide-react'

const mockProviders: AgentProvider[] = [
  { id: 'codex', label: 'Codex CLI', command: 'codex', state: 'ready', message: '' },
  { id: 'opencode', label: 'OpenCode', command: 'opencode', state: 'ready', message: '' },
  { id: 'claude', label: 'Claude Code', command: 'claude', state: 'missing', message: '' },
]

const mockNodeMeta: Record<NodeKind, { label: string; meta: string; icon: React.ReactNode }> = {
  workbench: { label: 'Editor e terminal', meta: 'WORKBENCH', icon: createElement(FileCode2, { size: 13 }) },
  browser: { label: 'Navegador do projeto', meta: 'BROWSER', icon: createElement(Globe2, { size: 13 }) },
  note: { label: 'Nota', meta: 'INTEL', icon: createElement(NotebookPen, { size: 13 }) },
  agent: { label: 'Agente', meta: 'AGENTE', icon: createElement(Bot, { size: 13 }) },
  terminal: { label: 'Terminal', meta: 'TERMINAL', icon: createElement(Terminal, { size: 13 }) },
}

describe('TASK-03B — CanvasToolbar UI Component', () => {
  it('renderiza todos os grupos essenciais: criação, navegação, zoom e inspector', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasToolbar, {
        zoom: 1.0,
        onZoomIn: vi.fn(),
        onZoomOut: vi.fn(),
        onResetViewport: vi.fn(),
        onCreateAgent: vi.fn(),
        onCreateTerminal: vi.fn(),
        onCreateNote: vi.fn(),
        onCreateSquad: vi.fn(),
        onFitCanvas: vi.fn(),
        onFocusSelected: vi.fn(),
        onToggleInspector: vi.fn(),
        onSetZoomPreset: vi.fn(),
        isInspectorOpen: false,
        selectionCount: 0,
      }),
    )

    expect(html).toContain('role="toolbar"')
    expect(html).toContain('aria-label="Barra de ferramentas do canvas"')
    expect(html).toContain('Agente')
    expect(html).toContain('Terminal')
    expect(html).toContain('Nota')
    expect(html).toContain('Squad')
    expect(html).toContain('100%')
    expect(html).toContain('Perto')
    expect(html).toContain('Médio')
    expect(html).toContain('Longe')
    expect(html).toContain('Foco')
    expect(html).toContain('Inspector')
  })

  it('exibe ações de seleção e delete quando há nós selecionados', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasToolbar, {
        zoom: 1.25,
        onZoomIn: vi.fn(),
        onZoomOut: vi.fn(),
        onResetViewport: vi.fn(),
        selectionCount: 2,
        onStartConnection: vi.fn(),
        onRemoveLinks: vi.fn(),
        onDeleteSelected: vi.fn(),
      }),
    )

    expect(html).toContain('Conectar')
    expect(html).toContain('Desvincular')
    expect(html).toContain('Excluir')
    expect(html).toContain('125%')
  })

  it('destaca estado ativo do Inspector e do Modo Foco', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasToolbar, {
        zoom: 0.5,
        onZoomIn: vi.fn(),
        onZoomOut: vi.fn(),
        onResetViewport: vi.fn(),
        isInspectorOpen: true,
        isFocusModeActive: true,
        selectionCount: 1,
        onFocusSelected: vi.fn(),
        onToggleInspector: vi.fn(),
      }),
    )

    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('50%')
  })

  it('renderiza chips de níveis discretos quando zoomLevels e onSetZoom são fornecidos', () => {
    const onSetZoom = vi.fn()
    const html = renderToStaticMarkup(
      createElement(CanvasToolbar, {
        zoom: 1.0,
        zoomLevels: [0.5, 0.75, 1.0, 1.25],
        onSetZoom,
        onZoomIn: vi.fn(),
        onZoomOut: vi.fn(),
        onResetViewport: vi.fn(),
      }),
    )

    expect(html).toContain('50%')
    expect(html).toContain('75%')
    expect(html).toContain('100%')
    expect(html).toContain('125%')
    expect(html).toContain('title="Definir zoom para 75%"')
  })
})

describe('TASK-03B — CanvasNodeInspector UI Component', () => {
  it('não renderiza nada quando fechado', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasNodeInspector, {
        isOpen: false,
        onClose: vi.fn(),
        node: null,
      }),
    )
    expect(html).toBe('')
  })

  it('renderiza inspeção contextual detalhada para nó do tipo Agent', () => {
    const agentNode: CanvasNode = {
      id: 'agent-1',
      kind: 'agent',
      title: 'Dev Backend',
      x: 100,
      y: 100,
      width: 400,
      height: 300,
      z: 1,
      role: 'Coordenador',
      provider: 'codex',
      account: 'account1',
    }

    const html = renderToStaticMarkup(
      createElement(CanvasNodeInspector, {
        isOpen: true,
        onClose: vi.fn(),
        node: agentNode,
        providers: mockProviders,
        progress: { state: 'running', label: 'Processando task' },
        onSendTask: vi.fn(),
        onIsolateWorktree: vi.fn(),
      }),
    )

    expect(html).toContain('data-canvas-inspector=""')
    expect(html).toContain('Dev Backend')
    expect(html).toContain('Configuração do Agente')
    expect(html).toContain('Coordenador')
    expect(html).toContain('Codex CLI')
    expect(html).toContain('Conta 1')
    expect(html).toContain('Processando task')
    expect(html).toContain('Enviar Tarefa ao Agente')
    expect(html).toContain('Isolar em Worktree Git')
  })

  it('renderiza inspeção contextual para nó do tipo Terminal com aviso de sessão viva', () => {
    const terminalNode: CanvasNode = {
      id: 'term-1',
      kind: 'terminal',
      title: 'Vite Dev',
      x: 200,
      y: 200,
      width: 400,
      height: 300,
      z: 2,
      terminal: {
        presetId: 'dev',
        command: 'npm run dev',
        args: ['--port', '3000'],
        cwdMode: 'workspace',
        autoStart: true,
        restartBehavior: 'restart',
        monitorActivity: true,
      },
    }

    const html = renderToStaticMarkup(
      createElement(CanvasNodeInspector, {
        isOpen: true,
        onClose: vi.fn(),
        node: terminalNode,
        quickDeployChips: [
          {
            id: 'dev',
            label: 'DEV',
            description: 'Dev server',
            preset: {
              id: 'dev' as any,
              command: 'npm run dev',
              defaultAutoStart: true,
              defaultMonitorActivity: true,
              defaultRestartBehavior: 'restart',
              label: 'DEV',
              description: 'Dev server',
              kind: 'command',
            },
          },
        ],
        onUpdateTerminalNode: vi.fn(),
      }),
    )

    expect(html).toContain('Configuração do Terminal')
    expect(html).toContain('Sessão PTY permanece viva no card do canvas')
    expect(html).toContain('npm run dev')
    expect(html).toContain('--port 3000')
    expect(html).toContain('Relançar processo')
  })

  it('renderiza inspeção para nó do tipo Note com estatísticas de texto', () => {
    const noteNode: CanvasNode = {
      id: 'note-1',
      kind: 'note',
      title: 'Plano de Ação',
      x: 300,
      y: 100,
      width: 300,
      height: 200,
      z: 1,
      content: 'Instruções para a equipe de QA',
    }

    const html = renderToStaticMarkup(
      createElement(CanvasNodeInspector, {
        isOpen: true,
        onClose: vi.fn(),
        node: noteNode,
        onUpdateContent: vi.fn(),
      }),
    )

    expect(html).toContain('Conteúdo da Nota')
    expect(html).toContain('Instruções para a equipe de QA')
    expect(html).toContain('30 caracteres')
    expect(html).toContain('6 palavras')
  })

  it('renderiza inspeção de Agente com papel customizado e lista de papéis sugeridos', () => {
    const agentNode: CanvasNode = {
      id: 'agent-custom-1',
      kind: 'agent',
      title: 'Especialista em UX',
      x: 150,
      y: 150,
      width: 400,
      height: 300,
      z: 3,
      role: 'UX Designer',
      provider: 'opencode',
    }

    const html = renderToStaticMarkup(
      createElement(CanvasNodeInspector, {
        isOpen: true,
        onClose: vi.fn(),
        node: agentNode,
        providers: mockProviders,
        onUpdateRole: vi.fn(),
        onUpdateTitle: vi.fn(),
        onDisconnectLinks: vi.fn(),
      }),
    )

    expect(html).toContain('Especialista em UX')
    expect(html).toContain('UX Designer')
    expect(html).toContain('Papel (preset ou customizado)')
    expect(html).toContain('id="inspector-builtin-roles"')
    expect(html).toContain('Coordenador')
    expect(html).toContain('Implementação')
    expect(html).toContain('OpenCode')
    expect(html).toContain('Desconectar')
  })

  it('renderiza Squad Inspector com membros, objetivo, coordenador e collapse quando node=null (TASK-03C)', () => {
    const squad: CanvasSquad = {
      id: 'squad-42',
      title: 'Squad de Infraestrutura',
      objective: 'Configurar clusters e pipelines de CI/CD',
      coordinatorNodeId: 'agent-coord',
      memberNodeIds: ['agent-coord', 'agent-dev'],
      collapsed: false,
    }

    const member1: CanvasNode = {
      id: 'agent-coord',
      kind: 'agent',
      title: 'Tech Lead Infra',
      role: 'Coordenador',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      z: 1,
    }

    const member2: CanvasNode = {
      id: 'agent-dev',
      kind: 'agent',
      title: 'DevOps Engineer',
      role: 'SRE',
      x: 450,
      y: 0,
      width: 400,
      height: 300,
      z: 2,
    }

    const availableAgent: CanvasNode = {
      id: 'agent-free',
      kind: 'agent',
      title: 'QA Tester',
      role: 'Testes',
      x: 900,
      y: 0,
      width: 400,
      height: 300,
      z: 3,
    }

    const html = renderToStaticMarkup(
      createElement(CanvasNodeInspector, {
        isOpen: true,
        onClose: vi.fn(),
        node: null,
        squad,
        squadMembers: [member1, member2],
        availableAgentsForSquad: [availableAgent],
        onUpdateSquadTitle: vi.fn(),
        onUpdateSquadObjective: vi.fn(),
        onSetSquadCoordinator: vi.fn(),
        onAddSquadMember: vi.fn(),
        onRemoveSquadMember: vi.fn(),
        onToggleSquadCollapse: vi.fn(),
        onCreateAgentForSquad: vi.fn(),
      }),
    )

    // Cabeçalho e nome
    expect(html).toContain('Squad de Infraestrutura')
    expect(html).toContain('data-canvas-inspector=""')
    // Objetivo
    expect(html).toContain('Configurar clusters e pipelines de CI/CD')
    // Coordenador opcional
    expect(html).toContain('Coordenação da Squad')
    expect(html).toContain('Sem coordenador (avulso)')
    // Membros e papéis
    expect(html).toContain('Membros (2)')
    expect(html).toContain('Tech Lead Infra')
    expect(html).toContain('DevOps Engineer')
    expect(html).toContain('SRE')
    expect(html).toContain('Coordenador')
    // Ações de membro
    expect(html).toContain('Remover da squad')
    // Adicionar membro
    expect(html).toContain('Adicionar Membro à Squad')
    expect(html).toContain('QA Tester (Testes)')
    expect(html).toContain('Criar novo agente para a squad')
    // Collapse toggle
    expect(html).toContain('Recolher')
  })

  it('exibe abas de alternância Nó / Squad quando ambos são fornecidos ao Inspector', () => {
    const squad: CanvasSquad = {
      id: 'squad-1',
      title: 'Squad Mobile',
      memberNodeIds: ['agent-1'],
    }
    const agentNode: CanvasNode = {
      id: 'agent-1',
      kind: 'agent',
      title: 'Flutter Dev',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      z: 1,
      role: 'Mobile Lead',
    }

    const html = renderToStaticMarkup(
      createElement(CanvasNodeInspector, {
        isOpen: true,
        onClose: vi.fn(),
        node: agentNode,
        squad,
        squadMembers: [agentNode],
      }),
    )

    expect(html).toContain('role="tablist"')
    expect(html).toContain('Nó (Flutter Dev)')
    expect(html).toContain('Squad (Squad Mobile)')
  })

  it('sincroniza objetivo ao alternar de Squad A para Squad B sem vazar o objetivo anterior', () => {
    const squadA: CanvasSquad = {
      id: 'squad-a',
      title: 'Squad Alpha',
      objective: 'Objetivo da Squad Alpha',
      memberNodeIds: ['agent-1'],
    }
    const squadB: CanvasSquad = {
      id: 'squad-b',
      title: 'Squad Beta',
      objective: 'Objetivo da Squad Beta',
      memberNodeIds: ['agent-2'],
    }

    const htmlA = renderToStaticMarkup(
      createElement(CanvasNodeInspector, {
        isOpen: true,
        onClose: vi.fn(),
        node: null,
        squad: squadA,
      }),
    )
    expect(htmlA).toContain('Squad Alpha')
    expect(htmlA).toContain('Objetivo da Squad Alpha')
    expect(htmlA).not.toContain('Objetivo da Squad Beta')

    // Troca de Squad para Squad B
    const htmlB = renderToStaticMarkup(
      createElement(CanvasNodeInspector, {
        isOpen: true,
        onClose: vi.fn(),
        node: null,
        squad: squadB,
      }),
    )
    expect(htmlB).toContain('Squad Beta')
    expect(htmlB).toContain('Objetivo da Squad Beta')
    expect(htmlB).not.toContain('Objetivo da Squad Alpha')
  })

  it('filtra agentes que já são membros da squad ao listar opções em Adicionar Membro', () => {
    const memberAgent: CanvasNode = {
      id: 'agent-member-1',
      kind: 'agent',
      title: 'Agente Membro',
      role: 'Backend',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      z: 1,
    }
    const candidateAgent: CanvasNode = {
      id: 'agent-candidate-2',
      kind: 'agent',
      title: 'Agente Candidato',
      role: 'Frontend',
      x: 100,
      y: 100,
      width: 400,
      height: 300,
      z: 2,
    }

    const squad: CanvasSquad = {
      id: 'squad-filter-test',
      title: 'Squad Teste',
      memberNodeIds: ['agent-member-1'],
    }

    const html = renderToStaticMarkup(
      createElement(CanvasNodeInspector, {
        isOpen: true,
        onClose: vi.fn(),
        node: null,
        squad,
        squadMembers: [memberAgent],
        availableAgentsForSquad: [memberAgent, candidateAgent],
        onAddSquadMember: vi.fn(),
      }),
    )

    // A lista de membros exibe o membro atual
    expect(html).toContain('Agente Membro')
    // No seletor de adicionar membros, apenas o agente avulso é oferecido (o membro atual é excluído)
    const addMemberSection = html.slice(html.indexOf('inspector-add-member'))
    expect(addMemberSection).toContain('Agente Candidato (Frontend)')
    expect(addMemberSection).not.toContain('Agente Membro')
  })

  it('desabilita botão de remover e exibe indicação discreta quando squad possui apenas 1 membro', () => {
    const singleMember: CanvasNode = {
      id: 'agent-sole-1',
      kind: 'agent',
      title: 'Agente Único',
      role: 'Coordenador',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      z: 1,
    }

    const multiMember1: CanvasNode = {
      id: 'agent-multi-1',
      kind: 'agent',
      title: 'Agente Alpha',
      role: 'Coordenador',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      z: 1,
    }

    const multiMember2: CanvasNode = {
      id: 'agent-multi-2',
      kind: 'agent',
      title: 'Agente Beta',
      role: 'Implementação',
      x: 400,
      y: 0,
      width: 400,
      height: 300,
      z: 2,
    }

    const squadWithOne: CanvasSquad = {
      id: 'squad-one',
      title: 'Squad Solitária',
      memberNodeIds: ['agent-sole-1'],
    }

    const squadWithTwo: CanvasSquad = {
      id: 'squad-two',
      title: 'Squad Duo',
      memberNodeIds: ['agent-multi-1', 'agent-multi-2'],
    }

    // 1. Render com 1 membro: botão desabilitado e indicação discreta de restrição
    const htmlSingle = renderToStaticMarkup(
      createElement(CanvasNodeInspector, {
        isOpen: true,
        onClose: vi.fn(),
        node: null,
        squad: squadWithOne,
        squadMembers: [singleMember],
        onRemoveSquadMember: vi.fn(),
      }),
    )

    expect(htmlSingle).toContain('Membros (1)')
    expect(htmlSingle).toContain('Agente Único')
    // Botão disabled e com título explicativo
    expect(htmlSingle).toContain('disabled=""')
    expect(htmlSingle).toContain('A squad requer ao menos 1 membro ativo. O último membro não pode ser removido.')
    // Indicação discreta abaixo da lista
    expect(htmlSingle).toContain('canvas-inspector-restriction-hint')
    expect(htmlSingle).toContain('Squads exigem ao menos 1 membro ativo. O último membro não pode ser removido.')

    // 2. Render com 2 membros: botão habilitado e sem indicação de restrição
    const htmlMulti = renderToStaticMarkup(
      createElement(CanvasNodeInspector, {
        isOpen: true,
        onClose: vi.fn(),
        node: null,
        squad: squadWithTwo,
        squadMembers: [multiMember1, multiMember2],
        onRemoveSquadMember: vi.fn(),
      }),
    )

    expect(htmlMulti).toContain('Membros (2)')
    expect(htmlMulti).not.toContain('disabled=""')
    expect(htmlMulti).not.toContain('canvas-inspector-restriction-hint')
  })
})

describe('TASK-03B — CanvasNodeCard UI Component & Keep-Alive', () => {
  const baseCardProps = {
    isSelected: false,
    isConnecting: false,
    isConnectionTargetAvailable: false,
    isConfigOpen: false,
    quickDeployChips: [],
    terminalPresets: [],
    terminalDraft: null,
    terminalCommandHint: '',
    presetDraftName: '',
    presetSaveStatus: '',
    nodeMeta: mockNodeMeta,
    onSelect: vi.fn(),
    onStartPan: vi.fn(),
    onStartNodeDrag: vi.fn(),
    onStartResize: vi.fn(),
    onStartConnection: vi.fn(),
    onChooseConnectionSource: vi.fn(),
    onConnectNodes: vi.fn(),
    onDeleteNode: vi.fn(),
    onToggleConfig: vi.fn(),
    onDisconnectLinks: vi.fn(),
    onFocusNode: vi.fn(),
    onUpdateGeometry: vi.fn(),
    onUpdateTitle: vi.fn(),
    onUpdateRole: vi.fn(),
    onUpdateProvider: vi.fn(),
    onUpdateAccount: vi.fn(),
    onUpdateContent: vi.fn(),
    onSendTask: vi.fn(),
    onUpdateTerminalNode: vi.fn(),
    onSetTerminalDraftField: vi.fn(),
    onCommitTerminalFields: vi.fn(),
    onSetTerminalDraft: vi.fn(),
    onSetTerminalCommandHint: vi.fn(),
    onSetPresetDraftName: vi.fn(),
    onSetPresetSaveStatus: vi.fn(),
    onSavePreset: vi.fn(),
    onRenameCustomPreset: vi.fn(),
    onDeleteCustomPreset: vi.fn(),
  }

  it('renderiza card de agente com badges concisas e botões de ação rápida', () => {
    const agentNode: CanvasNode = {
      id: 'agent-1',
      kind: 'agent',
      title: 'Dev Agent',
      x: 100,
      y: 150,
      width: 480,
      height: 320,
      z: 5,
      role: 'Coordenador',
      provider: 'codex',
      account: 'account1',
    }

    const html = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: agentNode,
        agentProviders: mockProviders,
        renderAgent: () => createElement('div', { id: 'live-terminal-dom' }, 'XTERM_SESSION_ALIVE'),
      }),
    )

    expect(html).toContain('data-canvas-card="agent"')
    expect(html).toContain('Dev Agent')
    expect(html).toContain('canvas-role-pill')
    expect(html).toContain('Coordenador')
    expect(html).toContain('CODEX (C1)')
    expect(html).toContain('canvas-compact-toggle')
    expect(html).toContain('XTERM_SESSION_ALIVE')
  })

  it('renderiza coroa quando isSquadCoordinator é true mesmo com papel customizado', () => {
    const customAgent: CanvasNode = {
      id: 'agent-custom-coord',
      kind: 'agent',
      title: 'UX Lead',
      x: 100,
      y: 100,
      width: 400,
      height: 300,
      z: 1,
      role: 'UX Designer',
    }

    const html = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: customAgent,
        isSquadCoordinator: true,
      }),
    )

    expect(html).toContain('UX Designer')
    expect(html).toContain('title="Coordenador da squad"')
  })

  it('não renderiza coroa quando isSquadCoordinator é false mesmo se papel for Coordenador', () => {
    const nonCoordAgent: CanvasNode = {
      id: 'agent-not-coord',
      kind: 'agent',
      title: 'Membro com papel Coordenador',
      x: 100,
      y: 100,
      width: 400,
      height: 300,
      z: 1,
      role: 'Coordenador',
    }

    const html = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: nonCoordAgent,
        isSquadCoordinator: false,
      }),
    )

    expect(html).toContain('Coordenador')
    expect(html).not.toContain('title="Coordenador da squad"')
  })

  it('preserva montagem do terminal no DOM quando o card está recolhido (isCompact)', () => {
    const terminalNode: CanvasNode = {
      id: 'term-node-1',
      kind: 'terminal',
      title: 'Processo Ativo',
      x: 50,
      y: 50,
      width: 400,
      height: 250,
      z: 3,
      terminal: { presetId: 'shell', cwdMode: 'workspace', autoStart: false, restartBehavior: 'restart', monitorActivity: false },
    }

    const html = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: terminalNode,
        isCompact: true,
        renderTerminal: () => createElement('div', { id: 'live-pty-never-unmount' }, 'PTY_DATA_STREAMING'),
      }),
    )

    // O card tem as classes de compactação
    expect(html).toContain('is-compact')
    expect(html).toContain('data-is-compact="true"')
    expect(html).toContain('is-compact-hidden')
    // E CRUCIAL: o terminal NÃO foi desmontado do DOM!
    expect(html).toContain('id="live-pty-never-unmount"')
    expect(html).toContain('PTY_DATA_STREAMING')
  })

  it('engrenagem abre Inspector (com onOpenInspector) e NÃO renderiza overlay inline de agente', () => {
    const onOpenInspector = vi.fn()
    const onToggleConfig = vi.fn()
    const agentNode: CanvasNode = {
      id: 'agent-gear-test',
      kind: 'agent',
      title: 'Agente Engrenagem',
      x: 100,
      y: 100,
      width: 400,
      height: 300,
      z: 1,
      role: 'Implementação',
    }

    const html = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: agentNode,
        isConfigOpen: true,
        onOpenInspector,
        onToggleConfig,
      }),
    )

    // A engrenagem está presente
    expect(html).toContain('canvas-agent-config-toggle')
    // NÃO renderiza o overlay inline legado de configuração de agente
    expect(html).not.toContain('class="canvas-agent-config"')
    expect(html).not.toContain('id="agent-config-agent-gear-test"')
  })

  it('portas de conexão possuem classes corretas para visibilidade em repouso, seleção e conexão', () => {
    const agentNode: CanvasNode = {
      id: 'agent-ports-test',
      kind: 'agent',
      title: 'Agente Portas',
      x: 100,
      y: 100,
      width: 400,
      height: 300,
      z: 1,
      role: 'Implementação',
    }

    // 1. Estado de repouso: portas renderizadas, card sem is-selected nem is-connecting, porta alvo sem is-available
    const htmlDefault = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: agentNode,
        isSelected: false,
        isConnecting: false,
        isConnectionTargetAvailable: false,
      }),
    )
    expect(htmlDefault).toContain('canvas-port canvas-port-source')
    expect(htmlDefault).toContain('canvas-port canvas-port-target')
    expect(htmlDefault).not.toContain('workspace-canvas-card is-selected')
    expect(htmlDefault).not.toContain('workspace-canvas-card is-connecting')
    expect(htmlDefault).not.toContain('canvas-port-target is-available')

    // 2. Quando selecionado: card recebe classe is-selected (ativa visibilidade via CSS)
    const htmlSelected = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: agentNode,
        isSelected: true,
      }),
    )
    expect(htmlSelected).toContain('is-selected')

    // 3. Quando conectando: card recebe classe is-connecting
    const htmlConnecting = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: agentNode,
        isConnecting: true,
      }),
    )
    expect(htmlConnecting).toContain('is-connecting')

    // 4. Quando destino de conexão disponível: porta alvo recebe is-available
    const htmlTargetAvailable = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: agentNode,
        isConnectionTargetAvailable: true,
      }),
    )
    expect(htmlTargetAvailable).toContain('canvas-port canvas-port-target is-available')
  })

  it('toggle compacto funciona para expandir e recolher independente de isConfigOpen', () => {
    const agentNode: CanvasNode = {
      id: 'agent-compact-test',
      kind: 'agent',
      title: 'Agente Compacto Teste',
      x: 100,
      y: 100,
      width: 500,
      height: 360,
      z: 1,
      role: 'Implementação',
    }

    // Mesmo com isConfigOpen: true, se isCompact é true, o card permanece compacto
    const htmlCompact = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: agentNode,
        isCompact: true,
        isConfigOpen: true,
      }),
    )
    expect(htmlCompact).toContain('is-compact')
    expect(htmlCompact).toContain('data-is-compact="true"')
    expect(htmlCompact).toContain('width:320px')
    expect(htmlCompact).toContain('height:130px')

    // E quando isCompact é false, expande mesmo com isConfigOpen: true
    const htmlExpanded = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: agentNode,
        isCompact: false,
        isConfigOpen: true,
      }),
    )
    expect(htmlExpanded).toContain('data-is-compact="false"')
    expect(htmlExpanded).not.toContain('is-compact-hidden')
    expect(htmlExpanded).toContain('width:500px')
    expect(htmlExpanded).toContain('height:360px')
  })
})

describe('TASK-03B — AgentCreationDialog UI Component', () => {
  it('renderiza dialog com lista dinâmica de participantes em modo Squad', () => {
    const html = renderToStaticMarkup(
      createElement(AgentCreationDialog, {
        isOpen: true,
        mode: 'squad',
        providers: mockProviders,
        onClose: vi.fn(),
        onCreateAgent: vi.fn(),
        onCreateSquad: vi.fn(),
      }),
    )

    expect(html).toContain('Configurar Squad de Agentes')
    expect(html).toContain('Templates Rápidos de Squad')
    expect(html).toContain('Trio Ágil (Coord + Dev + Testes)')
    expect(html).toContain('Pair (Coord + Dev)')
    expect(html).toContain('Full Squad (Coord + Dev + Rev + Testes)')
    expect(html).toContain('Adicionar Participante')
    expect(html).toContain('Sem coordenador (avulso)')
    expect(html).toContain('Coordenação da Squad')
    expect(html).toContain('COORDENADOR')
    expect(html).toContain('placeholder="ex.: Backend, UX, Testes..."')
  })

  it('renderiza dialog em modo agente individual', () => {
    const html = renderToStaticMarkup(
      createElement(AgentCreationDialog, {
        isOpen: true,
        mode: 'agent',
        providers: mockProviders,
        onClose: vi.fn(),
        onCreateAgent: vi.fn(),
        onCreateSquad: vi.fn(),
      }),
    )

    expect(html).toContain('Configurar Agente')
    expect(html).toContain('Papel do Agente')
    expect(html).toContain('Provedor do agente')
    expect(html).toContain('Criar Agente')
  })
})

describe('TASK-03D — Resumo Conciso de Cards (~320x130) e Keep-Alive Operacional', () => {
  const baseCardProps = {
    isSelected: false,
    isConnecting: false,
    isConnectionTargetAvailable: false,
    isConfigOpen: false,
    quickDeployChips: [],
    terminalPresets: [],
    terminalDraft: null,
    terminalCommandHint: '',
    presetDraftName: '',
    presetSaveStatus: '',
    nodeMeta: mockNodeMeta,
    onSelect: vi.fn(),
    onStartPan: vi.fn(),
    onStartNodeDrag: vi.fn(),
    onStartResize: vi.fn(),
    onStartConnection: vi.fn(),
    onChooseConnectionSource: vi.fn(),
    onConnectNodes: vi.fn(),
    onDeleteNode: vi.fn(),
    onToggleConfig: vi.fn(),
    onDisconnectLinks: vi.fn(),
    onFocusNode: vi.fn(),
    onUpdateGeometry: vi.fn(),
    onUpdateTitle: vi.fn(),
    onUpdateRole: vi.fn(),
    onUpdateProvider: vi.fn(),
    onUpdateAccount: vi.fn(),
    onUpdateContent: vi.fn(),
    onSendTask: vi.fn(),
    onUpdateTerminalNode: vi.fn(),
    onSetTerminalDraftField: vi.fn(),
    onCommitTerminalFields: vi.fn(),
    onSetTerminalDraft: vi.fn(),
    onSetTerminalCommandHint: vi.fn(),
    onSetPresetDraftName: vi.fn(),
    onSetPresetSaveStatus: vi.fn(),
    onSavePreset: vi.fn(),
    onRenameCustomPreset: vi.fn(),
    onDeleteCustomPreset: vi.fn(),
  }

  it('agente nasce compacto por padrão com resumo útil, tarefa real, provider discreto e botões de ação', () => {
    const agentNode: CanvasNode = {
      id: 'agent-concise-1',
      kind: 'agent',
      title: 'Agente UI',
      x: 100,
      y: 100,
      width: 500,
      height: 360,
      z: 1,
      role: 'UX Designer',
      provider: 'opencode',
      content: 'Refatorar formulários do checkout',
    }

    const html = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: agentNode,
        agentProviders: mockProviders,
        progress: { state: 'running', label: 'Executando testes visuais' },
        renderAgent: () => createElement('div', { id: 'agent-pty-alive' }, 'AGENT_PROCESS_ALIVE'),
      }),
    )

    // O card inicia com classe is-compact e dimensões compactas 320x130
    expect(html).toContain('is-compact')
    expect(html).toContain('width:320px')
    expect(html).toContain('height:130px')
    expect(html).toContain('data-is-compact="true"')
    expect(html).toContain('data-canvas-summary="agent"')

    // Resumo conciso
    expect(html).toContain('UX Designer')
    expect(html).toContain('OPENCODE')
    expect(html).toContain('Executando testes visuais')
    expect(html).toContain('status-running')

    // Botões operacionais claros
    expect(html).toContain('Expandir terminal')
    expect(html).toContain('Inspector')

    // Sessão do terminal montada no DOM com ocultação segura
    expect(html).toContain('is-compact-hidden')
    expect(html).toContain('id="agent-pty-alive"')
    expect(html).toContain('AGENT_PROCESS_ALIVE')
  })

  it('exibe status factual "Configurado" quando progress é ausente e "Aguardando configuração" quando não configurado', () => {
    const configuredAgent: CanvasNode = {
      id: 'agent-configured',
      kind: 'agent',
      title: 'Dev Backend',
      x: 100,
      y: 100,
      width: 500,
      height: 360,
      z: 1,
      role: 'Implementação',
      provider: 'codex',
      account: 'account1',
    }

    const unconfiguredAgent: CanvasNode = {
      id: 'agent-unconfigured',
      kind: 'agent',
      title: 'Dev Sem Provider',
      x: 100,
      y: 100,
      width: 500,
      height: 360,
      z: 1,
      role: 'Implementação',
    }

    const htmlConfigured = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: configuredAgent,
        agentProviders: mockProviders,
      }),
    )
    expect(htmlConfigured).toContain('Configurado')
    expect(htmlConfigured).not.toContain('Pronto para tarefas')

    const htmlUnconfigured = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: unconfiguredAgent,
        agentProviders: mockProviders,
      }),
    )
    expect(htmlUnconfigured).toContain('Aguardando configuração')
  })

  it('terminal nasce compacto por padrão com preset, comando principal e status', () => {
    const termNode: CanvasNode = {
      id: 'term-concise-1',
      kind: 'terminal',
      title: 'Dev Server',
      x: 200,
      y: 200,
      width: 520,
      height: 340,
      z: 2,
      terminal: {
        presetId: 'npm',
        command: 'npm run dev',
        args: ['--host', '0.0.0.0'],
        cwdMode: 'workspace',
        autoStart: true,
        restartBehavior: 'restart',
        monitorActivity: false,
      },
    }

    const html = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: termNode,
        renderTerminal: () => createElement('div', { id: 'term-pty-alive' }, 'SERVER_STREAM_ACTIVE'),
      }),
    )

    expect(html).toContain('is-compact')
    expect(html).toContain('width:320px')
    expect(html).toContain('height:130px')
    expect(html).toContain('data-canvas-summary="terminal"')
    expect(html).toContain('npm run dev --host 0.0.0.0')
    expect(html).toContain('Auto-início')
    expect(html).toContain('Expandir terminal')
    expect(html).toContain('Inspector')

    // Terminal mantido no DOM
    expect(html).toContain('is-compact-hidden')
    expect(html).toContain('id="term-pty-alive"')
    expect(html).toContain('SERVER_STREAM_ACTIVE')
  })

  it('nota nasce expandida e suporta resumo leve quando compactada', () => {
    const noteNode: CanvasNode = {
      id: 'note-1',
      kind: 'note',
      title: 'Checklist do Release',
      content: '1. Validar e2e\n2. Atualizar changelog\n3. Tag v1.0.37',
      x: 50,
      y: 50,
      width: 330,
      height: 240,
      z: 1,
    }

    // 1. Por padrão, nota nasce expandida com textarea acessível
    const expandedHtml = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: noteNode,
      }),
    )
    expect(expandedHtml).toContain('data-is-compact="false"')
    expect(expandedHtml).toContain('class="workspace-canvas-card canvas-note"')
    expect(expandedHtml).not.toContain('data-canvas-summary="note"')
    expect(expandedHtml).toContain('width:330px')
    expect(expandedHtml).toContain('height:240px')
    expect(expandedHtml).toContain('data-canvas-note-editor=""')
    expect(expandedHtml).toContain('Checklist do Release')

    // 2. Quando compactada, exibe resumo leve
    const compactHtml = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: noteNode,
        isCompact: true,
      }),
    )
    expect(compactHtml).toContain('is-compact')
    expect(compactHtml).toContain('data-is-compact="true"')
    expect(compactHtml).toContain('data-canvas-summary="note"')
    expect(compactHtml).toContain('width:320px')
    expect(compactHtml).toContain('height:130px')
    expect(compactHtml).toContain('Nota rápida')
    expect(compactHtml).toContain('Expandir nota')
    expect(compactHtml).toContain('Inspector')
    // Editor continua montado no DOM
    expect(compactHtml).toContain('data-canvas-note-editor=""')
  })

  it('permite controle externo via props isCompact e ajusta dimensões visuais 320x130 sem mutar geometria original', () => {
    const agentNode: CanvasNode = {
      id: 'agent-controlled',
      kind: 'agent',
      title: 'Agente Controlado',
      x: 300,
      y: 100,
      width: 500,
      height: 360,
      z: 1,
      role: 'Implementação',
    }

    // Quando OpenCode força isCompact: false, renderiza expandido com node.width/node.height originais
    const expandedHtml = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: agentNode,
        isCompact: false,
        renderAgent: () => createElement('div', null, 'FULL_TERMINAL_VIEW'),
      }),
    )
    expect(expandedHtml).toContain('data-is-compact="false"')
    expect(expandedHtml).toContain('class="workspace-canvas-card canvas-agent"')
    expect(expandedHtml).not.toContain('data-canvas-summary="agent"')
    expect(expandedHtml).toContain('height:360px')
    expect(expandedHtml).toContain('width:500px')
    expect(expandedHtml).not.toContain('is-compact-hidden')

    // Quando OpenCode força isCompact: true, renderiza conciso com visual width: 320px e height: 130px
    const compactHtml = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: agentNode,
        isCompact: true,
      }),
    )
    expect(compactHtml).toContain('is-compact')
    expect(compactHtml).toContain('data-is-compact="true"')
    expect(compactHtml).toContain('data-canvas-summary="agent"')
    expect(compactHtml).toContain('width:320px')
    expect(compactHtml).toContain('height:130px')

    // A geometria original do objeto do nó não sofreu mutação
    expect(agentNode.width).toBe(500)
    expect(agentNode.height).toBe(360)
  })
})
