import { useCallback, useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Globe,
  List,
  Plus,
  RefreshCw,
  Save,
  Download,
  Trash2,
  Wand2,
} from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, ErrorBanner, Field, Input, Select, SkeletonTabla, Table } from '../ui'

/**
 * Pools de direcciones para las ONUs.
 *
 * Son dos cosas con la misma forma y usos distintos:
 *
 *   Gestión   la IP con la que se administra la ONT — TR069, OMCI. Viaja por la
 *             VLAN de gestión, en paralelo a la del abonado.
 *   WAN       la estática que la ONT usa cuando el abonado tiene IP fija en el
 *             equipo y no por PPPoE.
 *
 * A diferencia de un segmento de abonados, acá las direcciones se cargan una por
 * una: es lo que permite ver cuáles están tomadas sin ir a mirar la OLT, que es
 * como se hace hoy.
 */

/**
 * Qué uso de VLAN corresponde a cada tipo de pool.
 *
 * Un pool de gestión va en la VLAN de gestión y uno de WAN en la de abonados.
 * Es una regla del ISP, no del equipo, y por eso vive acá y no en la OLT.
 */
const USO_ESPERADO = { gestion_onu: 'gestion', wan_onu: 'internet' }
const ETIQUETA_USO = { gestion: 'gestión', internet: 'internet' }

const VISTAS = {
  gestion_onu: {
    label: 'IPs de gestión',
    icon: List,
    titulo: 'Pools de gestión de ONUs',
    ayuda:
      'Direcciones para administrar las ONTs — TR069 y VoIP. De acá sale la IP fija que se le ' +
      'asigna a cada equipo.',
  },
  wan_onu: {
    label: 'IPs WAN estáticas',
    icon: Globe,
    titulo: 'Pools de WAN estática',
    ayuda:
      'Direcciones que la ONT usa en su WAN cuando el abonado tiene IP fija en el equipo y no ' +
      'la recibe por PPPoE.',
  },
}

export default function OltPoolsIp({ olt }) {
  const [proposito, setProposito] = useState('gestion_onu')
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [creando, setCreando] = useState(false)
  const [abierto, setAbierto] = useState(null) // id del pool desplegado
  const [ips, setIps] = useState(null)
  const [vlans, setVlans] = useState([])
  const [importacion, setImportacion] = useState(null)
  const [importando, setImportando] = useState(false)

  const leer = useCallback(async () => {
    setCargando(true)
    setError(null)
    try {
      setDatos(await api.olt.poolsIp(olt.id, proposito))
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [olt.id, proposito])

  useEffect(() => {
    leer()
    setAbierto(null)
    setIps(null)
  }, [leer])

  // Las VLANs del equipo, para el desplegable del formulario. Falla en silencio
  // a propósito: no poder leerlas no tiene por qué impedir cargar un pool.
  useEffect(() => {
    api.olt
      .vlans(olt.id)
      .then((r) => setVlans(r.vlans ?? []))
      .catch(() => setVlans([]))
  }, [olt.id])

  async function verIps(pool) {
    if (abierto === pool.id) {
      setAbierto(null)
      return setIps(null)
    }
    setAbierto(pool.id)
    setIps(null)
    try {
      setIps(await api.olt.poolIps(olt.id, pool.id))
    } catch (err) {
      setError(err)
    }
  }

  const V = VISTAS[proposito]

  if (creando) {
    return (
      <FormularioPool
        olt={olt}
        proposito={proposito}
        vlans={vlans}
        onListo={() => {
          setCreando(false)
          leer()
        }}
        onCancelar={() => setCreando(false)}
      />
    )
  }

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {/* --- Las dos vistas --- */}
      <div className="flex flex-wrap gap-2">
        {Object.entries(VISTAS).map(([clave, v]) => {
          const esta = proposito === clave
          const Icono = v.icon
          return (
            <button
              key={clave}
              type="button"
              onClick={() => setProposito(clave)}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition ${
                esta
                  ? 'bg-sky-600 text-white'
                  : 'border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10'
              }`}
            >
              <Icono size={14} />
              {v.label}
            </button>
          )
        })}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-100">{V.titulo}</h3>
        <p className="mt-0.5 max-w-3xl text-xs leading-snug text-slate-500">{V.ayuda}</p>
      </div>

      {datos === null ? (
        <SkeletonTabla filas={4} columnas={6} />
      ) : (
        <>
          {/* --- Los números --- */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Metrica titulo="Pools" valor={datos.resumen.pools} />
            <Metrica
              titulo="Requieren atención"
              valor={datos.resumen.requieren_atencion}
              color={datos.resumen.requieren_atencion > 0 ? 'text-amber-400' : undefined}
              ayuda="Direcciones entregadas que no están enganchadas a ninguna ONU"
            />
            <Metrica titulo="Usadas" valor={datos.resumen.usadas} />
            <Metrica titulo="Reservadas" valor={datos.resumen.reservadas} />
            <Metrica titulo="Disponibles" valor={datos.resumen.libres} color="text-emerald-400" />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variante="primario" icon={Plus} onClick={() => setCreando(true)}>
              Agregar pool
            </Button>
            {/* El paso de una migración: las direcciones están en los equipos y
                acá figuran libres, así que el primer alta entregaría una
                repetida. Se lee del equipo, que es la única fuente que no puede
                estar desactualizada. */}
            {proposito === 'gestion_onu' && datos.pools.length > 0 && (
              <Button
                icon={Download}
                cargando={importando}
                onClick={async () => {
                  setImportando(true)
                  setError(null)
                  try {
                    setImportacion(await api.olt.importarIpsGestion(olt.id, { aplicar: false }))
                  } catch (err) {
                    setError(err)
                  } finally {
                    setImportando(false)
                  }
                }}
              >
                Traer las que ya están puestas
              </Button>
            )}
            <span className="flex-1" />
            <Button variante="fantasma" icon={RefreshCw} cargando={cargando} onClick={leer}>
              Releer
            </Button>
          </div>

          {importacion && (
            <PanelImportacion
              datos={importacion}
              trabajando={importando}
              onAplicar={async () => {
                setImportando(true)
                setError(null)
                try {
                  await api.olt.importarIpsGestion(olt.id, { aplicar: true })
                  setImportacion(null)
                  await leer()
                } catch (err) {
                  setError(err)
                } finally {
                  setImportando(false)
                }
              }}
              onCerrar={() => setImportacion(null)}
            />
          )}

          <Table
            columnas={['', 'Red', 'Gateway', 'DNS 1', 'DNS 2', 'VLAN', 'Reparto', 'Uso', '']}
            filas={datos.pools}
            vacio={`Todavía no hay ningún pool de ${proposito === 'wan_onu' ? 'WAN' : 'gestión'}.`}
            renderFila={(p) => (
              <FilaPool
                key={p.id}
                pool={p}
                abierto={abierto === p.id}
                ips={abierto === p.id ? ips : null}
                onVer={() => verIps(p)}
                onBorrar={async (forzar) => {
                  setError(null)
                  try {
                    await api.olt.borrarPoolIp(olt.id, p.id, forzar)
                    await leer()
                  } catch (err) {
                    setError(err)
                  }
                }}
              />
            )}
          />
        </>
      )}
    </div>
  )
}

function Metrica({ titulo, valor, color, ayuda }) {
  return (
    <div className="t-card-sm p-3" title={ayuda}>
      <p className="text-[11px] uppercase tracking-wider text-slate-500">{titulo}</p>
      <p className={`mt-1 text-xl font-semibold ${color ?? 'text-slate-100'}`}>{valor}</p>
    </div>
  )
}

function FilaPool({ pool, abierto, ips, onVer, onBorrar }) {
  const confirmar = useConfirmar()
  const pct = pool.uso_pct ?? 0
  const color = pct >= 90 ? 'bg-rose-500' : pct >= 60 ? 'bg-amber-500' : 'bg-emerald-500'

  return (
    <>
      <tr className="text-slate-300">
        <td className="px-3 py-2">
          <button type="button" onClick={onVer} className="text-slate-500 hover:text-slate-200">
            {abierto ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
        </td>
        <td className="px-3 py-2">
          <Badge color="azul">{pool.cidr}</Badge>
          {pool.nombre && <span className="ml-2 text-[11px] text-slate-500">{pool.nombre}</span>}
        </td>
        <td className="px-3 py-2 font-mono text-xs">{pool.gateway ?? '—'}</td>
        <td className="px-3 py-2 font-mono text-xs">{pool.dns1 ?? '—'}</td>
        <td className="px-3 py-2 font-mono text-xs">{pool.dns2 ?? '—'}</td>
        <td className="px-3 py-2 font-mono text-xs">{pool.vlan ?? '—'}</td>
        <td className="px-3 py-2">
          <div className="relative h-5 w-full min-w-[11rem] overflow-hidden rounded bg-slate-800">
            <div className={`h-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
            <span className="absolute inset-0 flex items-center px-2 text-[11px] text-slate-100">
              {pool.usadas} usadas · {pool.libres} libres · {pool.total} en total
            </span>
          </div>
        </td>
        <td className="px-3 py-2">
          <Badge color={pct >= 90 ? 'rojo' : pct >= 60 ? 'ambar' : 'verde'}>{pct}%</Badge>
        </td>
        <td className="px-3 py-2 text-right">
          <div className="flex justify-end gap-1">
            <Button variante="fantasma" icon={List} onClick={onVer}>
              Ver IPs
            </Button>
            <Button
              variante="fantasma"
              icon={Trash2}
              title="Borrar el pool y sus direcciones"
              onClick={async () => {
                const entregadas = (pool.usadas ?? 0) + (pool.reservadas ?? 0)
                const texto = entregadas
                  ? `El pool ${pool.cidr} tiene ${entregadas} direcciones entregadas. Borrarlo se las lleva puestas. ¿Seguir igual?`
                  : `¿Borrar el pool ${pool.cidr} y sus ${pool.total} direcciones?`
                if (await confirmar(texto)) onBorrar(entregadas > 0)
              }}
            />
          </div>
        </td>
      </tr>

      {abierto && (
        <tr>
          <td colSpan={9} className="bg-slate-900/60 px-3 py-3">
            {ips === null ? (
              <p className="text-xs text-slate-500">Cargando las direcciones…</p>
            ) : (
              <ListaIps ips={ips} />
            )}
          </td>
        </tr>
      )}
    </>
  )
}

const COLOR_ESTADO = {
  libre: 'text-slate-500',
  asignada: 'text-emerald-300',
  reservada: 'text-amber-300',
}

function ListaIps({ ips }) {
  const [soloOcupadas, setSoloOcupadas] = useState(true)

  // Por defecto se muestran solo las tomadas: un /24 son 253 chips y lo que uno
  // busca al desplegar es quién tiene qué, no la lista de las que faltan.
  const visibles = soloOcupadas ? ips.ips.filter((i) => i.estado !== 'libre') : ips.ips

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
        <span>{ips.total} direcciones</span>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={soloOcupadas}
            onChange={(e) => setSoloOcupadas(e.target.checked)}
          />
          solo las tomadas
        </label>
      </div>

      {visibles.length === 0 ? (
        <p className="text-xs text-slate-500">
          {soloOcupadas ? 'Ninguna entregada todavía.' : 'El pool está vacío.'}
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {visibles.map((i) => (
            <span
              key={i.id}
              title={
                i.onu
                  ? `${i.onu.sn} · ${i.onu.donde}${i.onu.nombre ? ` · ${i.onu.nombre}` : ''}`
                  : i.estado
              }
              className={`rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] ${COLOR_ESTADO[i.estado] ?? ''}`}
            >
              {i.ip_address}
              {i.onu && <span className="ml-1 text-slate-500">{i.onu.donde}</span>}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Alta de un pool.
 *
 * El rango se revisa contra el servidor antes de guardar, y no en el navegador:
 * es la misma cuenta que después decide qué filas se crean, y tenerla en dos
 * lados es tenerla distinta el día que una cambie.
 */
function FormularioPool({ olt, proposito, vlans, onListo, onCancelar }) {
  const [form, setForm] = useState({
    cidr: '',
    desde: '',
    hasta: '',
    gateway: '',
    dns1: '8.8.8.8',
    dns2: '8.8.4.4',
    vlan: '',
    nombre: '',
  })
  const [revision, setRevision] = useState(null)
  const [error, setError] = useState(null)
  const [guardando, setGuardando] = useState(false)
  const [todasLasVlans, setTodasLasVlans] = useState(false)

  const usoEsperado = USO_ESPERADO[proposito]
  const delUso = vlans.filter((v) => v.uso === usoEsperado)
  const hayDelUso = delUso.length > 0
  const opcionesVlan = !hayDelUso || todasLasVlans ? vlans : delUso

  const set = (campo) => (e) => {
    setForm((f) => ({ ...f, [campo]: e.target.value }))
    setRevision(null)
  }

  /** Completa el rango con todo lo que entra en el CIDR. */
  async function todoElBloque() {
    setError(null)
    try {
      const r = await api.olt.revisarPoolIp(olt.id, { cidr: form.cidr })
      setForm((f) => ({
        ...f,
        desde: r.bloque.desde,
        hasta: r.bloque.hasta,
        // El gateway se propone, no se impone: la primera del bloque es la
        // convención más común pero no la única.
        gateway: f.gateway || r.bloque.desde,
      }))
      setRevision(null)
    } catch (err) {
      setError(err)
    }
  }

  async function revisar() {
    setError(null)
    try {
      setRevision(await api.olt.revisarPoolIp(olt.id, form))
    } catch (err) {
      setError(err)
      setRevision(null)
    }
  }

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setError(null)
    try {
      await api.olt.crearPoolIp(olt.id, { ...form, proposito })
      onListo()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <form onSubmit={guardar} className="space-y-4">
      <Button type="button" variante="fantasma" icon={ArrowLeft} onClick={onCancelar}>
        Volver a los pools
      </Button>

      <div>
        <h3 className="text-sm font-semibold text-slate-100">
          Nuevo pool de {proposito === 'wan_onu' ? 'WAN estática' : 'gestión'}
        </h3>
        <p className="mt-0.5 text-xs text-slate-500">En {olt.nombre}</p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Red (CIDR)" hint="el bloque completo, como 10.100.0.0/20" className="sm:col-span-2">
          <Input
            value={form.cidr}
            onChange={set('cidr')}
            placeholder="10.100.0.0/20"
            spellCheck={false}
            required
          />
        </Field>

        <Field
          label="Desde"
          hint="primera dirección que el pool entrega"
        >
          <Input value={form.desde} onChange={set('desde')} placeholder="10.100.0.2" spellCheck={false} />
        </Field>
        <Field label="Hasta" hint="última">
          <Input value={form.hasta} onChange={set('hasta')} placeholder="10.100.15.254" spellCheck={false} />
        </Field>

        <div className="sm:col-span-2">
          <Button type="button" icon={Wand2} disabled={!form.cidr.trim()} onClick={todoElBloque}>
            Usar todo el bloque
          </Button>
          <p className="mt-1 text-[11px] text-slate-500">
            Las direcciones que ya existan en ese bloque no se duplican, así que se puede volver a
            guardar para ampliar un rango sin perder lo asignado.
          </p>
        </div>

        <Field label="Gateway" hint="no se reparte: se descuenta del pool">
          <Input value={form.gateway} onChange={set('gateway')} placeholder="10.100.0.1" spellCheck={false} />
        </Field>

        {/* --- La VLAN ---
            Solo las declaradas para este uso. Ofrecer la de los abonados para
            un pool de gestión es invitar a que la ONT termine con su IP de
            administración en la VLAN de los clientes.

            Si no hay ninguna del uso correcto NO se deja el desplegable vacío:
            se ofrecen todas con el aviso puesto. Trabar el formulario por un
            dato administrativo que nadie cargó es peor que dejar elegir mal
            avisando. */}
        <Field
          label="VLAN"
          hint={
            hayDelUso
              ? `solo las declaradas como ${ETIQUETA_USO[usoEsperado]}`
              : 'se preselecciona al asignarle una IP a una ONU'
          }
        >
          <Select value={form.vlan} onChange={set('vlan')}>
            <option value="">— sin VLAN —</option>
            {opcionesVlan.map((v) => (
              <option key={v.vlan} value={v.vlan}>
                {v.vlan}
                {v.descripcion ? ` · ${v.descripcion}` : ''}
              </option>
            ))}
          </Select>

          {hayDelUso && vlans.length > opcionesVlan.length && (
            <button
              type="button"
              onClick={() => setTodasLasVlans(!todasLasVlans)}
              className="mt-1 text-[11px] text-slate-500 underline hover:text-slate-300"
            >
              {todasLasVlans
                ? `mostrar solo las de ${ETIQUETA_USO[usoEsperado]}`
                : `ver las ${vlans.length - opcionesVlan.length} restantes`}
            </button>
          )}

          {!hayDelUso && vlans.length > 0 && (
            <p className="mt-1 text-[11px] leading-snug text-amber-400/80">
              Ninguna VLAN de esta OLT está declarada como{' '}
              <b>{ETIQUETA_USO[usoEsperado]}</b>, así que se muestran todas. Conviene marcarla en{' '}
              <b>VLANs</b> antes: una VLAN de abonados usada para gestión mezcla el tráfico de
              administración con el de los clientes.
            </p>
          )}
        </Field>

        <Field label="DNS primario">
          <Input value={form.dns1} onChange={set('dns1')} placeholder="8.8.8.8" spellCheck={false} />
        </Field>
        <Field label="DNS secundario">
          <Input value={form.dns2} onChange={set('dns2')} placeholder="8.8.4.4" spellCheck={false} />
        </Field>

        <Field label="Nombre" hint="opcional; si se deja vacío se arma solo" className="sm:col-span-2">
          <Input value={form.nombre} onChange={set('nombre')} placeholder="Gestión ONUs VLAN 999" />
        </Field>
      </div>

      {/* Cuántas filas se van a crear, antes de crearlas. Un /20 son cuatro mil
          y es mejor verlo antes que después. */}
      {revision && (
        <Aviso>
          Se van a cargar <b>{revision.a_crear}</b> direcciones, de {revision.desde} a{' '}
          {revision.hasta}.
          {revision.gateway && revision.a_crear < revision.total && (
            <> El gateway {revision.gateway} queda fuera del reparto.</>
          )}
        </Aviso>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={revisar} disabled={!form.cidr.trim()}>
          Ver cuántas son
        </Button>
        <Button type="submit" variante="primario" icon={Save} cargando={guardando}>
          Guardar
        </Button>
        <Button type="button" variante="fantasma" onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}

/**
 * Lo que se encontró en los equipos, antes de escribir nada.
 *
 * Las direcciones repetidas se muestran aparte y NO se importan. Dos ONTs con
 * la misma IP de gestión no dan error en ningún lado: las dos le contestan al
 * ACS y ninguna configuración llega a destino. Elegir una en silencio
 * escondería justamente el problema que hay que ver.
 */
function PanelImportacion({ datos, trabajando, onAplicar, onCerrar }) {
  const r = datos.resumen
  const problemas = datos.filas.filter((f) => f.estado !== 'se_importa' && f.estado !== 'sin_ip')

  return (
    <div className="space-y-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
      <p className="text-sm font-semibold text-sky-200">Lo que las ONTs ya tienen puesto</p>

      <p className="text-xs text-sky-200/80">
        {r.onts_leidas} ONTs leídas · {r.con_ip} con IP de gestión · <b>{r.se_importan} se traen</b>
        {r.sin_ip > 0 && ` · ${r.sin_ip} sin IP`}
        {r.sin_pool > 0 && ` · ${r.sin_pool} fuera de todo pool`}
        {r.repetidas > 0 && ` · ${r.repetidas} repetidas`}
        {r.con_error > 0 && ` · ${r.con_error} no se pudieron leer`}
      </p>

      {r.repetidas > 0 && (
        <Aviso tipo="alerta">
          Hay {r.repetidas} dirección(es) puesta(s) en más de una ONT. No se importan: dos equipos
          con la misma IP de gestión responden los dos al ACS y ninguna configuración llega. Hay que
          corregirlo en el equipo.
        </Aviso>
      )}

      {r.sin_pool > 0 && (
        <Aviso tipo="alerta">
          {r.sin_pool} ONT(s) tienen una dirección que no cae en ningún pool cargado. Creá el pool de
          ese bloque y volvé a traer, o van a quedar fuera del control del sistema.
        </Aviso>
      )}

      {problemas.length > 0 && (
        <div className="max-h-56 overflow-y-auto rounded border border-slate-800">
          <table className="w-full text-xs">
            <tbody>
              {problemas.map((f) => (
                <tr key={`${f.sn}-${f.donde}`} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-2 py-1 font-mono text-slate-300">{f.donde}</td>
                  <td className="px-2 py-1 font-mono text-slate-400">{f.sn}</td>
                  <td className="px-2 py-1 font-mono text-slate-100">{f.ip ?? '—'}</td>
                  <td className="px-2 py-1 text-amber-400">{f.motivo}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variante="primario"
          icon={Download}
          cargando={trabajando}
          disabled={!r.se_importan}
          onClick={onAplicar}
        >
          Traer {r.se_importan}
        </Button>
        <Button variante="fantasma" onClick={onCerrar}>
          Cancelar
        </Button>
      </div>

      <p className="text-[11px] text-slate-500">
        Esto <b>no toca la OLT</b>: solo marca en el sistema las direcciones que los equipos ya
        tienen, para que ningún alta las vuelva a entregar.
      </p>
    </div>
  )
}
