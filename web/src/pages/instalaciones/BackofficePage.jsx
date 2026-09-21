import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  Check,
  ClipboardCheck,
  Eye,
  FileSignature,
  Inbox,
  MapPin,
  Search,
  UserCheck,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import {
  Aviso,
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Select,
  SkeletonTabla,
  Stat,
  Table,
  Textarea,
} from '../../components/ui'
import ConPermiso from '../../components/layout/ConPermiso'
import { usePermisos } from '../../lib/AuthContext'
import { ESTADOS, ESTADOS_BACKOFFICE } from '../../lib/instalaciones'
import { TIPOS_DOCUMENTO, expedientesApi } from '../../lib/expedientes'
import { personalApi } from '../../lib/personal'

/**
 * Nuevas instalaciones — la bandeja del backoffice.
 *
 * ── Por qué es una pantalla aparte de Instalaciones ──
 *
 * Se evaluó agregar filtros a la pantalla que ya existe. Se descartó porque son
 * dos trabajos con ritmos distintos: aquella responde "¿en qué anda el trabajo
 * de la semana?" y se mira de a ratos; esta es una bandeja de entrada que hay
 * que vaciar — llega una venta, se revisa, se despacha, desaparece.
 *
 * Mezclarlas haría que las órdenes nuevas se pierdan entre las cincuenta que ya
 * están agendadas, que es exactamente el problema que esta pantalla evita.
 *
 * ── El orden ──
 *
 * Por antigüedad, la más vieja arriba. Es deliberado y va contra la costumbre de
 * ordenar por fecha descendente: acá lo que importa es lo que lleva más tiempo
 * esperando, porque cada día que una venta no se despacha es un día que el
 * cliente ya pagó la expectativa y no tiene servicio.
 */
export default function BackofficePage() {
  const { perfil } = usePermisos()

  const [ordenes, setOrdenes] = useState([])
  const [tecnicos, setTecnicos] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const [filtro, setFiltro] = useState('pendientes')
  const [busqueda, setBusqueda] = useState('')
  const [filtroVendedor, setFiltroVendedor] = useState('')
  const [filtroTecnico, setFiltroTecnico] = useState('')
  const [filtroSector, setFiltroSector] = useState('')

  const [revisando, setRevisando] = useState(null)
  const [asignando, setAsignando] = useState(null)

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      const [ins, tec, exp] = await Promise.all([
        supabase.from('v_instalaciones').select('*').order('created_at').limit(500),
        supabase.from('tecnicos').select('id, nombre, especialidad').eq('activo', true).order('nombre'),
        // El expediente trae de qué vendedor vino cada orden. Es el enlace que
        // permite el filtro que pediste.
        supabase.from('v_expedientes').select('*').not('instalacion_id', 'is', null),
      ])
      if (ins.error) throw ins.error

      const porInstalacion = Object.fromEntries(
        (exp.data ?? []).map((e) => [e.instalacion_id, e]),
      )
      setOrdenes((ins.data ?? []).map((i) => ({ ...i, expediente: porInstalacion[i.id] ?? null })))
      setTecnicos(tec.data ?? [])
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  // Los desplegables se arman con lo que hay cargado: ofrecer un sector que
  // nadie usa es un filtro que devuelve vacío y hace dudar del sistema.
  const vendedores = useMemo(
    () => [
      ...new Map(
        ordenes
          .filter((o) => o.expediente?.vendedor_id)
          .map((o) => [o.expediente.vendedor_id, o.expediente.vendedor ?? 'Sin nombre']),
      ).entries(),
    ],
    [ordenes],
  )
  const sectores = useMemo(
    () => [...new Set(ordenes.map((o) => o.sector).filter(Boolean))].sort(),
    [ordenes],
  )

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    return ordenes.filter((o) => {
      if (filtro === 'pendientes' && !ESTADOS_BACKOFFICE.includes(o.estado)) return false
      if (filtro !== 'pendientes' && filtro !== 'todas' && o.estado !== filtro) return false
      if (filtroVendedor && o.expediente?.vendedor_id !== filtroVendedor) return false
      if (filtroTecnico && o.tecnico_id !== filtroTecnico) return false
      if (filtroSector && o.sector !== filtroSector) return false
      if (!q) return true
      return [o.titular, o.cedula, o.telefono, o.direccion, o.sector, o.tecnico_nombre]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    })
  }, [ordenes, filtro, busqueda, filtroVendedor, filtroTecnico, filtroSector])

  const cuenta = (e) => ordenes.filter((o) => o.estado === e).length
  const diasEsperando = (o) =>
    Math.floor((Date.now() - new Date(o.created_at).getTime()) / 86400000)

  const cambiarEstado = async (orden, estado, extra = {}) => {
    try {
      const { error: err } = await supabase
        .from('instalaciones')
        .update({ estado, ...extra })
        .eq('id', orden.id)
      if (err) throw err

      personalApi.registrar(
        'instalacion.estado',
        `${orden.titular}: ${ESTADOS[orden.estado]?.label ?? orden.estado} → ${ESTADOS[estado]?.label ?? estado}`,
        { entidad: 'instalacion', entidad_id: orden.id },
      )
      await recargar()
    } catch (err) {
      setError(err)
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100">
          <Inbox size={20} className="text-sky-400" />
          Nuevas instalaciones
        </h1>
        <p className="text-sm text-slate-400">
          Las ventas cerradas que llegaron del equipo comercial, esperando revisión y técnico.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Nuevas sin revisar"
          valor={cuenta('nueva')}
          icon={Inbox}
          color={cuenta('nueva') ? 'text-violet-400' : 'text-slate-400'}
        />
        <Stat label="En revisión" valor={cuenta('revisando')} color="text-amber-400" />
        <Stat
          label="Listas para asignar"
          valor={cuenta('lista_asignar')}
          icon={UserCheck}
          color="text-sky-400"
        />
        <Stat
          label="Esperando hace 3+ días"
          valor={
            ordenes.filter((o) => ESTADOS_BACKOFFICE.includes(o.estado) && diasEsperando(o) >= 3)
              .length
          }
          icon={AlertTriangle}
          color="text-red-400"
        />
      </div>

      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <Input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por titular, cédula, teléfono o dirección"
              className="pl-9"
            />
          </div>
          <Select value={filtroVendedor} onChange={(e) => setFiltroVendedor(e.target.value)} className="w-44">
            <option value="">Todos los vendedores</option>
            {vendedores.map(([id, nombre]) => (
              <option key={id} value={id}>
                {nombre}
              </option>
            ))}
          </Select>
          <Select value={filtroTecnico} onChange={(e) => setFiltroTecnico(e.target.value)} className="w-44">
            <option value="">Todos los técnicos</option>
            <option value="__sin">— sin asignar —</option>
            {tecnicos.map((t) => (
              <option key={t.id} value={t.id}>
                {t.nombre}
              </option>
            ))}
          </Select>
          <Select value={filtroSector} onChange={(e) => setFiltroSector(e.target.value)} className="w-40">
            <option value="">Todos los sectores</option>
            {sectores.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </div>

        <div className="mb-3 flex flex-wrap gap-1.5 border-t border-slate-800 pt-3">
          {[
            { clave: 'pendientes', label: 'Esperándome' },
            ...ESTADOS_BACKOFFICE.map((e) => ({ clave: e, label: ESTADOS[e].label })),
            { clave: 'agendada', label: 'Agendadas' },
            { clave: 'todas', label: 'Todas' },
          ].map((f) => (
            <button
              key={f.clave}
              type="button"
              onClick={() => setFiltro(f.clave)}
              className={`rounded-lg border px-3 py-1.5 text-[13px] transition ${
                filtro === f.clave
                  ? 'border-sky-500/50 bg-sky-500/10 text-sky-300'
                  : 'border-slate-800 text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {cargando ? (
          <SkeletonTabla filas={6} columnas={6} />
        ) : (
          <Table
            columnas={['Cliente', 'Vendedor', 'Plan', 'Estado', 'Técnico', 'Esperando', '']}
            filas={visibles}
            vacio={
              filtro === 'pendientes'
                ? 'No hay nada esperando. Todo lo que llegó ya está despachado.'
                : 'Ninguna orden coincide con el filtro.'
            }
            renderFila={(o) => {
              const dias = diasEsperando(o)
              const demorada = ESTADOS_BACKOFFICE.includes(o.estado) && dias >= 3
              return (
                <tr key={o.id} className="hover:bg-slate-800/40">
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-100">{o.titular}</div>
                    <div className="text-[11px] text-slate-500">
                      {o.sector ? `${o.sector} · ` : ''}
                      {o.telefono ?? 'sin teléfono'}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-[12px] text-slate-400">
                    {o.expediente?.vendedor ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-[12px] text-slate-300">{o.plan ?? '—'}</td>
                  <td className="px-3 py-2">
                    <Badge color={ESTADOS[o.estado]?.color ?? 'gris'}>
                      {ESTADOS[o.estado]?.label ?? o.estado}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-[12px] text-slate-400">
                    {o.tecnico_nombre ?? <span className="text-amber-400">sin asignar</span>}
                    {o.fecha && (
                      <div className="text-[11px] text-slate-500">
                        {new Date(`${o.fecha}T12:00:00`).toLocaleDateString('es-EC')}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`text-[13px] tabular-nums ${
                        demorada ? 'font-medium text-red-400' : 'text-slate-400'
                      }`}
                    >
                      {dias} d
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        variante="fantasma"
                        icon={Eye}
                        title="Revisar el expediente"
                        onClick={() => setRevisando(o)}
                      />
                      <ConPermiso permiso="soporte.asignar" envezDe={null}>
                        <Button
                          variante="fantasma"
                          icon={UserCheck}
                          title="Asignar técnico y fecha"
                          onClick={() =>
                            setAsignando({
                              orden: o,
                              tecnico_id: o.tecnico_id ?? '',
                              fecha: o.fecha ?? new Date().toISOString().slice(0, 10),
                              hora: o.hora ?? '',
                              nota: '',
                            })
                          }
                        />
                      </ConPermiso>
                    </div>
                  </td>
                </tr>
              )
            }}
          />
        )}
      </Card>

      {/* Revisar el expediente */}
      <Modal
        abierto={!!revisando}
        titulo={`Expediente — ${revisando?.titular ?? ''}`}
        onCerrar={() => setRevisando(null)}
        ancho="max-w-3xl"
      >
        {revisando && (
          <RevisionExpediente
            orden={revisando}
            perfil={perfil}
            onError={setError}
            onEstado={async (estado) => {
              await cambiarEstado(revisando, estado)
              setRevisando(null)
            }}
          />
        )}
      </Modal>

      {/* Asignar técnico */}
      <Modal
        abierto={!!asignando}
        titulo={`Asignar — ${asignando?.orden?.titular ?? ''}`}
        onCerrar={() => setAsignando(null)}
      >
        {asignando && (
          <div className="space-y-3">
            <Field label="Técnico">
              <Select
                value={asignando.tecnico_id}
                onChange={(e) => setAsignando({ ...asignando, tecnico_id: e.target.value })}
              >
                <option value="">— elegí el técnico —</option>
                {tecnicos.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.nombre}
                    {t.especialidad === 'ftth' ? ' · solo fibra' : ''}
                    {t.especialidad === 'wireless' ? ' · solo radio' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Fecha">
                <Input
                  type="date"
                  value={asignando.fecha}
                  onChange={(e) => setAsignando({ ...asignando, fecha: e.target.value })}
                />
              </Field>
              <Field label="Hora (opcional)">
                <Input
                  type="time"
                  value={asignando.hora}
                  onChange={(e) => setAsignando({ ...asignando, hora: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Observación para el técnico">
              <Textarea
                rows={2}
                value={asignando.nota}
                onChange={(e) => setAsignando({ ...asignando, nota: e.target.value })}
                placeholder="Llevar escalera larga, perro suelto, timbre roto…"
              />
            </Field>

            <Aviso>
              Al asignar, la orden pasa a <b>Agendada</b> y le aparece al técnico en su lista de
              trabajos.
            </Aviso>

            <div className="flex justify-end gap-2">
              <Button variante="fantasma" onClick={() => setAsignando(null)}>
                Cancelar
              </Button>
              <Button
                disabled={!asignando.tecnico_id || !asignando.fecha}
                onClick={async () => {
                  await cambiarEstado(asignando.orden, 'agendada', {
                    tecnico_id: asignando.tecnico_id,
                    fecha: asignando.fecha,
                    hora: asignando.hora || null,
                    // La observación se suma, no pisa: la del vendedor sigue
                    // siendo útil para el técnico.
                    notas: [asignando.orden.notas, asignando.nota].filter(Boolean).join('\n'),
                  })
                  setAsignando(null)
                }}
              >
                Asignar y agendar
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * La revisión: qué mandó el vendedor y si sirve.
 *
 * Es el control de calidad del expediente. Aprobar acá es lo que compromete a un
 * técnico a salir, así que la pantalla muestra las fotos de verdad —no un tilde
 * de "cargado"— porque una cédula borrosa figura como cargada igual.
 */
function RevisionExpediente({ orden, perfil, onError, onEstado }) {
  const [documentos, setDocumentos] = useState([])
  const [viendo, setViendo] = useState(null)
  const [cargando, setCargando] = useState(true)

  const exp = orden.expediente

  useEffect(() => {
    if (!exp?.id) return setCargando(false)
    expedientesApi
      .abrir(exp.id)
      .then(({ documentos: d }) => setDocumentos(d))
      .catch(onError)
      .finally(() => setCargando(false))
  }, [exp?.id, onError])

  const mapa =
    orden.latitud && orden.longitud
      ? `https://www.google.com/maps?q=${orden.latitud},${orden.longitud}`
      : null

  return (
    <div className="space-y-4">
      <div className="grid gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-3 text-[13px] md:grid-cols-2">
        <Dato etiqueta="Titular" valor={orden.titular} />
        <Dato etiqueta="Cédula" valor={orden.cedula} />
        <Dato etiqueta="Teléfono" valor={orden.telefono} />
        <Dato etiqueta="Plan" valor={orden.plan} />
        <Dato etiqueta="Dirección" valor={orden.direccion} ancho />
        <Dato etiqueta="Cómo llegar" valor={orden.referencia} ancho />
        <Dato etiqueta="Vendedor" valor={exp?.vendedor} />
        <Dato etiqueta="Contrato" valor={exp?.contrato_numero} />
      </div>

      {/* La ubicación, con su procedencia. Una cargada a mano merece una mirada
          antes de mandar a alguien: puede estar a dos cuadras. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-3">
        <MapPin size={16} className="text-sky-400" />
        {orden.latitud ? (
          <>
            <span className="font-mono text-[13px] text-slate-200">
              {Number(orden.latitud).toFixed(6)}, {Number(orden.longitud).toFixed(6)}
            </span>
            {exp?.ubicacion_origen && (
              <Badge color={exp.ubicacion_origen === 'gps' ? 'verde' : 'ambar'}>
                {exp.ubicacion_origen === 'gps'
                  ? `GPS ±${Math.round(exp.precision_m)} m`
                  : 'Cargada a mano'}
              </Badge>
            )}
            <a
              href={mapa}
              target="_blank"
              rel="noreferrer"
              className="ml-auto text-[12px] text-sky-400 underline"
            >
              Abrir el mapa
            </a>
          </>
        ) : (
          <span className="text-[13px] text-amber-400">Sin ubicación registrada</span>
        )}
      </div>

      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-200">
          <ClipboardCheck size={16} /> Documentación
        </h3>
        {cargando ? (
          <p className="py-3 text-center text-[13px] text-slate-500">Cargando…</p>
        ) : documentos.length === 0 ? (
          <Aviso tipo="alerta">Esta orden no tiene expediente asociado — se cargó a mano.</Aviso>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {documentos
              .filter((d) => d.estado !== 'rechazado')
              .map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={async () => {
                    try {
                      setViendo(await expedientesApi.verDocumento(d.ruta))
                    } catch (err) {
                      onError(err)
                    }
                  }}
                  className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/40 p-2.5 text-left hover:border-sky-500/50"
                >
                  <span className="text-[13px] text-slate-200">{TIPOS_DOCUMENTO[d.tipo]}</span>
                  <Eye size={15} className="shrink-0 text-slate-400" />
                </button>
              ))}
          </div>
        )}
        <p className="mt-2 text-[11px] text-slate-500">
          Abrir un documento queda registrado en la auditoría, con tu nombre y la hora.
        </p>
      </div>

      {exp && !exp.ok_firma && (
        <Aviso tipo="alerta">
          <FileSignature size={14} className="mr-1 inline" />
          El contrato de esta orden no figura firmado. No debería haber llegado acá — revisalo antes
          de aprobar.
        </Aviso>
      )}

      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-800 pt-3">
        <Button variante="peligro" onClick={() => onEstado('cancelada')}>
          Rechazar
        </Button>
        {orden.estado === 'nueva' && (
          <Button onClick={() => onEstado('revisando')}>Marcar en revisión</Button>
        )}
        <Button variante="primario" icon={Check} onClick={() => onEstado('lista_asignar')}>
          Documentación aprobada
        </Button>
      </div>

      {viendo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={() => setViendo(null)}
        >
          <img src={viendo} alt="Documento" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </div>
  )
}

const Dato = ({ etiqueta, valor, ancho }) => (
  <div className={ancho ? 'md:col-span-2' : ''}>
    <span className="text-slate-500">{etiqueta}: </span>
    <span className="text-slate-200">{valor || '—'}</span>
  </div>
)
