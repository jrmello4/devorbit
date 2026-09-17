import { request as httpRequest, get as httpGet } from 'node:http'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AuditLedger } from '../src/main/audit-ledger'
import { HITLManager } from '../src/main/hitl'
import { Semaphore } from '../src/main/semaphore'
import { Telemetry } from '../src/main/telemetry'
import { McpServer } from '../src/main/mcp/server'
import { createSseTransport, createStdioTransport, createStreamableHttpTransport } from '../src/main/mcp/transports'

function postJson(port: number, pathname: string, payload: unknown, authToken?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', ...(authToken ? { authorization: `Bearer ${authToken}` } : {}) } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.end(JSON.stringify(payload))
  })
}

describe('McpServer', () => {
  it('lists and calls typed tools with optional integrations', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devorbit-mcp-'))
    try {
      const telemetry = new Telemetry({ clock: (() => {
        let now = 100
        return () => ++now
      })() })
      const ledger = new AuditLedger(path.join(directory, 'audit.jsonl'))
      const server = new McpServer({ integrations: { semaphore: new Semaphore(1), ledger, telemetry } })
      server.registerTool({
        name: 'sum',
        description: 'Adds two values',
        inputSchema: { type: 'object' },
        handler: (args: { a: number; b: number }) => ({ total: args.a + args.b }),
      })
      const listing = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      expect(((listing as unknown) as { result: { tools: Array<{ name: string }> } }).result.tools[0].name).toBe('sum')
      const call = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sum', arguments: { a: 2, b: 3 } } })
      expect(JSON.stringify(call)).toContain('5')
      expect(telemetry.getSpans()[0].status).toBe('ok')
      expect(await ledger.read()).toHaveLength(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('waits for HITL approval before invoking a protected tool', async () => {
    const hitl = new HITLManager({ defaultTtlMs: 5_000, idFactory: () => 'mcp-approval' })
    let invoked = false
    const server = new McpServer({ integrations: { hitl } })
    server.registerTool({
      name: 'protected',
      inputSchema: { type: 'object' },
      requiresApproval: true,
      handler: () => {
        invoked = true
        return 'done'
      },
    })
    const call = server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'protected', arguments: {} } })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(hitl.pending()[0].id).toBe('mcp-approval')
    expect(invoked).toBe(false)
    hitl.approve('mcp-approval')
    const result = await call
    expect(invoked).toBe(true)
    expect(JSON.stringify(result)).toContain('done')
  })

  it('returns JSON-RPC protocol errors and suppresses notification responses', async () => {
    const server = new McpServer()
    const unknown = await server.handle({ jsonrpc: '2.0', id: 'x', method: 'missing' })
    expect((unknown as { error: { code: number } }).error.code).toBe(-32601)
    expect(await server.handle({ jsonrpc: '2.0', method: 'tools/list' })).toBeUndefined()
  })

  it('answers the MCP initialize handshake', async () => {
    const server = new McpServer({ name: 'DevOrbit', version: '1.0.29' })
    const result = await server.handle({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    expect(result).toMatchObject({ result: { protocolVersion: '2025-06-18', serverInfo: { name: 'DevOrbit', version: '1.0.29' } } })
  })

  it('records span duration, status, and redacted attributes', () => {
    let now = 10
    const telemetry = new Telemetry({ clock: () => now })
    const span = telemetry.startSpan('operation', { prompt: 'private', token: 'secret', env: { PATH: 'hidden' }, safe: 'visible' })
    now = 42
    const record = span.end({ status: 'ok' })
    expect(record.durationMs).toBe(32)
    expect(record.status).toBe('ok')
    expect(record.attributes.prompt).toBe('[REDACTED]')
    expect(record.attributes.token).toBe('[REDACTED]')
    expect(record.attributes.env).toBe('[REDACTED]')
    expect(record.attributes.safe).toBe('visible')
  })
})

describe('MCP transports', () => {
  it('adapts newline JSON over stdio', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: Buffer[] = []
    output.on('data', (chunk: Buffer) => chunks.push(chunk))
    const server = new McpServer()
    server.registerTool({ name: 'echo', inputSchema: { type: 'object' }, handler: () => 'ok' })
    const transport = createStdioTransport(server, { input, output })
    await transport.start()
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } })}\n`)
    await transport.flush()
    expect(Buffer.concat(chunks).toString('utf8')).toContain('ok')
    await transport.close()
  })

  it('does not bind streamable HTTP until listen is called', async () => {
    const server = new McpServer()
    server.registerTool({ name: 'echo', inputSchema: { type: 'object' }, handler: () => 'http-ok' })
    const transport = createStreamableHttpTransport(server)
    expect(transport.httpServer.listening).toBe(false)
    const address = await transport.listen(0)
    const unauthorized = await postJson(address.port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } })
    expect(unauthorized.status).toBe(401)
    const result = await postJson(address.port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }, transport.authToken)
    expect(result.status).toBe(200)
    expect(result.body).toContain('http-ok')
    await transport.close()
  })

  it('opens an SSE session and routes a message response to it', async () => {
    const server = new McpServer()
    server.registerTool({ name: 'echo', inputSchema: { type: 'object' }, handler: () => 'sse-ok' })
    const transport = createSseTransport(server)
    expect(transport.httpServer.listening).toBe(false)
    const address = await transport.listen(0)
    const stream = await new Promise<{ response: import('node:http').IncomingMessage; first: string }>((resolve, reject) => {
      const request = httpGet({ hostname: '127.0.0.1', port: address.port, path: '/sse', headers: { authorization: `Bearer ${transport.authToken}` } }, (response) => {
        response.once('data', (chunk: Buffer) => resolve({ response, first: chunk.toString('utf8') }))
      })
      request.on('error', reject)
    })
    expect(stream.first).toContain('event: endpoint')
    const sessionId = transport.sessionIds()[0]
    const unknownSession = await postJson(address.port, '/messages?sessionId=missing', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }, transport.authToken)
    expect(unknownSession.status).toBe(404)
    const result = await postJson(address.port, `/messages?sessionId=${encodeURIComponent(sessionId)}`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }, transport.authToken)
    expect(result.status).toBe(202)
    const event = await new Promise<string>((resolve) => stream.response.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8'))))
    expect(event).toContain('sse-ok')
    stream.response.destroy()
    await transport.close()
  })
})
