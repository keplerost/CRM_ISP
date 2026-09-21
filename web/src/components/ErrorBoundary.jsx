import { Component } from 'react'

/**
 * Sin esto, cualquier error de render deja la pantalla en blanco y el único
 * rastro queda en la consola del navegador — que es justo donde no mira quien
 * está siguiendo el taller. Acá el error se ve.
 */
export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Error de render:', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="grid h-full place-items-center p-6">
        <div className="w-full max-w-2xl rounded-xl border border-red-500/30 bg-red-500/10 p-6">
          <h1 className="text-base font-semibold text-red-200">La aplicación no pudo cargar</h1>
          <p className="mt-2 text-sm text-red-300/90">{this.state.error.message}</p>

          <pre className="mt-4 max-h-64 overflow-auto rounded-lg bg-black/40 p-3 text-[11px] text-red-200/70">
            {this.state.error.stack}
          </pre>

          <button
            onClick={() => window.location.reload()}
            className="mt-4 rounded-lg border border-red-500/40 px-3 py-2 text-sm text-red-100 transition hover:bg-red-500/20"
          >
            Recargar
          </button>
        </div>
      </div>
    )
  }
}
