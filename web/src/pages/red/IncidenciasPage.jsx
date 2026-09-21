import { useCallback, useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import {
  AlertOctagon,
  Ban,
  Check,
  Megaphone,
  Plus,
  Send,
  Users,
  Wrench,
} from 'lucide-react'

import { api } from '../../lib/apiNetwork'
import { supabase } from '../../lib/supabaseClient'
import { usePermisos } from '../../lib/AuthContext'
import { MOTIVOS_CANCELAR_INCIDENCIA } from '../../lib/motivos'
import {
  Aviso,
  Badge,
  Button,
  Card,
  Cargando,
  ErrorBanner,
  Field,
  Input,
  Modal,
  PedirMotivo,
  Select,
  Stat,
  Table,
  Textarea,
} from '../../components/ui'

/**
 * Cortes masivos: avisarle al sector antes de que el sector escriba.
 *
 * ── Lo que esta pantalla tiene que hacer bien ──
 *
 * Una sola cosa: que el número de afectados esté sobre la mesa ANTES de que
 * exista un botón que mande mensajes. "Esta zona son 12 abonados" y "esta zona
 * son 340" se deciden distinto, y si el número aparece recién después de crear
 * la incidencia, la tentación es abrirla igual.
 *
 * Por eso el formulario previsualiza mientras se elige el alcance, con una
 * muestra de nombres: el número solo no permite ver que se eligió la zona
 * vecina.
 */

const TIPOS = [
  ['fibra_rota', 'Fibra cortada'],
  ['enlace_caido', 'Enlace o antena caída'],
  ['corte_energia', 'Corte de energía'],
  ['mantenimiento', 'Mantenimiento programado'],
  ['averia', 'Avería (otra)'],
  ['otro', 'Otro'],
]

const ALCANCES = [
  ['zona', 'Una zona'],
  ['punto', 'Una caja NAP, antena o torre'],
  ['nodo', 'Un nodo del monitoreo (y todo lo que cuelga)'],
  ['olt', 'Una OLT o un puerto PON'],
  ['router', 'Un router'],
]

const FORM = {
  tipo: 'fibra_rota',
  titulo: '',
  descripcion: '',
  alcance: 'zona',
  zona: '',
  punto_id: '',
  nodo_id: '',
  olt_id: '',
  puerto_pon: '',
  router_id: '',
  estimado_at: '',
  inicio_previsto: '',
  fin_previsto: '',
  avisar_apertura: true,
  avisar_resolucion: true,
}

const fecha = (v) =>
  v ? new Date(v).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' }) : '—'

const duracion = (min) => {
  if (min == null) return '—'
  const m = Math.round(min)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

export default function IncidenciasPage() {
  const confirmar = useConfirmar()
  const { puede } = usePermisos()
  const puedeAvisar = puede('red.incidencias')

  const [estado, setEstado] = useState('abierta')
  const [filas, setFilas] = useState([])
  // La incidencia que se está por cancelar.
  const [aCancelar, setACancelar] = useState(null)
  const [cancelando, setCancelando] = useState(false)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [creando, setCreando] = useState(null)
  const [guardando, setGuardando] = useState(false)

  // Los catálogos del formulario. Se leen una vez: no cambian mientras alguien
  // está cargando una avería.
  const [catalogos, setCatalogos] = useState({ zonas: [], puntos: [], nodos: [], olts: [], routers: [] })

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      setFilas(await api.incidencias.listar(estado))
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [estado])

  useEffect(() => {
    recargar()
  }, [recargar])

  useEffect(() => {
    Promise.all([
      supabase.from('clientes').select('zona').not('zona', 'is', null).neq('estado', 'baja'),
      supabase.from('puntos_red').select('id, nombre, tipo').eq('activo', true).order('nombre'),
      supabase.from('nodos_red').select('id, nombre, tipo, estado').order('nombre'),
      supabase.from('olts').select('id, nombre').order('nombre'),
      supabase.from('routers_mikrotik').select('id, nombre').order('nombre'),
    ])
      .then(([z, p, n, o, r]) => {
        setCatalogos({
          // Las zonas no son una tabla: son texto en la ficha del abonado. Se
          // sacan de ahí para que la lista sea exactamente lo que existe.
          zonas: [...new Set((z.data ?? []).map((x) => x.zona).filter(Boolean))].sort(),
          puntos: p.data ?? [],
          nodos: n.data ?? [],
          olts: o.data ?? [],
          routers: r.data ?? [],
        })
      })
      .catch(() => {})
  }, [])

  async function accion(fn, fila, confirmacion) {
    if (confirmacion && !await confirmar(confirmacion)) return
    setError(null)
    try {
      await fn(fila.id)
      await recargar()
    } catch (err) {
      setError(err)
    }
  }

  const abiertas = filas.filter((f) => f.estado === 'abierta')
  const porAvisar = filas.reduce((s, f) => s + Number(f.por_avisar ?? 0), 0)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Cortes masivos</h1>
        <p className="text-sm text-slate-500">
          Avisarle a un sector de una avería o un mantenimiento, antes de que el sector escriba.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Abiertas ahora" valor={abiertas.length} icon={AlertOctagon} color="text-amber-400" />
        <Stat
          label="Abonados alcanzados"
          valor={abiertas.reduce((s, f) => s + Number(f.afectados ?? 0), 0)}
          icon={Users}
        />
        <Stat label="Avisos en cola" valor={porAvisar} icon={Send} />
      </div>

      {porAvisar > 0 && (
        <Aviso tipo="alerta">
          Hay <b>{porAvisar}</b> avisos esperando salir. Se mandan solos si la tarea{' '}
          <b>Aviso de cortes masivos</b> está encendida en Ajustes → Tareas programadas; si no,
          usá el botón <b>Enviar ahora</b> de la incidencia.
        </Aviso>
      )}

      <Card
        title="Incidencias"
        icon={Megaphone}
        actions={
          <div className="flex items-center gap-2">
            <Select value={estado} onChange={(e) => setEstado(e.target.value)} className="w-auto">
              <option value="abierta">Abiertas</option>
              <option value="borrador">Borradores</option>
              <option value="resuelta">Resueltas</option>
              <option value="cancelada">Canceladas</option>
              <option value="todas">Todas</option>
            </Select>
            {puedeAvisar && (
              <Button icon={Plus} onClick={() => setCreando({ ...FORM })}>
                Nueva
              </Button>
            )}
          </div>
        }
      >
        {cargando ? (
          <Cargando />
        ) : (
          <Table
            columnas={['Qué pasó', 'Alcance', 'Abonados', 'Avisos', 'Desde', '']}
            filas={filas}
            vacio={
              estado === 'abierta'
                ? 'No hay ninguna avería abierta ahora mismo.'
                : 'No hay incidencias con ese estado.'
            }
            renderFila={(f) => (
              <tr key={f.id} className="text-slate-300">
                <td className="px-3 py-2">
                  <span className="block text-slate-100">{f.titulo}</span>
                  <span className="text-[11px] text-slate-500">
                    {TIPOS.find((t) => t[0] === f.tipo)?.[1] ?? f.tipo}
                    {f.origen === 'nms' && ' · detectada por el monitoreo'}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs">
                  {f.zona ?? f.punto ?? f.nodo ?? f.olt ?? f.router ?? 'selección manual'}
                  {f.puerto_pon && <span className="text-slate-500"> · PON {f.puerto_pon}</span>}
                </td>
                <td className="px-3 py-2">
                  <b>{f.afectados ?? '—'}</b>
                </td>
                <td className="px-3 py-2 text-xs">
                  {/* Los tres números que importan durante un corte: cuántos ya
                      lo saben, cuántos faltan y a cuántos no se les pudo decir. */}
                  <span className="text-emerald-400">{f.avisados} avisados</span>
                  {Number(f.por_avisar) > 0 && (
                    <span className="block text-amber-400">{f.por_avisar} en cola</span>
                  )}
                  {Number(f.fallidos) > 0 && (
                    <span className="block text-red-400">{f.fallidos} sin canal</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs">
                  <span className="block">{fecha(f.ocurrio_at)}</span>
                  <span className="text-[11px] text-slate-500">{duracion(f.minutos)}</span>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-2">
                    <EstadoIncidencia estado={f.estado} />
                    {puedeAvisar && f.estado === 'borrador' && (
                      <Button
                        icon={Megaphone}
                        variante="primario"
                        onClick={() =>
                          accion(api.incidencias.abrir, f,
                            `Se le va a avisar a ${f.afectados ?? '?'} abonados que hay una avería en su sector.\n\n` +
                              'Los mensajes que salgan no se pueden retirar. ¿Confirmás?')
                        }
                      >
                        Avisar
                      </Button>
                    )}
                    {puedeAvisar && f.estado === 'abierta' && (
                      <>
                        {Number(f.por_avisar) > 0 && (
                          <Button
                            icon={Send}
                            variante="fantasma"
                            onClick={async () => {
                              try {
                                const r = await api.incidencias.enviarPendientes(200)
                                await recargar()
                                if (!r.enviados) setError(new Error('No salió ninguno: revisá los canales de mensajería.'))
                              } catch (err) {
                                setError(err)
                              }
                            }}
                          >
                            Enviar ahora
                          </Button>
                        )}
                        <Button
                          icon={Check}
                          variante="primario"
                          onClick={() =>
                            accion(api.incidencias.resolver, f,
                              'Se le va a avisar a los que recibieron el aviso que el servicio quedó restablecido.\n\n¿El corte está solucionado?')
                          }
                        >
                          Resolver
                        </Button>
                      </>
                    )}
                    {puedeAvisar && ['borrador', 'abierta'].includes(f.estado) && (
                      <Button
                        icon={Ban}
                        variante="fantasma"
                        onClick={() => setACancelar(f)}
                                            >
                        Cancelar
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            )}
          />
        )}
      </Card>

      <FormIncidencia
        creando={creando}
        setCreando={setCreando}
        catalogos={catalogos}
        guardando={guardando}
        setGuardando={setGuardando}
        onCreada={recargar}
        onError={setError}
      />

      <PedirMotivo
        abierto={!!aCancelar}
        titulo="Cancelar la incidencia"
        etiquetaAccion="Cancelar la incidencia"
        icon={Ban}
        cargando={cancelando}
        advertencia="Frena los avisos que todavía no salieron. Lo que ya se mandó no se puede retirar."
        datos={
          aCancelar
            ? [
                ['Incidencia', aCancelar.titulo ?? '—'],
                ['Estado', aCancelar.estado],
                ['Afectados', `${aCancelar.afectados ?? '—'}`],
              ]
            : []
        }
        sugerencias={MOTIVOS_CANCELAR_INCIDENCIA}
        onCancelar={() => setACancelar(null)}
        onConfirmar={async (motivo) => {
          setCancelando(true)
          try {
            await api.incidencias.cancelar(aCancelar.id, motivo)
            setACancelar(null)
            await recargar()
          } catch (err) {
            setError(err)
          } finally {
            setCancelando(false)
          }
        }}
      />
    </div>
  )
}

function EstadoIncidencia({ estado }) {
  if (estado === 'abierta') return <Badge color="ambar">Avisada</Badge>
  if (estado === 'borrador') return <Badge color="gris">Sin avisar</Badge>
  if (estado === 'resuelta') return <Badge color="verde">Resuelta</Badge>
  return <Badge color="rojo">Cancelada</Badge>
}

/**
 * El formulario, con la previsualización viva.
 *
 * El número de afectados se recalcula cada vez que cambia el alcance, y no al
 * guardar. Es la única forma de que la decisión de a quién avisarle se tome
 * mirando el número y no después de haberlo creado.
 */
function FormIncidencia({ creando, setCreando, catalogos, guardando, setGuardando, onCreada, onError }) {
  const [previa, setPrevia] = useState(null)
  const [calculando, setCalculando] = useState(false)

  const set = (campo) => (e) => {
    const valor = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setCreando((c) => ({ ...c, [campo]: valor }))
  }

  // Recalcula cuando cambia algo del alcance. El resto del formulario —el
  // título, la descripción— no lo toca: escribir el texto no cambia a quién le
  // llega.
  useEffect(() => {
    if (!creando) return setPrevia(null)

    const alcance = {
      alcance: creando.alcance,
      zona: creando.zona,
      punto_id: creando.punto_id || null,
      nodo_id: creando.nodo_id || null,
      olt_id: creando.olt_id || null,
      puerto_pon: creando.puerto_pon || null,
      router_id: creando.router_id || null,
    }

    const listo =
      (creando.alcance === 'zona' && creando.zona) ||
      (creando.alcance === 'punto' && creando.punto_id) ||
      (creando.alcance === 'nodo' && creando.nodo_id) ||
      (creando.alcance === 'olt' && creando.olt_id) ||
      (creando.alcance === 'router' && creando.router_id)

    if (!listo) return setPrevia(null)

    setCalculando(true)
    api.incidencias
      .previsualizar(alcance)
      .then(setPrevia)
      .catch(() => setPrevia(null))
      .finally(() => setCalculando(false))
  }, [
    creando?.alcance,
    creando?.zona,
    creando?.punto_id,
    creando?.nodo_id,
    creando?.olt_id,
    creando?.puerto_pon,
    creando?.router_id,
    creando,
  ])

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    onError(null)
    try {
      await api.incidencias.crear(creando)
      setCreando(null)
      await onCreada()
    } catch (err) {
      onError(err)
    } finally {
      setGuardando(false)
    }
  }

  const programada = creando?.tipo === 'mantenimiento'

  return (
    <Modal
      abierto={Boolean(creando)}
      titulo="Nueva incidencia"
      onCerrar={() => setCreando(null)}
      ancho="max-w-2xl"
    >
      {creando && (
        <form onSubmit={guardar} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Qué pasó">
              <Select value={creando.tipo} onChange={set('tipo')}>
                {TIPOS.map(([v, n]) => (
                  <option key={v} value={v}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="A quiénes afecta">
              <Select value={creando.alcance} onChange={set('alcance')}>
                {ALCANCES.map(([v, n]) => (
                  <option key={v} value={v}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {creando.alcance === 'zona' && (
            <Field label="Zona">
              <Select value={creando.zona} onChange={set('zona')}>
                <option value="">Elegí una zona…</option>
                {catalogos.zonas.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {creando.alcance === 'punto' && (
            <Field label="Caja NAP, antena o torre">
              <Select value={creando.punto_id} onChange={set('punto_id')}>
                <option value="">Elegí…</option>
                {catalogos.puntos.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre} ({p.tipo})
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {creando.alcance === 'nodo' && (
            <Field
              label="Nodo del monitoreo"
              hint="Incluye todo lo que cuelga de él: si elegís la torre, entran también los abonados de sus sectoriales."
            >
              <Select value={creando.nodo_id} onChange={set('nodo_id')}>
                <option value="">Elegí…</option>
                {catalogos.nodos.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.nombre} {n.estado === 'down' ? '— CAÍDO' : ''}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {creando.alcance === 'olt' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="OLT">
                <Select value={creando.olt_id} onChange={set('olt_id')}>
                  <option value="">Elegí…</option>
                  {catalogos.olts.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.nombre}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Puerto PON"
                hint="Vacío = la OLT entera. Una fibra rota casi siempre es un puerto, no la OLT."
              >
                <Input value={creando.puerto_pon} onChange={set('puerto_pon')} placeholder="3" />
              </Field>
            </div>
          )}

          {creando.alcance === 'router' && (
            <Field label="Router">
              <Select value={creando.router_id} onChange={set('router_id')}>
                <option value="">Elegí…</option>
                {catalogos.routers.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.nombre}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {/* --- El número, antes de cualquier botón que mande nada --- */}
          <div
            className={`rounded-lg border p-3 ${
              previa?.afectados > 100
                ? 'border-amber-500/40 bg-amber-500/5'
                : 'border-slate-800 bg-slate-950/40'
            }`}
          >
            {calculando ? (
              <p className="text-[12px] text-slate-500">Calculando a quiénes alcanza…</p>
            ) : previa ? (
              <>
                <p className="text-[13px] text-slate-100">
                  <Users size={13} className="mr-1 inline" />
                  Alcanza a <b>{previa.afectados}</b>{' '}
                  {previa.afectados === 1 ? 'abonado' : 'abonados'}.
                </p>
                {previa.muestra?.length > 0 && (
                  <p className="mt-1 text-[11px] leading-snug text-slate-500">
                    Por ejemplo: {previa.muestra.map((m) => m.nombre).join(', ')}
                    {previa.afectados > previa.muestra.length && '…'}
                  </p>
                )}
                {previa.afectados === 0 && (
                  <p className="mt-1 text-[11px] text-amber-300">
                    No alcanza a nadie. Revisá el alcance: puede que los abonados de ese sector no
                    tengan cargada la caja o la zona.
                  </p>
                )}
              </>
            ) : (
              <p className="text-[12px] text-slate-500">Elegí el alcance para ver a cuántos alcanza.</p>
            )}
          </div>

          <Field
            label="Título"
            hint="Este texto se le manda al abonado tal cual. Escribilo como se lo dirías por teléfono."
          >
            <Input
              value={creando.titulo}
              onChange={set('titulo')}
              placeholder="Fibra cortada en la vía a El Progreso"
              maxLength={120}
            />
          </Field>

          <Field label="Detalle" hint="Va solo en el correo. El SMS y el WhatsApp llevan el título.">
            <Textarea rows={2} value={creando.descripcion} onChange={set('descripcion')} />
          </Field>

          {programada ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Desde">
                <Input type="datetime-local" value={creando.inicio_previsto} onChange={set('inicio_previsto')} />
              </Field>
              <Field label="Hasta">
                <Input type="datetime-local" value={creando.fin_previsto} onChange={set('fin_previsto')} />
              </Field>
            </div>
          ) : (
            <Field
              label="Estimamos restablecer"
              hint="Opcional, y es lo que más baja los mensajes repetidos. Sin esto se manda 'estamos trabajando'."
            >
              <Input type="datetime-local" value={creando.estimado_at} onChange={set('estimado_at')} />
            </Field>
          )}

          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={creando.avisar_resolucion}
              onChange={set('avisar_resolucion')}
            />
            <span className="text-[13px] text-slate-100">
              Avisar también cuando se solucione
              <span className="block text-[11px] text-slate-500">
                Es la mitad que se olvida, y la que hace que el abonado deje de reiniciar el router.
              </span>
            </span>
          </label>

          <Aviso>
            <Wrench size={13} className="mr-1 inline" />
            Se crea <b>sin avisar</b>. Los mensajes salen recién cuando apretás <b>Avisar</b> en la
            lista, y ahí se vuelve a pedir confirmación con el número de afectados.
          </Aviso>

          <div className="flex justify-end gap-2">
            <Button variante="fantasma" type="button" onClick={() => setCreando(null)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={guardando || !creando.titulo.trim()}>
              {guardando ? 'Creando…' : 'Crear sin avisar'}
            </Button>
          </div>
        </form>
      )}
    </Modal>

  )
}
