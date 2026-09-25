/**
 * Contenção Windows-only do sidecar ai-memory via Windows Job Object.
 *
 * Um Job Object com `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` é criado por sidecar
 * PRÓPRIO (owned) e o processo spawnado pelo DevOrbit é associado a ele; ao
 * fechar o handle (stop graceful ou fim do processo por crash), o Windows
 * encerra o sidecar — sem `taskkill` e sem varredura de processos.
 *
 * Fronteiras:
 * - Somente o PID do processo que o DevOrbit spawnou é associado, e apenas
 *   após verificar identidade (imagem + horário de criação) contra PID
 *   reciclado. Serviço externo/adotado nunca passa por aqui.
 * - Nenhum processo do app entra no job (updater portable precisa sobreviver).
 * - Fora do Windows é no-op (Mac/Linux inalterados).
 * - Qualquer falha/throw da FFI/API é fail-open SEM vazar handle: o sidecar
 *   continua operando e a limitação fica visível em `status().limitation`.
 */

import { createRequire } from 'node:module'

/** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (winnt.h). */
export const AI_MEMORY_JOB_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
/** `JobObjectExtendedLimitInformation` (JOBOBJECTINFOCLASS). */
export const AI_MEMORY_JOB_EXTENDED_LIMIT_INFORMATION = 9
/** JOBOBJECT_EXTENDED_LIMIT_INFORMATION em x64/arm64 (basic 64 + io 48 + 4 SIZE_T). */
export const AI_MEMORY_JOB_LIMIT_INFO_BYTES = 144
/** Offset de `BasicLimitInformation.LimitFlags` na struct acima. */
export const AI_MEMORY_JOB_LIMIT_FLAGS_OFFSET = 16
/** `PROCESS_SET_QUOTA` (processthreadsapi.h). */
export const AI_MEMORY_PROCESS_SET_QUOTA = 0x0100
/** `PROCESS_TERMINATE` (processthreadsapi.h). */
export const AI_MEMORY_PROCESS_TERMINATE = 0x0001
/** `PROCESS_QUERY_LIMITED_INFORMATION` (para QueryFullProcessImageNameW). */
export const AI_MEMORY_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
/** Tolerância default entre spawn e checagem de criação (clock/arredondamento). */
export const AI_MEMORY_JOB_SPAWN_TOLERANCE_MS = 2_000

/** Buffer de `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` só com KILL_ON_JOB_CLOSE. */
export function buildAiMemoryJobLimitInfo(): Buffer {
  const info = Buffer.alloc(AI_MEMORY_JOB_LIMIT_INFO_BYTES)
  info.writeUInt32LE(AI_MEMORY_JOB_LIMIT_KILL_ON_JOB_CLOSE, AI_MEMORY_JOB_LIMIT_FLAGS_OFFSET)
  return info
}

/** Direitos para `AssignProcessToJobObject` + consulta de imagem. */
export function aiMemoryJobProcessAccess(): number {
  return AI_MEMORY_PROCESS_SET_QUOTA | AI_MEMORY_PROCESS_TERMINATE | AI_MEMORY_PROCESS_QUERY_LIMITED_INFORMATION
}

/**
 * Janela de criação do processo: aceita apenas `creationMs` dentro de
 * `spawnedAtMs ± tolerance`. Mais antigo OU mais novo indica PID reciclado.
 */
export function isWithinSpawnWindow(
  creationMs: number,
  spawnedAtMs: number,
  toleranceMs = AI_MEMORY_JOB_SPAWN_TOLERANCE_MS
): AiMemoryJobVerifyResult {
  if (creationMs + toleranceMs < spawnedAtMs) {
    return { ok: false, reason: 'processo mais antigo que o spawn; PID provavelmente reciclado.' }
  }
  if (creationMs > spawnedAtMs + toleranceMs) {
    return { ok: false, reason: 'processo mais novo que o spawn; PID provavelmente reciclado.' }
  }
  return { ok: true }
}

/** Identidade do child PRÓPRIO, usada contra reuso de PID. */
export interface AiMemoryJobProcessIdentity {
  /** Caminho do binário spawnado pelo DevOrbit (imagem esperada). */
  imagePath?: string
  /** Epoch ms do spawn; criação anterior a isso indica PID reciclado. */
  spawnedAtMs?: number
  /** Tolerância ms para spawnedAtMs (default 2000). */
  toleranceMs?: number
}

export type AiMemoryJobHandle = unknown

export type AiMemoryJobVerifyResult = { ok: true } | { ok: false; reason: string }

/** Backend Win32 injetável (produção usa koffi; testes usam fake). */
export interface AiMemoryJobBackend {
  createJob(): AiMemoryJobHandle | undefined
  configureKillOnClose(job: AiMemoryJobHandle): boolean
  openProcess(pid: number): AiMemoryJobHandle | undefined
  verifyProcessIdentity(processHandle: AiMemoryJobHandle, identity: AiMemoryJobProcessIdentity): AiMemoryJobVerifyResult
  assignProcess(job: AiMemoryJobHandle, processHandle: AiMemoryJobHandle): { ok: boolean; error?: number }
  closeProcess(processHandle: AiMemoryJobHandle): void
  closeJob(job: AiMemoryJobHandle): void
}

export type AiMemoryJobBackendLoadResult = AiMemoryJobBackend | { error: string }
export type AiMemoryJobBackendLoader = () => AiMemoryJobBackendLoadResult

export interface AiMemoryJobContainmentStatus {
  platform: NodeJS.Platform
  supported: boolean
  active: boolean
  limitation?: string
}

export interface AiMemoryJobContainment {
  /** Associa APENAS o pid informado (após identidade); nunca lança. */
  contain(pid: number, identity?: AiMemoryJobProcessIdentity): void
  /** Fecha o handle do job (KILL_ON_JOB_CLOSE); idempotente, nunca lança. */
  release(): void
  status(): AiMemoryJobContainmentStatus
}

export interface AiMemoryJobContainmentOptions {
  platform?: NodeJS.Platform
  backendLoader?: AiMemoryJobBackendLoader
  warn?: (message: string) => void
}

const nodeRequire = createRequire(import.meta.url)

interface KoffiFunction {
  (...args: unknown[]): unknown
}

interface KoffiLibrary {
  func(signature: string): KoffiFunction
}

interface KoffiModule {
  load(path: string): KoffiLibrary
}

const WINDOWS_EPOCH_OFFSET_MS = 11_644_473_600_000

function normalizeBaseName(value: string): string {
  return value.replace(/\\/g, '/').split('/').filter(Boolean).pop()?.toLowerCase() ?? ''
}

/** Backend real: koffi pinado carregado em runtime (nunca no bundle). */
export function loadKoffiJobBackend(): AiMemoryJobBackendLoadResult {
  try {
    const koffi = nodeRequire('koffi') as KoffiModule
    const kernel32 = koffi.load('kernel32.dll')
    const CreateJobObjectW = kernel32.func('void *CreateJobObjectW(void *lpJobAttributes, void *lpName)')
    const SetInformationJobObject = kernel32.func(
      'int SetInformationJobObject(void *hJob, int JobObjectInformationClass, void *lpJobObjectInformation, uint32 cbJobObjectInformationLength)'
    )
    const OpenProcess = kernel32.func('void *OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)')
    const AssignProcessToJobObject = kernel32.func('int AssignProcessToJobObject(void *hJob, void *hProcess)')
    const QueryFullProcessImageNameW = kernel32.func(
      'int QueryFullProcessImageNameW(void *hProcess, uint32 dwFlags, void *lpExeName, void *lpdwSize)'
    )
    const GetProcessTimes = kernel32.func(
      'int GetProcessTimes(void *hProcess, void *lpCreationTime, void *lpExitTime, void *lpKernelTime, void *lpUserTime)'
    )
    const CloseHandle = kernel32.func('int CloseHandle(void *hObject)')
    const GetLastError = kernel32.func('uint32 GetLastError()')

    return {
      createJob: () => CreateJobObjectW(null, null) ?? undefined,
      configureKillOnClose: (job) =>
        Boolean(
          SetInformationJobObject(
            job,
            AI_MEMORY_JOB_EXTENDED_LIMIT_INFORMATION,
            buildAiMemoryJobLimitInfo(),
            AI_MEMORY_JOB_LIMIT_INFO_BYTES
          )
        ),
      openProcess: (pid) => OpenProcess(aiMemoryJobProcessAccess(), 0, pid) ?? undefined,
      verifyProcessIdentity: (processHandle, identity) => {
        if (identity.imagePath) {
          const expected = normalizeBaseName(identity.imagePath)
          const nameBuffer = Buffer.alloc(1024 * 2)
          const sizeBuffer = Buffer.alloc(4)
          sizeBuffer.writeUInt32LE(1024, 0)
          const ok = Boolean(QueryFullProcessImageNameW(processHandle, 0, nameBuffer, sizeBuffer))
          if (!ok) {
            return { ok: false, reason: `imagem do processo não pôde ser lida (erro ${Number(GetLastError())}).` }
          }
          const chars = sizeBuffer.readUInt32LE(0)
          const actual = nameBuffer.toString('utf16le', 0, Math.max(0, chars) * 2)
          if (expected && normalizeBaseName(actual) !== expected) {
            return { ok: false, reason: `imagem inesperada (${actual || 'desconhecida'}).` }
          }
        }
        if (identity.spawnedAtMs !== undefined) {
          const creationBuffer = Buffer.alloc(8)
          const exitBuffer = Buffer.alloc(8)
          const kernelBuffer = Buffer.alloc(8)
          const userBuffer = Buffer.alloc(8)
          const ok = Boolean(GetProcessTimes(processHandle, creationBuffer, exitBuffer, kernelBuffer, userBuffer))
          if (!ok) {
            return { ok: false, reason: `horário de criação não pôde ser lido (erro ${Number(GetLastError())}).` }
          }
          const creationMs = Number(creationBuffer.readBigUInt64LE(0) / 10_000n) - WINDOWS_EPOCH_OFFSET_MS
          const window = isWithinSpawnWindow(creationMs, identity.spawnedAtMs, identity.toleranceMs)
          if (!window.ok) return window
        }
        return { ok: true }
      },
      assignProcess: (job, processHandle) => {
        const ok = Boolean(AssignProcessToJobObject(job, processHandle))
        return ok ? { ok: true } : { ok: false, error: Number(GetLastError()) }
      },
      closeProcess: (processHandle) => {
        try {
          CloseHandle(processHandle)
        } catch {
          // Handle já inválido.
        }
      },
      closeJob: (job) => {
        try {
          CloseHandle(job)
        } catch {
          // Handle já inválido: job destruído pelo SO.
        }
      },
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Contenção por sidecar: cria um Job Object novo a cada associação e o fecha
 * em `release()` (ou no fim do processo DevOrbit, pelo SO). Nunca lança e
 * nunca deixa handle aberto em caminho de falha.
 */
export function createAiMemoryJobContainment(
  options: AiMemoryJobContainmentOptions = {}
): AiMemoryJobContainment {
  const platform = options.platform ?? process.platform
  const loader = options.backendLoader ?? loadKoffiJobBackend
  const warn = options.warn ?? ((message: string) => console.warn(`[DevOrbit ai-memory] ${message}`))

  let backend: AiMemoryJobBackend | undefined
  let backendLoaded = false
  let job: AiMemoryJobHandle | undefined
  let active = false
  let limitation: string | undefined

  const setLimitation = (message: string): void => {
    limitation = message
    warn(message)
  }

  const closeJob = (target: AiMemoryJobHandle | undefined): void => {
    if (target === undefined) return
    try {
      backend?.closeJob(target)
    } catch {
      // Nunca propaga falha de close: fail-open.
    }
  }

  const release = (): void => {
    const current = job
    job = undefined
    active = false
    closeJob(current)
  }

  return {
    contain(pid: number, identity: AiMemoryJobProcessIdentity = {}): void {
      if (platform !== 'win32') return
      release()
      if (!backendLoaded) {
        backendLoaded = true
        try {
          const result = loader()
          if ('error' in result) {
            setLimitation(`Job Object indisponível: ${result.error}`)
            return
          }
          backend = result
        } catch (error) {
          setLimitation(`Job Object indisponível: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
      }
      if (!backend) return
      if (!Number.isInteger(pid) || pid <= 0) {
        setLimitation('processo do sidecar sem pid válido; contenção Job Object indisponível.')
        return
      }

      let created: AiMemoryJobHandle | undefined
      let processHandle: AiMemoryJobHandle | undefined
      try {
        created = backend.createJob()
        if (created === undefined) {
          setLimitation('não foi possível criar o Job Object do sidecar.')
          return
        }
        if (!backend.configureKillOnClose(created)) {
          setLimitation('não foi possível configurar JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.')
          return
        }
        processHandle = backend.openProcess(pid)
        if (processHandle === undefined) {
          setLimitation(`não foi possível abrir o processo do sidecar (pid ${pid}).`)
          return
        }
        const identityCheck = backend.verifyProcessIdentity(processHandle, identity)
        if (!identityCheck.ok) {
          setLimitation(`processo do sidecar não confere com o spawn (${identityCheck.reason})`)
          return
        }
        const assigned = backend.assignProcess(created, processHandle)
        if (!assigned.ok) {
          setLimitation(
            `não foi possível associar o sidecar ao Job Object${assigned.error !== undefined ? ` (erro ${assigned.error})` : ''}.`
          )
          return
        }
        job = created
        active = true
        limitation = undefined
      } catch (error) {
        setLimitation(`falha ao conter o sidecar no Job Object: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        if (processHandle !== undefined) {
          try {
            backend.closeProcess(processHandle)
          } catch {
            // Fechamento do handle do processo nunca muda o resultado.
          }
        }
        if (job !== created) closeJob(created)
      }
    },

    release,

    status(): AiMemoryJobContainmentStatus {
      return {
        platform,
        supported: platform === 'win32',
        active,
        ...(limitation !== undefined ? { limitation } : {}),
      }
    },
  }
}
