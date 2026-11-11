import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { METAS, TIPOS_OBRA } from '../../lib/obras'
import { Aviso, Button, Field, Input, Modal, Select, Textarea } from '../ui'

/**
 * Crear o editar una obra (la oficina).
 *
 * El alcance va en números porque es contra lo que se mide el avance: "tender
 * la red del barrio" no se puede comparar con nada; "1.200 m de fibra, 6 NAP,
 * 24 fusiones" sí.
 *
 * El material presupuestado se elige del inventario cuando está dado de alta
 * (así el consumo se descuenta del almacén del técnico), o se escribe a mano.
 */

const VACIA = {
  titulo: '',
  tipo: 'expansion',
  zona: '',
  instrucciones: '',
  prioridad: 'media',
  cuadrilla_id: '',
  tecnico_id: '',
  fecha_inicio: '',
  fecha_meta: '',
  latitud: '',
  longitud: '',
  ticket_id: '',
  // El mapeo (233): de qué OLT y puerto PON es la zona, para sugerir abonados.
  olt_id: '',
  slot: '',
  puerto_pon: '',
  ...Object.fromEntries(METAS.map((m) => [`meta_${m.clave}`, ''])),
}

export default function ObraForm({ obra, desdeTicket, cuadrillas = [], tecnicos = [], onCerrar, onGuardada }) {
  const [form, setForm] = useState(VACIA)
  const [materiales, setMateriales] = useState([])
  const [borrados, setBorrados] = useState([])
  const [articulos, setArticulos] = useState([])
  const [olts, setOlts] = useState([])
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    supabase
      .from('articulos')
      .select('id,nombre,unidad,por_serie')
      .eq('activo', true)
      .order('nombre')
      .then(({ data }) => setArticulos((data ?? []).filter((a) => !a.por_serie)))
    supabase
      .from('olts')
      .select('id,nombre')
      .order('nombre')
      .then(({ data }) => setOlts(data ?? []))
  }, [])

  const esMapeo = form.tipo === 'mapeo'

  useEffect(() => {
    if (obra) {
      setForm({
        ...VACIA,
        ...Object.fromEntries(Object.keys(VACIA).map((k) => [k, obra[k] ?? ''])),
        ...Object.fromEntries(METAS.map((m) => [`meta_${m.clave}`, Number(obra[`meta_${m.clave}`]) || ''])),
      })
      supabase
        .from('obra_materiales')
        .select('*')
        .eq('obra_id', obra.id)
        .then(({ data }) => setMateriales((data ?? []).map((m) => ({ ...m, presupuesto: String(m.presupuesto) }))))
    } else if (desdeTicket) {
      // "Hace falta otro trabajo": la acometida o extensión para ese abonado.
      setForm({
        ...VACIA,
        tipo: 'acometida',
        prioridad: 'alta',
        titulo: `Acometida para ${desdeTicket.nombre}`.slice(0, 150),
        zona: [desdeTicket.sector, desdeTicket.direccion].filter(Boolean).join(' · ').slice(0, 150),
        latitud: desdeTicket.latitud ?? '',
        longitud: desdeTicket.longitud ?? '',
        ticket_id: desdeTicket.id,
        instrucciones: desdeTicket.motivo ? `Del ticket #${desdeTicket.numero}: ${desdeTicket.motivo}` : '',
      })
    }
  }, [obra, desdeTicket])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  function cambiarMaterial(i, cambios) {
    setMateriales((ms) => ms.map((m, j) => (j === i ? { ...m, ...cambios } : m)))
  }

  async function guardar(e) {
    e.preventDefault()
    if (!form.cuadrilla_id && !form.tecnico_id) return setError('Elegí la cuadrilla (o el técnico) que la hace.')
    setGuardando(true)
    setError(null)
    const datos = { ...form }
    for (const m of METAS) datos[`meta_${m.clave}`] = Number(form[`meta_${m.clave}`]) || 0
    const { data: id, error: err } = await supabase.rpc('guardar_obra', { p_id: obra?.id ?? null, p_datos: datos })
    if (err) {
      setGuardando(false)
      return setError(err.message)
    }

    // El presupuesto de material.
    const validos = materiales.filter((m) => m.descripcion.trim() && Number(m.presupuesto) > 0)
    const filas = validos.map((m) => ({
      ...(m.id ? { id: m.id } : {}),
      obra_id: id,
      articulo_id: m.articulo_id || null,
      descripcion: m.descripcion.trim(),
      unidad: (m.unidad || 'u').trim(),
      presupuesto: Number(m.presupuesto),
    }))
    const errores = []
    if (borrados.length) {
      const r = await supabase.from('obra_materiales').delete().in('id', borrados)
      if (r.error) errores.push(r.error.message)
    }
    const nuevas = filas.filter((f) => !f.id)
    const viejas = filas.filter((f) => f.id)
    if (nuevas.length) {
      const r = await supabase.from('obra_materiales').insert(nuevas)
      if (r.error) errores.push(r.error.message)
    }
    for (const f of viejas) {
      const r = await supabase.from('obra_materiales').update(f).eq('id', f.id)
      if (r.error) errores.push(r.error.message)
    }
    setGuardando(false)
    if (errores.length) return setError(`La obra se guardó, pero el material no: ${errores[0]}`)
    onGuardada?.(id)
  }

  return (
    <Modal abierto titulo={obra ? `Editar obra #${obra.numero}` : 'Nueva obra'} onCerrar={onCerrar} ancho="max-w-3xl">
      <form onSubmit={guardar} className="space-y-4">
        {form.ticket_id && desdeTicket && (
          <Aviso>
            Sale del ticket #{desdeTicket.numero} ({desdeTicket.nombre}). Cuando la apruebes, se avisa que ya se puede
            reprogramar.
          </Aviso>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Qué obra es" className="sm:col-span-2">
            <Input value={form.titulo} onChange={set('titulo')} required maxLength={150} placeholder="Ej.: Expansión barrio La Merced" />
          </Field>
          <Field label="Tipo">
            <Select value={form.tipo} onChange={set('tipo')}>
              {Object.entries(TIPOS_OBRA).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Zona / dirección" className="sm:col-span-2">
            <Input value={form.zona} onChange={set('zona')} maxLength={150} placeholder="Barrio, calles, referencia" />
          </Field>
          <Field label="Prioridad">
            <Select value={form.prioridad} onChange={set('prioridad')}>
              <option value="alta">Alta</option>
              <option value="media">Media</option>
              <option value="baja">Baja</option>
            </Select>
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Cuadrilla">
            <Select value={form.cuadrilla_id} onChange={set('cuadrilla_id')}>
              <option value="">— ninguna —</option>
              {cuadrillas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="O un técnico" hint="si no va una cuadrilla">
            <Select value={form.tecnico_id} onChange={set('tecnico_id')}>
              <option value="">—</option>
              {tecnicos.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.nombre}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Empieza">
            <Input type="date" value={form.fecha_inicio} onChange={set('fecha_inicio')} />
          </Field>
          <Field label="Fecha meta" hint="contra esta se mide si llegó a tiempo">
            <Input type="date" value={form.fecha_meta} min={form.fecha_inicio || undefined} onChange={set('fecha_meta')} />
          </Field>
        </div>

        {esMapeo && (
          <div className="space-y-3 rounded-xl border border-sky-500/30 p-3">
            <p className="text-[12px] text-slate-400">
              La cuadrilla registra cada caja que ya existe y releva puerto por puerto qué abonado está. No cuenta como
              producción ni como calidad de lo construido: tiene su propio indicador.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="OLT" hint="opcional: sugiere los abonados de ese puerto PON">
                <Select value={form.olt_id} onChange={set('olt_id')}>
                  <option value="">—</option>
                  {olts.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.nombre}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Placa (slot)">
                <Input type="number" min="0" value={form.slot} onChange={set('slot')} />
              </Field>
              <Field label="Puerto PON">
                <Input value={form.puerto_pon} onChange={set('puerto_pon')} maxLength={20} />
              </Field>
            </div>
          </div>
        )}

        <div>
          <p className="mb-2 text-xs font-semibold text-slate-400">
            {esMapeo ? 'Cuántas cajas hay que mapear' : 'Alcance (deja en blanco lo que la obra no incluye)'}
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
            {METAS.filter((m) => !esMapeo || m.clave === 'naps').map((m) => (
              <Field key={m.clave} label={`${m.label}${m.unidad ? ` (${m.unidad})` : ''}`}>
                <Input
                  type="number"
                  min="0"
                  inputMode="numeric"
                  value={form[`meta_${m.clave}`]}
                  onChange={set(`meta_${m.clave}`)}
                />
              </Field>
            ))}
          </div>
        </div>

        <Field label="Instrucciones" hint="lo que lee la cuadrilla en la app">
          <Textarea rows={3} value={form.instrucciones} onChange={set('instrucciones')} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Latitud" hint="opcional: para abrir el mapa">
            <Input value={form.latitud} onChange={set('latitud')} inputMode="decimal" />
          </Field>
          <Field label="Longitud">
            <Input value={form.longitud} onChange={set('longitud')} inputMode="decimal" />
          </Field>
        </div>

        <div className="rounded-xl border border-slate-800 p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-400">Material presupuestado</p>
            <Button
              type="button"
              variante="fantasma"
              icon={Plus}
              onClick={() => setMateriales((ms) => [...ms, { articulo_id: '', descripcion: '', unidad: 'm', presupuesto: '' }])}
            >
              Agregar
            </Button>
          </div>
          {!materiales.length && (
            <p className="text-[12px] text-slate-500">
              Sin presupuesto, el indicador de material no tiene contra qué comparar.
            </p>
          )}
          <div className="space-y-2">
            {materiales.map((m, i) => (
              <div key={m.id ?? `n${i}`} className="grid grid-cols-12 items-end gap-2">
                <Field label={i === 0 ? 'Del inventario' : ''} className="col-span-12 sm:col-span-4">
                  <Select
                    value={m.articulo_id ?? ''}
                    onChange={(e) => {
                      const a = articulos.find((x) => x.id === e.target.value)
                      cambiarMaterial(i, a ? { articulo_id: a.id, descripcion: a.nombre, unidad: a.unidad } : { articulo_id: '' })
                    }}
                  >
                    <option value="">— escribir a mano —</option>
                    {articulos.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.nombre}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={i === 0 ? 'Descripción' : ''} className="col-span-12 sm:col-span-4">
                  <Input
                    value={m.descripcion}
                    onChange={(e) => cambiarMaterial(i, { descripcion: e.target.value })}
                    placeholder="Fibra ADSS 12 hilos"
                  />
                </Field>
                <Field label={i === 0 ? 'Cantidad' : ''} className="col-span-5 sm:col-span-2">
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    value={m.presupuesto}
                    onChange={(e) => cambiarMaterial(i, { presupuesto: e.target.value })}
                  />
                </Field>
                <Field label={i === 0 ? 'Unidad' : ''} className="col-span-5 sm:col-span-1">
                  <Input value={m.unidad} maxLength={10} onChange={(e) => cambiarMaterial(i, { unidad: e.target.value })} />
                </Field>
                <div className="col-span-2 sm:col-span-1">
                  <Button
                    type="button"
                    variante="fantasma"
                    icon={Trash2}
                    onClick={() => {
                      if (m.id) setBorrados((b) => [...b, m.id])
                      setMateriales((ms) => ms.filter((_, j) => j !== i))
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {error && <p className="text-sm text-rose-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variante="fantasma" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button type="submit" variante="primario" cargando={guardando}>
            {obra ? 'Guardar' : 'Crear y asignar'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
