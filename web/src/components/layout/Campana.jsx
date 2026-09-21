import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Bell, Check, Info } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { usePermisos } from '../../lib/AuthContext'

/**
 * La campana de notificaciones.
 *
 * ── Por qué el contador cuenta solo lo urgente ──
 *
 * Si el número incluyera lo informativo —"tu venta fue enviada"— estaría
 * siempre en rojo y dejaría de significar algo. Cuenta lo que pide acción hoy:
 * expedientes a medio hacer, promesas que vencen, cobros vencidos, instalaciones
 * que fallaron. Lo demás está adentro, sin gritar.
 *
 * ── Por qué no hay tiempo real ──
 *
 * Se evaluó suscribirse a los cambios con Realtime. Se descartó por ahora: una
 * conexión abierta permanente en el celular del vendedor gasta batería y datos
 * todo el día para avisar de cosas que no son urgentes al minuto. Se refresca al
 * abrir la pantalla y cada dos minutos.
 */
const CADA = 120000

export default function Campana() {
  const { perfil } = usePermisos()
  const [avisos, setAvisos] = useState([])
  const [abierta, setAbierta] = useState(false)
  const caja = useRef(null)

  const recargar = useCallback(async () => {
    if (!perfil?.id) return
    const { data } = await supabase
      .from('v_notificaciones')
      .select('*')
      .order('urgencia')
      .order('creado_en', { ascending: false })
      .limit(40)
    setAvisos(data ?? [])
  }, [perfil])

  useEffect(() => {
    recargar()
    const t = setInterval(recargar, CADA)
    return () => clearInterval(t)
  }, [recargar])

  // Cerrar al tocar afuera. En el celular, sin esto queda un panel tapando la
  // pantalla que solo se va tocando exactamente la campana otra vez.
  useEffect(() => {
    if (!abierta) return
    const fuera = (e) => {
      if (caja.current && !caja.current.contains(e.target)) setAbierta(false)
    }
    document.addEventListener('mousedown', fuera)
    return () => document.removeEventListener('mousedown', fuera)
  }, [abierta])

  const urgentes = avisos.filter((a) => a.urgencia === 0 && !a.leida).length
  const sinLeer = avisos.filter((a) => !a.leida).length

  const marcarLeida = async (a) => {
    if (!a.se_puede_marcar) return
    await supabase
      .from('notificaciones')
      .update({ leida_en: new Date().toISOString() })
      .eq('id', a.clave)
    await recargar()
  }

  const marcarTodas = async () => {
    const ids = avisos.filter((a) => a.se_puede_marcar && !a.leida).map((a) => a.clave)
    if (!ids.length) return
    await supabase
      .from('notificaciones')
      .update({ leida_en: new Date().toISOString() })
      .in('id', ids)
    await recargar()
  }

  // Sin legajo no hay a quién notificar. No se dibuja nada en vez de una campana
  // que siempre está vacía.
  if (!perfil?.id) return null

  return (
    <div className="relative" ref={caja}>
      <button
        type="button"
        onClick={() => setAbierta((a) => !a)}
        className="relative grid h-10 w-10 place-items-center rounded-xl text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
        aria-label={`Notificaciones${sinLeer ? `: ${sinLeer} sin leer` : ''}`}
      >
        <Bell size={18} />
        {sinLeer > 0 && (
          // El punto rojo solo si hay algo urgente. Lo informativo mueve el
          // número pero no el color.
          <span
            className={`absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold text-white ${
              urgentes > 0 ? 'bg-red-500' : 'bg-slate-600'
            }`}
          >
            {sinLeer > 9 ? '9+' : sinLeer}
          </span>
        )}
      </button>

      {abierta && (
        <div className="absolute right-0 z-50 mt-2 max-h-[70vh] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto t-card">
          <div className="flex items-center justify-between border-b border-[rgba(15,23,42,0.06)] px-3 py-2">
            <span className="text-[13px] font-medium text-slate-200">Notificaciones</span>
            {avisos.some((a) => a.se_puede_marcar && !a.leida) && (
              <button
                type="button"
                onClick={marcarTodas}
                className="text-[12px] text-sky-400 hover:text-sky-300"
              >
                Marcar leídas
              </button>
            )}
          </div>

          {avisos.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-slate-500">
              Nada pendiente. Cuando falte algo en un expediente o venza una promesa, va a aparecer
              acá.
            </p>
          ) : (
            <div className="divide-y divide-slate-800/70">
              {avisos.map((a) => {
                const Icono = a.urgencia === 0 ? AlertTriangle : Info
                const cuerpo = (
                  <div
                    className={`flex gap-2.5 px-3 py-2.5 transition hover:bg-slate-800/60 ${
                      a.leida ? 'opacity-50' : ''
                    }`}
                  >
                    <Icono
                      size={15}
                      className={`mt-0.5 shrink-0 ${
                        a.urgencia === 0 ? 'text-amber-400' : 'text-sky-400'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] leading-snug text-slate-100">{a.titulo}</p>
                      {a.detalle && (
                        <p className="mt-0.5 truncate text-[11px] text-slate-500">{a.detalle}</p>
                      )}
                    </div>
                    {a.se_puede_marcar && !a.leida && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          marcarLeida(a)
                        }}
                        className="shrink-0 self-start rounded p-1 text-slate-500 hover:text-slate-200"
                        aria-label="Marcar como leída"
                      >
                        <Check size={14} />
                      </button>
                    )}
                  </div>
                )

                return a.ruta ? (
                  <Link key={a.clave} to={a.ruta} onClick={() => setAbierta(false)} className="block">
                    {cuerpo}
                  </Link>
                ) : (
                  <div key={a.clave}>{cuerpo}</div>
                )
              })}
            </div>
          )}

          {/* Las condiciones no se marcan como leídas: se resuelven. Decirlo
              evita que alguien busque el botón que falta. */}
          {avisos.some((a) => !a.se_puede_marcar) && (
            <p className="border-t border-[rgba(15,23,42,0.06)] px-3 py-2 text-[11px] text-slate-500">
              Los avisos sin tilde desaparecen solos cuando resolvés lo que los causa.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
