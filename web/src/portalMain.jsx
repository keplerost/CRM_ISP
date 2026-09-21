import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ErrorBoundary from './components/ErrorBoundary'
import PortalApp from './pages/portal/PortalApp'
import './index.css'

/**
 * El arranque del portal del abonado.
 *
 * Es una aplicación SEPARADA de la del personal, con su propio index.html y su
 * propio paquete. No comparte nada de lo otro y eso es a propósito:
 *
 *   EL ABONADO NO DESCARGA EL SISTEMA. Entra desde el celular, con datos
 *   móviles, y bajaba también el código de OLTs, MikroTik, facturación e IPAM.
 *   No podía usarlo —el middleware lo frena— pero lo pagaba en megas.
 *
 *   SE PUEDEN PROTEGER POR SEPARADO. El portal va en un dominio público; el
 *   sistema del personal puede quedar detrás de un firewall o una VPN. Con una
 *   sola aplicación en un solo origen eso era imposible.
 *
 * Sin AuthProvider ni BrowserRouter: el abonado tiene su propia sesión, y el
 * portal es una sola pantalla con pestañas abajo — no hay rutas que enrutar, y
 * cada una que agregara sería una URL más que alguien podría probar.
 */
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <PortalApp />
    </ErrorBoundary>
  </StrictMode>,
)
