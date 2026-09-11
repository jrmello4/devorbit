import electron from 'electron'
import updater from 'electron-updater'

const { app } = electron
const { autoUpdater } = updater

export type UpdateStatus = 'unavailable' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'

export type UpdateDistribution = 'installed' | 'portable' | 'dev'

export interface UpdateState {
  supported: boolean
  status: UpdateStatus
  distribution: UpdateDistribution
  version?: string
  progress?: number
  message?: string
}

let state: UpdateState = { supported: false, status: 'unavailable', distribution: 'dev' }
let publishState: (nextState: UpdateState) => void = () => undefined
let initialized = false

function setState(nextState: UpdateState): void {
  state = nextState
  publishState(state)
}

export function getUpdateDistribution(info?: { packaged?: boolean; platform?: string; portableDir?: string }): UpdateDistribution {
  const packaged = info?.packaged ?? app.isPackaged
  const platform = info?.platform ?? process.platform
  const portableDir = info?.portableDir ?? process.env.PORTABLE_EXECUTABLE_DIR
  if (!packaged) return 'dev'
  if (portableDir) return 'portable'
  if (platform === 'win32') return 'installed'
  return 'dev'
}

function canUpdate(): boolean {
  return getUpdateDistribution() === 'installed'
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

  const distribution = getUpdateDistribution()
  if (distribution === 'portable') {
    setState({ supported: false, status: 'unavailable', distribution, message: 'Versão portable: baixe a nova versão manualmente na página Releases do GitHub.' })
    return
  }
  if (distribution !== 'installed') {
    setState({ supported: false, status: 'unavailable', distribution })
    return
  }

  state = { supported: true, status: 'idle', distribution }
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => setState({ supported: true, status: 'checking', distribution }))
  autoUpdater.on('update-not-available', () => setState({ supported: true, status: 'idle', distribution }))
  autoUpdater.on('update-available', (info) => {
    setState({ supported: true, status: 'available', distribution, version: info.version })
  })
  autoUpdater.on('download-progress', (progress) => {
    setState({ supported: true, status: 'downloading', distribution, version: state.version, progress: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    setState({ supported: true, status: 'downloaded', distribution, version: info.version, progress: 100 })
  })
  autoUpdater.on('error', (error) => {
    console.warn('Falha ao verificar atualização:', error)
    setState({ supported: true, status: 'error', distribution, message: error.message })
  })

  void autoUpdater.checkForUpdates().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    setState({ supported: true, status: 'error', distribution, message })
  })
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (!canUpdate() || state.status !== 'available') return state
  setState({ ...state, status: 'downloading', progress: 0 })
  try {
    await autoUpdater.downloadUpdate()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    setState({ supported: true, status: 'error', distribution: state.distribution, version: state.version, message })
  }
  return state
}

export function installUpdate(): void {
  if (!canUpdate() || state.status !== 'downloaded') return
  autoUpdater.quitAndInstall()
}
