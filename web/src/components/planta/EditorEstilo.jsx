import { useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { ETIQUETA } from '../../lib/kmz'
import { LINEAS } from '../../lib/planta'
import { Button, Field, Input, Modal, Select, Textarea } from '../ui'

/**
 * Crear o editar una capa propia, o el estilo de un tipo (migración 235).
 *
 * `objetivo`:
 *   { capa: {...} }                       una capa existente
 *   { capa: { clase: 'cable' } }          una capa nueva
 *   { tipo: 'c:troncal', estilo: {...} }  el estilo de un tipo
 */

const TIPOS_CABLE = { troncal: 'Troncal', feeder: 'Feeder', distribucion: 'Distribución', drop: 'Drop', hilo: 'Hilo', otro: 'Otro' }

export default function EditorEstilo({ objetivo, elementos = [], cables = [], onCerrar, onGuardado, onError }) {
  const esTipo = Boolean(objetivo.tipo)
  const inicial = esTipo
    ? { linea: 'solida', opacidad: 0.9, ...objetivo.estilo }
    : { nombre: '', clase: 'cable', color: '#dc2626', tamano: 5, linea: 'solida', opacidad: 0.9, visible: true, descripcion: '', ...objetivo.capa }
  const [f, setF] = useState(inicial)
  const [guardando, setGuardando] = useState(false)
  const [mover, setMover] = useState({ carpeta: '', tipo: '' })
  const [movidos, setMovidos] = useState(null)
  const clase = esTipo ? (objetivo.tipo.startsWith('c:') ? 'cable' : 'elemento') : f.clase
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  // Las carpetas del KMZ de lo que se puede mover a esta capa.
  const carpetas = useMemo(() => {
    const lista = clase === 'cable' ? cables : elementos
    const c = new Map()
    for (const x of lista) {
      const k = x.origen?.carpeta
      if (k) c.set(k, (c.get(k) ?? 0) + 1)
    }
    return [...c].sort((a, b) => a[0].localeCompare(b[0]))
  }, [clase, elementos, cables])

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    const estilo = { color: f.color, tamano: Number(f.tamano), linea: f.linea, opacidad: Number(f.opacidad) }
    const r = esTipo
      ? await supabase.from('planta_estilos').update(estilo).eq('clave', objetivo.tipo)
      : f.id
        ? await supabase
            .from('planta_capas')
            .update({ ...estilo, nombre: f.nombre.trim(), visible: f.visible, descripcion: f.descripcion || null })
            .eq('id', f.id)
        : await supabase
            .from('planta_capas')
            .insert({ ...estilo, nombre: f.nombre.trim(), clase: f.clase, visible: f.visible, descripcion: f.descripcion || null })
            .select('id')
            .single()
    setGuardando(false)
    if (r.error) return onError(r.error)
    if (!esTipo && !f.id && r.data?.id) setF((v) => ({ ...v, id: r.data.id }))
    onGuardado()
    if (esTipo || f.id) onCerrar()
  }

  async function moverACapa() {
    const { data, error } = await supabase.rpc('mover_a_capa', {
      p_capa: f.id,
      p_clase: clase,
      p_carpeta: mover.carpeta || null,
      p_tipo: mover.tipo || null,
    })
    if (error) return onError(error)
    setMovidos(data)
    onGuardado()
  }

  async function borrar() {
    if (!window.confirm(`¿Borrar la capa "${f.nombre}"? Lo que tenía no se borra: vuelve a su tipo.`)) return
    const { error } = await supabase.from('planta_capas').delete().eq('id', f.id)
    if (error) return onError(error)
    onGuardado()
    onCerrar()
  }

  const titulo = esTipo
    ? `Estilo: ${objetivo.tipo.startsWith('c:') ? `cable ${TIPOS_CABLE[objetivo.tipo.slice(2)]}` : ETIQUETA[objetivo.tipo.slice(2)]}`
    : f.id
      ? `Capa: ${f.nombre}`
      : 'Nueva capa'

  return (
    <Modal abierto titulo={titulo} onCerrar={onCerrar}>
      <form onSubmit={guardar} className="space-y-4">
        {!esTipo && (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Nombre" className="col-span-2">
              <Input value={f.nombre} onChange={set('nombre')} required maxLength={80} placeholder="Ej.: Feeder principal" />
            </Field>
            <Field label="Es de">
              <Select value={f.clase} onChange={set('clase')} disabled={Boolean(f.id)}>
                <option value="cable">Cables</option>
                <option value="elemento">Puntos</option>
              </Select>
            </Field>
          </div>
        )}

        <div className="flex items-center gap-4 rounded-xl border border-slate-800 p-3">
          <svg width="90" height="40" aria-hidden="true">
            {clase === 'cable' ? (
              <line
                x1="6"
                y1="20"
                x2="84"
                y2="20"
                stroke={f.color}
                strokeWidth={f.tamano}
                strokeOpacity={f.opacidad}
                strokeDasharray={f.linea === 'rayada' ? '12 8' : f.linea === 'punteada' ? '2 7' : undefined}
                strokeLinecap="round"
              />
            ) : (
              <circle cx="45" cy="20" r={Math.min(18, Number(f.tamano))} fill={f.color} fillOpacity={f.opacidad} stroke="#fff" strokeWidth="1.2" />
            )}
          </svg>
          <span className="text-[12px] text-slate-400">Así se va a ver en el mapa.</span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Color">
            <div className="flex items-center gap-2">
              <input type="color" value={f.color} onChange={set('color')} className="h-9 w-12 cursor-pointer rounded border border-slate-700" />
              <Input value={f.color} onChange={set('color')} pattern="^#[0-9A-Fa-f]{6}$" maxLength={7} />
            </div>
          </Field>
          <Field label={clase === 'cable' ? `Grosor: ${f.tamano} px` : `Tamaño: ${f.tamano} px`}>
            <input type="range" min="1" max="30" step="0.5" value={f.tamano} onChange={set('tamano')} className="w-full" />
          </Field>
          {clase === 'cable' && (
            <Field label="Línea">
              <Select value={f.linea} onChange={set('linea')}>
                {Object.entries(LINEAS).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={`Opacidad: ${Math.round(Number(f.opacidad) * 100)}%`}>
            <input type="range" min="0.1" max="1" step="0.05" value={f.opacidad} onChange={set('opacidad')} className="w-full" />
          </Field>
        </div>

        {!esTipo && (
          <>
            <label className="flex items-center gap-2 text-[12px] text-slate-300">
              <input type="checkbox" checked={f.visible} onChange={set('visible')} /> Encendida al abrir el mapa
            </label>
            <Field label="Descripción" hint="opcional">
              <Textarea rows={2} value={f.descripcion ?? ''} onChange={set('descripcion')} />
            </Field>
          </>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          {!esTipo && f.id && (
            <Button type="button" variante="fantasma" icon={Trash2} onClick={borrar} className="mr-auto">
              Borrar capa
            </Button>
          )}
          <Button type="button" variante="fantasma" onClick={onCerrar}>
            Cerrar
          </Button>
          <Button type="submit" variante="primario" cargando={guardando}>
            {f.id || esTipo ? 'Guardar' : 'Crear capa'}
          </Button>
        </div>
      </form>

      {!esTipo && f.id && (
        <div className="mt-5 space-y-3 border-t border-slate-800 pt-4">
          <p className="text-xs font-semibold text-slate-400">Pasar a esta capa, de una vez</p>
          <p className="text-[11px] text-slate-500">
            Por ejemplo: todos los cables troncales de la carpeta TENDIDO HOME LINK. También se puede cambiar uno por uno
            desde su ficha.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Carpeta del KMZ">
              <Select value={mover.carpeta} onChange={(e) => setMover((m) => ({ ...m, carpeta: e.target.value }))}>
                <option value="">— cualquiera —</option>
                {carpetas.map(([k, n]) => (
                  <option key={k} value={k}>
                    {k} ({n})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Tipo">
              <Select value={mover.tipo} onChange={(e) => setMover((m) => ({ ...m, tipo: e.target.value }))}>
                <option value="">— cualquiera —</option>
                {Object.entries(clase === 'cable' ? TIPOS_CABLE : ETIQUETA).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex items-center gap-3">
            <Button type="button" onClick={moverACapa} disabled={!mover.carpeta && !mover.tipo}>
              Pasar a “{f.nombre}”
            </Button>
            {movidos != null && <span className="text-[12px] text-emerald-400">{movidos} pasaron a esta capa.</span>}
          </div>
        </div>
      )}
    </Modal>
  )
}
