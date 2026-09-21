import { useCallback, useEffect, useState } from 'react'
import { useConfirmar } from '../lib/confirmar'
import { Link } from 'react-router-dom'
import {
  Cpu,
  MemoryStick,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Router as RouterIcon,
  Trash2,
} from 'lucide-react'
import { useTabla } from '../lib/useTabla'
import { api } from '../lib/apiNetwork'
import RouterForm from '../components/mikrotik/RouterForm'
import ClientesRouterPanel from '../components/mikrotik/ClientesRouterPanel'
import RepararRouter from '../components/mikrotik/RepararRouter'
import PrepararIpv6 from '../components/mikrotik/PrepararIpv6'
import {
  Aviso,
  Badge,
  Button,
  Card,
  Cargando,
  ErrorBanner,
  Field,
  Modal,
  Select,
  Stat,
  Table,
} from '../components/ui'

/**
 * Routers MikroTik.
 *
 * Alta, edición y estado de los equipos de borde. El direccionamiento —pools,
 * direcciones, subredes— vive en Redes IPv4: son dos preguntas distintas y
 * mezclarlas obligaba a bajar por una pantalla de routers para encontrar un
 * pool.
 *
 * La carga se lee en vivo porque un "responde el ping" no alcanza: un CCR al
 * 95% de CPU contesta perfecto mientras le corta el tráfico a todos, y es la
 * falla que se busca cuando "anda lento" y todo lo demás da bien.
 */

/** Verde hasta el 60%, ámbar hasta el 85, rojo arriba. */
function Barra({ pct, etiqueta }) {
  if (pct == null) return <span className="text-xs text-slate-600">—</span>

  const color = pct >= 85 ? 'bg-rose-500' : pct >= 60 ? 'bg-amber-500' : 'bg-emerald-500'
  const texto = pct >= 85 ? 'text-rose-300' : pct >= 60 ? 'text-amber-300' : 'text-slate-300'

  return (
    <div className="min-w-[7rem]">
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-xs font-medium ${texto}`}>{pct}%</span>
        {etiqueta && <span className="text-[10px] text-slate-500">{etiqueta}</span>}
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  )
}

const COLOR_ESTADO = { online: 'verde', offline: 'rojo', inactivo: 'gris' }

export default function MikrotikPage() {
  const confirmar = useConfirmar()
  const {
    filas: routers,
    cargando,
    error,
    insertar,
    actualizar,
    eliminar,
    setError,
    recargar,
  } = useTabla('routers_mikrotik', { orderBy: 'nombre', ascending: true })

  // null = cerrado | {} = alta | {id,…} = edición de ese router
  const [enFormulario, setEnFormulario] = useState(null)
  const [routerId, setRouterId] = useState('')
  const [salud, setSalud] = useState({})
  const [consultando, setConsultando] = useState(false)

  const router = routers.find((r) => r.id === routerId)

  /**
   * La salud se pide toda junta al middleware, que consulta los equipos en
   * paralelo. Uno inalcanzable no puede hacer esperar a los demás treinta
   * segundos.
   */
  const consultarSalud = useCallback(async () => {
    setConsultando(true)
    try {
      const filas = await api.ipam.saludRouters()
      setSalud(Object.fromEntries(filas.map((f) => [f.id, f])))
    } catch (err) {
      setError(err)
    } finally {
      setConsultando(false)
    }
  }, [setError])

  useEffect(() => {
    if (routers.length) consultarSalud()
  }, [routers.length, consultarSalud])

  async function borrar(r) {
    if (!await confirmar(`¿Eliminar el router "${r.nombre}" de la base?`)) return
    try {
      await eliminar(r.id)
      if (routerId === r.id) setRouterId('')
    } catch (err) {
      setError(err)
    }
  }

  const online = Object.values(salud).filter((r) => r.estado === 'online')
  const cargados = online.filter((r) => (r.cpu_pct ?? 0) >= 60 || (r.memoria_pct ?? 0) >= 85)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Routers MikroTik</h1>
          <p className="text-sm text-slate-500">
            Equipos de borde y su carga. El direccionamiento está en{' '}
            <Link to="/red/redes" className="text-sky-400 hover:underline">
              Redes IPv4
            </Link>
            .
          </p>
        </div>
        <div className="flex gap-2">
          <Button icon={RefreshCw} onClick={consultarSalud} cargando={consultando}>
            Actualizar estado
          </Button>
          <Button variante="primario" icon={Plus} onClick={() => setEnFormulario({})}>
            Nuevo router
          </Button>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Routers" valor={routers.length} icon={RouterIcon} />
        <Stat
          label="En línea"
          valor={online.length}
          sub={`${Math.max(routers.length - online.length, 0)} sin responder`}
          color="text-emerald-400"
        />
        <Stat
          label="Con carga alta"
          valor={cargados.length}
          sub="CPU sobre 60% o memoria sobre 85%"
          icon={Cpu}
          color={cargados.length ? 'text-amber-400' : 'text-slate-500'}
        />
      </div>

      <Card title="Equipos registrados" icon={RouterIcon}>
        {cargando ? (
          <Cargando />
        ) : routers.length === 0 ? (
          <Aviso>Todavía no hay ningún router cargado.</Aviso>
        ) : (
          <Table
            columnas={['Router', 'IP de gestión', 'Puerto API', 'Estado', 'CPU', 'Memoria', 'Uptime', '']}
            filas={routers}
            renderFila={(r) => {
              const s = salud[r.id]
              return (
                <tr key={r.id} className="text-slate-300">
                  <td className="px-3 py-2">
                    <p className="font-medium text-slate-100">{r.nombre}</p>
                    <p className="text-[11px] text-slate-500">
                      {s?.modelo ?? r.usuario}
                      {s?.version ? ` · RouterOS ${s.version}` : ''}
                    </p>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.ip_host}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.puerto_api}
                    <span className="ml-1.5 text-[10px] text-slate-500">
                      {r.modo_api === 'rest' ? 'REST' : 'API'}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {!s ? (
                      <span className="text-xs text-slate-500">sin consultar</span>
                    ) : (
                      <>
                        <Badge color={COLOR_ESTADO[s.estado] ?? 'gris'}>
                          {s.estado === 'online'
                            ? 'En línea'
                            : s.estado === 'offline'
                              ? 'Sin responder'
                              : 'Inactivo'}
                        </Badge>
                        {s.estado === 'offline' && (
                          <p className="mt-1 max-w-[15rem] text-[11px] text-rose-300/80" title={s.hint}>
                            {s.error}
                          </p>
                        )}
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Barra pct={s?.cpu_pct} etiqueta={s?.cpu_nucleos ? `${s.cpu_nucleos} núcleos` : null} />
                  </td>
                  <td className="px-3 py-2">
                    <Barra
                      pct={s?.memoria_pct}
                      etiqueta={s?.memoria_libre_mb != null ? `${s.memoria_libre_mb} MB libres` : null}
                    />
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{s?.uptime ?? '—'}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        variante="fantasma"
                        icon={Plug}
                        title="Volver a consultar este equipo"
                        onClick={consultarSalud}
                      />
                      <Button
                        variante="fantasma"
                        icon={Pencil}
                        title="Editar"
                        onClick={() => setEnFormulario(r)}
                      />
                      <Button variante="fantasma" icon={Trash2} title="Eliminar" onClick={() => borrar(r)} />
                    </div>
                  </td>
                </tr>
              )
            }}
          />
        )}
      </Card>

      <p className="flex items-start gap-2 text-xs text-slate-500">
        <MemoryStick size={14} className="mt-0.5 shrink-0" />
        La memoria de un RouterOS sano se mantiene estable. Si sube sola con los días es una fuga
        —normalmente de una regla de firewall con connection tracking— y el equipo se va a reiniciar
        solo.
      </p>

      {routers.length > 0 && (
        <Card title="Clientes del router">
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
        </Card>
      )}

      {router && <ClientesRouterPanel key={router.id} router={router} />}
      {router && <RepararRouter key={`reparar-${router.id}`} router={router} />}

      {/* Va al final: es opcional y la mayoría de los ISP todavía no lo usa. */}
      {router && (
        <PrepararIpv6 key={`ipv6-${router.id}`} router={router} onCambio={recargar} />
      )}

      <Modal
        abierto={enFormulario !== null}
        titulo={enFormulario?.id ? `Editar ${enFormulario.nombre}` : 'Registrar router MikroTik'}
        onCerrar={() => setEnFormulario(null)}
        ancho="max-w-2xl"
      >
        <RouterForm
          // key fuerza el remontaje al cambiar de router: sin esto el formulario
          // conservaría los valores del anterior.
          key={enFormulario?.id ?? 'nuevo'}
          router={enFormulario?.id ? enFormulario : null}
          onCancelar={() => setEnFormulario(null)}
          onGuardado={async (datos) => {
            if (enFormulario?.id) {
              await actualizar(enFormulario.id, datos)
              // La conexión pudo cambiar: lo que se sabía de su estado ya no
              // dice nada sobre este router.
              setSalud((s) => {
                const { [enFormulario.id]: _, ...resto } = s
                return resto
              })
            } else {
              await insertar(datos)
            }
            setEnFormulario(null)
          }}
        />
      </Modal>
    </div>
  )
}
