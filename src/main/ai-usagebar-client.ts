/**
 * Client do CLI ai-usagebar (v1.24.0 pinada) para o main do DevOrbit.
 *
 * - Invoca todos os comandos com `--config` explícito (nunca os defaults do
 *   usuário fora do userData). O `--config` é global e aceito em todos os subcommands.
 * - Subcommands nunca recebem `--cache-dir` (rejeitado por vendors/usage/detect/settings):
 *   o cache interno fica no default do upstream, sem override suportado nessa CLI.
 * - Comandos permitidos: `vendors --json`, `usage --json`, `detect [--all]
 *   --json` (explícito) e `settings enable <vendor>`. NUNCA `account switch`.
 * - Timeout por comando com kill, stdout/stderr limitados, `windowsHide`.
 * - Nenhum segredo em mensagens: erros passam por sanitize.
 */

import { spawn } from 'node:child_process'
import {
  AI_USAGEBAR_ERROR_MAX_CHARS,
  AI_USAGEBAR_MAX_STDERR_BYTES,
  AI_USAGEBAR_MAX_STDOUT_BYTES,
  buildAiUsagebarEnv,
  clampAiUsagebarTimeout,
  isSafeAiUsagebarVendorId,
  sanitizeAiUsagebarMessage,
} from './ai-usagebar-config'
import {
  AI_USAGEBAR_SUPPORTED_SCHEMA_VERSION,
  type AiUsagebarDetectReport,
  type AiUsagebarReport,
  type AiUsagebarVendorCatalog,
} from '../shared/ai-usagebar-contract'

export { AI_USAGEBAR_SUPPORTED_SCHEMA_VERSION }

export type AiUsagebarCommandKind = 'timeout' | 'overflow' | 'exit' | 'parse' | 'schema' | 'spawn'

export class AiUsagebarCommandError extends Error {
  readonly kind: AiUsagebarCommandKind
  constructor(kind: AiUsagebarCommandKind, message: string) {
    super(sanitizeAiUsagebarMessage(message))
    this.name = 'AiUsagebarCommandError'
    this.kind = kind
  }
}

export interface AiUsagebarCommandResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  stdoutOverflow: boolean
  stderrOverflow: boolean
}

export interface AiUsagebarCommandOptions {
  cwd?: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  maxStdoutBytes: number
  maxStderrBytes: number
}

export type AiUsagebarCommandRunner = (
  binaryPath: string,
  args: readonly string[],
  options: AiUsagebarCommandOptions
) => Promise<AiUsagebarCommandResult>

/** Runner real: spawn sem shell, output bounded, kill no timeout. */
export const defaultAiUsagebarRunner: AiUsagebarCommandRunner = (binaryPath, args, options) =>
  new Promise((resolve) => {
    const child = spawn(binaryPath, [...args], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let stdoutOverflow = false
    let stderrOverflow = false
    let timedOut = false
    let settled = false

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut, stdoutOverflow, stderrOverflow })
    }

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        // Já encerrado.
      }
    }, options.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutOverflow) return
      const remaining = options.maxStdoutBytes - Buffer.byteLength(stdout)
      if (remaining <= 0) {
        stdoutOverflow = true
        return
      }
      stdout += chunk.toString('utf8', 0, Math.min(chunk.length, remaining))
      if (Buffer.byteLength(stdout) >= options.maxStdoutBytes) stdoutOverflow = true
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrOverflow) return
      const remaining = options.maxStderrBytes - Buffer.byteLength(stderr)
      if (remaining <= 0) {
        stderrOverflow = true
        return
      }
      stderr += chunk.toString('utf8', 0, Math.min(chunk.length, remaining))
      if (Buffer.byteLength(stderr) >= options.maxStderrBytes) stderrOverflow = true
    })
    child.on('error', (error) => {
      stderr = stderr || error.message
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })

export interface AiUsagebarClientOptions {
  binaryPath: string
  configPath: string
  runner?: AiUsagebarCommandRunner
  timeoutMs?: number
  maxStdoutBytes?: number
  maxStderrBytes?: number
  /** Overlay de env por chamada (chaves de API); nunca é logado. */
  envOverlay?: () => NodeJS.ProcessEnv | undefined
  /**
   * Callback de integração por conta (Codex `codex_auth_path` etc.):
   * `configPath` vira o `--config` DESTE comando (um config por conta com suas
   * `[[openai.accounts]]`). NUNCA troca conta (`account switch` proibido) e o
   * client NUNCA passa `--account`: em `usage --json` o upstream ignora essa
   * flag e o relatório consolidado JÁ contém um entry por conta configurada.
   */
  accountConfig?: () =>
    | Promise<AiUsagebarAccountConfig | undefined>
    | AiUsagebarAccountConfig
    | undefined
}

export interface AiUsagebarAccountConfig {
  /** Config alternativo (path existente) para o comando, ex. por conta. */
  configPath?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export class AiUsagebarClient {
  private readonly binaryPath: string
  private readonly configPath: string
  private readonly runner: AiUsagebarCommandRunner
  private readonly timeoutMs: number
  private readonly maxStdoutBytes: number
  private readonly maxStderrBytes: number
  private readonly envOverlay: (() => NodeJS.ProcessEnv | undefined) | undefined
  private readonly accountConfig: AiUsagebarClientOptions['accountConfig']

  constructor(options: AiUsagebarClientOptions) {
    this.binaryPath = options.binaryPath
    this.configPath = options.configPath
    this.runner = options.runner ?? defaultAiUsagebarRunner
    // Teto duro: nunca deixa a UI esperar além de 10s por comando.
    this.timeoutMs = clampAiUsagebarTimeout(options.timeoutMs)
    this.maxStdoutBytes = options.maxStdoutBytes ?? AI_USAGEBAR_MAX_STDOUT_BYTES
    this.maxStderrBytes = options.maxStderrBytes ?? AI_USAGEBAR_MAX_STDERR_BYTES
    this.envOverlay = options.envOverlay
    this.accountConfig = options.accountConfig
  }

  get commandTimeoutMs(): number {
    return this.timeoutMs
  }

  /**
   * Args globais obrigatórios em TODA invocação: `--config` é aceito
   * globalmente antes ou depois de qualquer subcommand. Subcommands rejeitam
   * `--cache-dir`.
   */
  private baseArgs(configPath?: string): string[] {
    return ['--config', configPath ?? this.configPath]
  }

  /**
   * Config ATIVO do comando: o `configPath` do provider de conta quando
   * presente (path por conta), senão o config padrão. Vale para TODOS os
   * comandos (vendors/usage/detect/settings) para o catálogo lido/escrito
   * ser o mesmo que o `usage` consome.
   */
  private async activeConfigPath(): Promise<string | undefined> {
    const account = await this.resolveAccountConfig()
    return account?.configPath
  }

  private async invoke(args: readonly string[]): Promise<AiUsagebarCommandResult> {
    const env = buildAiUsagebarEnv(this.envOverlay?.())
    return await this.runner(this.binaryPath, [...args], {
      env,
      timeoutMs: this.timeoutMs,
      maxStdoutBytes: this.maxStdoutBytes,
      maxStderrBytes: this.maxStderrBytes,
    })
  }

  private assertSuccess(result: AiUsagebarCommandResult): void {
    if (result.timedOut) throw new AiUsagebarCommandError('timeout', 'ai-usagebar excedeu o timeout.')
    if (result.stdoutOverflow || result.stderrOverflow) {
      throw new AiUsagebarCommandError('overflow', 'Saída do ai-usagebar excedeu o limite.')
    }
    if (result.code !== 0) {
      throw new AiUsagebarCommandError(
        'exit',
        result.stderr || result.stdout || `ai-usagebar terminou com código ${result.code}.`
      )
    }
  }

  private runJson<T>(
    args: readonly string[],
    label: string,
    validate: (value: unknown) => value is T
  ): Promise<T> {
    return this.invoke(args).then((result) => {
      this.assertSuccess(result)
      let parsed: unknown
      try {
        parsed = JSON.parse(result.stdout.trim())
      } catch {
        throw new AiUsagebarCommandError('parse', `${label}: JSON inválido do ai-usagebar.`)
      }
      if (!validate(parsed)) {
        throw new AiUsagebarCommandError('schema', `${label}: formato inesperado do ai-usagebar.`)
      }
      return parsed
    })
  }

  /**
   * Como `runJson`, mas aceita exit ≠ 0 quando o stdout é um documento JSON
   * válido: `usage --json` reflete o PIOR entry no exit code e ainda entrega
   * os providers bons. Timeout/overflow/spawn/JSON vazio ou malformado
   * continuam falhando (stderr sanitizado).
   */
  private runJsonAllowingEntryErrors<T>(
    args: readonly string[],
    label: string,
    validate: (value: unknown) => value is T
  ): Promise<T> {
    return this.invoke(args).then((result) => {
      if (result.timedOut) throw new AiUsagebarCommandError('timeout', 'ai-usagebar excedeu o timeout.')
      if (result.stdoutOverflow || result.stderrOverflow) {
        throw new AiUsagebarCommandError('overflow', 'Saída do ai-usagebar excedeu o limite.')
      }
      const trimmed = result.stdout.trim()
      if (result.code === null) {
        throw new AiUsagebarCommandError(
          'spawn',
          result.stderr || result.stdout || 'ai-usagebar não pôde ser iniciado.'
        )
      }
      if (!trimmed) {
        throw new AiUsagebarCommandError(
          'exit',
          result.stderr || result.stdout || `ai-usagebar terminou com código ${result.code}.`
        )
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        if (result.code !== 0) {
          throw new AiUsagebarCommandError(
            'exit',
            result.stderr || 'ai-usagebar terminou com código não-zero sem JSON válido.'
          )
        }
        throw new AiUsagebarCommandError('parse', `${label}: JSON inválido do ai-usagebar.`)
      }
      if (!validate(parsed)) {
        if (result.code !== 0) {
          throw new AiUsagebarCommandError(
            'exit',
            result.stderr || 'ai-usagebar terminou com código não-zero sem o schema esperado.'
          )
        }
        throw new AiUsagebarCommandError('schema', `${label}: formato inesperado do ai-usagebar.`)
      }
      return parsed
    })
  }

  /** `--version` (checagem exata de versão fica no service). */
  async version(): Promise<string | undefined> {
    // Paths explícitos também aqui: nenhuma invocação usa defaults do usuário.
    const result = await this.invoke([...this.baseArgs(), '--version'])
    // Exit ≠ 0/overflow/timeout: nunca aceita a linha de versão do stdout.
    if (result.code !== 0 || result.timedOut || result.stdoutOverflow || result.stderrOverflow) {
      return undefined
    }
    const match = /^ai-usagebar\s+(\S+)\s*$/.exec(result.stdout.trim())
    return match?.[1]
  }

  /**
   * `vendors --json` — catálogo de provedores conhecidos pelo CLI.
   * Recebe `--config` explícito (interceptado globalmente); subcommands
   * não aceitam `--cache-dir`.
   */
  async vendors(): Promise<AiUsagebarVendorCatalog> {
    return await this.runJson<AiUsagebarVendorCatalog>(
      [...this.baseArgs(await this.activeConfigPath()), 'vendors', '--json'],
      'vendors',
      (value): value is AiUsagebarVendorCatalog => {
        const record = asRecord(value)
        return record !== undefined && Array.isArray(record.vendors)
      }
    )
  }

  /**
   * `usage --json` — relatório consolidado (schema v1). SEM `--account`:
   * o upstream ignora a flag aqui (widget-only) e já emite um entry por conta
   * (`<slug>@<label>`) das `[[...accounts]]` do config ativo.
   */
  async usage(): Promise<AiUsagebarReport> {
    const args = [...this.baseArgs(await this.activeConfigPath()), 'usage', '--json']
    return await this.runJsonAllowingEntryErrors<AiUsagebarReport>(args, 'usage', (value): value is AiUsagebarReport => {
      const record = asRecord(value)
      if (record === undefined) return false
      if (record.schema_version !== AI_USAGEBAR_SUPPORTED_SCHEMA_VERSION) return false
      return Array.isArray(record.entries)
    })
  }

  /** `detect --json` — SOMENTE quando o chamador pede (escreve no config). */
  async detect(options: { all?: boolean } = {}): Promise<AiUsagebarDetectReport> {
    const args = [...this.baseArgs(await this.activeConfigPath()), 'detect', '--json']
    if (options.all === true) args.push('--all')
    return await this.runJson<AiUsagebarDetectReport>(
      args,
      'detect',
      (value): value is AiUsagebarDetectReport => {
        const record = asRecord(value)
        return (
          record !== undefined &&
          Array.isArray(record.enabled) &&
          Array.isArray(record.known) &&
          typeof record.probed === 'number'
        )
      }
    )
  }

  /**
   * `settings enable <vendor>` — único caminho CLI de opt-in. O id é
   * repassado GENERICAMENTE (sem catálogo local); a forma é validada apenas
   * para não corromper argv.
   */
  async enableVendor(vendorId: string): Promise<void> {
    if (!isSafeAiUsagebarVendorId(vendorId)) {
      throw new AiUsagebarCommandError('schema', `id de vendor inválido: ${vendorId}`)
    }
    const result = await this.invoke([
      ...this.baseArgs(await this.activeConfigPath()),
      'settings',
      'enable',
      vendorId,
    ])
    this.assertSuccess(result)
  }

  private async resolveAccountConfig(): Promise<AiUsagebarAccountConfig | undefined> {
    if (!this.accountConfig) return undefined
    try {
      const value = await this.accountConfig()
      if (value === null || typeof value !== 'object') return undefined
      const configPath =
        typeof value.configPath === 'string' ? value.configPath.trim() : undefined
      return configPath ? { configPath } : undefined
    } catch {
      return undefined
    }
  }
}

export { sanitizeAiUsagebarMessage }
export { AI_USAGEBAR_ERROR_MAX_CHARS }
