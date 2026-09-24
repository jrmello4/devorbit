/**
 * E2E scope verification: AiMemoryClient.verifyScope com sidecar real v2.4.0.
 *
 * Ativado SOMENTE quando AI_MEMORY_E2E_BINARY está definido.
 * Cria data-dir vazio e porta temporária; inicia sidecar; usa AiMemoryClient real.
 *
 * Uso:
 *   AI_MEMORY_E2E_BINARY=/caminho/ai-memory.exe npx vitest run tests/ai-memory-real-scope-e2e.test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterAll } from 'vitest'
import { AiMemoryClient } from '../src/main/ai-memory-client'
import { buildAiMemoryHelperEnv } from '../src/main/ai-memory-process-env'

const E2E_BINARY = process.env.AI_MEMORY_E2E_BINARY
const describeIfE2E = E2E_BINARY ? describe : describe.skip

let tempRoot = ''
let child: ChildProcess | null = null
let port = 0

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as { port: number }).port
      srv.close(() => resolve(p))
    })
    srv.on('error', reject)
  })
}

describeIfE2E('AiMemoryClient.verifyScope — E2E real sidecar v2.4.0', () => {
  afterAll(async () => {
    if (child) {
      try { child.kill() } catch { /* already dead */ }
      await new Promise<void>((resolve) => {
        if (!child) return resolve()
        child.on('exit', () => resolve())
        setTimeout(() => resolve(), 2000)
      })
    }
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('verifyScope retorna ok:true para workspace não inicializado (fail-open)', async () => {
    // Setup: data-dir vazio, porta nova
    tempRoot = await mkdtemp(join(tmpdir(), 'ai-e2e-'))
    const dataDir = join(tempRoot, 'data')
    await mkdir(dataDir, { recursive: true })
    port = await findFreePort()

    // Start sidecar com env mínimo (sem BYOK/CODEX_HOME/tokens).
    child = spawn(E2E_BINARY!, [
      '--data-dir', dataDir,
      'serve', '--transport', 'http',
      '--bind', `127.0.0.1:${port}`,
    ], { windowsHide: true, stdio: 'ignore', env: buildAiMemoryHelperEnv() })

    // Wait for health
    const client = new AiMemoryClient({ endpoint: `http://127.0.0.1:${port}/mcp` })
    const deadline = Date.now() + 15_000
    let healthy = false
    while (Date.now() < deadline) {
      try {
        const h = await client.health()
        if (h.ok) { healthy = true; break }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 250))
    }
    expect(healthy).toBe(true)

    // verifyScope com workspace não inicializado → deve retornar ok:true (fail-open)
    const result = await client.verifyScope({ workspace: 'e2e-fresh', project: 'p-1' })
    expect(result.ok).toBe(true)

    // writePage para inicializar o workspace (usa API tipada, sem any).
    await client.writePage({
      workspace: 'e2e-fresh', project: 'p-1',
      path: 'init.md', body: '# initialized',
    })

    // verifyScope pós-write → ok:true (workspace agora existe)
    const resultAfter = await client.verifyScope({ workspace: 'e2e-fresh', project: 'p-1' })
    expect(resultAfter.ok).toBe(true)

    // Mismatch real (workspace 'alien' vs scope 'devorbit') é coberto pelo
    // teste unitário. O sidecar v2.4.0 aceita workspace novo como novo scope
    // (memory_status retorna o scope pedido), então wrong-ws não gera erro.

    // Cleanup consolidado no afterAll.
  })
})
