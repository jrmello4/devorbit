/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
'use strict'

const electron = require('electron')
const { app, BrowserWindow, ipcMain } = electron
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const ts = require('typescript')

const projectRoot = path.resolve(__dirname, '..')
const preloadPath = path.join(projectRoot, 'dist-electron', 'preload', 'index.cjs')
const validationSourcePath = path.join(projectRoot, 'src', 'main', 'validation.ts')
// Chromium canonicaliza a URL do frame (caminho longo). Sem realpath, o
// `os.tmpdir()` em 8.3 (ADENIL~1.J) faria a origem confiável divergir.
// `realpathSync.native` é o que expande o alias 8.3; o realpath JS não.
function realDirectory(candidate) {
  try {
    return fs.realpathSync.native(candidate)
  } catch {
    try {
      return fs.realpathSync(candidate)
    } catch {
      return candidate
    }
  }
}
const scratchRoot = fs.mkdtempSync(path.join(realDirectory(os.tmpdir()), 'devorbit-smoke-'))
// O contrato de validação importa módulos do próprio projeto (ex.:
// ./agent-providers -> @typesafe-ai/sdk). Emitimos o grafo completo para um
// diretório dentro de node_modules para que a resolução real ocorra, sem
// replicar dependências à mão.
const emitRoot = (() => {
  const cacheRoot = path.join(projectRoot, 'node_modules', '.cache')
  fs.mkdirSync(cacheRoot, { recursive: true })
  const directory = fs.mkdtempSync(path.join(cacheRoot, 'devorbit-smoke-'))
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ type: 'commonjs' }))
  return directory
})()
const userDataDir = path.join(scratchRoot, 'userData')
fs.mkdirSync(userDataDir, { recursive: true })
app.setPath('userData', userDataDir)

const PRODUCTION_WEB_PREFERENCES = {
  preload: preloadPath,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
}

const EXPECTED_METHODS = [
  'getProjects',
  'refreshProjects',
  'getOtherDirs',
  'listProjectFiles',
  'readProjectFile',
  'saveProjectFile',
  'createProjectFile',
  'createProjectDirectory',
  'moveProjectEntry',
  'deleteProjectEntry',
  'syncGit',
  'getGitBranches',
  'switchGitBranch',
  'stashSyncGit',
  'stashSwitchGitBranch',
  'pushGit',
  'getGitChanges',
  'getGitFileDiff',
  'syncAllGit',
  'onSyncProgress',
  'getGitInitPreview',
  'initGitRepository',
  'cloneGitRepository',
  'restoreManagedProject',
  'finalizeManagedProject',
  'createAgentWorktree',
  'integrateAgentWorktree',
  'startTerminal',
  'startCodexTerminal',
  'startAgentTerminal',
  'resizeTerminal',
  'writeTerminal',
  'stopTerminal',
  'pipeTerminals',
  'sendAgentTurn',
  'onTerminalEvent',
  'onCompanionEvent',
  'onAgentBridgeEvent',
  'navigateWeb',
  'getWebState',
  'goBackWeb',
  'goForwardWeb',
  'reloadWeb',
  'setWebVisible',
  'disposeWebPanel',
  'setWebBounds',
  'onWebEvent',
  'launchTool',
  'copyProjectContext',
  'getConfig',
  'getUpdateState',
  'downloadUpdate',
  'installUpdate',
  'onUpdateStatus',
  'saveConfig',
  'exportConfig',
  'importConfig',
  'selectDirectory',
  'testToolPath',
  'getToolHealth',
  'windowControl',
  'getCodexAuthStatus',
  'startCodexLogin',
  'cancelCodexLogin',
  'onCodexAuthProgress',
  'getProjectMemory',
  'saveProjectMemory',
  'generateMemoryFromGit',
  'getRealUsage',
  'getProjectAudit',
  'getHitlRequests',
  'onHitlEvent',
  'approveHitl',
  'rejectHitl',
  'runDiagnostic',
  'getTelemetrySpans',
  'getHybridMemory',
  'rememberHybridMemory',
  'searchHybridMemory',
  'completeLlm',
  'getEvolutionHistory',
  'searchProjectText',
]

const checks = []

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function pass(message) {
  checks.push(message)
  console.log(`PASS ${message}`)
}

function compileValidationContract() {
  const program = ts.createProgram([validationSourcePath], {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
    outDir: emitRoot,
    rootDir: projectRoot,
    skipLibCheck: true,
    types: [],
  })
  const emitted = program.emit()
  assert(!emitted.emitSkipped, 'não foi possível emitir o contrato de validação do smoke')
  const compiledPath = path.join(emitRoot, 'src', 'main', 'validation.js')
  assert(fs.existsSync(compiledPath), `contrato de validação não emitido em ${compiledPath}`)
  return require(compiledPath)
}

async function waitFor(window, expression, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let result = null
    try {
      result = await window.webContents.executeJavaScript(`(${expression})`, true)
    } catch {
      result = null
    }
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timeout aguardando ${label}`)
}

async function loadPage(window, file) {
  await window.loadFile(file)
  await waitFor(
    window,
    `typeof window.devorbit === 'object' && window.devorbit !== null`,
    'preload expor window.devorbit'
  )
}

async function evaluate(window, expression) {
  return await window.webContents.executeJavaScript(`(${expression})`, true)
}

async function main() {
  assert(
    process.env.ELECTRON_RUN_AS_NODE !== '1',
    'Electron foi iniciado como Node; use `npx electron scripts/smoke-ipc.cjs`'
  )
  assert(
    fs.existsSync(preloadPath),
    `Preload compilado ausente em ${preloadPath}. Rode \`npm run build\` antes do smoke.`
  )

  const pagesDir = path.join(scratchRoot, 'pages')
  fs.mkdirSync(pagesDir, { recursive: true })

  const validation = compileValidationContract()
  const trustedPage = path.join(pagesDir, 'trusted.html')
  const untrustedPage = path.join(pagesDir, 'untrusted.html')
  await fsp.writeFile(trustedPage, '<!doctype html><meta charset="utf-8"><title>trusted</title>')
  await fsp.writeFile(untrustedPage, '<!doctype html><meta charset="utf-8"><title>untrusted</title>')
  const trustedUrl = pathToFileURL(trustedPage).href
  const untrustedUrl = pathToFileURL(untrustedPage).href

  assert(
    validation.isTrustedRendererUrl(trustedUrl, trustedUrl) === true,
    'validador deveria confiar na própria página de produção'
  )
  assert(
    validation.isTrustedRendererUrl(untrustedUrl, trustedUrl) === false,
    'validador deveria rejeitar uma página irmã em file://'
  )
  assert(
    validation.isTrustedRendererUrl('https://evil.example/', trustedUrl) === false,
    'validador deveria rejeitar uma origem remota'
  )
  pass('validador existente aceita a origem confiável e rejeita origem irmã/remota')

  const fixtureConfig = {
    projectDirs: [],
    activeChatGptAccount: 'account1',
    chatGptAccount1Name: 'Smoke Conta 1',
    chatGptAccount2Name: 'Smoke Conta 2',
    customPaths: {},
  }
  const fixtureProjects = [
    {
      id: 'smoke-project',
      name: 'Smoke Project',
      path: 'C:\\smoke\\project',
      parentDir: 'smoke',
      lastModified: 0,
      techs: [],
      git: {
        isRepo: false,
        branch: '',
        ahead: 0,
        behind: 0,
        hasChanges: false,
        modifiedCount: 0,
        untrackedCount: 0,
      },
    },
  ]
  const invokeCounts = new Map()
  const registerTrustedHandler = (channel, handler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      validation.assertTrustedIpcSender(event, trustedUrl)
      invokeCounts.set(channel, (invokeCounts.get(channel) || 0) + 1)
      return handler(...args)
    })
  }
  registerTrustedHandler('devorbit:getConfig', () => fixtureConfig)
  registerTrustedHandler('devorbit:getProjects', () => fixtureProjects)

  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 600,
    webPreferences: PRODUCTION_WEB_PREFERENCES,
  })

  try {
    await loadPage(window, trustedPage)

    const preferences = window.webContents.getLastWebPreferences() || {}
    assert(preferences.sandbox === true, 'sandbox deveria estar ativo como em produção')
    assert(preferences.contextIsolation === true, 'contextIsolation deveria estar ativo')
    assert(preferences.nodeIntegration === false, 'nodeIntegration deveria estar desativado')
    pass('BrowserWindow usa sandbox/contextIsolation/nodeIntegration de produção')

    const surface = await evaluate(
      window,
      `(() => {
        const api = window.devorbit || {}
        return {
          hasApi: typeof window.devorbit === 'object' && window.devorbit !== null,
          methods: Object.keys(api).filter((key) => typeof api[key] === 'function'),
          nodeRequire: typeof window.require,
        }
      })()`
    )
    assert(surface.hasApi, 'window.devorbit não foi exposto pelo preload real')
    const missing = EXPECTED_METHODS.filter((name) => !surface.methods.includes(name))
    assert(missing.length === 0, `métodos ausentes em window.devorbit: ${missing.join(', ')}`)
    const unexpected = surface.methods.filter((name) => !EXPECTED_METHODS.includes(name))
    assert(unexpected.length === 0, `métodos inesperados em window.devorbit: ${unexpected.join(', ')}`)
    pass(`preload real expôs ${surface.methods.length} métodos em window.devorbit`)
    assert(surface.nodeRequire === 'undefined', 'window.require não deveria existir')
    pass('nodeIntegration permanece desativado no renderer')

    const authorized = await evaluate(
      window,
      `window.devorbit.getConfig()
        .then((value) => ({ ok: true, value }))
        .catch((error) => ({ ok: false, message: String((error && error.message) || error) }))`
    )
    assert(authorized.ok === true, `invoke autorizada falhou: ${authorized.message}`)
    assert(
      authorized.value && authorized.value.chatGptAccount1Name === 'Smoke Conta 1',
      'invoke autorizada retornou payload inesperado'
    )
    assert(invokeCounts.get('devorbit:getConfig') === 1, 'handler autorizado não foi chamado uma vez')
    pass('invoke autorizada via IPC/preload retornou o payload do handler controlado')

    await loadPage(window, untrustedPage)
    const rejected = await evaluate(
      window,
      `window.devorbit.getConfig()
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, message: String((error && error.message) || error) }))`
    )
    assert(rejected.ok === false, 'invoke de origem não confiável deveria ser rejeitada')
    assert(
      /não autorizada/i.test(rejected.message || ''),
      `mensagem de rejeição inesperada: ${rejected.message}`
    )
    pass('origem não confiável foi rejeitada pelo contrato de sender existente')
  } finally {
    if (!window.isDestroyed()) window.destroy()
  }
}

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.on('window-all-closed', (event) => event.preventDefault())

app.whenReady().then(async () => {
  try {
    await main()
    console.log(`IPC smoke passed: ${checks.length} checks`)
    process.exitCode = 0
  } catch (error) {
    console.error('IPC smoke failed')
    console.error(error && error.stack ? error.stack : error)
    process.exitCode = 1
  } finally {
    try {
      fs.rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        console.error('Falha ao limpar o diretório temporário do smoke:', error.message)
      }
    }
    try {
      fs.rmSync(emitRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        console.error('Falha ao limpar o contrato emitido do smoke:', error.message)
      }
    }
    app.quit()
  }
})
