import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { Link } from 'react-router-dom'
import {
  ChevronLeft,
  ChevronRight,
  Gauge,
  Pencil,
  Plus,
  Router as RouterIcon,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
  Users,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useTabla } from '../../lib/useTabla'
import { api } from '../../lib/apiNetwork'
import { CATEGORIAS, IMPUESTOS, dinero, enMbps } from '../../lib/planes'
import PlanForm from '../../components/servicios/PlanForm'
import AsignacionRouters from '../../components/servicios/AsignacionRouters'
import ColaDelPlan from '../../components/olt/ColaDelPlan'
import AplicarPlanClientes from '../../components/olt/AplicarPlanClientes'
import ConPermiso from '../../components/layout/ConPermiso'
import {
  Aviso,
  Badge,
  Button,
  Card,
  Cargando,
  ErrorBanner,
  Input,
  Modal,
  Select,
  Stat,
} from '../../components/ui'

/**
 * Servicios / Planes de Internet.
 *
 * El catálogo de lo que se vende. Es la única pantalla del sistema que toca las
 * dos mitades del negocio a la vez —el precio con su IVA y la velocidad con su
 * cola— y por eso el plan se edita solo acá: tenerlo en dos lugares garantiza
 * que tarde o temprano digan cosas distintas.
 *
 * De acá sale lo que se elige al dar de alta a un abonado, lo que va en el
 * contrato y lo que termina en la factura.
 */

const TAMANOS = [15, 30, 50]

const COLOR_CATEGORIA = {
  residencial: 'bg-sky-500 text-sky-950',
  corporativo: 'bg-violet-500 text-violet-950',
  otro: 'bg-slate-500 text-slate-950',
}

export default function PlanesPage() {
  const confirmar = useConfirmar()
  const { filas: olts } = useTabla('olts', { orderBy: 'nombre', ascending: true })
  const { filas: routers } = useTabla('routers_mikrotik', { orderBy: 'nombre', ascending: true })

  const [planes, setPlanes] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const [busqueda, setBusqueda] = useState('')
  const [porPagina, setPorPagina] = useState(15)
  const [pagina, setPagina] = useState(1)
  const [verRetirados, setVerRetirados] = useState(false)

  const [editando, setEditando] = useState(null)
  const [asignados, setAsignados] = useState([])
  const [routersDe, setRoutersDe] = useState(null)
  const [colaDe, setColaDe] = useState(null)
  const [aplicarA, setAplicarA] = useState(null)

  const [oltId, setOltId] = useState('')
  const [aplicandoOlt, setAplicandoOlt] = useState(null)
  // Las traffic tables de la OLT elegida. null = no se leyeron todavía.
  const [velocidades, setVelocidades] = useState(null)
  const [resultadoOlt, setResultadoOlt] = useState(null)

  const recargar = useCallback(async () => {
    setCargando(true)
    const { data, error: err } = await supabase
      .from('v_planes')
      .select('*')
      .order('bajada_kbps', { ascending: true })

    if (err) setError(err)
    setPlanes(data ?? [])
    setCargando(false)
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  /**
   * Al abrir el formulario se traen los routers que el plan ya tiene.
   *
   * Sin esto, editar un plan y guardar sin tocar la sección de routers lo
   * desasignaría de todos: la lista arrancaría vacía y la reconciliación lo
   * leería como "sacalo de todos lados".
   */
  useEffect(() => {
    if (!editando?.id) {
      setAsignados([])
      return
    }

    let vigente = true
    supabase
      .from('plan_routers')
      .select('router_id')
      .eq('plan_id', editando.id)
      .then(({ data }) => vigente && setAsignados((data ?? []).map((r) => r.router_id)))

    return () => {
      vigente = false
    }
  }, [editando])

  useEffect(() => {
    setVelocidades(null)
  }, [oltId])

  async function leerVelocidades() {
    if (!oltId) return setError(new Error('Elegí primero la OLT'))
    try {
      setVelocidades(await api.olt.trafficTables(oltId))
    } catch (err) {
      setError(err)
    }
  }

  const filtrados = useMemo(() => {
    const t = busqueda.trim().toLowerCase()
    return planes
      .filter((p) => verRetirados || p.activo)
      .filter(
        (p) =>
          !t ||
          [p.nombre, p.descripcion, p.perfil_ppp, CATEGORIAS[p.categoria]?.label]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(t)),
      )
  }, [planes, busqueda, verRetirados])

  useEffect(() => {
    setPagina(1)
  }, [busqueda, porPagina, verRetirados])

  const paginas = Math.max(1, Math.ceil(filtrados.length / porPagina))
  const desde = (pagina - 1) * porPagina
  const visibles = filtrados.slice(desde, desde + porPagina)

  /**
   * Guarda el plan y deja su lista de routers como quedó marcada.
   *
   * La asignación se reconcilia en vez de reescribirse: borrar todo e insertar
   * de nuevo perdería el estado del aprovisionamiento —cuándo se aplicó el
   * perfil en cada equipo, si dio error— y esa historia es justamente lo que
   * dice dónde falta trabajo.
   */
  async function guardar(datos, routerIds = []) {
    const { data: fila, error: err } = editando?.id
      ? await supabase
          .from('planes_velocidad')
          .update(datos)
          .eq('id', editando.id)
          .select('id')
          .single()
      : await supabase.from('planes_velocidad').insert(datos).select('id').single()

    if (err) throw err

    const planId = fila.id
    const antes = new Set(asignados)
    const ahora = new Set(routerIds)

    const agregar = routerIds.filter((id) => !antes.has(id))
    const quitar = [...antes].filter((id) => !ahora.has(id))

    if (agregar.length) {
      const { error: errIns } = await supabase
        .from('plan_routers')
        .insert(agregar.map((router_id) => ({ plan_id: planId, router_id })))
      if (errIns) throw errIns
    }

    // Sacar el plan de un router no borra el perfil del equipo: puede haber
    // abonados conectados con él, y quitárselo los dejaría con el de por
    // defecto en la próxima reconexión.
    if (quitar.length) {
      const { error: errDel } = await supabase
        .from('plan_routers')
        .delete()
        .eq('plan_id', planId)
        .in('router_id', quitar)
      if (errDel) throw errDel
    }

    setEditando(null)
    setAsignados([])
    await recargar()
  }

  async function eliminar(p) {
    if (p.abonados > 0) {
      return setError(
        Object.assign(new Error(`${p.nombre} lo tienen ${p.abonados} abonados`), {
          hint: 'Retiralo en vez de borrarlo: así deja de ofrecerse en las altas y los que lo tienen conservan su plan y su precio.',
        }),
      )
    }
    if (!await confirmar(`¿Eliminar el plan ${p.nombre}?`)) return

    const { error: err } = await supabase.from('planes_velocidad').delete().eq('id', p.id)
    if (err) return setError(err)
    await recargar()
  }

  async function aplicarEnOlt(p) {
    if (!oltId) return setError(new Error('Elegí primero la OLT donde aplicar la traffic table'))

    setAplicandoOlt(p.id)
    setError(null)
    setResultadoOlt(null)
    try {
      setResultadoOlt(await api.olt.aplicarPlan(oltId, { plan_id: p.id }))
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setAplicandoOlt(null)
    }
  }

  const activos = planes.filter((p) => p.activo)
  const abonados = planes.reduce((n, p) => n + Number(p.abonados ?? 0), 0)
  const sinAprovisionar = planes.filter((p) => p.routers > 0 && p.routers_aplicados < p.routers)

  const Icono = ({ icon: I, onClick, title, peligro, cargando: c }) => (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={c}
      className={`rounded p-1 transition hover:bg-slate-700 disabled:opacity-40 ${
        peligro ? 'text-slate-500 hover:text-rose-300' : 'text-slate-500 hover:text-slate-100'
      }`}
    >
      <I size={15} className={c ? 'animate-pulse' : ''} />
    </button>
  )

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Planes de internet</h1>
        <p className="text-sm text-slate-500">
          El catálogo de lo que se vende: precio, impuesto y velocidad. De acá sale lo que contrata
          cada abonado.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Planes activos" valor={activos.length} icon={Gauge} />
        <Stat label="Abonados con plan" valor={abonados} icon={Users} color="text-sky-400" />
        <Stat
          label="Sin aprovisionar"
          valor={sinAprovisionar.length}
          sub="Perfil pendiente en algún router"
          icon={RouterIcon}
          color={sinAprovisionar.length ? 'text-amber-400' : 'text-slate-500'}
        />
        <Stat
          label="Retirados"
          valor={planes.length - activos.length}
          sub="No se ofrecen en las altas"
          color="text-slate-500"
        />
      </div>

      <Card
        title="Catálogo"
        icon={Gauge}
        actions={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <Input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar…"
                className="w-48 pl-8"
              />
            </div>
            <ConPermiso permiso="config.planes" envezDe={null}>
              <Button variante="primario" icon={Plus} onClick={() => setEditando({})}>
                Nuevo plan
              </Button>
            </ConPermiso>
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
          <span className="flex items-center gap-2">
            <Select
              value={porPagina}
              onChange={(e) => setPorPagina(Number(e.target.value))}
              className="w-20 px-2 py-1 text-xs"
            >
              {TAMANOS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
            por página
          </span>

          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={verRetirados}
              onChange={(e) => setVerRetirados(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900 accent-sky-500"
            />
            Ver también los retirados
          </label>

          {/* La OLT destino es para aplicar traffic tables: configuración de
              red, no catálogo. Quien solo consulta precios no la necesita. */}
          <ConPermiso permiso="config.planes" envezDe={null}>
            <span className="ml-auto flex items-center gap-2">
              OLT destino
              <Select
                value={oltId}
                onChange={(e) => setOltId(e.target.value)}
                className="w-44 px-2 py-1 text-xs"
              >
                <option value="">— elegir —</option>
                {olts.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.nombre}
                  </option>
                ))}
              </Select>
            </span>
          </ConPermiso>
        </div>

        {cargando ? (
          <Cargando />
        ) : planes.length === 0 ? (
          <Aviso>
            Todavía no hay planes cargados. El primero define qué se puede vender: sin plan, un alta
            no tiene ni velocidad ni precio.
          </Aviso>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-2 font-medium">Plan</th>
                    <th className="px-3 py-2 font-medium">Categoría</th>
                    <th className="px-3 py-2 font-medium">Velocidad</th>
                    <th className="px-3 py-2 font-medium">Precio</th>
                    <th className="px-3 py-2 font-medium">Total a facturar</th>
                    <th className="px-3 py-2 text-center font-medium">Abonados</th>
                    <th className="px-3 py-2 font-medium">Routers</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {visibles.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-8 text-center text-slate-500">
                        Ningún plan coincide.
                      </td>
                    </tr>
                  ) : (
                    visibles.map((p) => (
                      <tr key={p.id} className={`text-slate-300 ${p.activo ? '' : 'opacity-50'}`}>
                        <td className="px-3 py-2">
                          <p className="font-medium text-slate-100">
                            {p.nombre}
                            {!p.activo && (
                              <span className="ml-2 text-[10px] uppercase text-slate-500">retirado</span>
                            )}
                          </p>
                          <p className="text-[11px] text-slate-500">
                            {p.perfil_ppp ? `perfil ${p.perfil_ppp}` : 'sin perfil PPP'}
                            {p.codigo_facturacion ? ` · cód. ${p.codigo_facturacion}` : ''}
                          </p>
                        </td>

                        <td className="px-3 py-2">
                          <span
                            className={`inline-flex rounded px-2 py-0.5 text-[10px] font-bold uppercase ${
                              COLOR_CATEGORIA[p.categoria] ?? COLOR_CATEGORIA.otro
                            }`}
                          >
                            {CATEGORIAS[p.categoria]?.label ?? p.categoria}
                          </span>
                        </td>

                        <td className="px-3 py-2 text-xs">
                          {enMbps(p.bajada_kbps)}
                          <span className="text-slate-500"> / {enMbps(p.subida_kbps)}</span>
                          {p.prioridad && (
                            <p className="text-[10px] text-slate-500">prioridad {p.prioridad}</p>
                          )}
                        </td>

                        <td className="px-3 py-2">
                          <p className="text-slate-200">{dinero(p.precio)}</p>
                          <p className="text-[10px] text-slate-500">
                            {IMPUESTOS[p.tipo_impuesto]?.label}
                            {p.tipo_impuesto !== 'ninguno' ? ` ${p.iva_porcentaje}%` : ''}
                          </p>
                        </td>

                        <td className="px-3 py-2">
                          <p className="font-medium text-emerald-300">{dinero(p.precio_total)}</p>
                          <p className="text-[10px] text-slate-500">
                            base {dinero(p.precio_sin_iva)} + IVA {dinero(p.iva_valor)}
                          </p>
                        </td>

                        <td className="px-3 py-2 text-center">
                          <Link
                            to={`/clientes?plan=${p.id}`}
                            className="text-slate-200 hover:text-sky-400"
                            title="Abonados con este plan"
                          >
                            {p.abonados ?? 0}
                          </Link>
                          {p.abonados_activos != null && p.abonados_activos !== p.abonados && (
                            <p className="text-[10px] text-slate-500">{p.abonados_activos} activos</p>
                          )}
                        </td>

                        {/* Clicable: es la acción que más se busca desde el
                            listado y un icono de 15 px no la anuncia.

                            Pero solo para quien configura. Sin este recorte, el
                            "sin asignar" es un enlace que abre el aprovisiona-
                            miento de routers — una puerta a la red escondida
                            detrás de una etiqueta que parece informativa. */}
                        <td className="px-3 py-2">
                          <ConPermiso
                            permiso="config.planes"
                            envezDe={
                              p.routers > 0 ? (
                                <Badge color="gris">{p.routers} routers</Badge>
                              ) : (
                                <span className="text-xs text-slate-600">—</span>
                              )
                            }
                          >
                            <button
                              type="button"
                              onClick={() => setRoutersDe(p)}
                              title="Elegir en qué routers se ofrece y aprovisionar el perfil"
                              className="text-left"
                            >
                              {p.routers > 0 ? (
                                <Badge color={p.routers_aplicados === p.routers ? 'verde' : 'ambar'}>
                                  {p.routers_aplicados} de {p.routers}
                                </Badge>
                              ) : (
                                <span className="text-xs text-amber-400 underline decoration-dotted">
                                  sin asignar
                                </span>
                              )}
                            </button>
                          </ConPermiso>
                        </td>

                        <td className="px-3 py-2">
                          {/* Todo lo de esta columna toca la red o el precio de
                              venta: es configuración, no consulta. Quien vende
                              ni siquiera llega a esta pantalla — elige el plan
                              desde el Cotizador. */}
                          <ConPermiso permiso="config.planes" envezDe={null}>
                          <div className="flex justify-end gap-0.5">
                            <Icono icon={Pencil} title="Editar el plan" onClick={() => setEditando(p)} />
                            <Icono
                              icon={RouterIcon}
                              title="Routers y perfil PPP"
                              onClick={() => setRoutersDe(p)}
                            />
                            <Icono
                              icon={SlidersHorizontal}
                              title="Ráfaga y prioridad de la cola"
                              onClick={() => setColaDe(p)}
                            />
                            <Icono
                              icon={Users}
                              title="Aplicar la velocidad a los abonados que ya lo tienen"
                              onClick={() => setAplicarA(p)}
                            />
                            <Icono
                              icon={Upload}
                              title="Aplicar la traffic table en la OLT"
                              cargando={aplicandoOlt === p.id}
                              onClick={() => aplicarEnOlt(p)}
                            />
                            <Icono icon={Trash2} title="Eliminar" peligro onClick={() => eliminar(p)} />
                          </div>
                          </ConPermiso>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
              <span>
                {filtrados.length === 0
                  ? 'Sin resultados'
                  : `Mostrando de ${desde + 1} al ${Math.min(desde + porPagina, filtrados.length)} de un total de ${filtrados.length}`}
              </span>

              {paginas > 1 && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPagina((p) => Math.max(1, p - 1))}
                    disabled={pagina === 1}
                    className="rounded border border-slate-700 p-1.5 hover:bg-slate-800 disabled:opacity-40"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  {Array.from({ length: paginas }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPagina(p)}
                      className={`min-w-[2rem] rounded border px-2 py-1 ${
                        p === pagina
                          ? 'border-sky-500 bg-sky-600 text-white'
                          : 'border-slate-700 hover:bg-slate-800'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setPagina((p) => Math.min(paginas, p + 1))}
                    disabled={pagina === paginas}
                    className="rounded border border-slate-700 p-1.5 hover:bg-slate-800 disabled:opacity-40"
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </Card>

      {resultadoOlt && (
        <Aviso>
          Traffic table aplicada en la OLT.
          <span className="mt-1 block font-mono text-[11px] opacity-80">{resultadoOlt.comando}</span>
        </Aviso>
      )}

      <Aviso>
        Cambiar la velocidad de un plan acá no se la cambia a ningún abonado: eso vive en los
        equipos. En fibra se aplica con la traffic table de la OLT; en radio, reescribiendo la cola
        de cada uno con <b>“A los clientes”</b>. La{' '}
        <Link to="/red/shaping" className="underline">
          regla de shaping
        </Link>{' '}
        explica por qué.
      </Aviso>

      <Modal
        abierto={editando !== null}
        titulo={editando?.id ? `Editar ${editando.nombre}` : 'Nuevo plan'}
        onCerrar={() => setEditando(null)}
        ancho="max-w-3xl"
      >
        <PlanForm
              velocidades={velocidades}
              onLeerVelocidades={leerVelocidades}
          // El key incluye los asignados para que el formulario se remonte
          // cuando llegan: se cargan después de abrir el modal y el estado
          // inicial de los checkboxes ya se había fijado en vacío.
          key={`${editando?.id ?? 'nuevo'}-${asignados.join(',')}`}
          plan={editando?.id ? editando : null}
          routers={routers}
          asignados={asignados}
          onGuardar={guardar}
          onCancelar={() => setEditando(null)}
        />
      </Modal>

      {routersDe && <AsignacionRouters plan={routersDe} onCerrar={() => setRoutersDe(null)} />}

      {colaDe && (
        <ColaDelPlan
          plan={colaDe}
          onCerrar={() => setColaDe(null)}
          onGuardar={async (cambios) => {
            const { error: err } = await supabase
              .from('planes_velocidad')
              .update(cambios)
              .eq('id', colaDe.id)
            if (err) return setError(err)
            setColaDe(null)
            await recargar()
          }}
        />
      )}

      <AplicarPlanClientes plan={aplicarA} onCerrar={() => setAplicarA(null)} />
    </div>
  )
}
