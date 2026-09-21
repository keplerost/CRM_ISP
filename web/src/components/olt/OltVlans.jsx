import { useCallback, useEffect, useState } from 'react'
import { Download, ListPlus, Minus, Network, Plus, RefreshCw, Trash2, Undo2, Wand2 } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { supabase } from '../../lib/supabaseClient'
import { hace } from '../../lib/olts'
import {
  Aviso,
  Badge,
  Button,
  ErrorBanner,
  Field,
  Input,
  Select,
  SkeletonTabla,
  Table,
} from '../ui'

/**
 * Las VLANs de la OLT.
 *
 * La existencia de cada una la dice el equipo. Lo que el equipo NO puede decir
 * es para qué la usa el ISP ni de qué puerto PON es la predeterminada: eso es
 * una convención, y las convenciones que no están escritas se aplican mal el
 * día que las aplica otra persona.
 *
 * Esa asignación puerto → VLAN es lo que después permite que una instalación
 * elija sola su segmento de red: la ONT apareció en el puerto 4, el puerto 4
 * usa la VLAN 204, esa VLAN es la de tal subred. El técnico no elige nada.
 */

const USOS = {
  internet: { label: 'Internet', color: 'verde' },
  gestion: { label: 'Gestión', color: 'azul' },
  voip: { label: 'VoIP', color: 'ambar' },
  iptv: { label: 'IPTV', color: 'ambar' },
  otra: { label: 'Otra', color: 'gris' },
}

export default function OltVlans({ olt }) {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [panel, setPanel] = useState(null) // 'crear' | 'borrar' | 'esquema'
  const [form, setForm] = useState({})
  const [trabajando, setTrabajando] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [editando, setEditando] = useState(null)
  const [vista, setVista] = useState('vlans') // 'vlans' | 'puertos'

  const leer = useCallback(async () => {
    setCargando(true)
    setError(null)
    try {
      setDatos(await api.olt.vlans(olt.id))
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [olt.id])

  useEffect(() => {
    leer()
  }, [leer])

  async function correr(fn) {
    setTrabajando(true)
    setError(null)
    setResultado(null)
    try {
      setResultado(await fn())
      setPanel(null)
      await leer()
    } catch (err) {
      setError(err)
    } finally {
      setTrabajando(false)
    }
  }

  const abrir = (cual) => {
    setResultado(null)
    setPanel(cual)
    setForm(
      cual === 'esquema'
        ? {
            slot: 6,
            desdePuerto: 0,
            hastaPuerto: 15,
            desdeVlan: 202,
            bloqueBase: '',
            prefijo: 25,
            pppoe: 'si',
            gateway: 'compartido',
            gatewayPppoe: '172.17.0.1',
            olt: '',
            routerId: '',
            interfaz: 'vlan{vlan}',
          }
        : { vlans: '', descripcion: '', uso: 'internet', forzar: false },
    )
  }

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {/* Las dos formas de mirar lo mismo. Por VLAN se responde "¿dónde se usa
          la 200?"; por puerto, "¿qué le falta al 6/12?". La segunda es con la
          que se configura, porque muestra también los puertos vacíos. */}
      <div className="flex gap-1 rounded-lg bg-slate-800/60 p-1">
        {[
          ['vlans', 'Por VLAN'],
          ['puertos', 'Por puerto PON'],
        ].map(([clave, label]) => (
          <button
            key={clave}
            type="button"
            onClick={() => setVista(clave)}
            className={`rounded px-3 py-1.5 text-xs font-medium transition ${
              vista === clave
                ? 'bg-slate-700 text-slate-100'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {vista === 'puertos' && (
        <PuertosPon olt={olt} vlansDisponibles={(datos?.vlans ?? []).map((v) => v.vlan)} />
      )}

      {vista === 'vlans' && (
      <>
      <div className="flex flex-wrap items-center gap-2">
        <Button variante="primario" icon={Plus} onClick={() => abrir('crear')}>
          Agregar VLAN
        </Button>
        <Button icon={ListPlus} onClick={() => abrir('esquema')}>
          Una VLAN y un bloque por puerto
        </Button>
        {/* Crear son TRES cosas —la VLAN en la OLT, el bloque y la asignación
            del puerto— y deshacerlas eran tres pantallas distintas. Quien iba a
            dos quedaba con el generador bloqueado sin entender por qué. */}
        <Button variante="peligro" icon={Undo2} onClick={() => abrir('deshacer')}>
          Deshacer un esquema
        </Button>
        <Button variante="peligro" icon={Minus} onClick={() => abrir('borrar')}>
          Borrar varias
        </Button>
        <span className="flex-1" />
        <Button variante="fantasma" icon={RefreshCw} cargando={cargando} onClick={leer}>
          Releer del equipo
        </Button>
      </div>

      <p className="text-[11px] leading-snug text-slate-500">
        Crear una VLAN acá <b>no la pone en los troncales</b>. Eso se hace en Uplink, y sin eso el
        tráfico de esa VLAN no sale de la OLT — las ONTs se ven online y el abonado no navega.
      </p>

      {/* --- Crear --- */}
      {panel === 'crear' && (
        <div className="space-y-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="VLANs" hint="una, varias o un rango: 201-215, 300">
              <Input
                value={form.vlans}
                onChange={(e) => setForm({ ...form, vlans: e.target.value })}
                placeholder="201-215"
              />
            </Field>
            <Field label="Para qué">
              <Select value={form.uso} onChange={(e) => setForm({ ...form, uso: e.target.value })}>
                {Object.entries(USOS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Descripción">
              <Input
                value={form.descripcion}
                onChange={(e) => setForm({ ...form, descripcion: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button
              variante="primario"
              icon={Plus}
              cargando={trabajando}
              disabled={!form.vlans?.trim()}
              onClick={() => correr(() => api.olt.crearVlans(olt.id, form))}
            >
              Crear
            </Button>
            <Button variante="fantasma" onClick={() => setPanel(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {/* --- Deshacer --- */}
      {panel === 'deshacer' && (
        <DeshacerEsquema
          olt={olt}
          onListo={() => {
            setPanel(null)
            leer()
          }}
          onCancelar={() => setPanel(null)}
        />
      )}

      {/* --- El esquema por puerto: VLAN y bloque de IP para cada PON --- */}
      {panel === 'esquema' && (
        <EsquemaPorPuerto
          olt={olt}
          form={form}
          setForm={setForm}
          onListo={() => {
            setPanel(null)
            leer()
          }}
          onCancelar={() => setPanel(null)}
        />
      )}

      {/* --- Borrar --- */}
      {panel === 'borrar' && (
        <div className="space-y-3 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3">
          <Field label="VLANs a borrar" hint="una, varias o un rango">
            <Input
              value={form.vlans}
              onChange={(e) => setForm({ ...form, vlans: e.target.value })}
              placeholder="301, 302"
            />
          </Field>
          <p className="text-[11px] leading-snug text-rose-300/70">
            Se niega a borrar las que tienen abonados. Quitarlas los deja sin salida en el momento y
            desde el lado GPON no se ve nada raro: las ONTs siguen online.
          </p>
          <div className="flex gap-2">
            <Button
              variante="peligro"
              icon={Trash2}
              cargando={trabajando}
              disabled={!form.vlans?.trim()}
              onClick={() => correr(() => api.olt.borrarVlans(olt.id, form))}
            >
              Borrar
            </Button>
            <Button variante="fantasma" onClick={() => setPanel(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {resultado && (
        <Aviso tipo={resultado.fallidas?.length ? 'alerta' : 'info'}>
          {resultado.asignadas != null ? (
            <>
              {resultado.asignadas} puertos asignados: del {resultado.desde.puerto} con la VLAN{' '}
              {resultado.desde.vlan} al {resultado.hasta.puerto} con la {resultado.hasta.vlan}.
            </>
          ) : (
            <>
              {resultado.creadas?.length > 0 && <>Creadas: {resultado.creadas.join(', ')}. </>}
              {resultado.borradas?.length > 0 && <>Borradas: {resultado.borradas.join(', ')}. </>}
              {/* Se informan aparte para que el resumen no diga "creadas 20"
                  cuando dieciocho ya estaban. */}
              {resultado.yaEstaban?.length > 0 && (
                <>Ya existían: {resultado.yaEstaban.join(', ')}. </>
              )}
              {resultado.noEstaban?.length > 0 && (
                <>No estaban en el equipo: {resultado.noEstaban.join(', ')}. </>
              )}
              {resultado.fallidas?.length > 0 && (
                <span className="mt-1 block">
                  Fallaron: {resultado.fallidas.map((f) => `${f.vlan} (${f.error})`).join(' · ')}
                </span>
              )}
            </>
          )}
        </Aviso>
      )}

      {datos?.huerfanas?.length > 0 && (
        <Aviso tipo="alerta">
          Hay {datos.huerfanas.length} VLAN(s) anotadas en el sistema que el equipo no tiene:{' '}
          {datos.huerfanas.map((v) => v.vlan).join(', ')}. Una VLAN asignada a un puerto que ya no
          existe deja una instalación eligiendo un segmento que no lleva a ningún lado.
        </Aviso>
      )}

      {datos === null ? (
        <SkeletonTabla filas={8} columnas={6} />
      ) : (
        <>
          <div className="text-xs text-slate-500">
            {datos.resumen.total} VLANs · {datos.resumen.con_abonados} con abonados ·{' '}
            {datos.resumen.en_uso} en algún PON · {datos.resumen.asignadas_a_puerto} asignadas a un
            puerto · {datos.resumen.con_subred} con segmento de red
          </div>

          <Table
            columnas={[
              'VLAN',
              'En qué PON está',
              'Predeterminada de',
              'Uso',
              'Descripción',
              'Segmento',
              'ONUs',
              '',
            ]}
            filas={datos.vlans}
            renderFila={(v) => (
              <tr key={v.vlan} className="text-slate-300">
                <td className="px-3 py-2 font-mono text-sm text-slate-100">{v.vlan}</td>
                {/* Dónde está puesta HOY, leído de las ONUs. Es distinto de la
                    predeterminada —esa es la convención del ISP— y durante una
                    migración de esquema las dos no coinciden: ver la diferencia
                    es lo que dice cuánto falta por mover. */}
                <td className="px-3 py-2 text-xs">
                  {v.puertos_en_uso?.length ? (
                    <div className="flex flex-wrap gap-1">
                      {v.puertos_en_uso.map((p) => (
                        <span
                          key={p.puerto}
                          className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-200"
                          title={`${p.abonados} ${p.abonados === 1 ? 'abonado' : 'abonados'} en el puerto ${p.puerto}`}
                        >
                          {p.puerto}
                          <span className="ml-1 text-slate-500">{p.abonados}</span>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-slate-600">sin abonados</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs">
                  {v.puertos_predeterminados?.length ? (
                    <div className="flex flex-wrap gap-1">
                      {v.puertos_predeterminados.map((p) => (
                        <span
                          key={p.etiqueta}
                          className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-200"
                        >
                          {p.etiqueta}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-slate-600">ninguno</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs">
                  {v.uso ? (
                    <Badge color={USOS[v.uso]?.color ?? 'gris'}>{USOS[v.uso]?.label ?? v.uso}</Badge>
                  ) : (
                    <span className="text-slate-600">sin definir</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-slate-400">{v.descripcion ?? '—'}</td>
                {/* Sin segmento, la cadena se corta y el técnico va a tener que
                    elegirlo a mano. Se ve acá antes de que pase. */}
                <td className="px-3 py-2 text-xs">
                  {v.segmentos?.length ? (
                    v.segmentos.map((s) => (
                      <span key={s.subred_id} className="mb-1 block text-slate-300 last:mb-0">
                        {s.subred}
                        <span className="block font-mono text-[11px] text-slate-600">{s.cidr}</span>
                      </span>
                    ))
                  ) : (
                    <span className="text-amber-400/70">sin subred con esta VLAN</span>
                  )}
                </td>
                <td className="px-3 py-2 text-sm">
                  {v.abonados > 0 ? (
                    <span className="text-slate-100">{v.abonados}</span>
                  ) : (
                    <span className="text-slate-600">0</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    variante="fantasma"
                    onClick={() =>
                      setEditando({
                        vlan: v.vlan,
                        descripcion: v.descripcion ?? '',
                        uso: v.uso ?? 'internet',
                      })
                    }
                  >
                    Editar
                  </Button>
                </td>
              </tr>
            )}
          />
        </>
      )}

      {editando && (
        <div className="space-y-3 t-panel p-3">
          <p className="text-sm font-semibold text-slate-100">VLAN {editando.vlan}</p>
          <div className="grid gap-2 sm:grid-cols-4">
            <Field label="Para qué">
              <Select
                value={editando.uso}
                onChange={(e) => setEditando({ ...editando, uso: e.target.value })}
              >
                {Object.entries(USOS).map(([k, u]) => (
                  <option key={k} value={k}>
                    {u.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Descripción" className="sm:col-span-3">
              <Input
                value={editando.descripcion}
                onChange={(e) => setEditando({ ...editando, descripcion: e.target.value })}
              />
            </Field>
            {/* De qué puertos es la predeterminada se edita en la vista por
                puerto: una VLAN puede ser la de varios, y un campo suelto acá
                solo podía decir uno. */}
            <p className="text-[11px] text-slate-500 sm:col-span-3">
              De qué puertos PON es la predeterminada se configura en{' '}
              <b>Por puerto PON</b>. Una VLAN puede ser la de varios puertos.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variante="primario"
              cargando={trabajando}
              onClick={() =>
                correr(async () => {
                  const r = await api.olt.anotarVlan(olt.id, editando.vlan, editando)
                  setEditando(null)
                  return r
                })
              }
            >
              Guardar
            </Button>
            <Button variante="fantasma" onClick={() => setEditando(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  )
}

/**
 * Los puertos PON de cada placa, con la VLAN que tienen puesta.
 *
 * Es la misma información que la tabla de VLANs, mirada al revés. Las dos hacen
 * falta porque responden preguntas distintas: aquélla dice dónde se usa una
 * VLAN, y ésta qué le falta a un puerto.
 *
 * Lista TODOS los puertos, tengan abonados o no — un puerto vacío es
 * precisamente el que hay que configurar, y esconderlo hasta que llegue un
 * cliente es dejar el trabajo para cuando ya hay alguien esperando.
 */
function PuertosPon({ olt, vlansDisponibles }) {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [editando, setEditando] = useState(null) // "6/12"
  const [valor, setValor] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [relevando, setRelevando] = useState(false)
  const [importacion, setImportacion] = useState(null)
  const [importando, setImportando] = useState(false)
  const [sobrescribir, setSobrescribir] = useState(false)

  const leer = useCallback(async () => {
    setCargando(true)
    setError(null)
    try {
      setDatos(await api.olt.vlansPorPuerto(olt.id))
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [olt.id])

  useEffect(() => {
    leer()
  }, [leer])

  async function asignar(p) {
    setGuardando(true)
    setError(null)
    try {
      await api.olt.asignarPuerto(olt.id, p.slot, p.puerto, { vlan: Number(valor) })
      setEditando(null)
      await leer()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  if (datos === null) return <SkeletonTabla filas={10} columnas={5} />

  const r = datos.resumen

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="flex flex-wrap items-center gap-3">
        <div className="text-xs text-slate-500">
          {r.puertos} puertos · {r.con_vlan} con VLAN · {r.listos} listos para dar de alta ·{' '}
          {r.con_abonados} con abonados
          {r.a_medio_migrar > 0 && (
            <span className="text-amber-400"> · {r.a_medio_migrar} a medio migrar</span>
          )}
        </div>
        <span className="flex-1" />
        {/* Traer lo que el equipo ya tiene, en vez de escribirlo puerto por
            puerto. No toca la OLT: solo escribe nuestras anotaciones. */}
        <Button
          icon={Download}
          cargando={importando}
          onClick={async () => {
            setImportando(true)
            setError(null)
            try {
              setImportacion(await api.olt.importarVlans(olt.id, { aplicar: false }))
            } catch (err) {
              setError(err)
            } finally {
              setImportando(false)
            }
          }}
        >
          Traer del equipo
        </Button>
        <Button
          icon={RefreshCw}
          cargando={relevando}
          onClick={async () => {
            setRelevando(true)
            setError(null)
            try {
              await api.olt.relevarPuertos(olt.id)
              await leer()
            } catch (err) {
              setError(err)
            } finally {
              setRelevando(false)
            }
          }}
        >
          Preguntarle al equipo
        </Button>
      </div>

      {/* De cuándo es lo que se está viendo. Un dato viejo presentado como
          actual se toma por cierto; con la fecha, se vuelve a leer. */}
      <p className="text-[11px] text-slate-500">
        {datos.relevado_at ? (
          <>Relevado del equipo {hace(datos.relevado_at)}. Tarda ~30 s: por eso no se hace solo.</>
        ) : (
          <>
            Todavía no se le preguntó al equipo. Se muestran los puertos que conocemos por sus
            abonados, así que pueden faltar.
          </>
        )}
      </p>

      {importacion && (
        <div className="space-y-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
          <p className="text-sm font-semibold text-sky-200">
            Lo que el equipo ya tiene configurado
          </p>
          <p className="text-xs text-sky-200/80">
            {importacion.resumen.se_pueden_traer} se pueden traer ·{' '}
            {importacion.resumen.ya_estaban_igual} ya estaban igual ·{' '}
            {importacion.resumen.distintas} distintas de lo cargado ·{' '}
            {importacion.resumen.sin_resolver} sin resolver
          </p>

          <div className="max-h-64 overflow-y-auto rounded border border-slate-800">
            <table className="w-full text-xs">
              <tbody>
                {importacion.propuestas.map((p) => (
                  <tr key={p.etiqueta} className="border-b border-slate-800/60 last:border-0">
                    <td className="px-2 py-1 font-mono text-slate-300">{p.etiqueta}</td>
                    <td className="px-2 py-1 font-mono text-slate-100">{p.vlan ?? '—'}</td>
                    <td className="px-2 py-1 font-mono text-[11px] text-slate-500">
                      {p.vlans_del_equipo.map((v) => `${v.vlan}(${v.service_ports})`).join(' ') ||
                        'sin service-ports'}
                    </td>
                    <td className="px-2 py-1 text-[11px]">
                      {p.estado === 'nueva' && <span className="text-emerald-400">se trae</span>}
                      {p.estado === 'igual' && <span className="text-slate-600">ya estaba</span>}
                      {p.motivo && <span className="text-amber-400">{p.motivo}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {importacion.resumen.distintas > 0 && (
            <Aviso tipo="alerta">
              Hay {importacion.resumen.distintas} puerto(s) donde el sistema tiene una VLAN y el
              equipo usa otra. No se pisan solos: marcá <b>Reemplazar las distintas</b> si querés que
              gane lo del equipo.
            </Aviso>
          )}

          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={sobrescribir}
              onChange={(e) => setSobrescribir(e.target.checked)}
            />
            Reemplazar las distintas con lo que tiene el equipo
          </label>

          <div className="flex gap-2">
            <Button
              variante="primario"
              icon={Download}
              cargando={importando}
              disabled={!importacion.resumen.se_pueden_traer && !sobrescribir}
              onClick={async () => {
                setImportando(true)
                setError(null)
                try {
                  await api.olt.importarVlans(olt.id, { aplicar: true, sobrescribir })
                  setImportacion(null)
                  await leer()
                } catch (err) {
                  setError(err)
                } finally {
                  setImportando(false)
                }
              }}
            >
              Traer al sistema
            </Button>
            <Button variante="fantasma" onClick={() => setImportacion(null)}>
              Cancelar
            </Button>
          </div>

          <p className="text-[11px] text-slate-500">
            Esto <b>no escribe nada en la OLT</b>. Solo carga en el sistema lo que el equipo ya
            tiene, igual que si lo escribieras a mano puerto por puerto.
          </p>
        </div>
      )}


      {/* Una VLAN pasando por los puertos sin que nadie declare qué es no se
          descubre hasta que alguien la saca de un troncal y algo deja de andar. */}
      {datos.vlans_sin_declarar?.length > 0 && (
        <Aviso>
          El equipo usa {datos.vlans_sin_declarar.length === 1 ? 'la VLAN' : 'las VLANs'}{' '}
          <b>{datos.vlans_sin_declarar.join(', ')}</b> en sus puertos y{' '}
          {datos.vlans_sin_declarar.length === 1 ? 'no está declarada' : 'no están declaradas'} en el
          sistema. Conviene decir para qué {datos.vlans_sin_declarar.length === 1 ? 'sirve' : 'sirven'}{' '}
          desde la vista por VLAN — la de gestión no lleva abonados y ofrecerla en un alta deja al
          cliente sin servicio.
        </Aviso>
      )}

      {datos.placas.map((placa) => (
        <div key={placa.slot} className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-semibold text-slate-200">Placa {placa.slot}</h3>
            <span className="font-mono text-xs text-slate-500">{placa.placa ?? '—'}</span>
            <span className="text-xs text-slate-600">{placa.puertos.length} puertos PON</span>
          </div>

          <Table
            columnas={[
              'Puerto',
              'VLAN asignada',
              'Segmento de red',
              'Abonados',
              'VLANs en el equipo',
              '',
            ]}
            filas={placa.puertos}
            renderFila={(p) => (
              <tr key={p.etiqueta} className="text-slate-300">
                <td className="px-3 py-2 font-mono text-sm text-slate-100">
                  {p.etiqueta}
                  {p.listo && <span className="ml-2 text-[11px] text-emerald-400">listo</span>}
                </td>

                <td className="px-3 py-2 text-sm">
                  {editando === p.etiqueta ? (
                    <div className="flex items-center gap-1">
                      <Select
                        value={valor}
                        onChange={(e) => setValor(e.target.value)}
                        className="w-28"
                      >
                        <option value="">—</option>
                        {vlansDisponibles.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </Select>
                      <Button
                        variante="primario"
                        cargando={guardando}
                        disabled={!valor}
                        onClick={() => asignar(p)}
                      >
                        Guardar
                      </Button>
                      <Button variante="fantasma" onClick={() => setEditando(null)}>
                        ✕
                      </Button>
                    </div>
                  ) : (
                    <span className="font-mono text-slate-100">
                      {p.vlan ?? <span className="text-slate-600">sin asignar</span>}
                    </span>
                  )}
                </td>

                {/* Sin segmento la cadena se corta: el puerto tiene VLAN pero la
                    instalación no sabe de qué bloque sacar la IP. */}
                <td className="px-3 py-2 text-xs">
                  {p.segmentos.length ? (
                    p.segmentos.map((s) => (
                      <span key={s.subred_id} className="mb-1 block last:mb-0">
                        {s.subred}
                        <span className="block font-mono text-[11px] text-slate-600">{s.cidr}</span>
                      </span>
                    ))
                  ) : p.vlan != null ? (
                    <span className="text-amber-400/70">ninguna subred usa la VLAN {p.vlan}</span>
                  ) : (
                    <span className="text-slate-600">—</span>
                  )}
                </td>

                <td className="px-3 py-2 text-sm">
                  {p.abonados > 0 ? (
                    <span className="text-slate-100">
                      {p.abonados}
                      <span className="ml-1 text-[11px] text-slate-500">{p.online} online</span>
                    </span>
                  ) : (
                    <span className="text-slate-600">0</span>
                  )}
                </td>

                {/* Lo que el EQUIPO tiene puesto en ese puerto, leído de sus
                    service-ports. Es la fuente buena: nuestra base guarda una
                    sola VLAN por ONU y así se pierde la de gestión, que también
                    está pasando por ahí. En ámbar, la que no coincide con la
                    asignada: es lo que falta migrar. */}
                <td className="px-3 py-2 text-xs">
                  {p.vlans_del_equipo?.length ? (
                    <div className="flex flex-wrap gap-1">
                      {p.vlans_del_equipo.map((v) => (
                        <span
                          key={v.vlan}
                          title={
                            v.de_servicio === false
                              ? `VLAN ${v.vlan}: no lleva abonados. ${v.service_ports} service-ports.`
                              : `${v.service_ports} service-ports con la VLAN ${v.vlan}`
                          }
                          className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
                            v.de_servicio === false
                              ? // La de gestión está en todos los puertos por
                                // diseño. Pintarla de alerta sería un aviso
                                // siempre encendido, y esos no se miran.
                                'bg-slate-800/60 text-slate-500'
                              : p.vlan != null && v.vlan !== p.vlan
                                ? 'bg-amber-500/15 text-amber-300'
                                : 'bg-slate-800 text-slate-200'
                          }`}
                        >
                          {v.vlan}
                          <span className="ml-1 text-slate-500">{v.service_ports}</span>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-slate-600">sin service-ports</span>
                  )}
                </td>

                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variante="fantasma"
                      onClick={() => {
                        setEditando(p.etiqueta)
                        setValor(p.vlan ?? '')
                      }}
                    >
                      {p.vlan == null ? 'Asignar VLAN' : 'Cambiar'}
                    </Button>
                    {/* Quita la anotación, no la VLAN. Son cosas distintas y
                        confundirlas es caro: esto no toca el equipo ni deja a
                        nadie sin servicio; borrar la VLAN sí. */}
                    {p.vlan != null && (
                      <Button
                        variante="fantasma"
                        title={`Olvidar que la VLAN ${p.vlan} es la de este puerto. No toca el equipo.`}
                        onClick={async () => {
                          setError(null)
                          try {
                            await api.olt.desasignarPuerto(olt.id, p.slot, p.puerto)
                            await leer()
                          } catch (err) {
                            setError(err)
                          }
                        }}
                      >
                        Quitar
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            )}
          />
        </div>
      ))}
    </div>
  )
}

/**
 * Una VLAN y un bloque de IP para cada puerto PON, de una vez.
 *
 * Es el esquema que este ISP ya tiene armado a mano en la MA5608T: dos /25 por
 * cada /24, uno por puerto, con el gateway en la primera dirección.
 *
 *     vlan116  172.16.8.0/25    gw 172.16.8.1     .2 → .126     PON 0
 *     vlan117  172.16.8.128/25  gw 172.16.8.129   .130 → .254   PON 1
 *
 * Repetirlo en otra OLT son dieciséis VLANs, dieciséis subredes y dieciséis
 * gateways escritos uno por uno. Es donde aparece el octeto salteado, y eso no
 * se nota hasta que dos abonados terminan con la misma dirección.
 *
 * Va en dos pasos a propósito: primero se ve la tabla entera con los avisos de
 * lo que choca con algo que ya existe, y recién después se crea.
 */
function EsquemaPorPuerto({ olt, form, setForm, onListo, onCancelar }) {
  const [routers, setRouters] = useState([])
  const [plan, setPlan] = useState(null)
  const [error, setError] = useState(null)
  const [trabajando, setTrabajando] = useState(false)
  const [hecho, setHecho] = useState(null)

  useEffect(() => {
    supabase
      .from('routers_mikrotik')
      .select('id, nombre')
      .eq('activo', true)
      .order('nombre')
      .then(({ data }) => setRouters(data ?? []))
  }, [])

  const set = (campo) => (e) => {
    setForm({ ...form, [campo]: e.target.value })
    // Cambiar un parámetro invalida la tabla que se está viendo. Dejarla en
    // pantalla invitaría a crear un esquema distinto del que se calculó.
    setPlan(null)
  }

  async function correr(fn, guardar) {
    setTrabajando(true)
    setError(null)
    try {
      guardar(await fn())
    } catch (err) {
      setError(err)
    } finally {
      setTrabajando(false)
    }
  }

  if (hecho) {
    return (
      <div className="space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
        <p className="text-sm font-semibold text-emerald-200">
          {hecho.creadas} {hecho.creadas === 1 ? 'bloque creado' : 'bloques creados'}
          {hecho.pools ? ` · ${hecho.pools} pools en el router` : ''}
          {hecho.omitidas ? ` · ${hecho.omitidas} sin crear` : ''}
        </p>
        {hecho.resultados
          ?.filter((r) => !r.hecho || r.avisos?.length)
          .map((r) => (
            <p key={r.puerto} className="text-xs text-amber-300">
              PON {r.puerto} · VLAN {r.vlan}: {r.motivo ?? r.avisos?.join(' · ')}
            </p>
          ))}
        <Aviso>
          Falta poner <b>la VLAN en el troncal</b> (pestaña Uplink): sin eso las ONTs se ven online y
          el abonado no navega.
          {hecho.pppoe ? (
            <>
              {' '}
              Y del lado del router falta, por cada VLAN, la <b>interfaz</b> y su{' '}
              <b>servidor PPPoE</b> — sin uno escuchando en esa VLAN el abonado no autentica.
            </>
          ) : (
            <> Y si no elegiste MikroTik, falta el <b>gateway y el pool</b> del lado del router.</>
          )}
        </Aviso>
        <Button variante="primario" onClick={onListo}>
          Listo
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <p className="text-sm font-semibold text-sky-200">Una VLAN y un bloque por puerto PON</p>
      <p className="text-xs leading-snug text-sky-200/80">
        El puerto {form.desdePuerto} usa la VLAN {form.desdeVlan} y el primer bloque, el{' '}
        {Number(form.desdePuerto) + 1} la {Number(form.desdeVlan) + 1} y el siguiente, y así. Con un
        /25 entran dos puertos en cada /24.
      </p>

      {form.pppoe === 'si' && (
        <p className="text-xs leading-snug text-sky-200/60">
          En PPPoE el bloque <b>no se pone en ninguna interfaz</b>: cada sesión levanta su propia
          ruta /32. Se crea el pool y nada más.
          {form.gateway === 'compartido' ? (
            <> Con el gateway compartido no se reserva ninguna dirección: cada /25 entrega 126.</>
          ) : (
            <>
              {' '}
              Con un gateway por bloque hace falta <b>un perfil PPP por VLAN</b>, cada uno con esa
              dirección como local-address. Cada /25 entrega 125.
            </>
          )}
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-4">
        <Field label="Placa">
          <Input type="number" value={form.slot} onChange={set('slot')} />
        </Field>
        <Field label="Desde el puerto">
          <Input type="number" value={form.desdePuerto} onChange={set('desdePuerto')} />
        </Field>
        <Field label="Hasta el puerto">
          <Input type="number" value={form.hastaPuerto} onChange={set('hastaPuerto')} />
        </Field>
        <Field label="VLAN inicial">
          <Input type="number" value={form.desdeVlan} onChange={set('desdeVlan')} />
        </Field>

        {/* Sin esto el nombre toma el de la OLT entero —"OLT X7 LA MANA"— con
            espacios y todo. En la MA5608T los pools se llaman "…_MA5608T". */}
        <Field label="Sufijo del nombre" hint="va al final: BOARD6_PON0_VLAN202_X7">
          <Input value={form.olt} onChange={set('olt')} placeholder="X7" spellCheck={false} />
        </Field>

        <Field label="Primer bloque" hint="dónde arranca el primero" className="sm:col-span-2">
          <Input
            value={form.bloqueBase}
            onChange={set('bloqueBase')}
            placeholder="172.16.16.0"
            spellCheck={false}
          />
        </Field>
        <Field label="Tamaño" hint="/25 son 128 direcciones">
          <Select value={form.prefijo} onChange={set('prefijo')}>
            <option value={24}>/24 — 256</option>
            <option value={25}>/25 — 128</option>
            <option value={26}>/26 — 64</option>
            <option value={27}>/27 — 32</option>
          </Select>
        </Field>
        {/* Dos decisiones independientes. Estaban en un solo campo y por eso
            no se podía pedir "PPPoE con un gateway por VLAN". */}
        <Field label="Cómo se reparte">
          <Select value={form.pppoe} onChange={set('pppoe')}>
            <option value="si">PPPoE</option>
            <option value="no">IP fija en la interfaz</option>
          </Select>
        </Field>

        <Field
          label="Gateway"
          hint={
            form.gateway === 'compartido'
              ? 'uno solo para todos los bloques'
              : 'el de cada bloque · reserva una dirección'
          }
        >
          <Select value={form.gateway} onChange={set('gateway')}>
            <option value="compartido">Compartido — ninguno en el bloque</option>
            <option value="inicio">Al principio de cada bloque (.1)</option>
            <option value="fin">Al final de cada bloque (.254)</option>
          </Select>
        </Field>

        {/* En PPPoE cada sesión es punto a punto y levanta su propia ruta /32:
            no hay ARP ni dominio de broadcast, y el bloque no vive en ninguna
            interfaz. El gateway del abonado es el local-address del perfil, uno
            solo para todos los bloques. */}
        {form.gateway === 'compartido' && (
          <Field
            label="Local-address del perfil PPP"
            hint="la puerta de enlace que reciben todos los abonados"
            className="sm:col-span-2"
          >
            <Input
              value={form.gatewayPppoe}
              onChange={set('gatewayPppoe')}
              placeholder="172.17.0.1"
              spellCheck={false}
            />
          </Field>
        )}

        {/* --- El lado del MikroTik ---
            El pool es lo que hace que el alta pueda sacar la siguiente
            dirección libre sin que nadie escriba el rango a mano. */}
        <Field label="MikroTik" hint="dónde se crean los pools" className="sm:col-span-2">
          <Select value={form.routerId} onChange={set('routerId')}>
            <option value="">— no tocar el router —</option>
            {routers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.nombre}
              </option>
            ))}
          </Select>
        </Field>
        {form.pppoe === 'no' && (
          <Field
            label="Interfaz de la VLAN"
            hint="vacío = no poner el gateway; tiene que existir ya"
            className="sm:col-span-2"
          >
            <Input
              value={form.interfaz}
              onChange={set('interfaz')}
              placeholder="vlan{vlan}"
              spellCheck={false}
              disabled={!form.routerId}
            />
          </Field>
        )}
      </div>

      {!plan && (
        <div className="flex gap-2">
          <Button
            variante="primario"
            icon={Wand2}
            cargando={trabajando}
            onClick={() =>
              correr(() => api.olt.esquemaSimular(olt.id, { ...form, pppoe: form.pppoe === 'si' }), setPlan)
            }
          >
            Ver el plan
          </Button>
          <Button variante="fantasma" onClick={onCancelar}>
            Cancelar
          </Button>
        </div>
      )}

      {plan && (
        <>
          <Table
            columnas={['PON', 'VLAN', 'Bloque', 'Gateway', 'Para abonados', 'Nombre', '']}
            filas={plan.filas}
            renderFila={(f) => (
              <tr
                key={`${f.slot}/${f.puerto}`}
                className={f.listo ? 'text-slate-300' : 'text-slate-500'}
              >
                <td className="px-3 py-2 font-mono text-sm text-slate-100">
                  {f.slot}/{f.puerto}
                </td>
                <td className="px-3 py-2 font-mono text-sm">{f.vlan}</td>
                <td className="px-3 py-2 font-mono text-xs">{f.cidr}</td>
                <td className="px-3 py-2 font-mono text-xs">{f.gateway}</td>
                <td className="px-3 py-2 font-mono text-[11px]">
                  {f.rango} <span className="text-slate-500">({f.direcciones})</span>
                </td>
                <td className="px-3 py-2 font-mono text-[11px]">{f.nombre}</td>
                <td className="px-3 py-2">
                  <div className="space-y-0.5">
                    {f.avisos.map((a, i) => (
                      <p
                        key={i}
                        className={`text-xs ${
                          a.grave
                            ? 'text-rose-400'
                            : a.cambia_predeterminada
                              ? 'text-sky-400'
                              : 'text-amber-400'
                        }`}
                      >
                        {a.texto}
                      </p>
                    ))}
                  </div>
                </td>
              </tr>
            )}
          />

          {!plan.equipo_leido && (
            <Aviso tipo="alerta">
              No se pudo leer las VLANs del equipo, así que no sabemos cuáles hay que crear. Se van a
              crear igual las que falten al aplicar.
            </Aviso>
          )}

          {plan.cambian_de_vlan > 0 && (
            <Aviso>
              A <b>{plan.cambian_de_vlan}</b> puertos les cambia la VLAN predeterminada. Eso{' '}
              <b>no toca a los abonados que ya tienen</b>: siguen en la VLAN que su ONT tiene puesta
              y se los migra de a uno. Lo que cambia es por dónde sale un alta nueva de ese puerto.
            </Aviso>
          )}

          {plan.con_problemas > 0 && (
            <Aviso tipo="alerta">
              {plan.con_problemas} {plan.con_problemas === 1 ? 'fila choca' : 'filas chocan'} con algo
              que ya existe y <b>no se van a crear</b>. Corregí el bloque o la VLAN inicial, o creá
              el resto y esas a mano.
            </Aviso>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variante="primario"
              icon={Plus}
              cargando={trabajando}
              onClick={() =>
                correr(
                  () =>
                    api.olt.esquemaAplicar(olt.id, {
                      filas: plan.filas,
                      routerId: form.routerId || null,
                      interfaz: form.routerId ? form.interfaz : '',
                    }),
                  setHecho,
                )
              }
            >
              Crear {plan.filas.length - plan.con_problemas}
              {plan.a_crear_en_el_equipo ? ` (y ${plan.a_crear_en_el_equipo} VLANs en el equipo)` : ''}
            </Button>
            <Button variante="fantasma" onClick={() => setPlan(null)}>
              Cambiar los datos
            </Button>
            <Button variante="fantasma" onClick={onCancelar}>
              Cancelar
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Deshacer un esquema por puerto.
 *
 * Saca las tres cosas de una: el bloque, su pool en el router y la VLAN que el
 * puerto tenía asignada. Antes había que ir a tres pantallas, y quien iba a dos
 * quedaba con el generador bloqueado sin entender el motivo — los bloques ya no
 * estaban pero los puertos seguían con su VLAN puesta.
 *
 * Nunca toca un puerto con abonados ni un bloque con direcciones entregadas: se
 * los saltea y lo dice. Limpiar nueve y dejar siete es lo correcto; trabar los
 * dieciséis por esos siete no le serviría a nadie.
 */
function DeshacerEsquema({ olt, onListo, onCancelar }) {
  const [form, setForm] = useState({ slot: 6, desdePuerto: 0, hastaPuerto: 15 })
  const [revision, setRevision] = useState(null)
  const [error, setError] = useState(null)
  const [trabajando, setTrabajando] = useState(false)
  const [hecho, setHecho] = useState(null)

  const set = (campo) => (e) => {
    setForm((f) => ({ ...f, [campo]: e.target.value }))
    setRevision(null)
  }

  const correr = async (aplicar) => {
    setTrabajando(true)
    setError(null)
    try {
      const r = await api.olt.esquemaDeshacer(olt.id, { ...form, aplicar })
      if (aplicar) setHecho(r)
      else setRevision(r)
    } catch (err) {
      setError(err)
    } finally {
      setTrabajando(false)
    }
  }

  if (hecho) {
    return (
      <div className="space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
        <p className="text-sm font-semibold text-emerald-200">
          {hecho.puertos} puertos limpiados · {hecho.bloques} bloques borrados · {hecho.pools} pools
        </p>
        {hecho.fallos?.length > 0 &&
          hecho.fallos.map((f) => (
            <p key={f} className="text-xs text-amber-400">
              {f}
            </p>
          ))}
        <Aviso>{hecho.nota}</Aviso>
        <Button variante="primario" onClick={onListo}>
          Listo
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />
      <p className="text-sm font-semibold text-rose-200">Deshacer un esquema por puerto</p>
      <p className="text-xs leading-snug text-rose-200/80">
        Saca el bloque, su pool del router y la VLAN del puerto. Los puertos con abonados y los
        bloques con direcciones entregadas <b>no se tocan</b>.
      </p>

      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="Placa">
          <Input type="number" value={form.slot} onChange={set('slot')} />
        </Field>
        <Field label="Desde el puerto">
          <Input type="number" value={form.desdePuerto} onChange={set('desdePuerto')} />
        </Field>
        <Field label="Hasta el puerto">
          <Input type="number" value={form.hastaPuerto} onChange={set('hastaPuerto')} />
        </Field>
      </div>

      {revision && (
        <>
          <p className="text-xs text-slate-400">
            {revision.resumen.se_limpian} puertos se limpian · {revision.resumen.se_dejan} se dejan ·{' '}
            {revision.resumen.bloques} bloques
          </p>
          <div className="max-h-56 overflow-y-auto rounded border border-slate-800">
            <table className="w-full text-xs">
              <tbody>
                {revision.filas.map((f) => (
                  <tr key={f.etiqueta} className="border-b border-slate-800/60 last:border-0">
                    <td className="px-2 py-1 font-mono text-slate-300">{f.etiqueta}</td>
                    <td className="px-2 py-1 font-mono text-slate-100">vlan {f.vlan}</td>
                    <td className="px-2 py-1 font-mono text-[11px] text-slate-500">
                      {f.bloques.map((b) => b.cidr).join(' ') || '—'}
                    </td>
                    <td className="px-2 py-1 text-[11px]">
                      {f.se_quita_la_vlan ? (
                        <span className="text-rose-400">se borra</span>
                      ) : (
                        <span className="text-slate-500">{f.motivo}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="flex flex-wrap gap-2">
        {!revision ? (
          <Button variante="primario" cargando={trabajando} onClick={() => correr(false)}>
            Ver qué se borraría
          </Button>
        ) : (
          <Button
            variante="peligro"
            icon={Trash2}
            cargando={trabajando}
            disabled={!revision.resumen.se_limpian}
            onClick={() => correr(true)}
          >
            Borrar {revision.resumen.se_limpian} puertos y {revision.resumen.bloques} bloques
          </Button>
        )}
        <Button variante="fantasma" onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}
