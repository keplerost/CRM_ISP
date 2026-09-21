import { useCallback, useEffect, useMemo, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { usePermisos } from '../../lib/AuthContext'
import { useMarca } from '../../lib/useMarca'
import { puedeEntrar } from '../../lib/rutasPermisos'
import {
  Activity,
  Megaphone,
  Award,
  Backpack,
  Ban,
  BarChart3,
  Box,
  Calculator,
  Gift,
  Boxes,
  ChevronDown,
  ChevronsLeft,
  CreditCard,
  FileSignature,
  Gauge,
  HardHat,
  History,
  Inbox,
  Layers,
  Lightbulb,
  LayoutDashboard,
  Map,
  MapPinned,
  Network,
  Package,
  PackageX,
  Radio,
  LifeBuoy,
  Receipt,
  Router as RouterIcon,
  ScanSearch,
  ShoppingCart,
  Search,
  SlidersHorizontal,
  Target,
  Truck,
  Users,
  Wallet,
  Waves,
  Wrench,
  Cloud,
  Cpu,
  Settings,
  Landmark,
  ClipboardList,
} from 'lucide-react'

/**
 * Menú lateral.
 *
 * Los grupos con `hijos` se despliegan. Se abren solos cuando la página que
 * estás viendo es una de las de adentro: al recargar en "Contratos", el menú
 * tiene que mostrar dónde estás parado y no volver a cerrarse.
 *
 * ── Qué se ve y qué no ──
 *
 * Cada ítem se muestra solo si su ruta está permitida. El permiso no se declara
 * acá sino en `lib/rutasPermisos.js`, junto al que usa el guardián de acceso:
 * si vivieran en dos lados, el día que se separen habría ítems que llevan a una
 * pantalla que rebota, o pantallas alcanzables que el menú esconde. Las dos
 * versiones de ese error son confusas de distinta manera.
 *
 * Un grupo cuyos hijos quedaron todos fuera desaparece entero, y una sección
 * sin ítems no dibuja ni su título — un encabezado "OLT / GPON" sobre nada es
 * peor que no tenerlo.
 */
const SECCIONES = [
  {
    titulo: null,
    items: [
      // La única entrada con permiso propio, y por una razón: "/" no es una
      // pantalla, es un desvío — manda a cada uno a la suya. Su permiso no se
      // puede deducir del mapa de rutas porque ahí tiene que quedar abierta,
      // si no el guardián rechazaría a alguien antes de poder desviarlo.
      //
      // Pedía solo `red.olts_ver`, y por eso el técnico no tenía Dashboard: su
      // menú arrancaba en Clientes. Ahora también lo ve quien tiene tablero
      // propio — el suyo se dibuja en la misma URL, así que el enlace es el
      // mismo para todos y nadie tiene que saber a cuál le toca.
      {
        to: '/',
        label: 'Dashboard',
        icon: Gauge,
        end: true,
        permiso: ['red.olts_ver', 'instalaciones.asignadas', 'soporte.asignados'],
      },
      // No hay ítem "Modo campo", y es a propósito.
      //
      // Lo hubo un rato. Dejó de tener sentido cuando la pantalla de inicio pasó
      // a elegir sola: en un teléfono manda a `/campo`, en un monitor dibuja el
      // tablero acá adentro. Con esa decisión automática, el ítem solo servía
      // para una cosa — abrir la app de celular a pantalla completa en una
      // computadora, que es justamente el problema que se vino a resolver.
      //
      // La ruta `/campo` sigue existiendo y se puede escribir a mano; lo que no
      // hay es un botón que invite a usarla donde no corresponde. El camino de
      // vuelta —del celular al escritorio— sí está, en Perfil, porque ahí es una
      // salida deliberada de una decisión automática y no un atajo a la vista
      // equivocada.
      {
        to: '/clientes',
        label: 'Clientes',
        icon: Users,
        hijos: [
          { to: '/clientes', label: 'Usuarios', icon: Users, end: true },
          { to: '/clientes/mapa', label: 'Mapa de clientes', icon: Map },
          { to: '/instalaciones/nuevas', label: 'Nuevas instalaciones', icon: Inbox, contador: 'nuevas' },
          { to: '/clientes/instalaciones', label: 'Instalaciones', icon: Wrench },
          { to: '/clientes/contratos', label: 'Contratos', icon: FileSignature },
        ],
      },
      // Los planes van antes que Finanzas porque son su origen: de acá sale el
      // precio y el impuesto que después se factura.
      {
        to: '/servicios',
        label: 'Servicios',
        icon: Gauge,
        hijos: [
          { to: '/servicios/planes', label: 'Planes de internet', icon: Gauge },
          // Las traffic tables viven en las OLTs, no en la base: el plan solo
          // apunta a una y le pone el precio. Por eso van al lado.
          { to: '/servicios/velocidades', label: 'Perfiles de velocidad', icon: Activity },
        ],
      },
      /**
       * Mi recaudación va ANTES de Finanzas y fuera del grupo.
       *
       * Para quien cobra es su pantalla, no un submenú: tiene que estar a la
       * vista sin desplegar nada. Y para quien no cobra, no aparece.
       */
      { to: '/recaudacion', label: 'Mi recaudación', icon: Wallet },
      {
        to: '/finanzas',
        label: 'Finanzas',
        icon: Wallet,
        hijos: [
          { to: '/pagos', label: 'Pagos', icon: CreditCard },
          { to: '/transacciones', label: 'Transacciones', icon: Search },
          // Va pegada a Transacciones porque es su continuación: primero se mira
          // lo cobrado, después se comprueba que haya entrado.
          { to: '/conciliacion', label: 'Conciliación bancaria', icon: Landmark },
          // El reporte del regulador va en Finanzas y no en Ajustes: sale de las
          // facturas, y quien lo arma es el mismo que mira la caja.
          { to: '/arcotel', label: 'Reporte ARCOTEL', icon: ClipboardList },
          { to: '/estadisticas', label: 'Estadísticas', icon: BarChart3 },
          { to: '/facturacion', label: 'Facturación', icon: Receipt },
        ],
      },
      {
        to: '/soporte',
        label: 'Soporte',
        icon: LifeBuoy,
        hijos: [
          { to: '/soporte', label: 'Tickets', icon: LifeBuoy, end: true },
          { to: '/soporte/tecnicos', label: 'Técnicos y cuadrillas', icon: HardHat },
          { to: '/soporte/desempeno', label: 'Desempeño del equipo', icon: Gauge },
          { to: '/soporte/vehiculos', label: 'Vehículos', icon: Truck },
        ],
      },
      {
        to: '/inventario',
        label: 'Inventario',
        icon: Boxes,
        hijos: [
          { to: '/inventario/stock', label: 'Stock', icon: Package },
          { to: '/inventario/compras', label: 'Compras y proveedores', icon: ShoppingCart },
          { to: '/inventario/movimientos', label: 'Movimientos', icon: History },
          // Los equipos que quedaron en casas que dejaron de pagar. Va en
          // Inventario y no en Ventas porque el trabajo es logístico: alguien
          // tiene que ir a buscarlos y devolverlos al stock.
          { to: '/inventario/retiros', label: 'Retiros de equipo', icon: PackageX },
          { to: '/inventario/entregas', label: 'Recibir de técnicos', icon: Inbox },
          // Última: es la del técnico, que no entra por acá sino desde su
          // propia pantalla de inicio.
          { to: '/inventario/mi-almacen', label: 'Mi almacén', icon: Backpack },
        ],
      },
    ],
  },
  {
    // El módulo comercial se despliega en secciones propias en vez de esconderse
    // dentro de un grupo plegable.
    //
    // El motivo es concreto: al vendedor, el menú se le reducía a un solo
    // desplegable cerrado. Tenía que abrirlo para ver sus cinco pantallas —el
    // sistema entero, para él— mientras el resto de los roles ven las suyas de
    // entrada. Un menú que hay que abrir para descubrir qué tiene se usa menos.
    titulo: 'Comercial',
    items: [
      // Las tres primeras son la AGENDA PERSONAL de quien vende: su día, su
      // pipeline, sus seguimientos por enfriarse.
      //
      // `soloVendedor` las saca del menú de quien tiene la cartera completa.
      // Antes al administrador le aparecía el menú del vendedor entero, y las
      // tres primeras entradas eran la agenda de otra persona: nunca las iba a
      // abrir, y le empujaban hacia abajo lo que sí usa —Inteligencia y
      // Reportes—. Las rutas siguen existiendo y siguen siendo alcanzables
      // escribiéndolas; esto no es un permiso, es dejar de ofrecer lo que no
      // corresponde.
      { to: '/ventas/tablero', label: 'Mi día', icon: LayoutDashboard, soloVendedor: true },
      // Va segunda, pegada a "Mi día": es la otra pregunta que el vendedor se
      // hace todas las mañanas, y tenerla escondida abajo la convierte en algo
      // que se consulta a fin de mes en vez de algo que orienta el día.
      { to: '/ventas/mi-comision', label: 'Mi comisión', icon: Award, soloVendedor: true },
      { to: '/ventas/prospectos', label: 'Prospectos', icon: Target },
      // Vistas preajustadas de la misma pantalla, no pantallas nuevas. Son los
      // dos cortes que un vendedor hace todo el tiempo, y llegar a ellos con un
      // clic en vez de tres es la diferencia entre usarlos y no.
      { to: '/ventas/prospectos?f=abiertos', label: 'Pipeline', icon: Layers, soloVendedor: true },
      { to: '/ventas/prospectos?f=enfriando', label: 'Seguimientos', icon: History, contador: 'enfriando', soloVendedor: true },
      { to: '/ventas/cobertura', label: 'Verificar cobertura', icon: Radio },
      { to: '/ventas/mapa', label: 'Mapa comercial', icon: MapPinned },
      { to: '/ventas/cotizador', label: 'Cotizador', icon: Calculator },
      { to: '/ventas/promociones', label: 'Promociones', icon: Gift },
    ],
  },
  {
    titulo: 'Reportes',
    items: [
      { to: '/ventas/reportes', label: 'Reportes comerciales', icon: BarChart3 },
      { to: '/ventas/inteligencia', label: 'Inteligencia comercial', icon: Lightbulb },
      // Aparte de Inteligencia comercial y no adentro: esa pantalla contesta
      // dónde nos piden servicio y no llegamos; esta, cuánto cuesta el canal y
      // qué calidad trae cada uno. Son dos preguntas distintas y juntarlas en
      // una sola pantalla no ayuda a ninguna de las dos.
      { to: '/ventas/comisiones', label: 'Comisiones del equipo', icon: Award },
    ],
  },
  {
    titulo: 'Cobranzas',
    items: [
      { to: '/ventas/cobranza', label: 'Cobros por gestionar', icon: Wallet, contador: 'cobros' },
    ],
  },
  {
    titulo: 'OLT / GPON',
    items: [
      // El tablero va primero: es la pantalla desde la que se empieza el día.
      { to: '/gpon', label: 'Tablero GPON', icon: LayoutDashboard },
      { to: '/olts', label: 'OLTs', icon: Network },
      // Global y no por OLT: un modelo de ONT es el mismo cuelgue de donde
      // cuelgue, y tenerlo por equipo haría que las copias se contradigan.
      { to: '/onu-types', label: 'Tipos de ONU', icon: Cpu },
      { to: '/onus', label: 'ONUs', icon: Radio },
      { to: '/naps', label: 'Cajas NAP', icon: Box },
      { to: '/perfiles', label: 'Perfiles y planes', icon: Layers },
      // Global y no por OLT, por lo mismo que los tipos de ONU: un ACS sirve a
      // todas. Tenerlo por equipo es cómo se llega a que cada OLT apunte a una
      // dirección distinta sin que nadie lo note.
      { to: '/tr069', label: 'TR-069 / ACS', icon: Cloud },
      { to: '/metricas', label: 'Métricas ópticas', icon: Waves },
    ],
  },
  {
    titulo: 'Infraestructura',
    // La importación y exportación de clientes viven dentro de la ficha del
    // router: son operaciones sobre un equipo concreto, no una sección aparte.
    items: [
      {
        to: '/red',
        label: 'Gestión de Red e IPAM',
        icon: Network,
        hijos: [
          { to: '/red/routers', label: 'Routers MikroTik', icon: RouterIcon },
          { to: '/red/redes', label: 'Redes IPv4', icon: Boxes },
          { to: '/red/auditoria', label: 'Auditoría de subred', icon: ScanSearch },
          { to: '/red/shaping', label: 'Regla de shaping', icon: SlidersHorizontal },
          // El tablero y el inventario son la misma pregunta hecha dos veces:
          // se veía una caída y había que cambiar de pantalla para saber de qué
          // torre colgaba. Van juntos y el menú tiene una sola entrada.
          { to: '/monitoreo', label: 'Monitoreo de red', icon: Activity },
          // Aparte del monitoreo aunque salga de él: una cosa es enterarse de que
          // se cayó la torre y otra es escribirle a los que cuelgan de ella. Quien
          // hace lo segundo suele ser soporte, no quien mira el tablero.
          { to: '/monitoreo/incidencias', label: 'Cortes masivos', icon: Megaphone },
          { to: '/bloqueos', label: 'Cortes / morosos', icon: Ban },
        ],
      },
    ],
  },
  {
    // Último a propósito: es a donde se va una vez, no todos los días.
    titulo: 'Sistema',
    items: [{ to: '/ajustes', label: 'Ajustes', icon: Settings }],
  },
]


/**
 * Los números que van al lado de algunos ítems del menú.
 *
 * ── Por qué solo tres ──
 *
 * Un contador en cada entrada convierte el menú en un tablero, y entonces no se
 * lee ninguno. Van los tres que exigen ir a esa pantalla hoy: cobros asignados,
 * prospectos enfriándose y órdenes esperando despacho.
 *
 * Cada consulta pide `head: true` y cuenta sin traer filas — el menú se dibuja
 * en cada navegación y traer trescientos prospectos para mostrar un "12" sería
 * pagar caro un número chico.
 */
function useContadores(puede) {
  const [n, setN] = useState({})

  const cargar = useCallback(async () => {
    const pedidos = {}

    if (puede('pagos.observaciones')) {
      pedidos.cobros = supabase
        .from('v_cobros_por_gestionar')
        .select('asignacion_id', { count: 'exact', head: true })
    }
    if (puede('ventas.prospectos')) {
      // "Enfriándose" es la condición del embudo que se mira todos los días:
      // abierto y sin contacto hace cinco días o más.
      pedidos.enfriando = supabase
        .from('v_prospectos')
        .select('id', { count: 'exact', head: true })
        .in('estado', ['nuevo', 'contactado', 'cotizado', 'negociacion'])
        .gte('dias_sin_contacto', 5)
    }
    if (puede('instalaciones.backoffice')) {
      pedidos.nuevas = supabase
        .from('instalaciones')
        .select('id', { count: 'exact', head: true })
        .in('estado', ['nueva', 'revisando', 'lista_asignar'])
    }

    const claves = Object.keys(pedidos)
    if (!claves.length) return

    const res = await Promise.all(Object.values(pedidos))
    // Un contador que falla no puede romper el menú: se omite y el ítem queda
    // sin número, que es exactamente como estaba antes.
    setN(Object.fromEntries(claves.map((k, i) => [k, res[i].error ? null : res[i].count])))
  }, [puede])

  useEffect(() => {
    cargar()
    // Dos minutos: son cifras que cambian por hora, no por segundo.
    const t = setInterval(cargar, 120000)
    return () => clearInterval(t)
  }, [cargar])

  return n
}

const CLASE_ITEM = (activo) =>
  `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
    activo
      ? 'bg-sky-600/15 font-medium text-sky-300'
      : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
  }`


/**
 * El menú mientras se resuelve quién entró.
 *
 * Barras grises con la forma del menú, no el menú de verdad. Lo importante es
 * que ocupe el mismo lugar: si no dibujara nada, el contenido de la derecha se
 * correría al aparecer y la página saltaría en cada recarga.
 */
const MenuCargando = ({ plegado }) => (
  <div className="space-y-2 px-1">
    {[0, 1, 2, 3, 4, 5, 6].map((i) => (
      <div
        key={i}
        className={`h-8 animate-pulse rounded-lg bg-slate-800/50 ${plegado ? 'w-10' : ''}`}
        // Largos distintos: todas iguales se leen como una tabla vacía, no como
        // algo que está por llegar.
        style={plegado ? undefined : { width: `${68 + ((i * 37) % 30)}%` }}
      />
    ))}
  </div>
)

/** El número al lado de un ítem. Solo aparece si hay algo: un "0" es ruido. */
const Insignia = ({ n }) =>
  n > 0 ? (
    <span className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-sky-500/20 px-1.5 text-[11px] font-semibold text-sky-300">
      {n > 99 ? '99+' : n}
    </span>
  ) : null

function Grupo({ item, contadores, plegado }) {
  const { pathname } = useLocation()
  // El grupo está "dentro" si la ruta actual es la suya o la de alguno de sus
  // hijos: Finanzas agrupa rutas sueltas, no un prefijo común.
  const dentro =
    pathname === item.to ||
    pathname.startsWith(`${item.to}/`) ||
    item.hijos.some((h) => pathname === h.to || pathname.startsWith(`${h.to}/`))
  const [abierto, setAbierto] = useState(dentro)

  const Icon = item.icon

  return (
    <div>
      <button
        type="button"
        onClick={() => setAbierto((a) => !a)}
        title={plegado ? item.label : undefined}
        className={`w-full ${CLASE_ITEM(dentro && !abierto)} ${
          plegado ? 'justify-center px-0' : 'justify-between'
        }`}
      >
        <span className="flex items-center gap-3">
          <Icon size={16} />
          {!plegado && item.label}
        </span>
        {!plegado && (
          <ChevronDown
            size={14}
            className={`transition-transform ${abierto ? 'rotate-180' : ''}`}
          />
        )}
      </button>

      {abierto && !plegado && (
        <div className="mt-1 space-y-0.5 border-l border-slate-800 pl-3 ml-4">
          {item.hijos.map((h) => (
            <NavLink
              key={h.to}
              to={h.to}
              end={h.end}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] transition ${
                  isActive
                    ? 'bg-sky-600/15 font-medium text-sky-300'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                }`
              }
            >
              <h.icon size={14} />
              {h.label}
              <Insignia n={contadores?.[h.contador]} />
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Sidebar() {
  const { puede, perfil, cargandoPerfil } = usePermisos()
  const marca = useMarca()
  const contadores = useContadores(puede)

  // Plegado: en una pantalla de 13 pulgadas, 240 px de menú son el 20% del
  // ancho. Se recuerda por dispositivo, igual que el tema.
  const [plegado, setPlegado] = useState(() => {
    try { return localStorage.getItem('menu-plegado') === 'si' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('menu-plegado', plegado ? 'si' : 'no') } catch { /* modo privado */ }
  }, [plegado])

  /**
   * Poda el menú dejando solo lo alcanzable.
   *
   * Un grupo se queda si le sobrevive al menos un hijo, aunque su propia ruta
   * esté vedada: "/finanzas" no es una pantalla, es un cajón, y esconderlo
   * porque el cajón no tiene permiso propio dejaría afuera a los pagos que sí
   * lo tienen.
   */
  const secciones = useMemo(
    () =>
      SECCIONES.map((seccion) => ({
        ...seccion,
        items: seccion.items
          .map((item) => {
            // `permiso` explícito gana sobre el mapa de rutas. Es la excepción
            // para "/" y está documentada ahí; cualquier otra entrada se sigue
            // resolviendo sola, que es lo que evita que el menú y el guardián
            // se contradigan.
            //
            // Acepta un arreglo, y ahí alcanza con tener uno — igual que el
            // mapa de rutas y que `ConPermiso`. Que las tres formas de pedir un
            // permiso se comporten distinto es cómo aparecen los ítems que se
            // ven y no abren.
            // La agenda personal del vendedor no se le ofrece a quien maneja
            // la cartera: no es su trabajo diario. No es un permiso —puede
            // entrar igual— es no ocuparle el menú con lo de otro.
            if (item.soloVendedor && puede('clientes.cartera')) return null
            if (item.permiso && ![item.permiso].flat().some((p) => puede(p))) return null
            if (!item.hijos) return item.permiso ? item : puedeEntrar(puede, item.to) ? item : null
            const hijos = item.hijos.filter((h) => puedeEntrar(puede, h.to))
            return hijos.length ? { ...item, hijos } : null
          })
          .filter(Boolean),
      })).filter((s) => s.items.length),
    [puede],
  )

  return (
    <aside
      className={`flex shrink-0 flex-col border-r border-slate-800 bg-slate-950/60 transition-[width] ${
        plegado ? 'w-16' : 'w-60'
      }`}
    >
      {/* La marca sale de la configuración, no está escrita acá: cada ISP que
          instala el sistema pone la suya en Ajustes → General. */}
      <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-4">
        {marca?.logo_b64 ? (
          <img src={marca.logo_b64} alt="" className="h-8 w-8 shrink-0 rounded-lg object-cover" />
        ) : (
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-sky-600 text-sm font-bold text-white">
            {(marca?.nombre_sistema ?? 'S').trim().charAt(0).toUpperCase()}
          </div>
        )}
        {!plegado && (
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold text-slate-100">
              {marca?.nombre_sistema ?? 'SmartOLT'}
            </p>
            <p className="truncate text-[11px] text-slate-500">{marca?.lema ?? ''}</p>
          </div>
        )}
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
        {/* Mientras no se sabe quién entró, el menú no se dibuja.
            Antes se dibujaba entero —`puede()` decía que sí durante la carga— y
            el vendedor veía por unos segundos Clientes, Finanzas, OLT y Ajustes
            antes de que desaparecieran. Le enseñaba que esas pantallas existen y
            le daba una ventana para entrar. */}
        {/* Y con un perfil ya cargado, una recarga en segundo plano no vacía el
            menú: parpadearía entero cada vez que se vuelve a la pestaña. */}
        {cargandoPerfil && !perfil ? (
          <MenuCargando plegado={plegado} />
        ) : (
          secciones.map((seccion, i) => (
          <div key={i}>
            {/* Plegado, el título se reemplaza por una línea: sin él las
                secciones se pegan y el menú se lee como una lista sola. */}
            {seccion.titulo &&
              (plegado ? (
                <div className="mx-auto mb-2 h-px w-6 bg-slate-800" />
              ) : (
                <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                  {seccion.titulo}
                </p>
              ))}
            <div className="space-y-1">
              {seccion.items.map((item) =>
                item.hijos ? (
                  <Grupo key={item.to} item={item} contadores={contadores} plegado={plegado} />
                ) : (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    // Plegado, el nombre pasa al tooltip del navegador: un menú
                    // de solo íconos sin forma de saber qué es cada uno obliga a
                    // probarlos.
                    title={plegado ? item.label : undefined}
                    className={({ isActive }) =>
                      `${CLASE_ITEM(isActive)} ${plegado ? 'justify-center px-0' : ''}`
                    }
                  >
                    <span className="relative">
                      <item.icon size={16} />
                      {/* Plegado no hay lugar para el número, pero sí para un
                          punto: sirve para saber que ahí hay algo esperando. */}
                      {plegado && contadores?.[item.contador] > 0 && (
                        <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-sky-400" />
                      )}
                    </span>
                    {!plegado && item.label}
                    {!plegado && <Insignia n={contadores?.[item.contador]} />}
                  </NavLink>
                ),
              )}
            </div>
          </div>
          ))
        )}
      </nav>

      <button
        type="button"
        onClick={() => setPlegado((v) => !v)}
        className="flex items-center gap-3 border-t border-slate-800 px-4 py-3 text-[12px] text-slate-500 transition hover:text-slate-300"
        title={plegado ? 'Mostrar el menú' : 'Ocultar el menú'}
      >
        <ChevronsLeft size={16} className={`transition-transform ${plegado ? 'rotate-180' : ''}`} />
        {!plegado && 'Ocultar menú'}
      </button>
    </aside>
  )
}
