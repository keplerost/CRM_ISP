import { useState } from 'react'
import { RotateCcw } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { hoyLocal } from '../../lib/soporte'
import { Button, Input, Textarea } from '../ui'

/**
 * Reabrir un ticket resuelto por error (migración 240). Solo la oficina.
 *
 * Dos maneras: que el técnico lo termine ahora (vuelve a "En proceso" con la
 * llegada que tenía) o una visita nueva en otra fecha (vuelve a "Asignado").
 * En las dos se borran la solución y la firma, y el motivo queda en el historial.
 */
export default function ReabrirTicket({ t, onHecho, onError }) {
  const [abierto, setAbierto] = useState(false)
  const [modo, setModo] = useState(t.llegada_at ? 'ahora' : 'fecha')
  const [fecha, setFecha] = useState(hoyLocal())
  const [motivo, setMotivo] = useState('')
  const [enviando, setEnviando] = useState(false)

  const listo = motivo.trim().length >= 5 && (modo === 'ahora' || fecha)

  async function reabrir() {
    setEnviando(true)
    onError?.(null)
    const { error } = await supabase.rpc('reabrir_ticket', {
      p_id: t.id,
      p_motivo: motivo.trim(),
      p_fecha: modo === 'fecha' ? fecha : null,
    })
    setEnviando(false)
    if (error) return onError?.(error)
    setAbierto(false)
    setMotivo('')
    await onHecho?.()
  }

  if (!abierto) {
    return (
      <div className="mt-4 border-t border-slate-800 pt-3">
        <Button variante="fantasma" icon={RotateCcw} onClick={() => setAbierto(true)} className="text-xs">
          Reabrir ticket
        </Button>
      </div>
    )
  }

  const opcion = (valor, titulo, ayuda, deshabilitado = false) => (
    <label
      className={`flex gap-2 rounded-lg border p-2.5 text-[13px] ${
        modo === valor ? 'border-sky-500 bg-sky-500/10' : 'border-slate-700'
      } ${deshabilitado ? 'opacity-50' : 'cursor-pointer'}`}
    >
      <input
        type="radio"
        name={`reabrir-${t.id}`}
        checked={modo === valor}
        disabled={deshabilitado}
        onChange={() => setModo(valor)}
        className="mt-0.5"
      />
      <span>
        <b className="block text-slate-200">{titulo}</b>
        <span className="text-[12px] text-slate-500">{ayuda}</span>
      </span>
    </label>
  )

  return (
    <div className="mt-4 space-y-3 border-t border-slate-800 pt-3">
      <p className="text-sm font-semibold text-slate-200">Reabrir ticket</p>
      <p className="text-[12px] text-slate-500">
        Se borran la solución y la firma: el técnico tiene que volver a cerrarlo y hacer firmar al abonado. El motivo queda
        en el historial.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {opcion(
          'ahora',
          'Que lo termine ahora',
          t.llegada_at ? 'Vuelve a "En proceso" con la llegada que ya tiene.' : 'No tiene la llegada marcada.',
          !t.llegada_at,
        )}
        {opcion('fecha', 'Nueva visita', 'Vuelve a "Asignado" para la fecha que elijas, con la misma cuadrilla o técnico.')}
      </div>
      {modo === 'fecha' && (
        <div className="w-44">
          <Input type="date" value={fecha} min={hoyLocal()} onChange={(e) => setFecha(e.target.value)} />
        </div>
      )}
      <Textarea
        rows={2}
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        placeholder="Por qué se reabre (obligatorio). Ej.: el técnico lo cerró por error, el cliente sigue sin internet"
      />
      <div className="flex flex-wrap gap-2">
        <Button variante="primario" icon={RotateCcw} onClick={reabrir} cargando={enviando} disabled={!listo}>
          Reabrir
        </Button>
        <Button variante="fantasma" onClick={() => setAbierto(false)}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}
