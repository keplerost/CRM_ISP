import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, CheckCircle2, Clock, MapPin, Navigation } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { enlaceMapa } from '../../lib/soporte'
import { ESTADOS } from '../../lib/instalaciones'
import { HORA, faltaPara, hoyISO } from '../../lib/campo'
import { conCache } from '../../lib/cacheLocal'
import { usePermisos } from '../../lib/AuthContext'

/**
 * Las órdenes del técnico.
 *
 * ── Qué filtra, y qué NO ──
 *
 * No filtra por técnico. Eso lo hace RLS: `instalaciones_lectura` solo devuelve
 * las filas cuyo `tecnico_id` coincide con el suyo. Agregar acá un `.eq()` con
 * su id daría la ilusión de que la seguridad vive en la pantalla, y la próxima
 * pantalla que alguien escriba se olvidaría de ponerlo.
 *
 * Lo que sí filtra es el tiempo, que es una decisión de producto: hoy, atrasadas
 * y lo que viene. Un técnico no necesita ver las de marzo.
 */

const GRUPOS = [
  { clave: 'atrasadas', titulo: 'Atrasadas', tono: 'text-amber-400' },
  { clave: 'hoy', titulo: 'Hoy', tono: 'text-sky-400' },
  { clave: 'proximas', titulo: 'Próximos días', tono: 'text-slate-400' },
  { clave: 'cerradas', titulo: 'Cerradas hace poco', tono: 'text-slate-500' },
]

export default function OrdenesPage() {
  const { perfil } = usePermisos()
  const [ordenes, setOrdenes] = useState([])
  const [cargando, setCargando] = useState(true)
  const [deCache, setDeCache] = useState(null)

  const recargar = useCallback(async () => {
    try {
      // Igual que el tablero: si no hay señal se muestra lo último leído, con
      // la hora a la vista. Ver `lib/cacheLocal.js`.
      const r = await conCache(`ordenes:${perfil?.id ?? 'anonimo'}`, async () => {
        const { data, error } = await supabase
          .from('v_instalaciones')
          .select('*')
          .order('fecha', { ascending: false })
          .limit(80)
        if (error) throw error
        return data ?? []
      })
      setOrdenes(r.datos)
      setDeCache(r.deCache ? r.minutos : null)
    } catch {
      setOrdenes([])
    } finally {
      setCargando(false)
    }
  }, [perfil?.id])

  useEffect(() => {
    recargar()
  }, [recargar])

  const grupos = useMemo(() => {
    // `hoyISO()` y no `toISOString()`: ese devuelve la fecha en UTC, y en
    // Ecuador (UTC-5) eso hace que a partir de las 19:00 el sistema pase al día
    // siguiente — las órdenes de hoy se verían como atrasadas. Es el mismo
    // error que ya se arregló en el tablero; este archivo había quedado afuera.
    const hoy = hoyISO()
    const abierta = (o) => !['hecha', 'cancelada'].includes(o.estado)
    return {
      atrasadas: ordenes.filter((o) => abierta(o) && o.fecha && o.fecha < hoy),
      hoy: ordenes.filter((o) => o.fecha === hoy),
      proximas: ordenes.filter((o) => abierta(o) && (!o.fecha || o.fecha > hoy)),
      cerradas: ordenes.filter((o) => !abierta(o) && o.fecha !== hoy).slice(0, 10),
    }
  }, [ordenes])

  if (cargando) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl bg-slate-900/60" />
        ))}
      </div>
    )
  }

  if (!ordenes.length) {
    return (
      <div className="py-16 text-center">
        <p className="text-slate-400">No tenés órdenes asignadas.</p>
        <p className="mt-1 text-[12px] text-slate-600">
          Cuando la oficina te asigne un trabajo, aparece acá.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {deCache != null && <AvisoGuardado minutos={deCache} />}
      {GRUPOS.map(({ clave, titulo, tono }) => {
        const lista = grupos[clave]
        if (!lista?.length) return null
        return (
          <section key={clave}>
            <p className={`mb-2 text-[11px] font-semibold uppercase tracking-wide ${tono}`}>
              {titulo} · {lista.length}
            </p>
            <div className="grid gap-2 md:grid-cols-2">
              {lista.map((o) => (
                <Tarjeta key={o.id} o={o} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function Tarjeta({ o }) {
  const cerrada = o.estado === 'hecha' || o.estado === 'cancelada'
  const falta = cerrada ? [] : faltaPara(o)
  const est = ESTADOS[o.estado]

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={`truncate text-[14px] font-medium ${cerrada ? 'text-slate-500' : 'text-slate-100'}`}>
            {o.cliente ?? o.nombre ?? 'Sin nombre'}
          </p>
          <p className="mt-0.5 flex items-start gap-1 text-[12px] text-slate-400">
            <MapPin size={12} className="mt-0.5 shrink-0 text-slate-600" />
            <span className="line-clamp-2">{o.direccion ?? 'sin dirección'}</span>
          </p>
        </div>
        {cerrada ? (
          <CheckCircle2 size={16} className="shrink-0 text-emerald-500" />
        ) : (
          <span className="shrink-0 rounded-full border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400">
            {est?.label ?? o.estado}
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        {o.fecha && (
          <span className="flex items-center gap-1">
            <Clock size={11} />
            {new Date(`${o.fecha}T12:00:00`).toLocaleDateString('es-EC', {
              day: '2-digit',
              month: 'short',
            })}
            {o.hora ? ` · ${HORA(o.hora)}` : ''}
          </span>
        )}
        {o.plan && <span>{o.plan}</span>}
        {o.telefono && (
          <a href={`tel:${o.telefono}`} className="text-sky-400">
            {o.telefono}
          </a>
        )}
      </div>

      {/* Qué le falta, antes de manejar hasta el domicilio. */}
      {falta.length > 0 && (
        <p className="mt-1.5 flex items-start gap-1 text-[11px] text-amber-400/80">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          Falta {falta.join(' · ')}
        </p>
      )}

      <div className="mt-2.5 flex gap-2">
        <a
          href={enlaceMapa(o) ?? undefined}
          target="_blank"
          rel="noreferrer"
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-700 py-2 text-[12px] text-slate-300 active:bg-slate-800 ${
            enlaceMapa(o) ? '' : 'pointer-events-none opacity-30'
          }`}
        >
          <Navigation size={13} /> Llegar
        </a>
        <Link
          to={`/instalaciones/${o.id}/alta`}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-sky-600 py-2 text-[12px] font-medium text-white active:bg-sky-700"
        >
          {cerrada ? 'Ver' : 'Abrir'} <ArrowRight size={13} />
        </Link>
      </div>
    </div>
  )
}

/** Los datos son de antes: hay que decirlo, no insinuarlo. */
const AvisoGuardado = ({ minutos }) => (
  <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-[12px] text-amber-300">
    Sin conexión. Estás viendo lo guardado hace{' '}
    {minutos < 60 ? `${minutos} min` : `${Math.floor(minutos / 60)} h`}.
  </div>
)
