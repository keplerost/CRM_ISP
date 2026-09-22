import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Bell,
  Boxes,
  Camera,
  CheckCircle2,
  ClipboardList,
  Clock,
  CloudOff,
  MapPin,
  Navigation,
  Phone,
  PlayCircle,
  RadioTower,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Wifi,
  PackageX,
  Package,
} from 'lucide-react'
import { usePermisos } from '../../lib/AuthContext'
import { nombreRol } from '../../lib/permisos'
import { useTemaCampo } from '../../lib/temaCampo'
import BotonTema from '../../components/ventas/BotonTema'
import { enlaceMapa, etiquetaIncidencia } from '../../lib/soporte'
import { HORA, faltaPara, hoyISO, tableroDelDia } from '../../lib/campo'
import { supabase } from '../../lib/supabaseClient'
import { largoDeRuta } from '../../lib/ruta.js'
import MapaCampo from '../../components/tecnico/MapaCampo'

/**
 * El tablero del técnico de campo.
 *
 * ── Dos formas, un solo componente ──
 *
 * En el celular es una columna, con los bloques en orden de urgencia. En el
 * escritorio se despliega en la grilla del diseño de referencia: el estado de
 * la red cruzando arriba, tres columnas en el medio, y el detalle abajo.
 *
 * Es el mismo componente en los dos lados —lo dibuja la app de campo y también
 * la pantalla de inicio del escritorio— así que no pueden divergir.
 *
 * ── Por qué arranca en claro ──
 *
 * Porque se usa afuera. Una pantalla oscura al sol del mediodía no se lee, y el
 * técnico no va a buscar un ajuste con la escalera en la otra mano. El botón
 * para cambiarlo está arriba y la elección se guarda por dispositivo: el mismo
 * técnico puede tener el teléfono en claro y la computadora de la oficina en
 * oscuro, que es como realmente se usan.
 */
export default function InicioPage() {
  const { perfil } = usePermisos()
  const { tema, alternar } = useTemaCampo('claro')
  const [d, setD] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  /**
   * La jornada de hoy, aparte del tablero.
   *
   * No sale de `tableroDelDia` porque ese pasa por el caché de campo, pensado
   * para datos que se pueden mostrar viejos un rato. Éste no: decirle "ya
   * iniciaste" a alguien que todavía no inició —o al revés— es el único dato
   * de esta pantalla que hace que alguien NO haga algo que tenía que hacer.
   *
   * Si la consulta falla no se muestra la tarjeta y listo: sin señal el
   * técnico ya sabe que va a tener que marcar después, y un error rojo arriba
   * de todo no le agrega nada.
   */
  const [jornadaHoy, setJornadaHoy] = useState(null)

  const recargar = useCallback(async () => {
    try {
      setD(await tableroDelDia(perfil))
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }

    if (perfil?.tecnico_id) {
      const { data } = await supabase
        .from('v_jornadas')
        .select('id, inicio_at, foto_ingreso')
        .eq('tecnico_id', perfil.tecnico_id)
        .eq('fecha', hoyISO())
        .maybeSingle()
      setJornadaHoy(data ?? null)
    }
  }, [perfil])

  useEffect(() => {
    recargar()
    // Cada dos minutos. La red cambia sola y el técnico no va a tirar para
    // recargar mientras trabaja; más seguido gastaría datos móviles por un dato
    // que no cambia tan rápido.
    const t = setInterval(recargar, 120000)
    return () => clearInterval(t)
  }, [recargar])

  const critica = d?.red?.incidencias?.find((n) => n.estado === 'down') ?? null

  return (
    <div className="campo campo-fondo -m-3 space-y-4 p-3 md:-m-4 md:p-4" data-tema={tema}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="campo-txt text-lg font-semibold">Dashboard Técnico</h1>
          <p className="campo-tenue text-[11px]">
            {new Date().toLocaleDateString('es-EC', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={recargar}
            className="campo-tenue flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px]"
          >
            <RefreshCw size={13} className={cargando ? 'animate-spin' : ''} />
            <span className="hidden sm:inline">Actualizar</span>
          </button>
          <BotonTema tema={tema} onAlternar={alternar} />

          {/* Quién está adentro. No es decoración: estos teléfonos se prestan, y
              ver el nombre propio arriba es lo que evita cargar el trabajo del
              día en la sesión de otro. */}
          <Link to="/campo/perfil" className="flex items-center gap-2 pl-1">
            <div className="hidden text-right sm:block">
              <p className="campo-txt text-[13px] font-medium leading-tight">
                {`${perfil?.nombre ?? ''} ${perfil?.apellido ?? ''}`.trim() || 'Sin nombre'}
              </p>
              <p className="campo-tenue text-[11px] leading-tight">{nombreRol(perfil?.rol)}</p>
            </div>
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sky-600/20 text-[13px] font-semibold text-sky-500">
              {`${perfil?.nombre?.[0] ?? ''}${perfil?.apellido?.[0] ?? ''}`.toUpperCase() || '?'}
            </span>
          </Link>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-[13px] text-rose-400">
          No se pudo cargar y no hay nada guardado de antes. Revisá la señal y tocá actualizar.
        </div>
      )}

      {/* Datos guardados: se dice de cuándo son, siempre.
          Mostrarlos sin la hora sería dejar que el técnico maneje hasta la casa
          equivocada creyendo que ve la ruta de hoy. */}
      {d?.deCache && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-[13px] text-amber-600">
          <CloudOff size={16} className="shrink-0" />
          <span>
            Sin conexión. Estás viendo los datos de{' '}
            <b>
              {d.minutosDeCache < 60
                ? `hace ${d.minutosDeCache} min`
                : `hace ${Math.floor(d.minutosDeCache / 60)} h`}
            </b>
            . Se actualizan solos al volver la señal.
          </span>
        </div>
      )}

      {/* ── Fila 1 · Estado de la red + la incidencia que manda ── */}
      <section className="grid gap-3 xl:grid-cols-5">
        <div className="xl:col-span-3">
          <Titulo>Estado de la red</Titulo>
          <EstadoRed red={d?.red} cargando={cargando} />
        </div>
        <div className="xl:col-span-2">
          <IncidenciaCritica n={critica} cargando={cargando} />
        </div>
      </section>

      {/* La jornada va ANTES que todo lo demás cuando falta algo.
          Hasta ahora sólo se llegaba por Perfil → "Mi jornada y combustible",
          que son tres toques y adentro de donde uno va a cambiar el tema — no
          a empezar el día. Una acción diaria escondida en Ajustes es una
          acción que no se hace. */}
      <AvisoJornada j={jornadaHoy} />

      {/* ── Fila 2 · Novedades · Jornada · Próxima ── */}
      <section className="grid gap-3 lg:grid-cols-3">
        <NovedadesRed novedades={d?.novedades} nuevas={d?.novedadesNuevas ?? 0} desde={d?.desdeUltimoIngreso} />
        <Jornada j={d?.jornada} resumen={d?.resumen} cargando={cargando} />
        <Proxima o={d?.proxima} cargando={cargando} />
      </section>

      {/* ── Fila 3 · Ruta y trabajos recientes ── */}
      <section className="grid gap-3 lg:grid-cols-2">
        <Ruta ruta={d?.ruta ?? []} atrasadas={d?.atrasadas ?? []} cargando={cargando} />
        <Recientes filas={d?.recientes ?? []} cargando={cargando} />
      </section>

      {/* ── Equipos por retirar ──
          Solo aparece si tiene alguno. Un bloque vacío en la pantalla que se
          mira apurado antes de salir es ruido: ocupa el lugar de lo que sí hay
          que hacer hoy. */}
      {(d?.retiros?.length ?? 0) > 0 && (
        <PorRetirar filas={d.retiros} vencidos={d.retirosVencidos ?? 0} />
      )}

      {/* ── El material que se le está acabando ──
          Va acá abajo y no arriba a propósito: no es trabajo del día, es algo
          que resolver de paso por la bodega. Pero sigue estando mientras el
          problema exista, que es lo que una notificación no hace — esa se lee,
          se cierra, y el conector sigue faltando. */}
      {(d?.material?.length ?? 0) > 0 && (
        <MaterialQueFalta filas={d.material} agotados={d.materialAgotado ?? 0} />
      )}

      <AccesosRapidos
        pendientes={d?.jornada?.pendientes ?? 0}
        avisos={d?.notificaciones?.length ?? 0}
        retiros={d?.retiros?.length ?? 0}
      />
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────── */

const Titulo = ({ children }) => (
  <p className="campo-tenue mb-2 text-[11px] font-semibold uppercase tracking-wider">{children}</p>
)

const Panel = ({ children, className = '' }) => (
  <div className={`campo-borde campo-sup rounded-2xl border p-4 ${className}`}>{children}</div>
)

const Hueco = ({ alto = 'h-32' }) => (
  <div className={`campo-borde campo-sup ${alto} animate-pulse rounded-2xl border`} />
)

/* ── Estado de la red ─────────────────────────────────────────────────────── */

const TARJETAS = [
  { clave: 'up', label: 'En línea', pie: 'Operativos', icono: Wifi, color: 'text-emerald-500', fondo: 'bg-emerald-500/15' },
  { clave: 'warning', label: 'En alerta', pie: 'Requieren revisión', icono: AlertTriangle, color: 'text-amber-500', fondo: 'bg-amber-500/15' },
  { clave: 'down', label: 'Caídos', pie: 'Incidencia activa', icono: ShieldAlert, color: 'text-rose-500', fondo: 'bg-rose-500/15' },
  { clave: 'recuperadosHoy', label: 'Recuperados hoy', pie: 'Servicio restablecido', icono: RotateCcw, color: 'text-sky-500', fondo: 'bg-sky-500/15' },
]

function EstadoRed({ red, cargando }) {
  if (cargando && !red) return <Hueco />

  // Sin nodos cargados no se muestra un cero: se calla. Un "0 caídos" en verde
  // diría que la red está perfecta cuando en realidad nadie la está midiendo.
  if (!red || red.total === 0) {
    return (
      <Panel>
        <p className="campo-tenue py-6 text-center text-[13px]">
          No hay equipos monitoreados todavía.
        </p>
      </Panel>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {TARJETAS.map((t) => (
        <div key={t.clave} className="campo-borde campo-sup rounded-2xl border p-3">
          <div className={`grid h-10 w-10 place-items-center rounded-full ${t.fondo}`}>
            <t.icono size={19} className={t.color} />
          </div>
          <p className={`mt-2 text-3xl font-semibold tabular-nums ${t.color}`}>{red[t.clave] ?? 0}</p>
          <p className="campo-txt text-[13px] font-medium">{t.label}</p>
          <p className="campo-tenue text-[11px]">{t.pie}</p>
        </div>
      ))}
    </div>
  )
}

function IncidenciaCritica({ n, cargando }) {
  if (cargando && !n) return <Hueco />

  // Sin incidencia no se dibuja un cartel verde de "todo en orden". Un aviso
  // permanente se vuelve invisible en dos días, y entonces el rojo tampoco se ve.
  if (!n) return null

  return (
    <div className="h-full rounded-2xl border border-rose-500/40 bg-rose-500/[0.07] p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-wide text-rose-500">
          <span className="h-2 w-2 rounded-full bg-rose-500" />
          Incidencia crítica
        </p>
        <RadioTower size={26} className="shrink-0 text-rose-500/70" />
      </div>

      <p className="campo-txt mt-2 text-[17px] font-bold">{n.nombre}</p>
      <p className="campo-suave text-[13px]">
        Sin conexión desde hace {duracion(n.minutos_asi)}
      </p>

      <div className="campo-tenue mt-2 space-y-0.5 text-[12px]">
        {n.desde && (
          <p>
            Última comunicación:{' '}
            {new Date(n.desde).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })}
          </p>
        )}
        {/* El número de afectados es lo que convierte "una torre caída" en algo
            que se prioriza. Sin él, todas las caídas parecen iguales. */}
        <p>Clientes posiblemente afectados: {n.clientes_afectados ?? 0}</p>
        {n.punto && <p>Ubicación: {n.punto}</p>}
      </div>

      <Link
        to={`/campo/red?nodo=${n.id}`}
        className="campo-borde campo-txt mt-3 inline-flex items-center gap-1.5 rounded-lg border bg-white/5 px-3 py-2 text-[12px] font-medium"
      >
        Ver detalle <ArrowRight size={13} />
      </Link>
    </div>
  )
}

/* ── Novedades de red ─────────────────────────────────────────────────────── */

const CLASE = {
  caida: { punto: 'bg-rose-500', texto: 'perdió comunicación' },
  recuperado: { punto: 'bg-emerald-500', texto: 'recuperado' },
  degradado: { punto: 'bg-amber-500', texto: 'presentó alta latencia' },
}

function NovedadesRed({ novedades, nuevas = 0, desde }) {
  return (
    <Panel>
      <div className="mb-2 flex items-baseline justify-between">
        <Titulo>Novedades de red</Titulo>
        <Link to="/campo/red" className="text-[12px] text-sky-500">
          Ver todas
        </Link>
      </div>

      {/* Lo que no había visto, contado arriba.
          El pedido era "desde su último ingreso". Filtrar por eso dejaría la
          sección vacía casi siempre —el acceso se sella en cada carga— así que
          se muestra el historial y se marca lo nuevo, como una bandeja. */}
      {desde && (
        <p className="campo-tenue -mt-1 mb-2 text-[11px]">
          {nuevas > 0 ? (
            <span className="font-medium text-sky-500">
              {nuevas} {nuevas === 1 ? 'novedad nueva' : 'novedades nuevas'} desde tu último
              ingreso
            </span>
          ) : (
            'Sin novedades desde tu último ingreso'
          )}
        </p>
      )}

      {!novedades?.length ? (
        <p className="campo-tenue py-6 text-center text-[13px]">Sin novedades en la red.</p>
      ) : (
        <div className="space-y-0">
          {novedades.slice(0, 4).map((e, i) => {
            const c = CLASE[e.clase] ?? CLASE.degradado
            return (
              <div
                key={`${e.id}-${e.clase}-${i}`}
                className={`campo-borde flex items-center gap-2.5 border-b py-2.5 last:border-0 ${
                  e.nueva ? '' : 'opacity-60'
                }`}
              >
                {/* Las ya vistas se atenúan en vez de esconderse: el técnico
                    igual quiere poder mirar qué pasó anoche. */}
                <span className="campo-tenue shrink-0 text-[12px] tabular-nums">
                  {new Date(e.momento).toLocaleTimeString('es-EC', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span className={`h-2 w-2 shrink-0 rounded-full ${c.punto}`} />
                <span className="campo-txt min-w-0 flex-1 truncate text-[13px]">
                  <b className="font-medium">{e.nodo}</b>{' '}
                  <span className="campo-suave">{c.texto}</span>
                  {e.duracion_min != null && (
                    <span className="campo-tenue"> · {duracion(e.duracion_min)}</span>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </Panel>
  )
}

/* ── Mi jornada ───────────────────────────────────────────────────────────── */

function Jornada({ j, resumen, cargando }) {
  if (cargando && !j) return <Hueco alto="h-48" />
  if (!j) return null

  const cifras = [
    { n: j.pendientes, label: 'Pendientes', color: 'text-sky-500' },
    { n: j.enProceso, label: 'En proceso', color: 'text-amber-500' },
    { n: j.hechas, label: 'Completadas', color: 'text-emerald-500' },
    { n: j.reagendadas, label: 'Reagendada', color: 'campo-suave' },
  ]

  return (
    <Panel>
      <Titulo>Mi jornada</Titulo>

      <div className="grid grid-cols-4 gap-2">
        {cifras.map((c) => (
          <div key={c.label} className="campo-borde rounded-xl border py-3 text-center">
            <p className={`text-2xl font-semibold tabular-nums ${c.color}`}>{c.n}</p>
            <p className="campo-tenue text-[10px]">{c.label}</p>
          </div>
        ))}
      </div>

      <div className="campo-borde mt-3 flex items-start gap-2.5 rounded-xl border bg-sky-500/[0.06] p-3">
        <ClipboardList size={17} className="mt-0.5 shrink-0 text-sky-500" />
        <p className="campo-suave text-[12px]">
          {j.total === 0
            ? 'No tenés trabajos agendados para hoy.'
            : `Tenés ${j.total} ${j.total === 1 ? 'orden asignada' : 'órdenes asignadas'} para hoy.`}
          {j.atrasadas > 0 && (
            <>
              {' '}
              <Link to="/campo/ordenes" className="font-medium text-amber-500">
                Y {j.atrasadas} de días anteriores.
              </Link>
            </>
          )}
        </p>
      </div>

      {/* El resumen del día. Sin "distancia recorrida": ver el comentario en
          `resumenDelDia` — este sistema toma coordenadas puntuales, no un
          recorrido, y un kilometraje inventado que se ve exacto es peor que
          no mostrarlo. */}
      {resumen?.inicio && (
        <div className="campo-borde mt-3 grid grid-cols-2 gap-2 border-t pt-3 text-[12px]">
          <div>
            <p className="campo-tenue text-[10px] uppercase tracking-wide">Inicio de jornada</p>
            <p className="campo-txt font-medium">
              {new Date(resumen.inicio).toLocaleTimeString('es-EC', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          </div>
          <div>
            <p className="campo-tenue text-[10px] uppercase tracking-wide">En jornada</p>
            <p className="campo-txt font-medium">{duracion(resumen.minutosDesdeInicio)}</p>
          </div>
        </div>
      )}
    </Panel>
  )
}

/* ── Próxima instalación ──────────────────────────────────────────────────── */

function Proxima({ o, cargando }) {
  if (cargando && !o) return <Hueco alto="h-48" />

  if (!o) {
    return (
      <Panel>
        <Titulo>Próxima instalación</Titulo>
        <p className="campo-tenue py-8 text-center text-[13px]">
          No queda nada agendado para hoy.
        </p>
      </Panel>
    )
  }

  const falta = faltaPara(o)

  return (
    <Panel>
      <Titulo>Próxima {o.tipo === 'nueva' ? 'instalación' : 'visita'}</Titulo>

      {/* El mapa arriba: lo primero que se mira antes de salir es dónde queda.
          Si no hay coordenadas o no hay señal, la tarjeta lo dice en vez de
          dejar un rectángulo roto — y los datos de abajo siguen sirviendo. */}
      <MapaCampo
        alto="h-32"
        puntos={[{ lat: o.latitud, lng: o.longitud, titulo: o.cliente ?? o.nombre, estado: o.estado }]}
      />

      {o.hora && (
        <p className="campo-txt mt-3 flex items-center gap-1.5 text-[15px] font-semibold">
          <Clock size={15} className="campo-tenue" /> {HORA(o.hora)}
        </p>
      )}
      <p className="campo-txt mt-1 text-[17px] font-bold">{o.cliente ?? o.nombre}</p>
      {o.numero && <p className="campo-tenue text-[11px]">Orden #{o.numero}</p>}
      <p className="campo-suave mt-0.5 flex items-start gap-1.5 text-[13px]">
        <MapPin size={14} className="campo-tenue mt-0.5 shrink-0" />
        <span>{o.direccion ?? 'sin dirección cargada'}</span>
      </p>
      {(o.plan || o.tecnologia) && (
        <p className="campo-suave mt-1 text-[13px]">
          {[o.plan, o.tecnologia?.toUpperCase()].filter(Boolean).join(' · ')}
        </p>
      )}

      {/* El estado del expediente: si el contrato está firmado y si la
          documentación está completa.

          Va acá y no en el paso de cierre porque es lo que decide si el viaje
          sirve: llegar y descubrir que falta la cédula del titular es volver
          otro día. */}
      {(o.contrato_firmado || o.documentos_completos) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {o.contrato_firmado && <Etiqueta tono="verde">Contrato firmado</Etiqueta>}
          {o.documentos_completos && <Etiqueta tono="azul">Documentos completos</Etiqueta>}
        </div>
      )}

      {/* Qué le falta a esta orden, ANTES de manejar hasta el domicilio. */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {falta.length === 0 ? (
          <Etiqueta tono="verde">Lista para cerrar</Etiqueta>
        ) : (
          falta.slice(0, 3).map((f) => (
            <Etiqueta key={f} tono="ambar">
              Falta {f}
            </Etiqueta>
          ))
        )}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <Boton href={o.telefono ? `tel:${o.telefono}` : null} icono={Phone}>
          Llamar
        </Boton>
        <Boton href={enlaceMapa(o)} icono={MapPin} externo>
          Ubicación
        </Boton>
        <Link
          to={`/instalaciones/${o.id}/alta`}
          className="flex items-center justify-center gap-1.5 rounded-xl bg-sky-600 py-2.5 text-[13px] font-semibold text-white"
        >
          Iniciar <PlayCircle size={15} />
        </Link>
      </div>
    </Panel>
  )
}

const Boton = ({ href, icono: Icono, externo, children }) => (
  <a
    href={href ?? undefined}
    target={externo ? '_blank' : undefined}
    rel={externo ? 'noreferrer' : undefined}
    className={`campo-borde campo-txt flex items-center justify-center gap-1.5 rounded-xl border py-2.5 text-[13px] font-medium ${
      href ? '' : 'pointer-events-none opacity-40'
    }`}
  >
    <Icono size={15} /> {children}
  </a>
)

const Etiqueta = ({ tono, children }) => (
  <span
    className={`rounded-md px-2 py-0.5 text-[11px] ${
      tono === 'verde'
        ? 'bg-emerald-500/15 text-emerald-600'
        : tono === 'azul'
          ? 'bg-sky-500/15 text-sky-600'
          : 'bg-amber-500/15 text-amber-600'
    }`}
  >
    {children}
  </span>
)

/* ── Mi ruta de hoy ───────────────────────────────────────────────────────── */

const PASO_RUTA = {
  agendada: { label: 'Pendiente', chip: 'campo-suave campo-borde border' },
  en_ruta: { label: 'En camino', chip: 'bg-sky-500/15 text-sky-600' },
  en_curso: { label: 'En proceso', chip: 'bg-amber-500/15 text-amber-600' },
  hecha: { label: 'Finalizada', chip: 'bg-emerald-500/15 text-emerald-600' },
  reprogramada: { label: 'Reagendada', chip: 'bg-violet-500/15 text-violet-600' },
  no_realizada: { label: 'No realizada', chip: 'bg-rose-500/15 text-rose-600' },
  cancelada: { label: 'Cancelada', chip: 'campo-tenue campo-borde border' },
}

function Ruta({ ruta, atrasadas, cargando }) {
  if (cargando && !ruta.length) return <Hueco alto="h-48" />
  const lista = [...ruta, ...atrasadas]

  return (
    <Panel>
      <div className="mb-2 flex items-baseline justify-between">
        <Titulo>Mi ruta de hoy</Titulo>
        <Link to="/campo/ordenes" className="text-[12px] text-sky-500">
          Ver todas
        </Link>
      </div>

      {!lista.length ? (
        <p className="campo-tenue py-8 text-center text-[13px]">Sin paradas para hoy.</p>
      ) : (
        <div className="space-y-2">
          <LargoDeRuta lista={lista} />

          {/* Las paradas numeradas y unidas en el orden en que se recorren. No
              es la ruta por calles —para eso está el botón que abre el
              navegador del teléfono— sino el orden de visita. */}
          <MapaCampo
            alto="h-40"
            conRuta
            puntos={lista.map((o) => ({
              lat: o.latitud,
              lng: o.longitud,
              titulo: o.cliente ?? o.nombre,
              estado: o.estado,
            }))}
          />
          {lista.map((o, i) => {
            const e = PASO_RUTA[o.estado] ?? PASO_RUTA.agendada
            const hecha = o.estado === 'hecha'
            return (
              <Link
                key={o.id}
                to={`/instalaciones/${o.id}/alta`}
                className="campo-borde flex items-center gap-3 rounded-xl border p-2.5"
              >
                <span
                  className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[12px] font-semibold ${
                    hecha ? 'bg-emerald-500/15 text-emerald-600' : 'bg-sky-500/15 text-sky-600'
                  }`}
                >
                  {hecha ? <CheckCircle2 size={16} /> : i + 1}
                </span>
                <span className="campo-tenue shrink-0 text-[12px] tabular-nums">
                  {HORA(o.hora) ?? '—'}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-[13px] ${
                      hecha ? 'campo-tenue line-through' : 'campo-txt font-medium'
                    }`}
                  >
                    {o.cliente ?? o.nombre}
                  </span>
                  <span className="campo-tenue block truncate text-[11px]">
                    {o.sector ?? o.direccion ?? ''}
                  </span>
                </span>
                {/* Palabra y color, no solo color: al sol, y para quien no
                    distingue bien el verde del ámbar, dos puntitos son el mismo
                    puntito. */}
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${e.chip}`}>
                  {e.label}
                </span>
              </Link>
            )
          })}
        </div>
      )}
    </Panel>
  )
}

/* ── Trabajos recientes ───────────────────────────────────────────────────── */

function Recientes({ filas, cargando }) {
  if (cargando && !filas.length) return <Hueco alto="h-48" />

  return (
    <Panel>
      <div className="mb-2 flex items-baseline justify-between">
        <Titulo>Trabajos recientes</Titulo>
        <Link to="/campo/ordenes" className="text-[12px] text-sky-500">
          Ver todas
        </Link>
      </div>

      {!filas.length ? (
        <p className="campo-tenue py-8 text-center text-[13px]">Todavía no hay trabajos.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12px]">
            <thead className="campo-tenue text-[10px] uppercase tracking-wide">
              <tr>
                <th className="pb-2 pr-3 font-medium">Orden</th>
                <th className="pb-2 pr-3 font-medium">Cliente</th>
                <th className="pb-2 pr-3 font-medium">Tipo</th>
                <th className="pb-2 pr-3 font-medium">Hora</th>
                <th className="pb-2 pr-3 font-medium">Estado</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {filas.map((f) => {
                const e = PASO_RUTA[f.estado] ?? {
                  label: f.estado,
                  chip: 'campo-suave campo-borde border',
                }
                return (
                  <tr key={`${f.tipo}-${f.id}`} className="campo-borde border-t">
                    <td className="campo-tenue py-2 pr-3 font-mono text-[11px]">
                      {f.numero ? `#${f.numero}` : '—'}
                    </td>
                    <td className="campo-txt max-w-[10rem] truncate py-2 pr-3 font-medium">
                      {f.cliente ?? '—'}
                    </td>
                    <td className="campo-suave py-2 pr-3">{f.tipo}</td>
                    <td className="campo-tenue py-2 pr-3 tabular-nums">
                      {HORA(f.hora) ??
                        new Date(f.cuando).toLocaleDateString('es-EC', {
                          day: '2-digit',
                          month: 'short',
                        })}
                    </td>
                    <td className="py-2 pr-3">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] ${e.chip}`}>
                        {e.label}
                      </span>
                    </td>
                    <td className="py-2 text-right">
                      <Link to={f.a} className="text-[12px] text-sky-500">
                        Abrir
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

/* ── Accesos rápidos ──────────────────────────────────────────────────────── */

/**
 * Los equipos que hay que ir a buscar.
 *
 * ── Por qué las citas vencidas van primero y en rojo ──
 *
 * Porque son la razón por la que este bloque existe. El abonado dijo "pasá el
 * jueves a las tres", nadie fue, y sin nada que lo muestre esa orden se pierde
 * entre las otras hasta que el equipo ya no se recupera. Es la diferencia entre
 * una lista y un recordatorio.
 */
function PorRetirar({ filas, vencidos }) {
  const hora = (f) => {
    if (!f) return null
    const d = new Date(f)
    return Number.isNaN(d.getTime())
      ? null
      : d.toLocaleString('es-EC', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  return (
    <section className="t-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <PackageX size={16} className="text-amber-400" />
          Equipos por retirar
          <span className="text-xs font-normal text-slate-500">{filas.length}</span>
        </h2>
        {vencidos > 0 && (
          <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-300">
            {vencidos} con la hora pasada
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        {filas.slice(0, 4).map((r) => {
          const cuando = hora(r.agendado_para)
          const vencida = r.agendado_para && new Date(r.agendado_para) < new Date()
          return (
            <Link
              key={r.id}
              to="/campo/retiros"
              className="block t-panel px-3 py-2 transition hover:border-slate-700"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm text-slate-200">{r.cliente}</span>
                {cuando && (
                  <span className={`shrink-0 text-[11px] ${vencida ? 'text-red-400' : 'text-sky-400'}`}>
                    {cuando}
                  </span>
                )}
              </div>
              <div className="truncate text-[11px] text-slate-500">
                {[r.zona, r.direccion, r.serie].filter(Boolean).join(' · ')}
              </div>
            </Link>
          )
        })}
      </div>

      {filas.length > 4 && (
        <Link to="/campo/retiros" className="mt-2 block text-[12px] text-sky-500">
          Ver los {filas.length} →
        </Link>
      )}
    </section>
  )
}

/* ── Accesos rápidos ──────────────────────────────────────────────────────── */

/**
 * Lo que hay que pedir en bodega antes de salir.
 *
 * ── Por qué el número que se muestra es cuánto pedir y no cuánto queda ──
 *
 * Porque "te quedan 2 conectores" obliga a hacer una cuenta —¿cuántos necesito
 * para hoy?, ¿cuántos me daban antes?— parado en la puerta de la bodega. "Pedí
 * 20" se puede ejecutar sin pensar, que es lo único que se hace bien a las siete
 * de la mañana.
 */
function MaterialQueFalta({ filas, agotados }) {
  return (
    <section className="campo-tarjeta rounded-xl p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Titulo>
          <Package size={14} className="mr-1.5 inline" />
          Material por pedir
        </Titulo>
        {agotados > 0 && (
          <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] text-rose-500">
            {agotados} sin nada
          </span>
        )}
      </div>

      <ul className="space-y-1.5">
        {filas.map((m) => (
          <li key={m.articulo} className="flex items-center justify-between gap-2 text-[13px]">
            <span className="campo-txt min-w-0 truncate">
              {m.articulo}
              <span className="campo-tenue ml-1.5 text-[11px]">
                {m.agotado ? 'no te queda ninguno' : `te quedan ${m.cantidad} ${m.unidad}`}
              </span>
            </span>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[12px] tabular-nums ${
                m.agotado ? 'bg-rose-500/15 text-rose-500' : 'bg-amber-500/15 text-amber-600'
              }`}
            >
              pedir {m.sugerido}
            </span>
          </li>
        ))}
      </ul>

      <Link to="/inventario/mi-almacen" className="mt-2 block text-[12px] text-sky-500">
        Ver mi almacén
      </Link>
    </section>
  )
}

function AccesosRapidos({ pendientes, avisos, retiros }) {
  const items = [
    { to: '/campo/ordenes', label: 'Órdenes asignadas', icono: ClipboardList, n: pendientes },
    { to: '/campo/retiros', label: 'Equipos por retirar', icono: PackageX, n: retiros },
    { to: '/campo/entregar', label: 'Entregar a oficina', icono: Boxes },
    { to: '/campo/soporte', label: 'Soporte', icono: Activity },
    { to: '/campo/inventario', label: 'Materiales', icono: Boxes },
    { to: '/campo/red', label: 'Monitoreo de red', icono: RadioTower, nota: 'Solo lectura' },
    { to: '/campo/avisos', label: 'Notificaciones', icono: Bell, n: avisos },
    { to: '/campo/desempeno', label: 'Mi desempeño', icono: BarChart3 },
  ]

  return (
    <section>
      <Titulo>Accesos rápidos</Titulo>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {items.map((i) => (
          <Link
            key={i.to}
            to={i.to}
            className="campo-borde campo-sup relative flex flex-col items-center gap-2 rounded-2xl border p-4"
          >
            <i.icono size={22} className="campo-suave" />
            <span className="campo-txt text-center text-[12px] font-medium">{i.label}</span>
            {i.nota && (
              <span className="campo-tenue rounded bg-black/5 px-1.5 text-[9px] uppercase tracking-wide">
                {i.nota}
              </span>
            )}
            {i.n > 0 && (
              <span className="absolute right-2 top-2 grid h-5 min-w-5 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
                {i.n}
              </span>
            )}
          </Link>
        ))}
      </div>
    </section>
  )
}

/** "3h 27m". Sin segundos: a nadie le sirven acá. */
function duracion(minutos) {
  if (minutos == null) return '—'
  // Un negativo significa que el reloj del servidor y el del evento no
  // coinciden —o que alguien cargó una fecha futura—. "hace -5h" no le dice
  // nada a nadie; "recién" es lo más cercano a la verdad que se puede afirmar.
  if (minutos < 0) return 'recién'
  if (minutos < 60) return `${minutos} min`
  const h = Math.floor(minutos / 60)
  const m = minutos % 60
  if (h < 48) return m ? `${h}h ${m}m` : `${h}h`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/* ── Falta iniciar la jornada, o falta su foto ─────────────────────────────── */

/**
 * Solo aparece cuando hay algo que hacer.
 *
 * Con la jornada abierta y su foto subida no se dibuja nada: un cartel verde
 * de "todo en orden" arriba de la pantalla se vuelve parte del fondo en dos
 * días, y el día que diga otra cosa tampoco se va a leer.
 */
function AvisoJornada({ j }) {
  if (j?.inicio_at && j?.foto_ingreso) return null

  const sinIniciar = !j?.inicio_at
  const texto = sinIniciar
    ? {
        titulo: 'Todavía no iniciaste tu jornada',
        sub: 'Registrá el vehículo, el kilometraje y tu foto de ingreso.',
        accion: 'Iniciar',
      }
    : {
        titulo: 'Falta tu foto de ingreso',
        sub: 'La jornada está abierta. Subí la foto cuando tengas señal.',
        accion: 'Subir',
      }

  return (
    <Link
      to="/campo/jornada"
      className={`campo-borde flex items-center gap-3 rounded-2xl border p-4 ${
        sinIniciar ? 'bg-sky-500/[0.08]' : 'bg-amber-500/[0.08]'
      }`}
    >
      <span
        className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${
          sinIniciar ? 'bg-sky-500/15 text-sky-500' : 'bg-amber-500/15 text-amber-500'
        }`}
      >
        {sinIniciar ? <PlayCircle size={22} /> : <Camera size={22} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="campo-txt block text-[14px] font-semibold">{texto.titulo}</span>
        <span className="campo-suave mt-0.5 block text-[12px] leading-snug">{texto.sub}</span>
      </span>
      <span
        className={`shrink-0 rounded-lg px-3 py-1.5 text-[12px] font-semibold text-white ${
          sinIniciar ? 'bg-sky-600' : 'bg-amber-600'
        }`}
      >
        {texto.accion}
      </span>
    </Link>
  )
}

/**
 * Cuánto da el recorrido del día, y con qué honestidad.
 *
 * ── Por qué dice "en línea recta" y no lo esconde ──
 *
 * Porque el número va a estar siempre por debajo del real: no conoce las
 * calles, los sentidos únicos ni el río. Un técnico que lee "8 km" y maneja 14
 * deja de creerle a la pantalla — y con razón. Diciendo de dónde sale, el
 * número sigue sirviendo para lo único que sirve: comparar un día contra otro.
 *
 * ── Y por qué avisa cuando faltan coordenadas ──
 *
 * Sumar solo los tramos medibles y presentarlo como el total del día es la
 * forma silenciosa de mentir. Si de seis paradas solo tres se pudieron medir,
 * eso se dice.
 */
function LargoDeRuta({ lista }) {
  const { metros, tramosMedidos } = largoDeRuta(lista)
  if (!tramosMedidos) return null

  const sinUbicar = lista.filter((o) => o.latitud == null || o.longitud == null).length

  return (
    <p className="campo-tenue mb-2 text-[11px] leading-snug">
      <b className="campo-suave">
        {metros >= 1000 ? `${(metros / 1000).toFixed(1)} km` : `${metros} m`}
      </b>{' '}
      en línea recta entre las paradas, en este orden.
      {sinUbicar > 0 && (
        <>
          {' '}
          {sinUbicar === 1
            ? 'Una parada sin ubicación quedó afuera de la cuenta.'
            : `${sinUbicar} paradas sin ubicación quedaron afuera de la cuenta.`}
        </>
      )}
    </p>
  )
}
