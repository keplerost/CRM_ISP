import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Clock,
  DollarSign,
  HardHat,
  Inbox,
  LifeBuoy,
  Network,
  Radio,
  Truck,
  Users,
  Waves,
  Wifi,
  WifiOff,
  XCircle,
  PauseCircle,
  Receipt,
  Router as RouterIcon,
  Wallet,
} from 'lucide-react'
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts'
import { supabase } from '../lib/supabaseClient'
import { api } from '../lib/apiNetwork'
import { usePermisos } from '../lib/AuthContext'
import { puedeEntrar } from '../lib/rutasPermisos'
import { clientesConVencido, fechaLocal } from '../lib/abonados'
import { UMBRAL_RX_DBM } from '../components/olt/ONUStatsCard'
import { ErrorBanner, Skeleton } from '../components/ui'
import ResumenAreas from '../components/layout/ResumenAreas'

/**
 * El panel de inicio.
 *
 * ── Qué es y qué no es ──
 *
 * No es un informe: es la puerta del sistema. Todo lo que muestra es un enlace
 * a la pantalla donde eso se trabaja, con el filtro ya puesto cuando la
 * pantalla de destino sabe recibirlo. Un número que obliga a abrir un módulo y
 * volver a buscar lo mismo a mano no sirve para decidir — queda de adorno.
 *
 * Por eso cada KPI, cada fila de OLT, cada ticket y cada cobro es un `<Link>`
 * de verdad y no un `div` con `onClick`: se abre en pestaña nueva con el botón
 * del medio, se copia la dirección, y quien navega con teclado lo alcanza con
 * el tabulador y ve dónde está parado.
 *
 * ── Por qué las tarjetas se preguntan el permiso ──
 *
 * Una tarjeta que lleva a una pantalla que rebota es peor que no tenerla:
 * enseña que la pantalla existe y hace perder un clic. Cada bloque consulta el
 * MISMO mapa de rutas que usa el guardián del layout (`puedeEntrar`), así que
 * el panel no puede contradecirlo: el día que una ruta cambie de permiso, la
 * tarjeta lo sigue sola.
 *
 * ── Por qué los datos se piden con `allSettled` ──
 *
 * Son diez consultas independientes contra vistas distintas. Con `Promise.all`
 * una sola que falle —una instalación a la que le falta una migración, una
 * vista sin permiso de lectura— deja el panel entero en blanco. Así cada
 * bloque muestra lo suyo y el que no pudo cargar se dice a sí mismo, sin
 * arrastrar a los demás.
 */

const ABIERTO = (t) => !['resuelto', 'cancelado'].includes(t.estado)

/**
 * Contador animado.
 *
 * Cuenta desde cero respetando prefijo, sufijo y decimales, para que "$2.340"
 * siga siendo "$2.340" mientras sube. Con `prefers-reduced-motion` no anima:
 * para algunas personas el movimiento no es elegancia, es mareo.
 */
function useContador(valor) {
  const [mostrado, setMostrado] = useState(valor)
  const anterior = useRef(null)

  useEffect(() => {
    const texto = String(valor)
    const sinMovimiento =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    // Solo anima la primera vez que llega un valor. Si animara en cada
    // refresco, el panel estaría contando sin parar y sería imposible leerlo.
    if (sinMovimiento || anterior.current === texto || anterior.current !== null) {
      anterior.current = texto
      setMostrado(texto)
      return undefined
    }
    anterior.current = texto

    const m = texto.match(/^([^\d-]*)(-?[\d.,]+)(.*)$/)
    if (!m) {
      setMostrado(texto)
      return undefined
    }
    const [, prefijo, numero, sufijo] = m
    const destino = parseFloat(numero.replace(/\./g, '').replace(',', '.'))
    if (!Number.isFinite(destino)) {
      setMostrado(texto)
      return undefined
    }
    const decimales = (numero.split(',')[1] || '').length
    const inicio = performance.now()
    let raf

    const paso = (ahora) => {
      const p = Math.min(1, (ahora - inicio) / 900)
      const suave = 1 - Math.pow(1 - p, 3)
      setMostrado(
        prefijo +
          (suave * destino).toLocaleString('es-EC', {
            minimumFractionDigits: decimales,
            maximumFractionDigits: decimales,
          }) +
          sufijo,
      )
      if (p < 1) raf = requestAnimationFrame(paso)
    }
    raf = requestAnimationFrame(paso)
    return () => cancelAnimationFrame(raf)
  }, [valor])

  return mostrado
}

const moneda = (n) =>
  `$${Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const numero = (n) => Number(n || 0).toLocaleString('es-EC')

/* ═══════════════════════════════════════════════════════════════════════════
   PIEZAS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Tarjeta de KPI.
 *
 * Es un enlace entero, no una tarjeta con un enlace adentro: el área de clic
 * es toda la tarjeta, que es lo que uno intenta apretar.
 */
function KpiCard({ icon: Icon, etiqueta, valor, pista, a, tono = 'marca' }) {
  const mostrado = useContador(valor)

  // El color solo aparece cuando el número ES un estado. Un KPI neutro va del
  // color de marca como todo lo demás; si "abonados activos" fuera verde, el
  // verde dejaría de significar "en línea" en la pantalla de al lado.
  const tonos = {
    marca: 'bg-[#F0F9FF] text-sky-400',
    ok: 'bg-[#ECFDF5] text-emerald-400',
    aviso: 'bg-[#FFFBEB] text-amber-400',
    critico: 'bg-[#FEF2F2] text-red-400',
  }

  return (
    <Link to={a} className="t-card t-card-hover relative block overflow-hidden p-5">
      <span className="t-stripe" aria-hidden="true" />
      <div className="flex items-start justify-between">
        <span className={`t-kpi-icon ${tonos[tono]}`}>
          <Icon size={18} />
        </span>
        <ArrowRight size={14} className="mt-1 text-slate-600" aria-hidden="true" />
      </div>
      <p className="t-kpi-valor mt-3.5">{mostrado}</p>
      <p className="mt-1.5 text-xs font-semibold text-slate-300">{etiqueta}</p>
      {pista && <p className="mt-0.5 text-[11px] text-slate-500">{pista}</p>}
    </Link>
  )
}

/** Tarjeta de sección: encabezado con barrita de marca y enlace al módulo. */
function Seccion({ titulo, subtitulo, a, etiquetaEnlace = 'Ver todo', children, className = '' }) {
  return (
    <section className={`t-card overflow-hidden ${className}`}>
      <header className="flex items-center justify-between gap-4 border-b border-[rgba(15,23,42,0.06)] px-6 pt-5 pb-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="h-5 w-1 shrink-0 rounded-full bg-gradient-to-b from-sky-700 to-sky-400"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h2 className="t-titulo truncate text-sm font-bold text-slate-100">{titulo}</h2>
            {subtitulo && <p className="mt-0.5 text-[11.5px] text-slate-500">{subtitulo}</p>}
          </div>
        </div>
        {a && (
          <Link
            to={a}
            className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-sky-400 transition hover:bg-[#F0F9FF]"
          >
            {etiquetaEnlace}
            <ChevronRight size={13} />
          </Link>
        )}
      </header>
      <div className="p-6">{children}</div>
    </section>
  )
}

/** El hueco cuando no hay nada que mostrar. Dice qué significa el vacío. */
const Vacio = ({ icon: Icon = CheckCircle2, titulo, sub }) => (
  <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
    <div className="mb-3 grid h-10 w-10 place-items-center rounded-full bg-slate-800">
      <Icon size={18} className="text-slate-600" />
    </div>
    <p className="text-xs font-semibold text-slate-400">{titulo}</p>
    {sub && <p className="mt-1 text-[11px] text-slate-500">{sub}</p>}
  </div>
)

/**
 * Clientes por router: una tarjeta por cada RB cargado.
 *
 * Se arma con los routers de la base y el estado de cada abonado, no leyendo
 * los equipos: es lo que el sistema dice que tiene que pasar, y no depende de
 * que el RB conteste. Agregar un router en el módulo de red le hace aparecer
 * su tarjeta acá sin tocar nada.
 *
 * `cortado` y `suspendido` van separados porque dicen cosas distintas: el
 * primero es por deuda (y es lo que deja el botón "Suspender servicio"), el
 * segundo es una pausa o un secret deshabilitado que llegó al importar. Los
 * retirados (`baja`) no cuentan: ya no son abonados de ese router.
 *
 * Cada número abre el listado con el router y el estado ya filtrados.
 *
 * ── La deuda ──
 *
 * "Por cobrar" es el saldo de todas las facturas impagas de los abonados del
 * router; "vencido" es solo el de las que ya pasaron su vencimiento, con la
 * misma regla que `clientesConVencido`. El vencido abre el listado con
 * `?deuda=vencida`, que es el filtro que ya usa la tarjeta de cartera.
 * Los retirados tampoco suman acá: lo suyo es cobranza de baja, no del sector.
 */
const VISIBLES_DE_ENTRADA = 6

const ORDENES = [
  ['servicio', 'Más sin servicio'],
  ['deuda', 'Más deuda vencida'],
]

function ClientesPorRouter({ routers, clientes, facturas, salud, verRouters, verCrecimiento }) {
  const [todos, setTodos] = useState(false)
  const [orden, setOrden] = useState('servicio')

  const { tarjetas, sinRouter } = useMemo(() => {
    const cuenta = new Map(
      routers.map((r) => [
        r.id,
        {
          id: r.id,
          nombre: r.nombre,
          habilitado: r.activo !== false,
          activo: 0,
          cortado: 0,
          suspendido: 0,
          porCobrar: 0,
          vencido: 0,
        },
      ]),
    )
    const routerDe = new Map()
    let sinRouter = 0
    for (const c of clientes) {
      if (!['activo', 'cortado', 'suspendido'].includes(c.estado)) continue
      const r = cuenta.get(c.router_id)
      if (r) {
        r[c.estado] += 1
        routerDe.set(c.id, r)
      } else sinRouter += 1
    }

    const hoy = fechaLocal()
    for (const f of facturas) {
      const saldo = Number(f.saldo ?? 0)
      const r = routerDe.get(f.client_id)
      if (!r || !(saldo > 0)) continue
      r.porCobrar += saldo
      if (f.fecha_vencimiento && f.fecha_vencimiento < hoy) r.vencido += saldo
    }

    const sinServicio = (r) => r.cortado + r.suspendido
    const criterio =
      orden === 'deuda'
        ? (a, b) => b.vencido - a.vencido || b.porCobrar - a.porCobrar
        : (a, b) => sinServicio(b) - sinServicio(a) || b.vencido - a.vencido
    const tarjetas = [...cuenta.values()].sort(
      (a, b) => criterio(a, b) || String(a.nombre).localeCompare(String(b.nombre)),
    )
    return { tarjetas, sinRouter }
  }, [routers, clientes, facturas, orden])

  const enPantalla = todos ? tarjetas : tarjetas.slice(0, VISIBLES_DE_ENTRADA)
  const filtro = (id, estado) =>
    `/clientes?router=${encodeURIComponent(id)}${estado ? `&estado=${estado}` : ''}`
  const conVencido = (id) => `/clientes?router=${encodeURIComponent(id)}&deuda=vencida`

  return (
    <Seccion
      titulo="Clientes por router"
      subtitulo="Activos, cortados y pausados de cada MikroTik"
      a={verRouters ? '/red/routers' : null}
      etiquetaEnlace="Ver routers"
    >
      {tarjetas.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label="Ordenar routers">
          {ORDENES.map(([clave, etiqueta]) => (
            <button
              key={clave}
              type="button"
              onClick={() => setOrden(clave)}
              aria-pressed={orden === clave}
              className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition ${
                orden === clave
                  ? 'bg-[#F0F9FF] text-sky-400'
                  : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'
              }`}
            >
              {etiqueta}
            </button>
          ))}
        </div>
      )}
      {tarjetas.length === 0 ? (
        <Vacio
          icon={RouterIcon}
          titulo="No hay routers cargados"
          sub="Registrá el primero en Red → Routers"
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {enPantalla.map((r) => {
              const total = r.activo + r.cortado + r.suspendido
              const pct = total ? Math.round((r.activo / total) * 100) : 0
              const estado = salud?.[r.id]
              return (
                <div key={r.id} className={`t-panel p-4 ${r.habilitado ? '' : 'opacity-60'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <Link
                      to={filtro(r.id)}
                      className="t-titulo min-w-0 truncate text-[13px] font-bold text-slate-100 hover:text-sky-400"
                    >
                      {r.nombre}
                    </Link>
                    {estado && (
                      <span
                        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                          estado === 'online' ? 'bg-emerald-500' : 'bg-red-500'
                        }`}
                        title={estado === 'online' ? 'Responde' : 'No responde'}
                      />
                    )}
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {[
                      ['activo', 'activos', r.activo, 'text-emerald-400'],
                      ['cortado', 'cortados', r.cortado, 'text-red-400'],
                      ['suspendido', 'pausados', r.suspendido, 'text-amber-400'],
                    ].map(([clave, etiqueta, n, color]) => (
                      <Link
                        key={clave}
                        to={filtro(r.id, clave)}
                        className="rounded-lg px-1 py-1 transition hover:bg-slate-800"
                      >
                        <p
                          className={`t-dato text-lg font-bold leading-none ${n ? color : 'text-slate-500'}`}
                        >
                          {numero(n)}
                        </p>
                        <p className="mt-1 text-[11px] text-slate-500">{etiqueta}</p>
                      </Link>
                    ))}
                  </div>

                  {/* La barra dice lo mismo que los números; va oculta para
                      lectores de pantalla porque ya está escrito arriba. */}
                  <div className="mt-3 flex items-center gap-2">
                    <div
                      className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800"
                      aria-hidden="true"
                    >
                      <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="t-dato text-[11px] text-slate-500">
                      {total ? `${pct}% con servicio` : 'sin clientes'}
                    </span>
                  </div>

                  <div className="mt-3 flex items-end justify-between gap-2 border-t border-[rgba(15,23,42,0.06)] pt-3">
                    <div>
                      <p className="t-dato text-sm font-bold leading-none text-slate-100">
                        {moneda(r.porCobrar)}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-500">por cobrar</p>
                    </div>
                    {r.vencido > 0 ? (
                      <Link
                        to={conVencido(r.id)}
                        className="rounded-lg px-1 py-0.5 text-right transition hover:bg-slate-800"
                      >
                        <p className="t-dato text-sm font-bold leading-none text-red-400">
                          {moneda(r.vencido)}
                        </p>
                        <p className="mt-1 text-[11px] text-slate-500">vencido</p>
                      </Link>
                    ) : (
                      <p className="text-[11px] text-emerald-400">sin deuda vencida</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
            <span>
              {sinRouter > 0 &&
                `${numero(sinRouter)} abonado${sinRouter === 1 ? '' : 's'} sin router asignado`}
            </span>
            {tarjetas.length > VISIBLES_DE_ENTRADA && (
              <button
                type="button"
                onClick={() => setTodos((t) => !t)}
                className="rounded-lg px-2 py-1 font-semibold text-sky-400 transition hover:bg-[#F0F9FF]"
              >
                {todos ? 'Ver menos' : `Ver los ${tarjetas.length} routers`}
              </button>
            )}
            {verCrecimiento && (
              <Link
                to="/reportes/crecimiento-routers"
                className="ml-auto rounded-lg px-2 py-1 font-semibold text-sky-400 transition hover:bg-[#F0F9FF]"
              >
                Ver crecimiento mes a mes →
              </Link>
            )}
          </div>
        </>
      )}
    </Seccion>
  )
}

/* ═══════════════════════════════════════════════════════════════════════════
   EL PANEL
   ═══════════════════════════════════════════════════════════════════════════ */

export default function Dashboard() {
  const { puede } = usePermisos()
  const abre = useCallback((ruta) => puedeEntrar(puede, ruta), [puede])

  const [d, setD] = useState(null)
  const [error, setError] = useState(null)

  /**
   * Lo que salió mal en la última corrida de las tareas.
   *
   * Va por el middleware y no por la base porque ese resultado vive en memoria
   * del proceso que corre las tareas: es lo último que hizo, no un histórico.
   *
   * Si el middleware no responde, queda en null y la tarjeta no se dibuja. Es
   * correcto: no saber si hubo fallas no es lo mismo que saber que las hubo, y
   * un cartel rojo porque se cayó la API sería una alarma sobre la alarma.
   */
  const [problemas, setProblemas] = useState(null)
  const [saludRouters, setSaludRouters] = useState(null)

  useEffect(() => {
    let vivo = true
    const hoy = fechaLocal()

    // Todas de solo lectura y todas contra vistas que el sistema ya usaba en
    // otras pantallas. El panel no consulta nada que no se consultara ya.
    const consultas = [
      supabase
        .from('v_olt_resumen')
        .select('olt_id, numero, nombre, olt_estado, onus, online, caidas, los')
        .order('numero'),
      supabase.from('v_nodos_red').select('id, nombre, equipo, ip, estado, punto').order('nombre'),
      supabase.from('v_tickets').select('*').order('created_at', { ascending: false }).limit(80),
      supabase.from('v_pagos').select('*').order('created_at', { ascending: false }).limit(12),
      supabase.from('v_facturas_por_cobrar').select('client_id, saldo, fecha_vencimiento'),
      supabase.from('v_clientes_ficha').select('id, estado, router_id'),
      /* La MISMA vista y el MISMO filtro que usa el listado de ONUs.
         `senal_baja` se calcula en la base —migración 44— justamente para que
         la regla viva en un solo lugar: si el umbral cambia, cambia para el
         número de esta tarjeta y para la lista que abre, a la vez. */
      supabase
        .from('v_onus_clientes')
        .select('onu_id, sn, cliente, nombre_en_la_olt, rx_power_dbm, olt, ruta_onu', {
          count: 'exact',
        })
        .eq('senal_baja', true)
        .order('rx_power_dbm')
        /* Se cuenta en la base y se bajan solo las que se dibujan. Sin esto,
           un ISP con doscientas ONUs degradadas se las bajaba TODAS para
           mostrar un número y cuatro filas — y además el número habría quedado
           tapado por el tope de mil filas de la API. */
        .limit(6),
      supabase
        .from('v_instalaciones')
        .select('id, numero, cliente, nombre, tecnico_nombre, estado, hora')
        .eq('fecha', hoy),
      supabase.from('tecnicos').select('id, nombre').eq('activo', true).order('nombre'),
      supabase.from('v_expedientes').select('id').eq('completo', false),
      /* Los pausados cuya fecha ya pasó.
         Quedan sin servicio y sin factura, así que no generan ningún reclamo:
         el abonado cree que sigue de viaje y el ISP no cobra. Es una pérdida
         silenciosa, y la única forma de enterarse es que alguien se acuerde. */
      supabase
        .from('clientes')
        .select('id, nombre, suspendido_motivo, suspendido_hasta', { count: 'exact' })
        .eq('estado', 'suspendido')
        .not('suspendido_hasta', 'is', null)
        .lt('suspendido_hasta', hoy)
        .order('suspendido_hasta')
        .limit(6),
      // Solo lo que se dibuja: la tabla también guarda la clave del equipo.
      supabase.from('routers_mikrotik').select('id, nombre, activo').order('nombre'),
      /* Facturas y cobros de hoy, facturas sin pagar y vencidas: sumados en la
         base sobre TODO, no sobre las filas que bajan. Sin la migración 206
         falla sola y las tarjetas que dependen de ella no se dibujan. */
      supabase.rpc('panel_facturacion', { p_hoy: hoy }),
    ]

    Promise.allSettled(consultas).then((res) => {
      if (!vivo) return
      // Una vista que falla devuelve lista vacía y el resto del panel sigue.
      const filas = (i) => (res[i].status === 'fulfilled' ? (res[i].value.data ?? []) : [])
      // El total que informa la base, para las consultas que no bajan todo.
      const cuantas = (i) =>
        res[i].status === 'fulfilled' ? (res[i].value.count ?? filas(i).length) : 0

      // Si TODAS fallaron no es una vista faltante, es la conexión: ahí sí
      // conviene decirlo en vez de mostrar un panel lleno de ceros.
      const todasFallaron = res.every(
        (r) => r.status === 'rejected' || r.value?.error,
      )
      if (todasFallaron) {
        setError(res.find((r) => r.value?.error)?.value.error ?? new Error('Sin conexión'))
      }

      setD({
        olts: filas(0),
        nodos: filas(1),
        tickets: filas(2),
        pagos: filas(3).filter((p) => !p.anulado),
        facturas: filas(4),
        clientes: filas(5),
        onusBajas: filas(6),
        onusBajasTotal: cuantas(6),
        instalaciones: filas(7),
        tecnicos: filas(8),
        expedientes: filas(9),
        pausadosVencidos: filas(10),
        pausadosVencidosTotal: cuantas(10),
        routers: filas(11),
        facturacion: filas(12)[0] ?? null,
      })
    })

    /* Si cada router responde o no. Va aparte y sin esperar: consulta los
       equipos en vivo y uno caído tarda en contestar. Mientras no llega, las
       tarjetas se dibujan igual, solo que sin el puntito de estado. */
    api.ipam
      .saludRouters()
      .then(
        (f) => vivo && setSaludRouters(Object.fromEntries((f ?? []).map((r) => [r.id, r.estado]))),
      )
      .catch(() => {})

    api.tareas
      .estado()
      .then((r) => vivo && setProblemas(r?.problemas ?? null))
      .catch(() => {})

    return () => {
      vivo = false
    }
  }, [])

  const m = useMemo(() => {
    if (!d) return null
    const hoy = fechaLocal()

    const conSaldo = d.facturas.filter((f) => Number(f.saldo) > 0)
    const porVencer = conSaldo.filter((f) => f.fecha_vencimiento && f.fecha_vencimiento >= hoy)

    /* La MISMA función que usa el listado de abonados para su filtro. Es lo
       que garantiza que el número de esta tarjeta y la lista que abre hablen
       de la misma gente: si el criterio cambia, cambia para los dos. */
    const idsVencidos = clientesConVencido(d.facturas, hoy)
    const vencidas = conSaldo.filter((f) => idsVencidos.has(f.client_id))

    /* Al día = activo y sin ninguna factura con saldo. Antes se restaba a los
       activos la cantidad de abonados con saldo, pero esos incluyen cortados y
       de baja: con más deudores cortados que activos daba negativo y la
       tarjeta mostraba 0 aunque hubiera abonados al día. */
    const idsConSaldo = new Set(conSaldo.map((f) => f.client_id))
    const alDia = d.clientes.filter((c) => c.estado === 'activo' && !idsConSaldo.has(c.id)).length

    return {
      activos: d.clientes.filter((c) => c.estado === 'activo').length,
      abiertos: d.tickets.filter(ABIERTO),
      vencidoMonto: vencidas.reduce((s, f) => s + Number(f.saldo || 0), 0),
      vencidasCuentas: idsVencidos.size,
      cartera: [
        { nombre: 'Al día', valor: alDia, color: '#10B981' },
        { nombre: 'Por vencer', valor: new Set(porVencer.map((f) => f.client_id)).size, color: '#F59E0B' },
        { nombre: 'Vencido', valor: idsVencidos.size, color: '#EF4444' },
      ].map((x) => ({ ...x, valor: Math.max(0, x.valor) })),
      visitasHoy: d.instalaciones,
      enCurso: d.instalaciones.filter((i) => i.estado === 'en_curso').length,
      cobradoHoy: d.pagos
        .filter((p) => String(p.fecha_pago || '').slice(0, 10) === hoy)
        .reduce((s, p) => s + Number(p.monto || 0), 0),
    }
  }, [d])

  if (!d || !m) return <PanelCargando />

  return (
    <div className="space-y-6">
      {/* ── Encabezado ─────────────────────────────────────────────────── */}
      <div>
        <h1 className="t-titulo text-xl font-extrabold text-slate-100">Panel</h1>
        <p className="mt-0.5 text-xs text-slate-500">
          El estado del sistema, y la puerta a cada módulo
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <TareasConProblemas problemas={problemas} puede={abre} />

      <PausadosVencidos
        abonados={d.pausadosVencidos}
        total={d.pausadosVencidosTotal}
        puede={abre}
      />

      {/* ── KPIs ───────────────────────────────────────────────────────────
          Seis números, y cada uno abre la pantalla donde se trabaja. Los dos
          que el prototipo traía —uptime de red y throughput pico— no están:
          este sistema no guarda ni histórico de disponibilidad ni medición de
          tráfico, así que serían un número inventado. En su lugar van dos que
          sí existen y que además se miran todos los días. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {abre('/clientes') && (
          <KpiCard
            icon={Users}
            etiqueta="Abonados activos"
            valor={numero(m.activos)}
            pista={`de ${numero(d.clientes.length)} en el padrón`}
            a="/clientes"
          />
        )}
        {abre('/soporte') && (
          <KpiCard
            icon={LifeBuoy}
            etiqueta="Tickets abiertos"
            valor={numero(m.abiertos.length)}
            pista={`${m.abiertos.filter((t) => t.prioridad === 'alta').length} de prioridad alta`}
            a="/soporte?estado=pendientes"
            tono={m.abiertos.length ? 'aviso' : 'ok'}
          />
        )}
        {/* Abre exactamente a la gente que este número contó: el listado
            filtra con `clientesConVencido`, la misma función que se usa acá
            arriba para calcularlo. */}
        {/* Facturas sin pagar, con las vencidas adentro: las vencidas son una
            parte de las sin pagar, y verlas juntas dice cuánto de lo pendiente
            ya está atrasado. Reemplaza a "Cartera vencida", que mostraba el
            mismo monto vencido. Sin la migración 206 vuelve la tarjeta vieja. */}
        {abre('/clientes') && d.facturacion && (
          <KpiCard
            icon={Wallet}
            etiqueta="Facturas sin pagar"
            valor={moneda(d.facturacion.sin_pagar_monto)}
            pista={
              <>
                {numero(d.facturacion.sin_pagar)} factura{d.facturacion.sin_pagar === 1 ? '' : 's'}
                {d.facturacion.vencidas > 0 ? (
                  <span className="font-semibold text-red-400">
                    {' · '}
                    {numero(d.facturacion.vencidas)} vencida{d.facturacion.vencidas === 1 ? '' : 's'} ·{' '}
                    {moneda(d.facturacion.vencidas_monto)}
                  </span>
                ) : (
                  <span className="text-emerald-400"> · ninguna vencida</span>
                )}
              </>
            }
            a={d.facturacion.vencidas > 0 ? '/clientes?deuda=vencida' : '/clientes'}
            tono={d.facturacion.vencidas > 0 ? 'critico' : 'ok'}
          />
        )}
        {abre('/facturacion') && d.facturacion && (
          <KpiCard
            icon={Receipt}
            etiqueta="Facturas de hoy"
            valor={numero(d.facturacion.facturas_hoy)}
            pista={`${moneda(d.facturacion.facturado_hoy)} facturados`}
            a="/facturacion?t=mes"
          />
        )}
        {(abre('/transacciones') || abre('/pagos')) && d.facturacion && (
          <KpiCard
            icon={DollarSign}
            etiqueta="Cobros de hoy"
            valor={numero(d.facturacion.cobros_hoy)}
            pista={`${moneda(d.facturacion.cobrado_hoy)} cobrados`}
            a={
              abre('/transacciones')
                ? `/transacciones?desde=${fechaLocal()}&hasta=${fechaLocal()}`
                : '/pagos'
            }
          />
        )}
        {abre('/clientes') && !d.facturacion && (
          <KpiCard
            icon={DollarSign}
            etiqueta="Cartera vencida"
            valor={moneda(m.vencidoMonto)}
            pista={`${numero(m.vencidasCuentas)} cuentas con saldo vencido`}
            a="/clientes?deuda=vencida"
            tono={m.vencidoMonto > 0 ? 'critico' : 'ok'}
          />
        )}
        {abre('/onus') && (
          <KpiCard
            icon={Waves}
            etiqueta="ONUs con señal baja"
            valor={numero(d.onusBajasTotal)}
            pista={`por debajo de ${UMBRAL_RX_DBM} dBm`}
            a="/onus?senal=baja"
            tono={d.onusBajasTotal ? 'critico' : 'ok'}
          />
        )}
        {abre('/clientes/instalaciones') && (
          <KpiCard
            icon={Truck}
            etiqueta="Visitas técnicas hoy"
            valor={numero(m.visitasHoy.length)}
            pista={`${m.enCurso} en curso`}
            a="/clientes/instalaciones"
          />
        )}
        {abre('/instalaciones/nuevas') && (
          <KpiCard
            icon={Inbox}
            etiqueta="Por despachar"
            valor={numero(d.expedientes.length)}
            pista="ventas cerradas sin orden"
            a="/instalaciones/nuevas"
            tono={d.expedientes.length ? 'aviso' : 'ok'}
          />
        )}
      </div>

      {/* El resumen de áreas que ya existía. Es otra pregunta —qué pasó hoy en
          ventas y en campo, con el detalle a un clic— y sigue siendo suya. */}
      <ResumenAreas />

      {abre('/clientes') && (
        <ClientesPorRouter
          routers={d.routers}
          clientes={d.clientes}
          facturas={d.facturas}
          salud={saludRouters}
          verRouters={abre('/red/routers')}
          verCrecimiento={abre('/reportes/crecimiento-routers')}
        />
      )}

      {/* ── Red ────────────────────────────────────────────────────────── */}
      <div className="grid gap-5 lg:grid-cols-3">
        {abre('/gpon') && (
          <Seccion
            titulo="Topología GPON"
            subtitulo="Cada OLT, con sus ONUs en línea y caídas"
            a="/gpon"
            className="lg:col-span-2"
          >
            {d.olts.length === 0 ? (
              <Vacio
                icon={Network}
                titulo="No hay OLTs cargadas"
                sub="Registrá la primera en el módulo OLT"
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {d.olts.map((o) => {
                  const caidas = Number(o.caidas || 0)
                  const total = Number(o.onus || 0)
                  const salud =
                    o.olt_estado === 'down' || caidas > total * 0.2
                      ? 'critico'
                      : caidas > 0
                        ? 'aviso'
                        : 'ok'
                  const etiqueta = { ok: 'Operativa', aviso: 'Degradada', critico: 'Crítica' }[salud]

                  return (
                    <Link
                      key={o.olt_id}
                      to={`/olts/${o.olt_id}`}
                      className="t-panel t-lift block p-4"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="t-titulo truncate text-[13px] font-bold text-slate-100">
                            {o.nombre}
                          </p>
                          <p className="t-dato mt-0.5 text-[11px] text-slate-500">
                            OLT-{String(o.numero).padStart(2, '0')}
                          </p>
                        </div>
                        <span className={`t-badge t-badge-${salud === 'ok' ? 'ok' : salud}`}>
                          {etiqueta}
                        </span>
                      </div>

                      <div className="mt-3 flex items-end justify-between">
                        <div>
                          <p className="t-dato text-lg font-bold leading-none text-slate-100">
                            {numero(o.online)}
                            <span className="text-xs font-medium text-slate-500">
                              {' '}
                              / {numero(total)}
                            </span>
                          </p>
                          <p className="mt-1 text-[11px] text-slate-500">ONUs en línea</p>
                        </div>
                        {caidas > 0 && (
                          <span className="t-dato text-[11px] font-semibold text-red-400">
                            {numero(caidas)} caídas
                          </span>
                        )}
                      </div>

                      {/* La barra dice lo mismo que el número, pero se lee sin
                          leer. Va con `aria-hidden` porque el número ya está
                          escrito ahí arriba. */}
                      <div
                        className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-800"
                        aria-hidden="true"
                      >
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-sky-700 to-sky-400"
                          style={{ width: `${total ? (Number(o.online) / total) * 100 : 0}%` }}
                        />
                      </div>
                    </Link>
                  )
                })}
              </div>
            )}
          </Seccion>
        )}

        {abre('/monitoreo') && (
          <Seccion titulo="Alertas técnicas" subtitulo="Lo que hay que mirar ahora" a="/monitoreo/incidencias">
            {d.onusBajasTotal === 0 && d.nodos.filter((n) => n.estado === 'down').length === 0 ? (
              <Vacio titulo="Sin alertas activas" sub="Todo operando con normalidad" />
            ) : (
              <ul className="space-y-2">
                {d.nodos
                  .filter((n) => n.estado === 'down')
                  .slice(0, 4)
                  .map((n) => (
                    <li key={`n-${n.id}`}>
                      <Link to="/monitoreo" className="t-panel t-lift flex items-start gap-2.5 p-3">
                        <XCircle size={15} className="mt-0.5 shrink-0 text-red-400" />
                        <div className="min-w-0">
                          <p className="truncate text-xs font-semibold text-slate-200">
                            {n.nombre} sin responder
                          </p>
                          <p className="t-dato mt-0.5 truncate text-[11px] text-slate-500">
                            {n.equipo} · {n.ip}
                          </p>
                        </div>
                      </Link>
                    </li>
                  ))}
                {abre('/onus') &&
                  d.onusBajas.slice(0, 4).map((o) => (
                  <li key={`o-${o.onu_id}`}>
                    {/* A la ficha de ESA ONU. Antes iba a Métricas ópticas, que
                        es la herramienta de diagnóstico en vivo: obligaba a
                        elegir OLT y puerto y volver a buscar la que la alerta
                        ya había nombrado. */}
                    <Link
                      to={`/onus/${o.onu_id}`}
                      className="t-panel t-lift flex items-start gap-2.5 p-3"
                    >
                      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-400" />
                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-slate-200">
                          Señal degradada
                          {o.cliente || o.nombre_en_la_olt
                            ? ` · ${o.cliente ?? o.nombre_en_la_olt}`
                            : ''}
                        </p>
                        <p className="t-dato mt-0.5 truncate text-[11px] text-slate-500">
                          {o.sn} · {o.rx_power_dbm} dBm{o.ruta_onu ? ` · ${o.ruta_onu}` : ''}
                        </p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Seccion>
        )}
      </div>

      {/* ── Operación ──────────────────────────────────────────────────── */}
      <div className="grid gap-5 lg:grid-cols-3">
        {abre('/soporte') && (
          <Seccion
            titulo="Tickets de soporte"
            subtitulo="Por estado, los más recientes primero"
            a="/soporte"
            className="lg:col-span-2"
          >
            {m.abiertos.length === 0 ? (
              <Vacio titulo="No hay tickets sin resolver" sub="La bandeja está limpia" />
            ) : (
              <div className="grid gap-4 sm:grid-cols-3">
                {[
                  ['Sin asignar', ['abierto']],
                  ['Asignados', ['asignado']],
                  ['En curso', ['en_ruta', 'en_proceso']],
                ].map(([titulo, estados]) => {
                  const lista = m.abiertos.filter((t) => estados.includes(t.estado))
                  return (
                    <div key={titulo}>
                      <div className="mb-2.5 flex items-center justify-between">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-600">
                          {titulo}
                        </p>
                        <span className="t-dato text-[11px] font-bold text-slate-400">
                          {lista.length}
                        </span>
                      </div>
                      <div className="space-y-2">
                        {lista.length === 0 ? (
                          <p className="t-panel p-3 text-[11px] text-slate-500">Ninguno</p>
                        ) : (
                          lista.slice(0, 3).map((t) => (
                            <Link
                              key={t.id}
                              to={`/soporte/${t.id}`}
                              className="t-panel t-lift block p-3"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <p className="t-dato text-[10px] font-bold text-slate-500">
                                  #{t.codigo}
                                </p>
                                {t.prioridad && (
                                  <span
                                    className={`t-badge t-badge-${
                                      { alta: 'critico', media: 'aviso', baja: 'neutro' }[
                                        t.prioridad
                                      ] ?? 'neutro'
                                    }`}
                                  >
                                    {t.prioridad}
                                  </span>
                                )}
                              </div>
                              <p className="mt-1 truncate text-xs font-semibold text-slate-200">
                                {t.cliente || t.nombre || 'Sin cliente'}
                              </p>
                              {t.tecnico && (
                                <p className="mt-0.5 truncate text-[11px] text-slate-500">
                                  {t.tecnico}
                                </p>
                              )}
                            </Link>
                          ))
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </Seccion>
        )}

        {abre('/soporte/tecnicos') && (
          <Seccion titulo="Personal en campo" subtitulo="Quién está y con qué" a="/soporte/tecnicos">
            {d.tecnicos.length === 0 ? (
              <Vacio icon={HardHat} titulo="No hay técnicos activos" />
            ) : (
              <ul className="space-y-2">
                {d.tecnicos.slice(0, 5).map((t) => {
                  const suyas = m.visitasHoy.filter((i) => i.tecnico_nombre === t.nombre)
                  const enCurso = suyas.find((i) => i.estado === 'en_curso')
                  return (
                    <li key={t.id}>
                      <Link
                        to="/soporte/tecnicos"
                        className="t-panel t-lift flex items-center gap-3 p-3"
                      >
                        <span className="t-dato grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#F0F9FF] text-[11px] font-bold text-sky-400">
                          {t.nombre
                            .split(' ')
                            .slice(0, 2)
                            .map((p) => p[0])
                            .join('')
                            .toUpperCase()}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold text-slate-200">{t.nombre}</p>
                          <p className="truncate text-[11px] text-slate-500">
                            {enCurso
                              ? `En sitio · ${enCurso.cliente ?? enCurso.nombre ?? ''}`
                              : suyas.length
                                ? `${suyas.length} visita${suyas.length > 1 ? 's' : ''} hoy`
                                : 'Sin visitas hoy'}
                          </p>
                        </div>
                        <span className={`t-badge ${enCurso ? 't-badge-aviso' : 't-badge-ok'}`}>
                          {enCurso ? 'En sitio' : 'Libre'}
                        </span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </Seccion>
        )}
      </div>

      {/* ── Dinero ─────────────────────────────────────────────────────── */}
      <div className="grid gap-5 lg:grid-cols-3">
        {abre('/pagos') && (
          <Seccion
            titulo="Últimos cobros registrados"
            subtitulo={`${moneda(d.facturacion?.cobrado_hoy ?? m.cobradoHoy)} cobrados hoy`}
            a="/pagos"
            className="lg:col-span-2"
          >
            {d.pagos.length === 0 ? (
              <Vacio icon={DollarSign} titulo="Todavía no se registró ningún cobro" />
            ) : (
              <div className="overflow-x-auto">
                <table className="t-tabla">
                  <thead>
                    <tr>
                      <th>Abonado</th>
                      <th>Forma de pago</th>
                      <th className="text-right">Monto</th>
                      <th>Cuándo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.pagos.slice(0, 6).map((p) => (
                      <tr key={p.id}>
                        <td>
                          {/* La fila lleva a la ficha del abonado, que es lo
                              que uno quiere mirar después de ver un cobro. */}
                          <Link
                            to={p.client_id ? `/clientes/${p.client_id}` : '/pagos'}
                            className="font-semibold text-slate-200 hover:text-sky-400"
                          >
                            {p.cliente || p.cliente_nombre || '—'}
                          </Link>
                        </td>
                        <td className="text-slate-500">{p.forma_pago || '—'}</td>
                        <td className="t-dato text-right font-bold text-slate-100">
                          {moneda(p.monto)}
                        </td>
                        <td className="t-dato text-[11px] text-slate-500">
                          {p.created_at
                            ? new Date(p.created_at).toLocaleString('es-EC', {
                                day: '2-digit',
                                month: '2-digit',
                                hour: '2-digit',
                                minute: '2-digit',
                              })
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Seccion>
        )}

        {abre('/clientes') && (
          <Seccion titulo="Estado de la cartera" subtitulo="Abonados por situación de pago" a="/clientes">
            <div className="flex items-center gap-5">
              <div className="h-[132px] w-[132px] shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={m.cartera}
                      dataKey="valor"
                      nameKey="nombre"
                      innerRadius={42}
                      outerRadius={62}
                      paddingAngle={2}
                      stroke="none"
                      isAnimationActive={false}
                    >
                      {m.cartera.map((c) => (
                        <Cell key={c.nombre} fill={c.color} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </div>
              {/* La leyenda lleva el número al lado del color: el color solo
                  no dice cuánto, y para quien no lo distingue no dice nada. */}
              <ul className="min-w-0 flex-1 space-y-2.5">
                {m.cartera.map((c) => (
                  <li key={c.nombre} className="flex items-center gap-2.5">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: c.color }}
                      aria-hidden="true"
                    />
                    <span className="flex-1 truncate text-xs text-slate-400">{c.nombre}</span>
                    <span className="t-dato text-xs font-bold text-slate-100">
                      {numero(c.valor)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </Seccion>
        )}
      </div>

      {/* ── Enlaces de radio ───────────────────────────────────────────── */}
      {abre('/monitoreo') && (
        <Seccion
          titulo="Enlaces de radio y PTP"
          subtitulo="Los nodos que sostienen la red fuera de la fibra"
          a="/monitoreo"
        >
          {d.nodos.length === 0 ? (
            <Vacio icon={Radio} titulo="No hay nodos cargados" sub="Se registran en Monitoreo de red" />
          ) : (
            <div className="overflow-x-auto">
              <table className="t-tabla">
                <thead>
                  <tr>
                    <th>Nodo</th>
                    <th>Equipo</th>
                    <th>Dirección IP</th>
                    <th>Ubicación</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {d.nodos.slice(0, 8).map((n) => {
                    const meta = {
                      up: ['t-badge-ok', 'En línea', Wifi, 'text-emerald-400'],
                      down: ['t-badge-critico', 'Sin conexión', WifiOff, 'text-red-400'],
                      degradado: ['t-badge-aviso', 'Degradada', Activity, 'text-amber-400'],
                    }[n.estado] ?? ['t-badge-neutro', 'Sin datos', Clock, 'text-slate-500']
                    const [clase, texto, Icono, colorIcono] = meta

                    return (
                      <tr key={n.id}>
                        <td className="font-semibold text-slate-200">
                          <Link to="/monitoreo" className="hover:text-sky-400">
                            {n.nombre}
                          </Link>
                        </td>
                        <td className="text-slate-500">{n.equipo || '—'}</td>
                        <td className="t-dato text-slate-400">{n.ip || '—'}</td>
                        <td className="text-slate-500">{n.punto || '—'}</td>
                        <td>
                          <span className={`t-badge ${clase}`}>
                            <Icono size={11} className={colorIcono} />
                            {texto}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Seccion>
      )}
    </div>
  )
}

/** El panel mientras carga: el hueco con la forma que va a tener. */
const PanelCargando = () => (
  <div className="space-y-6">
    <div>
      <Skeleton className="h-6 w-32" />
      <Skeleton className="mt-2 h-3 w-64" />
    </div>
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="t-card h-[132px] animate-pulse" />
      ))}
    </div>
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="t-card h-64 animate-pulse lg:col-span-2" />
      <div className="t-card h-64 animate-pulse" />
    </div>
  </div>
)

/* ── Lo que la última corrida no pudo hacer ────────────────────────────────── */

const TAREAS = {
  mora: {
    titulo: 'Corte por mora',
    queSignifica: 'Esos abonados siguen navegando sin haber pagado.',
    donde: '/red/routers',
    verbo: 'Revisar los routers',
  },
  cortes: {
    titulo: 'Cortes y promesas',
    queSignifica: 'Quedaron cortes o reconexiones sin aplicar en el router.',
    donde: '/red/routers',
    verbo: 'Revisar los routers',
  },
  avisos_pago: {
    titulo: 'Avisos de pago',
    queSignifica: 'Esos abonados no recibieron su aviso.',
    donde: '/ajustes/crontab',
    verbo: 'Ver la corrida',
  },
}

/**
 * Solo aparece cuando hay algo que arreglar.
 *
 * ── Por qué acá y no en Tareas programadas ──
 *
 * Ahí ya estaba, y por eso no servía: nadie abre todos los días una pantalla
 * que casi siempre está bien. Uno se entera de que un corte falló cuando llama
 * el cliente o cuando falta la plata a fin de mes.
 *
 * El panel es lo que se abre igual. Una tarjeta que solo existe cuando hay
 * problema no se vuelve parte del paisaje — el día que aparece, aparece.
 *
 * ── Por qué dice qué significa y no solo cuántos ──
 *
 * "3 fallidos en corte por mora" no mueve a nadie. "Esos abonados siguen
 * navegando sin haber pagado" sí, porque nombra la consecuencia — que es lo que
 * decide si vale la pena dejar lo que uno estaba haciendo.
 */
/**
 * Los pausados que ya deberían haber vuelto.
 *
 * Es la única pérdida del sistema que no genera ningún reclamo: el abonado
 * quedó sin servicio y sin factura, cree que sigue de viaje, y el ISP no cobra.
 * Nadie llama porque a nadie le molesta — hasta que pasan tres meses.
 *
 * Por eso va en el panel y no en un listado: hay que tropezarse con esto, no
 * ir a buscarlo.
 */
function PausadosVencidos({ abonados, total, puede }) {
  if (!abonados?.length) return null

  return (
    <div className="t-card border-l-4 border-l-amber-500 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="t-kpi-icon shrink-0 bg-[#FFFBEB] text-amber-400">
            <PauseCircle size={18} />
          </span>
          <div className="min-w-0">
            <p className="t-titulo text-sm font-bold text-slate-100">
              {total === 1
                ? 'Un abonado pausado ya pasó su fecha'
                : `${total} abonados pausados ya pasaron su fecha`}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              Siguen sin internet y sin facturarse. Si ya volvieron, hay que reactivarlos.
            </p>

            <ul className="mt-2 space-y-0.5">
              {abonados.map((c) => (
                <li key={c.id} className="text-[11px] text-slate-500">
                  <Link to={`/clientes/${c.id}`} className="font-medium text-slate-400 hover:text-sky-400">
                    {c.nombre}
                  </Link>
                  <span className="t-dato"> · volvía el {c.suspendido_hasta}</span>
                  {c.suspendido_motivo ? ` · ${c.suspendido_motivo}` : ''}
                </li>
              ))}
              {total > abonados.length && (
                <li className="text-[11px] text-slate-600">y {total - abonados.length} más</li>
              )}
            </ul>
          </div>
        </div>

        {puede('/clientes') && (
          <Link to="/clientes?estado=suspendido" className="t-btn t-btn-marca shrink-0">
            Ver los pausados
          </Link>
        )}
      </div>
    </div>
  )
}

function TareasConProblemas({ problemas, puede }) {
  // "Ver todos" abierto, por tarea.
  const [abiertos, setAbiertos] = useState({})
  // Los nombres de los routers que fallaron, para el botón "Reparar <router>".
  const [nombres, setNombres] = useState({})

  const conFalla = Object.entries(problemas ?? {}).filter(
    ([, p]) => p && (p.error || p.fallidos > 0),
  )
  const idsRouters = [...new Set(conFalla.flatMap(([, p]) => p.routers ?? []))].sort().join(',')

  useEffect(() => {
    if (!idsRouters) return
    supabase
      .from('routers_mikrotik')
      .select('id, nombre')
      .in('id', idsRouters.split(','))
      .then(({ data }) => setNombres(Object.fromEntries((data ?? []).map((r) => [r.id, r.nombre]))))
  }, [idsRouters])

  if (!conFalla.length) return null

  return (
    <div className="space-y-3">
      {conFalla.map(([clave, p]) => {
        const t = TAREAS[clave] ?? { titulo: clave, queSignifica: '', donde: '/ajustes/crontab', verbo: 'Ver' }
        return (
          <div key={clave} className="t-card border-l-4 border-l-amber-500 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <span className="t-kpi-icon shrink-0 bg-[#FFFBEB] text-amber-400">
                  <AlertTriangle size={18} />
                </span>
                <div className="min-w-0">
                  <p className="t-titulo text-sm font-bold text-slate-100">
                    {p.error
                      ? `${t.titulo}: la tarea no pudo correr`
                      : `${t.titulo}: ${p.fallidos} ${p.fallidos === 1 ? 'caso quedó' : 'casos quedaron'} sin aplicar`}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {p.error ? p.error : t.queSignifica}
                  </p>

                  {p.ejemplos?.length > 0 && (
                    <ul className="mt-2 max-h-64 space-y-0.5 overflow-y-auto">
                      {(abiertos[clave] && p.lista?.length ? p.lista : p.ejemplos).map((e, i) => (
                        <li key={i} className="t-dato truncate text-[11px] text-slate-500">
                          <b className="text-slate-400">{e.cliente ?? '—'}</b>
                          {e.motivo ? ` · ${e.motivo}` : ''}
                        </li>
                      ))}
                      {p.fallidos > p.ejemplos.length && !abiertos[clave] && (
                        <li>
                          {p.lista?.length > p.ejemplos.length ? (
                            <button
                              type="button"
                              onClick={() => setAbiertos((a) => ({ ...a, [clave]: true }))}
                              className="text-[11px] font-semibold text-sky-400 hover:underline"
                            >
                              Ver los {p.fallidos}
                            </button>
                          ) : (
                            <span className="text-[11px] text-slate-600">
                              y {p.fallidos - p.ejemplos.length} más
                            </span>
                          )}
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              </div>

              {puede(t.donde) &&
                (t.donde === '/red/routers' && p.routers?.length ? (
                  // Directo a "Reparar el router" de cada router que falló: ahí
                  // se aplican los cortes y reconexiones que quedaron pendientes.
                  <div className="flex shrink-0 flex-col gap-2">
                    {p.routers.map((id) => (
                      <Link key={id} to={`/red/routers?router=${id}`} className="t-btn t-btn-marca">
                        Reparar {nombres[id] ?? 'el router'}
                        <ChevronRight size={14} />
                      </Link>
                    ))}
                  </div>
                ) : (
                  <Link to={t.donde} className="t-btn t-btn-marca shrink-0">
                    {t.verbo}
                    <ChevronRight size={14} />
                  </Link>
                ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
