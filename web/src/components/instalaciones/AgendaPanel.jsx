import { useEffect, useState } from 'react'
import { CalendarClock, HardHat, Save } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { FRANJAS } from '../../lib/instalaciones'
import { Aviso, Button, Card, Field, Input, Select } from '../ui'

/**
 * Agendamiento: qué día va, quién va y qué se le vendió.
 *
 * El plan, el precio y el día de facturación se cargan acá y no en el celular
 * del técnico a propósito. Son las condiciones comerciales: las cierra la
 * oficina, y el técnico las tiene que ver para saber qué velocidad configurar,
 * no decidirlas parado en la vereda.
 */
export default function AgendaPanel({ instalacion, onError, onGuardado }) {
  const [tecnicos, setTecnicos] = useState([])
  const [cuadrillas, setCuadrillas] = useState([])
  const [planes, setPlanes] = useState([])
  const [guardando, setGuardando] = useState(false)

  const [form, setForm] = useState({
    fecha: instalacion.fecha ?? new Date().toISOString().slice(0, 10),
    franja: instalacion.franja ?? '',
    hora: instalacion.hora ? String(instalacion.hora).slice(0, 5) : '',
    tecnico_id: instalacion.tecnico_id ?? '',
    cuadrilla_id: instalacion.cuadrilla_id ?? '',
    plan_id: instalacion.plan_id ?? '',
    precio_mensual: instalacion.precio_mensual ?? '',
    dia_facturacion: instalacion.dia_facturacion ?? '',
    costo: instalacion.costo ?? '',
  })

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  useEffect(() => {
    let vigente = true

    ;(async () => {
      const [tec, cua, pl] = await Promise.all([
        supabase
          .from('tecnicos')
          .select('id, nombre, especialidad')
          .eq('activo', true)
          .order('nombre'),
        supabase.from('cuadrillas').select('id, nombre, zona').eq('activo', true).order('nombre'),
        supabase.from('planes_velocidad').select('id, nombre, precio').order('nombre'),
      ])

      if (!vigente) return
      setTecnicos(tec.data ?? [])
      setCuadrillas(cua.data ?? [])
      setPlanes(pl.data ?? [])
    })()

    return () => {
      vigente = false
    }
  }, [])

  /** Elegir un plan trae su precio de lista, que después se puede pisar. */
  function elegirPlan(e) {
    const id = e.target.value
    const plan = planes.find((p) => p.id === id)
    setForm((f) => ({
      ...f,
      plan_id: id,
      precio_mensual: plan ? String(plan.precio ?? '') : f.precio_mensual,
    }))
  }

  async function guardar() {
    setGuardando(true)
    onError?.(null)

    try {
      const numero = (v) => (v === '' || v == null ? null : Number(v))

      const cambios = {
        fecha: form.fecha,
        franja: form.franja || null,
        hora: form.franja === 'exacta' ? form.hora || null : null,
        tecnico_id: form.tecnico_id || null,
        cuadrilla_id: form.cuadrilla_id || null,
        plan_id: form.plan_id || null,
        precio_mensual: numero(form.precio_mensual),
        dia_facturacion: numero(form.dia_facturacion),
        costo: numero(form.costo) ?? 0,
      }

      // Con fecha y con alguien asignado deja de ser un pedido suelto. El paso
      // se da acá y no con un botón aparte: agendar ES eso, y un estado que hay
      // que acordarse de cambiar a mano es un estado que queda mal.
      const asignado = Boolean(cambios.tecnico_id || cambios.cuadrilla_id)
      if (asignado && instalacion.estado === 'prospecto') cambios.estado = 'agendada'

      const { error } = await supabase.from('instalaciones').update(cambios).eq('id', instalacion.id)
      if (error) throw error

      await onGuardado?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  const especialistas = tecnicos.filter(
    (t) => t.especialidad === 'ambas' || t.especialidad === (instalacion.tecnologia ?? 'ftth'),
  )
  const sinAsignar = !form.tecnico_id && !form.cuadrilla_id

  return (
    <Card title="Agenda y condiciones" icon={CalendarClock}>
      <div className="space-y-4">
        {instalacion.factibilidad === 'no_factible' && (
          <Aviso tipo="alerta">
            Este pedido está marcado como no factible. Agendarlo es mandar a alguien a un domicilio
            donde no se puede instalar.
          </Aviso>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Fecha de visita">
            <Input type="date" value={form.fecha} onChange={set('fecha')} required />
          </Field>

          <Field label="Franja">
            <Select value={form.franja} onChange={set('franja')}>
              <option value="">Sin definir</option>
              {Object.entries(FRANJAS).map(([valor, label]) => (
                <option key={valor} value={valor}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>

          {form.franja === 'exacta' && (
            <Field label="Hora">
              <Input type="time" value={form.hora} onChange={set('hora')} />
            </Field>
          )}

          <Field
            label="Técnico"
            hint={
              especialistas.length < tecnicos.length
                ? `Se muestran los de ${instalacion.tecnologia === 'wireless' ? 'radio' : 'fibra'}`
                : undefined
            }
          >
            <Select value={form.tecnico_id} onChange={set('tecnico_id')}>
              <option value="">Sin asignar</option>
              {especialistas.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.nombre}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Cuadrilla" hint="Cuando salen varios juntos">
            <Select value={form.cuadrilla_id} onChange={set('cuadrilla_id')}>
              <option value="">Sin asignar</option>
              {cuadrillas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                  {c.zona ? ` · ${c.zona}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Plan contratado">
            <Select value={form.plan_id} onChange={elegirPlan}>
              <option value="">Sin definir</option>
              {planes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Precio mensual" hint="Puede diferir del precio de lista">
            <Input
              type="number"
              step="0.01"
              min={0}
              value={form.precio_mensual}
              onChange={set('precio_mensual')}
            />
          </Field>

          <Field label="Día de facturación" hint="1 a 28. Lo define la oficina.">
            <Input
              type="number"
              min={1}
              max={28}
              value={form.dia_facturacion}
              onChange={set('dia_facturacion')}
            />
          </Field>

          <Field label="Costo de instalación" hint="Lo que se le cobra por la visita">
            <Input type="number" step="0.01" min={0} value={form.costo} onChange={set('costo')} />
          </Field>
        </div>

        {sinAsignar && (
          <p className="flex items-center gap-2 text-xs text-slate-500">
            <HardHat size={14} />
            Mientras no tenga técnico o cuadrilla queda como pedido: no aparece en la agenda del día.
          </p>
        )}

        <Button variante="primario" icon={Save} onClick={guardar} cargando={guardando}>
          Guardar agenda
        </Button>
      </div>
    </Card>
  )
}
