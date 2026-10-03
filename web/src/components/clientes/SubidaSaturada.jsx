import { useEffect, useState } from 'react'
import { Upload } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Card, Table } from '../ui'

/**
 * Las veces que el abonado saturó su propia subida.
 *
 * Es la evidencia para la llamada de "anda lento": fecha, hora, cuánto subía y
 * contra qué límite. Solo aparecen los episodios que se sostuvieron el tiempo
 * de la regla; un pico suelto no queda guardado.
 *
 * Si la migración 204 no corrió, la función no existe y la tarjeta no se
 * dibuja: no saber no es lo mismo que "nunca pasó".
 */
const mbps = (n) =>
  n == null ? '—' : `${Number(n).toLocaleString('es-EC', { maximumFractionDigits: 1 })} Mbps`

function duracion(desde, hasta) {
  const min = Math.max(0, Math.round(((hasta ? new Date(hasta) : new Date()) - new Date(desde)) / 60000))
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return `${h} h ${min % 60} min`
}

export default function SubidaSaturada({ cliente }) {
  const [eventos, setEventos] = useState(null)

  useEffect(() => {
    let vigente = true
    supabase.rpc('subida_saturada_de', { p_cliente: cliente.id }).then(({ data, error }) => {
      if (vigente) setEventos(error ? null : (data ?? []))
    })
    return () => {
      vigente = false
    }
  }, [cliente.id])

  if (eventos == null) return null

  return (
    <Card
      title="Subida saturada"
      subtitle="Veces que el abonado llenó su propia subida de forma sostenida"
      icon={Upload}
    >
      <Table
        columnas={['Empezó', 'Duración', 'Subiendo', 'Pico', 'Límite']}
        filas={eventos}
        vacio="Nunca saturó su subida desde que se mide."
        renderFila={(e) => (
          <tr key={e.id} className="border-t border-slate-800 text-slate-300">
            <td className="px-3 py-2 text-xs">{new Date(e.empezo_en).toLocaleString()}</td>
            <td className="px-3 py-2 text-xs">
              {duracion(e.empezo_en, e.resuelto_en)}
              {!e.resuelto_en && <span className="ml-1 font-semibold text-red-400">· sigue ahora</span>}
            </td>
            <td className="px-3 py-2 text-xs">
              {mbps(e.detalle?.ultimo_mbps)}
              {e.detalle?.ultimo_pct != null && (
                <span className="text-slate-500"> ({Math.round(e.detalle.ultimo_pct)}%)</span>
              )}
            </td>
            <td className="px-3 py-2 text-xs">{mbps(e.detalle?.pico_mbps)}</td>
            <td className="px-3 py-2 text-xs">{mbps(e.detalle?.limite_mbps)}</td>
          </tr>
        )}
      />
    </Card>
  )
}
