import { useCallback, useEffect, useState } from 'react'
import { TrendingDown, TrendingUp, Minus } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { UMBRAL_DBM, dbm, nivel } from '../../lib/optica'
import { Cargando } from '../ui'

/**
 * Serie de potencia óptica de una ONT.
 *
 * Lo que se viene a mirar acá no es el número de hoy —ese ya está en la tabla—
 * sino la PENDIENTE. Una fibra que se degrada, un conector sucio o un empalme
 * soltándose bajan de a poco durante semanas antes de cortar. Con la lectura
 * suelta no se ven; con la línea, sí.
 *
 * Dibujado a mano en SVG en vez de traer una librería de gráficos: son cuatro
 * cálculos y una polilínea.
 */

const ALTO = 120
const ANCHO = 520

export default function HistorialOptico({ onuId, nombre }) {
  const [puntos, setPuntos] = useState(null)
  const [error, setError] = useState(null)

  const cargar = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('onu_optica_historial')
      .select('rx_dbm, tx_dbm, medida_at')
      .eq('onu_id', onuId)
      .not('rx_dbm', 'is', null)
      .order('medida_at', { ascending: true })
      .limit(500)

    if (err) {
      setError(
        err.code === '42P01'
          ? { message: 'Falta la tabla de historial óptico', hint: 'Corré la migración 41.' }
          : err,
      )
      setPuntos([])
      return
    }
    setPuntos((data ?? []).map((d) => ({ rx: Number(d.rx_dbm), at: new Date(d.medida_at) })))
  }, [onuId])

  useEffect(() => {
    cargar()
  }, [cargar])

  if (error) {
    return (
      <p className="py-3 text-xs text-amber-300">
        {error.message}
        {error.hint && <span className="text-slate-500"> — {error.hint}</span>}
      </p>
    )
  }
  if (!puntos) return <Cargando texto="Buscando el historial…" />

  if (puntos.length === 0) {
    return (
      <p className="py-3 text-xs leading-relaxed text-slate-500">
        Todavía no hay historial de esta ONT. Se va llenando con cada lectura de óptica: se guarda
        un punto cuando la señal se mueve medio dB o cuando pasan seis horas, así la serie muestra
        los cambios sin llenarse de repeticiones.
      </p>
    )
  }

  if (puntos.length === 1) {
    return (
      <p className="py-3 text-xs leading-relaxed text-slate-500">
        Un solo punto: <b className="text-slate-300">{dbm(puntos[0].rx)}</b> el{' '}
        {puntos[0].at.toLocaleString('es-EC')}. Hace falta al menos una lectura más para poder
        hablar de tendencia — con una sola no se puede saber si viene bajando.
      </p>
    )
  }

  // Escala. Se deja siempre visible el umbral, aunque la ONT esté lejos: sin él
  // no se ve cuánto margen queda.
  const valores = puntos.map((p) => p.rx)
  const min = Math.min(...valores, UMBRAL_DBM) - 1
  const max = Math.max(...valores, UMBRAL_DBM + 2) + 1
  const t0 = puntos[0].at.getTime()
  const t1 = puntos[puntos.length - 1].at.getTime()
  const rangoT = Math.max(t1 - t0, 1)

  const x = (p) => ((p.at.getTime() - t0) / rangoT) * (ANCHO - 40) + 34
  // Más negativo = peor = más abajo.
  const y = (v) => ALTO - 18 - ((v - min) / (max - min)) * (ALTO - 34)

  const linea = puntos.map((p) => `${x(p).toFixed(1)},${y(p.rx).toFixed(1)}`).join(' ')
  const delta = puntos[puntos.length - 1].rx - puntos[0].rx
  const dias = Math.max(Math.round(rangoT / 86400000), 1)

  const Icono = delta <= -1 ? TrendingDown : delta >= 1 ? TrendingUp : Minus
  const colorDelta = delta <= -3 ? 'text-rose-400' : delta <= -1 ? 'text-amber-400' : 'text-slate-400'
  const n = nivel(puntos[puntos.length - 1].rx)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="text-slate-400">
          {nombre && <span className="text-slate-300">{nombre} · </span>}
          {puntos.length} lecturas en {dias} {dias === 1 ? 'día' : 'días'}
        </span>
        <span className={`flex items-center gap-1 ${colorDelta}`}>
          <Icono size={13} />
          {delta > 0 ? '+' : ''}
          {delta.toFixed(2)} dB
          {delta <= -3 && <b className="ml-1">— viene degradándose</b>}
        </span>
        <span className={n.punto === 'bg-rose-500' ? 'text-rose-300' : 'text-slate-400'}>
          ahora {dbm(puntos[puntos.length - 1].rx)}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${ANCHO} ${ALTO}`}
        className="w-full t-panel"
        preserveAspectRatio="none"
      >
        {/* Umbral: por debajo de esta línea hay pérdida de paquetes. */}
        {UMBRAL_DBM >= min && UMBRAL_DBM <= max && (
          <>
            <line
              x1="34"
              x2={ANCHO - 6}
              y1={y(UMBRAL_DBM)}
              y2={y(UMBRAL_DBM)}
              stroke="rgb(244 63 94 / 0.5)"
              strokeDasharray="4 3"
            />
            <text x="36" y={y(UMBRAL_DBM) - 3} fill="rgb(244 63 94 / 0.7)" fontSize="8">
              {UMBRAL_DBM} dBm
            </text>
          </>
        )}

        {/* Ejes con el rango real */}
        <text x="2" y={y(max) + 8} fill="rgb(100 116 139)" fontSize="8">
          {max.toFixed(0)}
        </text>
        <text x="2" y={y(min)} fill="rgb(100 116 139)" fontSize="8">
          {min.toFixed(0)}
        </text>

        <polyline
          points={linea}
          fill="none"
          stroke="rgb(56 189 248)"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />

        {puntos.map((p, i) => (
          <circle
            key={i}
            cx={x(p)}
            cy={y(p.rx)}
            r="2"
            fill={p.rx < UMBRAL_DBM ? 'rgb(244 63 94)' : 'rgb(56 189 248)'}
          >
            <title>{`${p.at.toLocaleString('es-EC')} — ${p.rx.toFixed(2)} dBm`}</title>
          </circle>
        ))}
      </svg>

      <div className="flex justify-between text-[10px] text-slate-600">
        <span>{puntos[0].at.toLocaleDateString('es-EC')}</span>
        <span>{puntos[puntos.length - 1].at.toLocaleDateString('es-EC')}</span>
      </div>
    </div>
  )
}
