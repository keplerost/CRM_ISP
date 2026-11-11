import { useMemo, useState } from 'react'

import { supabase } from '../../lib/supabaseClient'
import { OPTICA_BASE, compararMedido } from '../../lib/hilos'
import { Button, Field, Input, Modal } from '../ui'

/**
 * El presupuesto óptico de todas las cajas NAP (migración 237): cuánto debería
 * llegar, cuánto margen queda, y lo medido en campo al lado. Las que no tienen
 * camino hasta un puerto PON dicen qué les falta.
 */

const ORDEN = { mal: 0, atencion: 1, sin_camino: 2, bien: 3 }
const ESTADO = {
  bien: { label: 'Bien', clase: 'text-emerald-400' },
  atencion: { label: 'Justo', clase: 'text-amber-400' },
  mal: { label: 'No alcanza', clase: 'text-rose-400' },
  sin_camino: { label: 'Sin camino', clase: 'text-slate-400' },
}

const CAMPOS = [
  ['atenuacion_db_km', 'Atenuación de la fibra (dB/km)', '0.01'],
  ['perdida_fusion', 'Pérdida por fusión (dB)', '0.01'],
  ['perdida_conector', 'Pérdida por conector (dB)', '0.01'],
  ['sensibilidad_dbm', 'Sensibilidad de la ONU (dBm)', '0.5'],
  ['margen_min_db', 'Margen mínimo (dB)', '0.5'],
  ['drop_m', 'Acometida típica (m)', '10'],
  ['tolerancia_db', 'Diferencia medido/calculado que avisa (dB)', '0.5'],
]

export default function PresupuestoOptico({ naps, presupuestos, medidos, optica, edita, onIr, onCerrar, onCambio, onError }) {
  const [filtro, setFiltro] = useState('todas')
  const [cfg, setCfg] = useState(null)

  const filas = useMemo(() => {
    return naps
      .map((e) => {
        const p = presupuestos.get(e.id)
        const m = medidos.get(e.id)
        const medido = m?.medido_dbm ?? m?.rx_promedio ?? null
        return { e, p, medido, cmp: compararMedido(p, medido, optica) }
      })
      .filter(
        (f) =>
          filtro === 'todas' ||
          (filtro === 'con' && f.p?.ok) ||
          (filtro === 'sin' && !f.p?.ok) ||
          (filtro === 'alerta' && (f.cmp?.alerta || ['mal', 'atencion'].includes(f.p?.estado))),
      )
      .sort((a, b) => ORDEN[a.p?.estado ?? 'sin_camino'] - ORDEN[b.p?.estado ?? 'sin_camino'] || a.e.nombre.localeCompare(b.e.nombre))
  }, [naps, presupuestos, medidos, optica, filtro])

  const cuenta = (pred) => naps.filter((e) => pred(presupuestos.get(e.id))).length

  async function guardar(e) {
    e.preventDefault()
    const fila = Object.fromEntries(CAMPOS.map(([k]) => [k, Number(cfg[k])]))
    const { error } = await supabase.from('planta_optica').update({ ...fila, actualizado_en: new Date().toISOString() }).eq('id', true)
    if (error) return onError(error)
    setCfg(null)
    onCambio()
  }

  return (
    <Modal abierto titulo="Presupuesto óptico de las cajas" onCerrar={onCerrar} ancho="max-w-5xl">
      <div className="space-y-3 text-[12px]">
        <div className="flex flex-wrap items-center gap-2">
          {[
            ['todas', `Todas (${naps.length})`],
            ['con', `Con camino al PON (${cuenta((p) => p?.ok)})`],
            ['alerta', `Para mirar (${cuenta((p) => ['mal', 'atencion'].includes(p?.estado))})`],
            ['sin', `Sin camino (${cuenta((p) => !p?.ok)})`],
          ].map(([k, l]) => (
            <button
              key={k}
              type="button"
              onClick={() => setFiltro(k)}
              className={`rounded-full border px-3 py-1 font-semibold ${filtro === k ? 'border-sky-500 bg-sky-500/10 text-sky-400' : 'border-slate-700 text-slate-400'}`}
            >
              {l}
            </button>
          ))}
          {edita && (
            <Button variante="fantasma" className="ml-auto" onClick={() => setCfg({ ...OPTICA_BASE, ...optica })}>
              Valores del cálculo
            </Button>
          )}
        </div>
        <p className="text-slate-500">
          Fibra {optica?.atenuacion_db_km ?? OPTICA_BASE.atenuacion_db_km} dB/km · fusión {optica?.perdida_fusion ?? 0.1} dB · conector{' '}
          {optica?.perdida_conector ?? 0.5} dB · sensibilidad {optica?.sensibilidad_dbm ?? -27} dBm · margen mínimo {optica?.margen_min_db ?? 3} dB.
        </p>

        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full">
            <thead className="sticky top-0 bg-white">
              <tr className="text-left text-slate-500">
                <th className="py-1.5 font-medium">Caja</th>
                <th className="py-1.5 font-medium">PON</th>
                <th className="py-1.5 text-right font-medium">Pérdida</th>
                <th className="py-1.5 text-right font-medium">En la caja</th>
                <th className="py-1.5 text-right font-medium">Al abonado</th>
                <th className="py-1.5 text-right font-medium">Margen</th>
                <th className="py-1.5 text-right font-medium">Medido</th>
                <th className="py-1.5 font-medium">Estado</th>
              </tr>
            </thead>
            <tbody>
              {filas.map(({ e, p, medido, cmp }) => {
                const est = ESTADO[p?.estado ?? 'sin_camino']
                return (
                  <tr key={e.id} className="cursor-pointer border-t border-slate-800 hover:bg-slate-800/30" onClick={() => onIr(e)}>
                    <td className="py-1.5 text-slate-200">{e.nombre}</td>
                    <td className="py-1.5 text-slate-400">{p?.ok ? p.pon.nombre : '—'}</td>
                    <td className="py-1.5 text-right tabular-nums">{p?.ok ? `${p.perdidaSalida} dB` : '—'}</td>
                    <td className="py-1.5 text-right tabular-nums">{p?.ok ? `${p.rxSalida} dBm` : '—'}</td>
                    <td className="py-1.5 text-right tabular-nums">{p?.ok ? `${p.rxAbonado} dBm` : '—'}</td>
                    <td className={`py-1.5 text-right tabular-nums ${est.clase}`}>{p?.ok ? `${p.margen} dB` : '—'}</td>
                    <td className={`py-1.5 text-right tabular-nums ${cmp?.alerta ? 'text-rose-400' : ''}`}>
                      {medido != null ? `${medido} dBm` : '—'}
                      {cmp?.alerta && ` (${cmp.diferencia > 0 ? '+' : ''}${cmp.diferencia})`}
                    </td>
                    <td className={`py-1.5 ${est.clase}`} title={p?.ok ? '' : p?.error}>
                      {est.label}
                      {!p?.ok && p?.error && <span className="block max-w-[260px] truncate text-[11px] text-slate-500">{p.error}</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {cfg && (
        <Modal abierto titulo="Valores del cálculo" onCerrar={() => setCfg(null)}>
          <form onSubmit={guardar} className="space-y-3">
            {CAMPOS.map(([k, l, paso]) => (
              <Field key={k} label={l}>
                <Input type="number" step={paso} value={cfg[k] ?? ''} onChange={(e) => setCfg((v) => ({ ...v, [k]: e.target.value }))} required />
              </Field>
            ))}
            <p className="text-[11px] text-slate-500">
              B+: sensibilidad −27 dBm. C+: −30 dBm. La fibra pierde ~0,35 dB/km en 1310 nm (subida) y ~0,25 en 1490 nm (bajada).
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variante="fantasma" onClick={() => setCfg(null)}>
                Cancelar
              </Button>
              <Button type="submit" variante="primario">
                Guardar
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </Modal>
  )
}
