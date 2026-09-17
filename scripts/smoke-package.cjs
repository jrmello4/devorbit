/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
'use strict'

const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const releaseDir = path.join(projectRoot, 'release')
const MARKER_KIND = 'devorbit-packaged-smoke'

const tempRoot = (() => {
  const candidates = [process.env.RUNNER_TEMP, os.tmpdir(), process.env.TEMP, process.env.TMP]
  // `realpathSync.native` expande aliases 8.3 (ex.: ADENIL~1.J); o realpath JS
  // não. Caminhos curtos fariam a URL do frame (`%7E`) divergir da URL de
  // produção do app, derrubando o IPC do smoke.
  const canonicalize = (candidate) => {
    for (const resolve of [
      () => fs.realpathSync.native(candidate),
      () => fs.realpathSync(candidate),
    ]) {
      try {
        const real = resolve()
        if (fs.statSync(real).isDirectory()) return real
      } catch {
        // try the next resolution
      }
    }
    return null
  }
  for (const candidate of candidates) {
    if (!candidate) continue
    const real = canonicalize(candidate)
    if (real) return real
  }
  return os.tmpdir()
})()
process.env.TEMP = tempRoot
process.env.TMP = tempRoot

function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version
}

function parseTargets(argv) {
  const arg = argv.find((item) => item.startsWith('--targets='))
  if (!arg) return ['unpacked', 'portable', 'nsis']
  return arg
    .slice('--targets='.length)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseScalar(value) {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseLatestYml(text) {
  const parsed = { version: null, path: null, sha512: null, files: [] }
  let inFiles = false
  let currentFile = null
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue
    const indent = rawLine.length - rawLine.trimStart().length
    const line = rawLine.trim()
    if (indent === 0) {
      currentFile = null
      if (line === 'files:') {
        inFiles = true
        continue
      }
      inFiles = false
      const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
      if (!match) return null
      const key = match[1]
      const value = parseScalar(match[2])
      if (key === 'version') parsed.version = value
      else if (key === 'path') parsed.path = value
      else if (key === 'sha512') parsed.sha512 = value
      continue
    }
    if (!inFiles) return null
    if (line.startsWith('- ')) {
      currentFile = {}
      parsed.files.push(currentFile)
      const match = line.slice(2).match(/^([A-Za-z0-9_]+):\s*(.*)$/)
      if (!match) return null
      currentFile[match[1]] = parseScalar(match[2])
      continue
    }
    if (!currentFile) return null
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (!match) return null
    currentFile[match[1]] = parseScalar(match[2])
  }
  return parsed
}

function validateLatestYml(version) {
  const label = 'latest.yml'
  const ymlPath = path.join(releaseDir, 'latest.yml')
  const installerName = `DevOrbit-${version}-x64.exe`
  const installerPath = path.join(releaseDir, installerName)

  if (!fs.existsSync(ymlPath)) return { label, ok: false, detail: 'latest.yml nÃ£o encontrado' }
  if (!fs.existsSync(installerPath)) {
    return { label, ok: false, detail: `instalador referenciado ausente: ${installerName}` }
  }

  const parsed = parseLatestYml(fs.readFileSync(ymlPath, 'utf8'))
  if (!parsed) return { label, ok: false, detail: 'latest.yml com estrutura nÃ£o reconhecida' }
  if (parsed.version !== version) {
    return { label, ok: false, detail: `latest.yml version=${parsed.version} != ${version}` }
  }
  if (parsed.path !== installerName) {
    return { label, ok: false, detail: `latest.yml path=${parsed.path} != ${installerName}` }
  }
  if (parsed.files.length !== 1) {
    return { label, ok: false, detail: `latest.yml files deveria ter 1 item, tem ${parsed.files.length}` }
  }

  const entry = parsed.files[0]
  if (!entry.url || path.basename(entry.url) !== installerName) {
    return { label, ok: false, detail: `latest.yml url invÃ¡lida: ${entry.url}` }
  }

  const realSize = fs.statSync(installerPath).size
  if (Number(entry.size) !== realSize) {
    return { label, ok: false, detail: `latest.yml size=${entry.size} != real ${realSize}` }
  }

  const realSha512 = crypto.createHash('sha512').update(fs.readFileSync(installerPath)).digest('base64')
  if (parsed.sha512 !== realSha512) {
    return { label, ok: false, detail: 'latest.yml sha512 (raiz) nÃ£o corresponde ao instalador' }
  }
  if (entry.sha512 !== realSha512) {
    return { label, ok: false, detail: 'latest.yml sha512 (files[0]) nÃ£o corresponde ao instalador' }
  }

  return {
    label,
    ok: true,
    detail: `latest.yml OK path=${installerName} size=${realSize} sha512=${realSha512.slice(0, 12)}`,
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function removeTempDir(dir, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!fs.existsSync(dir)) return true
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } catch (error) {
      if (error && error.code === 'ENOENT') return true
    }
    if (!fs.existsSync(dir)) return true
    sleepSync(500)
  }
  return !fs.existsSync(dir)
}

function runProcess(exePath, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(exePath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, stdout, stderr })
    }
    timer = setTimeout(() => {
      child.kill()
      finish({ code: null, timedOut: true })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => finish({ code: null, error }))
    child.on('close', (code) => finish({ code }))
  })
}

async function readMarker(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      let parsed = null
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        parsed = null
      }
      if (parsed) return parsed
    }
    await sleep(100)
  }
  return null
}

function checkMarker(marker, expected) {
  if (!marker || typeof marker !== 'object') return { ok: false, detail: 'marcador ausente/invÃ¡lido' }
  if (marker.kind !== MARKER_KIND) return { ok: false, detail: 'kind do marcador inesperado' }
  if (marker.token !== expected.token) return { ok: false, detail: 'token do marcador divergente' }
  if (marker.version !== expected.version) {
    return { ok: false, detail: `versÃ£o do marcador ${marker.version} != ${expected.version}` }
  }
  if (marker.success !== true) {
    return { ok: false, detail: `marcador success=false (${marker.error || 'sem detalhe'})` }
  }
  if (marker.renderer !== true || marker.preload !== true || marker.ipc !== true) {
    return { ok: false, detail: 'marcador sem evidÃªncia de renderer/preload/IPC' }
  }
  return { ok: true, detail: 'marcador validado' }
}

async function smokeExecutable(label, exePath, version) {
  if (!fs.existsSync(exePath)) {
    return { label, ok: false, detail: `executÃ¡vel nÃ£o encontrado: ${exePath}` }
  }

  const base = fs.mkdtempSync(path.join(tempRoot, 'devorbit-smoke-run-'))
  const userDataDir = path.join(base, 'user-data')
  const resultFile = path.join(base, 'result.json')
  const token = crypto.randomBytes(16).toString('hex')
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.writeFileSync(
    path.join(userDataDir, 'config.json'),
    JSON.stringify({
      projectDirs: [],
      activeChatGptAccount: 'account1',
      chatGptAccount1Name: 'Smoke Conta 1',
      chatGptAccount2Name: 'Smoke Conta 2',
      customPaths: {},
    })
  )

  let outcome
  try {
    const run = await runProcess(
      exePath,
      [
        '--devorbit-smoke',
        `--devorbit-smoke-version=${version}`,
        `--devorbit-smoke-token=${token}`,
        `--devorbit-smoke-temp=${base}`,
        `--devorbit-smoke-userdata=${userDataDir}`,
        `--devorbit-smoke-result=${resultFile}`,
        `--user-data-dir=${userDataDir}`,
      ],
      90_000
    )

    if (run.timedOut) {
      outcome = { label, ok: false, detail: 'timeout aguardando o processo' }
    } else if (run.error) {
      outcome = { label, ok: false, detail: `processo: ${run.error.message}` }
    } else if (run.code !== 0) {
      outcome = { label, ok: false, detail: `exit ${run.code} ${run.stderr.trim()}`.trim() }
    } else {
      const marker = await readMarker(resultFile, 10_000)
      const check = checkMarker(marker, { version, token })
      outcome = check.ok
        ? { label, ok: true, detail: `marcador OK token=${token.slice(0, 8)} versÃ£o=${version}` }
        : { label, ok: false, detail: check.detail }
    }
  } catch (error) {
    outcome = { label, ok: false, detail: `erro: ${error.message}` }
  }

  const cleaned = removeTempDir(base)
  if (!cleaned) {
    return { label, ok: false, detail: `${outcome.detail}; resÃ­duo temporÃ¡rio permaneceu` }
  }
  return outcome
}

async function silentInstallSmoke(label, installerPath, version) {
  if (!fs.existsSync(installerPath)) {
    return { label, ok: false, detail: `instalador nÃ£o encontrado: ${installerPath}` }
  }

  const installDir = fs.mkdtempSync(path.join(tempRoot, 'devorbit-smoke-install-'))
  if (/\s/.test(installDir)) {
    removeTempDir(installDir)
    return { label, ok: false, detail: 'diretÃ³rio de instalaÃ§Ã£o criado com espaÃ§os' }
  }

  const installedExe = path.join(installDir, 'DevOrbit.exe')
  const uninstaller = path.join(installDir, 'Uninstall DevOrbit.exe')

  let outcome
  try {
    const install = await runProcess(installerPath, ['/S', `/D=${installDir}`], 180_000)
    if (install.timedOut) {
      outcome = { label, ok: false, detail: 'timeout na instalaÃ§Ã£o silenciosa' }
    } else if (install.error) {
      outcome = { label, ok: false, detail: `instalaÃ§Ã£o: ${install.error.message}` }
    } else if (install.code !== 0) {
      outcome = { label, ok: false, detail: `instalaÃ§Ã£o exit ${install.code}` }
    } else if (!fs.existsSync(installedExe)) {
      outcome = { label, ok: false, detail: `instalador nÃ£o gerou ${installedExe}` }
    } else {
      outcome = await smokeExecutable(label, installedExe, version)
    }
  } catch (error) {
    outcome = { label, ok: false, detail: `erro na instalaÃ§Ã£o: ${error.message}` }
  }

  let uninstallerStatus = 'ausente'
  if (fs.existsSync(uninstaller)) {
    const uninstall = await runProcess(uninstaller, ['/S'], 60_000)
    if (uninstall.error) uninstallerStatus = `erro: ${uninstall.error.message}`
    else if (uninstall.timedOut) uninstallerStatus = 'timeout'
    else uninstallerStatus = `exit ${uninstall.code}`
  }

  const cleaned = removeTempDir(installDir)
  const suffix = `(uninstaller: ${uninstallerStatus})`
  if (!cleaned) {
    return {
      label,
      ok: false,
      detail: `${outcome.detail}; resÃ­duo da instalaÃ§Ã£o permaneceu ${suffix}`,
    }
  }
  return { ...outcome, detail: `${outcome.detail} ${suffix}` }
}

async function main() {
  const version = readVersion()
  const targets = parseTargets(process.argv)
  const results = [validateLatestYml(version)]

  if (targets.includes('unpacked')) {
    results.push(
      await smokeExecutable('win-unpacked', path.join(releaseDir, 'win-unpacked', 'DevOrbit.exe'), version)
    )
  }
  if (targets.includes('portable')) {
    results.push(
      await smokeExecutable('portable', path.join(releaseDir, `DevOrbit-${version}-portable.exe`), version)
    )
  }
  if (targets.includes('nsis')) {
    results.push(
      await silentInstallSmoke('nsis-install', path.join(releaseDir, `DevOrbit-${version}-x64.exe`), version)
    )
  }

  if (results.length === 0) {
    console.error('Nenhum alvo de smoke selecionado.')
    process.exitCode = 1
    return
  }

  let failed = false
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'} [${result.label}] ${result.detail}`)
    if (!result.ok) failed = true
  }
  const passed = results.filter((result) => result.ok).length
  console.log(`Package smoke ${failed ? 'failed' : 'passed'}: ${passed}/${results.length}`)
  process.exitCode = failed ? 1 : 0
}

main().catch((error) => {
  console.error('Package smoke error:', error && error.stack ? error.stack : error)
  process.exitCode = 1
})
