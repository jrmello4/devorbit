import { describe, expect, it } from 'vitest'
import {
  CANVAS_EDGE_KINDS,
  CANVAS_STATE_VERSION,
  LEGACY_CANVAS_EDGE_KIND,
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
  selectTerminalCommand,
  slugifyCustomPresetId,
  terminalNodeTitle,
  isCustomTerminalPresetId,
  deleteCustomTerminalPreset,
  renameCustomTerminalPreset,
} from '../src/renderer/src/components/terminal-node-helpers'
import { TERMINAL_PRESETS } from '../src/shared/terminal-presets'

describe('migração do canvas para terminais (v3 → v4)', () => {
  it('nós antigos sem terminal permanecem sem terminal', () => {
    const migrated = migrateCanvasNodesForTerminals([
      { kind: 'note' },
      { kind: 'agent' },
    ])
    expect(migrated).toEqual([{ kind: 'note' }, { kind: 'agent' }])
  })

  it('migração é não-destrutiva: payload realista de v3 atravessa intacto', () => {
    const agente = {
      id: 'note-abc123',
      kind: 'agent',
      title: 'Agente: Implementação',
      x: 420,
      y: 260,
      width: 500,
      height: 360,
      z: 7,
      content: 'Resultado anterior da tarefa',
      role: 'Implementação',
      account: 'account2',
      provider: 'codex',
    }
    const nota = {
      id: 'note-xyz',
      kind: 'note',
      title: 'Handoff',
      x: 40,
      y: 40,
      width: 330,
      height: 240,
      z: 2,
      content: '# Objetivo',
    }
    const [migratedAgent, migratedNote] = migrateCanvasNodesForTerminals([agente, nota])
    expect(migratedAgent).toEqual(agente)
    expect(migratedAgent?.id).toBe('note-abc123')
    expect(migratedAgent?.title).toBe('Agente: Implementação')
    expect(migratedAgent?.x).toBe(420)
    expect(migratedAgent?.y).toBe(260)
    expect(migratedAgent?.width).toBe(500)
    expect(migratedAgent?.height).toBe(360)
    expect(migratedAgent?.z).toBe(7)
    expect(migratedAgent?.content).toBe('Resultado anterior da tarefa')
    expect(migratedAgent?.role).toBe('Implementação')
    expect(migratedAgent?.account).toBe('account2')
    expect(migratedAgent?.provider).toBe('codex')
    expect(migratedNote).toEqual(nota)
  })

  it('nó terminal: config saneada e demais campos preservados', () => {
    const terminalNode = {
      id: 'note-term1',
      kind: 'terminal',
      title: 'Codex',
      x: 100,
      y: 200,
      width: 520,
      height: 340,
      z: 9,
      terminal: {
        presetId: 'codex',
        cwdMode: 'custom',
        cwd: 'C:\\projetos\\demo',
        autoStart: true,
        restartBehavior: 'restart',
        monitorActivity: true,
      },
    }
    const [migrated] = migrateCanvasNodesForTerminals([terminalNode])
    expect(migrated?.id).toBe('note-term1')
    expect(migrated?.title).toBe('Codex')
    expect(migrated?.x).toBe(100)
    expect(migrated?.y).toBe(200)
    expect(migrated?.width).toBe(520)
    expect(migrated?.height).toBe(340)
    expect(migrated?.z).toBe(9)
    expect(migrated?.terminal).toEqual(terminalNode.terminal)
  })

  it('nó terminal com campo terminal não-objeto sai sem terminal, sem perder o nó', () => {
    // A config de objeto sempre saneia para defaults (presetId vira 'shell');
    // apenas lixo não-objeto (string, ausente) é descartado — e o resto do nó
    // permanece.
    const migrated = migrateCanvasNodesForTerminals([
      { kind: 'terminal', terminal: 'lixo', title: 'Meu terminal' },
      { kind: 'terminal' },
      null,
    ] as unknown as Parameters<typeof migrateCanvasNodesForTerminals>[0])
    expect(migrated[0]?.terminal).toBeUndefined()
    expect(migrated[0]?.title).toBe('Meu terminal')
    expect(migrated[1]?.terminal).toBeUndefined()
    expect(migrated[2]?.terminal).toBeUndefined()
  })

  it('config de objeto com campos inválidos saneia para defaults de shell', () => {
    const migrated = migrateCanvasNodesForTerminals([
      { kind: 'terminal', terminal: { presetId: 42, cwdMode: 'qualquer', autoStart: 'sim' } },
    ])
    expect(migrated[0]?.terminal).toEqual({
      presetId: 'shell',
      cwdMode: 'workspace',
      autoStart: false,
      restartBehavior: 'restart',
      monitorActivity: true,
    })
  })

  it('versão do esquema é 5 com leitura de v2–v5', () => {
    expect(CANVAS_STATE_VERSION).toBe(5)
    expect([...READABLE_CANVAS_VERSIONS]).toEqual([2, 3, 4, 5])
  })
})

describe('migração do canvas v4 → v5 (squads independentes e arestas tipadas)', () => {
  it('aresta antiga sem tipo recebe o default legado sem perder id/from/to', () => {
    const state = migrateCanvasStateV5({
      connections: [{ id: 'l1', from: 'note-a', to: 'agent-b' }],
      squads: [],
    })
    expect(state.connections).toEqual([
      { id: 'l1', from: 'note-a', to: 'agent-b', kind: 'flow' },
    ])
  })

  it('aresta v5 com tipo semântico atravessa intacta (idempotente)', () => {
    const state = migrateCanvasStateV5({
      connections: [{ id: 'l1', from: 'note-a', to: 'squad:s1', kind: 'membership', label: 'objetivo' }],
      squads: [],
    })
    expect(state.connections).toEqual([
      { id: 'l1', from: 'note-a', to: 'squad:s1', kind: 'membership', label: 'objetivo' },
    ])
  })

  it('squad v4 ganha objetivo vazio, coordenador ausente, membros e collapse sem perder campos', () => {
    const state = migrateCanvasStateV5({
      connections: [],
      squads: [{ id: 's1', title: 'Antigo', coordinatorNodeId: 'a', memberNodeIds: ['a', 'b'] }],
    })
    expect(state.squads).toEqual([
      {
        id: 's1',
        title: 'Antigo',
        objective: '',
        coordinatorNodeId: 'a',
        memberNodeIds: ['a', 'b'],
        collapsed: false,
      },
    ])
  })

  it('squad sem coordenador migra sem inventar promoção e não descarta layout', () => {
    const state = migrateCanvasStateV5({
      version: 5,
      connections: [],
      squads: [{ id: 's1', title: 'Livre', memberNodeIds: ['a', 'b', 'c'], objective: 'meta', collapsed: true }],
    })
    expect(state.squads).toEqual([
      {
        id: 's1',
        title: 'Livre',
        objective: 'meta',
        coordinatorNodeId: null,
        memberNodeIds: ['a', 'b', 'c'],
        collapsed: true,
      },
    ])
  })

  it('payload não-array vira lista vazia sem lançar', () => {
    expect(migrateCanvasStateV5({ connections: 'lixo', squads: null })).toEqual({
      connections: [],
      squads: [],
    })
  })
})

describe('tipos semânticos de aresta', () => {
  it('tipo ausente ou inválido cai no default legado flow', () => {
    expect(defaultCanvasEdgeKind(undefined)).toBe(LEGACY_CANVAS_EDGE_KIND)
    expect(defaultCanvasEdgeKind('inventado')).toBe('flow')
    expect(defaultCanvasEdgeKind('membership')).toBe('membership')
  })

  it('somente flow/delegation/dependency impõem ordenação', () => {
    expect(isOrderingEdgeKind('flow')).toBe(true)
    expect(isOrderingEdgeKind('delegation')).toBe(true)
    expect(isOrderingEdgeKind('dependency')).toBe(true)
    expect(isOrderingEdgeKind('coordination')).toBe(false)
    expect(isOrderingEdgeKind('membership')).toBe(false)
    expect(isOrderingEdgeKind('context')).toBe(false)
    expect(isOrderingEdgeKind('result')).toBe(false)
    expect(isOrderingEdgeKind('visual')).toBe(false)
  })

  it('catálogo cobre coordenação, vínculo, delegação, dependência, contexto e resultado', () => {
    expect([...CANVAS_EDGE_KINDS]).toEqual([
      'flow',
      'coordination',
      'membership',
      'delegation',
      'dependency',
      'context',
      'result',
      'visual',
    ])
    expect(canvasEdgeLabel('membership')).toBe('Vínculo do squad')
    expect(canvasEdgeLabel('coordination', '  ')).toBe('Coordenação')
    expect(canvasEdgeLabel('delegation', 'fazer X')).toBe('fazer X')
  })
})

describe('chips do Quick Deploy', () => {
  it('lista os seis presets embutidos na ordem compartilhada', () => {
    const chips = buildQuickDeployChips()
    expect(chips.map((chip) => chip.id)).toEqual(TERMINAL_PRESETS.map((preset) => preset.id))
    expect(chips).toHaveLength(6)
    expect(chips[0]?.label).toBe('Shell')
  })

  it('anexa presets personalizados depois dos embutidos', () => {
    const chips = buildQuickDeployChips([
      { id: 'custom:lint', name: 'Lint', command: 'npm', args: ['run', 'lint'], icon: '🧹' },
    ])
    expect(chips).toHaveLength(7)
    const custom = chips[6]
    expect(custom?.id).toBe('custom:lint')
    expect(custom?.label).toBe('Lint')
    expect(custom?.icon).toBe('🧹')
    expect(custom?.description).toBe('npm run lint')
    expect(custom?.preset).toEqual({ id: 'custom:lint', name: 'Lint', command: 'npm', args: ['run', 'lint'], icon: '🧹' })
  })

  it('descrição de preset sem argumentos é só o comando', () => {
    const chips = buildQuickDeployChips([{ id: 'custom:a', name: 'A', command: 'htop' }])
    expect(chips[6]?.description).toBe('htop')
  })
})

describe('título do nó de terminal', () => {
  it('usa o rótulo do preset embutido', () => {
    const codex = TERMINAL_PRESETS.find((preset) => preset.id === 'codex')
    expect(codex && terminalNodeTitle(codex)).toBe('Codex')
  })

  it('usa o nome do preset personalizado', () => {
    expect(terminalNodeTitle({ id: 'custom:x', name: 'Meu comando', command: 'x' })).toBe('Meu comando')
  })

  it('deduplica com sufixo numérico', () => {
    const codex = TERMINAL_PRESETS.find((preset) => preset.id === 'codex')
    expect(codex && terminalNodeTitle(codex, ['Codex'])).toBe('Codex 2')
    expect(codex && terminalNodeTitle(codex, ['Codex', 'codex 2'])).toBe('Codex 3')
    expect(codex && terminalNodeTitle(codex, ['Outro'])).toBe('Codex')
  })

  it('nome vazio cai em "Terminal"', () => {
    expect(terminalNodeTitle({ id: 'custom:x', name: '   ', command: 'x' })).toBe('Terminal')
  })
})

describe('parser do campo de argumentos', () => {
  it('divide por espaço em branco e devolve undefined para vazio', () => {
    expect(parseArgsInput('--model gpt-5')).toEqual(['--model', 'gpt-5'])
    expect(parseArgsInput('   ')).toBeUndefined()
    expect(parseArgsInput('')).toBeUndefined()
  })

  it('aspas duplas agrupam argumentos com espaço', () => {
    expect(parseArgsInput('--prompt "olá mundo" --deep')).toEqual(['--prompt', 'olá mundo', '--deep'])
    expect(parseArgsInput('"só um"')).toEqual(['só um'])
  })

  it('aspas não fechadas ainda devolvem o conteúdo parcial', () => {
    expect(parseArgsInput('"incompleto')).toEqual(['incompleto'])
  })
})

describe('slug de preset personalizado', () => {
  it('normaliza acentos, espaços e maiúsculas com prefixo custom:', () => {
    expect(slugifyCustomPresetId('Meu Comando!')).toBe('custom:meu-comando')
    expect(slugifyCustomPresetId('Ação Rápida')).toBe('custom:acao-rapida')
  })

  it('limita o slug a 48 caracteres e corta hifens das bordas', () => {
    const slug = slugifyCustomPresetId('a'.repeat(60))
    expect(slug).toBe('custom:' + 'a'.repeat(48))
    expect(slugifyCustomPresetId('  --nome--  ')).toBe('custom:nome')
  })

  it('resolve colisão com sufixo numérico', () => {
    expect(slugifyCustomPresetId('Lint', ['custom:lint'])).toBe('custom:lint-2')
    expect(slugifyCustomPresetId('Lint', ['custom:lint', 'custom:lint-2'])).toBe('custom:lint-3')
  })

  it('devolve vazio quando não há caractere aproveitável', () => {
    expect(slugifyCustomPresetId('!!!')).toBe('')
    expect(slugifyCustomPresetId('')).toBe('')
  })
})

describe('seleção de comando para start (primário vs retomada)', () => {
  const resolvido = {
    command: 'npm run dev',
    args: ['--port', '3000'],
    resumeCommand: 'codex resume',
    resumeArgs: ['--last'],
    restartBehavior: 'resume' as const,
  }

  it('primeiro start (auto-start/mount) NUNCA usa o comando de retomada', () => {
    expect(selectTerminalCommand(resolvido, false)).toEqual({
      command: 'npm run dev',
      args: ['--port', '3000'],
    })
  })

  it('reinício com restartBehavior resume usa o par de retomada', () => {
    expect(selectTerminalCommand(resolvido, true)).toEqual({
      command: 'codex resume',
      args: ['--last'],
    })
  })

  it('resume sem resumeCommand definido cai no comando primário', () => {
    const semResume = { ...resolvido, resumeCommand: undefined, resumeArgs: undefined }
    expect(selectTerminalCommand(semResume, true)).toEqual({
      command: 'npm run dev',
      args: ['--port', '3000'],
    })
  })

  it('restartBehavior restart/shell nunca retoma, mesmo com allowResume', () => {
    expect(
      selectTerminalCommand({ ...resolvido, restartBehavior: 'restart' }, true),
    ).toEqual({ command: 'npm run dev', args: ['--port', '3000'] })
    expect(
      selectTerminalCommand({ ...resolvido, restartBehavior: 'shell' }, true),
    ).toEqual({ command: 'npm run dev', args: ['--port', '3000'] })
  })

  it('retomada sem resumeArgs herda os argumentos primários', () => {
    const comResume = { ...resolvido, resumeArgs: undefined }
    expect(selectTerminalCommand(comResume, true)).toEqual({
      command: 'codex resume',
      args: ['--port', '3000'],
    })
  })
})

describe('validação de texto do comando (rascunho do painel)', () => {
  it('aceita texto normal e vazio (limpar é intenção válida)', () => {
    expect(isTerminalCommandTextRejected('npm run dev')).toBe(false)
    expect(isTerminalCommandTextRejected('')).toBe(false)
    expect(isTerminalCommandTextRejected('   ')).toBe(false)
  })

  it('rejeita %, ! e caracteres de controle — os alvos do sanitize compartilhado', () => {
    expect(isTerminalCommandTextRejected('npm run dev %PATH%')).toBe(true)
    expect(isTerminalCommandTextRejected('echo "!bang"')).toBe(true)
    expect(isTerminalCommandTextRejected('cmd\x00del')).toBe(true)
    expect(isTerminalCommandTextRejected('linha\nnova')).toBe(true)
  })

  it('rejeita comando acima de 512 caracteres', () => {
    expect(isTerminalCommandTextRejected('a'.repeat(512))).toBe(false)
    expect(isTerminalCommandTextRejected('a'.repeat(513))).toBe(true)
  })

  it('expõe o aviso curto em pt-BR', () => {
    expect(TERMINAL_COMMAND_INVALID_HINT).toBe('Caracteres não permitidos: % !')
  })
})

describe('formatação dos argumentos para o campo de texto', () => {
  it('reponde aspas em argumentos com espaço (round-trip estável)', () => {
    const texto = formatArgsInput(['--prompt', 'olá mundo', '--deep'])
    expect(texto).toBe('--prompt "olá mundo" --deep')
    expect(parseArgsInput(texto)).toEqual(['--prompt', 'olá mundo', '--deep'])
  })

  it('lista vazia ou ausente vira string vazia', () => {
    expect(formatArgsInput([])).toBe('')
    expect(formatArgsInput(undefined)).toBe('')
  })
})

describe('ciclo de vida de presets personalizados (renomear e excluir)', () => {
  const customPresets = [
    { id: 'custom:meu-servidor', name: 'Meu Servidor', command: 'npm start' },
    { id: 'custom:testes', name: 'Testes', command: 'npm test' },
  ]

  it('identifica corretamente presets customizados vs nativos', () => {
    expect(isCustomTerminalPresetId('custom:meu-servidor')).toBe(true)
    expect(isCustomTerminalPresetId('custom:outro')).toBe(true)
    expect(isCustomTerminalPresetId('shell')).toBe(false)
    expect(isCustomTerminalPresetId('codex')).toBe(false)
    expect(isCustomTerminalPresetId('dev-server')).toBe(false)
  })

  it('exclui preset customizado existente', () => {
    const res = deleteCustomTerminalPreset(customPresets, 'custom:meu-servidor')
    expect(res.error).toBeUndefined()
    expect(res.deleted?.name).toBe('Meu Servidor')
    expect(res.presets).toHaveLength(1)
    expect(res.presets[0].id).toBe('custom:testes')
  })

  it('bloqueia exclusão de preset nativo', () => {
    const res = deleteCustomTerminalPreset(customPresets, 'shell')
    expect(res.error).toBe('Não é permitido excluir presets nativos do sistema.')
    expect(res.presets).toHaveLength(2)
  })

  it('renomeia preset customizado com sucesso', () => {
    const res = renameCustomTerminalPreset(customPresets, 'custom:meu-servidor', 'Servidor de Produção')
    expect(res.error).toBeUndefined()
    expect(res.updated?.name).toBe('Servidor de Produção')
    expect(res.presets.find((p) => p.id === 'custom:meu-servidor')?.name).toBe('Servidor de Produção')
  })

  it('bloqueia renomeação de preset nativo', () => {
    const res = renameCustomTerminalPreset(customPresets, 'codex', 'Novo Codex')
    expect(res.error).toBe('Não é permitido renomear presets nativos do sistema.')
  })

  it('rejeita nome vazio ao renomear', () => {
    const res = renameCustomTerminalPreset(customPresets, 'custom:meu-servidor', '   ')
    expect(res.error).toBe('O nome do preset não pode ser vazio.')
  })

  it('rejeita colisão com nome de outro preset customizado existente', () => {
    const res = renameCustomTerminalPreset(customPresets, 'custom:meu-servidor', 'testes')
    expect(res.error).toBe('Já existe outro preset com este nome.')
  })
})
