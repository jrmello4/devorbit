import electron from 'electron'
import updater from 'electron-updater'

const { app } = electron
const { autoUpdater } = updater

export type UpdateStatus = 'unavailable' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'

export interface UpdateState {
  supported: boolean
  status: UpdateStatus
  version?: string
  progress?: number
  message?: string
}

let state: UpdateState = { supported: false, status: 'unavailable' }
let publishState: (nextState: UpdateState) => void = () => undefined
let initialized = false

function setState(nextState: UpdateState): void {
  state = nextState
  publishState(state)
}

function canUpdate(): boolean {
  return app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR
}

export function getUpdateState(): UpdateState {
  return state
}

export function initializeUpdater(sendState: (nextState: UpdateState) => void): void {
  publishState = sendState
  if (initialized) {
    publishState(state)
    return
  }
  initialized = true

  if (!canUpdate()) {
    setState({ supported: false, status: 'unavailable' })
    return
  }

  state = { supported: true, status: 'idle' }
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => setState({ supported: true, status: 'checking' }))
  autoUpdater.on('update-not-available', () => setState({ supported: true, status: 'idle' }))
  autoUpdater.on('update-available', (info) => {
    setState({ supported: true, status: 'available', version: info.version })
  })
  autoUpdater.on('download-progress', (progress) => {
    setState({ supported: true, status: 'downloading', version: state.version, progress: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    setState({ supported: true, status: 'downloaded', version: info.version, progress: 100 })
  })
  autoUpdater.on('error', (error) => {
    console.warn('Falha ao verificar atualização:', error)
    setState({ supported: true, status: 'error', message: error.message })
  })

  void autoUpdater.checkForUpdates().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    setState({ supported: true, status: 'error', message })
  })
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (!canUpdate() || state.status !== 'available') return state
  setState({ ...state, status: 'downloading', progress: 0 })
  try {
    await autoUpdater.downloadUpdate()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    setState({ supported: true, status: 'error', version: state.version, message })
  }
  return state
}

export function installUpdate(): void {
  if (!canUpdate() || state.status !== 'downloaded') return
  autoUpdater.quitAndInstall()
}
