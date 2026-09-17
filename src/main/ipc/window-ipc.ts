import type { BrowserWindow } from 'electron'
import { validateWindowAction } from '../validation'
import type { IpcListenerRegistrar } from './registrar'

export interface WindowIpcDependencies {
  getWindow: () => BrowserWindow | null
}

export function registerWindowIpc(registerListener: IpcListenerRegistrar, dependencies: WindowIpcDependencies): void {
  registerListener('devorbit:windowControl', (_event, action: 'minimize' | 'maximize' | 'close') => {
    const window = dependencies.getWindow()
    if (!window) return
    const safeAction = validateWindowAction(action)
    if (safeAction === 'minimize') window.minimize()
    else if (safeAction === 'maximize') {
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    } else if (safeAction === 'close') window.close()
  })
}
