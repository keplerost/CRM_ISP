import { useEffect, useState } from 'react'
import { Camera, Clock, PhoneOff } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { comprimirImagen, ubicacionActual } from '../../lib/soporte'
import { sacarFoto } from '../../lib/servicio'
import { Button, Card } from '../ui'

/**
 * El ticket que no se pudo atender (migración 216).
 *
 * Termina el trabajo actual sin resolverlo: el ticket vuelve a la oficina para
 * reprogramar y la ruta pasa al siguiente. Para que no sirva de atajo, la base
 * exige estar en el sitio (la llegada marcada), la foto de la fachada y, si el
 * cliente no contesta o no hay nadie, haberlo llamado desde la app y esperar
 * 10 minutos desde la llegada. Acá se muestra cuánto falta antes de intentar.
 */

const MOTIVOS = [
  { valor: 'no_contesta', label: 'No contesta', espera: true },
  { valor: 'sin_nadie', label: 'No hay nadie', espera: true },
  { valor: 'no_permite', label: 'No permite el ingreso' },
  { valor: 'direccion_erronea', label: 'Dirección errónea' },
  { valor: 'falta_material', label: 'Faltó material' },
  { valor: 'clima', label: 'Lluvia o peligro' },
  { valor: 'otro', label: 'Otro' },
]

const ESPERA_MIN = 10

export default function NoSePudoTicket({ t, onHecho, onError }) {
  const [abierto, setAbierto] = useState(false)
  const [motivo, setMotivo] = useState(null)
  const [detalle, setDetalle] = useState('')
  const [foto, setFoto] = useState(null)
  const [previa, setPrevia] = useState(null)
  const [llamadas, setLlamadas] = useState(0)
  const [ahora, setAhora] = useState(() => Date.now())
  const [enviando, setEnviando] = useState(false)

  // El reloj de la espera, y cuántas veces se lo llamó desde la app.
  useEffect(() => {
    if (!abierto) return undefined
    const reloj = setInterval(() => setAhora(Date.now()), 15000)
    supabase
      .from('campo_llamadas')
      .select('id', { count: 'exact', head: true })
      .eq('item_tipo', 'ticket')
      .eq('item_id', t.id)
      .then(({ count }) => setLlamadas(count ?? 0))
    return () => clearInterval(reloj)
  }, [abierto, t.id])

  useEffect(() => {
    if (!foto) return setPrevia(null)
    const url = URL.createObjectURL(foto)
    setPrevia(url)
    return () => URL.revokeObjectURL(url)
  }, [foto])

  const m = MOTIVOS.find((x) => x.valor === motivo)
  const minutos = t.llegada_at ? (ahora - new Date(t.llegada_at).getTime()) / 60000 : 0
  const faltan = m?.espera ? Math.max(0, Math.ceil(ESPERA_MIN - minutos)) : 0
  const sinLlamada = m?.espera && llamadas === 0
  const listo = motivo && foto && !faltan && !sinLlamada && (motivo !== 'otro' || detalle.trim())

  async function enviar() {
    setEnviando(true)
    onError?.(null)
    try {
      // La foto, a las del ticket: así queda junto al resto de su historia.
      const blob = await comprimirImagen(foto)
      const ruta = `${t.id}/no-se-pudo-${Date.now()}.jpg`
      const { error: errSubida } = await supabase.storage
        .from('tickets')
        .upload(ruta, blob, { contentType: 'image/jpeg' })
      if (errSubida) throw errSubida
      const { data: sesion } = await supabase.auth.getUser()
      await supabase.from('ticket_adjuntos').insert({
        ticket_id: t.id,
        tipo: 'antes',
        ruta,
        descripcion: `No se pudo atender: ${m.label}`,
        created_by: sesion?.user?.id ?? null,
      })

      const pos = await ubicacionActual()
      const { error } = await supabase.rpc('no_se_pudo_atender', {
        p_ticket: t.id,
        p_motivo: motivo,
        p_detalle: detalle.trim() || null,
        p_foto: ruta,
        p_lat: pos?.lat ?? null,
        p_lng: pos?.lng ?? null,
      })
      if (error) throw error
      setAbierto(false)
      await onHecho?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setEnviando(false)
    }
  }

  if (!abierto) {
    return (
      <button
        type="button"
        onClick={() => setAbierto(true)}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 py-3 text-[14px] font-semibold text-amber-300"
      >
        <PhoneOff size={16} /> No se pudo atender
      </button>
    )
  }

  return (
    <Card title="No se pudo atender" icon={PhoneOff}>
      <div className="space-y-4 p-4">
        <p className="text-[13px] text-slate-400">
          El ticket vuelve a la oficina para reprogramar y pasás al siguiente de tu ruta.
        </p>

        <div className="grid grid-cols-2 gap-2">
          {MOTIVOS.map((x) => (
            <button
              key={x.valor}
              type="button"
              onClick={() => setMotivo(x.valor)}
              className={`rounded-lg border px-2 py-2.5 text-[13px] ${
                motivo === x.valor
                  ? 'border-amber-500 bg-amber-500/20 text-amber-200'
                  : 'border-slate-700 text-slate-300'
              }`}
            >
              {x.label}
            </button>
          ))}
        </div>

        {m?.espera && (
          <div className="space-y-1 rounded-lg border border-slate-700 p-3 text-[12px]">
            <p className={sinLlamada ? 'text-amber-400' : 'text-emerald-400'}>
              {sinLlamada
                ? 'Primero llamalo o escribile desde el botón Llamar o WhatsApp del ticket.'
                : `Lo llamaste ${llamadas} ${llamadas === 1 ? 'vez' : 'veces'} desde la app.`}
            </p>
            <p className={faltan ? 'text-amber-400' : 'text-emerald-400'}>
              <Clock size={12} className="mr-1 inline" />
              {faltan
                ? `Esperá en el sitio: faltan ${faltan} min (son ${ESPERA_MIN} desde que llegaste).`
                : `Ya esperaste ${ESPERA_MIN} minutos.`}
            </p>
          </div>
        )}

        <textarea
          rows={2}
          value={detalle}
          onChange={(e) => setDetalle(e.target.value)}
          placeholder={motivo === 'otro' ? 'Contá qué pasó (obligatorio)' : 'Detalle (opcional)'}
          className="w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-[13px] text-slate-100"
        />

        <button
          type="button"
          onClick={async () => {
            const f = await sacarFoto('environment')
            if (f) setFoto(f)
          }}
          className="flex w-full items-center gap-3 rounded-xl border border-dashed border-slate-700 p-3 text-left"
        >
          {previa ? (
            <img src={previa} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />
          ) : (
            <span className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-slate-800">
              <Camera size={20} className="text-slate-500" />
            </span>
          )}
          <span className="text-[13px] text-slate-300">
            {previa ? 'Tocá para sacarla de nuevo' : 'Foto de la fachada (obligatoria)'}
          </span>
        </button>

        <div className="flex gap-2">
          <Button className="flex-1" onClick={() => setAbierto(false)}>
            Volver
          </Button>
          <Button variante="primario" className="flex-1" onClick={enviar} cargando={enviando} disabled={!listo || enviando}>
            Confirmar
          </Button>
        </div>
      </div>
    </Card>
  )
}
