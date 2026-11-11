import { useCallback, useEffect, useState } from 'react'
import { Settings2 } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { hoyLocal } from '../../lib/soporte'
import { ESTADOS_OBRA, fmt, leerIndicadores, periodo } from '../../lib/obras'
import { Badge, Button, Card, ErrorBanner, Field, Input, Modal, SkeletonTabla } from '../ui'

/**
 * Los ocho indicadores de cada cuadrilla que construye (migración 232).
 *
 * Cada tarjeta dice el número, la meta y el semáforo con palabras —"Bien",
 * "Atención", "Mal"—, no solo con color: se mira en el celular al sol.
 */

const PERIODOS = [
  { clave: 'semana', label: 'Esta semana' },
  { clave: 'semana_pasada', label: 'Semana pasada' },
  { clave: 'mes', label: 'Este mes' },
  { clave: 'mes_pasado', label: 'Mes pasado' },
  { clave: 'trimestre', label: 'Últimos 90 días' },
]

const SEMAFORO = {
  bien: { label: 'Bien', punto: 'bg-emerald-500', borde: 'border-emerald-500/40' },
  atencion: { label: 'Atención', punto: 'bg-amber-500', borde: 'border-amber-500/50' },
  mal: { label: 'Mal', punto: 'bg-rose-500', borde: 'border-rose-500/50' },
  sin_datos: { label: 'Sin datos', punto: 'bg-slate-600', borde: 'border-slate-800' },
}

const CAMPOS_CONFIG = [
  { k: 'potencia_min_dbm', label: 'Potencia mínima en la NAP (dBm)', paso: '0.1' },
  { k: 'perdida_fusion_max_db', label: 'Pérdida máxima por fusión (dB)', paso: '0.01' },
  { k: 'meta_a_tiempo_pct', label: 'Obras a tiempo (%)', paso: '1' },
  { k: 'merma_max_pct', label: 'Merma de material tolerada (%)', paso: '1' },
  { k: 'apoyo_max_pct', label: 'Días en tickets, máximo (%)', paso: '1' },
  { k: 'dias_fallas', label: 'Días después de entregar para contar fallas', paso: '1' },
  { k: 'meta_metros_dia', label: 'Metros de fibra por día (0 = sin meta)', paso: '1' },
]

export default function IndicadoresObras({ puedeConfigurar = false, onAbrirObra }) {
  const hoy = hoyLocal()
  const [clave, setClave] = useState('mes')
  const [rango, setRango] = useState(() => periodo('mes', hoy))
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [config, setConfig] = useState(null)

  const cargar = useCallback(async () => {
    setDatos(null)
    const { data, error: e } = await supabase.rpc('indicadores_obras', { p_desde: rango.desde, p_hasta: rango.hasta })
    setError(e ?? null)
    setDatos(e ? { cuadrillas: [] } : data)
  }, [rango])

  useEffect(() => {
    cargar()
  }, [cargar])

  async function guardarConfig(e) {
    e.preventDefault()
    const cambios = Object.fromEntries(CAMPOS_CONFIG.map(({ k }) => [k, Number(config[k])]))
    const { error: err } = await supabase
      .from('obras_config')
      .update({ ...cambios, actualizado_en: new Date().toISOString() })
      .eq('id', true)
    if (err) return setError(err)
    setConfig(null)
    cargar()
  }

  const cfg = datos?.config ?? {}

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />
      <div className="flex flex-wrap items-end gap-2">
        {PERIODOS.map((p) => (
          <button
            key={p.clave}
            type="button"
            onClick={() => {
              setClave(p.clave)
              setRango(periodo(p.clave, hoy))
            }}
            className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold ${
              clave === p.clave ? 'border-sky-500 bg-sky-500/10 text-sky-400' : 'border-slate-700 text-slate-400'
            }`}
          >
            {p.label}
          </button>
        ))}
        <div className="flex items-end gap-2">
          <Field label="Desde">
            <Input
              type="date"
              value={rango.desde}
              max={rango.hasta}
              onChange={(e) => {
                setClave('otro')
                setRango((r) => ({ ...r, desde: e.target.value }))
              }}
            />
          </Field>
          <Field label="Hasta">
            <Input
              type="date"
              value={rango.hasta}
              min={rango.desde}
              onChange={(e) => {
                setClave('otro')
                setRango((r) => ({ ...r, hasta: e.target.value }))
              }}
            />
          </Field>
        </div>
        {puedeConfigurar && (
          <Button variante="fantasma" icon={Settings2} className="ml-auto" onClick={() => setConfig({ ...cfg })} disabled={!datos}>
            Metas
          </Button>
        )}
      </div>

      {!datos ? (
        <SkeletonTabla filas={4} columnas={4} />
      ) : !datos.cuadrillas?.length ? (
        <Card>
          <p className="p-6 text-center text-sm text-slate-500">
            Todavía no hay obras asignadas. Los indicadores aparecen apenas una cuadrilla tenga su primera obra.
          </p>
        </Card>
      ) : (
        datos.cuadrillas.map((c) => <Cuadrilla key={c.cuadrilla_id} c={c} cfg={cfg} onAbrirObra={onAbrirObra} />)
      )}

      <Modal abierto={Boolean(config)} titulo="Metas de los indicadores" onCerrar={() => setConfig(null)}>
        {config && (
          <form onSubmit={guardarConfig} className="space-y-3">
            {CAMPOS_CONFIG.map(({ k, label, paso }) => (
              <Field key={k} label={label}>
                <Input
                  type="number"
                  step={paso}
                  value={config[k] ?? ''}
                  onChange={(e) => setConfig((x) => ({ ...x, [k]: e.target.value }))}
                  required
                />
              </Field>
            ))}
            <div className="flex justify-end gap-2">
              <Button type="button" variante="fantasma" onClick={() => setConfig(null)}>
                Cancelar
              </Button>
              <Button type="submit" variante="primario">
                Guardar
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}

function Cuadrilla({ c, cfg, onAbrirObra }) {
  const ks = leerIndicadores(c, cfg)
  const resumen = ks.reduce((acc, k) => ({ ...acc, [k.estado]: (acc[k.estado] ?? 0) + 1 }), {})
  return (
    <Card
      title={c.cuadrilla}
      subtitle={[
        resumen.bien && `${resumen.bien} bien`,
        resumen.atencion && `${resumen.atencion} en atención`,
        resumen.mal && `${resumen.mal} mal`,
      ]
        .filter(Boolean)
        .join(' · ')}
    >
      <div className="space-y-5 p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {ks.map((k) => {
            const s = SEMAFORO[k.estado]
            return (
              <div key={k.clave} className={`rounded-xl border p-3 ${s.borde}`}>
                <p className="flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {k.titulo}
                  <span className="flex items-center gap-1 normal-case tracking-normal text-slate-400">
                    <span className={`h-2 w-2 rounded-full ${s.punto}`} aria-hidden="true" />
                    {s.label}
                  </span>
                </p>
                <p className="mt-1.5 text-lg font-bold text-slate-100">{k.valor}</p>
                <p className="mt-1 text-[11px] leading-snug text-slate-400">{k.detalle}</p>
                <p className="mt-1 text-[10.5px] text-slate-500">{k.meta}</p>
              </div>
            )
          })}
        </div>

        {c.seguridad?.detalle?.length > 0 && (
          <div className="rounded-xl border border-rose-500/40 p-3 text-[12px] text-rose-300">
            <p className="mb-1 font-semibold">Incidentes del período</p>
            <ul className="list-disc space-y-0.5 pl-4">
              {c.seguridad.detalle.map((i, n) => (
                <li key={n}>
                  {new Date(`${i.fecha}T12:00:00`).toLocaleDateString('es-EC', { day: 'numeric', month: 'short' })}: {i.nota}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-3">
          <Tabla
            titulo="Semana a semana"
            columnas={['Semana', 'Metros', 'NAP', 'Fusiones', 'Días']}
            filas={(c.semanas ?? []).map((s) => [
              `desde ${new Date(`${s.semana}T12:00:00`).toLocaleDateString('es-EC', { day: 'numeric', month: 'short' })}`,
              fmt(s.metros),
              fmt(s.naps),
              fmt(s.fusiones),
              fmt(s.dias),
            ])}
          />
          <Tabla
            titulo="Por integrante (lo que reportó)"
            columnas={['Técnico', 'Metros', 'NAP', 'Fusiones', 'Días']}
            filas={(c.por_tecnico ?? []).map((t) => [t.nombre, fmt(t.metros), fmt(t.naps), fmt(t.fusiones), fmt(t.dias)])}
          />
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Obras</p>
            {!c.obras?.length ? (
              <p className="text-[12px] text-slate-500">Ninguna abierta ni cerrada en el período.</p>
            ) : (
              <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
                {c.obras.map((o) => (
                  <li key={o.id}>
                    <button
                      type="button"
                      onClick={() => onAbrirObra?.(o.id)}
                      className="flex w-full items-center gap-2 p-2 text-left text-[12px] hover:bg-slate-800/40"
                    >
                      <span className="min-w-0 flex-1 truncate text-slate-200">
                        #{o.numero} {o.titulo}
                      </span>
                      {o.atrasada && <Badge color="rojo">Atrasada</Badge>}
                      <Badge color={ESTADOS_OBRA[o.estado]?.color}>{ESTADOS_OBRA[o.estado]?.label}</Badge>
                      <span className="w-10 text-right tabular-nums text-slate-400">{fmt(o.avance_pct)}%</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Card>
  )
}

function Tabla({ titulo, columnas, filas }) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{titulo}</p>
      {!filas.length ? (
        <p className="text-[12px] text-slate-500">Sin partes en el período.</p>
      ) : (
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-slate-500">
              {columnas.map((c, i) => (
                <th key={c} className={`py-1 font-medium ${i ? 'text-right' : 'text-left'}`}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filas.map((f, n) => (
              <tr key={n} className="border-t border-slate-800">
                {f.map((v, i) => (
                  <td key={i} className={`py-1.5 ${i ? 'text-right tabular-nums text-slate-300' : 'text-slate-200'}`}>
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
