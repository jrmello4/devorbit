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
    const rows = Array.from(document.querySelectorAll('.project-list .project-row'))
    const strayRows = Array.from(document.querySelectorAll('.other-dirs .project-row'))
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
      strayRows: strayRows.length,
      strayActions: strayRows.filter((row) => row.querySelector('[aria-label^="Adicionar Git"]') && row.querySelector('[aria-label^="Abrir pasta"]')).length,
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
  assert(result.strayRows >= 2 && result.strayActions === result.strayRows, `${viewport.label}: seção Outras pastas incompleta (${JSON.stringify({ stray: result.strayRows, actions: result.strayActions })})`)
  recordPass(viewport.label, `shell bounded at ${result.viewport.width}×${result.viewport.height}; ${result.rows} project rows; ${result.strayRows} stray dirs; Git fixtures visible`)
}

async function inspectProjectInteractions(window, viewport) {
  const selection = await evaluate(window, `(() => {
    const rows = Array.from(document.querySelectorAll('.project-list .project-row'))
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
  const workspaceControls = await evaluate(window, `(() => ({
    openAll: Boolean(document.querySelector('button.workspace-open-all')),
    accountSelect: Boolean(document.querySelector('.work-account-control select')),
    metadata: Boolean(document.querySelector('.detail-project-meta')),
  }))()`)
  assert(workspaceControls.openAll && workspaceControls.accountSelect && workspaceControls.metadata, `${viewport.label}: controles do workspace incompletos (${JSON.stringify(workspaceControls)})`)
  recordPass(viewport.label, 'workspace actions expose integrated environment, project account and metadata')

  await setSelectValue(window, '.work-account-control select', 'account2')
  await waitFor(window, `document.querySelector('.work-account-control select')?.value === 'account2'`, `${viewport.label} account selection`)
  await clickButtonByText(window, (node) => node.classList.contains('workspace-open-all'), `${viewport.label} integrated workspace launch`)
  await waitFor(window, `Boolean(document.querySelector('.integrated-workspace') && document.querySelector('[aria-label="Terminal interno"]') && document.querySelector('[aria-label="Pesquisa web"]'))`, `${viewport.label} integrated workspace view`)
  const workspaceFeatures = await evaluate(window, `(() => ({
    editor: Boolean(document.querySelector('.workspace-editor')),
    editorTabs: document.querySelectorAll('[role="tab"]').length >= 1,
    search: Boolean(document.querySelector('button[title*="Buscar no arquivo"]')),
    symbols: Boolean(document.querySelector('button[title="Mostrar símbolos do arquivo atual"]')),
    diff: Boolean(document.querySelector('button[title="Ver alterações não salvas"]')),
    context: Boolean(document.querySelector('button[title*="Enviar arquivo ao contexto"]')),
    terminalPty: Boolean(document.querySelector('.workspace-terminal-xterm .xterm')),
    browserControls: document.querySelectorAll('.browser-actions button').length === 3,
  }))()`)
  assert(Object.values(workspaceFeatures).every(Boolean), `${viewport.label}: recursos do workspace incompletos (${JSON.stringify(workspaceFeatures)})`)
  recordPass(viewport.label, 'editor com abas/busca/contexto, terminal PTY e controles web visíveis')
  const dirtyEditor = await evaluate(window, `(() => {
    const editor = document.querySelector('textarea.workspace-editor')
    if (!editor || editor.disabled) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(editor, editor.value + String.fromCharCode(10) + '// rascunho de verificacao')
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    editor.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  assert(dirtyEditor, `${viewport.label}: editor indisponível para verificar rascunho`)
  await waitFor(window, `Boolean(document.querySelector('.editor-dirty'))`, `${viewport.label} editor dirty state`)
  await evaluate(window, `(() => {
    window.__devorbitVerifyConfirmCalls = 0
    window.confirm = () => { window.__devorbitVerifyConfirmCalls += 1; return false }
    return true
  })()`)
  await clickButtonByText(window, (node) => node.getAttribute('aria-label') === 'Abrir canvas', `${viewport.label} guarded canvas launch`)
  await waitFor(window, `!document.querySelector('.workspace-canvas')`, `${viewport.label} guarded canvas mode`)
  const modeGuard = await evaluate(window, `({
    confirmCalls: window.__devorbitVerifyConfirmCalls || 0,
    canvas: Boolean(document.querySelector('.workspace-canvas')),
  })`)
  assert(modeGuard.confirmCalls > 0 && !modeGuard.canvas, `${viewport.label}: troca de layout ignorou rascunho (${JSON.stringify(modeGuard)})`)
  recordPass(viewport.label, 'troca de layout confirma rascunhos e preserva o modo atual quando cancelada')
  await evaluate(window, `(() => { window.confirm = () => true; return true })()`)
  const canvasAlreadyOpen = await evaluate(window, `Boolean(document.querySelector('.workspace-canvas'))`)
  if (!canvasAlreadyOpen) await clickButtonByText(window, (node) => node.getAttribute('aria-label') === 'Abrir canvas', `${viewport.label} canvas launch`)
  await waitFor(window, `document.querySelectorAll('.workspace-canvas [data-canvas-card]').length === 3`, `${viewport.label} canvas cards`)
  const canvasCards = await evaluate(window, `Array.from(document.querySelectorAll('.workspace-canvas [data-canvas-card]')).map((node) => node.getAttribute('data-canvas-card')).sort().join(',')`)
  assert(canvasCards === 'browser,notes,workbench', `${viewport.label}: cards do canvas incompletos (${canvasCards})`)
  await waitFor(window, `(() => {
    const viewport = document.querySelector('.workspace-canvas .workspace-web-viewport')
    const boundsCall = Array.from(window.__devorbitVerifyFixture.getCalls()).filter((call) => call.name === 'setWebBounds').at(-1)
    if (!viewport || !boundsCall) return false
    const rect = viewport.getBoundingClientRect()
    const bounds = boundsCall.args[0]
    const canvas = document.querySelector('.workspace-canvas')?.getBoundingClientRect()
    const left = Math.max(0, rect.left, canvas?.left || 0)
    const top = Math.max(0, rect.top, canvas?.top || 0)
    const right = Math.min(window.innerWidth, rect.right, canvas?.right || window.innerWidth)
    const bottom = Math.min(window.innerHeight, rect.bottom, canvas?.bottom || window.innerHeight)
    return Math.abs(bounds.x - Math.round(left)) <= 1 &&
      Math.abs(bounds.y - Math.round(top)) <= 1 &&
      Math.abs(bounds.width - Math.round(Math.max(0, right - left))) <= 1 &&
      Math.abs(bounds.height - Math.round(Math.max(0, bottom - top))) <= 1
  })()`, `${viewport.label} canvas web bounds`)
  recordPass(viewport.label, 'painel web nativo acompanha o viewport atual do canvas')
  await clickButtonByText(window, (node) => node.getAttribute('title') === 'Mostrar ou ocultar navegador', `${viewport.label} canvas web hide`)
  await waitFor(window, `document.querySelectorAll('.workspace-canvas [data-canvas-card]').length === 2 && !document.querySelector('[data-canvas-card="browser"]')`, `${viewport.label} canvas browser hidden`)
  await clickButtonByText(window, (node) => node.getAttribute('title') === 'Mostrar ou ocultar navegador', `${viewport.label} canvas web restore`)
  await waitFor(window, `document.querySelectorAll('.workspace-canvas [data-canvas-card]').length === 3 && document.querySelector('[data-canvas-card="browser"]')`, `${viewport.label} canvas browser restored`)
  recordPass(viewport.label, 'botão Web remove e restaura o cartão do navegador no canvas')
  const terminalIds = await evaluate(window, `Array.from(window.__devorbitVerifyFixture.getCalls())
    .filter((call) => call.name === 'startTerminal' || call.name === 'startCodexTerminal')
    .map((call) => call.args[0])`)
  assert(terminalIds.length >= 2 && new Set(terminalIds).size === 1, `${viewport.label}: terminal perdeu o ID ao trocar para o canvas (${JSON.stringify(terminalIds)})`)
  recordPass(viewport.label, 'canvas reinicia o terminal usando o mesmo identificador de sessão')
  const canvasInteractions = await evaluate(window, `(function () {
    const workbench = document.querySelector('[data-canvas-card="workbench"]')
    const dragHandle = workbench?.querySelector('[data-canvas-drag-handle]')
    if (!workbench || !dragHandle) return false
    const beforeLeft = Number.parseFloat(workbench.style.left)
    const beforeWidth = Number.parseFloat(workbench.style.width)
    dragHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }))
    return { beforeLeft, beforeWidth }
  })()`)
  assert(canvasInteractions, `${viewport.label}: controles de interação do canvas ausentes`)
  await new Promise((resolve) => setTimeout(resolve, 0))
  await evaluate(window, `(() => { window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 132, clientY: 124 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 132, clientY: 124 })); return true })()`)
  await waitFor(window, `Number.parseFloat(document.querySelector('[data-canvas-card="workbench"]').style.left) > ${canvasInteractions.beforeLeft}`, `${viewport.label} canvas drag`)
  await evaluate(window, `(function () {
    const workbench = document.querySelector('[data-canvas-card="workbench"]')
    const resizeHandle = workbench?.querySelector('[data-canvas-resize-handle]')
    if (!resizeHandle) return false
    resizeHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 200 }))
    return true
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 0))
  await evaluate(window, `(() => { window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 246, clientY: 232 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 246, clientY: 232 })); return true })()`)
  await waitFor(window, `Number.parseFloat(document.querySelector('[data-canvas-card="workbench"]').style.width) > ${canvasInteractions.beforeWidth}`, `${viewport.label} canvas resize`)
  await waitFor(window, `(() => {
    const canvas = document.querySelector('.workspace-canvas')
    const id = canvas?.getAttribute('data-canvas-project-id')
    const raw = id ? window.localStorage.getItem('devorbit:workspace-canvas:' + id) : null
    if (!canvas || !raw) return false
    const saved = JSON.parse(raw)
    const card = saved.cards?.find((item) => item.id === 'workbench')
    return card && Number(card.width) === Number.parseFloat(canvas.querySelector('[data-canvas-card="workbench"]').style.width)
  })()`, `${viewport.label} canvas geometry persistence`)
  await evaluate(window, `(function () {
    const note = document.querySelector('[data-canvas-note-editor]')
    if (!note) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(note, 'handoff persistente')
    note.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await waitFor(window, `document.querySelector('[data-canvas-note-editor]').value === 'handoff persistente'`, `${viewport.label} canvas notes`)
  recordPass(viewport.label, 'canvas com cartões, arraste, redimensionamento e notas locais')
  await clickButtonByText(window, (node) => node.getAttribute('aria-label') === 'Voltar ao layout integrado', `${viewport.label} canvas close`)
  await waitFor(window, `!document.querySelector('.workspace-canvas')`, `${viewport.label} grid layout restore`)
  await clickButtonByText(window, (node) => node.getAttribute('title') === 'Projetos', `${viewport.label} multi-project navigation`)
  await waitFor(window, `document.querySelector('.view-panel:not([hidden])')?.innerText.includes('Projetos')`, `${viewport.label} multi-project view`)
  await setInputValue(window, '#project-search', 'Fixture 03')
  await waitFor(window, `document.querySelectorAll('.project-list .project-row').length === 1`, `${viewport.label} multi-project search`)
  await clickButtonByText(window, (node) => node.classList.contains('workspace-open-all'), `${viewport.label} second workspace launch`)
  await waitFor(window, `document.querySelectorAll('.workspace-tabs .workspace-tab').length >= 2`, `${viewport.label} multiple workspace tabs`)
  await evaluate(window, `window.__devorbitVerifyFixture.resetCalls()`)
  await clickButtonByText(window, (node) => node.classList.contains('workspace-tab') && /Fixture 02/.test(node.innerText), `${viewport.label} first workspace tab`)
  await waitFor(window, `document.querySelector('.workspace-tab.active')?.innerText.includes('Fixture 02')`, `${viewport.label} first workspace tab active`)
  const webVisibilityCalls = await evaluate(window, `new Promise((resolve) => {
    window.setTimeout(() => resolve(window.__devorbitVerifyFixture.getCalls()
      .filter((call) => call.name === 'setWebVisible').map((call) => call.args[0])), 50)
  })`)
  assert(webVisibilityCalls.length > 0 && webVisibilityCalls.at(-1) === true, `${viewport.label}: painel web da aba ativa foi ocultado (${JSON.stringify(webVisibilityCalls)})`)
  recordPass(viewport.label, 'multiple projects use workspace tabs with inactive sessions suspended')

  await clickButtonByText(window, (node) => /contas e uso/i.test(node.innerText), `${viewport.label} usage navigation from workspace`)
  await waitFor(window, `document.querySelector('.view-panel:not([hidden])')?.innerText.includes('Quotas do provedor')`, `${viewport.label} usage navigation from workspace`)
  await clickButtonByText(window, (node) => (node.getAttribute('title') || '').startsWith('Ambiente integrado de '), `${viewport.label} workspace restore`)
  await waitFor(window, `Boolean(document.querySelector('.integrated-workspace') && document.querySelector('.integrated-workspace-view:not([hidden])'))`, `${viewport.label} workspace restore`)
  recordPass(viewport.label, 'workspace remains mounted while switching sections')
  await setInputValue(window, '#project-search', 'Fixture 02')
  await waitFor(window, `document.querySelectorAll('.project-list .project-row').length === 1`, `${viewport.label} busca`)
  const searchResult = await evaluate(window, `document.querySelector('.project-list .project-row')?.innerText || ''`)
  assert(searchResult.includes('Fixture 02 · Pull pending develop'), `${viewport.label}: busca retornou projeto inesperado (${searchResult})`)
  recordPass(viewport.label, 'project search narrows to the matching fixture')

  await setInputValue(window, '#project-search', '')
  await waitFor(window, `document.querySelectorAll('.project-list .project-row').length >= 30`, `${viewport.label} limpeza da busca`)
  await setSelectValue(window, '.project-filters select', 'modified')
  await waitFor(window, `document.querySelectorAll('.project-list .project-row').length > 0 && Array.from(document.querySelectorAll('.project-list .project-row')).every((row) => row.querySelector('[title="Alterações locais"]'))`, `${viewport.label} filtro Git`)
  recordPass(viewport.label, 'Git status filter shows only local-change fixtures')
  await setSelectValue(window, '.project-filters select', 'all')
  await waitFor(window, `document.querySelectorAll('.project-list .project-row').length >= 30`, `${viewport.label} reset do filtro`)
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

async function inspectToolHealth(window, viewport) {
  await clickButtonByText(window, (node) => node.getAttribute('title') === 'Diagnosticar ferramentas instaladas', `${viewport.label} tool health navigation`)
  await waitFor(window, `(() => { const dialog = document.querySelector('[role="dialog"]'); return Boolean(dialog?.querySelector('#tool-health-title') && dialog.querySelectorAll('article').length === 7 && dialog.contains(document.activeElement)) })()`, `${viewport.label} tool health dialog`)
  const health = await evaluate(window, `(() => ({
    title: document.querySelector('#tool-health-title')?.innerText,
    tools: document.querySelectorAll('[role="dialog"] article').length,
    missing: Array.from(document.querySelectorAll('[role="dialog"] article')).filter((article) => article.innerText.includes('Não encontrado')).length,
  }))()`)
  assert(health.title === 'Diagnóstico de ferramentas' && health.tools === 7 && health.missing === 1, `${viewport.label}: diagnóstico incompleto (${JSON.stringify(health)})`)
  recordPass(viewport.label, 'tool health dialog lists all launchers and their states')
  await key(window, 'Escape')
  await waitFor(window, `!document.querySelector('[role="dialog"] #tool-health-title')`, `${viewport.label} tool health Escape`)
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
    // Each viewport is a fresh UI run. Clear persisted layout/canvas state
    // before the page initializes so one viewport cannot affect the next.
    await window.webContents.session.clearStorageData({ storages: ['localstorage'] })
    await window.loadFile(rendererEntry)
    await waitFor(window, `Boolean(document.querySelector('.project-workspace') && document.querySelector('.project-row'))`, `${viewport.label} renderer bootstrap`)
    await inspectShell(window, viewport)
    await inspectProjectInteractions(window, viewport)
    await inspectMemory(window, viewport)
    await inspectUsage(window, viewport)
    // Return to projects so the settings trigger lives in the visible shell.
    await clickButtonByText(window, (node) => /projetos/i.test(node.innerText) && node.getAttribute('title') === 'Projetos', `${viewport.label} projects navigation`)
    await waitFor(window, `document.querySelector('.view-panel:not([hidden])')?.innerText.includes('Projetos')`, `${viewport.label} projects navigation restore`)
    await inspectToolHealth(window, viewport)
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
