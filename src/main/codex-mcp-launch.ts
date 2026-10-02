import { randomUUID } from 'node:crypto'
import path from 'node:path'
import electron from 'electron'

const { app } = electron

/**
 * Runtime paths used by the short-lived DevOrbit MCP child process.
 *
 * The defaults are resolved from Electron at launch time.  Keeping the
 * values injectable makes the argv/env contract testable without pretending
 * that a Node executable is available in the packaged application.
 */
export interface CodexMcpLaunchRuntime {
  /** Electron executable used with ELECTRON_RUN_AS_NODE=1. */
  executablePath?: string
  /** Optional explicit MCP script path. */
  scriptPath?: string
  /** App root used for development path resolution. */
  appPath?: string
  /** Packaged resources directory. */
  resourcesPath?: string
  /** Overrides Electron's packaged flag for deterministic tests. */
  isPackaged?: boolean
  /** Optional absolute working directory for the MCP child. */
  cwd?: string
}

export interface DevOrbitCodexMcpLaunch {
  name: 'devorbit'
  launchId: string
  command: string
  args: string[]
  cwd: string
  env: { ELECTRON_RUN_AS_NODE: '1' }
  /** Canonical names only, per the current product contract. */
  envVars: readonly ['DEVORBIT_BRIDGE_PIPE', 'DEVORBIT_BRIDGE_TOKEN', 'DEVORBIT_SESSION_ID']
  required: true
  enabled: true
  startupTimeoutSec: 10
}

export interface PreparedDevOrbitCodexLaunch {
  /** Final Codex argv, including the per-launch MCP `--config` overrides. */
  args: string[]
  /** Codex environment.  Bridge credentials remain environment-only. */
  env: NodeJS.ProcessEnv
  mcp: DevOrbitCodexMcpLaunch
}

export interface PrepareDevOrbitCodexLaunchInput {
  accountEnvironment?: NodeJS.ProcessEnv
  bridgeEnv?: NodeJS.ProcessEnv
  terminalId: string
  baseArgs?: readonly string[]
  runtime?: CodexMcpLaunchRuntime
}

const BRIDGE_ENV_VARS = [
  'DEVORBIT_BRIDGE_PIPE',
  'DEVORBIT_BRIDGE_TOKEN',
  'DEVORBIT_SESSION_ID',
] as const

const DEVORBIT_MCP_TOOLS = ['agent.list', 'agent.send', 'agent.ask', 'agent.wait', 'agent.run'] as const

function tomlString(value: string): string {
  // JSON string escaping is a compatible TOML basic-string subset. It keeps
  // Windows backslashes and apostrophes exact while escaping embedded quotes
  // and control characters. node-pty forwards the resulting quoted argv
  // entry through cmd.exe correctly for both native binaries and .cmd shims.
  return JSON.stringify(value)
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`
}

function tomlInlineTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values).map(([key, value]) => `${key} = ${tomlString(value)}`).join(', ')} }`
}

/**
 * Extracts the value of a `-c`/`--config` override. `-c value` and
 * `--config value` keep the value in the next argv entry, while the attached
 * forms (`-c=value`, `-cvalue`, `--config=value`) carry it inline. Codex's
 * clap definition accepts both, so the boundary must recognize both.
 */
function configOverrideValue(argument: string, next: string | undefined): string | undefined {
  if (argument === '--config' || argument === '-c') return next
  if (argument.startsWith('--config=')) return argument.slice('--config='.length)
  if (argument.startsWith('-c=')) return argument.slice('-c='.length)
  if (argument.startsWith('-c') && argument.length > 2) return argument.slice(2)
  return undefined
}

/**
 * Rejects caller overrides that collide with the managed namespace. The
 * collision surface includes the `mcp_servers` parent table (an inline table
 * there could redefine or disable DevOrbit) and every `mcp_servers.devorbit*`
 * key. Whitespace around dots and case differences are normalized because
 * TOML dotted keys tolerate both.
 */
function validateBaseArgs(baseArgs: readonly string[], bridgeEnv: NodeJS.ProcessEnv | undefined): void {
  for (let index = 0; index < baseArgs.length; index += 1) {
    const argument = baseArgs[index]
    const configValue = configOverrideValue(argument, baseArgs[index + 1])
    if (configValue !== undefined && configValue.trim() !== '') {
      const key = configValue.split('=', 1)[0].trim().replace(/\s+/gu, '').toLowerCase()
      const collides = key === 'mcp_servers'
        || key === 'mcp_servers.devorbit'
        || key.startsWith('mcp_servers.devorbit.')
      if (collides) {
        throw new Error('A configuração mcp_servers.devorbit é controlada pelo lançador gerenciado.')
      }
    }

    for (const name of BRIDGE_ENV_VARS) {
      const value = bridgeEnv?.[name]
      if (value && argument.includes(value)) {
        throw new Error(`O argumento do Codex não pode conter a credencial ${name}.`)
      }
    }
  }
}

function absolutePath(value: string): string {
  return path.isAbsolute(value) || /^[a-z]:[\\/]/i.test(value) ? value : path.resolve(value)
}

function resolveRuntime(runtime: CodexMcpLaunchRuntime | undefined): { executablePath: string; scriptPath: string; cwd: string } {
  const rawExecutablePath = runtime?.executablePath?.trim() || process.execPath
  if (!rawExecutablePath) throw new Error('ExecutÃ¡vel do runtime MCP nÃ£o encontrado.')
  const executablePath = absolutePath(rawExecutablePath)
  if (!executablePath) throw new Error('Executável do runtime MCP não encontrado.')

  if (runtime?.scriptPath?.trim()) {
    const scriptPath = absolutePath(runtime.scriptPath)
    return { executablePath, scriptPath, cwd: absolutePath(runtime.cwd || path.dirname(scriptPath)) }
  }

  const packaged = runtime?.isPackaged ?? app.isPackaged
  const root = packaged
    ? (runtime?.resourcesPath?.trim() || process.resourcesPath)
    : (runtime?.appPath?.trim() || app.getAppPath())
  if (!root) throw new Error('Diretório do aplicativo DevOrbit não encontrado.')
  return {
    executablePath,
    scriptPath: absolutePath(path.join(root, 'scripts', 'devorbit-mcp.cjs')),
    cwd: absolutePath(runtime?.cwd?.trim() || root),
  }
}

function validateTerminalId(terminalId: string): void {
  if (typeof terminalId !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(terminalId)) {
    throw new Error('Identificador de terminal inválido.')
  }
}

/**
 * Build the one managed Codex launch contract.
 *
 * The `--config` values are appended after caller arguments and caller
 * overrides for `mcp_servers.devorbit` are rejected.  The bridge values
 * themselves are copied only to `env`; the MCP receives their names through
 * `env_vars` and inherits the values from Codex.
 */
export function prepareDevOrbitCodexLaunch(
  input: PrepareDevOrbitCodexLaunchInput,
): PreparedDevOrbitCodexLaunch {
  validateTerminalId(input.terminalId)
  const baseArgs = [...(input.baseArgs || [])]
  validateBaseArgs(baseArgs, input.bridgeEnv)
  const runtime = resolveRuntime(input.runtime)
  const launchId = randomUUID()
  const mcpArgs = [runtime.scriptPath, '--terminal-id', input.terminalId, '--launch-id', launchId]
  const mcpEnv = { ELECTRON_RUN_AS_NODE: '1' as const }
  const mcp: DevOrbitCodexMcpLaunch = {
    name: 'devorbit',
    launchId,
    command: runtime.executablePath,
    args: mcpArgs,
    cwd: runtime.cwd,
    env: mcpEnv,
    envVars: BRIDGE_ENV_VARS,
    required: true,
    enabled: true,
    startupTimeoutSec: 10,
  }

  // A single complete table defines the managed DevOrbit namespace while
  // leaving all other MCP servers untouched. The table MUST come before the
  // leaf resets: CLI overrides collapse into one layer by insertion, and a
  // later table would replace the whole subtree.
  const configTable = [
    `command = ${tomlString(mcp.command)}`,
    `args = ${tomlArray(mcp.args)}`,
    `cwd = ${tomlString(mcp.cwd)}`,
    `env_vars = ${tomlArray(mcp.envVars)}`,
    `env = ${tomlInlineTable(mcp.env)}`,
    `enabled_tools = ${tomlArray(DEVORBIT_MCP_TOOLS)}`,
    'required = true',
    'enabled = true',
    'startup_timeout_sec = 10',
  ].join(', ')
  // Arrays replace wholesale at the leaf (source-verified merge), so an empty
  // `disabled_tools` clears stale blocks. `enabled_tools=[]` is NOT used:
  // upstream `ToolFilter::from_config` treats an empty allowlist as "enable no
  // tools", which would hide every DevOrbit tool. Tables (env/url/http_headers)
  // cannot be removed through the CLI: a stale literal `env` key wins over
  // `env_vars` (upstream deep-merge limitation, documented with CLI proofs in
  // the verification harness scratch/report).
  const configArgs = [
    '--config', `mcp_servers.devorbit={ ${configTable} }`,
    '--config', 'mcp_servers.devorbit.disabled_tools=[]',
  ]

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(input.bridgeEnv || {}),
    ...(input.accountEnvironment || {}),
  }
  // ELECTRON_RUN_AS_NODE is scoped to the MCP child in mcp.env.  Never make
  // the Codex PTY itself run as Electron just because the parent inherited a
  // stale process variable.
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'electron_run_as_node') delete env[key]
  }

  return {
    args: [...baseArgs, ...configArgs],
    env,
    mcp,
  }
}
