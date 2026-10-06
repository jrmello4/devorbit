import { once } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAgentBridgeServer,
  type AgentBridgeHandlers,
  type AgentBridgeRequest,
} from '../src/main/agent-bridge'

const mcpScript = path.resolve(process.cwd(), 'scripts', 'devorbit-mcp.cjs')
// Versão esperada derivada do package.json: acompanha bumps de release sem
// edição manual (o servidor MCP reporta a versão empacotada).
const packageVersion = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')).version

interface McpMessage {
  jsonrpc?: string
  id?: unknown
  result?: {
    protocolVersion?: string
    capabilities?: { tools?: { listChanged?: boolean } }
    serverInfo?: { name?: string; version?: string }
    tools?: Array<{ name?: string; inputSchema?: { required?: string[] } }>
    isError?: boolean
    structuredContent?: unknown
    content?: Array<{ type?: string; text?: string }>
  }
  error?: { code?: number; message?: string; data?: { code?: string } }
}

interface McpClient {
  request: (payload: Record<string, unknown>) => Promise<McpMessage>
  sendRaw: (raw: string) => Promise<McpMessage>
  notify: (payload: Record<string, unknown>) => void
  expectSilence: (ms?: number) => Promise<void>
  close: () => Promise<void>
}

interface BridgeFixture {
  pipeName: string
  token: string
  sessionId: string
  close: () => Promise<void>
}

const mcpClients: McpClient[] = []
const bridgeServers: Array<{ close: () => Promise<void> }> = []
let pipeSequence = 0

function startMcp(env: Record<string, string> = {}, args: string[] = []): McpClient {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env }
  for (const name of ['DEVORBIT_BRIDGE_PIPE', 'DEVORBIT_BRIDGE_TOKEN', 'DEVORBIT_SESSION_ID']) {
    if (!(name in env)) delete childEnv[name]
  }
  const child: ChildProcess = spawn(process.execPath, [mcpScript, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
    windowsHide: true,
  })
  const lines: string[] = []
  const waiters: Array<{ resolve: (line: string) => void; timer: NodeJS.Timeout }> = []
  let buffer = ''

  const deliver = (line: string): void => {
    const waiter = waiters.shift()
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.resolve(line)
      return
    }
    lines.push(line)
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      deliver(buffer.slice(0, index).trimEnd())
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
  })

  const nextLine = (timeoutMs = 5_000): Promise<string> =>
    new Promise((resolve, reject) => {
      if (lines.length > 0) {
        resolve(lines.shift() as string)
        return
      }
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.timer === timer)
        if (index >= 0) waiters.splice(index, 1)
        reject(new Error('timeout aguardando resposta do MCP'))
      }, timeoutMs)
      waiters.push({ resolve, timer })
    })

  const write = (text: string): void => {
    child.stdin?.write(`${text}\n`)
  }

  const client: McpClient = {
    request: async (payload) => {
      write(JSON.stringify(payload))
      return JSON.parse(await nextLine()) as McpMessage
    },
    sendRaw: async (raw) => {
      write(raw)
      return JSON.parse(await nextLine()) as McpMessage
    },
    notify: (payload) => {
      write(JSON.stringify(payload))
    },
    expectSilence: async (ms = 250) => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      if (lines.length > 0) throw new Error(`resposta inesperada do MCP: ${lines[0]}`)
    },
    close: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve()
          return
        }
        const timer = setTimeout(resolve, 1_000)
        child.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
        child.stdin?.end()
        child.kill()
      }),
  }
  mcpClients.push(client)
  return client
}

async function initializeMcp(mcp: McpClient, id = 1): Promise<McpMessage> {
  return mcp.request({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'conformance', version: '1.0.0' } },
  })
}

async function startBridge(
  handlers: AgentBridgeHandlers,
  credentials: { token?: string; sessionId?: string } = {},
): Promise<BridgeFixture> {
  const token = credentials.token ?? 'a'.repeat(64)
  const sessionId = credentials.sessionId ?? 'b'.repeat(24)
  pipeSequence += 1
  const pipeName = process.platform === 'win32'
    ? `\\\\.\\pipe\\devorbit-mcp-conformance-${process.pid}-${pipeSequence}`
    : `/tmp/devorbit-mcp-conformance-${process.pid}-${pipeSequence}.sock`
  const server = createAgentBridgeServer({ pipeName, token, sessionId, handlers })
  if (!server.listening) await once(server, 'listening')
  const fixture: BridgeFixture = {
    pipeName,
    token,
    sessionId,
    close: () =>
      new Promise((resolve) => {
        if (!server.listening) {
          resolve()
          return
        }
        const timer = setTimeout(resolve, 1_000)
        server.close(() => {
          clearTimeout(timer)
          resolve()
        })
      }),
  }
  bridgeServers.push(fixture)
  return fixture
}

function bridgeEnv(bridge: BridgeFixture, overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    DEVORBIT_BRIDGE_PIPE: bridge.pipeName,
    DEVORBIT_BRIDGE_TOKEN: bridge.token,
    DEVORBIT_SESSION_ID: bridge.sessionId,
    ...overrides,
  }
}

afterEach(async () => {
  for (const client of mcpClients.splice(0)) await client.close()
  for (const bridge of bridgeServers.splice(0)) await bridge.close()
})

describe('devorbit-mcp conformance', () => {
  it('requires the executable script to exist in the checkout', () => {
    expect(fs.existsSync(mcpScript)).toBe(true)
    expect(fs.statSync(mcpScript).size).toBeGreaterThan(0)
  })

  it('answers initialize with protocol version, tools capability and server info', async () => {
    const bridge = await startBridge({})
    const mcp = startMcp(bridgeEnv(bridge))
    const response = await initializeMcp(mcp)

    expect(response).toMatchObject({ jsonrpc: '2.0', id: 1 })
    expect(response.result?.protocolVersion).toBe('2025-06-18')
    expect(response.result?.capabilities?.tools?.listChanged).toBe(false)
    expect(response.result?.serverInfo?.name).toBe('DevOrbit MCP')
    expect(response.result?.serverInfo?.version).toBe(packageVersion)
  })

  it('exposes a coherent preflight timeout below 10s and the packaged version', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BRIDGE_PING_TIMEOUT_MS, getMcpVersion } = require('../scripts/devorbit-mcp.cjs')
    expect(BRIDGE_PING_TIMEOUT_MS).toBe(8_000)
    expect(BRIDGE_PING_TIMEOUT_MS).toBeLessThan(10_000)
    expect(BRIDGE_PING_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000)
    expect(getMcpVersion()).toBe(packageVersion)
  })

  it('lists the four agent tools with their input schemas', async () => {
    const bridge = await startBridge({})
    const mcp = startMcp(bridgeEnv(bridge))
    await initializeMcp(mcp)
    const response = await mcp.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    expect(response.result?.tools?.map((tool) => tool.name)).toEqual([
      'agent.list',
      'agent.send',
      'agent.wait',
      'agent.ask',
      'agent.run',
    ])
    const send = response.result?.tools?.find((tool) => tool.name === 'agent.send')
    const ask = response.result?.tools?.find((tool) => tool.name === 'agent.ask')
    const run = response.result?.tools?.find((tool) => tool.name === 'agent.run')
    expect(send?.inputSchema?.required).toEqual(['target', 'prompt'])
    expect(ask?.inputSchema?.required).toEqual(['target', 'prompt'])
    expect(run?.inputSchema?.required).toEqual(['target', 'prompt'])
  })

  it('treats tools/list without an id as a notification and stays responsive', async () => {
    const bridge = await startBridge({})
    const mcp = startMcp(bridgeEnv(bridge))
    await initializeMcp(mcp)
    mcp.notify({ jsonrpc: '2.0', method: 'tools/list' })
    await mcp.expectSilence(300)

    const liveness = await mcp.request({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} })
    expect(liveness.id).toBe(3)
    expect(liveness.result?.serverInfo?.name).toBe('DevOrbit MCP')
  })

  it('answers malformed JSON with parse error -32700 and keeps the loop alive', async () => {
    const bridge = await startBridge({})
    const mcp = startMcp(bridgeEnv(bridge))
    await initializeMcp(mcp)
    const response = await mcp.sendRaw('{ isto nao e json')

    expect(response).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } })

    const liveness = await mcp.request({ jsonrpc: '2.0', id: 4, method: 'initialize', params: {} })
    expect(liveness.result?.serverInfo?.name).toBe('DevOrbit MCP')
  })

  it('rejects invalid requests and unknown methods with JSON-RPC codes', async () => {
    const mcp = startMcp()
    const invalid = await mcp.request({ jsonrpc: '1.0', id: 5, method: 'initialize' })
    expect(invalid.error?.code).toBe(-32600)

    const unknown = await mcp.request({ jsonrpc: '2.0', id: 6, method: 'resources/list' })
    expect(unknown.error?.code).toBe(-32601)
  })

  it('returns text content and structuredContent for object results', async () => {
    const calls: AgentBridgeRequest[] = []
    const bridge = await startBridge({
      ask: async (request) => {
        calls.push(request)
        return { summary: 'pronto', status: 'completed' }
      },
    })
    const mcp = startMcp(bridgeEnv(bridge))
    await initializeMcp(mcp)

    const response = await mcp.request({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'agent.ask', arguments: { target: 'agy', prompt: 'implemente' } },
    })

    expect(response.result?.isError).toBeUndefined()
    expect(response.result?.structuredContent).toEqual({ summary: 'pronto', status: 'completed' })
    expect(response.result?.content?.[0]).toEqual({
      type: 'text',
      text: JSON.stringify({ summary: 'pronto', status: 'completed' }),
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ type: 'ask', target: 'agy', prompt: 'implemente' })
    expect(calls[0].token).toBe(bridge.token)
    expect(calls[0].sessionId).toBe(bridge.sessionId)
  })

  it('returns text-only content for string results', async () => {
    const bridge = await startBridge({ send: async () => 'texto simples' })
    const mcp = startMcp(bridgeEnv(bridge))
    await initializeMcp(mcp)

    const response = await mcp.request({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'agent.send', arguments: { target: 'opencode', prompt: 'rode' } },
    })

    expect(response.result?.isError).toBeUndefined()
    expect(response.result?.content).toEqual([{ type: 'text', text: JSON.stringify('texto simples') }])
    expect(response.result?.structuredContent).toBeUndefined()
  })

  it('calls the authenticated agent.list tool after initialize', async () => {
    const calls: AgentBridgeRequest[] = []
    const bridge = await startBridge({
      list: async (request) => {
        calls.push(request)
        return [{ id: 'agy', status: 'active' }]
      },
    })
    const mcp = startMcp(bridgeEnv(bridge))
    await initializeMcp(mcp)

    const response = await mcp.request({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: { name: 'agent.list', arguments: {} },
    })

    expect(response.result?.isError).toBeUndefined()
    expect(response.result?.content?.[0]?.text).toBe(JSON.stringify([{ id: 'agy', status: 'active' }]))
    expect(response.result?.structuredContent).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ type: 'list', token: bridge.token, sessionId: bridge.sessionId })
  })

  it('maps agent.run options to the bridge run request and returns structured content', async () => {
    const calls: AgentBridgeRequest[] = []
    const bridge = await startBridge({
      run: async (request) => {
        calls.push(request)
        return {
          status: 'completed',
          summary: 'headless ok',
          origin: 'devorbit',
          destination: 'agy',
          result: { outcome: 'completed', summary: 'headless ok' },
        }
      },
    })
    const mcp = startMcp(bridgeEnv(bridge))
    await initializeMcp(mcp)

    const response = await mcp.request({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'agent.run',
        arguments: {
          target: 'agy',
          prompt: 'refatore o módulo',
          model: 'gemini-2.0-flash',
          mode: 'accept-edits',
          effort: 'high',
          agent: 'reviewer',
        },
      },
    })

    expect(response.result?.isError).toBeUndefined()
    expect(response.result?.structuredContent).toMatchObject({ status: 'completed', summary: 'headless ok' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      type: 'run',
      target: 'agy',
      prompt: 'refatore o módulo',
      model: 'gemini-2.0-flash',
      mode: 'accept-edits',
      effort: 'high',
      agent: 'reviewer',
      timeoutMs: 5 * 60 * 1000,
    })
  })

  it('surfaces bridge authentication failures as isError content', async () => {
    const bridge = await startBridge(
      { ask: async () => ({ summary: 'nao deveria executar' }) },
      { token: 'c'.repeat(64) },
    )
    const mcp = startMcp(bridgeEnv(bridge, { DEVORBIT_BRIDGE_TOKEN: 'd'.repeat(64) }))

    const initialize = await initializeMcp(mcp)
    expect(initialize.error?.data).toMatchObject({ code: 'BRIDGE_AUTH_REJECTED' })

    const response = await mcp.request({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'agent.ask', arguments: { target: 'agy', prompt: 'x' } },
    })

    expect(response.result?.isError).toBe(true)
    const structured = response.result?.structuredContent as Record<string, unknown>
    expect(structured).toMatchObject({
      code: 'MCP_NOT_INITIALIZED',
      errorCode: 'MCP_NOT_INITIALIZED',
      phase: 'request_rejected',
      turnId: 'unknown',
      provider: 'unknown',
      elapsedMs: 0,
    })
    expect(response.result?.content?.[0]?.text).toBe(JSON.stringify(structured))
  })

  it('rejects initialize when the bridge environment is missing', async () => {
    const mcp = startMcp()
    const initialize = await initializeMcp(mcp)
    expect(initialize.error?.data).toMatchObject({ code: 'BRIDGE_ENV_MISSING' })
    const response = await mcp.request({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'agent.list', arguments: {} },
    })

    expect(response.result?.isError).toBe(true)
    const structured = response.result?.structuredContent as Record<string, unknown>
    expect(structured).toMatchObject({
      code: 'MCP_NOT_INITIALIZED',
      errorCode: 'MCP_NOT_INITIALIZED',
      phase: 'request_rejected',
      turnId: 'unknown',
      provider: 'unknown',
      elapsedMs: 0,
    })
    expect(response.result?.content?.[0]?.text).toBe(JSON.stringify(structured))
  })

  it('distinguishes a rejected token from a mismatched session during initialize', async () => {
    const bridge = await startBridge({}, { token: 'c'.repeat(64), sessionId: 's'.repeat(24) })

    const wrongToken = startMcp(bridgeEnv(bridge, { DEVORBIT_BRIDGE_TOKEN: 'd'.repeat(64) }))
    const auth = await initializeMcp(wrongToken)
    expect(auth.error?.data).toMatchObject({ code: 'BRIDGE_AUTH_REJECTED' })
    expect(auth.error?.message).not.toContain(bridge.token)
    expect(JSON.stringify(auth)).not.toContain(bridge.pipeName)

    const wrongSession = startMcp(bridgeEnv(bridge, { DEVORBIT_SESSION_ID: 't'.repeat(24) }))
    const session = await initializeMcp(wrongSession)
    expect(session.error?.data).toMatchObject({ code: 'BRIDGE_SESSION_MISMATCH' })
    expect(session.error?.message).not.toContain(bridge.sessionId)
    expect(JSON.stringify(session)).not.toContain(bridge.pipeName)
  })

  it('completes managed initialize only after the authenticated launch handshake', async () => {
    const handshakes: AgentBridgeRequest[] = []
    const bridge = await startBridge({
      mcpHandshake: async (request) => {
        handshakes.push(request)
        return { connected: true }
      },
    })
    const mcp = startMcp(bridgeEnv(bridge), ['--terminal-id', 'terminal-1', '--launch-id', 'launch-1'])
    const initialized = await initializeMcp(mcp)
    expect(initialized.result?.serverInfo?.name).toBe('DevOrbit MCP')
    expect(handshakes).toHaveLength(1)
    expect(handshakes[0]).toMatchObject({ type: 'mcp-handshake', terminalId: 'terminal-1', launchId: 'launch-1', pid: expect.any(Number) })
    const listing = await mcp.request({ jsonrpc: '2.0', id: 17, method: 'tools/list' })
    expect(listing.result?.tools?.length).toBe(5)

    const standalone = startMcp(bridgeEnv(bridge))
    await initializeMcp(standalone, 13)
    standalone.notify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(handshakes).toHaveLength(1)
  })

  it('keeps managed tools gated when the launch handshake is rejected', async () => {
    const bridge = await startBridge({})
    const mcp = startMcp(bridgeEnv(bridge), ['--terminal-id', 'terminal-2', '--launch-id', 'launch-2'])
    const initialize = await initializeMcp(mcp)
    expect(initialize.error?.data).toMatchObject({ code: 'MCP_STARTUP_FAILED' })

    const listing = await mcp.request({ jsonrpc: '2.0', id: 18, method: 'tools/list' })
    expect(listing.error?.data).toMatchObject({ code: 'MCP_NOT_INITIALIZED' })
  })

  it('waits for a managed handshake before returning initialize', async () => {
    let resolveHandshake!: (value: unknown) => void
    const handshakeHold = new Promise((resolve) => {
      resolveHandshake = resolve
    })
    const handshakes: AgentBridgeRequest[] = []
    const bridge = await startBridge({
      mcpHandshake: async (request) => {
        handshakes.push(request)
        await handshakeHold
        return { connected: true }
      },
    })
    const mcp = startMcp(bridgeEnv(bridge), ['--terminal-id', 'terminal-pipe', '--launch-id', 'launch-pipe'])
    const responsePromise = initializeMcp(mcp, 20)

    await expect.poll(() => handshakes.length, { timeout: 5_000 }).toBe(1)
    expect(handshakes[0]).toMatchObject({ type: 'mcp-handshake', terminalId: 'terminal-pipe', launchId: 'launch-pipe' })

    resolveHandshake({ connected: true })

    const response = await responsePromise
    expect(response.result?.serverInfo?.name).toBe('DevOrbit MCP')
  })

  it('returns a sanitized startup failure when the managed handshake fails', async () => {
    let releaseHandshake!: () => void
    const handshakeHold = new Promise<void>((resolve) => {
      releaseHandshake = resolve
    })
    const handshakes: AgentBridgeRequest[] = []
    const bridge = await startBridge({
      mcpHandshake: async (request) => {
        handshakes.push(request)
        await handshakeHold
        throw new Error('Handshake rejected')
      },
    })
    const mcp = startMcp(bridgeEnv(bridge), ['--terminal-id', 'terminal-pipe-fail', '--launch-id', 'launch-pipe-fail'])
    const responsePromise = initializeMcp(mcp, 21)
    await expect.poll(() => handshakes.length, { timeout: 5_000 }).toBe(1)
    releaseHandshake()

    const response = await responsePromise
    expect(response.error?.data).toMatchObject({ code: 'MCP_STARTUP_FAILED' })
    expect(response.error?.message).toBe('MCP bridge initialization failed.')
  })

  it('propagates a specific bridge validation code without echoing prompt or credentials', async () => {
    const calls: AgentBridgeRequest[] = []
    const bridge = await startBridge({ ask: async (request) => {
      calls.push(request)
      return { summary: 'must not execute', status: 'completed' }
    } }, { token: 'validation-secret-token' })
    const mcp = startMcp(bridgeEnv(bridge, { DEVORBIT_BRIDGE_TOKEN: 'validation-secret-token' }))
    await initializeMcp(mcp)

    const response = await mcp.request({
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: { name: 'agent.ask', arguments: { target: 'agy', prompt: 'linha-secreta-1\nlinha-secreta-2\u0000' } },
    })

    const structured = response.result?.structuredContent as Record<string, unknown>
    expect(calls).toHaveLength(0)
    expect(response.result?.isError).toBe(true)
    expect(structured).toEqual({
      code: 'INVALID_PROMPT',
      errorCode: 'INVALID_PROMPT',
      phase: 'request_rejected',
      turnId: 'unknown',
      provider: 'unknown',
      elapsedMs: 0,
    })
    expect(response.result?.content?.[0]?.text).toBe(JSON.stringify(structured))
    const serialized = JSON.stringify(response)
    expect(serialized).not.toContain('linha-secreta')
    expect(serialized).not.toContain('validation-secret-token')
    expect(serialized).not.toContain(bridge.pipeName)
  })

  it('preserves safe pre-turn readiness errors through MCP without inventing a turn id', async () => {
    const bridge = await startBridge({ ask: async () => {
      throw Object.assign(new Error('private detail must not pass'), {
        code: 'AGENT_NOT_READY',
        bridgeData: {
          phase: 'target_validation',
          agentId: 'agent-codex-1',
          provider: 'codex',
          status: 'starting',
          operational: false,
          turnCreated: false,
        },
      })
    } })
    const mcp = startMcp(bridgeEnv(bridge))
    await initializeMcp(mcp)

    const response = await mcp.request({
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/call',
      params: { name: 'agent.ask', arguments: { target: 'agent-codex-1', prompt: 'prompt-secret' } },
    })

    const structured = response.result?.structuredContent as Record<string, unknown>
    expect(structured).toEqual({
      code: 'AGENT_NOT_READY',
      errorCode: 'AGENT_NOT_READY',
      phase: 'target_validation',
      provider: 'codex',
      agentId: 'agent-codex-1',
      status: 'starting',
      operational: false,
      turnCreated: false,
    })
    expect(structured).not.toHaveProperty('turnId')
    expect(response.result?.isError).toBe(true)
    const serialized = JSON.stringify(response)
    expect(serialized).not.toContain('private detail')
    expect(serialized).not.toContain('prompt-secret')
    expect(serialized).not.toContain(bridge.token)
    expect(serialized).not.toContain(bridge.pipeName)
  })

  it('returns bounded failed-turn diagnostics in text JSON and structuredContent', async () => {
    const promptSecret = 'prompt-secret-value'
    const tokenSecret = 'token-secret-value'
    const bridge = await startBridge(
      {
        ask: async () => ({
          status: 'failed',
          errorCode: 'RESULT_PARSE_FAILED',
          summary: `prompt=${promptSecret} token=${tokenSecret}`,
          diagnostic: {
            phase: 'result_candidate',
            turnId: 'bridge_worker_1_abc123',
            provider: 'codex',
            elapsedMs: 42,
            providerState: 'busy',
            markerState: 'seen',
            nonceState: 'unmatched',
            exitCode: 7,
            prompt: promptSecret,
            token: tokenSecret,
            env: 'sensitive-env-value',
          },
        }),
      },
      { token: tokenSecret },
    )
    const mcp = startMcp(bridgeEnv(bridge))
    await initializeMcp(mcp)

    const response = await mcp.request({
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/call',
      params: { name: 'agent.ask', arguments: { target: 'agy', prompt: 'safe task' } },
    })

    const structured = response.result?.structuredContent as Record<string, unknown>
    expect(response.result?.isError).toBe(true)
    expect(structured).toEqual({
      code: 'RESULT_PARSE_FAILED',
      errorCode: 'RESULT_PARSE_FAILED',
      phase: 'result_candidate',
      turnId: 'bridge_worker_1_abc123',
      provider: 'codex',
      elapsedMs: 42,
      providerState: 'busy',
      markerState: 'seen',
      nonceState: 'unmatched',
      exitCode: 7,
    })
    expect(response.result?.content?.[0]?.text).toBe(JSON.stringify(structured))
    const serialized = JSON.stringify(response)
    expect(serialized).not.toContain(promptSecret)
    expect(serialized).not.toContain(tokenSecret)
    expect(serialized).not.toContain('sensitive-env-value')
  })

  it('propagates only known thrown-turn diagnostics from the bridge', async () => {
    const promptSecret = 'thrown-prompt-secret'
    const tokenSecret = 'thrown-token-secret'
    const bridge = await startBridge(
      {
        ask: async () => {
          const failure = Object.assign(new Error(`provider output prompt=${promptSecret} token=${tokenSecret}`), {
            code: 'PROVIDER_STARTUP_FAILED',
            diagnostic: {
              phase: 'provider_startup_failed',
              turnId: 'bridge_worker_2_def456',
              provider: 'codex',
              elapsedMs: 17,
              providerState: 'failed',
              markerState: 'missing',
              nonceState: 'unmatched',
              exitCode: 2,
              prompt: promptSecret,
              token: tokenSecret,
            },
          })
          throw failure
        },
      },
      { token: tokenSecret },
    )
    const mcp = startMcp(bridgeEnv(bridge))
    await initializeMcp(mcp)

    const response = await mcp.request({
      jsonrpc: '2.0',
      id: 25,
      method: 'tools/call',
      params: { name: 'agent.ask', arguments: { target: 'agy', prompt: 'safe task' } },
    })

    const structured = response.result?.structuredContent as Record<string, unknown>
    expect(response.result?.isError).toBe(true)
    expect(structured).toEqual({
      code: 'PROVIDER_STARTUP_FAILED',
      errorCode: 'PROVIDER_STARTUP_FAILED',
      phase: 'provider_startup_failed',
      turnId: 'bridge_worker_2_def456',
      provider: 'codex',
      elapsedMs: 17,
      providerState: 'failed',
      markerState: 'missing',
      nonceState: 'unmatched',
      exitCode: 2,
    })
    expect(response.result?.content?.[0]?.text).toBe(JSON.stringify(structured))
    const serialized = JSON.stringify(response)
    expect(serialized).not.toContain(promptSecret)
    expect(serialized).not.toContain(tokenSecret)
  })

  it('preserves the caller identity stale code without exposing bridge details', async () => {
    const bridge = await startBridge({
      ask: async () => {
        throw Object.assign(new Error('stale caller token=do-not-forward'), { code: 'CALLER_IDENTITY_STALE' })
      },
    })
    const mcp = startMcp(bridgeEnv(bridge))
    await initializeMcp(mcp)

    const response = await mcp.request({
      jsonrpc: '2.0',
      id: 26,
      method: 'tools/call',
      params: { name: 'agent.ask', arguments: { target: 'agy', prompt: 'safe task' } },
    })

    const structured = response.result?.structuredContent as Record<string, unknown>
    expect(response.result?.isError).toBe(true)
    expect(structured).toMatchObject({
      code: 'CALLER_IDENTITY_STALE',
      errorCode: 'CALLER_IDENTITY_STALE',
      phase: 'request_rejected',
      turnId: 'unknown',
      provider: 'unknown',
      elapsedMs: 0,
    })
    expect(response.result?.content?.[0]?.text).toBe(JSON.stringify(structured))
    expect(JSON.stringify(response)).not.toContain('do-not-forward')
  })

  it('includes managed caller identity after the bridge context', async () => {
    const calls: AgentBridgeRequest[] = []
    const bridge = await startBridge({
      mcpHandshake: async () => ({ connected: true }),
      ask: async (request) => {
        calls.push(request)
        return { summary: 'identity-ok', status: 'completed' }
      },
    })
    const mcp = startMcp(bridgeEnv(bridge), ['--terminal-id', 'coordinator', '--launch-id', 'launch-1'])
    await initializeMcp(mcp)

    const response = await mcp.request({
      jsonrpc: '2.0',
      id: 24,
      method: 'tools/call',
      params: { name: 'agent.ask', arguments: { target: 'agy', prompt: 'identity check' } },
    })

    expect(response.result?.isError).toBeUndefined()
    expect(calls[0]).toMatchObject({
      origin: 'coordinator',
      originTerminalId: 'coordinator',
      originLaunchId: 'launch-1',
    })
  })

  it('defaults agent.wait timeout to the bridge default when the caller omits it', async () => {
    const calls: AgentBridgeRequest[] = []
    const bridge = await startBridge({
      wait: async (request) => {
        calls.push(request)
        return { summary: 'aguardado', status: 'completed' }
      },
    })
    const mcp = startMcp(bridgeEnv(bridge))
    await initializeMcp(mcp)

    const withoutTimeout = await mcp.request({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'agent.wait', arguments: { target: 'agy' } },
    })

    expect(withoutTimeout.result?.isError).toBeUndefined()
    expect(withoutTimeout.result?.structuredContent).toEqual({ summary: 'aguardado', status: 'completed' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ type: 'wait', target: 'agy', timeoutMs: 5 * 60 * 1000 })

    const withTimeout = await mcp.request({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'agent.wait', arguments: { target: 'opencode', timeoutMs: 1_000 } },
    })

    expect(withTimeout.result?.isError).toBeUndefined()
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ type: 'wait', target: 'opencode', timeoutMs: 1_000 })
  })

  it('treats tools/call without an id as a notification while still reaching the bridge', async () => {
    let received = 0
    const bridge = await startBridge({
      send: async () => {
        received += 1
        return 'ok'
      },
    })
    const mcp = startMcp(bridgeEnv(bridge))
    await initializeMcp(mcp)

    mcp.notify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'agent.send', arguments: { target: 'agy', prompt: 'silencioso' } },
    })

    await expect.poll(() => received, { timeout: 5_000 }).toBe(1)
    await mcp.expectSilence(200)
  })
})
