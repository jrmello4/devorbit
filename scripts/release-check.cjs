/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const lockJson = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
if (lockJson.version !== packageJson.version || lockJson.packages?.['']?.version !== packageJson.version) {
  throw new Error('package.json e package-lock.json divergem.')
}
const expectedHeading = `## [${packageJson.version}]`
if (!changelog.split(/\r?\n/u).some((line) => line.trim() === expectedHeading || line.trim().startsWith(expectedHeading + ' '))) {
  throw new Error(`CHANGELOG.md não possui uma entrada para ${packageJson.version}.`)
}
process.stdout.write(`Release metadata válida: ${packageJson.version}\n`)
