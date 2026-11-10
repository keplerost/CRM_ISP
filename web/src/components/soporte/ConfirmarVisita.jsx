import { useEffect, useState } from 'react'
import { CalendarClock, MessageCircle, Phone, PhoneCall } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { RESULTADOS_LLAMADA, etiquetaLlamada } from '../../lib/confirmaciones'
import { enlaceLlamada, enlaceWhatsApp } from '../../lib/telefono'
import { Aviso, Button, Field, Input, Modal, Select, Textarea } from '../ui'

/**
 * La oficina llama al cliente antes de que vaya el técnico (migración 227).
 *
 * "Está en casa" deja la parada confirmada. Las otras tres sacan el ticket de
 * la ruta de hoy sin cerrarlo: con fecha nueva queda agendado; sin fecha va a
 * "Por reprogramar". El técnico recibe el aviso de no ir, y no tiene que viajar
 * ni esperar los diez minutos del "no se pudo".
 *
 * @param ticket   { id, numero, nombre, telefono, franja, estado }
 * @param compacto solo el ícono, para la lista de la ruta
 */
const hoyLocal = () => new Date().toLocaleDateString('en-CA')

export default function ConfirmarVisita({ ticket, onHecho, onError, compacto = false }) {
  const [abierto, setAbierto] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [detalle, setDetalle] = useState('')
  const [fecha, setFecha] = useState('')
  const [franja, setFranja] = useState('')
  const [hora, setHora] = useState('')
  const [guardando, setGuardando] = useState(false)

  const r = RESULTADOS_LLAMADA.find((x) => x.valor === resultado)
  const llamar = enlaceLlamada(ticket.telefono)
  const whatsapp = enlaceWhatsApp(ticket.telefono)
  const falta = !resultado || (r?.posterga && fecha && franja === 'exacta' && !hora)

  function abrir() {
    setResultado(null)
    setDetalle('')
    setFecha('')
    setFranja(ticket.franja ?? '')
    setHora('')
    setAbierto(true)
  }

  async function guardar() {
    setGuardando(true)
    onError?.(null)
    const pos = r?.posterga
    const { error } = await supabase.rpc('oficina_confirma_visita', {
      p_ticket: ticket.id,
      p_resultado: resultado,
      p_detalle: detalle.trim() || null,
      p_fecha: pos && fecha ? fecha : null,
      p_franja: pos && fecha && franja ? franja : null,
      p_hora: pos && fecha && franja === 'exacta' ? hora : null,
    })
    setGuardando(false)
    if (error) return onError?.(error)
    setAbierto(false)
    onHecho?.()
  }

  return (
    <>
      {compacto ? (
        <button
          type="button"
          onClick={abrir}
          className="p-1 text-slate-500 hover:text-sky-400"
          title="Llamar al cliente antes de la visita"
          aria-label="Llamar al cliente"
        >
          <PhoneCall size={15} />
        </button>
      ) : (
        <button
          type="button"
          onClick={abrir}
          className="inline-flex items-center gap-2 text-sm text-sky-400 hover:text-sky-300"
          title="Llamar al cliente antes de que vaya el técnico"
        >
          <PhoneCall size={15} /> Confirmar visita
        </button>
      )}

      <Modal abierto={abierto} titulo={`Confirmar visita · #${ticket.numero}`} onCerrar={() => setAbierto(false)} ancho="max-w-xl">
        {abierto && (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-semibold text-slate-100">{ticket.nombre}</p>
              <div className="mt-1 flex flex-wrap gap-3 text-sm">
                {llamar ? (
                  <a href={llamar} className="inline-flex items-center gap-1 text-sky-400 hover:underline">
                    <Phone size={14} /> {ticket.telefono}
                  </a>
                ) : (
                  <span className="text-slate-500">Sin teléfono cargado</span>
                )}
                {whatsapp && (
                  <a href={whatsapp} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-emerald-400 hover:underline">
                    <MessageCircle size={14} /> WhatsApp
                  </a>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {RESULTADOS_LLAMADA.map((x) => (
                <button
                  key={x.valor}
                  type="button"
                  onClick={() => setResultado(x.valor)}
                  className={`rounded-lg border px-2 py-2.5 text-sm ${
                    resultado === x.valor
                      ? x.posterga
                        ? 'border-amber-500 bg-amber-500/20 text-amber-200'
                        : 'border-emerald-500 bg-emerald-500/20 text-emerald-200'
                      : 'border-slate-700 text-slate-300 hover:border-slate-600'
                  }`}
                >
                  {x.label}
                </button>
              ))}
            </div>

            {r?.posterga && (
              <>
                <Aviso>
                  El ticket sale de la ruta de hoy, <b>no se cierra</b>, y al técnico le llega el aviso de no ir.
                  Sin fecha nueva queda en «Por reprogramar».
                </Aviso>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Nueva fecha" hint="opcional">
                    <Input type="date" value={fecha} min={hoyLocal()} onChange={(e) => setFecha(e.target.value)} />
                  </Field>
                  <Field label="Franja">
                    <Select value={franja} onChange={(e) => setFranja(e.target.value)} disabled={!fecha}>
                      <option value="">— la misma —</option>
                      <option value="manana">Mañana</option>
                      <option value="tarde">Tarde</option>
                      <option value="exacta">Hora exacta</option>
                    </Select>
                  </Field>
                  {franja === 'exacta' && fecha && (
                    <Field label="Hora">
                      <Input type="time" value={hora} onChange={(e) => setHora(e.target.value)} />
                    </Field>
                  )}
                </div>
              </>
            )}

            {resultado && (
              <Field label="Qué dijo" hint="opcional">
                <Textarea
                  rows={2}
                  value={detalle}
                  onChange={(e) => setDetalle(e.target.value)}
                  placeholder={r?.posterga ? 'Ej.: trabaja hasta las 3, que vayan después' : 'Ej.: está toda la mañana'}
                />
              </Field>
            )}

            <div className="flex justify-end gap-2 border-t border-slate-800 pt-3">
              <Button variante="fantasma" onClick={() => setAbierto(false)}>
                Cancelar
              </Button>
              <Button
                variante="primario"
                icon={r?.posterga ? CalendarClock : PhoneCall}
                cargando={guardando}
                disabled={falta || guardando}
                onClick={guardar}
              >
                {!r ? 'Guardar' : r.posterga ? (fecha ? 'Postergar' : 'Pasar a Por reprogramar') : 'Confirmar'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}

/**
 * Las llamadas de la oficina a este ticket, para la ficha. Solo aparece si hay
 * alguna: así el técnico ve que la oficina ya confirmó que lo esperan.
 */
export function LlamadasDelTicket({ ticketId, clave = 0 }) {
  const [filas, setFilas] = useState([])
  useEffect(() => {
    let vivo = true
    supabase
      .from('confirmaciones_visita')
      .select('id, resultado, detalle, nueva_fecha, nueva_franja, creado_at, usuario_id')
      .eq('ticket_id', ticketId)
      .order('creado_at', { ascending: false })
      .limit(5)
      .then(({ data }) => vivo && setFilas(data ?? []))
    return () => {
      vivo = false
    }
  }, [ticketId, clave])
  if (!filas.length) return null

  const cuando = (f) => new Date(f).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' })
  return (
    <section className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-sky-300">
        <PhoneCall size={14} /> La oficina llamó al cliente
      </p>
      <ul className="mt-1 space-y-0.5 text-[12px] text-slate-400">
        {filas.map((f) => (
          <li key={f.id}>
            <b className={f.resultado === 'esta' ? 'text-emerald-300' : 'text-amber-300'}>{etiquetaLlamada(f.resultado)}</b>
            {f.detalle && ` · ${f.detalle}`}
            {f.nueva_fecha &&
              ` · nueva visita ${new Date(`${f.nueva_fecha}T12:00:00`).toLocaleDateString('es-EC', { weekday: 'short', day: 'numeric', month: 'short' })}`}
            <span className="text-slate-500"> · {cuando(f.creado_at)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
