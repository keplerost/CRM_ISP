import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './lib/AuthContext'
import { ConfirmarProvider } from './lib/confirmar'
import { IngresoGrupalProvider } from './components/tecnico/IngresoGrupal'
import ErrorBoundary from './components/ErrorBoundary'
import { recargarPorVersionNueva } from './lib/versionNueva'
import App from './App'
import './index.css'

// Vite avisa con este evento cuando no puede bajar el archivo de una pantalla:
// casi siempre es una pestaña abierta antes de actualizar el servidor.
window.addEventListener('vite:preloadError', (e) => {
  if (recargarPorVersionNueva()) e.preventDefault()
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <ConfirmarProvider>
            <IngresoGrupalProvider>
              <App />
            </IngresoGrupalProvider>
          </ConfirmarProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
