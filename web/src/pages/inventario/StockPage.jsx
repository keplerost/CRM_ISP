import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeftRight,
  Boxes,
  Package,
  PackagePlus,
  Pencil,
  Plus,
  Search,
  Sliders,
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
  Tabs,
  Textarea,
} from '../../components/ui'
import ConPermiso from '../../components/layout/ConPermiso'
import StockBajo from '../../components/inventario/StockBajo'
import { usePermisos } from '../../lib/AuthContext'
import { dineroCero as dinero } from '../../lib/formato'
import {
  CATEGORIAS,
  ESTADOS_EQUIPO,
  TIPOS_MOVIMIENTO,
  UNIDADES,
  inventarioApi,
} from '../../lib/inventario'

/**
 * Stock — qué hay y dónde.
 *
 * ── Dos vistas del mismo material, porque son dos preguntas ──
 *
 * "Por artículo" contesta *cuánto tengo en total* — la que se hace al comprar.
 * "Por almacén" contesta *dónde está* — la que se hace al mandar a un técnico a
 * un trabajo. El mismo número sumado de dos formas distintas; mostrarlo de una
 * sola obliga a hacer la otra cuenta de cabeza.
 *
 * Los equipos con serie tienen su propia pestaña porque la pregunta ahí es una
 * tercera: *dónde está el aparato con esta serie*, que ninguna cantidad
 * responde.
 */

const ARTICULO_VACIO = {
  codigo: '',
  nombre: '',
  categoria: 'material',
  unidad: 'u',
  por_serie: false,
  stock_minimo: '',
  activo: true,
  notas: '',
}

export default function StockPage() {
  const { puede, perfil } = usePermisos()

  const [articulos, setArticulos] = useState([])
  const [almacenes, setAlmacenes] = useState([])
  const [existencias, setExistencias] = useState([])
  const [equipos, setEquipos] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const [tab, setTab] = useState('articulos')
  const [busqueda, setBusqueda] = useState('')
  const [filtroAlmacen, setFiltroAlmacen] = useState('')

  const [editando, setEditando] = useState(null)
  const [moviendo, setMoviendo] = useState(null)
  const [dandoAlta, setDandoAlta] = useState(null)

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      const [cat, ex, eq] = await Promise.all([
        inventarioApi.catalogo(),
        inventarioApi.existencias(),
        inventarioApi.equipos(),
      ])
      setArticulos(cat.articulos)
      setAlmacenes(cat.almacenes)
      setExistencias(ex)
      setEquipos(eq)
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

  const coincide = (texto) =>
    !busqueda.trim() || String(texto ?? '').toLowerCase().includes(busqueda.trim().toLowerCase())

  const articulosVisibles = useMemo(
    () => articulos.filter((a) => coincide(a.nombre) || coincide(a.codigo)),
    [articulos, busqueda],
  )
  const existenciasVisibles = useMemo(
    () =>
      existencias.filter(
        (e) => (!filtroAlmacen || e.almacen_id === filtroAlmacen) && coincide(e.articulo),
      ),
    [existencias, filtroAlmacen, busqueda],
  )
  const equiposVisibles = useMemo(
    () =>
      equipos.filter(
        (q) =>
          (!filtroAlmacen || q.almacen_id === filtroAlmacen) &&
          (coincide(q.serie) || coincide(q.articulo) || coincide(q.cliente)),
      ),
    [equipos, filtroAlmacen, busqueda],
  )

  const bajoMinimo = articulos.filter((a) => a.bajo_minimo)

  const guardarArticulo = async () => {
    try {
      await inventarioApi.guardarArticulo(editando)
      setEditando(null)
      await recargar()
    } catch (err) {
      setError(err)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100">
            <Boxes size={20} className="text-sky-400" />
            Inventario
          </h1>
          <p className="text-sm text-slate-400">
            Qué hay, dónde está y quién lo tiene.
          </p>
        </div>
        <div className="flex gap-2">
          <ConPermiso permiso="inventario.ingresos" envezDe={null}>
            <Button icon={PackagePlus} onClick={() => setDandoAlta({ articuloId: '', almacenId: almacenes[0]?.id ?? '', series: '' })}>
              Alta de equipos
            </Button>
          </ConPermiso>
          <ConPermiso permiso="inventario.ver" envezDe={null}>
            <Button variante="primario" icon={Plus} onClick={() => setEditando({ ...ARTICULO_VACIO })}>
              Nuevo artículo
            </Button>
          </ConPermiso>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Artículos" valor={articulos.length} icon={Package} />
        <Stat label="Almacenes" valor={almacenes.length} icon={Boxes} />
        <Stat
          label="Equipos en stock"
          valor={equipos.filter((q) => q.estado === 'en_stock').length}
          color="text-emerald-400"
        />
        <Stat
          label="Bajo mínimo"
          valor={bajoMinimo.length}
          icon={AlertTriangle}
          color={bajoMinimo.length ? 'text-amber-400' : 'text-slate-400'}
        />
      </div>

      {bajoMinimo.length > 0 && (
        <Aviso tipo="alerta">
          <b>{bajoMinimo.length}</b> {bajoMinimo.length === 1 ? 'artículo llegó' : 'artículos llegaron'} a su
          mínimo: {bajoMinimo.slice(0, 5).map((a) => a.nombre).join(', ')}
          {bajoMinimo.length > 5 ? ` y ${bajoMinimo.length - 5} más` : ''}.
        </Aviso>
      )}

      <Tabs
        activa={tab}
        onCambiar={setTab}
        tabs={[
          { clave: 'articulos', label: 'Por artículo', icon: Package, contador: articulos.length },
          { clave: 'almacenes', label: 'Por almacén', icon: Boxes, contador: existencias.length },
          { clave: 'equipos', label: 'Equipos con serie', icon: Sliders, contador: equipos.length },
          // La cuarta pregunta, y la única que se hace antes de que haga falta:
          // qué falta pedir. Las otras tres se hacen cuando ya se necesita algo.
          { clave: 'bajo', label: 'Por acabarse', icon: AlertTriangle },
        ]}
      />

      {tab === 'bajo' && <StockBajo almacenes={almacenes} articulos={articulos} />}

      {tab !== 'bajo' && (
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <div className="relative flex-1 min-w-[220px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <Input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por nombre, código, serie o cliente"
              className="pl-9"
            />
          </div>
          {tab !== 'articulos' && (
            <Select
              value={filtroAlmacen}
              onChange={(e) => setFiltroAlmacen(e.target.value)}
              className="w-56"
            >
              <option value="">Todos los almacenes</option>
              {almacenes.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nombre}
                </option>
              ))}
            </Select>
          )}
        </div>

        {cargando ? (
          <SkeletonTabla filas={6} columnas={6} />
        ) : tab === 'articulos' ? (
          <Table
            columnas={['Artículo', 'Categoría', 'Stock total', 'Mínimo', 'Último costo', '']}
            filas={articulosVisibles}
            vacio="Todavía no hay artículos cargados."
            renderFila={(a) => (
              <tr key={a.id} className="hover:bg-slate-800/40">
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-100">{a.nombre}</div>
                  <div className="text-[11px] text-slate-500">
                    {a.codigo ? `${a.codigo} · ` : ''}
                    {a.por_serie ? 'por serie' : `por cantidad (${a.unidad})`}
                    {a.ont_modelo ? ` · ${a.ont_marca} ${a.ont_modelo}` : ''}
                  </div>
                </td>
                <td className="px-3 py-2 text-[12px] text-slate-400">{CATEGORIAS[a.categoria]}</td>
                <td className="px-3 py-2">
                  <span
                    className={`tabular-nums ${a.bajo_minimo ? 'font-medium text-amber-400' : 'text-slate-200'}`}
                  >
                    {Number(a.stock_total).toLocaleString('es-EC')} {a.unidad}
                  </span>
                  {a.por_serie && (
                    <div className="text-[11px] text-slate-500">{a.equipos_libres} libres</div>
                  )}
                </td>
                <td className="px-3 py-2 tabular-nums text-[12px] text-slate-500">
                  {a.stock_minimo ?? '—'}
                </td>
                <td className="px-3 py-2 tabular-nums text-[12px] text-slate-400">
                  {a.costo_ultimo ? dinero(a.costo_ultimo) : '—'}
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <ConPermiso
                      permiso={['inventario.ingresos', 'inventario.salidas', 'inventario.transferir']}
                      envezDe={null}
                    >
                      <Button
                        variante="fantasma"
                        icon={ArrowLeftRight}
                        title="Mover este artículo"
                        onClick={() =>
                          setMoviendo({
                            tipo: 'ingreso',
                            articuloId: a.id,
                            articulo: a,
                            cantidad: '',
                            origen: '',
                            destino: almacenes[0]?.id ?? '',
                            equipoIds: [],
                            motivo: '',
                          })
                        }
                      />
                    </ConPermiso>
                    <Button variante="fantasma" icon={Pencil} onClick={() => setEditando(a)} />
                  </div>
                </td>
              </tr>
            )}
          />
        ) : tab === 'almacenes' ? (
          <Table
            columnas={['Almacén', 'Artículo', 'Cantidad', 'Mínimo']}
            filas={existenciasVisibles}
            vacio="Sin existencias registradas."
            renderFila={(e) => (
              <tr key={`${e.articulo_id}-${e.almacen_id}`} className="hover:bg-slate-800/40">
                <td className="px-3 py-2">
                  <span className="text-slate-200">{e.almacen}</span>
                  {e.almacen_tipo === 'tecnico' && (
                    <Badge color="azul">
                      <span className="ml-0">técnico</span>
                    </Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-300">{e.articulo}</td>
                <td className="px-3 py-2">
                  <span
                    className={`tabular-nums ${e.bajo_minimo ? 'font-medium text-amber-400' : 'text-slate-200'}`}
                  >
                    {Number(e.cantidad).toLocaleString('es-EC')} {e.unidad}
                  </span>
                </td>
                <td className="px-3 py-2 tabular-nums text-[12px] text-slate-500">
                  {e.stock_minimo ?? '—'}
                </td>
              </tr>
            )}
          />
        ) : (
          <Table
            columnas={['Serie', 'Artículo', 'Estado', 'Dónde está', 'Cliente']}
            filas={equiposVisibles}
            vacio="Sin equipos con serie cargados."
            renderFila={(q) => (
              <tr key={q.id} className="hover:bg-slate-800/40">
                <td className="px-3 py-2 font-mono text-[12px] text-slate-100">
                  {q.serie}
                  {q.mac && <div className="text-[11px] text-slate-500">{q.mac}</div>}
                </td>
                <td className="px-3 py-2 text-slate-300">{q.articulo}</td>
                <td className="px-3 py-2">
                  <Badge color={ESTADOS_EQUIPO[q.estado]?.color ?? 'gris'}>
                    {ESTADOS_EQUIPO[q.estado]?.label ?? q.estado}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-[12px] text-slate-400">
                  {q.almacen ?? (q.estado === 'instalado' ? 'en casa del cliente' : '—')}
                </td>
                <td className="px-3 py-2 text-[12px] text-slate-400">{q.cliente ?? '—'}</td>
              </tr>
            )}
          />
        )}
      </Card>
      )}

      {/* Ficha del artículo */}
      <Modal
        abierto={!!editando}
        titulo={editando?.id ? `Editar ${editando.nombre}` : 'Nuevo artículo'}
        onCerrar={() => setEditando(null)}
      >
        {editando && (
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Nombre">
                <Input
                  value={editando.nombre}
                  onChange={(e) => setEditando({ ...editando, nombre: e.target.value })}
                  autoFocus
                />
              </Field>
              <Field label="Código" hint="Interno o del proveedor. Opcional.">
                <Input
                  value={editando.codigo ?? ''}
                  onChange={(e) => setEditando({ ...editando, codigo: e.target.value })}
                />
              </Field>
              <Field label="Categoría">
                <Select
                  value={editando.categoria}
                  onChange={(e) => setEditando({ ...editando, categoria: e.target.value })}
                >
                  {Object.entries(CATEGORIAS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Unidad">
                <Select
                  value={editando.unidad}
                  onChange={(e) => setEditando({ ...editando, unidad: e.target.value })}
                  disabled={editando.por_serie}
                >
                  {UNIDADES.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Stock mínimo"
                hint="Cuándo avisar que hay que reponer. Vacío = no se controla."
              >
                <Input
                  type="number"
                  value={editando.stock_minimo ?? ''}
                  onChange={(e) => setEditando({ ...editando, stock_minimo: e.target.value })}
                />
              </Field>
            </div>

            {/* Cambiar esto después de cargar stock dejaría cantidades sin
                equipos o equipos sin cantidad: se fija al crear y no se toca. */}
            <label
              className={`flex items-start gap-2 rounded-lg border border-slate-800 p-2.5 text-[13px] ${
                editando.id ? 'opacity-50' : 'cursor-pointer hover:bg-slate-800/40'
              }`}
            >
              <input
                type="checkbox"
                checked={editando.por_serie}
                disabled={!!editando.id}
                onChange={(e) =>
                  setEditando({ ...editando, por_serie: e.target.checked, unidad: 'u' })
                }
                className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-slate-900 text-sky-500 focus:ring-sky-500"
              />
              <span>
                <span className="text-slate-200">Se rastrea por número de serie</span>
                <span className="block text-[11px] leading-tight text-slate-500">
                  Para ONT y routers: cada unidad se sigue una por una y se vincula al cliente.
                  {editando.id && ' No se puede cambiar después de crear el artículo.'}
                </span>
              </span>
            </label>

            <Field label="Notas">
              <Textarea
                rows={2}
                value={editando.notas ?? ''}
                onChange={(e) => setEditando({ ...editando, notas: e.target.value })}
              />
            </Field>

            <div className="flex justify-end gap-2 border-t border-slate-800 pt-3">
              <Button variante="fantasma" onClick={() => setEditando(null)}>
                Cancelar
              </Button>
              <Button onClick={guardarArticulo} disabled={!editando.nombre?.trim()}>
                Guardar
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Mover material */}
      <MovimientoModal
        estado={moviendo}
        setEstado={setMoviendo}
        almacenes={almacenes}
        equipos={equipos}
        perfil={perfil}
        onHecho={recargar}
        onError={setError}
      />

      {/* Alta de equipos con serie */}
      <Modal
        abierto={!!dandoAlta}
        titulo="Alta de equipos con serie"
        onCerrar={() => setDandoAlta(null)}
      >
        {dandoAlta && (
          <div className="space-y-3">
            <Aviso>
              Pegá una serie por línea. Se crean los equipos y su ingreso al almacén en una sola
              operación, así el stock queda cuadrado sin sumar nada a mano.
            </Aviso>
            <Field label="Artículo">
              <Select
                value={dandoAlta.articuloId}
                onChange={(e) => setDandoAlta({ ...dandoAlta, articuloId: e.target.value })}
              >
                <option value="">— elegí el artículo —</option>
                {articulos
                  .filter((a) => a.por_serie)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.nombre}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Almacén de destino">
              <Select
                value={dandoAlta.almacenId}
                onChange={(e) => setDandoAlta({ ...dandoAlta, almacenId: e.target.value })}
              >
                {almacenes.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nombre}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Series">
              <Textarea
                rows={6}
                value={dandoAlta.series}
                onChange={(e) => setDandoAlta({ ...dandoAlta, series: e.target.value })}
                placeholder={'48575443A1B2\n48575443A1B3\n48575443A1B4'}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variante="fantasma" onClick={() => setDandoAlta(null)}>
                Cancelar
              </Button>
              <Button
                disabled={!dandoAlta.articuloId || !dandoAlta.series.trim()}
                onClick={async () => {
                  try {
                    await inventarioApi.altaEquipos(
                      {
                        articuloId: dandoAlta.articuloId,
                        almacenId: dandoAlta.almacenId,
                        series: dandoAlta.series.split('\n'),
                      },
                      perfil,
                    )
                    setDandoAlta(null)
                    await recargar()
                  } catch (err) {
                    setError(err)
                  }
                }}
              >
                Dar de alta
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
 * El formulario de movimiento.
 *
 * Uno solo para los seis tipos, porque son la misma operación con distintos
 * extremos: de dónde sale y a dónde entra. Seis formularios distintos harían
 * que "transferir" y "consumir" se vean como cosas ajenas cuando son el mismo
 * renglón en la bitácora.
 */
function MovimientoModal({ estado, setEstado, almacenes, equipos, perfil, onHecho, onError }) {
  const [guardando, setGuardando] = useState(false)
  if (!estado) return null

  const t = estado.tipo
  const porSerie = estado.articulo?.por_serie
  const necesitaOrigen = ['salida', 'consumo', 'transferencia'].includes(t)
  const necesitaDestino = ['ingreso', 'devolucion', 'transferencia', 'ajuste'].includes(t)

  const disponibles = equipos.filter(
    (q) =>
      q.articulo_id === estado.articuloId &&
      (!necesitaOrigen || q.almacen_id === estado.origen) &&
      ['en_stock', 'asignado'].includes(q.estado),
  )

  const listo =
    (!necesitaOrigen || estado.origen) &&
    (!necesitaDestino || estado.destino) &&
    (porSerie ? estado.equipoIds.length > 0 : Number(estado.cantidad) !== 0)

  return (
    <Modal
      abierto
      titulo={`${TIPOS_MOVIMIENTO[t].label} — ${estado.articulo?.nombre ?? ''}`}
      onCerrar={() => setEstado(null)}
    >
      <div className="space-y-3">
        <Field label="Tipo de movimiento" hint={TIPOS_MOVIMIENTO[t].ayuda}>
          <Select
            value={t}
            onChange={(e) =>
              setEstado({ ...estado, tipo: e.target.value, equipoIds: [], origen: '', destino: '' })
            }
          >
            {Object.entries(TIPOS_MOVIMIENTO).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-3 md:grid-cols-2">
          {necesitaOrigen && (
            <Field label="Sale de">
              <Select
                value={estado.origen}
                onChange={(e) => setEstado({ ...estado, origen: e.target.value, equipoIds: [] })}
              >
                <option value="">— elegí —</option>
                {almacenes.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nombre}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {necesitaDestino && (
            <Field label="Entra a">
              <Select
                value={estado.destino}
                onChange={(e) => setEstado({ ...estado, destino: e.target.value })}
              >
                <option value="">— elegí —</option>
                {almacenes.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nombre}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>

        {porSerie ? (
          <Field
            label="Equipos"
            hint={
              disponibles.length
                ? 'Marcá cuáles se mueven. Cada uno deja su propio renglón en la bitácora.'
                : necesitaOrigen && !estado.origen
                  ? 'Elegí primero de qué almacén salen.'
                  : 'No hay equipos disponibles de este artículo en ese almacén.'
            }
          >
            <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-slate-800 p-2">
              {disponibles.map((q) => (
                <label
                  key={q.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[13px] hover:bg-slate-800/50"
                >
                  <input
                    type="checkbox"
                    checked={estado.equipoIds.includes(q.id)}
                    onChange={(e) =>
                      setEstado({
                        ...estado,
                        equipoIds: e.target.checked
                          ? [...estado.equipoIds, q.id]
                          : estado.equipoIds.filter((x) => x !== q.id),
                      })
                    }
                    className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-sky-500 focus:ring-sky-500"
                  />
                  <span className="font-mono text-slate-200">{q.serie}</span>
                  <span className="text-[11px] text-slate-500">{q.almacen}</span>
                </label>
              ))}
              {!disponibles.length && (
                <p className="py-3 text-center text-[12px] text-slate-500">Nada para mover.</p>
              )}
            </div>
          </Field>
        ) : (
          <Field
            label={`Cantidad (${estado.articulo?.unidad ?? 'u'})`}
            hint={t === 'ajuste' ? 'Puede ser negativa: −5 descuenta cinco.' : undefined}
          >
            <Input
              type="number"
              step="0.01"
              value={estado.cantidad}
              onChange={(e) => setEstado({ ...estado, cantidad: e.target.value })}
            />
          </Field>
        )}

        <Field label="Motivo" hint={t === 'ajuste' ? 'Obligatorio: un ajuste sin motivo no se puede auditar.' : 'Opcional'}>
          <Input
            value={estado.motivo}
            onChange={(e) => setEstado({ ...estado, motivo: e.target.value })}
          />
        </Field>

        <div className="flex justify-end gap-2 border-t border-slate-800 pt-3">
          <Button variante="fantasma" onClick={() => setEstado(null)}>
            Cancelar
          </Button>
          <Button
            cargando={guardando}
            disabled={!listo || guardando || (t === 'ajuste' && !estado.motivo.trim())}
            onClick={async () => {
              setGuardando(true)
              try {
                await inventarioApi.mover(estado, perfil)
                setEstado(null)
                await onHecho()
              } catch (err) {
                onError(err)
              } finally {
                setGuardando(false)
              }
            }}
          >
            Registrar {TIPOS_MOVIMIENTO[t].label.toLowerCase()}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
