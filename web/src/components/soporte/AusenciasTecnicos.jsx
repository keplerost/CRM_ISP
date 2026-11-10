import { useCallback, useEffect, useState } from 'react'
import { CalendarOff, Plus, Trash2 } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { useConfirmar } from '../../lib/confirmar'
import { hoyLocal, TIPOS_AUSENCIA } from '../../lib/soporte'
import { Button, Card, Field, Input, Modal, Select } from '../ui'

/**
 * Descanso médico, vacaciones, permiso (migración 230).
 *
 * Se carga una vez, de una fecha a otra, y mientras dure el técnico sale en el
 * panel como "Descanso médico hasta el 15/11" en vez de figurar trabajando con
 * su cuadrilla. Tampoco le llega el "No vayas" de la oficina.
 *
 * Se muestran las de hoy en adelante: las pasadas ya no cambian nada.
 */

const fecha = (f) =>
  new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString('es-EC', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })

export default function AusenciasTecnicos({ tecnicos = [], puedeCargar = false, onCambio, onError }) {
  const confirmar = useConfirmar()
  const [ausencias, setAusencias] = useState(null)
  const [nueva, setNueva] = useState(null)
  const [guardando, setGuardando] = useState(false)
  const hoy = hoyLocal()

  const recargar = useCallback(async () => {
    const { data, error } = await supabase
      .from('tecnico_ausencias')
      .select('*')
      .gte('hasta', hoy)
      .order('desde')
    // Sin la 230 la tabla no existe: la tarjeta no se dibuja.
    setAusencias(error ? false : (data ?? []))
  }, [hoy])

  useEffect(() => {
    recargar()
  }, [recargar])

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    const { error } = await supabase.from('tecnico_ausencias').insert({
      tecnico_id: nueva.tecnico_id,
      tipo: nueva.tipo,
      desde: nueva.desde,
      hasta: nueva.hasta,
      nota: nueva.nota.trim() || null,
    })
    setGuardando(false)
    if (error) return onError?.(error)
    setNueva(null)
    await recargar()
    onCambio?.()
  }

  async function borrar(a, nombre) {
    const ok = await confirmar({
      titulo: 'Quitar la ausencia',
      mensaje: `¿Quitar ${TIPOS_AUSENCIA[a.tipo].toLowerCase()} de ${nombre}? Vuelve a contar como presente esos días.`,
      etiquetaAccion: 'Quitar',
    })
    if (!ok) return
    const { error } = await supabase.from('tecnico_ausencias').delete().eq('id', a.id)
    if (error) return onError?.(error)
    await recargar()
    onCambio?.()
  }

  if (ausencias === false) return null
  const nombreDe = (id) => tecnicos.find((t) => t.id === id)?.nombre ?? '—'

  return (
    <Card
      title="Ausencias"
      icon={CalendarOff}
      subtitle="Descanso médico, vacaciones o permiso: mientras dure no figura trabajando con su cuadrilla"
      actions={
        puedeCargar && (
          <Button
            variante="primario"
            icon={Plus}
            onClick={() => setNueva({ tecnico_id: '', tipo: 'descanso_medico', desde: hoy, hasta: hoy, nota: '' })}
          >
            Registrar
          </Button>
        )
      }
    >
      {ausencias === null ? (
        <p className="p-4 text-sm text-slate-500">Cargando…</p>
      ) : !ausencias.length ? (
        <p className="p-4 text-sm text-slate-500">Nadie ausente de hoy en adelante.</p>
      ) : (
        <ul className="divide-y divide-slate-800 px-4">
          {ausencias.map((a) => {
            const enCurso = a.desde <= hoy
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-100">
                    <b>{nombreDe(a.tecnico_id)}</b> · {TIPOS_AUSENCIA[a.tipo]}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {a.desde === a.hasta ? fecha(a.desde) : `del ${fecha(a.desde)} al ${fecha(a.hasta)}`}
                    {a.nota && ` · ${a.nota}`}
                  </p>
                </div>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[11px] ${
                    enCurso ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-slate-700 text-slate-400'
                  }`}
                >
                  {enCurso ? 'Hoy no está' : 'Próxima'}
                </span>
                {puedeCargar && (
                  <Button variante="fantasma" icon={Trash2} onClick={() => borrar(a, nombreDe(a.tecnico_id))} />
                )}
              </li>
            )
          })}
        </ul>
      )}

      <Modal abierto={Boolean(nueva)} titulo="Registrar ausencia" onCerrar={() => setNueva(null)}>
        {nueva && (
          <form onSubmit={guardar} className="space-y-4">
            <Field label="Técnico">
              <Select
                value={nueva.tecnico_id}
                onChange={(e) => setNueva((n) => ({ ...n, tecnico_id: e.target.value }))}
                required
              >
                <option value="">— elegí —</option>
                {tecnicos
                  .filter((t) => t.activo)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.nombre}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Motivo">
              <Select value={nueva.tipo} onChange={(e) => setNueva((n) => ({ ...n, tipo: e.target.value }))}>
                {Object.entries(TIPOS_AUSENCIA).map(([v, l]) => (
                  <option key={v} value={v}>
                    {v === 'otro' ? 'Otro' : l}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Desde">
                <Input
                  type="date"
                  value={nueva.desde}
                  onChange={(e) =>
                    setNueva((n) => ({ ...n, desde: e.target.value, hasta: n.hasta < e.target.value ? e.target.value : n.hasta }))
                  }
                  required
                />
              </Field>
              <Field label="Hasta" hint="incluido">
                <Input
                  type="date"
                  value={nueva.hasta}
                  min={nueva.desde}
                  onChange={(e) => setNueva((n) => ({ ...n, hasta: e.target.value }))}
                  required
                />
              </Field>
            </div>
            <Field label="Nota" hint="opcional">
              <Input
                value={nueva.nota}
                onChange={(e) => setNueva((n) => ({ ...n, nota: e.target.value }))}
                placeholder="Ej.: certificado del IESS por 5 días"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variante="fantasma" type="button" onClick={() => setNueva(null)}>
                Cancelar
              </Button>
              <Button variante="primario" type="submit" cargando={guardando} disabled={!nueva.tecnico_id}>
                Registrar
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </Card>
  )
}
