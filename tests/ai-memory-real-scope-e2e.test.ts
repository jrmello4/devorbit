/**
 * E2E real sidecar v2.4.0 — Windows-only.
 *
 * Ativado SOMENTE quando AI_MEMORY_E2E_BINARY está definido E platform é win32.
 * Cada teste é autossuficiente: cria tempRoot, dataDir, porta e child próprios.
 *
 * Cleanup semantics:
 *  - killChild rejeita em timeout; finally NÃO engole a rejeição.
 *  - Se killChild falha, tempRoot NÃO é removido (preserva data-dir de filho vivo).
 *  - Se killChild OK e teste falhou, re-throw do erro original do teste.
 *  - Spawn error fecha o handle via pid/close para que isExited() retorne true.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AiMemoryClient } from '../src/main/ai-memory-client'
import { buildAiMemoryHelperEnv } from '../src/main/ai-memory-process-env'
import {
  resolveAiMemoryHarness,
  resolveAiMemoryAgentChoice,
  AI_MEMORY_HARNESS_MAP,
} from '../src/main/ai-memory-launcher'

const E2E_BINARY = process.env.AI_MEMORY_E2E_BINARY
const isWin32 = process.platform === 'win32'
const describeIfE2E = E2E_BINARY && isWin32 ? describe : describe.skip

const SCOPE = { workspace: 'e2e-fresh', project: 'p-1' } as const
const DECISION_PATH = 'decisions/architecture.md'
const DECISION_BODY = '# Architecture Decision\n\nUse Rust sidecar for memory persistence.\n'
const HANDOFF_SUMMARY = 'Codex completing architecture review. Handoff to OpenCode for implementation.'
const HANDOFF_FILES = ['src/main/arch.rs', 'tests/arch_test.rs']

interface SidecarHandle {
  child: ChildProcess
  isExited: () => boolean
  spawnError: Promise<never>
}

function isProcessExited(h: SidecarHandle): boolean {
  return h.child.exitCode !== null
    || h.child.signalCode !== null
    || h.child.pid === undefined
}

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

function startSidecar(dataDir: string, sidecarPort: number): SidecarHandle {
  let rejectSpawn: (err: Error) => void
  const spawnError = new Promise<never>((_, reject) => { rejectSpawn = reject })

  const c = spawn(E2E_BINARY!, [
    '--data-dir', dataDir,
    'serve', '--transport', 'http',
    '--bind', `127.0.0.1:${sidecarPort}`,
  ], { windowsHide: true, stdio: 'ignore', env: buildAiMemoryHelperEnv() })

  const handle: SidecarHandle = {
    child: c,
    isExited: () => isProcessExited(handle),
    spawnError,
  }

  // Spawn error: reject the promise AND ensure isExited() returns true.
  // On error, 'exit' may never fire; 'close' always fires after error.
  let closed = false
  c.on('error', (err) => {
    closed = true
    rejectSpawn(new Error(`Sidecar spawn error: ${err.message}`))
  })
  c.on('close', () => { closed = true })

  // Override isExited to also check the close sentinel.
  const origIsExited = handle.isExited
  handle.isExited = () => origIsExited() || closed

  return handle
}

async function killChild(handle: SidecarHandle): Promise<void> {
  if (handle.isExited()) return
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('killChild timeout: sidecar did not exit within 5s'))
    }, 5000)
    handle.child.on('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    try { handle.child.kill() } catch (err) {
      clearTimeout(timeout)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

async function waitForHealth(client: AiMemoryClient, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const h = await client.health()
      if (h.ok) return
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('Sidecar health timeout')
}

/**
 * Finalize a test: kill process, then remove tempRoot ONLY if process exited.
 * Returns the test error (original or cleanup) for the caller to throw.
 */
async function finalize(
  handle: SidecarHandle | null,
  myRoot: string,
  testError: unknown,
): Promise<unknown> {
  if (!handle) return testError

  // Kill process — do NOT swallow rejection.
  let killError: unknown = null
  try {
    await killChild(handle)
  } catch (err) {
    killError = err
  }

  // Remove tempRoot ONLY if process actually exited.
  if (handle.isExited() && myRoot) {
    await rm(myRoot, { recursive: true, force: true }).catch(() => {})
  }

  // Cleanup failure takes precedence (process still alive = must report).
  if (killError) return killError
  return testError
}

describeIfE2E('AiMemoryClient — E2E real sidecar v2.4.0', () => {
  it('launcher mapping: resolveAiMemoryHarness e resolveAiMemoryAgentChoice', () => {
    expect(resolveAiMemoryHarness('codex')).toBe('codex')
    expect(resolveAiMemoryHarness('opencode')).toBe('opencode')
    expect(resolveAiMemoryHarness('OpenCode')).toBe('opencode')
    expect(resolveAiMemoryHarness('unknown-provider')).toBeNull()

    expect(resolveAiMemoryAgentChoice('codex')).toBe('codex')
    expect(resolveAiMemoryAgentChoice('opencode')).toBe('opencode')
    expect(resolveAiMemoryAgentChoice('opencode2')).toBe('opencode2')
    expect(resolveAiMemoryAgentChoice('unknown')).toBeNull()

    for (const [key, harness] of Object.entries(AI_MEMORY_HARNESS_MAP)) {
      expect(resolveAiMemoryHarness(key)).toBe(harness)
    }
  })

  it('verifyScope fail-open: writePage e verifyScope pos-write', async () => {
    const myRoot = await mkdtemp(join(tmpdir(), 'ai-e2e-scope-'))
    const dataDir = join(myRoot, 'data')
    await mkdir(dataDir, { recursive: true })
    const myPort = await findFreePort()
    let handle: SidecarHandle | null = null
    let testError: unknown = null

    try {
      handle = startSidecar(dataDir, myPort)
      await Promise.race([
        handle.spawnError,
        waitForHealth(new AiMemoryClient({ endpoint: `http://127.0.0.1:${myPort}/mcp` })),
      ])

      const client = new AiMemoryClient({ endpoint: `http://127.0.0.1:${myPort}/mcp` })

      const before = await client.verifyScope(SCOPE)
      expect(before.ok).toBe(true)

      const w = await client.writePage({ ...SCOPE, path: 'init.md', body: '# initialized' })
      expect(w.isError).toBe(false)

      const after = await client.verifyScope(SCOPE)
      expect(after.ok).toBe(true)
    } catch (err) {
      testError = err
    }

    const err = await finalize(handle, myRoot, testError)
    if (err) throw err
  })

  it('persistencia de decisao e handoff apos reinicio; mappings Codex/OpenCode', async () => {
    const harnessCodex = resolveAiMemoryHarness('codex')
    const harnessOpenCode = resolveAiMemoryHarness('opencode')
    const agentChoiceCodex = resolveAiMemoryAgentChoice('codex')
    const agentChoiceOpenCode = resolveAiMemoryAgentChoice('opencode')
    expect(harnessCodex).toBe('codex')
    expect(harnessOpenCode).toBe('opencode')
    expect(agentChoiceCodex).toBe('codex')
    expect(agentChoiceOpenCode).toBe('opencode')

    const myRoot = await mkdtemp(join(tmpdir(), 'ai-e2e-continuity-'))
    const projectCwd = join(myRoot, 'project')
    await mkdir(projectCwd, { recursive: true })
    const dataDir = join(myRoot, 'data')
    await mkdir(dataDir, { recursive: true })
    const myPort = await findFreePort()
    let handle: SidecarHandle | null = null
    let handoffId: string | undefined
    let testError: unknown = null

    try {
      // Phase 1: Codex writes decision + handoff
      handle = startSidecar(dataDir, myPort)
      await Promise.race([
        handle.spawnError,
        waitForHealth(new AiMemoryClient({ endpoint: `http://127.0.0.1:${myPort}/mcp` })),
      ])

      const client1 = new AiMemoryClient({ endpoint: `http://127.0.0.1:${myPort}/mcp` })

      const writeResult = await client1.writePage({ ...SCOPE, path: DECISION_PATH, body: DECISION_BODY })
      expect(writeResult.isError).toBe(false)

      const read1 = await client1.readPage({ ...SCOPE, path: DECISION_PATH })
      expect(read1.isError).toBe(false)
      expect(read1.text).toContain('Architecture Decision')
      expect(read1.text).toContain('Rust sidecar')

      const handoff = await client1.handoffBegin({
        ...SCOPE,
        summary: HANDOFF_SUMMARY,
        filesTouched: HANDOFF_FILES,
        nextSteps: ['Implement memory store', 'Add unit tests'],
        cwd: projectCwd,
      })
      expect(handoff.isError).toBe(false)
      handoffId = (handoff.json as { handoff_id?: string })?.handoff_id
      expect(handoffId).toBeDefined()

      const list1 = await client1.handoffs(SCOPE)
      expect(list1.isError).toBe(false)
      expect(list1.text).toContain('architecture review')

      // Phase 2: Kill sidecar, restart same data-dir
      await killChild(handle)
      handle = null

      const port2 = await findFreePort()
      handle = startSidecar(dataDir, port2)
      await Promise.race([
        handle.spawnError,
        waitForHealth(new AiMemoryClient({ endpoint: `http://127.0.0.1:${port2}/mcp` })),
      ])

      const client2 = new AiMemoryClient({ endpoint: `http://127.0.0.1:${port2}/mcp` })

      const read2 = await client2.readPage({ ...SCOPE, path: DECISION_PATH })
      expect(read2.isError).toBe(false)
      expect(read2.text).toContain('Architecture Decision')
      expect(read2.text).toContain('Rust sidecar')

      const list2 = await client2.handoffs(SCOPE)
      expect(list2.isError).toBe(false)
      expect(list2.text).toContain('architecture review')

      const accepted = await client2.handoffAccept({ ...SCOPE, handoffId, cwd: projectCwd })
      expect(accepted.isError).toBe(false)
    } catch (err) {
      testError = err
    }

    const err = await finalize(handle, myRoot, testError)
    if (err) throw err
  })
})
