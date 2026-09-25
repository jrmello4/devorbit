import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sharedConfigWriteLock } from '../src/main/ai-usagebar-config-lock'
import { syncAiUsagebarAccounts } from '../src/main/ai-usagebar-accounts'
import { resolveAiUsagebarPaths } from '../src/main/ai-usagebar-config'
import {
  createAiUsagebarService,
  type AiUsagebarFileSystem,
} from '../src/main/ai-usagebar-service'
import type {
  AiUsagebarCommandOptions,
  AiUsagebarCommandResult,
} from '../src/main/ai-usagebar-client'

const BINARY_BYTES = Buffer.from('ai-usagebar-concurrency-fixture')
const BINARY_SHA = createHash('sha256').update(BINARY_BYTES).digest('hex')
const INITIAL_CONFIG = '[openai]\nenabled = true\n'
const PROFILE_PATH = 'C:/perfis/.codex-work/auth.json'

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout aguardando ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('ai-usagebar config concurrency — sharedConfigWriteLock', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  it('serializa setVendorEnabled e syncAiUsagebarAccounts no MESMO configPath sem lost update', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ai-usagebar-lock-'))
    tempDirs.push(root)
    const paths = resolveAiUsagebarPaths(root)
    await fsp.mkdir(paths.runtimeDir, { recursive: true })
    await fsp.writeFile(paths.configPath, INITIAL_CONFIG, 'utf8')
    await fsp.writeFile(paths.binaryPath, BINARY_BYTES)

    const configReads: string[] = []
    const fileSystem: AiUsagebarFileSystem = {
      exists: async (filePath) => {
        try {
          await fsp.access(filePath)
          return true
        } catch {
          return false
        }
      },
      readFile: async (filePath) => {
        if (filePath === paths.configPath) configReads.push(filePath)
        return await fsp.readFile(filePath, 'utf8')
      },
      readFileBytes: (filePath) => fsp.readFile(filePath),
      writeFile: (filePath, data) => fsp.writeFile(filePath, data),
      mkdir: async (dirPath) => {
        await fsp.mkdir(dirPath, { recursive: true })
      },
      rename: (from, to) => fsp.rename(from, to),
      rm: (filePath) => fsp.rm(filePath, { force: true }),
    }

    const runnerCalls: string[][] = []
    const runner = async (
      _binaryPath: string,
      args: readonly string[],
      _options: AiUsagebarCommandOptions
    ): Promise<AiUsagebarCommandResult> => {
      runnerCalls.push([...args])
      const base: AiUsagebarCommandResult = {
        code: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        stdoutOverflow: false,
        stderrOverflow: false,
      }
      if (args.includes('--version')) return { ...base, stdout: 'ai-usagebar 1.24.0\n' }
      if (args.includes('vendors')) {
        return {
          ...base,
          stdout: JSON.stringify({
            vendors: [{ id: 'openai', name: 'Codex', enabled: true, configured: true }],
          }),
        }
      }
      return base
    }

    const service = createAiUsagebarService({
      userDataDir: root,
      platform: 'win32',
      arch: 'x64',
      fileSystem,
      runner,
      expectedSha256: BINARY_SHA,
    })

    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    let signalGateEntered!: () => void
    const gateEntered = new Promise<void>((resolve) => {
      signalGateEntered = resolve
    })
    const gateRun = sharedConfigWriteLock.withConfigLock(paths.configPath, async () => {
      signalGateEntered()
      await gate
    })
    await gateEntered

    let serviceSettled = false
    let syncSettled = false
    const serviceOp = service.setVendorEnabled('openai', false).then((snapshot) => {
      serviceSettled = true
      return snapshot
    })
    const syncOp = syncAiUsagebarAccounts({
      configPath: paths.configPath,
      profiles: [{ codex_auth_path: PROFILE_PATH, label: 'work' }],
    }).then((result) => {
      syncSettled = true
      return result
    })

    await waitFor(
      () => runnerCalls.some((args) => args.includes('--version')),
      'version do service'
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(configReads).toHaveLength(0)
    expect(serviceSettled).toBe(false)
    expect(syncSettled).toBe(false)

    releaseGate()
    await gateRun
    const [snapshot, syncResult] = await Promise.all([serviceOp, syncOp])

    expect(syncResult.status).toBe('ok')
    expect(snapshot.state).toBe('ready')
    expect(configReads.length).toBeGreaterThan(0)

    const finalContent = await fsp.readFile(paths.configPath, 'utf8')
    expect(finalContent).toContain('[[openai.accounts]]')
    expect(finalContent).toContain(`codex_auth_path = "${PROFILE_PATH}"`)
    expect(finalContent).toContain('label = "work"')
    expect(finalContent).toContain('enabled = false')
    expect(finalContent).not.toContain('enabled = true')
  })
})
