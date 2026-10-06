import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronUp, Hammer, MapPin, MessageSquarePlus, Star } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { useConfirmar } from '../../lib/confirmar'
import { TIPO_AVERIA, useBitacora } from '../red/ReparacionesRed'
import { exigirEnServicio } from '../../lib/servicio'

/**
 * Las reparaciones de red asignadas a la cuadrilla del técnico (migración 209).
 *
 * ── Quién hace qué ──
 *
 * Cualquiera de la cuadrilla reporta avances: "llegamos", "el corte está en el
 * poste 14". El jefe de grupo del día la cierra como reparada; a los demás se
 * les dice quién la cierra, en vez de esconderles el botón sin explicación.
 *
 * La base es la que decide (`puede_cerrar_reparacion`): el botón solo refleja
 * lo que ella va a aceptar.
 */

/** Las reparaciones abiertas que ve quien pregunta. `[]` sin la 209. */
export function useReparaciones() {
  const [filas, setFilas] = useState([])
  const recargar = useCallback(async () => {
    const { data, error } = await supabase
      .from('v_reparaciones_red')
      .select('*')
      .in('estado', ['asignada', 'en_curso'])
      .order('creada_at', { ascending: false })
    setFilas(error ? [] : (data ?? []))
  }, [])
  useEffect(() => {
    recargar()
  }, [recargar])
  return { filas, recargar }
}

/**
 * La ubicación del momento, si el teléfono la da rápido. No se espera más de
 * ocho segundos: el reporte importa más que la coordenada.
 */
function ubicacion() {
  return new Promise((resolver) => {
    if (!navigator.geolocation) return resolver(null)
    navigator.geolocation.getCurrentPosition(
      (p) => resolver({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolver(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    )
  })
}

export default function ReparacionesCampo({ filas, onCambio }) {
  if (!filas?.length) return null
  return (
    <section className="space-y-2">
      <p className="flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <Hammer size={12} /> Reparaciones asignadas ({filas.length})
      </p>
      {filas.map((r) => (
        <Reparacion key={r.id} r={r} onCambio={onCambio} />
      ))}
    </section>
  )
}

const PRIORIDAD = {
  alta: 'border-rose-500/50',
  media: 'border-amber-500/40',
  baja: 'border-slate-700',
}

function Reparacion({ r, onCambio }) {
  const confirmar = useConfirmar()
  // 'avance' | 'cierre' | null
  const [modo, setModo] = useState(null)
  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState(null)
  const [hecho, setHecho] = useState(null)
  const [verBitacora, setVerBitacora] = useState(false)
  const bitacora = useBitacora(verBitacora ? r.id : null)

  async function enviar(e) {
    e.preventDefault()
    if (!texto.trim()) return
    if (modo === 'cierre') {
      const aviso =
        r.corte_estado === 'abierta'
          ? `Se va a resolver el corte masivo y se les avisa a ${r.corte_afectados ?? 'los'} abonados que el servicio volvió.\n\n¿Quedó reparado?`
          : '¿Quedó reparado?'
      if (!(await confirmar(aviso))) return
    }
    setEnviando(true)
    setError(null)
    try {
      await exigirEnServicio()
    } catch (err) {
      setEnviando(false)
      return setError(err.message)
    }
    const pos = await ubicacion()
    const args = { p_id: r.id, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null }
    const { data, error: err } =
      modo === 'cierre'
        ? await supabase.rpc('cerrar_reparacion', { ...args, p_nota: texto.trim() })
        : await supabase.rpc('reportar_reparacion', { ...args, p_texto: texto.trim() })
    setEnviando(false)
    if (err) return setError(err.message)

    if (modo === 'cierre') {
      setHecho(
        data?.corte_resuelto
          ? `Reparada. Se resolvió el corte y salen ${data.avisos} avisos de restablecimiento.`
          : r.alerta_id
            ? 'Reparada. La alerta se cierra sola cuando las lecturas de la OLT se normalicen.'
            : 'Reparada. La oficina ya fue avisada.',
      )
    }
    setTexto('')
    setModo(null)
    onCambio?.()
  }

  if (hecho) {
    return (
      <div className="t-card border border-emerald-500/40 p-3 text-[13px] text-emerald-300">
        <CheckCircle2 size={15} className="mr-1.5 inline" />
        {hecho}
      </div>
    )
  }

  return (
    <article className={`t-card border p-3 ${PRIORIDAD[r.prioridad] ?? PRIORIDAD.media}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-slate-500">
            #{r.numero} · {TIPO_AVERIA[r.tipo] ?? r.tipo}
            {r.prioridad === 'alta' && <span className="text-rose-400"> · prioridad alta</span>}
            {r.estado === 'en_curso' && <span className="text-amber-400"> · en curso</span>}
          </p>
          <p className="text-[14px] font-medium text-slate-100">{r.titulo}</p>
          {(r.lugar || r.afectados != null) && (
            <p className="mt-0.5 flex items-center gap-1 text-[12px] text-slate-400">
              <MapPin size={12} className="shrink-0" />
              {[r.lugar, r.afectados != null && `${r.afectados} abonados`].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      </div>

      {r.instrucciones && (
        <p className="mt-2 rounded-lg bg-sky-500/10 p-2 text-[12px] text-sky-200">{r.instrucciones}</p>
      )}

      {r.origen_activo === false && (
        <p className="mt-2 text-[12px] text-emerald-400">
          El sistema ya ve el servicio restablecido. Si quedó bien, cerrala.
        </p>
      )}

      {r.ultimo_reporte && (
        <p className="mt-2 text-[12px] text-slate-300">
          “{r.ultimo_reporte}” <span className="text-slate-500">— {r.ultimo_reporte_de}</span>
        </p>
      )}

      <p className="mt-2 text-[11px] text-slate-500">
        {r.puedo_cerrar ? (
          <>
            <Star size={11} className="mr-1 inline text-amber-400" />
            La cerrás vos cuando quede reparada.
          </>
        ) : r.jefe ? (
          `La cierra el jefe de grupo: ${r.jefe}. Vos podés reportar avances.`
        ) : (
          'Podés reportar avances.'
        )}
      </p>

      {modo ? (
        <form onSubmit={enviar} className="mt-2 space-y-2">
          <textarea
            rows={3}
            autoFocus
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            placeholder={
              modo === 'cierre'
                ? 'Qué se reparó: "empalme de 12 hilos en el poste 14, potencias OK"'
                : 'Qué encontraron o qué falta: "el corte está a 300 m del poste 14"'
            }
            className="w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-[13px] text-slate-100"
          />
          {error && <p className="text-[12px] text-rose-400">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setModo(null)}
              className="flex-1 rounded-lg border border-slate-700 py-2 text-[13px] text-slate-300"
            >
              Volver
            </button>
            <button
              type="submit"
              disabled={enviando || !texto.trim()}
              className={`flex-1 rounded-lg py-2 text-[13px] font-semibold text-white disabled:opacity-50 ${
                modo === 'cierre' ? 'bg-emerald-600' : 'bg-sky-600'
              }`}
            >
              {enviando ? 'Enviando…' : modo === 'cierre' ? 'Marcar reparada' : 'Enviar reporte'}
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => setModo('avance')}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-sky-500/50 py-2 text-[13px] text-sky-300"
          >
            <MessageSquarePlus size={14} /> Reportar avance
          </button>
          {r.puedo_cerrar && (
            <button
              type="button"
              onClick={() => setModo('cierre')}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 py-2 text-[13px] font-semibold text-white"
            >
              <CheckCircle2 size={14} /> Marcar reparada
            </button>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setVerBitacora((v) => !v)}
        className="mt-2 flex items-center gap-1 text-[11px] text-slate-500"
      >
        {verBitacora ? <ChevronUp size={12} /> : <ChevronDown size={12} />} Bitácora
      </button>
      {verBitacora && (
        <ul className="mt-1 space-y-1.5 border-t border-slate-800 pt-2">
          {(bitacora ?? []).map((f) => (
            <li key={f.id} className="text-[12px]">
              <span className="text-slate-500">
                {new Date(f.creado_at).toLocaleString('es-EC', {
                  day: '2-digit',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}{' '}
                · {f.quien ?? '—'}
              </span>
              <p className="text-slate-300">{f.texto}</p>
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}
