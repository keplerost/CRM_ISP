import { useState } from 'react'
import { AlertTriangle, Eye, Scissors, Undo2 } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, ErrorBanner } from '../ui'

/**
 * A quién se cortaría hoy, sin cortar a nadie.
 *
 * ── Por qué esta pantalla no es opcional ──
 *
 * Porque es la única tarea que deja gente sin internet, y el error más probable
 * no es del programa: es un abonado con sus meses mal puestos en la ficha. El
 * que paga cada tres meses configurado en uno se corta el primer mes, y no hay
 * nada que lo detecte salvo mirar la lista antes.
 *
 * Se muestran las dos columnas —a quién se corta y a quién se reconecta— porque
 * la tarea hace las dos cosas y la segunda es la que da confianza para encender
 * la primera.
 */
export default function MoraPrueba() {
  const [r, setR] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState(null)

  const mirar = async () => {
    setCargando(true)
    setError(null)
    try {
      setR(await api.tareas.simularMora())
    } catch (e) {
      setError(e)
    } finally {
      setCargando(false)
    }
  }

  const cortar = r?.pendientes_corte ?? []
  const reconectar = r?.pendientes_reconexion ?? []

  return (
    <div className="mt-2 space-y-2">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <Button icon={Eye} cargando={cargando} onClick={mirar} className="py-1.5 text-xs">
        Ver a quién se cortaría hoy
      </Button>

      {r && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge color={cortar.length ? 'rojo' : 'gris'}>
              <Scissors size={10} className="mr-1 inline" />
              {cortar.length} a cortar
            </Badge>
            <Badge color={reconectar.length ? 'verde' : 'gris'}>
              <Undo2 size={10} className="mr-1 inline" />
              {reconectar.length} a reconectar
            </Badge>
          </div>

          {cortar.length === 0 && reconectar.length === 0 && (
            <p className="text-xs text-slate-500">
              Hoy no hay nada que hacer. Puede ser que nadie haya pasado su umbral de meses, o que
              no haya facturas vencidas todavía.
            </p>
          )}

          {cortar.length > 0 && (
            <div className="rounded-lg border border-rose-900/60">
              <p className="border-b border-rose-900/40 px-3 py-1.5 text-[11px] text-rose-400">
                Se quedarían sin internet
              </p>
              <div className="max-h-56 overflow-auto">
                <table className="w-full text-xs">
                  <tbody>
                    {cortar.map((c) => (
                      <tr key={c.cliente_id} className="border-b border-slate-800/60 last:border-0">
                        <td className="px-2 py-1.5 text-slate-200">{c.nombre}</td>
                        <td className="px-2 py-1.5 font-mono text-slate-500">{c.ip}</td>
                        <td className="px-2 py-1.5 tabular-nums text-slate-400">
                          ${Number(c.saldo).toFixed(2)}
                        </td>
                        <td className="px-2 py-1.5 text-slate-500">
                          {/* La fecha de corte y cuánto se pasó de ella: es lo
                              que permite ver de un vistazo si la ficha está bien
                              puesta, sin ir a buscar la factura.

                              Se habla en DÍAS porque así se habla del atraso en
                              la oficina: "está a cuarenta y cinco días", no
                              "tiene un mes y medio". */}
                          {c.fecha_corte && `se cortaba el ${c.fecha_corte} · `}
                          {c.dias_de_atraso != null
                            ? `${c.dias_de_atraso} días de atraso`
                            : `${c.meses_de_atraso ?? c.meses_sin_pago} meses de atraso`}
                          {c.dias_gracia > 0 && ` · ${c.dias_gracia} días de gracia`}
                          {/* El caso que motivó la 153: atrasado meses, pero con
                              un abono reciente que antes lo salvaba del corte. */}
                          {c.meses_sin_pago != null
                            && c.meses_de_atraso != null
                            && c.meses_sin_pago < c.meses_de_atraso && (
                            <span className="ml-1 text-amber-500">
                              (abonó algo hace {c.meses_sin_pago}{' '}
                              {c.meses_sin_pago === 1 ? 'mes' : 'meses'}, sigue debiendo)
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {reconectar.length > 0 && (
            <div className="rounded-lg border border-emerald-900/60">
              <p className="border-b border-emerald-900/40 px-3 py-1.5 text-[11px] text-emerald-400">
                Recuperarían el servicio
              </p>
              <div className="max-h-40 overflow-auto">
                <table className="w-full text-xs">
                  <tbody>
                    {reconectar.map((c) => (
                      <tr key={c.cliente_id} className="border-b border-slate-800/60 last:border-0">
                        <td className="px-2 py-1.5 text-slate-200">{c.nombre}</td>
                        <td className="px-2 py-1.5 font-mono text-slate-500">{c.ip}</td>
                        <td className="px-2 py-1.5 tabular-nums text-slate-400">
                          ${Number(c.saldo).toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {cortar.length > 0 && (
            <Aviso tipo="alerta">
              <AlertTriangle size={13} className="mr-1 inline" />
              Revisá la columna de la derecha antes de encender: si alguno tiene un acuerdo de pagar
              cada varios meses, corregile los meses en su ficha —Facturación → Configuración →
              Aplica corte— y volvé a mirar.
            </Aviso>
          )}
        </>
      )}
    </div>
  )
}
