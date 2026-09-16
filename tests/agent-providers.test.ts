import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppConfig } from '../src/renderer/src/types'
import { resolveAgentProviderCommand } from '../src/main/agent-providers'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe.skipIf(process.platform !== 'win32')('agent provider resolution', () => {
  it('resolves a configured CLI path without reading or copying credentials', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-agent-provider-'))
    temporaryDirectories.push(root)
    const executable = path.join(root, 'OpenCode CLI', 'opencode.cmd')
    await fs.mkdir(path.dirname(executable), { recursive: true })
    await fs.writeFile(executable, '@echo off')

    const result = await resolveAgentProviderCommand(
      { customPaths: { opencode: executable } } as AppConfig,
      'opencode'
    )

    expect(result.path).toBe(executable)
    expect(result.message).toContain('autenticação é gerenciada pelo próprio CLI')
  })

  it('does not resolve shell expressions as custom agent commands', async () => {
    const result = await resolveAgentProviderCommand(
      { customPaths: { customAgent: 'agent.cmd & whoami' } } as AppConfig,
      'custom'
    )

    expect(result.path).toBeNull()
  })
})
