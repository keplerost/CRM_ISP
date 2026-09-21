import { Navigate, Route, Routes } from 'react-router-dom'
import FranjaAmbiente from './components/layout/FranjaAmbiente'
import Layout from './components/layout/Layout'
import ProtectedRoute from './components/layout/ProtectedRoute'
import ConPermiso from './components/layout/ConPermiso'
import Login from './pages/Login'
import PantallaInicial from './components/layout/PantallaInicial'
import OLTPage from './pages/OLTPage'
import OltDetallePage from './pages/OltDetallePage'
import Tr069Page from './pages/Tr069Page'
import TiposOnuPage from './pages/olt/TiposOnuPage'
import DashboardGponPage from './pages/olt/DashboardGponPage'
import ONUsPage from './pages/ONUsPage'
import OnusPage from './pages/olt/OnusPage'
import OnuDetallePage from './pages/olt/OnuDetallePage'
import CajasNapPage from './pages/olt/CajasNapPage'
import PerfilesPage from './pages/PerfilesPage'
import MetricasPage from './pages/MetricasPage'
import MikrotikPage from './pages/MikrotikPage'
import BloqueosPage from './pages/BloqueosPage'
import AjusteSeccionPage from './pages/AjusteSeccionPage'
import AjustesPage from './pages/AjustesPage'
import LicenciaPage from './pages/LicenciaPage'
import MensajeriaPage from './pages/MensajeriaPage'
import TareasPage from './pages/TareasPage'
import GeneralPage from './pages/GeneralPage'
import EmpresaPage from './pages/EmpresaPage'
import PortalClientePage from './pages/PortalClientePage'
import PersonalPage from './pages/PersonalPage'
import ComisionesPage from './pages/ajustes/ComisionesPage'
import SimuladorComisionesPage from './pages/ajustes/SimuladorComisionesPage'
import AlertasPage from './pages/ajustes/AlertasPage'
import PaginaCortePage from './pages/ajustes/PaginaCortePage'
import PlantillasPage from './pages/ajustes/PlantillasPage'
import PrestadorPage from './pages/ajustes/PrestadorPage'
import FirmaPage from './pages/ajustes/FirmaPage'
import IntegracionesPage from './pages/ajustes/IntegracionesPage'
import IncidenciasPage from './pages/red/IncidenciasPage'
import PlantillasWhatsappPage from './pages/ajustes/PlantillasWhatsappPage'
import ServidorCorreoPage from './pages/ServidorCorreoPage'
import ClientesPage from './pages/ClientesPage'
import ImportarAbonadosPage from './pages/clientes/ImportarAbonadosPage'
import FacturacionPage from './pages/FacturacionPage'
import PagosPage from './pages/PagosPage'
import ClienteDetallePage from './pages/ClienteDetallePage'
import MapaClientesPage from './pages/MapaClientesPage'
import InstalacionesPage from './pages/InstalacionesPage'
import OrdenInstalacionPage from './pages/OrdenInstalacionPage'
import AltaCampoPage from './pages/AltaCampoPage'
import ContratosPage from './pages/ContratosPage'
import TransaccionesPage from './pages/TransaccionesPage'
import ConciliacionPage from './pages/ConciliacionPage'
import ArcotelPage from './pages/ArcotelPage'
import RecaudacionPage from './pages/recaudacion/InicioPage'
import EstadisticasPage from './pages/EstadisticasPage'
import SoportePage from './pages/SoportePage'
import TicketPage from './pages/TicketPage'
import TecnicosPage from './pages/TecnicosPage'
import DesempenoEquipoPage from './pages/DesempenoEquipoPage'
import VehiculosPage from './pages/VehiculosPage'
import RedesIpv4Page from './pages/red/RedesIpv4Page'
import AuditoriaPage from './pages/red/AuditoriaPage'
import ShapingPage from './pages/red/ShapingPage'
import MonitoreoPage from './pages/nms/MonitoreoPage'
import PlanesPage from './pages/servicios/PlanesPage'
import ProspectosPage from './pages/ventas/ProspectosPage'
import CoberturaPage from './pages/ventas/CoberturaPage'
import DashboardComercialPage from './pages/ventas/DashboardComercialPage'
import MapaComercialPage from './pages/ventas/MapaComercialPage'
import ExpedientePage from './pages/ventas/ExpedientePage'
import CobranzaPage from './pages/ventas/CobranzaPage'
import InteligenciaPage from './pages/ventas/InteligenciaPage'
import ReportesPage from './pages/ventas/ReportesPage'
import CotizadorPage from './pages/ventas/CotizadorPage'
import PromocionesPage from './pages/ventas/PromocionesPage'
import LayoutCampo from './components/tecnico/LayoutCampo'
import InicioCampoPage from './pages/tecnico/InicioPage'
import OrdenesCampoPage from './pages/tecnico/OrdenesPage'
import MisRetirosPage from './pages/campo/MisRetirosPage'
import EntregarEquiposPage from './pages/campo/EntregarEquiposPage'
import RecibirEntregasPage from './pages/inventario/RecibirEntregasPage'
import SoporteCampoPage from './pages/tecnico/SoporteCampoPage'
import AvisosCampoPage from './pages/tecnico/AvisosPage'
import PerfilCampoPage from './pages/tecnico/PerfilPage'
import RedCampoPage from './pages/tecnico/RedPage'
import DesempenoCampoPage from './pages/tecnico/DesempenoPage'
import JornadaCampoPage from './pages/tecnico/JornadaPage'
import BackofficePage from './pages/instalaciones/BackofficePage'
import StockPage from './pages/inventario/StockPage'
import MovimientosPage from './pages/inventario/MovimientosPage'
import ComprasPage from './pages/inventario/ComprasPage'
import MiAlmacenPage from './pages/inventario/MiAlmacenPage'
import RetirosPage from './pages/inventario/RetirosPage'
import MiComisionPage from './pages/ventas/MiComisionPage'
import ComisionesEquipoPage from './pages/ventas/ComisionesEquipoPage'
import VelocidadesPage from './pages/servicios/VelocidadesPage'

export default function App() {
  return (
    <>
      {/* Va afuera de las rutas para que también se vea en el login: si solo
          apareciera adentro, uno se entera de en qué ambiente está DESPUÉS de
          escribir la contraseña. */}
      <FranjaAmbiente />

      <Routes>
        <Route path="/login" element={<Login />} />

      {/* Fuera del layout Y fuera de ProtectedRoute: es la pantalla a la que
          llega el cliente bloqueado, que por definición no pudo entrar. */}
      <Route path="/licencia" element={<LicenciaPage suelta />} />

      {/* El asistente de alta va fuera del layout: se usa en el celular, en la
          calle, y ahí el menú lateral solo roba pantalla.

          Al estar fuera, tampoco pasa por el control de acceso del Layout: es
          la única ruta que tiene que pedir su permiso a mano. */}
      <Route
        path="/instalaciones/:id/alta"
        element={
          <ProtectedRoute>
            <ConPermiso permiso={['instalaciones.completar', 'instalaciones.asignadas']}>
              <AltaCampoPage />
            </ConPermiso>
          </ProtectedRoute>
        }
      />

      {/* La app de campo va fuera del layout de escritorio por lo mismo que el
          asistente de alta: se usa en la calle, con una mano, y el menú lateral
          de escritorio solo roba pantalla.

          Es un ESPACIO con varias pantallas, no una pantalla suelta, y por eso
          tiene su propio marco. La primera versión no lo tenía: "Materiales"
          apuntaba a `/inventario/mi-almacen`, que vive adentro del layout de
          escritorio, y tocarlo en el celular tiraba al técnico dentro del marco
          de la computadora con todo descuadrado. */}
      <Route
        path="/campo"
        element={
          <ProtectedRoute>
            <ConPermiso permiso={['instalaciones.asignadas', 'soporte.asignados']}>
              <LayoutCampo />
            </ConPermiso>
          </ProtectedRoute>
        }
      >
        <Route index element={<InicioCampoPage />} />
        <Route path="ordenes" element={<OrdenesCampoPage />} />
        <Route path="soporte" element={<SoporteCampoPage />} />
        {/* El detalle del ticket, dentro del marco de campo. Es el MISMO
            componente que usa el escritorio —no una copia—; solo cambia dónde
            se dibuja y a dónde vuelve el botón de atrás. */}
        <Route path="soporte/:id" element={<TicketPage />} />
        {/* La misma pantalla de inventario que usa el escritorio, adentro del
            marco correcto. No se duplicó: es el mismo componente. */}
        <Route path="inventario" element={<MiAlmacenPage />} />
        {/* El estado de la red, solo lectura. Ver el encabezado del archivo:
            no hay ningún botón que toque un equipo, y los datos que llegan al
            navegador no incluyen IP ni credenciales. */}
        {/* Los equipos por retirar de quien los tiene asignados. Va en el marco
            de campo por lo mismo que las órdenes: se trabaja en la puerta de
            una casa, con el teléfono en la mano. */}
        <Route path="retiros" element={<MisRetirosPage />} />
        {/* El acta con la que devuelve a la oficina lo que recuperó. */}
        <Route path="entregar" element={<EntregarEquiposPage />} />
        <Route path="red" element={<RedCampoPage />} />
        <Route path="desempeno" element={<DesempenoCampoPage />} />
        <Route path="jornada" element={<JornadaCampoPage />} />
        <Route path="avisos" element={<AvisosCampoPage />} />
        <Route path="perfil" element={<PerfilCampoPage />} />
      </Route>

      {/* El expediente de venta, por la misma razón: se completa en la vereda
          con el cliente delante, y el menú lateral solo roba pantalla. */}
      <Route
        path="/ventas/expediente/:id"
        element={
          <ProtectedRoute>
            <ConPermiso permiso="ventas.prospectos">
              <ExpedientePage />
            </ConPermiso>
          </ProtectedRoute>
        }
      />

      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        {/* La pantalla de inicio depende de quién entra: el Dashboard de red
            para quien la opera, su propia pantalla para el resto. */}
        <Route index element={<PantallaInicial />} />
        <Route path="gpon" element={<DashboardGponPage />} />
        <Route path="olts" element={<OLTPage />} />
        <Route path="olts/:id" element={<OltDetallePage />} />
        <Route path="tr069" element={<Tr069Page />} />
        <Route path="onu-types" element={<TiposOnuPage />} />
        {/* El listado de todas las ONUs autorizadas. La pantalla vieja seguía
            siendo la de aprovisionar puerto por puerto: sigue existiendo, pero
            no es lo que uno busca al entrar a "ONUs". */}
        <Route path="onus" element={<OnusPage />} />
        <Route path="onus/aprovisionar" element={<ONUsPage />} />
        <Route path="onus/:id" element={<OnuDetallePage />} />
        <Route path="naps" element={<CajasNapPage />} />
        <Route path="perfiles" element={<PerfilesPage />} />
        <Route path="metricas" element={<MetricasPage />} />
        <Route path="bloqueos" element={<BloqueosPage />} />

        {/* Gestión de Red e IPAM */}
        <Route path="red/routers" element={<MikrotikPage />} />
        <Route path="red/redes" element={<RedesIpv4Page />} />
        <Route path="red/auditoria" element={<AuditoriaPage />} />
        <Route path="red/shaping" element={<ShapingPage />} />
        {/* El módulo es solo un grupo del menú: entra por su primera página. */}
        <Route path="red" element={<Navigate to="/red/routers" replace />} />
        {/* Los routers y el direccionamiento se separaron: eran dos preguntas
            distintas en la misma pantalla. El redirect evita romper un enlace
            guardado. */}
        <Route path="mikrotik" element={<Navigate to="/red/routers" replace />} />
        <Route path="red/subredes" element={<Navigate to="/red/redes" replace />} />

        {/* Monitoreo de red: el tablero y el inventario son la misma pregunta
            hecha dos veces, así que viven en una sola pantalla. */}
        <Route path="monitoreo" element={<MonitoreoPage />} />
        <Route path="monitoreo/incidencias" element={<IncidenciasPage />} />
        <Route path="monitoreo/inventario" element={<Navigate to="/monitoreo" replace />} />
        {/* Las rutas fijas van antes que /clientes/:id para que "mapa" no se
            interprete como el id de un cliente. */}
        <Route path="ajustes" element={<AjustesPage />} />
        <Route path="ajustes/correo" element={<ServidorCorreoPage />} />
        <Route path="ajustes/licencia" element={<LicenciaPage />} />
        <Route path="ajustes/mensajeria" element={<MensajeriaPage />} />
        <Route path="ajustes/crontab" element={<TareasPage />} />
        <Route path="ajustes/general" element={<GeneralPage />} />
        <Route path="ajustes/empresa" element={<EmpresaPage />} />
        <Route path="ajustes/portal-cliente" element={<PortalClientePage />} />
        <Route path="ajustes/personal" element={<PersonalPage />} />
        {/* Antes del comodín `:slug`: si no, lo captura y muestra la ficha
            genérica de "esta sección todavía no existe". */}
        <Route path="ajustes/alertas" element={<AlertasPage />} />
        <Route path="ajustes/pagina-corte" element={<PaginaCortePage />} />
        <Route path="ajustes/plantillas" element={<PlantillasPage />} />
        <Route path="ajustes/prestador" element={<PrestadorPage />} />
        <Route path="ajustes/firma" element={<FirmaPage />} />
        <Route path="ajustes/integraciones" element={<IntegracionesPage />} />
        <Route path="ajustes/plantillas-whatsapp" element={<PlantillasWhatsappPage />} />
        <Route path="ajustes/comisiones" element={<ComisionesPage />} />
        <Route path="ajustes/comisiones/simulador" element={<SimuladorComisionesPage />} />
        <Route path="ajustes/:slug" element={<AjusteSeccionPage />} />
        <Route path="clientes" element={<ClientesPage />} />
        <Route path="clientes/importar" element={<ImportarAbonadosPage />} />
        <Route path="clientes/mapa" element={<MapaClientesPage />} />
        <Route path="clientes/instalaciones" element={<InstalacionesPage />} />
        {/* La bandeja del backoffice: las ventas cerradas esperando despacho. */}
        <Route path="instalaciones/nuevas" element={<BackofficePage />} />
        <Route path="clientes/instalaciones/:id" element={<OrdenInstalacionPage />} />
        <Route path="clientes/contratos" element={<ContratosPage />} />
        <Route path="inventario/entregas" element={<RecibirEntregasPage />} />
        <Route path="clientes/:id" element={<ClienteDetallePage />} />
        {/* Servicios: el catálogo de lo que se vende. */}
        <Route path="servicios/planes" element={<PlanesPage />} />
        <Route path="servicios/velocidades" element={<VelocidadesPage />} />
        <Route path="servicios" element={<Navigate to="/servicios/planes" replace />} />

        {/* Ventas: el embudo comercial. Vive aparte de Clientes a propósito —un
            prospecto no es un abonado, y la mayoría nunca va a serlo. */}
        <Route path="ventas/tablero" element={<DashboardComercialPage />} />
        <Route path="ventas/prospectos" element={<ProspectosPage />} />
        <Route path="ventas/cobertura" element={<CoberturaPage />} />
        <Route path="ventas/mapa" element={<MapaComercialPage />} />
        <Route path="ventas/cobranza" element={<CobranzaPage />} />
        <Route path="ventas/mi-comision" element={<MiComisionPage />} />
        <Route path="ventas/comisiones" element={<ComisionesEquipoPage />} />
        <Route path="ventas/inteligencia" element={<InteligenciaPage />} />
        <Route path="ventas/reportes" element={<ReportesPage />} />
        <Route path="ventas/cotizador" element={<CotizadorPage />} />
        <Route path="ventas/promociones" element={<PromocionesPage />} />
        {/* El tablero es la puerta del módulo: es la pantalla que dice qué
            hacer, y la lista de prospectos es a dónde se va después. */}
        <Route path="ventas" element={<Navigate to="/ventas/tablero" replace />} />

        {/* Inventario. "Mi almacén" va primero en el archivo pero no en el
            menú: es del técnico, no de bodega. */}
        <Route path="inventario/mi-almacen" element={<MiAlmacenPage />} />
        <Route path="inventario/movimientos" element={<MovimientosPage />} />
        <Route path="inventario/compras" element={<ComprasPage />} />
        <Route path="inventario/stock" element={<StockPage />} />
        <Route path="inventario/retiros" element={<RetirosPage />} />
        <Route path="inventario" element={<Navigate to="/inventario/stock" replace />} />

        <Route path="facturacion" element={<FacturacionPage />} />
        <Route path="pagos" element={<PagosPage />} />
        <Route path="transacciones" element={<TransaccionesPage />} />
        <Route path="conciliacion" element={<ConciliacionPage />} />
        <Route path="arcotel" element={<ArcotelPage />} />
        <Route path="recaudacion" element={<RecaudacionPage />} />
        <Route path="estadisticas" element={<EstadisticasPage />} />

        <Route path="soporte" element={<SoportePage />} />
        <Route path="soporte/tecnicos" element={<TecnicosPage />} />
        <Route path="soporte/desempeno" element={<DesempenoEquipoPage />} />
        <Route path="soporte/vehiculos" element={<VehiculosPage />} />
        <Route path="soporte/:id" element={<TicketPage />} />
        {/* Finanzas es solo un grupo del menú: entra por su primera página. */}
        <Route path="finanzas" element={<Navigate to="/pagos" replace />} />
        {/* La importación se movió a la ficha del router. El redirect evita
            romper un enlace guardado. */}
        <Route path="importar" element={<Navigate to="/mikrotik" replace />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}
