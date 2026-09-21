import { useCallback, useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { Link } from 'react-router-dom'
import { Gauge, Plus, RefreshCw, Tag, Trash2, TriangleAlert } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import {
  Aviso,
  Badge,
  Button,
  Card,
  Cargando,
  ErrorBanner,
  Field,
  Input,
  Table,
} from '../../components/ui'

/**
 * Los perfiles de velocidad que viven dentro de las OLTs.
 *
 * Una "traffic table" es lo que el equipo aplica de verdad para limitar a un
 * abonado. Hasta ahora se cargaban a mano en el plan escribiendo un número, y
 * así quedaron dos planes apuntando a tablas que no existían y uno apuntando a
 * la de 1 Gbps mientras vendía 100 megas.
 *
 * Dos cosas que la pantalla deja claras porque son la fuente de esos errores:
 *
 *   - Van de a PARES. El equipo aplica una tabla por sentido; con una sola, el
 *     abonado termina con su velocidad de bajada también en la subida.
 *   - El índice es de CADA equipo. Por eso se crean con el mismo número en
 *     todas las OLTs elegidas: así el plan guarda un par de números y vale para
 *     toda la red.
 */
export default function VelocidadesPage() {
  const confirmar = useConfirmar()
  const [olts, setOlts] = useState([])
  const [elegidas, setElegidas] = useState([])
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [leyendo, setLeyendo] = useState(false)
  const [nueva, setNueva] = useState(null)
  const [creando, setCreando] = useState(false)
  const [resultado, setResultado] = useState(null)
  // Ponerle precio a un par de tablas que ya existe. Es el camino que faltaba:
  // en una red andando, las tablas están desde hace años y lo único que falta
  // es el nombre comercial y el precio.
  const [aVender, setAVender] = useState(null)
  const [vendiendo, setVendiendo] = useState(false)
  const [planCreado, setPlanCreado] = useState(null)

  useEffect(() => {
    supabase
      .from('olts')
      .select('id, nombre, numero')
      .eq('activo', true)
      .order('numero')
      .then(({ data }) => {
        setOlts(data ?? [])
        setElegidas((data ?? []).map((o) => o.id))
      })
  }, [])

  const leer = useCallback(async () => {
    if (!elegidas.length) return
    setLeyendo(true)
    setError(null)
    try {
      setDatos(await api.olt.velocidades(elegidas))
    } catch (err) {
      setError(err)
    } finally {
      setLeyendo(false)
    }
  }, [elegidas])

  async function crear() {
    setCreando(true)
    setError(null)
    setResultado(null)
    try {
      const r = await api.olt.crearVelocidad({
        olt_ids: elegidas,
        nombre: nueva.nombre,
        bajada_kbps: Math.round(Number(nueva.bajada) * 1000),
        subida_kbps: Math.round(Number(nueva.subida) * 1000),
      })
      setResultado(r)
      setNueva(null)
      await leer()
    } catch (err) {
      setError(err)
    } finally {
      setCreando(false)
    }
  }

  async function crearPlan() {
    setVendiendo(true)
    setError(null)
    try {
      const r = await api.olt.crearPlanDesdeTablas(aVender.olt_id, {
        nombre: aVender.nombre_plan,
        precio: aVender.precio,
        bajada: aVender.traffic_table_bajada,
        subida: aVender.traffic_table_subida,
      })
      setPlanCreado(r)
      setAVender(null)
    } catch (err) {
      setError(err)
    } finally {
      setVendiendo(false)
    }
  }

  const alternar = (id) =>
    setElegidas((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Perfiles de velocidad</h1>
          <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-slate-500">
            Las traffic tables que viven dentro de cada OLT. Son las que limitan de verdad al
            abonado: el plan solo guarda a cuál apunta y le pone el precio.
          </p>
        </div>
        <div className="flex gap-2">
          <Button icon={RefreshCw} cargando={leyendo} onClick={leer} disabled={!elegidas.length}>
            Leer de los equipos
          </Button>
          <Button
            variante="primario"
            icon={Plus}
            disabled={!elegidas.length}
            onClick={() => setNueva({ nombre: '', bajada: '', subida: '' })}
          >
            Nuevo perfil
          </Button>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <Card title="En qué OLTs">
        <div className="flex flex-wrap gap-2">
          {olts.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => alternar(o.id)}
              className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                elegidas.includes(o.id)
                  ? 'border-sky-500/50 bg-sky-500/10 text-sky-200'
                  : 'border-slate-700 text-slate-400 hover:border-slate-600'
              }`}
            >
              {o.numero ? `${o.numero} · ` : ''}
              {o.nombre}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-snug text-slate-500">
          Un perfil se crea con el <b>mismo índice en todas las elegidas</b>. Así el plan guarda un
          par de números y vale para toda la red; con índices distintos por equipo, cada alta
          tendría que averiguar en cuál está.
        </p>
      </Card>

      {nueva && (
        <Card title="Nuevo perfil de velocidad" icon={Gauge}>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Nombre" hint="se le agrega -DOWN y -UP">
              <Input
                value={nueva.nombre}
                onChange={(e) => setNueva({ ...nueva, nombre: e.target.value })}
                placeholder="PLAN_100M"
              />
            </Field>
            <Field label="Bajada (Mbps)">
              <Input
                type="number"
                value={nueva.bajada}
                onChange={(e) => setNueva({ ...nueva, bajada: e.target.value })}
                placeholder="100"
              />
            </Field>
            <Field label="Subida (Mbps)">
              <Input
                type="number"
                value={nueva.subida}
                onChange={(e) => setNueva({ ...nueva, subida: e.target.value })}
                placeholder="10"
              />
            </Field>
          </div>

          <p className="mt-2 text-[11px] leading-snug text-slate-500">
            Se crean <b>dos</b> tablas, una por sentido, con índices consecutivos libres en todas
            las OLTs elegidas. El equipo aplica una por dirección: con una sola, el abonado termina
            con su velocidad de bajada también en la subida.
          </p>

          <div className="mt-3 flex gap-2">
            <Button
              variante="primario"
              icon={Plus}
              cargando={creando}
              disabled={!nueva.nombre?.trim() || !nueva.bajada || !nueva.subida}
              onClick={crear}
            >
              Crear en {elegidas.length} OLT{elegidas.length === 1 ? '' : 's'}
            </Button>
            <Button variante="fantasma" onClick={() => setNueva(null)}>
              Cancelar
            </Button>
          </div>
        </Card>
      )}

      {resultado && (
        <Aviso tipo={resultado.completo ? 'info' : 'alerta'}>
          {resultado.completo ? (
            <>
              <b>{resultado.nombre}</b> creado. Bajada en el índice{' '}
              <b>{resultado.traffic_table_bajada}</b>, subida en el{' '}
              <b>{resultado.traffic_table_subida}</b>. Ya se puede elegir desde un plan.
            </>
          ) : (
            <>
              <b>Quedó a medias.</b> Un perfil que existe en unas OLTs y en otras no, no sirve para
              un plan comercial: el alta va a fallar justo en la que falta.
              <ul className="mt-1 space-y-0.5 text-xs">
                {resultado.verificacion
                  .filter((v) => !v.ok)
                  .map((v) => (
                    <li key={v.olt}>{v.olt}: no quedaron las dos tablas</li>
                  ))}
                {resultado.fallidas.map((f, i) => (
                  <li key={i}>
                    {f.olt} índice {f.index}: {f.error}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Aviso>
      )}

      {datos === null ? (
        leyendo ? (
          <Cargando texto="Preguntándole a los equipos…" />
        ) : (
          <p className="py-8 text-center text-sm text-slate-500">
            Todavía no se leyeron. Apretá <b>Leer de los equipos</b>: cuesta una sesión SSH por OLT.
          </p>
        )
      ) : (
        datos.map((d) => (
          <Card key={d.olt_id} title={d.olt ?? 'OLT'} icon={Gauge}>
            {d.error ? (
              <Aviso tipo="alerta">No se pudo leer: {d.error}</Aviso>
            ) : (
              <div className="space-y-4">
                {/* --- Los pares, que son lo vendible --- */}
                <div>
                  <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Perfiles completos
                  </h4>
                  <p className="mb-2 text-[11px] leading-snug text-slate-500">
                    Tienen sus dos tablas —una por sentido— así que se pueden vender tal cual.
                    Ponerle precio a uno crea el plan con la velocidad que el equipo aplica de
                    verdad, no con la que se escriba a mano.
                  </p>
                  <Table
                    columnas={['Perfil', 'Bajada', 'Subida', 'Índices', 'Uso', '']}
                    filas={d.pares ?? []}
                    vacio="Ninguna tabla tiene su par. Abajo están las sueltas."
                    renderFila={(p) => (
                      <tr key={p.nombre} className="text-slate-300">
                        <td className="px-3 py-2 text-sm text-slate-100">{p.nombre}</td>
                        <td className="px-3 py-2 text-sm">{p.bajada_mbps} Mbps</td>
                        <td className="px-3 py-2 text-sm">{p.subida_mbps} Mbps</td>
                        <td className="px-3 py-2 font-mono text-xs text-slate-500">
                          {p.traffic_table_bajada}/{p.traffic_table_subida}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {p.en_uso ? (
                            <Badge color="verde">en uso</Badge>
                          ) : (
                            <span className="text-slate-600">sin usar</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button
                            variante="primario"
                            icon={Tag}
                            onClick={() =>
                              setAVender({
                                ...p,
                                olt_id: d.olt_id,
                                nombre_plan: p.nombre.replace(/^SMARTOLT[-_]/i, ''),
                                precio: '',
                              })
                            }
                          >
                            Ponerle precio
                          </Button>
                        </td>
                      </tr>
                    )}
                  />
                </div>

                {/* --- Las sueltas ---
                    Se muestran igual: media pareja no sirve para vender, pero
                    esconderlas sería decidir por el usuario qué puede usar. */}
                {(d.sueltas ?? []).length > 0 && (
                  <div>
                    <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Tablas sueltas
                    </h4>
                    <p className="mb-2 text-[11px] leading-snug text-slate-500">
                      No tienen par. Para vender un plan hacen falta las dos: la que falta quedaría
                      sin límite y el abonado tendría un plan distinto del que pagó.
                    </p>
                    <Table
                      columnas={['Índice', 'Nombre', 'Velocidad', 'Uso', '']}
                      filas={d.sueltas}
                      renderFila={(t) => (
                        <tr key={t.index} className="text-slate-300">
                          <td className="px-3 py-1.5 font-mono text-xs">{t.index}</td>
                          <td className="px-3 py-1.5 text-xs">{t.nombre ?? '—'}</td>
                          <td className="px-3 py-1.5 text-sm">
                            {t.sin_limite ? (
                              <span className="text-amber-300">sin límite</span>
                            ) : (
                              `${t.mbps} Mbps`
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-xs">
                            {t.en_uso ? (
                              <Badge color="verde">en uso</Badge>
                            ) : (
                              <span className="text-slate-600">sin usar</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            <Button
                              variante="fantasma"
                              icon={Trash2}
                              disabled={t.en_uso}
                              title={t.en_uso ? 'La está aplicando algún abonado' : undefined}
                              onClick={async () => {
                                if (
                                  !await confirmar(
                                    `Borrar la traffic table ${t.index} de ${elegidas.length} OLT(s)?`,
                                  )
                                ) {
                                  return
                                }
                                try {
                                  await api.olt.borrarVelocidad(t.index, elegidas)
                                  await leer()
                                } catch (err) {
                                  setError(err)
                                }
                              }}
                            >
                              Borrar
                            </Button>
                          </td>
                        </tr>
                      )}
                    />
                  </div>
                )}
              </div>
            )}
          </Card>
        ))
      )}

      {/* --- Ponerle precio a un perfil que ya existe --- */}
      {aVender && (
        <Card title={`Vender ${aVender.nombre}`} icon={Tag}>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Nombre comercial" hint="el que ve el abonado en su factura">
              <Input
                value={aVender.nombre_plan}
                onChange={(e) => setAVender({ ...aVender, nombre_plan: e.target.value })}
              />
            </Field>
            <Field label="Precio">
              <Input
                type="number"
                step="0.01"
                value={aVender.precio}
                onChange={(e) => setAVender({ ...aVender, precio: e.target.value })}
                placeholder="25.00"
              />
            </Field>
          </div>

          <p className="mt-2 text-[11px] leading-snug text-slate-500">
            La velocidad la pone el equipo, no este formulario:{' '}
            <b>
              {aVender.bajada_mbps} Mbps de bajada y {aVender.subida_mbps} de subida
            </b>{' '}
            (tablas {aVender.traffic_table_bajada}/{aVender.traffic_table_subida}). Es lo que evita
            volver a tener un plan llamado &quot;100M&quot; que aplica 1 Gbps.
          </p>

          <div className="mt-3 flex gap-2">
            <Button
              variante="primario"
              icon={Tag}
              cargando={vendiendo}
              disabled={!aVender.nombre_plan?.trim() || !aVender.precio}
              onClick={crearPlan}
            >
              Crear el plan
            </Button>
            <Button variante="fantasma" onClick={() => setAVender(null)}>
              Cancelar
            </Button>
          </div>
        </Card>
      )}

      {planCreado && (
        <Aviso>
          Plan <b>{planCreado.nombre}</b> creado: {planCreado.aplica_bajada} de bajada y{' '}
          {planCreado.aplica_subida} de subida.{' '}
          <Link to="/servicios/planes" className="underline hover:text-sky-200">
            Verlo en Planes de internet
          </Link>{' '}
          para completar el IVA, la categoría y en qué routers se ofrece.
        </Aviso>
      )}

      {datos && datos.length > 1 && (
        <Aviso tipo="alerta">
          <TriangleAlert size={13} className="mr-1 inline" />
          Fijate que el mismo índice tenga la misma velocidad en todas las OLTs. Si difieren, un
          plan que apunte a ese índice le va a dar velocidades distintas a los abonados según de
          qué equipo cuelguen — y desde la ficha del abonado no se ve.
        </Aviso>
      )}
    </div>
  )
}
