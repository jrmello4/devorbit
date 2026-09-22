import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

type ErrorListener = (error: Error) => void

interface FakeChildProcess {
  unref: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  emitError: (error: Error) => void
}

function createFakeChildProcess(): FakeChildProcess {
  const listeners: ErrorListener[] = []
  return {
    unref: vi.fn(),
    on: vi.fn((event: string, listener: ErrorListener) => {
      if (event === 'error') listeners.push(listener)
    }),
    emitError: (error: Error) => listeners.forEach((listener) => listener(error)),
  }
}

const { spawnMock, childSpawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  childSpawnMock: vi.fn(),
}))

vi.mock('node-pty', () => ({ spawn: spawnMock }))
vi.mock('node:child_process', () => ({ spawn: childSpawnMock }))

interface FakeTerminal {
  pid: number
  cols: number
  rows: number
  onData: (callback: (data: string) => void) => void
  onExit: (callback: (event: { exitCode: number }) => void) => void
  write: (input: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  emitData: (data: string) => void
  emitExit: (exitCode: number) => void
}

function createFakeTerminal(pid: number): FakeTerminal {
  const dataListeners: Array<(data: string) => void> = []
  const exitListeners: Array<(event: { exitCode: number }) => void> = []
  return {
    pid,
    cols: 120,
    rows: 32,
    onData: (callback) => { dataListeners.push(callback) },
    onExit: (callback) => { exitListeners.push(callback) },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    emitData: (data) => dataListeners.forEach((callback) => callback(data)),
    emitExit: (exitCode) => exitListeners.forEach((callback) => callback({ exitCode })),
  }
}

describe('terminal-session', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    vi.resetModules()
    spawnMock.mockReset()
    childSpawnMock.mockReset()
    childSpawnMock.mockImplementation(() => createFakeChildProcess())
  })

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('inicia PTY, encaminha saída, escrita e redimensionamento', async () => {
    const terminal = createFakeTerminal(401)
    spawnMock.mockReturnValue(terminal)
    const { onTerminalEvent, startTerminal, writeTerminal, resizeTerminal, stopTerminal } = await import('../src/main/terminal-session')

    const events: Array<{ type: string; data?: string; code?: number | null }> = []
    const unsubscribe = onTerminalEvent((event) => events.push(event))
    const result = await startTerminal('workspace-one', 'C:\\workspace')
    expect(result).toEqual({ id: 'workspace-one', pid: 401 })

    terminal.emitData('\x1b[31mhello\x1b[0m')
    expect(events).toContainEqual({ id: 'workspace-one', type: 'data', data: '\x1b[31mhello\x1b[0m' })
    expect(writeTerminal('workspace-one', 'Ctrl-C')).toBe(true)
    expect(terminal.write).toHaveBeenCalledWith('Ctrl-C')
    expect(resizeTerminal('workspace-one', 151, 44)).toBe(true)
    expect(terminal.resize).toHaveBeenCalledWith(151, 44)

    terminal.emitExit(0)
    expect(events).toContainEqual({ id: 'workspace-one', type: 'exit', code: 0 })
    stopTerminal('workspace-one')
    expect(terminal.kill).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('ignora eventos atrasados de uma sessão substituída', async () => {
    const first = createFakeTerminal(501)
    const second = createFakeTerminal(502)
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const { onTerminalEvent, startTerminal } = await import('../src/main/terminal-session')
    const events: Array<{ id: string; type: string; data?: string }> = []
    onTerminalEvent((event) => events.push(event))

    await startTerminal('workspace-one', 'C:\\workspace')
    await startTerminal('workspace-one', 'C:\\workspace')
    first.emitData('stale')
    first.emitExit(1)
    second.emitData('fresh')

    expect(events.filter((event) => event.type === 'data')).toEqual([
      { id: 'workspace-one', type: 'data', data: 'fresh' },
    ])
  })

  it('encerra todos os PTYs e ignora operaÃ§Ãµes posteriores', async () => {
    const first = createFakeTerminal(601)
    const second = createFakeTerminal(602)
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const { startTerminal, stopAllTerminals, writeTerminal } = await import('../src/main/terminal-session')

    await startTerminal('workspace-one', 'C:\\workspace')
    await startTerminal('workspace-two', 'C:\\workspace')

    stopAllTerminals()

    expect(first.kill).toHaveBeenCalledOnce()
    expect(second.kill).toHaveBeenCalledOnce()
    expect(writeTerminal('workspace-one', 'after-cleanup')).toBe(false)
    expect(writeTerminal('workspace-two', 'after-cleanup')).toBe(false)

    stopAllTerminals()
    expect(first.kill).toHaveBeenCalledOnce()
    expect(second.kill).toHaveBeenCalledOnce()
  })

  it('restart interno preserva arestas; stop limpa nas duas direções', async () => {
    const terminal = createFakeTerminal(701)
    spawnMock.mockReturnValue(terminal)
    const session = await import('../src/main/terminal-session')
    const pipes = await import('../src/main/pty-pipe')

    await session.startTerminal('pipe-src', 'C:\\workspace')
    await session.startTerminal('pipe-dst', 'C:\\workspace')
    pipes.setPipe('pipe-src', 'pipe-dst')
    expect(pipes.listPipes()).toEqual([{ from: 'pipe-src', to: 'pipe-dst' }])

    // Restart (mesmo id, ex. failover com troca de modelo): o cabo visual
    // continua desenhado, então o piping é preservado.
    await session.startTerminal('pipe-src', 'C:\\workspace')
    expect(pipes.listPipes()).toEqual([{ from: 'pipe-src', to: 'pipe-dst' }])
    expect(session.hasTerminal('pipe-src')).toBe(true)

    // Destino parado: sem cabo pendurado, origem viva.
    session.stopTerminal('pipe-dst')
    expect(pipes.listPipes()).toEqual([])
    expect(session.hasTerminal('pipe-src')).toBe(true)

    // Origem parada também limpa suas saídas.
    pipes.setPipe('pipe-src', 'pipe-dst')
    await session.startTerminal('pipe-dst', 'C:\\workspace')
    session.stopTerminal('pipe-src')
    expect(pipes.listPipes()).toEqual([])
  })

  it('não herda GH_TOKEN/GITHUB_TOKEN no ambiente do PTY', async () => {
    const terminal = createFakeTerminal(901)
    spawnMock.mockReturnValue(terminal)
    const previousGh = process.env.GH_TOKEN
    const previousGithub = process.env.GITHUB_TOKEN
    process.env.GH_TOKEN = 'ghp_secret_value'
    process.env.GITHUB_TOKEN = 'github_pat_secret_value'
    try {
      const { startTerminal } = await import('../src/main/terminal-session')
      // Mesmo que um overlay tente reinjetar, o PTY nunca recebe o token.
      await startTerminal('agent-scrub', 'C:\\workspace', { env: { GH_TOKEN: 'explicit', OTHER: 'ok' } })

      const options = spawnMock.mock.calls.at(-1)?.[2] as { env: NodeJS.ProcessEnv }
      expect(options.env.GH_TOKEN).toBeUndefined()
      expect(options.env.GITHUB_TOKEN).toBeUndefined()
      expect(options.env.OTHER).toBe('ok')
    } finally {
      if (previousGh === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = previousGh
      if (previousGithub === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = previousGithub
    }
  })

  it('parar tudo zera o grafo', async () => {
    const terminal = createFakeTerminal(801)
    spawnMock.mockReturnValue(terminal)
    const session = await import('../src/main/terminal-session')
    const pipes = await import('../src/main/pty-pipe')

    await session.startTerminal('pipe-src', 'C:\\workspace')
    await session.startTerminal('pipe-dst', 'C:\\workspace')
    pipes.setPipe('pipe-src', 'pipe-dst')
    session.stopAllTerminals()
    expect(pipes.listPipes()).toEqual([])
  })

  it('terminateProcessTree usa taskkill sem shell e nunca dispara processo real nos testes', async () => {
    const { terminateProcessTree } = await import('../src/main/terminal-session')

    expect(terminateProcessTree(4242)).toBe(true)
    expect(childSpawnMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4242', '/T', '/F'],
      expect.objectContaining({ windowsHide: true, stdio: 'ignore', shell: false }),
    )

    childSpawnMock.mockClear()
    expect(terminateProcessTree(4242, { platform: 'linux' })).toBe(false)
    expect(terminateProcessTree(-1)).toBe(false)
    expect(terminateProcessTree(0)).toBe(false)
    expect(terminateProcessTree(1.5)).toBe(false)
    expect(childSpawnMock).not.toHaveBeenCalled()

    childSpawnMock.mockImplementationOnce(() => { throw new Error('spawn blocked') })
    expect(terminateProcessTree(99)).toBe(false)
  })

  it('stopTerminal encerra a árvore no Windows e ainda chama kill como fallback', async () => {
    const terminal = createFakeTerminal(4242)
    spawnMock.mockReturnValue(terminal)
    const { startTerminal, stopTerminal } = await import('../src/main/terminal-session')

    await startTerminal('tree-stop', 'C:\\workspace')
    stopTerminal('tree-stop')

    expect(childSpawnMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4242', '/T', '/F'],
      expect.objectContaining({ shell: false }),
    )
    expect(terminal.kill).toHaveBeenCalledOnce()
  })

  it('expoe falha assincrona de spawn do taskkill sem vazar dados sensiveis e mantem kill', async () => {
    const terminal = createFakeTerminal(4343)
    spawnMock.mockReturnValue(terminal)
    const child = createFakeChildProcess()
    childSpawnMock.mockReturnValue(child)
    const { onTerminalEvent, startTerminal, stopTerminal } = await import('../src/main/terminal-session')

    const events: Array<{ type: string; data?: string }> = []
    const unsubscribe = onTerminalEvent((event) => events.push(event))
    await startTerminal('tree-async-fail', 'C:\\workspace')
    stopTerminal('tree-async-fail')

    expect(terminal.kill).toHaveBeenCalledOnce()

    child.emitError(Object.assign(new Error('spawn ENOENT: token=super-secret-value'), { code: 'ENOENT' }))
    const failure = events.find((event) => event.type === 'error')
    expect(failure?.data).toContain('4343')
    expect(failure?.data).toContain('ENOENT')
    expect(failure?.data).not.toContain('super-secret-value')
    expect(failure?.data).not.toContain('token=')
    unsubscribe()
  })

  it('reporta falha sincrona de spawn via onFailure e retorna false', async () => {
    const { terminateProcessTree } = await import('../src/main/terminal-session')
    const onFailure = vi.fn()
    childSpawnMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('blocked password=hunter2'), { code: 'EACCES' })
    })

    expect(terminateProcessTree(55, { onFailure })).toBe(false)
    expect(onFailure).toHaveBeenCalledWith({ pid: 55, reason: 'EACCES' })
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain('hunter2')
  })
})
