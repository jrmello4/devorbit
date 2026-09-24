import fsSync from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  finalizeAiMemorySession,
  generateWorkstreamId,
  prepareAiMemoryLaunch,
  resolveAiMemoryHarness,
  resolveAiMemoryAgentChoice,
  resolveAiMemoryDataDir,
  resolveAiMemoryUserDataDir,
  resolveExecutableForRust,
  ensureAllowlistCaptureMode,
  installHarnessAllowlistHooks,
  clearActiveAiMemorySessions,
  registerActiveAiMemorySession,
  getActiveAiMemorySession,
  setGlobalAiMemoryService,
  getGlobalAiMemoryService,
  drainPendingAiMemoryFinalizations,
  releaseAiMemoryReservation,
  rollbackAiMemoryLaunch,
  rollbackAiMemorySession,
  removeActiveAiMemorySession,
  isScopeActiveOrPreparing,
  getPendingScopeReservation,
  isCommandCodeAgent,
  resolveExplicitFinalizeAgent,
  hasParallelCommandCodeSessions,
  AI_MEMORY_CAPTURE_MODE_FILE,
  type AiMemoryLauncherDeps,
  type AiMemoryLaunchContext,
} from '../src/main/ai-memory-launcher'
import type { AiMemoryStatus, AiMemoryMarkerWriteResult } from '../src/shared/ai-memory-contract'
import type {
  AiMemoryAgentSetupDeps,
  AiMemoryAgentSetupRequest,
  AiMemoryAgentSetupResult,
} from '../src/main/ai-memory-agent-setup'

describe('ai-memory-launcher', () => {
  beforeEach(() => {
    clearActiveAiMemorySessions()
  })

  describe('resolveExecutableForRust (Windows shim safety)', () => {
    it('passa .exe direto sem modificação', () => {
      const result = resolveExecutableForRust('C:\\bin\\opencode.exe')
      expect(result).toBe('C:\\bin\\opencode.exe')
    })

    it('passa caminho non-Windows sem modificação', () => {
      const result = resolveExecutableForRust('/usr/bin/opencode')
      expect(result).toBe('/usr/bin/opencode')
    })

    it('retorna .exe irmão quando existe ao lado do script .cmd', () => {
      const statSpy = vi.spyOn(fsSync, 'statSync').mockReturnValue({ isFile: () => true } as any)
      try {
        // Simulação win32 completa em qualquer host: o seam de isAbsolute
        // existe justamente para essa semântica — path.isAbsolute do HOST
        // (POSIX no CI) trata 'C:\cli\...' como relativo e desviaria cedo.
        // statSync segue mockado; o resultado é o literal Windows.
        const result = resolveExecutableForRust('C:\\cli\\opencode.cmd', {
          platform: 'win32',
          isAbsolute: path.win32.isAbsolute,
        })
        expect(result).toBe('C:\\cli\\opencode.exe')
      } finally {
        statSpy.mockRestore()
      }
    })

    it('retorna o próprio .cmd diretamente sem embrulhar em cmd.exe quando não há .exe irmão', () => {
      // Em testes sem .exe correspondente no filesystem, retorna o caminho do .cmd diretamente
      const result = resolveExecutableForRust('C:\\Users\\test\\opencode.cmd', { platform: 'win32' })
      expect(result).toBe('C:\\Users\\test\\opencode.cmd')
      expect(result).not.toContain('cmd.exe')
      expect(result).not.toContain('/c')
    })

    it('retorna o próprio .bat diretamente sem cmd.exe', () => {
      const result = resolveExecutableForRust('D:\\tools\\codex.bat', { platform: 'win32' })
      expect(result).toBe('D:\\tools\\codex.bat')
      expect(result).not.toContain('cmd.exe')
    })

    it('retorna o próprio .com diretamente sem cmd.exe', () => {
      const result = resolveExecutableForRust('C:\\bin\\tool.com', { platform: 'win32' })
      expect(result).toBe('C:\\bin\\tool.com')
      expect(result).not.toContain('cmd.exe')
    })

    it('caminho RELATIVO preserva o valor e não investiga .exe no cwd (Shell #3)', () => {
      const statSpy = vi.fn(() => ({ isFile: () => true }))
      const result = resolveExecutableForRust('opencode.cmd', {
        platform: 'win32',
        isAbsolute: () => false,
        statSync: statSpy,
      })
      expect(result).toBe('opencode.cmd')
      expect(statSpy).not.toHaveBeenCalled()
    })

    it('caminho ABSOLUTO prioriza .exe irmão (determinístico e portável)', () => {
      const statSpy = vi.fn(() => ({ isFile: () => true }))
      const cmd = path.join(path.sep, 'cli', 'opencode.cmd')
      const sibling = path.join(path.dirname(cmd), 'opencode.exe')
      const result = resolveExecutableForRust(cmd, {
        platform: 'win32',
        isAbsolute: () => true,
        statSync: statSpy,
      })
      expect(result).toBe(sibling)
      expect(statSpy).toHaveBeenCalledWith(sibling, { throwIfNoEntry: false })
    })

    it('caminho ABSOLUTO sem .exe irmão devolve o .cmd direto (sem cmd.exe)', () => {
      const cmd = path.join(path.sep, 'cli', 'opencode.cmd')
      const result = resolveExecutableForRust(cmd, {
        platform: 'win32',
        isAbsolute: () => true,
        statSync: () => undefined,
      })
      expect(result).toBe(cmd)
      expect(result).not.toContain('cmd.exe')
    })
  })

  describe('resolveAiMemoryDataDir/UserDataDir (sem fallback para ~/.devorbit)', () => {
    it('construtor puro: base userDataDir → <base>/ai-memory/data e <base>', () => {
      expect(resolveAiMemoryDataDir('C:\\u')).toBe(path.join('C:\\u', 'ai-memory', 'data'))
      expect(resolveAiMemoryUserDataDir('C:\\u')).toBe('C:\\u')
      expect(resolveAiMemoryDataDir('C:\\u')).not.toContain('.devorbit')
    })
  })

  describe('prepareAiMemoryLaunch — Gemini CLI usa hooks + MCP (sem ai-memory run)', () => {
    const geminiScope = {
      workspace: 'devorbit',
      project: 'my-project',
      identity: 'id-proj-1',
      root: 'C:\\projects\\my-project',
      source: 'path' as const,
    }

    const healthyService = () => ({
      status: vi.fn((): AiMemoryStatus => ({
        state: 'running',
        owned: true,
        binaryPath: 'C:\\bin\\ai-memory.exe',
      })),
      health: vi.fn(async (): Promise<{ ok: boolean; message?: string }> => ({ ok: true })),
      resolveScope: vi.fn(async () => geminiScope),
      ensureProjectMarker: vi.fn(
        async (): Promise<AiMemoryMarkerWriteResult> => ({
          configured: true,
          status: 'unchanged',
          path: 'C:\\projects\\my-project\\.ai-memory.toml',
        })
      ),
      isProjectEnabled: vi.fn(() => true),
    })

    const geminiContext: AiMemoryLaunchContext = {
      provider: 'gemini',
      resolvedCommand: 'C:\\bin\\gemini.cmd',
      originalArgs: ['--model', 'gemini-2.5-pro'],
      env: { DEVORBIT_MODEL: 'gemini-2.5-pro', PATH: 'C:\\Windows' },
      cwd: 'C:\\projects\\my-project',
      terminalId: 'gemini-term-1',
    }

    const setupSpy = (
      impl: (
        request: AiMemoryAgentSetupRequest,
        deps: AiMemoryAgentSetupDeps
      ) => Promise<AiMemoryAgentSetupResult>
    ) => vi.fn(impl)

    const baseDeps = (service: ReturnType<typeof healthyService>): AiMemoryLauncherDeps => ({
      getService: () => service,
      getDataDir: () => 'C:\\devorbit\\data',
      getUserDataDir: () => 'C:\\devorbit\\userdata',
      ensureAllowlistMode: async () => true,
      /** Stub padrão do setup nativo: hermético (sem subprocesso real). */
      setupAgent: async () => ({ status: 'already-installed', mcp: 'skipped', hooks: 'skipped' }),
    })

    it('opt-in + setup OK → execução direta sem degradedReason, preservando command/argv/cwd/env', async () => {
      const service = healthyService()
      const setup = setupSpy(async () => ({ status: 'installed', mcp: 'installed', hooks: 'installed' }))
      const plan = await prepareAiMemoryLaunch(geminiContext, {
        ...baseDeps(service),
        setupGemini: setup,
      })

      expect(plan.wrapped).toBe(false)
      expect(plan.degradedReason).toBeUndefined()
      expect(plan.command).toBe('C:\\bin\\gemini.cmd')
      expect(plan.args).toEqual(['--model', 'gemini-2.5-pro'])
      expect(plan.cwd).toBe('C:\\projects\\my-project')
      expect(plan.env).toEqual(geminiContext.env)

      expect(setup).toHaveBeenCalledTimes(1)
      const [request, setupDeps] = setup.mock.calls[0]
      expect(request).toEqual({
        optedIn: true,
        binaryPath: 'C:\\bin\\ai-memory.exe',
        identity: 'id-proj-1',
        dataDir: 'C:\\devorbit\\data',
        cwd: 'C:\\projects\\my-project',
      })
      // Sem env do harness: CODEX_HOME/tokens não vazam para o instalador.
      expect(request).not.toHaveProperty('env')
      expect(setupDeps).toEqual({ userDataDir: 'C:\\devorbit\\userdata' })
    })

    it('setup already-installed também é sucesso direto', async () => {
      const service = healthyService()
      const setup = setupSpy(async () => ({ status: 'already-installed', mcp: 'skipped', hooks: 'skipped' }))
      const plan = await prepareAiMemoryLaunch(geminiContext, { ...baseDeps(service), setupGemini: setup })
      expect(plan.wrapped).toBe(false)
      expect(plan.degradedReason).toBeUndefined()
    })

    it('falha de setup → execução direta com degradedReason preparation-failed (PTY não bloqueia)', async () => {
      const service = healthyService()
      const setup = setupSpy(async () => ({ status: 'degraded', mcp: 'failed', hooks: 'installed' }))
      const plan = await prepareAiMemoryLaunch(geminiContext, { ...baseDeps(service), setupGemini: setup })
      expect(plan).toMatchObject({
        wrapped: false,
        degradedReason: 'preparation-failed',
        command: 'C:\\bin\\gemini.cmd',
        cwd: 'C:\\projects\\my-project',
      })
      expect(plan.args).toEqual(['--model', 'gemini-2.5-pro'])
      expect(plan.env).toEqual(geminiContext.env)
    })

    it('setup que lança não derruba: degradado, sem throw', async () => {
      const service = healthyService()
      const setup = vi.fn(async () => {
        throw new Error('boom')
      })
      const plan = await prepareAiMemoryLaunch(geminiContext, { ...baseDeps(service), setupGemini: setup })
      expect(plan).toMatchObject({ wrapped: false, degradedReason: 'preparation-failed' })
      expect(plan.command).toBe('C:\\bin\\gemini.cmd')
    })

    it('projeto sem opt-in → degradedReason opt-out e NENHUM setup', async () => {
      const service = healthyService()
      service.isProjectEnabled = vi.fn(() => false)
      const setup = setupSpy(async () => ({ status: 'installed', mcp: 'installed', hooks: 'installed' }))
      const plan = await prepareAiMemoryLaunch(geminiContext, { ...baseDeps(service), setupGemini: setup })
      expect(plan).toMatchObject({ wrapped: false, degradedReason: 'opt-out' })
      expect(setup).not.toHaveBeenCalled()
    })

    it('serviço indisponível → degradedReason service-unavailable e NENHUM setup', async () => {
      const service = healthyService()
      service.status = vi.fn((): AiMemoryStatus => ({ state: 'unavailable', owned: false }))
      const setup = setupSpy(async () => ({ status: 'installed', mcp: 'installed', hooks: 'installed' }))
      const plan = await prepareAiMemoryLaunch(geminiContext, { ...baseDeps(service), setupGemini: setup })
      expect(plan).toMatchObject({ wrapped: false, degradedReason: 'service-unavailable' })
      expect(setup).not.toHaveBeenCalled()
    })

    it('providers unsupported (aider/custom) não disparam setup de memória', async () => {
      const service = healthyService()
      const setup = setupSpy(async () => ({ status: 'installed', mcp: 'installed', hooks: 'installed' }))
      for (const provider of ['aider', 'custom']) {
        const plan = await prepareAiMemoryLaunch(
          { ...geminiContext, provider },
          { ...baseDeps(service), setupGemini: setup }
        )
        expect(plan).toMatchObject({ wrapped: false, degradedReason: 'harness-not-supported' })
      }
      expect(setup).not.toHaveBeenCalled()
    })

    it('Codex preserva CODEX_HOME no lançamento e não chama o setup Gemini', async () => {
      const service = healthyService()
      const setup = setupSpy(async () => ({ status: 'installed', mcp: 'installed', hooks: 'installed' }))
      const codexContext: AiMemoryLaunchContext = {
        provider: 'codex',
        resolvedCommand: 'C:\\bin\\codex.cmd',
        originalArgs: [],
        env: { CODEX_HOME: 'C:\\Users\\x\\.codex-conta2', DEVORBIT_MODEL: 'gpt' },
        cwd: 'C:\\projects\\my-project',
        terminalId: 'codex-term-1',
      }
      const plan = await prepareAiMemoryLaunch(codexContext, { ...baseDeps(service), setupGemini: setup })
      expect(plan.wrapped).toBe(true)
      expect(plan.env.CODEX_HOME).toBe('C:\\Users\\x\\.codex-conta2')
      expect(plan.env.DEVORBIT_MODEL).toBe('gpt')
      expect(setup).not.toHaveBeenCalled()
    })

    it('userData indisponível → degrada e inicia direto, sem criar outra fonte', async () => {
      const service = healthyService()
      const setup = setupSpy(async () => ({ status: 'installed', mcp: 'installed', hooks: 'installed' }))
      const plan = await prepareAiMemoryLaunch(geminiContext, {
        getService: () => service,
        getDataDir: () => {
          throw new Error('userData indisponível')
        },
        getUserDataDir: () => {
          throw new Error('userData indisponível')
        },
        ensureAllowlistMode: async () => true,
        setupGemini: setup,
      })
      expect(plan).toMatchObject({
        wrapped: false,
        degradedReason: 'preparation-failed',
        command: 'C:\\bin\\gemini.cmd',
      })
      expect(setup).not.toHaveBeenCalled()
    })

    it('prepareAiMemoryLaunch (wrapper) degrada quando o dataDir não resolve', async () => {
      const service = healthyService()
      const opencodeContext: AiMemoryLaunchContext = {
        provider: 'opencode',
        resolvedCommand: 'C:\\bin\\opencode.cmd',
        originalArgs: ['--model', 'claude-sonnet'],
        env: { DEVORBIT_MODEL: 'claude-sonnet' },
        cwd: 'C:\\projects\\my-project',
        terminalId: 'opencode-term-1',
      }
      const deps: AiMemoryLauncherDeps = {
        setupAgent: async () => ({ status: 'already-installed', mcp: 'skipped', hooks: 'skipped' }),
        getService: () => service,
        getDataDir: () => {
          throw new Error('userData indisponível')
        },
        ensureAllowlistMode: async () => true,
      }
      const plan = await prepareAiMemoryLaunch(opencodeContext, deps)
      expect(plan).toMatchObject({ wrapped: false, degradedReason: 'preparation-failed' })
      expect(plan.command).toBe('C:\\bin\\opencode.cmd')
    })
  })

  describe('resolveAiMemoryHarness (mapping de harnesses v2.4.0)', () => {
    it('mapeia os provedores suportados para seus harnesses oficiais', () => {
      expect(resolveAiMemoryHarness('codex')).toBe('codex')
      expect(resolveAiMemoryHarness('opencode')).toBe('opencode')
      expect(resolveAiMemoryHarness('opencode2')).toBe('opencode2')
      expect(resolveAiMemoryHarness('claude')).toBe('claude')
      expect(resolveAiMemoryHarness('claude-code')).toBe('claude')
      expect(resolveAiMemoryHarness('agy')).toBe('antigravity')
      expect(resolveAiMemoryHarness('antigravity')).toBe('antigravity')
      expect(resolveAiMemoryHarness('antigravity-cli')).toBe('antigravity')
      expect(resolveAiMemoryHarness('command-code')).toBe('command-code')
      expect(resolveAiMemoryHarness('cmdc')).toBe('command-code')
    })

    it('retorna null para provedores sem harness gerenciado (gemini, aider, custom)', () => {
      expect(resolveAiMemoryHarness('gemini')).toBeNull()
      expect(resolveAiMemoryHarness('aider')).toBeNull()
      expect(resolveAiMemoryHarness('custom')).toBeNull()
      expect(resolveAiMemoryHarness('desconhecido')).toBeNull()
    })
  })

  describe('resolveAiMemoryAgentChoice (mapping oficial para install-hooks --agent)', () => {
    it('mapeia os provedores para o nome de agente aceito por install-hooks v2.4.0', () => {
      expect(resolveAiMemoryAgentChoice('codex')).toBe('codex')
      expect(resolveAiMemoryAgentChoice('opencode')).toBe('opencode')
      expect(resolveAiMemoryAgentChoice('opencode2')).toBe('opencode2')
      expect(resolveAiMemoryAgentChoice('claude')).toBe('claude-code')
      expect(resolveAiMemoryAgentChoice('claude-code')).toBe('claude-code')
      expect(resolveAiMemoryAgentChoice('agy')).toBe('antigravity-cli')
      expect(resolveAiMemoryAgentChoice('antigravity')).toBe('antigravity-cli')
      expect(resolveAiMemoryAgentChoice('antigravity-cli')).toBe('antigravity-cli')
      expect(resolveAiMemoryAgentChoice('command-code')).toBe('command-code')
      expect(resolveAiMemoryAgentChoice('cmdc')).toBe('command-code')
      expect(resolveAiMemoryAgentChoice('gemini')).toBeNull()
      expect(resolveAiMemoryAgentChoice('aider')).toBeNull()
    })
  })

  describe('generateWorkstreamId', () => {
    it('gera identificador com provider, terminalId e sufixo único', () => {
      const id1 = generateWorkstreamId('opencode', 'term-1')
      const id2 = generateWorkstreamId('opencode', 'term-1')

      expect(id1).toContain('opencode-term-1-')
      expect(id2).toContain('opencode-term-1-')
      expect(id1).not.toBe(id2)
    })
  })

  describe('prepareAiMemoryLaunch (planejamento e fallbacks)', () => {
    const fakeScope = {
      workspace: 'devorbit',
      project: 'my-project',
      identity: 'id-proj-1',
      root: 'C:\\projects\\my-project',
      source: 'path' as const,
    }

    const createHealthyService = () => ({
      status: vi.fn((): AiMemoryStatus => ({
        state: 'running',
        owned: true,
        binaryPath: 'C:\\bin\\ai-memory.exe',
      })),
      health: vi.fn(async (): Promise<{ ok: boolean; message?: string }> => ({ ok: true })),
      resolveScope: vi.fn(async () => fakeScope),
      ensureProjectMarker: vi.fn(async (): Promise<AiMemoryMarkerWriteResult> => ({
        configured: true,
        status: 'unchanged',
        path: 'C:\\projects\\my-project\\.ai-memory.toml',
      })),
      isProjectEnabled: vi.fn(() => true),
    })

    const baseContext: AiMemoryLaunchContext = {
      provider: 'opencode',
      resolvedCommand: 'C:\\bin\\opencode.cmd',
      originalArgs: ['--model', 'claude-sonnet'],
      env: { DEVORBIT_MODEL: 'claude-sonnet', PATH: 'C:\\Windows' },
      cwd: 'C:\\projects\\my-project',
      terminalId: 'agent-term-1',
    }

    it('envelopa com a sintaxe oficial v2.4.0 e omite --new na ausência de sessões ativas (workstream default)', async () => {
      const service = createHealthyService()
      const deps: AiMemoryLauncherDeps = {
        setupAgent: async () => ({ status: 'already-installed', mcp: 'skipped', hooks: 'skipped' }),
        getService: () => service,
        getDataDir: () => 'C:\\devorbit\\data',
        getUserDataDir: () => 'C:\\devorbit\\userdata',
      }

      const plan = await prepareAiMemoryLaunch(baseContext, deps)

      expect(plan.wrapped).toBe(true)
      expect(plan.command).toBe('C:\\bin\\ai-memory.exe')
      // --executable passa o script diretamente (opencode.cmd) sem embrulhar em cmd.exe
      expect(plan.args[0]).toBe('--data-dir')
      expect(plan.args).toContain('--executable')
      const executableIdx = plan.args.indexOf('--executable')
      expect(plan.args[executableIdx + 1]).toBe('C:\\bin\\opencode.cmd')
      expect(plan.args[executableIdx + 1]).not.toContain('cmd.exe')
      expect(plan.args).toEqual([
        '--data-dir',
        'C:\\devorbit\\data',
        'run',
        '--workspace',
        'devorbit',
        '--project',
        'my-project',
        '--executable',
        'C:\\bin\\opencode.cmd',
        'opencode',
        '--',
        '--model',
        'claude-sonnet',
      ])
      // Não deve existir flag --new (retoma workstream default)
      expect(plan.args).not.toContain('--new')
      expect(plan.isDefaultWorkstream).toBe(true)
      expect(plan.workstream).toBe('default')
      expect(plan.args).not.toContain('--harness')
      expect(plan.harness).toBe('opencode')
      expect(plan.cwd).toBe('C:\\projects\\my-project')
      expect(plan.env.DEVORBIT_MODEL).toBe('claude-sonnet')
      expect(plan.metadata).toBeDefined()
      expect(plan.metadata?.isDefaultWorkstream).toBe(true)
    })

    it('quando outra sessão já está ativa no mesmo escopo, passa flag --new com workstream único', async () => {
      const service = createHealthyService()
      const deps: AiMemoryLauncherDeps = {
        setupAgent: async () => ({ status: 'already-installed', mcp: 'skipped', hooks: 'skipped' }),
        getService: () => service,
        getDataDir: () => 'C:\\devorbit\\data',
        getUserDataDir: () => 'C:\\devorbit\\userdata',
        generateWorkstreamId: () => 'opencode-term-2-unique',
      }

      // Registra sessão ativa existente para o mesmo escopo (workspace + project)
      registerActiveAiMemorySession({
        terminalId: 'agent-term-active',
        provider: 'claude',
        harness: 'claude',
        workstream: 'default',
        workspace: 'devorbit',
        project: 'my-project',
        dataDir: 'C:\\devorbit\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        startedAt: Date.now(),
      })

      const context2: AiMemoryLaunchContext = {
        ...baseContext,
        terminalId: 'agent-term-2',
      }

      const plan = await prepareAiMemoryLaunch(context2, deps)

      expect(plan.wrapped).toBe(true)
      expect(plan.isDefaultWorkstream).toBe(false)
      expect(plan.workstream).toBe('opencode-term-2-unique')
      expect(plan.args).toContain('--new')
      expect(plan.args).toContain('opencode-term-2-unique')
    })

    it('preparos simultâneos no mesmo escopo produzem exatamente um default e outro com --new', async () => {
      const service = createHealthyService()
      const deps: AiMemoryLauncherDeps = {
        setupAgent: async () => ({ status: 'already-installed', mcp: 'skipped', hooks: 'skipped' }),
        getService: () => service,
        getDataDir: () => 'C:\\devorbit\\data',
        getUserDataDir: () => 'C:\\devorbit\\userdata',
      }

      const ctxA = { ...baseContext, terminalId: 'simultaneous-a' }
      const ctxB = { ...baseContext, terminalId: 'simultaneous-b' }

      // Dispara simultaneamente
      const [planA, planB] = await Promise.all([
        prepareAiMemoryLaunch(ctxA, deps),
        prepareAiMemoryLaunch(ctxB, deps),
      ])

      expect(planA.wrapped).toBe(true)
      expect(planB.wrapped).toBe(true)

      // Exatamente um deve ser default (sem --new) e o outro deve ter --new com identificador distinto
      const defaultPlans = [planA, planB].filter((p) => p.isDefaultWorkstream)
      const newPlans = [planA, planB].filter((p) => !p.isDefaultWorkstream)

      expect(defaultPlans).toHaveLength(1)
      expect(newPlans).toHaveLength(1)
      expect(defaultPlans[0].args).not.toContain('--new')
      expect(newPlans[0].args).toContain('--new')
      expect(defaultPlans[0].workstream).not.toBe(newPlans[0].workstream)
    })

    it('falha/fallback libera a reserva e spawn bem-sucedido a transfere para a sessão ativa', async () => {
      const service = createHealthyService()
      const deps: AiMemoryLauncherDeps = {
        setupAgent: async () => ({ status: 'already-installed', mcp: 'skipped', hooks: 'skipped' }),
        getService: () => service,
        getDataDir: () => 'C:\\devorbit\\data',
        getUserDataDir: () => 'C:\\devorbit\\userdata',
      }

      // 1. Preparo adquire reserva pendente
      const plan = await prepareAiMemoryLaunch({ ...baseContext, terminalId: 'term-transfer' }, deps)
      expect(plan.wrapped).toBe(true)
      const pendingBefore = getPendingScopeReservation('term-transfer')
      expect(pendingBefore).toBeDefined()
      expect(pendingBefore?.terminalId).toBe('term-transfer')
      expect(getActiveAiMemorySession('term-transfer')).toBeUndefined()

      // 2. Spawn bem-sucedido transfere a reserva para a sessão ativa
      registerActiveAiMemorySession(plan.metadata!)
      expect(getPendingScopeReservation('term-transfer')).toBeUndefined()
      expect(getActiveAiMemorySession('term-transfer')).toBeDefined()

      // 3. Preparo com falha/fallback subsequente libera a reserva
      const failPlan = await prepareAiMemoryLaunch({ ...baseContext, terminalId: 'term-fallback' }, deps)
      expect(getPendingScopeReservation('term-fallback')).toBeDefined()

      releaseAiMemoryReservation('term-fallback')
      expect(getPendingScopeReservation('term-fallback')).toBeUndefined()
    })

    it('sessões simultâneas não compartilham workstream e sessão sequencial posterior cross-harness retoma o default', async () => {
      const service = createHealthyService()
      const deps: AiMemoryLauncherDeps = {
        setupAgent: async () => ({ status: 'already-installed', mcp: 'skipped', hooks: 'skipped' }),
        getService: () => service,
        getDataDir: () => 'C:\\devorbit\\data',
        getUserDataDir: () => 'C:\\devorbit\\userdata',
      }

      const codexCtx: AiMemoryLaunchContext = {
        ...baseContext,
        provider: 'codex',
        resolvedCommand: 'codex.cmd',
        terminalId: 'simultaneous-codex',
      }
      const claudeCtx: AiMemoryLaunchContext = {
        ...baseContext,
        provider: 'claude',
        resolvedCommand: 'claude.cmd',
        terminalId: 'simultaneous-claude',
      }

      // 1. Disparo simultâneo de duas sessões no mesmo escopo (workspace + project)
      const [planA, planB] = await Promise.all([
        prepareAiMemoryLaunch(codexCtx, deps),
        prepareAiMemoryLaunch(claudeCtx, deps),
      ])

      expect(planA.wrapped).toBe(true)
      expect(planB.wrapped).toBe(true)

      // Comprova que NÃO compartilham workstream (workstreams distintos)
      expect(planA.workstream).not.toBe(planB.workstream)

      // Exatamente um é default (sem --new) e o outro é isolado (com --new)
      const defaultPlan = [planA, planB].find((p) => p.isDefaultWorkstream)!
      const newPlan = [planA, planB].find((p) => !p.isDefaultWorkstream)!

      expect(defaultPlan).toBeDefined()
      expect(newPlan).toBeDefined()
      expect(defaultPlan.args).not.toContain('--new')
      expect(defaultPlan.workstream).toBe('default')
      expect(newPlan.args).toContain('--new')
      expect(newPlan.args).toContain(newPlan.workstream)

      // 2. Ambos spawnados com sucesso e registrados
      registerActiveAiMemorySession(planA.metadata!)
      registerActiveAiMemorySession(planB.metadata!)

      expect(getActiveAiMemorySession('simultaneous-codex')).toBeDefined()
      expect(getActiveAiMemorySession('simultaneous-claude')).toBeDefined()

      // 3. Ambas as sessões são finalizadas
      await finalizeAiMemorySession({ terminalId: 'simultaneous-codex' })
      await finalizeAiMemorySession({ terminalId: 'simultaneous-claude' })

      expect(getActiveAiMemorySession('simultaneous-codex')).toBeUndefined()
      expect(getActiveAiMemorySession('simultaneous-claude')).toBeUndefined()
      expect(isScopeActiveOrPreparing('devorbit', 'my-project')).toBe(false)

      // 4. Sessão sequencial posterior com outro harness (OpenCode) retoma o workstream default
      const sequentialOpenCodeCtx: AiMemoryLaunchContext = {
        ...baseContext,
        provider: 'opencode',
        resolvedCommand: 'opencode.cmd',
        terminalId: 'sequential-opencode',
      }
      const sequentialPlan = await prepareAiMemoryLaunch(sequentialOpenCodeCtx, deps)

      expect(sequentialPlan.wrapped).toBe(true)
      expect(sequentialPlan.isDefaultWorkstream).toBe(true)
      expect(sequentialPlan.workstream).toBe('default')
      expect(sequentialPlan.args).not.toContain('--new')
    })

    it('reproduz a corrida: saída imediata do PTY antes de registerActiveAiMemorySession não deixa sessão zumbi nem bloqueia o workstream default', async () => {
      const service = createHealthyService()
      const deps: AiMemoryLauncherDeps = {
        setupAgent: async () => ({ status: 'already-installed', mcp: 'skipped', hooks: 'skipped' }),
        getService: () => service,
        getDataDir: () => 'C:\\devorbit\\data',
        getUserDataDir: () => 'C:\\devorbit\\userdata',
      }
      const ctx: AiMemoryLaunchContext = {
        ...baseContext,
        provider: 'codex',
        resolvedCommand: 'codex.cmd',
        terminalId: 'immediate-exit-term',
      }

      // 1. Preparo adquire reserva e seleciona o workstream default
      const plan = await prepareAiMemoryLaunch(ctx, deps)
      expect(plan.isDefaultWorkstream).toBe(true)
      expect(plan.workstream).toBe('default')
      expect(plan.args).not.toContain('--new')
      expect(getPendingScopeReservation('immediate-exit-term')).toBeDefined()

      // 2. Simula o PTY saindo imediatamente: onExit dispara finalizeAiMemorySession
      // ANTES de o chamador registrar metadata
      const exitResult = await finalizeAiMemorySession({ terminalId: 'immediate-exit-term' })
      expect(exitResult.finalized).toBe(false)
      // A reserva pendente foi liberada
      expect(getPendingScopeReservation('immediate-exit-term')).toBeUndefined()

      // 3. Chamador recebe retorno de startTerminal e tenta registrar metadata tardiamente
      const registered = registerActiveAiMemorySession(plan.metadata!)
      // O registro é rejeitado por ter havido saída prévia
      expect(registered).toBe(false)
      expect(getActiveAiMemorySession('immediate-exit-term')).toBeUndefined()
      expect(isScopeActiveOrPreparing('devorbit', 'my-project')).toBe(false)

      // 4. Um lançamento subsequente no mesmo escopo retoma o workstream default sem bloqueio
      const subsequentPlan = await prepareAiMemoryLaunch(
        { ...baseContext, provider: 'codex', resolvedCommand: 'codex.cmd', terminalId: 'subsequent-term' },
        deps
      )
      expect(subsequentPlan.wrapped).toBe(true)
      expect(subsequentPlan.isDefaultWorkstream).toBe(true)
      expect(subsequentPlan.workstream).toBe('default')
      expect(subsequentPlan.args).not.toContain('--new')
    })

    it('rollbackAiMemoryLaunch e remoção explícita limpam reservas/sessões e protegem contra registro tardio', async () => {
      const service = createHealthyService()
      const deps: AiMemoryLauncherDeps = {
        setupAgent: async () => ({ status: 'already-installed', mcp: 'skipped', hooks: 'skipped' }),
        getService: () => service,
        getDataDir: () => 'C:\\devorbit\\data',
        getUserDataDir: () => 'C:\\devorbit\\userdata',
      }

      const plan = await prepareAiMemoryLaunch(
        { ...baseContext, terminalId: 'term-rollback' },
        deps
      )
      expect(getPendingScopeReservation('term-rollback')).toBeDefined()

      // Rollback explícito (ex.: falha de spawn ou verificação de !hasTerminal)
      rollbackAiMemoryLaunch('term-rollback')
      expect(getPendingScopeReservation('term-rollback')).toBeUndefined()
      expect(getActiveAiMemorySession('term-rollback')).toBeUndefined()

      // Tentativa tardia de registrar metadata é descartada
      const reg = registerActiveAiMemorySession(plan.metadata!)
      expect(reg).toBe(false)
      expect(getActiveAiMemorySession('term-rollback')).toBeUndefined()
      expect(isScopeActiveOrPreparing('devorbit', 'my-project')).toBe(false)

      // removeActiveAiMemorySession remove sessão ativa registrada e libera o escopo
      const activePlan = await prepareAiMemoryLaunch(
        { ...baseContext, terminalId: 'term-active-remove' },
        deps
      )
      registerActiveAiMemorySession(activePlan.metadata!)
      expect(getActiveAiMemorySession('term-active-remove')).toBeDefined()

      const removed = removeActiveAiMemorySession('term-active-remove')
      expect(removed?.terminalId).toBe('term-active-remove')
      expect(getActiveAiMemorySession('term-active-remove')).toBeUndefined()
      expect(isScopeActiveOrPreparing('devorbit', 'my-project')).toBe(false)
    })

    it('degrada para execução direta quando harness não é suportado (aider, custom)', async () => {
      const service = createHealthyService()
      const deps: AiMemoryLauncherDeps = {
        setupAgent: async () => ({ status: 'already-installed', mcp: 'skipped', hooks: 'skipped' }),
        getService: () => service,
      }

      // Gemini tem caminho dedicado (hooks + MCP) coberto no describe próprio.
      const aiderPlan = await prepareAiMemoryLaunch(
        { ...baseContext, provider: 'aider', resolvedCommand: 'aider.exe' },
        deps
      )
      expect(aiderPlan.wrapped).toBe(false)
      expect(aiderPlan.command).toBe('aider.exe')
      expect(aiderPlan.degradedReason).toBe('harness-not-supported')

      const customPlan = await prepareAiMemoryLaunch(
        { ...baseContext, provider: 'custom', resolvedCommand: 'mycli.exe' },
        deps
      )
      expect(customPlan.wrapped).toBe(false)
      expect(customPlan.degradedReason).toBe('harness-not-supported')
    })

    it('fallback direto quando serviço não existe ou não está running', async () => {
      const noServicePlan = await prepareAiMemoryLaunch(baseContext, { getService: () => null })
      expect(noServicePlan.wrapped).toBe(false)
      expect(noServicePlan.degradedReason).toBe('service-unavailable')

      const stoppedService = createHealthyService()
      stoppedService.status.mockReturnValue({ state: 'unavailable', owned: false })
      const stoppedPlan = await prepareAiMemoryLaunch(baseContext, { getService: () => stoppedService })
      expect(stoppedPlan.wrapped).toBe(false)
      expect(stoppedPlan.degradedReason).toBe('service-unavailable')
    })

    it('fallback direto quando ocorre outage de transporte depois do start (status=running mas health ok=false)', async () => {
      const service = createHealthyService()
      // Status síncrono continua 'running', mas health() detecta que o transporte caiu
      service.health.mockResolvedValue({ ok: false, message: 'Transport connection refused (ECONNREFUSED)' })

      const plan = await prepareAiMemoryLaunch(baseContext, { getService: () => service })
      expect(plan.wrapped).toBe(false)
      expect(plan.degradedReason).toBe('service-unavailable')
      expect(plan.command).toBe(baseContext.resolvedCommand)
      expect(service.health).toHaveBeenCalledTimes(1)
    })

    it('fallback direto quando health() rejeita com exceção', async () => {
      const service = createHealthyService()
      service.health.mockRejectedValue(new Error('Socket timeout'))

      const plan = await prepareAiMemoryLaunch(baseContext, { getService: () => service })
      expect(plan.wrapped).toBe(false)
      expect(plan.degradedReason).toBe('service-unavailable')
      expect(plan.command).toBe(baseContext.resolvedCommand)
    })

    it('fallback direto quando o projeto é opt-out (não chama ensureProjectMarker nem ativa marker)', async () => {
      const service = createHealthyService()
      service.isProjectEnabled.mockReturnValue(false)

      const plan = await prepareAiMemoryLaunch(baseContext, { getService: () => service })
      expect(plan.wrapped).toBe(false)
      expect(plan.degradedReason).toBe('opt-out')
      expect(plan.command).toBe('C:\\bin\\opencode.cmd')
      // Privacidade: projeto opt-out NUNCA deve chamar ensureProjectMarker
      expect(service.ensureProjectMarker).not.toHaveBeenCalled()
    })

    it('fallback direto quando marker de terceiro não gerenciado é preservado (sem sobrescrever)', async () => {
      const service = createHealthyService()
      // Marker de terceiro preservado: configured = false, status = 'preserved'
      service.ensureProjectMarker.mockResolvedValue({
        configured: false,
        status: 'preserved',
        path: 'C:\\projects\\my-project\\.ai-memory.toml',
        missingFields: ['briefing', 'ignore_paths'],
      })

      const plan = await prepareAiMemoryLaunch(baseContext, { getService: () => service })
      expect(plan.wrapped).toBe(false)
      expect(plan.degradedReason).toBe('marker-unconfigured')
      expect(plan.command).toBe('C:\\bin\\opencode.cmd')
    })

    it('fallback direto quando o marker tem conflito não gerenciável', async () => {
      const service = createHealthyService()
      service.ensureProjectMarker.mockResolvedValue({
        configured: false,
        status: 'conflict',
        path: 'C:\\projects\\my-project\\.ai-memory.toml',
        conflicts: ['workspace'],
      })

      const plan = await prepareAiMemoryLaunch(baseContext, { getService: () => service })
      expect(plan.wrapped).toBe(false)
      expect(plan.degradedReason).toBe('marker-unconfigured')
    })

    it('fallback direto para direct launch quando ensureAllowlistMode falha (blindagem contra denylist)', async () => {
      const service = createHealthyService()
      const failingAllowlist = vi.fn(async () => false)

      const plan = await prepareAiMemoryLaunch(baseContext, {
        getService: () => service,
        getDataDir: () => 'C:\\devorbit\\data',
        ensureAllowlistMode: failingAllowlist,
      })

      expect(plan.wrapped).toBe(false)
      expect(plan.degradedReason).toBe('preparation-failed')
      expect(plan.command).toBe(baseContext.resolvedCommand)
      expect(failingAllowlist).toHaveBeenCalledTimes(1)
    })

    it('preserva CODEX_HOME intacto para o Codex', async () => {
      const service = createHealthyService()
      const deps: AiMemoryLauncherDeps = {
        setupAgent: async () => ({ status: 'already-installed', mcp: 'skipped', hooks: 'skipped' }),
        getService: () => service,
        getDataDir: () => 'C:\\devorbit\\data',
        getUserDataDir: () => 'C:\\devorbit\\userdata',
        generateWorkstreamId: () => 'codex-term-c1-xyz',
      }

      const codexContext: AiMemoryLaunchContext = {
        provider: 'codex',
        resolvedCommand: 'C:\\Users\\user\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe',
        originalArgs: [],
        env: {
          CODEX_HOME: 'C:\\Users\\user\\.codex-conta1',
          DEVORBIT_MODEL: 'codex',
        },
        cwd: 'C:\\projects\\my-project',
        terminalId: 'codex-term-1',
        account: 'account1',
      }

      const plan = await prepareAiMemoryLaunch(codexContext, deps)

      expect(plan.wrapped).toBe(true)
      expect(plan.harness).toBe('codex')
      expect(plan.env.CODEX_HOME).toBe('C:\\Users\\user\\.codex-conta1')
      expect(plan.args).toContain('--executable')
      expect(plan.args).toContain('C:\\Users\\user\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe')
      expect(plan.args).toContain('codex')
    })

    it('captura exceções inesperadas antes do spawn e retorna preparation-failed sem lançar', async () => {
      const faultyService = createHealthyService()
      faultyService.resolveScope.mockRejectedValue(new Error('Git crash'))

      const plan = await prepareAiMemoryLaunch(baseContext, { getService: () => faultyService })
      expect(plan.wrapped).toBe(false)
      expect(plan.degradedReason).toBe('preparation-failed')
      expect(plan.command).toBe(baseContext.resolvedCommand)
    })
  })

  describe('finalizeAiMemorySession (finalização e deduplicação)', () => {
    it('executa finalize-session com --agent antigravity-cli para Antigravity', async () => {
      const execCli = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' }))

      registerActiveAiMemorySession({
        terminalId: 'agy-term-1',
        provider: 'agy',
        harness: 'antigravity',
        workstream: 'ws-1',
        workspace: 'devorbit',
        project: 'p1',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        sessionId: 'session-uuid-123',
        startedAt: Date.now(),
      })

      const result = await finalizeAiMemorySession(
        { terminalId: 'agy-term-1' },
        { execCli }
      )

      expect(result.finalized).toBe(true)
      expect(execCli).toHaveBeenCalledTimes(1)
      const [bin, args] = (execCli.mock.calls as unknown as Array<[string, string[]]>)[0]
      expect(bin).toBe('C:\\bin\\ai-memory.exe')
      expect(args).toEqual([
        '--data-dir',
        'C:\\data',
        'finalize-session',
        '--agent',
        'antigravity-cli',
        '--session-id',
        'session-uuid-123',
        '--workspace',
        'devorbit',
        '--project',
        'p1',
      ])
      // NUNCA deve incluir --all
      expect(args).not.toContain('--all')
    })

    it('deduplica chamadas: segunda invocação com o mesmo terminalId é no-op', async () => {
      const execCli = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' }))

      const input = {
        terminalId: 'term-dedup-1',
        agent: 'antigravity-cli',
        sessionId: 'sess-dedup-1',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        dataDir: 'C:\\devorbit\\data',
      }

      const first = await finalizeAiMemorySession(input, { execCli })
      expect(first.finalized).toBe(true)
      expect(execCli).toHaveBeenCalledTimes(1)

      const second = await finalizeAiMemorySession(input, { execCli })
      expect(second.finalized).toBe(false)
      expect(second.message).toContain('já finalizada')
      expect(execCli).toHaveBeenCalledTimes(1) // Não chamou de novo
    })

    it('lida com falhas no CLI sem estourar exceção', async () => {
      const execCli = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'session not found' }))

      const result = await finalizeAiMemorySession(
        {
          terminalId: 'term-fail-1',
          agent: 'antigravity-cli',
          sessionId: 'sess-fail-1',
          binaryPath: 'C:\\bin\\ai-memory.exe',
          dataDir: 'C:\\devorbit\\data',
        },
        { execCli }
      )

      expect(result.finalized).toBe(false)
      expect(result.message).toContain('session not found')
    })

    it('não queima terminalId quando chamado sem sessão ativa ou binário (startup do primeiro terminal), permitindo saída natural posterior', async () => {
      const execCli = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' }))

      // Simula startup: chamada sem sessão ativa nem binaryPath
      const startupCall = await finalizeAiMemorySession(
        { terminalId: 'term-startup-1' },
        { execCli }
      )
      expect(startupCall.finalized).toBe(false)
      expect(startupCall.message).toContain('Nenhuma sessão ativa')
      expect(execCli).not.toHaveBeenCalled()

      // Agora a sessão do PTY é registrada (após o startTerminal)
      registerActiveAiMemorySession({
        terminalId: 'term-startup-1',
        provider: 'agy',
        harness: 'antigravity',
        workstream: 'ws-start-1',
        workspace: 'devorbit',
        project: 'p1',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        sessionId: 'session-live-999',
        startedAt: Date.now(),
      })

      // Saída natural (terminal.onExit): a finalização NÃO foi bloqueada e finaliza com sucesso
      const onExitCall = await finalizeAiMemorySession(
        { terminalId: 'term-startup-1' },
        { execCli }
      )
      expect(onExitCall.finalized).toBe(true)
      expect(execCli).toHaveBeenCalledTimes(1)
      const [bin, args] = (execCli.mock.calls as unknown as Array<[string, string[]]>)[0]
      expect(bin).toBe('C:\\bin\\ai-memory.exe')
      expect(args).toContain('antigravity-cli')
      expect(args).toContain('session-live-999')
    })

    it('deduplica chamadas concorrentes em voo (in-flight), compartilhando a mesma promise', async () => {
      let resolvePromise: (val: any) => void
      const deferred = new Promise<any>((res) => {
        resolvePromise = res
      })
      const execCli = vi.fn(async () => deferred)

      const input = {
        terminalId: 'term-inflight-1',
        agent: 'antigravity-cli',
        sessionId: 'sess-inflight-1',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        dataDir: 'C:\\devorbit\\data',
      }

      // Duas chamadas simultâneas (ex: stopTerminal e onExit competindo)
      const p1 = finalizeAiMemorySession(input, { execCli })
      const p2 = finalizeAiMemorySession(input, { execCli })

      // Libera o CLI
      resolvePromise!({ code: 0, stdout: 'done', stderr: '' })

      const [res1, res2] = await Promise.all([p1, p2])
      expect(res1.finalized).toBe(true)
      expect(res2.finalized).toBe(true)
      // Executa o CLI apenas UMA vez!
      expect(execCli).toHaveBeenCalledTimes(1)
    })

    it('permite retry após falha temporária no CLI: dedupe por sucesso, não falha permanente', async () => {
      let attempt = 0
      const execCli = vi.fn(async () => {
        attempt += 1
        if (attempt === 1) {
          return { code: 1, stdout: '', stderr: 'busy: database locked' }
        }
        return { code: 0, stdout: 'ok', stderr: '' }
      })

      const input = {
        terminalId: 'term-retry-1',
        agent: 'antigravity-cli',
        sessionId: 'sess-retry-1',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        dataDir: 'C:\\devorbit\\data',
      }

      // Primeira tentativa falha
      const first = await finalizeAiMemorySession(input, { execCli })
      expect(first.finalized).toBe(false)
      expect(first.message).toContain('database locked')
      expect(execCli).toHaveBeenCalledTimes(1)

      // Segunda tentativa (retry) tem sucesso e NÃO é descartada como já finalizada
      const retry = await finalizeAiMemorySession(input, { execCli })
      expect(retry.finalized).toBe(true)
      expect(execCli).toHaveBeenCalledTimes(2)

      // Terceira tentativa após o sucesso: aí sim vira no-op deduplicado
      const third = await finalizeAiMemorySession(input, { execCli })
      expect(third.finalized).toBe(false)
      expect(third.message).toContain('já finalizada')
      expect(execCli).toHaveBeenCalledTimes(2)
    })

    it('dispensa chamada CLI de finalize-session para provedor com sessão já gerenciada/encerrada por hook (ex: opencode)', async () => {
      const execCli = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' }))

      registerActiveAiMemorySession({
        terminalId: 'term-opencode-1',
        provider: 'opencode',
        harness: 'opencode',
        workstream: 'ws-opencode-1',
        workspace: 'devorbit',
        project: 'p1',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        startedAt: Date.now(),
      })

      const result = await finalizeAiMemorySession(
        { terminalId: 'term-opencode-1' },
        { execCli }
      )

      // Nenhum CLI executado: hooks próprios encerram a sessão
      expect(execCli).not.toHaveBeenCalled()
      expect(result.finalized).toBe(false)
      expect(result.message).toContain('gerenciado pelo harness/hooks')
      // Removido das sessões ativas
      expect(getActiveAiMemorySession('term-opencode-1')).toBeUndefined()

      // Segunda chamada subsequente é tratada como já finalizada
      const second = await finalizeAiMemorySession(
        { terminalId: 'term-opencode-1' },
        { execCli }
      )
      expect(second.finalized).toBe(false)
      expect(second.message).toContain('já finalizada')
      expect(execCli).not.toHaveBeenCalled()
    })

    it('duas sessões Antigravity concorrentes com sessionId exato são finalizadas individualmente sem colisão', async () => {
      const execCli = vi.fn(async () => ({ code: 0, stdout: 'finalized ok', stderr: '' }))

      registerActiveAiMemorySession({
        terminalId: 'agy-squad-1',
        provider: 'agy',
        harness: 'antigravity',
        workstream: 'ws-agy-1',
        workspace: 'devorbit',
        project: 'p-shared',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        sessionId: 'sess-agy-uuid-1',
        startedAt: Date.now(),
      })

      registerActiveAiMemorySession({
        terminalId: 'agy-squad-2',
        provider: 'agy',
        harness: 'antigravity',
        workstream: 'ws-agy-2',
        workspace: 'devorbit',
        project: 'p-shared',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        sessionId: 'sess-agy-uuid-2',
        startedAt: Date.now(),
      })

      // Finaliza o membro 1 com seu sessionId exato
      const res1 = await finalizeAiMemorySession(
        { terminalId: 'agy-squad-1' },
        { execCli }
      )
      expect(res1.finalized).toBe(true)
      expect(execCli).toHaveBeenCalledTimes(1)
      const call1Args = (execCli.mock.calls as unknown as Array<[string, string[]]>)[0][1]
      expect(call1Args).toContain('--agent')
      expect(call1Args).toContain('antigravity-cli')
      expect(call1Args).toContain('--session-id')
      expect(call1Args).toContain('sess-agy-uuid-1')

      // Membro 2 continua ativo
      expect(getActiveAiMemorySession('agy-squad-2')).toBeDefined()

      // Finaliza o membro 2 com seu próprio sessionId exato
      const res2 = await finalizeAiMemorySession(
        { terminalId: 'agy-squad-2' },
        { execCli }
      )
      expect(res2.finalized).toBe(true)
      expect(execCli).toHaveBeenCalledTimes(2)
      const call2Args = (execCli.mock.calls as unknown as Array<[string, string[]]>)[1][1]
      expect(call2Args).toContain('--session-id')
      expect(call2Args).toContain('sess-agy-uuid-2')
    })

    it('duas sessões Antigravity concorrentes sem sessionId exato não chamam CLI (evita selecionar latest em paralelo)', async () => {
      const execCli = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' }))

      registerActiveAiMemorySession({
        terminalId: 'agy-par-1',
        provider: 'agy',
        harness: 'antigravity',
        workstream: 'ws-par-1',
        workspace: 'devorbit',
        project: 'p-shared',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        sessionId: undefined, // Sem sessionId exato conhecido
        startedAt: Date.now(),
      })

      registerActiveAiMemorySession({
        terminalId: 'agy-par-2',
        provider: 'agy',
        harness: 'antigravity',
        workstream: 'ws-par-2',
        workspace: 'devorbit',
        project: 'p-shared',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        sessionId: undefined,
        startedAt: Date.now(),
      })

      // Tenta finalizar agy-par-1 sem sessionId enquanto agy-par-2 continua vivo
      const res = await finalizeAiMemorySession(
        { terminalId: 'agy-par-1' },
        { execCli }
      )

      // NÃO chama o CLI para evitar que o ai-memory escolha 'latest' e mate a sessão agy-par-2!
      expect(execCli).not.toHaveBeenCalled()
      expect(res.finalized).toBe(false)
      expect(res.message).toContain('seleção de latest evitada')
      // agy-par-1 foi encerrado internamente
      expect(getActiveAiMemorySession('agy-par-1')).toBeUndefined()
      // agy-par-2 permanece intacto
      expect(getActiveAiMemorySession('agy-par-2')).toBeDefined()
    })

    it('sessão Antigravity única sem sessionId exato chama CLI sem --session-id com segurança', async () => {
      const execCli = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' }))

      registerActiveAiMemorySession({
        terminalId: 'agy-single-1',
        provider: 'agy',
        harness: 'antigravity',
        workstream: 'ws-single-1',
        workspace: 'devorbit',
        project: 'p-alone',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        sessionId: undefined,
        startedAt: Date.now(),
      })

      const res = await finalizeAiMemorySession(
        { terminalId: 'agy-single-1' },
        { execCli }
      )

      expect(res.finalized).toBe(true)
      expect(execCli).toHaveBeenCalledTimes(1)
      const callArgs = (execCli.mock.calls as unknown as Array<[string, string[]]>)[0][1]
      expect(callArgs).toContain('--agent')
      expect(callArgs).toContain('antigravity-cli')
      expect(callArgs).not.toContain('--session-id')
    })

    it('permite finalização quando terminalId é reutilizado para nova sessão e protege contra callbacks tardios', async () => {
      const execCli = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' }))

      // 1. Registra Sessão 1 no terminal 'term-reuse-1'
      registerActiveAiMemorySession({
        terminalId: 'term-reuse-1',
        provider: 'agy',
        harness: 'antigravity',
        workstream: 'ws-session-1',
        workspace: 'devorbit',
        project: 'p-reuse',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        sessionId: 'sess-1',
        startedAt: Date.now(),
      })

      // 2. Finaliza Sessão 1
      const res1 = await finalizeAiMemorySession(
        { terminalId: 'term-reuse-1' },
        { execCli }
      )
      expect(res1.finalized).toBe(true)
      expect(execCli).toHaveBeenCalledTimes(1)
      const call1Args = (execCli.mock.calls as unknown as Array<[string, string[]]>)[0][1]
      expect(call1Args).toContain('sess-1')

      // 3. Chamada duplicada imediata para a mesma sessão 1 vira no-op
      const res1Dedup = await finalizeAiMemorySession(
        { terminalId: 'term-reuse-1' },
        { execCli }
      )
      expect(res1Dedup.finalized).toBe(false)
      expect(res1Dedup.message).toContain('já finalizada')
      expect(execCli).toHaveBeenCalledTimes(1)

      // 4. Inicia Sessão 2 no MESMO terminalId 'term-reuse-1'
      registerActiveAiMemorySession({
        terminalId: 'term-reuse-1',
        provider: 'agy',
        harness: 'antigravity',
        workstream: 'ws-session-2',
        workspace: 'devorbit',
        project: 'p-reuse',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        sessionId: 'sess-2',
        startedAt: Date.now(),
      })

      // 5. Simula callback tardio da Sessão 1 chegando após o início da Sessão 2
      const lateCall = await finalizeAiMemorySession(
        { terminalId: 'term-reuse-1', workstream: 'ws-session-1', generation: 1 },
        { execCli }
      )
      expect(lateCall.finalized).toBe(false)
      expect(lateCall.message).toContain('já finalizada')
      // CLI NÃO deve ser chamado pelo callback tardio
      expect(execCli).toHaveBeenCalledTimes(1)
      // Sessão 2 continua ativa
      expect(getActiveAiMemorySession('term-reuse-1')?.workstream).toBe('ws-session-2')

      // 6. Finaliza Sessão 2 no mesmo terminalId
      const res2 = await finalizeAiMemorySession(
        { terminalId: 'term-reuse-1' },
        { execCli }
      )
      expect(res2.finalized).toBe(true)
      expect(execCli).toHaveBeenCalledTimes(2)
      const call2Args = (execCli.mock.calls as unknown as Array<[string, string[]]>)[1][1]
      expect(call2Args).toContain('sess-2')
    })

    it('protege duas sessões Antigravity com overlap que encerram sequencialmente sem sessionId de usar latest', async () => {
      const execCli = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' }))

      // 1. Registra duas sessões Antigravity concorrentes no mesmo projeto/workspace sem sessionId
      registerActiveAiMemorySession({
        terminalId: 'agy-overlap-1',
        provider: 'agy',
        harness: 'antigravity',
        workstream: 'ws-overlap-1',
        workspace: 'devorbit',
        project: 'p-overlap',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        startedAt: Date.now(),
      })
      registerActiveAiMemorySession({
        terminalId: 'agy-overlap-2',
        provider: 'agy',
        harness: 'antigravity',
        workstream: 'ws-overlap-2',
        workspace: 'devorbit',
        project: 'p-overlap',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        startedAt: Date.now(),
      })

      // 2. Encerra a primeira sessão
      const res1 = await finalizeAiMemorySession(
        { terminalId: 'agy-overlap-1' },
        { execCli }
      )
      expect(res1.finalized).toBe(false)
      expect(res1.message).toContain('sobreposição')
      // CLI finalize-session NÃO deve ser invocado
      expect(execCli).not.toHaveBeenCalled()

      // 3. Encerra a segunda sessão sequencialmente (agora ela é a única em activeSessions)
      const res2 = await finalizeAiMemorySession(
        { terminalId: 'agy-overlap-2' },
        { execCli }
      )
      // Como ela teve overlap com agy-overlap-1, NÃO deve selecionar latest!
      expect(res2.finalized).toBe(false)
      expect(res2.message).toContain('sobreposição')
      expect(execCli).not.toHaveBeenCalled()
    })

    it('identifica Command Code via isCommandCodeAgent e resolveExplicitFinalizeAgent', () => {
      expect(isCommandCodeAgent('command-code')).toBe(true)
      expect(isCommandCodeAgent('cmdc')).toBe(true)
      expect(isCommandCodeAgent(undefined, 'command-code')).toBe(true)
      expect(isCommandCodeAgent(undefined, undefined, 'command-code')).toBe(true)
      expect(isCommandCodeAgent('opencode')).toBe(false)
      expect(isCommandCodeAgent('gemini')).toBe(false)

      expect(resolveExplicitFinalizeAgent('command-code')).toBe('command-code')
      expect(resolveExplicitFinalizeAgent('agy')).toBe('antigravity-cli')
      expect(resolveExplicitFinalizeAgent('opencode')).toBeNull()
      expect(resolveExplicitFinalizeAgent('gemini')).toBeNull()
    })

    it('executa finalize-session com --agent command-code para Command Code no fechamento do terminal', async () => {
      const execCli = vi.fn(async () => ({ code: 0, stdout: 'cmdc ok', stderr: '' }))

      registerActiveAiMemorySession({
        terminalId: 'cmdc-term-1',
        provider: 'command-code',
        harness: 'command-code',
        workstream: 'ws-cmdc-1',
        workspace: 'devorbit',
        project: 'p1',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        sessionId: 'session-cmdc-123',
        startedAt: Date.now(),
      })

      const result = await finalizeAiMemorySession(
        { terminalId: 'cmdc-term-1' },
        { execCli }
      )

      expect(result.finalized).toBe(true)
      expect(execCli).toHaveBeenCalledTimes(1)
      const [bin, args] = (execCli.mock.calls as unknown as Array<[string, string[]]>)[0]
      expect(bin).toBe('C:\\bin\\ai-memory.exe')
      expect(args).toEqual([
        '--data-dir',
        'C:\\data',
        'finalize-session',
        '--agent',
        'command-code',
        '--session-id',
        'session-cmdc-123',
        '--workspace',
        'devorbit',
        '--project',
        'p1',
      ])
      // NUNCA deve incluir --all
      expect(args).not.toContain('--all')
    })

    it('duas sessões Command Code concorrentes sem sessionId exato não chamam CLI (evita selecionar latest em paralelo)', async () => {
      const execCli = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' }))

      registerActiveAiMemorySession({
        terminalId: 'cmdc-conc-1',
        provider: 'command-code',
        harness: 'command-code',
        workstream: 'ws-cmdc-c1',
        workspace: 'devorbit',
        project: 'p-cmdc',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        sessionId: undefined,
        startedAt: Date.now(),
      })

      registerActiveAiMemorySession({
        terminalId: 'cmdc-conc-2',
        provider: 'command-code',
        harness: 'command-code',
        workstream: 'ws-cmdc-c2',
        workspace: 'devorbit',
        project: 'p-cmdc',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        sessionId: undefined,
        startedAt: Date.now(),
      })

      expect(hasParallelCommandCodeSessions('cmdc-conc-1', 'p-cmdc', 'devorbit')).toBe(true)

      const res = await finalizeAiMemorySession(
        { terminalId: 'cmdc-conc-1' },
        { execCli }
      )

      expect(res.finalized).toBe(false)
      expect(res.message).toContain('sobreposição')
      expect(execCli).not.toHaveBeenCalled()
    })

    it('duas sessões Command Code com sobreposição que encerram sequencialmente sem sessionId evitam latest para ambas', async () => {
      const execCli = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' }))

      registerActiveAiMemorySession({
        terminalId: 'cmdc-seq-1',
        provider: 'command-code',
        harness: 'command-code',
        workstream: 'ws-seq-1',
        workspace: 'devorbit',
        project: 'p-seq',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        sessionId: undefined,
        startedAt: Date.now(),
      })

      registerActiveAiMemorySession({
        terminalId: 'cmdc-seq-2',
        provider: 'command-code',
        harness: 'command-code',
        workstream: 'ws-seq-2',
        workspace: 'devorbit',
        project: 'p-seq',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        sessionId: undefined,
        startedAt: Date.now(),
      })

      // Encerra a primeira sessão
      const res1 = await finalizeAiMemorySession(
        { terminalId: 'cmdc-seq-1' },
        { execCli }
      )
      expect(res1.finalized).toBe(false)
      expect(res1.message).toContain('sobreposição')
      expect(execCli).not.toHaveBeenCalled()

      // Encerra a segunda sessão sequencialmente (agora ela é a única em activeSessions)
      const res2 = await finalizeAiMemorySession(
        { terminalId: 'cmdc-seq-2' },
        { execCli }
      )
      // Como ela teve overlap com cmdc-seq-1, NÃO deve selecionar latest!
      expect(res2.finalized).toBe(false)
      expect(res2.message).toContain('sobreposição')
      expect(execCli).not.toHaveBeenCalled()
    })
  })

  describe('ensureAllowlistCaptureMode', () => {
    it('cria capture-mode com allowlist\n se o arquivo não existir', async () => {
      const written: Record<string, string> = {}
      const dirs: string[] = []

      const fsMock = {
        readFile: vi.fn(async () => {
          throw new Error('ENOENT')
        }),
        writeFile: vi.fn(async (target: string, content: string) => {
          written[target] = content
        }),
        mkdir: vi.fn(async (dir: string) => {
          dirs.push(dir)
        }),
      }

      const ok = await ensureAllowlistCaptureMode('C:\\test\\data', fsMock)
      expect(ok).toBe(true)
      expect(dirs).toContain('C:\\test\\data')
      // Chave portável: a produção monta o alvo com path.join — o separador
      // difere entre Windows ('\\') e POSIX ('/') e a asserção literal quebrava
      // no CI Linux/macOS.
      expect(written[path.join('C:\\test\\data', AI_MEMORY_CAPTURE_MODE_FILE)]).toBe('allowlist\n')
    })

    it('mantém o arquivo intacto se já contiver allowlist', async () => {
      const fsMock = {
        readFile: vi.fn(async () => 'allowlist\n'),
        writeFile: vi.fn(async () => {}),
        mkdir: vi.fn(async () => {}),
      }

      const ok = await ensureAllowlistCaptureMode('C:\\test\\data', fsMock)
      expect(ok).toBe(true)
      expect(fsMock.writeFile).not.toHaveBeenCalled()
    })

    it('retorna false caso ocorra falha de escrita', async () => {
      const fsMock = {
        readFile: vi.fn(async () => {
          throw new Error('ENOENT')
        }),
        writeFile: vi.fn(async () => {
          throw new Error('EACCES: permission denied')
        }),
        mkdir: vi.fn(async () => {}),
      }

      const ok = await ensureAllowlistCaptureMode('C:\\test\\data', fsMock)
      expect(ok).toBe(false)
    })
  })

  describe('installHarnessAllowlistHooks', () => {
    it('executa ai-memory install-hooks com --apply --capture-mode allowlist e agent mapeado', async () => {
      const execCli = vi.fn(async () => ({ code: 0, stdout: 'installed', stderr: '' }))

      const res = await installHarnessAllowlistHooks(
        {
          binaryPath: 'C:\\bin\\ai-memory.exe',
          dataDir: 'C:\\data',
          agent: 'codex',
          env: { CODEX_HOME: 'C:\\Users\\user\\.codex-conta1' },
        },
        { execCli }
      )

      expect(res.success).toBe(true)
      expect(execCli).toHaveBeenCalledTimes(1)
      const [bin, args, opts] = (execCli.mock.calls as unknown as Array<[string, string[], { env?: NodeJS.ProcessEnv }]>)[0]
      expect(bin).toBe('C:\\bin\\ai-memory.exe')
      expect(args).toEqual([
        '--data-dir',
        'C:\\data',
        'install-hooks',
        '--apply',
        '--capture-mode',
        'allowlist',
        '--agent',
        'codex',
      ])
      // CODEX_HOME deve estar presente nas opções de env passadas para o comando
      expect(opts?.env?.CODEX_HOME).toBe('C:\\Users\\user\\.codex-conta1')
    })

    it('retorna falha imediata para harness sem suporte de instalação (ex: gemini)', async () => {
      const execCli = vi.fn()

      const res = await installHarnessAllowlistHooks(
        {
          binaryPath: 'C:\\bin\\ai-memory.exe',
          dataDir: 'C:\\data',
          agent: 'gemini',
        },
        { execCli }
      )

      expect(res.success).toBe(false)
      expect(res.message).toContain('não suporta instalação')
      expect(execCli).not.toHaveBeenCalled()
    })
  })

  describe('globalAiMemoryService wiring e ciclo de vida', () => {
    it('prepareAiMemoryLaunch consome o service bootstrapped via setGlobalAiMemoryService', async () => {
      const fakeScope = {
        workspace: 'devorbit',
        project: 'my-project',
        identity: 'id-proj-1',
        root: 'C:\\projects\\my-project',
        source: 'path' as const,
      }
      const service = {
        status: vi.fn((): AiMemoryStatus => ({
          state: 'running',
          owned: true,
          binaryPath: 'C:\\bin\\ai-memory.exe',
        })),
        health: vi.fn(async () => ({ ok: true })),
        resolveScope: vi.fn(async () => fakeScope),
        ensureProjectMarker: vi.fn(async (): Promise<AiMemoryMarkerWriteResult> => ({
          configured: true,
          status: 'unchanged',
          path: 'C:\\projects\\my-project\\.ai-memory.toml',
        })),
        isProjectEnabled: vi.fn(() => true),
      }
      setGlobalAiMemoryService(service)

      const plan = await prepareAiMemoryLaunch(
        {
          provider: 'opencode',
          resolvedCommand: 'C:\\bin\\opencode.cmd',
          originalArgs: [],
          env: {},
          cwd: 'C:\\projects\\my-project',
          terminalId: 'term-bootstrap-1',
        },
        {
          getDataDir: () => 'C:\\devorbit\\data',
          getUserDataDir: () => 'C:\\devorbit\\userdata',
          ensureAllowlistMode: async () => true,
          setupAgent: async () => ({ status: 'already-installed', mcp: 'skipped', hooks: 'skipped' }),
        }
      )

      expect(plan.wrapped).toBe(true)
      expect(plan.command).toBe('C:\\bin\\ai-memory.exe')
      expect(service.status).toHaveBeenCalled()
    })

    it('reseta para fallback transparente quando o service é desacoplado no shutdown', async () => {
      // Simula shutdown chamando setGlobalAiMemoryService(null)
      setGlobalAiMemoryService(null)

      const plan = await prepareAiMemoryLaunch({
        provider: 'opencode',
        resolvedCommand: 'C:\\bin\\opencode.cmd',
        originalArgs: [],
        env: {},
        cwd: 'C:\\projects\\my-project',
        terminalId: 'term-shutdown-1',
      })

      expect(plan.wrapped).toBe(false)
      expect(plan.degradedReason).toBe('service-unavailable')
      expect(plan.command).toBe('C:\\bin\\opencode.cmd')
    })
  })

  describe('drainPendingAiMemoryFinalizations (bounded shutdown finalizer)', () => {
    it('retorna imediatamente com drained: true quando não há finalizações em voo', async () => {
      const outcome = await drainPendingAiMemoryFinalizations({ timeoutMs: 1000 })
      expect(outcome.drained).toBe(true)
      expect(outcome.pendingCount).toBe(0)
    })

    it('aguarda finalização em voo e conclui com drained: true', async () => {
      let resolveCli: (val: any) => void
      const deferred = new Promise<any>((res) => {
        resolveCli = res
      })
      const execCli = vi.fn(async () => deferred)

      registerActiveAiMemorySession({
        terminalId: 'term-drain-1',
        provider: 'agy',
        harness: 'antigravity',
        workstream: 'ws-drain-1',
        workspace: 'devorbit',
        project: 'p1',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        sessionId: 'sess-drain-1',
        startedAt: Date.now(),
      })

      // Inicia a finalização (fica em voo)
      const finalizationPromise = finalizeAiMemorySession(
        { terminalId: 'term-drain-1' },
        { execCli }
      )

      // Agenda resolução do CLI após 20ms
      setTimeout(() => {
        resolveCli({ code: 0, stdout: 'done', stderr: '' })
      }, 20)

      const drainOutcome = await drainPendingAiMemoryFinalizations({ timeoutMs: 2000 })
      expect(drainOutcome.drained).toBe(true)
      expect(drainOutcome.pendingCount).toBe(0)

      const res = await finalizationPromise
      expect(res.finalized).toBe(true)
    })

    it('faz fallback gracioso em caso de timeout sem estourar unhandled error', async () => {
      // CLI que nunca responde (simula deadlock ou processo zumbi)
      const execCli = vi.fn(async () => new Promise<any>(() => {}))

      registerActiveAiMemorySession({
        terminalId: 'term-drain-hang',
        provider: 'agy',
        harness: 'antigravity',
        workstream: 'ws-hang-1',
        workspace: 'devorbit',
        project: 'p1',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        sessionId: 'sess-hang-1',
        startedAt: Date.now(),
      })

      void finalizeAiMemorySession(
        { terminalId: 'term-drain-hang' },
        { execCli }
      )

      // Timeout curto de 40ms
      const drainOutcome = await drainPendingAiMemoryFinalizations({ timeoutMs: 40 })
      expect(drainOutcome.drained).toBe(false)
      expect(drainOutcome.pendingCount).toBe(1)
    })

    it('lida graciosamente com rejeição/falha no CLI sem quebrar o drain', async () => {
      const execCli = vi.fn(async () => {
        throw new Error('EPIPE: broken pipe to daemon')
      })

      registerActiveAiMemorySession({
        terminalId: 'term-drain-error',
        provider: 'agy',
        harness: 'antigravity',
        workstream: 'ws-err-1',
        workspace: 'devorbit',
        project: 'p1',
        dataDir: 'C:\\data',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        sessionId: 'sess-err-1',
        startedAt: Date.now(),
      })

      void finalizeAiMemorySession(
        { terminalId: 'term-drain-error' },
        { execCli }
      )

      const drainOutcome = await drainPendingAiMemoryFinalizations({ timeoutMs: 1000 })
      // Mesmo com rejeição, o drain settle todas as promises graciosamente
      expect(drainOutcome.drained).toBe(true)
      expect(drainOutcome.pendingCount).toBe(0)
    })
  })

  describe('setup nativo por provider no launch (v2.4.0 — complementar ao run)', () => {
    const makeService = () => ({
      status: vi.fn((): AiMemoryStatus => ({
        state: 'running' as const,
        owned: true,
        binaryPath: 'C:\\bin\\ai-memory.exe',
      })),
      health: vi.fn(async () => ({ ok: true })),
      resolveScope: vi.fn(async () => ({
        workspace: 'devorbit',
        project: 'my-project',
        identity: 'id-setup-1',
        root: 'C:\\projects\\my-project',
        source: 'path' as const,
      })),
      ensureProjectMarker: vi.fn(async (): Promise<AiMemoryMarkerWriteResult> => ({
        configured: true,
        status: 'unchanged' as const,
        path: 'C:\\projects\\my-project\\.ai-memory.toml',
      })),
      isProjectEnabled: vi.fn(() => true),
    })

    it('codex: setup ANTES do run com codexHome do env; wrapped segue; env do harness nunca vai ao setup', async () => {
      const service = makeService()
      const setup = vi.fn<
        (request: AiMemoryAgentSetupRequest, deps: AiMemoryAgentSetupDeps) => Promise<AiMemoryAgentSetupResult>
      >(async () => ({ status: 'installed', mcp: 'installed', hooks: 'installed' }))
      const plan = await prepareAiMemoryLaunch(
        {
          provider: 'codex',
          resolvedCommand: 'C:\\cli\\codex.cmd',
          originalArgs: [],
          env: { CODEX_HOME: 'C:\\perfis\\.codex-conta2', PATH: 'C:\\Windows', MY_API_TOKEN: 'secret' },
          cwd: 'C:\\projects\\my-project',
          terminalId: 'setup-codex-1',
        },
        {
          getService: () => service,
          getDataDir: () => 'C:\\devorbit\\data',
          getUserDataDir: () => 'C:\\devorbit\\userdata',
          ensureAllowlistMode: async () => true,
          setupAgent: setup,
        }
      )
      expect(plan.wrapped).toBe(true)
      expect(setup).toHaveBeenCalledTimes(1)
      const [request, setupDeps] = setup.mock.calls[0]
      expect(request).toMatchObject({
        optedIn: true,
        provider: 'codex',
        binaryPath: 'C:\\bin\\ai-memory.exe',
        identity: 'id-setup-1',
        dataDir: 'C:\\devorbit\\data',
        cwd: 'C:\\projects\\my-project',
        codexHome: 'C:\\perfis\\.codex-conta2',
      })
      expect(request).not.toHaveProperty('env')
      expect(setupDeps).toEqual({ userDataDir: 'C:\\devorbit\\userdata' })
    })

    it('setup degradado → fallback DIRETO com setup-failed (fail-open, sem bloquear workspace)', async () => {
      const service = makeService()
      const setup = vi.fn(
        async (
          _request: AiMemoryAgentSetupRequest,
          _deps: AiMemoryAgentSetupDeps
        ): Promise<AiMemoryAgentSetupResult> => ({
          status: 'degraded',
          mcp: 'failed',
          hooks: 'installed',
          message: 'install-mcp: boom',
        })
      )
      const plan = await prepareAiMemoryLaunch(
        {
          provider: 'opencode2',
          resolvedCommand: 'C:\\cli\\opencode2.cmd',
          originalArgs: [],
          env: {},
          cwd: 'C:\\projects\\my-project',
          terminalId: 'setup-degraded-1',
        },
        {
          getService: () => service,
          getDataDir: () => 'C:\\devorbit\\data',
          getUserDataDir: () => 'C:\\devorbit\\userdata',
          ensureAllowlistMode: async () => true,
          setupAgent: setup,
        }
      )
      expect(plan.wrapped).toBe(false)
      expect(plan.degradedReason).toBe('setup-failed')
      expect(plan.command).toBe('C:\\cli\\opencode2.cmd')
      expect(getPendingScopeReservation('setup-degraded-1')).toBeUndefined()
    })

    it('aider (sem prova upstream): fallback harness-not-supported ANTES de qualquer setup', async () => {
      const service = makeService()
      const setup = vi.fn(
        async (
          _request: AiMemoryAgentSetupRequest,
          _deps: AiMemoryAgentSetupDeps
        ): Promise<AiMemoryAgentSetupResult> => ({
          status: 'unsupported',
          mcp: 'skipped',
          hooks: 'skipped',
        })
      )
      const plan = await prepareAiMemoryLaunch(
        {
          provider: 'aider',
          resolvedCommand: 'C:\\cli\\aider.cmd',
          originalArgs: [],
          env: {},
          cwd: 'C:\\projects\\my-project',
          terminalId: 'setup-unsupported-1',
        },
        {
          getService: () => service,
          getDataDir: () => 'C:\\devorbit\\data',
          getUserDataDir: () => 'C:\\devorbit\\userdata',
          ensureAllowlistMode: async () => true,
          setupAgent: setup,
        }
      )
      // `harness-not-supported` fica restrito a aider/custom: nem chega ao setup.
      expect(plan.wrapped).toBe(false)
      expect(plan.degradedReason).toBe('harness-not-supported')
      expect(setup).not.toHaveBeenCalled()
    })

    it('opencode: setup MCP-only (stub) roda e o launch segue wrapped', async () => {
      const service = makeService()
      const setup = vi.fn<
        (request: AiMemoryAgentSetupRequest, deps: AiMemoryAgentSetupDeps) => Promise<AiMemoryAgentSetupResult>
      >(async () => ({ status: 'installed', mcp: 'installed', hooks: 'skipped' }))
      const plan = await prepareAiMemoryLaunch(
        {
          provider: 'opencode',
          resolvedCommand: 'C:\\bin\\opencode.cmd',
          originalArgs: [],
          env: {},
          cwd: 'C:\\projects\\my-project',
          terminalId: 'setup-opencode-1',
        },
        {
          getService: () => service,
          getDataDir: () => 'C:\\devorbit\\data',
          getUserDataDir: () => 'C:\\devorbit\\userdata',
          ensureAllowlistMode: async () => true,
          setupAgent: setup,
        }
      )
      expect(plan.wrapped).toBe(true)
      expect(setup).toHaveBeenCalledTimes(1)
      const [request] = setup.mock.calls[0]
      expect(request).toMatchObject({ provider: 'opencode', identity: 'id-setup-1' })
      expect(request).not.toHaveProperty('codexHome')
    })

    it('claude/command-code/antigravity: setup por provider com família correta e launch wrapped', async () => {
      for (const [provider, command] of [
        ['claude', 'C:\\cli\\claude.cmd'],
        ['command-code', 'C:\\cli\\commandcode.cmd'],
        ['agy', 'C:\\cli\\agy.cmd'],
      ] as const) {
        const service = makeService()
        const setup = vi.fn(
          async (
            request: AiMemoryAgentSetupRequest,
            _deps: AiMemoryAgentSetupDeps
          ): Promise<AiMemoryAgentSetupResult> => ({ status: 'already-installed', mcp: 'skipped', hooks: 'skipped' })
        )
        const plan = await prepareAiMemoryLaunch(
          {
            provider,
            resolvedCommand: command,
            originalArgs: [],
            env: { PATH: 'C:\\Windows' },
            cwd: 'C:\\projects\\my-project',
            terminalId: `setup-${provider}-1`,
          },
          {
            getService: () => service,
            getDataDir: () => 'C:\\devorbit\\data',
            getUserDataDir: () => 'C:\\devorbit\\userdata',
            ensureAllowlistMode: async () => true,
            setupAgent: setup,
          }
        )
        expect(plan.wrapped).toBe(true)
        expect(setup).toHaveBeenCalledTimes(1)
        const [request] = setup.mock.calls[0]
        expect(request).toMatchObject({ optedIn: true, provider, identity: 'id-setup-1' })
        expect(request).not.toHaveProperty('codexHome')
        expect(request).not.toHaveProperty('env')
      }
    })

    it('opt-out (isProjectEnabled=false) NÃO chama o setup', async () => {
      const service = { ...makeService(), isProjectEnabled: vi.fn(() => false) }
      const setup = vi.fn<
        (request: AiMemoryAgentSetupRequest, deps: AiMemoryAgentSetupDeps) => Promise<AiMemoryAgentSetupResult>
      >(async () => ({ status: 'installed', mcp: 'installed', hooks: 'installed' }))
      const plan = await prepareAiMemoryLaunch(
        {
          provider: 'codex',
          resolvedCommand: 'C:\\cli\\codex.cmd',
          originalArgs: [],
          env: { CODEX_HOME: 'C:\\perfis\\.codex-conta1' },
          cwd: 'C:\\projects\\my-project',
          terminalId: 'setup-optout-1',
        },
        {
          getService: () => service,
          getDataDir: () => 'C:\\devorbit\\data',
          getUserDataDir: () => 'C:\\devorbit\\userdata',
          ensureAllowlistMode: async () => true,
          setupAgent: setup,
        }
      )
      expect(plan.wrapped).toBe(false)
      expect(plan.degradedReason).toBe('opt-out')
      expect(setup).not.toHaveBeenCalled()
    })
  })
})
