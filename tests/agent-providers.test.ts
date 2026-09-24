import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppConfig } from '../src/renderer/src/types'
import {
  AGENT_CLI_PROVIDER_IDS,
  AGENT_CLI_PROVIDERS,
  resolveAgentProviderCommand,
  orderProvidersForTask,
  providerUnavailableError,
  buildAgentTurnEnv,
  resolveProviderInvocation,
} from '../src/main/agent-providers'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('provider catalog completeness', () => {
  it('opencode2 and command-code are in AGENT_CLI_PROVIDER_IDS', () => {
    expect(AGENT_CLI_PROVIDER_IDS).toContain('opencode2')
    expect(AGENT_CLI_PROVIDER_IDS).toContain('command-code')
  })

  it('AGENT_CLI_PROVIDERS has entries for all provider IDs', () => {
    for (const id of AGENT_CLI_PROVIDER_IDS) {
      expect(AGENT_CLI_PROVIDERS[id]).toBeDefined()
      expect(AGENT_CLI_PROVIDERS[id].id).toBe(id)
    }
  })

  it('opencode2 has correct definition', () => {
    const def = AGENT_CLI_PROVIDERS.opencode2
    expect(def.label).toBe('OpenCode 2')
    expect(def.aliases).toContain('opencode2')
    expect(def.aliases).toContain('opencode2.cmd')
    expect(def.aliases).toContain('opencode2.exe')
    expect(def.defaultCommand).toBe('opencode2.cmd')
  })

  it('command-code has correct definition with cmdc aliases', () => {
    const def = AGENT_CLI_PROVIDERS['command-code']
    expect(def.label).toBe('Command Code')
    expect(def.aliases).toContain('command-code')
    expect(def.aliases).toContain('cmdc')
    expect(def.aliases).toContain('cmdc.cmd')
    expect(def.aliases).toContain('cmdc.exe')
    expect(def.defaultCommand).toBe('cmdc.cmd')
  })

  it('existing providers are unchanged', () => {
    expect(AGENT_CLI_PROVIDERS.codex.label).toBe('Codex CLI')
    expect(AGENT_CLI_PROVIDERS.opencode.label).toBe('OpenCode')
    expect(AGENT_CLI_PROVIDERS.claude.label).toBe('Claude Code')
    expect(AGENT_CLI_PROVIDERS.gemini.label).toBe('Gemini CLI')
    expect(AGENT_CLI_PROVIDERS.aider.label).toBe('Aider')
    expect(AGENT_CLI_PROVIDERS.agy.label).toBe('Antigravity')
    expect(AGENT_CLI_PROVIDERS.custom.label).toBe('Outro CLI')
  })
})

describe('orderProvidersForTask', () => {
  it('opencode2 is an explicit provider — no fallback to other CLIs', () => {
    const ordered = orderProvidersForTask('opencode2', ['opencode2', 'claude'])
    expect(ordered).toEqual(['opencode2'])
  })

  it('command-code is an explicit provider — no fallback to other CLIs', () => {
    const ordered = orderProvidersForTask('command-code', ['command-code', 'agy'])
    expect(ordered).toEqual(['command-code'])
  })

  it('returns empty when preferred is not ready', () => {
    const ordered = orderProvidersForTask('opencode2', ['claude', 'gemini'])
    expect(ordered).toEqual([])
  })
})

describe('providerUnavailableError', () => {
  it('reports opencode2 as missing when not in health list', () => {
    const error = providerUnavailableError('opencode2', [
      { id: 'codex', state: 'ready' },
    ])
    expect(error).toBeDefined()
    expect(error?.provider).toBe('opencode2')
    expect(error?.code).toBe('provider-missing')
    expect(error?.message).toContain('OpenCode 2')
  })

  it('reports command-code as not-ready when present but missing', () => {
    const error = providerUnavailableError('command-code', [
      { id: 'command-code', state: 'missing' },
    ])
    expect(error).toBeDefined()
    expect(error?.provider).toBe('command-code')
    expect(error?.code).toBe('provider-not-ready')
  })

  it('returns undefined when provider is ready', () => {
    const error = providerUnavailableError('opencode2', [
      { id: 'opencode2', state: 'ready' },
    ])
    expect(error).toBeUndefined()
  })
})

describe('buildAgentTurnEnv', () => {
  it('opencode2 gets ANTHROPIC_API_KEY (same family as opencode)', () => {
    const env = buildAgentTurnEnv('opencode2', 'model', 'fast', undefined, {
      ANTHROPIC_API_KEY: 'sk-ant-test',
    })
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test')
    expect(env.DEVORBIT_MODEL).toBe('model')
  })

  it('command-code gets OPENAI_API_KEY (same family as codex)', () => {
    const env = buildAgentTurnEnv('command-code', 'model', 'fast', undefined, {
      OPENAI_API_KEY: 'sk-test',
    })
    expect(env.OPENAI_API_KEY).toBe('sk-test')
  })

  it('existing providers unchanged', () => {
    const claude = buildAgentTurnEnv('claude', 'm', 'fast', undefined, { ANTHROPIC_API_KEY: 'k' })
    expect(claude.ANTHROPIC_API_KEY).toBe('k')
    const codex = buildAgentTurnEnv('codex', 'm', 'fast', undefined, { OPENAI_API_KEY: 'k' })
    expect(codex.OPENAI_API_KEY).toBe('k')
  })
})

describe('resolveProviderInvocation', () => {
  it('opencode2 uses --model flag', () => {
    const inv = resolveProviderInvocation('opencode2', 'C:\\opencode2.cmd', 'claude-sonnet', 'fast')
    expect(inv.nativeArgs).toEqual(['--model', 'claude-sonnet'])
    expect(inv.command).toBe(process.env.ComSpec || 'cmd.exe')
    expect(inv.args).toContain('call')
    expect(inv.args).toContain('C:\\opencode2.cmd')
  })

  it('command-code uses --model flag', () => {
    const inv = resolveProviderInvocation('command-code', 'C:\\cmdc.cmd', 'gpt-4o', 'fast')
    expect(inv.nativeArgs).toEqual(['--model', 'gpt-4o'])
    expect(inv.command).toBe(process.env.ComSpec || 'cmd.exe')
    expect(inv.args).toContain('call')
  })
})

describe.skipIf(process.platform !== 'win32')('agent provider resolution (Windows)', () => {
  it('resolves a configured CLI path without reading or copying credentials', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-agent-provider-'))
    temporaryDirectories.push(root)
    const executable = path.join(root, 'OpenCode CLI', 'opencode.cmd')
    await fs.mkdir(path.dirname(executable), { recursive: true })
    await fs.writeFile(executable, '@echo off')

    const result = await resolveAgentProviderCommand(
      { customPaths: { opencode: executable } } as AppConfig,
      'opencode'
    )

    expect(result.path).toBe(executable)
    expect(result.message).toContain('autenticação é gerenciada pelo próprio CLI')
  })

  it('resolves opencode2 via custom path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-opencode2-'))
    temporaryDirectories.push(root)
    const executable = path.join(root, 'opencode2.cmd')
    await fs.writeFile(executable, '@echo off')

    const result = await resolveAgentProviderCommand(
      { customPaths: { opencode2: executable } } as AppConfig,
      'opencode2'
    )

    expect(result.path).toBe(executable)
    expect(result.message).toContain('OpenCode 2')
  })

  it('resolves command-code via custom path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-cmdc-'))
    temporaryDirectories.push(root)
    const executable = path.join(root, 'cmdc.cmd')
    await fs.writeFile(executable, '@echo off')

    const result = await resolveAgentProviderCommand(
      { customPaths: { commandCode: executable } } as AppConfig,
      'command-code'
    )

    expect(result.path).toBe(executable)
    expect(result.message).toContain('Command Code')
  })

  it('does not resolve shell expressions as custom agent commands', async () => {
    const result = await resolveAgentProviderCommand(
      { customPaths: { customAgent: 'agent.cmd & whoami' } } as AppConfig,
      'custom'
    )

    expect(result.path).toBeNull()
  })
})

describe.skipIf(process.platform !== 'win32')('provider path resolution determinística (Windows)', () => {
  /** Snapshot/restauração de env para os testes não dependerem da máquina. */
  const envSnapshot = new Map<string, string | undefined>()
  const ENV_KEYS = ['PATH', 'LOCALAPPDATA', 'USERPROFILE'] as const

  beforeEach(() => {
    envSnapshot.clear()
    for (const key of ENV_KEYS) envSnapshot.set(key, process.env[key])
  })

  afterEach(async () => {
    for (const [key, value] of envSnapshot) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    envSnapshot.clear()
  })

  it('resolve opencode2 via PATH com o diretório preparado EM PRIMEIRO (tmpdir antes do PATH real)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-opencode2-path-'))
    temporaryDirectories.push(root)
    const shim = path.join(root, 'opencode2.cmd')
    await fs.writeFile(shim, '@echo off')

    // Prepend (não substitui): where.exe devolve matches na ordem do PATH, e o
    // findOnPath usa o primeiro existente — o tmpdir vence qualquer instalação
    // real da máquina, tornando o caso determinístico.
    const savedPath = envSnapshot.get('PATH')
    process.env.PATH = `${root};${savedPath ?? ''}`

    const result = await resolveAgentProviderCommand({} as AppConfig, 'opencode2')

    // mkdtemp pode devolver o caminho na forma 8.3 (ADENIL~1.J) enquanto o
    // where.exe devolve a forma longa — compara pelo caminho real resolvido.
    expect(result.path).toBe(await fs.realpath(shim))
    expect(result.message).toContain('OpenCode 2')
  })

  it('resolve command-code via PATH (alias command-code) com o diretório preparado EM PRIMEIRO', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-cmdc-path-'))
    temporaryDirectories.push(root)
    const shim = path.join(root, 'command-code.cmd')
    await fs.writeFile(shim, '@echo off')

    const savedPath = envSnapshot.get('PATH')
    process.env.PATH = `${root};${savedPath ?? ''}`

    const result = await resolveAgentProviderCommand({} as AppConfig, 'command-code')

    expect(result.path).toBe(await fs.realpath(shim))
    expect(result.message).toContain('Command Code')
  })

  // LACUNA DOCUMENTADA (não enfraquecida): candidates de caminho conhecido
  // (LOCALAPPDATA/Program Files, ex. <LOCALAPPDATA>/command-code/bin/command-code.exe)
  // só são sondados DEPOIS do probe de alias via where.exe, e o probe usa
  // execFile SEM env explícito — o filho herda o bloco de ambiente ORIGINAL do
  // processo pai, então mutar process.env.PATH/LOCALAPPDATA não neutraliza o
  // PATH real (onde o where.exe em si também precisa viver). Isolar esse ramo
  // de forma determinística exigiria injetar a sonda (DI de findOnPath/alias)
  // na produção — fora do escopo desta contribuição (sem editar produção).
  // Cobertura equivalente: os dois casos PATH acima e o caso "custom path"
  // (absoluto → fileExists) fecham a resolução dos dois provedores sem
  // depender da máquina.

  it('custom sem comando configurado NÃO produz execução (path null, mensagem acionável)', async () => {
    // PATH não dá para neutralizar (herdado pelo filho, ver lacuna acima), mas
    // o contrato é observável: custom não tem aliases nem candidates — qualquer
    // resolução além do configured precisaria de execução, e o resultado é null
    // com mensagem acionável.
    const result = await resolveAgentProviderCommand({} as AppConfig, 'custom')

    expect(result.path).toBeNull()
    expect(result.message).toContain('Outro CLI ausente')
    expect(result.message).toContain('autenticação é gerenciada pelo próprio CLI')
  })
})
