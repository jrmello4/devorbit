import React, { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Code2, Globe, RefreshCw, Terminal as TerminalIcon } from 'lucide-react'
import type { TerminalEvent } from '../types'

interface WorkspaceTerminalProps {
  projectPath: string
  terminalId: string
  codexAccount: 'account1' | 'account2'
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void
  onRequestCodexAuth?: (account: 'account1' | 'account2') => void
  agentTask?: { id: string; prompt: string }
  onAgentResult?: (result: string) => void
}

type TerminalState = 'starting' | 'ready' | 'stopped' | 'error'
type TerminalMode = 'shell' | 'codex'

const MAX_SNAPSHOT_LENGTH = 40_000

export const WorkspaceTerminal: React.FC<WorkspaceTerminalProps> = ({
  projectPath,
  terminalId,
  codexAccount,
  onNotify,
  onRequestCodexAuth,
  agentTask,
  onAgentResult,
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const outputSnapshotRef = useRef('')
  const completedTaskRef = useRef<string | null>(null)
  const deliveringTaskRef = useRef<string | null>(null)
  const reportedResultsRef = useRef(new Set<string>())
  // Every start replaces the PTY behind this terminal id. Keep a local token so
  // a late response from the initial CMD startup cannot repaint a newer Codex
  // session as a shell session.
  const terminalStartTokenRef = useRef(0)
  const terminalModeRef = useRef<TerminalMode>('shell')
  const fitTerminalRef = useRef<() => void>(() => undefined)
  const onNotifyRef = useRef(onNotify)
  const onRequestCodexAuthRef = useRef(onRequestCodexAuth)
  const onAgentResultRef = useRef(onAgentResult)
  onNotifyRef.current = onNotify
  onRequestCodexAuthRef.current = onRequestCodexAuth
  onAgentResultRef.current = onAgentResult
  const [terminalState, setTerminalState] = useState<TerminalState>('starting')
  const [terminalMode, setTerminalMode] = useState<TerminalMode>('shell')
  const [isStartingCodex, setIsStartingCodex] = useState(false)
  const [lastDetectedUrl, setLastDetectedUrl] = useState('')

  const startShell = useCallback(async () => {
    const startToken = ++terminalStartTokenRef.current
    terminalModeRef.current = 'shell'
    setTerminalMode('shell')
    setTerminalState('starting')
    try {
      const result = await window.devorbit.startTerminal(
        terminalId,
        projectPath,
      )
      if (startToken === terminalStartTokenRef.current) {
        terminalRef.current?.clear()
        terminalRef.current?.writeln('\x1b[90mDevOrbit terminal PTY pronto.\x1b[0m')
        setTerminalState('ready')
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
  }, [projectPath, terminalId])

  const startCodex = useCallback(async () => {
    const startToken = ++terminalStartTokenRef.current
    terminalModeRef.current = 'codex'
    setIsStartingCodex(true)
    setTerminalState('starting')
    try {
      const result = await window.devorbit.startCodexTerminal(
        terminalId,
        projectPath,
        codexAccount,
        terminalRef.current?.cols,
        terminalRef.current?.rows,
      )
      if (!result.success) {
        if (startToken !== terminalStartTokenRef.current) return result
        terminalModeRef.current = 'shell'
        setTerminalMode('shell')
        setTerminalState(result.needsAuth ? 'ready' : 'error')
        if (result.message) onNotifyRef.current(result.message, result.needsAuth ? 'info' : 'error')
        if (result.needsAuth) onRequestCodexAuthRef.current?.(codexAccount)
        return result
      }
      if (startToken === terminalStartTokenRef.current) {
        setTerminalMode('codex')
        terminalRef.current?.clear()
        terminalRef.current?.writeln('\x1b[90mDevOrbit iniciou o Codex nesta sessão.\x1b[0m')
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
        window.requestAnimationFrame(refit)
        window.setTimeout(refit, 140)
        window.setTimeout(refit, 650)
      }
      return result
    } catch (error) {
      if (startToken !== terminalStartTokenRef.current) return null
      setTerminalState('error')
      const message = error instanceof Error ? error.message : String(error)
      terminalRef.current?.writeln('\r\n\x1b[31m[erro ao iniciar o Codex: ' + message + ']\x1b[0m')
      onNotifyRef.current('Não foi possível iniciar o Codex no terminal: ' + message, 'error')
      return null
    } finally {
      setIsStartingCodex(false)
    }
  }, [codexAccount, projectPath, terminalId])

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
        background: '#20261f',
        foreground: '#d9e3d4',
        cursor: '#aebeaa',
        selectionBackground: '#52614d',
        black: '#20261f',
        brightBlack: '#72806e',
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
        white: '#d9e3d4',
        brightWhite: '#f4f8f1',
      },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const fitTerminal = () => {
      try {
        fitAddon.fit()
        if (terminal.cols >= 40 && terminal.rows >= 12) {
          void window.devorbit.resizeTerminal(terminalId, terminal.cols, terminal.rows)
        }
      } catch {
        // The terminal can be temporarily detached while the workspace changes
        // visibility. The next resize event will fit it again.
      }
    }
    fitTerminalRef.current = fitTerminal

    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(fitTerminal)
    })
    resizeObserver.observe(container)
    fitTerminal()

    const inputDisposable = terminal.onData((data) => {
      if (terminalStateRef.current !== 'ready') return
      void window.devorbit.writeTerminal(terminalId, data)
    })

    const unsubscribe = window.devorbit.onTerminalEvent((event: TerminalEvent) => {
      if (event.id !== terminalId) return
      if (event.type === 'data' && event.data) {
        outputSnapshotRef.current = (outputSnapshotRef.current + event.data).slice(-MAX_SNAPSHOT_LENGTH)
        const detectedUrl = outputSnapshotRef.current.match(/https:\/\/[^\s"'<>`]+/i)?.[0]?.replace(/[),.;]+$/, '')
        if (detectedUrl) setLastDetectedUrl(detectedUrl)
        const result = outputSnapshotRef.current.match(/DEVORBIT_RESULT:\s*([^\r\n]+)/i)?.[1]?.trim()
        if (result && !reportedResultsRef.current.has(result)) {
          reportedResultsRef.current.add(result)
          onAgentResultRef.current?.(result.slice(0, 1000))
        }
        terminal.write(event.data)
      } else if (event.type === 'exit') {
        terminal.writeln('\r\n\x1b[90m[processo encerrado: ' + String(event.code ?? '') + ']\x1b[0m')
        setTerminalState('stopped')
      } else if (event.type === 'error') {
        terminal.writeln('\r\n\x1b[31m[erro: ' + (event.data || 'falha desconhecida') + ']\x1b[0m')
        setTerminalState('error')
      }
    })

    let alive = true
    const initialStartToken = ++terminalStartTokenRef.current
    terminalModeRef.current = 'shell'
    void window.devorbit.startTerminal(terminalId, projectPath)
      .then(() => {
        if (!alive || initialStartToken !== terminalStartTokenRef.current || terminalModeRef.current !== 'shell') return
        terminal.writeln('\x1b[90mDevOrbit terminal PTY pronto em ' + projectPath + '\x1b[0m')
        setTerminalState('ready')
      })
      .catch((error) => {
        if (!alive || initialStartToken !== terminalStartTokenRef.current) return
        const message = error instanceof Error ? error.message : String(error)
        terminal.writeln('\r\n\x1b[31m[erro ao iniciar: ' + message + ']\x1b[0m')
        setTerminalState('error')
        onNotifyRef.current('Não foi possível iniciar o terminal interno: ' + message, 'error')
      })

    return () => {
      alive = false
      inputDisposable.dispose()
      unsubscribe()
      resizeObserver.disconnect()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      fitTerminalRef.current = () => undefined
      void window.devorbit.stopTerminal(terminalId)
    }
  }, [projectPath, terminalId])

  useEffect(() => {
    if (!agentTask || completedTaskRef.current === agentTask.id || deliveringTaskRef.current === agentTask.id) return
    let cancelled = false
    const deliver = async () => {
      deliveringTaskRef.current = agentTask.id
      const ready = terminalMode === 'codex' ? { success: true } : await startCodex()
      if (cancelled || !ready?.success) { deliveringTaskRef.current = null; return }
      const written = await window.devorbit.writeTerminal(terminalId, agentTask.prompt + '\r')
      if (!cancelled && written.success) {
        completedTaskRef.current = agentTask.id
        onNotifyRef.current('Tarefa enviada ao agente.', 'success')
      }
      deliveringTaskRef.current = null
    }
    void deliver()
    return () => { cancelled = true }
  }, [agentTask, startCodex, terminalId, terminalMode])

  const terminalStateRef = useRef<TerminalState>(terminalState)
  terminalStateRef.current = terminalState

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
            {terminalState === 'ready' ? (terminalMode === 'codex' ? 'Codex ativo' : 'Pronto')
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
            disabled={isStartingCodex || terminalState === 'starting'}
            title={'Iniciar Codex com a conta ' + (codexAccount === 'account2' ? '2' : '1')}
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
