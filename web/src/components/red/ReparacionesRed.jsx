import { useCallback, useEffect, useState } from 'react'
import { Ban, ClipboardList, Hammer, History, Repeat, Wrench } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { useConfirmar } from '../../lib/confirmar'
import {
  Badge,
  Button,
  Card,
  Cargando,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
} from '../ui'

/**
 * Reparaciones de red (migración 209): quién va a arreglar cada avería.
 *
 * ── Qué decide este panel ──
 *
 * Arriba, lo que está roto y no tiene dueño: cortes masivos, cortes agrupados
 * que detectó la OLT y cajas NAP degradándose. Cada uno se le asigna a una
 * cuadrilla, que lo ve en la app de campo. Abajo, lo que ya está en manos de
 * alguien, con el último reporte que mandaron desde el poste.
 *
 * Lo cierra el jefe de grupo desde el campo. Si salió de un corte masivo
 * avisado, cerrarlo manda el "ya está" a los abonados.
 */

export const TIPO_AVERIA = {
  fibra_rota: 'Fibra cortada',
  enlace_caido: 'Enlace o antena caída',
  corte_energia: 'Corte de energía',
  averia: 'Avería',
  otro: 'Otro',
  corte_grupo: 'Corte agrupado (OLT)',
  nap_degradada: 'NAP degradándose',
}

export const ESTADO_REPARACION = {
  asignada: { label: 'Asignada', color: 'azul' },
  en_curso: { label: 'En curso', color: 'ambar' },
  reparada: { label: 'Reparada', color: 'verde' },
  cancelada: { label: 'Cancelada', color: 'gris' },
}

const fecha = (v) =>
  v ? new Date(v).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' }) : '—'

/** Los errores de una RPC llegan como objeto suelto: se los pasa a Error para el banner. */
const comoError = (e) => (e instanceof Error ? e : new Error(e?.message ?? String(e)))

export default function ReparacionesRed() {
  const confirmar = useConfirmar()
  const [sinAsignar, setSinAsignar] = useState([])
  const [enMarcha, setEnMarcha] = useState([])
  const [cuadrillas, setCuadrillas] = useState([])
  const [tecnicos, setTecnicos] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [asignando, setAsignando] = useState(null)
  const [bitacora, setBitacora] = useState(null)

  const recargar = useCallback(async () => {
    const [s, r] = await Promise.all([
      supabase.from('v_averias_sin_asignar').select('*').order('desde', { ascending: false }),
      supabase
        .from('v_reparaciones_red')
        .select('*')
        // Las cerradas de los últimos días quedan a la vista: es donde la
        // oficina lee qué se hizo antes de llamar al abonado.
        .or(`estado.in.(asignada,en_curso),cerrada_at.gte.${new Date(Date.now() - 3 * 864e5).toISOString()}`)
        .order('creada_at', { ascending: false })
        .limit(60),
    ])
    // Sin la 209 las dos fallan: el panel no se dibuja en vez de gritar.
    if (s.error && r.error) setError(null)
    else setError(s.error ? comoError(s.error) : r.error ? comoError(r.error) : null)
    setSinAsignar(s.data ?? [])
    setEnMarcha(r.data ?? [])
    setCargando(false)
  }, [])

  useEffect(() => {
    recargar()
    Promise.all([
      supabase.from('cuadrillas').select('id, nombre').eq('activo', true).order('nombre'),
      supabase.from('tecnicos').select('id, nombre').eq('activo', true).order('nombre'),
    ]).then(([c, t]) => {
      setCuadrillas(c.data ?? [])
      setTecnicos(t.data ?? [])
    })
  }, [recargar])

  async function cancelar(r) {
    if (!(await confirmar(`¿Cancelar la reparación #${r.numero}? La cuadrilla deja de verla.`))) return
    const { error: e } = await supabase.rpc('cancelar_reparacion', { p_id: r.id, p_motivo: null })
    if (e) return setError(comoError(e))
    await recargar()
  }

  if (cargando) return <Cargando />

  return (
    <Card
      title="Reparaciones de red"
      subtitle="Quién va a arreglar cada avería. La cierra el jefe de grupo desde el campo."
      icon={Wrench}
    >
      <div className="space-y-5 p-4 sm:p-6">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        <section>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Sin asignar ({sinAsignar.length})
          </p>
          {!sinAsignar.length ? (
            <p className="text-sm text-slate-500">Todo lo que está roto tiene a alguien asignado.</p>
          ) : (
            <ul className="divide-y divide-slate-800/60">
              {sinAsignar.map((a) => (
                <li key={`${a.origen}-${a.id}`} className="flex flex-wrap items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-slate-100">{a.titulo}</p>
                    <p className="text-[11px] text-slate-500">
                      {TIPO_AVERIA[a.tipo] ?? a.tipo}
                      {a.lugar && ` · ${a.lugar}`}
                      {a.afectados != null && ` · ${a.afectados} abonados`}
                      {` · desde ${fecha(a.desde)}`}
                      {a.estado === 'borrador' && ' · corte sin avisar'}
                    </p>
                  </div>
                  <Button
                    icon={Hammer}
                    variante="primario"
                    onClick={() =>
                      setAsignando({
                        origen: a.origen,
                        id: a.id,
                        titulo: a.titulo,
                        cuadrilla_id: '',
                        tecnico_id: '',
                        prioridad: 'alta',
                        instrucciones: '',
                      })
                    }
                  >
                    Asignar
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Asignadas y recientes ({enMarcha.length})
          </p>
          {!enMarcha.length ? (
            <p className="text-sm text-slate-500">No hay reparaciones en marcha.</p>
          ) : (
            <ul className="divide-y divide-slate-800/60">
              {enMarcha.map((r) => {
                const est = ESTADO_REPARACION[r.estado] ?? ESTADO_REPARACION.asignada
                const abierta = ['asignada', 'en_curso'].includes(r.estado)
                return (
                  <li key={r.id} className="flex flex-wrap items-start gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-slate-100">
                        <span className="text-slate-500">#{r.numero}</span> {r.titulo}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        {r.cuadrilla ? `Cuadrilla ${r.cuadrilla}` : r.tecnico}
                        {r.jefe && ` · jefe de grupo hoy: ${r.jefe}`}
                        {r.lugar && ` · ${r.lugar}`}
                        {` · ${fecha(r.creada_at)}`}
                      </p>
                      {r.ultimo_reporte && (
                        <p className="mt-1 text-[12px] text-slate-300">
                          “{r.ultimo_reporte}”{' '}
                          <span className="text-slate-500">
                            — {r.ultimo_reporte_de ?? '—'}, {fecha(r.ultimo_reporte_at)}
                          </span>
                        </p>
                      )}
                      {r.estado === 'reparada' && r.origen_activo && (
                        <p className="mt-1 text-[11px] text-amber-400">
                          La cerraron como reparada pero la alerta sigue abierta: las lecturas todavía no
                          se normalizaron.
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge color={est.color}>{est.label}</Badge>
                      <Button icon={History} variante="fantasma" onClick={() => setBitacora(r)}>
                        Bitácora
                      </Button>
                      {abierta && (
                        <>
                          <Button
                            icon={Repeat}
                            variante="fantasma"
                            onClick={() =>
                              setAsignando({
                                origen: r.incidencia_id ? 'incidencia' : r.alerta_id ? 'alerta' : null,
                                id: r.incidencia_id ?? r.alerta_id,
                                titulo: r.titulo,
                                cuadrilla_id: r.cuadrilla_id ?? '',
                                tecnico_id: r.cuadrilla_id ? '' : (r.tecnico_id ?? ''),
                                prioridad: r.prioridad,
                                instrucciones: r.instrucciones ?? '',
                                reasignar: true,
                              })
                            }
                          >
                            Reasignar
                          </Button>
                          <Button icon={Ban} variante="fantasma" onClick={() => cancelar(r)}>
                            Cancelar
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>

      <FormAsignar
        datos={asignando}
        setDatos={setAsignando}
        cuadrillas={cuadrillas}
        tecnicos={tecnicos}
        onListo={recargar}
      />
      <Bitacora reparacion={bitacora} onCerrar={() => setBitacora(null)} />
    </Card>
  )
}

function FormAsignar({ datos, setDatos, cuadrillas, tecnicos, onListo }) {
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)
  const set = (campo) => (e) => setDatos((d) => ({ ...d, [campo]: e.target.value }))

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setError(null)
    const { error: err } = await supabase.rpc('asignar_reparacion', {
      p_incidencia: datos.origen === 'incidencia' ? datos.id : null,
      p_alerta: datos.origen === 'alerta' ? datos.id : null,
      // Cuadrilla o técnico suelto: si eligió las dos, manda la cuadrilla.
      p_cuadrilla: datos.cuadrilla_id || null,
      p_tecnico: datos.cuadrilla_id ? null : datos.tecnico_id || null,
      p_titulo: datos.titulo,
      p_instrucciones: datos.instrucciones,
      p_prioridad: datos.prioridad,
    })
    setGuardando(false)
    if (err) return setError(comoError(err))
    setDatos(null)
    await onListo()
  }

  return (
    <Modal
      abierto={Boolean(datos)}
      titulo={datos?.reasignar ? 'Reasignar la reparación' : 'Asignar la reparación'}
      onCerrar={() => setDatos(null)}
    >
      {datos && (
        <form onSubmit={guardar} className="space-y-4">
          <ErrorBanner error={error} onCerrar={() => setError(null)} />
          <Field label="Qué hay que reparar">
            <Input value={datos.titulo} onChange={set('titulo')} maxLength={150} required />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Cuadrilla" hint="La cierra su jefe de grupo del día.">
              <Select value={datos.cuadrilla_id} onChange={set('cuadrilla_id')}>
                <option value="">— Ninguna —</option>
                {cuadrillas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="O un técnico suelto">
              <Select
                value={datos.tecnico_id}
                onChange={set('tecnico_id')}
                disabled={Boolean(datos.cuadrilla_id)}
              >
                <option value="">— Ninguno —</option>
                {tecnicos.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.nombre}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Prioridad">
            <Select value={datos.prioridad} onChange={set('prioridad')}>
              <option value="alta">Alta</option>
              <option value="media">Media</option>
              <option value="baja">Baja</option>
            </Select>
          </Field>
          <Field label="Indicaciones para la cuadrilla" hint="Opcional: material, acceso, a quién llamar.">
            <Textarea rows={3} value={datos.instrucciones} onChange={set('instrucciones')} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variante="fantasma" onClick={() => setDatos(null)}>
              Volver
            </Button>
            <Button
              type="submit"
              variante="primario"
              icon={Hammer}
              cargando={guardando}
              disabled={!datos.cuadrilla_id && !datos.tecnico_id}
            >
              {datos.reasignar ? 'Reasignar' : 'Asignar'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}

/** Todo lo que pasó con una reparación, en orden. Lo usa también la app de campo. */
export function useBitacora(id) {
  const [filas, setFilas] = useState(null)
  useEffect(() => {
    if (!id) return setFilas(null)
    let vigente = true
    supabase
      .from('v_reparacion_reportes')
      .select('id, tipo, texto, quien, creado_at')
      .eq('reparacion_id', id)
      .order('creado_at')
      .then(({ data }) => vigente && setFilas(data ?? []))
    return () => {
      vigente = false
    }
  }, [id])
  return filas
}

function Bitacora({ reparacion, onCerrar }) {
  const filas = useBitacora(reparacion?.id)
  return (
    <Modal abierto={Boolean(reparacion)} titulo={`Reparación #${reparacion?.numero ?? ''}`} onCerrar={onCerrar}>
      {reparacion && (
        <div className="space-y-3">
          <p className="text-sm text-slate-200">{reparacion.titulo}</p>
          {reparacion.instrucciones && (
            <p className="flex gap-2 text-[12px] text-slate-400">
              <ClipboardList size={14} className="mt-0.5 shrink-0" /> {reparacion.instrucciones}
            </p>
          )}
          {!filas ? (
            <Cargando />
          ) : (
            <ul className="space-y-2">
              {filas.map((f) => (
                <li key={f.id} className="text-[12px]">
                  <span className="text-slate-500">{fecha(f.creado_at)} · {f.quien ?? '—'}</span>
                  <p className={f.tipo === 'reparada' ? 'text-emerald-400' : 'text-slate-200'}>{f.texto}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  )
}
