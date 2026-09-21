import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  Check,
  Copy,
  KeyRound,
  LogOut,
  Search,
  Users,
  Wifi,
  X,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../lib/apiNetwork'
import { Aviso, Button, Card, Cargando, ErrorBanner, Input } from '../components/ui'

/**
 * El portal del abonado, visto desde la oficina.
 *
 * Tres cosas, en el orden en que importan:
 *
 *   LA COLA DE PEDIDOS de cambio de WiFi. Es trabajo pendiente que hoy no ve
 *   nadie: el abonado lo pidió y espera, y sin esta pantalla queda enterrado.
 *
 *   QUIÉNES NO PUEDEN ENTRAR. Cada fila es un dato que falta en una ficha, y
 *   completarlo es un abonado que deja de llamar a la oficina.
 *
 *   RESETEAR EL ACCESO de uno en particular.
 */
export default function PortalClientePage() {
  const [datos, setDatos] = useState(null)
  const [pedidos, setPedidos] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const recargar = () =>
    Promise.all([api.portalAdmin.resumen(), api.portalAdmin.solicitudes()])
      .then(([r, s]) => {
        setDatos(r)
        setPedidos(s)
      })
      .catch(setError)

  useEffect(() => {
    recargar().finally(() => setCargando(false))
  }, [])

  if (cargando) return <Cargando />

  return (
    <div className="space-y-4">
      <Link to="/ajustes" className="inline-flex items-center gap-1 text-sm text-slate-400">
        <ArrowLeft size={15} /> Volver a Ajustes
      </Link>

      <div>
        <h1 className="text-lg font-semibold text-slate-100">Portal del cliente</h1>
        <p className="mt-0.5 max-w-3xl text-xs leading-snug text-slate-500">
          Tus abonados entran con su cédula y un código al celular a ver sus facturas, reportar
          fallas y cambiar su clave de WiFi.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <Enlace />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metrica titulo="Pueden entrar" valor={datos.habilitados} de={datos.abonados} />
        <Metrica titulo="Con contraseña" valor={datos.con_clave} />
        <Metrica titulo="Sesiones abiertas" valor={datos.sesiones_activas} />
        <Metrica
          titulo="Pedidos pendientes"
          valor={datos.solicitudes_pendientes}
          color={datos.solicitudes_pendientes ? 'text-amber-400' : undefined}
        />
      </div>

      <Pedidos pedidos={pedidos} onCambio={recargar} onError={setError} />

      {datos.bloqueados_total > 0 && <Bloqueados datos={datos} />}

      <Buscador onError={setError} />
    </div>
  )
}

/** El enlace que hay que repartir. Sin esto, el portal existe y nadie lo usa. */
function Enlace() {
  const [copiado, setCopiado] = useState(false)
  const url = `${window.location.origin}/portal/`

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-wider text-slate-500">
            El enlace para tus abonados
          </p>
          <code className="mt-1 block select-all break-all font-mono text-sm text-sky-300">
            {url}
          </code>
        </div>
        <Button
          variante="fantasma"
          icon={Copy}
          onClick={() => {
            navigator.clipboard?.writeText(url)
            setCopiado(true)
            setTimeout(() => setCopiado(false), 2000)
          }}
        >
          {copiado ? 'Copiado' : 'Copiar'}
        </Button>
      </div>
    </Card>
  )
}

const Metrica = ({ titulo, valor, de, color }) => (
  <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
    <p className="text-[11px] uppercase tracking-wider text-slate-500">{titulo}</p>
    <p className={`mt-1 text-xl font-semibold ${color ?? 'text-slate-100'}`}>
      {valor}
      {de != null && <span className="text-sm text-slate-600"> de {de}</span>}
    </p>
  </div>
)

/**
 * Los cambios de WiFi que los abonados pidieron.
 *
 * Hasta que el ACS tenga camino a la red de gestión, alguien los aplica a mano.
 * La clave se muestra porque quien la aplica la necesita: está cifrada en la
 * base para que no aparezca en cada respaldo, no para ocultársela a quien tiene
 * que hacer el trabajo.
 */
function Pedidos({ pedidos, onCambio, onError }) {
  const [trabajando, setTrabajando] = useState(null)

  async function marcar(id, estado) {
    setTrabajando(id)
    try {
      await api.portalAdmin.marcarSolicitud(id, estado)
      await onCambio()
    } catch (err) {
      onError(err)
    } finally {
      setTrabajando(null)
    }
  }

  if (!pedidos.length) {
    return (
      <Card title="Cambios de WiFi pedidos" icon={Wifi}>
        <p className="text-sm text-slate-500">No hay pedidos pendientes.</p>
      </Card>
    )
  }

  return (
    <Card title={`Cambios de WiFi pedidos (${pedidos.length})`} icon={Wifi}>
      <div className="space-y-2">
        <Aviso>
          Los abonados están esperando. Aplicalos en su equipo y marcalos como hechos — hasta
          entonces siguen usando su clave anterior, que es lo que les dijimos.
        </Aviso>

        {pedidos.map((p) => (
          <div
            key={p.id}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm text-slate-200">{p.cliente}</p>
              <p className="text-xs text-slate-500">
                {p.tipo === 'clave_wifi' ? 'Clave nueva' : 'Nombre de red nuevo'} ·{' '}
                {new Date(p.creada_en).toLocaleDateString('es-EC')}
              </p>
            </div>

            {p.ilegible ? (
              <span className="text-xs text-rose-400">
                No se pudo descifrar — pedile que lo vuelva a cargar
              </span>
            ) : (
              <code className="select-all rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-sm text-emerald-300">
                {p.valor}
              </code>
            )}

            <div className="flex gap-1.5">
              <Button
                variante="secundario"
                icon={Check}
                cargando={trabajando === p.id}
                onClick={() => marcar(p.id, 'aplicada')}
              >
                Hecho
              </Button>
              <Button
                variante="fantasma"
                icon={X}
                cargando={trabajando === p.id}
                onClick={() => marcar(p.id, 'cancelada')}
              >
                Descartar
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

/** Los que no pueden entrar, con qué les falta. */
function Bloqueados({ datos }) {
  const [abierto, setAbierto] = useState(false)

  return (
    <Card title={`No pueden entrar (${datos.bloqueados_total})`} icon={Users}>
      <div className="space-y-3">
        <p className="text-sm leading-snug text-slate-400">
          El portal necesita la <b>cédula</b> para reconocer al abonado y un <b>celular</b> para
          mandarle el código. Al que le falta alguna de las dos no puede entrar, y no lo puede
          resolver solo: tiene que llamar.
        </p>

        {abierto ? (
          <div className="max-h-72 divide-y divide-slate-800/60 overflow-y-auto rounded border border-slate-800">
            {datos.bloqueados.map((b) => (
              <Link
                key={b.id}
                to={`/clientes/${b.id}`}
                className="flex items-center justify-between px-3 py-2 text-sm hover:bg-slate-800/40"
              >
                <span className="text-slate-300">{b.nombre}</span>
                <span className="text-xs text-amber-400">falta {b.falta}</span>
              </Link>
            ))}
            {datos.bloqueados_total > datos.bloqueados.length && (
              <p className="px-3 py-2 text-xs text-slate-500">
                y {datos.bloqueados_total - datos.bloqueados.length} más
              </p>
            )}
          </div>
        ) : (
          <Button variante="secundario" onClick={() => setAbierto(true)}>
            Ver quiénes son
          </Button>
        )}
      </div>
    </Card>
  )
}

/** Buscar un abonado y resetearle el acceso. */
function Buscador({ onError }) {
  const [q, setQ] = useState('')
  const [resultados, setResultados] = useState(null)
  const [buscando, setBuscando] = useState(false)
  const [hecho, setHecho] = useState(null)

  async function buscar(e) {
    e.preventDefault()
    setBuscando(true)
    setHecho(null)
    try {
      setResultados(await api.portalAdmin.buscar(q))
    } catch (err) {
      onError(err)
    } finally {
      setBuscando(false)
    }
  }

  async function accion(id, cual) {
    try {
      const r =
        cual === 'resetear'
          ? await api.portalAdmin.resetear(id)
          : await api.portalAdmin.cerrarSesiones(id)
      setHecho(r.mensaje ?? `${r.sesiones_cerradas} sesiones cerradas.`)
      setResultados(await api.portalAdmin.buscar(q))
    } catch (err) {
      onError(err)
    }
  }

  return (
    <Card title="Buscar un abonado" icon={Search}>
      <div className="space-y-3">
        <form onSubmit={buscar} className="flex gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Nombre o cédula"
            className="flex-1"
          />
          <Button type="submit" variante="primario" cargando={buscando} disabled={q.trim().length < 2}>
            Buscar
          </Button>
        </form>

        {hecho && <Aviso>{hecho}</Aviso>}

        {resultados?.length === 0 && (
          <p className="text-sm text-slate-500">No se encontró a nadie con eso.</p>
        )}

        {resultados?.map((c) => (
          <div key={c.id} className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <Link to={`/clientes/${c.id}`} className="text-sm text-slate-200 hover:text-sky-300">
                  {c.nombre}
                </Link>
                <p className="text-xs text-slate-500">
                  {c.identificacion ?? 'sin cédula'} · {c.contacto ?? 'sin contacto'}
                </p>
              </div>

              <div className="flex flex-wrap gap-1.5">
                <Button variante="fantasma" icon={KeyRound} onClick={() => accion(c.id, 'resetear')}>
                  Resetear acceso
                </Button>
                {c.sesiones > 0 && (
                  <Button
                    variante="fantasma"
                    icon={LogOut}
                    onClick={() => accion(c.id, 'cerrar')}
                  >
                    Cerrar {c.sesiones} {c.sesiones === 1 ? 'sesión' : 'sesiones'}
                  </Button>
                )}
              </div>
            </div>

            <div className="mt-2 flex flex-wrap gap-3 text-xs">
              {c.falta ? (
                <span className="text-amber-400">No puede entrar: falta {c.falta}</span>
              ) : (
                <span className="text-slate-500">
                  {c.tiene_clave ? 'Tiene contraseña' : 'Entra solo con código'}
                </span>
              )}
              {c.ultimo_acceso && (
                <span className="text-slate-500">
                  Último acceso: {new Date(c.ultimo_acceso).toLocaleString('es-EC')}
                </span>
              )}
            </div>
          </div>
        ))}

        {/* Lo que esta pantalla NO puede hacer, dicho para que nadie lo busque. */}
        <p className="pt-1 text-xs leading-relaxed text-slate-500">
          Resetear <b>borra</b> la contraseña: el abonado vuelve a entrar con el código a su celular
          y elige otra. Desde acá no se puede poner una contraseña que vos conozcas — si se pudiera,
          alguien de la oficina podría entrar a su cuenta y no habría forma de distinguirlo de él.
        </p>
      </div>
    </Card>
  )
}
