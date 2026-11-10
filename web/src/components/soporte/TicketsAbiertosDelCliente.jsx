import { useEffect, useState } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { ESTADOS, etiquetaIncidencia } from '../../lib/soporte'

/**
 * "Este cliente ya tiene un ticket abierto."
 *
 * ── Para qué ──
 *
 * El 10/11/2026 había dos abonados con dos tickets abiertos cada uno, en el
 * mismo punto del mapa: el mismo reclamo cargado dos veces, uno a la cuadrilla
 * y otro a un técnico. En la ruta son dos paradas en la misma casa y en el
 * tablero, dos atrasos.
 *
 * Avisa, no bloquea: a veces son dos problemas de verdad (no tiene internet y
 * además pide un traslado). Quien carga lo decide, pero lo decide sabiéndolo.
 *
 * El enlace abre en otra pestaña para no perder lo que ya se cargó.
 */
export default function TicketsAbiertosDelCliente({ clientId, identificacion, excluir = null }) {
  const [abiertos, setAbiertos] = useState([])
  const cedula = String(identificacion ?? '').trim()
  const buscar = Boolean(clientId) || cedula.length >= 10

  useEffect(() => {
    if (!buscar) {
      setAbiertos([])
      return
    }
    let vigente = true
    let q = supabase
      .from('tickets')
      .select('id, numero, estado, tipo_incidencia, incidencia_otro, created_at')
      .not('estado', 'in', '(resuelto,cancelado)')
      .order('created_at', { ascending: false })
      .limit(5)
    q = clientId ? q.eq('client_id', clientId) : q.eq('identificacion', cedula)
    q.then(({ data }) => {
      if (vigente) setAbiertos((data ?? []).filter((t) => t.id !== excluir))
    })
    return () => {
      vigente = false
    }
  }, [buscar, clientId, cedula, excluir])

  if (!abiertos.length) return null

  return (
    <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-400" />
      <div className="min-w-0">
        <p className="font-semibold">
          Este cliente ya tiene {abiertos.length === 1 ? 'un ticket abierto' : `${abiertos.length} tickets abiertos`}.
          Si es el mismo reclamo, no hace falta crear otro.
        </p>
        <ul className="mt-1 space-y-0.5">
          {abiertos.map((t) => (
            <li key={t.id}>
              <a
                href={`/soporte/${t.id}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-amber-300 underline-offset-2 hover:underline"
              >
                N° {t.numero} · {etiquetaIncidencia(t.tipo_incidencia, t.incidencia_otro)} ·{' '}
                {ESTADOS[t.estado]?.label ?? t.estado}
                <ExternalLink size={11} />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
