/* eslint-disable @typescript-eslint/no-require-imports, no-undef, no-control-regex */
'use strict'

const { spawn, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')

const projectRoot = path.resolve(__dirname, '..')
const releaseDir = path.join(projectRoot, 'release')
const MARKER_KIND = 'devorbit-packaged-smoke'

const tempRoot = (() => {
  const candidates = [process.env.RUNNER_TEMP, os.tmpdir(), process.env.TEMP, process.env.TMP]
  // O app agora canonicaliza URLs file:// sozinho (alias 8.3 do TEMP incluído),
  // então o smoke precisa exercitar a forma REAL de TEMP do usuário — sem
  // realpath que esconderia o caminho curto.
  for (const candidate of candidates) {
    if (!candidate) continue
    // O caminho vira string de comando no cmd.exe (passo 8.3); aspas e
    // caracteres de controle são ilegais em paths do Windows e só poderiam
    // vir de um ambiente hostil — descarta em vez de interpolar.
    if (/["\r\n\t\u0000-\u001f]/.test(candidate)) continue
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate
    } catch {
      // tenta o próximo candidato
    }
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

function validateLatestPortableYml(version) {
  const label = 'latest-portable.yml'
  const ymlPath = path.join(releaseDir, 'latest-portable.yml')
  const portableName = `DevOrbit-${version}-portable.exe`
  const portablePath = path.join(releaseDir, portableName)

  if (!fs.existsSync(ymlPath)) return { label, ok: false, detail: 'latest-portable.yml não encontrado' }
  if (!fs.existsSync(portablePath)) {
    return { label, ok: false, detail: `executável portable referenciado ausente: ${portableName}` }
  }

  const content = fs.readFileSync(ymlPath, 'utf8')
  const versionMatch = content.match(/^version:\s*(.+)$/m)
  const pathMatch = content.match(/^path:\s*(.+)$/m)
  const shaMatch = content.match(/^sha512:\s*(.+)$/m)

  if (!versionMatch || !pathMatch || !shaMatch) {
    return { label, ok: false, detail: 'latest-portable.yml com estrutura ou campos ausentes' }
  }

  const parsedVersion = parseScalar(versionMatch[1])
  const parsedPath = parseScalar(pathMatch[1])
  const parsedSha512 = parseScalar(shaMatch[1]).toLowerCase()

  if (parsedVersion !== version) {
    return { label, ok: false, detail: `latest-portable.yml version=${parsedVersion} != ${version}` }
  }
  if (parsedPath !== portableName) {
    return { label, ok: false, detail: `latest-portable.yml path=${parsedPath} != ${portableName}` }
  }

  const hexSha512 = crypto.createHash('sha512').update(fs.readFileSync(portablePath)).digest('hex').toLowerCase()
  const base64Sha512 = crypto.createHash('sha512').update(fs.readFileSync(portablePath)).digest('base64').toLowerCase()
  if (parsedSha512 !== hexSha512 && parsedSha512 !== base64Sha512) {
    return { label, ok: false, detail: 'latest-portable.yml sha512 não corresponde ao executável portable' }
  }

  return {
    label,
    ok: true,
    detail: `latest-portable.yml OK path=${portableName} sha512=${hexSha512.slice(0, 12)}`,
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

const BRIDGE_RESOURCE_FILES = [
  'devorbit.cmd',
  'devorbit-mcp.cmd',
  path.join('scripts', 'devorbit-bridge.cjs'),
  path.join('scripts', 'devorbit-mcp.cjs'),
  path.join('ai-usagebar', 'ai-usagebar.exe'),
  path.join('ai-usagebar', 'LICENSE-ai-usagebar.txt'),
  path.join('ai-usagebar', 'ATTRIBUTION-ai-usagebar.txt'),
]

function runLauncherProbe(command, args, input, timeoutMs = 30_000, windowsVerbatimArguments = false, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      windowsVerbatimArguments,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch (error) {
        void error
      }
      resolve({ ...result, stdout, stderr })
    }
    const timer = setTimeout(() => finish({ code: null, timedOut: true }), timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      if (stdout.includes('\n')) finish({ code: 0 })
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => finish({ code: null, error }))
    child.on('close', (code) => finish({ code }))
    child.stdin.write(`${input}\n`)
  })
}

async function verifyBridgeResources() {
  const label = 'bridge/mcp resources'
  const resourcesDir = path.join(releaseDir, 'win-unpacked', 'resources')
  if (!fs.existsSync(resourcesDir)) {
    return { label, ok: false, detail: 'resources do pacote ausente; rode npm run dist antes do smoke' }
  }
  const missing = []
  for (const relative of BRIDGE_RESOURCE_FILES) {
    const file = path.join(resourcesDir, relative)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
      missing.push(relative)
    }
  }
  if (missing.length > 0) {
    return { label, ok: false, detail: `arquivos ausentes fora do ASAR: ${missing.join(', ')}` }
  }
  if (!fs.existsSync(path.join(resourcesDir, 'app.asar'))) {
    return { label, ok: false, detail: 'app.asar ausente no pacote' }
  }
  const mcpCmdSource = fs.readFileSync(path.join(resourcesDir, 'devorbit-mcp.cmd'), 'utf8')
  if (!mcpCmdSource.includes('scripts\\devorbit-mcp.cjs') && !mcpCmdSource.includes('scripts/devorbit-mcp.cjs')) {
    return { label, ok: false, detail: 'devorbit-mcp.cmd nao aponta para scripts/devorbit-mcp.cjs' }
  }
  const bridgeCmdSource = fs.readFileSync(path.join(resourcesDir, 'devorbit.cmd'), 'utf8')
  if (!bridgeCmdSource.includes('scripts\\devorbit-bridge.cjs') && !bridgeCmdSource.includes('scripts/devorbit-bridge.cjs')) {
    return { label, ok: false, detail: 'devorbit.cmd nao aponta para scripts/devorbit-bridge.cjs' }
  }
  if (process.platform !== 'win32') {
    return { label, ok: false, detail: 'probe do launcher fisico exige Windows' }
  }
  const mcpCjs = path.join(resourcesDir, 'scripts', 'devorbit-mcp.cjs')
  const bridgeCjs = path.join(resourcesDir, 'scripts', 'devorbit-bridge.cjs')
  for (const file of [bridgeCjs, mcpCjs]) {
    const check = await runProcess(process.execPath, ['--check', file], 20_000)
    if (check.code !== 0) {
      return { label, ok: false, detail: `node --check falhou em ${path.basename(file)}: ${check.stderr.trim()}` }
    }
  }
  const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  const pipeName = `\\\\.\\pipe\\devorbit-package-mcp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  const token = crypto.randomBytes(32).toString('hex')
  const sessionId = crypto.randomBytes(12).toString('hex')
  const bridge = net.createServer((socket) => {
    let pending = ''
    socket.on('error', () => undefined)
    socket.on('data', (chunk) => {
      pending += chunk.toString()
      const newline = pending.indexOf('\n')
      if (newline < 0) return
      try {
        const request = JSON.parse(pending.slice(0, newline))
        const ok = request.token === token && request.sessionId === sessionId
        socket.end(JSON.stringify(ok
          ? { ok: true, result: request.type === 'list' ? [] : { connected: true } }
          : { ok: false, error: { code: 'BRIDGE_AUTH_REJECTED', message: 'Authentication rejected.' } }) + '\n')
      } catch { socket.destroy() }
    })
  })
  await new Promise((resolve, reject) => { bridge.once('error', reject); bridge.listen(pipeName, resolve) })
  const runtimeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DEVORBIT_BRIDGE_PIPE: pipeName, DEVORBIT_BRIDGE_TOKEN: token, DEVORBIT_SESSION_ID: sessionId }
  const runtimeExe = path.join(releaseDir, 'win-unpacked', 'DevOrbit.exe')
  try {
    if (!fs.existsSync(runtimeExe) || !fs.statSync(runtimeExe).isFile()) {
      return { label, ok: false, detail: `executavel empacotado ausente: ${runtimeExe}` }
    }
    // Exercise the bundled runtime used by managed launches, without a Node PATH dependency.
    const direct = await runLauncherProbe(runtimeExe, [mcpCjs], initialize, 30_000, false, runtimeEnv)
    const response = JSON.parse(direct.stdout.trim().split('\n')[0] || '{}')
    if (direct.timedOut || response.result?.serverInfo?.name !== 'DevOrbit MCP') {
      return { label, ok: false, detail: 'Electron empacotado nao inicializou o MCP com Bridge autenticada' }
    }
    const missingEnv = { ...runtimeEnv }
    delete missingEnv.DEVORBIT_BRIDGE_TOKEN
    const missing = await runLauncherProbe(runtimeExe, [mcpCjs], initialize, 30_000, false, missingEnv)
    if (!missing.stdout.includes('BRIDGE_ENV_MISSING')) return { label, ok: false, detail: 'MCP aceitou initialize sem ambiente completo' }
    return { label, ok: true, detail: 'Recursos fora do ASAR; Electron empacotado executa MCP, autentica Bridge e rejeita ambiente incompleto' }
  } finally {
    await new Promise((resolve) => bridge.close(resolve))
  }
}

function runProcess(exePath, args, timeoutMs, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(exePath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
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
      let parsed
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

async function smokeExecutable(label, exePath, version, options = {}) {
  const { baseDir = tempRoot, prefix = 'devorbit-smoke-run-', env = process.env, overrideTemp = false } = options
  if (!fs.existsSync(exePath)) {
    return { label, ok: false, detail: `executÃ¡vel nÃ£o encontrado: ${exePath}` }
  }

  const base = fs.mkdtempSync(path.join(baseDir, prefix))
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
    // O extrator portable grava em %TEMP%: o override força a extração sob o
    // diretório desta execução (incluindo a variante 8.3) e o cleanup cobre.
    const childEnv = overrideTemp ? { ...env, TEMP: base, TMP: base } : env
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
      90_000,
      childEnv
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

function samePathValue(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

function getWindowsShortPath(dir) {
  if (process.platform !== 'win32') return null
  try {
    // Verbatim é obrigatório: o quote automático do Node quebra o parse do
    // `for` do cmd (aspas embutidas do caminho).
    const result = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${dir}") do @echo %~sI`], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      windowsVerbatimArguments: true,
    })
    if (result.error || result.status !== 0) return null
    const line = String(result.stdout || '')
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)[0]
    return line || null
  } catch {
    return null
  }
}

// Regressão do bug P0: portable extraído em TEMP na forma 8.3 (ADENIL~1.J)
// derrubava todo o IPC por divergência de URL (til literal vs %7E).
async function smokePortableTemp83(version) {
  const label = 'portable-temp-8.3'
  const portableExe = path.join(releaseDir, `DevOrbit-${version}-portable.exe`)
  if (!fs.existsSync(portableExe)) {
    return { label, ok: false, detail: `executável portable não encontrado: ${portableExe}` }
  }
  if (process.platform !== 'win32') {
    return { label, ok: true, skip: true, detail: 'pulado: regressão 8.3 exige Windows' }
  }
  const shortForm = getWindowsShortPath(tempRoot)
  if (!shortForm) {
    console.log(`[aviso] ${label}: forma 8.3 de ${tempRoot} indisponível (8.3 desabilitado?); etapa pulada`)
    return { label, ok: true, skip: true, detail: `pulado: forma 8.3 de ${tempRoot} indisponível` }
  }
  if (samePathValue(shortForm, tempRoot)) {
    console.log(`[aviso] ${label}: TEMP (${tempRoot}) não possui alias 8.3 distinto; etapa pulada`)
    return { label, ok: true, skip: true, detail: `pulado: TEMP sem alias 8.3 distinto (${shortForm})` }
  }
  return await smokeExecutable(label, portableExe, version, {
    baseDir: shortForm,
    prefix: 'devorbit-smoke-83-',
    overrideTemp: true,
  })
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
  const results = [
    validateLatestYml(version),
    validateLatestPortableYml(version),
    await verifyBridgeResources(),
  ]

  if (targets.includes('unpacked')) {
    results.push(
      await smokeExecutable('win-unpacked', path.join(releaseDir, 'win-unpacked', 'DevOrbit.exe'), version)
    )
  }
  if (targets.includes('portable')) {
    results.push(
      await smokeExecutable('portable', path.join(releaseDir, `DevOrbit-${version}-portable.exe`), version)
    )
    results.push(await smokePortableTemp83(version))
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
  let skipped = 0
  for (const result of results) {
    if (result.skip) {
      skipped += 1
      console.log(`SKIP [${result.label}] ${result.detail}`)
      continue
    }
    console.log(`${result.ok ? 'PASS' : 'FAIL'} [${result.label}] ${result.detail}`)
    if (!result.ok) failed = true
  }
  const passed = results.filter((result) => result.ok && !result.skip).length
  console.log(`Package smoke ${failed ? 'failed' : 'passed'}: ${passed}/${results.length - skipped}${skipped ? ` (${skipped} pulada(s))` : ''}`)
  process.exitCode = failed ? 1 : 0
}

main().catch((error) => {
  console.error('Package smoke error:', error && error.stack ? error.stack : error)
  process.exitCode = 1
})
