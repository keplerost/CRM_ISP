import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Activity, Cloud, Plus, RefreshCw, Search, Send, Server } from 'lucide-react'
import { api } from '../lib/apiNetwork'
import {
  Aviso,
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Punto,
  Select,
  SkeletonTabla,
  Stat,
  Table,
  Tabs,
} from '../components/ui'

/**
 * TR-069 de todo el padrón.
 *
 * ── Por qué es una pantalla propia y no una pestaña de cada OLT ──
 *
 * Un ACS sirve a todas las OLTs, no a una. Definir el mismo perfil equipo por
 * equipo es cómo se llega a que La Maná apunte a una dirección y el Progreso a
 * otra que quedó vieja, sin que nadie se entere hasta que media zona deja de
 * verse. Acá el perfil se define una vez y se aplica a las OLTs que se elijan.
 *
 * Nada de esto se guarda en la base: los perfiles viven dentro de cada equipo y
 * esta pantalla los junta al leerlos. El número de perfil puede ser distinto en
 * cada OLT y no importa — lo que los identifica como "el mismo" es a qué ACS
 * apuntan.
 */

const TABS = [
  { clave: 'perfiles', label: 'Perfiles TR-069', icon: Cloud },
  { clave: 'estado', label: 'Estado', icon: Activity },
]

export default function Tr069Page() {
  const [params, setParams] = useSearchParams()
  const activa = params.get('tab') ?? 'perfiles'

  return (
    <div className="space-y-5">
      <div>
        <h1 className="t-titulo text-lg font-bold text-slate-100">TR-069</h1>
        <p className="text-xs text-slate-500">
          Un servidor de gestión para todas las OLTs. Los perfiles se leen del equipo cada vez: acá
          no hay copia que pueda quedar vieja.
        </p>
      </div>

      <Tabs tabs={TABS} activa={activa} onCambiar={(c) => setParams({ tab: c }, { replace: true })} />

      {activa === 'perfiles' ? <Perfiles /> : <Estado />}
    </div>
  )
}

/* ── Perfiles ─────────────────────────────────────────────────────────────── */

function Perfiles() {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [nuevo, setNuevo] = useState(false)
  const [aplicar, setAplicar] = useState(null)

  const cargar = useCallback(async () => {
    setCargando(true)
    setError(null)
    try {
      setDatos(await api.tr069.perfiles())
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    cargar()
  }, [cargar])

  const olts = datos?.olts ?? []
  const conFalla = olts.filter((o) => o.error)

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {datos?.nuestroAcs && <NuestroAcs acs={datos.nuestroAcs} />}

      {conFalla.length > 0 && (
        <Aviso tipo="alerta">
          No se pudo leer {conFalla.length === 1 ? 'una OLT' : `${conFalla.length} OLTs`}:{' '}
          {conFalla.map((o) => `${o.nombre} (${o.error})`).join(' · ')}. Lo de abajo es lo que
          contestaron las demás.
        </Aviso>
      )}

      <Card
        title="Perfiles definidos"
        subtitle="Agrupados por el ACS al que apuntan. Dos perfiles con el mismo nombre y distinta dirección son dos perfiles distintos."
        icon={Cloud}
        actions={
          <div className="flex gap-2">
            <Button icon={RefreshCw} cargando={cargando} onClick={cargar}>
              Releer los equipos
            </Button>
            <Button icon={Plus} onClick={() => setNuevo(true)}>
              Nuevo perfil
            </Button>
          </div>
        }
      >
        {!datos ? (
          <SkeletonTabla filas={2} columnas={5} />
        ) : (
          <Table
            columnas={['Perfil', 'ACS', 'Alcance', 'OLTs', 'ONT', '']}
            filas={datos.perfiles}
            vacio="Ninguna OLT tiene perfiles TR-069. Sin uno, ninguna ONT sabe a dónde reportar."
            renderFila={(p) => (
              <tr key={p.url} className="align-top text-slate-300">
                <td className="px-3 py-2">
                  <span className="font-medium text-slate-100">{p.nombre}</span>
                  {p.nombresDistintos && (
                    <div className="mt-1">
                      <Badge color="ambar">se llama distinto en cada OLT</Badge>
                    </div>
                  )}
                  {p.usuario && (
                    <div className="text-[11px] text-slate-500">
                      usuario {p.usuario}
                      {p.conClave && ' · con clave'}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{p.url}</td>
                <td className="px-3 py-2">
                  {/* "Alcanzable desde el servidor", no "las ONT llegan": son dos
                      preguntas distintas y confundirlas manda a buscar el
                      problema del lado equivocado. */}
                  {p.acs?.ok ? (
                    <Badge color="verde">responde · {p.acs.ms} ms</Badge>
                  ) : (
                    <span title={p.acs?.motivo}>
                      <Badge color="ambar">sin respuesta</Badge>
                    </span>
                  )}
                  <div className="text-[10px] text-slate-600">desde el servidor</div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-1">
                    {p.enOlts.map((o) => (
                      <span key={o.oltId} className="text-xs">
                        {o.olt}{' '}
                        <span className="font-mono text-[10px] text-slate-600">#{o.profileId}</span>
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2">
                  {p.ontsTotal > 0 ? <Badge color="verde">{p.ontsTotal}</Badge> : <Badge>0</Badge>}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button onClick={() => setAplicar(p)}>Aplicar a otra OLT</Button>
                </td>
              </tr>
            )}
          />
        )}
      </Card>

      {olts.length > 0 && (
        <Card title="OLTs del padrón" subtitle="A cuántas alcanza este servidor de gestión." icon={Server}>
          <div className="flex flex-wrap gap-2">
            {olts.map((o) => (
              <span
                key={o.id}
                className="flex items-center gap-2 rounded-lg border border-slate-800 px-3 py-1.5 text-sm text-slate-300"
              >
                <Punto estado={o.error ? 'offline' : 'online'} />
                {o.nombre}
                <Badge color={o.marca === 'Huawei' ? 'rojo' : 'azul'}>{o.marca}</Badge>
              </span>
            ))}
          </div>
        </Card>
      )}

      <FormPerfil
        abierto={nuevo || Boolean(aplicar)}
        base={aplicar}
        olts={olts}
        perfiles={datos?.perfiles ?? []}
        onCerrar={() => {
          setNuevo(false)
          setAplicar(null)
        }}
        alCrear={() => {
          setNuevo(false)
          setAplicar(null)
          cargar()
        }}
      />
    </div>
  )
}

/** El ACS del propio sistema, para comparar contra lo que está escrito en las OLTs. */
const NuestroAcs = ({ acs }) => (
  <div className="flex flex-wrap items-center gap-4 t-card px-4 py-3">
    <span className="text-xs uppercase tracking-wide text-slate-500">Nuestro ACS</span>
    {acs.configurado ? (
      <>
        <span className="font-mono text-xs text-slate-300">{acs.url}</span>
        <span className="text-sm text-slate-300">
          {acs.equipos} equipo{acs.equipos === 1 ? '' : 's'} · {acs.activos} activos
        </span>
      </>
    ) : (
      <span className="text-sm text-amber-400">
        Sin configurar. Falta <code className="font-mono text-xs">GENIEACS_URL</code> en el
        middleware.
      </span>
    )}
  </div>
)

/* ── Crear / aplicar un perfil ────────────────────────────────────────────── */

/**
 * El mismo formulario sirve para crear uno nuevo y para llevar uno existente a
 * otra OLT: en los dos casos el resultado es la misma línea escrita en un
 * equipo. Separarlos en dos pantallas haría que la de "aplicar" tuviera que
 * repetir todas las validaciones de la otra.
 */
function FormPerfil({ abierto, base, olts, perfiles, onCerrar, alCrear }) {
  const [datos, setDatos] = useState({ nombre: '', url: '', usuario: '', clave: '' })
  const [elegidas, setElegidas] = useState({})
  const [error, setError] = useState(null)
  const [guardando, setGuardando] = useState(false)
  const [resultados, setResultados] = useState(null)

  useEffect(() => {
    if (!abierto) return
    setError(null)
    setResultados(null)
    setDatos({
      nombre: base?.nombre ?? '',
      url: base?.url ?? '',
      usuario: base?.usuario ?? '',
      clave: '',
    })

    // Las OLTs que YA lo tienen vienen desmarcadas y bloqueadas: volver a
    // crearlo ahí sería un rechazo del equipo, no un cambio.
    const yaLoTienen = new Set((base?.enOlts ?? []).map((o) => o.oltId))
    const inicial = {}
    for (const o of olts) {
      if (o.error || yaLoTienen.has(o.id)) continue
      inicial[o.id] = { marcada: false, profileId: sugerirNumero(o.id, perfiles) }
    }
    setElegidas(inicial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierto, base])

  const yaLoTienen = new Set((base?.enOlts ?? []).map((o) => o.oltId))
  const marcadas = Object.entries(elegidas).filter(([, v]) => v.marcada)

  async function guardar() {
    setGuardando(true)
    setError(null)
    try {
      const r = await api.tr069.crearPerfil({
        nombre: datos.nombre,
        url: datos.url.trim(),
        usuario: datos.usuario || undefined,
        clave: datos.clave || undefined,
        olts: marcadas.map(([oltId, v]) => ({ oltId, profileId: Number(v.profileId) })),
      })
      setResultados(r.resultados)
      if (r.fallaron === 0) alCrear()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <Modal
      abierto={abierto}
      titulo={base ? `Llevar "${base.nombre}" a otra OLT` : 'Nuevo perfil TR-069'}
      onCerrar={onCerrar}
      ancho="max-w-2xl"
    >
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nombre">
            <Input
              placeholder="GenieACS"
              value={datos.nombre}
              onChange={(e) => setDatos({ ...datos, nombre: e.target.value })}
            />
          </Field>
          <Field label="URL del ACS" hint="Tiene que ser alcanzable desde la red de gestión de las ONT.">
            <Input
              placeholder="http://192.168.55.254:7547"
              value={datos.url}
              onChange={(e) => setDatos({ ...datos, url: e.target.value })}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Usuario" hint="Solo si el ACS lo pide. GenieACS por defecto no.">
            <Input
              value={datos.usuario}
              onChange={(e) => setDatos({ ...datos, usuario: e.target.value })}
            />
          </Field>
          <Field label="Clave">
            <Input
              type="password"
              value={datos.clave}
              onChange={(e) => setDatos({ ...datos, clave: e.target.value })}
            />
          </Field>
        </div>

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">
            En qué OLTs crearlo
          </div>
          <div className="space-y-2">
            {olts.map((o) => {
              const loTiene = yaLoTienen.has(o.id)
              const v = elegidas[o.id]
              return (
                <div
                  key={o.id}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 px-3 py-2"
                >
                  <input
                    type="checkbox"
                    disabled={loTiene || Boolean(o.error) || !v}
                    checked={Boolean(v?.marcada)}
                    onChange={(e) =>
                      setElegidas({ ...elegidas, [o.id]: { ...v, marcada: e.target.checked } })
                    }
                  />
                  <span className="text-sm text-slate-200">{o.nombre}</span>
                  <Badge color={o.marca === 'Huawei' ? 'rojo' : 'azul'}>{o.marca}</Badge>

                  {loTiene ? (
                    <Badge color="verde">ya lo tiene</Badge>
                  ) : o.error ? (
                    <Badge color="ambar">no se pudo leer</Badge>
                  ) : (
                    <label className="ml-auto flex items-center gap-2 text-xs text-slate-500">
                      número de perfil
                      <Input
                        type="number"
                        className="w-20"
                        value={v?.profileId ?? ''}
                        onChange={(e) =>
                          setElegidas({
                            ...elegidas,
                            [o.id]: { ...v, profileId: e.target.value },
                          })
                        }
                      />
                    </label>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <Aviso tipo="alerta">
          Crear el perfil <b>no mueve ninguna ONT</b>. Recién cuando apuntes una, esa ONT deja de
          hablar con el ACS anterior.
        </Aviso>

        {resultados && (
          <div className="space-y-1 rounded-lg border border-slate-800 p-3 text-sm">
            {resultados.map((r) => (
              <div key={r.oltId} className={r.ok ? 'text-emerald-400' : 'text-amber-400'}>
                {r.ok ? '✓' : '✗'} {r.olt ?? r.oltId}
                {r.ok ? ` · perfil #${r.perfil.id}` : ` · ${r.error}`}
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button onClick={onCerrar}>Cerrar</Button>
          <Button
            icon={Plus}
            cargando={guardando}
            disabled={!datos.nombre || !datos.url || marcadas.length === 0}
            onClick={guardar}
          >
            Crear en {marcadas.length} {marcadas.length === 1 ? 'OLT' : 'OLTs'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Propone un número de perfil libre para esa OLT.
 *
 * El número es la posición dentro del equipo y el equipo rechaza uno repetido
 * en vez de pisarlo. Se sugiere el primero libre para que nadie tenga que ir a
 * mirar cuáles hay, pero se deja editable: quien sepa que quiere el 7, pone 7.
 */
function sugerirNumero(oltId, perfiles) {
  const usados = new Set()
  for (const p of perfiles) {
    for (const o of p.enOlts) if (o.oltId === oltId) usados.add(o.profileId)
  }
  for (let i = 1; i <= 20; i++) if (!usados.has(i)) return String(i)
  return ''
}

/* ── Estado ───────────────────────────────────────────────────────────────── */

function Estado() {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [cargando, setCargando] = useState(false)

  const cargar = useCallback(async () => {
    setCargando(true)
    setError(null)
    try {
      setDatos(await api.tr069.estado())
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    cargar()
  }, [cargar])

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />
      {datos?.nuestroAcs && <NuestroAcs acs={datos.nuestroAcs} />}

      <Card
        title="Estado por OLT"
        subtitle="Tres números que no son el mismo: tener perfil no es tener IP de gestión, y las dos juntas no son estar hablando."
        icon={Activity}
        actions={
          <Button icon={RefreshCw} cargando={cargando} onClick={cargar}>
            Releer los equipos
          </Button>
        }
      >
        {!datos ? (
          <SkeletonTabla filas={2} columnas={4} />
        ) : (
          <div className="space-y-3">
            {datos.olts.map((o) => (
              <div key={o.id} className="rounded-xl border border-slate-800 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <Punto estado={o.error ? 'offline' : 'online'} />
                  <span className="font-medium text-slate-100">{o.nombre}</span>
                  <Badge color={o.marca === 'Huawei' ? 'rojo' : 'azul'}>{o.marca}</Badge>
                </div>

                {o.error ? (
                  <p className="text-sm text-amber-400">{o.error}</p>
                ) : (
                  <>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Stat label="Perfiles" valor={o.perfiles?.length ?? 0} />
                      <Stat label="ONT apuntadas" valor={o.ontsConPerfil ?? 0} />
                      <Stat
                        label="ONT con IP de gestión"
                        valor={o.ontsConIpDeGestion ?? 0}
                        color="text-amber-400"
                      />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(o.perfiles ?? []).map((p) => (
                        <span
                          key={p.id}
                          className="rounded-lg border border-slate-800 px-2.5 py-1 text-xs text-slate-400"
                        >
                          #{p.id} {p.nombre} · <b className="text-slate-200">{p.onts}</b> ONT
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <ConsultarOnt olts={datos?.olts ?? []} />
    </div>
  )
}

/** Consulta y cambia el TR-069 de una ONT, en cualquiera de las OLTs. */
function ConsultarOnt({ olts }) {
  const [donde, setDonde] = useState({ oltId: '', frame: 0, slot: '', puerto: '', onuId: '' })
  const [estado, setEstado] = useState(null)
  const [error, setError] = useState(null)
  const [buscando, setBuscando] = useState(false)
  const [moviendo, setMoviendo] = useState(false)
  const [destino, setDestino] = useState('')
  const [hecho, setHecho] = useState(null)

  const oltElegida = olts.find((o) => o.id === donde.oltId)
  const perfiles = oltElegida?.perfiles ?? []
  const completo = donde.oltId && donde.slot !== '' && donde.puerto !== '' && donde.onuId !== ''

  async function consultar() {
    setBuscando(true)
    setError(null)
    setEstado(null)
    setHecho(null)
    try {
      const r = await api.tr069.ont(donde)
      setEstado(r)
      setDestino(String(r.perfilId ?? ''))
    } catch (err) {
      setError(err)
    } finally {
      setBuscando(false)
    }
  }

  async function mover() {
    setMoviendo(true)
    setError(null)
    try {
      setHecho(await api.tr069.asignar({ ...donde, profileId: Number(destino) }))
      await consultar()
    } catch (err) {
      setError(err)
    } finally {
      setMoviendo(false)
    }
  }

  return (
    <Card
      title="Estado TR-069 de una ONT"
      subtitle="Se lo pregunta al equipo en vivo: qué perfil tiene, qué IP le escribimos y cuál reporta ella."
      icon={Search}
    >
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        <div className="grid gap-3 sm:grid-cols-6">
          <Field label="OLT" className="sm:col-span-2">
            <Select
              value={donde.oltId}
              onChange={(e) => setDonde({ ...donde, oltId: e.target.value })}
            >
              <option value="">Elegí…</option>
              {olts
                .filter((o) => !o.error)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.nombre}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Slot">
            <Input
              type="number"
              placeholder="6"
              value={donde.slot}
              onChange={(e) => setDonde({ ...donde, slot: e.target.value })}
            />
          </Field>
          <Field label="Puerto">
            <Input
              type="number"
              placeholder="9"
              value={donde.puerto}
              onChange={(e) => setDonde({ ...donde, puerto: e.target.value })}
            />
          </Field>
          <Field label="ONT-ID">
            <Input
              type="number"
              placeholder="17"
              value={donde.onuId}
              onChange={(e) => setDonde({ ...donde, onuId: e.target.value })}
            />
          </Field>
          <Field label="&nbsp;">
            <Button icon={Search} cargando={buscando} disabled={!completo} onClick={consultar}>
              Consultar
            </Button>
          </Field>
        </div>

        {estado && (
          <div className="space-y-3">
            <div className="t-card p-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Dato label="Estado" valor={estado.estado} />
                <Dato
                  label="Perfil TR-069"
                  valor={
                    estado.perfilId != null
                      ? `${estado.perfilId} · ${estado.perfilNombre ?? ''}`
                      : 'ninguno'
                  }
                />
                <Dato label="IP que le escribimos" valor={estado.ipConfigurada ?? '—'} />
                <Dato
                  label="IP que la ONT reporta"
                  valor={estado.ipViva ?? 'no reporta'}
                  alerta={!estado.ipViva}
                />
                <Dato label="VLAN de gestión" valor={estado.vlanGestion ?? '—'} />
                <Dato label="Prioridad" valor={estado.prioridad ?? '—'} />
                <Dato
                  label="Gestión habilitada"
                  valor={estado.gestionHabilitada ? 'sí' : 'no'}
                  alerta={!estado.gestionHabilitada}
                />
                <Dato
                  label="MAC en la VLAN de gestión"
                  valor={
                    estado.macsEnGestion == null
                      ? 'sin comprobar'
                      : estado.macsEnGestion > 0
                        ? `${estado.macsEnGestion} — está hablando`
                        : 'ninguna ahora (la tabla envejece)'
                  }
                />
              </div>
            </div>

            {/* Tres estados, no dos. El tercero —"no lo sé"— existía antes como
                un "sí" implícito, y así una ONT que el ACS nunca vio figuraba
                lista. */}
            <Aviso tipo={estado.diagnostico?.lista === true ? 'info' : 'alerta'}>
              {estado.diagnostico?.lista === true
                ? '✓ '
                : estado.diagnostico?.lista === false
                  ? '✗ '
                  : '? '}
              {estado.diagnostico?.motivo}
            </Aviso>

            {perfiles.length > 0 && (
              <div className="flex flex-wrap items-end gap-3">
                <Field
                  label="Apuntar esta ONT a"
                  hint="Una ONT habla con un ACS a la vez: cambiarla la saca del anterior."
                >
                  <Select value={destino} onChange={(e) => setDestino(e.target.value)}>
                    <option value="">Elegí un perfil…</option>
                    {perfiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id} · {p.nombre} — {p.url}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button
                  icon={Send}
                  cargando={moviendo}
                  disabled={!destino || Number(destino) === estado.perfilId}
                  onClick={mover}
                >
                  Aplicar
                </Button>
              </div>
            )}

            {hecho && (
              <Aviso>
                Movida del perfil <b>{hecho.perfilAnterior ?? 'ninguno'}</b> al{' '}
                <b>
                  {hecho.perfil} · {hecho.perfilNombre}
                </b>
                . Para volver atrás, elegí el {hecho.perfilAnterior ?? '—'} y aplicá de nuevo.
              </Aviso>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

const Dato = ({ label, valor, alerta = false }) => (
  <div>
    <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
    <div className={`text-sm ${alerta ? 'text-amber-400' : 'text-slate-100'}`}>{valor}</div>
  </div>
)
