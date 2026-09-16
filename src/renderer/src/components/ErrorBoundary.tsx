import React from 'react'
import './ErrorBoundary.css'

interface ErrorBoundaryProps {
  children: React.ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(
      '[DevOrbit] Falha de renderização capturada pelo ErrorBoundary:',
      error,
      info.componentStack
    )
  }

  private readonly handleReload = (): void => {
    window.location.reload()
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    const technicalDetails = [`${error.name}: ${error.message}`, error.stack]
      .filter((value): value is string => Boolean(value))
      .join('\n\n')

    return (
      <div className="renderer-fallback" role="alert">
        <div className="renderer-fallback__panel">
          <span className="renderer-fallback__icon" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </span>

          <h1 className="renderer-fallback__title">Algo deu errado ao exibir o DevOrbit</h1>
          <p className="renderer-fallback__message">
            Ocorreu um erro inesperado na interface. Recarregue para continuar — seus dados locais
            não foram alterados.
          </p>

          <button type="button" className="renderer-fallback__reload" onClick={this.handleReload}>
            Recarregar
          </button>

          <details className="renderer-fallback__details">
            <summary>Detalhes técnicos</summary>
            <pre className="renderer-fallback__pre">{technicalDetails}</pre>
          </details>
        </div>
      </div>
    )
  }
}
