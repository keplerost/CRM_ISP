import { useEffect, useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { supabase } from '../../lib/supabaseClient'
import { ESTADOS_NODO, duracion } from '../../lib/red'
import { Aviso, Badge, Cargando, Table } from '../ui'

/**
 * Historial de un nodo: cuándo cambió de estado y con qué latencia.
 *
 * Es importante saber qué NO es esto: no es un gráfico de ping continuo. El
 * monitoreo guarda un intervalo por estado y no una muestra por sondeo —una
 * fila por minuto serían 43.000 por nodo al mes para contestar "¿cuánto estuvo
 * caído?"—, así que cada punto es la última latencia medida dentro de ese
 * tramo.
 *
 * Se dice acá abajo en vez de dibujar una línea suave que aparente una
 * resolución que no existe: un gráfico que miente sobre su propia precisión es
 * peor que no tenerlo.
 */
export default function HistorialNodo({ nodo }) {
  const [eventos, setEventos] = useState([])
  const [cargando, setCargando] = useState(true)

  useEffect(() => {
    let vigente = true
    setCargando(true)

    supabase
      .from('v_nodo_eventos')
      .select('*')
      .eq('nodo_id', nodo.id)
      .order('desde', { ascending: false })
      .limit(60)
      .then(({ data }) => {
        if (!vigente) return
        setEventos(data ?? [])
        setCargando(false)
      })

    return () => {
      vigente = false
    }
  }, [nodo.id])

  if (cargando) return <Cargando texto="Cargando el historial…" />

  if (eventos.length === 0) {
    return (
      <Aviso>
        Todavía no hay historial de {nodo.nombre}. Se llena cuando el monitoreo lo sondea: con el
        watchdog apagado, solo cuando alguien aprieta “Sondear ahora”.
      </Aviso>
    )
  }

  const conLatencia = [...eventos]
    .filter((e) => e.latencia_ms != null)
    .reverse()
    .map((e) => ({
      cuando: new Date(e.desde).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' }),
      ms: Number(e.latencia_ms),
      estado: e.estado,
    }))

  const caidas = eventos.filter((e) => e.estado === 'down')
  const totalCaido = caidas.reduce((s, e) => s + Number(e.minutos ?? 0), 0)

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3 text-sm">
        <Dato etiqueta="Uptime 30 días" valor={nodo.uptime_pct != null ? `${nodo.uptime_pct}%` : '—'} />
        <Dato etiqueta="Caídas registradas" valor={caidas.length} />
        <Dato etiqueta="Tiempo caído" valor={duracion(totalCaido)} />
      </div>

      {conLatencia.length >= 2 ? (
        <div className="h-52 w-full">
          <ResponsiveContainer>
            <LineChart data={conLatencia} margin={{ top: 8, right: 8, bottom: 4, left: -12 }}>
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
              <XAxis dataKey="cuando" tick={{ fill: '#64748b', fontSize: 10 }} minTickGap={40} />
              <YAxis tick={{ fill: '#64748b', fontSize: 10 }} unit=" ms" />
              <Tooltip
                contentStyle={{
                  background: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: '#94a3b8' }}
                formatter={(v) => [`${v} ms`, 'Latencia']}
              />
              <Line
                type="monotone"
                dataKey="ms"
                stroke="#38bdf8"
                strokeWidth={2}
                dot={{ r: 3, fill: '#38bdf8' }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <Aviso>
          Hace falta más de una medición para dibujar el gráfico. Con el watchdog encendido se llena
          solo.
        </Aviso>
      )}

      <p className="text-[11px] text-slate-500">
        Cada punto es la última latencia medida dentro de un tramo de estado, no una muestra por
        ping: el monitoreo guarda intervalos y no una fila por sondeo.
      </p>

      <Table
        columnas={['Estado', 'Desde', 'Hasta', 'Duración', 'Latencia', 'Causa']}
        filas={eventos}
        renderFila={(e) => (
          <tr key={e.id} className="text-slate-300">
            <td className="px-3 py-2">
              <Badge
                color={
                  e.estado === 'down'
                    ? 'rojo'
                    : e.estado === 'warning'
                      ? 'ambar'
                      : e.estado === 'up'
                        ? 'verde'
                        : 'gris'
                }
              >
                {ESTADOS_NODO[e.estado]?.label ?? e.estado}
              </Badge>
            </td>
            <td className="px-3 py-2 text-xs">{new Date(e.desde).toLocaleString()}</td>
            <td className="px-3 py-2 text-xs">
              {e.hasta ? new Date(e.hasta).toLocaleString() : <span className="text-sky-400">en curso</span>}
            </td>
            <td className="px-3 py-2 text-xs">{duracion(e.minutos)}</td>
            <td className="px-3 py-2 text-xs">{e.latencia_ms != null ? `${e.latencia_ms} ms` : '—'}</td>
            <td className="px-3 py-2 text-xs">
              {e.causado_por ? (
                <span className="text-slate-500">cayó {e.causado_por}</span>
              ) : (
                <span className="text-slate-600">—</span>
              )}
            </td>
          </tr>
        )}
      />
    </div>
  )
}

function Dato({ etiqueta, valor }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wider text-slate-500">{etiqueta}</p>
      <p className="text-lg font-semibold text-slate-100">{valor}</p>
    </div>
  )
}
