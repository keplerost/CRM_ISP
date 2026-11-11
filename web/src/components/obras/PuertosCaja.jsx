import { useEffect, useState } from 'react'
import { Search, Trash2, X } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { ESTADOS_PUERTO, resumenCaja } from '../../lib/obras'

/**
 * Relevar una caja del mapeo puerto por puerto (migración 233), con la caja
 * abierta delante.
 *
 * Toca un puerto y dice qué hay: el abonado (sugerido por cercanía o buscado
 * por nombre o cédula), libre o dañado. Lo que se marca acá deja al abonado en
 * esa caja y ese puerto, verificado en campo.
 */
export default function PuertosCaja({ obra, nap, puertos, onCambio, onCerrar }) {
  const [puerto, setPuerto] = useState(null)
  const rc = resumenCaja(nap, puertos)
  const deCaja = puertos.filter((p) => p.obra_nap_id === nap.id)
  const total = Number(nap.puertos) || 0

  return (
    <div className="space-y-3 rounded-lg border border-sky-500/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[14px] font-semibold text-slate-100">{nap.nombre}</p>
          <p className={`text-[12px] ${rc.completa ? 'text-emerald-400' : 'text-amber-400'}`}>
            {rc.relevados} de {total || '?'} relevados · {rc.ubicados} abonados · {rc.libres} libres
            {rc.danados ? ` · ${rc.danados} dañados` : ''}
          </p>
        </div>
        <button type="button" onClick={onCerrar} className="text-slate-500" aria-label="Cerrar">
          <X size={16} />
        </button>
      </div>

      {!total ? (
        <p className="text-[12px] text-amber-400">Cargale a la caja cuántos puertos tiene (Caja NAP, mismo nombre).</p>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          {Array.from({ length: total }, (_, i) => i + 1).map((n) => {
            const p = deCaja.find((x) => x.puerto === n)
            return (
              <button
                key={n}
                type="button"
                onClick={() => setPuerto(n)}
                className={`flex flex-col items-center rounded-lg border px-1 py-2 text-[11px] ${
                  puerto === n ? 'ring-2 ring-sky-400' : ''
                } ${p ? ESTADOS_PUERTO[p.estado].clase : 'border-dashed border-slate-600 text-slate-400'}`}
              >
                <span className="text-[14px] font-bold">{n}</span>
                <span className="w-full truncate text-center">
                  {p ? (p.cliente ?? (p.nota || ESTADOS_PUERTO[p.estado].label)) : 'sin ver'}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {puerto && (
        <Puerto
          key={puerto}
          obra={obra}
          nap={nap}
          n={puerto}
          actual={deCaja.find((x) => x.puerto === puerto)}
          onListo={async () => {
            await onCambio?.()
            const siguiente = Array.from({ length: total }, (_, i) => i + 1).find(
              (k) => k > puerto && !deCaja.some((x) => x.puerto === k),
            )
            setPuerto(siguiente ?? null)
          }}
        />
      )}
    </div>
  )
}

function Puerto({ obra, nap, n, actual, onListo }) {
  const [texto, setTexto] = useState('')
  const [lista, setLista] = useState(null)
  const [nota, setNota] = useState(actual?.nota ?? '')
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState(null)

  // Los cercanos a la caja al abrir; con texto, la búsqueda en la cartera.
  useEffect(() => {
    let vivo = true
    const t = setTimeout(
      async () => {
        const q = texto.trim()
        const { data, error: e } = await supabase.rpc('abonados_para_caja', {
          p_obra: obra.id,
          p_lat: q ? null : (nap.latitud ?? null),
          p_lng: q ? null : (nap.longitud ?? null),
          p_texto: q || null,
        })
        if (vivo) setLista(e ? [] : (data ?? []))
      },
      texto ? 350 : 0,
    )
    return () => {
      vivo = false
      clearTimeout(t)
    }
  }, [texto, obra.id, nap.latitud, nap.longitud])

  async function marcar(estado, cliente = null) {
    setEnviando(true)
    setError(null)
    const { error: e } = await supabase.rpc('relevar_puerto_nap', {
      p_obra_nap: nap.id,
      p_puerto: n,
      p_estado: estado,
      p_cliente: cliente,
      p_nota: nota.trim() || null,
    })
    setEnviando(false)
    if (e) return setError(e.message)
    onListo()
  }

  const BTN = 'flex-1 rounded-lg border py-2 text-[12px] font-semibold disabled:opacity-50'

  return (
    <div className="space-y-2 border-t border-slate-800 pt-3">
      <p className="text-[12px] font-semibold text-slate-200">
        Puerto {n}
        {actual && <span className="font-normal text-slate-500"> · ahora: {actual.cliente ?? ESTADOS_PUERTO[actual.estado].label}</span>}
      </p>
      <div className="flex gap-2">
        <button type="button" disabled={enviando} onClick={() => marcar('libre')} className={`${BTN} ${ESTADOS_PUERTO.libre.clase}`}>
          Libre
        </button>
        <button type="button" disabled={enviando} onClick={() => marcar('danado')} className={`${BTN} ${ESTADOS_PUERTO.danado.clase}`}>
          Dañado
        </button>
        {actual && (
          <button
            type="button"
            disabled={enviando}
            onClick={() => marcar(null)}
            className={`${BTN} max-w-[44px] border-slate-700 text-slate-400`}
            title="Borrar lo marcado"
          >
            <Trash2 size={14} className="mx-auto" />
          </button>
        )}
      </div>

      <p className="pt-1 text-[11px] text-slate-500">Ocupado por:</p>
      <label className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-2">
        <Search size={14} className="text-slate-500" />
        <input
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          placeholder="Buscar por nombre, cédula o código"
          className="w-full bg-transparent py-2 text-[13px] text-slate-100 outline-none"
        />
      </label>
      {lista === null ? (
        <p className="text-[12px] text-slate-500">Buscando…</p>
      ) : !lista.length ? (
        <p className="text-[12px] text-slate-500">
          {texto.trim() ? 'Nadie con ese nombre.' : 'Nadie con ubicación cerca de la caja. Buscalo por nombre.'}
        </p>
      ) : (
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {lista.map((a) => (
            <li key={a.cliente_id}>
              <button
                type="button"
                disabled={enviando}
                onClick={() => marcar('ocupado', a.cliente_id)}
                className="w-full rounded-lg border border-slate-700 p-2 text-left text-[12px] active:bg-slate-800"
              >
                <span className="font-medium text-slate-100">{a.nombre}</span>
                <span className="block text-[11px] text-slate-500">
                  {[
                    a.distancia_m != null && `a ${a.distancia_m} m`,
                    a.por === 'puerto_pon' && `del puerto PON${a.distancia_olt_m != null ? ` · ${a.distancia_olt_m} m de la OLT` : ''}`,
                    a.direccion,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {a.caja_actual && (
                  <span className="block text-[11px] text-amber-400">
                    Ya figura en {a.caja_actual}
                    {a.puerto_actual ? `, puerto ${a.puerto_actual}` : ''}
                    {a.verificado ? ' (verificado)' : ''}: si lo marcás acá, se mueve.
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="block">
        <span className="mb-0.5 block text-[11px] text-slate-400">Si no lo encontrás: lo que dice la etiqueta del drop</span>
        <div className="flex gap-2">
          <input
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            placeholder="Ej.: “Fam. Pérez casa verde”"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-[13px] text-slate-100"
          />
          <button
            type="button"
            disabled={enviando || !nota.trim()}
            onClick={() => marcar('ocupado')}
            className={`${BTN} max-w-[110px] ${ESTADOS_PUERTO.ocupado.clase}`}
          >
            Ocupado
          </button>
        </div>
      </label>
      {error && <p className="text-[12px] text-rose-400">{error}</p>}
    </div>
  )
}
