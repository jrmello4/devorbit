import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import App, { isDevOrbitBridgeAvailable } from '../src/renderer/src/App'

describe('App — ponte de preload ausente', () => {
  it('detecta a ausência de window.devorbit fora do Electron', () => {
    expect(typeof window).toBe('undefined')
    expect(isDevOrbitBridgeAvailable()).toBe(false)
  })

  it('renderiza um estado de erro acionável em PT-BR em vez de uma tela silenciosa', () => {
    const html = renderToStaticMarkup(React.createElement(App))

    expect(html).toContain('role="alert"')
    expect(html).toContain('A ponte local do DevOrbit não está disponível')
    expect(html).toContain('Recarregar')
    expect(html).toContain('Detalhes técnicos')
    expect(html).not.toContain('app-shell')
  })
})
