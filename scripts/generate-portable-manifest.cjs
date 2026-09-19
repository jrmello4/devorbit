/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const PORTABLE_MANIFEST_NAME = 'latest-portable.yml'
const projectRoot = path.resolve(__dirname, '..')

function readVersion(root = projectRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (!pkg || typeof pkg.version !== 'string' || !pkg.version.trim()) {
    throw new Error('package.json sem versão válida para o manifesto portátil.')
  }
  return pkg.version.trim()
}

function portableArtifactName(version) {
  return `DevOrbit-${version}-portable.exe`
}

/**
 * Gera `latest-portable.yml` a partir do executável portátil já construído.
 * O formato é o que `parsePortableManifest` (src/main/updater.ts) reconhece:
 * `version`, `path` (nome puro, sem barras) e `sha512` em hexadecimal.
 */
function generatePortableManifest(options) {
  const releaseDir = options && options.releaseDir ? options.releaseDir : path.join(projectRoot, 'release')
  const version = options && options.version ? String(options.version).trim() : readVersion()
  const portableName = portableArtifactName(version)
  const portablePath = path.join(releaseDir, portableName)
  if (!fs.existsSync(portablePath)) {
    throw new Error(`Executável portátil ausente para o manifesto: ${portablePath}`)
  }
  const sha512 = crypto.createHash('sha512').update(fs.readFileSync(portablePath)).digest('hex').toLowerCase()
  const manifest = [
    `version: ${version}`,
    `path: ${portableName}`,
    `sha512: ${sha512}`,
    `releaseDate: ${new Date().toISOString()}`,
  ].join('\n')
  const manifestPath = path.join(releaseDir, PORTABLE_MANIFEST_NAME)
  fs.writeFileSync(manifestPath, `${manifest}\n`, 'utf8')
  return { manifestPath, portablePath, sha512, version }
}

function releaseDirFromContext(context) {
  if (context && typeof context.outDir === 'string' && context.outDir.trim()) {
    return path.resolve(context.outDir)
  }
  if (context && Array.isArray(context.artifactPaths)) {
    const portable = context.artifactPaths.find((entry) => /portable\.exe$/i.test(String(entry)))
    if (portable) return path.dirname(String(portable))
    if (context.artifactPaths.length > 0) return path.dirname(String(context.artifactPaths[0]))
  }
  return path.join(projectRoot, 'release')
}

/**
 * Hook `afterAllArtifactBuild` do electron-builder: garante que o manifesto
 * portátil acompanhe os artefatos gerados por `npm run dist` e pelo CI, sem
 * interferir no `latest.yml` do NSIS.
 */
async function afterAllArtifactBuild(context) {
  return generatePortableManifest({ releaseDir: releaseDirFromContext(context) })
}

module.exports = afterAllArtifactBuild
module.exports.generatePortableManifest = generatePortableManifest
module.exports.readVersion = readVersion
module.exports.portableArtifactName = portableArtifactName
module.exports.releaseDirFromContext = releaseDirFromContext
module.exports.PORTABLE_MANIFEST_NAME = PORTABLE_MANIFEST_NAME
