import { useEffect, useState } from 'react'
import { GitMerge, MapPin, Route, X } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { ETIQUETA } from '../../lib/kmz'
import { COLOR_HILO, LINEAS, resolverEstilo } from '../../lib/planta'
import { Badge, Button, Field, Input, Select, Textarea } from '../ui'
import SelectorIcono from './SelectorIcono'
import { colorHilo, describir } from '../../lib/hilos'

/**
 * La ficha de lo elegido en el mapa de planta externa: ver, editar, cambiar de
 * capa y, si hace falta, darle un color o grosor propio (migración 235).
 */

export const TIPOS_CABLE = {
  troncal: 'Troncal',
  feeder: 'Feeder',
  distribucion: 'Distribución',
  drop: 'Drop',
  hilo: 'Hilo',
  otro: 'Otro',
}
const VERIF = { importado: 'Importado (sin verificar)', oficina: 'Revisado en oficina', campo: 'Verificado en campo' }
const ESTADO = { existente: 'Existente', proyectado: 'Proyectado', retirado: 'Retirado' }

export default function FichaPlanta({
  x,
  clase,
  edita,
  elementos,
  capas,
  estilos,
  onCerrar,
  onCambio,
  onError,
  onMover,
  onRuta,
  onDiagrama,
  presupuesto = null,
  usoHilos = [],
  red = null,
}) {
  const [f, setF] = useState(x)
  const [guardando, setGuardando] = useState(false)
  useEffect(() => setF(x), [x])
  const tabla = clase === 'e' ? 'planta_elementos' : 'planta_cables'
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }))
  const n = (v) => (v === '' || v == null ? null : Number(v))
  const capasDeClase = [...capas.values()].filter((c) => c.clase === (clase === 'e' ? 'elemento' : 'cable'))
  // El estilo que tendría sin uno propio: para mostrar qué se está pisando.
  const heredado = resolverEstilo({ ...f, color: null, tamano: null, linea: null, icono: null }, clase, { capas, estilos })
  const propio = Boolean(f.color || f.tamano || f.linea || f.icono)
  const [verIconos, setVerIconos] = useState(false)

  async function guardar(extra = {}) {
    setGuardando(true)
    const comunes = {
      nombre: f.nombre?.trim() || x.nombre,
      estado: f.estado,
      descripcion: f.descripcion || null,
      capa_id: f.capa_id || null,
      color: f.color || null,
      tamano: n(f.tamano),
      ...extra,
    }
    const fila =
      clase === 'e'
        ? {
            ...comunes,
            tipo: f.tipo,
            capacidad: n(f.capacidad),
            hilos: n(f.hilos),
            splitter: f.splitter || null,
            herraje: f.herraje || null,
            metros: n(f.metros),
            icono: f.icono || null,
          }
        : {
            ...comunes,
            tipo: f.tipo,
            hilos: n(f.hilos),
            color_hilo: f.color_hilo || null,
            linea: f.linea || null,
            hilos_por_tubo: n(f.hilos_por_tubo),
          }
    const { error } = await supabase.from(tabla).update(fila).eq('id', x.id)
    setGuardando(false)
    if (error) return onError(error)
    onCambio()
  }

  async function borrar() {
    if (!window.confirm(`¿Borrar "${x.nombre}" del mapa?`)) return
    const { error } = await supabase.from(tabla).delete().eq('id', x.id)
    if (error) return onError(error)
    onCerrar()
    onCambio()
  }

  const extremo = (id) => elementos.find((e) => e.id === id)?.nombre

  return (
    <div className="space-y-3 text-[12px]">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] text-slate-500">{clase === 'e' ? ETIQUETA[x.tipo] : `Cable ${TIPOS_CABLE[x.tipo] ?? x.tipo}`}</p>
          <p className="text-[14px] font-semibold text-slate-100">{x.nombre}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge color={x.verificacion === 'campo' ? 'verde' : x.verificacion === 'oficina' ? 'azul' : 'ambar'}>{VERIF[x.verificacion]}</Badge>
            {x.estado !== 'existente' && <Badge color="gris">{ESTADO[x.estado]}</Badge>}
            {x.capa_id && capas.get(x.capa_id) && <Badge color="azul">{capas.get(x.capa_id).nombre}</Badge>}
          </div>
        </div>
        <button type="button" onClick={onCerrar} className="text-slate-500" aria-label="Cerrar">
          <X size={16} />
        </button>
      </div>

      {x.revisar?.length > 0 && (
        <div className="rounded-lg bg-amber-500/10 p-2 text-amber-300">
          {x.revisar.map((r) => (
            <p key={r}>• {r}</p>
          ))}
        </div>
      )}

      {clase === 'e' && x.tipo === 'nap' && (
        <p className="text-slate-300">
          {x.abonados ?? 0} abonado(s){x.capacidad ? ` de ${x.capacidad} puertos · ${x.libres} libres` : ''}
          {x.caja && x.caja !== x.nombre?.toUpperCase() && <span className="block text-slate-500">Caja en el sistema: {x.caja}</span>}
        </p>
      )}
      {clase === 'c' && (
        <p className="text-slate-300">
          {Math.round(x.longitud_m ?? 0)} m de ruta
          {(x.desde_id || x.hasta_id) && (
            <span className="block text-slate-500">
              {extremo(x.desde_id) ?? '—'} → {extremo(x.hasta_id) ?? '—'}
            </span>
          )}
        </p>
      )}
      {clase === 'e' && (
        <a
          href={`https://www.google.com/maps?q=${x.latitud},${x.longitud}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-sky-400"
        >
          <MapPin size={12} /> {Number(x.latitud).toFixed(6)}, {Number(x.longitud).toFixed(6)}
        </a>
      )}
      {clase === 'e' && !['poste', 'reserva'].includes(x.tipo) && onDiagrama && (
        <Button icon={GitMerge} onClick={onDiagrama} className="w-full">
          Hilos, splitters y presupuesto
        </Button>
      )}
      {presupuesto && x.tipo === 'nap' && (
        <p
          className={
            presupuesto.estado === 'bien'
              ? 'text-emerald-400'
              : presupuesto.estado === 'atencion'
                ? 'text-amber-400'
                : presupuesto.estado === 'mal'
                  ? 'text-rose-400'
                  : 'text-slate-500'
          }
        >
          {presupuesto.ok
            ? `Debería llegar ${presupuesto.rxSalida} dBm · margen ${presupuesto.margen} dB (${presupuesto.pon.nombre})`
            : `Presupuesto: ${presupuesto.error}`}
        </p>
      )}
      {clase === 'c' && usoHilos.length > 0 && red && (
        <div className="space-y-0.5">
          <p className="text-[11px] font-semibold text-slate-400">Hilos en uso ({new Set(usoHilos.flatMap((u) => [u.a_id === x.id ? u.a_num : null, u.b_id === x.id ? u.b_num : null]).filter(Boolean)).size})</p>
          {usoHilos.slice(0, 12).map((u) => {
            const mio = u.a_tipo === 'hilo' && u.a_id === x.id ? 'a' : 'b'
            const otro = mio === 'a' ? 'b' : 'a'
            const num = u[`${mio}_num`]
            const col = colorHilo(num, x.hilos_por_tubo)
            return (
              <p key={u.id} className="flex items-center gap-1 text-[11px] text-slate-300">
                <span className="h-2.5 w-2.5 rounded-full border border-slate-400" style={{ background: col.color }} />
                {num} → {describir(red, { tipo: u[`${otro}_tipo`], id: u[`${otro}_id`], num: u[`${otro}_num`], lado: u[`${otro}_lado`] })}
                <span className="text-slate-500">({elementos.find((e) => e.id === u.elemento_id)?.nombre})</span>
              </p>
            )
          })}
        </div>
      )}
      {x.foto_url && (
        <a href={x.foto_url} target="_blank" rel="noreferrer" className="text-sky-400">
          Ver foto del KMZ
        </a>
      )}

      {edita ? (
        <div className="space-y-2">
          <Field label="Nombre (como está rotulado)">
            <Input value={f.nombre ?? ''} onChange={set('nombre')} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Tipo">
              <Select value={f.tipo} onChange={set('tipo')}>
                {Object.entries(clase === 'e' ? ETIQUETA : TIPOS_CABLE).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Estado">
              <Select value={f.estado} onChange={set('estado')}>
                {Object.entries(ESTADO).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Capa">
            <Select value={f.capa_id ?? ''} onChange={set('capa_id')}>
              <option value="">— ninguna (estilo de su tipo) —</option>
              {capasDeClase.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            {(clase === 'c' || f.tipo === 'manga') && (
              <Field label="Hilos">
                <Input type="number" min="1" value={f.hilos ?? ''} onChange={set('hilos')} />
              </Field>
            )}
            {clase === 'c' && (
              <Field label="Hilos por tubo">
                <Input type="number" min="1" max="24" value={f.hilos_por_tubo ?? ''} onChange={set('hilos_por_tubo')} placeholder="12" />
              </Field>
            )}
            {clase === 'c' && f.tipo === 'hilo' && (
              <Field label="Color del hilo">
                <Select value={f.color_hilo ?? ''} onChange={set('color_hilo')}>
                  <option value="">—</option>
                  {Object.keys(COLOR_HILO).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {clase === 'e' && f.tipo === 'nap' && (
              <Field label="Puertos">
                <Input type="number" min="1" value={f.capacidad ?? ''} onChange={set('capacidad')} />
              </Field>
            )}
            {clase === 'e' && (f.tipo === 'nap' || f.tipo === 'splitter') && (
              <Field label="Splitter">
                <Select value={f.splitter ?? ''} onChange={set('splitter')}>
                  <option value="">—</option>
                  {['1:2', '1:4', '1:8', '1:16', '1:32', '1:64'].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {clase === 'e' && f.tipo === 'poste' && (
              <Field label="Herraje">
                <Select value={f.herraje ?? ''} onChange={set('herraje')}>
                  <option value="">—</option>
                  <option value="A">A · anclaje / retención</option>
                  <option value="J">J · suspensión</option>
                </Select>
              </Field>
            )}
            {clase === 'e' && f.tipo === 'reserva' && (
              <Field label="Metros de reserva">
                <Input type="number" min="0" value={f.metros ?? ''} onChange={set('metros')} />
              </Field>
            )}
          </div>

          <div className="space-y-2 rounded-lg border border-slate-800 p-2">
            <p className="flex items-center justify-between text-[11px] font-semibold text-slate-400">
              Estilo propio
              {propio && (
                <button
                  type="button"
                  onClick={() => setF((v) => ({ ...v, color: null, tamano: null, linea: null, icono: null }))}
                  className="font-normal text-sky-400"
                >
                  Usar el de {f.capa_id ? 'la capa' : 'su tipo'}
                </button>
              )}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Color">
                <input
                  type="color"
                  value={f.color || heredado.color}
                  onChange={set('color')}
                  className="h-9 w-full cursor-pointer rounded border border-slate-700"
                />
              </Field>
              <Field label={`${clase === 'c' ? 'Grosor' : 'Tamaño'}: ${f.tamano || heredado.tamano} px`}>
                <input
                  type="range"
                  min="1"
                  max="30"
                  step="0.5"
                  value={f.tamano || heredado.tamano}
                  onChange={set('tamano')}
                  className="w-full"
                />
              </Field>
              {clase === 'c' && (
                <Field label="Línea">
                  <Select value={f.linea ?? ''} onChange={set('linea')}>
                    <option value="">— la de {f.capa_id ? 'la capa' : 'su tipo'} —</option>
                    {Object.entries(LINEAS).map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            {clase === 'e' && (
              <div>
                <button type="button" onClick={() => setVerIconos((v) => !v)} className="text-[11px] text-sky-400">
                  {verIconos ? 'Ocultar íconos' : f.icono ? 'Cambiar el ícono' : 'Elegir un ícono propio'}
                </button>
                {verIconos && (
                  <div className="mt-1">
                    <SelectorIcono
                      valor={f.icono}
                      color={f.color || heredado.color}
                      onCambio={(k) => setF((v) => ({ ...v, icono: k }))}
                      vacio={`— el de ${f.capa_id ? 'la capa' : 'su tipo'} —`}
                    />
                  </div>
                )}
              </div>
            )}
            {!propio && <p className="text-[11px] text-slate-500">Hoy toma el de {f.capa_id ? 'su capa' : 'su tipo'}.</p>}
          </div>

          <Field label="Descripción">
            <Textarea rows={2} value={f.descripcion ?? ''} onChange={set('descripcion')} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variante="primario" cargando={guardando} onClick={() => guardar()}>
              Guardar
            </Button>
            {(x.verificacion === 'importado' || x.revisar?.length > 0) && (
              <Button cargando={guardando} onClick={() => guardar({ verificacion: x.verificacion === 'campo' ? 'campo' : 'oficina', revisar: [] })}>
                Guardar como revisado
              </Button>
            )}
            {clase === 'e' ? (
              <Button variante="fantasma" icon={MapPin} onClick={onMover}>
                Mover
              </Button>
            ) : (
              <Button variante="fantasma" icon={Route} onClick={onRuta}>
                Redibujar ruta
              </Button>
            )}
            <Button variante="fantasma" onClick={borrar}>
              Borrar
            </Button>
          </div>
        </div>
      ) : (
        x.descripcion && <p className="text-slate-400">{x.descripcion}</p>
      )}
    </div>
  )
}
