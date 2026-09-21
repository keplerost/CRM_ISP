import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Activity, ArrowLeft, MapPin, Users, Wifi, WifiOff } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'

/**
 * El estado de la red, completo — y de solo lectura.
 *
 * ── Qué NO tiene esta pantalla, y es lo importante ──
 *
 * Ni un botón que toque un equipo. No hay reiniciar, no hay sondear, no hay
 * configurar. Y no es que estén escondidos: los datos vienen de `v_estado_red`,
 * que no trae la IP ni el router ni la comunidad SNMP, y el middleware rechaza
 * cualquier acción de red sin el permiso correspondiente.
 *
 * Ocultar el botón habría sido lo fácil. Cualquiera que abra la consola del
 * navegador encuentra en un minuto lo que la pantalla no muestra; lo que no
 * puede encontrar es lo que el servidor no le manda.
 *
 * ── Para qué le sirve al técnico ──
 *
 * Para una sola pregunta, y vale la pantalla entera: ¿el problema de este
 * cliente es del domicilio o es de la zona? Si la torre está caída, no hay nada
 * que revisar en la casa.
 */

const FILTROS = [
  { clave: 'todos', label: 'Todos', tipos: null },
  { clave: 'torres', label: 'Torres', tipos: ['rb_torre', 'ptmp'] },
  { clave: 'olt', label: 'OLT', tipos: ['olt'] },
  { clave: 'enlaces', label: 'Enlaces', tipos: ['ptp'] },
  { clave: 'otros', label: 'Otros', tipos: ['switch', 'energia', 'otro'] },
]

const TONO = {
  up: { punto: 'bg-emerald-500', texto: 'text-emerald-400', label: 'Operativo' },
  warning: { punto: 'bg-amber-500', texto: 'text-amber-400', label: 'Degradado' },
  down: { punto: 'bg-rose-500', texto: 'text-rose-400', label: 'Sin conexión' },
  desconocido: { punto: 'bg-slate-600', texto: 'text-slate-500', label: 'Sin datos' },
}

export default function RedPage() {
  const [params, setParams] = useSearchParams()
  const [nodos, setNodos] = useState([])
  const [novedades, setNovedades] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [filtro, setFiltro] = useState('todos')

  // El nodo abierto viaja en la URL: así el enlace del dashboard —"ver esta
  // incidencia"— abre directamente en ella, y el botón de atrás del teléfono
  // vuelve a la lista en vez de salir de la pantalla.
  const abierto = params.get('nodo')

  const recargar = useCallback(async () => {
    const [r, n] = await Promise.all([
      supabase.from('v_estado_red').select('*').order('estado').order('nombre'),
      supabase.from('v_novedades_red').select('*').order('momento', { ascending: false }).limit(30),
    ])
    setError(r.error ?? null)
    setNodos(r.data ?? [])
    setNovedades(n.data ?? [])
    setCargando(false)
  }, [])

  useEffect(() => {
    recargar()
    const t = setInterval(recargar, 120000)
    return () => clearInterval(t)
  }, [recargar])

  const visibles = useMemo(() => {
    const f = FILTROS.find((x) => x.clave === filtro)
    const lista = f?.tipos ? nodos.filter((n) => f.tipos.includes(n.tipo)) : nodos
    // Lo que anda mal, arriba. Es el orden en que se mira esta pantalla.
    const peso = { down: 0, warning: 1, desconocido: 2, up: 3 }
    return [...lista].sort((a, b) => peso[a.estado] - peso[b.estado] || a.nombre.localeCompare(b.nombre))
  }, [nodos, filtro])

  const nodo = nodos.find((n) => n.id === abierto)

  if (cargando) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl bg-slate-900/60" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-center">
        <p className="text-[14px] text-rose-200">No se pudo leer el estado de la red.</p>
        <p className="mt-1 font-mono text-[11px] text-rose-300/70">{error.message}</p>
      </div>
    )
  }

  if (!nodos.length) {
    return (
      <div className="py-16 text-center">
        <Wifi size={28} className="mx-auto mb-2 text-slate-700" />
        <p className="text-slate-400">No hay equipos monitoreados.</p>
        <p className="mt-1 text-[12px] text-slate-600">
          Cuando la oficina cargue los nodos de red, aparecen acá.
        </p>
      </div>
    )
  }

  /* ── El detalle de un equipo ── */
  if (nodo) {
    return <Detalle nodo={nodo} novedades={novedades} onVolver={() => setParams({})} />
  }

  const up = nodos.filter((n) => n.estado === 'up').length
  const warn = nodos.filter((n) => n.estado === 'warning').length
  const down = nodos.filter((n) => n.estado === 'down').length

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Cifra n={up} label="en línea" color="text-emerald-400" />
        <Cifra n={warn} label="en alerta" color="text-amber-400" />
        <Cifra n={down} label="caídos" color="text-rose-400" />
      </div>

      {/* Los filtros se desplazan al costado en vez de envolverse: cinco chips
          en dos renglones desperdician el alto, que en un teléfono es lo caro. */}
      <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1">
        {FILTROS.map((f) => {
          const n = f.tipos ? nodos.filter((x) => f.tipos.includes(x.tipo)).length : nodos.length
          if (n === 0 && f.tipos) return null
          return (
            <button
              key={f.clave}
              type="button"
              onClick={() => setFiltro(f.clave)}
              className={`shrink-0 rounded-full border px-3 py-1.5 text-[12px] ${
                filtro === f.clave
                  ? 'border-slate-500 bg-slate-800 text-slate-100'
                  : 'border-slate-800 text-slate-400'
              }`}
            >
              {f.label} <span className="text-slate-500">{n}</span>
            </button>
          )
        })}
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        {visibles.map((n) => (
          <Fila key={n.id} n={n} onAbrir={() => setParams({ nodo: n.id })} />
        ))}
      </div>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────── */

const Cifra = ({ n, label, color }) => (
  <div className="t-card py-3 text-center">
    <p className={`text-2xl font-semibold tabular-nums ${color}`}>{n}</p>
    <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
  </div>
)

function Fila({ n, onAbrir }) {
  const t = TONO[n.estado] ?? TONO.desconocido
  return (
    <button
      type="button"
      onClick={onAbrir}
      className="w-full t-card p-3 text-left active:bg-slate-800"
    >
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${t.punto}`} />
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-slate-100">
          {n.nombre}
        </span>
        <span className={`shrink-0 text-[11px] ${t.texto}`}>{t.label}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 pl-4.5 text-[11px] text-slate-500">
        {n.estado === 'up' && n.latencia_ms != null && <span>Ping {n.latencia_ms} ms</span>}
        {n.estado !== 'up' && n.minutos_asi != null && <span>Hace {duracion(n.minutos_asi)}</span>}
        {n.perdida_pct > 0 && <span>Pérdida {n.perdida_pct}%</span>}
        {n.clientes_afectados > 0 && n.estado !== 'up' && (
          <span className="text-slate-300">{n.clientes_afectados} clientes</span>
        )}
        {n.por_el_padre && <span>por {n.depende_de}</span>}
      </div>
    </button>
  )
}

function Detalle({ nodo, novedades, onVolver }) {
  const t = TONO[nodo.estado] ?? TONO.desconocido
  const suyas = novedades.filter((e) => e.nodo_id === nodo.id)

  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <button
        type="button"
        onClick={onVolver}
        className="flex items-center gap-1.5 text-[13px] text-slate-400 active:text-slate-200"
      >
        <ArrowLeft size={16} /> Estado de la red
      </button>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex items-center gap-2.5">
          {nodo.estado === 'up' ? (
            <Wifi size={20} className={t.texto} />
          ) : (
            <WifiOff size={20} className={t.texto} />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[17px] font-semibold text-slate-100">{nodo.nombre}</p>
            <p className={`text-[12px] ${t.texto}`}>{t.label}</p>
          </div>
        </div>

        <div className="mt-3 space-y-1.5 text-[13px]">
          <Dato label="Tipo" valor={TIPO[nodo.tipo] ?? nodo.tipo} />
          {nodo.punto && <Dato label="Ubicación" valor={nodo.punto} icono={MapPin} />}
          {nodo.estado !== 'up' && nodo.minutos_asi != null && (
            <Dato label="Así desde hace" valor={duracion(nodo.minutos_asi)} />
          )}
          {nodo.desde && (
            <Dato
              label={nodo.estado === 'up' ? 'Operativo desde' : 'Última respuesta'}
              valor={new Date(nodo.desde).toLocaleString('es-EC', {
                day: '2-digit',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
            />
          )}
          {nodo.latencia_ms != null && <Dato label="Ping" valor={`${nodo.latencia_ms} ms`} />}
          {nodo.perdida_pct != null && nodo.perdida_pct > 0 && (
            <Dato label="Pérdida de paquetes" valor={`${nodo.perdida_pct} %`} />
          )}
          {nodo.clientes_afectados > 0 && (
            <Dato
              label="Clientes que dependen"
              valor={String(nodo.clientes_afectados)}
              icono={Users}
            />
          )}
          {nodo.hijos > 0 && <Dato label="Equipos que cuelgan" valor={String(nodo.hijos)} />}
          {nodo.depende_de && <Dato label="Depende de" valor={nodo.depende_de} />}
        </div>

        {/* Cuando la caída es consecuencia de otra, decirlo es lo que evita que
            el técnico salga a revisar el equipo equivocado. */}
        {nodo.por_el_padre && (
          <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-[12px] text-amber-200">
            Este equipo está caído porque <b>{nodo.depende_de}</b> no responde. Arreglar esto
            empieza por ahí.
          </p>
        )}

        {/* Ni IP, ni credenciales, ni un botón de configuración. Ver el
            comentario de arriba del archivo: no es que estén ocultos, es que no
            llegan al navegador. */}
        <p className="mt-3 border-t border-slate-800 pt-2 text-[11px] text-slate-600">
          Solo consulta. Para operar este equipo, avisá a la oficina.
        </p>
      </section>

      {suyas.length > 0 && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-3">
          <p className="mb-2 flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <Activity size={12} /> Historial reciente
          </p>
          <div className="space-y-1.5">
            {suyas.map((e, i) => (
              <div key={`${e.id}-${e.clase}-${i}`} className="flex gap-2 text-[12px]">
                <span className="shrink-0 tabular-nums text-slate-500">
                  {new Date(e.momento).toLocaleString('es-EC', {
                    day: '2-digit',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span className="text-slate-300">
                  {e.clase === 'caida'
                    ? 'perdió comunicación'
                    : e.clase === 'recuperado'
                      ? 'recuperado'
                      : 'degradado'}
                  {e.duracion_min != null && (
                    <span className="text-slate-500"> · duró {duracion(e.duracion_min)}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

const Dato = ({ label, valor, icono: Icono }) => (
  <div className="flex items-center gap-2 t-panel px-3 py-2">
    {Icono && <Icono size={13} className="shrink-0 text-slate-600" />}
    <span className="text-slate-500">{label}</span>
    <span className="ml-auto text-right text-slate-200">{valor}</span>
  </div>
)

const TIPO = {
  rb_torre: 'Torre',
  ptmp: 'Antena sectorial',
  ptp: 'Radioenlace',
  olt: 'OLT',
  switch: 'Switch',
  energia: 'Energía',
  otro: 'Otro',
}

/** "3h 27m". Sin segundos y sin días sueltos: es lo que se dice en voz alta. */
function duracion(minutos) {
  if (minutos == null) return '—'
  // Un negativo significa que el reloj del servidor y el del evento no
  // coinciden —o que alguien cargó una fecha futura—. "hace -5h" no le dice
  // nada a nadie; "recién" es lo más cercano a la verdad que se puede afirmar.
  if (minutos < 0) return 'recién'
  if (minutos < 60) return `${minutos}m`
  const h = Math.floor(minutos / 60)
  const m = minutos % 60
  if (h < 48) return m ? `${h}h ${m}m` : `${h}h`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}
