import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Network,
  RefreshCw,
  Search,
  Waves,
  XCircle,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { hace } from '../../lib/olts'
import DetalleTarjeta from '../../components/olt/DetalleTarjeta'
import AltasPorDia from '../../components/olt/AltasPorDia'
import AutorizarOnt from '../../components/olt/AutorizarOnt'
import VerOntEsperando from '../../components/olt/VerOntEsperando'
import Presets from '../../components/olt/Presets'
import Preautorizadas from '../../components/olt/Preautorizadas'
import ReemplazosPendientes from '../../components/olt/ReemplazosPendientes'
import TrasladosPendientes from '../../components/olt/TrasladosPendientes'
import { Aviso, Badge, Button, Card, ErrorBanner, Modal, Punto, Skeleton } from '../../components/ui'

/**
 * Tablero de OLT/GPON.
 *
 * Junta en una pantalla lo que hay que mirar todos los días, de todas las OLTs
 * a la vez. Las cuentas salen de vistas de la base y no de traerse las ONUs al
 * navegador: con mil abonados, contar del lado del cliente significa bajar mil
 * filas para mostrar cuatro números.
 *
 * Lo que se lee de la base es instantáneo; lo que hay que preguntarle a los
 * equipos va con su botón, porque cuesta segundos y consume sus sesiones. La
 * pantalla dice siempre de cuándo es cada dato: un tablero que muestra una
 * lectura de hace tres horas como si fuera de ahora es peor que uno vacío.
 */

const TARJETAS = {
  esperando: {
    titulo: 'Esperando autorización',
    icono: Search,
    clase: 'border-sky-500/40 bg-sky-500/10',
    texto: 'text-sky-300',
  },
  online: {
    titulo: 'En línea',
    icono: CheckCircle2,
    clase: 'border-emerald-500/40 bg-emerald-500/10',
    texto: 'text-emerald-300',
  },
  caidas: {
    titulo: 'Caídas',
    icono: XCircle,
    clase: 'border-slate-600 bg-slate-800/60',
    texto: 'text-slate-200',
  },
  senal: {
    titulo: 'Señal baja',
    icono: AlertTriangle,
    clase: 'border-amber-500/40 bg-amber-500/10',
    texto: 'text-amber-300',
  },
}

function Tarjeta({ clave, valor, sub, activa, onClick, cargando }) {
  const t = TARJETAS[clave]
  const Icono = t.icono
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border p-4 text-left transition hover:brightness-125 ${t.clase} ${
        activa ? 'ring-2 ring-sky-400/60' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {cargando ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <p className={`text-3xl font-semibold ${t.texto}`}>{valor}</p>
          )}
          <p className="mt-1 text-xs font-medium text-slate-300">{t.titulo}</p>
        </div>
        <Icono size={20} className={t.texto} />
      </div>
      {sub && <p className="mt-2 text-[11px] leading-snug text-slate-500">{sub}</p>}
    </button>
  )
}

export default function DashboardGponPage() {
  const [resumen, setResumen] = useState(null)
  const [puertos, setPuertos] = useState([])
  const [altas, setAltas] = useState([])
  const [eventos, setEventos] = useState([])
  const [error, setError] = useState(null)

  const [abierta, setAbierta] = useState(null)
  const [autorizando, setAutorizando] = useState(null)
  const [viendo, setViendo] = useState(null)
  // Los dos paneles trabajan contra UNA OLT: los IDs de perfil son de cada
  // equipo, así que "la OLT" no puede quedar implícita.
  const [panel, setPanel] = useState(null) // 'plantillas' | 'cargar'
  const [oltPanel, setOltPanel] = useState(null)
  const [presets, setPresets] = useState([])
  const [perfiles, setPerfiles] = useState(null)
  const [planes, setPlanes] = useState([])
  const [sondeando, setSondeando] = useState(false)
  const [esperando, setEsperando] = useState(null)
  const [buscandoNuevas, setBuscandoNuevas] = useState(false)

  const cargar = useCallback(async () => {
    const [r1, r2, r3, r4, r5, r6] = await Promise.all([
      supabase.from('v_olt_resumen').select('*').order('numero'),
      supabase.from('v_pon_puertos').select('*'),
      supabase.from('v_onus_por_dia').select('*').order('dia'),
      supabase
        .from('olt_historial')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(12),
      // Lo esperando se LEE de la base, no se consulta a los equipos: eso lo
      // hace la tarea de fondo cada pocos minutos. Abrir el tablero tiene que
      // ser instantáneo.
      supabase.from('v_esperando_autorizacion').select('*').order('numero'),
      supabase.from('onts_esperando').select('*').order('detectada'),
    ])

    const fallo = [r1, r2, r3, r4, r5, r6].find((r) => r.error)
    if (fallo) {
      setError(
        fallo.error.code === '42P01'
          ? {
              message: 'Faltan las vistas del tablero',
              hint: 'Corré supabase/migracion-40-dashboard-gpon.sql en el SQL Editor.',
            }
          : fallo.error,
      )
      setResumen([])
      return
    }

    setResumen(r1.data ?? [])
    setPuertos(r2.data ?? [])
    setAltas(r3.data ?? [])
    setEventos(r4.data ?? [])

    const porOlt = r5.data ?? []
    setEsperando({
      olts: porOlt.map((o) => ({
        olt_id: o.olt_id,
        olt: o.olt,
        numero: o.numero,
        puertos: o.puertos_consultados,
        descartadas: o.descartadas,
        ms: o.escaneo_ms,
        error: o.escaneo_error,
        at: o.escaneada_at,
        hace: o.escaneada_hace_segundos,
        tiene_snmp: o.tiene_snmp,
      })),
      onts: (r6.data ?? []).map((o) => ({ ...o, olt: porOlt.find((x) => x.olt_id === o.olt_id)?.olt })),
      // La antigüedad se toma del barrido MÁS VIEJO: decir "hace 1 minuto"
      // porque una de tres OLTs se escaneó recién ocultaría que las otras dos
      // llevan una hora sin consultarse.
      at: porOlt.map((o) => o.escaneada_at).filter(Boolean).sort()[0] ?? null,
    })
  }, [])

  useEffect(() => {
    cargar()
  }, [cargar])

  const cargarPresets = useCallback(async () => {
    try {
      setPresets(await api.olt.presets(oltPanel?.olt_id))
    } catch (err) {
      setError(err)
    }
  }, [oltPanel?.olt_id])

  // Los perfiles se le piden al equipo, así que solo cuando hace falta: al abrir
  // uno de los dos paneles, no al entrar al tablero.
  useEffect(() => {
    if (!panel || !oltPanel) return
    let vivo = true
    cargarPresets()
    supabase
      .from('planes_velocidad')
      .select('*')
      .order('bajada_kbps')
      .then(({ data }) => vivo && setPlanes(data ?? []))
    api.olt
      .perfilesOnt(oltPanel.olt_id)
      .then((p) => vivo && setPerfiles(p))
      .catch((err) => vivo && setError(err))
    return () => {
      vivo = false
    }
  }, [panel, oltPanel, cargarPresets])

  /** Alcance de todos los equipos: es un TCP por OLT, sale barato. */
  async function sondear() {
    setSondeando(true)
    try {
      await api.olt.estados()
      await cargar()
    } catch (err) {
      setError(err)
    } finally {
      setSondeando(false)
    }
  }

  /** Esto SÍ cuesta: son varios comandos por la CLI contra cada equipo. */
  async function buscarNuevas() {
    setBuscandoNuevas(true)
    setError(null)
    try {
      // El middleware barre y guarda; después se relee de la base. Así el
      // botón y la tarea automática dejan exactamente el mismo resultado.
      await api.olt.escanearEsperando()
      await cargar()
    } catch (err) {
      setError(err)
    } finally {
      setBuscandoNuevas(false)
    }
  }

  const total = useMemo(() => {
    const s = (campo) => (resumen ?? []).reduce((a, o) => a + (Number(o[campo]) || 0), 0)
    return {
      onus: s('onus'),
      online: s('online'),
      caidas: s('caidas'),
      los: s('los'),
      power_off: s('power_off'),
      sin_causa: s('sin_causa'),
      sin_lectura: s('sin_lectura'),
      critica: s('senal_critica'),
      aviso: s('senal_aviso'),
      sin_abonado: s('sin_abonado'),
    }
  }, [resumen])

  /** Abre uno de los dos paneles contra la OLT que más sentido tiene. */
  function abrirPanel(cual) {
    const conEspera = esperando?.onts?.[0]?.olt_id
    const lista = esperando?.olts ?? []
    setOltPanel(lista.find((o) => o.olt_id === conEspera) ?? lista[0] ?? null)
    setPerfiles(null)
    setPanel(cual)
  }

  const cargando = resumen === null
  const nuevasReales = esperando?.onts ?? []
  const puertosCaidos = puertos.filter((p) => p.puerto_caido)
  const puertosDegradados = puertos.filter((p) => p.puerto_degradado)
  const ultimaLectura = (resumen ?? []).map((o) => o.ultima_lectura).filter(Boolean).sort().pop()

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="t-titulo text-lg font-bold text-slate-100">Tablero GPON</h1>
          <p className="text-xs text-slate-500">
            {cargando
              ? 'Cargando…'
              : `${resumen.length} OLTs · ${total.onus} ONTs · óptica leída ${
                  ultimaLectura
                    ? hace(Math.floor((Date.now() - new Date(ultimaLectura)) / 1000))
                    : 'nunca'
                }`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button icon={RefreshCw} onClick={sondear} cargando={sondeando}>
            Probar alcance
          </Button>
          <Button variante="primario" icon={Search} onClick={buscarNuevas} cargando={buscandoNuevas}>
            Buscar ONTs nuevas
          </Button>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {/* Va antes que las tarjetas y no en una pestaña: es lo único de esta
          pantalla donde hay un abonado sin servicio ahora mismo, esperando algo
          que ya se sabe cómo arreglar. */}
      <ReemplazosPendientes onError={setError} />

      {/* Debajo del de reemplazos y no arriba: acá el abonado TIENE servicio.
          Es una tarea que traba un traslado, no una urgencia. El orden en la
          pantalla tiene que decir eso sin que haya que leerlo. */}
      <TrasladosPendientes onError={setError} />

      {/* --- Las cuatro tarjetas --- */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tarjeta
          clave="esperando"
          valor={nuevasReales.length}
          cargando={cargando}
          sub={
            esperando?.at
              ? `escaneado ${hace(Math.floor((Date.now() - new Date(esperando.at)) / 1000))}`
              : 'Todavía no se escaneó ninguna OLT'
          }
          activa={abierta === 'esperando'}
          onClick={() => setAbierta(abierta === 'esperando' ? null : 'esperando')}
        />
        <Tarjeta
          clave="online"
          valor={total.online}
          sub={`de ${total.onus} autorizadas`}
          cargando={cargando}
          activa={abierta === 'online'}
          onClick={() => setAbierta(abierta === 'online' ? null : 'online')}
        />
        <Tarjeta
          clave="caidas"
          valor={total.caidas}
          sub={
            total.caidas
              ? `LOS: ${total.los} · sin luz: ${total.power_off} · sin causa: ${total.sin_causa}`
              : 'ninguna caída'
          }
          cargando={cargando}
          activa={abierta === 'caidas'}
          onClick={() => setAbierta(abierta === 'caidas' ? null : 'caidas')}
        />
        <Tarjeta
          clave="senal"
          valor={total.critica + total.aviso}
          sub={`críticas: ${total.critica} · para mirar: ${total.aviso} · sin lectura: ${total.sin_lectura}`}
          cargando={cargando}
          activa={abierta === 'senal'}
          onClick={() => setAbierta(abierta === 'senal' ? null : 'senal')}
        />
      </div>

      {abierta && (
        <DetalleTarjeta
          tipo={abierta}
          esperando={esperando}
          onCerrar={() => setAbierta(null)}
          onBuscar={buscarNuevas}
          buscando={buscandoNuevas}
          onAutorizar={setAutorizando}
          onVer={setViendo}
          onPlantillas={() => abrirPanel('plantillas')}
          onCargarOnu={() => abrirPanel('cargar')}
        />
      )}

      <Modal
        abierto={panel !== null}
        titulo={panel === 'plantillas' ? 'Plantillas de autorización' : 'Cargar ONU para autorizar después'}
        onCerrar={() => setPanel(null)}
        ancho="max-w-4xl"
      >
        <div className="space-y-4">
          {(esperando?.olts ?? []).length > 1 && (
            <label className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              OLT:
              <select
                value={oltPanel?.olt_id ?? ''}
                onChange={(e) =>
                  setOltPanel((esperando?.olts ?? []).find((o) => o.olt_id === e.target.value) ?? null)
                }
                className="t-panel px-2 py-1 text-slate-100"
              >
                {(esperando?.olts ?? []).map((o) => (
                  <option key={o.olt_id} value={o.olt_id}>
                    {o.numero ? `${o.numero} · ` : ''}
                    {o.olt}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-slate-600">
                los perfiles y las plantillas se resuelven contra esta OLT
              </span>
            </label>
          )}

          {panel === 'plantillas' ? (
            <Presets
              olt={oltPanel ? { id: oltPanel.olt_id, nombre: oltPanel.olt } : null}
              perfiles={perfiles}
              planes={planes}
              onListo={cargarPresets}
            />
          ) : panel === 'cargar' ? (
            <Preautorizadas
              olt={oltPanel ? { id: oltPanel.olt_id, nombre: oltPanel.olt } : null}
              presets={presets}
              planes={planes}
              onListo={cargar}
            />
          ) : null}
        </div>
      </Modal>

      <Modal
        abierto={viendo !== null}
        titulo={`ONU ${viendo?.sn ?? ''}`}
        onCerrar={() => setViendo(null)}
        ancho="max-w-2xl"
      >
        {viendo && (
          <VerOntEsperando
            oltId={viendo.olt_id}
            sn={viendo.sn}
            // Recargar de la base, no volver a barrer todas las OLTs: el
            // resync ya preguntó por esta ONT y dejó la fila al día.
            onCambio={cargar}
            onCerrar={() => setViendo(null)}
            onAutorizar={() => {
              // Se pasa la fila de la lista, no la ficha: es la forma que el
              // formulario de autorización ya sabe leer.
              setViendo(null)
              setAutorizando(viendo)
            }}
          />
        )}
      </Modal>

      <Modal
        abierto={autorizando !== null}
        titulo={`Autorizar ${autorizando?.sn ?? ''}`}
        onCerrar={() => setAutorizando(null)}
        ancho="max-w-3xl"
      >
        {autorizando && (
          <AutorizarOnt
            olt={{ id: autorizando.olt_id, nombre: autorizando.olt }}
            ont={autorizando}
            onListo={cargar}
            onCancelar={() => setAutorizando(null)}
          />
        )}
      </Modal>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* --- Puertos con problemas --- */}
        <Card
          title="Puertos PON"
          subtitle="Cuando cae un puerto entero, la causa es la fibra o el módulo — no los equipos de los abonados"
          icon={Waves}
        >
          {cargando ? (
            <Skeleton className="h-24 w-full" />
          ) : puertosCaidos.length === 0 && puertosDegradados.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-emerald-300">
              <CheckCircle2 size={16} />
              Ningún puerto caído ni degradado.
            </div>
          ) : (
            <div className="space-y-2">
              {puertosCaidos.map((p) => (
                <div
                  key={`${p.olt_id}-${p.slot}-${p.puerto}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-500/50 bg-rose-500/10 px-3 py-2"
                >
                  <span className="text-sm text-rose-200">
                    <b>{p.olt}</b> · slot {p.slot} puerto {p.puerto}
                  </span>
                  <span className="text-xs text-rose-300/80">
                    {p.onus} ONTs, todas caídas — revisá la fibra o el módulo óptico
                  </span>
                </div>
              ))}
              {puertosDegradados.map((p) => (
                <div
                  key={`${p.olt_id}-${p.slot}-${p.puerto}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2"
                >
                  <span className="text-sm text-amber-200">
                    <b>{p.olt}</b> · slot {p.slot} puerto {p.puerto}
                  </span>
                  <span className="text-xs text-amber-300/80">
                    {p.caidas} de {p.onus} caídas — se está degradando
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* --- OLTs --- */}
        <Card title="OLTs" icon={Network}>
          {cargando ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <div className="space-y-2">
              {resumen.map((o) => (
                <Link
                  key={o.olt_id}
                  to={`/olts/${o.olt_id}`}
                  className="flex items-center justify-between gap-3 t-panel px-3 py-2.5 transition hover:border-slate-700 hover:bg-slate-900"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Punto estado={o.olt_estado} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-slate-100">
                        {o.numero} · {o.nombre}
                      </span>
                      <span className="block text-[11px] text-slate-500">
                        {o.hw_version ?? o.marca} · {o.onus} ONTs
                        {o.senal_critica > 0 && (
                          <span className="text-rose-400"> · {o.senal_critica} con señal baja</span>
                        )}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-medium text-emerald-400">{o.online}</span>
                    <span className="block text-[10px] text-slate-600">en línea</span>
                  </span>
                </Link>
              ))}
              {resumen.length === 0 && (
                <p className="py-4 text-center text-sm text-slate-500">No hay OLTs cargadas.</p>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card
          title="Autorizaciones por día"
          subtitle="Con la fecha que tiene el equipo, no la de importación"
          icon={BarChart3}
        >
          <AltasPorDia filas={altas} />
        </Card>

        <Card title="Actividad reciente" icon={Activity}>
          {eventos.length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-500">Sin cambios registrados.</p>
          ) : (
            <ul className="space-y-2">
              {eventos.map((e) => (
                <li key={e.id} className="flex items-start gap-2 text-xs">
                  <Badge color={e.accion === 'alta' ? 'verde' : 'gris'}>{e.accion}</Badge>
                  <span className="min-w-0 flex-1">
                    <span className="text-slate-300">{e.campo}</span>
                    {e.valor_despues && (
                      <span className="text-slate-500"> → {String(e.valor_despues).slice(0, 40)}</span>
                    )}
                    <span className="block text-[10px] text-slate-600">
                      {e.quien} ·{' '}
                      {hace(Math.floor((Date.now() - new Date(e.created_at)) / 1000))}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Lo que el tablero NO puede mostrar todavía, dicho en voz alta. */}
      <Aviso>
        Falta el gráfico de estado a lo largo del tiempo: este sistema todavía no guarda un
        histórico de cuántas ONTs estaban en línea en cada momento, y dibujarlo con los datos de
        hoy sería inventarlo. Se resuelve tomando una muestra cada tanto y guardándola — decime si
        lo querés y lo agrego.
      </Aviso>
    </div>
  )
}
