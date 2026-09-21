import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowLeft, Clock } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../lib/apiNetwork'
import AvisosPagoPrueba from '../components/ajustes/AvisosPagoPrueba'
import MoraPrueba from '../components/ajustes/MoraPrueba'
import { Aviso, Button, Card, Cargando, ErrorBanner, Field, Input } from '../components/ui'

/**
 * Los automatismos: qué corre solo y cuándo.
 *
 * Cada uno se muestra con lo que hace y, si tiene consecuencias visibles para
 * el abonado, con la advertencia de cuáles son. Un interruptor que dice
 * "cortes_automaticos" y nada más se enciende sin saber que va a dejar gente
 * sin internet — y eso pasa una sola vez, pero pasa.
 */

/** Los campos de cada tarea, según cómo se programa. */
const CAMPOS = {
  cortes: [
    { campo: 'cortes_hora', label: 'Hora', tipo: 'hora' },
    {
      campo: 'cortes_limite',
      label: 'Tope por corrida',
      tipo: 'numero',
      // Este no acepta 0: la base lo exige entre 1 y 100000. No hace falta, son
      // las promesas incumplidas del día y son pocas por definición.
      hint: 'Son las promesas incumplidas del día: normalmente son pocas',
    },
  ],
  facturacion: [{ campo: 'facturacion_hora', label: 'Hora', tipo: 'hora' }],
  comisiones: [{ campo: 'comisiones_hora', label: 'Hora', tipo: 'hora' }],
  cartera: [{ campo: 'cartera_hora', label: 'Hora', tipo: 'hora' }],
  stock: [{ campo: 'stock_hora', label: 'Hora', tipo: 'hora' }],
  avisos_pago: [{ campo: 'avisos_pago_hora', label: 'Hora', tipo: 'hora' }],
  mora: [
    { campo: 'mora_hora', label: 'Hora', tipo: 'hora' },
    {
      campo: 'mora_limite',
      label: 'Máximo por corrida',
      tipo: 'numero',
      /**
       * El texto anterior —"freno de mano: nadie deja sin internet a 500 casas
       * en una madrugada"— defendía un tope que no hacía falta. Medido contra el
       * router real: 9 ms por corte, unos 7000 por minuto. Y si el corte salió de
       * una factura mal creada, se anula la factura y la barrida los reconecta
       * en quince minutos sin tocar nada.
       */
      hint: '0 = sin tope, corta a todos los que deben. Si ponés un número y se alcanza, el resto queda sin cortar hasta mañana.',
    },
    {
      campo: 'mora_reconexion_segundos',
      label: 'Atender la cola cada',
      tipo: 'numero',
      hint: 'Segundos. El pago encola la reconexión y esto la ejecuta',
    },
    {
      campo: 'mora_barrida_minutos',
      label: 'Barrida de seguridad cada',
      tipo: 'minutos',
      hint: 'Recoge lo que la cola no atrapó',
    },
  ],
  consumo: [{ campo: 'consumo_cada_minutos', label: 'Cada', tipo: 'minutos' }],
  alertas: [{ campo: 'alertas_cada_minutos', label: 'Cada', tipo: 'minutos' }],
  nms: [
    { campo: 'nms_cada_minutos', label: 'Cada', tipo: 'minutos' },
    {
      campo: 'nms_paquetes',
      label: 'Pings por sondeo',
      tipo: 'numero',
      hint: 'Con menos, una pérdida puntual se lee como caída',
    },
  ],
  optica: [{ campo: 'optica_cada_minutos', label: 'Cada', tipo: 'minutos' }],
  esperando: [{ campo: 'esperando_cada_minutos', label: 'Cada', tipo: 'minutos' }],
}

/** La columna que enciende cada tarea. */
const LLAVE = {
  cortes: 'cortes_automaticos',
  facturacion: 'facturacion_automatica',
  optica: 'optica_automatica',
  consumo: 'consumo_automatico',
  nms: 'nms_automatico',
  esperando: 'esperando_automatico',
  // Sin estas dos, el interruptor de la tarea se dibuja apagado y al tocarlo
  // guarda en un campo `undefined`: la tarea no se puede encender desde acá y no
  // hay ningún error que lo explique.
  comisiones: 'comisiones_automatico',
  cartera: 'cartera_automatico',
  alertas: 'alertas_automaticas',
  stock: 'stock_automatico',
  avisos_pago: 'avisos_pago_automatico',
  mora: 'mora_automatico',
  firmas: 'firmas_automatico',
  // La de incidencias enciende por `cola_activa` y no por `automatico`: son
  // dos interruptores distintos y el segundo —que el monitoreo ABRA la
  // incidencia solo— se configura en la pantalla de cortes masivos.
  incidencias: 'incidencias_cola_activa',
}

export default function TareasPage() {
  const [datos, setDatos] = useState(null)
  const [form, setForm] = useState({})
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado] = useState(false)
  const [error, setError] = useState(null)

  const recargar = () =>
    api.tareas
      .estado()
      .then((d) => {
        setDatos(d)
        setForm(d.valores)
      })
      .catch(setError)

  useEffect(() => {
    recargar().finally(() => setCargando(false))
  }, [])

  const set = (campo, valor) => {
    setGuardado(false)
    setForm((f) => ({ ...f, [campo]: valor }))
  }

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setGuardado(false)
    setError(null)
    try {
      const d = await api.tareas.guardar(form)
      setDatos(d)
      setForm(d.valores)
      setGuardado(true)
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  if (cargando) return <Cargando />

  return (
    <div className="space-y-4">
      <Link to="/ajustes" className="inline-flex items-center gap-1 text-sm text-slate-400">
        <ArrowLeft size={15} /> Volver a Ajustes
      </Link>

      <div>
        <h1 className="t-titulo text-lg font-bold text-slate-100">Tareas programadas</h1>
        <p className="mt-0.5 max-w-3xl text-xs leading-snug text-slate-500">
          Lo que el sistema hace solo, sin que nadie apriete nada. Los cambios se aplican al
          guardar: no hace falta reiniciar el servidor.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <form onSubmit={guardar} className="space-y-3">
        {datos.tareas.map((t) => (
          <Tarea
            key={t.clave}
            tarea={t}
            form={form}
            set={set}
            ultima={datos.ultimas_corridas?.[t.clave]}
          />
        ))}

        {guardado && <Aviso>Guardado. Los automatismos ya se reprogramaron.</Aviso>}

        <div className="flex justify-end">
          <Button type="submit" variante="primario" cargando={guardando}>
            Guardar
          </Button>
        </div>
      </form>
    </div>
  )
}

function Tarea({ tarea, form, set, ultima }) {
  const encendida = Boolean(form[LLAVE[tarea.clave]])

  return (
    <Card>
      <div className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          {/* El interruptor primero: es lo que se viene a tocar. */}
          <label className="mt-0.5 flex cursor-pointer items-center">
            <input
              type="checkbox"
              checked={encendida}
              onChange={(e) => set(LLAVE[tarea.clave], e.target.checked)}
              className="size-4 cursor-pointer"
            />
          </label>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-100">{tarea.nombre}</h3>
              {tarea.corriendo && (
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                  corriendo
                </span>
              )}
              {/* De dónde salió el encendido. Explica por qué algo corre aunque
                  nadie lo haya tocado desde acá, y es lo que hay que migrar
                  antes de entregarle el sistema a otra empresa. */}
              {tarea.desde_archivo && (
                <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">
                  viene del .env
                </span>
              )}
              {ultima && (
                <span className="text-[11px] text-slate-500">última corrida: {ultima}</span>
              )}
            </div>

            <p className="mt-0.5 text-xs leading-snug text-slate-500">{tarea.que}</p>

            {/* La advertencia solo cuando está por encenderse o ya lo está:
                si va a quedar apagada, no hay nada de qué advertir. */}
            {tarea.cuidado && encendida && (
              <p className="mt-2 flex gap-1.5 text-xs leading-snug text-amber-400">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                {tarea.cuidado}
              </p>
            )}

            {/* La prueba en seco va SIEMPRE, encendida o apagada: es lo que
                permite decidir si encenderla. Escondida detrás del interruptor
                obligaría a encender la tarea para poder mirarla. */}
            {tarea.clave === 'avisos_pago' && <AvisosPagoPrueba />}
            {tarea.clave === 'mora' && <MoraPrueba />}

            {encendida && CAMPOS[tarea.clave] && (
              <div className="mt-3 flex flex-wrap gap-3">
                {CAMPOS[tarea.clave].map((c) => (
                  <Field
                    key={c.campo}
                    label={c.label}
                    hint={c.hint}
                    className={c.tipo === 'hora' ? 'w-28' : 'w-40'}
                  >
                    {c.tipo === 'hora' ? (
                      <Input
                        type="time"
                        value={form[c.campo] ?? ''}
                        onChange={(e) => set(c.campo, e.target.value)}
                      />
                    ) : (
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={1}
                          value={form[c.campo] ?? ''}
                          onChange={(e) => set(c.campo, e.target.value)}
                        />
                        {c.tipo === 'minutos' && (
                          <span className="whitespace-nowrap text-xs text-slate-500">min</span>
                        )}
                      </div>
                    )}
                  </Field>
                ))}
              </div>
            )}
          </div>

          <Clock size={16} className={encendida ? 'text-sky-400' : 'text-slate-700'} />
        </div>
      </div>
    </Card>
  )
}
