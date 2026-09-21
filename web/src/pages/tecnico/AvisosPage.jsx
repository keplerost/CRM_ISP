import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { BellOff, Check } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'

/**
 * Los avisos del técnico.
 *
 * ── Por qué "marcar leído" es explícito y no automático ──
 *
 * Lo natural sería marcarlos al abrir la pantalla. Está mal: el técnico entra
 * acá mientras maneja o entre dos trabajos, ve que hay tres avisos y sale sin
 * leerlos. Marcarlos solos hace desaparecer el contador de algo que nadie leyó,
 * y el aviso que importaba —"el cliente de las 3 canceló"— se pierde.
 *
 * Se marca uno por uno, o todos con un botón que hay que apretar. La diferencia
 * es que apretar es una decisión.
 */
export default function AvisosPage() {
  const { recargarAvisos } = useOutletContext() ?? {}
  const [avisos, setAvisos] = useState([])
  const [cargando, setCargando] = useState(true)

  const recargar = useCallback(async () => {
    const { data } = await supabase
      .from('v_notificaciones')
      .select('*')
      .order('creado_en', { ascending: false })
      .limit(50)
    setAvisos(data ?? [])
    setCargando(false)
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  const marcar = async (ids) => {
    if (!ids.length) return
    await supabase
      .from('notificaciones')
      .update({ leida_en: new Date().toISOString() })
      .in('id', ids)
    await recargar()
    recargarAvisos?.()
  }

  const sinLeer = avisos.filter((a) => !a.leida_en)

  if (cargando) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl bg-[#F6F8FB]" />
        ))}
      </div>
    )
  }

  if (!avisos.length) {
    return (
      <div className="py-16 text-center">
        <BellOff size={28} className="mx-auto mb-2 text-slate-700" />
        <p className="text-slate-400">No hay avisos.</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-2">
      {sinLeer.length > 1 && (
        <button
          type="button"
          onClick={() => marcar(sinLeer.map((a) => a.id))}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-[12px] text-slate-400 active:bg-slate-800"
        >
          <Check size={13} /> Marcar los {sinLeer.length} como leídos
        </button>
      )}

      {avisos.map((a) => (
        <div
          key={a.id}
          className={`rounded-xl border p-3 ${
            a.leida_en
              ? 'border-slate-800/60 bg-[#F6F8FB]'
              : 'border-slate-700 bg-[#F6F8FB]'
          }`}
        >
          <div className="flex items-start gap-2.5">
            {!a.leida_en && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-sky-400" />}
            <div className="min-w-0 flex-1">
              <p className={`text-[14px] ${a.leida_en ? 'text-slate-500' : 'text-slate-100'}`}>
                {a.titulo ?? a.mensaje}
              </p>
              {a.titulo && a.mensaje && (
                <p className="mt-0.5 text-[12px] text-slate-500">{a.mensaje}</p>
              )}
              <p className="mt-1 text-[11px] text-slate-600">
                {new Date(a.creado_en).toLocaleString('es-EC', {
                  day: '2-digit',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            </div>
            {!a.leida_en && (
              <button
                type="button"
                onClick={() => marcar([a.id])}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 active:bg-slate-800"
                aria-label="Marcar como leído"
              >
                <Check size={15} />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
