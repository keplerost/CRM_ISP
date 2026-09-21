import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { Link, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Clock,
  FileSignature,
  FileText,
  Flame,
  Phone,
  Plus,
  Search,
  Target,
  Trash2,
  TrendingUp,
  UserPlus,
} from 'lucide-react'
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
import { expedientesApi, loQueFalta } from '../../lib/expedientes'
import { dineroCero as dinero } from '../../lib/formato'
import {
  COBERTURAS,
  ESTADOS,
  ESTADOS_ABIERTOS,
  ORIGENES,
  RESULTADOS,
  TIPOS_ACTIVIDAD,
  etiquetaEstado,
  seEstaEnfriando,
  ventasApi,
} from '../../lib/ventas'

/**
 * Prospectos — el embudo de ventas.
 *
 * ── Por qué el listado se ordena por lo que se está enfriando ──
 *
 * La tentación es ordenar por fecha de carga, como todas las listas del
 * sistema. Acá sería lo peor: el prospecto de hoy no necesita nada, y el que
 * pidió precio hace seis días es el que se está yendo con otro proveedor. El
 * orden por defecto pone arriba lo que hay que atender hoy.
 *
 * ── Ganar no es terminar ──
 *
 * Marcar GANADO abre el expediente: documentación, cédula, fotos, ubicación,
 * contrato y firma. La orden de instalación se crea sola recién cuando ese
 * expediente está completo, y lo verifica el servidor.
 *
 * Antes esta pantalla decía que había que pasar a Instalaciones a mano. Ya no:
 * crear la orden antes de la firma llenaba la agenda de los técnicos de trabajos
 * que todavía podían caerse.
 */

const VACIO = {
  nombre: '',
  identificacion: '',
  telefono: '',
  telefono_whatsapp: '',
  email: '',
  direccion: '',
  referencia: '',
  sector: '',
  canton: '',
  plan_id: '',
  origen: 'llamada',
  estado: 'nuevo',
  cobertura: 'pendiente',
  proxima_accion: '',
  notas: '',
}

const fecha = (v) => (v ? new Date(v).toLocaleDateString('es-EC') : '—')

export default function ProspectosPage() {
  const confirmar = useConfirmar()
  const { puede, perfil } = usePermisos()
  const [params, setParams] = useSearchParams()

  const [prospectos, setProspectos] = useState([])
  const [planes, setPlanes] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const [busqueda, setBusqueda] = useState('')
  const [filtroEstado, setFiltroEstado] = useState('abiertos')

  const [editando, setEditando] = useState(null)
  const [guardando, setGuardando] = useState(false)
  const [abierto, setAbierto] = useState(null) // la ficha desplegada
  const [perdiendo, setPerdiendo] = useState(null)

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      const [lista, cat] = await Promise.all([ventasApi.listar(), ventasApi.planes()])
      setProspectos(lista)
      setPlanes(cat)
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

  /**
   * El filtro puede venir del menú (`?f=abiertos`, `?f=enfriando`).
   *
   * Es lo que hace que "Pipeline" y "Seguimientos" del menú lateral sean vistas
   * de verdad y no pantallas nuevas: la misma lista, con el corte que el
   * vendedor iba a aplicar igual.
   */
  useEffect(() => {
    const f = params.get('f')
    if (f) setFiltroEstado(f)
  }, [params])

  /**
   * Abre el prospecto que venga en la URL (`?p=<id>`).
   *
   * Es lo que hace que el tablero pueda mandar acá directo a la persona que
   * acaba de nombrar, en vez de dejar al vendedor buscándola de nuevo en una
   * lista de quinientos. Se limpia el parámetro al abrir para que cerrar la
   * ficha y recargar no la vuelva a abrir sola.
   */
  useEffect(() => {
    const id = params.get('p')
    if (!id || !prospectos.length) return
    const p = prospectos.find((x) => x.id === id)
    if (p) setAbierto(p)
    setParams({}, { replace: true })
  }, [params, prospectos, setParams])

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    return prospectos
      .filter((p) => {
        if (filtroEstado === 'abiertos') return ESTADOS_ABIERTOS.includes(p.estado)
        if (filtroEstado === 'enfriando') return seEstaEnfriando(p)
        if (filtroEstado && filtroEstado !== 'todos') return p.estado === filtroEstado
        return true
      })
      .filter(
        (p) =>
          !q ||
          [p.nombre, p.telefono, p.identificacion, p.sector, p.direccion]
            .filter(Boolean)
            .some((c) => String(c).toLowerCase().includes(q)),
      )
      .sort((a, b) => (b.dias_sin_contacto ?? 0) - (a.dias_sin_contacto ?? 0))
  }, [prospectos, busqueda, filtroEstado])

  const contar = (estado) => prospectos.filter((p) => p.estado === estado).length
  const abiertos = prospectos.filter((p) => ESTADOS_ABIERTOS.includes(p.estado))
  const enfriando = prospectos.filter(seEstaEnfriando).length

  const guardar = async () => {
    setGuardando(true)
    try {
      await ventasApi.guardar({
        ...editando,
        // Los desplegables devuelven '' cuando están en "sin elegir", y una
        // cadena vacía en una columna UUID revienta el insert con un error que
        // no le dice nada a quien lo ve.
        plan_id: editando.plan_id || null,
        proxima_accion: editando.proxima_accion || null,
        // Las coordenadas viajan como texto desde el formulario. Una cadena
        // vacía en una columna numérica revienta el insert, y un `Number('')`
        // daría 0 — que es una coordenada válida en medio del Atlántico.
        latitud: editando.latitud ? Number(editando.latitud) : null,
        longitud: editando.longitud ? Number(editando.longitud) : null,
        vendedor_id: editando.vendedor_id ?? perfil?.id ?? null,
        creado_por: editando.id ? undefined : perfil?.id ?? null,
      })
      setEditando(null)
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  const mover = async (p, estado) => {
    if (estado === 'perdido') return setPerdiendo({ p, motivo: '' })
    try {
      await ventasApi.cambiarEstado(p, estado)
      await recargar()
    } catch (err) {
      setError(err)
    }
  }

  const eliminar = async (p) => {
    if (!await confirmar(`¿Eliminar el prospecto ${p.nombre}? No se puede deshacer.`)) return
    try {
      await ventasApi.eliminar(p)
      await recargar()
    } catch (err) {
      setError(err)
    }
  }

  const puedeEditar = puede('ventas.prospectos')

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100">
            <Target size={20} className="text-sky-400" />
            Prospectos
          </h1>
          <p className="text-sm text-slate-400">
            Quién preguntó por el servicio, en qué quedó y a quién hay que volver a llamar.
          </p>
        </div>
        <ConPermiso permiso="ventas.prospectos" envezDe={null}>
          <Button variante="primario" icon={Plus} onClick={() => setEditando({ ...VACIO })}>
            Nuevo prospecto
          </Button>
        </ConPermiso>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="En el embudo" valor={abiertos.length} icon={TrendingUp} />
        <Stat
          label="Se están enfriando"
          valor={enfriando}
          sub="5 días o más sin contacto"
          icon={Flame}
          color="text-amber-400"
        />
        <Stat label="Ganados" valor={contar('ganado')} icon={UserPlus} color="text-emerald-400" />
        <Stat label="Perdidos" valor={contar('perdido')} color="text-red-400" />
      </div>

      {/* El embudo como botones de filtro: cada etapa dice cuántos tiene, así se
          ve dónde se traba el proceso sin abrir ningún reporte. */}
      <div className="flex flex-wrap gap-1.5">
        {[
          { clave: 'abiertos', label: 'En curso', n: abiertos.length },
          { clave: 'enfriando', label: 'Enfriándose', n: enfriando },
          ...ESTADOS.map((e) => ({ clave: e.clave, label: e.label, n: contar(e.clave) })),
          { clave: 'todos', label: 'Todos', n: prospectos.length },
        ].map((f) => (
          <button
            key={f.clave}
            type="button"
            onClick={() => setFiltroEstado(f.clave)}
            className={`rounded-lg border px-3 py-1.5 text-[13px] transition ${
              filtroEstado === f.clave
                ? 'border-sky-500/50 bg-sky-500/10 text-sky-300'
                : 'border-slate-800 text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
            }`}
          >
            {f.label} <span className="text-slate-500">{f.n}</span>
          </button>
        ))}
      </div>

      <Card>
        <div className="relative mb-3">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <Input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por nombre, teléfono, cédula o sector"
            className="pl-9"
          />
        </div>

        {cargando ? (
          <SkeletonTabla filas={6} columnas={6} />
        ) : (
          <Table
            columnas={['Prospecto', 'Plan que pidió', 'Origen', 'Cobertura', 'Etapa', 'Sin contacto', '']}
            filas={visibles}
            vacio={
              prospectos.length
                ? 'Ningún prospecto coincide con el filtro.'
                : 'Todavía no hay prospectos cargados.'
            }
            renderFila={(p) => (
              <tr
                key={p.id}
                className="cursor-pointer hover:bg-slate-800/40"
                onClick={() => setAbierto(p)}
              >
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-100">{p.nombre}</div>
                  <div className="text-[11px] text-slate-500">
                    {p.telefono || 'sin teléfono'}
                    {p.sector ? ` · ${p.sector}` : ''}
                  </div>
                </td>
                <td className="px-3 py-2 text-slate-300">
                  {p.plan ? (
                    <>
                      <div className="text-[13px]">{p.plan}</div>
                      <div className="text-[11px] text-slate-500">{dinero(p.plan_precio)}</div>
                    </>
                  ) : (
                    <span className="text-slate-600">sin definir</span>
                  )}
                </td>
                <td className="px-3 py-2 text-[12px] text-slate-400">{ORIGENES[p.origen]}</td>
                <td className="px-3 py-2">
                  <Badge color={COBERTURAS[p.cobertura]?.color ?? 'gris'}>
                    {COBERTURAS[p.cobertura]?.label ?? p.cobertura}
                  </Badge>
                </td>
                <td className="px-3 py-2">
                  <Badge color={etiquetaEstado(p.estado).color}>{etiquetaEstado(p.estado).label}</Badge>
                </td>
                <td className="px-3 py-2">
                  {ESTADOS_ABIERTOS.includes(p.estado) ? (
                    <span
                      className={`text-[13px] ${
                        seEstaEnfriando(p) ? 'font-medium text-amber-400' : 'text-slate-400'
                      }`}
                    >
                      {p.dias_sin_contacto} d
                    </span>
                  ) : (
                    <span className="text-slate-600">—</span>
                  )}
                </td>
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <div className="flex justify-end gap-1">
                    <ConPermiso permiso="ventas.prospectos" envezDe={null}>
                      <Button
                        variante="fantasma"
                        icon={Phone}
                        title="Abrir la ficha y registrar el contacto"
                        onClick={() => setAbierto(p)}
                      />
                      <Button variante="fantasma" icon={Trash2} onClick={() => eliminar(p)} />
                    </ConPermiso>
                  </div>
                </td>
              </tr>
            )}
          />
        )}
      </Card>

      {/* La ficha del prospecto */}
      <Modal
        abierto={!!abierto}
        titulo={abierto?.nombre ?? ''}
        onCerrar={() => setAbierto(null)}
        ancho="max-w-3xl"
      >
        {abierto && (
          <FichaProspecto
            prospecto={abierto}
            planes={planes}
            perfil={perfil}
            puedeEditar={puedeEditar}
            puedeCotizar={puede('ventas.cotizaciones')}
            onEditar={() => {
              setEditando({ ...abierto })
              setAbierto(null)
            }}
            onMover={mover}
            onError={setError}
            onCambio={recargar}
          />
        )}
      </Modal>

      {/* Alta y edición */}
      <Modal
        abierto={!!editando}
        titulo={editando?.id ? `Editar a ${editando.nombre}` : 'Nuevo prospecto'}
        onCerrar={() => setEditando(null)}
        ancho="max-w-3xl"
      >
        {editando && (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Nombre y apellido">
                <Input
                  value={editando.nombre}
                  onChange={(e) => setEditando({ ...editando, nombre: e.target.value })}
                  autoFocus
                />
              </Field>
              <Field label="Cédula o RUC" hint="Se puede completar después, al cerrar la venta.">
                <Input
                  value={editando.identificacion ?? ''}
                  onChange={(e) => setEditando({ ...editando, identificacion: e.target.value })}
                />
              </Field>
              <Field label="Teléfono">
                <Input
                  value={editando.telefono ?? ''}
                  onChange={(e) => setEditando({ ...editando, telefono: e.target.value })}
                />
              </Field>
              <Field label="WhatsApp">
                <Input
                  value={editando.telefono_whatsapp ?? ''}
                  onChange={(e) => setEditando({ ...editando, telefono_whatsapp: e.target.value })}
                />
              </Field>
              <Field label="Correo">
                <Input
                  type="email"
                  value={editando.email ?? ''}
                  onChange={(e) => setEditando({ ...editando, email: e.target.value })}
                />
              </Field>
              <Field label="Sector o barrio">
                <Input
                  value={editando.sector ?? ''}
                  onChange={(e) => setEditando({ ...editando, sector: e.target.value })}
                />
              </Field>
              <Field label="Dirección" className="md:col-span-2">
                <Input
                  value={editando.direccion ?? ''}
                  onChange={(e) => setEditando({ ...editando, direccion: e.target.value })}
                />
              </Field>
              <Field
                label="Referencia"
                hint="Cómo llegar. En un barrio sin nomenclatura es lo único que sirve."
                className="md:col-span-2"
              >
                <Input
                  value={editando.referencia ?? ''}
                  onChange={(e) => setEditando({ ...editando, referencia: e.target.value })}
                />
              </Field>
              {/* Sin coordenadas el prospecto no aparece en el mapa comercial,
                  que es donde se ve si está cerca de una caja con lugar. La
                  forma cómoda de cargarlas es verificar la cobertura y crear el
                  prospecto desde ahí: el punto ya queda marcado. */}
              <Field label="Latitud" hint="Se cargan solas si creás el prospecto desde Verificar cobertura.">
                <Input
                  value={editando.latitud ?? ''}
                  onChange={(e) => setEditando({ ...editando, latitud: e.target.value })}
                  placeholder="-0.9376"
                />
              </Field>
              <Field label="Longitud">
                <Input
                  value={editando.longitud ?? ''}
                  onChange={(e) => setEditando({ ...editando, longitud: e.target.value })}
                  placeholder="-79.2270"
                />
              </Field>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {/* El plan sale del catálogo: el vendedor elige de lo que se
                  vende, con el precio vigente. No es un texto libre. */}
              <Field label="Plan que pidió" hint="Precio con IVA: lo que el abonado va a pagar.">
                <Select
                  value={editando.plan_id ?? ''}
                  onChange={(e) => setEditando({ ...editando, plan_id: e.target.value })}
                >
                  <option value="">— todavía no lo definió —</option>
                  {planes.map((pl) => (
                    <option key={pl.id} value={pl.id}>
                      {pl.nombre} — {dinero(pl.precio)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Cómo llegó">
                <Select
                  value={editando.origen}
                  onChange={(e) => setEditando({ ...editando, origen: e.target.value })}
                >
                  {Object.entries(ORIGENES).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Cobertura" hint="Consultala en el mapa de cobertura antes de prometer.">
                <Select
                  value={editando.cobertura}
                  onChange={(e) => setEditando({ ...editando, cobertura: e.target.value })}
                >
                  {Object.entries(COBERTURAS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Volver a contactar el">
                <Input
                  type="date"
                  value={editando.proxima_accion ?? ''}
                  onChange={(e) => setEditando({ ...editando, proxima_accion: e.target.value })}
                />
              </Field>
            </div>

            <Field label="Notas">
              <Textarea
                rows={3}
                value={editando.notas ?? ''}
                onChange={(e) => setEditando({ ...editando, notas: e.target.value })}
              />
            </Field>

            <div className="flex justify-end gap-2 border-t border-slate-800 pt-3">
              <Button variante="fantasma" onClick={() => setEditando(null)}>
                Cancelar
              </Button>
              <Button
                onClick={guardar}
                cargando={guardando}
                disabled={guardando || !editando.nombre.trim()}
              >
                {editando.id ? 'Guardar' : 'Cargar prospecto'}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Dar por perdido: el motivo es obligatorio, y por algo */}
      <Modal
        abierto={!!perdiendo}
        titulo={`Dar por perdido a ${perdiendo?.p?.nombre ?? ''}`}
        onCerrar={() => setPerdiendo(null)}
      >
        {perdiendo && (
          <div className="space-y-3">
            <Aviso>
              El motivo es obligatorio. Un prospecto perdido sin motivo no enseña nada: dentro de dos
              meses nadie va a poder decir por qué se caen las ventas.
            </Aviso>
            <Field label="¿Por qué se perdió?">
              <Textarea
                rows={3}
                autoFocus
                value={perdiendo.motivo}
                onChange={(e) => setPerdiendo({ ...perdiendo, motivo: e.target.value })}
                placeholder="Precio, se fue con la competencia, no hay cobertura, se mudó…"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variante="fantasma" onClick={() => setPerdiendo(null)}>
                Cancelar
              </Button>
              <Button
                variante="peligro"
                disabled={!perdiendo.motivo.trim()}
                onClick={async () => {
                  try {
                    await ventasApi.cambiarEstado(perdiendo.p, 'perdido', perdiendo.motivo.trim())
                    setPerdiendo(null)
                    setAbierto(null)
                    await recargar()
                  } catch (err) {
                    setError(err)
                  }
                }}
              >
                Dar por perdido
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
 * La ficha: el historial de contactos y las cotizaciones de un prospecto.
 *
 * Es el corazón del módulo. La lista dice quiénes hay; esto dice qué pasó con
 * este, que es lo que el vendedor necesita leer en los diez segundos antes de
 * apretar "llamar".
 */
function FichaProspecto({
  prospecto,
  planes,
  perfil,
  puedeEditar,
  puedeCotizar,
  onEditar,
  onMover,
  onError,
  onCambio,
}) {
  const [actividades, setActividades] = useState([])
  const [cotizaciones, setCotizaciones] = useState([])
  const [nueva, setNueva] = useState({ tipo: 'llamada', resultado: 'contactado', detalle: '' })
  const [cotizando, setCotizando] = useState(null)
  const [trabajando, setTrabajando] = useState(false)
  const [expediente, setExpediente] = useState(null)

  const recargar = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([
        ventasApi.actividades(prospecto.id),
        ventasApi.cotizaciones(prospecto.id),
      ])
      setActividades(a)
      setCotizaciones(c)

      // El expediente solo existe si la venta se ganó. Se pide siempre igual —
      // devuelve null si no hay— para no tener dos caminos de carga distintos
      // según el estado.
      setExpediente(await expedientesApi.porProspecto(prospecto.id))
    } catch (err) {
      onError(err)
    }
  }, [prospecto.id, onError])

  // El historial son los cerrados; los seguimientos, los que siguen abiertos.
  // Es la misma tabla partida por estado, no dos consultas.
  const pendientes = actividades.filter((a) => a.estado === 'pendiente' && a.programado_para)
  const historial = actividades.filter((a) => a.estado !== 'pendiente')

  useEffect(() => {
    recargar()
  }, [recargar])

  const registrar = async () => {
    if (!nueva.detalle.trim() && nueva.tipo === 'nota') return
    setTrabajando(true)
    try {
      const { programado_para, proxima_accion, ...contacto } = nueva

      // Lo que pasó se guarda siempre; lo que sigue, solo si se agendó. Son dos
      // filas y no una porque un contacto ya ocurrido no puede quedar
      // "pendiente" esperando su propia fecha.
      await ventasApi.registrarActividad(
        prospecto.id,
        { ...contacto, estado: 'completado' },
        perfil,
      )
      if (programado_para) {
        await ventasApi.agendar(
          prospecto.id,
          {
            tipo: contacto.tipo,
            proxima_accion: proxima_accion || null,
            programado_para: new Date(programado_para).toISOString(),
          },
          perfil,
        )
      }

      setNueva({ tipo: 'llamada', resultado: 'contactado', detalle: '' })
      await recargar()
      await onCambio()
    } catch (err) {
      onError(err)
    } finally {
      setTrabajando(false)
    }
  }

  const plan = planes.find((p) => p.id === prospecto.plan_id)

  return (
    <div className="space-y-4">
      <div className="grid gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-3 text-[13px] md:grid-cols-2">
        <Dato etiqueta="Teléfono" valor={prospecto.telefono} />
        <Dato etiqueta="WhatsApp" valor={prospecto.telefono_whatsapp} />
        <Dato etiqueta="Dirección" valor={prospecto.direccion} />
        <Dato etiqueta="Referencia" valor={prospecto.referencia} />
        <Dato etiqueta="Plan que pidió" valor={prospecto.plan} />
        <Dato etiqueta="Origen" valor={ORIGENES[prospecto.origen]} />
        <Dato etiqueta="Cobertura" valor={COBERTURAS[prospecto.cobertura]?.label} />
        <Dato etiqueta="Volver a contactar" valor={fecha(prospecto.proxima_accion)} />
        {prospecto.notas && <Dato etiqueta="Notas" valor={prospecto.notas} ancho />}
        {prospecto.motivo_perdida && (
          <Dato etiqueta="Motivo de la pérdida" valor={prospecto.motivo_perdida} ancho />
        )}
      </div>

      {/* Ganado no es el final: es el comienzo del expediente. El acceso va
          arriba de todo porque, una vez ganada la venta, completar la
          documentación es lo único que queda por hacer con este prospecto. */}
      {prospecto.estado === 'ganado' && expediente && (
        <Link
          to={`/ventas/expediente/${expediente.id}`}
          className={`flex items-center justify-between gap-3 rounded-xl border p-3 transition ${
            expediente.completo
              ? 'border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10'
              : 'border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10'
          }`}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[13px] font-medium text-slate-100">
              <FileSignature size={15} />
              {expediente.estado === 'enviado'
                ? 'Expediente enviado a instalaciones'
                : expediente.completo
                  ? 'Expediente completo — falta enviarlo'
                  : 'Completar el expediente'}
            </div>
            {expediente.estado !== 'enviado' && (
              <p className="truncate text-[11px] text-slate-500">
                Falta: {loQueFalta(expediente).join(', ') || 'nada'}
              </p>
            )}
          </div>
          <ArrowRight size={16} className="shrink-0 text-slate-400" />
        </Link>
      )}

      {puedeEditar && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-slate-500">Mover a:</span>
          {ESTADOS.filter((e) => e.clave !== prospecto.estado).map((e) => (
            <button
              key={e.clave}
              type="button"
              title={e.ayuda}
              onClick={() => onMover(prospecto, e.clave)}
              className="rounded-lg border border-slate-800 px-2.5 py-1 text-[12px] text-slate-300 transition hover:border-sky-500/50 hover:text-sky-300"
            >
              {e.label}
            </button>
          ))}
          <Button variante="fantasma" onClick={onEditar} className="ml-auto">
            Editar datos
          </Button>
        </div>
      )}

      {/* Registrar lo que pasó, y agendar lo que sigue.
          Van juntos porque es un solo momento: se cuelga el teléfono, se anota
          qué dijo y cuándo hay que volver a llamarlo. Separarlos en dos
          pantallas es cómo se pierden los seguimientos. */}
      {puedeEditar && (
        <Card title="Registrar contacto y agendar el siguiente" icon={Phone}>
          <div className="grid gap-2 md:grid-cols-2">
            <Select value={nueva.tipo} onChange={(e) => setNueva({ ...nueva, tipo: e.target.value })}>
              {Object.entries(TIPOS_ACTIVIDAD).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <Select
              value={nueva.resultado ?? ''}
              onChange={(e) => setNueva({ ...nueva, resultado: e.target.value || null })}
            >
              <option value="">— sin resultado —</option>
              {Object.entries(RESULTADOS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </div>
          <Input
            className="mt-2"
            value={nueva.detalle}
            onChange={(e) => setNueva({ ...nueva, detalle: e.target.value })}
            placeholder="Qué se habló (opcional)"
          />

          <div className="mt-3 space-y-2 border-t border-slate-800 pt-3">
            <p className="text-[12px] text-slate-400">Próxima acción (opcional)</p>
            <div className="grid gap-2 md:grid-cols-2">
              <Input
                type="datetime-local"
                value={nueva.programado_para ?? ''}
                onChange={(e) => setNueva({ ...nueva, programado_para: e.target.value })}
              />
              <Input
                value={nueva.proxima_accion ?? ''}
                onChange={(e) => setNueva({ ...nueva, proxima_accion: e.target.value })}
                placeholder="Qué hay que hacer: llamar, pasar la cotización…"
              />
            </div>
          </div>

          <Button onClick={registrar} cargando={trabajando} disabled={trabajando} className="mt-3">
            Guardar
          </Button>
        </Card>
      )}

      {/* Los seguimientos abiertos */}
      {pendientes.length > 0 && (
        <Card title="Seguimientos abiertos" icon={CalendarClock}>
          <div className="space-y-1.5">
            {pendientes.map((s) => {
              const vencido = new Date(s.programado_para) < new Date()
              return (
                <div
                  key={s.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 p-2 text-[13px]"
                >
                  <span
                    className={`flex items-center gap-1.5 text-[11px] font-medium ${
                      vencido ? 'text-red-400' : 'text-amber-400'
                    }`}
                  >
                    {vencido ? <AlertTriangle size={13} /> : <Clock size={13} />}
                    {vencido ? 'Vencido' : 'Pendiente'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="text-slate-200">
                      {s.proxima_accion || TIPOS_ACTIVIDAD[s.tipo]}
                    </span>
                    <div className="text-[11px] text-slate-500">
                      {new Date(s.programado_para).toLocaleString('es-EC')}
                    </div>
                  </div>
                  <Button
                    variante="fantasma"
                    onClick={async () => {
                      await ventasApi.cerrarSeguimiento(s.id, 'completado')
                      await recargar()
                      await onCambio()
                    }}
                  >
                    Cumplido
                  </Button>
                  <Button
                    variante="fantasma"
                    onClick={async () => {
                      await ventasApi.cerrarSeguimiento(s.id, 'cancelado')
                      await recargar()
                    }}
                  >
                    Cancelar
                  </Button>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      <Card title="Historial" icon={CalendarClock} subtitle={`${historial.length} contactos`}>
        {historial.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500">
            Todavía no se registró ningún contacto.
          </p>
        ) : (
          <div className="max-h-56 space-y-1.5 overflow-y-auto">
            {historial.map((a) => (
              <div key={a.id} className="rounded-lg border border-slate-800 bg-slate-900/40 p-2">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="text-slate-200">{TIPOS_ACTIVIDAD[a.tipo]}</span>
                  {a.resultado && <Badge color="gris">{RESULTADOS[a.resultado]}</Badge>}
                </div>
                {a.detalle && <p className="mt-0.5 text-[12px] text-slate-400">{a.detalle}</p>}
                <div className="mt-0.5 text-[11px] text-slate-500">
                  {new Date(a.creado_en).toLocaleString('es-EC')}
                  {a.usuario_nombre ? ` · ${a.usuario_nombre}` : ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Cotizaciones"
        icon={FileText}
        actions={
          puedeCotizar && (
            <Button
              icon={Plus}
              onClick={() =>
                setCotizando({
                  plan_id: prospecto.plan_id ?? '',
                  precio_mensual: plan?.precio ?? 0,
                  costo_instalacion: 0,
                  costo_equipo: 0,
                  descuento: 0,
                  meses_contrato: '',
                  validez_dias: 15,
                  notas: '',
                })
              }
            >
              Cotizar
            </Button>
          )
        }
      >
        {cotizaciones.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500">Sin cotizaciones.</p>
        ) : (
          <div className="space-y-1.5">
            {cotizaciones.map((c) => (
              <div
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/40 p-2 text-[13px]"
              >
                <div>
                  <span className="text-slate-200">
                    N° {String(c.numero).padStart(5, '0')} · {c.plan_nombre ?? 'sin plan'}
                  </span>
                  <div className="text-[11px] text-slate-500">
                    {dinero(c.precio_mensual)}/mes
                    {Number(c.costo_instalacion) > 0
                      ? ` · instalación ${dinero(c.costo_instalacion)}`
                      : ''}
                    {Number(c.descuento) > 0 ? ` · descuento ${dinero(c.descuento)}` : ''}
                    {` · ${new Date(c.creado_en).toLocaleDateString('es-EC')}`}
                  </div>
                </div>
                <Badge color="gris">{c.estado}</Badge>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal
        abierto={!!cotizando}
        titulo={`Cotizar para ${prospecto.nombre}`}
        onCerrar={() => setCotizando(null)}
      >
        {cotizando && (
          <div className="space-y-3">
            <Field label="Plan" hint="El precio se copia al cotizar: si mañana sube, esta no cambia.">
              <Select
                value={cotizando.plan_id}
                onChange={(e) => {
                  const pl = planes.find((x) => x.id === e.target.value)
                  setCotizando({
                    ...cotizando,
                    plan_id: e.target.value,
                    precio_mensual: pl?.precio ?? 0,
                  })
                }}
              >
                <option value="">— elegí el plan —</option>
                {planes.map((pl) => (
                  <option key={pl.id} value={pl.id}>
                    {pl.nombre} — {dinero(pl.precio)}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Precio mensual">
                <Input
                  type="number"
                  step="0.01"
                  value={cotizando.precio_mensual}
                  onChange={(e) => setCotizando({ ...cotizando, precio_mensual: e.target.value })}
                />
              </Field>
              <Field label="Costo de instalación">
                <Input
                  type="number"
                  step="0.01"
                  value={cotizando.costo_instalacion}
                  onChange={(e) => setCotizando({ ...cotizando, costo_instalacion: e.target.value })}
                />
              </Field>
              <Field label="Equipo">
                <Input
                  type="number"
                  step="0.01"
                  value={cotizando.costo_equipo}
                  onChange={(e) => setCotizando({ ...cotizando, costo_equipo: e.target.value })}
                />
              </Field>
              <Field label="Descuento">
                <Input
                  type="number"
                  step="0.01"
                  value={cotizando.descuento}
                  onChange={(e) => setCotizando({ ...cotizando, descuento: e.target.value })}
                />
              </Field>
              <Field label="Meses de contrato">
                <Input
                  type="number"
                  value={cotizando.meses_contrato}
                  onChange={(e) => setCotizando({ ...cotizando, meses_contrato: e.target.value })}
                />
              </Field>
              <Field label="Validez (días)">
                <Input
                  type="number"
                  value={cotizando.validez_dias}
                  onChange={(e) => setCotizando({ ...cotizando, validez_dias: e.target.value })}
                />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button variante="fantasma" onClick={() => setCotizando(null)}>
                Cancelar
              </Button>
              <Button
                disabled={!cotizando.plan_id}
                onClick={async () => {
                  try {
                    const pl = planes.find((x) => x.id === cotizando.plan_id)
                    await ventasApi.cotizar(
                      prospecto.id,
                      {
                        ...cotizando,
                        plan_nombre: pl?.nombre ?? null,
                        meses_contrato: cotizando.meses_contrato || null,
                        estado: 'enviada',
                      },
                      perfil,
                    )
                    setCotizando(null)
                    await recargar()
                    await onCambio()
                  } catch (err) {
                    onError(err)
                  }
                }}
              >
                Guardar cotización
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

const Dato = ({ etiqueta, valor, ancho }) =>
  valor ? (
    <div className={ancho ? 'md:col-span-2' : ''}>
      <span className="text-slate-500">{etiqueta}: </span>
      <span className="text-slate-200">{valor}</span>
    </div>
  ) : null
