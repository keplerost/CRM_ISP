import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Flag, Pause, Play, Save, Trash2 } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { largoRuta, metrosEntre } from '../../lib/kmz'

/**
 * Levantar un tramo de cable caminando con el celular (migración 239).
 *
 * El GPS va marcando el recorrido mientras se camina. En cada poste se toca
 * "A" (retención) o "J" (suspensión); en cada reserva, se ponen los metros. Al
 * terminar, el tramo queda en la obra y en el mapa de planta externa como
 * cable verificado en campo, con sus postes.
 *
 * ── Sin señal ──
 *
 * Todo lo marcado se guarda en el celular a cada paso. Si se cierra la app o
 * se va la señal, al volver se sigue donde quedó; y el envío lleva una clave,
 * así reintentarlo no lo carga dos veces.
 */

const MIN_PASO_M = 4
const MAX_PRECISION_M = 30

const leer = (k) => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? 'null')
  } catch {
    return null
  }
}
const guardar = (k, v) => {
  try {
    if (v == null) localStorage.removeItem(k)
    else localStorage.setItem(k, JSON.stringify(v))
  } catch {
    // Sin almacenamiento (modo privado): se sigue en memoria.
  }
}

export default function LevantarTramo({ obra, onCancelar, onListo }) {
  const clave = `tramo:${obra.id}`
  const [b, setB] = useState(() => leer(clave) ?? { puntos: [], marcas: [], precisiones: [], id: crypto.randomUUID() })
  const [grabando, setGrabando] = useState(false)
  const [pos, setPos] = useState(null)
  const [reserva, setReserva] = useState(null)
  const [cierre, setCierre] = useState(null)
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => guardar(clave, b.puntos.length || b.marcas.length ? b : null), [b, clave])

  // ── El GPS ──
  useEffect(() => {
    if (!grabando || !navigator.geolocation) return
    let wake = null
    navigator.wakeLock?.request?.('screen').then((w) => (wake = w)).catch(() => {})
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const actual = { lat: p.coords.latitude, lng: p.coords.longitude, precision: p.coords.accuracy }
        setPos(actual)
        if (actual.precision > MAX_PRECISION_M) return
        setB((v) => {
          const ult = v.puntos[v.puntos.length - 1]
          if (ult && metrosEntre(ult, [actual.lat, actual.lng]) < MIN_PASO_M) return v
          return {
            ...v,
            puntos: [...v.puntos, [round7(actual.lat), round7(actual.lng)]],
            precisiones: [...v.precisiones, Math.round(actual.precision)],
          }
        })
      },
      (e) => setError(e.code === 1 ? 'Sin permiso para usar la ubicación: activalo en el navegador.' : 'El GPS no responde.'),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    )
    return () => {
      navigator.geolocation.clearWatch(id)
      wake?.release?.().catch(() => {})
    }
  }, [grabando])

  // ── El mapa chico ──
  const cont = useRef(null)
  const mapa = useRef(null)
  const capa = useRef(null)
  useEffect(() => {
    if (!cont.current || mapa.current) return
    const m = L.map(cont.current, { zoomControl: false, attributionControl: false }).setView(b.puntos[0] ?? [-0.93, -79.22], 17)
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19 }).addTo(m)
    capa.current = L.layerGroup().addTo(m)
    mapa.current = m
    return () => {
      m.remove()
      mapa.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const g = capa.current
    if (!g) return
    g.clearLayers()
    if (b.puntos.length > 1) L.polyline(b.puntos, { color: '#f97316', weight: 5 }).addTo(g)
    for (const mk of b.marcas) {
      L.circleMarker([mk.lat, mk.lng], {
        radius: 7,
        color: '#fff',
        weight: 2,
        fillColor: mk.tipo === 'reserva' ? '#0d9488' : mk.herraje === 'A' ? '#2563eb' : mk.herraje === 'J' ? '#9333ea' : '#475569',
        fillOpacity: 1,
      })
        .bindTooltip(mk.tipo === 'reserva' ? `Reserva ${mk.metros} m` : `Poste ${mk.herraje ?? ''}`)
        .addTo(g)
    }
    if (pos) {
      L.circle([pos.lat, pos.lng], { radius: pos.precision, color: '#0ea5e9', weight: 1, fillOpacity: 0.1 }).addTo(g)
      L.circleMarker([pos.lat, pos.lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#0ea5e9', fillOpacity: 1 }).addTo(g)
      mapa.current?.panTo([pos.lat, pos.lng], { animate: false })
    }
  }, [b, pos])

  function marcar(m) {
    const p = pos && pos.precision <= MAX_PRECISION_M * 1.5 ? pos : null
    const ult = b.puntos[b.puntos.length - 1]
    const lugar = p ? [p.lat, p.lng] : ult
    if (!lugar) return setError('Todavía no hay ubicación: esperá a que el GPS tome tu posición.')
    setB((v) => ({ ...v, marcas: [...v.marcas, { ...m, lat: round7(lugar[0]), lng: round7(lugar[1]) }] }))
  }

  async function enviar(e) {
    e.preventDefault()
    setEnviando(true)
    setError(null)
    const prec = b.precisiones.length ? b.precisiones.reduce((s, x) => s + x, 0) / b.precisiones.length : null
    const { error: err } = await supabase.rpc('registrar_tramo_obra', {
      p_obra: obra.id,
      p_datos: {
        nombre: cierre.nombre,
        tipo: cierre.tipo,
        hilos: cierre.hilos ? Number(cierre.hilos) : null,
        ruta: b.puntos,
        marcas: b.marcas,
        precision_m: prec ? Math.round(prec * 10) / 10 : null,
      },
      p_clave: b.id,
    })
    setEnviando(false)
    if (err) return setError(`${err.message} El tramo sigue guardado en el celular: reintentá cuando haya señal.`)
    guardar(clave, null)
    onListo()
  }

  const metros = Math.round(largoRuta(b.puntos))
  const CAMPO = 'w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-[13px] text-slate-100'
  const BTN = 'flex-1 rounded-lg border py-2.5 text-[12px] font-semibold active:opacity-80 disabled:opacity-40'

  return (
    <div className="space-y-3 rounded-lg border border-orange-500/40 p-3">
      <div ref={cont} className="isolate h-56 w-full overflow-hidden rounded-lg" />
      <p className="flex flex-wrap gap-x-3 text-[12px] text-slate-300">
        <span>
          <b>{metros}</b> m
        </span>
        <span>{b.puntos.length} puntos</span>
        <span>{b.marcas.length} marcas</span>
        {pos && (
          <span className={pos.precision > MAX_PRECISION_M ? 'text-amber-400' : 'text-emerald-400'}>
            GPS ±{Math.round(pos.precision)} m{pos.precision > MAX_PRECISION_M ? ' (esperando mejor señal)' : ''}
          </span>
        )}
      </p>
      {!grabando && b.puntos.length > 0 && !cierre && (
        <p className="text-[11px] text-sky-300">Tramo guardado en el celular: podés seguirlo donde quedó.</p>
      )}

      {!cierre ? (
        <>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setGrabando((g) => !g)}
              className={`${BTN} ${grabando ? 'border-amber-500/60 text-amber-300' : 'border-emerald-500/60 text-emerald-300'}`}
            >
              {grabando ? <Pause size={14} className="mr-1 inline" /> : <Play size={14} className="mr-1 inline" />}
              {grabando ? 'Pausar' : b.puntos.length ? 'Seguir' : 'Empezar a caminar'}
            </button>
            <button
              type="button"
              disabled={b.puntos.length < 2}
              onClick={() => {
                setGrabando(false)
                setCierre({ nombre: '', tipo: 'distribucion', hilos: '' })
              }}
              className={`${BTN} border-sky-500/60 text-sky-300`}
            >
              <Save size={14} className="mr-1 inline" /> Terminar
            </button>
          </div>
          <div className="grid grid-cols-4 gap-2">
            <button type="button" onClick={() => marcar({ tipo: 'poste', herraje: 'A' })} className={`${BTN} border-blue-500/60 text-blue-300`}>
              Poste A
            </button>
            <button type="button" onClick={() => marcar({ tipo: 'poste', herraje: 'J' })} className={`${BTN} border-violet-500/60 text-violet-300`}>
              Poste J
            </button>
            <button type="button" onClick={() => marcar({ tipo: 'poste' })} className={`${BTN} border-slate-600 text-slate-300`}>
              Poste
            </button>
            <button type="button" onClick={() => setReserva('')} className={`${BTN} border-teal-500/60 text-teal-300`}>
              <Flag size={13} className="mr-0.5 inline" /> Reserva
            </button>
          </div>
          {reserva !== null && (
            <div className="flex gap-2">
              <input
                type="number"
                min="1"
                autoFocus
                value={reserva}
                onChange={(e) => setReserva(e.target.value)}
                placeholder="Metros de la reserva"
                className={CAMPO}
              />
              <button
                type="button"
                disabled={!Number(reserva)}
                onClick={() => {
                  marcar({ tipo: 'reserva', metros: Number(reserva) })
                  setReserva(null)
                }}
                className="rounded-lg bg-teal-600 px-3 text-[12px] font-semibold text-white disabled:opacity-40"
              >
                Marcar
              </button>
            </div>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={onCancelar} className="flex-1 rounded-lg border border-slate-700 py-2 text-[12px] text-slate-300">
              Volver (queda guardado)
            </button>
            {(b.puntos.length > 0 || b.marcas.length > 0) && (
              <button
                type="button"
                onClick={() => {
                  if (!window.confirm('¿Descartar este tramo? Se borra lo marcado.')) return
                  setGrabando(false)
                  setB({ puntos: [], marcas: [], precisiones: [], id: crypto.randomUUID() })
                }}
                className="rounded-lg border border-slate-700 px-3 text-slate-400"
                aria-label="Descartar"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </>
      ) : (
        <form onSubmit={enviar} className="space-y-2">
          <input
            value={cierre.nombre}
            onChange={(e) => setCierre((v) => ({ ...v, nombre: e.target.value }))}
            placeholder="Nombre del tramo (ej.: Distribución calle Bolívar)"
            className={CAMPO}
          />
          <div className="grid grid-cols-2 gap-2">
            <select value={cierre.tipo} onChange={(e) => setCierre((v) => ({ ...v, tipo: e.target.value }))} className={CAMPO}>
              <option value="troncal">Troncal</option>
              <option value="feeder">Feeder</option>
              <option value="distribucion">Distribución</option>
              <option value="drop">Drop</option>
              <option value="otro">Otro</option>
            </select>
            <input
              type="number"
              min="1"
              value={cierre.hilos}
              onChange={(e) => setCierre((v) => ({ ...v, hilos: e.target.value }))}
              placeholder="Hilos"
              className={CAMPO}
            />
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setCierre(null)} className="flex-1 rounded-lg border border-slate-700 py-2 text-[13px] text-slate-300">
              Seguir marcando
            </button>
            <button type="submit" disabled={enviando} className="flex-1 rounded-lg bg-sky-600 py-2 text-[13px] font-semibold text-white disabled:opacity-50">
              {enviando ? 'Guardando…' : 'Guardar tramo'}
            </button>
          </div>
        </form>
      )}
      {error && <p className="text-[12px] text-rose-400">{error}</p>}
    </div>
  )
}

const round7 = (x) => Math.round(Number(x) * 1e7) / 1e7
