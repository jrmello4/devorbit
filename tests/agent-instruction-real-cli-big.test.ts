/* eslint-disable no-control-regex -- o alvo das regex abaixo É o caractere ESC (escape ANSI) */
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { stripAnsiEscapes } from '../src/shared/ansi'

/**
 * Teste de integração REAL (I4 — teto de 64k): valida, com o CLI OpenCode real
 * em um PTY verdadeiro (node-pty), que um prompt GRANDE (~60 mil caracteres)
 * chega INTEIRO ao agente. A prova é a instrução final NO FIM do payload: se a
 * cauda do bloco se perder no caminho de escrita (bug I2/I4), o agente nunca
 * recebe a tarefa e DEVORBIT_OK nunca aparece.
 *
 * Mesmo padrão do tests/agent-instruction-real-cli.test.ts (setup copiado;
 * aquele arquivo não é editado). Diferenças deliberadas:
 *   - a escrita do conteúdo é fatiada em chunks de 16.000 chars, espelhando a
 *     `writeTerminal` de produção (src/main/terminal-session.ts);
 *   - `isBracketedPasteEnabled` é o observador real de DECSET 2004
 *     (src/main/terminal-paste-mode.ts), como no terminal-ipc de produção —
 *     o bloco grande vai embrulhado em ESC[200~ … ESC[201~.
 *
 * Gated: só roda com DEVORBIT_REAL_CLI=1 (spawnar um CLI de IA real custa
 * quota e não pode entrar na suíte unitária/CI padrão).
 *   DEVORBIT_REAL_CLI=1 npx vitest run tests/agent-instruction-real-cli-big.test.ts
 */

interface RealPty {
  write(data: string): boolean
  kill(): void
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number) => void): void
}

/** Mesma fatia da writeTerminal de produção (CHUNK = 16_000). */
const WRITE_CHUNK = 16_000

/** Prompt de massa ~60k: seções Markdown repetidas + instrução final NA CAUDA. */
function buildBigPrompt(): string {
  const header = [
    'Você é um agente de teste do DevOrbit.',
    '',
    'Este prompt é deliberadamente grande (~60 mil caracteres) para validar o',
    'caminho de escrita de payloads grandes (teto de 64k). Tudo aqui é contexto',
    'de massa: não execute comandos e não crie arquivos. A única tarefa está no',
    'FIM deste documento.',
    '',
  ].join('\n')
  const filler =
    'Parágrafo de massa para a validação I4 do DevOrbit: este texto existe apenas para ocupar espaço de forma realista e não requer nenhuma ação do agente.'
  const parts: string[] = [`${header}\n`]
  let length = parts[0].length
  let section = 1
  while (length < 59_800) {
    const block = `## Contexto ${section}\n\n${filler}\n\nBloco ${section} de massa de teste. Continue lendo; a instrução final está no fim do documento.\n\n`
    parts.push(block)
    length += block.length
    section += 1
  }
  // Prova de cauda: a ÚNICA instrução de tarefa é o último trecho do prompt.
  parts.push('## Tarefa final\n\nResponda exatamente: DEVORBIT_OK\n')
  return parts.join('')
}

async function tryRequireNodePty(): Promise<typeof import('node-pty') | null> {
  try {
    return (await import('node-pty')) as unknown as typeof import('node-pty')
  } catch {
    return null
  }
}

const PASTE_ENABLE_SEQUENCE = new RegExp('\\x1b\\[\\?2004h')

/**
 * Boot com RETRY: a TUI do OpenCode tem corrida de plugins — boots "zumbis"
 * (sem anúncio ESC[?2004h) engolem input silenciosamente (evidência PTY
 * 2026-09-30). Espelha a produção: só interage com TUI viva; boot morto
 * → mata e respawna. (Mesmo helper do tests/agent-instruction-real-cli.test.ts;
 * testes autoss contidos é o padrão do repo.)
 */
async function spawnInteractiveOpenCode(
  pty: typeof import('node-pty'),
  shim: string,
  hooks: { onData: (d: string) => void; onExit: (code: number) => void },
): Promise<{ write: (d: string) => boolean; spawnAt: number; kill: () => void }> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let bootBuffer = ''
    const spawnAt = Date.now()
    const conpty = pty.spawn(
      process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : shim,
      process.platform === 'win32' ? ['/d', '/q', '/k', 'call', shim] : [],
      { name: 'xterm-256color', cols: 120, rows: 30, cwd: os.tmpdir(), env: process.env as Record<string, string> }
    )
    conpty.onData((d) => {
      bootBuffer = (bootBuffer + d).slice(-200_000)
      hooks.onData(d)
    })
    conpty.onExit(({ exitCode }) => hooks.onExit(exitCode))
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (PASTE_ENABLE_SEQUENCE.test(bootBuffer)) {
        return {
          write: (d: string) => {
            conpty.write(d)
            return true
          },
          spawnAt,
          kill: () => {
            try { conpty.kill() } catch { /* já morto */ }
          },
        }
      }
      await sleep(250)
    }
    try { conpty.kill() } catch { /* já morto */ }
    await sleep(1_000)
  }
  throw new Error('OpenCode não anunciou bracketed paste em 3 boots (TUI zumbi)')
}

const REAL_TUI_BOOT_CALM_MS = 8_500 // TUI do OpenCode carrega plugins por ~8s; instruções antes disso são engolidas silenciosamente (evidência: diagnóstico PTY 2026-09-30)
describe.skipIf(process.env.DEVORBIT_REAL_CLI !== '1')('agent instruction — CLI real, prompt ~60k (I4)', () => {
  it(
    'prompt de ~60 mil caracteres chega inteiro: a instrução final (cauda) é executada e responde DEVORBIT_OK',
    { timeout: 420_000 },
    async () => {
      const prompt = buildBigPrompt()
      // Sanidade da massa de teste: ~60k, muitas seções e a tarefa no fim.
      expect(prompt.length).toBeGreaterThanOrEqual(58_000)
      expect(prompt.length).toBeLessThanOrEqual(62_000)
      expect(prompt.split('\n').length).toBeGreaterThan(200)
      expect(prompt.trimEnd().endsWith('Responda exatamente: DEVORBIT_OK')).toBe(true)

      const pty = await tryRequireNodePty()
      if (!pty) throw new Error('node-pty indisponível neste runtime (ABI).')
      const { createTerminalReadiness } = await import('../src/main/terminal-readiness')
      const { sendAgentInstruction } = await import('../src/main/agent-instruction')
      const { createTerminalPasteMode } = await import('../src/main/terminal-paste-mode')

      const terminalId = 'real-opencode-big'
      const listeners: Array<(ev: { id: string; type: string; data?: string; code?: number }) => void> = []
      let buffer = ''
      let exited = false

      const subscribeBus = (
        listener: (ev: { id: string; type: string; data?: string; code?: number }) => void
      ): (() => void) => {
        listeners.push(listener)
        return () => {
          const index = listeners.indexOf(listener)
          if (index >= 0) listeners.splice(index, 1)
        }
      }

      // Mesmo wrap do resolveProviderInvocation no Windows: cmd.exe /k call <shim.cmd>
      const where = process.platform === 'win32' ? 'where.exe' : 'which'
      const { execFileSync } = await import('node:child_process')
      const hits = execFileSync(where, ['opencode'], { encoding: 'utf-8' })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      const shim = hits.find((line) => line.toLowerCase().endsWith('.cmd')) ?? hits[0]
      expect(shim, 'opencode não encontrado no PATH').toBeTruthy()

      // Capability REAL de bracketed paste sobre o mesmo barramento (como no
      // terminal-ipc de produção): com a TUI anunciando ESC[?2004h, o bloco de
      // ~60k vai embrulhado ESC[200~ … ESC[201~ em vez de verbatim. Criada
      // ANTES do primeiro spawn e NÃO recriada no retry: precisa capturar o
      // anúncio 2004h do boot vencedor.
      const pasteMode = createTerminalPasteMode(subscribeBus as never, (id) => id === terminalId)

      // Boot com RETRY: boots zumbis (sem 2004h) engolem input — o helper mata
      // e respawna; o barramento abaixo alimenta os observers com a TUI vencedora.
      const boot = await spawnInteractiveOpenCode(pty, shim, {
        onData: (data) => {
          buffer = (buffer + data).slice(-1_500_000)
          for (const listener of listeners) listener({ id: terminalId, type: 'data', data })
        },
        onExit: (code) => {
          exited = true
          for (const listener of listeners) listener({ id: terminalId, type: 'exit', code })
        },
      })
      // Exits anteriores eram boots zumbis mortos pelo helper; a TUI vencedora
      // está viva — realinha o flag de saída para o turno.
      exited = false
      const spawnAt = boot.spawnAt
      const ptyProcess: RealPty = {
        write: boot.write,
        kill: boot.kill,
        onData: (cb) => listeners.push((ev) => { if (ev.type === 'data') cb(ev.data ?? '') }),
        onExit: (cb) => listeners.push((ev) => { if (ev.type === 'exit') cb(ev.code ?? 0) }),
      }

      try {
        // 1) Prontidão por turno ancorada no spawn (mesmo contrato do teste
        // original: readiness cobre o boot da TUI, não o silêncio do cmd).
        const readiness = createTerminalReadiness(subscribeBus as never)
        const ready = await readiness.waitReady(terminalId, { since: spawnAt + 30_000, timeoutMs: 30_000 })
        expect(ready.timedOut, 'TUI do OpenCode não ficou pronta a tempo').toBe(false)

        // 2) Instrução real via a abstração central: paste grande fatiado +
        // submit central + ack, sem Enter manual.
        const result = await sendAgentInstruction(
          {
            hasTerminal: () => !exited,
            waitReady: (id, options) => readiness.waitReady(id, options),
            // Mesma estratégia da writeTerminal de produção: payload grande é
            // fatiado em chunks de 16.000 chars antes de atingir o conpty.
            write: (id, data) => {
              if (id !== terminalId) return false
              for (let offset = 0; offset < data.length; offset += WRITE_CHUNK) {
                ptyProcess.write(data.slice(offset, offset + WRITE_CHUNK))
              }
              return true
            },
            subscribe: (listener) => {
              listeners.push(listener as never)
              return () => {
                const index = listeners.indexOf(listener as never)
                if (index >= 0) listeners.splice(index, 1)
              }
            },
            isBracketedPasteEnabled: (id) => pasteMode.isBracketedPasteEnabled(id),
            now: Date.now,
          },
          {
            terminalId,
            turnId: 'real_cli_big_prompt',
            content: prompt,
            provider: 'opencode',
            ackTimeoutMs: 15_000,
            maxSubmitAttempts: 2,
          }
        )
        expect(result.acked, `instrução de ~60k não foi reconhecida: ${result.error ?? '?'}`).toBe(true)

        // 3) O agente responde sozinho (janela de 300s). A resposta prova que a
        // CAUDA do prompt chegou: a única instrução de tarefa está no FIM.
        // A opentui renderiza sem newlines (run de células): assert line-anchored
        // nunca casa. Prova de CAUDA executada: o eco do prompt contém o token
        // UMA vez ('Responda exatamente: DEVORBIT_OK'); a resposta do modelo
        // adiciona a SEGUNDA ocorrência.
        const answerAt = Date.now()
        const occurrences = () => (stripAnsiEscapes(buffer).match(new RegExp('DEVORBIT_OK', 'g')) || []).length
        while (Date.now() - answerAt < 300_000) {
          if (occurrences() >= 2) break
          if (exited) break
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
        if (occurrences() < 2) {
          // Diagnóstico: cauda limpa do que a TUI mostrou (última tela).
          const tail = stripAnsiEscapes(buffer).split(/\r?\n/).filter(Boolean).slice(-25).join(' | ')
          throw new Error(`agente não respondeu DEVORBIT_OK ao prompt de ~60k (ocorrências: ${occurrences()}); tela final: ${tail.slice(0, 1500)}`)
        }
      } finally {
        ptyProcess.kill()
      }
    }
  )
})
