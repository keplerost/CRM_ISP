import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './lib/AuthContext'
import { ConfirmarProvider } from './lib/confirmar'
import { IngresoGrupalProvider } from './components/tecnico/IngresoGrupal'
import ErrorBoundary from './components/ErrorBoundary'
import App from './App'
import './index.css'

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
