import React, { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Code2, Globe, RefreshCw, Terminal as TerminalIcon } from 'lucide-react'
import type { AgentProviderId, TerminalEvent } from '../types'
import { createAgentResultScanner, createLegacyAgentResult, type AgentResult } from '../../../shared/agent-result'
import { canReuseCodexSession } from '../../../shared/codex-session'

interface WorkspaceTerminalProps {
  projectPath: string
  terminalId: string
  codexAccount?: 'account1' | 'account2'
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void
  onRequestCodexAuth?: (account: 'account1' | 'account2') => void
  provider: AgentProviderId
  /** Inicia o executor configurado no mount, em vez do shell genérico. */
  autoStart?: boolean
  /** Conta Codex padrão quando o executor automático é o Codex. */
  autoStartCodexAccount?: 'account1' | 'account2'
  agentTask?: { id: string; prompt: string }
  onAgentResult?: (result: AgentResult, taskId?: string) => void
  onAgentTaskFailure?: (taskId: string, message: string) => void
}

type TerminalState = 'starting' | 'ready' | 'stopped' | 'error'
type TerminalMode = 'shell' | 'codex' | 'agent'

const MAX_SNAPSHOT_LENGTH = 40_000
const CODEX_READY_FALLBACK_MS = 750
const RESIZE_DEBOUNCE_MS = 90
const MIN_PTY_COLS = 20
const MIN_PTY_ROWS = 5
const providerLabels: Record<AgentProviderId, string> = {
  codex: 'Codex',
  opencode: 'OpenCode',
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
  aider: 'Aider',
  agy: 'Antigravity',
  custom: 'Agente local',
}

function currentDimensions(terminal: XTerm | null): { cols: number; rows: number } | undefined {
  if (!terminal || !Number.isFinite(terminal.cols) || !Number.isFinite(terminal.rows)) return undefined
  return { cols: terminal.cols, rows: terminal.rows }
}

export const WorkspaceTerminal: React.FC<WorkspaceTerminalProps> = ({
  projectPath,
  terminalId,
  codexAccount,
  onNotify,
  onRequestCodexAuth,
  provider,
  autoStart = false,
  autoStartCodexAccount,
  agentTask,
  onAgentResult,
  onAgentTaskFailure,
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const outputSnapshotRef = useRef('')
  const completedTaskRef = useRef<string | null>(null)
  const deliveringTaskRef = useRef<string | null>(null)
  // Every start replaces the PTY behind this terminal id. Keep a local token so
  // a late response from the initial CMD startup cannot repaint a newer Codex
  // session as a shell session.
  const terminalStartTokenRef = useRef(0)
  const terminalModeRef = useRef<TerminalMode>('shell')
  const autoStartRef = useRef(autoStart)
  const autoStartedRef = useRef(false)
  const activeProviderRef = useRef<AgentProviderId | null>(null)
  const activeCodexAccountRef = useRef<'account1' | 'account2' | null>(null)
  const fitTerminalRef = useRef<() => void>(() => undefined)
  const lastSentDimsRef = useRef<{ cols: number; rows: number } | null>(null)
  const resizeTimerRef = useRef<number | null>(null)
  const pendingFramesRef = useRef<number[]>([])
  const pendingTimeoutsRef = useRef<number[]>([])
  const onNotifyRef = useRef(onNotify)
  const onRequestCodexAuthRef = useRef(onRequestCodexAuth)
  const onAgentResultRef = useRef(onAgentResult)
  const onAgentTaskFailureRef = useRef(onAgentTaskFailure)
  const activeTaskRef = useRef<string | null>(null)
  const reportedTaskFailuresRef = useRef(new Set<string>())
  // Tarefas cujo resultado/blocked já foi entregue ao canvas (via evento PTY
  // ou via retorno de sendAgentTurn). Garante entrega única e determinística
  // mesmo quando o marcador chega antes da Promise resolver.
  const deliveredTaskResultsRef = useRef(new Set<string>())
  const resultScannerRef = useRef(createAgentResultScanner())
  const invalidResultRef = useRef<string | null>(null)
  const terminalDataWaitersRef = useRef(new Set<() => void>())
  onNotifyRef.current = onNotify
  onRequestCodexAuthRef.current = onRequestCodexAuth
  onAgentResultRef.current = onAgentResult
  onAgentTaskFailureRef.current = onAgentTaskFailure
  const [terminalState, setTerminalState] = useState<TerminalState>('starting')
  const [terminalMode, setTerminalMode] = useState<TerminalMode>('shell')
  const [isStartingCodex, setIsStartingCodex] = useState(false)
  const [lastDetectedUrl, setLastDetectedUrl] = useState('')
  const terminalStateRef = useRef<TerminalState>(terminalState)
  terminalStateRef.current = terminalState

  const reportTaskFailure = useCallback((taskId: string, message: string) => {
    if (reportedTaskFailuresRef.current.has(taskId)) return
    reportedTaskFailuresRef.current.add(taskId)
    if (activeTaskRef.current === taskId) activeTaskRef.current = null
    onNotifyRef.current('A tarefa automática do agente foi bloqueada: ' + message, 'error')
    onAgentTaskFailureRef.current?.(taskId, message)
  }, [])

  // Entrega o resultado de um turno ao canvas exatamente uma vez por tarefa.
  // O listener do PTY pode ter entregado antes (marcador veio antes da
  // resolução); nesse caso esta chamada é um no-op.
  const deliverTaskResult = useCallback((taskId: string, result: AgentResult) => {
    if (!result.summary || deliveredTaskResultsRef.current.has(taskId)) return
    deliveredTaskResultsRef.current.add(taskId)
    onAgentResultRef.current?.(result, taskId)
  }, [])

  const scheduleFitFrame = useCallback((callback: () => void): number => {
    const id = window.requestAnimationFrame(() => {
      pendingFramesRef.current = pendingFramesRef.current.filter((frame) => frame !== id)
      callback()
    })
    pendingFramesRef.current.push(id)
    return id
  }, [])

  const scheduleFitTimeout = useCallback((callback: () => void, ms: number): number => {
    const id = window.setTimeout(() => {
      pendingTimeoutsRef.current = pendingTimeoutsRef.current.filter((timeout) => timeout !== id)
      callback()
    }, ms)
    pendingTimeoutsRef.current.push(id)
    return id
  }, [])

  const sendResize = useCallback((cols: number, rows: number, force = false) => {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    if (cols < MIN_PTY_COLS || rows < MIN_PTY_ROWS) return
    const last = lastSentDimsRef.current
    if (!force && last && last.cols === cols && last.rows === rows) return
    lastSentDimsRef.current = { cols, rows }
    void window.devorbit.resizeTerminal(terminalId, cols, rows).catch(() => {
      lastSentDimsRef.current = last
    })
  }, [terminalId])

  const waitForTerminalData = useCallback(() => {
    let settled = false
    let timeoutId: number | null = null
    let resolvePromise: (receivedData: boolean) => void = () => undefined
    const finish = (receivedData: boolean) => {
      if (settled) return
      settled = true
      if (timeoutId !== null) window.clearTimeout(timeoutId)
      terminalDataWaitersRef.current.delete(onData)
      resolvePromise(receivedData)
    }
    const onData = () => finish(true)
    const promise = new Promise<boolean>((resolve) => {
      resolvePromise = resolve
      terminalDataWaitersRef.current.add(onData)
      timeoutId = window.setTimeout(() => finish(false), CODEX_READY_FALLBACK_MS)
    })
    return { promise, cancel: () => finish(false) }
  }, [])

  const startShell = useCallback(async () => {
    const startToken = ++terminalStartTokenRef.current
    terminalModeRef.current = 'shell'
    activeProviderRef.current = null
    activeCodexAccountRef.current = null
    outputSnapshotRef.current = ''
    resultScannerRef.current.reset()
    invalidResultRef.current = null
    lastSentDimsRef.current = null
    setTerminalMode('shell')
    setTerminalState('starting')
    try {
      const dims = currentDimensions(terminalRef.current)
      const result = await window.devorbit.startTerminal(
        terminalId,
        projectPath,
        dims?.cols,
        dims?.rows,
      )
      if (startToken === terminalStartTokenRef.current) {
        terminalRef.current?.clear()
        terminalRef.current?.writeln('\x1b[90mTerminal pronto.\x1b[0m')
        setTerminalState('ready')
        scheduleFitFrame(() => fitTerminalRef.current())
      }
      return result
    } catch (error) {
      if (startToken !== terminalStartTokenRef.current) return null
      setTerminalState('error')
      const message = error instanceof Error ? error.message : String(error)
      terminalRef.current?.writeln('\r\n\x1b[31m[erro ao iniciar: ' + message + ']\x1b[0m')
      onNotifyRef.current('Não foi possível iniciar o terminal interno: ' + message, 'error')
      return null
    }
  }, [projectPath, scheduleFitFrame, terminalId])

  const startCodex = useCallback(async (accountOverride?: 'account1' | 'account2') => {
    const account = accountOverride ?? codexAccount
    if (!account) {
      onNotifyRef.current('Configure a conta Codex deste agente para iniciar o Codex.', 'error')
      return null
    }
    const startToken = ++terminalStartTokenRef.current
    terminalModeRef.current = 'codex'
    activeProviderRef.current = 'codex'
    outputSnapshotRef.current = ''
    resultScannerRef.current.reset()
    invalidResultRef.current = null
    lastSentDimsRef.current = null
    setIsStartingCodex(true)
    setTerminalState('starting')
    const readySignal = waitForTerminalData()
    try {
      const result = await window.devorbit.startCodexTerminal(
        terminalId,
        projectPath,
        account,
        terminalRef.current?.cols,
        terminalRef.current?.rows,
      )
      if (!result.success) {
        readySignal.cancel()
        if (startToken !== terminalStartTokenRef.current) return result
        activeProviderRef.current = null
        activeCodexAccountRef.current = null
        terminalModeRef.current = 'shell'
        setTerminalMode('shell')
        setTerminalState(result.needsAuth ? 'ready' : 'error')
        if (result.message) onNotifyRef.current(result.message, result.needsAuth ? 'info' : 'error')
        if (result.needsAuth) onRequestCodexAuthRef.current?.(account)
        return result
      }
      await readySignal.promise
      if (startToken === terminalStartTokenRef.current) {
        activeCodexAccountRef.current = account
        setTerminalMode('codex')
        terminalRef.current?.clear()
        terminalRef.current?.writeln('\x1b[90mCodex iniciado.\x1b[0m')
        setTerminalState('ready')
        // The Codex TUI switches to an alternate screen after its process has
        // started. Re-fit it after that switch so its grid uses the card's real
        // dimensions instead of the initial CMD dimensions.
        const refit = () => {
          if (startToken !== terminalStartTokenRef.current || terminalModeRef.current !== 'codex') return
          fitTerminalRef.current()
          const terminal = terminalRef.current
          if (terminal) terminal.refresh(0, Math.max(0, terminal.rows - 1))
        }
        scheduleFitFrame(refit)
        scheduleFitTimeout(refit, 140)
        scheduleFitTimeout(refit, 650)
      }
      return result
    } catch (error) {
      readySignal.cancel()
      if (startToken !== terminalStartTokenRef.current) return null
      activeProviderRef.current = null
      activeCodexAccountRef.current = null
      setTerminalState('error')
      const message = error instanceof Error ? error.message : String(error)
      terminalRef.current?.writeln('\r\n\x1b[31m[erro ao iniciar o Codex: ' + message + ']\x1b[0m')
      onNotifyRef.current('Não foi possível iniciar o Codex no terminal: ' + message, 'error')
      return null
    } finally {
      readySignal.cancel()
      setIsStartingCodex(false)
    }
  }, [codexAccount, projectPath, scheduleFitFrame, scheduleFitTimeout, terminalId, waitForTerminalData])

  const startAgent = useCallback(async (task?: string) => {
    if (provider === 'codex') return startCodex()
    const startToken = ++terminalStartTokenRef.current
    terminalModeRef.current = 'agent'
    activeProviderRef.current = provider
    activeCodexAccountRef.current = null
    outputSnapshotRef.current = ''
    resultScannerRef.current.reset()
    invalidResultRef.current = null
    lastSentDimsRef.current = null
    setIsStartingCodex(true)
    setTerminalState('starting')
    const readySignal = waitForTerminalData()
    try {
      const result = await window.devorbit.startAgentTerminal(
        terminalId,
        projectPath,
        provider,
        terminalRef.current?.cols,
        terminalRef.current?.rows,
        task,
      )
      if (!result.success) {
        readySignal.cancel()
        if (startToken !== terminalStartTokenRef.current) return result
        activeProviderRef.current = null
        activeCodexAccountRef.current = null
        terminalModeRef.current = 'shell'
        setTerminalMode('shell')
        setTerminalState('error')
        if (result.message) onNotifyRef.current(result.message, 'error')
        return result
      }
      await readySignal.promise
      if (startToken === terminalStartTokenRef.current) {
        if (result.provider) activeProviderRef.current = result.provider
        setTerminalMode('agent')
        terminalRef.current?.clear()
        terminalRef.current?.writeln('\x1b[90mAgente iniciado.\x1b[0m')
        if (result.tier && result.model) {
          terminalRef.current?.writeln(`\x1b[90m${result.tier === 'deep' ? 'Análise profunda' : 'Resposta rápida'} · ${result.model}\x1b[0m`)
        }
        setTerminalState('ready')
      }
      return result
    } catch (error) {
      readySignal.cancel()
      if (startToken !== terminalStartTokenRef.current) return null
      activeProviderRef.current = null
      activeCodexAccountRef.current = null
      terminalModeRef.current = 'shell'
      setTerminalMode('shell')
      setTerminalState('error')
      const message = error instanceof Error ? error.message : String(error)
      terminalRef.current?.writeln('\r\n\x1b[31m[erro ao iniciar o agente: ' + message + ']\x1b[0m')
      onNotifyRef.current('Não foi possível iniciar o agente local: ' + message, 'error')
      return null
    } finally {
      readySignal.cancel()
      setIsStartingCodex(false)
    }
  }, [projectPath, provider, startCodex, terminalId, waitForTerminalData])

  useEffect(() => {
    autoStartRef.current = autoStart
  }, [autoStart])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const terminal = new XTerm({
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      fontFamily: 'Consolas, "Cascadia Code", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      theme: {
        background: '#0d0f14',
        foreground: '#f5f7fa',
        cursor: '#8797b4',
        selectionBackground: '#232b39',
        black: '#0d0f14',
        brightBlack: '#7e8491',
        red: '#d27564',
        brightRed: '#ef907a',
        green: '#9bbd88',
        brightGreen: '#b7d7a3',
        yellow: '#d5b06c',
        brightYellow: '#ebcf8d',
        blue: '#87a7c5',
        brightBlue: '#aac4e0',
        magenta: '#b49ac4',
        brightMagenta: '#d4b7e8',
        cyan: '#7db9b1',
        brightCyan: '#a5ded5',
        white: '#f5f7fa',
        brightWhite: '#ffffff',
      },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const fitTerminal = () => {
      try {
        if (!container.isConnected || container.clientWidth === 0 || container.clientHeight === 0) return
        fitAddon.fit()
        const dims = currentDimensions(terminal)
        if (dims && dims.cols >= MIN_PTY_COLS && dims.rows >= MIN_PTY_ROWS) {
          sendResize(dims.cols, dims.rows)
        }
      } catch {
        // The terminal can be temporarily detached while the workspace changes
        // visibility. The next resize event will fit it again.
      }
    }
    fitTerminalRef.current = fitTerminal

    const scheduleFit = () => {
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null
        scheduleFitFrame(fitTerminal)
      }, RESIZE_DEBOUNCE_MS)
    }

    const resizeObserver = new ResizeObserver(scheduleFit)
    resizeObserver.observe(container)
    window.addEventListener('resize', scheduleFit)
    // O fit inicial usa as dimensões reais do card; o PTY nasce com elas e
    // cada resize posterior emite um evento real de redimensionamento.
    // Todos os handles passam pelo scheduler estável para cleanup no unmount.
    scheduleFitFrame(fitTerminal)
    scheduleFitTimeout(fitTerminal, 120)

    const inputDisposable = terminal.onData((data) => {
      if (terminalStateRef.current !== 'ready') return
      void window.devorbit.writeTerminal(terminalId, data)
    })

    const unsubscribe = window.devorbit.onTerminalEvent((event: TerminalEvent) => {
      if (event.id !== terminalId) return
      if (event.type === 'data' && event.data) {
        // Streaming sem perda: cada chunk do PTY nativo é anexado ao snapshot
        // e escrito no xterm na mesma ordem de chegada.
        for (const waiter of Array.from(terminalDataWaitersRef.current)) waiter()
        const nextSnapshot = outputSnapshotRef.current + event.data
        outputSnapshotRef.current = nextSnapshot.slice(-MAX_SNAPSHOT_LENGTH)
        const detectedUrl = outputSnapshotRef.current.match(/https:\/\/[^\s"'<>`]+/i)?.[0]?.replace(/[),.;]+$/, '')
        if (detectedUrl) setLastDetectedUrl(detectedUrl)
        for (const parsed of resultScannerRef.current.push(event.data)) {
          if (parsed.kind === 'invalid') {
            invalidResultRef.current = invalidResultRef.current || parsed.reason
            continue
          }
          if (parsed.kind !== 'result') continue
          const taskId = activeTaskRef.current || undefined
          activeTaskRef.current = null
          invalidResultRef.current = null
          if (!taskId || !deliveredTaskResultsRef.current.has(taskId)) {
            if (taskId) deliveredTaskResultsRef.current.add(taskId)
            if (parsed.result.outcome === 'failed') {
              if (taskId) reportTaskFailure(taskId, parsed.result.summary)
              else onNotifyRef.current(`O agente reportou falha: ${parsed.result.summary}`, 'error')
            } else {
              onAgentResultRef.current?.(parsed.result, taskId)
            }
          }
        }
        terminal.write(event.data)
      } else if (event.type === 'resize' && event.cols && event.rows) {
        lastSentDimsRef.current = { cols: event.cols, rows: event.rows }
      } else if (event.type === 'exit') {
        for (const parsed of resultScannerRef.current.finish()) {
          if (parsed.kind === 'invalid') {
            invalidResultRef.current = invalidResultRef.current || parsed.reason
            continue
          }
          if (parsed.kind !== 'result') continue
          const taskId = activeTaskRef.current || undefined
          activeTaskRef.current = null
          invalidResultRef.current = null
          if (!taskId || deliveredTaskResultsRef.current.has(taskId)) continue
          deliveredTaskResultsRef.current.add(taskId)
          if (parsed.result.outcome === 'failed') reportTaskFailure(taskId, parsed.result.summary)
          else onAgentResultRef.current?.(parsed.result, taskId)
        }
        terminal.writeln('\r\n\x1b[90m[processo encerrado]\x1b[0m')
        setTerminalState('stopped')
        const taskId = activeTaskRef.current
        if (taskId) {
          reportTaskFailure(taskId, invalidResultRef.current
            ? `Resultado DEVORBIT_RESULT inválido ou incerto (${invalidResultRef.current}).`
            : 'O processo do agente foi encerrado antes de devolver um resultado.')
        }
      } else if (event.type === 'error') {
        terminal.writeln('\r\n\x1b[31m[erro: ' + (event.data || 'falha desconhecida') + ']\x1b[0m')
        setTerminalState('error')
        const taskId = activeTaskRef.current
        if (taskId) reportTaskFailure(taskId, event.data || 'O terminal do agente encontrou um erro.')
      }
    })

    let alive = true
    // Com executor automático configurado, o shell genérico não sobe: o efeito
    // de auto-start logo abaixo inicia o executor no mesmo PTY, sem sobrescrever
    // a sessão e sem duplicar o processo.
    if (!autoStartRef.current) {
      const initialStartToken = ++terminalStartTokenRef.current
      terminalModeRef.current = 'shell'
      const initialDims = currentDimensions(terminal)
      void window.devorbit.startTerminal(terminalId, projectPath, initialDims?.cols, initialDims?.rows)
        .then(() => {
          if (!alive || initialStartToken !== terminalStartTokenRef.current || terminalModeRef.current !== 'shell') return
          terminal.writeln('\x1b[90mTerminal pronto · ' + projectPath + '\x1b[0m')
          setTerminalState('ready')
          scheduleFitFrame(fitTerminal)
        })
        .catch((error) => {
          if (!alive || initialStartToken !== terminalStartTokenRef.current) return
          const message = error instanceof Error ? error.message : String(error)
          terminal.writeln('\r\n\x1b[31m[erro ao iniciar: ' + message + ']\x1b[0m')
          setTerminalState('error')
          onNotifyRef.current('Não foi possível iniciar o terminal interno: ' + message, 'error')
        })
    }

    return () => {
      alive = false
      inputDisposable.dispose()
      unsubscribe()
      resizeObserver.disconnect()
      window.removeEventListener('resize', scheduleFit)
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current)
        resizeTimerRef.current = null
      }
      for (const frame of pendingFramesRef.current) window.cancelAnimationFrame(frame)
      pendingFramesRef.current = []
      for (const timeout of pendingTimeoutsRef.current) window.clearTimeout(timeout)
      pendingTimeoutsRef.current = []
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      fitTerminalRef.current = () => undefined
      lastSentDimsRef.current = null
      void window.devorbit.stopTerminal(terminalId)
    }
  }, [projectPath, reportTaskFailure, scheduleFitFrame, scheduleFitTimeout, sendResize, terminalId])

  // Executor automático: uma vez por mount, no mesmo terminalId. Um restart
  // manual depois é escolha do usuário (startShell) e não é desfeito aqui.
  useEffect(() => {
    if (!autoStartRef.current || autoStartedRef.current) return
    autoStartedRef.current = true
    void (provider === 'codex' ? startCodex(autoStartCodexAccount ?? codexAccount) : startAgent())
  }, [autoStartCodexAccount, codexAccount, provider, startAgent, startCodex])

  useEffect(() => {
    if (!agentTask || completedTaskRef.current === agentTask.id || deliveringTaskRef.current === agentTask.id) return
    let cancelled = false
    resultScannerRef.current.reset()
    invalidResultRef.current = null
    const deliver = async () => {
      deliveringTaskRef.current = agentTask.id
      try {
        // Fronteira real do turno (FASE 3): o main resolve tier/modelo pelo
        // prompt, garante o CLI com o env do turno, entrega, aguarda o
        // marcador e só faz failover em erro transitório — mesmo terminal id.
        // O taskId é registrado ANTES do await: no backend real o marcador
        // chega pelo evento PTY antes desta Promise resolver, e o listener
        // precisa do id para entregar ao canvas. O retorno também é entregue
        // explicitamente (dedup) caso o evento não tenha sido observado.
        if (provider !== 'codex') {
          activeTaskRef.current = agentTask.id
          const turn = await window.devorbit.sendAgentTurn(terminalId, provider, projectPath, agentTask.prompt)
          if (cancelled) return
          if (!turn.success) {
            activeTaskRef.current = null
            reportTaskFailure(agentTask.id, turn.message || 'O agente não executou a tarefa.')
            return
          }
          if (turn.provider) activeProviderRef.current = turn.provider
          if (turn.blocked) {
            activeTaskRef.current = null
            // Se o listener já entregou o texto bloqueado como resultado, o
            // canvas marcou o bloqueio; reportTaskFailure duplicaria o toast.
            if (!deliveredTaskResultsRef.current.has(agentTask.id)) {
              deliverTaskResult(agentTask.id, createLegacyAgentResult('blocked', turn.blocked))
            }
            return
          }
          if (turn.result) {
            // No backend real o listener normalmente já entregou (marcador
            // antes da resolução); deliverTaskResult deduplica por tarefa.
            deliverTaskResult(agentTask.id, createLegacyAgentResult('completed', turn.result))
            activeTaskRef.current = null
          } else if (deliveredTaskResultsRef.current.has(agentTask.id)) {
            activeTaskRef.current = null
          }
          // Sem result e sem entrega: o marcador ainda virá por evento PTY e
          // o taskId precisa continuar ativo para o listener entregar.
          if (!cancelled) {
            completedTaskRef.current = agentTask.id
            terminalModeRef.current = 'agent'
            setTerminalMode('agent')
            setTerminalState('ready')
            onNotifyRef.current(
              `Tarefa enviada${turn.model ? ` · ${turn.tier === 'deep' ? 'análise profunda' : 'resposta rápida'} (${turn.model})` : ''}.`,
              'success'
            )
          } else if (activeTaskRef.current === agentTask.id) {
            activeTaskRef.current = null
          }
          return
        }
        if (!codexAccount) {
          reportTaskFailure(agentTask.id, 'Configure a conta Codex deste agente para executar tarefas.')
          return
        }
        const reusable = canReuseCodexSession(
          {
            provider: activeProviderRef.current,
            account: activeCodexAccountRef.current,
            mode: terminalModeRef.current,
            state: terminalStateRef.current,
          },
          provider,
          codexAccount,
        )
        const ready = reusable ? { success: true } : await startAgent(agentTask.prompt)
        if (cancelled) return
        if (!ready?.success) {
          reportTaskFailure(agentTask.id, ready?.message || 'O Codex não ficou disponível para receber a tarefa.')
          return
        }
        activeTaskRef.current = agentTask.id
        const written = await window.devorbit.writeTerminal(terminalId, agentTask.prompt + '\r')
        if (!written.success) {
          reportTaskFailure(agentTask.id, 'O terminal do agente recusou a tarefa.')
          return
        }
        if (!cancelled) {
          completedTaskRef.current = agentTask.id
          onNotifyRef.current('Tarefa enviada ao agente.', 'success')
        } else if (activeTaskRef.current === agentTask.id) {
          activeTaskRef.current = null
        }
      } catch (error) {
        if (!cancelled) {
          reportTaskFailure(agentTask.id, error instanceof Error ? error.message : String(error))
        }
      } finally {
        deliveringTaskRef.current = null
      }
    }
    void deliver()
    return () => {
      cancelled = true
      if (activeTaskRef.current === agentTask.id && completedTaskRef.current !== agentTask.id) activeTaskRef.current = null
    }
  }, [agentTask, codexAccount, deliverTaskResult, provider, reportTaskFailure, startAgent, terminalId])

  const openDetectedLink = async () => {
    if (!lastDetectedUrl) return
    const result = await window.devorbit.navigateWeb(lastDetectedUrl)
    if (result.success) onNotifyRef.current('Link do terminal aberto no painel Web.', 'success')
    else onNotifyRef.current(result.message || 'Não foi possível abrir o link no painel Web.', 'error')
  }

  const restartTerminal = async () => {
    outputSnapshotRef.current = ''
    await startShell()
  }

  return (
    <section className="workspace-terminal-panel" aria-label="Terminal interno">
      <div className="workspace-panel-heading terminal-heading">
        <div>
          <strong><TerminalIcon size={14} aria-hidden="true" /> Terminal interno</strong>
          <span className={'terminal-status ' + terminalState}>
            <i />
            {terminalState === 'ready' ? (terminalMode === 'codex' ? 'Codex ativo' : terminalMode === 'agent' ? providerLabels[provider] + ' ativo' : 'Pronto')
              : terminalState === 'starting' ? 'Iniciando'
              : terminalState === 'error' ? 'Erro' : 'Encerrado'}
          </span>
        </div>
        <div className="terminal-actions">
          {lastDetectedUrl && (
            <button
              type="button"
              className="workspace-tool-button terminal-codex-button"
              onClick={() => void openDetectedLink()}
              title="Abrir o último link HTTPS impresso no terminal no painel Web"
            >
              <Globe size={13} aria-hidden="true" /><span>Abrir Web</span>
            </button>
          )}
          <button
            type="button"
            className="workspace-tool-button terminal-codex-button"
            onClick={() => void startCodex()}
            disabled={!codexAccount || isStartingCodex || terminalState === 'starting'}
            title={codexAccount ? 'Iniciar Codex com a conta ' + (codexAccount === 'account2' ? '2' : '1') : 'Configure a conta Codex deste agente para iniciar'}
          >
            <Code2 size={13} aria-hidden="true" /><span>{isStartingCodex ? 'Conectando…' : 'Codex'}</span>
          </button>
          <button
            type="button"
            className="workspace-icon-button"
            onClick={() => void restartTerminal()}
            aria-label="Reiniciar terminal"
            title="Reiniciar terminal"
          >
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div
        ref={containerRef}
        className="workspace-terminal-xterm"
        aria-label="Console interativo"
      />
    </section>
  )
}
