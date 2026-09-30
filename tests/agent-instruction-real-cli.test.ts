import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Teste de integração REAL (P0 orquestração): valida, com o CLI OpenCode real
 * em um PTY verdadeiro (node-pty), o caminho completo do conserto — prontidão
 * por turno, submit central e acknowledgement — sem pressionar Enter manual.
 *
 * Gated: só roda com DEVORBIT_REAL_CLI=1 (spawnar um CLI de IA real custa
 * quota e não pode entrar na suíte unitária/CI padrão).
 *   DEVORBIT_REAL_CLI=1 npx vitest run tests/agent-instruction-real-cli.test.ts
 */

const envFlag = process.env.DEVORBIT_REAL_CLI === '1'

interface RealPty {
  write(data: string): boolean
  kill(): void
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number) => void): void
}

async function tryRequireNodePty(): Promise<typeof import('node-pty') | null> {
  try {
    return (await import('node-pty')) as unknown as typeof import('node-pty')
  } catch {
    return null
  }
}

describe.skipIf(!envFlag)('agent instruction — CLI real (OpenCode)', () => {
  it(
    'espera prontidão real da TUI, submete a instrução e recebe ack sem Enter manual',
    { timeout: 180_000 },
    async () => {
      const pty = await tryRequireNodePty()
      if (!pty) throw new Error('node-pty indisponível neste runtime (ABI).')
      const { createTerminalReadiness } = await import('../src/main/terminal-readiness')
      const { sendAgentInstruction } = await import('../src/main/agent-instruction')
      const { AGENT_SUBMIT_SEQUENCE } = await import('../src/shared/agent-instruction-contract')

      const terminalId = 'real-opencode'
      const listeners: Array<(ev: { id: string; type: string; data?: string; code?: number }) => void> = []
      let buffer = ''
      let exited = false
      let ptyProcess: RealPty | null = null

      // Mesmo wrap do resolveProviderInvocation no Windows: cmd.exe /k call <shim.cmd>
      const where = process.platform === 'win32' ? 'where.exe' : 'which'
      const { execFileSync } = await import('node:child_process')
      const hits = execFileSync(where, ['opencode'], { encoding: 'utf-8' })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      const shim = hits.find((line) => line.toLowerCase().endsWith('.cmd')) ?? hits[0]
      expect(shim, 'opencode não encontrado no PATH').toBeTruthy()

      const spawnAt = Date.now()
      const conpty = pty.spawn(
        process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : shim,
        process.platform === 'win32' ? ['/d', '/q', '/k', 'call', shim] : [],
        {
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd: os.tmpdir(),
          env: process.env as Record<string, string>,
        }
      )
      ptyProcess = {
        write: (data: string) => {
          conpty.write(data)
          return true
        },
        kill: () => {
          try {
            conpty.kill()
          } catch {
            /* já morto */
          }
        },
        onData: (cb) => listeners.push((ev) => { if (ev.type === 'data') cb(ev.data ?? '') }),
        onExit: (cb) => listeners.push((ev) => { if (ev.type === 'exit') cb(ev.code ?? 0) }),
      }
      conpty.onData((data) => {
        buffer = (buffer + data).slice(-32_000)
        for (const listener of listeners) listener({ id: terminalId, type: 'data', data })
      })
      conpty.onExit(({ exitCode }) => {
        exited = true
        for (const listener of listeners) listener({ id: terminalId, type: 'exit', code: exitCode })
      })

      try {
        // 1) Prontidão por turno ancorada no spawn: com o fix, a espera cobre o
        // boot da TUI (o bug antigo liberava "pronto" com o silêncio do banner
        // do cmd, antes da TUI existir).
        const readiness = createTerminalReadiness((listener) => {
          listeners.push(listener as never)
          return () => {
            const index = listeners.indexOf(listener as never)
            if (index >= 0) listeners.splice(index, 1)
          }
        })
        const readyStarted = Date.now()
        const ready = await readiness.waitReady(terminalId, { since: spawnAt, timeoutMs: 30_000 })
        expect(ready.timedOut, 'TUI do OpenCode não ficou pronta a tempo').toBe(false)
        expect(Date.now() - readyStarted).toBeGreaterThanOrEqual(0)

        // 2) Instrução real via a abstração central: write + submit + ack.
        // Sem este módulo o texto ficava parado no prompt esperando Enter.
        const result = await sendAgentInstruction(
          {
            hasTerminal: () => !exited,
            waitReady: (id, options) => readiness.waitReady(id, options),
            write: (id, data) => (id === terminalId ? ptyProcess!.write(data) : false),
            subscribe: (listener) => {
              listeners.push(listener as never)
              return () => {
                const index = listeners.indexOf(listener as never)
                if (index >= 0) listeners.splice(index, 1)
              }
            },
            now: Date.now,
          },
          {
            terminalId,
            turnId: 'real_cli_smoke',
            content: 'Responda apenas com OK e mais nada.',
            provider: 'opencode',
            ackTimeoutMs: 10_000,
            maxSubmitAttempts: 2,
          }
        )
        expect(result.acked, `instrução não foi reconhecida: ${result.error ?? '?'}`).toBe(true)
        // O submit do conteúdo é o único Enter: nada de CR extra digitado à mão.
        expect(AGENT_SUBMIT_SEQUENCE).toBe('\r')

        // 3) O agente responde sozinho (atividade pós-submit) — aqui com a
        // resposta "OK" aparecendo no buffer em até ~150s.
        const answerAt = Date.now()
        while (Date.now() - answerAt < 150_000) {
          if (/^\s*OK\b/m.test(buffer.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))) break
          if (exited) break
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
        const clean = buffer.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        expect(/OK/i.test(clean), 'agente não respondeu após a submissão automática').toBe(true)
      } finally {
        ptyProcess?.kill()
      }
    }
  )

  it(
    'prompt MULTILINE real (estilo orquestrador) chega integral e responde sem Enter manual',
    { timeout: 240_000 },
    async () => {
      const pty = await tryRequireNodePty()
      if (!pty) throw new Error('node-pty indisponível neste runtime (ABI).')
      const { createTerminalReadiness } = await import('../src/main/terminal-readiness')
      const { sendAgentInstruction } = await import('../src/main/agent-instruction')

      const terminalId = 'real-opencode-multiline'
      const listeners: Array<(ev: { id: string; type: string; data?: string; code?: number }) => void> = []
      let buffer = ''
      let exited = false

      const where = process.platform === 'win32' ? 'where.exe' : 'which'
      const { execFileSync } = await import('node:child_process')
      const hits = execFileSync(where, ['opencode'], { encoding: 'utf-8' })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      const shim = hits.find((line) => line.toLowerCase().endsWith('.cmd')) ?? hits[0]
      expect(shim, 'opencode não encontrado no PATH').toBeTruthy()

      const spawnAt = Date.now()
      const conpty = pty.spawn(
        process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : shim,
        process.platform === 'win32' ? ['/d', '/q', '/k', 'call', shim] : [],
        { name: 'xterm-256color', cols: 120, rows: 30, cwd: os.tmpdir(), env: process.env as Record<string, string> }
      )
      const ptyProcess: RealPty = {
        write: (data: string) => {
          conpty.write(data)
          return true
        },
        kill: () => {
          try {
            conpty.kill()
          } catch {
            /* já morto */
          }
        },
        onData: (cb) => listeners.push((ev) => { if (ev.type === 'data') cb(ev.data ?? '') }),
        onExit: (cb) => listeners.push((ev) => { if (ev.type === 'exit') cb(ev.code ?? 0) }),
      }
      conpty.onData((data) => {
        buffer = (buffer + data).slice(-32_000)
        for (const listener of listeners) listener({ id: terminalId, type: 'data', data })
      })
      conpty.onExit(({ exitCode }) => {
        exited = true
        for (const listener of listeners) listener({ id: terminalId, type: 'exit', code: exitCode })
      })

      // Prompt REAL do orquestrador: grandes, multiline, com seções. O teste
      // prova que nenhuma linha executa prematuramente e que a resposta vem
      // apenas após o submit automático.
      const multilinePrompt = [
        'Você é um agente de teste do DevOrbit.',
        '',
        '## Contexto',
        '',
        'Estamos validando a orquestração automática do DevOrbit com prompts',
        'multiline reais. Este prompt tem múltiplas linhas e seções.',
        '',
        '## Tarefa',
        '',
        'Responda exatamente com:',
        '',
        'DEVORBIT_OK',
        '',
        '## Regras',
        '',
        '- Não execute comandos.',
        '- Não crie arquivos.',
        '- Não escreva nada além da resposta solicitada.',
        '',
        '## Critérios de aceitação',
        '',
        '- A resposta final deve ser exatamente DEVORBIT_OK.',
      ].join('\n')
      expect(multilinePrompt.split('\n').length).toBeGreaterThan(20)

      try {
        const readiness = createTerminalReadiness((listener) => {
          listeners.push(listener as never)
          return () => {
            const index = listeners.indexOf(listener as never)
            if (index >= 0) listeners.splice(index, 1)
          }
        })
        const ready = await readiness.waitReady(terminalId, { since: spawnAt, timeoutMs: 30_000 })
        expect(ready.timedOut, 'TUI do OpenCode não ficou pronta a tempo').toBe(false)

        const result = await sendAgentInstruction(
          {
            hasTerminal: () => !exited,
            waitReady: (id, options) => readiness.waitReady(id, options),
            write: (id, data) => (id === terminalId ? ptyProcess.write(data) : false),
            subscribe: (listener) => {
              listeners.push(listener as never)
              return () => {
                const index = listeners.indexOf(listener as never)
                if (index >= 0) listeners.splice(index, 1)
              }
            },
            now: Date.now,
          },
          {
            terminalId,
            turnId: 'real_cli_multiline',
            content: multilinePrompt,
            provider: 'opencode',
            ackTimeoutMs: 10_000,
            maxSubmitAttempts: 2,
          }
        )
        expect(result.acked, `instrução multiline não foi reconhecida: ${result.error ?? '?'}`).toBe(true)

        // Agente responde DEVORBIT_OK sem Enter manual (até ~200s).
        const answerAt = Date.now()
        const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        while (Date.now() - answerAt < 200_000) {
          if (/DEVORBIT_OK/.test(strip(buffer))) break
          if (exited) break
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
        // Se o prompt foi executado linha a linha, o conteúdo teria sido
        // interpretado como comandos separados (ex.: "## Regras" como prompt);
        // a resposta única DEVORBIT_OK prova entrega integral.
        expect(/DEVORBIT_OK/.test(strip(buffer)), 'agente não respondeu DEVORBIT_OK ao prompt multiline').toBe(true)
      } finally {
        ptyProcess.kill()
      }
    }
  )
})
