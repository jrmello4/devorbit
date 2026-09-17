/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const cssPath = path.join(root, 'src', 'renderer', 'src', 'index.css')
const css = fs.readFileSync(cssPath, 'utf8')
const declarations = new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/giu)].map((match) => match[1]))
const required = [
  'color-bg-page',
  'color-bg-panel',
  'color-border-subtle',
  'text-primary',
  'color-accent',
  'color-focus-ring',
]
const missing = required.filter((token) => !declarations.has(token))
if (missing.length > 0) throw new Error(`Tokens ausentes: ${missing.join(', ')}`)
if (!/\[data-theme="dark"\]/u.test(css)) throw new Error('Tema escuro não possui bloco de tokens.')
if (!/prefers-color-scheme/u.test(css)) throw new Error('Fallback de tema do sistema ausente.')
process.stdout.write(`Tokens válidos: ${declarations.size}\n`)
