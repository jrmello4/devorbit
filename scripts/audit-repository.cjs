/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const sourceRoot = path.join(root, 'src')
const outputRoot = path.join(root, 'artifacts', 'audit')
const extensions = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx'])
const ignored = new Set(['node_modules', 'dist', 'dist-electron', 'release', '.git'])

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)).flatMap((entry) => {
    if (entry.isDirectory()) return ignored.has(entry.name) ? [] : files(path.join(directory, entry.name))
    return extensions.has(path.extname(entry.name).toLowerCase()) ? [path.join(directory, entry.name)] : []
  })
}

const findings = []
let linesScanned = 0
let complexity = 0
for (const file of files(sourceRoot)) {
  const relative = path.relative(root, file).split(path.sep).join('/')
  const content = fs.readFileSync(file, 'utf8')
  linesScanned += content.split(/\r?\n/u).length
  const branches = [...content.matchAll(/\b(if|for|while|catch|case|&&|\|\||\?)\b/gu)].length
  complexity += branches + 1
  for (const [pattern, severity, message, minutes] of [[/\bTODO\b/gu, 'low', 'TODO pendente', 15], [/\bFIXME\b/gu, 'medium', 'FIXME pendente', 30], [/:\s*any\b/gu, 'medium', 'Tipo any', 20]]) {
    for (const match of content.matchAll(pattern)) {
      findings.push({ severity, file: relative, line: content.slice(0, match.index || 0).split(/\r?\n/u).length, message, estimatedMinutes: minutes })
    }
  }
  if (branches >= 12) findings.push({ severity: branches >= 30 ? 'critical' : branches >= 20 ? 'high' : 'medium', file: relative, line: 1, message: `Complexidade aproximada ${branches + 1}`, estimatedMinutes: (branches + 1) * 5 })
}
const report = { version: 1, generatedAt: new Date().toISOString(), filesScanned: files(sourceRoot).length, linesScanned, cyclomaticComplexity: complexity, findings, estimatedDebtMinutes: findings.reduce((total, item) => total + item.estimatedMinutes, 0) }
fs.mkdirSync(outputRoot, { recursive: true })
fs.writeFileSync(path.join(outputRoot, 'repository-audit.json'), `${JSON.stringify(report, null, 2)}\n`)
const markdown = [`# Auditoria estática`, '', `Arquivos: ${report.filesScanned} · Linhas: ${report.linesScanned} · Complexidade: ${report.cyclomaticComplexity} · Débito: ${report.estimatedDebtMinutes} minutos`, '', '| Severidade | Arquivo | Linha | Achado |', '|---|---|---:|---|', ...findings.map((item) => `| ${item.severity} | ${item.file} | ${item.line} | ${item.message} |`), ''].join('\n')
fs.writeFileSync(path.join(outputRoot, 'repository-audit.md'), markdown)
process.stdout.write(`Auditoria gerada em ${outputRoot}\n`)
