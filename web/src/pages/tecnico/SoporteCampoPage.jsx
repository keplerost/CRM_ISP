import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, MapPin, Navigation, Ticket } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { ESTADOS, PRIORIDADES, enlaceMapa, etiquetaIncidencia } from '../../lib/soporte'
import { conCache } from '../../lib/cacheLocal'
import { usePermisos } from '../../lib/AuthContext'

/**
 * Los tickets del técnico, en formato de campo.
 *
 * ── Por qué no se reutiliza `SoportePage` ──
 *
 * Se evaluó. `SoportePage` es una bandeja con filtros por estado, prioridad,
 * técnico y fecha, pensada para quien reparte el trabajo: necesita comparar y
 * decidir a quién le toca qué.
 *
 * El técnico no reparte nada. Ya sabe cuáles son suyos —RLS no le muestra
 * otros— y lo único que decide es a cuál va primero. Los filtros no le sirven y
 * le ocupan la mitad de una pantalla que ya es chica.
 *
 * La ficha del ticket sí se reutiliza: es la misma pantalla y ahí sí hace
 * exactamente lo mismo que cualquiera.
 */

/**
 * Los tres grupos, y por qué no son los tres nombres obvios.
 *
 * Lo natural sería "Asignados / Sin resolver / Resueltos". No funciona: "sin
 * resolver" INCLUYE a los asignados —también a los que van en camino y a los
 * que se están trabajando— así que un ticket recién asignado aparecería en dos
 * pestañas a la vez. Eso es la misma mezcla que se venía a arreglar, con más
 * pasos.
 *
 * Los tres grupos de acá no se pisan, y el corte es el que el técnico hace en
 * la cabeza: lo que todavía no arrancó, lo que tiene entre manos, y lo que ya
 * terminó.
 */
const GRUPOS = [
  {
    clave: 'asignados',
    label: 'Asignados',
    ayuda: 'Te los asignaron y todavía no saliste.',
    estados: ['asignado'],
    tono: 'text-sky-300',
  },
  {
    clave: 'curso',
    label: 'En curso',
    ayuda: 'Ya saliste o estás trabajando en el lugar.',
    estados: ['en_ruta', 'en_proceso'],
    tono: 'text-amber-300',
  },
  {
    clave: 'cerrados',
    label: 'Cerrados',
    ayuda: 'Resueltos y cancelados.',
    estados: ['resuelto', 'cancelado'],
    tono: 'text-emerald-300',
  },
]

export default function SoporteCampoPage() {
  const { perfil } = usePermisos()
  const [tickets, setTickets] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState(null)
  const [deCache, setDeCache] = useState(null)

  const recargar = useCallback(async () => {
    // Sin filtro por técnico: RLS ya devuelve solo los suyos. Ver el comentario
    // de OrdenesPage — la seguridad no vive en la pantalla.
    try {
      const r = await conCache(`tickets:${perfil?.id ?? 'anonimo'}`, async () => {
        const { data, error: err } = await supabase
          .from('tickets')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(60)
        // El error se propaga. La primera versión lo descartaba y ordenaba por
        // una columna inexistente: la consulta fallaba entera y la pantalla
        // decía "no tenés tickets asignados" con el ticket ahí, asignado. Un
        // error que se ve como un hecho es peor que un error.
        if (err) throw err
        return data ?? []
      })
      setTickets(r.datos)
      setDeCache(r.deCache ? r.minutos : null)
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [perfil?.id])

  useEffect(() => {
    recargar()
  }, [recargar])

  const porGrupo = Object.fromEntries(
    GRUPOS.map((g) => [g.clave, tickets.filter((t) => g.estados.includes(t.estado))]),
  )

  /**
   * Qué pestaña abre.
   *
   * La primera que tenga algo, en orden de urgencia: lo que está en curso
   * primero —si el técnico dejó un trabajo a medias, eso es lo que busca—,
   * después lo asignado, y recién al final los cerrados.
   *
   * Abrir siempre en "Asignados" sería más previsible, y le mostraría una lista
   * vacía justo al que está en medio de una reparación.
   *
   * Se calcula, no se guarda en estado, hasta que el técnico elige: así la
   * pestaña sigue al trabajo mientras él no opine, y deja de moverse en cuanto
   * opina.
   */
  const activa =
    tab ?? GRUPOS.find((g) => porGrupo[g.clave]?.length)?.clave ?? 'asignados'
  const grupo = GRUPOS.find((g) => g.clave === activa)
  const lista = porGrupo[activa] ?? []

  if (cargando) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl bg-slate-900/60" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-center">
        <p className="text-[14px] text-rose-200">No se pudieron cargar los tickets.</p>
        <p className="mt-1 font-mono text-[11px] text-rose-300/70">{error.message}</p>
      </div>
    )
  }

  if (!tickets.length) {
    return (
      <div className="py-16 text-center">
        <Ticket size={28} className="mx-auto mb-2 text-slate-700" />
        <p className="text-slate-400">No tenés tickets asignados.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {deCache != null && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-[12px] text-amber-300">
          Sin conexión. Estás viendo lo guardado hace{' '}
          {deCache < 60 ? `${deCache} min` : `${Math.floor(deCache / 60)} h`}.
        </div>
      )}
      {/* Las tres pestañas. Con el número al lado: sin él hay que entrar a cada
          una para saber si tiene algo, que en un celular son tres toques para
          responder una pregunta que se contesta mirando. */}
      <div className="flex gap-1.5">
        {GRUPOS.map((g) => {
          const n = porGrupo[g.clave]?.length ?? 0
          const sel = g.clave === activa
          return (
            <button
              key={g.clave}
              type="button"
              onClick={() => setTab(g.clave)}
              className={`flex-1 rounded-xl border px-2 py-2.5 text-center transition ${
                sel
                  ? 'border-slate-600 bg-slate-800'
                  : 'border-slate-800 bg-slate-900/40 active:bg-slate-800/60'
              }`}
            >
              <span
                className={`block text-lg font-semibold tabular-nums ${
                  n === 0 ? 'text-slate-600' : sel ? g.tono : 'text-slate-300'
                }`}
              >
                {n}
              </span>
              <span
                className={`block text-[11px] ${sel ? 'text-slate-200' : 'text-slate-500'}`}
              >
                {g.label}
              </span>
            </button>
          )
        })}
      </div>

      {/* Qué significa la pestaña abierta. Es una línea y evita la pregunta
          "¿asignado y en curso no son lo mismo?", que es exactamente la duda
          que trajo esta pantalla. */}
      <p className="px-1 text-[11px] text-slate-500">{grupo?.ayuda}</p>

      {lista.length === 0 ? (
        <div className="py-12 text-center">
          <Ticket size={24} className="mx-auto mb-2 text-slate-700" />
          <p className="text-[13px] text-slate-500">
            {activa === 'asignados'
              ? 'No tenés trabajos esperando.'
              : activa === 'curso'
                ? 'No tenés nada empezado.'
                : 'Todavía no cerraste ninguno.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {lista.map((t) => (
            <Tarjeta key={t.id} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}

function Tarjeta({ t }) {
  const cerrado = ['resuelto', 'cancelado'].includes(t.estado)
  const p = PRIORIDADES[t.prioridad] ?? PRIORIDADES.media
  const est = ESTADOS[t.estado]

  return (
    <div className="t-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {/* El abonado primero: es a quién va a ver. El tipo de incidencia
              abajo, que es qué le pasa. La tabla no tiene un "título" — se
              arma de esas dos cosas, igual que en la pantalla de escritorio. */}
          <p className={`truncate text-[14px] font-medium ${cerrado ? 'text-slate-500' : 'text-slate-100'}`}>
            {t.nombre ?? 'Sin nombre'}
          </p>
          <p className="mt-0.5 text-[12px] text-slate-400">{etiquetaIncidencia(t.tipo_incidencia)}</p>
          <p className="text-[11px] text-slate-600">
            #{t.numero}
            {est ? ` · ${est.label}` : ''}
          </p>
        </div>
        {!cerrado && t.prioridad && (
          <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${p.clase}`}>
            {p.label}
          </span>
        )}
      </div>

      {t.direccion && (
        <p className="mt-1.5 flex items-start gap-1 text-[12px] text-slate-400">
          <MapPin size={12} className="mt-0.5 shrink-0 text-slate-600" />
          <span className="line-clamp-2">{t.direccion}</span>
        </p>
      )}

      <div className="mt-2.5 flex gap-2">
        <a
          href={enlaceMapa(t) ?? undefined}
          target="_blank"
          rel="noreferrer"
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-700 py-2 text-[12px] text-slate-300 active:bg-slate-800 ${
            enlaceMapa(t) ? '' : 'pointer-events-none opacity-30'
          }`}
        >
          <Navigation size={13} /> Llegar
        </a>
        <Link
          to={`/campo/soporte/${t.id}`}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-sky-600 py-2 text-[12px] font-medium text-white active:bg-sky-700"
        >
          Abrir <ArrowRight size={13} />
        </Link>
      </div>
    </div>
  )
}
