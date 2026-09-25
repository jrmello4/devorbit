import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AI_MEMORY_AGENT_SETUP_TIMEOUT_MS,
  agentSetupReceiptPath,
  buildGeminiInstallHooksArgs,
  buildGeminiInstallMcpArgs,
  buildInstallHooksArgs,
  buildInstallMcpArgs,
  geminiAgentSetupReceiptPath,
  setupAgentIntegrations,
  setupGeminiAgentIntegrations,
  type AiMemoryAgentSetupFileSystem,
  type AiMemoryAgentSetupRunner,
} from '../src/main/ai-memory-agent-setup'

interface CliCall {
  binaryPath: string
  args: string[]
  options?: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv }
}

function createRunner(
  responder: (args: readonly string[]) => { code?: number | null; stdout?: string; stderr?: string } | 'throw' = () => ({ code: 0 })
): { runner: AiMemoryAgentSetupRunner; calls: CliCall[] } {
  const calls: CliCall[] = []
  const runner: AiMemoryAgentSetupRunner = async (binaryPath, args, options) => {
    calls.push({ binaryPath, args: [...args], ...(options ? { options } : {}) })
    const result = responder(args)
    if (result === 'throw') throw new Error('spawn falhou')
    return { code: result.code ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
  return { runner, calls }
}

function createMemoryFs(): {
  fs: AiMemoryAgentSetupFileSystem
  files: Map<string, string>
  stats: { reads: number; writes: number; mkdirs: number }
  failReceiptWrite: { value: boolean }
} {
  const files = new Map<string, string>()
  const stats = { reads: 0, writes: 0, mkdirs: 0 }
  const failReceiptWrite = { value: false }
  const key = (value: string): string => path.resolve(value).toLowerCase()
  const missing = (): NodeJS.ErrnoException => {
    const error = new Error('ENOENT') as NodeJS.ErrnoException
    error.code = 'ENOENT'
    return error
  }
  const fs: AiMemoryAgentSetupFileSystem = {
    readFile: async (filePath) => {
      stats.reads += 1
      const value = files.get(key(filePath))
      if (value === undefined) throw missing()
      return value
    },
    writeFile: async (filePath, data) => {
      stats.writes += 1
      if (failReceiptWrite.value && filePath.includes('agent-setup')) throw new Error('disk full')
      files.set(key(filePath), data)
    },
    mkdir: async () => {
      stats.mkdirs += 1
    },
    rename: async (from, to) => {
      const value = files.get(key(from))
      if (value === undefined) throw missing()
      files.delete(key(from))
      files.set(key(to), value)
    },
    rm: async (filePath) => {
      files.delete(key(filePath))
    },
  }
  return { fs, files, stats, failReceiptWrite }
}

const USER_DATA = path.join('C:', 'users', 'dev', 'AppData', 'Roaming', 'DevOrbit')
const IDENTITY = 'git-common-dir:abc123'

/**
 * Normalização portável para chaves do mock fs: replica EXATAMENTE o `key()`
 * de createMemoryFs (path.resolve + lowercase). No POSIX, `path.resolve`
 * prefixa caminhos ao estilo Windows com o cwd — as asserções que usavam só
 * `.toLowerCase()` divergiam da chave gravada pelo mock e liam `undefined`
 * (receipt "vazia") no CI Linux/macOS. Mesma função nos dois lados = fixture
 * portável sem mudar produção.
 */
const receiptKey = (value: string): string => path.resolve(value).toLowerCase()
const BINARY = 'C:\\bin\\ai-memory.exe'

function baseRequest(overrides: Partial<Parameters<typeof setupGeminiAgentIntegrations>[0]> = {}) {
  return { optedIn: true, binaryPath: BINARY, identity: IDENTITY, ...overrides }
}

describe('ai-memory agent setup — comandos e contrato v2.4.0 (Gemini CLI)', () => {
  it('opt-out: nenhum subprocesso e nenhum acesso a disco', async () => {
    const { runner, calls } = createRunner()
    const memory = createMemoryFs()
    const result = await setupGeminiAgentIntegrations(
      baseRequest({ optedIn: false }),
      { userDataDir: USER_DATA, runCli: runner, fileSystem: memory.fs }
    )
    expect(result).toEqual({ status: 'skipped-opt-out', mcp: 'skipped', hooks: 'skipped' })
    expect(calls).toHaveLength(0)
    expect(memory.stats).toEqual({ reads: 0, writes: 0, mkdirs: 0 })
  })

  it('emite os comandos exatos com --data-dir, argv separado e opções seguras', async () => {
    const { runner, calls } = createRunner()
    const memory = createMemoryFs()
    const result = await setupGeminiAgentIntegrations(
      baseRequest({ dataDir: 'C:\\data\\ai-memory', cwd: 'C:\\proj' }),
      { userDataDir: USER_DATA, runCli: runner, fileSystem: memory.fs }
    )

    expect(result).toMatchObject({ status: 'installed', mcp: 'installed', hooks: 'installed' })
    expect(calls.map((call) => call.args)).toEqual([
      ['--data-dir', 'C:\\data\\ai-memory', 'install-mcp', '--client', 'gemini-cli', '--apply'],
      [
        '--data-dir',
        'C:\\data\\ai-memory',
        'install-hooks',
        '--agent',
        'gemini-cli',
        '--apply',
        '--capture-mode',
        'allowlist',
      ],
    ])
    for (const call of calls) {
      expect(call.binaryPath).toBe(BINARY)
      expect(call.options?.timeout).toBe(AI_MEMORY_AGENT_SETUP_TIMEOUT_MS)
      expect(call.options?.cwd).toBe('C:\\proj')
    }
  })

  it('sem dataDir os comandos base não incluem --data-dir', () => {
    expect(buildGeminiInstallMcpArgs()).toEqual(['install-mcp', '--client', 'gemini-cli', '--apply'])
    expect(buildGeminiInstallHooksArgs()).toEqual([
      'install-hooks',
      '--agent',
      'gemini-cli',
      '--apply',
      '--capture-mode',
      'allowlist',
    ])
  })

  it('grava receipt por identidade e retorna already-installed na segunda chamada', async () => {
    const { runner, calls } = createRunner()
    const memory = createMemoryFs()
    const deps = { userDataDir: USER_DATA, runCli: runner, fileSystem: memory.fs }

    const first = await setupGeminiAgentIntegrations(baseRequest(), deps)
    expect(first.status).toBe('installed')
    expect(calls).toHaveLength(2)

    const receiptPath = receiptKey(geminiAgentSetupReceiptPath(USER_DATA, IDENTITY))
    const receipt = JSON.parse(memory.files.get(receiptPath) ?? '{}') as Record<string, unknown>
    expect(receipt).toMatchObject({ version: 1, client: 'gemini-cli', agent: 'gemini-cli' })
    expect(JSON.stringify(receipt)).not.toContain(IDENTITY) // só o hash, nunca a identidade crua

    const second = await setupGeminiAgentIntegrations(baseRequest(), deps)
    expect(second.status).toBe('already-installed')
    expect(calls).toHaveLength(2) // nenhum subprocesso novo
  })

  it('force reexecuta mesmo com receipt presente', async () => {
    const { runner, calls } = createRunner()
    const memory = createMemoryFs()
    const deps = { userDataDir: USER_DATA, runCli: runner, fileSystem: memory.fs }
    await setupGeminiAgentIntegrations(baseRequest(), deps)
    await setupGeminiAgentIntegrations(baseRequest({ force: true }), deps)
    expect(calls).toHaveLength(4)
  })

  it('falha graceful: um passo falha → degraded, outro passo ainda é tentado, sem receipt', async () => {
    const { runner, calls } = createRunner((args) =>
      args.includes('install-mcp') ? { code: 1, stderr: 'boom' } : { code: 0 }
    )
    const memory = createMemoryFs()
    const result = await setupGeminiAgentIntegrations(baseRequest(), {
      userDataDir: USER_DATA,
      runCli: runner,
      fileSystem: memory.fs,
    })

    expect(result).toMatchObject({ status: 'degraded', mcp: 'failed', hooks: 'installed' })
    expect(result.message).toContain('install-mcp')
    expect(calls).toHaveLength(2)
    expect(memory.files.has(receiptKey(geminiAgentSetupReceiptPath(USER_DATA, IDENTITY)))).toBe(false)
  })

  it('runner que lança não derruba: degraded, sem throw', async () => {
    const { runner } = createRunner(() => 'throw')
    const memory = createMemoryFs()
    await expect(
      setupGeminiAgentIntegrations(baseRequest(), { userDataDir: USER_DATA, runCli: runner, fileSystem: memory.fs })
    ).resolves.toMatchObject({ status: 'degraded', mcp: 'failed', hooks: 'failed' })
  })

  it('não registra tokens/env no message (redigido e limitado)', async () => {
    const { runner } = createRunner(() => ({
      code: 1,
      stderr: 'Authorization: Bearer supersecret-token-123 and apiKey sk-abcdef123456789',
    }))
    const memory = createMemoryFs()
    const result = await setupGeminiAgentIntegrations(baseRequest(), {
      userDataDir: USER_DATA,
      runCli: runner,
      fileSystem: memory.fs,
    })
    expect(result.status).toBe('degraded')
    expect(result.message).not.toContain('supersecret-token-123')
    expect(result.message).not.toContain('sk-abcdef123456789')
    expect(result.message).not.toContain('Bearer')
  })

  it('receipt corrompida é tratada como ausente (reexecuta com segurança)', async () => {
    const memory = createMemoryFs()
    memory.files.set(receiptKey(geminiAgentSetupReceiptPath(USER_DATA, IDENTITY)), '{ corrompida')
    const { runner, calls } = createRunner()
    const result = await setupGeminiAgentIntegrations(baseRequest(), {
      userDataDir: USER_DATA,
      runCli: runner,
      fileSystem: memory.fs,
    })
    expect(result.status).toBe('installed')
    expect(calls).toHaveLength(2)
  })

  it('falha ao gravar receipt → degraded, mas passos reportados como instalados', async () => {
    const { runner } = createRunner()
    const memory = createMemoryFs()
    memory.failReceiptWrite.value = true
    const result = await setupGeminiAgentIntegrations(baseRequest(), {
      userDataDir: USER_DATA,
      runCli: runner,
      fileSystem: memory.fs,
    })
    expect(result).toMatchObject({ status: 'degraded', mcp: 'installed', hooks: 'installed' })
    expect(result.message).toContain('receipt')
  })

  it('binaryPath/identity ausentes → degraded sem subprocesso', async () => {
    const { runner, calls } = createRunner()
    const memory = createMemoryFs()
    const result = await setupGeminiAgentIntegrations(
      { optedIn: true, binaryPath: '', identity: '' },
      { userDataDir: USER_DATA, runCli: runner, fileSystem: memory.fs }
    )
    expect(result.status).toBe('degraded')
    expect(calls).toHaveLength(0)
  })
})

describe('setup por provider — matriz v2.4.0 (MCP + hooks)', () => {
  it('codex/claude/command-code/antigravity/opencode/opencode2: install-mcp --client <c> --apply + install-hooks --agent <a> --apply --capture-mode allowlist', async () => {
    for (const [provider, client, agent] of [
      ['codex', 'codex', 'codex'],
      ['claude', 'claude-code', 'claude-code'],
      ['command-code', 'command-code', 'command-code'],
      ['agy', 'antigravity-cli', 'antigravity-cli'],
      ['opencode', 'opencode', 'opencode'],
      ['opencode2', 'opencode2', 'opencode2'],
    ] as const) {
      const { runner, calls } = createRunner()
      const memory = createMemoryFs()
      const result = await setupAgentIntegrations(
        baseRequest({ provider, dataDir: 'C:\\data\\ai-memory' }),
        { userDataDir: USER_DATA, runCli: runner, fileSystem: memory.fs }
      )
      expect(result).toMatchObject({ status: 'installed', mcp: 'installed', hooks: 'installed' })
      expect(calls.map((call) => call.args)).toEqual([
        ['--data-dir', 'C:\\data\\ai-memory', 'install-mcp', '--client', client, '--apply'],
        [
          '--data-dir',
          'C:\\data\\ai-memory',
          'install-hooks',
          '--agent',
          agent,
          '--apply',
          '--capture-mode',
          'allowlist',
        ],
      ])
      expect(memory.files.get(receiptKey(agentSetupReceiptPath(USER_DATA, { provider, identity: IDENTITY, client })))).toBeDefined()
    }
  })

  it('opencode/opencode2: executa ambos subprocessos (mcp + hooks allowlist) e grava receipt com agent', async () => {
    for (const [provider, client, agent] of [
      ['opencode', 'opencode', 'opencode'],
      ['opencode2', 'opencode2', 'opencode2'],
    ] as const) {
      const { runner, calls } = createRunner()
      const memory = createMemoryFs()
      const result = await setupAgentIntegrations(
        baseRequest({ provider, dataDir: 'C:\\data\\ai-memory' }),
        { userDataDir: USER_DATA, runCli: runner, fileSystem: memory.fs }
      )
      expect(result).toMatchObject({
        status: 'installed',
        mcp: 'installed',
        hooks: 'installed',
      })
      expect(calls.map((call) => call.args)).toEqual([
        ['--data-dir', 'C:\\data\\ai-memory', 'install-mcp', '--client', client, '--apply'],
        [
          '--data-dir',
          'C:\\data\\ai-memory',
          'install-hooks',
          '--agent',
          agent,
          '--apply',
          '--capture-mode',
          'allowlist',
        ],
      ])
      const receiptPath = agentSetupReceiptPath(USER_DATA, { provider, identity: IDENTITY, client })
      const rawReceipt = memory.files.get(receiptKey(receiptPath))
      expect(rawReceipt).toBeDefined()
      const parsed = JSON.parse(rawReceipt!)
      expect(parsed).toMatchObject({
        version: 1,
        provider,
        client,
        agent,
      })
    }
  })

  it('aider/custom: unsupported — nenhum subprocesso, nenhum receipt', async () => {
    for (const provider of ['aider', 'custom']) {
      const { runner, calls } = createRunner()
      const memory = createMemoryFs()
      const result = await setupAgentIntegrations(
        baseRequest({ provider }),
        { userDataDir: USER_DATA, runCli: runner, fileSystem: memory.fs }
      )
      expect(result).toMatchObject({ status: 'unsupported', mcp: 'skipped', hooks: 'skipped' })
      expect(calls).toHaveLength(0)
      expect(memory.stats.writes).toBe(0)
    }
  })

  it('opt-out por provider não executa nada', async () => {
    const { runner, calls } = createRunner()
    const memory = createMemoryFs()
    const result = await setupAgentIntegrations(
      baseRequest({ provider: 'codex', optedIn: false }),
      { userDataDir: USER_DATA, runCli: runner, fileSystem: memory.fs }
    )
    expect(result).toEqual({ status: 'skipped-opt-out', mcp: 'skipped', hooks: 'skipped' })
    expect(calls).toHaveLength(0)
    expect(memory.stats).toEqual({ reads: 0, writes: 0, mkdirs: 0 })
  })

  it('codex: env do subprocesso contém SOMENTE o CAMINHO do CODEX_HOME (sem tokens) e receipt é por conta', async () => {
    const { runner, calls } = createRunner()
    const memory = createMemoryFs()
    const conta1 = path.resolve('perfis', '.codex-conta1')
    const conta2 = path.resolve('perfis', '.codex-conta2')

    const first = await setupAgentIntegrations(
      baseRequest({ provider: 'codex', codexHome: conta1, dataDir: 'C:\\data\\ai-memory' }),
      { userDataDir: USER_DATA, runCli: runner, fileSystem: memory.fs }
    )
    expect(first.status).toBe('installed')
    for (const call of calls) {
      expect(call.options?.env).toEqual({ CODEX_HOME: conta1 })
    }
    const receipt1 = JSON.parse(
      memory.files.get(
        receiptKey(agentSetupReceiptPath(USER_DATA, { provider: 'codex', identity: IDENTITY, codexHome: conta1, client: 'codex' }))
      ) ?? '{}'
    ) as Record<string, unknown>
    expect(receipt1).toMatchObject({ version: 1, provider: 'codex', client: 'codex', agent: 'codex', account: '.codex-conta1' })
    expect(JSON.stringify(receipt1)).not.toContain(IDENTITY)
    expect(JSON.stringify(receipt1)).not.toContain(conta1)

    // Conta 2 ≠ conta 1: receipt distinta → NOVA instalação (isolamento por conta).
    const second = await setupAgentIntegrations(
      baseRequest({ provider: 'codex', codexHome: conta2, dataDir: 'C:\\data\\ai-memory' }),
      { userDataDir: USER_DATA, runCli: runner, fileSystem: memory.fs }
    )
    expect(second.status).toBe('installed')
    expect(calls).toHaveLength(4) // 2 passos por conta

    // Mesma conta de novo → already-installed, zero subprocessos novos.
    const third = await setupAgentIntegrations(
      baseRequest({ provider: 'codex', codexHome: conta1, dataDir: 'C:\\data\\ai-memory' }),
      { userDataDir: USER_DATA, runCli: runner, fileSystem: memory.fs }
    )
    expect(third.status).toBe('already-installed')
    expect(calls).toHaveLength(4)
  })

  it('idempotência por provider: segunda chamada não repete subprocessos', async () => {
    for (const provider of ['codex', 'claude', 'command-code', 'agy', 'opencode', 'opencode2']) {
      const { runner, calls } = createRunner()
      const memory = createMemoryFs()
      const deps = { userDataDir: USER_DATA, runCli: runner, fileSystem: memory.fs }
      await setupAgentIntegrations(baseRequest({ provider }), deps)
      const afterFirst = calls.length
      expect(afterFirst).toBe(2)
      const second = await setupAgentIntegrations(baseRequest({ provider }), deps)
      expect(second.status).toBe('already-installed')
      expect(calls).toHaveLength(afterFirst)
    }
  })

  it('falha no install-hooks do codex → degraded, install-mcp executado, SEM receipt (retry possível)', async () => {
    const { runner, calls } = createRunner((args) =>
      args.includes('install-hooks') ? { code: 1, stderr: 'boom' } : { code: 0 }
    )
    const memory = createMemoryFs()
    const result = await setupAgentIntegrations(
      baseRequest({ provider: 'codex', codexHome: 'C:\\perfis\\.codex-conta1' }),
      { userDataDir: USER_DATA, runCli: runner, fileSystem: memory.fs }
    )
    expect(result).toMatchObject({ status: 'degraded', mcp: 'installed', hooks: 'failed' })
    expect(calls).toHaveLength(2)
    expect(
      memory.files.get(
        receiptKey(agentSetupReceiptPath(USER_DATA, { provider: 'codex', identity: IDENTITY, codexHome: 'C:\\perfis\\.codex-conta1', client: 'codex' }))
      )
    ).toBeUndefined()
  })

  it('builders genéricos: aliases e flags exatos por provider', () => {
    expect(buildInstallMcpArgs('codex', 'D:\\d')).toEqual(['--data-dir', 'D:\\d', 'install-mcp', '--client', 'codex', '--apply'])
    expect(buildInstallHooksArgs('codex', 'D:\\d')).toEqual(['--data-dir', 'D:\\d', 'install-hooks', '--agent', 'codex', '--apply', '--capture-mode', 'allowlist'])
    expect(buildInstallMcpArgs('claude')).toEqual(['install-mcp', '--client', 'claude-code', '--apply'])
    expect(buildInstallHooksArgs('cmdc')).toEqual(['install-hooks', '--agent', 'command-code', '--apply', '--capture-mode', 'allowlist'])
    expect(buildInstallHooksArgs('opencode')).toEqual(['install-hooks', '--agent', 'opencode', '--apply', '--capture-mode', 'allowlist'])
    expect(buildInstallHooksArgs('opencode2')).toEqual(['install-hooks', '--agent', 'opencode2', '--apply', '--capture-mode', 'allowlist'])
    expect(buildInstallMcpArgs('opencode2')).toEqual(['install-mcp', '--client', 'opencode2', '--apply'])
    expect(buildInstallMcpArgs('aider')).toEqual(['install-mcp', '--client', 'gemini-cli', '--apply'])
  })
})
