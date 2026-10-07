import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  ListOrdered,
  Lock,
  MapPin,
  MessageCircle,
  Navigation,
  Phone,
} from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { enlaceLlamada, enlaceWhatsApp, separarTelefonos } from '../../lib/telefono'
import { etiquetaIncidencia } from '../../lib/soporte'

/**
 * La ruta de hoy (migración 216).
 *
 * ── Un trabajo a la vez ──
 *
 * Arriba, grande, el trabajo ACTUAL: el que está en curso o, si no hay, el
 * primero pendiente. Los demás se ven debajo con un candado: la base no deja
 * salir hacia ni llegar a otro mientras el actual no termine —resuelto o "no se
 * pudo atender"—. La pantalla solo lo dice antes de que el técnico lo intente.
 *
 * ── Quién cambia el orden ──
 *
 * La oficina, o el jefe de grupo del día diciendo por qué (queda registrado y
 * la oficina se entera). Se ofrece solo a quien la base se lo va a aceptar.
 */

/** Toca "Llamar" o "WhatsApp": queda constancia para el "no contesta". */
export function registrarLlamada(tipo, id, canal = 'llamada') {
  supabase.rpc('registrar_llamada', { p_tipo: tipo, p_id: id, p_canal: canal }).then(() => {})
}

export function useMiRuta() {
  const [ruta, setRuta] = useState(null)
  const recargar = useCallback(async () => {
    const { data, error } = await supabase.rpc('mi_ruta_hoy')
    // Sin la 216 no hay ruta: la tarjeta no se dibuja.
    setRuta(error ? null : (data ?? null))
  }, [])
  useEffect(() => {
    recargar()
  }, [recargar])
  return { ruta, recargar }
}

const enlaceDe = (i) => (i.tipo === 'ticket' ? `/campo/soporte/${i.id}` : `/instalaciones/${i.id}/alta`)

const mapaDe = (i) =>
  i.latitud != null && i.longitud != null
    ? `https://www.google.com/maps/dir/?api=1&destination=${i.latitud},${i.longitud}`
    : i.direccion
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(i.direccion)}`
      : null

const queEs = (i) =>
  i.tipo === 'ticket'
    ? `Ticket #${i.numero} · ${etiquetaIncidencia(i.detalle)}`
    : `Instalación${i.numero ? ` #${i.numero}` : ''}`

const ESTADO = {
  en_ruta: 'En camino',
  en_proceso: 'En el sitio',
  en_curso: 'En el sitio',
}

export default function RutaDelDia({ ruta, onCambio }) {
  const [ordenando, setOrdenando] = useState(null)
  const [motivo, setMotivo] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)

  if (!ruta) return null
  const items = ruta.items ?? []

  if (!items.length) {
    return (
      <section className="t-card p-4">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          <ListOrdered size={12} /> Ruta de hoy
        </p>
        <p className="mt-2 text-[13px] text-slate-400">No tenés trabajos pendientes para hoy.</p>
      </section>
    )
  }

  const [actual, ...despues] = items
  const tel = separarTelefonos(actual.telefono)[0]
  const wa = enlaceWhatsApp(actual.telefono)
  const mapa = mapaDe(actual)

  async function guardarOrden() {
    setGuardando(true)
    setError(null)
    const { error: err } = await supabase.rpc('ordenar_ruta', {
      p_items: ordenando.map((i) => ({ tipo: i.tipo, id: i.id })),
      p_motivo: motivo.trim() || null,
    })
    setGuardando(false)
    if (err) return setError(err.message)
    setOrdenando(null)
    setMotivo('')
    onCambio?.()
  }

  const mover = (idx, delta) =>
    setOrdenando((lista) => {
      const n = [...lista]
      const j = idx + delta
      if (j < 0 || j >= n.length) return n
      ;[n[idx], n[j]] = [n[j], n[idx]]
      return n
    })

  /* ── Cambiar el orden ── */
  if (ordenando) {
    return (
      <section className="t-card space-y-3 p-4">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          <ListOrdered size={12} /> Cambiar el orden de la ruta
        </p>
        <ul className="space-y-1.5">
          {ordenando.map((i, idx) => (
            <li key={i.id} className="flex items-center gap-2 t-panel px-2 py-1.5 text-[13px]">
              <span className="w-5 text-center text-slate-500">{idx + 1}</span>
              <span className="min-w-0 flex-1 truncate text-slate-200">{i.nombre}</span>
              <button type="button" onClick={() => mover(idx, -1)} className="p-1 text-slate-400" aria-label="Subir">
                <ArrowUp size={16} />
              </button>
              <button type="button" onClick={() => mover(idx, 1)} className="p-1 text-slate-400" aria-label="Bajar">
                <ArrowDown size={16} />
              </button>
            </li>
          ))}
        </ul>
        {!ruta.es_oficina && (
          <textarea
            rows={2}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Por qué cambiás el orden (lo ve la oficina)"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-[13px] text-slate-100"
          />
        )}
        {error && <p className="text-[12px] text-rose-400">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setOrdenando(null)}
            className="flex-1 rounded-lg border border-slate-700 py-2 text-[13px] text-slate-300"
          >
            Volver
          </button>
          <button
            type="button"
            onClick={guardarOrden}
            disabled={guardando || (!ruta.es_oficina && !motivo.trim())}
            className="flex-1 rounded-lg bg-sky-600 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            {guardando ? 'Guardando…' : 'Guardar el orden'}
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="t-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          <ListOrdered size={12} /> Ruta de hoy · {items.length} {items.length === 1 ? 'trabajo' : 'trabajos'}
        </p>
        {ruta.puede_ordenar && items.length > 1 && (
          <button type="button" onClick={() => setOrdenando(items)} className="text-[12px] text-sky-400">
            Cambiar orden
          </button>
        )}
      </div>

      {/* El actual */}
      <div className="rounded-xl border border-sky-500/40 bg-sky-500/10 p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-300">
          Ahora{ESTADO[actual.estado] ? ` · ${ESTADO[actual.estado]}` : ''}
        </p>
        <p className="mt-0.5 text-[15px] font-semibold text-slate-100">{actual.nombre}</p>
        <p className="text-[12px] text-slate-400">{queEs(actual)}</p>
        {actual.direccion && (
          <p className="mt-0.5 flex items-start gap-1 text-[12px] text-slate-400">
            <MapPin size={12} className="mt-0.5 shrink-0" /> {actual.direccion}
          </p>
        )}

        <div className="mt-3 grid grid-cols-4 gap-2 text-[11px]">
          <Link
            to={enlaceDe(actual)}
            className="col-span-1 flex flex-col items-center gap-1 rounded-lg bg-sky-600 py-2 font-semibold text-white"
          >
            <ChevronRight size={16} /> Abrir
          </Link>
          <a
            href={tel ? enlaceLlamada(actual.telefono) : undefined}
            onClick={() => tel && registrarLlamada(actual.tipo, actual.id, 'llamada')}
            className={`flex flex-col items-center gap-1 rounded-lg border py-2 ${
              tel ? 'border-sky-500/40 text-sky-300' : 'pointer-events-none border-slate-800 text-slate-600'
            }`}
          >
            <Phone size={16} /> Llamar
          </a>
          <a
            href={wa ?? undefined}
            target="_blank"
            rel="noreferrer"
            onClick={() => wa && registrarLlamada(actual.tipo, actual.id, 'whatsapp')}
            className={`flex flex-col items-center gap-1 rounded-lg border py-2 ${
              wa ? 'border-emerald-500/40 text-emerald-300' : 'pointer-events-none border-slate-800 text-slate-600'
            }`}
          >
            <MessageCircle size={16} /> WhatsApp
          </a>
          <a
            href={mapa ?? undefined}
            target="_blank"
            rel="noreferrer"
            className={`flex flex-col items-center gap-1 rounded-lg border py-2 ${
              mapa ? 'border-violet-500/40 text-violet-300' : 'pointer-events-none border-slate-800 text-slate-600'
            }`}
          >
            <Navigation size={16} /> Mapa
          </a>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          Si el cliente no contesta: llamalo desde acá, esperá 10 minutos en el sitio y marcá
          "No se pudo atender" dentro del trabajo.
        </p>
      </div>

      {/* Los que siguen, con candado */}
      {despues.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {despues.map((i) => (
            <li key={i.id} className="flex items-center gap-2 text-[13px] text-slate-400">
              <Lock size={13} className="shrink-0 text-slate-600" />
              <span className="w-5 shrink-0 text-center text-slate-500">{i.posicion}</span>
              <span className="min-w-0 flex-1 truncate">
                {i.nombre} <span className="text-slate-600">· {queEs(i)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
