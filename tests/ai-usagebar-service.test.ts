import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAiUsagebarService,
  type AiUsagebarFileSystem,
  type AiUsagebarServiceOptions,
} from '../src/main/ai-usagebar-service'
import {
  AI_USAGEBAR_COMMAND_TIMEOUT_MS,
  AI_USAGEBAR_WINDOWS_X64_URL,
  defaultAiUsagebarDownload,
  resolveAiUsagebarPaths,
  setVendorEnabledInConfig,
} from '../src/main/ai-usagebar-config'
import type { AiUsagebarCommandOptions, AiUsagebarCommandResult } from '../src/main/ai-usagebar-client'

const USER_DATA = 'C:\\userData'
const PATHS = resolveAiUsagebarPaths(USER_DATA)
const BINARY = PATHS.binaryPath
const CONFIG = PATHS.configPath
const CONFIG_TEXT = '[openai]\nenabled = true\napi_key = "sk-inline-fixture"\n'
const BINARY_BYTES = Buffer.from('runtime-binary-fixture')
const BINARY_SHA = createHash('sha256').update(BINARY_BYTES).digest('hex')

interface RecordedCall {
  binaryPath: string
  args: string[]
  options: AiUsagebarCommandOptions
}

interface Harness {
  fs: AiUsagebarFileSystem
  files: Map<string, Uint8Array>
  calls: RecordedCall[]
  options: AiUsagebarServiceOptions
}

function memoryFs(seed: Record<string, string | Uint8Array>): {
  fs: AiUsagebarFileSystem
  files: Map<string, Uint8Array>
} {
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>()
  const key = (value: string): string => path.resolve(value).toLowerCase()
  for (const [filePath, content] of Object.entries(seed)) {
    files.set(key(filePath), typeof content === 'string' ? Buffer.from(content) : content)
  }
  const missing = (): NodeJS.ErrnoException => {
    const error = new Error('ENOENT') as NodeJS.ErrnoException
    error.code = 'ENOENT'
    return error
  }
  const fs: AiUsagebarFileSystem = {
    exists: async (filePath) => files.has(key(filePath)) || dirs.has(key(filePath)),
    readFile: async (filePath) => {
      const value = files.get(key(filePath))
      if (!value) throw missing()
      return Buffer.from(value).toString('utf8')
    },
    readFileBytes: async (filePath) => {
      const value = files.get(key(filePath))
      if (!value) throw missing()
      return Buffer.from(value)
    },
    writeFile: async (filePath, data) => {
      files.set(key(filePath), typeof data === 'string' ? Buffer.from(data) : Buffer.from(data))
    },
    mkdir: async (dirPath) => {
      dirs.add(key(dirPath))
    },
    rename: async (from, to) => {
      const value = files.get(key(from))
      if (!value) throw missing()
      files.delete(key(from))
      files.set(key(to), value)
    },
    rm: async (filePath) => {
      files.delete(key(filePath))
    },
  }
  return { fs, files }
}

interface RunnerScript {
  version?: string | (() => string)
  usage?: Partial<AiUsagebarCommandResult> | (() => Partial<AiUsagebarCommandResult> | undefined)
  usageGate?: Promise<void>
  vendors?: () => Partial<AiUsagebarCommandResult> | undefined
  detect?: () => Partial<AiUsagebarCommandResult> | undefined
}

function createHarness(
  seed: Record<string, string | Uint8Array>,
  script: RunnerScript = {},
  overrides: Partial<AiUsagebarServiceOptions> = {}
): Harness {
  const { fs, files } = memoryFs(seed)
  const calls: RecordedCall[] = []
  const runner = async (
    binaryPath: string,
    args: readonly string[],
    options: AiUsagebarCommandOptions
  ): Promise<AiUsagebarCommandResult> => {
    const call: RecordedCall = { binaryPath, args: [...args], options }
    calls.push(call)
    const base: AiUsagebarCommandResult = {
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      stdoutOverflow: false,
      stderrOverflow: false,
    }
    if (args.includes('--version')) {
      const version = typeof script.version === 'function' ? script.version() : script.version ?? '1.24.0'
      return { ...base, stdout: `ai-usagebar ${version}\n` }
    }
    if (args.includes('settings')) return { ...base, stdout: '{"ok":true}' }
    if (args.includes('vendors')) {
      const override = script.vendors?.()
      if (override) return { ...base, ...override }
      return { ...base, stdout: JSON.stringify({ vendors: [{ id: 'openai', name: 'Codex', enabled: true }] }) }
    }
    if (args.includes('detect')) {
      const override = script.detect?.()
      if (override) return { ...base, ...override }
      return { ...base, stdout: JSON.stringify({ enabled: ['openai'], known: ['openai'], probed: 1 }) }
    }
    if (args.includes('usage')) {
      if (script.usageGate) await script.usageGate
      const override =
        typeof script.usage === 'function' ? script.usage() ?? {} : script.usage ?? {}
      if (override.code !== undefined || override.stdout !== undefined || override.stderr !== undefined) {
        return { ...base, ...override }
      }
      return {
        ...base,
        stdout: JSON.stringify({
          schema_version: 1,
          primary: 'openai',
          entries: [{ id: 'openai', name: 'Codex', status: 'ready' }],
        }),
      }
    }
    return base
  }
  const options: AiUsagebarServiceOptions = {
    userDataDir: USER_DATA,
    platform: 'win32',
    arch: 'x64',
    fileSystem: fs,
    runner,
    now: () => 1_700_000_000_000,
    expectedSha256: BINARY_SHA,
    ...overrides,
  }
  return { fs, files, calls, options }
}

function seededBinary(): Record<string, string | Uint8Array> {
  return { [BINARY]: BINARY_BYTES, [CONFIG]: CONFIG_TEXT }
}

function settingsCalls(h: Harness): RecordedCall[] {
  return h.calls.filter((call) => call.args.includes('settings'))
}

describe('ai-usagebar service — lifecycle e fail-open', () => {
  it('fora do Windows x64 fica unavailable e nunca spawna', async () => {
    const h = createHarness(seededBinary(), {}, { platform: 'darwin', arch: 'arm64' })
    const service = createAiUsagebarService(h.options)
    const snapshot = await service.refresh()
    expect(snapshot.state).toBe('unavailable')
    expect(h.calls).toHaveLength(0)
  })

  it('config ausente é criado atomicamente no primeiro uso, sem detect/enable', async () => {
    const h = createHarness({ [BINARY]: BINARY_BYTES })
    const service = createAiUsagebarService(h.options)
    const snapshot = await service.refresh()
    expect(snapshot.state).toBe('ready')

    const key = path.resolve(CONFIG).toLowerCase()
    expect(h.files.has(key)).toBe(true)
    const content = Buffer.from(h.files.get(key)!).toString('utf8')
    expect(content).toContain('ai-usagebar')
    expect(content).not.toMatch(/enabled\s*=/)
    expect(h.files.has(path.resolve(`${CONFIG}.tmp`).toLowerCase())).toBe(false)
    expect(h.calls.some((call) => call.args.includes('detect'))).toBe(false)
    expect(h.calls.some((call) => call.args.includes('settings'))).toBe(false)
    expect(h.calls.some((call) => call.args.includes('usage'))).toBe(true)
  })

  it('catálogo sem vendor habilitado: refresh curto-circuita pronto com relatório vazio e hint', async () => {
    const h = createHarness(seededBinary(), {
      vendors: () => ({
        stdout: JSON.stringify({ vendors: [{ id: 'openai', name: 'Codex', enabled: false }] }),
      }),
    })
    const service = createAiUsagebarService(h.options)
    const snapshot = await service.refresh()
    expect(snapshot.state).toBe('ready')
    expect(snapshot.stale).toBe(false)
    expect(snapshot.report).toEqual({ schema_version: 1, entries: [] })
    expect(snapshot.fetchedAt).toBe(new Date(1_700_000_000_000).toISOString())
    expect(snapshot.message).toContain('Nenhum provedor habilitado')
    expect(h.calls.some((call) => call.args.includes('usage'))).toBe(false)
    expect(h.calls.some((call) => call.args.includes('detect') || call.args.includes('settings'))).toBe(false)
  })

  it('ready popula snapshot com vendors e relatório, e refresh é single-flight', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = createHarness(seededBinary(), { usageGate: gate })
    const service = createAiUsagebarService(h.options)

    const first = service.refresh()
    const second = service.refresh()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.calls.filter((call) => call.args.includes('usage'))).toHaveLength(1)

    release?.()
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(a.state).toBe('ready')
    expect(a.version).toBe('1.24.0')
    expect(a.vendors).toHaveLength(1)
    expect(a.report?.schema_version).toBe(1)
    expect(a.stale).toBe(false)
    expect(a.fetchedAt).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it('runtime divergente tenta substituição validada (self-heal) e fica ready', async () => {
    const payload = Buffer.from('healed-binary')
    const digest = createHash('sha256').update(payload).digest('hex')
    let version = '9.9.9'
    const h = createHarness(
      seededBinary(),
      { version: () => version },
      { expectedSha256: digest }
    )
    const download = vi.fn(async (_url: string, destination: string) => {
      await h.fs.writeFile(destination, payload)
      version = '1.24.0'
    })
    const service = createAiUsagebarService({ ...h.options, download })

    const snapshot = await service.refresh()
    expect(download).toHaveBeenCalledTimes(1)
    expect(snapshot.state).toBe('ready')
    expect(snapshot.version).toBe('1.24.0')
  })

  it('versão divergente com hash VÁLIDO vira error sem baixar nada', async () => {
    const download = vi.fn(async () => {
      throw new Error('download não deveria ser chamado')
    })
    const h = createHarness(seededBinary(), { version: '9.9.9' })
    const service = createAiUsagebarService({ ...h.options, download })
    const snapshot = await service.refresh()
    expect(snapshot.state).toBe('error')
    expect(snapshot.message).toContain('9.9.9')
    expect(snapshot.version).toBeUndefined()
    expect(download).not.toHaveBeenCalled()
  })

  it('runtime adulterado e download falhando vira error sanitizado (fail-open)', async () => {
    const h = createHarness(
      { [BINARY]: Buffer.from('evil-binary'), [CONFIG]: CONFIG_TEXT },
      {},
      { expectedSha256: BINARY_SHA }
    )
    const download = vi.fn(async () => {
      throw new Error('OPENROUTER_API_KEY=sk-leak000000000 falhou no download')
    })
    const service = createAiUsagebarService({ ...h.options, download })
    const snapshot = await service.refresh()
    expect(snapshot.state).toBe('error')
    expect(snapshot.version).toBeUndefined()
    expect(download).toHaveBeenCalledTimes(1)
    expect(snapshot.message).not.toContain('sk-leak000000000')
    expect(snapshot.message).toContain('[redacted]')
  })

  it('falha do usage mantém último relatório stale e sanitiza segredo', async () => {
    let fail = false
    const h = createHarness(seededBinary(), {
      usage: () => (fail ? { code: 1, stderr: 'OPENROUTER_API_KEY=sk-leak123456789 falhou' } : undefined),
    })
    const service = createAiUsagebarService(h.options)
    const ok = await service.refresh()
    expect(ok.state).toBe('ready')

    fail = true
    const degraded = await service.refresh()
    expect(degraded.state).toBe('degraded')
    expect(degraded.stale).toBe(true)
    expect(degraded.report?.entries).toHaveLength(1)
    expect(degraded.message).not.toContain('sk-leak123456789')
    expect(degraded.message).toContain('[redacted]')
  })

  it('falha sem relatório prévio fica error (fail-open, sem throw)', async () => {
    const h = createHarness(seededBinary(), { usage: () => ({ code: 1, stderr: 'indisponível' }) })
    const service = createAiUsagebarService(h.options)
    const snapshot = await service.refresh()
    expect(snapshot.state).toBe('error')
    expect(snapshot.report).toBeUndefined()
  })
})

describe('ai-usagebar service — instalação verificada', () => {
  it('baixa binário, confere SHA-256 e renomeia antes de ready', async () => {
    const payload = Buffer.from('fake-binary-payload')
    const digest = createHash('sha256').update(payload).digest('hex')
    const h = createHarness({ [CONFIG]: CONFIG_TEXT }, {}, { expectedSha256: digest })
    const download = vi.fn(async (_url: string, destination: string) => {
      await h.fs.writeFile(destination, payload)
    })
    const service = createAiUsagebarService({ ...h.options, download })

    const snapshot = await service.refresh()
    expect(download).toHaveBeenCalledWith(AI_USAGEBAR_WINDOWS_X64_URL, `${BINARY}.download`, {
      timeoutMs: undefined,
    })
    expect(snapshot.state).toBe('ready')
    expect(h.files.has(path.resolve(BINARY).toLowerCase())).toBe(true)
    expect(h.files.has(path.resolve(`${BINARY}.download`).toLowerCase())).toBe(false)
  })

  it('SHA-256 divergente descarta o download e vira error', async () => {
    const h = createHarness({ [CONFIG]: CONFIG_TEXT }, {}, { expectedSha256: 'f'.repeat(64) })
    const download = async (_url: string, destination: string): Promise<void> => {
      await h.fs.writeFile(destination, Buffer.from('corrupted'))
    }
    const service = createAiUsagebarService({ ...h.options, download })
    const snapshot = await service.refresh()
    expect(snapshot.state).toBe('error')
    expect(snapshot.message).toContain('SHA-256')
    expect(h.files.has(path.resolve(BINARY).toLowerCase())).toBe(false)
  })

  it('binário empacotado validado é preferido e copiado para o runtime (resources intacto)', async () => {
    const payload = Buffer.from('packaged-binary')
    const digest = createHash('sha256').update(payload).digest('hex')
    const bundled = 'C:\\app\\resources\\ai-usagebar\\ai-usagebar.exe'
    const h = createHarness(
      { [CONFIG]: CONFIG_TEXT, [bundled]: payload },
      {},
      { expectedSha256: digest, bundledBinaryPath: bundled }
    )
    const download = vi.fn(async () => {
      throw new Error('download não deveria ser chamado')
    })
    const service = createAiUsagebarService({ ...h.options, download })

    const snapshot = await service.refresh()
    expect(snapshot.state).toBe('ready')
    expect(download).not.toHaveBeenCalled()
    expect(Buffer.from(h.files.get(path.resolve(BINARY).toLowerCase())!).toString()).toBe('packaged-binary')
    expect(Buffer.from(h.files.get(path.resolve(bundled).toLowerCase())!).toString()).toBe('packaged-binary')
  })

  it('empacotado com hash divergente cai para o download no userData', async () => {
    const payload = Buffer.from('fresh-download')
    const digest = createHash('sha256').update(payload).digest('hex')
    const bundled = 'C:\\app\\resources\\ai-usagebar\\ai-usagebar.exe'
    const h = createHarness(
      { [CONFIG]: CONFIG_TEXT, [bundled]: Buffer.from('tampered') },
      {},
      { expectedSha256: digest, bundledBinaryPath: bundled }
    )
    const download = vi.fn(async (_url: string, destination: string) => {
      await h.fs.writeFile(destination, payload)
    })
    const service = createAiUsagebarService({ ...h.options, download })

    const snapshot = await service.refresh()
    expect(snapshot.state).toBe('ready')
    expect(download).toHaveBeenCalledTimes(1)
    expect(Buffer.from(h.files.get(path.resolve(BINARY).toLowerCase())!).toString()).toBe('fresh-download')
    // resources permanece intacto (nunca escrito).
    expect(Buffer.from(h.files.get(path.resolve(bundled).toLowerCase())!).toString()).toBe('tampered')
  })

  it('timeout do comando nunca passa do teto de 10s', async () => {
    const h = createHarness(seededBinary(), {}, { timeoutMs: 120_000 })
    const service = createAiUsagebarService(h.options)
    await service.refresh()
    for (const call of h.calls) {
      expect(call.options.timeoutMs).toBeLessThanOrEqual(AI_USAGEBAR_COMMAND_TIMEOUT_MS)
      expect(call.options.timeoutMs).toBeLessThanOrEqual(10_000)
    }
  })
})

describe('ai-usagebar service — hash pré-spawn, single-flight e entries com erro', () => {
  it('exe adulterado que reporta versão correta NÃO é executado; é substituído', async () => {
    const goodPayload = Buffer.from('good-runtime-binary')
    const goodDigest = createHash('sha256').update(goodPayload).digest('hex')
    const h = createHarness(
      { [BINARY]: Buffer.from('evil-binary'), [CONFIG]: CONFIG_TEXT },
      {},
      { expectedSha256: goodDigest }
    )
    const events: string[] = []
    const baseRunner = h.options.runner!
    const runner: typeof baseRunner = async (binaryPath, args, options) => {
      if (args.includes('--version')) events.push('version')
      return await baseRunner(binaryPath, args, options)
    }
    const download = vi.fn(async (_url: string, destination: string) => {
      events.push('download')
      await h.fs.writeFile(destination, goodPayload)
    })
    const service = createAiUsagebarService({ ...h.options, runner, download })

    const snapshot = await service.refresh()
    expect(snapshot.state).toBe('ready')
    expect(download).toHaveBeenCalledTimes(1)
    // Nunca executou o binário adulterado: download antes e UMA única chamada
    // de versão (já sobre o binário substituído).
    expect(events).toEqual(['download', 'version'])
    expect(Buffer.from(h.files.get(path.resolve(BINARY).toLowerCase())!)).toEqual(goodPayload)
  })

  it('ensureInstalled é single-flight: chamadas concorrentes instalam uma vez', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = createHarness({ [CONFIG]: CONFIG_TEXT })
    const payload = Buffer.from('single-flight-binary')
    const digest = createHash('sha256').update(payload).digest('hex')
    const download = vi.fn(async (_url: string, destination: string) => {
      await gate
      await h.fs.writeFile(destination, payload)
    })
    const service = createAiUsagebarService({ ...h.options, expectedSha256: digest, download })

    const first = service.ensureInstalled()
    const second = service.ensureInstalled()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(download).toHaveBeenCalledTimes(1)
    release?.()
    const [a, b] = await Promise.all([first, second])
    expect(a.state).toBe('ready')
    expect(b.state).toBe('ready')
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('usage com exit≠0 e documento válido mantém providers bons no snapshot', async () => {
    const mixed = {
      schema_version: 1,
      entries: [
        { id: 'openai', name: 'Codex', status: 'error', error: 'rota de quota indisponível' },
        { id: 'anthropic', name: 'Claude', status: 'ready' },
      ],
    }
    const h = createHarness(seededBinary(), {
      usage: () => ({ code: 1, stderr: 'pior entry: erro', stdout: JSON.stringify(mixed) }),
    })
    const service = createAiUsagebarService(h.options)

    const snapshot = await service.refresh()
    expect(snapshot.state).toBe('ready')
    expect(snapshot.report?.entries).toHaveLength(2)
    expect(snapshot.report?.entries[0]).toMatchObject({ id: 'openai', status: 'error' })
    expect(snapshot.report?.entries[1]).toMatchObject({ id: 'anthropic', status: 'ready' })
  })
})

describe('defaultAiUsagebarDownload — fetch bounded com AbortController', () => {
  const destinations: string[] = []
  function tempDestination(): string {
    const destination = path.join(
      os.tmpdir(),
      `ai-usagebar-dl-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`
    )
    destinations.push(destination)
    return destination
  }

  afterEach(async () => {
    vi.unstubAllGlobals()
    for (const destination of destinations.splice(0)) {
      await fsp.rm(destination, { force: true }).catch(() => undefined)
      await fsp.rm(`${destination}.part`, { force: true }).catch(() => undefined)
    }
  })

  it('baixa bytes e escreve atomicamente (sem .part residual)', async () => {
    const destination = tempDestination()
    vi.stubGlobal(
      'fetch',
      async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => Uint8Array.from(Buffer.from('binary-bytes')).buffer,
      })
    )
    await defaultAiUsagebarDownload('https://example.invalid/a.exe', destination)
    expect(Buffer.from(await fsp.readFile(destination)).toString()).toBe('binary-bytes')
    await expect(fsp.access(`${destination}.part`)).rejects.toBeDefined()
  })

  it('HTTP não-ok falha e não deixa arquivo', async () => {
    const destination = tempDestination()
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 502, arrayBuffer: async () => new ArrayBuffer(0) }))
    await expect(defaultAiUsagebarDownload('https://example.invalid/a.exe', destination)).rejects.toThrow(/502/)
    await expect(fsp.access(destination)).rejects.toBeDefined()
    await expect(fsp.access(`${destination}.part`)).rejects.toBeDefined()
  })

  it('excede maxBytes falha e limpa o temp', async () => {
    const destination = tempDestination()
    vi.stubGlobal(
      'fetch',
      async () => ({ ok: true, status: 200, arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4, 5]).buffer })
    )
    await expect(
      defaultAiUsagebarDownload('https://example.invalid/a.exe', destination, { maxBytes: 4 })
    ).rejects.toThrow(/limite de bytes/)
    await expect(fsp.access(`${destination}.part`)).rejects.toBeDefined()
  })

  it('timeout aborta via AbortController e limpa o temp', async () => {
    const destination = tempDestination()
    vi.stubGlobal(
      'fetch',
      async (_url: string, init?: { signal?: AbortSignal }) =>
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted by signal')))
        })
    )
    await expect(
      defaultAiUsagebarDownload('https://example.invalid/a.exe', destination, { timeoutMs: 20 })
    ).rejects.toThrow(/timeout/)
    await expect(fsp.access(`${destination}.part`)).rejects.toBeDefined()
  })

  interface StreamState {
    pulled: number
    cancelled: boolean
  }

  function stubChunkedResponse(chunks: Buffer[], options: { contentLength?: string } = {}): StreamState {
    const state: StreamState = { pulled: 0, cancelled: false }
    let index = 0
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-length' ? options.contentLength ?? null : null),
      },
      body: {
        getReader: () => ({
          read: async () => {
            if (index >= chunks.length) return { done: true }
            state.pulled += 1
            const value = Uint8Array.from(chunks[index])
            index += 1
            return { done: false, value }
          },
          cancel: async () => {
            state.cancelled = true
          },
          releaseLock: () => undefined,
        }),
      },
      arrayBuffer: async () => Uint8Array.from(Buffer.concat(chunks)).buffer,
    }))
    return state
  }

  it('Content-Length acima do cap é rejeitado ANTES de ler o body', async () => {
    const destination = tempDestination()
    const state = stubChunkedResponse([Buffer.from('12345678')], { contentLength: '8' })
    await expect(
      defaultAiUsagebarDownload('https://example.invalid/a.exe', destination, { maxBytes: 4 })
    ).rejects.toThrow(/limite de bytes/)
    expect(state.pulled).toBe(0)
    await expect(fsp.access(destination)).rejects.toBeDefined()
    await expect(fsp.access(`${destination}.part`)).rejects.toBeDefined()
  })

  it('chunk excessivo aborta e cancela o reader sem bufferizar tudo', async () => {
    const destination = tempDestination()
    const state = stubChunkedResponse([Buffer.from('aaaa'), Buffer.from('bbbb'), Buffer.from('cccc')])
    await expect(
      defaultAiUsagebarDownload('https://example.invalid/a.exe', destination, { maxBytes: 5 })
    ).rejects.toThrow(/limite de bytes/)
    expect(state.pulled).toBe(2)
    expect(state.cancelled).toBe(true)
    await expect(fsp.access(`${destination}.part`)).rejects.toBeDefined()
  })

  it('stream dentro do cap concatena os chunks e grava atômico', async () => {
    const destination = tempDestination()
    const payload = Buffer.from('chunked-binary-bytes')
    stubChunkedResponse([payload.subarray(0, 5), payload.subarray(5, 11), payload.subarray(11)])
    await defaultAiUsagebarDownload('https://example.invalid/a.exe', destination)
    expect(Buffer.from(await fsp.readFile(destination)).toString()).toBe('chunked-binary-bytes')
    await expect(fsp.access(`${destination}.part`)).rejects.toBeDefined()
  })
})

describe('ai-usagebar service — opt-in genérico, detect explícito e segredos', () => {
  it('detect só roda quando chamado explicitamente e nunca no refresh', async () => {
    const h = createHarness(seededBinary())
    const service = createAiUsagebarService(h.options)
    await service.refresh()
    expect(h.calls.some((call) => call.args.includes('detect'))).toBe(false)

    const report = await service.detect({ all: true })
    expect(report.enabled).toEqual(['openai'])
    const detectCalls = h.calls.filter((call) => call.args.includes('detect'))
    expect(detectCalls).toHaveLength(1)
    expect(detectCalls[0].args).toContain('--all')
  })

  it('detect explícito atualiza o catálogo: enabled passa a rodar usage no refresh seguinte', async () => {
    let enabled = false
    const h = createHarness(seededBinary(), {
      vendors: () => ({
        stdout: JSON.stringify({ vendors: [{ id: 'openai', name: 'Codex', enabled }] }),
      }),
      detect: () => {
        enabled = true
        return {
          stdout: JSON.stringify({ enabled: ['openai'], known: ['openai'], probed: 1 }),
        }
      },
    })
    const service = createAiUsagebarService(h.options)

    const before = await service.refresh()
    expect(before.report).toEqual({ schema_version: 1, entries: [] })
    expect(h.calls.some((call) => call.args.includes('usage'))).toBe(false)

    const report = await service.detect()
    expect(report.enabled).toEqual(['openai'])
    // Cache pós-detect já reflete o config mutado (sem esperar novo refresh).
    expect(service.snapshot().vendors[0]?.enabled).toBe(true)

    const after = await service.refresh()
    expect(after.state).toBe('ready')
    expect(after.message).toBeUndefined()
    expect(after.report?.entries).toHaveLength(1)
    expect(h.calls.filter((call) => call.args.includes('usage'))).toHaveLength(1)
  })

  it('detect explícito com vendors falhando invalida o cache (refresh recarrega)', async () => {
    let vendorReads = 0
    const h = createHarness(seededBinary(), {
      vendors: () => {
        vendorReads += 1
        if (vendorReads === 2) return { code: 1, stderr: 'vendors caiu' }
        return { stdout: JSON.stringify({ vendors: [{ id: 'openai', name: 'Codex', enabled: true }] }) }
      },
    })
    const service = createAiUsagebarService(h.options)
    await service.refresh()
    await service.detect()
    expect(service.snapshot().vendors).toEqual([])
  })

  it('enable usa settings enable genérico; disable edita o config local sem CLI de disable', async () => {
    const h = createHarness(seededBinary(), {
      vendors: () => ({
        stdout: JSON.stringify({
          vendors: [
            { id: 'openai', name: 'Codex', enabled: true },
            { id: 'future-vendor', name: 'Future', enabled: false },
          ],
        }),
      }),
    })
    const service = createAiUsagebarService(h.options)
    await service.refresh()

    await service.setVendorEnabled('future-vendor', true)
    expect(settingsCalls(h)).toHaveLength(1)
    expect(settingsCalls(h)[0].args.slice(2)).toEqual(['settings', 'enable', 'future-vendor'])
    expect(settingsCalls(h)[0].args).not.toContain('--cache-dir')

    await service.setVendorEnabled('openai', false)
    expect(settingsCalls(h)).toHaveLength(1)
    const content = Buffer.from(h.files.get(path.resolve(CONFIG).toLowerCase())!).toString('utf8')
    expect(content).toContain('[openai]')
    expect(content).toContain('enabled = false')
    expect(content).toContain('api_key = "sk-inline-fixture"')
    expect(content.match(/enabled =/g)).toHaveLength(1)
  })

  it('id fora do catálogo dinâmico é recusado sem gravar config', async () => {
    const h = createHarness(seededBinary())
    const service = createAiUsagebarService(h.options)
    await service.refresh()
    const before = await h.fs.readFile(CONFIG)
    const callsBefore = h.calls.length

    const snapshot = await service.setVendorEnabled('custom:mytool', true)

    expect(snapshot.state).toBe('degraded')
    expect(snapshot.message).toContain('catálogo')
    expect(h.calls).toHaveLength(callsBefore)
    expect(settingsCalls(h)).toHaveLength(0)
    const after = await h.fs.readFile(CONFIG)
    expect(after).toBe(before)
    expect(after).not.toContain('custom:mytool')
    expect(after).not.toContain('[[custom]]')
  })

  it('edição local nunca cria seção fora de bare key TOML', async () => {
    const content = '[[custom]]\nid = "mytool"\nenabled = false\n'
    expect(setVendorEnabledInConfig(content, 'custom:mytool', true)).toBe(content)
    expect(setVendorEnabledInConfig(content, 'a.b', true)).toBe(content)
  })

  it('id inválido não spawna e mantém estado estável', async () => {
    const h = createHarness(seededBinary())
    const service = createAiUsagebarService(h.options)
    await service.refresh()
    const before = h.calls.length
    const snapshot = await service.setVendorEnabled('bad id; rm -rf', true)
    expect(h.calls).toHaveLength(before)
    expect(snapshot.state).toBe('degraded')
  })

  it('secret env overlay chega ao runner, nunca ao snapshot', async () => {
    const h = createHarness(seededBinary())
    const service = createAiUsagebarService(h.options)
    service.setSecretEnv({ OPENROUTER_API_KEY: 'sk-overlay-1234567890' })

    const snapshot = await service.refresh()
    expect(snapshot.state).toBe('ready')
    const usageCall = h.calls.find((call) => call.args.includes('usage'))
    expect(usageCall?.options.env.OPENROUTER_API_KEY).toBe('sk-overlay-1234567890')
    expect(JSON.stringify(snapshot)).not.toContain('sk-overlay-1234567890')
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined()
  })

  it('account-config usa --config por conta, sem --account, e preserva entries por conta', async () => {
    const accountConfig = 'C:\\userData\\ai-usagebar\\accounts\\work.toml'
    const h = createHarness(
      {
        ...seededBinary(),
        [accountConfig]:
          '[openai]\nenabled = true\n[[openai.accounts]]\nlabel = "work"\ncodex_auth_path = "C:\\\\perfis\\\\.codex-work\\\\auth.json"\n',
      },
      {
        usage: () => ({
          stdout: JSON.stringify({
            schema_version: 1,
            entries: [
              { id: 'openai', name: 'Codex' },
              { id: 'openai@work', name: 'Codex (work)' },
            ],
          }),
        }),
      }
    )
    const service = createAiUsagebarService(h.options)
    service.setAccountConfig(() => ({ configPath: accountConfig }))

    const snapshot = await service.refresh()
    const usageCall = h.calls.find((call) => call.args.includes('usage'))
    expect(usageCall?.args[usageCall.args.indexOf('--config') + 1]).toBe(accountConfig)
    expect(usageCall?.args).not.toContain('--cache-dir')
    // Relatório consolidado (uma chamada) mantém as contas como entries distintas.
    expect(snapshot.report?.entries.map((entry) => entry.id)).toEqual(['openai', 'openai@work'])
    for (const call of h.calls) {
      expect(call.args).not.toContain('--account')
      expect(call.args).not.toContain('--cache-dir')
      expect(call.args.join(' ')).not.toContain('switch')
    }
  })

  it('setSecretEnv invalida o catálogo e refresh vê configured/enabled atualizado', async () => {
    const h = createHarness(seededBinary(), {
      vendors: () => {
        const lastCall = [...h.calls].reverse().find((call) => call.args.includes('vendors'))
        const configured = typeof lastCall?.options.env.OPENROUTER_API_KEY === 'string'
        return {
          stdout: JSON.stringify({
            vendors: [{ id: 'openrouter', name: 'OpenRouter', enabled: true, configured }],
          }),
        }
      },
    })
    const service = createAiUsagebarService(h.options)
    const vendorsCalls = (): number => h.calls.filter((call) => call.args.includes('vendors')).length

    const before = await service.refresh()
    expect(before.vendors[0]).toMatchObject({ enabled: true, configured: false })
    expect(vendorsCalls()).toBe(1)

    service.setSecretEnv({ OPENROUTER_API_KEY: 'sk-overlay-fixture' })
    const after = await service.refresh()
    expect(after.vendors[0]).toMatchObject({ enabled: true, configured: true })
    expect(vendorsCalls()).toBe(2)

    // Overlay idêntico NÃO é mudança efetiva: nada de reload extra.
    service.setSecretEnv({ OPENROUTER_API_KEY: 'sk-overlay-fixture' })
    await service.refresh()
    expect(vendorsCalls()).toBe(2)
  })

  it('setAccountConfig invalida o catálogo e o reload segue o config por conta', async () => {
    const altConfig = 'C:\\userData\\ai-usagebar\\accounts\\work.toml'
    const h = createHarness({ ...seededBinary(), [altConfig]: CONFIG_TEXT })
    const service = createAiUsagebarService(h.options)
    const vendorsCalls = (): RecordedCall[] =>
      h.calls.filter((call) => call.args.includes('vendors'))

    await service.refresh()
    expect(vendorsCalls()).toHaveLength(1)
    const first = vendorsCalls()[0]
    expect(first?.args[first.args.indexOf('--config') + 1]).toBe(CONFIG)

    const provider = (): { configPath: string } => ({ configPath: altConfig })
    service.setAccountConfig(provider)
    await service.refresh()
    expect(vendorsCalls()).toHaveLength(2)
    const latest = vendorsCalls()[1]
    expect(latest?.args[latest.args.indexOf('--config') + 1]).toBe(altConfig)
    const usageCall = h.calls.filter((call) => call.args.includes('usage')).pop()
    expect(usageCall?.args[usageCall.args.indexOf('--config') + 1]).toBe(altConfig)

    // Mesma referência de provider: mudança NÃO efetiva, sem reload extra.
    service.setAccountConfig(provider)
    await service.refresh()
    expect(vendorsCalls()).toHaveLength(2)
  })

  it('usageLock injetável embrulha SOMENTE o usage do refresh', async () => {
    const h = createHarness(seededBinary())
    const events: string[] = []
    let lockCalls = 0
    const service = createAiUsagebarService({
      ...h.options,
      usageLock: async (run) => {
        lockCalls += 1
        events.push('enter')
        const value = await run()
        events.push('exit')
        return value
      },
    })

    const snapshot = await service.refresh()
    expect(snapshot.state).toBe('ready')
    expect(lockCalls).toBe(1)
    expect(events).toEqual(['enter', 'exit'])
    // Nada de usage fora do lock: uma única chamada de usage no total.
    expect(h.calls.filter((call) => call.args.includes('usage'))).toHaveLength(1)
  })

  it('concurrent setVendorEnabled calls both preserve their changes (default sharedConfigWriteLock)', async () => {
    const h = createHarness(seededBinary(), {
      vendors: () => ({
        stdout: JSON.stringify({
          vendors: [
            { id: 'openai', name: 'Codex', enabled: true },
            { id: 'future-vendor', name: 'Future', enabled: false },
          ],
        }),
      }),
    })
    const service = createAiUsagebarService(h.options)
    await service.refresh()

    const [, b] = await Promise.all([
      service.setVendorEnabled('openai', false),
      service.setVendorEnabled('future-vendor', true),
    ])

    expect(b.state).toBe('ready')
    const content = Buffer.from(h.files.get(path.resolve(CONFIG).toLowerCase())!).toString('utf8')
    expect(content).toContain('enabled = false')
    expect(settingsCalls(h)).toHaveLength(1)
  })

  it('entry.error is sanitized (secrets + paths redacted) before entering snapshot', async () => {
    const errorEntry = {
      id: 'provider-x',
      name: 'ProviderX',
      status: 'error',
      error: 'Failed to read C:\\Users\\secret\\auth.json with token sk-live-abc123def456ghijk',
    }
    const h = createHarness(seededBinary(), {
      usage: () => ({
        code: 1,
        stdout: JSON.stringify({ schema_version: 1, entries: [errorEntry] }),
      }),
    })
    const service = createAiUsagebarService(h.options)
    const snapshot = await service.refresh()

    expect(snapshot.state).toBe('ready')
    const entry = snapshot.report?.entries[0]
    expect(entry?.error).toBeDefined()
    expect(entry?.error).not.toContain('C:\\Users\\secret')
    expect(entry?.error).not.toContain('sk-live-abc123def456ghijk')
    expect(entry?.error).toContain('[redacted]')
  })
})
