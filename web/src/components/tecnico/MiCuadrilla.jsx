import { useEffect, useState } from 'react'
import { Check, Star, Users } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { hoyISO } from '../../lib/campo'

/**
 * La cuadrilla de hoy del técnico (migración 208).
 *
 * `null` si trabaja suelto o si la 208 no corrió: en los dos casos no hay nada
 * que mostrar. Se pide de nuevo cuando cambia el técnico, no en cada render.
 */
export function useMiCuadrilla(tecnicoId) {
  const [c, setC] = useState(null)
  useEffect(() => {
    if (!tecnicoId) return undefined
    let vigente = true
    supabase.rpc('mi_cuadrilla_hoy', { p_fecha: hoyISO() }).then(({ data, error }) => {
      if (vigente) setC(error ? null : (data ?? null))
    })
    return () => {
      vigente = false
    }
  }, [tecnicoId])
  return c
}

/**
 * La cuadrilla de hoy: quién es el jefe de grupo y, para él, quién de su
 * equipo ya marcó ingreso. No se dibuja si el técnico trabaja suelto.
 */
export default function MiCuadrilla({ c }) {
  if (!c) return null
  const hora = (f) =>
    new Date(f).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })

  return (
    <section className="t-card p-4">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <Users size={12} /> Cuadrilla {c.cuadrilla}
      </p>
      <p className="text-[13px] text-slate-300">
        {c.sin_jefe ? (
          'Sin jefe de grupo definido: cada uno carga su vehículo y km.'
        ) : c.soy_jefe ? (
          <>
            <Star size={13} className="mr-1 inline text-amber-400" />
            Hoy sos el jefe de grupo{c.es_reemplazo ? ' (reemplazo)' : ''}: cargás el vehículo y los km.
          </>
        ) : (
          <>
            Jefe de grupo hoy: <b>{c.jefe}</b>
            {c.es_reemplazo ? ' (reemplazo)' : ''}
          </>
        )}
      </p>

      {c.soy_jefe && (
        <ul className="mt-3 space-y-1.5">
          {(c.integrantes ?? []).map((i) => (
            <li key={i.nombre} className="flex items-center justify-between text-[12px]">
              <span className="text-slate-300">
                {i.es_jefe && <Star size={11} className="mr-1 inline text-amber-400" />}
                {i.nombre}
              </span>
              {i.ingreso_at ? (
                <span className="text-emerald-400">
                  <Check size={12} className="mr-0.5 inline" />
                  {hora(i.ingreso_at)}
                  {!i.con_foto && <span className="ml-1 text-amber-400">sin foto</span>}
                </span>
              ) : (
                <span className="text-slate-500">no marcó</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
