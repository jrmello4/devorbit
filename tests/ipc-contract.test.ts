import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  assertTrustedIpcSender,
  isSameLocalFileUrl,
  isTrustedRendererUrl,
  type IpcSenderLike,
  type LocalFileUrlComparisonDeps,
  type TrustedIpcContext,
} from '../src/main/validation'

const TRUSTED_URL = 'file:///C:/app/dist/index.html'
const TRUSTED_ID = 7
const originalDevServerUrl = process.env.VITE_DEV_SERVER_URL

beforeEach(() => {
  delete process.env.VITE_DEV_SERVER_URL
})

afterEach(() => {
  if (originalDevServerUrl === undefined) {
    delete process.env.VITE_DEV_SERVER_URL
  } else {
    process.env.VITE_DEV_SERVER_URL = originalDevServerUrl
  }
})

/** Evento cujo senderFrame É o main frame do sender (frames idênticos por referência). */
const mainEvent = (id: number = TRUSTED_ID, url: string = TRUSTED_URL): IpcSenderLike => {
  const frame = { url }
  return { sender: { id, getURL: () => url, mainFrame: frame }, senderFrame: frame }
}

/** Contexto estrito no formato usado por registerIpcHandler em src/main/index.ts. */
const trustedCtx = (id: number = TRUSTED_ID): TrustedIpcContext => ({
  getTrustedWebContents: () => ({ id }),
  productionUrl: TRUSTED_URL,
})

/**
 * Resolver falso que espelha defaultResolveRealPath no cenário portable:
 * colapsa o alias 8.3 (ADENIL~1.J) no nome longo e preserva o sufixo virtual
 * após app.asar — sem tocar no filesystem, determinístico em qualquer CI.
 */
const aliasDeps: LocalFileUrlComparisonDeps = {
  resolveRealPath: (input) => input.replace(/ADENIL~1\.J/i, 'adenilson.j'),
}

// O bug do portable: o Chromium relata o 8.3 com ~ literal, o pathToFileURL
// codifica o mesmo caminho com %7E — antes da canonicalização, hrefs distintos.
const PORTABLE_ACTUAL = 'file:///C:/Users/ADENIL~1.J/x/dist/index.html'
const PORTABLE_EXPECTED = 'file:///C:/Users/ADENIL%7E1.J/x/dist/index.html'
const ASAR_ACTUAL = 'file:///C:/Users/ADENIL~1.J/App/resources/app.asar/dist/index.html'
const ASAR_EXPECTED = 'file:///C:/Users/ADENIL%7E1.J/App/resources/app.asar/dist/index.html'

describe('contrato de origem IPC (trusted sender)', () => {
  it('aceita exatamente a origem de produção', () => {
    expect(isTrustedRendererUrl(TRUSTED_URL, TRUSTED_URL)).toBe(true)
  })

  it('aceita https idêntico fora do modo file: (igualdade exata de href)', () => {
    expect(isTrustedRendererUrl('https://app.example/index.html', 'https://app.example/index.html')).toBe(true)
  })

  it('rejeita origem irmã, remota e valores não-string', () => {
    expect(isTrustedRendererUrl('file:///C:/app/dist/other.html', TRUSTED_URL)).toBe(false)
    expect(isTrustedRendererUrl('https://evil.example/', TRUSTED_URL)).toBe(false)
    expect(isTrustedRendererUrl(undefined, TRUSTED_URL)).toBe(false)
    expect(isTrustedRendererUrl(123, TRUSTED_URL)).toBe(false)
  })

  it('assertTrustedIpcSender aceita o frame confiável e lança para os demais', () => {
    expect(() =>
      assertTrustedIpcSender({ senderFrame: { url: TRUSTED_URL } }, TRUSTED_URL)
    ).not.toThrow()

    expect(() =>
      assertTrustedIpcSender({ senderFrame: { url: 'file:///C:/app/dist/other.html' } }, TRUSTED_URL)
    ).toThrow(/não autorizada/i)

    expect(() =>
      assertTrustedIpcSender(
        { senderFrame: null, sender: { getURL: () => 'https://evil.example/' } },
        TRUSTED_URL
      )
    ).toThrow(/não autorizada/i)
  })
})

describe('modo estrito de IPC (getTrustedWebContents)', () => {
  it('aceita WebContents confiável no main frame com URL de produção', () => {
    expect(() => assertTrustedIpcSender(mainEvent(), trustedCtx())).not.toThrow()
  })

  it('rejeita WebContents diferente mesmo copiando a URL confiável', () => {
    expect(() => assertTrustedIpcSender(mainEvent(99), trustedCtx())).toThrow(/não autorizada/i)
  })

  it('rejeita subframe da própria janela (senderFrame !== sender.mainFrame)', () => {
    const frame = { url: TRUSTED_URL }
    const subframeEvent: IpcSenderLike = {
      sender: { id: TRUSTED_ID, getURL: () => TRUSTED_URL, mainFrame: frame },
      senderFrame: { url: TRUSTED_URL },
    }
    expect(() => assertTrustedIpcSender(subframeEvent, trustedCtx())).toThrow(/não autorizada/i)
  })

  it('rejeita senderFrame nulo mesmo com id confiável', () => {
    const nullFrameEvent: IpcSenderLike = {
      sender: { id: TRUSTED_ID, getURL: () => TRUSTED_URL, mainFrame: { url: TRUSTED_URL } },
      senderFrame: null,
    }
    expect(() => assertTrustedIpcSender(nullFrameEvent, trustedCtx())).toThrow(/não autorizada/i)
  })

  it('rejeita main frame confiável com URL remota', () => {
    expect(() =>
      assertTrustedIpcSender(mainEvent(TRUSTED_ID, 'https://evil.example/'), trustedCtx())
    ).toThrow(/não autorizada/i)
  })

  it('falha fechado quando a janela confiável não existe (getTrustedWebContents → null)', () => {
    const goneCtx: TrustedIpcContext = { getTrustedWebContents: () => null, productionUrl: TRUSTED_URL }
    expect(() => assertTrustedIpcSender(mainEvent(), goneCtx)).toThrow(/não autorizada/i)
  })

  it('em modo dev aceita a origem do Vite no main frame confiável', () => {
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173'
    expect(() =>
      assertTrustedIpcSender(mainEvent(TRUSTED_ID, 'http://localhost:5173/'), trustedCtx())
    ).not.toThrow()
  })

  it('em modo dev rejeita origem de outro servidor local', () => {
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173'
    expect(() =>
      assertTrustedIpcSender(mainEvent(TRUSTED_ID, 'http://localhost:9999/'), trustedCtx())
    ).toThrow(/não autorizada/i)
  })
})

describe('isSameLocalFileUrl — equivalências do Windows portable', () => {
  it('o bug do portable: ~ literal (Chromium) vs %7E (pathToFileURL) é o mesmo arquivo', () => {
    expect(isSameLocalFileUrl(PORTABLE_ACTUAL, PORTABLE_EXPECTED, aliasDeps)).toBe(true)
  })

  it('alias 8.3 colapsa no nome longo do mesmo arquivo', () => {
    expect(
      isSameLocalFileUrl(PORTABLE_ACTUAL, 'file:///C:/Users/adenilson.j/x/dist/index.html', aliasDeps)
    ).toBe(true)
  })

  it('diretórios temporários distintos continuam arquivos distintos', () => {
    expect(
      isSameLocalFileUrl(
        'file:///C:/Users/adenilson.j/TempA1B2C3/dist/index.html',
        'file:///C:/Users/adenilson.j/TempX9Y8Z7/dist/index.html',
        aliasDeps
      )
    ).toBe(false)
  })

  it('arquivo irmão na mesma pasta continua diferente', () => {
    expect(
      isSameLocalFileUrl(PORTABLE_ACTUAL, 'file:///C:/Users/ADENIL%7E1.J/x/dist/other.html', aliasDeps)
    ).toBe(false)
  })

  it('sufixo virtual após app.asar: mesma página passa, página diferente não', () => {
    expect(isSameLocalFileUrl(ASAR_ACTUAL, ASAR_EXPECTED, aliasDeps)).toBe(true)
    expect(
      isSameLocalFileUrl(
        ASAR_ACTUAL,
        'file:///C:/Users/ADENIL%7E1.J/App/resources/app.asar/dist/other.html',
        aliasDeps
      )
    ).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')(
    'caminho curto 8.3 real resolve no caminho longo (filesystem de verdade)',
    (ctx) => {
      const longDir = mkdtempSync(path.join(os.tmpdir(), 'devorbit-ipc-'))
      try {
        const longFile = path.join(longDir, 'index.html')
        writeFileSync(longFile, '<!doctype html>', 'utf-8')
        // Pede ao cmd.exe a forma curta (%~sI) do diretório recém-criado.
        const shortResult = spawnSync(
          'cmd.exe',
          ['/d', '/c', `for %I in ("${longDir}") do @echo %~sI`],
          { windowsVerbatimArguments: true, encoding: 'utf8' }
        )
        const shortDir = shortResult.stdout.trim()
        if (shortResult.status !== 0 || !shortDir || shortDir.toLowerCase() === longDir.toLowerCase()) {
          ctx.skip() // geração 8.3 desabilitada neste volume
          return
        }
        expect(
          isSameLocalFileUrl(
            pathToFileURL(path.join(shortDir, 'index.html')).href,
            pathToFileURL(longFile).href
          )
        ).toBe(true)
      } finally {
        rmSync(longDir, { recursive: true, force: true })
      }
    }
  )
})

describe('isSameLocalFileUrl — fail-closed', () => {
  const identityDeps: LocalFileUrlComparisonDeps = { resolveRealPath: (input) => input }

  it('rejeita entradas que não são file:', () => {
    expect(isSameLocalFileUrl('https://a.example/', 'https://a.example/', identityDeps)).toBe(false)
    expect(isSameLocalFileUrl('file:///C:/app/dist/index.html', 'https://a.example/', identityDeps)).toBe(false)
  })

  it('rejeita hosts diferentes (UNC vs local, UNC vs UNC)', () => {
    expect(
      isSameLocalFileUrl('file://server/share/index.html', 'file:///C:/app/dist/index.html', identityDeps)
    ).toBe(false)
    expect(
      isSameLocalFileUrl('file://server/share/index.html', 'file://other/share/index.html', identityDeps)
    ).toBe(false)
  })

  it('rejeita caminho não resolvível (resolver devolve null)', () => {
    const deps: LocalFileUrlComparisonDeps = {
      resolveRealPath: (input) => (input.includes('missing') ? null : input),
    }
    expect(isSameLocalFileUrl('file:///C:/missing/index.html', 'file:///C:/app/dist/index.html', deps)).toBe(false)
    expect(isSameLocalFileUrl('file:///C:/missing/index.html', 'file:///C:/missing-too/index.html', deps)).toBe(false)
  })
})

describe('devorbit:getConfig — regressão do portable', () => {
  // Espelha registerIpcHandler de src/main/index.ts: TODA invocação do canal
  // passa pela asserção estrita ANTES de despachar para o handler de config.
  const dispatchGetConfig = (event: IpcSenderLike): { projectDirs: string[] } => {
    assertTrustedIpcSender(event, trustedCtx())
    return { projectDirs: [] }
  }

  it('atende o renderer confiável e devolve a config', () => {
    expect(dispatchGetConfig(mainEvent())).toEqual({ projectDirs: [] })
  })

  it('bloqueia renderer não confiável antes de tocar no handler', () => {
    expect(() => dispatchGetConfig(mainEvent(99))).toThrow(/Origem IPC não autorizada/)
  })
})
