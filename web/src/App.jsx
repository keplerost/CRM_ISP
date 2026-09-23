import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import FranjaAmbiente from './components/layout/FranjaAmbiente'
import Layout from './components/layout/Layout'
import ProtectedRoute from './components/layout/ProtectedRoute'
import ConPermiso from './components/layout/ConPermiso'
import Login from './pages/Login'
import PantallaInicial from './components/layout/PantallaInicial'
const OLTPage = lazy(() => import('./pages/OLTPage'))
const OltDetallePage = lazy(() => import('./pages/OltDetallePage'))
const Tr069Page = lazy(() => import('./pages/Tr069Page'))
const TiposOnuPage = lazy(() => import('./pages/olt/TiposOnuPage'))
const DashboardGponPage = lazy(() => import('./pages/olt/DashboardGponPage'))
const ONUsPage = lazy(() => import('./pages/ONUsPage'))
const OnusPage = lazy(() => import('./pages/olt/OnusPage'))
const OnuDetallePage = lazy(() => import('./pages/olt/OnuDetallePage'))
const CajasNapPage = lazy(() => import('./pages/olt/CajasNapPage'))
const PerfilesPage = lazy(() => import('./pages/PerfilesPage'))
const MiPerfilPage = lazy(() => import('./pages/MiPerfilPage'))
const MetricasPage = lazy(() => import('./pages/MetricasPage'))
const MikrotikPage = lazy(() => import('./pages/MikrotikPage'))
const BloqueosPage = lazy(() => import('./pages/BloqueosPage'))
const AjusteSeccionPage = lazy(() => import('./pages/AjusteSeccionPage'))
const AjustesPage = lazy(() => import('./pages/AjustesPage'))
const LicenciaPage = lazy(() => import('./pages/LicenciaPage'))
const MensajeriaPage = lazy(() => import('./pages/MensajeriaPage'))
const TareasPage = lazy(() => import('./pages/TareasPage'))
const GeneralPage = lazy(() => import('./pages/GeneralPage'))
const EmpresaPage = lazy(() => import('./pages/EmpresaPage'))
const PortalClientePage = lazy(() => import('./pages/PortalClientePage'))
const PersonalPage = lazy(() => import('./pages/PersonalPage'))
const ComisionesPage = lazy(() => import('./pages/ajustes/ComisionesPage'))
const SimuladorComisionesPage = lazy(() => import('./pages/ajustes/SimuladorComisionesPage'))
const AlertasPage = lazy(() => import('./pages/ajustes/AlertasPage'))
const PaginaCortePage = lazy(() => import('./pages/ajustes/PaginaCortePage'))
const PlantillasPage = lazy(() => import('./pages/ajustes/PlantillasPage'))
const PrestadorPage = lazy(() => import('./pages/ajustes/PrestadorPage'))
const FirmaPage = lazy(() => import('./pages/ajustes/FirmaPage'))
const IntegracionesPage = lazy(() => import('./pages/ajustes/IntegracionesPage'))
const IncidenciasPage = lazy(() => import('./pages/red/IncidenciasPage'))
const PlantillasWhatsappPage = lazy(() => import('./pages/ajustes/PlantillasWhatsappPage'))
const ServidorCorreoPage = lazy(() => import('./pages/ServidorCorreoPage'))
const ClientesPage = lazy(() => import('./pages/ClientesPage'))
const ImportarAbonadosPage = lazy(() => import('./pages/clientes/ImportarAbonadosPage'))
const FacturacionPage = lazy(() => import('./pages/FacturacionPage'))
const PagosPage = lazy(() => import('./pages/PagosPage'))
const ClienteDetallePage = lazy(() => import('./pages/ClienteDetallePage'))
const MapaClientesPage = lazy(() => import('./pages/MapaClientesPage'))
const InstalacionesPage = lazy(() => import('./pages/InstalacionesPage'))
const OrdenInstalacionPage = lazy(() => import('./pages/OrdenInstalacionPage'))
const AltaCampoPage = lazy(() => import('./pages/AltaCampoPage'))
const ContratosPage = lazy(() => import('./pages/ContratosPage'))
const TransaccionesPage = lazy(() => import('./pages/TransaccionesPage'))
const ConciliacionPage = lazy(() => import('./pages/ConciliacionPage'))
const ArcotelPage = lazy(() => import('./pages/ArcotelPage'))
const RecaudacionPage = lazy(() => import('./pages/recaudacion/InicioPage'))
const EstadisticasPage = lazy(() => import('./pages/EstadisticasPage'))
const SoportePage = lazy(() => import('./pages/SoportePage'))
const TicketPage = lazy(() => import('./pages/TicketPage'))
const TecnicosPage = lazy(() => import('./pages/TecnicosPage'))
const DesempenoEquipoPage = lazy(() => import('./pages/DesempenoEquipoPage'))
const JornadasPage = lazy(() => import('./pages/soporte/JornadasPage'))
const VehiculosPage = lazy(() => import('./pages/VehiculosPage'))
const RedesIpv4Page = lazy(() => import('./pages/red/RedesIpv4Page'))
const AuditoriaPage = lazy(() => import('./pages/red/AuditoriaPage'))
const ShapingPage = lazy(() => import('./pages/red/ShapingPage'))
const MonitoreoPage = lazy(() => import('./pages/nms/MonitoreoPage'))
const PlanesPage = lazy(() => import('./pages/servicios/PlanesPage'))
const ProspectosPage = lazy(() => import('./pages/ventas/ProspectosPage'))
const CoberturaPage = lazy(() => import('./pages/ventas/CoberturaPage'))
const DashboardComercialPage = lazy(() => import('./pages/ventas/DashboardComercialPage'))
const MapaComercialPage = lazy(() => import('./pages/ventas/MapaComercialPage'))
const ExpedientePage = lazy(() => import('./pages/ventas/ExpedientePage'))
const CobranzaPage = lazy(() => import('./pages/ventas/CobranzaPage'))
const InteligenciaPage = lazy(() => import('./pages/ventas/InteligenciaPage'))
const ReportesPage = lazy(() => import('./pages/ventas/ReportesPage'))
const CotizadorPage = lazy(() => import('./pages/ventas/CotizadorPage'))
const PromocionesPage = lazy(() => import('./pages/ventas/PromocionesPage'))
import LayoutCampo from './components/tecnico/LayoutCampo'
const InicioCampoPage = lazy(() => import('./pages/tecnico/InicioPage'))
const OrdenesCampoPage = lazy(() => import('./pages/tecnico/OrdenesPage'))
const MisRetirosPage = lazy(() => import('./pages/campo/MisRetirosPage'))
const EntregarEquiposPage = lazy(() => import('./pages/campo/EntregarEquiposPage'))
const RecibirEntregasPage = lazy(() => import('./pages/inventario/RecibirEntregasPage'))
const SoporteCampoPage = lazy(() => import('./pages/tecnico/SoporteCampoPage'))
const AvisosCampoPage = lazy(() => import('./pages/tecnico/AvisosPage'))
const PerfilCampoPage = lazy(() => import('./pages/tecnico/PerfilPage'))
const RedCampoPage = lazy(() => import('./pages/tecnico/RedPage'))
const DesempenoCampoPage = lazy(() => import('./pages/tecnico/DesempenoPage'))
const JornadaCampoPage = lazy(() => import('./pages/tecnico/JornadaPage'))
const BackofficePage = lazy(() => import('./pages/instalaciones/BackofficePage'))
const StockPage = lazy(() => import('./pages/inventario/StockPage'))
const MovimientosPage = lazy(() => import('./pages/inventario/MovimientosPage'))
const ComprasPage = lazy(() => import('./pages/inventario/ComprasPage'))
const MiAlmacenPage = lazy(() => import('./pages/inventario/MiAlmacenPage'))
const RetirosPage = lazy(() => import('./pages/inventario/RetirosPage'))
const MiComisionPage = lazy(() => import('./pages/ventas/MiComisionPage'))
const ComisionesEquipoPage = lazy(() => import('./pages/ventas/ComisionesEquipoPage'))
const VelocidadesPage = lazy(() => import('./pages/servicios/VelocidadesPage'))

/**
 * Lo que se ve mientras baja la pantalla pedida.
 *
 * Deliberadamente igual al indicador del `index.html`: el primero lo dibuja el
 * navegador antes de que exista React y este lo reemplaza sin que se note. Dos
 * indicadores distintos seguidos se leen como dos cargas, no como una.
 */
function Cargando() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <div
        className="size-9 animate-spin rounded-full border-[3px] border-[rgba(3,105,161,.18)] border-t-[#0369A1] motion-reduce:animate-pulse"
        role="status"
        aria-label="Cargando"
      />
    </div>
  )
}

export default function App() {
  return (
    <>
      {/* Va afuera de las rutas para que también se vea en el login: si solo
          apareciera adentro, uno se entera de en qué ambiente está DESPUÉS de
          escribir la contraseña. */}
      <FranjaAmbiente />

      {/*
        Cada pantalla es su propio archivo y se baja cuando se entra a ella.

        Antes las noventa viajaban juntas en un solo bloque de 2,6 MB, y el
        navegador tenía que descargarlo, parsearlo y ejecutarlo entero antes de
        dibujar cualquier cosa — aunque fuera a mostrar la ficha de un abonado.
        Con varias pestañas abiertas a la vez, ese trabajo se multiplicaba y
        unas quedaban colgadas mientras otras abrían.

        `Suspense` es lo que hace falta para que esto sea legal: mientras baja
        la pantalla pedida, muestra el indicador de abajo. Sin él, React no
        tiene qué dibujar en ese hueco y rompe.
      */}
      <Suspense fallback={<Cargando />}>
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

        {/* Sin permiso: cualquiera que entró tiene que poder cambiar SU
            contraseña. Atarla a un permiso dejaría afuera justo a quien más lo
            necesita — el que recibió una clave dictada por otro. */}
        <Route path="mi-perfil" element={<MiPerfilPage />} />
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
        {/* Antes de "soporte/:id": si no, el comodín se lo come y busca un
            ticket con el id "jornadas". */}
        <Route path="soporte/jornadas" element={<JornadasPage />} />
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
      </Suspense>
    </>
  )
}
