import { useEffect, useState } from 'react'
import { LifeBuoy, Loader2, Plus } from 'lucide-react'
import { portalApi } from '../../lib/portalApi'
import { Cargando, Tarjeta, Vacio } from './PortalApp'

/**
 * Reportar una falla y seguirla.
 *
 * Cuatro botones grandes en vez de una lista desplegable: el abonado está
 * enojado y con una mano. Y la descripción es un solo campo — todo lo demás
 * (su dirección, su teléfono, su caja NAP) ya lo tenemos, y pedírselo otra vez
 * es como termina un reclamo sin hacer y una llamada a la oficina.
 */

const TIPOS = [
  { valor: 'sin_internet', titulo: 'No tengo internet', ayuda: 'No conecta nada' },
  { valor: 'lento', titulo: 'Anda lento', ayuda: 'Conecta pero va despacio' },
  { valor: 'intermitente', titulo: 'Se corta a ratos', ayuda: 'Va y viene' },
  { valor: 'otro', titulo: 'Otra cosa', ayuda: 'Contanos qué pasa' },
]

const ESTADOS = {
  abierto: { texto: 'Recibido', color: 'text-sky-400' },
  asignado: { texto: 'Asignado a un técnico', color: 'text-sky-400' },
  en_ruta: { texto: 'El técnico va en camino', color: 'text-amber-400' },
  en_proceso: { texto: 'En atención', color: 'text-amber-400' },
  resuelto: { texto: 'Resuelto', color: 'text-emerald-400' },
  cancelado: { texto: 'Cancelado', color: 'text-slate-500' },
}

export default function PortalReclamos() {
  const [tickets, setTickets] = useState(null)
  const [creando, setCreando] = useState(false)

  const cargar = () => portalApi.tickets().then(setTickets).catch(() => setTickets([]))

  useEffect(() => {
    cargar()
  }, [])

  if (creando) {
    return (
      <Nuevo
        onListo={() => {
          setCreando(false)
          cargar()
        }}
        onCancelar={() => setCreando(false)}
      />
    )
  }

  if (!tickets) return <Cargando />

  return (
    <div className="space-y-3">
      <button
        onClick={() => setCreando(true)}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-sky-600 py-3.5 text-base font-medium text-white"
      >
        <Plus size={18} /> Reportar un problema
      </button>

      {!tickets.length ? (
        <Vacio icono={LifeBuoy}>
          No tenés reclamos. Si algo no anda, contanos y mandamos a alguien.
        </Vacio>
      ) : (
        tickets.map((t) => {
          const e = ESTADOS[t.estado] ?? { texto: t.estado, color: 'text-slate-400' }
          return (
            <Tarjeta key={t.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-slate-200">
                    {TIPOS.find((x) => x.valor === t.tipo_incidencia)?.titulo ?? t.tipo_incidencia}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{t.descripcion}</p>
                </div>
                <span className="shrink-0 text-xs text-slate-600">N° {t.numero}</span>
              </div>

              <p className={`mt-2 text-xs font-medium ${e.color}`}>{e.texto}</p>

              {/* La visita agendada, cuando la hay: es el dato por el que la
                  gente vuelve a llamar. */}
              {t.fecha_visita && t.estado !== 'resuelto' && (
                <p className="mt-1 text-xs text-slate-400">
                  Visita: {new Date(`${t.fecha_visita}T12:00:00`).toLocaleDateString('es-EC')}
                  {t.franja === 'manana' && ' por la mañana'}
                  {t.franja === 'tarde' && ' por la tarde'}
                </p>
              )}
            </Tarjeta>
          )
        })
      )}
    </div>
  )
}

function Nuevo({ onListo, onCancelar }) {
  const [tipo, setTipo] = useState(null)
  const [descripcion, setDescripcion] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState(null)
  const [hecho, setHecho] = useState(null)

  async function enviar(e) {
    e.preventDefault()
    setEnviando(true)
    setError(null)
    try {
      setHecho(await portalApi.abrirTicket(tipo, descripcion))
    } catch (err) {
      setError(err.message)
    } finally {
      setEnviando(false)
    }
  }

  if (hecho) {
    return (
      <div className="space-y-4 py-6 text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-full bg-emerald-500/15">
          <LifeBuoy size={26} className="text-emerald-400" />
        </div>
        <div>
          <p className="text-lg font-medium text-slate-100">Reclamo registrado</p>
          <p className="mt-1 text-sm text-slate-400">
            Quedó con el N° {hecho.numero}. Te vamos a contactar.
          </p>
        </div>
        <button
          onClick={onListo}
          className="w-full rounded-xl bg-slate-800 py-3 text-sm text-slate-200"
        >
          Volver
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={enviar} className="space-y-4">
      <div>
        <p className="mb-2 text-sm text-slate-400">¿Qué te está pasando?</p>
        <div className="grid grid-cols-2 gap-2">
          {TIPOS.map((t) => (
            <button
              key={t.valor}
              type="button"
              onClick={() => setTipo(t.valor)}
              className={`rounded-xl border p-3 text-left transition ${
                tipo === t.valor
                  ? 'border-sky-500 bg-sky-500/10'
                  : 'border-slate-800 bg-slate-900/50'
              }`}
            >
              <p className="text-sm font-medium text-slate-200">{t.titulo}</p>
              <p className="mt-0.5 text-xs text-slate-500">{t.ayuda}</p>
            </button>
          ))}
        </div>
      </div>

      {tipo && (
        <div>
          <label className="mb-1.5 block text-sm text-slate-400">Contanos un poco más</label>
          <textarea
            rows={4}
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
            placeholder="Desde cuándo pasa, si probaste reiniciar el equipo, a qué hora se nota más…"
            required
            className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-base text-slate-100 outline-none focus:border-sky-500"
          />
          <p className="mt-1.5 text-xs text-slate-500">
            Cuanto más nos cuentes, mejor preparado va el técnico.
          </p>
        </div>
      )}

      {error && <p className="text-sm text-rose-400">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancelar}
          className="flex-1 rounded-xl bg-slate-800 py-3.5 text-sm text-slate-300"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={!tipo || !descripcion.trim() || enviando}
          className="flex flex-[2] items-center justify-center gap-2 rounded-xl bg-sky-600 py-3.5 text-base font-medium text-white disabled:opacity-40"
        >
          {enviando && <Loader2 size={18} className="animate-spin" />}
          Enviar
        </button>
      </div>
    </form>
  )
}
