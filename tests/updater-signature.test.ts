import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const autoUpdaterMock = vi.hoisted(() => ({
  autoDownload: false,
  autoInstallOnAppQuit: false,
  on: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
  requestHeaders: null as Record<string, string> | null,
}))

vi.mock('electron-updater', () => ({
  default: { autoUpdater: autoUpdaterMock },
}))

const testState = vi.hoisted(() => ({ tempDir: '' }))

const electronAppMock = vi.hoisted(() => ({
  isPackaged: true,
  getVersion: () => '1.0.45',
  getPath: (name: string) => testState.tempDir || process.env.TEMP || process.env.TMP || '.',
  on: vi.fn(),
}))

vi.mock('electron', () => ({
  default: { app: electronAppMock },
}))

import {
  _resetUpdaterForTest,
  _setExecFileRunnerForTest,
  checkPortableForUpdates,
  downloadUpdate,
  EXPECTED_UPDATE_CERT_THUMBPRINT,
  EXPECTED_UPDATE_PUBLISHER,
  getUpdateState,
  handleAppQuitPortableUpdate,
  initializeUpdater,
  installUpdate,
  verifyAuthenticode,
} from '../src/main/updater'

interface RunnerCall {
  file: string
  args: readonly string[]
}

const originalPlatform = process.platform
const originalFetch = globalThis.fetch
const ORIGINAL_ENV: Record<string, string | undefined> = {}
const ENV_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN', 'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_FILE', 'SystemRoot']

let tempDir = ''
let signatureCalls: RunnerCall[] = []
let signatureOutput = { stdout: '', stderr: '' }

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function setSignatureOutput(stdout: string): void {
  signatureOutput = { stdout, stderr: '' }
}

function powershellCallCount(): number {
  return signatureCalls.filter((call) => String(call.file).toLowerCase().includes('powershell')).length
}

function getDownloadedHandler(): (info: { version: string; downloadedFile?: string }) => void {
  const calls = autoUpdaterMock.on.mock.calls.filter(([event]) => event === 'update-downloaded')
  const call = calls[calls.length - 1]
  if (!call) throw new Error('handler update-downloaded não foi registrado')
  return call[1] as (info: { version: string; downloadedFile?: string }) => void
}

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-signature-'))
}

async function createFakePowershellTree(root: string): Promise<string> {
  const powershellPath = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  await fs.mkdir(path.dirname(powershellPath), { recursive: true })
  await fs.writeFile(powershellPath, '', 'utf8')
  return powershellPath
}

function mockPortableReleaseFetch(content: Buffer, sha512: string): void {
  globalThis.fetch = vi.fn(async (url: string) => {
    if (String(url).includes('/releases/latest')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async (): Promise<string> =>
          JSON.stringify({
            tag_name: 'v1.0.46',
            assets: [
              { id: 1, name: 'latest-portable.yml', url: 'https://api.github.com/repos/jrmello4/devorbit/releases/assets/1', size: 200 },
              { id: 2, name: 'DevOrbit-1.0.46-portable.exe', url: 'https://api.github.com/repos/jrmello4/devorbit/releases/assets/2', size: content.length },
            ],
          }),
      }
    }
    if (String(url).includes('/releases/assets/1')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        text: async (): Promise<string> => `version: 1.0.46\npath: DevOrbit-1.0.46-portable.exe\nsha512: ${sha512}`,
      }
    }
    if (String(url).includes('/releases/assets/2')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(content.length) }),
        body: new Blob([new Uint8Array(content)]).stream(),
      }
    }
    return { ok: false, status: 404, text: async (): Promise<string> => 'Not Found' }
  }) as unknown as typeof globalThis.fetch
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    ORIGINAL_ENV[key] = process.env[key]
  }
  signatureCalls = []
  signatureOutput = { stdout: '', stderr: '' }
  _resetUpdaterForTest()
})

afterEach(async () => {
  _setExecFileRunnerForTest(null)
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] !== undefined) process.env[key] = ORIGINAL_ENV[key]
    else delete process.env[key]
  }
  stubPlatform(originalPlatform)
  globalThis.fetch = originalFetch
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    tempDir = ''
  }
  testState.tempDir = ''
  signatureCalls = []
  _resetUpdaterForTest()
})

describe('verifyAuthenticode', () => {
  beforeEach(async () => {
    tempDir = await makeTempDir()
    testState.tempDir = tempDir
    stubPlatform('win32')
  })

  it('(a) aceita Status Valid com publisher esperado no subject e chama o PowerShell corretamente', async () => {
    const filePath = path.join(tempDir, 'update.exe')
    await fs.writeFile(filePath, 'binary')
    setSignatureOutput('STATUS=Valid\r\nSIGNER=CN=DevOrbit, O=DevOrbit, C=BR\r\n')
    _setExecFileRunnerForTest(async (file, args) => {
      signatureCalls.push({ file, args })
      return signatureOutput
    })

    const result = await verifyAuthenticode(filePath, 'DevOrbit')

    expect(result).toEqual({ status: 'Valid', signer: 'CN=DevOrbit, O=DevOrbit, C=BR' })
    expect(powershellCallCount()).toBe(1)
    const [call] = signatureCalls
    expect(String(call.file).toLowerCase()).toContain('powershell.exe')
    expect(call.args).toContain('-NoLogo')
    expect(call.args).toContain('-NoProfile')
    expect(call.args).toContain('-NonInteractive')
    expect(call.args).toContain('-ExecutionPolicy')
    expect(call.args).toContain('Bypass')
    expect(call.args).toContain('-Command')
    const command = call.args[call.args.indexOf('-Command') + 1]
    expect(command).toContain('Get-AuthenticodeSignature')
    expect(command).toContain(filePath)
  })

  it('(b) rejeita NotSigned e HashMismatch', async () => {
    const filePath = path.join(tempDir, 'update.exe')
    await fs.writeFile(filePath, 'binary')
    _setExecFileRunnerForTest(async (file, args) => {
      signatureCalls.push({ file, args })
      return signatureOutput
    })

    setSignatureOutput('STATUS=NotSigned\r\nSIGNER=\r\n')
    await expect(verifyAuthenticode(filePath, 'DevOrbit')).rejects.toThrow(/Authenticode falhou \(Status: NotSigned\)/)

    setSignatureOutput('STATUS=HashMismatch\r\nSIGNER=\r\n')
    await expect(verifyAuthenticode(filePath, 'DevOrbit')).rejects.toThrow(/Authenticode falhou \(Status: HashMismatch\)/)
  })

  it('(c) rejeita publisher diferente do esperado e certificado sem subject', async () => {
    const filePath = path.join(tempDir, 'update.exe')
    await fs.writeFile(filePath, 'binary')
    _setExecFileRunnerForTest(async (file, args) => {
      signatureCalls.push({ file, args })
      return signatureOutput
    })

    setSignatureOutput('STATUS=Valid\r\nSIGNER=CN=Outra Empresa Ltda, O=Outra Empresa\r\n')
    await expect(verifyAuthenticode(filePath, 'DevOrbit')).rejects.toThrow('não corresponde ao esperado')

    setSignatureOutput('STATUS=Valid\r\nSIGNER=\r\n')
    await expect(verifyAuthenticode(filePath, 'DevOrbit')).rejects.toThrow('não possui publisher no subject')
  })

  it('(d) falha fail-closed em erro/timeout do PowerShell e em saída inesperada', async () => {
    const filePath = path.join(tempDir, 'update.exe')
    await fs.writeFile(filePath, 'binary')

    _setExecFileRunnerForTest(async () => {
      throw new Error('Command failed: powershell exited with ETIMEDOUT')
    })
    await expect(verifyAuthenticode(filePath, 'DevOrbit')).rejects.toThrow('não pôde ser concluída')

    _setExecFileRunnerForTest(async () => ({ stdout: 'saida sem marcadores', stderr: '' }))
    await expect(verifyAuthenticode(filePath, 'DevOrbit')).rejects.toThrow('Saída inesperada')

    // Publisher vazio (configuração atual): exige apenas Status Valid.
    _setExecFileRunnerForTest(async () => ({ stdout: 'STATUS=Valid\r\nSIGNER=\r\n', stderr: '' }))
    await expect(verifyAuthenticode(filePath, '')).resolves.toEqual({ status: 'Valid', signer: null })

    // Arquivo ausente também é falha (fail-closed), sem chamar PowerShell.
    _setExecFileRunnerForTest(async (file, args) => {
      signatureCalls.push({ file, args })
      return { stdout: 'STATUS=Valid\r\n', stderr: '' }
    })
    await expect(verifyAuthenticode(path.join(tempDir, 'ausente.exe'), '')).rejects.toThrow('não encontrado')
    expect(powershellCallCount()).toBe(0)
  })

  it('(f) fora do Windows não chama o PowerShell e pula a verificação de assinatura', async () => {
    stubPlatform('linux')
    _setExecFileRunnerForTest(async (file, args) => {
      signatureCalls.push({ file, args })
      throw new Error('PowerShell não deveria ser chamado fora do Windows')
    })

    await expect(verifyAuthenticode('C:\\qualquer\\caminho.exe', 'DevOrbit')).resolves.toEqual({
      status: 'SkippedNonWindows',
      signer: null,
    })
    expect(signatureCalls).toHaveLength(0)
  })

  it('mantém EXPECTED_UPDATE_PUBLISHER e EXPECTED_UPDATE_CERT_THUMBPRINT vazios enquanto electron-builder.json não define certificateSubjectName/publisherName', async () => {
    const builderConfigPath = path.join(process.cwd(), 'electron-builder.json')
    const builderConfig = JSON.parse(await fs.readFile(builderConfigPath, 'utf8')) as {
      win?: { certificateSubjectName?: string; publisherName?: string }
    }
    expect(builderConfig?.win?.certificateSubjectName).toBeUndefined()
    expect(builderConfig?.win?.publisherName).toBeUndefined()
    expect(EXPECTED_UPDATE_PUBLISHER).toBe('')
    // Pinning de thumbprint também permanece desativado enquanto o build não
    // é assinado com cert fixo (pareia com o secret WINDOWS_CERTIFICATE_THUMBPRINT).
    expect(EXPECTED_UPDATE_CERT_THUMBPRINT).toBe('')
  })

  describe('thumbprint do certificado (EXPECTED_UPDATE_CERT_THUMBPRINT)', () => {
    // Thumbprints fictícios de 40 hex (SHA-1) para os testes de pinning.
    const THUMBPRINT_A = 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2'
    const THUMBPRINT_B = '0123456789ABCDEF0123456789ABCDEF01234567'

    async function createUpdateBinary(): Promise<string> {
      const filePath = path.join(tempDir, 'update.exe')
      await fs.writeFile(filePath, 'binary')
      return filePath
    }

    function stubRunner(): void {
      _setExecFileRunnerForTest(async (file, args) => {
        signatureCalls.push({ file, args })
        return signatureOutput
      })
    }

    it('(a) thumbprint esperado igual após normalização (caixa/espaços/hífens) passa', async () => {
      const filePath = await createUpdateBinary()
      setSignatureOutput(`STATUS=Valid\r\nSIGNER=CN=DevOrbit\r\nTHUMBPRINT=${THUMBPRINT_A}\r\n`)
      stubRunner()

      const result = await verifyAuthenticode(
        filePath,
        '',
        ' a1b2-c3d4 e5f6-a1b2 c3d4-e5f6 a1b2-c3d4-e5f6-a1b2 '
      )

      expect(result).toEqual({ status: 'Valid', signer: 'CN=DevOrbit' })
      expect(powershellCallCount()).toBe(1)
      const [call] = signatureCalls
      const command = call.args[call.args.indexOf('-Command') + 1]
      // O script PowerShell precisa emitir a linha machine-readable THUMBPRINT=.
      expect(command).toContain('THUMBPRINT=')
    })

    it('(b) thumbprint divergente do esperado falha', async () => {
      const filePath = await createUpdateBinary()
      setSignatureOutput(`STATUS=Valid\r\nSIGNER=CN=DevOrbit\r\nTHUMBPRINT=${THUMBPRINT_B}\r\n`)
      stubRunner()

      await expect(verifyAuthenticode(filePath, '', THUMBPRINT_A)).rejects.toThrow(
        'O thumbprint do certificado da atualização não corresponde ao esperado.'
      )
    })

    it('(c) THUMBPRINT ausente na saída do PowerShell com expectativa setada falha (fail-closed)', async () => {
      const filePath = await createUpdateBinary()
      stubRunner()

      // Linha THUMBPRINT inteiramente ausente na saída.
      setSignatureOutput('STATUS=Valid\r\nSIGNER=CN=DevOrbit\r\n')
      await expect(verifyAuthenticode(filePath, '', THUMBPRINT_A)).rejects.toThrow(
        'O thumbprint do certificado da atualização não ficou disponível para verificação.'
      )

      // Linha presente, mas vazia (SignerCertificate sem thumbprint).
      setSignatureOutput('STATUS=Valid\r\nSIGNER=CN=DevOrbit\r\nTHUMBPRINT=\r\n')
      await expect(verifyAuthenticode(filePath, '', THUMBPRINT_A)).rejects.toThrow(
        'O thumbprint do certificado da atualização não ficou disponível para verificação.'
      )
    })

    it('(d) expectativa vazia pula a checagem de thumbprint (comportamento atual preservado)', async () => {
      const filePath = await createUpdateBinary()
      stubRunner()

      // Sem linha THUMBPRINT na saída e sem expectativa: passa.
      setSignatureOutput('STATUS=Valid\r\nSIGNER=\r\n')
      await expect(verifyAuthenticode(filePath, '')).resolves.toEqual({ status: 'Valid', signer: null })

      // THUMBPRINT divergente presente e expectativa vazia: também passa.
      setSignatureOutput(`STATUS=Valid\r\nSIGNER=CN=Outra Empresa\r\nTHUMBPRINT=${THUMBPRINT_B}\r\n`)
      await expect(verifyAuthenticode(filePath, '', '')).resolves.toEqual({
        status: 'Valid',
        signer: 'CN=Outra Empresa',
      })
    })

    it('(e) publisher e thumbprint juntos válidos passam', async () => {
      const filePath = await createUpdateBinary()
      setSignatureOutput(
        `STATUS=Valid\r\nSIGNER=CN=DevOrbit, O=DevOrbit, C=BR\r\nTHUMBPRINT=${THUMBPRINT_A}\r\n`
      )
      stubRunner()

      await expect(
        verifyAuthenticode(filePath, 'DevOrbit', THUMBPRINT_A.toLowerCase())
      ).resolves.toEqual({ status: 'Valid', signer: 'CN=DevOrbit, O=DevOrbit, C=BR' })
    })
  })
})

describe('fluxo portable com verificação de assinatura', () => {
  const fakeBinary = Buffer.from('DEVORBIT-FAKE-UPDATE-BINARY')
  const fakeBinarySha512 = createHash('sha512').update(fakeBinary).digest('hex')

  beforeEach(async () => {
    tempDir = await makeTempDir()
    testState.tempDir = tempDir
    stubPlatform('win32')
    process.env.GH_TOKEN = 'gho_portable_test_token'
    process.env.PORTABLE_EXECUTABLE_DIR = tempDir
    process.env.PORTABLE_EXECUTABLE_FILE = path.join(tempDir, 'DevOrbit.exe')
    process.env.SystemRoot = tempDir
    await fs.writeFile(path.join(tempDir, 'DevOrbit.exe'), 'current-app')
    await createFakePowershellTree(tempDir)
    _setExecFileRunnerForTest(async (file, args) => {
      signatureCalls.push({ file, args })
      return signatureOutput
    })
  })

  it('(e) assinatura inválida no download → estado de erro e instalação NÃO agendada', async () => {
    setSignatureOutput('STATUS=NotSigned\r\nSIGNER=\r\n')
    mockPortableReleaseFetch(fakeBinary, fakeBinarySha512)

    await checkPortableForUpdates('portable')
    await downloadUpdate()

    const state = getUpdateState()
    expect(state.status).toBe('error')
    expect(state.message).toContain('Authenticode')
    expect(state.message).toContain('NotSigned')
    // Logs não-sensíveis: o token não pode aparecer em mensagens de erro.
    expect(state.message).not.toContain('gho_portable_test_token')
    expect(state.diagnostic?.errorDetail).toContain('NotSigned')

    // Instalação não é agendada: arquivo não foi promovido, quit handler recusa.
    await expect(handleAppQuitPortableUpdate()).resolves.toBe(false)
  })

  it('hash incorreto aborta antes da verificação de assinatura (PowerShell não é chamado)', async () => {
    const wrongSha = 'a'.repeat(128)
    setSignatureOutput('STATUS=Valid\r\nSIGNER=CN=DevOrbit\r\n')
    mockPortableReleaseFetch(fakeBinary, wrongSha)

    await checkPortableForUpdates('portable')
    await downloadUpdate()

    const state = getUpdateState()
    expect(state.status).toBe('error')
    expect(state.message).toContain('integridade')
    expect(powershellCallCount()).toBe(0)
  })

  it('revalida a assinatura antes de agendar a instalação no encerramento e aborta em caso de falha', async () => {
    setSignatureOutput('STATUS=Valid\r\nSIGNER=CN=DevOrbit\r\n')
    mockPortableReleaseFetch(fakeBinary, fakeBinarySha512)

    await checkPortableForUpdates('portable')
    await downloadUpdate()
    expect(getUpdateState().status).toBe('downloaded')
    expect(powershellCallCount()).toBe(1)

    // Localiza o binário promovido (.download → .exe) criado pelo download.
    const entries = await fs.readdir(tempDir)
    const downloadedName = entries.find((name) => /^DevOrbit-1\.0\.46-\d+\.exe$/.test(name))
    expect(downloadedName).toBeDefined()

    // Binário é trocado por um não assinado entre o download e o quit.
    setSignatureOutput('STATUS=NotSigned\r\nSIGNER=\r\n')
    await expect(handleAppQuitPortableUpdate()).resolves.toBe(false)

    const state = getUpdateState()
    expect(state.status).toBe('error')
    expect(state.message).toContain('Authenticode')
    // O binário rejeitado é removido para evitar instalação posterior.
    await expect(fs.access(path.join(tempDir, downloadedName as string))).rejects.toThrow()
  })

  it('fora do Windows o hash continua obrigatório e o PowerShell não é chamado', async () => {
    stubPlatform('linux')
    setSignatureOutput('STATUS=Valid\r\nSIGNER=CN=DevOrbit\r\n')
    mockPortableReleaseFetch(fakeBinary, fakeBinarySha512)

    await checkPortableForUpdates('portable')
    await downloadUpdate()

    const state = getUpdateState()
    expect(state.status).toBe('downloaded')
    expect(state.version).toBe('1.0.46')
    expect(powershellCallCount()).toBe(0)
  })
})

describe('fluxo instalado (NSIS) com verificação de assinatura', () => {
  let installerPath: string

  beforeEach(async () => {
    tempDir = await makeTempDir()
    testState.tempDir = tempDir
    stubPlatform('win32')
    delete process.env.PORTABLE_EXECUTABLE_DIR
    delete process.env.PORTABLE_EXECUTABLE_FILE
    process.env.GH_TOKEN = 'gho_nsis_test_token'
    installerPath = path.join(tempDir, 'DevOrbit-Setup-1.0.46.exe')
    await fs.writeFile(installerPath, 'fake-installer')
    autoUpdaterMock.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.0.46' } })
    _setExecFileRunnerForTest(async (file, args) => {
      signatureCalls.push({ file, args })
      return signatureOutput
    })
    initializeUpdater(() => undefined)
  })

  it('update-downloaded com assinatura válida transita para downloaded', async () => {
    setSignatureOutput('STATUS=Valid\r\nSIGNER=CN=DevOrbit, O=DevOrbit, C=BR\r\n')
    const handler = getDownloadedHandler()
    handler({ version: '1.0.46', downloadedFile: installerPath })

    await vi.waitFor(() => {
      expect(getUpdateState().status).toBe('downloaded')
    }, { timeout: 10_000 })
    expect(getUpdateState().version).toBe('1.0.46')
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(true)
    expect(powershellCallCount()).toBe(1)
  })

  it('update-downloaded com assinatura inválida → fail-closed: erro, sem auto-install e installUpdate recusa', async () => {
    setSignatureOutput('STATUS=HashMismatch\r\nSIGNER=\r\n')
    const handler = getDownloadedHandler()
    handler({ version: '1.0.46', downloadedFile: installerPath })

    await vi.waitFor(() => {
      expect(getUpdateState().status).toBe('error')
    }, { timeout: 10_000 })
    expect(getUpdateState().message).toContain('HashMismatch')
    // Impede o electron-updater de instalar no encerramento.
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false)

    const result = await installUpdate()
    expect(result.success).toBe(false)
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
  })

  it('update-downloaded sem caminho do arquivo no Windows → fail-closed', async () => {
    setSignatureOutput('STATUS=Valid\r\nSIGNER=CN=DevOrbit\r\n')
    const handler = getDownloadedHandler()
    handler({ version: '1.0.46' })

    await vi.waitFor(() => {
      expect(getUpdateState().status).toBe('error')
    }, { timeout: 10_000 })
    expect(getUpdateState().message).toContain('indisponível para verificação')
    expect(powershellCallCount()).toBe(0)
  })

  it('installUpdate revalida a assinatura imediatamente antes de quitAndInstall', async () => {
    setSignatureOutput('STATUS=Valid\r\nSIGNER=CN=DevOrbit\r\n')
    const handler = getDownloadedHandler()
    handler({ version: '1.0.46', downloadedFile: installerPath })
    await vi.waitFor(() => {
      expect(getUpdateState().status).toBe('downloaded')
    }, { timeout: 10_000 })

    // Binário/certificado rejeitado entre o download e o clique em instalar.
    // (O default de EXPECTED_UPDATE_PUBLISHER é vazio — ver testes unitários —,
    // então a revalidação aqui é exercida com Status inválido.)
    setSignatureOutput('STATUS=HashMismatch\r\nSIGNER=\r\n')
    const result = await installUpdate()

    expect(result.success).toBe(false)
    expect(result.message).toContain('HashMismatch')
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    expect(getUpdateState().status).toBe('error')
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false)
    expect(powershellCallCount()).toBe(2)
  })
})
