import { describe, expect, it, vi } from 'vitest'

const autoUpdaterMock = vi.hoisted(() => ({
  autoDownload: false,
  autoInstallOnAppQuit: false,
  on: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
}))

vi.mock('electron-updater', () => ({
  default: { autoUpdater: autoUpdaterMock },
}))

import { getUpdateDistribution } from '../src/main/updater'

describe('getUpdateDistribution', () => {
  it('classifica checkout como dev', () => {
    expect(getUpdateDistribution({ packaged: false, platform: 'win32' })).toBe('dev')
  })
  it('classifica portable pelo env', () => {
    expect(getUpdateDistribution({ packaged: true, platform: 'win32', portableDir: 'C:\\portable' })).toBe('portable')
  })
  it('classifica NSIS instalado', () => {
    expect(getUpdateDistribution({ packaged: true, platform: 'win32', portableDir: '' })).toBe('installed')
  })
  it('plataforma fora do Windows não promete update', () => {
    expect(getUpdateDistribution({ packaged: true, platform: 'darwin', portableDir: '' })).toBe('dev')
  })
})
