import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, LifeBuoy, Plus } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Button, Card, Modal } from '../ui'
import TicketForm from '../soporte/TicketForm'
import { ESTADOS, PRIORIDADES, etiquetaIncidencia, haceCuanto } from '../../lib/soporte'

/**
 * Los tickets de este abonado, dentro de su ficha.
 *
 * Es la pregunta que se hace en el mostrador: "¿este ya reclamó antes?". Un
 * abonado que llamó tres veces por lo mismo en un mes no necesita otra visita
 * igual, necesita que alguien mire el historial.
 */

const fecha = (f) => (f ? new Date(f).toLocaleDateString() : '—')

export default function FichaSoporte({ cliente, onError }) {
  const [tickets, setTickets] = useState([])
  const [cargando, setCargando] = useState(true)
  const [creando, setCreando] = useState(false)

  const recargar = useCallback(async () => {
    setCargando(true)
    const { data, error } = await supabase
      .from('v_tickets')
      .select('*')
      .eq('client_id', cliente.id)
      .order('created_at', { ascending: false })

    if (error) onError?.(error)
    setTickets(data ?? [])
    setCargando(false)
  }, [cliente.id, onError])

  useEffect(() => {
    recargar()
  }, [recargar])

  const abiertos = tickets.filter((t) => !['resuelto', 'cancelado'].includes(t.estado))

  return (
    <Card
      title="Tickets de soporte"
      icon={LifeBuoy}
      subtitle={
        tickets.length
          ? `${tickets.length} en total · ${abiertos.length} sin resolver`
          : 'Nunca reportó una falla'
      }
      actions={
        <Button variante="primario" icon={Plus} onClick={() => setCreando(true)}>
          Nuevo ticket
        </Button>
      }
    >
      {cargando ? (
        <p className="text-sm text-slate-500">Cargando…</p>
      ) : tickets.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">
          Este abonado no tiene reclamos registrados.
        </p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {tickets.map((t) => {
            const estado = ESTADOS[t.estado] ?? ESTADOS.abierto
            return (
              <li key={t.id}>
                <Link
                  to={`/soporte/${t.id}`}
                  className="flex items-center gap-3 py-3 transition hover:bg-slate-800/40"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <b className="font-mono text-[11px] text-slate-500">N° {t.codigo}</b>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] ${estado.clase}`}>
                        {estado.label}
                      </span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] ${PRIORIDADES[t.prioridad]?.clase ?? ''}`}
                      >
                        {PRIORIDADES[t.prioridad]?.label}
                      </span>
                    </span>
                    <span className="block truncate text-sm text-slate-200">
                      {etiquetaIncidencia(t.tipo_incidencia)}
                    </span>
                    <span className="block text-[11px] text-slate-500">
                      {fecha(t.created_at)} · {haceCuanto(t.horas_abierto)}
                      {t.tecnico || t.cuadrilla ? ` · ${t.tecnico ?? t.cuadrilla}` : ' · sin asignar'}
                    </span>
                  </span>
                  <ChevronRight size={16} className="shrink-0 text-slate-600" />
                </Link>
              </li>
            )
          })}
        </ul>
      )}

      <Modal
        abierto={creando}
        titulo={`Nuevo ticket · ${cliente.nombre}`}
        onCerrar={() => setCreando(false)}
        ancho="max-w-3xl"
      >
        <TicketForm
          clienteInicial={cliente}
          onError={onError}
          onCancelar={() => setCreando(false)}
          onCreado={() => {
            setCreando(false)
            recargar()
          }}
        />
      </Modal>
    </Card>
  )
}
