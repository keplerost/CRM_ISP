import { useEffect, useRef, useState } from 'react'
import { Activity, Pause, Play } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Button } from '../ui'

/**
 * La velocidad del abonado, ahora.
 *
 * El equipo no informa velocidad: informa bytes acumulados desde que se creó el
 * service-port. La velocidad sale de restar dos lecturas, así que la primera
 * NUNCA puede dar un número — y eso se dice, en vez de dibujar un cero. Un
 * gráfico que arranca en cero se lee como "no está consumiendo nada", que es lo
 * contrario de "todavía no lo sé".
 *
 * Cada muestra cuesta una sesión SSH contra la OLT, así que arranca detenido y
 * se para solo al salir de la pantalla. Dejarlo corriendo olvidado consumiría
 * las pocas sesiones que tiene el equipo.
 */

const INTERVALO_MS = 5000
const MUESTRAS = 40

export default function TraficoVivo({ oltId, onuId }) {
  const [corriendo, setCorriendo] = useState(false)
  const [serie, setSerie] = useState([])
  const [ultimo, setUltimo] = useState(null)
  const [error, setError] = useState(null)
  const timer = useRef(null)
  const vivo = useRef(true)

  useEffect(() => {
    vivo.current = true
    return () => {
      vivo.current = false
      clearTimeout(timer.current)
    }
  }, [])

  useEffect(() => {
    if (!corriendo) {
      clearTimeout(timer.current)
      return
    }

    let cancelado = false

    const tomar = async () => {
      try {
        const r = await api.olt.traficoOnu(oltId, onuId)
        if (cancelado || !vivo.current) return
        setError(null)
        setUltimo(r)
        if (!r.primera_lectura) {
          setSerie((s) => [...s, { at: r.at, subida: r.subida_mbps, bajada: r.bajada_mbps }].slice(-MUESTRAS))
        }
      } catch (err) {
        if (cancelado || !vivo.current) return
        setError(err)
        setCorriendo(false)
        return
      }
      // Se encadena en vez de usar un intervalo fijo: si una lectura tarda ocho
      // segundos, un setInterval de cinco largaría la siguiente antes de que
      // vuelva la anterior y terminarían apilándose sesiones contra la OLT.
      if (!cancelado && vivo.current) timer.current = setTimeout(tomar, INTERVALO_MS)
    }

    tomar()
    return () => {
      cancelado = true
      clearTimeout(timer.current)
    }
  }, [corriendo, oltId, onuId])

  const max = Math.max(1, ...serie.flatMap((p) => [p.subida ?? 0, p.bajada ?? 0]))

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
          <Activity size={13} />
          Consumo en vivo
        </span>
        <Button
          variante={corriendo ? 'alerta' : 'primario'}
          icon={corriendo ? Pause : Play}
          onClick={() => setCorriendo((c) => !c)}
        >
          {corriendo ? 'Detener' : 'Ver en vivo'}
        </Button>
      </div>

      {error && <Aviso tipo="alerta">{error.message}</Aviso>}

      {corriendo && ultimo?.primera_lectura && (
        <Aviso>
          Primera lectura tomada. El equipo informa bytes acumulados, así que la velocidad aparece
          recién con la segunda — en unos segundos.
        </Aviso>
      )}

      {(ultimo?.bajada_mbps != null || serie.length > 0) && (
        <div className="grid grid-cols-2 gap-2">
          <Medida titulo="Bajada" valor={ultimo?.bajada_mbps} color="text-sky-300" />
          <Medida titulo="Subida" valor={ultimo?.subida_mbps} color="text-emerald-300" />
        </div>
      )}

      {serie.length > 1 && (
        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-2">
          <svg viewBox={`0 0 ${MUESTRAS} 40`} preserveAspectRatio="none" className="h-24 w-full">
            {['bajada', 'subida'].map((cual) => (
              <polyline
                key={cual}
                fill="none"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
                className={cual === 'bajada' ? 'stroke-sky-400' : 'stroke-emerald-400'}
                points={serie
                  .map((p, i) => `${i + (MUESTRAS - serie.length)},${40 - ((p[cual] ?? 0) / max) * 38}`)
                  .join(' ')}
              />
            ))}
          </svg>
          <div className="flex items-center justify-between text-[10px] text-slate-600">
            <span>{serie.length} muestras · cada {INTERVALO_MS / 1000} s</span>
            <span>pico {max.toFixed(1)} Mbps</span>
          </div>
        </div>
      )}

      {ultimo?.service_ports?.some((s) => s.bajada_descartados > 0 || s.subida_descartados > 0) && (
        <p className="text-[11px] leading-snug text-slate-500">
          El equipo también cuenta paquetes descartados:{' '}
          {ultimo.service_ports
            .map((s) => `vlan ${s.vlan}: ${s.bajada_descartados ?? 0} bajada / ${s.subida_descartados ?? 0} subida`)
            .join(' · ')}
          . Son acumulados desde el alta, no de ahora.
        </p>
      )}

      {!corriendo && serie.length === 0 && (
        <p className="text-[11px] leading-snug text-slate-500">
          Cada muestra es una consulta a la OLT, por eso no arranca solo. Se detiene al salir de
          esta pantalla.
        </p>
      )}
    </div>
  )
}

function Medida({ titulo, valor, color }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
      <p className="text-[11px] text-slate-500">{titulo}</p>
      <p className={`text-xl font-semibold ${color}`}>
        {valor == null ? <span className="text-slate-600">—</span> : `${valor.toFixed(2)} Mbps`}
      </p>
    </div>
  )
}
