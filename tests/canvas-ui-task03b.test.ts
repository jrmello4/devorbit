import { createElement, useState } from 'react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
    // Criação mantém texto curto; demais grupos são ícone + tooltip (clean pass)
    expect(html).toContain('Agente')
    expect(html).toContain('Terminal')
    expect(html).toContain('Nota')
    expect(html).toContain('Squad')
    expect(html).toContain('100%')
    expect(html).toContain('Perto')
    expect(html).toContain('Médio')
    expect(html).toContain('Longe')
    expect(html).toContain('aria-label="Focar nó selecionado"')
    expect(html).toContain('aria-label="Alternar painel de inspeção"')
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

    // Ícone + tooltip: quem identifica a ação é o aria-label preservado
    expect(html).toContain('aria-label="Conectar nós selecionados"')
    expect(html).toContain('aria-label="Desvincular nós"')
    expect(html).toContain('aria-label="Excluir 2 nó(s) selecionado(s)"')
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

  it('expõe os presets 25–150% como dropdown com marca no nível atual', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasToolbar, {
        zoom: 1.0,
        zoomLevels: [0.25, 0.5, 0.75, 1.0, 1.25, 1.5],
        onSetZoom: vi.fn(),
        onZoomIn: vi.fn(),
        onZoomOut: vi.fn(),
        onResetViewport: vi.fn(),
      }),
    )

    // Gatilho ▾ acessível e fechado por padrão (−/+ e % permanecem fora do menu)
    expect(html).toContain('aria-label="Escolher nível de zoom"')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="false"')
    // Menu popover com os 6 presets, oculto até abrir
    expect(html).toContain('role="menu"')
    expect(html).toContain('aria-label="Níveis de zoom"')
    expect(html).toContain('hidden=""')
    expect(html).toContain('title="Definir zoom para 25%"')
    expect(html).toContain('title="Definir zoom para 150%"')
    // Nível atual (100%) marcado com aria-checked
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="Zoom 100%"/)
    expect(html).toMatch(/aria-checked="false"[^>]*aria-label="Zoom 25%"/)
  })

  it('mantém Conectar sempre presente (desabilitado sem seleção) com estado ativo ao conectar', () => {
    const conectar = (props: Record<string, unknown>) =>
      renderToStaticMarkup(
        createElement(CanvasToolbar, {
          zoom: 1.0,
          onZoomIn: vi.fn(),
          onZoomOut: vi.fn(),
          onResetViewport: vi.fn(),
          ...props,
        }),
      ).match(/<button[^>]*aria-label="Conectar nós selecionados"[^>]*>/)?.[0] ?? ''

    // Sem seleção: botão visível porém desabilitado
    const idleHtml = conectar({ onStartConnection: vi.fn(), selectionCount: 0 })
    expect(idleHtml).toContain('disabled=""')

    // Conectando: estado ativo (aria-pressed)
    const activeHtml = conectar({
      onStartConnection: vi.fn(),
      selectionCount: 1,
      isConnecting: true,
    })
    expect(activeHtml).not.toContain('disabled=""')
    expect(activeHtml).toContain('aria-pressed="true"')
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
    // Clean pass: ponto + tooltip no lugar do texto de estado duplicado
    expect(html).toContain('title="Estado: running"')
    expect(html).not.toContain('canvas-inspector-status-sub')
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
    expect(html).toContain('Tema de cores')
    expect(html).toContain('id="terminal-theme-select"')
    expect(html).toContain('aria-label="Tema de cores do terminal"')
    expect(html).toContain('canvas-inspector-theme-swatches')
    expect(html).toContain('aria-label="Tema Carbon"')
    expect(html).toContain('aria-label="Tema Esmeralda"')
  })

  it('renderiza inspeção para nó do tipo Note sem contadores fora de foco', () => {
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
    // Clean pass: contadores só aparecem com o campo em foco
    expect(html).not.toContain('caracteres')
    expect(html).not.toContain('palavras')
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
    expect(html).toContain('Papel</label>')
    // Clean pass: ajuda longa virou tooltip no rótulo
    expect(html).toContain('title="Preset ou customizado"')
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
    // Clean pass: sem título redundante de visão geral e sem pills de papel
    expect(html).not.toContain('Visão Geral da Squad')
    expect(html).not.toContain('canvas-inspector-role-badge')
    // Objetivo
    expect(html).toContain('Configurar clusters e pipelines de CI/CD')
    // Coordenador opcional (rótulo curto + select)
    expect(html).toContain('id="squad-coordinator-select"')
    expect(html).toContain('Sem coordenador (avulso)')
    // Membros e papéis
    expect(html).toContain('Membros (2)')
    expect(html).toContain('Tech Lead Infra')
    expect(html).toContain('DevOps Engineer')
    expect(html).toContain('SRE')
    expect(html).toContain('Coordenador')
    // Ações de membro
    expect(html).toContain('Remover da squad')
    // Adicionar membro (linha dentro da seção de membros)
    expect(html).toContain('aria-label="Selecionar agente para adicionar à squad"')
    expect(html).toContain('QA Tester (Testes)')
    expect(html).toContain('>Adicionar</span>')
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
    isConnectMode: false,
    isConnectSource: false,
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
    onChooseConnectionSource: vi.fn(),
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
    // Clean pass: provedor com conta muda decisão — pill continua; papel e
    // provedor também viram tooltip no título (cabeçalho único de 28px).
    expect(html).toContain('CODEX (C1)')
    expect(html).toContain('title="Dev Agent · Papel: Coordenador · Provedor: CODEX (C1)"')
    expect(html).toContain('canvas-compact-toggle')
    expect(html).toContain('canvas-card-actions')
    expect(html).toContain('canvas-card-drag-handle')
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

  it('renderiza badge âmbar "orquestrando" no cabeçalho apenas durante orquestração ativa', () => {
    const coordinator: CanvasNode = {
      id: 'agent-orchestrating',
      kind: 'agent',
      title: 'Coordenador',
      x: 100,
      y: 100,
      width: 400,
      height: 300,
      z: 1,
      role: 'Coordenador',
    }

    // Sem orquestração: badge ausente
    const idleHtml = renderToStaticMarkup(
      createElement(CanvasNodeCard, { ...baseCardProps, node: coordinator }),
    )
    expect(idleHtml).not.toContain('canvas-node-orchestrating-badge')

    // Com orquestração ativa: badge presente e anunciado por role="status"
    const orchestratingHtml = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: coordinator,
        isOrchestrating: true,
      }),
    )
    expect(orchestratingHtml).toContain('canvas-node-orchestrating-badge')
    expect(orchestratingHtml).toContain('role="status"')
    // Clean pass: badge virou ponto âmbar + tooltip (sem texto no repouso)
    expect(orchestratingHtml).toContain('aria-label="Orquestrando"')
    expect(orchestratingHtml).toContain('title="Orquestração de squad ativa"')
    // Um único indicador de status: ponto de progresso não aparece junto
    expect(orchestratingHtml).not.toContain('canvas-agent-progress')
  })

  it('clean pass: papel padrão fica oculto (tooltip no título) e papel de especialista permanece visível', () => {
    const defaultRoleAgent: CanvasNode = {
      id: 'agent-role-default',
      kind: 'agent',
      title: 'Agente Padrão',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      z: 1,
      role: 'Implementação',
    }
    const specialistAgent: CanvasNode = {
      ...defaultRoleAgent,
      id: 'agent-role-specialist',
      title: 'Agente Especialista',
      role: 'Testes',
    }

    const defaultHtml = renderToStaticMarkup(
      createElement(CanvasNodeCard, { ...baseCardProps, node: defaultRoleAgent }),
    )
    // O span segue no DOM (contrato do harness), mas oculto via classe
    expect(defaultHtml).toContain('canvas-role-pill is-default-role')
    expect(defaultHtml).toContain('title="Agente Padrão · Papel: Implementação"')

    const specialistHtml = renderToStaticMarkup(
      createElement(CanvasNodeCard, { ...baseCardProps, node: specialistAgent }),
    )
    expect(specialistHtml).not.toContain('is-default-role')
    expect(specialistHtml).toContain('>Testes</span>')
  })

  it('clean pass: status do agente no cabeçalho é um ponto com tooltip, sem pill de texto', () => {
    const agentNode: CanvasNode = {
      id: 'agent-progress-dot',
      kind: 'agent',
      title: 'Agente com Progresso',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      z: 1,
      role: 'Implementação',
    }

    const html = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: agentNode,
        progress: { state: 'running', label: 'Executando testes visuais' },
      }),
    )

    expect(html).toMatch(/canvas-agent-progress progress-running/)
    expect(html).toContain('data-agent-progress="running"')
    expect(html).toContain('aria-label="Status: Executando testes visuais"')
    expect(html).toContain('title="Executando testes visuais"')
  })

  it('clean pass: pill de preset do terminal sai do repouso e vira tooltip no título', () => {
    const terminalNode: CanvasNode = {
      id: 'term-clean-header',
      kind: 'terminal',
      title: 'Shell do Projeto',
      x: 10,
      y: 10,
      width: 420,
      height: 280,
      z: 1,
      terminal: { presetId: 'shell', cwdMode: 'workspace', autoStart: false, restartBehavior: 'restart', monitorActivity: false },
    }

    const html = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: terminalNode,
        isCompact: false,
        renderTerminal: () => createElement('div', null, 'TERM'),
      }),
    )

    expect(html).not.toContain('canvas-terminal-pill')
    expect(html).toContain('title="Shell do Projeto · Preset: Shell"')
  })

  it('clean pass: nota sem contador de caracteres em repouso (vira tooltip no título)', () => {
    const noteNode: CanvasNode = {
      id: 'note-clean-header',
      kind: 'note',
      title: 'Checklist',
      content: 'Primeira linha da nota',
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      z: 1,
    }

    const html = renderToStaticMarkup(
      createElement(CanvasNodeCard, { ...baseCardProps, node: noteNode }),
    )

    expect(html).not.toContain('canvas-note-pill')
    expect(html).toContain('title="Checklist · 22 caracteres"')
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

  it('modo conectar: nenhuma porta/bolinha e classes de destaque corretas', () => {
    const agentNode: CanvasNode = {
      id: 'agent-connect-test',
      kind: 'agent',
      title: 'Agente Conectar',
      x: 100,
      y: 100,
      width: 400,
      height: 300,
      z: 1,
      role: 'Implementação',
    }

    // 1. Estado de repouso: NENHUMA porta em nenhum estado; card sem classes
    //    de conexão.
    const htmlDefault = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: agentNode,
        isSelected: false,
        isConnectMode: false,
        isConnectSource: false,
      }),
    )
    expect(htmlDefault).not.toContain('canvas-port')
    expect(htmlDefault).not.toContain('data-canvas-port')
    expect(htmlDefault).not.toContain('is-connect-mode')
    expect(htmlDefault).not.toContain('is-connect-source')
    expect(htmlDefault).not.toContain('is-selected')

    // 2. Modo conectar ativo: card elegível recebe is-connect-mode (contorno
    //    tracejado via CSS), sem porta alguma no DOM.
    const htmlConnectMode = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: agentNode,
        isConnectMode: true,
      }),
    )
    expect(htmlConnectMode).toContain('is-connect-mode')
    expect(htmlConnectMode).not.toContain('data-canvas-port')

    // 3. Card de ORIGEM: destaque firme (is-connect-source) vence o tracejado.
    const htmlSource = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: agentNode,
        isConnectMode: true,
        isConnectSource: true,
      }),
    )
    expect(htmlSource).toContain('is-connect-source')
    expect(htmlSource).not.toContain('is-connect-mode')
    expect(htmlSource).not.toContain('data-canvas-port')
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
    isConnectMode: false,
    isConnectSource: false,
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
    onChooseConnectionSource: vi.fn(),
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

  it('aplica atributos data-terminal-theme e variáveis de estilo para nó de terminal', () => {
    const terminalNode: CanvasNode = {
      id: 'term-theme-test',
      kind: 'terminal',
      title: 'Terminal Esmeralda',
      x: 100,
      y: 100,
      width: 400,
      height: 300,
      z: 1,
      terminal: {
        presetId: 'shell',
        theme: 'emerald',
        cwdMode: 'workspace',
        autoStart: false,
        restartBehavior: 'restart',
        monitorActivity: false,
      },
    }

    const html = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: terminalNode,
        isCompact: false,
        renderTerminal: () => createElement('div', null, 'TERM'),
      }),
    )

    expect(html).toContain('data-terminal-theme="emerald"')
    expect(html).toContain('--term-accent:#059669')
    expect(html).toContain('--term-bg:#0a130f')
  })

  it('renderiza o tema carbon como padrão no card de terminal quando theme não está definido', () => {
    const terminalNode: CanvasNode = {
      id: 'term-theme-default',
      kind: 'terminal',
      title: 'Terminal Padrão',
      x: 100,
      y: 100,
      width: 400,
      height: 300,
      z: 1,
      terminal: {
        presetId: 'shell',
        cwdMode: 'workspace',
        autoStart: false,
        restartBehavior: 'restart',
        monitorActivity: false,
      },
    }

    const html = renderToStaticMarkup(
      createElement(CanvasNodeCard, {
        ...baseCardProps,
        node: terminalNode,
        isCompact: false,
        renderTerminal: () => createElement('div', null, 'TERM'),
      }),
    )

    expect(html).toContain('data-terminal-theme="carbon"')
    expect(html).toContain('--term-accent:#8797b4')
    expect(html).toContain('--term-bg:#0d0f14')
  })
})

describe('Rodada 2 — grip de resize com CSS real e roda respeita conteúdo rolável', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const css = readFileSync(join(here, '../src/renderer/src/components/WorkspaceCanvas.css'), 'utf8')
  const canvasSource = readFileSync(join(here, '../src/renderer/src/components/WorkspaceCanvas.tsx'), 'utf8')

  it('o grip do markup (resize-handle) tem regra CSS própria com cursor de resize', () => {
    // Regressão: o markup usa .workspace-canvas-resize-handle, mas só existia
    // a regra órfã .workspace-canvas-resize — grip sem posição/cursor, e o
    // usuário nunca conseguia esticar o card.
    expect(css).toMatch(/\.workspace-canvas-resize-handle\s*{[^}]*cursor:\s*nwse-resize/s)
    expect(css).not.toContain('.workspace-canvas-resize {')
  })

  it('a roda do mouse rola o conteúdo dos cards (guard genérico de scroll)', () => {
    // Regressão: o guard antigo cobria só .workspace-canvas-card-content;
    // painéis roláveis novos (config de agente, squads) recebiam pan do fundo.
    expect(canvasSource).toContain('insideScrollableRegion')
    expect(canvasSource).toContain('scrollHeight > el.clientHeight')
  })
})

describe('Terminal do Agente no Inspector (mesmos campos do Smart Terminal)', () => {
  const baseAgent = {
    id: 'agent-term-1',
    kind: 'agent' as const,
    title: 'Dev OpenCode',
    x: 10,
    y: 10,
    width: 500,
    height: 360,
    z: 1,
    role: 'Implementação',
  }

  it('agente BYOK sem config mostra campos com placeholder do CLI padrão do provider', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasNodeInspector, {
        isOpen: true,
        onClose: vi.fn(),
        node: { ...baseAgent, provider: 'opencode' },
        onUpdateAgentTerminalNode: vi.fn(),
      }),
    )

    expect(html).toContain('Terminal do Agente')
    expect(html).toContain('id="agent-terminal-command-input"')
    expect(html).toContain('placeholder="opencode"')
    expect(html).toContain('Vazio inicia o CLI padrão do provedor (opencode)')
    expect(html).toContain('id="agent-terminal-args-input"')
    expect(html).toContain('name="agent-terminal-cwd-mode"')
  })

  it('agente custom sem CLI padrão pede comando explícito', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasNodeInspector, {
        isOpen: true,
        onClose: vi.fn(),
        node: { ...baseAgent, provider: 'custom' },
        onUpdateAgentTerminalNode: vi.fn(),
      }),
    )
    expect(html).toContain('Defina o comando do CLI personalizado')
  })

  it('reflete comando/argumentos/diretório salvos no nó do agente', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasNodeInspector, {
        isOpen: true,
        onClose: vi.fn(),
        node: {
          ...baseAgent,
          provider: 'gemini',
          terminal: {
            presetId: 'custom',
            command: 'gemini',
            args: ['--sandbox'],
            cwdMode: 'custom',
            cwd: 'C:\\work\\repo',
            autoStart: true,
            restartBehavior: 'restart',
            monitorActivity: false,
          },
        },
        onUpdateAgentTerminalNode: vi.fn(),
      }),
    )
    expect(html).toContain('value="gemini"')
    expect(html).toContain('value="--sandbox"')
    expect(html).toContain('value="C:\\work\\repo"')
    expect(html).toMatch(/name="agent-terminal-cwd-mode"[^>]*checked/)
  })

  it('agente codex exibe aviso de terminal gerenciado e NÃO mostra campos', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasNodeInspector, {
        isOpen: true,
        onClose: vi.fn(),
        node: { ...baseAgent, provider: 'codex', account: 'account2' },
        onUpdateAgentTerminalNode: vi.fn(),
      }),
    )
    expect(html).toContain('Gerenciado pelo DevOrbit (conta C2).')
    expect(html).toContain('data-agent-terminal="managed"')
    expect(html).not.toContain('agent-terminal-command-input')
    expect(html).not.toContain('Terminal do Agente')
  })
})
