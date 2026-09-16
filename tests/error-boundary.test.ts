import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ErrorBoundary } from '../src/renderer/src/components/ErrorBoundary'

describe('ErrorBoundary — recuperação de falha do renderer', () => {
  it('renderiza os filhos quando não há exceção', () => {
    const html = renderToStaticMarkup(
      React.createElement(ErrorBoundary, null, React.createElement('p', null, 'conteudo-seguro'))
    )

    expect(html).toContain('conteudo-seguro')
    expect(html).not.toContain('Recarregar')
  })

  it('captura a exceção e produz estado PT-BR acessível com Recarregar e detalhes recolhíveis', () => {
    const boundary = new ErrorBoundary({ children: null })
    const recovered = ErrorBoundary.getDerivedStateFromError(new Error('falha simulada de render'))

    expect(recovered.error).toBeInstanceOf(Error)
    expect(recovered.error?.message).toBe('falha simulada de render')

    boundary.state = recovered
    const html = renderToStaticMarkup(boundary.render())

    expect(html).toContain('role="alert"')
    expect(html).toContain('Algo deu errado ao exibir o DevOrbit')
    expect(html).toContain('Recarregar')
    expect(html).toContain('<details')
    expect(html).toContain('Detalhes técnicos')
    expect(html).toContain('falha simulada de render')
  })
})
