import { describe, expect, it } from 'vitest'
import {
  CANVAS_STATE_VERSION,
  TERMINAL_COMMAND_INVALID_HINT,
  buildQuickDeployChips,
  formatArgsInput,
  isTerminalCommandTextRejected,
  migrateCanvasNodesForTerminals,
  parseArgsInput,
  selectTerminalCommand,
  slugifyCustomPresetId,
  terminalNodeTitle,
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

  it('versão do esquema é 4', () => {
    expect(CANVAS_STATE_VERSION).toBe(4)
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
