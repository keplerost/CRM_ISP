import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Camera, HardHat, MapPin, ShieldAlert } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { hoyLocal } from '../../lib/soporte'
import { ESTADOS_OBRA, TIPOS_OBRA, diasParaMeta, fmt, progresoMetas } from '../../lib/obras'
import { Badge } from '../ui'
import { useFotosObra } from './fotos'

/**
 * Todo lo de una obra: alcance contra lo hecho, los partes de cada día con sus
 * fotos, las NAP con su potencia, el material contra el presupuesto y la
 * bitácora. Lo usan la oficina y la app de campo; cada una pone sus botones.
 */

/** La obra y todo lo que cuelga de ella. */
export function useObra(id) {
  const [d, setD] = useState(null)
  const recargar = useCallback(async () => {
    if (!id) return setD(null)
    const [o, av, naps, mat, con, bit, falt, cfg] = await Promise.all([
      supabase.from('v_obras_red').select('*').eq('id', id).maybeSingle(),
      supabase.from('v_obra_avances').select('*').eq('obra_id', id).order('fecha', { ascending: false }).order('id', { ascending: false }),
      supabase.from('obra_naps').select('*').eq('obra_id', id).order('nombre'),
      supabase.from('obra_materiales').select('*').eq('obra_id', id).order('descripcion'),
      supabase.from('obra_consumos').select('*').eq('obra_id', id).order('creado_at', { ascending: false }),
      supabase.from('v_obra_bitacora').select('*').eq('obra_id', id).order('creado_at', { ascending: false }),
      supabase.rpc('faltantes_obra', { p_id: id }),
      supabase.from('obras_config').select('*').maybeSingle(),
    ])
    setD({
      obra: o.data,
      error: o.error,
      avances: av.data ?? [],
      naps: naps.data ?? [],
      materiales: mat.data ?? [],
      consumos: con.data ?? [],
      bitacora: bit.data ?? [],
      faltantes: falt.data ?? [],
      config: cfg.data ?? {},
    })
  }, [id])
  useEffect(() => {
    recargar()
  }, [recargar])
  return { d, recargar }
}

const tono = (estado) =>
  ({ bien: 'text-emerald-400', atencion: 'text-amber-400', mal: 'text-rose-400' })[estado] ?? 'text-slate-400'

function Barra({ pct }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
      <div
        className={`h-full rounded-full ${pct >= 100 ? 'bg-emerald-500' : pct >= 50 ? 'bg-sky-500' : 'bg-amber-500'}`}
        style={{ width: `${Math.max(2, pct ?? 0)}%` }}
      />
    </div>
  )
}

export function EncabezadoObra({ o, enlaceTicket = true }) {
  const dias = diasParaMeta(o.fecha_meta, hoyLocal())
  const est = ESTADOS_OBRA[o.estado] ?? { label: o.estado, color: 'gris' }
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <span>
          #{o.numero} · {TIPOS_OBRA[o.tipo] ?? o.tipo}
        </span>
        <Badge color={est.color}>{est.label}</Badge>
        {o.prioridad === 'alta' && <Badge color="rojo">Prioridad alta</Badge>}
        {o.devoluciones > 0 && <Badge color="ambar">Devuelta {o.devoluciones}×</Badge>}
      </p>
      <p className="text-[15px] font-semibold text-slate-100">{o.titulo}</p>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-slate-400">
        {o.zona && (
          <span className="flex items-center gap-1">
            <MapPin size={12} />
            {o.latitud && o.longitud ? (
              <a
                href={`https://www.google.com/maps?q=${o.latitud},${o.longitud}`}
                target="_blank"
                rel="noreferrer"
                className="text-sky-400"
              >
                {o.zona}
              </a>
            ) : (
              o.zona
            )}
          </span>
        )}
        <span className="flex items-center gap-1">
          <HardHat size={12} />
          {o.cuadrilla ?? o.tecnico ?? '—'}
          {o.jefe ? ` · jefe: ${o.jefe}` : ''}
        </span>
        {o.fecha_meta && (
          <span className={o.atrasada ? 'text-rose-400' : ''}>
            Meta {new Date(`${o.fecha_meta}T12:00:00`).toLocaleDateString('es-EC', { day: 'numeric', month: 'short' })}
            {['planificada', 'en_curso'].includes(o.estado) && dias != null &&
              (dias < 0 ? ` · ${-dias} día(s) atrasada` : dias === 0 ? ' · vence hoy' : ` · faltan ${dias} día(s)`)}
          </span>
        )}
        {o.ticket_id && (
          <span>
            {enlaceTicket ? (
              <Link to={`/soporte/${o.ticket_id}`} className="text-sky-400">
                Ticket #{o.ticket_numero}
              </Link>
            ) : (
              `Ticket #${o.ticket_numero}`
            )}
            {o.ticket_cliente ? ` · ${o.ticket_cliente}` : ''}
          </span>
        )}
      </p>
    </div>
  )
}

export function AvanceMetas({ o }) {
  const metas = progresoMetas(o)
  if (!metas.length) return <p className="text-[12px] text-slate-500">La obra no tiene alcance en números.</p>
  return (
    <div className="space-y-2">
      <p className="flex items-center justify-between text-[12px] text-slate-400">
        <span>Avance</span>
        <span className="font-semibold text-slate-100">{fmt(o.avance_pct)}%</span>
      </p>
      {metas.map((m) => (
        <div key={m.clave}>
          <p className="mb-0.5 flex justify-between text-[11px] text-slate-500">
            <span>{m.label}</span>
            <span className="tabular-nums">
              {fmt(m.hecho)} / {fmt(m.meta)} {m.unidad}
            </span>
          </p>
          <Barra pct={m.pct} />
        </div>
      ))}
    </div>
  )
}

function Seccion({ titulo, children, n }) {
  return (
    <section className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {titulo}
        {n != null && ` (${n})`}
      </p>
      {children}
    </section>
  )
}

const fecha = (f) =>
  new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString('es-EC', { weekday: 'short', day: 'numeric', month: 'short' })

export default function DetalleObra({ d, enlaceTicket = true }) {
  const { obra: o, avances, naps, materiales, consumos, bitacora, config } = d
  const rutas = useMemo(
    () => [...avances.flatMap((a) => a.fotos ?? []), ...naps.map((n) => n.foto)].filter(Boolean),
    [avances, naps],
  )
  const urls = useFotosObra(rutas)
  const min = Number(config?.potencia_min_dbm ?? -22)

  const usado = (mid) => consumos.filter((c) => c.material_id === mid).reduce((s, c) => s + Number(c.cantidad), 0)
  const extras = consumos.filter((c) => !c.material_id)

  return (
    <div className="space-y-5">
      <EncabezadoObra o={o} enlaceTicket={enlaceTicket} />
      {o.instrucciones && <p className="rounded-lg bg-sky-500/10 p-2.5 text-[12px] text-sky-200">{o.instrucciones}</p>}
      <AvanceMetas o={o} />

      {o.entrega_nota && o.estado !== 'en_curso' && (
        <p className="rounded-lg border border-emerald-500/30 p-2.5 text-[12px] text-emerald-300">
          Entrega: “{o.entrega_nota}”
        </p>
      )}

      <Seccion titulo="Partes del día" n={avances.length}>
        {!avances.length && <p className="text-[12px] text-slate-500">Todavía nadie reportó avances.</p>}
        <ul className="space-y-2">
          {avances.map((a) => (
            <li key={a.id} className="rounded-lg border border-slate-800 p-2.5 text-[12px]">
              <p className="flex flex-wrap items-center justify-between gap-2 text-slate-500">
                <span>
                  {fecha(a.fecha)} · {a.quien ?? '—'}
                </span>
                <span className="flex items-center gap-2">
                  {!a.epp_completo && (
                    <span className="flex items-center gap-1 text-amber-400">
                      <ShieldAlert size={12} /> sin EPP completo
                    </span>
                  )}
                  {a.incidente && (
                    <span className="flex items-center gap-1 text-rose-400">
                      <AlertTriangle size={12} /> incidente
                    </span>
                  )}
                </span>
              </p>
              <p className="mt-1 text-slate-200">
                {[
                  Number(a.metros) > 0 && `${fmt(a.metros)} m`,
                  a.naps > 0 && `${a.naps} NAP`,
                  a.fusiones > 0 &&
                    `${a.fusiones} fusiones${a.perdida_fusion_db != null ? ` (${fmt(a.perdida_fusion_db, 2)} dB)` : ''}`,
                  a.mangas > 0 && `${a.mangas} mangas`,
                  a.postes > 0 && `${a.postes} postes`,
                  a.puertos > 0 && `${a.puertos} puertos`,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'Sin cantidades'}
              </p>
              {a.texto && <p className="mt-1 text-slate-300">“{a.texto}”</p>}
              {a.incidente_nota && <p className="mt-1 text-rose-300">Incidente: {a.incidente_nota}</p>}
              {a.fotos?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {a.fotos.map((f) =>
                    urls[f] ? (
                      <a key={f} href={urls[f]} target="_blank" rel="noreferrer">
                        <img src={urls[f]} alt="Foto del avance" className="h-16 w-16 rounded-lg object-cover" />
                      </a>
                    ) : (
                      <span key={f} className="flex h-16 w-16 items-center justify-center rounded-lg bg-slate-800">
                        <Camera size={14} className="text-slate-500" />
                      </span>
                    ),
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </Seccion>

      <Seccion titulo="Cajas NAP" n={`${naps.length}${o.meta_naps ? ` de ${o.meta_naps}` : ''}`}>
        {!naps.length && <p className="text-[12px] text-slate-500">Sin cajas registradas.</p>}
        <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
          {naps.map((n) => {
            const ok = n.potencia_dbm == null ? null : Number(n.potencia_dbm) >= min
            return (
              <li key={n.id} className="flex flex-wrap items-center gap-3 p-2.5 text-[12px]">
                <span className="min-w-0 flex-1 font-medium text-slate-100">{n.nombre}</span>
                <span className={ok == null ? 'text-slate-500' : ok ? 'text-emerald-400' : 'text-rose-400'}>
                  {n.potencia_dbm == null ? 'sin potencia' : `${fmt(n.potencia_dbm, 2)} dBm`}
                </span>
                <span className="text-slate-400">{n.puertos ? `${n.puertos} puertos` : 'sin puertos'}</span>
                {n.latitud && n.longitud ? (
                  <a
                    href={`https://www.google.com/maps?q=${n.latitud},${n.longitud}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sky-400"
                  >
                    Mapa
                  </a>
                ) : (
                  <span className="text-rose-400">sin ubicación</span>
                )}
                {n.foto ? (
                  urls[n.foto] ? (
                    <a href={urls[n.foto]} target="_blank" rel="noreferrer" className="text-sky-400">
                      Foto
                    </a>
                  ) : (
                    <span className="text-slate-500">Foto</span>
                  )
                ) : (
                  <span className="text-rose-400">sin foto</span>
                )}
              </li>
            )
          })}
        </ul>
      </Seccion>

      <Seccion titulo="Material">
        {!materiales.length && !extras.length && <p className="text-[12px] text-slate-500">Sin material.</p>}
        {(materiales.length > 0 || extras.length > 0) && (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="py-1 font-medium">Material</th>
                <th className="py-1 text-right font-medium">Presup.</th>
                <th className="py-1 text-right font-medium">Usado</th>
                <th className="py-1 text-right font-medium">Desvío</th>
              </tr>
            </thead>
            <tbody>
              {materiales.map((m) => {
                const u = usado(m.id)
                const desv = Math.round((u / Number(m.presupuesto) - 1) * 100)
                const lim = Number(config?.merma_max_pct ?? 10)
                return (
                  <tr key={m.id} className="border-t border-slate-800">
                    <td className="py-1.5 text-slate-200">{m.descripcion}</td>
                    <td className="py-1.5 text-right tabular-nums text-slate-400">
                      {fmt(m.presupuesto, 2)} {m.unidad}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-slate-200">{fmt(u, 2)}</td>
                    <td className={`py-1.5 text-right tabular-nums ${tono(u === 0 ? null : desv > lim ? 'mal' : 'bien')}`}>
                      {u === 0 ? '—' : `${desv > 0 ? '+' : ''}${desv}%`}
                    </td>
                  </tr>
                )
              })}
              {extras.map((c) => (
                <tr key={c.id} className="border-t border-slate-800">
                  <td className="py-1.5 text-slate-200">
                    {c.descripcion} <span className="text-amber-400">(no presupuestado)</span>
                  </td>
                  <td className="py-1.5 text-right text-slate-500">—</td>
                  <td className="py-1.5 text-right tabular-nums text-slate-200">
                    {fmt(c.cantidad, 2)} {c.unidad}
                  </td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {consumos.some((c) => c.articulo_id && !c.movimiento_id) && (
          <p className="text-[11px] text-amber-400">
            Parte del material no se descontó del inventario: el almacén del técnico no lo tenía cargado.
          </p>
        )}
      </Seccion>

      <Seccion titulo="Bitácora">
        <ul className="space-y-1.5">
          {bitacora.map((b) => (
            <li key={b.id} className="text-[12px]">
              <span className="text-slate-500">
                {new Date(b.creado_at).toLocaleString('es-EC', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}{' '}
                · {b.quien ?? '—'}
              </span>
              <p className={b.tipo === 'devuelta' ? 'text-amber-300' : 'text-slate-300'}>{b.texto}</p>
            </li>
          ))}
        </ul>
      </Seccion>
    </div>
  )
}
