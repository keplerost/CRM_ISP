import { useCallback, useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { Link } from 'react-router-dom'
import { Box, Check, MapPin, Package, Pencil, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { dbm } from '../../lib/optica'
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
} from '../../components/ui'

/**
 * Las cajas NAP: dónde están y cuántas bocas les quedan.
 *
 * La pregunta que contesta, y que hoy nadie puede contestar: entra un cliente
 * nuevo en esa cuadra — ¿hay lugar en la caja, o hay que salir con una caja
 * nueva en la camioneta?
 *
 * El sistema NO sabe de qué caja cuelga cada abonado: los splitters son pasivos
 * y la OLT ve lo mismo con una caja que con cinco. Lo que hace es PROPONER
 * agrupaciones con lo que sí sabe —puerto, dirección y distancia medida— y
 * mostrar la evidencia para que una persona decida. Nunca las da por ciertas
 * solas.
 */

const CONFIANZA = {
  alta: { color: 'verde', label: 'probable' },
  media: { color: 'ambar', label: 'a revisar' },
  baja: { color: 'rojo', label: 'floja' },
}

export default function CajasNapPage() {
  const confirmar = useConfirmar()
  const [olts, setOlts] = useState([])
  const [oltId, setOltId] = useState('')
  const [cajas, setCajas] = useState(null)
  const [propuesta, setPropuesta] = useState(null)
  const [error, setError] = useState(null)
  const [buscando, setBuscando] = useState(false)
  const [creando, setCreando] = useState(null)
  const [editando, setEditando] = useState(null)

  useEffect(() => {
    supabase
      .from('olts')
      .select('id, nombre, numero')
      .order('numero')
      .then(({ data }) => {
        setOlts(data ?? [])
        if (data?.length && !oltId) setOltId(data[0].id)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cargarCajas = useCallback(async () => {
    if (!oltId) return
    try {
      setCajas(await api.olt.naps(oltId))
    } catch (err) {
      setError(err)
      setCajas([])
    }
  }, [oltId])

  useEffect(() => {
    setPropuesta(null)
    cargarCajas()
  }, [cargarCajas])

  async function proponer() {
    setBuscando(true)
    setError(null)
    try {
      setPropuesta(await api.olt.proponerNaps(oltId))
    } catch (err) {
      setError(err)
    } finally {
      setBuscando(false)
    }
  }

  /**
   * Guarda los datos de una caja que ya existe.
   *
   * Faltaba: la pantalla proponía cajas, las creaba y las borraba, y nada más.
   * Corregir una capacidad mal contada o cargarle las coordenadas obligaba a
   * borrar la caja y rehacerla —perdiendo qué ONUs tenía asignadas— o a entrar
   * a la base a mano.
   *
   * Y sin coordenadas la caja no existe para media aplicación: la verificación
   * de cobertura la ignora (`cobertura_cercana` filtra las que no tienen punto)
   * y el mapa comercial no la dibuja. O sea que la falta de un formulario de
   * edición dejaba fuera de servicio una función entera del módulo de ventas.
   *
   * Va directo a Supabase y no por el middleware porque no toca la OLT: son
   * datos de gestión sobre una fila, y `puntos_red` ya acepta escritura del
   * personal con sesión.
   */
  async function guardarCaja() {
    setError(null)
    try {
      const { error: err } = await supabase
        .from('puntos_red')
        .update({
          nombre: editando.nombre.trim(),
          direccion: editando.direccion?.trim() || null,
          // Vacío es NULL, no cero: "no sé cuántas bocas tiene" y "tiene cero
          // bocas" son cosas distintas, y la vista de ocupación las distingue.
          capacidad: editando.capacidad === '' ? null : Number(editando.capacidad),
          latitud: editando.latitud === '' ? null : Number(editando.latitud),
          longitud: editando.longitud === '' ? null : Number(editando.longitud),
          notas: editando.notas?.trim() || null,
          activo: editando.activo,
        })
        .eq('id', editando.id)
      if (err) throw err

      setEditando(null)
      await cargarCajas()
    } catch (err) {
      setError(err)
    }
  }

  async function crear(p) {
    setError(null)
    try {
      await api.olt.crearNap(oltId, {
        nombre: creando.nombre,
        slot: p.slot,
        puerto: p.puerto,
        capacidad: creando.capacidad ? Number(creando.capacidad) : null,
        direccion: p.direccion,
        verificada: creando.verificada,
        onu_ids: p.onus.map((o) => o.id),
      })
      setCreando(null)
      await cargarCajas()
      await proponer()
    } catch (err) {
      setError(err)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Cajas NAP</h1>
          <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-slate-500">
            La OLT no sabe de qué caja cuelga cada abonado: los splitters son pasivos y ve lo mismo
            con una caja que con cinco. Acá se proponen agrupaciones con lo que sí se sabe y las
            confirma una persona.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <Field label="OLT">
            <Select value={oltId} onChange={(e) => setOltId(e.target.value)}>
              {olts.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.numero ? `${o.numero} · ` : ''}
                  {o.nombre}
                </option>
              ))}
            </Select>
          </Field>
          <Button variante="primario" icon={RefreshCw} cargando={buscando} onClick={proponer}>
            Proponer cajas
          </Button>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {/* --- Cajas ya cargadas --- */}
      <Card title="Cajas cargadas" icon={Box}>
        {cajas === null ? (
          <SkeletonTabla filas={3} columnas={6} />
        ) : cajas.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            Todavía no hay ninguna. Apretá <b>Proponer cajas</b> y confirmá las que reconozcas.
          </p>
        ) : (
          <Table
            columnas={['Caja', 'Puerto', 'Ocupación', 'Señal', 'Distancia', 'Origen', '']}
            filas={cajas}
            renderFila={(c) => (
              <tr key={c.id} className="text-slate-300">
                <td className="px-3 py-2 text-sm text-slate-100">
                  {c.nombre}
                  {c.direccion && (
                    <span className="block text-[11px] text-slate-500">{c.direccion}</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {c.slot ?? '—'}/{c.puerto_pon ?? '—'}
                </td>
                <td className="px-3 py-2 text-xs">
                  {/* Sin capacidad cargada no se dice "hay lugar": no se sabe. */}
                  {c.capacidad == null ? (
                    <span className="text-slate-500">
                      {c.ocupadas} colgadas · <span className="text-amber-400">sin capacidad</span>
                    </span>
                  ) : (
                    <span className={c.llena ? 'text-rose-300' : ''}>
                      {c.ocupadas} de {c.capacidad}
                      {c.llena ? ' · LLENA' : ` · ${c.libres} libres`}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs">
                  {dbm(c.rx_promedio)}
                  {c.con_senal_baja > 0 && (
                    <span className="ml-1 text-rose-300">· {c.con_senal_baja} bajas</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {c.distancia_min != null ? `${c.distancia_min}–${c.distancia_max} m` : '—'}
                </td>
                <td className="px-3 py-2 text-xs">
                  {c.origen === 'campo' ? (
                    <Badge color="verde">verificada</Badge>
                  ) : (
                    <Badge color="gris">deducida</Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    variante="fantasma"
                    icon={Pencil}
                    onClick={() =>
                      setEditando({
                        id: c.id,
                        nombre: c.nombre ?? '',
                        direccion: c.direccion ?? '',
                        capacidad: c.capacidad ?? '',
                        latitud: c.latitud ?? '',
                        longitud: c.longitud ?? '',
                        notas: c.notas ?? '',
                        activo: c.activo !== false,
                      })
                    }
                  >
                    Editar
                  </Button>
                  <Button
                    variante="fantasma"
                    icon={Trash2}
                    onClick={async () => {
                      if (!await confirmar(`Borrar la caja "${c.nombre}"?\n\nLos abonados quedan sin caja asignada, pero conservan su servicio.`)) return
                      try {
                        await api.olt.borrarNap(c.id)
                        await cargarCajas()
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
        )}
      </Card>

      {/* --- Editar una caja --- */}
      <Modal
        abierto={!!editando}
        titulo={`Editar ${editando?.nombre ?? ''}`}
        onCerrar={() => setEditando(null)}
      >
        {editando && (
          <div className="space-y-3">
            <Field label="Nombre">
              <Input
                value={editando.nombre}
                onChange={(e) => setEditando({ ...editando, nombre: e.target.value })}
                autoFocus
              />
            </Field>
            <Field label="Dirección">
              <Input
                value={editando.direccion}
                onChange={(e) => setEditando({ ...editando, direccion: e.target.value })}
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Capacidad (bocas)"
                hint="Vacío = no se sabe. No es lo mismo que cero."
              >
                <Input
                  type="number"
                  min={1}
                  value={editando.capacidad}
                  onChange={(e) => setEditando({ ...editando, capacidad: e.target.value })}
                />
              </Field>
              <Field label="Estado">
                <Select
                  value={editando.activo ? 'si' : 'no'}
                  onChange={(e) => setEditando({ ...editando, activo: e.target.value === 'si' })}
                >
                  <option value="si">Activa</option>
                  <option value="no">Fuera de servicio</option>
                </Select>
              </Field>
            </div>

            {/* Las coordenadas no son un adorno del mapa: sin ellas la caja es
                invisible para la verificación de cobertura, que descarta las que
                no tienen punto. Por eso el aviso está acá y no en la ayuda. */}
            <Aviso>
              Sin coordenadas, esta caja no aparece en el mapa comercial y la{' '}
              <b>verificación de cobertura la ignora</b>: cualquier dirección cercana va a dar "sin
              cobertura". Sacalas de Google Maps con clic derecho sobre el poste → el primer número
              es la latitud.
            </Aviso>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Latitud">
                <Input
                  value={editando.latitud}
                  onChange={(e) => setEditando({ ...editando, latitud: e.target.value })}
                  placeholder="-0.9302"
                  inputMode="decimal"
                />
              </Field>
              <Field label="Longitud">
                <Input
                  value={editando.longitud}
                  onChange={(e) => setEditando({ ...editando, longitud: e.target.value })}
                  placeholder="-79.2214"
                  inputMode="decimal"
                />
              </Field>
            </div>

            <Field label="Notas">
              <Input
                value={editando.notas}
                onChange={(e) => setEditando({ ...editando, notas: e.target.value })}
              />
            </Field>

            <div className="flex justify-end gap-2 border-t border-slate-800 pt-3">
              <Button variante="fantasma" onClick={() => setEditando(null)}>
                Cancelar
              </Button>
              <Button
                variante="primario"
                onClick={guardarCaja}
                disabled={!editando.nombre.trim()}
              >
                Guardar
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* --- Propuestas --- */}
      {propuesta && (
        <>
          <Aviso>
            De {propuesta.resumen.onus} ONUs: <b>{propuesta.resumen.ya_asignadas}</b> ya tienen
            caja, <b>{propuesta.resumen.sin_asignar}</b> no, y se armaron{' '}
            <b>{propuesta.resumen.propuestas}</b> grupos candidatos.{' '}
            {propuesta.resumen.sin_direccion > 0 && (
              <>
                Otras <b>{propuesta.resumen.sin_direccion}</b> no tienen dirección cargada: de esas
                no se puede deducir nada, hay que ir a verlas.
              </>
            )}
          </Aviso>

          <Card title="Cajas candidatas" icon={Package}>
            <p className="mb-3 text-xs leading-relaxed text-slate-500">
              Cada grupo comparte puerto PON, dirección y distancia. La confianza sale de cuánto se
              separan entre sí: los abonados de una misma caja se separan lo que miden sus
              acometidas, decenas de metros. Un grupo que abarca cientos casi seguro son varias
              cajas sobre la misma vía — partilo o andá a verlo.
            </p>

            <div className="space-y-2">
              {propuesta.propuestas.map((p) => {
                const c = CONFIANZA[p.confianza.nivel]
                const abierto = creando?.clave === p.clave
                return (
                  <div key={p.clave} className="rounded-lg border border-slate-800">
                    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <Badge color={c.color}>{c.label}</Badge>
                      <span className="font-mono text-xs text-slate-500">
                        {p.slot}/{p.puerto}
                      </span>
                      <span className="text-sm text-slate-100">{p.direccion}</span>
                      <span className="text-xs text-slate-500">
                        {p.abonados} abonados
                        {p.distancia_min != null && ` · ${p.distancia_min}–${p.distancia_max} m`}
                      </span>
                      <span className="flex-1" />
                      <Button
                        variante={abierto ? 'fantasma' : 'primario'}
                        icon={abierto ? undefined : Check}
                        onClick={() =>
                          setCreando(
                            abierto
                              ? null
                              : {
                                  clave: p.clave,
                                  nombre: p.nombre_sugerido,
                                  capacidad: p.abonados <= 8 ? 8 : 16,
                                  verificada: false,
                                },
                          )
                        }
                      >
                        {abierto ? 'Cancelar' : 'Crear caja'}
                      </Button>
                    </div>

                    <p className="px-3 pb-2 text-[11px] text-slate-500">
                      {p.confianza.nivel !== 'alta' && (
                        <TriangleAlert size={11} className="mr-1 inline text-amber-400" />
                      )}
                      {p.confianza.motivo}
                    </p>

                    {abierto && (
                      <div className="space-y-3 border-t border-slate-800 bg-slate-950/40 px-3 py-3">
                        <div className="grid gap-2 sm:grid-cols-3">
                          <Field label="Nombre de la caja" className="sm:col-span-2">
                            <Input
                              value={creando.nombre}
                              onChange={(e) => setCreando({ ...creando, nombre: e.target.value })}
                            />
                          </Field>
                          <Field label="Bocas del splitter" hint="lo que decide si entra uno más">
                            <Select
                              value={creando.capacidad}
                              onChange={(e) => setCreando({ ...creando, capacidad: e.target.value })}
                            >
                              <option value="">no sé</option>
                              <option value="4">4</option>
                              <option value="8">8</option>
                              <option value="16">16</option>
                              <option value="32">32</option>
                            </Select>
                          </Field>
                        </div>

                        <label className="flex items-start gap-2 text-xs text-slate-400">
                          <input
                            type="checkbox"
                            checked={creando.verificada}
                            onChange={(e) => setCreando({ ...creando, verificada: e.target.checked })}
                            className="mt-0.5 accent-sky-500"
                          />
                          <span>
                            Alguien fue y lo verificó en el poste.
                            <span className="block text-[11px] text-slate-500">
                              Sin marcar queda como deducida. La diferencia importa el día que el
                              sistema diga que hay una boca libre: no es lo mismo si eso salió de
                              una cuenta o de alguien que abrió la caja.
                            </span>
                          </span>
                        </label>

                        <Table
                          columnas={['Abonado', 'Serie', 'ONT', 'Distancia', 'Señal']}
                          filas={p.onus}
                          renderFila={(o) => (
                            <tr key={o.id} className="text-slate-300">
                              <td className="px-3 py-1 text-xs">
                                <Link to={`/onus/${o.id}`} className="hover:text-sky-300">
                                  {o.cliente ?? o.sn}
                                </Link>
                              </td>
                              <td className="px-3 py-1 font-mono text-[11px]">{o.sn}</td>
                              <td className="px-3 py-1 font-mono text-[11px]">{o.onu_index}</td>
                              <td className="px-3 py-1 text-xs">
                                {o.distancia_m != null ? `${o.distancia_m} m` : '—'}
                              </td>
                              <td className="px-3 py-1 text-xs">{dbm(o.rx_power_dbm)}</td>
                            </tr>
                          )}
                        />

                        <Button variante="primario" icon={Check} onClick={() => crear(p)}>
                          Crear "{creando.nombre}" con {p.abonados} abonados
                        </Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </Card>

          {propuesta.sin_direccion.length > 0 && (
            <Card title="Sin dirección: hay que ir a verlas" icon={MapPin}>
              <p className="mb-2 text-xs leading-relaxed text-slate-500">
                El sistema anterior nunca les cargó la dirección, así que no hay con qué agruparlas.
                Se completan solas a medida que un técnico las visite.
              </p>
              <Table
                columnas={['Abonado', 'Serie', 'Puerto', 'Distancia']}
                filas={propuesta.sin_direccion}
                renderFila={(o) => (
                  <tr key={o.id} className="text-slate-300">
                    <td className="px-3 py-1.5 text-xs">
                      <Link to={`/onus/${o.id}`} className="hover:text-sky-300">
                        {o.cliente ?? o.sn}
                      </Link>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[11px]">{o.sn}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{o.puerto}</td>
                    <td className="px-3 py-1.5 text-xs">
                      {o.distancia_m != null ? `${o.distancia_m} m` : '—'}
                    </td>
                  </tr>
                )}
              />
            </Card>
          )}
        </>
      )}
    </div>
  )
}
