import { useCallback, useEffect, useMemo, useState } from 'react'
import { Info, TriangleAlert } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { Card, ErrorBanner, Select, SkeletonTabla } from '../components/ui'

/**
 * Comparar el rendimiento de los técnicos.
 *
 * ── Lo que esta pantalla se niega a hacer ──
 *
 * Un ranking. No hay puesto, no hay puntaje único, no hay medalla.
 *
 * No es escrúpulo: es que un número único obliga a ponderar cosas que no se
 * pueden sumar. ¿Cuánto vale un punto de puntualidad contra un punto de
 * reincidencia? Cualquier respuesta es arbitraria, y una vez que existe el
 * puntaje, la gente trabaja para el puntaje.
 *
 * Lo que sí hace es poner los números uno al lado del otro CON su contexto, y
 * dejar la conclusión en manos de quien conoce las rutas.
 *
 * ── Por qué los kilómetros van al lado de la productividad ──
 *
 * Porque el técnico de la zona rural maneja el triple, tarda más por trabajo,
 * gasta más drop y llega tarde más seguido — y puede ser el mejor de los dos.
 * Comparar "trabajos por mes" sin mirar "km por trabajo" premia a quien tiene
 * la ruta corta.
 *
 * Cuando la diferencia de kilómetros entre técnicos es grande, la pantalla lo
 * dice sola. No queda como una advertencia al pie que nadie lee.
 */

/** Cuánta diferencia de km por trabajo hace que la comparación deje de ser justa. */
const DIFERENCIA_SOSPECHOSA = 1.6

export default function DesempenoEquipoPage() {
  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [mes, setMes] = useState(null)

  const recargar = useCallback(async () => {
    setCargando(true)
    const { data, error: err } = await supabase
      .from('v_desempeno_tecnico')
      .select('*')
      .order('mes', { ascending: false })
    setError(err ?? null)
    setFilas(data ?? [])
    setCargando(false)
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  const meses = useMemo(
    () => [...new Set(filas.map((f) => f.mes))].sort().reverse(),
    [filas],
  )
  const activo = mes ?? meses[0] ?? null
  const delMes = useMemo(
    () => filas.filter((f) => f.mes === activo).sort((a, b) => b.trabajos - a.trabajos),
    [filas, activo],
  )

  /**
   * ¿Se pueden comparar estas filas entre sí?
   *
   * Si el que más maneja por trabajo hace bastante más kilómetros que el que
   * menos, están haciendo rutas distintas y los promedios no se miden con la
   * misma vara.
   */
  const rutasDispares = useMemo(() => {
    const kms = delMes.map((f) => f.km_por_trabajo).filter((k) => k > 0)
    if (kms.length < 2) return false
    return Math.max(...kms) / Math.min(...kms) >= DIFERENCIA_SOSPECHOSA
  }, [delMes])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Desempeño del equipo</h1>
          <p className="text-sm text-slate-400">
            Los mismos números que ve cada técnico de sí mismo, puestos uno al lado del otro.
          </p>
        </div>
        {meses.length > 0 && (
          <Select value={activo ?? ''} onChange={(e) => setMes(e.target.value)} className="w-48">
            {meses.map((m) => (
              <option key={m} value={m}>
                {new Date(`${m}T12:00:00`).toLocaleDateString('es-EC', {
                  month: 'long',
                  year: 'numeric',
                })}
              </option>
            ))}
          </Select>
        )}
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {/* La advertencia aparece cuando de verdad aplica, con el número que la
          motiva. Una nota fija al pie se vuelve invisible en dos días. */}
      {rutasDispares && (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
          <TriangleAlert size={17} className="mt-0.5 shrink-0 text-amber-400" />
          <p className="text-[13px] text-amber-200">
            <b>Estas filas no se comparan directamente.</b> Hay técnicos que manejan mucho más por
            trabajo que otros: están cubriendo rutas distintas. Mirá la columna{' '}
            <b>km/trabajo</b> antes de sacar conclusiones sobre la productividad.
          </p>
        </div>
      )}

      <Card>
        {cargando ? (
          <SkeletonTabla filas={4} columnas={8} />
        ) : delMes.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">
            Todavía no hay trabajos cerrados con técnico asignado.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="pb-2 pr-4 font-medium">Técnico</th>
                  <th className="pb-2 pr-4 font-medium">Trabajos</th>
                  <th className="pb-2 pr-4 font-medium">Puntualidad</th>
                  <th className="pb-2 pr-4 font-medium">Tiempo</th>
                  <th className="pb-2 pr-4 font-medium">Señal óptima</th>
                  <th className="pb-2 pr-4 font-medium">Volvieron a llamar</th>
                  <th className="pb-2 pr-4 font-medium">Cable/inst.</th>
                  <th className="pb-2 pr-4 font-medium">km/trabajo</th>
                </tr>
              </thead>
              <tbody>
                {delMes.map((f) => (
                  <tr key={f.tecnico_id} className="border-t border-slate-800">
                    <td className="py-3 pr-4">
                      <p className="font-medium text-slate-100">
                        {String(f.tecnico ?? '—').trim()}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        {f.instalaciones} inst · {f.tickets} tickets
                        {f.visitas_fallidas > 0 && ` · ${f.visitas_fallidas} fallidas`}
                      </p>
                    </td>
                    <td className="py-3 pr-4 text-lg font-semibold tabular-nums text-slate-100">
                      {f.trabajos}
                    </td>
                    <Celda valor={f.pct_puntual} sufijo="%" base={f.con_hora_y_llegada} />
                    <Celda valor={f.minutos_mediana} sufijo=" min" base={f.trabajos} />
                    <Celda valor={f.pct_senal_optima} sufijo="%" base={f.con_medicion} />
                    <Celda
                      valor={f.pct_reincidencia}
                      sufijo="%"
                      base={f.trabajos}
                      detalle={f.trabajos_con_reclamo ? `${f.trabajos_con_reclamo} clientes` : null}
                    />
                    <Celda valor={f.metros_por_instalacion} sufijo=" m" base={f.instalaciones} />
                    <Celda
                      valor={f.km_por_trabajo}
                      sufijo=" km"
                      base={f.dias_con_km}
                      unidadBase="días"
                      resaltar
                    />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-3 flex items-start gap-2 border-t border-slate-800 pt-3 text-[11px] text-slate-500">
          <Info size={13} className="mt-0.5 shrink-0" />
          <p>
            El número chico debajo de cada valor es sobre cuántos casos se calculó. Un 100% sobre
            dos trabajos medidos no dice lo mismo que sobre cuarenta. Donde hay un guión, ese
            técnico todavía no generó el dato — no es un cero.
          </p>
        </div>
      </Card>
    </div>
  )
}

/**
 * Una celda con su denominador debajo.
 *
 * Sin base se muestra un guión y no un cero: la diferencia entre "no midió" y
 * "midió mal" es toda la diferencia cuando alguien usa esto para evaluar a una
 * persona.
 */
function Celda({ valor, sufijo = '', base, unidadBase = '', detalle, resaltar = false }) {
  if (valor == null || !base) {
    return (
      <td className="py-3 pr-4">
        <span className="text-slate-600">—</span>
      </td>
    )
  }
  return (
    <td className="py-3 pr-4">
      <p className={`tabular-nums ${resaltar ? 'font-medium text-sky-300' : 'text-slate-100'}`}>
        {valor}
        {sufijo}
      </p>
      <p className="text-[11px] text-slate-500">
        de {base} {unidadBase}
      </p>
      {detalle && <p className="text-[11px] text-slate-600">{detalle}</p>}
    </td>
  )
}
