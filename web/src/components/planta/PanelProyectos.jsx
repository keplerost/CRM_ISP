import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Download, Hammer, PencilRuler, Plus, Trash2 } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { delProyecto, listaMateriales, metasDelProyecto } from '../../lib/proyectos'
import { METAS } from '../../lib/obras'
import { Badge, Button, Field, Input, Modal, Select, Textarea } from '../ui'

/**
 * Los proyectos de red (migración 238), en el costado del mapa: crearlos,
 * diseñar (lo que se dibuja con el proyecto activo queda "proyectado"), ver su
 * lista de materiales y su presupuesto óptico, y convertirlos en obra.
 */

const ESTADO = {
  diseno: { label: 'En diseño', color: 'azul' },
  en_obra: { label: 'En obra', color: 'ambar' },
  construido: { label: 'Construido', color: 'verde' },
  cancelado: { label: 'Cancelado', color: 'gris' },
}
const PRESUP = { bien: 'text-emerald-400', atencion: 'text-amber-400', mal: 'text-rose-400', sin_camino: 'text-slate-500' }

export default function PanelProyectos({
  proyectos,
  datos,
  presupuestos,
  activo,
  solo,
  edita,
  onActivar,
  onSolo,
  onExportar,
  onCambio,
  onError,
}) {
  const [abierto, setAbierto] = useState(null)
  const [nuevo, setNuevo] = useState(null)
  const [aObra, setAObra] = useState(false)
  const p = proyectos.find((x) => x.id === abierto)

  const sueltos = useMemo(
    () => [...datos.elementos, ...datos.cables].filter((x) => x.estado === 'proyectado' && !x.proyecto_id).length,
    [datos],
  )

  async function crear(e) {
    e.preventDefault()
    const { data, error } = await supabase
      .from('planta_proyectos')
      .insert({
        nombre: nuevo.nombre.trim(),
        zona: nuevo.zona.trim() || null,
        descripcion: nuevo.descripcion.trim() || null,
        reserva_pct: Number(nuevo.reserva_pct) || 0,
      })
      .select('id')
      .single()
    if (error) return onError(error)
    setNuevo(null)
    await onCambio()
    setAbierto(data.id)
    onActivar(data.id)
  }

  if (p) {
    return (
      <Detalle
        p={p}
        datos={datos}
        presupuestos={presupuestos}
        activo={activo === p.id}
        solo={solo === p.id}
        sueltos={sueltos}
        edita={edita}
        onVolver={() => setAbierto(null)}
        onActivar={onActivar}
        onSolo={onSolo}
        onExportar={onExportar}
        onCambio={onCambio}
        onError={onError}
        aObra={aObra}
        setAObra={setAObra}
      />
    )
  }

  return (
    <div className="space-y-3 text-[12px]">
      {edita &&
        (nuevo ? (
          <form onSubmit={crear} className="space-y-2 rounded-lg border border-slate-800 p-2">
            <Field label="Nombre del proyecto">
              <Input value={nuevo.nombre} onChange={(e) => setNuevo((v) => ({ ...v, nombre: e.target.value }))} required placeholder="Expansión La Merced" />
            </Field>
            <Field label="Zona">
              <Input value={nuevo.zona} onChange={(e) => setNuevo((v) => ({ ...v, zona: e.target.value }))} />
            </Field>
            <Field label="Descripción" hint="lo que lee la cuadrilla en la obra">
              <Textarea rows={2} value={nuevo.descripcion} onChange={(e) => setNuevo((v) => ({ ...v, descripcion: e.target.value }))} />
            </Field>
            <Field label="Reserva de cable (%)" hint="se suma a los metros dibujados">
              <Input type="number" min="0" max="100" value={nuevo.reserva_pct} onChange={(e) => setNuevo((v) => ({ ...v, reserva_pct: e.target.value }))} />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" variante="primario">
                Crear y diseñar
              </Button>
              <Button type="button" variante="fantasma" onClick={() => setNuevo(null)}>
                Cancelar
              </Button>
            </div>
          </form>
        ) : (
          <Button icon={Plus} className="w-full" onClick={() => setNuevo({ nombre: '', zona: '', descripcion: '', reserva_pct: 10 })}>
            Nuevo proyecto
          </Button>
        ))}
      {!proyectos.length && (
        <p className="text-slate-500">
          Un proyecto agrupa lo que se diseña sin tocar la red real: sale la lista de materiales, el presupuesto óptico y la obra.
        </p>
      )}
      <ul className="space-y-1.5">
        {proyectos.map((x) => {
          const d = delProyecto(x.id, datos)
          return (
            <li key={x.id}>
              <button
                type="button"
                onClick={() => setAbierto(x.id)}
                className={`w-full rounded-lg border p-2 text-left ${activo === x.id ? 'border-sky-500' : 'border-slate-800'} hover:bg-slate-800/30`}
              >
                <span className="flex items-center gap-2">
                  <span className="flex-1 font-semibold text-slate-100">{x.nombre}</span>
                  <Badge color={ESTADO[x.estado].color}>{ESTADO[x.estado].label}</Badge>
                </span>
                <span className="text-[11px] text-slate-500">
                  {d.elementos.length} elementos · {d.cables.length} cables{x.zona ? ` · ${x.zona}` : ''}
                  {activo === x.id && <span className="text-sky-400"> · diseñando</span>}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Detalle({ p, datos, presupuestos, activo, solo, sueltos, edita, onVolver, onActivar, onSolo, onExportar, onCambio, onError, aObra, setAObra }) {
  const d = useMemo(() => delProyecto(p.id, datos), [p.id, datos])
  const materiales = useMemo(() => listaMateriales(d, { reservaPct: p.reserva_pct }), [d, p.reserva_pct])
  const naps = d.elementos.filter((e) => e.tipo === 'nap')
  const [obra, setObra] = useState(null)

  useEffect(() => {
    if (!p.obra_id) return setObra(null)
    supabase
      .from('obras_red')
      .select('id,numero,estado')
      .eq('id', p.obra_id)
      .maybeSingle()
      .then(({ data }) => setObra(data))
  }, [p.obra_id])

  async function pasarSueltos() {
    const a = await supabase.from('planta_elementos').update({ proyecto_id: p.id }).eq('estado', 'proyectado').is('proyecto_id', null)
    const b = await supabase.from('planta_cables').update({ proyecto_id: p.id }).eq('estado', 'proyectado').is('proyecto_id', null)
    if (a.error || b.error) return onError(a.error ?? b.error)
    onCambio()
  }

  async function borrar() {
    if (!window.confirm(`¿Borrar el proyecto "${p.nombre}" y todo lo que se dibujó en él?`)) return
    const { error } = await supabase.rpc('borrar_proyecto', { p_id: p.id })
    if (error) return onError(error)
    if (activo) onActivar(null)
    onVolver()
    onCambio()
  }

  const enDiseno = p.estado === 'diseno'

  return (
    <div className="space-y-3 text-[12px]">
      <button type="button" onClick={onVolver} className="flex items-center gap-1 text-slate-400">
        <ArrowLeft size={13} /> Proyectos
      </button>
      <div>
        <p className="flex items-center gap-2">
          <span className="text-[14px] font-semibold text-slate-100">{p.nombre}</span>
          <Badge color={ESTADO[p.estado].color}>{ESTADO[p.estado].label}</Badge>
        </p>
        {p.zona && <p className="text-slate-500">{p.zona}</p>}
        {p.descripcion && <p className="mt-1 text-slate-400">{p.descripcion}</p>}
        {obra && (
          <Link to={`/soporte/obras?obra=${obra.id}`} className="mt-1 block text-sky-400">
            Obra #{obra.numero} ({obra.estado})
          </Link>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {edita && enDiseno && (
          <Button variante={activo ? 'primario' : 'secundario'} icon={PencilRuler} onClick={() => onActivar(activo ? null : p.id)}>
            {activo ? 'Diseñando… (terminar)' : 'Diseñar'}
          </Button>
        )}
        <Button variante="fantasma" onClick={() => onSolo(solo ? null : p.id)}>
          {solo ? 'Ver toda la red' : 'Ver solo este proyecto'}
        </Button>
        <Button variante="fantasma" icon={Download} onClick={() => onExportar(p)}>
          KMZ
        </Button>
      </div>
      {edita && enDiseno && sueltos > 0 && (
        <button type="button" onClick={pasarSueltos} className="text-left text-sky-400">
          Pasar a este proyecto los {sueltos} elementos proyectados que no tienen proyecto (los de la carpeta PROYECTOS del KMZ).
        </button>
      )}

      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Lista de materiales{p.reserva_pct ? ` (cable +${p.reserva_pct}% de reserva)` : ''}
        </p>
        {!materiales.length ? (
          <p className="text-slate-500">Todavía no hay nada dibujado en el proyecto.</p>
        ) : (
          <table className="w-full">
            <tbody>
              {materiales.map((m) => (
                <tr key={m.clave} className="border-t border-slate-800">
                  <td className="py-1 text-slate-300">{m.descripcion}</td>
                  <td className="py-1 text-right tabular-nums text-slate-100">
                    {m.cantidad.toLocaleString('es-EC')} {m.unidad}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {naps.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Presupuesto óptico de sus cajas</p>
          <ul className="space-y-0.5">
            {naps.map((n) => {
              const pr = presupuestos.get(n.id)
              return (
                <li key={n.id} className={`flex justify-between gap-2 ${PRESUP[pr?.estado ?? 'sin_camino']}`} title={pr?.error ?? ''}>
                  <span className="truncate">{n.nombre}</span>
                  <span className="shrink-0 tabular-nums">{pr?.ok ? `${pr.rxSalida} dBm · margen ${pr.margen}` : 'sin camino'}</span>
                </li>
              )
            })}
          </ul>
          <p className="mt-1 text-[11px] text-slate-500">
            Para que haya camino, uní en cada caja los hilos del proyecto con la red existente (Hilos, splitters y presupuesto).
          </p>
        </div>
      )}

      {edita && enDiseno && (
        <div className="flex flex-wrap gap-2 border-t border-slate-800 pt-3">
          <Button variante="primario" icon={Hammer} onClick={() => setAObra(true)} disabled={!materiales.length}>
            Convertir en obra
          </Button>
          <Button variante="fantasma" icon={Trash2} onClick={borrar}>
            Borrar proyecto
          </Button>
        </div>
      )}

      {aObra && <AObra p={p} d={d} materiales={materiales} onCerrar={() => setAObra(false)} onCambio={onCambio} onError={onError} />}
    </div>
  )
}

function AObra({ p, d, materiales, onCerrar, onCambio, onError }) {
  const [cuadrillas, setCuadrillas] = useState([])
  const [cuadrilla, setCuadrilla] = useState('')
  const [fecha, setFecha] = useState('')
  const [metas, setMetas] = useState(() => metasDelProyecto(d))
  const [lineas, setLineas] = useState(() => materiales.filter((m) => m.grupo !== 'Fusiones y conectores').map((m) => ({ ...m, incluir: true })))
  const [enviando, setEnviando] = useState(false)
  const [hecho, setHecho] = useState(null)

  useEffect(() => {
    supabase
      .from('cuadrillas')
      .select('id,nombre')
      .eq('activo', true)
      .order('nombre')
      .then(({ data }) => setCuadrillas(data ?? []))
  }, [])

  async function convertir() {
    setEnviando(true)
    const { data, error } = await supabase.rpc('proyecto_a_obra', {
      p_proyecto: p.id,
      p_cuadrilla: cuadrilla,
      p_fecha_meta: fecha || null,
      p_metas: Object.fromEntries(Object.entries(metas).map(([k, v]) => [k, Number(v) || 0])),
      p_materiales: lineas.filter((l) => l.incluir).map((l) => ({ descripcion: l.descripcion, unidad: l.unidad, cantidad: Number(l.cantidad) })),
    })
    setEnviando(false)
    if (error) return onError(error)
    setHecho(data)
    onCambio()
  }

  return (
    <Modal abierto titulo={`Convertir en obra · ${p.nombre}`} onCerrar={onCerrar} ancho="max-w-3xl">
      {hecho ? (
        <div className="space-y-3 text-sm">
          <p className="text-emerald-400">Listo: la obra quedó creada y la cuadrilla ya fue avisada.</p>
          <Link to={`/soporte/obras?obra=${hecho}`} className="text-sky-400">
            Abrir la obra
          </Link>
        </div>
      ) : (
        <div className="space-y-4 text-[12px]">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Cuadrilla que lo construye">
              <Select value={cuadrilla} onChange={(e) => setCuadrilla(e.target.value)}>
                <option value="">— elegí —</option>
                {cuadrillas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Fecha meta">
              <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
            </Field>
          </div>
          <div>
            <p className="mb-1 font-semibold text-slate-400">Alcance (del diseño; se puede ajustar)</p>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {METAS.map((m) => (
                <Field key={m.clave} label={`${m.label}${m.unidad ? ` (${m.unidad})` : ''}`}>
                  <Input
                    type="number"
                    min="0"
                    value={metas[`meta_${m.clave}`] ?? 0}
                    onChange={(e) => setMetas((v) => ({ ...v, [`meta_${m.clave}`]: e.target.value }))}
                  />
                </Field>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1 font-semibold text-slate-400">Material presupuestado de la obra</p>
            <ul className="space-y-1">
              {lineas.map((l, i) => (
                <li key={l.clave} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={l.incluir}
                    onChange={(e) => setLineas((ls) => ls.map((x, j) => (j === i ? { ...x, incluir: e.target.checked } : x)))}
                  />
                  <span className="flex-1 text-slate-300">{l.descripcion}</span>
                  <Input
                    type="number"
                    min="0"
                    value={l.cantidad}
                    onChange={(e) => setLineas((ls) => ls.map((x, j) => (j === i ? { ...x, cantidad: e.target.value } : x)))}
                    className="w-24"
                  />
                  <span className="w-6 text-slate-500">{l.unidad}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[11px] text-slate-500">
              Después, en la obra, se puede vincular cada línea con su artículo del inventario para que el consumo se descuente.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variante="fantasma" onClick={onCerrar}>
              Cancelar
            </Button>
            <Button variante="primario" icon={Hammer} cargando={enviando} disabled={!cuadrilla} onClick={convertir}>
              Crear la obra
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
