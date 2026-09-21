import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import ConciliarIps from '../../components/red/ConciliarIps'
import {
  ChevronLeft,
  ChevronRight,
  Info,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useTabla } from '../../lib/useTabla'
import { api } from '../../lib/apiNetwork'
import { TIPOS_SUBRED } from '../../lib/red'
import MapaIps from '../../components/red/MapaIps'
import SubredForm from '../../components/red/SubredForm'
import IPPoolManager from '../../components/mikrotik/IPPoolManager'
import IPAddressManager from '../../components/mikrotik/IPAddressManager'
import {
  Aviso,
  Button,
  Card,
  Cargando,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Select,
} from '../../components/ui'

/**
 * Redes IPv4 — el registro de los bloques.
 *
 * El listado es lo que se mira todos los días, así que está armado para
 * responder de un vistazo: cuánto queda libre en cada bloque. Por eso el uso va
 * como barra y no como número — "70.9% (180 de 254)" se entiende sin leerlo, y
 * un 180 suelto no dice nada sin saber el total.
 *
 * Se pagina en el navegador y no contra la base: un ISP tiene decenas de
 * bloques, no millones, y traerlos todos permite buscar sin ir y volver al
 * servidor en cada tecla.
 */

const TAMANOS = [15, 30, 50, 100]

/** Azul mientras sobra, naranja cuando aprieta, rojo cuando ya no entra nadie. */
function UsoIps({ pct, usadas, total }) {
  if (pct == null) {
    return <span className="text-xs text-slate-500">{usadas} asignadas</span>
  }

  const color = pct >= 90 ? 'bg-rose-500' : pct >= 60 ? 'bg-amber-500' : 'bg-sky-500'

  return (
    <div className="relative h-5 w-full min-w-[10rem] overflow-hidden rounded bg-slate-800">
      <div className={`h-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      <span className="absolute inset-0 flex items-center px-2 text-[11px] font-medium text-slate-100">
        {pct}% ({usadas} de {total})
      </span>
    </div>
  )
}

const COLOR_TIPO = {
  estatica: 'bg-emerald-500 text-emerald-950',
  pool_pppoe: 'bg-amber-500 text-amber-950',
  cgnat: 'bg-violet-500 text-violet-950',
  nodos: 'bg-slate-500 text-slate-950',
}

const ETIQUETA_TIPO = {
  estatica: 'ESTÁTICO',
  pool_pppoe: 'POOL',
  cgnat: 'CGNAT',
  nodos: 'NODOS',
}

export default function RedesIpv4Page() {
  const confirmar = useConfirmar()
  const { filas: routers } = useTabla('routers_mikrotik', { orderBy: 'nombre', ascending: true })
  const { filas: puntos } = useTabla('puntos_red', { orderBy: 'nombre', ascending: true })

  const [subredes, setSubredes] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const [busqueda, setBusqueda] = useState('')
  const [porPagina, setPorPagina] = useState(15)
  const [pagina, setPagina] = useState(1)

  const [editando, setEditando] = useState(null) // null | {} | fila
  const [mapaDe, setMapaDe] = useState(null)
  const [infoDe, setInfoDe] = useState(null)
  const [direcciones, setDirecciones] = useState([])
  const [sincronizando, setSincronizando] = useState(null)
  const [resultado, setResultado] = useState(null)

  const [routerId, setRouterId] = useState('')
  const [olts, setOlts] = useState([])
  const router = routers.find((r) => r.id === routerId)

  const recargar = useCallback(async () => {
    setCargando(true)
    const { data, error: err } = await supabase.from('v_subredes').select('*').order('numero')
    if (err) setError(err)
    setSubredes(data ?? [])
    setCargando(false)
  }, [])

  useEffect(() => {
    supabase
      .from('olts')
      .select('id, nombre, numero')
      .eq('activo', true)
      .order('numero')
      .then(({ data }) => setOlts(data ?? []))
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  const cargarDirecciones = useCallback(async (id) => {
    const { data } = await supabase
      .from('v_direcciones_ip')
      .select('*')
      .eq('subred_id', id)
      .order('ip_address')
    setDirecciones(data ?? [])
  }, [])

  useEffect(() => {
    if (mapaDe) cargarDirecciones(mapaDe.id)
  }, [mapaDe, cargarDirecciones])

  const filtradas = useMemo(() => {
    const t = busqueda.trim().toLowerCase()
    if (!t) return subredes
    return subredes.filter((s) =>
      [s.nombre, s.red, s.cidr, s.router, s.punto, ETIQUETA_TIPO[s.tipo]]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(t)),
    )
  }, [subredes, busqueda])

  // Al filtrar, la página en la que uno estaba puede ya no existir.
  useEffect(() => {
    setPagina(1)
  }, [busqueda, porPagina])

  const paginas = Math.max(1, Math.ceil(filtradas.length / porPagina))
  const desde = (pagina - 1) * porPagina
  const visibles = filtradas.slice(desde, desde + porPagina)

  /**
   * Abre la ficha con el puerto PON ya resuelto.
   *
   * El puerto no está en la subred: está en las VLANs de la OLT. Se busca al
   * abrir para que el campo muestre lo que hay en vez de aparecer vacío y hacer
   * creer que no está asignado.
   */
  async function abrirEdicion(s) {
    // La búsqueda va ANTES de abrir la ficha, no después.
    //
    // El formulario toma sus valores iniciales una sola vez, al montarse. Si se
    // abría primero y se completaba después, la placa y el puerto llegaban
    // tarde y quedaban vacíos — parecía que no se guardaban, y en realidad
    // nunca se habían cargado.
    let extra = {}
    if (s.olt_id && s.vlan != null) {
      // Puede haber varios puertos con esta VLAN —en esta red la 200 es la de
      // siete— así que se muestra el primero y no se inventa que hay uno solo.
      const { data } = await supabase
        .from('puertos_pon')
        .select('slot, puerto')
        .eq('olt_id', s.olt_id)
        .eq('vlan', s.vlan)
        .order('slot')
        .order('puerto')
      if (data?.length) extra = { slot: data[0].slot, puerto: data[0].puerto }
    }
    setEditando({ ...s, ...extra })
  }

  async function guardar({ slot, puerto, ...datos }) {
    const { error: err } = editando?.id
      ? await supabase.from('subredes').update(datos).eq('id', editando.id)
      : await supabase.from('subredes').insert(datos)

    if (err) throw err

    // El rango que se entrega vive en DOS lados: acá, como inventario, y en el
    // pool del MikroTik, que es lo que de verdad reparte. Cambiar uno solo deja
    // el sistema diciendo una cosa y el router haciendo otra.
    if (editando?.id && datos.pool_router && datos.router_id && datos.rango_desde) {
      await api.ipam
        .sincronizarPool(editando.id)
        .catch((e) => setError(new Error(`El bloque se guardó, pero el pool del router no: ${e.message}`)))
    }

    // El puerto PON no vive en la subred sino en la tabla de VLANs de la OLT:
    // la relación es puerto → VLAN → bloque, y varios bloques pueden compartir
    // una VLAN. Se guarda desde acá igual porque cargarlo en otra pantalla es
    // el paso que se olvida, y sin él la instalación no puede elegir sola su
    // segmento.
    if (datos.olt_id && datos.vlan != null && slot !== '' && puerto !== '') {
      await api.olt.asignarPuerto(datos.olt_id, Number(slot), Number(puerto), {
        vlan: datos.vlan,
      })
    }

    setEditando(null)
    await recargar()
  }

  async function sincronizar(s) {
    setSincronizando(s.id)
    setError(null)
    setResultado(null)
    try {
      setResultado(await api.ipam.sincronizar(s.id))
      await recargar()
      if (mapaDe?.id === s.id) await cargarDirecciones(s.id)
    } catch (err) {
      setError(err)
    } finally {
      setSincronizando(null)
    }
  }

  async function eliminar(s) {
    if (!await confirmar(`¿Eliminar ${s.nombre} (${s.red}/${s.prefijo})? Se borra su mapa de IPs.`)) return
    const { error: err } = await supabase.from('subredes').delete().eq('id', s.id)
    if (err) return setError(err)
    if (mapaDe?.id === s.id) setMapaDe(null)
    await recargar()
  }

  const Icono = ({ icon: I, onClick, title, peligro }) => (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded p-1 transition hover:bg-slate-700 ${
        peligro ? 'text-slate-500 hover:text-rose-300' : 'text-slate-500 hover:text-slate-100'
      }`}
    >
      <I size={15} />
    </button>
  )

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Redes IPv4</h1>
        <p className="text-sm text-slate-500">
          Los bloques de direcciones, su ocupación y quién tiene cada IP.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {/* Va arriba de los bloques y no abajo: después de migrar un padrón, esto
          es lo primero que hay que correr. Un abonado que paga y está en la lista
          de cortes del sistema anterior no da ninguna señal — solo su llamada. */}
      <ConciliarIps routers={routers} />

      <Card
        title="Bloques"
        icon={Network}
        actions={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <Input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar…"
                className="w-52 pl-8"
              />
            </div>
            <Button variante="primario" icon={Plus} onClick={() => setEditando({})}>
              Nuevo
            </Button>
          </div>
        }
      >
        <div className="mb-3 flex items-center gap-2 text-xs text-slate-500">
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
        </div>

        {cargando ? (
          <Cargando />
        ) : subredes.length === 0 ? (
          <Aviso>
            Todavía no hay bloques cargados. Con el primero, el alta de un abonado deja de
            contestarse mirando el cuaderno.
          </Aviso>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-2 font-medium">ID</th>
                    <th className="px-3 py-2 font-medium">Nombre</th>
                    <th className="px-3 py-2 font-medium">Red</th>
                    <th className="px-3 py-2 font-medium">Uso IPs</th>
                    <th className="px-3 py-2 font-medium">CIDR</th>
                    <th className="px-3 py-2 font-medium">Router</th>
                    <th className="px-3 py-2 font-medium">Tipo</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {visibles.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-8 text-center text-slate-500">
                        Ningún bloque coincide con “{busqueda}”.
                      </td>
                    </tr>
                  ) : (
                    visibles.map((s) => (
                      <tr key={s.id} className="text-slate-300">
                        <td className="px-3 py-2 text-xs text-slate-500">{s.numero}</td>
                        <td className="px-3 py-2 font-medium text-slate-100">{s.nombre}</td>
                        <td className="px-3 py-2 font-mono text-xs">{s.red}</td>
                        <td className="px-3 py-2">
                          <UsoIps
                            pct={s.ocupacion_pct}
                            usadas={Number(s.asignadas ?? 0) + Number(s.reservadas ?? 0)}
                            total={s.utilizables}
                          />
                        </td>
                        <td className="px-3 py-2 text-xs">{s.prefijo}</td>
                        <td className="px-3 py-2 text-xs">{s.router ?? '—'}</td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-flex rounded px-2 py-0.5 text-[10px] font-bold ${
                              COLOR_TIPO[s.tipo] ?? COLOR_TIPO.nodos
                            }`}
                          >
                            {ETIQUETA_TIPO[s.tipo] ?? s.tipo}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-0.5">
                            <Icono icon={Pencil} title="Editar" onClick={() => abrirEdicion(s)} />
                            <Icono
                              icon={Info}
                              title="Detalle"
                              onClick={() => setInfoDe(infoDe?.id === s.id ? null : s)}
                            />
                            <Icono
                              icon={Network}
                              title="Mapa de direcciones"
                              onClick={() => setMapaDe(mapaDe?.id === s.id ? null : s)}
                            />
                            <Icono
                              icon={RefreshCw}
                              title="Sincronizar con el router"
                              onClick={() => sincronizar(s)}
                            />
                            <Icono icon={Trash2} title="Eliminar" peligro onClick={() => eliminar(s)} />
                          </div>
                          {sincronizando === s.id && (
                            <p className="text-right text-[10px] text-slate-500">consultando…</p>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
              <span>
                {filtradas.length === 0
                  ? 'Sin resultados'
                  : `Mostrando de ${desde + 1} al ${Math.min(desde + porPagina, filtradas.length)} de un total de ${filtradas.length}`}
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
                  {Array.from({ length: paginas }, (_, i) => i + 1)
                    // Con muchas páginas se muestran solo las cercanas: veinte
                    // botones de página no se usan, se ignoran.
                    .filter((p) => p === 1 || p === paginas || Math.abs(p - pagina) <= 2)
                    .map((p, i, lista) => (
                      <span key={p} className="flex items-center gap-1">
                        {i > 0 && lista[i - 1] !== p - 1 && <span className="px-1">…</span>}
                        <button
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
                      </span>
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

      {resultado && (
        <Aviso>
          {resultado.mensaje} {resultado.nuevas} nuevas, {resultado.actualizadas} actualizadas.
          <span className="mt-1 block text-xs opacity-80">
            Fuentes: {resultado.fuentes.direcciones} direcciones del equipo, {resultado.fuentes.leases}{' '}
            leases, {resultado.fuentes.secrets} secrets, {resultado.fuentes.sesiones} sesiones activas.
          </span>
        </Aviso>
      )}

      {infoDe && (
        <Card title={infoDe.nombre} subtitle={`${infoDe.red}/${infoDe.prefijo}`} icon={Info}>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <Dato etiqueta="Tipo" valor={TIPOS_SUBRED[infoDe.tipo]?.label} />
            <Dato etiqueta="Router" valor={infoDe.router} />
            <Dato etiqueta="Nodo" valor={infoDe.punto} />
            <Dato etiqueta="Gateway" valor={infoDe.gateway} />
            <Dato etiqueta="VLAN" valor={infoDe.vlan} />
            <Dato etiqueta="Pool en el router" valor={infoDe.pool_router} />
            <Dato etiqueta="Utilizables" valor={infoDe.utilizables} />
            <Dato etiqueta="Asignadas" valor={infoDe.asignadas} />
            <Dato etiqueta="Reservadas" valor={infoDe.reservadas} />
            <Dato etiqueta="Rango" valor={`${infoDe.primera} – ${infoDe.ultima}`} />
            <Dato etiqueta="Sin autorizar" valor={infoDe.sin_autorizar} />
            <Dato etiqueta="Notas" valor={infoDe.notas} />
          </dl>
          <p className="mt-3 text-xs text-slate-500">{TIPOS_SUBRED[infoDe.tipo]?.ayuda}</p>
        </Card>
      )}

      {mapaDe && (
        <Card
          title={`Mapa de ${mapaDe.nombre}`}
          subtitle={`${mapaDe.red}/${mapaDe.prefijo} · ${TIPOS_SUBRED[mapaDe.tipo]?.label ?? mapaDe.tipo}`}
          icon={Network}
        >
          <MapaIps cidr={`${mapaDe.red}/${mapaDe.prefijo}`} direcciones={direcciones} />
        </Card>
      )}

      <Card title="Pools y direcciones del router" icon={Network}>
        <Field label="Router">
          <Select value={routerId} onChange={(e) => setRouterId(e.target.value)}>
            <option value="">— elegí un router —</option>
            {routers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.nombre} ({r.ip_host})
              </option>
            ))}
          </Select>
        </Field>
        <p className="mt-2 text-xs text-slate-500">
          Esto es lo que el equipo tiene configurado ahora mismo. El IPAM de arriba es el registro:
          la diferencia entre los dos es lo que la auditoría saca a la luz.
        </p>
      </Card>

      {router && (
        <>
          <IPPoolManager router={router} />
          <IPAddressManager router={router} />
        </>
      )}

      <Modal
        abierto={editando !== null}
        titulo={editando?.id ? `Editar ${editando.nombre}` : 'Nuevo bloque'}
        onCerrar={() => setEditando(null)}
        ancho="max-w-2xl"
      >
        <SubredForm
          key={editando?.id ?? 'nuevo'}
          subred={editando?.id ? editando : null}
          routers={routers}
          puntos={puntos}
          olts={olts}
          onGuardar={guardar}
          onCancelar={() => setEditando(null)}
        />
      </Modal>
    </div>
  )
}

function Dato({ etiqueta, valor }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-slate-500">{etiqueta}</dt>
      <dd className="text-slate-200">{valor ?? '—'}</dd>
    </div>
  )
}
