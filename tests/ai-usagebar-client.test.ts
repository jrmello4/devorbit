import { describe, expect, it, vi } from 'vitest'
import {
  AiUsagebarClient,
  AiUsagebarCommandError,
  type AiUsagebarCommandOptions,
  type AiUsagebarCommandResult,
} from '../src/main/ai-usagebar-client'

const BINARY = 'C:\\userData\\ai-usagebar\\runtime\\ai-usagebar.exe'
const CONFIG = 'C:\\userData\\ai-usagebar\\config.toml'

interface RecordedCall {
  binaryPath: string
  args: string[]
  options: AiUsagebarCommandOptions
}

function fakeRunner(
  handler: (call: RecordedCall) => Partial<AiUsagebarCommandResult> | undefined
): { runner: (binaryPath: string, args: readonly string[], options: AiUsagebarCommandOptions) => Promise<AiUsagebarCommandResult>; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  return {
    calls,
    runner: async (binaryPath, args, options) => {
      const call: RecordedCall = { binaryPath, args: [...args], options }
      calls.push(call)
      const override = handler(call) ?? {}
      return {
        code: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        stdoutOverflow: false,
        stderrOverflow: false,
        ...override,
      }
    },
  }
}

function makeClient(
  handler: (call: RecordedCall) => Partial<AiUsagebarCommandResult> | undefined,
  options: { timeoutMs?: number; envOverlay?: () => NodeJS.ProcessEnv | undefined; accountConfig?: () => { label?: string; configPath?: string } | undefined } = {}
): { client: AiUsagebarClient; calls: RecordedCall[] } {
  const { runner, calls } = fakeRunner(handler)
  const client = new AiUsagebarClient({
    binaryPath: BINARY,
    configPath: CONFIG,
    runner,
    ...options,
  })
  return { client, calls }
}

function baseArgsOf(call: RecordedCall): string[] {
  return call.args.slice(0, 2)
}

describe('ai-usagebar client — invocação e paths explícitos', () => {
  it('TODA invocação carrega --config explícito e NUNCA passa --cache-dir', async () => {
    const { client, calls } = makeClient((call) => {
      if (call.args.includes('--version')) return { stdout: 'ai-usagebar 1.24.0\n' }
      if (call.args.includes('vendors')) return { stdout: JSON.stringify({ vendors: [] }) }
      if (call.args.includes('usage')) {
        return { stdout: JSON.stringify({ schema_version: 1, entries: [] }) }
      }
      if (call.args.includes('detect')) {
        return { stdout: JSON.stringify({ enabled: [], known: [], probed: 0 }) }
      }
      if (call.args.includes('settings')) return { stdout: '{"ok":true}' }
      return {}
    })

    await client.version()
    await client.vendors()
    await client.usage()
    await client.detect()
    await client.enableVendor('opencode-go')

    expect(calls).toHaveLength(5)
    for (const call of calls) {
      expect(call.binaryPath).toBe(BINARY)
      expect(baseArgsOf(call)).toEqual(['--config', CONFIG])
      expect(call.args).not.toContain('--cache-dir')
    }
    expect(calls[0].args).toEqual(['--config', CONFIG, '--version'])
    expect(calls[1].args).toEqual(['--config', CONFIG, 'vendors', '--json'])
    expect(calls[2].args).toEqual(['--config', CONFIG, 'usage', '--json'])
    expect(calls[3].args).toEqual(['--config', CONFIG, 'detect', '--json'])
    expect(calls[4].args).toEqual(['--config', CONFIG, 'settings', 'enable', 'opencode-go'])
  })

  it('vendors carrega --config isolado sem --cache-dir', async () => {
    const { client, calls } = makeClient(() => ({
      stdout: JSON.stringify({ vendors: [] }),
    }))
    await client.vendors()
    expect(calls).toHaveLength(1)
    expect(calls[0].binaryPath).toBe(BINARY)
    expect(calls[0].args).toEqual(['--config', CONFIG, 'vendors', '--json'])
    expect(calls[0].args).not.toContain('--cache-dir')
  })

  it('timeout é clampado ao teto duro de 10s', () => {
    expect(makeClient(() => undefined, { timeoutMs: 60_000 }).client.commandTimeoutMs).toBe(10_000)
    expect(makeClient(() => undefined, { timeoutMs: 5_000 }).client.commandTimeoutMs).toBe(5_000)
    expect(makeClient(() => undefined).client.commandTimeoutMs).toBe(10_000)
  })
})

describe('ai-usagebar client — parsing genérico e erros sanitizados', () => {
  it('vendors tolera campos extras e devolve o catálogo genérico', async () => {
    const { client } = makeClient(() => ({
      stdout: JSON.stringify({
        vendors: [{ id: 'future-vendor', name: 'Future', enabled: false, new_field: 42 }],
        extra: true,
      }),
    }))
    const catalog = await client.vendors()
    expect(catalog.vendors).toHaveLength(1)
    expect(catalog.vendors[0]).toMatchObject({ id: 'future-vendor', name: 'Future' })
  })

  it('usage aceita exit≠0 quando o documento schema v1 é válido (entries com erro preservadas)', async () => {
    const mixed = {
      schema_version: 1,
      primary: 'openai',
      entries: [
        { id: 'openai', name: 'Codex', status: 'error', error: 'rota de quota indisponível' },
        { id: 'anthropic', name: 'Claude', status: 'ready' },
      ],
    }
    const { client, calls } = makeClient(() => ({
      code: 1,
      stderr: 'pior entry: erro',
      stdout: JSON.stringify(mixed),
    }))
    await expect(client.usage()).resolves.toEqual(mixed)
    expect(calls[0].args.slice(2)).toEqual(['usage', '--json'])
  })

  it('usage com exit≠0 sem JSON válido continua falhando (exit, stderr sanitizado)', async () => {
    const empty = makeClient(() => ({ code: 1, stdout: '', stderr: 'falha OPENROUTER_API_KEY=sk-x12345678' }))
    const emptyError = await empty.client.usage().catch((value: unknown) => value)
    expect(emptyError).toBeInstanceOf(AiUsagebarCommandError)
    expect((emptyError as AiUsagebarCommandError).kind).toBe('exit')
    expect((emptyError as Error).message).not.toContain('sk-x12345678')
    expect((emptyError as Error).message).toContain('[redacted]')

    const malformed = makeClient(() => ({ code: 1, stdout: 'not-json', stderr: 'boom' }))
    await expect(malformed.client.usage()).rejects.toMatchObject({ kind: 'exit' })

    const wrongSchema = makeClient(() => ({
      code: 1,
      stdout: JSON.stringify({ schema_version: 2, entries: [] }),
    }))
    await expect(wrongSchema.client.usage()).rejects.toMatchObject({ kind: 'exit' })
  })

  it('version: exit≠0 nunca aceita a linha de versão do stdout', async () => {
    const failing = makeClient(() => ({ code: 1, stdout: 'ai-usagebar 1.24.0\n', stderr: 'boom' }))
    await expect(failing.client.version()).resolves.toBeUndefined()

    const ok = makeClient(() => ({ code: 0, stdout: 'ai-usagebar 1.24.0\n' }))
    await expect(ok.client.version()).resolves.toBe('1.24.0')
  })

  it('usage valida schema_version 1 e rejeita versão incompatível', async () => {
    const ok = makeClient(() => ({ stdout: JSON.stringify({ schema_version: 1, entries: [{ id: 'openai', name: 'Codex' }] }) }))
    await expect(ok.client.usage()).resolves.toMatchObject({ schema_version: 1 })

    const bad = makeClient(() => ({ stdout: JSON.stringify({ schema_version: 2, entries: [] }) }))
    await expect(bad.client.usage()).rejects.toMatchObject({ kind: 'schema' })
  })

  it('JSON inválido vira erro de parse e exit≠0 vira erro de exit', async () => {
    const broken = makeClient(() => ({ stdout: 'not-json' }))
    await expect(broken.client.vendors()).rejects.toMatchObject({ kind: 'parse' })

    const failing = makeClient(() => ({ code: 1, stderr: 'config malformado' }))
    await expect(failing.client.detect()).rejects.toMatchObject({ kind: 'exit' })
  })

  it('stderr com segredo é redigido na mensagem de erro', async () => {
    const { client } = makeClient(() => ({
      code: 1,
      stderr: 'falha ao ler OPENROUTER_API_KEY=sk-secret1234567890 para openrouter',
    }))
    const error = await client.usage().catch((value: unknown) => value)
    expect(error).toBeInstanceOf(AiUsagebarCommandError)
    const message = (error as Error).message
    expect(message).not.toContain('sk-secret1234567890')
    expect(message).toContain('[redacted]')
  })

  it('timeout e overflow têm kinds próprios', async () => {
    const timedOut = makeClient(() => ({ timedOut: true }))
    await expect(timedOut.client.usage()).rejects.toMatchObject({ kind: 'timeout' })

    const overflow = makeClient(() => ({ stdoutOverflow: true }))
    await expect(overflow.client.vendors()).rejects.toMatchObject({ kind: 'overflow' })
  })
})

describe('ai-usagebar client — detect, conta e env overlay', () => {
  it('detect só passa --all quando o chamador pede', async () => {
    const { client, calls } = makeClient(() => ({
      stdout: JSON.stringify({ enabled: [], known: [], probed: 0 }),
    }))
    await client.detect()
    await client.detect({ all: true })
    expect(calls[0].args).not.toContain('--all')
    expect(calls[1].args).toContain('--all')
  })

  it('accountConfig define o config ATIVO dos comandos de configuração e relatório; NUNCA passa --account nem troca conta', async () => {
    const altConfig = 'C:\\userData\\ai-usagebar\\accounts\\work.toml'
    const { client, calls } = makeClient(
      (call) => {
        if (call.args.includes('usage')) {
          return {
            stdout: JSON.stringify({
              schema_version: 1,
              entries: [
                { id: 'openai', name: 'Codex' },
                { id: 'openai@work', name: 'Codex (work)' },
              ],
            }),
          }
        }
        if (call.args.includes('vendors')) return { stdout: JSON.stringify({ vendors: [] }) }
        if (call.args.includes('detect')) return { stdout: JSON.stringify({ enabled: [], known: [], probed: 0 }) }
        return { stdout: '{"ok":true}' }
      },
      { accountConfig: () => ({ configPath: altConfig }) }
    )
    const report = await client.usage()
    await client.vendors()
    await client.detect()
    await client.enableVendor('openai')

    // Relatório consolidado preserva as contas distintas como entries.
    expect(report.entries.map((entry) => entry.id)).toEqual(['openai', 'openai@work'])
    for (const call of calls) {
      expect(baseArgsOf(call)).toEqual(['--config', altConfig])
      expect(call.args).not.toContain('--cache-dir')
      expect(call.args).not.toContain('--account')
      expect(call.args.join(' ')).not.toContain('switch')
    }
  })

  it('enableVendor repassa o id genericamente e rejeita id inseguro sem spawnar', async () => {
    const { client, calls } = makeClient(() => ({ stdout: '{"ok":true}' }))
    await client.enableVendor('future-vendor-2')
    expect(calls[0].args.slice(2)).toEqual(['settings', 'enable', 'future-vendor-2'])

    await expect(client.enableVendor('bad id; rm -rf')).rejects.toMatchObject({ kind: 'schema' })
    expect(calls).toHaveLength(1)
  })

  it('env overlay chega ao runner e não muta process.env', async () => {
    const previous = process.env.OPENROUTER_API_KEY
    const { client, calls } = makeClient(() => ({
      stdout: JSON.stringify({ schema_version: 1, entries: [] }),
    }), { envOverlay: () => ({ OPENROUTER_API_KEY: 'sk-overlay-secret' }) })

    await client.usage()
    expect(calls[0].options.env.OPENROUTER_API_KEY).toBe('sk-overlay-secret')
    expect(process.env.OPENROUTER_API_KEY).toBe(previous)
  })
})
