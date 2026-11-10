import { useEffect, useMemo, useState } from 'react'
import { CalendarCheck, MapPinned } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { FRANJAS } from '../../lib/soporte'
import { RADIO_ZONA_M, esCoordenada, trabajosCercanos } from '../../lib/ruta'

/**
 * "Cerca de este cliente ya hay…", mientras se carga un ticket.
 *
 * ── Para qué ──
 *
 * La ruta se ordena sola por cercanía, pero solo dentro del mismo día y la
 * misma franja: si dos vecinos se agendan uno el miércoles y otro el jueves, el
 * técnico va dos veces a la misma zona. Esto se arregla al AGENDAR, y quien
 * agenda no tiene el mapa en la cabeza. Así que se le muestra: qué hay a menos
 * de dos kilómetros, cuándo, y un botón para ponerlo junto.
 *
 * Copia la fecha, la franja y a quién va asignado. No decide nada solo: el que
 * carga sabe si el abonado puede ese día.
 */

const MAX = 5

const fechaCorta = (f) =>
  f
    ? new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString('es-EC', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      })
    : 'sin fecha'

const distancia = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`)

export default function TrabajosCercanos({ latitud, longitud, excluir = null, onElegir }) {
  const [pendientes, setPendientes] = useState(null)
  const ubicado = esCoordenada(latitud) && esCoordenada(longitud)

  useEffect(() => {
    if (!ubicado || pendientes) return
    supabase
      .from('v_tickets')
      .select(
        'id, numero, nombre, latitud, longitud, estado, fecha_visita, franja, hora_visita, tecnico_id, cuadrilla_id, tecnico, cuadrilla',
      )
      .in('estado', ['abierto', 'asignado', 'en_ruta', 'en_proceso'])
      .not('latitud', 'is', null)
      .limit(500)
      .then(({ data }) => setPendientes(data ?? []))
  }, [ubicado, pendientes])

  const cerca = useMemo(
    () => trabajosCercanos({ latitud, longitud }, pendientes ?? [], { excluir }).slice(0, MAX),
    [latitud, longitud, pendientes, excluir],
  )

  if (!ubicado) {
    return (
      <p className="flex items-start gap-1.5 text-[11px] text-slate-500">
        <MapPinned size={13} className="mt-0.5 shrink-0" />
        Con la ubicación cargada (paso 2) acá se ven los tickets de la misma zona, para agendarlo junto
        a ellos.
      </p>
    )
  }
  if (!pendientes || !cerca.length) return null

  return (
    <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-sky-300">
        <MapPinned size={14} />
        Cerca de este cliente (a menos de {RADIO_ZONA_M / 1000} km) hay {cerca.length}{' '}
        {cerca.length === 1 ? 'ticket pendiente' : 'tickets pendientes'}
      </p>
      <p className="mt-0.5 text-[11px] text-slate-500">
        Agendarlo el mismo día y franja hace que el técnico los atienda seguidos, sin volver a la zona.
      </p>

      <ul className="mt-2 space-y-1.5">
        {cerca.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="w-14 shrink-0 tabular-nums text-slate-500">{distancia(t.metros)}</span>
            <span className="min-w-0 flex-1 truncate text-slate-200">
              N° {t.numero} · {t.nombre}
              <span className="block text-[11px] text-slate-500">
                {fechaCorta(t.fecha_visita)}
                {t.franja ? ` · ${FRANJAS[t.franja]?.split(' (')[0] ?? t.franja}` : ''}
                {t.tecnico || t.cuadrilla ? ` · ${t.tecnico ?? t.cuadrilla}` : ' · sin asignar'}
              </span>
            </span>
            <button
              type="button"
              onClick={() => onElegir?.(t)}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-sky-500/40 px-2 py-1 text-[11px] text-sky-300 hover:bg-sky-500/10"
            >
              <CalendarCheck size={12} /> Agendar igual
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
