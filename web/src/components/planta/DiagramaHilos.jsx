import { useMemo, useState } from 'react'
import { Cable, Link2, Plus, Radio, Split, Trash2, X } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { ETIQUETA } from '../../lib/kmz'
import {
  cadenamiento,
  colorHilo,
  compararMedido,
  describir,
  presupuestoCaja,
  salidasDe,
  sentido,
  trazarDesdePon,
} from '../../lib/hilos'
import { Badge, Button, Field, Input, Modal, Select } from '../ui'

/**
 * El diagrama de hilos de una caja, manga o nodo (migración 237).
 *
 * A la izquierda lo que hay en la caja: cables (con sus hilos en colores),
 * splitters y puertos PON. Se toca un extremo y después otro, y queda la
 * unión (fusión o conector). Abajo, el presupuesto óptico de la caja hasta su
 * puerto PON, y lo medido en campo al lado.
 *
 * Lo que no se puede deducir se pregunta: si un cable pasa de largo por la
 * manga, al tocar un hilo hay que decir de qué lado es el pedazo que se une.
 */

const RELACIONES = ['1:2', '1:4', '1:8', '1:16', '1:32', '1:64', '5/95', '10/90', '15/85', '20/80', '30/70', '40/60', '50/50']
const CERCA_M = 25

const k = (x) => `${x.tipo}|${x.id}|${x.num ?? ''}|${x.lado ?? ''}`

export default function DiagramaHilos({ elemento: E, datos, red, optica, medido, abonados = [], edita, onCerrar, onCambio, onError }) {
  const { cables, splitters, pons, uniones, olts = [] } = datos
  const [primero, setPrimero] = useState(null)
  const [preguntaLado, setPreguntaLado] = useState(null) // { cable, num }
  const [tipoUnion, setTipoUnion] = useState('fusion')
  const [perdida, setPerdida] = useState('')
  const [nuevoSplitter, setNuevoSplitter] = useState(E.tipo === 'nap' ? `1:${E.capacidad && [2, 4, 8, 16, 32, 64].includes(Number(E.capacidad)) ? E.capacidad : 8}` : '1:8')
  const [nuevoPon, setNuevoPon] = useState(null)
  const [verPon, setVerPon] = useState(null)
  const [ocupado, setOcupado] = useState(false)

  const misUniones = uniones.filter((u) => u.elemento_id === E.id)
  const misSplitters = splitters.filter((s) => s.elemento_id === E.id)
  const misPon = pons.filter((p) => p.elemento_id === E.id)

  // Los cables de esta caja: los que empiezan o terminan acá, los que tienen
  // hilos unidos acá, y los que pasan a menos de 25 m (sugeridos).
  const cablesAqui = useMemo(() => {
    const usados = new Set(misUniones.flatMap((u) => [u.a_tipo === 'hilo' && u.a_id, u.b_tipo === 'hilo' && u.b_id]).filter(Boolean))
    return cables
      .map((c) => {
        const extremo = c.desde_id === E.id ? 'desde' : c.hasta_id === E.id ? 'hasta' : null
        const p = cadenamiento(c.ruta, [Number(E.latitud), Number(E.longitud)])
        const cerca = p.d <= CERCA_M
        if (!extremo && !usados.has(c.id) && !cerca) return null
        return { c, extremo, distancia: Math.round(p.d), pasa: !extremo }
      })
      .filter(Boolean)
      .sort((a, b) => (a.extremo ? 0 : 1) - (b.extremo ? 0 : 1) || a.distancia - b.distancia)
  }, [cables, misUniones, E])

  // Con quién está unido cada extremo en esta caja.
  const unidoCon = useMemo(() => {
    const m = new Map()
    for (const u of misUniones) {
      const a = { tipo: u.a_tipo, id: u.a_id, num: u.a_num, lado: u.a_lado }
      const b = { tipo: u.b_tipo, id: u.b_id, num: u.b_num, lado: u.b_lado }
      m.set(k(a), { u, otro: b })
      m.set(k(b), { u, otro: a })
    }
    return m
  }, [misUniones])

  const presupuesto = useMemo(() => (misSplitters.length ? presupuestoCaja(red, E.id, optica) : null), [red, E.id, optica, misSplitters.length])
  const comparacion = presupuesto?.ok ? compararMedido(presupuesto, medido?.medido_dbm ?? medido?.rx_promedio, optica) : null

  async function correr(fn) {
    setOcupado(true)
    const { error } = await fn()
    setOcupado(false)
    if (error) return onError(error)
    onCambio()
  }

  async function tocar(x) {
    if (!edita) return
    // Un hilo de un cable que pasa de largo: hay que decir de qué lado.
    if (x.tipo === 'hilo' && !x.lado && !sentido(red, E.id, x)) return setPreguntaLado(x)
    if (!primero) return setPrimero(x)
    if (k(primero) === k(x)) return setPrimero(null)
    const a = primero
    setPrimero(null)
    const tipo = a.tipo === 'pon' || x.tipo === 'pon' ? 'conector' : tipoUnion
    await correr(() =>
      supabase.from('planta_uniones').insert({
        elemento_id: E.id,
        a_tipo: a.tipo,
        a_id: a.id,
        a_num: a.num,
        a_lado: a.lado ?? null,
        b_tipo: x.tipo,
        b_id: x.id,
        b_num: x.num,
        b_lado: x.lado ?? null,
        tipo,
        perdida_db: perdida === '' ? null : Number(perdida),
      }),
    )
    setPerdida('')
  }

  const Extremo = ({ x, etiqueta, color = null, colorTubo = null, chico = false }) => {
    const usado = unidoCon.get(k(x))
    const elegido = primero && k(primero) === k(x)
    return (
      <button
        type="button"
        onClick={() => tocar(x)}
        title={usado ? `Unido con ${describir(red, usado.otro)}` : edita ? 'Tocá para unir' : 'Libre'}
        className={`relative flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${
          elegido ? 'border-sky-500 ring-2 ring-sky-400' : usado ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-slate-700'
        } ${chico ? 'min-w-[38px] justify-center' : ''}`}
      >
        {colorTubo && <span className="h-3 w-1 rounded-sm" style={{ background: colorTubo }} />}
        {color && <span className="h-3 w-3 rounded-full border border-slate-400" style={{ background: color }} />}
        <span className="text-slate-200">{etiqueta}</span>
        {usado && <Link2 size={10} className="text-emerald-400" />}
      </button>
    )
  }

  const abonadosDe = (salida) =>
    abonados.filter((a) => E.punto_id && a.nap_id === E.punto_id && String(a.puerto_nap) === String(salida)).map((a) => a.nombre)

  return (
    <Modal abierto titulo={`Hilos y presupuesto · ${E.nombre}`} onCerrar={onCerrar} ancho="max-w-6xl">
      <div className="space-y-5 text-[12px]">
        <p className="text-slate-400">
          {ETIQUETA[E.tipo]}
          {edita && ' · Tocá un extremo y después otro para unirlos. Tocá un extremo unido para ver con qué está.'}
        </p>

        {edita && (
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-800 p-2">
            <Field label="Tipo de unión">
              <Select value={tipoUnion} onChange={(e) => setTipoUnion(e.target.value)}>
                <option value="fusion">Fusión</option>
                <option value="conector">Conector</option>
              </Select>
            </Field>
            <Field label="Pérdida medida (dB)" hint="opcional: la de la empalmadora">
              <Input type="number" step="0.01" min="0" value={perdida} onChange={(e) => setPerdida(e.target.value)} className="w-28" />
            </Field>
            {primero ? (
              <span className="rounded-lg bg-sky-500/10 px-2 py-1.5 text-sky-300">
                Elegido: {describir(red, primero)} · tocá el otro extremo
                <button type="button" onClick={() => setPrimero(null)} className="ml-2 text-slate-400">
                  <X size={12} className="inline" />
                </button>
              </span>
            ) : (
              <span className="text-slate-500">Nada elegido.</span>
            )}
          </div>
        )}

        {preguntaLado && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200">
            El cable pasa de largo por {E.nombre}. ¿Qué pedazo del hilo {preguntaLado.num} se une?
            <div className="mt-2 flex gap-2">
              {[
                ['d', 'El que va hacia el inicio del cable'],
                ['h', 'El que va hacia el final'],
              ].map(([l, t]) => (
                <Button
                  key={l}
                  onClick={() => {
                    const x = { ...preguntaLado, lado: l }
                    setPreguntaLado(null)
                    tocar(x)
                  }}
                >
                  {t}
                </Button>
              ))}
              <Button variante="fantasma" onClick={() => setPreguntaLado(null)}>
                Cancelar
              </Button>
            </div>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-2">
          {/* ── Cables ── */}
          <section className="space-y-2">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <Cable size={12} /> Cables en esta caja ({cablesAqui.length})
            </p>
            {!cablesAqui.length && <p className="text-slate-500">Ningún cable empieza, termina ni pasa por acá.</p>}
            {cablesAqui.map(({ c, extremo, distancia, pasa }) => {
              const n = Number(c.hilos) || 0
              return (
                <div key={c.id} className="space-y-1.5 rounded-lg border border-slate-800 p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-100">{c.nombre}</span>
                    <span className="text-slate-500">
                      {n || '?'} hilos{c.hilos_por_tubo ? ` · ${Math.ceil(n / c.hilos_por_tubo)}×${c.hilos_por_tubo}` : ''}
                    </span>
                    {extremo ? (
                      <Badge color="azul">{extremo === 'desde' ? 'empieza acá' : 'termina acá'}</Badge>
                    ) : (
                      <Badge color="gris">pasa a {distancia} m</Badge>
                    )}
                    {edita && pasa && (
                      <span className="ml-auto flex gap-1">
                        <Button
                          variante="fantasma"
                          onClick={() => correr(() => supabase.from('planta_cables').update({ desde_id: E.id }).eq('id', c.id))}
                        >
                          Empieza acá
                        </Button>
                        <Button
                          variante="fantasma"
                          onClick={() => correr(() => supabase.from('planta_cables').update({ hasta_id: E.id }).eq('id', c.id))}
                        >
                          Termina acá
                        </Button>
                      </span>
                    )}
                  </div>
                  {!n ? (
                    <p className="text-amber-400">Cargale cuántos hilos tiene (en su ficha) para poder unirlos.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {Array.from({ length: n }, (_, i) => i + 1).map((h) => {
                        const col = colorHilo(h, c.hilos_por_tubo)
                        const x = { tipo: 'hilo', id: c.id, num: h, lado: null }
                        // En un cable que pasa, el hilo puede estar unido de un lado, del otro o de los dos.
                        const d = unidoCon.get(k({ ...x, lado: 'd' }))
                        const hh = unidoCon.get(k({ ...x, lado: 'h' }))
                        return pasa && (d || hh) ? (
                          <span key={h} className="flex gap-0.5">
                            <Extremo x={{ ...x, lado: 'd' }} etiqueta={`${h}↑`} color={col.color} colorTubo={col.colorTubo} chico />
                            <Extremo x={{ ...x, lado: 'h' }} etiqueta={`${h}↓`} color={col.color} colorTubo={col.colorTubo} chico />
                          </span>
                        ) : (
                          <Extremo key={h} x={x} etiqueta={String(h)} color={col.color} colorTubo={col.colorTubo} chico />
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
            <p className="text-[11px] text-slate-500">
              La barrita es el color del tubo; el círculo, el del hilo (TIA-598). ↑ el pedazo que va hacia el inicio del cable, ↓ el
              que va hacia el final.
            </p>
          </section>

          {/* ── Splitters y PON ── */}
          <section className="space-y-4">
            <div className="space-y-2">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <Split size={12} /> Splitters ({misSplitters.length})
              </p>
              {misSplitters.map((s) => {
                const n = salidasDe(s.relacion)
                return (
                  <div key={s.id} className="space-y-1.5 rounded-lg border border-slate-800 p-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-100">Splitter {s.relacion}</span>
                      {s.nombre && <span className="text-slate-500">{s.nombre}</span>}
                      {edita && (
                        <button
                          type="button"
                          className="ml-auto text-slate-500 hover:text-rose-400"
                          onClick={() => window.confirm('¿Quitar el splitter y sus uniones?') && correr(() => supabase.from('planta_splitters').delete().eq('id', s.id))}
                          aria-label="Quitar splitter"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <Extremo x={{ tipo: 'splitter', id: s.id, num: 0, lado: null }} etiqueta="Entrada" />
                      <span className="text-slate-600">→</span>
                      {Array.from({ length: n }, (_, i) => i + 1).map((o) => {
                        const ab = E.tipo === 'nap' ? abonadosDe(o) : []
                        return (
                          <span key={o} title={ab.join(', ')}>
                            <Extremo x={{ tipo: 'splitter', id: s.id, num: o, lado: null }} etiqueta={ab.length ? `${o}·${ab[0].split(' ')[0]}` : String(o)} chico />
                          </span>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
              {edita && (
                <div className="flex items-end gap-2">
                  <Field label="Agregar splitter">
                    <Select value={nuevoSplitter} onChange={(e) => setNuevoSplitter(e.target.value)}>
                      {RELACIONES.map((r) => (
                        <option key={r} value={r}>
                          {r.includes('/') ? `${r} (desbalanceado)` : r}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Button
                    icon={Plus}
                    cargando={ocupado}
                    onClick={() => correr(() => supabase.from('planta_splitters').insert({ elemento_id: E.id, relacion: nuevoSplitter }))}
                  >
                    Agregar
                  </Button>
                </div>
              )}
            </div>

            {(misPon.length > 0 || ['nodo', 'odf'].includes(E.tipo)) && (
              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  <Radio size={12} /> Puertos PON ({misPon.length})
                </p>
                {misPon.map((p) => {
                  const d = verPon === p.id ? trazarDesdePon(red, p.id, optica) : null
                  return (
                    <div key={p.id} className="space-y-1.5 rounded-lg border border-slate-800 p-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Extremo x={{ tipo: 'pon', id: p.id, num: null, lado: null }} etiqueta={p.nombre} />
                        <span className="text-slate-500">
                          {p.clase} · {Number(p.tx_dbm) > 0 ? '+' : ''}
                          {p.tx_dbm} dBm
                        </span>
                        <button type="button" className="text-sky-400" onClick={() => setVerPon(verPon === p.id ? null : p.id)}>
                          {verPon === p.id ? 'Ocultar' : 'Qué alimenta'}
                        </button>
                        {edita && (
                          <button
                            type="button"
                            className="ml-auto text-slate-500 hover:text-rose-400"
                            onClick={() => window.confirm('¿Quitar el puerto PON y su unión?') && correr(() => supabase.from('planta_pon').delete().eq('id', p.id))}
                            aria-label="Quitar puerto"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                      {d && (
                        <div className="space-y-1 text-[11px]">
                          <p className="text-slate-300">
                            Hilos: {d.hilos.map((h) => `${red.cab.get(h.cable)?.nombre ?? '?'} #${h.num}`).join(' → ') || '—'}
                          </p>
                          <p className="text-slate-300">
                            Cajas: {d.cajas.map((c) => `${red.el.get(c.elemento)?.nombre} (${c.rxSalida} dBm)`).join(', ') || 'ninguna todavía'}
                          </p>
                          {d.cortes.map((c) => (
                            <p key={c} className="text-amber-400">
                              {c}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
                {edita &&
                  (nuevoPon ? (
                    <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-800 p-2 sm:grid-cols-3">
                      <Field label="Nombre">
                        <Input value={nuevoPon.nombre} onChange={(e) => setNuevoPon((v) => ({ ...v, nombre: e.target.value }))} placeholder="OLT1 0/1/3" />
                      </Field>
                      <Field label="Clase">
                        <Select
                          value={nuevoPon.clase}
                          onChange={(e) => setNuevoPon((v) => ({ ...v, clase: e.target.value, tx_dbm: e.target.value === 'B+' ? 3 : 5 }))}
                        >
                          <option>B+</option>
                          <option>C+</option>
                          <option>C++</option>
                        </Select>
                      </Field>
                      <Field label="Potencia de salida (dBm)">
                        <Input type="number" step="0.1" value={nuevoPon.tx_dbm} onChange={(e) => setNuevoPon((v) => ({ ...v, tx_dbm: e.target.value }))} />
                      </Field>
                      <Field label="OLT" hint="opcional">
                        <Select value={nuevoPon.olt_id} onChange={(e) => setNuevoPon((v) => ({ ...v, olt_id: e.target.value }))}>
                          <option value="">—</option>
                          {olts.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.nombre}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Slot">
                        <Input type="number" min="0" value={nuevoPon.slot} onChange={(e) => setNuevoPon((v) => ({ ...v, slot: e.target.value }))} />
                      </Field>
                      <Field label="Puerto">
                        <Input type="number" min="0" value={nuevoPon.puerto} onChange={(e) => setNuevoPon((v) => ({ ...v, puerto: e.target.value }))} />
                      </Field>
                      <div className="col-span-full flex gap-2">
                        <Button
                          variante="primario"
                          disabled={!nuevoPon.nombre.trim()}
                          onClick={async () => {
                            await correr(() =>
                              supabase.from('planta_pon').insert({
                                elemento_id: E.id,
                                nombre: nuevoPon.nombre.trim(),
                                clase: nuevoPon.clase,
                                tx_dbm: Number(nuevoPon.tx_dbm),
                                olt_id: nuevoPon.olt_id || null,
                                slot: nuevoPon.slot === '' ? null : Number(nuevoPon.slot),
                                puerto: nuevoPon.puerto === '' ? null : Number(nuevoPon.puerto),
                              }),
                            )
                            setNuevoPon(null)
                          }}
                        >
                          Agregar puerto
                        </Button>
                        <Button variante="fantasma" onClick={() => setNuevoPon(null)}>
                          Cancelar
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button icon={Plus} onClick={() => setNuevoPon({ nombre: '', clase: 'B+', tx_dbm: 3, olt_id: '', slot: '', puerto: '' })}>
                      Agregar puerto PON
                    </Button>
                  ))}
              </div>
            )}

            {/* ── Uniones ── */}
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Uniones en esta caja ({misUniones.length})</p>
              {!misUniones.length && <p className="text-slate-500">Todavía ninguna.</p>}
              {misUniones.map((u) => (
                <div key={u.id} className="flex items-center gap-2 rounded border border-slate-800 px-2 py-1">
                  <span className="flex-1 text-slate-300">
                    {describir(red, { tipo: u.a_tipo, id: u.a_id, num: u.a_num, lado: u.a_lado })} ↔{' '}
                    {describir(red, { tipo: u.b_tipo, id: u.b_id, num: u.b_num, lado: u.b_lado })}
                  </span>
                  <span className="text-slate-500">
                    {u.tipo === 'conector' ? 'conector' : 'fusión'}
                    {u.perdida_db != null ? ` · ${u.perdida_db} dB` : ''}
                  </span>
                  {edita && (
                    <button
                      type="button"
                      className="text-slate-500 hover:text-rose-400"
                      onClick={() => correr(() => supabase.from('planta_uniones').delete().eq('id', u.id))}
                      aria-label="Quitar unión"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* ── Presupuesto ── */}
        {presupuesto && <Presupuesto p={presupuesto} medido={medido} comparacion={comparacion} optica={optica} />}
      </div>
    </Modal>
  )
}

const ESTADO = {
  bien: { label: 'Bien', clase: 'border-emerald-500/50 text-emerald-300' },
  atencion: { label: 'Justo', clase: 'border-amber-500/50 text-amber-300' },
  mal: { label: 'No alcanza', clase: 'border-rose-500/50 text-rose-300' },
  sin_camino: { label: 'Sin camino al PON', clase: 'border-slate-700 text-slate-300' },
}

export function Presupuesto({ p, medido, comparacion, optica }) {
  const [ver, setVer] = useState(false)
  const e = ESTADO[p.estado]
  return (
    <section className={`space-y-2 rounded-xl border p-3 ${e.clase}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide">Presupuesto óptico · {e.label}</p>
      {!p.ok ? (
        <p>{p.error}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {[
              ['Puerto PON', `${p.pon.nombre} (${Number(p.pon.tx_dbm) > 0 ? '+' : ''}${p.pon.tx_dbm} dBm)`],
              ['Pérdida hasta la caja', `${p.perdidaSalida} dB`],
              ['Debería llegar a la caja', `${p.rxSalida} dBm`],
              ['Al abonado (drop típico)', `${p.rxAbonado} dBm`],
              ['Margen', `${p.margen} dB (mínimo ${optica?.margen_min_db ?? 3})`],
            ].map(([l, v]) => (
              <div key={l} className="rounded-lg bg-black/5 p-2">
                <p className="text-[10.5px] opacity-70">{l}</p>
                <p className="font-bold">{v}</p>
              </div>
            ))}
          </div>
          {(medido?.medido_dbm != null || medido?.rx_promedio != null) && (
            <p>
              {medido?.medido_dbm != null && `Medido en campo: ${medido.medido_dbm} dBm. `}
              {medido?.rx_promedio != null && `ONUs: promedio ${medido.rx_promedio} dBm (${medido.onus}). `}
              {comparacion &&
                (comparacion.alerta
                  ? `Difiere ${comparacion.diferencia} dB de lo calculado: hay algo en el camino (empalme malo, conector sucio o un dato mal cargado).`
                  : `Coincide con lo calculado (${comparacion.diferencia > 0 ? '+' : ''}${comparacion.diferencia} dB).`)}
            </p>
          )}
        </>
      )}
      {p.pasos?.length > 0 && (
        <>
          <button type="button" className="text-[11px] underline" onClick={() => setVer((v) => !v)}>
            {ver ? 'Ocultar el camino' : `Ver el camino (${p.pasos.length} pasos)`}
          </button>
          {ver && (
            <ol className="space-y-0.5 text-[11px]">
              {[...p.pasos].reverse().map((s, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span>{s.texto}</span>
                  <span className="shrink-0 tabular-nums">−{s.perdida.toFixed(2)} dB</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  )
}
