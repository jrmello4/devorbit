import { randomBytes } from 'node:crypto'
import type { Server } from 'node:net'
import {
  createAgentBridgeServer,
  type AgentBridgeHandlers,
} from './agent-bridge'
import {
  transitionAgentBridgeEvent,
  type AgentBridgeEvent,
  type AgentBridgeEventResult,
  type AgentBridgeEventStatus,
  type AgentBridgeTerminalStatus,
} from '../shared/agent-bridge-event'

export interface AgentBridgeRuntimeOptions {
  handlers: AgentBridgeHandlers
  cliDirectory: string
  onEvent?: (event: AgentBridgeEvent) => void
}

export interface AgentBridgeRuntime {
  readonly pipeName: string
  readonly token: string
  readonly sessionId: string
  env: () => NodeJS.ProcessEnv
  start: () => Server
  stop: () => void
}

export function createAgentBridgeRuntime(options: AgentBridgeRuntimeOptions): AgentBridgeRuntime {
  const sessionId = randomBytes(12).toString('hex')
  const token = randomBytes(32).toString('hex')
  const pipeName = process.platform === 'win32'
    ? `\\\\.\\pipe\\devorbit-${process.pid}-${sessionId}`
    : `/tmp/devorbit-${process.pid}-${sessionId}.sock`
  let server: Server | undefined
  let requestSequence = 0

  const emitEvent = (event: AgentBridgeEvent): void => {
    try {
      options.onEvent?.(event)
    } catch {
      // Telemetry must never break a bridge request.
    }
  }

  const normalizeEventId = (value: string | undefined, fallback: string): string => {
    const normalized = (value || fallback)
      .replace(/[^A-Za-z0-9._-]/gu, '-')
      .replace(/^[^A-Za-z0-9]+/u, '')
    return normalized.slice(0, 80) || fallback
  }

  const sanitizeEventText = (value: string): string => {
    let sanitized = ''
    for (const character of value) {
      const code = character.charCodeAt(0)
      sanitized += code <= 0x1f || code === 0x7f ? ' ' : character
    }
    return sanitized.trim().slice(0, 500)
  }

  const requestIdFor = (request: { id?: string }): string => normalizeEventId(
    request.id,
    `bridge-${Date.now().toString(36)}-${(++requestSequence).toString(36)}`,
  )

  const eventTargetFor = (request: { target?: string }): string => {
    const target = normalizeEventId(request.target, 'bridge-target')
    return target === 'devorbit' ? 'bridge-target' : target
  }

  const eventSummaryFor = (result: unknown): string | undefined => {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined
    const summary = (result as { summary?: unknown }).summary
    if (typeof summary !== 'string' || !summary.trim()) return undefined
    const sanitized = sanitizeEventText(summary)
    return sanitized || undefined
  }

  const eventStatusFor = (result: unknown): AgentBridgeEventStatus => {
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const status = (result as { status?: unknown }).status
      if (status === 'blocked' || status === 'failed' || status === 'completed') return status
    }
    return 'completed'
  }

  const eventDestinationFor = (result: unknown, request: { target?: string }): string => {
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const destination = (result as { destination?: unknown }).destination
      if (typeof destination === 'string' && destination.trim()) {
        const normalized = normalizeEventId(destination, 'bridge-target')
        return normalized === 'devorbit' ? 'bridge-target' : normalized
      }
    }
    return eventTargetFor(request)
  }

  const eventArtifactsFor = (result: unknown): string[] | undefined => {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined
    const raw = (result as { artifacts?: unknown }).artifacts
    if (!Array.isArray(raw)) return undefined
    const artifacts = raw
      .filter((item): item is string => typeof item === 'string')
      .map((item) => sanitizeEventText(item).slice(0, 240))
      .filter(Boolean)
      .slice(0, 16)
    return artifacts.length > 0 ? artifacts : undefined
  }

  const eventResultFor = (result: unknown, status: AgentBridgeEventStatus): AgentBridgeEventResult | undefined => {
    if (status === 'pending') return undefined
    const summary = eventSummaryFor(result)
    const artifacts = eventArtifactsFor(result)
    return {
      outcome: status as AgentBridgeTerminalStatus,
      ...(summary !== undefined ? { summary } : {}),
      ...(artifacts !== undefined ? { artifacts } : {}),
    }
  }

  const handlers: AgentBridgeHandlers = { ...options.handlers }
  for (const type of ['send', 'wait', 'ask', 'run'] as const) {
    const handler = options.handlers[type]
    if (!handler) continue
    handlers[type] = async (request, context) => {
      const requestId = requestIdFor(request)
      const destination = eventTargetFor(request)
      const requestedOrigin = normalizeEventId(request.origin, 'devorbit')
      // O contrato de evento proíbe origem == destino; um self-delegate cai
      // para um rótulo neutro em vez de invalidar o evento.
      const source = requestedOrigin === destination ? 'bridge-origin' : requestedOrigin
      const depth = typeof request.depth === 'number' ? request.depth : 0
      const createdAt = Date.now()
      const pending: AgentBridgeEvent = {
        requestId,
        source,
        target: destination,
        origin: source,
        destination,
        depth,
        status: 'pending',
        createdAt,
      }
      emitEvent(pending)
      try {
        const result = await handler(request as never, context)
        const status = eventStatusFor(result)
        const resolvedDestination = eventDestinationFor(result, request)
        const eventResult = eventResultFor(result, status)
        emitEvent(transitionAgentBridgeEvent(pending, {
          status,
          summary: eventSummaryFor(result),
          destination: resolvedDestination,
          ...(eventResult !== undefined ? { result: eventResult } : {}),
          updatedAt: Date.now(),
        }))
        return result
      } catch (error) {
        const summary = error instanceof Error && error.message.trim()
          ? sanitizeEventText(error.message)
          : 'A delegação falhou.'
        emitEvent(transitionAgentBridgeEvent(pending, {
          status: 'failed',
          summary,
          destination,
          result: { outcome: 'failed', summary },
          updatedAt: Date.now(),
        }))
        throw error
      }
    }
  }

  return {
    pipeName,
    token,
    sessionId,
    env: () => ({
      DEVORBIT_BRIDGE_PIPE: pipeName,
      DEVORBIT_BRIDGE_TOKEN: token,
      DEVORBIT_SESSION_ID: sessionId,
      PATH: [options.cliDirectory, process.env.PATH || ''].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
    }),
    start: () => {
      if (server) return server
      server = createAgentBridgeServer({ pipeName, token, sessionId, handlers })
      return server
    },
    stop: () => {
      if (!server) return
      server.close()
      server = undefined
    },
  }
}
