const os = require('node:os')
const { execFileSync } = require('node:child_process')

async function main() {
  const pty = require('node-pty')
  const hits = execFileSync('where.exe', ['opencode'], { encoding: 'utf-8' })
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const shim = hits.find((l) => l.toLowerCase().endsWith('.cmd')) ?? hits[0]
  let buffer = ''
  let exited = false
  const conpty = pty.spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/q', '/k', 'call', shim], {
    name: 'xterm-256color', cols: 120, rows: 30, cwd: os.tmpdir(), env: process.env,
  })
  conpty.onData((d) => { buffer = (buffer + d).slice(-120_000) })
  conpty.onExit(() => { exited = true })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  await sleep(30_000) // boot da TUI + folga total (experimento T+30s)
  conpty.write('Responda apenas com a soma de 12 + 30 em dígitos e mais nada.\r')
  await sleep(120_000) // janela para o modelo responder
  const strip = (t) =>
    t
      .replace(new RegExp('\\x1b\\[[0-9;?]*[A-Za-z]', 'g'), '')
      .replace(new RegExp('\\x1b\\][^\\x07\\x1b]*(\\x07|\\x1b\\\\)', 'g'), ' [OSC] ')
  const clean = strip(buffer)
  console.log('=== contém 42 (resposta computada, ausente do prompt)? ===', /\b42\b/.test(clean))
  console.log('=== notificações OSC 99 (erros/avisos da TUI) ===')
  for (const m of clean.matchAll(new RegExp('\\]99;i=[^:]*:p=?;([^\\x07\\x1b]*)', 'g'))) {
    console.log(' -', m[1].slice(0, 220))
  }
  console.log('=== linhas com erro/auth/credit/fail ===')
  for (const line of clean.split(/\r?\n/)) {
    if (/error|auth|credit|401|403|429|fail/i.test(line)) console.log(' *', line.trim().slice(0, 220))
  }
  console.log('=== ÚLTIMAS 60 linhas limpas ===')
  console.log(clean.split(/\r?\n/).filter((l) => l.trim()).slice(-60).join('\n').slice(-4000))
  console.log('=== exited:', exited, '===')
  try { conpty.kill() } catch {}
}

main()
