import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'

/**
 * "Ojo: la torre de este cliente está caída."
 *
 * ── Por qué esto vale más que el resto del módulo ──
 *
 * Sin este aviso, el técnico sale, maneja media hora, revisa el domicilio, no
 * encuentra nada, y recién ahí alguien le dice que se cayó la torre a las 5:42.
 * Se perdió la mañana y el cliente quedó igual de sin servicio, pero ahora
 * además convencido de que el técnico no supo arreglarlo.
 *
 * ── Por qué NO bloquea ──
 *
 * Podría impedir abrir la orden. Sería un error: la coordenada del abonado a
 * veces está mal cargada, un cliente puede estar colgado del nodo equivocado en
 * la ficha, y hay visitas que igual hay que hacer —dejar un equipo, cobrar—.
 * Un aviso que se puede ignorar se lee; uno que bloquea se aprende a esquivar.
 *
 * ── Y por qué no dice nada cuando está todo bien ──
 *
 * Un cartel verde de "la red está en orden" en cada orden se vuelve invisible
 * en dos días, y entonces el rojo tampoco se ve. Si no hay incidencia, este
 * componente no dibuja nada.
 */
export default function AvisoIncidencia({ clientId }) {
  const [incidencias, setIncidencias] = useState([])

  useEffect(() => {
    if (!clientId) return
    let vivo = true
    supabase
      .from('v_incidencia_de_cliente')
      .select('*')
      .eq('client_id', clientId)
      .then(({ data, error }) => {
        // Si la consulta falla —la migración 86 sin correr, por ejemplo— no se
        // muestra nada. Es un aviso extra: que falte no puede impedirle al
        // técnico abrir el trabajo.
        if (vivo && !error) setIncidencias(data ?? [])
      })
    return () => {
      vivo = false
    }
  }, [clientId])

  if (!incidencias.length) return null

  return (
    <div className="space-y-2">
      {incidencias.map((i) => {
        const caido = i.estado === 'down'
        return (
          <div
            key={i.nodo_id}
            className={`rounded-xl border p-3 ${
              caido
                ? 'border-rose-500/40 bg-rose-500/10'
                : 'border-amber-500/40 bg-amber-500/10'
            }`}
          >
            <div className="flex items-start gap-2.5">
              <AlertTriangle
                size={18}
                className={`mt-0.5 shrink-0 ${caido ? 'text-rose-400' : 'text-amber-400'}`}
              />
              <div className="min-w-0 flex-1">
                <p className={`text-[14px] font-semibold ${caido ? 'text-rose-200' : 'text-amber-200'}`}>
                  {caido ? 'Atención: la zona está caída' : 'Atención: la zona viene con problemas'}
                </p>
                <p className="mt-1 text-[13px] text-slate-300">
                  Este cliente está conectado a <b>{i.nodo}</b>, que{' '}
                  {caido ? 'no responde' : 'está degradado'} desde hace {duracion(i.minutos_asi)}.
                </p>
                <p className="mt-1 text-[12px] text-slate-400">
                  {i.clientes_afectados > 1
                    ? `Hay ${i.clientes_afectados} clientes en la misma situación. `
                    : ''}
                  Lo que le pasa al abonado puede ser por esto y no por su instalación.
                </p>

                <Link
                  to={`/campo/red?nodo=${i.nodo_id}`}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-slate-600/60 px-2.5 py-1.5 text-[12px] text-slate-200 active:bg-slate-800"
                >
                  Ver la incidencia <ArrowRight size={13} />
                </Link>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function duracion(minutos) {
  if (minutos == null) return '—'
  if (minutos < 0) return 'unos minutos'
  if (minutos < 60) return `${minutos} minutos`
  const h = Math.floor(minutos / 60)
  const m = minutos % 60
  return m ? `${h}h ${m}m` : `${h} horas`
}
