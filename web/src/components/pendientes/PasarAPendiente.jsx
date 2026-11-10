import { useEffect, useState } from 'react'
import { ArrowRightLeft } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { usePermisos } from '../../lib/AuthContext'
import { TIPOS_PENDIENTE } from '../../lib/pendientes'
import { Aviso, Button, Field, Input, Modal, Select, Textarea } from '../ui'

/**
 * "Esto no es soporte": el ticket pasa a Pendientes.
 *
 * Crea el pendiente con el abonado del ticket y cancela el ticket con el motivo
 * escrito (migración 225). Sale de la ruta, del plazo y del desempeño de la
 * cuadrilla, que no tenía nada que hacer con un cambio de plan.
 */

/** Adivina el tipo por lo que dice el ticket. Se puede cambiar. */
function tipoSugerido(t) {
  const x = String([t.descripcion, t.incidencia_otro].join(' '))
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
  if (/plan|\$\s?\d/.test(x)) return 'cambio_plan'
  if (/contrato|firm/.test(x)) return 'firma_contrato'
  if (/cedula/.test(x)) return 'copia_cedula'
  if (/reconex/.test(x)) return 'reconexion'
  if (/cobr/.test(x)) return 'cobro'
  return 'otro'
}

export default function PasarAPendiente({ ticket, onError }) {
  const { perfil } = usePermisos()
  const navegar = useNavigate()
  const [abierto, setAbierto] = useState(false)
  const [usuarios, setUsuarios] = useState([])
  const [form, setForm] = useState(null)
  const [guardando, setGuardando] = useState(false)

  useEffect(() => {
    if (!abierto) return
    setForm({
      tipo: tipoSugerido(ticket),
      tipo_otro: ticket.incidencia_otro ?? '',
      detalle: ticket.incidencia_otro || ticket.descripcion || '',
      asignado_a: perfil?.id ?? '',
      vence_el: ticket.fecha_visita ? String(ticket.fecha_visita).slice(0, 10) : '',
    })
    supabase
      .from('usuarios_sistema')
      .select('id, nombre, apellido')
      .eq('activo', true)
      .order('nombre')
      .then(({ data }) => setUsuarios(data ?? []))
  }, [abierto, ticket, perfil?.id])

  async function pasar() {
    setGuardando(true)
    onError?.(null)
    const { data: id, error } = await supabase.rpc('pasar_ticket_a_pendiente', {
      p_ticket: ticket.id,
      p_tipo: form.tipo,
      p_detalle: form.detalle.trim() || null,
      p_asignado_a: form.asignado_a || null,
      p_vence_el: form.vence_el || null,
    })
    if (!error && id && form.tipo === 'otro' && form.tipo_otro.trim()) {
      // Lo otro se guarda aparte (226): la función de la 225 no lo recibe.
      await supabase.from('pendientes').update({ tipo_otro: form.tipo_otro.trim() }).eq('id', id)
    }
    setGuardando(false)
    if (error) return onError?.(error)
    setAbierto(false)
    navegar('/pendientes')
  }

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  return (
    <>
      <button
        type="button"
        onClick={() => setAbierto(true)}
        className="inline-flex items-center gap-2 text-sm text-violet-400 hover:text-violet-300"
        title="Es algo administrativo, no un reclamo"
      >
        <ArrowRightLeft size={15} /> No es soporte
      </button>

      <Modal abierto={abierto} titulo="Pasar a Pendientes" onCerrar={() => setAbierto(false)} ancho="max-w-xl">
        {form && (
          <div className="space-y-4">
            <Aviso>
              El ticket N° {ticket.numero} se cancela con la nota «No era soporte» y queda como pendiente
              de {ticket.nombre}. Sale de la ruta del técnico, del plazo de atención y del desempeño.
            </Aviso>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Qué hay que hacer">
                <Select value={form.tipo} onChange={set('tipo')}>
                  {TIPOS_PENDIENTE.map((t) => (
                    <option key={t.valor} value={t.valor}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Para cuándo" hint="opcional">
                <Input type="date" value={form.vence_el} onChange={set('vence_el')} />
              </Field>
            </div>
            {form.tipo === 'otro' && (
              <Field label="¿Qué es lo otro?" hint="En pocas palabras">
                <Input value={form.tipo_otro} onChange={set('tipo_otro')} maxLength={120} />
              </Field>
            )}
            <Field label="Detalle">
              <Textarea rows={2} value={form.detalle} onChange={set('detalle')} />
            </Field>
            <Field label="Le toca a">
              <Select value={form.asignado_a} onChange={set('asignado_a')}>
                <option value="">— cualquiera de la oficina —</option>
                {usuarios.map((u) => (
                  <option key={u.id} value={u.id}>
                    {`${u.nombre ?? ''} ${u.apellido ?? ''}`.trim()}
                    {u.id === perfil?.id ? ' (yo)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex justify-end gap-2 border-t border-slate-800 pt-3">
              <Button variante="fantasma" onClick={() => setAbierto(false)}>
                Cancelar
              </Button>
              <Button variante="primario" icon={ArrowRightLeft} cargando={guardando} onClick={pasar}>
                Pasar a Pendientes
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}
