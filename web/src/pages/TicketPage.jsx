import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { ArrowLeft, ExternalLink, Package, Pencil, Printer } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { api } from '../lib/apiNetwork'
import { abrirPdf } from '../lib/pdf'
import { Card, ErrorBanner, Modal } from '../components/ui'
import TicketFicha from '../components/soporte/TicketFicha'
import TicketForm from '../components/soporte/TicketForm'
import CambioDeEquipo from '../components/soporte/CambioDeEquipo'
import MaterialUsado from '../components/inventario/MaterialUsado'
import ConPermiso from '../components/layout/ConPermiso'
import PasarAPendiente from '../components/pendientes/PasarAPendiente'
import PendientesDelAbonado from '../components/pendientes/PendientesDelAbonado'

/**
 * Un ticket, a pantalla completa.
 *
 * El ancho se limita aunque haya monitor de sobra: esta pantalla se diseñó para
 * el teléfono del técnico, y estirarla en escritorio dejaría los botones de
 * acción a medio metro uno del otro.
 */
export default function TicketPage() {
  const { id } = useParams()
  const { pathname } = useLocation()
  /**
   * La misma pantalla vive en dos lados.
   *
   * Desde el escritorio se entra por `/soporte/:id`; desde la app de campo, por
   * `/campo/soporte/:id`, que la dibuja dentro del marco del técnico —barra
   * abajo, sin menú lateral—.
   *
   * El componente es el mismo; lo único que cambia es a dónde vuelve el botón
   * de atrás. Sin esto, el técnico tocaba "Tickets" y caía en la bandeja de
   * escritorio, fuera de su app y con todo descuadrado.
   */
  const enCampo = pathname.startsWith('/campo')

  const [ticket, setTicket] = useState(null)
  const [error, setError] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [editando, setEditando] = useState(false)

  const cargar = useCallback(async () => {
    /*
     * La vista y la fila cruda, mezcladas.
     *
     * `v_tickets` es `SELECT t.*` de la migración 28 y congeló sus columnas ahí:
     * lo agregado después —el motivo de la demora de la 219, entre otros— no
     * aparece hasta que alguien la recrea. La fila cruda gana, así la pantalla
     * muestra siempre todos los campos del ticket. Igual que la ficha del
     * cliente.
     */
    const [vista, fila] = await Promise.all([
      supabase.from('v_tickets').select('*').eq('id', id).maybeSingle(),
      supabase.from('tickets').select('*').eq('id', id).maybeSingle(),
    ])

    if (vista.error) setError(vista.error)
    const data = vista.data || fila.data ? { ...(vista.data ?? {}), ...(fila.data ?? {}) } : null
    setTicket(data)
    setCargando(false)
  }, [id])

  useEffect(() => {
    cargar()
  }, [cargar])

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Link
          to={enCampo ? "/campo/soporte" : "/soporte"}
          className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200"
        >
          <ArrowLeft size={16} /> Tickets
        </Link>

        <div className="flex items-center gap-4">
          {/*
            El comprobante para dejarle en la mano al abonado. Lleva el número
            de reporte, que es lo que convierte un reclamo en algo que se puede
            seguir, y la firma si el técnico ya la tomó.
          */}
          {ticket && (
            <button
              type="button"
              onClick={() => abrirPdf(() => api.documentos.ticket(ticket.id)).catch(setError)}
              className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200"
            >
              <Printer size={15} /> Imprimir
            </button>
          )}

          {/* Corregir lo que se cargó mal al crearlo. Desde la oficina y con el
              ticket todavía abierto: uno resuelto o cancelado ya es historia. */}
          {ticket && !enCampo && !['resuelto', 'cancelado'].includes(ticket.estado) && (
            <ConPermiso permiso="soporte.crear" envezDe={null}>
              <button
                type="button"
                onClick={() => setEditando(true)}
                className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200"
              >
                <Pencil size={15} /> Editar
              </button>
            </ConPermiso>
          )}

          {/* Lo administrativo cargado como ticket ("cambiar a $23.10"): sale
              de la ruta y del plazo y queda como pendiente. Solo mientras nadie
              salió hacia allá. */}
          {ticket && !enCampo && ['abierto', 'asignado'].includes(ticket.estado) && (
            <ConPermiso permiso="soporte.crear" envezDe={null}>
              <PasarAPendiente ticket={ticket} onError={setError} />
            </ConPermiso>
          )}

          {ticket?.client_id && !enCampo && (
            <Link
              to={`/clientes/${ticket.client_id}`}
              className="inline-flex items-center gap-2 text-sm text-sky-400 hover:text-sky-300"
            >
              Ficha del abonado <ExternalLink size={14} />
            </Link>
          )}
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {cargando ? (
        <p className="p-4 text-sm text-slate-500">Cargando el ticket…</p>
      ) : !ticket ? (
        <p className="p-4 text-sm text-slate-500">No existe ese ticket.</p>
      ) : (
        <>
          {/* Lo que falta hacer con este abonado y no es el reclamo: si el
              técnico ya está ahí, lo resuelve en la misma visita. */}
          <PendientesDelAbonado abonado={ticket} onError={setError} />

          <TicketFicha ticket={ticket} onCambio={cargar} onError={setError} />

          {/* Cambiar la ONT.
              Va acá arriba del material y no adentro de la ficha: es una acción
              sobre el equipo del abonado, no un cambio de estado del reclamo. El
              componente se dibuja solo para quien tiene almacén propio —quien
              tiene la ONT en la mano—; para el resto no aparece nada. */}
          <ConPermiso permiso="inventario.almacen_propio" envezDe={null}>
            <CambioDeEquipo ticket={ticket} onCambio={cargar} onError={setError} />
          </ConPermiso>

          {/* El material que se gastó reparando.
              Va debajo de la ficha y no dentro: la ficha es del reclamo, esto es
              del inventario. Y en `compacto` no dibuja nada para quien no tiene
              almacén — la mayoría de quienes abren un ticket no son técnicos y
              no necesitan que se les explique cómo vincularse a uno. */}
          <ConPermiso permiso="inventario.almacen_propio" envezDe={null}>
            <Card
              title="Material usado en esta reparación"
              icon={Package}
              subtitle="Sale de tu almacén. Descontarlo acá es lo que evita que a fin de mes el stock no cuadre."
            >
              <MaterialUsado ticketId={ticket.id} onError={setError} compacto />
            </Card>
          </ConPermiso>
        </>
      )}

      {editando && ticket && (
        <Modal
          abierto
          titulo={`Editar ticket ${ticket.codigo ?? ''}`}
          onCerrar={() => setEditando(false)}
          ancho="max-w-3xl"
        >
          <TicketForm
            ticketInicial={ticket}
            onError={setError}
            onCancelar={() => setEditando(false)}
            onGuardado={() => {
              setEditando(false)
              cargar()
            }}
          />
        </Modal>
      )}
    </div>
  )
}
