import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Replace, RefreshCw, ArrowRight } from 'lucide-react'
import { Button } from '../ui'
import { reemplazosApi, MOTIVOS } from '../../lib/reemplazos'

/**
 * Cambios de ONT que quedaron a mitad de camino.
 *
 * ── Qué significa que algo aparezca acá ──
 *
 * Que el técnico ya dejó el equipo nuevo en la casa y se fue, pero la OLT
 * todavía tiene autorizada la ONT vieja. El abonado está SIN SERVICIO en este
 * momento, y no llamó porque supone que el técnico lo dejó andando.
 *
 * Casi siempre es el mismo motivo: la OLT no contestó desde el celular —zona
 * rural, VPN caída— y el reintento desde el domicilio tampoco salió.
 *
 * ── Por qué no se dibuja nada cuando está vacío ──
 *
 * Es la mitad del valor de esta tarjeta. Un renglón fijo que dice "0 pendientes"
 * se vuelve parte del fondo, y el día que diga "2" nadie lo va a ver.
 */
export default function ReemplazosPendientes({ onError }) {
  const [filas, setFilas] = useState([])
  const [resolviendo, setResolviendo] = useState(null)

  const cargar = useCallback(async () => {
    try {
      setFilas(await reemplazosApi.pendientes())
    } catch (err) {
      // Que falte la migración no puede tumbar el tablero: es una tarjeta extra.
      if (err?.code !== '42P01') onError?.(err)
    }
  }, [onError])

  useEffect(() => {
    cargar()
  }, [cargar])

  const reintentar = async (id) => {
    setResolviendo(id)
    try {
      await reemplazosApi.aprovisionar(id)
      await cargar()
    } catch (err) {
      onError?.(err)
    } finally {
      setResolviendo(null)
    }
  }

  if (!filas.length) return null

  return (
    <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4">
      <div className="flex items-start gap-3">
        <Replace size={18} className="mt-0.5 shrink-0 text-rose-400" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-rose-200">
            {filas.length === 1
              ? 'Un cambio de ONT quedó sin terminar en la OLT'
              : `${filas.length} cambios de ONT quedaron sin terminar en la OLT`}
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            El equipo nuevo ya está en la casa, pero la OLT sigue con la ONT vieja autorizada.
            Mientras figure acá, el abonado no tiene servicio.
          </p>

          <ul className="mt-3 space-y-2">
            {filas.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700/70 bg-[#F6F8FB] px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-slate-100">{r.cliente}</p>
                  <p className="text-[11px] text-slate-500">
                    {r.serie_anterior ?? 'equipo anterior'} → <b className="text-slate-300">{r.serie_nueva}</b>
                    {' · '}
                    {MOTIVOS[r.motivo] ?? r.motivo}
                    {r.tecnico ? ` · ${r.tecnico}` : ''}
                    {' · '}
                    <span className="text-rose-300">{espera(r.minutos_esperando)} sin servicio</span>
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    icon={RefreshCw}
                    cargando={resolviendo === r.id}
                    onClick={() => reintentar(r.id)}
                  >
                    Reintentar
                  </Button>
                  {r.ticket_id && (
                    <Link
                      to={`/soporte/${r.ticket_id}`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
                    >
                      Ticket #{r.ticket_numero} <ArrowRight size={14} />
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <p className="mt-2 text-[11px] text-slate-500">
            Si el reintento tampoco pasa, autorizá la ONT nueva a mano desde la OLT: va en el mismo
            puerto y con el mismo perfil que la anterior.
          </p>
        </div>
      </div>
    </div>
  )
}

function espera(minutos) {
  if (minutos == null) return '—'
  // Un reloj del servidor unos segundos adelantado no puede imprimir "hace -3m".
  if (minutos < 1) return 'recién'
  if (minutos < 60) return `${minutos} min`
  const h = Math.floor(minutos / 60)
  if (h < 24) return `${h}h ${minutos % 60}m`
  return `${Math.floor(h / 24)} día(s)`
}
