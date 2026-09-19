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
  error?: { code?: number; message?: string }
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

function startMcp(env: Record<string, string> = {}): McpClient {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env }
  for (const name of ['DEVORBIT_BRIDGE_PIPE', 'DEVORBIT_BRIDGE_TOKEN', 'DEVORBIT_SESSION_ID']) {
    if (!(name in env)) delete childEnv[name]
  }
  const child: ChildProcess = spawn(process.execPath, [mcpScript], {
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
    const mcp = startMcp()
    const response = await mcp.request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'conformance', version: '1.0.0' } },
    })

    expect(response).toMatchObject({ jsonrpc: '2.0', id: 1 })
    expect(response.result?.protocolVersion).toBe('2025-06-18')
    expect(response.result?.capabilities?.tools?.listChanged).toBe(false)
    expect(response.result?.serverInfo?.name).toBe('DevOrbit MCP')
    expect(response.result?.serverInfo?.version).toBeTruthy()
  })

  it('lists the four agent tools with their input schemas', async () => {
    const mcp = startMcp()
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
    const mcp = startMcp()
    mcp.notify({ jsonrpc: '2.0', method: 'tools/list' })
    await mcp.expectSilence(300)

    const liveness = await mcp.request({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} })
    expect(liveness.id).toBe(3)
    expect(liveness.result?.serverInfo?.name).toBe('DevOrbit MCP')
  })

  it('answers malformed JSON with parse error -32700 and keeps the loop alive', async () => {
    const mcp = startMcp()
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

    const response = await mcp.request({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'agent.ask', arguments: { target: 'agy', prompt: 'x' } },
    })

    expect(response.result?.isError).toBe(true)
    expect(response.result?.content?.[0]?.text).toContain('authentication failed')
  })

  it('reports a missing bridge environment without calling the pipe', async () => {
    const mcp = startMcp()
    const response = await mcp.request({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'agent.list', arguments: {} },
    })

    expect(response.result?.isError).toBe(true)
    expect(response.result?.content?.[0]?.text).toContain('não configurado')
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

    mcp.notify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'agent.send', arguments: { target: 'agy', prompt: 'silencioso' } },
    })

    await expect.poll(() => received, { timeout: 5_000 }).toBe(1)
    await mcp.expectSilence(200)
  })
})
