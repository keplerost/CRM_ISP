import { useCallback, useEffect, useState } from 'react'
import { CircuitBoard, RefreshCw } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Badge, Button, Card, ErrorBanner, SkeletonTabla, Table } from '../ui'

/**
 * Placas del chasis.
 *
 * El caso que esta pantalla existe para atrapar es la placa de reserva en falla:
 * no molesta a nadie hasta el día que hace falta, y ese día ya es tarde. Por eso
 * "Standby_normal" se muestra como correcto y cualquier otra cosa como problema,
 * en vez de pintar de rojo todo lo que no diga "Normal".
 */

const colorTemp = (c) =>
  c == null ? 'text-slate-600' : c >= 60 ? 'text-rose-400' : c >= 50 ? 'text-amber-400' : 'text-emerald-400'

export default function OltPlacas({ olt }) {
  const [placas, setPlacas] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const consultar = useCallback(async () => {
    setCargando(true)
    setError(null)
    try {
      const r = await api.olt.placas(olt.id)
      setPlacas(r.placas ?? [])
    } catch (err) {
      setError(err)
      setPlacas(null)
    } finally {
      setCargando(false)
    }
  }, [olt.id])

  useEffect(() => {
    consultar()
  }, [consultar])

  const conFalla = (placas ?? []).filter((p) => !p.ok)

  return (
    <Card
      title="Placas del chasis"
      subtitle={
        placas
          ? `${placas.length} slots ocupados${conFalla.length ? ` · ${conFalla.length} con problema` : ' · todas en orden'}`
          : olt.ip_host
      }
      icon={CircuitBoard}
      actions={
        <Button icon={RefreshCw} onClick={consultar} cargando={cargando}>
          Actualizar
        </Button>
      }
    >
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        {cargando && !placas ? (
          <SkeletonTabla filas={6} columnas={5} />
        ) : !placas ? null : (
          <Table
            columnas={['Slot', 'Placa', 'Estado', 'Función', 'Temperatura']}
            filas={placas}
            vacio="El equipo no reportó placas."
            renderFila={(p) => (
              <tr key={p.slot} className={!p.ok ? 'bg-rose-500/5' : ''}>
                <td className="px-3 py-2 font-mono text-xs text-slate-400">{p.slot}</td>
                <td className="px-3 py-2 font-medium text-slate-100">{p.placa}</td>
                <td className="px-3 py-2">
                  <Badge color={p.ok ? (p.reserva ? 'azul' : 'verde') : 'rojo'}>{p.estado}</Badge>
                  {p.reserva && (
                    <span className="ml-2 text-[11px] text-slate-500">
                      en espera, es lo correcto
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-slate-400">
                  {p.servicio ? 'Servicio PON' : p.control ? 'Control' : 'Auxiliar'}
                </td>
                <td className={`px-3 py-2 text-sm font-medium ${colorTemp(p.celsius)}`}>
                  {p.celsius != null ? `${p.celsius} °C` : '—'}
                </td>
              </tr>
            )}
          />
        )}
      </div>
    </Card>
  )
}
