import { useCallback, useEffect, useState } from 'react'
import { CalendarDays, Camera, CameraOff, Clock, MapPin, X } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { urlDeFoto } from '../../lib/jornadaFoto'
import { RADIO_LLEGADA_M } from '../../lib/soporte'
import { Card, ErrorBanner, Input, Modal, SkeletonTabla, Stat } from '../../components/ui'

/**
 * Los ingresos del día: quién arrancó, a qué hora y con qué foto.
 *
 * ── Para qué sirve mirar esto ──
 *
 * La hora sola no prueba nada: la marca quien aprieta el botón, desde donde
 * sea. Con la foto al lado, un vistazo de treinta segundos contesta de quién es
 * cada ingreso y en qué condiciones salió — que es lo que antes había que
 * preguntar por teléfono, de a uno.
 *
 * ── Por qué la falta de foto se muestra, no se esconde ──
 *
 * El técnico puede abrir la jornada sin señal, y ahí la foto sube más tarde o
 * no sube. Esa fila tiene que verse igual y decir que falta: una pantalla que
 * mostrara solo los ingresos CON foto daría la impresión de que todos
 * cumplieron, cuando justamente los que faltan son los que hay que mirar.
 *
 * ── Por qué la hora de la foto va aparte ──
 *
 * Porque no son la misma cosa. Una jornada abierta a las 7:05 con foto subida
 * a las 9:20 es alguien que trabajó dos horas sin cobertura — no alguien que
 * llegó a las nueve. Mezclar las dos horas en una sola columna inventaría una
 * acusación.
 */

const hoyLocal = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

const hora = (v) =>
  v
    ? new Date(v).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })
    : '—'

export default function JornadasPage() {
  const [fecha, setFecha] = useState(hoyLocal)
  const [filas, setFilas] = useState(null)
  const [error, setError] = useState(null)
  const [mirando, setMirando] = useState(null)

  const cargar = useCallback(async () => {
    setFilas(null)
    const { data, error: err } = await supabase
      .from('v_jornadas')
      .select('*')
      .eq('fecha', fecha)
      .order('inicio_at', { ascending: true, nullsFirst: false })

    if (err) {
      // Sin la 188 no existen las columnas de la foto y la consulta sale igual,
      // así que el error acá es otra cosa: se muestra tal cual.
      setError(err)
      setFilas([])
      return
    }
    setError(null)
    setFilas(data ?? [])
  }, [fecha])

  useEffect(() => {
    cargar()
  }, [cargar])

  /**
   * La URL firmada se pide al abrir, no al listar.
   *
   * Listar veinte filas pediría veinte URLs que casi nadie va a usar, y cada
   * una queda registrada como un acceso a la foto de un empleado. Se pide la
   * de la que se mira.
   */
  async function abrirFoto(j) {
    setMirando({ jornada: j, url: null })
    const url = await urlDeFoto(j.foto_ingreso)
    setMirando({ jornada: j, url })
  }

  const conFoto = (filas ?? []).filter((j) => j.foto_ingreso).length
  const sinFoto = (filas ?? []).filter((j) => j.inicio_at && !j.foto_ingreso).length
  // Solo los que se pudieron medir con confianza: un GPS que informa más error
  // que la distancia medida no alcanza para contar a nadie como "lejos".
  const lejos = (filas ?? []).filter(
    (j) =>
      j.distancia_ingreso_m != null &&
      j.distancia_ingreso_m > RADIO_LLEGADA_M &&
      !(j.precision_ingreso_m != null && j.precision_ingreso_m >= j.distancia_ingreso_m),
  ).length

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="t-titulo text-lg font-bold text-slate-100">Ingresos del día</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            A qué hora arrancó cada técnico y con qué foto
          </p>
        </div>
        <div className="w-44">
          <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Jornadas abiertas" valor={filas?.length ?? '—'} icon={CalendarDays} />
        <Stat label="Con foto" valor={conFoto} icon={Camera} color="text-emerald-400" />
        <Stat
          label="Sin foto"
          valor={sinFoto}
          icon={CameraOff}
          color={sinFoto ? 'text-amber-400' : 'text-slate-500'}
        />
        <Stat
          label={`Lejos del 1er trabajo`}
          valor={lejos}
          sub={`a más de ${RADIO_LLEGADA_M} m`}
          icon={MapPin}
          color={lejos ? 'text-amber-400' : 'text-slate-500'}
        />
      </div>

      <Card title="Ingresos" icon={Clock}>
        {filas === null ? (
          <SkeletonTabla filas={6} columnas={5} />
        ) : filas.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">
            Nadie abrió jornada este día.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filas.map((j) => (
              <div key={j.id} className="t-panel p-3">
                <div className="flex items-start gap-3">
                  {j.foto_ingreso ? (
                    <button
                      type="button"
                      onClick={() => abrirFoto(j)}
                      title="Ver la foto"
                      className="grid h-16 w-16 shrink-0 place-items-center rounded-xl bg-[#ECFDF5] text-emerald-400 transition hover:brightness-95"
                    >
                      <Camera size={22} />
                    </button>
                  ) : (
                    <span
                      title="Todavía no subió la foto"
                      className="grid h-16 w-16 shrink-0 place-items-center rounded-xl bg-slate-800 text-slate-600"
                    >
                      <CameraOff size={22} />
                    </span>
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="t-titulo truncate text-[13px] font-bold text-slate-100">
                      {j.tecnico ?? '—'}
                    </p>
                    <p className="t-dato mt-1 text-[11px] text-slate-500">
                      Entró {hora(j.inicio_at)}
                      {j.fin_at ? ` · salió ${hora(j.fin_at)}` : ''}
                    </p>
                    {j.vehiculo && (
                      <p className="mt-0.5 truncate text-[11px] text-slate-500">
                        {j.vehiculo}
                        {j.placa ? ` · ${j.placa}` : ''}
                      </p>
                    )}
                    {/* Solo cuando difiere de la entrada: si subió al toque, el
                        dato no agrega nada y ocupa una línea. */}
                    {j.foto_ingreso_at && hora(j.foto_ingreso_at) !== hora(j.inicio_at) && (
                      <p className="t-dato mt-0.5 text-[11px] text-amber-400">
                        Foto subida {hora(j.foto_ingreso_at)}
                      </p>
                    )}
                    {!j.foto_ingreso && (
                      <p className="mt-0.5 text-[11px] font-medium text-amber-400">Sin foto</p>
                    )}

                    <Distancia j={j} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal
        abierto={!!mirando}
        titulo={mirando?.jornada?.tecnico ?? 'Foto de ingreso'}
        onCerrar={() => setMirando(null)}
        ancho="max-w-md"
      >
        {mirando && (
          <div className="space-y-3">
            {mirando.url ? (
              <img
                src={mirando.url}
                alt={`Ingreso de ${mirando.jornada.tecnico ?? ''}`}
                className="w-full rounded-xl"
              />
            ) : (
              <div className="grid h-64 place-items-center rounded-xl bg-slate-800 text-sm text-slate-500">
                Cargando…
              </div>
            )}
            <p className="t-dato text-center text-[11px] text-slate-500">
              Entró {hora(mirando.jornada.inicio_at)} · foto {hora(mirando.jornada.foto_ingreso_at)}
            </p>
            {/* La dirección se vence sola: es una foto de una persona, y una
                URL copiada no puede seguir abriéndola dentro de seis meses. */}
            <p className="flex items-center justify-center gap-1 text-[11px] text-slate-600">
              <X size={11} /> El enlace de esta foto se vence en 5 minutos
            </p>
          </div>
        )}
      </Modal>
    </div>
  )
}

/**
 * Dónde marcó, respecto del primer trabajo del día.
 *
 * ── Los tres estados, y por qué son tres ──
 *
 * "Cerca" y "lejos" no alcanzan. Falta el que no se pudo medir, y es el que
 * más se presta a leerse mal: una jornada sin distancia no es una jornada
 * sospechosa, es una donde el GPS no respondió, el técnico no tenía señal o la
 * primera orden no tiene coordenada cargada — lo último es un problema de
 * datos de la oficina, no del técnico.
 *
 * Y hay un cuarto caso escondido en el segundo: cuando el GPS informa más
 * error que la distancia medida, el número existe pero no concluye nada. Se
 * muestra en gris, con el margen al lado, para que no se lea como una falta.
 */
function Distancia({ j }) {
  if (j.distancia_ingreso_m == null) {
    return (
      <p className="mt-0.5 text-[11px] text-slate-600">
        {j.inicio_at ? 'Sin ubicación al marcar' : ''}
      </p>
    )
  }

  const d = j.distancia_ingreso_m
  const err = j.precision_ingreso_m
  const dudoso = err != null && err >= d
  const lejos = d > RADIO_LLEGADA_M && !dudoso

  const texto =
    d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${d} m`

  return (
    <p
      className={`t-dato mt-0.5 flex items-center gap-1 text-[11px] ${
        dudoso ? 'text-slate-600' : lejos ? 'text-amber-400' : 'text-emerald-400'
      }`}
    >
      <MapPin size={11} className="shrink-0" />
      {texto} del 1er trabajo
      {dudoso && <span className="text-slate-600">· margen {err} m</span>}
    </p>
  )
}
