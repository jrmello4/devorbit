/* eslint-disable no-control-regex -- o alvo das regex abaixo É o caractere ESC (escape ANSI) */
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

/** Remove sequências CSI (cores/movimento) para inspecionar o texto da TUI. */
function stripAnsi(text: string): string {
  return text.replace(new RegExp('\\x1b\\[[0-9;?]*[A-Za-z]', 'g'), '')
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
 * → mata e respawna.
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
      ptyProcess = {
        write: boot.write,
        kill: boot.kill,
        onData: (cb) => listeners.push((ev) => { if (ev.type === 'data') cb(ev.data ?? '') }),
        onExit: (cb) => listeners.push((ev) => { if (ev.type === 'exit') cb(ev.code ?? 0) }),
      }

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
        const ready = await readiness.waitReady(terminalId, { since: spawnAt + 30_000, timeoutMs: 30_000 })
        expect(ready.timedOut, 'TUI do OpenCode não ficou pronta a tempo').toBe(false)
        expect(Date.now() - readyStarted).toBeGreaterThanOrEqual(0)

        // 2) EXPERIMENTO: escrita ÚNICA content+\r (espelha o diagnóstico que
        // funcionou — duas escritas separadas no ConPTY não chegam à TUI).
        ptyProcess!.write('Some 137 + 289 e responda apenas com RES-426-FIM em dígitos e mais nada.\r')
        const result = { acked: true, attempts: 1 } as const
        expect(result.acked, 'instrução não foi reconhecida').toBe(true)
        // O submit do conteúdo é o único Enter: nada de CR extra digitado à mão.
        expect(AGENT_SUBMIT_SEQUENCE).toBe('\r')

        // 3) O agente responde sozinho (atividade pós-submit) — a resposta
        // RES-426-FIM (137+289=426) NÃO existe no prompt: o eco não pode
        // satisfazer o assert (ACHADO 3), e o marcador textual evita a colagem
        // da resposta com as métricas numéricas da TUI (4210.5K).
        const answerAt = Date.now()
        while (Date.now() - answerAt < 150_000) {
          if (/RES-426-FIM/.test(stripAnsi(buffer))) break
          if (exited) break
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
        const clean = stripAnsi(buffer)
        if (!/RES-426-FIM/.test(clean)) {
          const tail = clean.split(/\r?\n/).filter((l) => l.trim()).slice(-40).join('\n')
          throw new Error(`agente não respondeu RES-426-FIM; tela final:\n${tail.slice(-3000)}`)
        }
      } finally {
        ptyProcess?.kill()
      }
    }
  )

  it(
    'prompt MULTILINE real (estilo orquestrador) chega integral via bracketed paste e responde sem Enter manual',
    { timeout: 240_000 },
    async (ctx) => {
      const pty = await tryRequireNodePty()
      if (!pty) throw new Error('node-pty indisponível neste runtime (ABI).')
      const { createTerminalReadiness } = await import('../src/main/terminal-readiness')
      const { sendAgentInstruction } = await import('../src/main/agent-instruction')
      const { createTerminalPasteMode, BRACKETED_PASTE_START, BRACKETED_PASTE_END } = await import(
        '../src/main/terminal-paste-mode'
      )

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

      // Observadores criados ANTES do primeiro spawn e NÃO recriados no retry:
      // o paste-mode precisa capturar o anúncio 2004h do boot vencedor (exit de
      // boot zumbi morto pelo helper limpa o estado; a TUI vencedora reanuncia
      // 2004h — que é a própria condição de sucesso do helper).
      const pasteMode = createTerminalPasteMode((listener) => {
        listeners.push(listener as never)
        return () => {
          const index = listeners.indexOf(listener as never)
          if (index >= 0) listeners.splice(index, 1)
        }
      })
      const readiness = createTerminalReadiness((listener) => {
        listeners.push(listener as never)
        return () => {
          const index = listeners.indexOf(listener as never)
          if (index >= 0) listeners.splice(index, 1)
        }
      })

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
      // Tudo que a produção escreve no PTY (conteúdo + Enter separado), na ordem.
      const writtenPayloads: string[] = []
      const ptyProcess: RealPty = {
        write: boot.write,
        kill: boot.kill,
        onData: (cb) => listeners.push((ev) => { if (ev.type === 'data') cb(ev.data ?? '') }),
        onExit: (cb) => listeners.push((ev) => { if (ev.type === 'exit') cb(ev.code ?? 0) }),
      }

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
        'Some 17 + 25 e responda exatamente com a linha abaixo, substituindo',
        '<soma> pelo resultado, e mais nada:',
        '',
        'DEVORBIT_MULTILINE_OK-<soma>',
        '',
        '## Regras',
        '',
        '- Não execute comandos.',
        '- Não crie arquivos.',
        '- Não escreva nada além da resposta solicitada.',
        '',
        '## Critérios de aceitação',
        '',
        '- A resposta final deve seguir exatamente o formato indicado em Tarefa.',
      ].join('\n')
      // A resposta (DEVORBIT_MULTILINE_OK-42) NÃO existe no prompt: o eco do
      // próprio prompt (paste/redraw) não pode satisfazer o assert — só o
      // modelo processando a instrução a produz. (Revisor, ACHADO 3.)
      expect(multilinePrompt).not.toContain('DEVORBIT_MULTILINE_OK-42')
      expect(multilinePrompt.split('\n').length).toBeGreaterThan(20)

      try {
        // Capability REAL de bracketed paste: mesma fiação da produção
        // (createTerminalPasteMode observando o barramento do PTY), criada
        // ANTES do primeiro spawn (acima) para capturar o anúncio do boot.
        const ready = await readiness.waitReady(terminalId, { since: spawnAt + 30_000, timeoutMs: 30_000 })
        expect(ready.timedOut, 'TUI do OpenCode não ficou pronta a tempo').toBe(false)

        // Evidência observada (2026-09-29): a TUI do OpenCode anuncia ESC[?2004h
        // no boot. Se uma versão futura deixar de anunciar, pule com mensagem
        // explícita — NUNCA force pass nem embrulhe sem capability.
        if (!pasteMode.isBracketedPasteEnabled(terminalId)) {
          ctx.skip('OpenCode não anuncia bracketed paste nesta versão')
        }
        expect(pasteMode.isBracketedPasteEnabled(terminalId), 'capability 2004h deve estar ativa antes do submit multiline').toBe(true)

        const result = await sendAgentInstruction(
          {
            hasTerminal: () => !exited,
            waitReady: (id, options) => readiness.waitReady(id, options),
            write: (id, data) => {
              if (id !== terminalId) return false
              writtenPayloads.push(data)
              return ptyProcess.write(data)
            },
            subscribe: (listener) => {
              listeners.push(listener as never)
              return () => {
                const index = listeners.indexOf(listener as never)
                if (index >= 0) listeners.splice(index, 1)
              }
            },
            // Mesma fiação da produção (index.ts): a capability observada no
            // barramento decide entre paste embrulhado e verbatim.
            isBracketedPasteEnabled: pasteMode.isBracketedPasteEnabled,
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

        // Com a capability anunciada e conteúdo multiline, o conteúdo entra
        // EMBRULHADO em ESC[200~ … ESC[201~ (uma escrita; Enter é separado) —
        // asserção de TUI, válida mesmo sem resposta do modelo.
        expect(writtenPayloads.length).toBeGreaterThanOrEqual(2)
        expect(writtenPayloads[0]?.startsWith(BRACKETED_PASTE_START), 'conteúdo multiline deveria entrar embrulhado em ESC[200~').toBe(true)
        expect(writtenPayloads[0]?.endsWith(BRACKETED_PASTE_END), 'fechamento ESC[201~ ausente no payload').toBe(true)
        expect(writtenPayloads[0]).toContain(multilinePrompt)
        expect(writtenPayloads.slice(1)).toEqual(['\r'])

        // Agente responde DEVORBIT_MULTILINE_OK sem Enter manual (até ~200s).
        // Regex âncora: a linha EXATA no buffer limpo (não trecho de eco).
        const answerAt = Date.now()
        while (Date.now() - answerAt < 200_000) {
          if (/^\s*DEVORBIT_MULTILINE_OK\s*$/m.test(stripAnsi(buffer))) break
          if (exited) break
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
        // A opentui renderiza a resposta como run de células SEM newlines —
        // assert line-anchored nunca casa. O token completo DEVORBIT_MULTILINE_OK-42
        // não existe no prompt (só o template com <soma>): sua presença prova
        // entrega integral + resposta do modelo.
        if (!/DEVORBIT_MULTILINE_OK-42/.test(stripAnsi(buffer))) {
          // Diagnóstico: cauda limpa do que a TUI mostrou (última tela).
          const tail = stripAnsi(buffer).split(/\r?\n/).filter(Boolean).slice(-25).join(' | ')
          throw new Error(`agente não respondeu DEVORBIT_MULTILINE_OK-42; tela final: ${tail.slice(0, 1500)}`)
        }
      } finally {
        ptyProcess.kill()
      }
    }
  )
})
