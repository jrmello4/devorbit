import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AI_USAGEBAR_VERSION as RUNTIME_VERSION,
  AI_USAGEBAR_WINDOWS_X64_SHA256 as RUNTIME_SHA,
  AI_USAGEBAR_WINDOWS_X64_URL as RUNTIME_URL,
} from '../src/main/ai-usagebar-config'

interface PrepareResult {
  skipped: boolean
  executablePath: string
  licensePath: string
  attributionPath: string
}

interface PrepareModule {
  AI_USAGEBAR_VERSION: string
  AI_USAGEBAR_WINDOWS_X64_URL: string
  AI_USAGEBAR_WINDOWS_X64_SHA256: string
  EXECUTABLE_NAME: string
  LICENSE_NAME: string
  ATTRIBUTION_NAME: string
  MIT_LICENSE_TEXT: string
  assertPinnedAiUsagebarUrl: (url: string) => void
  prepareAiUsagebar: (options?: {
    targetDir?: string
    fetchImpl?: FetchLike
    expectedSha256?: string
    timeoutMs?: number
    maxBytes?: number
    log?: (message: string) => void
  }) => Promise<PrepareResult>
}

interface StreamReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  cancel?: () => Promise<void>
  releaseLock?: () => void
}

interface FetchResponseLike {
  ok: boolean
  status: number
  headers?: { get(name: string): string | null }
  body?: { getReader(): StreamReaderLike }
  arrayBuffer?: () => Promise<ArrayBuffer>
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<FetchResponseLike>

const requireCjs = createRequire(import.meta.url)
const prepare = requireCjs('../scripts/prepare-ai-usagebar.cjs') as PrepareModule

const PINNED_SHA = '286f0a480ac5ad6b5da79433b5b5852f4f807da87ffb9ef442dfc87045a4363d'
const PAYLOAD = Buffer.from('ai-usagebar-pinned-binary-fixture')
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex')

const tempDirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devorbit-ai-usagebar-'))
  tempDirs.push(dir)
  return dir
}

function fetchReturning(buffer: Buffer, status = 200, ok = true): FetchLike {
  return async () => ({
    ok,
    status,
    arrayBuffer: async () => Uint8Array.from(buffer).buffer,
  })
}

interface StreamState {
  pulled: number
  cancelled: boolean
}

/** Resposta com body em stream (chunks) para exercitar o cap progressivo. */
function fetchChunked(
  chunks: Buffer[],
  options: { status?: number; ok?: boolean; contentLength?: string } = {}
): { fetchImpl: FetchLike; state: StreamState } {
  const state: StreamState = { pulled: 0, cancelled: false }
  let index = 0
  const fetchImpl: FetchLike = async () => ({
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: {
      get: (name) => (name.toLowerCase() === 'content-length' ? options.contentLength ?? null : null),
    },
    body: {
      getReader: (): StreamReaderLike => ({
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
  })
  return { fetchImpl, state }
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe('prepare-ai-usagebar — pin e URL segura', () => {
  it('mantém versão/URL/SHA pinados e nunca usa latest', () => {
    expect(prepare.AI_USAGEBAR_VERSION).toBe('1.24.0')
    expect(prepare.AI_USAGEBAR_WINDOWS_X64_URL).toBe(
      'https://github.com/akitaonrails/ai-usagebar/releases/download/v1.24.0/ai-usagebar-windows-x86_64.exe'
    )
    expect(prepare.AI_USAGEBAR_WINDOWS_X64_SHA256).toBe(PINNED_SHA)
    expect(prepare.AI_USAGEBAR_WINDOWS_X64_URL).not.toMatch(/\/latest\//i)
    expect(() => prepare.assertPinnedAiUsagebarUrl(prepare.AI_USAGEBAR_WINDOWS_X64_URL)).not.toThrow()
    expect(() =>
      prepare.assertPinnedAiUsagebarUrl(
        'https://github.com/akitaonrails/ai-usagebar/releases/latest/download/ai-usagebar-windows-x86_64.exe'
      )
    ).toThrow(/latest/)
  })

  it('rejeita URLs atacantes mesmo contendo o segmento v1.24.0', () => {
    const attackers = [
      // Host de terceiros com o path pinado.
      'https://evil.example/akitaonrails/ai-usagebar/releases/download/v1.24.0/ai-usagebar-windows-x86_64.exe',
      // Lookalike de host.
      'https://github.com.evil.example/akitaonrails/ai-usagebar/releases/download/v1.24.0/ai-usagebar-windows-x86_64.exe',
      // userinfo.
      'https://user:pass@github.com/akitaonrails/ai-usagebar/releases/download/v1.24.0/ai-usagebar-windows-x86_64.exe',
      // query/fragment.
      'https://github.com/akitaonrails/ai-usagebar/releases/download/v1.24.0/ai-usagebar-windows-x86_64.exe?x=1',
      'https://github.com/akitaonrails/ai-usagebar/releases/download/v1.24.0/ai-usagebar-windows-x86_64.exe#frag',
      // esquema não-https.
      'http://github.com/akitaonrails/ai-usagebar/releases/download/v1.24.0/ai-usagebar-windows-x86_64.exe',
      // traversal normalizado para fora do asset.
      'https://github.com/akitaonrails/ai-usagebar/releases/download/v1.24.0/../other.exe',
      // repo/owner diferentes com o mesmo release path.
      'https://github.com/attacker/ai-usagebar/releases/download/v1.24.0/ai-usagebar-windows-x86_64.exe',
      // porta não-default mesmo em github.com.
      'https://github.com:8443/akitaonrails/ai-usagebar/releases/download/v1.24.0/ai-usagebar-windows-x86_64.exe',
    ]
    for (const url of attackers) {
      expect(() => prepare.assertPinnedAiUsagebarUrl(url), url).toThrow()
    }

    // Porta default explícita é normalizada para vazia e continua válida.
    expect(() =>
      prepare.assertPinnedAiUsagebarUrl(
        'https://github.com:443/akitaonrails/ai-usagebar/releases/download/v1.24.0/ai-usagebar-windows-x86_64.exe'
      )
    ).not.toThrow()
  })

  it('packager e runtime compartilham a MESMA versão/URL/SHA-256 (sem divergir)', () => {
    expect(prepare.AI_USAGEBAR_VERSION).toBe(RUNTIME_VERSION)
    expect(prepare.AI_USAGEBAR_WINDOWS_X64_URL).toBe(RUNTIME_URL)
    expect(prepare.AI_USAGEBAR_WINDOWS_X64_SHA256).toBe(RUNTIME_SHA)
    expect(prepare.AI_USAGEBAR_WINDOWS_X64_SHA256).toBe(PINNED_SHA)
  })
})

describe('prepare-ai-usagebar — download mockado, hash e staging', () => {
  it('baixa bytes (stream), grava EXE + licença/attribution e não deixa .part', async () => {
    const dir = tempDir()
    const { fetchImpl: streaming, state } = fetchChunked([PAYLOAD.subarray(0, 7), PAYLOAD.subarray(7)])
    const fetchImpl = vi.fn(streaming)
    const result = await prepare.prepareAiUsagebar({
      targetDir: dir,
      fetchImpl,
      expectedSha256: PAYLOAD_SHA,
      log: () => undefined,
    })

    expect(result.skipped).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe(prepare.AI_USAGEBAR_WINDOWS_X64_URL)
    expect(state.pulled).toBe(2)
    expect(await fsp.readFile(result.executablePath)).toEqual(PAYLOAD)
    expect(fs.existsSync(`${result.executablePath}.part`)).toBe(false)

    const license = await fsp.readFile(result.licensePath, 'utf8')
    expect(license).toContain('MIT License')
    expect(license).toContain('Copyright (c) 2026 AkitaOnRails')
    const attribution = await fsp.readFile(result.attributionPath, 'utf8')
    expect(attribution).toContain('ai-usagebar 1.24.0')
    expect(attribution).toContain(PINNED_SHA)
    // Somente EXE + licença + attribution: nada de config/cache/credenciais.
    expect(fs.readdirSync(dir).sort()).toEqual(
      [prepare.EXECUTABLE_NAME, prepare.LICENSE_NAME, prepare.ATTRIBUTION_NAME].sort()
    )
  })

  it('é idempotente: exe verificado não baixa de novo', async () => {
    const dir = tempDir()
    const first = vi.fn(fetchReturning(PAYLOAD))
    await prepare.prepareAiUsagebar({ targetDir: dir, fetchImpl: first, expectedSha256: PAYLOAD_SHA, log: () => undefined })

    const second = vi.fn(fetchReturning(PAYLOAD))
    const result = await prepare.prepareAiUsagebar({
      targetDir: dir,
      fetchImpl: second,
      expectedSha256: PAYLOAD_SHA,
      log: () => undefined,
    })
    expect(result.skipped).toBe(true)
    expect(second).not.toHaveBeenCalled()
  })

  it('fail-closed: hash divergente não grava EXE e limpa o staging', async () => {
    const dir = tempDir()
    await expect(
      prepare.prepareAiUsagebar({
        targetDir: dir,
        fetchImpl: fetchReturning(Buffer.from('tampered')),
        expectedSha256: PAYLOAD_SHA,
        log: () => undefined,
      })
    ).rejects.toThrow(/SHA-256/)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('fail-closed: HTTP não-ok não grava nada', async () => {
    const dir = tempDir()
    await expect(
      prepare.prepareAiUsagebar({
        targetDir: dir,
        fetchImpl: fetchReturning(Buffer.from(''), 502, false),
        expectedSha256: PAYLOAD_SHA,
        log: () => undefined,
      })
    ).rejects.toThrow(/HTTP 502/)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('timeout aborta e limpa o staging', async () => {
    const dir = tempDir()
    const hangingFetch: FetchLike = async (_url, init) =>
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by signal')))
      })
    await expect(
      prepare.prepareAiUsagebar({
        targetDir: dir,
        fetchImpl: hangingFetch,
        expectedSha256: PAYLOAD_SHA,
        timeoutMs: 20,
        log: () => undefined,
      })
    ).rejects.toThrow(/timeout/)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('exe pré-existente com hash errado é substituído pelo verificado', async () => {
    const dir = tempDir()
    await fsp.writeFile(path.join(dir, prepare.EXECUTABLE_NAME), 'garbage')
    const fetchImpl = vi.fn(fetchReturning(PAYLOAD))
    const result = await prepare.prepareAiUsagebar({
      targetDir: dir,
      fetchImpl,
      expectedSha256: PAYLOAD_SHA,
      log: () => undefined,
    })
    expect(result.skipped).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(await fsp.readFile(result.executablePath)).toEqual(PAYLOAD)
  })

  it('cap de bytes falha fechado antes de gravar (fallback sem stream)', async () => {
    const dir = tempDir()
    await expect(
      prepare.prepareAiUsagebar({
        targetDir: dir,
        fetchImpl: fetchReturning(PAYLOAD),
        expectedSha256: PAYLOAD_SHA,
        maxBytes: 4,
        log: () => undefined,
      })
    ).rejects.toThrow(/limite de bytes/)
    expect(fs.readdirSync(dir)).toEqual([])
  })
})

describe('prepare-ai-usagebar — cap durante o stream (sem bufferizar tudo)', () => {
  it('rejeita Content-Length acima do cap ANTES de ler o body', async () => {
    const dir = tempDir()
    const { fetchImpl, state } = fetchChunked([PAYLOAD], { contentLength: String(PAYLOAD.length) })
    await expect(
      prepare.prepareAiUsagebar({
        targetDir: dir,
        fetchImpl,
        expectedSha256: PAYLOAD_SHA,
        maxBytes: 4,
        log: () => undefined,
      })
    ).rejects.toThrow(/limite de bytes/)
    expect(state.pulled).toBe(0)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('chunk excessivo aborta assim que passa do cap (cancela o reader)', async () => {
    const dir = tempDir()
    const { fetchImpl, state } = fetchChunked([
      Buffer.from('aaaa'),
      Buffer.from('bbbb'),
      Buffer.from('cccc'),
    ])
    await expect(
      prepare.prepareAiUsagebar({
        targetDir: dir,
        fetchImpl,
        expectedSha256: PAYLOAD_SHA,
        maxBytes: 5,
        log: () => undefined,
      })
    ).rejects.toThrow(/limite de bytes/)
    // Parou no 2º chunk (8 bytes > 5) e cancelou — não leu o 3º.
    expect(state.pulled).toBe(2)
    expect(state.cancelled).toBe(true)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('stream dentro do cap concatena os chunks corretamente', async () => {
    const dir = tempDir()
    const payload = Buffer.from('chunked-payload')
    const digest = createHash('sha256').update(payload).digest('hex')
    const { fetchImpl } = fetchChunked([payload.subarray(0, 4), payload.subarray(4)])
    const result = await prepare.prepareAiUsagebar({
      targetDir: dir,
      fetchImpl,
      expectedSha256: digest,
      log: () => undefined,
    })
    expect(await fsp.readFile(result.executablePath)).toEqual(payload)
  })
})
