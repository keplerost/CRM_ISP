import { useState } from 'react'
import { CalendarClock, X } from 'lucide-react'
import { Button, Field, Input, Textarea } from '../ui'
import { campoApi } from '../../lib/colaCampo'

/**
 * La visita que no se pudo hacer.
 *
 * ── Por qué existe ──
 *
 * El asistente solo sabía avanzar hacia el cierre. El técnico que llegaba y no
 * podía instalar —no había nadie, la caja estaba llena, faltaba material— tenía
 * que llamar a la oficina para que lo cambiaran desde el escritorio. Y si no
 * llamaba, la orden quedaba "agendada" para siempre y figuraba como atrasada.
 *
 * El sistema sabía registrar el trabajo que sale bien. Esta pantalla registra
 * el que no.
 *
 * ── Por qué el motivo es una lista y no un campo libre ──
 *
 * El texto libre sirve para el caso puntual y está —abajo, opcional—. Pero de
 * un campo libre no sale "tres visitas perdidas por caja llena en Selva
 * Alegre", y ese número es una decisión de inversión: dice dónde hay que poner
 * la próxima NAP.
 *
 * Con el técnico parado en la vereda, además, ocho botones grandes se contestan
 * en dos segundos y un campo de texto no se contesta nunca.
 */

const MOTIVOS = [
  { valor: 'sin_nadie', label: 'No había nadie', ayuda: 'Nadie en el domicilio' },
  { valor: 'caja_llena', label: 'Caja llena', ayuda: 'La NAP no tiene puertos' },
  { valor: 'sin_cobertura', label: 'Sin cobertura', ayuda: 'No hay vista ni llega la fibra' },
  { valor: 'requiere_obra', label: 'Requiere obra', ayuda: 'Hay que tender o levantar antes' },
  { valor: 'falta_material', label: 'Faltó material', ayuda: 'No tenía lo necesario' },
  { valor: 'direccion_erronea', label: 'Dirección errónea', ayuda: 'No es ahí' },
  { valor: 'cliente_desiste', label: 'El cliente desistió', ayuda: 'Se arrepintió' },
  { valor: 'otro', label: 'Otro', ayuda: 'Contalo abajo' },
]

/** Mañana, en formato de fecha. Es la reprogramación más común. */
const manana = () => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  const dd = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${dd(d.getMonth() + 1)}-${dd(d.getDate())}`
}

export default function NoSePudo({ orden, onCerrar, onGuardado, onError }) {
  const [motivo, setMotivo] = useState(null)
  const [detalle, setDetalle] = useState('')
  const [vuelve, setVuelve] = useState('')
  const [guardando, setGuardando] = useState(false)

  const guardar = async () => {
    if (!motivo) return
    setGuardando(true)
    onError?.(null)
    try {
      /**
       * Con fecha se reprograma; sin fecha queda "no realizada".
       *
       * Son dos cosas distintas y por eso son dos estados. "Vuelvo el jueves"
       * es una visita que sigue viva y tiene que aparecer en la agenda de ese
       * día. "Hay que esperar la obra y no sé cuándo" es un trabajo detenido
       * que alguien de la oficina tiene que resolver.
       *
       * Forzar una fecha inventada para el segundo caso llenaría la agenda de
       * visitas que nadie va a hacer, y a las dos semanas nadie mira la agenda.
       */
      const campos = {
        estado: vuelve ? 'reprogramada' : 'no_realizada',
        motivo_no_realizada: motivo,
        detalle_no_realizada: detalle.trim() || null,
        reprogramada_para: vuelve || null,
      }
      // Si hay fecha nueva, la orden se mueve a ese día: si no, seguiría
      // apareciendo como atrasada la de hoy.
      if (vuelve) campos.fecha = vuelve

      const r = await campoApi.guardarOrden(orden.id, campos)
      await onGuardado?.({ ...campos, encolado: Boolean(r.encolado) })
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#F6F8FB]">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-slate-100">No se pudo hacer</h2>
          <p className="truncate text-[11px] text-slate-500">{orden.titular ?? orden.nombre}</p>
        </div>
        <button
          type="button"
          onClick={onCerrar}
          className="rounded-lg p-2 text-slate-400"
          aria-label="Volver al trabajo"
        >
          <X size={20} />
        </button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <div>
          <p className="mb-2 text-[13px] text-slate-400">¿Qué pasó?</p>
          {/* Dos columnas de botones grandes: se contesta con el pulgar, sin
              desplegar nada y sin apuntar a una lista de 8 renglones de 20 px. */}
          <div className="grid grid-cols-2 gap-2">
            {MOTIVOS.map((m) => (
              <button
                key={m.valor}
                type="button"
                onClick={() => setMotivo(m.valor)}
                className={`rounded-xl border p-3 text-left transition ${
                  motivo === m.valor
                    ? 'border-amber-500 bg-amber-500/15'
                    : 'border-slate-800 bg-slate-900 active:bg-slate-800'
                }`}
              >
                <span
                  className={`block text-[13px] font-medium ${
                    motivo === m.valor ? 'text-amber-200' : 'text-slate-200'
                  }`}
                >
                  {m.label}
                </span>
                <span className="block text-[11px] text-slate-500">{m.ayuda}</span>
              </button>
            ))}
          </div>
        </div>

        <Field
          label="¿Volvés otro día?"
          hint="Con fecha, la orden se reagenda para ese día. Sin fecha queda detenida y la oficina decide."
        >
          <div className="flex gap-2">
            <Input
              type="date"
              value={vuelve}
              onChange={(e) => setVuelve(e.target.value)}
              className="flex-1"
            />
            <button
              type="button"
              onClick={() => setVuelve(vuelve === manana() ? '' : manana())}
              className={`shrink-0 rounded-lg border px-3 text-[12px] ${
                vuelve === manana()
                  ? 'border-sky-500 bg-sky-500/15 text-sky-300'
                  : 'border-slate-700 text-slate-400'
              }`}
            >
              <CalendarClock size={14} className="mr-1 inline" />
              Mañana
            </button>
          </div>
        </Field>

        <Field label="Detalle" hint="Opcional. Lo que la lista de arriba no dice.">
          <Textarea
            rows={3}
            value={detalle}
            onChange={(e) => setDetalle(e.target.value)}
            placeholder="Ej: la caja 0-2 tiene los 8 puertos ocupados, hay que tender un ramal."
          />
        </Field>
      </div>

      <footer className="sticky bottom-0 border-t border-slate-800 bg-white/95 px-4 py-3">
        <div className="mx-auto flex max-w-2xl gap-2">
          <Button onClick={onCerrar} className="flex-1">
            Cancelar
          </Button>
          <Button
            variante="primario"
            className="flex-1"
            onClick={guardar}
            cargando={guardando}
            // Sin motivo no se guarda: una visita fallida sin causa no sirve
            // para nada — ni para volver, ni para contar, ni para decidir.
            disabled={!motivo || guardando}
          >
            {vuelve ? 'Reagendar' : 'Marcar sin hacer'}
          </Button>
        </div>
      </footer>
    </div>
  )
}
