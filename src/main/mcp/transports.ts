import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createInterface, type Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { McpServer } from './server'
import { McpHttpSecurity, type SlidingWindowRateLimiterOptions } from './security'

export interface McpTransport {
  start: () => Promise<void> | void
  close: () => Promise<void>
}

export interface StdioTransportOptions {
  input?: Readable
  output?: Writable
  maxLineBytes?: number
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class StdioMcpTransport implements McpTransport {
  private readonly input: Readable
  private readonly output: Writable
  private readonly maxLineBytes: number
  private reader?: Interface
  private processing: Promise<void> = Promise.resolve()

  constructor(private readonly server: McpServer, options: StdioTransportOptions = {}) {
    this.input = options.input ?? process.stdin
    this.output = options.output ?? process.stdout
    this.maxLineBytes = options.maxLineBytes ?? 1_048_576
    if (!Number.isInteger(this.maxLineBytes) || this.maxLineBytes < 1) throw new RangeError('Stdio line limit must be positive.')
  }

  start(): void {
    if (this.reader) return
    this.reader = createInterface({ input: this.input, crlfDelay: Infinity })
    this.reader.on('line', (line) => {
      this.processing = this.processing.then(async () => {
        if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
          await this.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Message too large.' } }))
          return
        }
        const response = await this.server.handleJson(line)
        if (response !== undefined) await this.write(response)
      }).catch(async (error: unknown) => {
        await this.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: asErrorMessage(error).slice(0, 500) } }))
      })
    })
  }

  async close(): Promise<void> {
    this.reader?.close()
    this.reader = undefined
    await this.processing
  }

  async flush(): Promise<void> {
    await this.processing
  }

  private write(value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.output.write(`${value}\n`, (error?: Error | null) => error ? reject(error) : resolve())
    })
  }
}

export interface HttpTransportOptions {
  host?: string
  path?: string
  maxBodyBytes?: number
  authToken?: string
  allowedOrigins?: string[]
  rateLimit?: SlidingWindowRateLimiterOptions
}

export interface HttpAddress {
  address: string
  family: string | number
  port: number
}

async function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBodyBytes) throw new Error('Message too large.')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function requestPath(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://127.0.0.1')
}

function writeResponse(response: ServerResponse, status: number, body?: string, contentType = 'application/json'): void {
  if (body === undefined) {
    response.writeHead(status)
    response.end()
    return
  }
  response.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(body, 'utf8') })
  response.end(body)
}

function authorizeRequest(request: IncomingMessage, security: McpHttpSecurity): { allowed: boolean; status?: number; retryAfterMs?: number } {
  const authorization = request.headers.authorization
  const tokenHeader = request.headers['x-devorbit-token']
  const decision = security.authorize({
    clientId: request.socket.remoteAddress || 'unknown',
    origin: request.headers.origin,
    authorization: Array.isArray(authorization) ? authorization[0] : authorization,
    'x-devorbit-token': Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader,
  })
  return decision.allowed
    ? { allowed: true }
    : { allowed: false, status: decision.reason === 'rate-limit' ? 429 : 401, retryAfterMs: decision.rateLimit?.retryAfterMs }
}

function rejectUnauthorized(response: ServerResponse, status = 401, retryAfterMs?: number): void {
  response.setHeader('www-authenticate', 'Bearer')
  if (retryAfterMs !== undefined) response.setHeader('retry-after', String(Math.ceil(retryAfterMs / 1000)))
  writeResponse(response, status, JSON.stringify({ error: status === 429 ? 'Rate limit exceeded.' : 'Unauthorized.' }))
}

async function dispatchHttp(server: McpServer, request: IncomingMessage, response: ServerResponse, maxBodyBytes: number, security: McpHttpSecurity): Promise<void> {
  const authorization = authorizeRequest(request, security)
  if (!authorization.allowed) {
    rejectUnauthorized(response, authorization.status, authorization.retryAfterMs)
    return
  }
  if (request.method === 'OPTIONS') {
    writeResponse(response, 204)
    return
  }
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST')
    writeResponse(response, 405)
    return
  }
  try {
    const body = await readBody(request, maxBodyBytes)
    const result = await server.handleJson(body)
    if (result === undefined) writeResponse(response, 202)
    else writeResponse(response, 200, result)
  } catch (error) {
    writeResponse(response, 400, JSON.stringify({ error: asErrorMessage(error).slice(0, 500) }))
  }
}

export class StreamableHttpMcpTransport implements McpTransport {
  readonly httpServer: Server
  private readonly host: string
  private readonly basePath: string
  private readonly maxBodyBytes: number
  readonly authToken: string
  private readonly security: McpHttpSecurity
  private readonly allowedOrigins: readonly string[]
  private listening = false

  constructor(private readonly server: McpServer, options: HttpTransportOptions = {}) {
    this.host = options.host ?? '127.0.0.1'
    this.basePath = options.path ?? '/mcp'
    this.maxBodyBytes = options.maxBodyBytes ?? 4 * 1_048_576
    this.authToken = options.authToken ?? randomUUID().replace(/-/gu, '')
    this.allowedOrigins = options.allowedOrigins ?? ['http://127.0.0.1', 'http://localhost', 'null']
    this.security = new McpHttpSecurity({ authToken: this.authToken, allowedOrigins: this.allowedOrigins, rateLimit: options.rateLimit })
    if (!Number.isInteger(this.maxBodyBytes) || this.maxBodyBytes < 1) throw new RangeError('HTTP body limit must be positive.')
    this.httpServer = createServer((request, response) => {
      const url = requestPath(request)
      if (url.pathname !== this.basePath) {
        writeResponse(response, 404)
        return
      }
      void dispatchHttp(this.server, request, response, this.maxBodyBytes, this.security)
    })
  }

  start(port = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.listening) {
        resolve()
        return
      }
      const onError = (error: Error): void => {
        this.httpServer.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        this.httpServer.off('error', onError)
        this.listening = true
        resolve()
      }
      this.httpServer.once('error', onError)
      this.httpServer.once('listening', onListening)
      this.httpServer.listen(port, this.host)
    })
  }

  async listen(port = 0): Promise<HttpAddress> {
    await this.start(port)
    return this.address()
  }

  address(): HttpAddress {
    const address = this.httpServer.address() as AddressInfo | null
    if (!address) throw new Error('HTTP transport is not listening.')
    return { address: address.address, family: address.family, port: address.port }
  }

  async close(): Promise<void> {
    if (!this.listening) return
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((error) => error ? reject(error) : resolve())
    })
    this.listening = false
  }
}

export interface SseTransportOptions extends HttpTransportOptions {
  ssePath?: string
  messagesPath?: string
}

export class SseMcpTransport implements McpTransport {
  readonly httpServer: Server
  private readonly host: string
  private readonly ssePath: string
  private readonly messagesPath: string
  private readonly maxBodyBytes: number
  readonly authToken: string
  private readonly security: McpHttpSecurity
  private readonly allowedOrigins: readonly string[]
  private readonly clients = new Map<string, ServerResponse>()
  private listening = false

  constructor(private readonly server: McpServer, options: SseTransportOptions = {}) {
    this.host = options.host ?? '127.0.0.1'
    this.ssePath = options.ssePath ?? options.path ?? '/sse'
    this.messagesPath = options.messagesPath ?? '/messages'
    this.maxBodyBytes = options.maxBodyBytes ?? 4 * 1_048_576
    this.authToken = options.authToken ?? randomUUID().replace(/-/gu, '')
    this.allowedOrigins = options.allowedOrigins ?? ['http://127.0.0.1', 'http://localhost', 'null']
    this.security = new McpHttpSecurity({ authToken: this.authToken, allowedOrigins: this.allowedOrigins, rateLimit: options.rateLimit })
    if (!Number.isInteger(this.maxBodyBytes) || this.maxBodyBytes < 1) throw new RangeError('SSE body limit must be positive.')
    this.httpServer = createServer((request, response) => {
      void this.handle(request, response)
    })
  }

  sessionIds(): string[] {
    return [...this.clients.keys()]
  }

  start(port = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.listening) {
        resolve()
        return
      }
      const onError = (error: Error): void => {
        this.httpServer.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        this.httpServer.off('error', onError)
        this.listening = true
        resolve()
      }
      this.httpServer.once('error', onError)
      this.httpServer.once('listening', onListening)
      this.httpServer.listen(port, this.host)
    })
  }

  async listen(port = 0): Promise<HttpAddress> {
    await this.start(port)
    return this.address()
  }

  address(): HttpAddress {
    const address = this.httpServer.address() as AddressInfo | null
    if (!address) throw new Error('SSE transport is not listening.')
    return { address: address.address, family: address.family, port: address.port }
  }

  async close(): Promise<void> {
    for (const response of this.clients.values()) response.end()
    this.clients.clear()
    if (!this.listening) return
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((error) => error ? reject(error) : resolve())
    })
    this.listening = false
  }

  send(event: unknown): void {
    const data = JSON.stringify(event)
    for (const response of this.clients.values()) response.write(`event: message\ndata: ${data}\n\n`)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authorization = authorizeRequest(request, this.security)
    if (!authorization.allowed) {
      rejectUnauthorized(response, authorization.status, authorization.retryAfterMs)
      return
    }
    const url = requestPath(request)
    if (request.method === 'GET' && url.pathname === this.ssePath) {
      this.openClient(url, response)
      return
    }
    if (request.method === 'POST' && url.pathname === this.messagesPath) {
      await this.postMessage(url, request, response)
      return
    }
    writeResponse(response, 404)
  }

  private openClient(url: URL, response: ServerResponse): void {
    const sessionId = randomUUID()
    this.clients.set(sessionId, response)
    response.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream',
      'mcp-session-id': sessionId,
    })
    const endpoint = `${url.pathname === this.ssePath ? this.messagesPath : url.pathname}?sessionId=${encodeURIComponent(sessionId)}`
    response.write(`event: endpoint\ndata: ${endpoint}\n\n`)
    response.on('close', () => this.clients.delete(sessionId))
  }

  private async postMessage(url: URL, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const sessionId = url.searchParams.get('sessionId') ?? request.headers['mcp-session-id']
    const session = typeof sessionId === 'string' ? this.clients.get(sessionId) : undefined
    if (!session) {
      writeResponse(response, 404, JSON.stringify({ error: 'Unknown MCP session.' }))
      return
    }
    try {
      const body = await readBody(request, this.maxBodyBytes)
      const result = await this.server.handleJson(body)
      if (result !== undefined) session.write(`event: message\ndata: ${result}\n\n`)
      writeResponse(response, 202)
    } catch (error) {
      writeResponse(response, 400, JSON.stringify({ error: asErrorMessage(error).slice(0, 500) }))
    }
  }
}

export function createStdioTransport(server: McpServer, options: StdioTransportOptions = {}): StdioMcpTransport {
  return new StdioMcpTransport(server, options)
}

export function createStreamableHttpTransport(server: McpServer, options: HttpTransportOptions = {}): StreamableHttpMcpTransport {
  return new StreamableHttpMcpTransport(server, options)
}

export function createSseTransport(server: McpServer, options: SseTransportOptions = {}): SseMcpTransport {
  return new SseMcpTransport(server, options)
}

export const createStreamableHTTPTransport = createStreamableHttpTransport
export const createHttpTransport = createStreamableHttpTransport
export const createSSETransport = createSseTransport
export { StdioMcpTransport as StdioTransport, StreamableHttpMcpTransport as StreamableHTTPTransport, SseMcpTransport as SSETransport }
