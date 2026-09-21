import { describe, expect, it } from 'vitest'
import {
  CUSTOM_TERMINAL_PRESET_LIMIT,
  TERMINAL_PRESETS,
  createTerminalNodeConfig,
  getTerminalPreset,
  isTerminalPresetId,
  resolveTerminalLaunch,
  sanitizeCustomTerminalPreset,
  sanitizeCustomTerminalPresets,
  sanitizeTerminalNodeConfig,
  type CustomTerminalPreset,
  type TerminalNodeRuntimeConfig,
} from '../src/shared/terminal-presets'

function validPreset(overrides: Partial<CustomTerminalPreset> = {}): CustomTerminalPreset {
  return {
    id: 'custom:lint',
    name: 'Lint',
    command: 'npm',
    args: ['run', 'lint'],
    ...overrides,
  }
}

function nodeConfig(overrides: Partial<TerminalNodeRuntimeConfig> = {}): TerminalNodeRuntimeConfig {
  return {
    presetId: 'shell',
    cwdMode: 'workspace',
    autoStart: false,
    restartBehavior: 'restart',
    monitorActivity: false,
    ...overrides,
  }
}

describe('registry de presets builtin', () => {
  it('expõe exatamente os seis presets com os rótulos do produto', () => {
    expect(TERMINAL_PRESETS.map((preset) => preset.id)).toEqual([
      'shell',
      'codex',
      'claude',
      'opencode',
      'antigravity',
      'custom',
    ])
    expect(TERMINAL_PRESETS.map((preset) => preset.label)).toEqual([
      'Shell',
      'Codex',
      'Claude Code',
      'OpenCode',
      'Antigravity',
      'Personalizado',
    ])
  })

  it('mapeia antigravity para o providerId agy e marca codex como provider', () => {
    expect(getTerminalPreset('antigravity')?.providerId).toBe('agy')
    expect(getTerminalPreset('codex')?.kind).toBe('provider')
    expect(getTerminalPreset('codex')?.providerId).toBe('codex')
    expect(getTerminalPreset('custom')?.kind).toBe('command')
    expect(isTerminalPresetId('shell')).toBe(true)
    expect(isTerminalPresetId('powercmd')).toBe(false)
  })
})

describe('sanitizeCustomTerminalPreset', () => {
  it('mantém um preset válido com campos opcionais', () => {
    const preset = sanitizeCustomTerminalPreset({
      id: ' custom:dev-server ',
      name: '  Servidor de dev  ',
      icon: ' 🚀 ',
      command: ' npm ',
      args: ['run', 'dev'],
      resumeCommand: 'npm',
      resumeArgs: ['run', 'dev', '--resume'],
      defaultAutoStart: true,
      defaultMonitorActivity: true,
      defaultRestartBehavior: 'resume',
    })
    expect(preset).toEqual({
      id: 'custom:dev-server',
      name: 'Servidor de dev',
      icon: '🚀',
      command: 'npm',
      args: ['run', 'dev'],
      resumeCommand: 'npm',
      resumeArgs: ['run', 'dev', '--resume'],
      defaultAutoStart: true,
      defaultMonitorActivity: true,
      defaultRestartBehavior: 'resume',
    })
  })

  it('rejeita id sem o prefixo custom: e campos obrigatórios ausentes', () => {
    expect(sanitizeCustomTerminalPreset({ id: 'shell', name: 'X', command: 'x' })).toBeUndefined()
    expect(sanitizeCustomTerminalPreset({ id: 'Custom:maiu', name: 'X', command: 'x' })).toBeUndefined()
    expect(sanitizeCustomTerminalPreset({ id: 'custom:ok', name: '', command: 'x' })).toBeUndefined()
    expect(sanitizeCustomTerminalPreset({ id: 'custom:ok', name: 'Sem comando' })).toBeUndefined()
    expect(sanitizeCustomTerminalPreset('preset')).toBeUndefined()
    expect(sanitizeCustomTerminalPreset(null)).toBeUndefined()
  })

  it('rejeita comando com % ou ! (simetria com a guarda do cmd.exe)', () => {
    expect(sanitizeCustomTerminalPreset(validPreset({ command: 'npm%i' }))).toBeUndefined()
    expect(sanitizeCustomTerminalPreset(validPreset({ command: 'node!x' }))).toBeUndefined()
    // Arg inválido é descartado da lista; o restante é mantido.
    expect(sanitizeCustomTerminalPreset(validPreset({ args: ['ok', 'bad%arg'] }))?.args).toEqual(['ok'])
  })

  it('limita args a 16 entradas e descarta entradas inválidas', () => {
    const manyArgs = Array.from({ length: 20 }, (_, index) => `arg-${index}`)
    const preset = sanitizeCustomTerminalPreset(validPreset({ args: manyArgs }))
    expect(preset?.args).toHaveLength(16)
    // O sanitizador recebe unknown (fronteira IPC); entrada mal tipada é descartada.
    const mixedArgs = ['ok', 42, ''] as unknown as string[]
    expect(sanitizeCustomTerminalPreset(validPreset({ args: mixedArgs }))?.args).toEqual(['ok'])
  })

  it('só mantém resumeArgs quando resumeCommand é válido', () => {
    const withResume = sanitizeCustomTerminalPreset(validPreset({
      resumeCommand: 'npm',
      resumeArgs: ['run', 'dev'],
    }))
    expect(withResume?.resumeCommand).toBe('npm')
    expect(withResume?.resumeArgs).toEqual(['run', 'dev'])
    expect(sanitizeCustomTerminalPreset(validPreset({ resumeCommand: 'npm%bad', resumeArgs: ['x'] }))?.resumeCommand).toBeUndefined()
    expect(sanitizeCustomTerminalPreset(validPreset({ resumeArgs: ['x'] }))?.resumeArgs).toBeUndefined()
  })
})

describe('sanitizeCustomTerminalPresets', () => {
  it('deduplica por id, aplica o limite de 24 e devolve undefined para lista vazia', () => {
    expect(sanitizeCustomTerminalPresets([
      validPreset({ id: 'custom:a' }),
      validPreset({ id: 'custom:a', name: 'Duplicado' }),
      validPreset({ id: 'custom:b' }),
    ])).toEqual([validPreset({ id: 'custom:a' }), validPreset({ id: 'custom:b' })])

    const limit = CUSTOM_TERMINAL_PRESET_LIMIT
    const many = Array.from({ length: limit + 5 }, (_, index) => validPreset({ id: `custom:p${index}` }))
    const sanitized = sanitizeCustomTerminalPresets(many)
    expect(sanitized).toHaveLength(limit)
    expect(sanitized?.[0]?.id).toBe('custom:p0')

    expect(sanitizeCustomTerminalPresets([])).toBeUndefined()
    expect(sanitizeCustomTerminalPresets([validPreset({ command: '' })])).toBeUndefined()
    expect(sanitizeCustomTerminalPresets('presets')).toBeUndefined()
  })
})

describe('sanitizeTerminalNodeConfig', () => {
  it('normaliza lixo para os defaults shell/workspace', () => {
    expect(sanitizeTerminalNodeConfig('garbage')).toBeUndefined()
    expect(sanitizeTerminalNodeConfig({
      presetId: 42,
      cwdMode: 'bogus',
      autoStart: 'yes',
      restartBehavior: 'nope',
      monitorActivity: 0,
    })).toEqual({
      presetId: 'shell',
      cwdMode: 'workspace',
      autoStart: false,
      restartBehavior: 'restart',
      monitorActivity: true,
    })
  })

  it('só mantém cwd quando cwdMode é custom', () => {
    expect(sanitizeTerminalNodeConfig(nodeConfig({ cwdMode: 'custom', cwd: 'C:/projetos/app' }))?.cwd).toBe('C:/projetos/app')
    expect(sanitizeTerminalNodeConfig(nodeConfig({ cwdMode: 'workspace', cwd: 'C:/projetos/app' }))?.cwd).toBeUndefined()
    expect(sanitizeTerminalNodeConfig(nodeConfig({ cwdMode: 'custom', cwd: '   ' }))?.cwd).toBeUndefined()
  })

  it('mantém monitorActivity ligado por padrão e descarta comando inválido', () => {
    expect(sanitizeTerminalNodeConfig({ presetId: 'shell', cwdMode: 'workspace', autoStart: false, restartBehavior: 'restart' })?.monitorActivity).toBe(true)
    expect(sanitizeTerminalNodeConfig(nodeConfig({ monitorActivity: false }))?.monitorActivity).toBe(false)
    expect(sanitizeTerminalNodeConfig(nodeConfig({ command: 'npm%bad' }))?.command).toBeUndefined()
    expect(sanitizeTerminalNodeConfig(nodeConfig({ command: 'npm', args: ['run', 'dev'] }))?.args).toEqual(['run', 'dev'])
  })
})

describe('createTerminalNodeConfig', () => {
  it('provider não copia comando; preset do usuário copia comando e resume', () => {
    const codex = createTerminalNodeConfig(TERMINAL_PRESETS[1])
    expect(codex).toEqual({
      presetId: 'codex',
      cwdMode: 'workspace',
      autoStart: true,
      restartBehavior: 'restart',
      monitorActivity: true,
    })
    expect(codex.command).toBeUndefined()

    const node = createTerminalNodeConfig(validPreset({
      args: ['run', 'dev'],
      resumeCommand: 'npm',
      resumeArgs: ['run', 'dev'],
      defaultAutoStart: true,
      defaultMonitorActivity: false,
      defaultRestartBehavior: 'resume',
    }))
    expect(node).toEqual({
      presetId: 'custom:lint',
      cwdMode: 'workspace',
      autoStart: true,
      restartBehavior: 'resume',
      monitorActivity: false,
      command: 'npm',
      args: ['run', 'dev'],
      resumeCommand: 'npm',
      resumeArgs: ['run', 'dev'],
    })
  })

  it('clona args e resumeArgs em vez de compartilhar referência', () => {
    const preset = validPreset({ args: ['run'], resumeCommand: 'npm', resumeArgs: ['x'] })
    const node = createTerminalNodeConfig(preset)
    node.args?.push('injected')
    node.resumeArgs?.push('injected')
    expect(preset.args).toEqual(['run'])
    expect(preset.resumeArgs).toEqual(['x'])
  })
})

describe('resolveTerminalLaunch', () => {
  it('override do nó vence o comando do preset custom', () => {
    const resolved = resolveTerminalLaunch(
      nodeConfig({ presetId: 'custom:lint', command: 'node', args: ['server.js'] }),
      [validPreset({ command: 'npm', args: ['run', 'lint'] })]
    )
    expect(resolved.label).toBe('Lint')
    expect(resolved.kind).toBe('command')
    expect(resolved.command).toBe('node')
    expect(resolved.args).toEqual(['server.js'])
    expect(resolved.missing).toBeUndefined()
  })

  it('sem override usa o comando do preset custom', () => {
    const resolved = resolveTerminalLaunch(nodeConfig({ presetId: 'custom:lint' }), [validPreset()])
    expect(resolved.command).toBe('npm')
    expect(resolved.args).toEqual(['run', 'lint'])
  })

  it('presetId desconhecido marca missing e usa o id como rótulo', () => {
    const resolved = resolveTerminalLaunch(nodeConfig({ presetId: 'custom:apagado' }), [])
    expect(resolved.missing).toBe(true)
    expect(resolved.label).toBe('custom:apagado')
    expect(resolved.kind).toBe('command')
    expect(resolved.command).toBeUndefined()
  })

  it('preset provider mantém providerId e não resolve comando', () => {
    const resolved = resolveTerminalLaunch(nodeConfig({ presetId: 'codex', autoStart: true, monitorActivity: true }))
    expect(resolved.kind).toBe('provider')
    expect(resolved.providerId).toBe('codex')
    expect(resolved.command).toBeUndefined()
    expect(resolved.missing).toBeUndefined()
  })

  it('preset builtin de comando sem comando definido marca missing', () => {
    const resolved = resolveTerminalLaunch(nodeConfig({ presetId: 'custom' }))
    expect(resolved.kind).toBe('command')
    expect(resolved.label).toBe('Personalizado')
    expect(resolved.command).toBeUndefined()
    expect(resolved.missing).toBe(true)
  })

  it('propaga resume do nó com fallback para o preset custom', () => {
    const fromNode = resolveTerminalLaunch(
      nodeConfig({ presetId: 'custom:lint', resumeCommand: 'npm', resumeArgs: ['run', 'dev'] }),
      [validPreset()]
    )
    expect(fromNode.resumeCommand).toBe('npm')
    expect(fromNode.resumeArgs).toEqual(['run', 'dev'])

    const fromPreset = resolveTerminalLaunch(
      nodeConfig({ presetId: 'custom:lint' }),
      [validPreset({ resumeCommand: 'npm', resumeArgs: ['resume', 'x'] })]
    )
    expect(fromPreset.resumeCommand).toBe('npm')
    expect(fromPreset.resumeArgs).toEqual(['resume', 'x'])
  })
})
