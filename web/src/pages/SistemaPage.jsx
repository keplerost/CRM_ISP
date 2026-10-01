import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Clock } from 'lucide-react'
import { api } from '../lib/apiNetwork'
import { Aviso, Button, Card, Cargando, ErrorBanner, Field, Select } from '../components/ui'

/**
 * La hora con la que trabaja el servidor.
 *
 * Existe porque en un VPS la máquina está en UTC, cinco horas adelante de
 * Ecuador: la facturación de la 01:00 salió a las 20:00 del día anterior, y
 * nadie podía ver por qué sin entrar por SSH. Acá se ve qué hora cree el
 * servidor que es, al lado de la del equipo de quien mira, y se corrige.
 */

/** Las de la región primero: son las que se van a buscar el 99 % de las veces. */
const DE_LA_REGION = [
  ['America/Guayaquil', 'Ecuador continental'],
  ['Pacific/Galapagos', 'Ecuador — Galápagos'],
  ['America/Bogota', 'Colombia'],
  ['America/Lima', 'Perú'],
  ['America/Caracas', 'Venezuela'],
  ['America/La_Paz', 'Bolivia'],
  ['America/Santiago', 'Chile'],
  ['America/Argentina/Buenos_Aires', 'Argentina'],
  ['America/Mexico_City', 'México (centro)'],
  ['America/Panama', 'Panamá'],
  ['America/Costa_Rica', 'Costa Rica'],
  ['America/Santo_Domingo', 'República Dominicana'],
  ['UTC', 'UTC (la hora de los servidores)'],
]

/** Todas las que conoce el navegador, por si el ISP está en otro lado. */
function todasLasZonas() {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return []
  }
}

const ZONA_DEL_EQUIPO = Intl.DateTimeFormat().resolvedOptions().timeZone

const escribirHora = (instante, zona) =>
  new Intl.DateTimeFormat('es-EC', { timeZone: zona, dateStyle: 'full', timeStyle: 'medium', hourCycle: 'h23' }).format(instante)

export default function SistemaPage() {
  const [reloj, setReloj] = useState(null)
  const [elegida, setElegida] = useState('')
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado] = useState(false)
  const [error, setError] = useState(null)
  // Para que los dos relojes avancen solos sin preguntarle al servidor cada segundo.
  const [ahora, setAhora] = useState(() => new Date())

  useEffect(() => {
    api.general
      .reloj()
      .then((r) => {
        setReloj(r)
        setElegida(r.zona)
      })
      .catch(setError)
      .finally(() => setCargando(false))
  }, [])

  useEffect(() => {
    const t = setInterval(() => setAhora(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const otras = useMemo(() => {
    const regionales = new Set(DE_LA_REGION.map(([z]) => z))
    return todasLasZonas().filter((z) => !regionales.has(z))
  }, [])

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setGuardado(false)
    setError(null)
    try {
      const r = await api.general.guardarZona(elegida)
      setReloj(r)
      setElegida(r.zona)
      setGuardado(true)
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  if (cargando) return <Cargando />

  const zonaServidor = reloj?.zona
  const distintas = zonaServidor && zonaServidor !== ZONA_DEL_EQUIPO
  // Se compara el texto de la hora y no el nombre de la zona: America/Bogota
  // y America/Guayaquil son nombres distintos con la misma hora, y eso no es
  // un problema que haya que señalar.
  const otraHora = zonaServidor && escribirHora(ahora, zonaServidor) !== escribirHora(ahora, ZONA_DEL_EQUIPO)

  return (
    <div className="space-y-4">
      <Link to="/ajustes" className="inline-flex items-center gap-1 text-sm text-slate-400">
        <ArrowLeft size={15} /> Volver a Ajustes
      </Link>

      <div>
        <h1 className="t-titulo text-lg font-bold text-slate-100">Sistema</h1>
        <p className="mt-0.5 max-w-3xl text-xs leading-snug text-slate-500">
          La zona horaria con la que corren la facturación, el corte por mora, los avisos y el resto
          de las tareas programadas.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <form onSubmit={guardar} className="space-y-4">
        <Card title="Zona horaria" subtitle="Qué hora cree el servidor que es" icon={Clock}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs text-slate-500">Hora del servidor</p>
              <p className="t-dato mt-0.5 text-sm text-slate-200">
                {zonaServidor ? escribirHora(ahora, zonaServidor) : '—'}
              </p>
              <p className="t-dato text-xs text-slate-500">
                {zonaServidor} · UTC{reloj?.desfase}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Hora de este equipo</p>
              <p className="t-dato mt-0.5 text-sm text-slate-200">{escribirHora(ahora, ZONA_DEL_EQUIPO)}</p>
              <p className="t-dato text-xs text-slate-500">{ZONA_DEL_EQUIPO}</p>
            </div>
          </div>

          {otraHora && (
            <div className="mt-4">
              <Aviso tipo="alerta">
                El servidor no tiene la misma hora que este equipo. Las tareas corren con la hora del
                servidor: una programada a la 01:00 sale a la 01:00 de <b>{zonaServidor}</b>, no a la
                tuya.
              </Aviso>
            </div>
          )}

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field
              label="Zona del ISP"
              hint="La del lugar donde están los abonados. Se aplica al guardar, sin reiniciar."
            >
              <Select value={elegida} onChange={(e) => { setElegida(e.target.value); setGuardado(false) }}>
                <optgroup label="La región">
                  {DE_LA_REGION.map(([z, nombre]) => (
                    <option key={z} value={z}>
                      {nombre} — {z}
                    </option>
                  ))}
                </optgroup>
                {otras.length > 0 && (
                  <optgroup label="Todas">
                    {otras.map((z) => (
                      <option key={z} value={z}>
                        {z}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
            </Field>
            {distintas && (
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => { setElegida(ZONA_DEL_EQUIPO); setGuardado(false) }}
                  className="pb-2 text-xs text-sky-400 hover:text-sky-300"
                >
                  Usar la de este equipo ({ZONA_DEL_EQUIPO})
                </button>
              </div>
            )}
          </div>

          <p className="mt-3 text-xs leading-snug text-slate-500">
            Al cambiarla se rearman las tareas. Una tarea diaria cuya hora ya pasó hoy en la zona nueva
            corre una vez en el acto, como hace siempre al arrancar el servidor. La facturación no
            duplica: la factura de un período que ya existe se saltea.
          </p>
        </Card>

        {guardado && <Aviso tipo="exito">Guardado. El servidor ya trabaja con la hora de {reloj?.zona}.</Aviso>}

        <div className="flex justify-end">
          <Button type="submit" variante="primario" cargando={guardando} disabled={!elegida || elegida === zonaServidor}>
            Guardar
          </Button>
        </div>
      </form>
    </div>
  )
}
