import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import {
  Activity,
  Antenna,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Eye,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Wifi,
  Zap,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useTabla } from '../../lib/useTabla'
import { api } from '../../lib/apiNetwork'
import { ESTADOS_NODO, TIPOS_NODO, duracion } from '../../lib/red'
import NodoForm from '../../components/red/NodoForm'
import HistorialNodo from '../../components/red/HistorialNodo'
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
 * Monitoreo de red: el tablero y el inventario en una sola pantalla.
 *
 * Estaban separados y era un ida y vuelta constante: se veía una caída en el
 * tablero y había que cambiar de pantalla para saber de qué torre colgaba o
 * para probarla. Son la misma pregunta hecha dos veces.
 *
 * El listado va ordenado por gravedad y no por nombre: lo que está mal, arriba.
 * Un tablero alfabético obliga a buscar el problema entre cuarenta filas verdes.
 */

const TAMANOS = [15, 30, 50, 100]

/** Los rotos primero; entre iguales, el que lleva más tiempo así. */
const GRAVEDAD = { down: 0, warning: 1, desconocido: 2, up: 3 }

/** Contador redondo, como los de la referencia: número dentro de un círculo. */
function Cuenta({ n, color }) {
  return (
    <span
      className={`inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[11px] font-bold ${color}`}
    >
      {n ?? 0}
    </span>
  )
}

export default function MonitoreoPage() {
  const confirmar = useConfirmar()
  const { filas: routers } = useTabla('routers_mikrotik', { orderBy: 'nombre', ascending: true })
  const { filas: puntos } = useTabla('puntos_red', { orderBy: 'nombre', ascending: true })

  const [nodos, setNodos] = useState([])
  const [tecnicos, setTecnicos] = useState([])
  const [estadoNms, setEstadoNms] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [sondeando, setSondeando] = useState(false)

  const [busqueda, setBusqueda] = useState('')
  const [porPagina, setPorPagina] = useState(15)
  const [pagina, setPagina] = useState(1)

  const [editando, setEditando] = useState(null) // null | {} | fila
  const [viendo, setViendo] = useState(null)
  const [graficando, setGraficando] = useState(null)
  const [pruebas, setPruebas] = useState({})

  const recargar = useCallback(async () => {
    const [n, t] = await Promise.all([
      supabase.from('v_nodos_red').select('*'),
      supabase.from('tecnicos').select('id, nombre').eq('activo', true).order('nombre'),
    ])

    if (n.error) setError(n.error)
    setNodos(n.data ?? [])
    setTecnicos(t.data ?? [])

    // El estado del servicio va aparte: si el middleware no está, los nodos se
    // siguen viendo con su última lectura en vez de quedar la pantalla vacía.
    try {
      setEstadoNms(await api.nms.estado())
    } catch {
      setEstadoNms(null)
    }

    setCargando(false)
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  // Un tablero de monitoreo que hay que recargar a mano no es un tablero.
  useEffect(() => {
    const t = setInterval(recargar, 30_000)
    return () => clearInterval(t)
  }, [recargar])

  const ordenados = useMemo(
    () =>
      [...nodos].sort(
        (a, b) =>
          (GRAVEDAD[a.estado] ?? 9) - (GRAVEDAD[b.estado] ?? 9) ||
          (b.minutos_en_estado ?? 0) - (a.minutos_en_estado ?? 0),
      ),
    [nodos],
  )

  const filtrados = useMemo(() => {
    const t = busqueda.trim().toLowerCase()
    if (!t) return ordenados
    return ordenados.filter((n) =>
      [n.nombre, n.equipo, n.ip, n.punto, n.padre, n.router]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(t)),
    )
  }, [ordenados, busqueda])

  useEffect(() => {
    setPagina(1)
  }, [busqueda, porPagina])

  const paginas = Math.max(1, Math.ceil(filtrados.length / porPagina))
  const desde = (pagina - 1) * porPagina
  const visibles = filtrados.slice(desde, desde + porPagina)

  async function sondearTodo() {
    setSondeando(true)
    setError(null)
    try {
      await api.nms.sondear()
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setSondeando(false)
    }
  }

  async function probar(n) {
    setPruebas((p) => ({ ...p, [n.id]: { cargando: true } }))
    try {
      const r = await api.nms.probar(n.id)
      setPruebas((p) => ({ ...p, [n.id]: r }))
    } catch (err) {
      setPruebas((p) => ({ ...p, [n.id]: { error: err.message } }))
    }
  }

  async function guardar(datos) {
    const { error: err } = editando?.id
      ? await supabase.from('nodos_red').update(datos).eq('id', editando.id)
      : await supabase.from('nodos_red').insert(datos)

    if (err) throw err
    setEditando(null)
    await recargar()
  }

  async function alternar(n, campo) {
    const { error: err } = await supabase
      .from('nodos_red')
      .update({ [campo]: !n[campo] })
      .eq('id', n.id)
    if (err) return setError(err)
    await recargar()
  }

  async function eliminar(n) {
    if (n.hijos > 0) {
      return setError(
        Object.assign(new Error(`${n.nombre} tiene ${n.hijos} nodos que dependen de él`), {
          hint: 'Reasignalos a otro padre antes de borrarlo, o quedarían sin dependencia y alertarían de a uno.',
        }),
      )
    }
    if (!await confirmar(`¿Eliminar ${n.nombre}? Se borra también su historial de caídas.`)) return

    const { error: err } = await supabase.from('nodos_red').delete().eq('id', n.id)
    if (err) return setError(err)
    await recargar()
  }

  const cuenta = (e) => nodos.filter((n) => n.estado === e).length
  const sinRouter = nodos.filter((n) => n.monitorear && !n.router_id)

  const Icono = ({ icon: I, onClick, title, activo, peligro }) => (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded p-1 transition hover:bg-slate-700 ${
        peligro
          ? 'text-slate-500 hover:text-rose-300'
          : activo
            ? 'text-sky-400'
            : 'text-slate-500 hover:text-slate-100'
      }`}
    >
      <I size={15} />
    </button>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Monitoreo de red</h1>
          <p className="text-sm text-slate-500">
            Estado en vivo de la infraestructura. Se refresca solo cada 30 segundos.
          </p>
        </div>
        <div className="flex gap-2">
          <Button icon={RefreshCw} onClick={sondearTodo} cargando={sondeando}>
            Sondear ahora
          </Button>
          <Button variante="primario" icon={Plus} onClick={() => setEditando({})}>
            Nuevo
          </Button>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {estadoNms && !estadoNms.configurado.automatico && (
        <Aviso tipo="alerta">
          El sondeo automático está apagado: los estados solo se actualizan cuando alguien aprieta
          “Sondear ahora”. Se enciende con <code className="text-xs">NMS_AUTOMATICO=true</code> en el{' '}
          <code className="text-xs">.env</code> del middleware, una vez que el árbol de dependencias
          esté armado.
        </Aviso>
      )}

      {sinRouter.length > 0 && (
        <Aviso tipo="alerta">
          {sinRouter.length} {sinRouter.length === 1 ? 'nodo está marcado' : 'nodos están marcados'}{' '}
          para monitorear pero sin router desde el cual sondearlos. El servidor casi nunca tiene ruta
          hasta una antena de torre: sin router quedan en “sin datos” para siempre.
        </Aviso>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="🔴 Caídos" valor={cuenta('down')} color="text-rose-400" icon={Zap} />
        <Stat label="🟡 Degradados" valor={cuenta('warning')} color="text-amber-400" />
        <Stat label="🟢 En servicio" valor={cuenta('up')} color="text-emerald-400" />
        <Stat
          label="⚪ Sin datos"
          valor={cuenta('desconocido')}
          sub={`${nodos.filter((n) => n.monitorear).length} de ${nodos.length} monitoreados`}
          color="text-slate-500"
        />
      </div>

      <Card
        title="Nodos"
        icon={Activity}
        actions={
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <Input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar…"
              className="w-52 pl-8"
            />
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
        ) : nodos.length === 0 ? (
          <Aviso>
            Todavía no hay nodos. Conviene empezar por los de cabecera —las OLTs y los enlaces
            troncales— y colgar de ellos las torres: el árbol es lo que evita las alertas en masa.
          </Aviso>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-2 font-medium">ID</th>
                    <th className="px-3 py-2 font-medium">Nombre</th>
                    <th className="px-3 py-2 font-medium">Equipo</th>
                    <th className="px-3 py-2 font-medium">IP</th>
                    <th className="px-3 py-2 font-medium">Estado</th>
                    <th className="px-3 py-2 text-center font-medium">Online</th>
                    <th className="px-3 py-2 text-center font-medium">Activos</th>
                    <th className="px-3 py-2 text-center font-medium">Suspendidos</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {visibles.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-3 py-8 text-center text-slate-500">
                        Ningún nodo coincide con “{busqueda}”.
                      </td>
                    </tr>
                  ) : (
                    visibles.map((n) => {
                      const e = ESTADOS_NODO[n.estado] ?? ESTADOS_NODO.desconocido
                      const prueba = pruebas[n.id]

                      return (
                        <tr key={n.id} className="text-slate-300">
                          <td className="px-3 py-2 text-xs text-slate-500">{n.numero}</td>

                          <td className="px-3 py-2">
                            <p className="font-medium text-slate-100">{n.nombre}</p>
                            <p className="text-[11px] text-slate-500">
                              {TIPOS_NODO[n.tipo]?.label ?? n.tipo}
                              {n.padre ? ` · depende de ${n.padre}` : ''}
                            </p>
                          </td>

                          <td className="px-3 py-2 text-xs">{n.equipo ?? '—'}</td>
                          <td className="px-3 py-2 font-mono text-xs">{n.ip}</td>

                          <td className="px-3 py-2">
                            <span
                              className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-bold uppercase ${e.clase}`}
                            >
                              {e.label}
                            </span>
                            <p className="mt-0.5 text-[11px] text-slate-500">
                              {n.desde ? duracion(n.minutos_en_estado) : 'sin sondear'}
                              {n.padre_caido && n.estado === 'down' ? ' · por su padre' : ''}
                            </p>
                            {prueba && (
                              <p className="text-[11px]">
                                {prueba.cargando ? (
                                  <span className="text-slate-500">probando…</span>
                                ) : prueba.error ? (
                                  <span className="text-rose-300">{prueba.error}</span>
                                ) : (
                                  <span className="text-sky-300">
                                    ping {prueba.recibidos}/{prueba.enviados}
                                    {prueba.latencia_ms != null ? ` · ${prueba.latencia_ms} ms` : ''}
                                  </span>
                                )}
                              </p>
                            )}
                          </td>

                          <td className="px-3 py-2 text-center">
                            <Cuenta n={n.online} color="bg-teal-500 text-teal-950" />
                          </td>
                          <td className="px-3 py-2 text-center">
                            <Cuenta n={n.activos} color="bg-amber-500 text-amber-950" />
                          </td>
                          <td className="px-3 py-2 text-center">
                            <Cuenta n={n.suspendidos} color="bg-rose-500 text-rose-950" />
                          </td>

                          <td className="px-3 py-2">
                            <div className="flex justify-end gap-0.5">
                              <Icono
                                icon={Zap}
                                title="Hacer ping ahora (no se registra)"
                                onClick={() => probar(n)}
                              />
                              <Icono icon={Pencil} title="Editar" onClick={() => setEditando(n)} />
                              <Icono
                                icon={Eye}
                                title="Ver detalle"
                                activo={viendo?.id === n.id}
                                onClick={() => setViendo(viendo?.id === n.id ? null : n)}
                              />
                              <Icono
                                icon={n.monitorear ? Wifi : Antenna}
                                title={n.monitorear ? 'Monitoreando: pausar' : 'Pausado: reanudar'}
                                activo={n.monitorear}
                                onClick={() => alternar(n, 'monitorear')}
                              />
                              <Icono
                                icon={BarChart3}
                                title="Historial y gráfico"
                                onClick={() => setGraficando(n)}
                              />
                              <Icono icon={Trash2} title="Eliminar" peligro onClick={() => eliminar(n)} />
                            </div>
                          </td>
                        </tr>
                      )
                    })
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
                  {Array.from({ length: paginas }, (_, i) => i + 1)
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

      {viendo && (
        <Card title={viendo.nombre} subtitle={`${TIPOS_NODO[viendo.tipo]?.label} · ${viendo.ip}`} icon={Eye}>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <Dato etiqueta="Equipo" valor={viendo.equipo} />
            <Dato etiqueta="Sitio" valor={viendo.punto} />
            <Dato etiqueta="Depende de" valor={viendo.padre ?? 'cabecera'} />
            <Dato etiqueta="Nodos que dependen" valor={viendo.hijos} />
            <Dato etiqueta="Sondeado desde" valor={viendo.router} />
            <Dato etiqueta="Técnico" valor={viendo.tecnico ?? 'destino general'} />
            <Dato etiqueta="Umbral de latencia" valor={`${viendo.latencia_warning_ms} ms`} />
            <Dato etiqueta="Umbral de pérdida" valor={`${viendo.perdida_warning_pct}%`} />
            <Dato
              etiqueta="Uptime 30 días"
              valor={viendo.uptime_pct != null ? `${viendo.uptime_pct}%` : 'sin historial'}
            />
            <Dato etiqueta="Último sondeo" valor={viendo.ultimo_chequeo ? new Date(viendo.ultimo_chequeo).toLocaleString() : '—'} />
            <Dato etiqueta="Avisos" valor={viendo.avisar ? 'activos' : 'silenciado'} />
            <Dato etiqueta="Notas" valor={viendo.notas} />
          </dl>

          <div className="mt-4 flex gap-2">
            <Button icon={Pencil} onClick={() => setEditando(viendo)}>
              Editar
            </Button>
            <Button icon={BarChart3} onClick={() => setGraficando(viendo)}>
              Ver historial
            </Button>
            <Button onClick={() => alternar(viendo, 'avisar')}>
              {viendo.avisar ? 'Silenciar avisos' : 'Reactivar avisos'}
            </Button>
          </div>
        </Card>
      )}

      {estadoNms?.ultimoResultado?.avisos?.length > 0 && (
        <Card title="Del último sondeo" icon={Activity}>
          <ul className="space-y-1 text-xs text-slate-400">
            {estadoNms.ultimoResultado.avisos.map((a, i) => (
              <li key={i}>
                <b className="text-slate-200">{a.nodo}</b>{' '}
                {a.enviado ? 'avisado' : `sin avisar — ${a.motivo}`}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal
        abierto={editando !== null}
        titulo={editando?.id ? `Editar ${editando.nombre}` : 'Nuevo nodo'}
        onCerrar={() => setEditando(null)}
        ancho="max-w-2xl"
      >
        <NodoForm
          key={editando?.id ?? 'nuevo'}
          nodo={editando?.id ? editando : null}
          nodos={nodos}
          routers={routers}
          puntos={puntos}
          tecnicos={tecnicos}
          onGuardar={guardar}
          onCancelar={() => setEditando(null)}
        />
      </Modal>

      <Modal
        abierto={graficando !== null}
        titulo={`Historial de ${graficando?.nombre ?? ''}`}
        onCerrar={() => setGraficando(null)}
        ancho="max-w-3xl"
      >
        {graficando && <HistorialNodo nodo={graficando} />}
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
