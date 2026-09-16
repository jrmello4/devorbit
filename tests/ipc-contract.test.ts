import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertTrustedIpcSender, isTrustedRendererUrl } from '../src/main/validation'

const TRUSTED_URL = 'file:///C:/app/dist/index.html'
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

describe('contrato de origem IPC (trusted sender)', () => {
  it('aceita exatamente a origem de produção', () => {
    expect(isTrustedRendererUrl(TRUSTED_URL, TRUSTED_URL)).toBe(true)
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
