/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
'use strict'

const electron = require('electron')
const { app, BrowserWindow } = electron
const fs = require('node:fs/promises')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const rendererEntry = path.join(projectRoot, 'dist', 'index.html')
const fixturePreload = path.join(__dirname, 'verify-ui-preload.cjs')
const artifactsRoot = path.join(projectRoot, 'artifacts', 'ui')

const viewports = [
  { width: 1366, height: 768, label: '1366x768' },
  { width: 1920, height: 1080, label: '1920x1080' },
]

const checks = []
const rendererErrors = []

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function recordPass(viewport, message) {
  checks.push({ viewport, message, status: 'pass' })
}

async function evaluate(window, expression) {
  return await window.webContents.executeJavaScript(`(${expression})`, true)
}

async function waitFor(window, expression, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await evaluate(window, expression)
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timeout aguardando ${label}`)
}

async function clickButtonByText(window, matcher, label) {
  const found = await evaluate(window, `(function () {
    const match = ${matcher.toString()}
    const buttons = Array.from(document.querySelectorAll('button'))
    const button = buttons.find((node) => match(node))
    if (!button) return false
    button.focus()
    button.click()
    return true
  })()`)
  assert(found, `${label}: botão não encontrado`)
}

async function setInputValue(window, selector, value) {
  const changed = await evaluate(window, `(function () {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  assert(changed, `campo não encontrado (${selector})`)
}

async function setSelectValue(window, selector, value) {
  const changed = await evaluate(window, `(function () {
    const select = document.querySelector(${JSON.stringify(selector)})
    if (!select) return false
    select.value = ${JSON.stringify(value)}
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  assert(changed, `select não encontrado (${selector})`)
}

async function key(window, keyName, options = {}) {
  await evaluate(window, `(function () {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: ${JSON.stringify(keyName)},
      code: ${JSON.stringify(keyName)},
      bubbles: true,
      cancelable: true,
      ctrlKey: ${Boolean(options.ctrlKey)},
      metaKey: ${Boolean(options.metaKey)},
      shiftKey: ${Boolean(options.shiftKey)},
    }))
  })()`)
}

async function screenshot(window, label) {
  const image = await window.webContents.capturePage()
  await fs.writeFile(path.join(artifactsRoot, `${label}.png`), image.toPNG())
}

async function inspectShell(window, viewport) {
  const result = await evaluate(window, `(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector)
      if (!node) return null
      const box = node.getBoundingClientRect()
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }
    }
    const rows = Array.from(document.querySelectorAll('.project-row'))
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
      workspace: rect('.project-workspace'),
      content: rect('.workspace-content'),
      master: rect('.project-master'),
      detail: rect('.project-detail'),
      rows: rows.length,
      rowNames: rows.map((row) => row.innerText),
      noGitRows: rows.filter((row) => row.innerText.includes('Sem repositório')).length,
      pullRows: rows.filter((row) => row.querySelector('[title*="commits para receber"]')).length,
      modifiedRows: rows.filter((row) => row.querySelector('[title="Alterações locais"]')).length,
      longNameRows: rows.filter((row) => row.innerText.includes('Extremely Long Project Name')).length,
      selectedRows: rows.filter((row) => row.matches('.selected,[aria-pressed="true"]')).length,
    }
  })()`)

  assert(result.viewport.width >= 1366 && result.viewport.height >= 768, `${viewport.label}: viewport desktop insuficiente ${JSON.stringify(result.viewport)}`)
  assert(result.document.scrollWidth <= result.viewport.width + 1, `${viewport.label}: overflow horizontal global (${result.document.scrollWidth} > ${result.viewport.width})`)
  assert(result.document.scrollHeight <= result.viewport.height + 1, `${viewport.label}: overflow vertical global (${result.document.scrollHeight} > ${result.viewport.height})`)
  for (const [name, box] of Object.entries({ workspace: result.workspace, content: result.content, master: result.master, detail: result.detail })) {
    assert(box && box.width > 0 && box.height > 0, `${viewport.label}: ${name} não tem área visível`)
    assert(box.left >= -1 && box.right <= result.viewport.width + 1, `${viewport.label}: ${name} sai da viewport (${JSON.stringify(box)})`)
  }
  assert(result.rows >= 30, `${viewport.label}: esperado >=30 projetos, encontrado ${result.rows}`)
  assert(result.noGitRows > 0 && result.pullRows > 0 && result.modifiedRows > 0, `${viewport.label}: fixtures Git incompletas (${JSON.stringify({ noGit: result.noGitRows, pull: result.pullRows, modified: result.modifiedRows })})`)
  assert(result.longNameRows > 0, `${viewport.label}: fixture de nome longo não apareceu`)
  assert(result.selectedRows === 1, `${viewport.label}: seleção inicial inválida (${result.selectedRows})`)
  recordPass(viewport.label, `shell bounded at ${result.viewport.width}×${result.viewport.height}; ${result.rows} project rows; Git fixtures visible`)
}

async function inspectProjectInteractions(window, viewport) {
  const selection = await evaluate(window, `(() => {
    const rows = Array.from(document.querySelectorAll('.project-row'))
    const target = rows[1]
    if (!target) return null
    const expected = target.innerText.split('\\n')[0]
    target.click()
    return expected
  })()`)
  assert(selection, `${viewport.label}: segunda linha não encontrada para seleção`)
  await waitFor(window, `(() => {
    const selected = document.querySelector('.project-row.selected,[aria-pressed="true"]')
    return Boolean(selected && selected.innerText.includes(${JSON.stringify(selection)}))
  })()`, `${viewport.label} seleção de projeto`)
  recordPass(viewport.label, 'project selection updates row and detail state')

  await setInputValue(window, '#project-search', 'Fixture 02 · Pull pending develop')
  await waitFor(window, `document.querySelectorAll('.project-row').length === 1`, `${viewport.label} busca`)
  const searchResult = await evaluate(window, `document.querySelector('.project-row')?.innerText || ''`)
  assert(searchResult.includes('Fixture 02 · Pull pending develop'), `${viewport.label}: busca retornou projeto inesperado (${searchResult})`)
  recordPass(viewport.label, 'project search narrows to the matching fixture')

  await setInputValue(window, '#project-search', '')
  await waitFor(window, `document.querySelectorAll('.project-row').length >= 30`, `${viewport.label} limpeza da busca`)
  await setSelectValue(window, '.project-filters select', 'modified')
  await waitFor(window, `document.querySelectorAll('.project-row').length > 0 && Array.from(document.querySelectorAll('.project-row')).every((row) => row.querySelector('[title="Alterações locais"]'))`, `${viewport.label} filtro Git`)
  recordPass(viewport.label, 'Git status filter shows only local-change fixtures')
  await setSelectValue(window, '.project-filters select', 'all')
  await waitFor(window, `document.querySelectorAll('.project-row').length >= 30`, `${viewport.label} reset do filtro`)
  await screenshot(window, `desktop-${viewport.label}-projects`)
}

async function inspectUsage(window, viewport) {
  await clickButtonByText(window, (node) => /contas e uso/i.test(node.innerText), `${viewport.label} usage navigation`)
  await waitFor(window, `document.body.innerText.includes('Quotas do provedor') && document.querySelectorAll('[role="progressbar"]').length >= 2`, `${viewport.label} usage view`)
  const usage = await evaluate(window, `(() => ({
    hiddenProjects: document.querySelector('.view-panel[hidden]')?.innerText.includes('Projetos') || false,
    realUsage: document.body.innerText.includes('Quotas do provedor'),
    progressbars: document.querySelectorAll('[role="progressbar"]').length,
    connected: document.body.innerText.includes('Codex conectado'),
  }))()`)
  assert(usage.realUsage && usage.progressbars >= 2, `${viewport.label}: usage view incompleta (${JSON.stringify(usage)})`)
  assert(usage.connected, `${viewport.label}: auth fixture não aparece no workspace`)
  recordPass(viewport.label, `usage view visible with ${usage.progressbars} progress bars and auth status`)
  await screenshot(window, `desktop-${viewport.label}-usage`)
}

async function inspectMemory(window, viewport) {
  await clickButtonByText(window, (node) => node.getAttribute('title') === 'Abrir memória de sessão e handoff', `${viewport.label} memory dialog`)
  await waitFor(window, `(() => { const dialog = document.querySelector('[role="dialog"]'); return Boolean(dialog?.querySelector('#ai-memory-dialog-title') && dialog.contains(document.activeElement)) })()`, `${viewport.label} memory dialog focus`)
  const memory = await evaluate(window, `(() => ({
    title: document.querySelector('#ai-memory-dialog-title')?.innerText,
    textarea: Boolean(document.querySelector('#ai-memory-content')),
    lightSurface: getComputedStyle(document.querySelector('[role="dialog"]')).backgroundColor,
  }))()`)
  assert(memory.title === 'Memória e handoff' && memory.textarea, `${viewport.label}: memory dialog incompleto (${JSON.stringify(memory)})`)
  assert(memory.lightSurface === 'rgb(255, 255, 255)', `${viewport.label}: memory dialog não usa superfície clara (${memory.lightSurface})`)
  recordPass(viewport.label, 'memory dialog uses the light system and exposes an editable handoff')
  await screenshot(window, `desktop-${viewport.label}-memory`)
  await key(window, 'Escape')
  await waitFor(window, `!document.querySelector('[role="dialog"] #ai-memory-dialog-title')`, `${viewport.label} memory Escape`)
}

async function inspectSettingsAndPalette(window, viewport) {
  await clickButtonByText(window, (node) => node.getAttribute('title') === 'Configurações', `${viewport.label} settings navigation`)
  await waitFor(window, `(() => { const dialog = document.querySelector('[role="dialog"]'); return Boolean(dialog?.querySelector('#settings-dialog-title') && dialog.contains(document.activeElement)) })()`, `${viewport.label} settings dialog`)
  const settingsFocus = await evaluate(window, `(() => {
    const dialog = document.querySelector('[role="dialog"]')
    return { modal: dialog?.getAttribute('aria-modal'), activeInside: Boolean(dialog && dialog.contains(document.activeElement)), title: document.querySelector('#settings-dialog-title')?.innerText }
  })()`)
  assert(settingsFocus.modal === 'true' && settingsFocus.activeInside, `${viewport.label}: settings focus trap/semantics inválidos (${JSON.stringify(settingsFocus)})`)
  recordPass(viewport.label, 'settings dialog opens with modal semantics and focus inside')
  await screenshot(window, `desktop-${viewport.label}-settings`)
  await key(window, 'Escape')
  await waitFor(window, `!document.querySelector('[role="dialog"] #settings-dialog-title')`, `${viewport.label} settings Escape`)
  await waitFor(window, `document.activeElement?.getAttribute('title') === 'Configurações'`, `${viewport.label} settings focus restore`)
  const restoredSettingsFocus = await evaluate(window, `document.activeElement?.getAttribute('title') || document.activeElement?.getAttribute('aria-label') || ''`)
  assert(restoredSettingsFocus === 'Configurações', `${viewport.label}: settings Escape não restaurou foco (${restoredSettingsFocus})`)
  recordPass(viewport.label, 'settings Escape closes and restores trigger focus')

  await key(window, 'k', { ctrlKey: true })
  await waitFor(window, `Boolean(document.querySelector('[role="dialog"] #command-palette-search'))`, `${viewport.label} command palette`)
  const paletteFocus = await evaluate(window, `(() => {
    const dialog = document.querySelector('[role="dialog"]')
    const input = document.querySelector('#command-palette-search')
    return { activeId: document.activeElement?.id, activeInside: Boolean(dialog && dialog.contains(document.activeElement)), label: document.querySelector('#command-palette-title')?.innerText, options: document.querySelectorAll('[role="option"]').length }
  })()`)
  assert(paletteFocus.activeId === 'command-palette-search' && paletteFocus.activeInside, `${viewport.label}: command palette não moveu foco (${JSON.stringify(paletteFocus)})`)
  assert(paletteFocus.options > 0, `${viewport.label}: command palette sem ações`)
  recordPass(viewport.label, `command palette opens and focuses search with ${paletteFocus.options} options`)
  await screenshot(window, `desktop-${viewport.label}-command-palette`)
  await key(window, 'Escape')
  await waitFor(window, `!document.querySelector('[role="dialog"] #command-palette-search')`, `${viewport.label} palette Escape`)
  await waitFor(window, `document.activeElement?.getAttribute('title') === 'Configurações'`, `${viewport.label} palette focus restore`)
  const restoredPaletteFocus = await evaluate(window, `document.activeElement?.getAttribute('title') || document.activeElement?.getAttribute('aria-label') || ''`)
  assert(restoredPaletteFocus === 'Configurações', `${viewport.label}: palette Escape não restaurou o controle de origem (${restoredPaletteFocus})`)
  recordPass(viewport.label, 'command palette Escape closes and restores origin focus')
}

async function runViewport(viewport) {
  let window
  try {
    window = new BrowserWindow({
      width: viewport.width,
      height: viewport.height,
      show: false,
      useContentSize: true,
      backgroundColor: '#f4f5f7',
      webPreferences: {
        preload: fixturePreload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    window.webContents.on('console-message', (_event, level, message, line, source) => {
      if (level >= 2) rendererErrors.push(`${viewport.label}: console level ${level}: ${message} (${source}:${line})`)
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      rendererErrors.push(`${viewport.label}: renderer gone ${JSON.stringify(details)}`)
    })
    await window.loadFile(rendererEntry)
    await waitFor(window, `Boolean(document.querySelector('.project-workspace') && document.querySelector('.project-row'))`, `${viewport.label} renderer bootstrap`)
    await inspectShell(window, viewport)
    await inspectProjectInteractions(window, viewport)
    await inspectMemory(window, viewport)
    await inspectUsage(window, viewport)
    // Return to projects so the settings trigger lives in the visible shell.
    await clickButtonByText(window, (node) => /projetos/i.test(node.innerText) && node.getAttribute('title') === 'Projetos', `${viewport.label} projects navigation`)
    await waitFor(window, `document.querySelector('.view-panel:not([hidden])')?.innerText.includes('Projetos')`, `${viewport.label} projects navigation restore`)
    await inspectSettingsAndPalette(window, viewport)
  } finally {
    if (window && !window.isDestroyed()) {
      window.destroy()
      // Chromium may still be releasing the file-backed renderer when the
      // next viewport starts. Yield one short turn before opening it again.
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

async function main() {
  assert(process.env.ELECTRON_RUN_AS_NODE !== '1', 'Electron foi iniciado como Node; use `npx electron scripts/verify-ui.cjs`')
  await fs.access(rendererEntry)
  await fs.access(fixturePreload)
  await fs.mkdir(artifactsRoot, { recursive: true })
  for (const viewport of viewports) await runViewport(viewport)
  if (rendererErrors.length) throw new Error(`Erros no renderer:\n${rendererErrors.join('\n')}`)
}

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.on('window-all-closed', (event) => event.preventDefault())
app.whenReady().then(async () => {
  try {
    await main()
    console.log(`UI verification passed: ${checks.length} assertions`)
    for (const check of checks) console.log(`PASS [${check.viewport}] ${check.message}`)
    process.exitCode = 0
  } catch (error) {
    console.error('UI verification failed')
    console.error(error && error.stack ? error.stack : error)
    for (const check of checks) console.log(`PASS [${check.viewport}] ${check.message}`)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
