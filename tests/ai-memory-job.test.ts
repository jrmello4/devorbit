import { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  AI_MEMORY_JOB_EXTENDED_LIMIT_INFORMATION,
  AI_MEMORY_JOB_LIMIT_FLAGS_OFFSET,
  AI_MEMORY_JOB_LIMIT_INFO_BYTES,
  AI_MEMORY_JOB_LIMIT_KILL_ON_JOB_CLOSE,
  AI_MEMORY_PROCESS_QUERY_LIMITED_INFORMATION,
  AI_MEMORY_PROCESS_SET_QUOTA,
  AI_MEMORY_PROCESS_TERMINATE,
  AI_MEMORY_JOB_SPAWN_TOLERANCE_MS,
  aiMemoryJobProcessAccess,
  buildAiMemoryJobLimitInfo,
  createAiMemoryJobContainment,
  isWithinSpawnWindow,
  type AiMemoryJobBackend,
  type AiMemoryJobProcessIdentity,
} from '../src/main/ai-memory-job'

interface FakeBackendHarness {
  backend: AiMemoryJobBackend
  job: { id: string }
  process: { pid: number }
  createCalls: number
  configureCalls: unknown[]
  openCalls: number[]
  verifyCalls: Array<{ handle: unknown; identity: AiMemoryJobProcessIdentity }>
  assignCalls: Array<{ job: unknown; process: unknown }>
  closeProcessCalls: unknown[]
  closeJobCalls: unknown[]
}

function fakeBackend(overrides: Partial<AiMemoryJobBackend> = {}): FakeBackendHarness {
  const job = { id: 'job-1' }
  const process = { pid: 0 }
  const harness: FakeBackendHarness = {
    job,
    process,
    createCalls: 0,
    configureCalls: [],
    openCalls: [],
    verifyCalls: [],
    assignCalls: [],
    closeProcessCalls: [],
    closeJobCalls: [],
    backend: {
      createJob: () => {
        harness.createCalls += 1
        return job
      },
      configureKillOnClose: (target) => {
        harness.configureCalls.push(target)
        return true
      },
      openProcess: (pid) => {
        harness.openCalls.push(pid)
        harness.process = { pid }
        return harness.process
      },
      verifyProcessIdentity: (handle, identity) => {
        harness.verifyCalls.push({ handle, identity })
        return { ok: true }
      },
      assignProcess: (target, processHandle) => {
        harness.assignCalls.push({ job: target, process: processHandle })
        return { ok: true }
      },
      closeProcess: (processHandle) => {
        harness.closeProcessCalls.push(processHandle)
      },
      closeJob: (target) => {
        harness.closeJobCalls.push(target)
      },
      ...overrides,
    },
  }
  return harness
}

function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = (): void => {
      if (predicate()) return resolve(true)
      if (Date.now() > deadline) return resolve(false)
      setTimeout(tick, 100)
    }
    tick()
  })
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const IDENTITY: AiMemoryJobProcessIdentity = { imagePath: 'C:\\bin\\ai-memory.exe', spawnedAtMs: 1_000 }

describe('ai-memory job containment — flags e contrato Win32', () => {
  it('monta o JOBOBJECT_EXTENDED_LIMIT_INFORMATION só com KILL_ON_JOB_CLOSE', () => {
    expect(AI_MEMORY_JOB_LIMIT_KILL_ON_JOB_CLOSE).toBe(0x2000)
    expect(AI_MEMORY_JOB_EXTENDED_LIMIT_INFORMATION).toBe(9)
    expect(AI_MEMORY_JOB_LIMIT_INFO_BYTES).toBe(144)
    expect(AI_MEMORY_JOB_LIMIT_FLAGS_OFFSET).toBe(16)
    const info = buildAiMemoryJobLimitInfo()
    expect(info.length).toBe(144)
    expect(info.readUInt32LE(16)).toBe(0x2000)
    const zeroes = info.filter((_value, index) => index < 16 || index >= 20)
    expect(zeroes.every((byte) => byte === 0)).toBe(true)
    expect(aiMemoryJobProcessAccess()).toBe(
      AI_MEMORY_PROCESS_SET_QUOTA | AI_MEMORY_PROCESS_TERMINATE | AI_MEMORY_PROCESS_QUERY_LIMITED_INFORMATION
    )
  })
})

describe('ai-memory job containment — janela de criação do processo', () => {
  const spawnAt = 1_000_000

  it('aceita criação dentro da janela (inclusive nas bordas)', () => {
    expect(isWithinSpawnWindow(spawnAt, spawnAt).ok).toBe(true)
    expect(isWithinSpawnWindow(spawnAt - AI_MEMORY_JOB_SPAWN_TOLERANCE_MS, spawnAt).ok).toBe(true)
    expect(isWithinSpawnWindow(spawnAt + AI_MEMORY_JOB_SPAWN_TOLERANCE_MS, spawnAt).ok).toBe(true)
  })

  it('rejeita processo ANTERIOR à janela do spawn', () => {
    const result = isWithinSpawnWindow(spawnAt - AI_MEMORY_JOB_SPAWN_TOLERANCE_MS - 1, spawnAt)
    expect(result).toMatchObject({ ok: false })
    expect(result.ok === false && result.reason).toContain('mais antigo que o spawn')
  })

  it('rejeita processo POSTERIOR à janela do spawn (PID reciclado)', () => {
    const result = isWithinSpawnWindow(spawnAt + AI_MEMORY_JOB_SPAWN_TOLERANCE_MS + 1, spawnAt)
    expect(result).toMatchObject({ ok: false })
    expect(result.ok === false && result.reason).toContain('mais novo que o spawn')
  })

  it('respeita tolerância customizada', () => {
    expect(isWithinSpawnWindow(spawnAt + 5_000, spawnAt, 10_000).ok).toBe(true)
    expect(isWithinSpawnWindow(spawnAt + 5_000, spawnAt, 1_000).ok).toBe(false)
  })
})

describe('ai-memory job containment — injeção do backend', () => {
  it('non-win32 é no-op: não carrega backend e não reporta limitação', () => {
    const loader = vi.fn()
    const containment = createAiMemoryJobContainment({ platform: 'darwin', backendLoader: loader })
    containment.contain(1234, IDENTITY)
    containment.release()
    expect(loader).not.toHaveBeenCalled()
    expect(containment.status()).toEqual({ platform: 'darwin', supported: false, active: false })
  })

  it('verifica identidade, associa o processo e fecha o handle do processo', () => {
    const harness = fakeBackend()
    const containment = createAiMemoryJobContainment({
      platform: 'win32',
      backendLoader: () => harness.backend,
      warn: () => undefined,
    })
    containment.contain(4242, IDENTITY)
    expect(harness.createCalls).toBe(1)
    expect(harness.configureCalls).toEqual([harness.job])
    expect(harness.openCalls).toEqual([4242])
    expect(harness.verifyCalls).toEqual([{ handle: harness.process, identity: IDENTITY }])
    expect(harness.assignCalls).toEqual([{ job: harness.job, process: harness.process }])
    expect(harness.closeProcessCalls).toEqual([harness.process])
    expect(harness.closeJobCalls).toHaveLength(0)
    expect(containment.status()).toMatchObject({ supported: true, active: true })
    expect(containment.status().limitation).toBeUndefined()

    containment.release()
    expect(harness.closeJobCalls).toEqual([harness.job])
    expect(containment.status().active).toBe(false)
    containment.release()
    expect(harness.closeJobCalls).toHaveLength(1)
  })

  it('identidade divergente não associa, fecha job/processo e reporta limitação', () => {
    const harness = fakeBackend({
      verifyProcessIdentity: () => ({ ok: false, reason: 'PID provavelmente reciclado.' }),
    })
    const containment = createAiMemoryJobContainment({
      platform: 'win32',
      backendLoader: () => harness.backend,
      warn: () => undefined,
    })
    containment.contain(4242, IDENTITY)
    expect(harness.assignCalls).toHaveLength(0)
    expect(harness.closeProcessCalls).toEqual([harness.process])
    expect(harness.closeJobCalls).toEqual([harness.job])
    expect(containment.status().active).toBe(false)
    expect(containment.status().limitation).toContain('não confere com o spawn')
  })

  it('nova associação fecha o job anterior antes de criar outro', () => {
    const harness = fakeBackend()
    const containment = createAiMemoryJobContainment({
      platform: 'win32',
      backendLoader: () => harness.backend,
      warn: () => undefined,
    })
    containment.contain(1, IDENTITY)
    containment.contain(2, IDENTITY)
    expect(harness.createCalls).toBe(2)
    expect(harness.closeJobCalls).toEqual([harness.job])
    expect(harness.assignCalls.at(-1)).toEqual({ job: harness.job, process: { pid: 2 } })
  })

  it('falha ao criar o job vira limitação fail-open (sem throw e sem handle)', () => {
    const harness = fakeBackend({ createJob: () => undefined })
    const containment = createAiMemoryJobContainment({
      platform: 'win32',
      backendLoader: () => harness.backend,
      warn: () => undefined,
    })
    expect(() => containment.contain(10, IDENTITY)).not.toThrow()
    expect(containment.status().active).toBe(false)
    expect(containment.status().limitation).toContain('criar o Job Object')
  })

  it('throw ao configurar fecha o job criado e reporta limitação', () => {
    const harness = fakeBackend({
      configureKillOnClose: () => {
        throw new Error('koffi explodiu no configure')
      },
    })
    const containment = createAiMemoryJobContainment({
      platform: 'win32',
      backendLoader: () => harness.backend,
      warn: () => undefined,
    })
    expect(() => containment.contain(10, IDENTITY)).not.toThrow()
    expect(harness.closeJobCalls).toEqual([harness.job])
    expect(containment.status().limitation).toContain('koffi explodiu no configure')
  })

  it('throw ao associar fecha processo e job, sem vazar handle', () => {
    const harness = fakeBackend({
      assignProcess: () => {
        throw new Error('assign boom')
      },
    })
    const containment = createAiMemoryJobContainment({
      platform: 'win32',
      backendLoader: () => harness.backend,
      warn: () => undefined,
    })
    expect(() => containment.contain(10, IDENTITY)).not.toThrow()
    expect(harness.closeProcessCalls).toEqual([harness.process])
    expect(harness.closeJobCalls).toEqual([harness.job])
    expect(containment.status().limitation).toContain('assign boom')
  })

  it('falha de Assign fecha o job e reporta o erro do SO', () => {
    const harness = fakeBackend({ assignProcess: () => ({ ok: false, error: 5 }) })
    const containment = createAiMemoryJobContainment({
      platform: 'win32',
      backendLoader: () => harness.backend,
      warn: () => undefined,
    })
    containment.contain(10, IDENTITY)
    expect(harness.closeJobCalls).toEqual([harness.job])
    expect(containment.status().limitation).toContain('erro 5')
  })

  it('falha/throw ao carregar a FFI vira limitação e contain é no-op', () => {
    const loaded = createAiMemoryJobContainment({
      platform: 'win32',
      backendLoader: () => ({ error: 'asar bloqueou koffi' }),
      warn: () => undefined,
    })
    loaded.contain(10, IDENTITY)
    loaded.release()
    expect(loaded.status()).toMatchObject({ supported: true, active: false })
    expect(loaded.status().limitation).toContain('asar bloqueou koffi')

    const thrown = createAiMemoryJobContainment({
      platform: 'win32',
      backendLoader: () => {
        throw new Error('dlopen falhou')
      },
      warn: () => undefined,
    })
    expect(() => thrown.contain(10, IDENTITY)).not.toThrow()
    expect(thrown.status().limitation).toContain('dlopen falhou')
  })

  it('throw do closeProcess no caminho de falha não propaga e o job é fechado', () => {
    const harness = fakeBackend({
      assignProcess: () => {
        throw new Error('assign boom')
      },
      closeProcess: () => {
        throw new Error('close process boom')
      },
    })
    const containment = createAiMemoryJobContainment({
      platform: 'win32',
      backendLoader: () => harness.backend,
      warn: () => undefined,
    })
    expect(() => containment.contain(10, IDENTITY)).not.toThrow()
    expect(harness.closeJobCalls).toEqual([harness.job])
    expect(containment.status().active).toBe(false)
    expect(containment.status().limitation).toContain('assign boom')
  })

  it('throw do closeJob no release não propaga e o job deixa de estar ativo', () => {
    const harness = fakeBackend({
      closeJob: () => {
        throw new Error('close job boom')
      },
    })
    const containment = createAiMemoryJobContainment({
      platform: 'win32',
      backendLoader: () => harness.backend,
      warn: () => undefined,
    })
    containment.contain(10, IDENTITY)
    expect(containment.status().active).toBe(true)
    expect(() => containment.release()).not.toThrow()
    expect(containment.status().active).toBe(false)
  })

  it('pid inválido vira limitação sem criar job', () => {
    const harness = fakeBackend()
    const containment = createAiMemoryJobContainment({
      platform: 'win32',
      backendLoader: () => harness.backend,
      warn: () => undefined,
    })
    containment.contain(Number.NaN, IDENTITY)
    expect(harness.createCalls).toBe(0)
    expect(containment.status().limitation).toContain('sem pid válido')
  })
})

describe.runIf(process.platform === 'win32')('ai-memory job containment — kernel real (Windows)', () => {
  function spawnChild(): { pid: number; kill: () => void } {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
    return {
      pid: child.pid as number,
      kill: () => {
        try {
          child.kill()
        } catch {
          // Já encerrado.
        }
      },
    }
  }

  it('KILL_ON_JOB_CLOSE encerra o processo associado ao fechar o handle', async () => {
    const containment = createAiMemoryJobContainment({ warn: () => undefined })
    const spawnedAtMs = Date.now()
    const child = spawnChild()
    try {
      containment.contain(child.pid, { imagePath: process.execPath, spawnedAtMs })
      expect(containment.status()).toMatchObject({ supported: true, active: true })
      expect(containment.status().limitation).toBeUndefined()
      expect(processAlive(child.pid)).toBe(true)

      containment.release()
      const died = await waitUntil(() => !processAlive(child.pid))
      expect(died).toBe(true)
    } finally {
      child.kill()
    }
  })

  it('imagem divergente NÃO é associada nem morta pelo job', async () => {
    const containment = createAiMemoryJobContainment({ warn: () => undefined })
    const spawnedAtMs = Date.now()
    const child = spawnChild()
    try {
      containment.contain(child.pid, { imagePath: 'C:\\outro\\processo.exe', spawnedAtMs })
      expect(containment.status().active).toBe(false)
      expect(containment.status().limitation).toContain('não confere com o spawn')
      containment.release()
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(processAlive(child.pid)).toBe(true)
    } finally {
      child.kill()
    }
  })
})
