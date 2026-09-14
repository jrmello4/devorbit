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

import { getPortableExecutablePath, getUpdateDistribution, isNewerVersion, parsePortableManifest } from '../src/main/updater'

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

describe('portable update helpers', () => {
  it('detects only newer stable versions', () => {
    expect(isNewerVersion('1.0.15', '1.0.14')).toBe(true)
    expect(isNewerVersion('1.0.14', '1.0.14')).toBe(false)
    expect(isNewerVersion('1.0.13', '1.0.14')).toBe(false)
    expect(isNewerVersion('invalid', '1.0.14')).toBe(false)
  })

  it('parses and validates the portable manifest', () => {
    const digest = 'a'.repeat(128)
    expect(parsePortableManifest('\uFEFFversion: 1.0.15\npath: DevOrbit-1.0.15-portable.exe\nsha512: ' + digest)).toEqual({
      version: '1.0.15',
      path: 'DevOrbit-1.0.15-portable.exe',
      sha512: digest,
    })
    expect(parsePortableManifest('version: 1.0.15\npath: ../unsafe.exe\nsha512: ' + digest)).toBeNull()
  })

  it('locates the portable executable from builder environment values', () => {
    expect(getPortableExecutablePath({ portableExecutableFile: 'C:\\portable\\DevOrbit.exe' })).toBe('C:\\portable\\DevOrbit.exe')
    expect(getPortableExecutablePath({ portableExecutableDir: 'C:\\portable', executablePath: 'C:\\runtime\\electron.exe' })).toBe('C:\\portable\\electron.exe')
  })
})