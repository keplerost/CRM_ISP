import { useCallback, useEffect, useState } from 'react'
import { Check, Plus, ShoppingCart, Trash2, Truck } from 'lucide-react'
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
  Table,
  Tabs,
  Textarea,
} from '../../components/ui'
import ConPermiso from '../../components/layout/ConPermiso'
import { usePermisos } from '../../lib/AuthContext'
import { dineroCero as dinero } from '../../lib/formato'
import { inventarioApi } from '../../lib/inventario'

/**
 * Compras y proveedores.
 *
 * ── Por qué una compra no suma stock al crearla ──
 *
 * Una compra en borrador es una intención: se pidió, todavía no llegó. Si el
 * stock subiera al registrarla, bodega prometería material que está en el camión
 * del proveedor, y esa promesa termina en una instalación agendada sin equipo.
 *
 * El stock entra al apretar **Recibir**, que es cuando alguien tuvo la caja en
 * la mano. Ahí se generan los movimientos —uno por ítem, o uno por equipo si el
 * artículo es por serie— y el ingreso queda en la bitácora con el número de
 * compra, así se puede reconstruir de dónde salió cada cosa.
 */

const COMPRA_VACIA = {
  proveedor_id: '',
  almacen_id: '',
  documento: '',
  fecha: new Date().toISOString().slice(0, 10),
  notas: '',
}

const PROVEEDOR_VACIO = {
  nombre: '',
  identificacion: '',
  telefono: '',
  email: '',
  contacto: '',
  direccion: '',
  activo: true,
}

export default function ComprasPage() {
  const { perfil } = usePermisos()

  const [tab, setTab] = useState('compras')
  const [compras, setCompras] = useState([])
  const [proveedores, setProveedores] = useState([])
  const [articulos, setArticulos] = useState([])
  const [almacenes, setAlmacenes] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const [nueva, setNueva] = useState(null)
  const [editandoProv, setEditandoProv] = useState(null)
  const [recibiendo, setRecibiendo] = useState(null)

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      const [c, p, cat] = await Promise.all([
        inventarioApi.compras(),
        inventarioApi.proveedores(),
        inventarioApi.catalogo(),
      ])
      setCompras(c)
      setProveedores(p)
      setArticulos(cat.articulos)
      setAlmacenes(cat.almacenes)
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

  const abrirNueva = () =>
    setNueva({
      compra: { ...COMPRA_VACIA, almacen_id: almacenes[0]?.id ?? '' },
      items: [{ articulo_id: '', cantidad: '', costo_unit: '', series: '' }],
    })

  const total = (items) =>
    items.reduce((t, i) => t + (Number(i.cantidad) || 0) * (Number(i.costo_unit) || 0), 0)

  const guardarCompra = async () => {
    try {
      const items = nueva.items
        .filter((i) => i.articulo_id && Number(i.cantidad) > 0)
        .map((i) => ({
          articulo_id: i.articulo_id,
          cantidad: Number(i.cantidad),
          costo_unit: Number(i.costo_unit) || 0,
          // Las series se cargan acá, con la factura a la vista. Pedirlas en
          // otra pantalla garantiza que la mitad no se carguen nunca.
          series: i.series?.trim() ? i.series.split('\n').map((s) => s.trim()).filter(Boolean) : null,
        }))

      if (!items.length) throw new Error('La compra no tiene ningún ítem con cantidad')

      await inventarioApi.guardarCompra(
        { compra: { ...nueva.compra, total: total(items), proveedor_id: nueva.compra.proveedor_id || null }, items },
        perfil,
      )
      setNueva(null)
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
            <ShoppingCart size={20} className="text-sky-400" />
            Compras y proveedores
          </h1>
          <p className="text-sm text-slate-400">
            Lo que se pidió, a quién, y qué entró efectivamente a la bodega.
          </p>
        </div>
        {tab === 'compras' ? (
          <ConPermiso permiso="inventario.compras" envezDe={null}>
            <Button variante="primario" icon={Plus} onClick={abrirNueva}>
              Nueva compra
            </Button>
          </ConPermiso>
        ) : (
          <ConPermiso permiso="inventario.proveedores" envezDe={null}>
            <Button
              variante="primario"
              icon={Plus}
              onClick={() => setEditandoProv({ ...PROVEEDOR_VACIO })}
            >
              Nuevo proveedor
            </Button>
          </ConPermiso>
        )}
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <Tabs
        activa={tab}
        onCambiar={setTab}
        tabs={[
          { clave: 'compras', label: 'Compras', icon: ShoppingCart, contador: compras.length },
          { clave: 'proveedores', label: 'Proveedores', icon: Truck, contador: proveedores.length },
        ]}
      />

      {tab === 'compras' ? (
        <Card>
          {cargando ? (
            <SkeletonTabla filas={5} columnas={6} />
          ) : (
            <Table
              columnas={['N°', 'Fecha', 'Proveedor', 'Ítems', 'Total', 'Estado', '']}
              filas={compras}
              vacio="Todavía no hay compras registradas."
              renderFila={(c) => (
                <tr key={c.id} className="hover:bg-slate-800/40">
                  <td className="px-3 py-2 font-mono text-[12px] text-slate-300">
                    {String(c.numero).padStart(5, '0')}
                    {c.documento && (
                      <div className="text-[11px] text-slate-500">{c.documento}</div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-[12px] text-slate-400">
                    {new Date(`${c.fecha}T12:00:00`).toLocaleDateString('es-EC')}
                  </td>
                  <td className="px-3 py-2 text-slate-200">
                    {c.proveedores?.nombre ?? 'sin proveedor'}
                  </td>
                  <td className="px-3 py-2 text-[12px] text-slate-400">
                    {(c.compra_items ?? []).length} artículos
                  </td>
                  <td className="px-3 py-2 tabular-nums text-slate-200">{dinero(c.total)}</td>
                  <td className="px-3 py-2">
                    <Badge
                      color={
                        c.estado === 'recibida' ? 'verde' : c.estado === 'anulada' ? 'rojo' : 'ambar'
                      }
                    >
                      {c.estado}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {c.estado === 'borrador' && (
                      <ConPermiso permiso="inventario.ingresos" envezDe={null}>
                        <Button variante="fantasma" icon={Check} onClick={() => setRecibiendo(c)}>
                          Recibir
                        </Button>
                      </ConPermiso>
                    )}
                  </td>
                </tr>
              )}
            />
          )}
        </Card>
      ) : (
        <Card>
          {cargando ? (
            <SkeletonTabla filas={5} columnas={4} />
          ) : (
            <Table
              columnas={['Proveedor', 'Identificación', 'Contacto', 'Estado', '']}
              filas={proveedores}
              vacio="Sin proveedores cargados."
              renderFila={(p) => (
                <tr key={p.id} className="hover:bg-slate-800/40">
                  <td className="px-3 py-2 text-slate-100">{p.nombre}</td>
                  <td className="px-3 py-2 font-mono text-[12px] text-slate-400">
                    {p.identificacion ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-[12px] text-slate-400">
                    {p.telefono ?? '—'}
                    {p.contacto && <div className="text-[11px] text-slate-500">{p.contacto}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <Badge color={p.activo ? 'verde' : 'gris'}>
                      {p.activo ? 'Activo' : 'Inactivo'}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <ConPermiso permiso="inventario.proveedores" envezDe={null}>
                      <Button variante="fantasma" onClick={() => setEditandoProv(p)}>
                        Editar
                      </Button>
                    </ConPermiso>
                  </td>
                </tr>
              )}
            />
          )}
        </Card>
      )}

      {/* Nueva compra */}
      <Modal abierto={!!nueva} titulo="Nueva compra" onCerrar={() => setNueva(null)} ancho="max-w-3xl">
        {nueva && (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Proveedor">
                <Select
                  value={nueva.compra.proveedor_id}
                  onChange={(e) =>
                    setNueva({ ...nueva, compra: { ...nueva.compra, proveedor_id: e.target.value } })
                  }
                >
                  <option value="">— sin especificar —</option>
                  {proveedores.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nombre}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Entra a">
                <Select
                  value={nueva.compra.almacen_id}
                  onChange={(e) =>
                    setNueva({ ...nueva, compra: { ...nueva.compra, almacen_id: e.target.value } })
                  }
                >
                  {almacenes.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.nombre}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Factura o documento">
                <Input
                  value={nueva.compra.documento}
                  onChange={(e) =>
                    setNueva({ ...nueva, compra: { ...nueva.compra, documento: e.target.value } })
                  }
                />
              </Field>
              <Field label="Fecha">
                <Input
                  type="date"
                  value={nueva.compra.fecha}
                  onChange={(e) =>
                    setNueva({ ...nueva, compra: { ...nueva.compra, fecha: e.target.value } })
                  }
                />
              </Field>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-slate-200">Ítems</h3>
                <Button
                  variante="fantasma"
                  icon={Plus}
                  onClick={() =>
                    setNueva({
                      ...nueva,
                      items: [...nueva.items, { articulo_id: '', cantidad: '', costo_unit: '', series: '' }],
                    })
                  }
                >
                  Agregar
                </Button>
              </div>

              {nueva.items.map((it, i) => {
                const art = articulos.find((a) => a.id === it.articulo_id)
                return (
                  <div key={i} className="space-y-2 rounded-lg border border-slate-800 p-2">
                    <div className="flex flex-wrap gap-2">
                      <Select
                        value={it.articulo_id}
                        onChange={(e) => {
                          const items = [...nueva.items]
                          items[i] = { ...it, articulo_id: e.target.value }
                          setNueva({ ...nueva, items })
                        }}
                        className="min-w-[180px] flex-1"
                      >
                        <option value="">— artículo —</option>
                        {articulos.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.nombre}
                          </option>
                        ))}
                      </Select>
                      <Input
                        type="number"
                        step="0.01"
                        placeholder="Cantidad"
                        value={it.cantidad}
                        onChange={(e) => {
                          const items = [...nueva.items]
                          items[i] = { ...it, cantidad: e.target.value }
                          setNueva({ ...nueva, items })
                        }}
                        className="w-28"
                      />
                      <Input
                        type="number"
                        step="0.01"
                        placeholder="Costo unit."
                        value={it.costo_unit}
                        onChange={(e) => {
                          const items = [...nueva.items]
                          items[i] = { ...it, costo_unit: e.target.value }
                          setNueva({ ...nueva, items })
                        }}
                        className="w-28"
                      />
                      <Button
                        variante="fantasma"
                        icon={Trash2}
                        onClick={() =>
                          setNueva({ ...nueva, items: nueva.items.filter((_, x) => x !== i) })
                        }
                      />
                    </div>

                    {art?.por_serie && (
                      <Textarea
                        rows={3}
                        value={it.series}
                        onChange={(e) => {
                          const items = [...nueva.items]
                          items[i] = { ...it, series: e.target.value }
                          setNueva({ ...nueva, items })
                        }}
                        placeholder="Una serie por línea — se cargan ahora, con la factura a la vista"
                      />
                    )}
                  </div>
                )
              })}
            </div>

            <div className="flex items-center justify-between border-t border-slate-800 pt-3">
              <span className="text-sm text-slate-400">
                Total <span className="text-slate-100">{dinero(total(nueva.items))}</span>
              </span>
              <div className="flex gap-2">
                <Button variante="fantasma" onClick={() => setNueva(null)}>
                  Cancelar
                </Button>
                <Button onClick={guardarCompra}>Guardar como borrador</Button>
              </div>
            </div>
            <p className="text-[11px] text-slate-500">
              Se guarda en borrador. El stock sube recién al recibirla, cuando alguien tuvo la caja
              en la mano.
            </p>
          </div>
        )}
      </Modal>

      {/* Recibir */}
      <Modal
        abierto={!!recibiendo}
        titulo={`Recibir compra ${recibiendo ? String(recibiendo.numero).padStart(5, '0') : ''}`}
        onCerrar={() => setRecibiendo(null)}
      >
        {recibiendo && (
          <div className="space-y-3">
            <Aviso>
              Al confirmar entra todo al stock y se genera un movimiento por cada ítem. La compra no
              se puede volver a recibir; si algo llegó mal, se corrige con un ajuste.
            </Aviso>
            <div className="space-y-1">
              {(recibiendo.compra_items ?? []).map((i) => (
                <div
                  key={i.id}
                  className="flex justify-between rounded-lg bg-[#F6F8FB] px-2 py-1.5 text-[13px]"
                >
                  <span className="text-slate-200">{i.articulos?.nombre}</span>
                  <span className="tabular-nums text-slate-400">
                    {i.cantidad} {i.articulos?.unidad}
                    {Array.isArray(i.series) && i.series.length
                      ? ` · ${i.series.length} series`
                      : ''}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button variante="fantasma" onClick={() => setRecibiendo(null)}>
                Cancelar
              </Button>
              <Button
                onClick={async () => {
                  try {
                    await inventarioApi.recibirCompra(recibiendo, perfil)
                    setRecibiendo(null)
                    await recargar()
                  } catch (err) {
                    setError(err)
                  }
                }}
              >
                Confirmar recepción
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Proveedor */}
      <Modal
        abierto={!!editandoProv}
        titulo={editandoProv?.id ? `Editar ${editandoProv.nombre}` : 'Nuevo proveedor'}
        onCerrar={() => setEditandoProv(null)}
      >
        {editandoProv && (
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Nombre">
                <Input
                  value={editandoProv.nombre}
                  onChange={(e) => setEditandoProv({ ...editandoProv, nombre: e.target.value })}
                  autoFocus
                />
              </Field>
              <Field label="RUC o cédula">
                <Input
                  value={editandoProv.identificacion ?? ''}
                  onChange={(e) =>
                    setEditandoProv({ ...editandoProv, identificacion: e.target.value })
                  }
                />
              </Field>
              <Field label="Teléfono">
                <Input
                  value={editandoProv.telefono ?? ''}
                  onChange={(e) => setEditandoProv({ ...editandoProv, telefono: e.target.value })}
                />
              </Field>
              <Field label="Correo">
                <Input
                  value={editandoProv.email ?? ''}
                  onChange={(e) => setEditandoProv({ ...editandoProv, email: e.target.value })}
                />
              </Field>
              <Field label="Persona de contacto" className="md:col-span-2">
                <Input
                  value={editandoProv.contacto ?? ''}
                  onChange={(e) => setEditandoProv({ ...editandoProv, contacto: e.target.value })}
                />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button variante="fantasma" onClick={() => setEditandoProv(null)}>
                Cancelar
              </Button>
              <Button
                disabled={!editandoProv.nombre?.trim()}
                onClick={async () => {
                  try {
                    await inventarioApi.guardarProveedor(editandoProv)
                    setEditandoProv(null)
                    await recargar()
                  } catch (err) {
                    setError(err)
                  }
                }}
              >
                Guardar
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
