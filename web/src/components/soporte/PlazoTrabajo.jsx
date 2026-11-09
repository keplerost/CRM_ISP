import { useCallback, useEffect, useRef, useState } from 'react'
import { AlarmClock } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { duracion } from '../../lib/alertas'
import { MOTIVOS_DEMORA, estadoPlazo, venceEl } from '../../lib/plazos'
import { Button, Modal, Textarea } from '../ui'

/**
 * El plazo de un trabajo en la app del técnico, y la justificación cuando se
 * llega tarde (migración 219).
 */

/**
 * Los plazos por tipo, una sola vez por sesión.
 *
 * Cambian muy de vez en cuando y la ruta del día dibuja una tarjeta por trabajo:
 * pedirlos en cada una sería una consulta por tarjeta en el celular. Si fallan
 * —sin señal, o la 219 sin correr— se devuelve null y la etiqueta no se dibuja.
 */
let cache = null
let pedido = null

export function usePlazosAtencion() {
  const [plazos, setPlazos] = useState(cache)

  useEffect(() => {
    if (cache) return
    pedido ??= supabase
      .from('plazos_atencion')
      .select('clave, horas')
      .then(({ data, error }) => {
        if (error || !data?.length) {
          pedido = null
          return null
        }
        cache = data
        return data
      })
    let vigente = true
    pedido.then((d) => vigente && d && setPlazos(d))
    return () => {
      vigente = false
    }
  }, [])

  return plazos
}

const ESTILO = {
  ok: 'border-slate-600/50 bg-slate-500/10 text-slate-300',
  cerca: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  vencido: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
}

const hora = (d) => d.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })
const dia = (d, ahora) =>
  d.toDateString() === ahora.toDateString()
    ? ''
    : ` del ${d.toLocaleDateString('es-EC', { weekday: 'short', day: 'numeric' })}`

/**
 * "Llegar antes de las 15:30 · faltan 2 h".
 *
 * Solo mientras falta llegar: una vez que llegó, el plazo ya se cumplió o no, y
 * seguir mostrándolo en rojo durante el trabajo solo apura a cerrar mal.
 */
export function PlazoTrabajo({ trabajo, clase = 'ticket', className = '' }) {
  const plazos = usePlazosAtencion()
  const [ahora, setAhora] = useState(() => new Date())

  useEffect(() => {
    const t = setInterval(() => setAhora(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  const cerrado = ['resuelto', 'cancelado', 'hecha', 'cancelada', 'no_realizada'].includes(trabajo?.estado)
  if (!plazos || !trabajo || trabajo.llegada_at || cerrado) return null

  const vence = venceEl(trabajo, plazos, clase)
  const e = estadoPlazo(vence, ahora)
  if (!e) return null

  return (
    <p
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${ESTILO[e.nivel]} ${className}`}
    >
      <AlarmClock size={12} className="shrink-0" />
      {e.nivel === 'vencido'
        ? `Plazo vencido hace ${duracion(-e.min)}`
        : `Llegar antes de las ${hora(vence)}${dia(vence, ahora)} · faltan ${duracion(e.min)}`}
    </p>
  )
}

/**
 * Pedir el motivo de la demora antes de marcar la llegada.
 *
 * Devuelve `[pedir, ventana]`: `pedir()` abre la ventana y espera la respuesta
 * —`{ demora_motivo, demora_nota }`, o `null` si el técnico se arrepiente— y
 * `ventana` se dibuja en la pantalla que la usa. Con una promesa, quien llama
 * sigue escrito de corrido: `const j = await pedir(); if (!j) return`.
 */
export function useJustificarDemora() {
  const [abierta, setAbierta] = useState(false)
  const [info, setInfo] = useState(null)
  const [motivo, setMotivo] = useState('')
  const [nota, setNota] = useState('')
  const resolver = useRef(null)

  const pedir = useCallback((datos = {}) => {
    setInfo(datos)
    setMotivo('')
    setNota('')
    setAbierta(true)
    return new Promise((res) => {
      resolver.current = res
    })
  }, [])

  const terminar = (valor) => {
    setAbierta(false)
    resolver.current?.(valor)
    resolver.current = null
  }

  // "Otro" sin decir cuál no justifica nada.
  const valido = motivo && (motivo !== 'otro' || nota.trim().length >= 5)

  const ventana = (
    <Modal abierto={abierta} titulo="Llegaste fuera de plazo" onCerrar={() => terminar(null)}>
      <div className="space-y-3">
        <p className="text-[13px] text-slate-300">
          {info?.minutos != null
            ? `El plazo para este trabajo venció hace ${duracion(info.minutos)}. `
            : 'El plazo para este trabajo ya venció. '}
          Contanos por qué, así la oficina sabe si el atraso fue tuyo o de otra cosa.
        </p>

        <div className="space-y-1.5">
          {MOTIVOS_DEMORA.map((m) => (
            <label
              key={m.valor}
              className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-[13px] ${
                motivo === m.valor
                  ? 'border-sky-500/50 bg-sky-500/10 text-sky-200'
                  : 'border-slate-700 text-slate-300'
              }`}
            >
              <input
                type="radio"
                name="demora_motivo"
                value={m.valor}
                checked={motivo === m.valor}
                onChange={() => setMotivo(m.valor)}
                className="accent-sky-500"
              />
              {m.label}
            </label>
          ))}
        </div>

        <Textarea
          rows={2}
          value={nota}
          onChange={(e) => setNota(e.target.value)}
          placeholder={motivo === 'otro' ? 'Escribí qué pasó (obligatorio)' : 'Detalle, si hace falta (opcional)'}
        />

        <div className="flex justify-end gap-2">
          <Button variante="secundario" onClick={() => terminar(null)}>
            Cancelar
          </Button>
          <Button
            variante="primario"
            disabled={!valido}
            onClick={() =>
              terminar({ demora_motivo: motivo, demora_nota: nota.trim() || null })
            }
          >
            Marcar la llegada
          </Button>
        </div>
      </div>
    </Modal>
  )

  return [pedir, ventana]
}
