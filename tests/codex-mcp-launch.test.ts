/* eslint-disable no-control-regex -- strip terminal title/ANSI sequences from the real PTY probe */
import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const electronRuntime = vi.hoisted(() => ({
  appPath: 'C:\\DevOrbit',
  packaged: false,
}))

vi.mock('electron', () => ({
  default: {
    app: {
      getAppPath: () => electronRuntime.appPath,
      get isPackaged() { return electronRuntime.packaged },
    },
  },
}))

import { prepareDevOrbitCodexLaunch } from '../src/main/codex-mcp-launch'

const findConfigTable = (args: string[], name: string): string => {
  const table = args.find((argument) => argument.startsWith(`mcp_servers.${name}={`))
  if (!table) throw new Error('config table ausente')
  return table
}

describe('prepareDevOrbitCodexLaunch', () => {
  const runtime = {
    executablePath: 'C:\\Program Files\\DevOrbit\\DevOrbit.exe',
    scriptPath: 'C:\\Program Files\\DevOrbit\\resources\\scripts\\devorbit-mcp.cjs',
    cwd: 'C:\\Program Files\\DevOrbit\\resources',
  }

  it('injects one complete absolute DevOrbit MCP table after base args', () => {
    const prepared = prepareDevOrbitCodexLaunch({
      accountEnvironment: { CODEX_HOME: 'C:\\Users\\tester\\.codex-conta1' },
      bridgeEnv: {
        DEVORBIT_BRIDGE_PIPE: '\\\\.\\pipe\\devorbit-test',
        DEVORBIT_BRIDGE_TOKEN: 'secret-token',
        DEVORBIT_SESSION_ID: 'session-1',
      },
      terminalId: 'codex-a',
      baseArgs: ['resume', '--last'],
      runtime,
    })

    expect(prepared.args.slice(0, 2)).toEqual(['resume', '--last'])
    expect(prepared.args.filter((argument) => argument === '--config')).toHaveLength(3)
    expect(prepared.mcp.name).toMatch(/^devorbit_runtime_[0-9a-f]{32}$/u)
    expect(prepared.mcp.name).not.toBe('devorbit')
    expect(prepared.args.some((argument) => argument.startsWith('mcp_servers.devorbit={') && argument.includes('enabled = false'))).toBe(true)
    const config = findConfigTable(prepared.args, prepared.mcp.name)
    expect(config).toMatch(new RegExp(`^mcp_servers\\.${prepared.mcp.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}=\\{ `))
    expect(config).toContain(`command = ${JSON.stringify(runtime.executablePath)}`)
    expect(config).toContain(`args = [${JSON.stringify(runtime.scriptPath)}, ${JSON.stringify('--terminal-id')}, ${JSON.stringify('codex-a')}, ${JSON.stringify('--launch-id')},`)
    expect(config).toContain(`cwd = ${JSON.stringify(runtime.cwd)}`)
    expect(config).toContain(`env_vars = [${JSON.stringify('DEVORBIT_BRIDGE_PIPE')}, ${JSON.stringify('DEVORBIT_BRIDGE_TOKEN')}, ${JSON.stringify('DEVORBIT_SESSION_ID')}]`)
    expect(config).toContain(`env = { ELECTRON_RUN_AS_NODE = ${JSON.stringify('1')} }`)
    expect(config).toContain('required = true')
    expect(config).toContain('enabled = true')
    expect(config).toContain('startup_timeout_sec = 10')
    expect(config).not.toContain('secret-token')
    expect(prepared.mcp.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    expect(prepared.env).toMatchObject({
      CODEX_HOME: 'C:\\Users\\tester\\.codex-conta1',
      DEVORBIT_BRIDGE_TOKEN: 'secret-token',
    })
    expect(prepared.mcp.args).toEqual([
      runtime.scriptPath,
      '--terminal-id',
      'codex-a',
      '--launch-id',
      prepared.mcp.launchId,
    ])
  })

  it('clears stale filters and keeps env_vars to the three canonical names', () => {
    const prepared = prepareDevOrbitCodexLaunch({
      accountEnvironment: { CODEX_HOME: 'C:\\Users\\tester\\.codex-conta1' },
      bridgeEnv: {
        DEVORBIT_BRIDGE_PIPE: '\\\\.\\pipe\\devorbit-test',
        DEVORBIT_BRIDGE_TOKEN: 'secret-token',
        DEVORBIT_SESSION_ID: 'session-1',
      },
      terminalId: 'codex-scoped',
      runtime,
    })

    // Restrição do produto: env_vars SOMENTE os três nomes canônicos.
    expect(prepared.mcp.envVars).toEqual(['DEVORBIT_BRIDGE_PIPE', 'DEVORBIT_BRIDGE_TOKEN', 'DEVORBIT_SESSION_ID'])
    expect(prepared.args.join(' ')).not.toContain('secret-token')

    const tableIndex = prepared.args.findIndex((argument) => argument.startsWith(`mcp_servers.${prepared.mcp.name}={`))
    // Explicit full allowlist overrides any persisted project/account allowlist.
    expect(prepared.args.slice(tableIndex + 1)).toEqual([
      '--config', `mcp_servers.${prepared.mcp.name}.disabled_tools=[]`,
    ])
    expect(findConfigTable(prepared.args, prepared.mcp.name)).toContain('enabled_tools = ["agent.list", "agent.send", "agent.ask", "agent.wait", "agent.run"]')
  })

  it('rejects caller -c/--config collisions with the managed namespace and parent', () => {
    const collisions: string[][] = [
      ['-c', 'mcp_servers.devorbit={ enabled = false }'],
      ['-c=mcp_servers.devorbit.enabled=false'],
      ['-cmcp_servers.devorbit.env={}'],
      ['--config=mcp_servers.devorbit.command="x"'],
      ['--config', 'mcp_servers . devorbit . required=false'],
      ['--config', 'mcp_servers.devorbit_runtime_old.enabled=true'],
      ['-c', 'mcp_servers = { other = {} }'],
      ['-c', 'mcp_servers'],
    ]
    for (const baseArgs of collisions) {
      expect(() => prepareDevOrbitCodexLaunch({ terminalId: 'codex-collision', baseArgs, runtime })).toThrow('mcp_servers.devorbit')
    }
  })

  it('allows caller config overrides outside the managed namespace', () => {
    const prepared = prepareDevOrbitCodexLaunch({
      terminalId: 'codex-allowed',
      baseArgs: ['-c', 'model="gpt-5"', '--config', 'mcp_servers.other.enabled=false', '-c', 'sandbox_mode="read-only"'],
      runtime,
    })
    expect(prepared.args.slice(0, 6)).toEqual([
      '-c', 'model="gpt-5"',
      '--config', 'mcp_servers.other.enabled=false',
      '-c', 'sandbox_mode="read-only"',
    ])
  })

  it('creates a fresh launch nonce and preserves account isolation', () => {
    const bridgeEnv = {
      DEVORBIT_BRIDGE_PIPE: 'pipe',
      DEVORBIT_BRIDGE_TOKEN: 'token',
      DEVORBIT_SESSION_ID: 'session',
      CODEX_HOME: 'stale-bridge-value',
    }
    const first = prepareDevOrbitCodexLaunch({
      accountEnvironment: { CODEX_HOME: 'C:\\Users\\tester\\.codex-conta1' },
      bridgeEnv,
      terminalId: 'codex-one',
      runtime,
    })
    const second = prepareDevOrbitCodexLaunch({
      accountEnvironment: { CODEX_HOME: 'C:\\Users\\tester\\.codex-conta2' },
      bridgeEnv,
      terminalId: 'codex-two',
      runtime,
    })

    expect(first.mcp.launchId).not.toBe(second.mcp.launchId)
    expect(first.mcp.name).not.toBe(second.mcp.name)
    expect(first.env.CODEX_HOME).toContain('.codex-conta1')
    expect(second.env.CODEX_HOME).toContain('.codex-conta2')
    expect(first.args.join(' ')).not.toContain('token')
    expect(second.args.join(' ')).not.toContain('token')
  })

  it('preserves apostrophes in runtime paths with valid TOML literals', () => {
    const prepared = prepareDevOrbitCodexLaunch({
      terminalId: 'codex-quote',
      runtime: {
        executablePath: "C:\\Program Files\\D'evOrbit\\DevOrbit.exe",
        scriptPath: "C:\\Program Files\\D'evOrbit\\scripts\\devorbit-mcp.cjs",
        cwd: "C:\\Program Files\\D'evOrbit",
      },
    })

    const config = findConfigTable(prepared.args, prepared.mcp.name)
    expect(config).toContain(`command = ${JSON.stringify("C:\\Program Files\\D'evOrbit\\DevOrbit.exe")}`)
    expect(config).toContain(`args = [${JSON.stringify("C:\\Program Files\\D'evOrbit\\scripts\\devorbit-mcp.cjs")},`)
    expect(config).toContain(`cwd = ${JSON.stringify("C:\\Program Files\\D'evOrbit")}`)
    expect(config).not.toContain("D''evOrbit")
  })

  const canRunCodexParser = process.platform === 'win32'
    && spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/q', '/c', 'where', 'codex.cmd'], { stdio: 'ignore' }).status === 0

  it.runIf(canRunCodexParser)('round-trips apostrophe paths through the real cmd/node-pty Codex parser', async () => {
    const pty = await import('node-pty')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devorbit-codex-mcp-'))
    const quotedRuntime = {
      executablePath: "C:\\Program Files\\D'evOrbit\\DevOrbit.exe",
      scriptPath: "C:\\Program Files\\D'evOrbit\\scripts\\devorbit-mcp.cjs",
      cwd: "C:\\Program Files\\D'evOrbit",
    }
    fs.writeFileSync(path.join(home, 'config.toml'), "mcp_servers.other = { command = 'other-command' }\n")

    const prepared = prepareDevOrbitCodexLaunch({ terminalId: 'codex-parser', runtime: quotedRuntime })
    const output: string[] = []
    const child = pty.spawn(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/q', '/c', 'call', 'codex.cmd', 'mcp', 'get', prepared.mcp.name, '--json', ...prepared.args],
      {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: process.cwd(),
        env: { ...process.env, CODEX_HOME: home } as Record<string, string>,
      },
    )
    const exit = await new Promise<{ code: number; output: string }>((resolve) => {
      const timeout = setTimeout(() => {
        try { child.kill() } catch { /* já encerrado */ }
        resolve({ code: -1, output: output.join('') })
      }, 20_000)
      child.onData((data) => output.push(data))
      child.onExit(({ exitCode }) => {
        clearTimeout(timeout)
        resolve({ code: exitCode, output: output.join('') })
      })
    })
    try { child.kill() } catch { /* já encerrado */ }
    fs.rmSync(home, { recursive: true, force: true })

    const clean = exit.output
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    const jsonStart = clean.indexOf('{')
    const jsonEnd = clean.lastIndexOf('}')
    expect(exit.code).toBe(0)
    expect(jsonStart).toBeGreaterThanOrEqual(0)
    const parsed = JSON.parse(clean.slice(jsonStart, jsonEnd + 1)) as {
      transport?: { command?: string; args?: string[]; cwd?: string; env?: Record<string, string>; env_vars?: string[] }
    }
    expect(parsed.transport?.command).toBe(quotedRuntime.executablePath)
    expect(parsed.transport?.args?.slice(0, 1)).toEqual([quotedRuntime.scriptPath])
    expect(parsed.transport?.cwd).toBe(quotedRuntime.cwd)
    expect(parsed.transport?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    expect(parsed.transport?.env_vars).toEqual(['DEVORBIT_BRIDGE_PIPE', 'DEVORBIT_BRIDGE_TOKEN', 'DEVORBIT_SESSION_ID'])
    expect(clean).not.toContain('secret-token')
  }, 30_000)

  it('rejects stale DevOrbit overrides in resume arguments', () => {
    expect(() => prepareDevOrbitCodexLaunch({
      terminalId: 'codex-stale',
      baseArgs: [
        '--config',
        "mcp_servers.devorbit={ env = { DEVORBIT_SESSION_ID = 'old-session', DEVORBIT_BRIDGE_TOKEN = 'old-token' }, bearer_token_env_var = 'OLD_TOKEN', enabled = false, cwd = 'C:\\old' }",
      ],
      runtime,
    })).toThrow('mcp_servers.devorbit')
  })

  it('uses Electron app and resources paths when runtime is omitted', () => {
    electronRuntime.appPath = 'C:\\DevOrbit\\app'
    electronRuntime.packaged = false
    const development = prepareDevOrbitCodexLaunch({ terminalId: 'codex-dev', runtime: { executablePath: runtime.executablePath } })
    expect(development.mcp.args[0].replaceAll('/', '\\')).toBe('C:\\DevOrbit\\app\\scripts\\devorbit-mcp.cjs')

    electronRuntime.packaged = true
    const packaged = prepareDevOrbitCodexLaunch({
      terminalId: 'codex-packaged',
      runtime: { executablePath: runtime.executablePath, resourcesPath: 'C:\\DevOrbit\\resources' },
    })
    expect(packaged.mcp.args[0].replaceAll('/', '\\')).toBe('C:\\DevOrbit\\resources\\scripts\\devorbit-mcp.cjs')
  })
})
