/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
'use strict'

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const projectRoot = path.resolve(__dirname, '..')
const mainEntry = path.join(projectRoot, 'dist-electron', 'main', 'index.js')
const preloadEntry = path.join(projectRoot, 'dist-electron', 'preload', 'index.cjs')
const rendererEntry = path.join(projectRoot, 'dist', 'index.html')

// O ambiente de validação (RDP/VM/CI) não tem GPU confiável; o Chromium pode
// perder o processo de GPU e falhar o load do file://. Este harness valida
// preload/IPC/scan — não rasterização — então segue o mesmo padrão de
// smoke-ipc, verify-bridge e verify-ui: sem aceleração de hardware.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

const diagnostics = []
app.on('child-process-gone', (_event, details) => {
  diagnostics.push({ kind: 'child-process-gone', details })
})

function trackWindowDiagnostics(target) {
  target.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    diagnostics.push({ kind: 'did-fail-load', code, description, url, isMainFrame: Boolean(isMainFrame) })
  })
  target.webContents.on('render-process-gone', (_event, details) => {
    diagnostics.push({ kind: 'render-process-gone', details })
  })
}

app.on('browser-window-created', (_event, target) => {
  trackWindowDiagnostics(target)
})

function formatDiagnostics() {
  return diagnostics
    .map((entry) => {
      if (entry.kind === 'did-fail-load') {
        return `did-fail-load ${entry.code} ${entry.description} ${entry.url} mainFrame=${entry.isMainFrame}`
      }
      return `${entry.kind} ${JSON.stringify(entry.details)}`
    })
    .join(' | ')
}

function fatalRendererFailure() {
  return diagnostics.find(
    (entry) => entry.kind === 'render-process-gone' || (entry.kind === 'did-fail-load' && entry.isMainFrame)
  )
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await delay(100)
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`Tempo limite aguardando ${label}${detail}`)
}

async function waitForRendererLoad(window) {
  const webContents = window.webContents
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const failure = fatalRendererFailure()
    if (failure) throw new Error(`Renderer não carregou: ${formatDiagnostics()}`)
    if (!webContents.isLoadingMainFrame()) {
      // `did-fail-load` pode chegar logo depois do fim do loading; concede um
      // ciclo curto antes de considerar a carga concluída.
      await delay(200)
      if (fatalRendererFailure()) throw new Error(`Renderer não carregou: ${formatDiagnostics()}`)
      if (!webContents.getURL()) {
        throw new Error(`Renderer terminou a carga sem URL${diagnostics.length ? `; ${formatDiagnostics()}` : ''}`)
      }
      return
    }
    await delay(50)
  }
  throw new Error(`Tempo limite carregando o renderer${diagnostics.length ? `; ${formatDiagnostics()}` : ''}`)
}

async function quitElectron() {
  if (!app.isReady()) return
  await new Promise((resolve) => {
    let settled = false
    let timer
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    app.once('will-quit', finish)
    timer = setTimeout(finish, 5_000)
    app.quit()
  })
}

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-runtime-'))
  const monitoredRoot = path.join(temporaryRoot, 'projects')
  const projectPath = path.join(monitoredRoot, 'runtime-fixture')
  let window

  try {
    await fs.mkdir(projectPath, { recursive: true })
    await fs.writeFile(
      path.join(projectPath, 'README.md'),
      '# Runtime fixture\noriginal\n',
      'utf8'
    )
    await fs.writeFile(
      path.join(projectPath, 'package.json'),
      JSON.stringify({ name: 'runtime-fixture', version: '1.0.0' }, null, 2),
      'utf8'
    )

    app.setPath('userData', temporaryRoot)
    await fs.writeFile(
      path.join(temporaryRoot, 'config.json'),
      JSON.stringify({ projectDirs: [monitoredRoot] }, null, 2),
      'utf8'
    )

    await fs.access(mainEntry)
    await fs.access(preloadEntry)
    await fs.access(rendererEntry)
    // Modo seguro de verificação de runtime: impede auto-refresh de cotas,
    // leitura de credenciais em ~/.codex-conta1/2 e download/spawn do ai-usagebar.
    process.env.DEVORBIT_VERIFY_UI = '1'
    process.env.DEVORBIT_VERIFY_RUNTIME = '1'
    await import(pathToFileURL(mainEntry).href)
    await app.whenReady()

    await waitFor('a janela principal', () => BrowserWindow.getAllWindows().length > 0)
    window = BrowserWindow.getAllWindows()[0]
    await waitForRendererLoad(window)
    window.hide()

    await waitFor('o preload real', async () => {
      return await window.webContents.executeJavaScript('Boolean(window.devorbit)', true)
    })

    const serializedProjectPath = JSON.stringify(projectPath)
    const result = await window.webContents.executeJavaScript(`(async () => {
      const requestedProjectPath = ${serializedProjectPath}
      const config = await window.devorbit.getConfig()
      const projects = await window.devorbit.getProjects()
      const project = projects.find((entry) => entry.name === 'runtime-fixture')
      if (!project) return {
        hasApi: Boolean(window.devorbit),
        configuredRoot: config.projectDirs.includes(${JSON.stringify(monitoredRoot)}),
        projectPath: null,
        projectPaths: projects.map((entry) => entry.path),
      }
      const projectPath = project.path

      const before = await window.devorbit.readProjectFile(projectPath, 'README.md')
      const entries = await window.devorbit.listProjectFiles(projectPath)
      await window.devorbit.saveProjectFile(projectPath, 'README.md', before.content + 'saved\\n')
      const after = await window.devorbit.readProjectFile(projectPath, 'README.md')
      await window.devorbit.createProjectDirectory(projectPath, 'notes')
      await window.devorbit.createProjectFile(projectPath, 'notes/todo.md')
      await window.devorbit.moveProjectEntry(projectPath, 'notes/todo.md', 'TODO.md')
      await window.devorbit.deleteProjectEntry(projectPath, 'notes', { recursive: true })
      await window.devorbit.deleteProjectEntry(projectPath, 'TODO.md')

      let invalidPathRejected = false
      try {
        await window.devorbit.readProjectFile(projectPath, '../outside.txt')
      } catch {
        invalidPathRejected = true
      }

      return {
        hasApi: Boolean(window.devorbit),
        configuredRoot: config.projectDirs.includes(${JSON.stringify(monitoredRoot)}),
        projectPath: project.path,
        projectName: project.name,
        hasReadme: entries.entries.some((entry) => entry.path === 'README.md'),
        before: before.content,
        after: after.content,
        invalidPathRejected,
        mutationsCompleted: true,
      }
    })()`, true)

    if (!result.hasApi) throw new Error('window.devorbit não foi exposto pelo preload real')
    if (!result.configuredRoot) throw new Error('configuração isolada não foi carregada')
    if (!result.projectPath) throw new Error(`projeto temporário não apareceu no scan real: ${JSON.stringify(result.projectPaths)}`)
    if (result.projectName !== 'runtime-fixture') throw new Error('projeto retornado é inesperado')
    if (!result.hasReadme) throw new Error('README.md não apareceu na árvore real')
    if (result.before !== '# Runtime fixture\noriginal\n') throw new Error('leitura real retornou conteúdo inesperado')
    if (result.after !== '# Runtime fixture\noriginal\nsaved\n') throw new Error('gravação real não persistiu')
    if (!result.invalidPathRejected) throw new Error('caminho relativo inválido foi aceito')
    if (!result.mutationsCompleted) throw new Error('operações reais de arquivo não foram concluídas')

    process.stdout.write('Runtime verification passed: preload real, IPC, scan, read, save e validação de caminho\n')
  } catch (error) {
    process.stderr.write(`runtime verification: error ${error instanceof Error ? error.stack || error.message : String(error)}\n`)
    if (diagnostics.length) process.stderr.write(`runtime verification: diagnostics ${formatDiagnostics()}\n`)
    throw error
  } finally {
    await quitElectron()
    await fs.rm(temporaryRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('Runtime verification failed')
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exitCode = 1
})
