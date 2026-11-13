import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowDown, ArrowUp, CalendarClock, Camera, Check, Hammer, ListOrdered, PhoneOff, Route, Wand2 } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { FRANJAS, etiquetaIncidencia } from '../../lib/soporte'
import { largoDeRuta, ordenarRutaAutomatica } from '../../lib/ruta'
import { estadoPlazo } from '../../lib/plazos'
import { duracion } from '../../lib/alertas'
import { Badge, Button, Card, ErrorBanner, Input, Modal, Select, SkeletonTabla } from '../../components/ui'
import ConfirmarVisita from '../../components/soporte/ConfirmarVisita'
import { useConfirmaciones } from '../../components/soporte/useConfirmaciones'
import { diaAnterior, etiquetaLlamada, horaCorta } from '../../lib/confirmaciones'

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
  requiere_otro: 'Hace falta otro trabajo',
  otro: 'Otro',
}

// Umbrales de las alertas, en minutos.
const EN_SITIO_MIN = 5
const VIAJE_MAX = 90

const queEs = (i) =>
  i.tipo === 'ticket' ? `#${i.numero} · ${etiquetaIncidencia(i.detalle)}` : `Instalación${i.numero ? ` #${i.numero}` : ''}`

const manana = () => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toLocaleDateString('en-CA')
}

/**
 * La página: Por reprogramar, y una tarjeta por cuadrilla.
 *
 * ── Por qué cada cuadrilla elige su día ──
 *
 * La primera versión tenía un solo día para toda la página y, arriba, una
 * lista "Para confirmar" con todo junto. Con dos cuadrillas y veinte trabajos
 * cada una era demasiado: la oficina quería mirar TROOPER hoy, MAZDA mañana,
 * y lo de Byron, sin que lo demás estorbe. Ahora cada tarjeta tiene sus
 * botones Hoy · Mañana · fecha y su filtro por integrante, y lo que hay que
 * llamar se ve adentro, con "Sin confirmar".
 *
 * Los técnicos que no integran ninguna cuadrilla van al final, plegados.
 */
export default function RutasPage() {
  // Las rutas de cada fecha que alguna tarjeta está mirando: fecha → [rutas].
  const [porFecha, setPorFecha] = useState(new Map())
  const [cuadrillas, setCuadrillas] = useState(null)
  const [miembros, setMiembros] = useState([])
  const [porReprogramar, setPorReprogramar] = useState([])
  const [error, setError] = useState(null)
  const [foto, setFoto] = useState(null)
  const [verSueltos, setVerSueltos] = useState(false)
  /**
   * El vencimiento del plazo de cada pendiente (migración 219), por
   * "tipo:id". Lo usa el orden automático para pasar adelante lo urgente. Si la
   * vista no está, queda vacío y el orden se arma solo por cercanía y franja.
   */
  const [vencimientos, setVencimientos] = useState(new Map())
  /** Los nombres de los técnicos, para decir de quién es cada trabajo. */
  const [nombres, setNombres] = useState(new Map())
  /** La última llamada de la oficina a cada ticket postergado (227). */
  const [llamadasReprog, setLlamadasReprog] = useState(new Map())

  useEffect(() => {
    Promise.all([
      supabase.from('tecnicos').select('id, nombre'),
      supabase.from('cuadrillas').select('id, nombre, activo').order('nombre'),
      supabase.from('cuadrilla_miembros').select('cuadrilla_id, tecnico_id, rol'),
    ]).then(([t, c, m]) => {
      setNombres(new Map((t.data ?? []).map((x) => [x.id, x.nombre])))
      setCuadrillas((c.data ?? []).filter((x) => x.activo !== false))
      setMiembros(m.data ?? [])
    })
  }, [])

  // Las llamadas a los tickets de todo lo cargado: "confirmado 09:15". Desde
  // ayer: para la ruta de hoy vale la llamada de ayer a la tarde, y para la de
  // mañana, la de hoy.
  const todas = [...porFecha.values()].flat()
  const idsTickets = todas.flatMap((ru) => (ru.pendientes ?? []).filter((i) => i.tipo === 'ticket').map((i) => i.id))
  const { confirmaciones, recargar: recargarLlamadas } = useConfirmaciones(idsTickets, {
    desdeDia: diaAnterior(hoyLocal()),
  })

  /** Trae las rutas de una fecha. Sin `forzar`, no repite una que ya se pidió. */
  const pedidas = useRef(new Set())
  const cargarFecha = useCallback(async (f, { forzar = false } = {}) => {
    if (pedidas.current.has(f) && !forzar) return
    pedidas.current.add(f)
    const r = await supabase.rpc('rutas_del_dia', { p_fecha: f })
    if (r.error) setError(r.error)
    setPorFecha((m) => new Map(m).set(f, r.data ?? []))
    const ids = (r.data ?? []).flatMap((ru) => (ru.pendientes ?? []).map((i) => i.id))
    if (ids.length) {
      const { data: pl } = await supabase.from('v_plazos_trabajo').select('clase, id, vence_at').in('id', ids)
      setVencimientos((m) => {
        const n = new Map(m)
        for (const x of pl ?? []) n.set(`${x.clase}:${x.id}`, x.vence_at)
        return n
      })
    }
  }, [])

  const cargarReprogramar = useCallback(async () => {
    const { data: p } = await supabase.from('v_tickets_por_reprogramar').select('*').order('reprogramar_desde')
    setPorReprogramar(p ?? [])
    const idsReprog = (p ?? []).map((t) => t.id)
    if (idsReprog.length) {
      const { data: ll } = await supabase
        .from('confirmaciones_visita')
        .select('ticket_id, resultado, detalle, creado_at')
        .in('ticket_id', idsReprog)
        .neq('resultado', 'esta')
        .order('creado_at')
      setLlamadasReprog(new Map((ll ?? []).map((x) => [x.ticket_id, x])))
    } else {
      setLlamadasReprog(new Map())
    }
  }, [])

  // Lo que se cargó, otra vez: después de guardar un orden, llamar o reprogramar.
  const recargar = useCallback(async () => {
    const fechas = [...new Set([hoyLocal(), ...porFecha.keys()])]
    await Promise.all([...fechas.map((f) => cargarFecha(f, { forzar: true })), cargarReprogramar()])
  }, [porFecha, cargarFecha, cargarReprogramar])

  useEffect(() => {
    cargarFecha(hoyLocal())
    cargarFecha(manana())
    cargarReprogramar()
  }, [cargarFecha, cargarReprogramar])

  async function verFoto(ruta) {
    setFoto({ url: null })
    const { data } = await supabase.storage.from('tickets').createSignedUrl(ruta, 300)
    setFoto({ url: data?.signedUrl ?? null })
  }

  const alLlamar = () => {
    recargar()
    recargarLlamadas()
  }

  // Los técnicos sin cuadrilla, solo si hoy tienen algo: Jefferson es de la
  // oficina y sale a campo a veces; sin trabajos no tiene por qué aparecer.
  const enCuadrilla = new Set(miembros.map((m) => m.tecnico_id))
  const sueltos = (porFecha.get(hoyLocal()) ?? []).filter(
    (r) =>
      r.clase !== 'cuadrilla' &&
      !enCuadrilla.has(r.id) &&
      (r.pendientes?.length || r.hechos?.length || r.no_se_pudo?.length),
  )

  const comun = {
    porFecha,
    cargarFecha,
    vencimientos,
    confirmaciones,
    nombres,
    onVerFoto: verFoto,
    onGuardado: recargar,
    onLlamada: alLlamar,
    onError: setError,
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="t-titulo text-lg font-bold text-slate-100">Rutas</h1>
        <p className="mt-0.5 text-xs text-slate-500">
          Qué tiene cada cuadrilla, en qué orden, a quién falta confirmar y qué hay que reprogramar
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {porReprogramar.length > 0 && (
        <Card title={`Por reprogramar (${porReprogramar.length})`} icon={CalendarClock}>
          <ul className="divide-y divide-slate-800/60 px-4 sm:px-6">
            {porReprogramar.map((t) => (
              <Reprogramar
                key={t.id}
                t={t}
                llamada={llamadasReprog.get(t.id)}
                onVerFoto={verFoto}
                onHecho={recargar}
                onError={setError}
              />
            ))}
          </ul>
        </Card>
      )}

      {cuadrillas === null ? (
        <SkeletonTabla filas={5} columnas={4} />
      ) : (
        cuadrillas.map((c) => (
          <RutaDelGrupo
            key={c.id}
            clase="cuadrilla"
            grupo={c}
            integrantes={miembros.filter((m) => m.cuadrilla_id === c.id)}
            {...comun}
          />
        ))
      )}

      {sueltos.length > 0 && (
        <section>
          <button
            type="button"
            onClick={() => setVerSueltos((v) => !v)}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            {verSueltos ? '▾' : '▸'} Técnicos sin cuadrilla con trabajos hoy ({sueltos.length})
          </button>
          {verSueltos && (
            <div className="mt-3 space-y-6">
              {sueltos.map((r) => (
                <RutaDelGrupo key={r.id} clase={r.clase} grupo={{ id: r.id, nombre: r.nombre }} integrantes={[]} {...comun} />
              ))}
            </div>
          )}
        </section>
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

/**
 * Una cuadrilla (o un técnico suelto) con SU día: Hoy · Mañana · fecha.
 * Busca su ruta entre las de esa fecha; si no tiene nada, la tarjeta lo dice.
 */
function RutaDelGrupo({ clase, grupo, integrantes, porFecha, cargarFecha, ...resto }) {
  const [fecha, setFecha] = useState(hoyLocal)
  const rutas = porFecha.get(fecha)

  useEffect(() => {
    if (!porFecha.has(fecha)) cargarFecha(fecha)
  }, [fecha, porFecha, cargarFecha])

  const vacia = useMemo(
    () => ({ clase, id: grupo.id, nombre: grupo.nombre, jefe: null, pendientes: [], hechos: [], no_se_pudo: [] }),
    [clase, grupo.id, grupo.nombre],
  )
  // Para un día que viene, solo lo agendado ESE día: la base suma lo atrasado
  // y lo sin fecha, que es de hoy, y en "Mañana" confundía.
  const r = useMemo(() => {
    const ru = (rutas ?? []).find((x) => x.clase === clase && x.id === grupo.id)
    if (!ru) return vacia
    if (fecha <= hoyLocal()) return ru
    return { ...ru, pendientes: (ru.pendientes ?? []).filter((i) => String(i.fecha ?? '').slice(0, 10) === fecha) }
  }, [rutas, clase, grupo.id, fecha, vacia])

  const dias = (
    <div className="flex flex-wrap items-center gap-2">
      {[
        [hoyLocal(), 'Hoy'],
        [manana(), 'Mañana'],
      ].map(([f, label]) => (
        <button
          key={label}
          type="button"
          onClick={() => setFecha(f)}
          className={`rounded-full border px-3 py-1 text-xs transition ${
            fecha === f
              ? 'border-sky-500/60 bg-sky-500/15 text-sky-200'
              : 'border-slate-700 text-slate-400 hover:border-slate-600'
          }`}
        >
          {label}
        </button>
      ))}
      <div className="w-40">
        <Input type="date" value={fecha} onChange={(e) => e.target.value && setFecha(e.target.value)} />
      </div>
    </div>
  )

  return (
    <RutaCard
      r={r}
      fecha={fecha}
      cargando={rutas === undefined}
      dias={dias}
      integrantes={integrantes}
      editable={fecha === hoyLocal()}
      llamable={fecha >= hoyLocal()}
      {...resto}
    />
  )
}

function RutaCard({
  r,
  fecha,
  cargando = false,
  dias = null,
  integrantes = [],
  editable,
  llamable,
  vencimientos,
  confirmaciones,
  nombres,
  onVerFoto,
  onGuardado,
  onLlamada,
  onError,
}) {
  const [orden, setOrden] = useState(r.pendientes)
  const [guardando, setGuardando] = useState(false)
  // Lo que cambió el orden automático, para decirlo al lado del botón.
  const [propuesta, setPropuesta] = useState(null)
  useEffect(() => {
    setOrden(r.pendientes)
    setPropuesta(null)
  }, [r.pendientes])

  const venceDe = (i) => vencimientos?.get(`${i.tipo}:${i.id}`) ?? null

  /*
   * De quién es cada trabajo, en una cuadrilla. Lo asignado a una persona lleva
   * su nombre; lo de la cuadrilla, no. Y se puede mirar solo lo de uno:
   * "¿qué tiene Byron?".
   */
  const esCuadrilla = r.clase === 'cuadrilla'
  const [verDe, setVerDe] = useState('todos')
  const [soloSinConfirmar, setSoloSinConfirmar] = useState(false)
  // Todos los integrantes, el jefe primero, tengan o no algo a su nombre.
  const personas = esCuadrilla
    ? [
        ...new Set([
          ...[...integrantes].sort((a, b) => Number(b.rol === 'lider') - Number(a.rol === 'lider')).map((m) => m.tecnico_id),
          ...orden.map((i) => i.tecnico_id).filter(Boolean),
        ]),
      ].map((id) => [id, nombres?.get(id) ?? 'Técnico'])
    : []
  const sinConfirmar = (i) => llamable && i.tipo === 'ticket' && !i.llegada_at && !confirmaciones?.get(i.id)
  const pasa = (i) =>
    (!soloSinConfirmar || sinConfirmar(i)) &&
    (verDe === 'todos' || (verDe === 'cuadrilla' ? !i.tecnico_id : i.tecnico_id === verDe || !i.tecnico_id))
  const filtrando = verDe !== 'todos' || soloSinConfirmar
  const faltanConfirmar = orden.filter(sinConfirmar).length
  const primerNombre = (n) => String(n ?? '').split(' ')[0]

  /**
   * Propone el orden: lo urgente primero, después por franja y por cercanía.
   * No guarda: queda en pantalla para revisarlo y se guarda con el botón de
   * siempre. Los kilómetros son en línea recta y sirven para comparar, no como
   * distancia real.
   */
  function ordenarAuto() {
    const antes = largoDeRuta(orden)
    const nuevo = ordenarRutaAutomatica(orden, { vence: venceDe })
    const despues = largoDeRuta(nuevo)
    setOrden(nuevo)
    setPropuesta({
      antesKm: antes.metros / 1000,
      despuesKm: despues.metros / 1000,
      sinUbicacion: nuevo.filter((i) => i.latitud == null || i.longitud == null).length,
    })
  }

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
        {dias}
        {cargando && <p className="text-sm text-slate-500">Cargando…</p>}
        {/* Pendientes, en orden */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <ListOrdered size={12} /> Pendientes
            </p>
            <div className="flex flex-wrap gap-2">
              {editable && orden.length >= 2 && (
                <Button variante="secundario" icon={Wand2} onClick={ordenarAuto}>
                  Ordenar automáticamente
                </Button>
              )}
              {editable && cambio && (
                <Button variante="primario" onClick={guardar} cargando={guardando}>
                  Guardar el orden
                </Button>
              )}
            </div>
          </div>
          {propuesta && (
            <p className="mb-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-200">
              Orden propuesto: lo urgente primero, después por franja y por cercanía.
              {propuesta.antesKm > 0 &&
                ` Recorrido en línea recta: ${propuesta.despuesKm.toFixed(1)} km (antes ${propuesta.antesKm.toFixed(1)} km).`}
              {propuesta.sinUbicacion > 0 &&
                ` ${propuesta.sinUbicacion} sin coordenadas quedaron al final: cargá su ubicación en el ticket.`}
              {cambio ? ' Revisalo y guardalo.' : ' Ya estaba en el mejor orden.'}
            </p>
          )}
          {(personas.length > 0 || faltanConfirmar > 0) && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {faltanConfirmar > 0 && (
                <button
                  type="button"
                  onClick={() => setSoloSinConfirmar((v) => !v)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                    soloSinConfirmar
                      ? 'border-amber-500/60 bg-amber-500/15 text-amber-200'
                      : 'border-amber-500/30 text-amber-300 hover:border-amber-500/60'
                  }`}
                >
                  📞 Sin confirmar ({faltanConfirmar})
                </button>
              )}
              {(personas.length
                ? [
                    ['todos', `Todos (${orden.length})`],
                    ['cuadrilla', `De la cuadrilla (${orden.filter((i) => !i.tecnico_id).length})`],
                    ...personas.map(([id, n]) => [
                      id,
                      `${primerNombre(n)} (${orden.filter((i) => i.tecnico_id === id).length} suyos)`,
                    ]),
                  ]
                : []
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVerDe(v)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                    verDe === v
                      ? 'border-violet-500/60 bg-violet-500/15 text-violet-200'
                      : 'border-slate-700 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {verDe !== 'todos' && verDe !== 'cuadrilla' && (
            <p className="mb-1 text-[11px] text-slate-500">
              Lo suyo y lo de la cuadrilla, en el orden de la ruta. Para cambiar el orden, volvé a «Todos».
            </p>
          )}
          {!orden.length ? (
            <p className="text-sm text-slate-500">{fecha === hoyLocal() ? 'Nada pendiente.' : 'Nada agendado para ese día.'}</p>
          ) : (
            <ul className="space-y-1">
              {orden.map((i, idx) => !pasa(i) ? null : (
                <li key={i.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-800/40">
                  <span className="w-5 text-center text-slate-500">{idx + 1}</span>
                  <Link
                    to={i.tipo === 'ticket' ? `/soporte/${i.id}` : `/instalaciones/${i.id}/alta`}
                    className="min-w-0 flex-1 truncate text-slate-200 hover:underline"
                  >
                    {i.nombre} <span className="text-xs text-slate-500">{queEs(i)}</span>
                  </Link>
                  {esCuadrilla && i.tecnico_id && (
                    <Badge color="azul">{primerNombre(nombres?.get(i.tecnico_id))}</Badge>
                  )}
                  {i.en_curso && <Badge color="ambar">{i.llegada_at ? 'en el sitio' : 'en camino'}</Badge>}
                  <Llamada c={confirmaciones?.get(i.id)} />
                  {i.prioridad === 'alta' && <Badge color="rojo">alta</Badge>}
                  <VencePlazo vence={venceDe(i)} />
                  {(i.latitud == null || i.longitud == null) && (
                    <span className="text-[11px] text-slate-500" title="Sin coordenadas: no entra en el orden por cercanía">
                      sin ubicación
                    </span>
                  )}
                  {/* La oficina llama antes: si no está, el técnico no viaja
                      ni espera los diez minutos (227). */}
                  {llamable && i.tipo === 'ticket' && !i.llegada_at && (
                    <ConfirmarVisita compacto ticket={i} onHecho={onLlamada} onError={onError} />
                  )}
                  {editable && !filtrando && (
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
                  {f.foto && (
                    <button type="button" onClick={() => onVerFoto(f.foto)} className="text-xs text-sky-400 hover:underline">
                      <Camera size={12} className="mr-1 inline" />
                      Ver foto
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Card>
  )
}

function Reprogramar({ t, llamada, onVerFoto, onHecho, onError }) {
  const [fecha, setFecha] = useState('')
  // Lo que pidió el cliente: mañana, tarde o una hora exacta. Sin franja, la
  // ruta lo acomoda donde le quede mejor.
  const [franja, setFranja] = useState('')
  const [horaVisita, setHoraVisita] = useState('')
  const [guardando, setGuardando] = useState(false)

  const listo = fecha && (franja !== 'exacta' || horaVisita)

  async function guardar() {
    setGuardando(true)
    const { error } = await supabase
      .from('tickets')
      .update({
        fecha_visita: fecha,
        franja: franja || null,
        hora_visita: franja === 'exacta' ? horaVisita : null,
      })
      .eq('id', t.id)
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
        {/* Lo último que pasó: el "no se pudo" del técnico o la llamada de la
            oficina, el que sea más nuevo. */}
        {llamada && (!t.fallida_at || new Date(llamada.creado_at) > new Date(t.fallida_at)) ? (
          <p className="text-[11px] text-slate-500">
            Oficina llamó: {etiquetaLlamada(llamada.resultado)}
            {llamada.detalle && ` · ${llamada.detalle}`} · {t.cuadrilla ? `Cuadrilla ${t.cuadrilla}` : t.tecnico}
            {` · ${new Date(llamada.creado_at).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' })}`}
          </p>
        ) : (
          <p className="text-[11px] text-slate-500">
            {MOTIVO[t.motivo] ?? 'No se pudo atender'}
            {t.detalle && ` · ${t.detalle}`} · {t.cuadrilla ? `Cuadrilla ${t.cuadrilla}` : t.tecnico}
            {t.fallida_at && ` · ${new Date(t.fallida_at).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' })}`}
          </p>
        )}
      </div>
      {t.foto && !(llamada && (!t.fallida_at || new Date(llamada.creado_at) > new Date(t.fallida_at))) && (
        <Button variante="fantasma" icon={Camera} onClick={() => onVerFoto(t.foto)}>
          Foto
        </Button>
      )}
      {/* "Hace falta otro trabajo": no es una visita más, es una obra para la
          cuadrilla de redes (232). Al aprobarla se avisa para reprogramar. */}
      {t.motivo === 'requiere_otro' && (
        <Link
          to={`/soporte/obras?ticket=${t.id}`}
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-300 hover:text-slate-100"
        >
          <Hammer size={14} /> Crear obra
        </Link>
      )}
      <div className="w-40">
        <Input type="date" value={fecha} min={hoyLocal()} onChange={(e) => setFecha(e.target.value)} />
      </div>
      <div className="w-48">
        <Select value={franja} onChange={(e) => setFranja(e.target.value)} aria-label="Franja">
          <option value="">Cualquier hora</option>
          {Object.entries(FRANJAS).map(([valor, label]) => (
            <option key={valor} value={valor}>
              {label}
            </option>
          ))}
        </Select>
      </div>
      {franja === 'exacta' && (
        <div className="w-28">
          <Input type="time" value={horaVisita} onChange={(e) => setHoraVisita(e.target.value)} aria-label="Hora" />
        </div>
      )}
      <Button variante="primario" icon={CalendarClock} onClick={guardar} cargando={guardando} disabled={!listo}>
        Reprogramar
      </Button>
    </li>
  )
}

/** Lo que dijo el cliente cuando lo llamó la oficina. */
function Llamada({ c }) {
  if (!c) return null
  return c.resultado === 'esta' ? (
    <Badge color="verde">
      <span title={c.detalle ?? ''}>
        confirmado {new Date(c.creado_at).toLocaleDateString('en-CA') === hoyLocal() ? '' : 'ayer '}
        {horaCorta(c.creado_at)}
      </span>
    </Badge>
  ) : (
    <Badge color="ambar">{etiquetaLlamada(c.resultado).toLowerCase()}</Badge>
  )
}

/** "vence 15:30" o "vencido hace 40 min", solo si importa (≤ 2 h o vencido). */
function VencePlazo({ vence }) {
  if (!vence) return null
  const e = estadoPlazo(vence)
  if (!e || e.min > 120) return null
  return e.nivel === 'vencido' ? (
    <Badge color="rojo">vencido hace {duracion(-e.min)}</Badge>
  ) : (
    <Badge color="ambar">vence en {duracion(e.min)}</Badge>
  )
}
