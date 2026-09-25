/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
'use strict'

/**
 * Prepara o executável ai-usagebar PINADO (v1.24.0, Windows x64) para o
 * empacotamento do DevOrbit.
 *
 * - URL/SHA-256 fixados no release v1.24.0 (JAMAIS usa `latest`);
 * - download com timeout (AbortController), cap de bytes e escrita temp+rename;
 * - cleanup de `.part` em qualquer falha;
 * - idempotente: se o exe já existe com o hash exato, não baixa de novo;
 * - grava SOMENTE o exe + licença MIT/attribution; nunca config/cache/credenciais.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const AI_USAGEBAR_VERSION = '1.24.0'
const AI_USAGEBAR_WINDOWS_X64_URL =
  'https://github.com/akitaonrails/ai-usagebar/releases/download/v1.24.0/ai-usagebar-windows-x86_64.exe'
const AI_USAGEBAR_WINDOWS_X64_SHA256 =
  '286f0a480ac5ad6b5da79433b5b5852f4f807da87ffb9ef442dfc87045a4363d'

const EXECUTABLE_NAME = 'ai-usagebar.exe'
const LICENSE_NAME = 'LICENSE-ai-usagebar.txt'
const ATTRIBUTION_NAME = 'ATTRIBUTION-ai-usagebar.txt'

const DOWNLOAD_TIMEOUT_MS = 120_000
const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024

const projectRoot = path.resolve(__dirname, '..')
const DEFAULT_TARGET_DIR = path.join(projectRoot, 'build', 'ai-usagebar')

const MIT_LICENSE_TEXT = `MIT License

Copyright (c) 2026 AkitaOnRails

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

function attributionText() {
  return [
    `ai-usagebar ${AI_USAGEBAR_VERSION}`,
    'Source: https://github.com/akitaonrails/ai-usagebar',
    'License: MIT (Copyright (c) 2026 AkitaOnRails)',
    `Pinned asset: ${AI_USAGEBAR_WINDOWS_X64_URL}`,
    `SHA-256: ${AI_USAGEBAR_WINDOWS_X64_SHA256}`,
    '',
  ].join('\n')
}

const PINNED_ASSET_HOST = 'github.com'
const PINNED_ASSET_PATH =
  '/akitaonrails/ai-usagebar/releases/download/v1.24.0/ai-usagebar-windows-x86_64.exe'

/**
 * Garante que a URL é EXATAMENTE o asset pinado: https, host github.com,
 * path fixo, sem userinfo/query/fragment nem `latest`. Qualquer host/path de
 * terceiros (mesmo contendo o segmento v1.24.0) é rejeitado.
 */
function assertPinnedAiUsagebarUrl(url) {
  if (typeof url !== 'string' || !url) {
    throw new Error('URL do ai-usagebar ausente.')
  }
  if (/\/latest\//i.test(url)) {
    throw new Error('URL do ai-usagebar não pode usar `latest`.')
  }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('URL do ai-usagebar inválida.')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('URL do ai-usagebar precisa ser https.')
  }
  if (parsed.hostname !== PINNED_ASSET_HOST) {
    throw new Error('URL do ai-usagebar precisa apontar para github.com.')
  }
  if (parsed.port !== '') {
    throw new Error('URL do ai-usagebar não pode usar porta não-padrão.')
  }
  if (parsed.username || parsed.password) {
    throw new Error('URL do ai-usagebar não pode conter userinfo.')
  }
  if (parsed.search || parsed.hash) {
    throw new Error('URL do ai-usagebar não pode conter query/fragment.')
  }
  if (parsed.pathname !== PINNED_ASSET_PATH) {
    throw new Error('URL do ai-usagebar não é o asset pinado do release.')
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

async function sha256File(filePath) {
  return sha256(await fsp.readFile(filePath))
}

const EXCESS_BYTES_ERROR = 'Download do ai-usagebar excedeu o limite de bytes.'

function declaredContentLength(response) {
  try {
    const raw = response?.headers?.get?.('content-length')
    if (typeof raw !== 'string' || raw.trim() === '') return undefined
    const value = Number(raw)
    return Number.isFinite(value) && value >= 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Lê o body com cap DURANTE a leitura (stream), sem materializar tudo antes:
 * rejeita Content-Length acima do limite e aborta assim que o total excede.
 */
async function readBodyBounded(response, maxBytes) {
  const declared = declaredContentLength(response)
  if (declared !== undefined && declared > maxBytes) {
    throw new Error(EXCESS_BYTES_ERROR)
  }
  const body = response?.body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
        total += chunk.byteLength
        if (total > maxBytes) {
          try {
            await reader.cancel()
          } catch {
            // Cancelamento best-effort.
          }
          throw new Error(EXCESS_BYTES_ERROR)
        }
        chunks.push(Buffer.from(chunk))
      }
    } finally {
      try {
        reader.releaseLock?.()
      } catch {
        // Sem lock para liberar.
      }
    }
    return Buffer.concat(chunks)
  }
  // Fallback para respostas sem stream (mocks exóticos): cap pós-leitura.
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > maxBytes) throw new Error(EXCESS_BYTES_ERROR)
  return buffer
}

/**
 * Baixa o asset pinado e devolve os bytes; o caller grava em `.part` e
 * renomeia (atômico). Limpa o `.part` em qualquer falha. Nunca bufferiza
 * mais que `maxBytes`.
 */
async function downloadPinnedAsset(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch indisponível para baixar o ai-usagebar.')
  }
  const url = options.url ?? AI_USAGEBAR_WINDOWS_X64_URL
  assertPinnedAiUsagebarUrl(url)

  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DOWNLOAD_MAX_BYTES
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'application/octet-stream' },
    })
    if (!response.ok) {
      throw new Error(`Download do ai-usagebar falhou (HTTP ${response.status}).`)
    }
    const buffer = await readBodyBounded(response, maxBytes)
    if (buffer.length === 0) throw new Error('Download do ai-usagebar veio vazio.')
    return buffer
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Download do ai-usagebar excedeu o timeout.')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function writeLicenseFiles(targetDir) {
  const licensePath = path.join(targetDir, LICENSE_NAME)
  const attributionPath = path.join(targetDir, ATTRIBUTION_NAME)
  await fsp.writeFile(licensePath, MIT_LICENSE_TEXT, 'utf8')
  await fsp.writeFile(attributionPath, attributionText(), 'utf8')
  return { licensePath, attributionPath }
}

/**
 * Garante `build/ai-usagebar/ai-usagebar.exe` verificado (+ licença MIT).
 * Opções injetáveis (fixtures/mocks): targetDir, fetchImpl, expectedSha256,
 * timeoutMs, maxBytes, log.
 */
async function prepareAiUsagebar(options = {}) {
  const targetDir = options.targetDir ?? DEFAULT_TARGET_DIR
  const expectedSha256 = options.expectedSha256 ?? AI_USAGEBAR_WINDOWS_X64_SHA256
  const url = options.url ?? AI_USAGEBAR_WINDOWS_X64_URL
  const log = options.log ?? console.log
  assertPinnedAiUsagebarUrl(url)

  await fsp.mkdir(targetDir, { recursive: true })
  const executablePath = path.join(targetDir, EXECUTABLE_NAME)

  if (fs.existsSync(executablePath)) {
    const existingHash = await sha256File(executablePath)
    if (existingHash === expectedSha256) {
      const files = await writeLicenseFiles(targetDir)
      log(`[prepare-ai-usagebar] já verificado: ${executablePath}`)
      return { skipped: true, executablePath, ...files }
    }
    await fsp.rm(executablePath, { force: true })
  }

  const temporary = `${executablePath}.part`
  try {
    const buffer = await downloadPinnedAsset({ ...options, url })
    const hash = sha256(buffer)
    if (hash !== expectedSha256) {
      throw new Error(`SHA-256 do ai-usagebar divergente (${hash}).`)
    }
    await fsp.writeFile(temporary, buffer)
    await fsp.rename(temporary, executablePath)
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }

  const files = await writeLicenseFiles(targetDir)
  log(`[prepare-ai-usagebar] preparado: ${executablePath}`)
  return { skipped: false, executablePath, ...files }
}

async function main() {
  try {
    const result = await prepareAiUsagebar()
    if (result.skipped) {
      console.log(`ai-usagebar já preparado em ${result.executablePath}`)
    } else {
      console.log(`ai-usagebar preparado em ${result.executablePath}`)
    }
  } catch (error) {
    console.error(`prepare-ai-usagebar: ${error && error.message ? error.message : error}`)
    process.exitCode = 1
  }
}

if (require.main === module) {
  void main()
}

module.exports = {
  AI_USAGEBAR_VERSION,
  AI_USAGEBAR_WINDOWS_X64_URL,
  AI_USAGEBAR_WINDOWS_X64_SHA256,
  EXECUTABLE_NAME,
  LICENSE_NAME,
  ATTRIBUTION_NAME,
  DEFAULT_TARGET_DIR,
  MIT_LICENSE_TEXT,
  assertPinnedAiUsagebarUrl,
  downloadPinnedAsset,
  prepareAiUsagebar,
  main,
}
