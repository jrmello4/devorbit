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
  try {
    return await window.webContents.executeJavaScript(`(${expression})`, true)
  } catch (error) {
    throw new Error(`Renderer evaluation failed: ${expression} (${error && error.message ? error.message : error})`)
  }
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

async function selectCreationProvider(window, role, provider, label) {
  const selector = `[aria-label="Provider do agente ${role}"]`
  await waitFor(window, `(() => {
    const select = document.querySelector(${JSON.stringify(selector)})
    if (!select) return false
    return Array.from(select.options).some((option) => option.value === ${JSON.stringify(provider)} && !option.disabled)
  })()`, `${label} provider ${provider} para ${role}`)
  const selected = await evaluate(window, `(function () {
    const select = document.querySelector(${JSON.stringify(selector)})
    if (!select) return false
    select.value = ${JSON.stringify(provider)}
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  assert(selected, `${label}: não foi possível selecionar ${provider} para ${role}`)
}

async function selectCreationAccount(window, role, account, label) {
  const selector = `input[type="radio"][name="codex-account-${role}"]`
  const index = account === 'account2' ? 1 : 0
  await waitFor(window, `document.querySelectorAll(${JSON.stringify(selector)}).length > ${index}`, `${label} opções de conta para ${role}`)
  const clicked = await evaluate(window, `(function () {
    const radios = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
    const radio = radios[${index}]
    if (!radio) return false
    radio.click()
    return radio.checked
  })()`)
  assert(clicked, `${label}: conta ${account} indisponível para ${role}`)
}

async function enableSquadRole(window, role, label) {
  const clicked = await evaluate(window, `(function () {
    const labelNode = Array.from(document.querySelectorAll('[role="dialog"] label'))
      .find((node) => node.querySelector('input[type="checkbox"]') && node.innerText.includes(${JSON.stringify(role)}))
    const checkbox = labelNode?.querySelector('input[type="checkbox"]')
    if (!checkbox || checkbox.disabled) return false
    if (!checkbox.checked) checkbox.click()
    return checkbox.checked
  })()`)
  assert(clicked, `${label}: papel ${role} não pôde ser marcado no squad`)
}

async function confirmCreationDialog(window, label) {
  await clickButtonByText(window, (node) => Boolean(node.closest('[role="dialog"]')) && /Criar/.test(node.innerText), `${label} confirmação`)
  await waitFor(window, `!document.querySelector('[role="dialog"] #agent-creation-dialog-title')`, `${label} diálogo fechado`)
}


async function verifyCoordinatorOrchestration(window, viewport) {
  const taskContent = 'Tarefa automatizada de ponta a ponta: executar a mudança e validar a entrega.'
  const noteUpdated = await evaluate(window, `(function () {
    const card = Array.from(document.querySelectorAll('.workspace-canvas [data-canvas-card="note"]'))
      .find((node) => node.querySelector('textarea[data-canvas-note-editor][aria-label="Plano da tarefa"]'))
    const editor = card?.querySelector('textarea[data-canvas-note-editor]')
    if (!editor) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(editor, ${JSON.stringify(taskContent)})
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    editor.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  assert(noteUpdated, `${viewport.label}: nota Plano da tarefa não encontrada`)
  await waitFor(window, `Array.from(document.querySelectorAll('textarea[data-canvas-note-editor]')).some((editor) => editor.getAttribute('aria-label') === 'Plano da tarefa' && editor.value === ${JSON.stringify(taskContent)})`, `${viewport.label} tarefa do squad`)
  await waitFor(window, `Array.from(document.querySelectorAll('[aria-label="Provedor do agente"] option')).some((option) => option.value === 'opencode' && !option.disabled)`, `${viewport.label} OpenCode detectado no canvas`)
  const providerChanged = await evaluate(window, `(() => {
    const card = Array.from(document.querySelectorAll('.workspace-canvas [data-canvas-card="agent"]'))
      .find((node) => node.querySelector('select')?.value === 'Implementação')
    const select = card?.querySelector('[aria-label="Provedor do agente"]')
    if (!select) return false
    select.value = 'opencode'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return select.value === 'opencode'
  })()`)
  assert(providerChanged, `${viewport.label}: não foi possível selecionar OpenCode no agente de Implementação`)
  recordPass(viewport.label, 'canvas detecta OpenCode e permite escolher o provedor por agente')

  await evaluate(window, `window.__devorbitVerifyFixture.resetCalls()`)
  const clickedCoordinator = await evaluate(window, `(() => {
    const card = Array.from(document.querySelectorAll('.workspace-canvas [data-canvas-card="agent"]'))
      .find((node) => node.querySelector('select')?.value === 'Coordenador')
    const send = card?.querySelector('[data-agent-send]')
    if (!send || send.disabled) return false
    send.click()
    return true
  })()`)
  assert(clickedCoordinator, `${viewport.label}: botão do Coordenador não encontrado ou desabilitado`)
  await waitFor(window, `Array.from(document.querySelectorAll('[data-agent-send]')).every((button) => button.disabled)`, `${viewport.label} bloqueio de envios manuais durante orquestração`)

  const planning = await waitFor(window, `(() => Array.from(window.__devorbitVerifyFixture.getCalls())
    .filter((call) => call.name === 'writeTerminal')
    .find((call) => String(call.args[1]).includes('Você atua como Coordenador neste projeto') && String(call.args[1]).includes('primeira etapa automática')))()`, `${viewport.label} prompt de planejamento do Coordenador`)
  assert(String(planning.args[1]).includes(taskContent), `${viewport.label}: planejamento não recebeu a nota da tarefa`)

  const emitResult = async (terminalId, result, label, fragmented = false) => {
    if (fragmented) {
      const splitAt = Math.max(1, Math.floor(result.length / 2))
      const firstEvent = JSON.stringify({ id: terminalId, type: 'data', data: `\r\nDEVORBIT_RESULT: ${result.slice(0, splitAt)}` })
      await evaluate(window, `(() => {
        window.__devorbitVerifyFixture.emitTerminalEvent(${firstEvent})
        return true
      })()`)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const premature = await evaluate(window, `Array.from(window.__devorbitVerifyFixture.getCalls())
        .filter((call) => call.name === 'writeTerminal')
        .some((call) => String(call.args[1]).includes('Você atua como Implementação neste projeto'))`)
      assert(!premature, `${viewport.label}: resultado fragmentado avançou antes da quebra de linha`)
      const finalEvent = JSON.stringify({ id: terminalId, type: 'data', data: `${result.slice(splitAt)}\r\n` })
      await evaluate(window, `(() => {
        window.__devorbitVerifyFixture.emitTerminalEvent(${finalEvent})
        return true
      })()`)
      return
    }
    const event = JSON.stringify({ id: terminalId, type: 'data', data: `\r\nDEVORBIT_RESULT: ${result}\r\n` })
    const emitted = await evaluate(window, `(() => {
      window.__devorbitVerifyFixture.emitTerminalEvent(${event})
      return true
    })()`)
    assert(emitted, `${viewport.label}: não foi possível emitir ${label}`)
  }

  const planResult = 'plano coordenado aprovado'
  await emitResult(planning.args[0], planResult, 'o plano', true)
  const implementation = await waitFor(window, `(() => Array.from(window.__devorbitVerifyFixture.getCalls())
    .filter((call) => call.name === 'writeTerminal')
     .find((call) => String(call.args[1]).includes('Você atua como Implementação neste projeto') && String(call.args[1]).includes(${JSON.stringify(planResult)})))()`, `${viewport.label} prompt de Implementação`)
  const implementationStart = await waitFor(window, `(() => Array.from(window.__devorbitVerifyFixture.getCalls())
    .filter((call) => call.name === 'startAgentTerminal')
    .find((call) => call.args[2] === 'opencode'))()`, `${viewport.label} inicialização do OpenCode`)
  assert(implementationStart.args[0] === implementation.args[0], `${viewport.label}: OpenCode iniciou um terminal diferente do agente`)

  const implementationResult = 'implementacao concluida'
  await emitResult(implementation.args[0], implementationResult, 'o resultado da Implementação')
  const review = await waitFor(window, `(() => Array.from(window.__devorbitVerifyFixture.getCalls())
    .filter((call) => call.name === 'writeTerminal')
    .find((call) => String(call.args[1]).includes('Você atua como Revisão neste projeto') && String(call.args[1]).includes(${JSON.stringify(planResult)}) && String(call.args[1]).includes(${JSON.stringify(implementationResult)})))()`, `${viewport.label} prompt de Revisão`)

  const reviewResult = 'revisao aprovada'
  await emitResult(review.args[0], reviewResult, 'o resultado da Revisão')
  const tests = await waitFor(window, `(() => Array.from(window.__devorbitVerifyFixture.getCalls())
    .filter((call) => call.name === 'writeTerminal')
    .find((call) => String(call.args[1]).includes('Você atua como Testes neste projeto') && String(call.args[1]).includes(${JSON.stringify(planResult)}) && String(call.args[1]).includes(${JSON.stringify(implementationResult)}) && String(call.args[1]).includes(${JSON.stringify(reviewResult)})))()`, `${viewport.label} prompt de Testes`)

  const testsResult = 'testes automatizados aprovados'
  await emitResult(tests.args[0], testsResult, 'o resultado dos Testes')
  const finalCoordinator = await waitFor(window, `(() => Array.from(window.__devorbitVerifyFixture.getCalls())
    .filter((call) => call.name === 'writeTerminal')
    .find((call) => String(call.args[1]).includes('Coordenador na etapa final') && String(call.args[1]).includes(${JSON.stringify(planResult)}) && String(call.args[1]).includes(${JSON.stringify(implementationResult)}) && String(call.args[1]).includes(${JSON.stringify(reviewResult)}) && String(call.args[1]).includes(${JSON.stringify(testsResult)})))()`, `${viewport.label} prompt final do Coordenador`)

  await emitResult(finalCoordinator.args[0], 'execucao completa e validada', 'o resultado final')
  await waitFor(window, `Boolean(document.querySelector('.workspace-canvas-orchestration-status[data-orchestration-phase="complete"]'))`, `${viewport.label} conclusão da orquestração`)

  const writes = await evaluate(window, `Array.from(window.__devorbitVerifyFixture.getCalls())
    .filter((call) => call.name === 'writeTerminal')
    .map((call) => ({ id: call.args[0], prompt: String(call.args[1]) }))`)
  const stages = [planning, implementation, review, tests, finalCoordinator]
  const indexes = stages.map((stage) => writes.findIndex((write) => write.id === stage.args[0] && write.prompt === String(stage.args[1])))
  assert(writes.length === stages.length && indexes.every((index) => index >= 0) && indexes.every((index, indexPosition) => indexPosition === 0 || index > indexes[indexPosition - 1]), `${viewport.label}: sequência de prompts inesperada (${JSON.stringify({ writes: writes.length, indexes })})`)
  const status = await evaluate(window, `(() => {
    const node = document.querySelector('.workspace-canvas-orchestration-status')
    return { phase: node?.getAttribute('data-orchestration-phase'), text: node?.innerText || '' }
  })()`)
  assert(status.phase === 'complete' && status.text.includes('conclu'), `${viewport.label}: status final inesperado (${JSON.stringify(status)})`)
  await evaluate(window, `window.__devorbitVerifyFixture.resetCalls()`)
  const blockedRunStarted = await evaluate(window, `(() => {
    const card = Array.from(document.querySelectorAll('.workspace-canvas [data-canvas-card="agent"]'))
      .find((node) => node.querySelector('select')?.value === 'Coordenador')
    const send = card?.querySelector('[data-agent-send]')
    if (!send || send.disabled) return false
    send.click()
    return true
  })()`)
  assert(blockedRunStarted, `${viewport.label}: second coordinator run did not start`)
  const blockedPlanning = await waitFor(window, `Array.from(window.__devorbitVerifyFixture.getCalls())
    .filter((call) => call.name === 'writeTerminal').at(-1)`, `${viewport.label} second coordinator planning`)
  await emitResult(blockedPlanning.args[0], 'BLOQUEADO: dependency missing', 'the agent block')
  await waitFor(window, `document.querySelector('.workspace-canvas-orchestration-status[data-orchestration-phase="blocked"]')`, `${viewport.label} explicit stage block`)
  const writesAfterBlock = await evaluate(window, `window.__devorbitVerifyFixture.getCalls()
    .filter((call) => call.name === 'writeTerminal').length`)
  assert(writesAfterBlock === 1, `${viewport.label}: a blocked result advanced the queue`)
  recordPass(viewport.label, 'BLOQUEADO result stops the queue and shows blocked state')

  await evaluate(window, `window.__devorbitVerifyFixture.resetCalls()`)
  await evaluate(window, `window.__devorbitVerifyFixture.setWriteTerminalFailure(true)`)
  const failedRunStarted = await evaluate(window, `(() => {
    const card = Array.from(document.querySelectorAll('.workspace-canvas [data-canvas-card="agent"]'))
      .find((node) => node.querySelector('select')?.value === 'Coordenador')
    const send = card?.querySelector('[data-agent-send]')
    if (!send || send.disabled) return false
    send.click()
    return true
  })()`)
  assert(failedRunStarted, `${viewport.label}: delivery failure run did not start`)
  await waitFor(window, `document.querySelector('.workspace-canvas-orchestration-status[data-orchestration-phase="blocked"]')`, `${viewport.label} agent delivery failure`)
  await evaluate(window, `window.__devorbitVerifyFixture.setWriteTerminalFailure(false)`)
  recordPass(viewport.label, 'terminal write failure blocks the orchestration')
  recordPass(viewport.label, 'um clique no Coordenador executa planejamento, Implementação, Revisão, Testes e consolidação final')

  // FASE 3 — race real: no backend o marcador chega pelo evento PTY ANTES de
  // sendAgentTurn resolver. O taskId precisa ser registrado antes do await
  // para o listener entregar ao canvas e a fila avançar mesmo assim.
  await evaluate(window, `window.__devorbitVerifyFixture.resetCalls()`)
  const coordinatorProviderChanged = await evaluate(window, `(() => {
    const card = Array.from(document.querySelectorAll('.workspace-canvas [data-canvas-card="agent"]'))
      .find((node) => node.querySelector('select')?.value === 'Coordenador')
    const select = card?.querySelector('[aria-label="Provedor do agente"]')
    if (!select) return false
    select.value = 'opencode'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return select.value === 'opencode'
  })()`)
  assert(coordinatorProviderChanged, `${viewport.label}: não foi possível selecionar OpenCode no Coordenador`)
  await evaluate(window, `window.__devorbitVerifyFixture.setSendAgentTurnResult('plano entregue antes da promessa')`)
  const raceRunStarted = await evaluate(window, `(() => {
    const card = Array.from(document.querySelectorAll('.workspace-canvas [data-canvas-card="agent"]'))
      .find((node) => node.querySelector('select')?.value === 'Coordenador')
    const send = card?.querySelector('[data-agent-send]')
    if (!send || send.disabled) return false
    send.click()
    return true
  })()`)
  assert(raceRunStarted, `${viewport.label}: coordinator race run did not start`)
  const raceAdvance = await waitFor(window, `(() => Array.from(window.__devorbitVerifyFixture.getCalls())
    .filter((call) => call.name === 'writeTerminal')
    .find((call) => String(call.args[1]).includes('Você atua como Implementação neste projeto') && String(call.args[1]).includes('plano entregue antes da promessa')))()`, `${viewport.label} race turn advanced the queue`)
  assert(
    await evaluate(window, `window.__devorbitVerifyFixture.getCalls().some((call) => call.name === 'sendAgentTurn')`),
    `${viewport.label}: race turn não passou por sendAgentTurn`
  )
  recordPass(viewport.label, 'turno não-Codex entrega resultado emitido antes da resolução e avança a fila')
  await emitResult(raceAdvance.args[0], 'BLOQUEADO: encerrando teste de race', 'the race halt')
  await waitFor(window, `document.querySelector('.workspace-canvas-orchestration-status[data-orchestration-phase="blocked"]')`, `${viewport.label} race run halted`)
}

async function verifyManualAgentSend(window, viewport) {
  await evaluate(window, `window.__devorbitVerifyFixture.resetCalls()`)
  const started = await evaluate(window, `(() => {
    const card = Array.from(document.querySelectorAll('.workspace-canvas [data-canvas-card="agent"]'))
      .find((node) => node.querySelector('select')?.value === 'Implementação')
    const send = card?.querySelector('[data-agent-send]')
    if (!send || send.disabled) return false
    send.click()
    return true
  })()`)
  assert(started, `${viewport.label}: envio manual do especialista indisponível`)

  const promptWrite = await waitFor(window, `(() => Array.from(window.__devorbitVerifyFixture.getCalls())
    .filter((call) => call.name === 'writeTerminal')
    .find((call) => String(call.args[1]).includes('Você atua como Implementação neste projeto') && String(call.args[1]).includes('Tarefa automatizada de ponta a ponta')))()`, `${viewport.label} prompt manual do especialista`)

  await evaluate(window, `(() => {
    const card = Array.from(document.querySelectorAll('.workspace-canvas [data-canvas-card="agent"]'))
      .find((node) => node.querySelector('select')?.value === 'Implementação')
    const send = card?.querySelector('[data-agent-send]')
    if (send) send.click()
    return true
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const manualWrites = await evaluate(window, `window.__devorbitVerifyFixture.getCalls()
    .filter((call) => call.name === 'writeTerminal' && String(call.args[1]).includes('Você atua como Implementação neste projeto')).length`)
  assert(manualWrites === 1, `${viewport.label}: envio manual duplicou a tarefa (${manualWrites})`)
  const busyDisabled = await evaluate(window, `(() => {
    const card = Array.from(document.querySelectorAll('.workspace-canvas [data-canvas-card="agent"]'))
      .find((node) => node.querySelector('select')?.value === 'Implementação')
    const send = card?.querySelector('[data-agent-send]')
    return Boolean(send && send.disabled)
  })()`)
  assert(busyDisabled, `${viewport.label}: controle de envio não foi desabilitado durante a tarefa`)
  const runningStatus = await evaluate(window, `(() => {
    const card = Array.from(document.querySelectorAll('.workspace-canvas [data-canvas-card="agent"]'))
      .find((node) => node.querySelector('select')?.value === 'Implementação')
    const chip = card?.querySelector('.canvas-agent-progress')
    return { state: chip?.getAttribute('data-agent-progress') || '', label: chip?.getAttribute('aria-label') || '' }
  })()`)
  assert(runningStatus.state === 'running', `${viewport.label}: status de execução ilegível (${runningStatus.state})`)
  assert(runningStatus.label.includes('Status da tarefa'), `${viewport.label}: status sem rótulo acessível (${runningStatus.label})`)

  const manualEvent = JSON.stringify({ id: promptWrite.args[0], type: 'data', data: '\r\nDEVORBIT_RESULT: {"version":1,"outcome":"completed","summary":"manual concluido"}\r\n' })
  await evaluate(window, `(() => { window.__devorbitVerifyFixture.emitTerminalEvent(${manualEvent}); return true })()`)
  await waitFor(window, `(() => {
    const card = Array.from(document.querySelectorAll('.workspace-canvas [data-canvas-card="agent"]'))
      .find((node) => node.querySelector('select')?.value === 'Implementação')
    const send = card?.querySelector('[data-agent-send]')
    return Boolean(send && !send.disabled)
  })()`, `${viewport.label} reabilitacao do envio manual`)
  const completedStatus = await evaluate(window, `(() => {
    const card = Array.from(document.querySelectorAll('.workspace-canvas [data-canvas-card="agent"]'))
      .find((node) => node.querySelector('select')?.value === 'Implementação')
    return card?.querySelector('.canvas-agent-progress')?.getAttribute('data-agent-progress') || ''
  })()`)
  assert(completedStatus === 'completed', `${viewport.label}: status final do especialista inesperado (${completedStatus})`)
  recordPass(viewport.label, 'nota conectada é enviada uma vez ao especialista e o envio reabilita após o resultado')
}

async function verifyAgentConfigDetails(window, viewport) {
  const opened = await evaluate(window, `(() => {
    const card = document.querySelector('.workspace-canvas [data-canvas-card="agent"]')
    const toggle = card?.querySelector('.canvas-agent-config-toggle')
    if (!toggle) return false
    toggle.click()
    return true
  })()`)
  assert(opened, `${viewport.label}: botão de configuração do agente ausente`)
  await waitFor(window, `(() => {
    const panel = document.querySelector('.canvas-agent-config')
    return Boolean(panel && !panel.hidden && panel.querySelectorAll('select').length === 3)
  })()`, `${viewport.label} painel de configuração do agente`)
  const details = await evaluate(window, `(() => {
    const card = document.querySelector('.workspace-canvas [data-canvas-card="agent"]')
    const toggle = card?.querySelector('.canvas-agent-config-toggle')
    return {
      expanded: toggle?.getAttribute('aria-expanded') || '',
      role: card?.querySelector('.canvas-node-meta')?.textContent || '',
      labels: Array.from(document.querySelectorAll('.canvas-agent-config select')).map((select) => select.getAttribute('aria-label') || ''),
    }
  })()`)
  assert(details.expanded === 'true', `${viewport.label}: toggle de configuração sem aria-expanded`)
  assert(details.role.includes('Implementação'), `${viewport.label}: papel do agente ilegível (${details.role})`)
  assert(details.labels.includes('Provedor do agente') && details.labels.includes('Conta Codex'), `sem campos de provider/conta no painel (${details.labels.join(', ')})`)
  await evaluate(window, `document.querySelector('.canvas-agent-config-toggle')?.click()`)
  await waitFor(window, `document.querySelector('.canvas-agent-config')?.hidden === true`, `${viewport.label} painel de configuração fechado`)
  recordPass(viewport.label, 'detalhes de configuração do agente acessíveis, rotulados e fecháveis')
}

async function verifySquadLayer(window, viewport) {
  await waitFor(window, `Boolean(document.querySelector('.canvas-squad-region'))`, `${viewport.label} região de squad`)
  const layer = await evaluate(window, `(() => {
    const region = document.querySelector('.canvas-squad-region')
    const label = region?.querySelector('.canvas-squad-region-label')?.textContent || ''
    const coordinator = Array.from(document.querySelectorAll('.workspace-canvas [data-canvas-card="agent"]'))
      .find((node) => node.querySelector('select')?.value === 'Coordenador')
    const meta = coordinator?.querySelector('.canvas-node-meta')?.textContent || ''
    const mark = coordinator?.querySelector('.canvas-command-mark')
    const regionRect = region?.getBoundingClientRect()
    const cardRect = coordinator?.getBoundingClientRect()
    const canvasRect = document.querySelector('.workspace-canvas')?.getBoundingClientRect()
    let topHitIsCard = false
    if (cardRect && canvasRect) {
      const left = (Math.max(cardRect.left, canvasRect.left) + Math.min(cardRect.right, canvasRect.right)) / 2
      const top = (Math.max(cardRect.top, canvasRect.top) + Math.min(cardRect.bottom, canvasRect.bottom)) / 2
      const hit = document.elementFromPoint(left, top)
      topHitIsCard = Boolean(hit && hit.closest('[data-canvas-card]'))
    }
    return {
      label,
      pointerEvents: region ? getComputedStyle(region).pointerEvents : '',
      meta,
      commandMark: Boolean(mark && mark.getAttribute('aria-label') === 'Coordenador'),
      containsCoordinator: Boolean(regionRect && cardRect && regionRect.left <= cardRect.left && regionRect.top <= cardRect.top && regionRect.right >= cardRect.right && regionRect.bottom >= cardRect.bottom),
      topHitIsCard,
    }
  })()`)
  assert(layer.label.includes('SQUAD ·'), `${viewport.label}: rótulo de squad ausente (${layer.label})`)
  assert(layer.pointerEvents === 'none', `${viewport.label}: região de squad intercepta o ponteiro (${layer.pointerEvents})`)
  assert(layer.meta.includes('Coordenador'), `${viewport.label}: papel do coordenador ilegível (${layer.meta})`)
  assert(layer.commandMark, `${viewport.label}: coordenador sem indicador de comando`)
  assert(layer.containsCoordinator, `${viewport.label}: região de squad não cobre o coordenador`)
  assert(layer.topHitIsCard, `${viewport.label}: hit testing do nó afetado pela região de squad (${JSON.stringify(layer)})`)
  recordPass(viewport.label, 'squad em região sutil atrás dos nós com coordenador identificável')
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
  window.webContents.invalidate()
  await new Promise((resolve) => setTimeout(resolve, 120))
  await window.webContents.capturePage()
  await window.webContents.invalidate()
  await new Promise((resolve) => setTimeout(resolve, 120))
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
    const groups = Array.from(document.querySelectorAll('.project-group'))
    const groupLabels = Array.from(document.querySelectorAll('.project-group-label')).map((node) => node.innerText)
    const collapsedGroups = Array.from(document.querySelectorAll('.project-group-items[hidden]')).length
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
      workspace: rect('.project-workspace'),
      content: rect('.workspace-content'),
      master: rect('.project-master'),
      list: rect('.project-list'),
      rows: rows.length,
      rowNames: rows.map((row) => row.innerText),
      noGitRows: rows.filter((row) => row.innerText.includes('Sem repositório')).length,
      pullRows: rows.filter((row) => row.querySelector('[title*="commits para receber"]')).length,
      modifiedRows: rows.filter((row) => row.querySelector('[title="Alterações locais"]')).length,
      longNameRows: rows.filter((row) => row.innerText.includes('Extremely Long Project Name')).length,
      selectedRows: rows.filter((row) => row.matches('.selected,[aria-pressed="true"]')).length,
      groups: groups.length,
      groupLabels,
      collapsedGroups,
      strayRows: strayRows.length,
      strayActions: strayRows.filter((row) => row.querySelector('[aria-label^="Adicionar Git"]') && row.querySelector('[aria-label^="Abrir pasta"]')).length,
      theme: (() => {
        const rootStyle = getComputedStyle(document.documentElement)
        const titlebar = document.querySelector('.app-titlebar')
        const sidebar = document.querySelector('.workspace-sidebar')
        return {
          mode: document.documentElement.dataset.theme || '',
          accent: rootStyle.getPropertyValue('--color-accent').trim(),
          bodyBg: getComputedStyle(document.body).backgroundColor,
          titlebarBg: titlebar ? getComputedStyle(titlebar).backgroundColor : '',
          sidebarBg: sidebar ? getComputedStyle(sidebar).backgroundColor : '',
        }
      })(),
    }
  })()`)

  assert(result.viewport.width >= 1366 && result.viewport.height >= 768, `${viewport.label}: viewport desktop insuficiente ${JSON.stringify(result.viewport)}`)
  assert(result.document.scrollWidth <= result.viewport.width + 1, `${viewport.label}: overflow horizontal global (${result.document.scrollWidth} > ${result.viewport.width})`)
  assert(result.document.scrollHeight <= result.viewport.height + 1, `${viewport.label}: overflow vertical global (${result.document.scrollHeight} > ${result.viewport.height})`)
  for (const [name, box] of Object.entries({ workspace: result.workspace, content: result.content, master: result.master, list: result.list })) {
    assert(box && box.width > 0 && box.height > 0, `${viewport.label}: ${name} não tem área visível`)
    assert(box.left >= -1 && box.right <= result.viewport.width + 1, `${viewport.label}: ${name} sai da viewport (${JSON.stringify(box)})`)
  }
  assert(result.rows >= 30, `${viewport.label}: esperado >=30 projetos, encontrado ${result.rows}`)
  assert(result.groups >= 4, `${viewport.label}: esperado >=4 grupos por pasta pai, encontrado ${result.groups}`)
  assert(result.groupLabels.some((label) => label.includes('alpha-squad')), `${viewport.label}: grupo alpha-squad ausente (${JSON.stringify(result.groupLabels)})`)
  assert(result.collapsedGroups === 0, `${viewport.label}: grupos deveriam abrir expandidos (${result.collapsedGroups})`)
  assert(result.noGitRows > 0 && result.pullRows > 0 && result.modifiedRows > 0, `${viewport.label}: fixtures Git incompletas (${JSON.stringify({ noGit: result.noGitRows, pull: result.pullRows, modified: result.modifiedRows })})`)
  assert(result.longNameRows > 0, `${viewport.label}: fixture de nome longo não apareceu`)
  assert(result.selectedRows === 1, `${viewport.label}: seleção inicial inválida (${result.selectedRows})`)
  assert(result.strayRows >= 2 && result.strayActions === result.strayRows, `${viewport.label}: seção Outras pastas incompleta (${JSON.stringify({ stray: result.strayRows, actions: result.strayActions })})`)
  assert(result.theme.mode === 'light', `${viewport.label}: tema padrão deveria ser claro (${result.theme.mode})`)
  assert(result.theme.accent === '#5b6b86', `${viewport.label}: acento neutro Carbon ausente (${result.theme.accent})`)
  assert(result.theme.bodyBg === 'rgb(244, 245, 247)', `${viewport.label}: fundo da página fora do Carbon claro (${result.theme.bodyBg})`)
  assert(result.theme.titlebarBg === 'rgb(251, 251, 252)', `${viewport.label}: titlebar fora do Carbon claro (${result.theme.titlebarBg})`)
  assert(result.theme.sidebarBg === 'rgb(238, 240, 243)', `${viewport.label}: sidebar fora do Carbon claro (${result.theme.sidebarBg})`)
  recordPass(viewport.label, `shell bounded at ${result.viewport.width}×${result.viewport.height}; ${result.rows} project rows; ${result.groups} parent groups; ${result.strayRows} stray dirs; Git fixtures visible; Carbon claro sem verde legado`)
}

async function inspectDarkTheme(window, viewport) {
  await clickButtonByText(window, (node) => node.getAttribute('aria-label') === 'Ativar tema escuro', `${viewport.label} dark theme toggle`)
  await waitFor(window, `document.documentElement.dataset.theme === 'dark'`, `${viewport.label} dark theme applied`)
  const dark = await evaluate(window, `(() => {
    const rootStyle = getComputedStyle(document.documentElement)
    const titlebar = document.querySelector('.app-titlebar')
    return {
      mode: document.documentElement.dataset.theme || '',
      accent: rootStyle.getPropertyValue('--color-accent').trim(),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      titlebarBg: titlebar ? getComputedStyle(titlebar).backgroundColor : '',
    }
  })()`)
  assert(dark.mode === 'dark', `${viewport.label}: tema escuro não aplicou (${dark.mode})`)
  assert(dark.accent === '#8797b4', `${viewport.label}: acento Carbon escuro ausente (${dark.accent})`)
  assert(dark.bodyBg === 'rgb(13, 15, 20)', `${viewport.label}: fundo escuro fora do Carbon (${dark.bodyBg})`)
  assert(dark.titlebarBg === 'rgb(17, 20, 27)', `${viewport.label}: titlebar escura fora do Carbon (${dark.titlebarBg})`)
  await screenshot(window, `desktop-${viewport.label}-dark`)
  await clickButtonByText(window, (node) => node.getAttribute('aria-label') === 'Ativar tema claro', `${viewport.label} light theme toggle`)
  await waitFor(window, `document.documentElement.dataset.theme === 'light'`, `${viewport.label} light theme restored`)
  recordPass(viewport.label, 'tema escuro Carbon aplicado e tema claro restaurado')
}

async function inspectAudit(window, viewport) {
  await clickButtonByText(window, (node) => node.getAttribute('title') === 'Auditoria', `${viewport.label} audit navigation`)
  await waitFor(window, `Boolean(document.querySelector('.view-panel:not([hidden]) .evolution-dashboard'))`, `${viewport.label} audit dashboard`)
  const auditProbe = await evaluate(window, `(async () => {
    let findings = -1
    let error = ''
    try {
      const snapshot = await window.devorbit.getProjectAudit('fixture-probe')
      findings = Array.isArray(snapshot.findings) ? snapshot.findings.length : -1
    } catch (probeError) {
      error = String((probeError && probeError.message) || probeError)
    }
    return {
      entries: document.querySelectorAll('.evolution-entry').length,
      hasMethod: typeof window.devorbit.getProjectAudit,
      findings,
      error,
    }
  })()`)
  assert(auditProbe.entries >= 24, `${viewport.label}: auditoria não listou os itens (${JSON.stringify(auditProbe)})`)
  const audit = await evaluate(window, `(() => {
    const dashboard = document.querySelector('.evolution-dashboard')
    const entries = Array.from(document.querySelectorAll('.evolution-entry'))
    const debtSection = document.querySelector('#audit-section-debt')?.closest('.evolution-entry-section')
    const badge = debtSection?.querySelector('.evolution-count-badge')
    const chips = document.querySelectorAll('.evolution-severity-filter button')
    const scrollHeight = dashboard.scrollHeight
    const clientHeight = dashboard.clientHeight
    dashboard.scrollTop = dashboard.scrollHeight
    const last = entries[entries.length - 1]
    const lastRect = last.getBoundingClientRect()
    const box = dashboard.getBoundingClientRect()
    return {
      total: entries.length,
      debtCount: Number((badge?.textContent || '0').trim()),
      chips: chips.length,
      internalScroll: scrollHeight > clientHeight + 1,
      globalScroll: document.documentElement.scrollHeight > window.innerHeight + 1,
      lastReachable: lastRect.bottom > box.top - 1 && lastRect.top < box.bottom + 1,
      plainText: dashboard.innerText,
    }
  })()`)
  assert(audit.total >= 24, `${viewport.label}: auditoria escondeu itens (${audit.total})`)
  assert(audit.debtCount >= 24, `${viewport.label}: contador de problemas divergente (${audit.debtCount})`)
  assert(audit.chips >= 5, `${viewport.label}: filtro por gravidade ausente (${audit.chips})`)
  assert(audit.internalScroll, `${viewport.label}: auditoria sem rolagem interna própria`)
  assert(!audit.globalScroll, `${viewport.label}: auditoria depende de rolagem global`)
  assert(audit.lastReachable, `${viewport.label}: último item da auditoria inalcançável`)
  assert(!/Spans IPC|fórmula visível|Visão explicável/.test(audit.plainText), `${viewport.label}: auditoria ainda expõe jargão técnico`)
  await clickButtonByText(window, (node) => (node.textContent || '').startsWith('Críticos'), `${viewport.label} audit severity filter`)
  await waitFor(window, `document.querySelectorAll('.evolution-entry').length === 3`, `${viewport.label} audit critical filter`)
  await clickButtonByText(window, (node) => (node.textContent || '').startsWith('Todos'), `${viewport.label} audit severity reset`)
  await waitFor(window, `document.querySelectorAll('.evolution-entry').length >= 24`, `${viewport.label} audit filter reset`)
  await screenshot(window, `desktop-${viewport.label}-audit`)
  recordPass(viewport.label, 'auditoria lista todos os itens com rolagem interna, filtro por gravidade e texto claro')
}

async function inspectProjectInteractions(window, viewport) {
  const selection = await evaluate(window, `(() => {
    const rows = Array.from(document.querySelectorAll('.project-list .project-row'))
    const target = rows[1]
    if (!target) return null
    const expected = target.querySelector('strong')?.innerText?.trim() || target.innerText.split('\\n')[0].trim()
    target.click()
    return expected
  })()`)
  assert(selection, `${viewport.label}: segunda linha não encontrada para seleção`)
  await waitFor(window, `Boolean(document.querySelector('.project-list .project-row.selected, .project-list .project-row[aria-pressed="true"]'))`, `${viewport.label} seleção de projeto`)
  const selectedText = await evaluate(window, `document.querySelector('.project-list .project-row.selected, .project-list .project-row[aria-pressed="true"]')?.innerText || ''`)
  assert(selectedText.includes(selection), `${viewport.label}: seleção de projeto divergente (${JSON.stringify({ selection, selectedText })})`)
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
  await evaluate(window, `(() => {
    const prompts = ['notes.md', 'renamed-notes.md']
    window.prompt = () => prompts.shift() || null
    window.confirm = () => true
    return true
  })()`)
  await clickButtonByText(window, (node) => node.getAttribute('aria-label') === 'Novo arquivo', `${viewport.label} create file`)
  await waitFor(window, `window.__devorbitVerifyFixture.getCalls().some((call) => call.name === 'createProjectFile' && call.args[1] === 'notes.md')`, `${viewport.label} create file IPC`)
  await waitFor(window, `!document.querySelector('button[aria-label="Renomear ou mover item"]')?.disabled`, `${viewport.label} created file selected`)
  await clickButtonByText(window, (node) => node.getAttribute('aria-label') === 'Renomear ou mover item', `${viewport.label} move file`)
  await waitFor(window, `window.__devorbitVerifyFixture.getCalls().some((call) => call.name === 'moveProjectEntry' && call.args[1] === 'notes.md' && call.args[2] === 'renamed-notes.md')`, `${viewport.label} move file IPC`)
  await evaluate(window, `(() => { document.querySelector('.workspace-file-row[title="src"]')?.click(); return true })()`)
  await waitFor(window, `!document.querySelector('button[aria-label="Excluir item"]')?.disabled`, `${viewport.label} directory selected`)
  await clickButtonByText(window, (node) => node.getAttribute('aria-label') === 'Excluir item', `${viewport.label} delete directory`)
  await waitFor(window, `window.__devorbitVerifyFixture.getCalls().some((call) => call.name === 'deleteProjectEntry' && call.args[1] === 'src' && call.args[2]?.recursive === true)`, `${viewport.label} delete directory IPC`)
  recordPass(viewport.label, 'editor cria, move e exclui itens por IPC com confirmação')
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
  const canvasBeforeToggle = await evaluate(window, `Boolean(document.querySelector('.workspace-canvas'))`)
  await clickButtonByText(window, (node) => node.getAttribute('aria-label') === 'Abrir canvas' || node.getAttribute('aria-label') === 'Voltar ao layout integrado', `${viewport.label} canvas launch with preserved drafts`)
  await waitFor(window, `Boolean(document.querySelector('.workspace-canvas')) !== ${canvasBeforeToggle ? 'true' : 'false'}`, `${viewport.label} canvas mode transition`)
  const draftPreserved = await evaluate(window, `Boolean(document.querySelector('.editor-dirty'))`)
  assert(draftPreserved, `${viewport.label}: rascunho do editor não foi preservado ao alternar layout`)
  recordPass(viewport.label, 'troca de layout preserva rascunhos e terminal sem interrupção por diálogo')
  const canvasAlreadyOpen = await evaluate(window, `Boolean(document.querySelector('.workspace-canvas'))`)
  if (!canvasAlreadyOpen) await clickButtonByText(window, (node) => node.getAttribute('aria-label') === 'Abrir canvas', `${viewport.label} canvas launch`)
  await waitFor(window, `document.querySelectorAll('.workspace-canvas [data-canvas-card]').length === 3`, `${viewport.label} canvas cards`)
  const canvasCards = await evaluate(window, `Array.from(document.querySelectorAll('.workspace-canvas [data-canvas-card]')).map((node) => node.getAttribute('data-canvas-card')).sort().join(',')`)
  assert(canvasCards === 'browser,note,workbench', `${viewport.label}: cards do canvas incompletos (${canvasCards})`)
  const focusMode = await evaluate(window, `(() => {
    const hidden = (selector) => { const node = document.querySelector(selector); return !node || node.offsetParent === null }
    return {
      titlebar: hidden('.app-titlebar'),
      sidebar: hidden('.workspace-sidebar'),
      tabs: hidden('.workspace-tabs'),
      statusbar: hidden('.app-statusbar'),
      toolbar: hidden('.integrated-toolbar'),
      controls: Boolean(document.querySelector('.canvas-focus-controls')),
      canvasWidth: document.querySelector('.workspace-canvas')?.getBoundingClientRect().width || 0,
      viewportWidth: window.innerWidth,
    }
  })()`)
  assert(focusMode.titlebar && focusMode.sidebar && focusMode.tabs && focusMode.statusbar, `${viewport.label}: modo canvas manteve o chrome usual (${JSON.stringify(focusMode)})`)
  assert(focusMode.toolbar, `${viewport.label}: toolbar do ambiente ainda visível no modo canvas`)
  assert(focusMode.controls, `${viewport.label}: controles mínimos do canvas ausentes`)
  assert(focusMode.canvasWidth > focusMode.viewportWidth - 40, `${viewport.label}: canvas não ocupou o espaço dedicado (${focusMode.canvasWidth}/${focusMode.viewportWidth})`)
  recordPass(viewport.label, 'modo dedicado do canvas esconde o chrome e mantém controles mínimos acessíveis')
  const canvasVisible = await evaluate(window, `(() => {
    const panel = document.querySelector('.integrated-workspace-view')
    const canvas = document.querySelector('.workspace-canvas')
    if (!panel || panel.hidden || !canvas) return false
    const rect = canvas.getBoundingClientRect()
    return rect.width > 100 && rect.height > 100 && canvas.offsetParent !== null
  })()`)
  assert(canvasVisible, `${viewport.label}: canvas montado mas não visível para interação`)
  recordPass(viewport.label, 'canvas ativo e visível para interação real')
  const canvasTheme = await evaluate(window, `(() => {
    const canvas = document.querySelector('.workspace-canvas')
    const cards = Array.from(document.querySelectorAll('.workspace-canvas-card'))
    const backgrounds = cards.map((card) => getComputedStyle(card).backgroundColor)
    return {
      canvas: getComputedStyle(canvas).backgroundColor,
      uniqueCardBackgrounds: new Set(backgrounds).size,
    }
  })()`)
  assert(canvasTheme.canvas === 'rgb(8, 9, 12)', `${viewport.label}: canvas fora do Carbon esperado (${canvasTheme.canvas})`)
  assert(canvasTheme.uniqueCardBackgrounds === 1, `${viewport.label}: nós não compartilham família neutra (${canvasTheme.uniqueCardBackgrounds} fundos)`)
  recordPass(viewport.label, 'canvas usa base Carbon e família neutra de nós')
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
  // FASE 2: o projeto abre direto no canvas; pode haver 1 start (sem toggle)
  // ou 2+ (grid -> canvas). O invariante é o mesmo ID de sessão.
  assert(terminalIds.length >= 1 && new Set(terminalIds).size === 1, `${viewport.label}: terminal perdeu o ID ao trocar para o canvas (${JSON.stringify(terminalIds)})`)
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
  const headerDrag = await evaluate(window, `(function () {
    const workbench = document.querySelector('[data-canvas-card="workbench"]')
    const header = workbench?.querySelector('header strong')
    if (!workbench || !header) return false
    const beforeTop = Number.parseFloat(workbench.style.top)
    header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 31, clientX: 220, clientY: 120 }))
    return { beforeTop }
  })()`)
  assert(headerDrag, `${viewport.label}: cabeçalho arrastável do canvas ausente`)
  await evaluate(window, `(() => { window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 31, clientX: 220, clientY: 164 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 31, clientX: 220, clientY: 164 })); return true })()`)
  await waitFor(window, `Number.parseFloat(document.querySelector('[data-canvas-card="workbench"]').style.top) > ${headerDrag.beforeTop}`, `${viewport.label} canvas header drag`)
  recordPass(viewport.label, 'cabeçalho inteiro move o quadro no canvas')

  const groupSelection = await evaluate(window, `(function () {
    const workbench = document.querySelector('[data-canvas-card="workbench"]')
    const note = document.querySelector('[data-canvas-card="note"]')
    const noteHeader = note?.querySelector('header strong')
    if (!workbench || !note || !noteHeader) return false
    noteHeader.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 33, ctrlKey: true, clientX: 820, clientY: 120 }))
    noteHeader.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 33, ctrlKey: true, clientX: 820, clientY: 120 }))
    return true
  })()`)
  assert(groupSelection, `${viewport.label}: cabeçalhos para seleção múltipla ausentes`)
  await waitFor(window, `document.querySelectorAll('.workspace-canvas-card.is-selected').length === 2`, `${viewport.label} canvas multi selection`)
  const groupDrag = await evaluate(window, `(function () {
    const workbench = document.querySelector('[data-canvas-card="workbench"]')
    const note = document.querySelector('[data-canvas-card="note"]')
    const header = workbench?.querySelector('header strong')
    if (!workbench || !note || !header) return false
    const before = { workbench: Number.parseFloat(workbench.style.left), note: Number.parseFloat(note.style.left) }
    header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 34, clientX: 220, clientY: 164 }))
    return { before }
  })()`)
  assert(groupDrag, `${viewport.label}: arraste da seleção múltipla indisponível`)
  await evaluate(window, `(() => { window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 34, clientX: 260, clientY: 164 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 34, clientX: 260, clientY: 164 })); return true })()`)
  await waitFor(window, `(() => { const workbench = document.querySelector('[data-canvas-card="workbench"]'); const note = document.querySelector('[data-canvas-card="note"]'); return Number.parseFloat(workbench.style.left) > ${groupDrag.before.workbench} && Number.parseFloat(note.style.left) > ${groupDrag.before.note} })()`, `${viewport.label} canvas group drag`)
  recordPass(viewport.label, 'Ctrl seleciona vários quadros e o arraste move o grupo')

  const viewportBeforePan = await evaluate(window, `(function () {
    const canvas = document.querySelector('.workspace-canvas')
    const world = document.querySelector('.workspace-canvas-world')
    const id = canvas?.getAttribute('data-canvas-project-id')
    const saved = id ? JSON.parse(window.localStorage.getItem('devorbit:workspace-canvas:' + id)) : null
    if (!world || !saved) return false
    world.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 32, clientX: 1180, clientY: 690 }))
    return saved.viewport
  })()`)
  assert(viewportBeforePan, `${viewport.label}: viewport do canvas indisponível`)
  await evaluate(window, `(() => { window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 32, clientX: 1220, clientY: 720 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 32, clientX: 1220, clientY: 720 })); return true })()`)
  await waitFor(window, `(() => { const canvas = document.querySelector('.workspace-canvas'); const raw = window.localStorage.getItem('devorbit:workspace-canvas:' + canvas.getAttribute('data-canvas-project-id')); const viewport = JSON.parse(raw).viewport; return viewport.x > ${viewportBeforePan.x} && viewport.y > ${viewportBeforePan.y} })()`, `${viewport.label} canvas blank pan`)

  const wheelNavigation = await evaluate(window, `(function () {
    const canvas = document.querySelector('.workspace-canvas')
    const id = canvas?.getAttribute('data-canvas-project-id')
    const before = id ? JSON.parse(window.localStorage.getItem('devorbit:workspace-canvas:' + id)).viewport : null
    if (!canvas || !before) return false
    canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 16, deltaY: 24 }))
    return { id, before }
  })()`)
  assert(wheelNavigation, `${viewport.label}: navegação por roda indisponível`)
  await waitFor(window, `(() => { const viewport = JSON.parse(window.localStorage.getItem('devorbit:workspace-canvas:${wheelNavigation.id}')).viewport; return viewport.x === ${wheelNavigation.before.x - 16} && viewport.y === ${wheelNavigation.before.y - 24} })()`, `${viewport.label} canvas wheel pan`)

  const cursorZoom = await evaluate(window, `(function () {
    const canvas = document.querySelector('.workspace-canvas')
    const id = canvas?.getAttribute('data-canvas-project-id')
    const before = id ? JSON.parse(window.localStorage.getItem('devorbit:workspace-canvas:' + id)).viewport : null
    if (!canvas || !before) return false
    const rect = canvas.getBoundingClientRect()
    const clientX = rect.left + rect.width * .7
    const clientY = rect.top + rect.height * .6
    const localX = clientX - rect.left
    const localY = clientY - rect.top
    const worldX = (localX - before.x) / before.zoom
    const worldY = (localY - before.y) / before.zoom
    canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -120, clientX, clientY }))
    return { id, beforeZoom: before.zoom, localX, localY, worldX, worldY }
  })()`)
  assert(cursorZoom, `${viewport.label}: zoom do canvas indisponível`)
  await waitFor(window, `JSON.parse(window.localStorage.getItem('devorbit:workspace-canvas:${cursorZoom.id}')).viewport.zoom > ${cursorZoom.beforeZoom}`, `${viewport.label} canvas cursor zoom`)
  const cursorZoomAfter = await evaluate(window, `(() => { const viewport = JSON.parse(window.localStorage.getItem('devorbit:workspace-canvas:${cursorZoom.id}')).viewport; return { viewport, worldX: (${cursorZoom.localX} - viewport.x) / viewport.zoom, worldY: (${cursorZoom.localY} - viewport.y) / viewport.zoom } })()`)
  assert(Math.abs(cursorZoomAfter.worldX - cursorZoom.worldX) < .1 && Math.abs(cursorZoomAfter.worldY - cursorZoom.worldY) < .1, `${viewport.label}: zoom não preservou o ponto sob o cursor (${JSON.stringify({ before: cursorZoom, after: cursorZoomAfter })})`)
  recordPass(viewport.label, 'fundo, roda e zoom no cursor navegam pelo canvas')

  const toolbarZoom = await evaluate(window, `(() => {
    const canvas = document.querySelector('.workspace-canvas')
    const id = canvas?.getAttribute('data-canvas-project-id')
    const before = id ? JSON.parse(window.localStorage.getItem('devorbit:workspace-canvas:' + id)).viewport : null
    return before ? { id, zoom: before.zoom } : null
  })()`)
  assert(toolbarZoom, `${viewport.label}: estado de zoom indisponível`)
  await clickButtonByText(window, (node) => node.getAttribute('aria-label') === 'Aumentar zoom', `${viewport.label} zoom in`)
  await clickButtonByText(window, (node) => node.getAttribute('aria-label') === 'Aumentar zoom', `${viewport.label} zoom in again`)
  await waitFor(window, `JSON.parse(window.localStorage.getItem('devorbit:workspace-canvas:${toolbarZoom.id}')).viewport.zoom > ${toolbarZoom.zoom}`, `${viewport.label} toolbar zoom in`)
  const zoomedVisibility = await evaluate(window, `(() => {
    const canvas = document.querySelector('.workspace-canvas').getBoundingClientRect()
    const cards = Array.from(document.querySelectorAll('.workspace-canvas-card')).map((card) => card.getBoundingClientRect())
    return cards.length === 3 && cards.every((card) => card.right > canvas.left && card.bottom > canvas.top && card.left < canvas.right && card.top < canvas.bottom)
  })()`)
  assert(zoomedVisibility, `${viewport.label}: zoom deixou quadros fora do canvas`)
  await clickButtonByText(window, (node) => (node.getAttribute('aria-label') || '').includes('Restaurar zoom'), `${viewport.label} zoom reset`)
  await waitFor(window, `JSON.parse(window.localStorage.getItem('devorbit:workspace-canvas:${toolbarZoom.id}')).viewport.zoom === 1`, `${viewport.label} toolbar zoom reset`)
  recordPass(viewport.label, 'zoom por botões mantém os quadros visíveis e volta a 100%')

  const manualLink = await evaluate(window, `(function () {
    const source = document.querySelector('[data-canvas-card="note"] [data-canvas-port="source"]')
    const target = document.querySelector('[data-canvas-card="browser"] [data-canvas-port="target"]')
    const canvas = document.querySelector('.workspace-canvas')
    const id = canvas?.getAttribute('data-canvas-project-id')
    if (!source || !target || !id) return false
    source.click()
    return { id }
  })()`)
  assert(manualLink, `${viewport.label}: portas de conexão do canvas ausentes`)
  await waitFor(window, `!document.querySelector('[data-canvas-card="browser"] [data-canvas-port="target"]').disabled`, `${viewport.label} canvas connection target`)
  await evaluate(window, `document.querySelector('[data-canvas-card="browser"] [data-canvas-port="target"]').click()`)
  await waitFor(window, `JSON.parse(window.localStorage.getItem('devorbit:workspace-canvas:${manualLink.id}')).connections.length === 1`, `${viewport.label} canvas manual connection`)
  await evaluate(window, `document.querySelector('[data-canvas-card="note"] [data-canvas-port="source"]').click()`)
  await waitFor(window, `!document.querySelector('[data-canvas-card="browser"] [data-canvas-port="target"]').disabled`, `${viewport.label} duplicate connection target`)
  await evaluate(window, `document.querySelector('[data-canvas-card="browser"] [data-canvas-port="target"]').click()`)
  await waitFor(window, `!document.querySelector('.workspace-canvas-connection-status')`, `${viewport.label} duplicate connection complete`)
  const duplicateLinks = await evaluate(window, `JSON.parse(window.localStorage.getItem('devorbit:workspace-canvas:${manualLink.id}')).connections.length`)
  assert(duplicateLinks === 1, `${viewport.label}: conexão duplicada foi criada (${duplicateLinks})`)
  await clickButtonByText(window, (node) => node.getAttribute('aria-label') === 'Encaixar conteúdo no canvas', `${viewport.label} canvas fit before cancel`)
  const cancelSetup = await evaluate(window, `(function () {
    const source = document.querySelector('[data-canvas-card="note"] [data-canvas-port="source"]')
    const target = document.querySelector('[data-canvas-card="workbench"] [data-canvas-port="target"]')
    const rect = target.getBoundingClientRect()
    source.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 77, clientX: 800, clientY: 200 }))
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('[data-canvas-port="target"]')
    if (hit !== target) return false
    window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 77, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }))
    return true
  })()`)
  assert(cancelSetup, `${viewport.label}: porta não ligada não ficou visível para pointercancel`)
  await waitFor(window, `!document.querySelector('.workspace-canvas-connection-status')`, `${viewport.label} canvas pointer cancel`)
  const cancelledLinks = await evaluate(window, `JSON.parse(window.localStorage.getItem('devorbit:workspace-canvas:${manualLink.id}')).connections.length`)
  assert(cancelledLinks === 1, `${viewport.label}: pointercancel criou conexão (${cancelledLinks})`)
  await evaluate(window, `document.querySelector('[data-canvas-card="note"] [data-canvas-port="source"]').click()`)
  await waitFor(window, `Boolean(document.querySelector('.workspace-canvas-connection-status'))`, `${viewport.label} canvas pending connection`)
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESCAPE' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESCAPE' })
  await waitFor(window, `!document.querySelector('.workspace-canvas-connection-status')`, `${viewport.label} canvas cancel connection`)
  await evaluate(window, `(function () {
    const header = document.querySelector('[data-canvas-card="browser"] header strong')
    if (!header) return false
    header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 78, clientX: 400, clientY: 300 }))
    return true
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 0))
  await evaluate(window, `(() => { window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 78, clientX: 10000, clientY: 10000 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 78, clientX: 10000, clientY: 10000 })); return true })()`)
  await waitFor(window, `(() => { const browser = document.querySelector('[data-canvas-card="browser"]'); return Number.parseFloat(browser.style.left) > 4000 && Number.parseFloat(browser.style.top) > 2500 })()`, `${viewport.label} canvas extreme placement`)
  await clickButtonByText(window, (node) => node.getAttribute('aria-label') === 'Encaixar conteúdo no canvas', `${viewport.label} canvas fit`)
  await waitFor(window, `(() => { const viewport = JSON.parse(window.localStorage.getItem('devorbit:workspace-canvas:${manualLink.id}')).viewport; const canvas = document.querySelector('.workspace-canvas').getBoundingClientRect(); const cards = Array.from(document.querySelectorAll('.workspace-canvas-card')).map((card) => card.getBoundingClientRect()); return viewport.zoom >= .08 && viewport.zoom <= 1.6 && cards.every((card) => card.left >= canvas.left - 1 && card.top >= canvas.top - 1 && card.right <= canvas.right + 1 && card.bottom <= canvas.bottom + 1) })()`, `${viewport.label} canvas fit bounds`)
  recordPass(viewport.label, 'portas ligam quadros sem duplicar e Escape cancela a ligação')
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
    const card = saved.nodes?.find((item) => item.id === 'workbench')
    return (saved.version === 4 || saved.version === 3) && Array.isArray(saved.squads) && card && Number(card.width) === Number.parseFloat(canvas.querySelector('[data-canvas-card="workbench"]').style.width)
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
  await key(window, '0', { ctrlKey: true })
  await waitFor(window, `(() => { const canvas = document.querySelector('.workspace-canvas'); const id = canvas?.getAttribute('data-canvas-project-id'); const raw = id ? window.localStorage.getItem('devorbit:workspace-canvas:' + id) : null; return Boolean(raw && JSON.parse(raw).viewport.zoom === 1) })()`, `${viewport.label} canvas zoom reset before agent creation`)
  await clickButtonByText(window, (node) => node.closest('.workspace-canvas-toolbar') && /Agente/.test(node.innerText), `${viewport.label} agent node creation`)
  await waitFor(window, `Boolean(document.querySelector('[role="dialog"] #agent-creation-dialog-title'))`, `${viewport.label} agent creation dialog`)
  await selectCreationProvider(window, 'Implementação', 'codex', viewport.label)
  await selectCreationAccount(window, 'Implementação', 'account1', viewport.label)
  await confirmCreationDialog(window, `${viewport.label} agent creation`)
  await waitFor(window, `document.querySelectorAll('.workspace-canvas [data-canvas-card="agent"]').length === 1`, `${viewport.label} agent canvas node`)
  await waitFor(window, `Array.from(window.__devorbitVerifyFixture.getCalls()).some((call) => call.name === 'startTerminal' && String(call.args[0]).startsWith('agent-'))`, `${viewport.label} agent terminal`)
  recordPass(viewport.label, 'canvas cria agente configurado com terminal independente')
  await verifyAgentConfigDetails(window, viewport)
  await screenshot(window, `desktop-${viewport.label}-canvas-agent`)
  await evaluate(window, `document.querySelector('[data-canvas-card="agent"] .canvas-delete-node')?.click()`)
  await waitFor(window, `document.querySelectorAll('.workspace-canvas [data-canvas-card="agent"]').length === 0`, `${viewport.label} agent terminal deletion`)
  await waitFor(window, `Array.from(window.__devorbitVerifyFixture.getCalls()).some((call) => call.name === 'stopTerminal' && String(call.args[0]).startsWith('agent-'))`, `${viewport.label} agent terminal stop`)
  recordPass(viewport.label, 'canvas exclui terminal de agente e encerra seu PTY')
  await clickButtonByText(window, (node) => node.closest('.workspace-canvas-toolbar') && /Squad/.test(node.innerText), `${viewport.label} squad template`)
  await waitFor(window, `Boolean(document.querySelector('[role="dialog"] #agent-creation-dialog-title'))`, `${viewport.label} squad creation dialog`)
  for (const role of ['Implementação', 'Revisão', 'Testes']) await enableSquadRole(window, role, viewport.label)
  await waitFor(window, `document.querySelectorAll('[role="dialog"] [aria-label^="Provider do agente"]').length === 4`, `${viewport.label} squad participants`)
  for (const role of ['Coordenador', 'Implementação', 'Revisão', 'Testes']) {
    await selectCreationProvider(window, role, 'codex', viewport.label)
    await selectCreationAccount(window, role, 'account1', viewport.label)
  }
  await confirmCreationDialog(window, `${viewport.label} squad creation`)
  await waitFor(window, `document.querySelectorAll('.workspace-canvas [data-canvas-card="agent"]').length === 4 && document.querySelectorAll('.workspace-canvas [data-canvas-card="note"]').length >= 2`, `${viewport.label} squad canvas nodes`)
  await waitFor(window, `document.querySelectorAll('.workspace-canvas-connections path').length >= 4`, `${viewport.label} squad task connections`)
  recordPass(viewport.label, 'template cria squad conectado a uma nota de tarefa')
  await verifySquadLayer(window, viewport)
  await screenshot(window, `desktop-${viewport.label}-canvas-squad`)
  const implicitStreaming = await evaluate(window, `window.__devorbitVerifyFixture.getCalls().filter((call) => call.name === 'pipeTerminals').length`)
  assert(implicitStreaming === 0, `${viewport.label}: conexões do canvas canalizaram PTY implicitamente (${implicitStreaming})`)
  recordPass(viewport.label, 'conexões do canvas não espelham digitação/TUI entre agentes')
  await verifyCoordinatorOrchestration(window, viewport)
  await verifyManualAgentSend(window, viewport)
  const stabilityBefore = await evaluate(window, `JSON.parse(window.localStorage.getItem('devorbit:workspace-canvas:' + document.querySelector('.workspace-canvas').getAttribute('data-canvas-project-id'))).viewport`)
  await clickButtonByText(window, (node) => node.getAttribute('aria-label') === 'Voltar ao layout integrado', `${viewport.label} stability grid`)
  await waitFor(window, `!document.querySelector('.workspace-canvas')`, `${viewport.label} stability grid state`)
  await clickButtonByText(window, (node) => node.getAttribute('aria-label') === 'Abrir canvas', `${viewport.label} stability canvas`)
  await waitFor(window, `document.querySelectorAll('.workspace-canvas [data-canvas-card]').length >= 3`, `${viewport.label} stability canvas cards`)
  const stability = await evaluate(window, `(() => {
    const canvas = document.querySelector('.workspace-canvas')
    const id = canvas.getAttribute('data-canvas-project-id')
    const viewport = JSON.parse(window.localStorage.getItem('devorbit:workspace-canvas:' + id)).viewport
    const box = canvas.getBoundingClientRect()
    const cards = Array.from(document.querySelectorAll('.workspace-canvas-card')).map((card) => card.getBoundingClientRect())
    return {
      viewport,
      cardsVisible: cards.some((card) => card.right > box.left && card.bottom > box.top && card.left < box.right && card.top < box.bottom),
      host: { width: box.width, height: box.height, left: box.left, top: box.top },
      cards: cards.map((card) => ({ left: Math.round(card.left), top: Math.round(card.top), right: Math.round(card.right), bottom: Math.round(card.bottom) })),
    }
  })()`)
  assert(stability.viewport.x === stabilityBefore.x && stability.viewport.y === stabilityBefore.y && stability.viewport.zoom === stabilityBefore.zoom, `${viewport.label}: alternância de layout perdeu o viewport`)
  assert(stability.cardsVisible, `${viewport.label}: quadros sumiram após alternar ambiente/canvas (${JSON.stringify(stability)})`)
  recordPass(viewport.label, 'alternar ambiente e canvas preserva viewport e mantém os quadros visíveis')
  await clickButtonByText(window, (node) => node.getAttribute('aria-label') === 'Voltar ao layout integrado', `${viewport.label} canvas close`)
  await waitFor(window, `!document.querySelector('.workspace-canvas')`, `${viewport.label} grid layout restore`)
  const chromeRestored = await evaluate(window, `(() => {
    const titlebar = document.querySelector('.app-titlebar')
    const sidebar = document.querySelector('.workspace-sidebar')
    const tabs = document.querySelector('.workspace-tabs')
    return Boolean(titlebar && titlebar.offsetParent !== null && sidebar && sidebar.offsetParent !== null && tabs && tabs.offsetParent !== null)
  })()`)
  assert(chromeRestored, `${viewport.label}: chrome usual não voltou ao sair do modo canvas`)
  await clickButtonByText(window, (node) => node.getAttribute('title') === 'Projetos', `${viewport.label} multi-project navigation`)
  await waitFor(window, `document.querySelector('.view-panel:not([hidden])')?.innerText.includes('Projetos')`, `${viewport.label} multi-project view`)
  await setInputValue(window, '#project-search', 'Fixture 03')
  await waitFor(window, `document.querySelectorAll('.project-list .project-row').length === 1`, `${viewport.label} multi-project search`)
  const openSecondProjectTab = await evaluate(window, `(() => {
    const row = document.querySelector('.project-list .project-row')
    if (!row) return false
    row.click()
    return true
  })()`)
  assert(openSecondProjectTab, `${viewport.label}: linha Fixture 03 indisponível para abrir aba`)
  await waitFor(window, `Boolean(document.querySelector('.project-tabs .project-tab.active') && document.querySelector('.project-tab-pane:not([hidden]) button.workspace-open-all'))`, `${viewport.label} second project tab pane`)
  const launchedSecond = await evaluate(window, `(() => {
    const button = document.querySelector('.project-tab-pane:not([hidden]) button.workspace-open-all')
    if (!button) return false
    button.focus()
    button.click()
    return true
  })()`)
  assert(launchedSecond, `${viewport.label}: botão abrir ambiente da aba ativa indisponível`)
  await waitFor(window, `document.querySelectorAll('.workspace-tabs .workspace-tab').length >= 2`, `${viewport.label} multiple workspace tabs`)
  // O modo dedicado esconde as abas; para trocar de projeto é preciso sair
  // dele pelo controle mínimo do canvas ativo.
  const focusBeforeTabs = await evaluate(window, `document.querySelector('.app-shell')?.classList.contains('canvas-focus') === true`)
  if (focusBeforeTabs) {
    await clickButtonByText(window, (node) => node.getAttribute('aria-label') === 'Voltar ao layout integrado', `${viewport.label} leave canvas focus for tabs`)
    await waitFor(window, `document.querySelector('.app-shell')?.classList.contains('canvas-focus') === false`, `${viewport.label} canvas focus cleared for tabs`)
    await waitFor(window, `document.querySelector('.workspace-tabs')?.offsetParent !== null`, `${viewport.label} workspace tabs restored`)
  }
  await evaluate(window, `window.__devorbitVerifyFixture.resetCalls()`)
  await clickButtonByText(window, (node) => node.classList.contains('workspace-tab') && !node.classList.contains('active'), `${viewport.label} first workspace tab`)
  await waitFor(window, `document.querySelector('.workspace-tab.active')?.innerText.includes(${JSON.stringify(selection)})`, `${viewport.label} first workspace tab active`)
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
  assert(searchResult.includes('Fixture 02') && searchResult.includes('develop'), `${viewport.label}: busca retornou projeto inesperado (${searchResult})`)
  recordPass(viewport.label, 'project search narrows to the matching fixture')

  await setInputValue(window, '#project-search', '')
  await waitFor(window, `document.querySelectorAll('.project-list .project-row').length >= 30`, `${viewport.label} limpeza da busca`)
  await setSelectValue(window, '.project-filters select', 'modified')
  await waitFor(window, `document.querySelectorAll('.project-list .project-row').length > 0 && Array.from(document.querySelectorAll('.project-list .project-row')).every((row) => row.querySelector('[title="Alterações locais"]'))`, `${viewport.label} filtro Git`)
  recordPass(viewport.label, 'Git status filter shows only local-change fixtures')
  await setSelectValue(window, '.project-filters select', 'all')
  await waitFor(window, `document.querySelectorAll('.project-list .project-row').length >= 30`, `${viewport.label} reset do filtro`)

  const openProjectTabFromLibrary = await evaluate(window, `(() => {
    const row = document.querySelector('.project-list .project-row')
    if (!row) return false
    row.click()
    return true
  })()`)
  assert(openProjectTabFromLibrary, `${viewport.label}: linha do projeto indisponível para abrir aba`)
  await waitFor(window, `Boolean(document.querySelector('.project-tabs .project-tab.active') && document.querySelector('.project-tab-pane:not([hidden])'))`, `${viewport.label} project tabs view`)
  const projectTabsInfo = await evaluate(window, `(() => {
    const tabs = Array.from(document.querySelectorAll('.project-tabs .project-tab'))
    const activeTab = document.querySelector('.project-tabs .project-tab.active')
    const breadcrumb = document.querySelector('.project-tab-pane:not([hidden]) .project-breadcrumb')
    return {
      total: tabs.length,
      activeName: activeTab?.querySelector('.project-tab-select')?.innerText?.trim() || '',
      hasBreadcrumb: Boolean(breadcrumb && breadcrumb.innerText.includes('Projetos')),
      canClose: Boolean(activeTab?.querySelector('.project-tab-close')),
    }
  })()`)
  assert(projectTabsInfo.total >= 1 && projectTabsInfo.hasBreadcrumb && projectTabsInfo.canClose, `${viewport.label}: abas de projeto incompletas (${JSON.stringify(projectTabsInfo)})`)
  const countBeforeClose = projectTabsInfo.total
  await evaluate(window, `(() => {
    const closeBtn = document.querySelector('.project-tabs .project-tab.active .project-tab-close')
    closeBtn?.click()
    return true
  })()`)
  if (countBeforeClose > 1) {
    await waitFor(window, `document.querySelectorAll('.project-tabs .project-tab').length === ${countBeforeClose - 1}`, `${viewport.label} project tab close`)
    await clickButtonByText(window, (node) => node.classList.contains('project-tab-projects') || node.classList.contains('project-breadcrumb-home'), `${viewport.label} return to project library`)
  }
  await waitFor(window, `Boolean(document.querySelector('.project-workspace.project-library') && document.querySelectorAll('.project-list .project-row').length >= 30)`, `${viewport.label} library restored after project tabs`)
  recordPass(viewport.label, 'abas de projeto abrem, exibem breadcrumb, fecham e retornam à biblioteca')
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
  await waitFor(window, `(() => { const dialog = document.querySelector('[role="dialog"]'); return Boolean(dialog?.querySelector('#tool-health-title') && dialog.querySelectorAll('article').length === 12 && dialog.contains(document.activeElement)) })()`, `${viewport.label} tool health dialog`)
  const health = await evaluate(window, `(() => ({
    title: document.querySelector('#tool-health-title')?.innerText,
    tools: document.querySelectorAll('[role="dialog"] article').length,
    missing: Array.from(document.querySelectorAll('[role="dialog"] article')).filter((article) => article.innerText.includes('Não encontrado')).length,
  }))()`)
  assert(health.title === 'Diagnóstico de ferramentas' && health.tools === 12 && health.missing === 4, `${viewport.label}: diagnóstico incompleto (${JSON.stringify(health)})`)
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

  // FASE 2: valida Ctrl+K com o painel Web visível — navega ao workspace para
  // garantir a view nativa ativa antes de abrir a paleta.
  await clickButtonByText(window, (node) => (node.getAttribute('title') || '').startsWith('Ambiente integrado de '), `${viewport.label} workspace restore for palette`)
  await waitFor(window, `Boolean(document.querySelector('.integrated-workspace') && document.querySelector('.integrated-workspace-view:not([hidden])'))`, `${viewport.label} workspace active for palette`)
  await waitFor(window, `window.__devorbitVerifyFixture.getCalls().filter((call) => call.name === 'setWebVisible').length > 0 && window.__devorbitVerifyFixture.getCalls().filter((call) => call.name === 'setWebVisible').at(-1).args[0] === true`, `${viewport.label} palette native web visible`)
  const paletteOrigin = await evaluate(window, `document.activeElement?.getAttribute('title') || ''`)
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
  // FASE 2: a view nativa pinta acima do DOM; com a paleta aberta ela deve ser
  // ocultada (preservando URL/sessão) para o input ficar utilizável.
  await waitFor(window, `window.__devorbitVerifyFixture.getCalls().filter((call) => call.name === 'setWebVisible').length > 0 && window.__devorbitVerifyFixture.getCalls().filter((call) => call.name === 'setWebVisible').at(-1).args[0] === false`, `${viewport.label} palette native web hidden`)
  const paletteWebState = await evaluate(window, `(() => {
    const input = document.querySelector('#command-palette-search')
    const dialog = document.querySelector('[role="dialog"]')
    return { usable: Boolean(input && !input.disabled && dialog && dialog.contains(document.activeElement)) }
  })()`)
  assert(paletteWebState.usable, `${viewport.label}: command center inutilizável com painel web visível`)
  recordPass(viewport.label, 'command palette usable over native web with state preserved')
  await screenshot(window, `desktop-${viewport.label}-command-palette`)
  await key(window, 'Escape')
  await waitFor(window, `!document.querySelector('[role="dialog"] #command-palette-search')`, `${viewport.label} palette Escape`)
  await waitFor(window, `window.__devorbitVerifyFixture.getCalls().filter((call) => call.name === 'setWebVisible').at(-1).args[0] === true`, `${viewport.label} palette native web restored`)
  await waitFor(window, `(() => {
    const title = document.activeElement?.getAttribute('title') || ''
    const label = document.activeElement?.getAttribute('aria-label') || ''
    return title === ${JSON.stringify(paletteOrigin)} || label === ${JSON.stringify(paletteOrigin)}
  })()`, `${viewport.label} palette focus restore`)
  const restoredPaletteFocus = await evaluate(window, `document.activeElement?.getAttribute('title') || document.activeElement?.getAttribute('aria-label') || ''`)
  assert(restoredPaletteFocus === paletteOrigin, `${viewport.label}: palette Escape não restaurou o controle de origem (${JSON.stringify({ paletteOrigin, restoredPaletteFocus })})`)
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
        backgroundThrottling: false,
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
    await inspectAudit(window, viewport)
    await clickButtonByText(window, (node) => /projetos/i.test(node.innerText) && node.getAttribute('title') === 'Projetos', `${viewport.label} projects navigation after audit`)
    await waitFor(window, `document.querySelector('.view-panel:not([hidden])')?.innerText.includes('Projetos')`, `${viewport.label} projects view after audit`)
    await inspectProjectInteractions(window, viewport)
    await inspectMemory(window, viewport)
    await inspectUsage(window, viewport)
    // Return to projects so the settings trigger lives in the visible shell.
    await clickButtonByText(window, (node) => /projetos/i.test(node.innerText) && node.getAttribute('title') === 'Projetos', `${viewport.label} projects navigation`)
    await waitFor(window, `document.querySelector('.view-panel:not([hidden])')?.innerText.includes('Projetos')`, `${viewport.label} projects navigation restore`)
    await inspectToolHealth(window, viewport)
    await inspectSettingsAndPalette(window, viewport)
    await inspectDarkTheme(window, viewport)
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
