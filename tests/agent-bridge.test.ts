import { describe, expect, it } from 'vitest'
import {
  AgentBridgeProtocolError,
  MAX_AGENT_BRIDGE_DEPTH,
  createAgentBridgeServer,
  isDelegationCycleBlocked,
  parseAgentBridgeLine,
  parseAgentBridgeTimeout,
  serializeAgentBridgeMessage,
  validateAgentBridgeRequest,
  validatePrompt,
  validateTarget,
} from '../src/main/agent-bridge'

describe('agent bridge protocol', () => {
  const credentials = { token: 'test-token', sessionId: 'session-1' }

  it('serializes and parses one newline-delimited request', () => {
    const line = serializeAgentBridgeMessage({ type: 'send', ...credentials, target: 'agy', prompt: 'hello' })

    expect(line.endsWith('\n')).toBe(true)
    expect(parseAgentBridgeLine(line)).toMatchObject({
      type: 'send',
      target: 'agy',
      prompt: 'hello',
      depth: 0,
      visited: [],
    })
  })

  it('validates each operation and normalizes timeout values', () => {
    expect(validateAgentBridgeRequest({ type: 'ping', ...credentials })).toMatchObject({ type: 'ping' })
    expect(validateAgentBridgeRequest({
      type: 'mcp-handshake',
      ...credentials,
      terminalId: 'terminal-1',
      launchId: 'launch-1',
      pid: 42,
    })).toMatchObject({ type: 'mcp-handshake', terminalId: 'terminal-1', launchId: 'launch-1', pid: 42 })
    expect(validateAgentBridgeRequest({ type: 'list', ...credentials })).toMatchObject({ type: 'list' })
    expect(validateAgentBridgeRequest({ type: 'wait', ...credentials, target: 'worker', timeoutMs: '5m' })).toMatchObject({
      type: 'wait',
      timeoutMs: 300000,
    })
    expect(validateAgentBridgeRequest({ type: 'ask', ...credentials, target: 'worker', prompt: 'do it' })).toMatchObject({
      type: 'ask',
    })
  })

  it('rejects malformed JSON, invalid target/prompt, and oversized messages', () => {
    expect(() => parseAgentBridgeLine('{bad}')).toThrowError(AgentBridgeProtocolError)
    expect(() => validateTarget('')).toThrowError(/Target/)
    expect(() => validatePrompt('   ')).toThrowError(/Prompt/)
    expect(validatePrompt('linha um\n\tlinha dois\r')).toBe('linha um\n\tlinha dois\r')
    expect(() => validatePrompt('texto\u0000invalido')).toThrowError(/Prompt/)
    expect(() => validatePrompt('texto\u001binvalido')).toThrowError(/Prompt/)
    expect(() => parseAgentBridgeLine('x'.repeat(65 * 1024))).toThrowError(/payload/i)
  })

  it('validates caller terminal and launch identity as a pair', () => {
    expect(validateAgentBridgeRequest({
      type: 'list',
      ...credentials,
      originTerminalId: 'coordinator',
      originLaunchId: 'launch-1',
    })).toMatchObject({ originTerminalId: 'coordinator', originLaunchId: 'launch-1' })
    expect(() => validateAgentBridgeRequest({
      type: 'list',
      ...credentials,
      originTerminalId: 'coordinator',
    })).toThrowError(/originTerminalId and originLaunchId/)
  })

  it('blocks cycles by visited targets and depth', () => {
    expect(isDelegationCycleBlocked('agy', { visited: ['agy'] })).toBe(true)
    expect(isDelegationCycleBlocked('agy', { depth: MAX_AGENT_BRIDGE_DEPTH })).toBe(true)
    expect(() => validateAgentBridgeRequest({
      type: 'send',
      ...credentials,
      target: 'agy',
      prompt: 'loop',
      visited: ['agy'],
    })).toThrowError(/cycle/i)
  })

  it('parses bounded timeout durations', () => {
    expect(parseAgentBridgeTimeout('5m')).toBe(300000)
    expect(parseAgentBridgeTimeout(1000)).toBe(1000)
    expect(() => parseAgentBridgeTimeout('0m')).toThrowError(/timeout/i)
    expect(() => parseAgentBridgeTimeout('2h')).toThrowError(/timeout/i)
  })

  it('bounds MCP handshake identity and process fields', () => {
    const base = { type: 'mcp-handshake', ...credentials, terminalId: 'terminal', launchId: 'launch', pid: 42 }
    expect(() => validateAgentBridgeRequest({ ...base, terminalId: '' })).toThrowError(/terminalId/)
    expect(() => validateAgentBridgeRequest({ ...base, launchId: 'l'.repeat(129) })).toThrowError(/launchId/)
    expect(() => validateAgentBridgeRequest({ ...base, pid: 0 })).toThrowError(/pid/)
    expect(() => validateAgentBridgeRequest({ ...base, pid: 2_147_483_648 })).toThrowError(/pid/)
    expect(() => validateAgentBridgeRequest({ ...base, pid: 1.5 })).toThrowError(/pid/)
  })
})

describe('agent bridge server configuration', () => {
  it('does not expose credentials in configuration errors', () => {
    expect(() => createAgentBridgeServer({
      pipeName: '',
      token: 'secret-token',
      sessionId: 'secret-session',
      handlers: {},
    })).toThrowError('Bridge pipe name is required.')
  })
})
