import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowDown, ArrowUp, CalendarClock, Camera, Check, ListOrdered, PhoneOff, Route } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { etiquetaIncidencia } from '../../lib/soporte'
import { Badge, Button, Card, ErrorBanner, Input, Modal, SkeletonTabla } from '../../components/ui'

/**
 * Las rutas del día, para la oficina (migración 216).
 *
 * ── Qué responde ──
 *
 * Por cada cuadrilla (y cada técnico suelto): qué le falta hacer y en qué
 * orden, qué hizo y cuánto tardó, y qué no se pudo atender y por qué. Arriba,
 * lo que espera una nueva fecha.
 *
 * El orden se cambia acá con las flechas: lo que se guarda es lo que la app de
 * campo muestra y lo que la base exige —un trabajo a la vez—.
 *
 * ── Las alertas ──
 *
 * No acusan a nadie: señalan lo que vale la pena mirar. Un ticket cerrado a los
 * 3 minutos de llegar puede ser un reinicio remoto bien hecho o una visita que
 * no se hizo; dos horas entre salir y llegar puede ser tráfico o una parada.
 */

const hoyLocal = () => new Date().toLocaleDateString('en-CA')
const hora = (v) =>
  v ? new Date(v).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' }) : '—'

const MOTIVO = {
  no_contesta: 'No contesta',
  sin_nadie: 'No hay nadie',
  no_permite: 'No permite el ingreso',
  direccion_erronea: 'Dirección errónea',
  falta_material: 'Faltó material',
  clima: 'Lluvia o peligro',
  otro: 'Otro',
}

// Umbrales de las alertas, en minutos.
const EN_SITIO_MIN = 5
const VIAJE_MAX = 90

const queEs = (i) =>
  i.tipo === 'ticket' ? `#${i.numero} · ${etiquetaIncidencia(i.detalle)}` : `Instalación${i.numero ? ` #${i.numero}` : ''}`

export default function RutasPage() {
  const [fecha, setFecha] = useState(hoyLocal)
  const [rutas, setRutas] = useState(null)
  const [porReprogramar, setPorReprogramar] = useState([])
  const [error, setError] = useState(null)
  const [foto, setFoto] = useState(null)

  const recargar = useCallback(async () => {
    setRutas(null)
    const [r, p] = await Promise.all([
      supabase.rpc('rutas_del_dia', { p_fecha: fecha }),
      supabase.from('v_tickets_por_reprogramar').select('*').order('reprogramar_desde'),
    ])
    if (r.error) setError(r.error)
    setRutas(r.data ?? [])
    setPorReprogramar(p.data ?? [])
  }, [fecha])

  useEffect(() => {
    recargar()
  }, [recargar])

  async function verFoto(ruta) {
    setFoto({ url: null })
    const { data } = await supabase.storage.from('tickets').createSignedUrl(ruta, 300)
    setFoto({ url: data?.signedUrl ?? null })
  }

  const esHoy = fecha === hoyLocal()

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="t-titulo text-lg font-bold text-slate-100">Rutas del día</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            Qué hace cada cuadrilla, en qué orden, y qué no se pudo atender
          </p>
        </div>
        <div className="w-44">
          <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {porReprogramar.length > 0 && (
        <Card title={`Por reprogramar (${porReprogramar.length})`} icon={CalendarClock}>
          <ul className="divide-y divide-slate-800/60 px-4 sm:px-6">
            {porReprogramar.map((t) => (
              <Reprogramar key={t.id} t={t} onVerFoto={verFoto} onHecho={recargar} onError={setError} />
            ))}
          </ul>
        </Card>
      )}

      {rutas === null ? (
        <SkeletonTabla filas={5} columnas={4} />
      ) : !rutas.length ? (
        <Card>
          <p className="p-6 text-sm text-slate-500">No hay trabajos asignados para esta fecha.</p>
        </Card>
      ) : (
        rutas.map((r) => (
          <RutaCard key={`${r.clase}-${r.id}`} r={r} editable={esHoy} onVerFoto={verFoto} onGuardado={recargar} onError={setError} />
        ))
      )}

      <Modal abierto={Boolean(foto)} titulo="Foto de la fachada" onCerrar={() => setFoto(null)}>
        {foto?.url ? (
          <img src={foto.url} alt="" className="w-full rounded-lg" />
        ) : (
          <p className="text-sm text-slate-500">Cargando…</p>
        )}
      </Modal>
    </div>
  )
}

function RutaCard({ r, editable, onVerFoto, onGuardado, onError }) {
  const [orden, setOrden] = useState(r.pendientes)
  const [guardando, setGuardando] = useState(false)
  useEffect(() => setOrden(r.pendientes), [r.pendientes])

  const cambio = orden.some((i, idx) => i.id !== r.pendientes[idx]?.id)
  const mover = (idx, delta) =>
    setOrden((lista) => {
      const n = [...lista]
      const j = idx + delta
      if (j < 0 || j >= n.length) return n
      ;[n[idx], n[j]] = [n[j], n[idx]]
      return n
    })

  async function guardar() {
    setGuardando(true)
    const { error } = await supabase.rpc('ordenar_ruta', {
      p_items: orden.map((i) => ({ tipo: i.tipo, id: i.id })),
      p_motivo: null,
    })
    setGuardando(false)
    if (error) return onError(error)
    onGuardado()
  }

  const titulo = r.clase === 'cuadrilla' ? `Cuadrilla ${r.nombre}` : r.nombre
  const resumen = `${r.hechos.length} hechos · ${r.no_se_pudo.length} no se pudo · ${r.pendientes.length} pendientes`

  return (
    <Card title={titulo} subtitle={`${r.jefe ? `Jefe de grupo: ${r.jefe} · ` : ''}${resumen}`} icon={Route}>
      <div className="space-y-4 p-4 sm:p-6">
        {/* Pendientes, en orden */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <ListOrdered size={12} /> Pendientes
            </p>
            {editable && cambio && (
              <Button variante="primario" onClick={guardar} cargando={guardando}>
                Guardar el orden
              </Button>
            )}
          </div>
          {!orden.length ? (
            <p className="text-sm text-slate-500">Nada pendiente.</p>
          ) : (
            <ul className="space-y-1">
              {orden.map((i, idx) => (
                <li key={i.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-800/40">
                  <span className="w-5 text-center text-slate-500">{idx + 1}</span>
                  <Link
                    to={i.tipo === 'ticket' ? `/soporte/${i.id}` : `/instalaciones/${i.id}/alta`}
                    className="min-w-0 flex-1 truncate text-slate-200 hover:underline"
                  >
                    {i.nombre} <span className="text-xs text-slate-500">{queEs(i)}</span>
                  </Link>
                  {i.en_curso && <Badge color="ambar">{i.llegada_at ? 'en el sitio' : 'en camino'}</Badge>}
                  {i.prioridad === 'alta' && <Badge color="rojo">alta</Badge>}
                  {editable && (
                    <>
                      <button type="button" onClick={() => mover(idx, -1)} className="p-1 text-slate-500 hover:text-slate-200" aria-label="Subir">
                        <ArrowUp size={15} />
                      </button>
                      <button type="button" onClick={() => mover(idx, 1)} className="p-1 text-slate-500 hover:text-slate-200" aria-label="Bajar">
                        <ArrowDown size={15} />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Hechos, con tiempos y alertas */}
        {r.hechos.length > 0 && (
          <section>
            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <Check size={12} /> Hechos
            </p>
            <ul className="space-y-1.5">
              {r.hechos.map((h) => {
                const rapido = h.minutos_en_sitio != null && h.minutos_en_sitio < EN_SITIO_MIN
                const lento = h.minutos_de_viaje != null && h.minutos_de_viaje > VIAJE_MAX
                return (
                  <li key={h.id} className="text-sm">
                    <Link to={`/soporte/${h.id}`} className="text-slate-200 hover:underline">
                      #{h.numero} {h.nombre}
                    </Link>
                    <span className="ml-2 text-xs text-slate-500">
                      salió {hora(h.salida_at)} · llegó {hora(h.llegada_at)} · cerró {hora(h.cerrado_at)}
                      {h.minutos_en_sitio != null && ` · ${h.minutos_en_sitio} min en el sitio`}
                    </span>
                    {(rapido || lento) && (
                      <span className="mt-0.5 flex items-center gap-1 text-xs text-amber-400">
                        <AlertTriangle size={12} />
                        {rapido && `Cerró a los ${h.minutos_en_sitio} min de llegar. `}
                        {lento && `${h.minutos_de_viaje} min entre salir y llegar.`}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {/* No se pudo */}
        {r.no_se_pudo.length > 0 && (
          <section>
            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <PhoneOff size={12} /> No se pudo atender
            </p>
            <ul className="space-y-1.5">
              {r.no_se_pudo.map((f) => (
                <li key={`${f.ticket_id}-${f.creado_at}`} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-slate-200">
                    #{f.numero} {f.nombre}
                  </span>
                  <Badge color="ambar">{MOTIVO[f.motivo] ?? f.motivo}</Badge>
                  <span className="text-xs text-slate-500">
                    llegó {hora(f.llegada_at)} · marcó {hora(f.creado_at)}
                    {f.detalle && ` · ${f.detalle}`}
                  </span>
                  <button type="button" onClick={() => onVerFoto(f.foto)} className="text-xs text-sky-400 hover:underline">
                    <Camera size={12} className="mr-1 inline" />
                    Ver foto
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Card>
  )
}

function Reprogramar({ t, onVerFoto, onHecho, onError }) {
  const [fecha, setFecha] = useState('')
  const [guardando, setGuardando] = useState(false)

  async function guardar() {
    setGuardando(true)
    const { error } = await supabase.from('tickets').update({ fecha_visita: fecha }).eq('id', t.id)
    setGuardando(false)
    if (error) return onError(error)
    onHecho()
  }

  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <Link to={`/soporte/${t.id}`} className="text-sm text-slate-100 hover:underline">
          #{t.numero} {t.nombre}
        </Link>
        <p className="text-[11px] text-slate-500">
          {MOTIVO[t.motivo] ?? 'No se pudo atender'}
          {t.detalle && ` · ${t.detalle}`} · {t.cuadrilla ? `Cuadrilla ${t.cuadrilla}` : t.tecnico}
          {t.fallida_at && ` · ${new Date(t.fallida_at).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' })}`}
        </p>
      </div>
      {t.foto && (
        <Button variante="fantasma" icon={Camera} onClick={() => onVerFoto(t.foto)}>
          Foto
        </Button>
      )}
      <div className="w-40">
        <Input type="date" value={fecha} min={hoyLocal()} onChange={(e) => setFecha(e.target.value)} />
      </div>
      <Button variante="primario" icon={CalendarClock} onClick={guardar} cargando={guardando} disabled={!fecha}>
        Reprogramar
      </Button>
    </li>
  )
}
