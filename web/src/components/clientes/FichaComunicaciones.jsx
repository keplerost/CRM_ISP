import { useCallback, useEffect, useState } from 'react'
import {
  Bot,
  Check,
  CheckCheck,
  Clock,
  Mail,
  MessageCircle,
  MessageSquare,
  Send,
  X,
  Zap,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { Aviso, Button, Card, Field, Input, Modal, Select, Textarea } from '../ui'

/**
 * Todo lo que se le dijo al abonado, por el canal que sea.
 *
 * Un solo historial para los cuatro canales porque la pregunta que se hace en
 * el mostrador es una sola: "¿a este se le avisó?". Tener que mirar en cuatro
 * lugares para contestarla es la forma de que nadie la conteste.
 *
 * Los estados dicen la verdad de cada canal y no lo que quedaría lindo: el
 * correo confirma que el servidor lo aceptó, no que lo leyeron; un WhatsApp sin
 * API configurada queda en "pendiente" hasta que una persona confirme que lo
 * mandó. Marcar como entregado algo que nadie mandó le daría al ISP una prueba
 * falsa frente a un reclamo.
 */

const CANALES = {
  email: { label: 'Email', icon: Mail, color: 'text-sky-400' },
  whatsapp: { label: 'WhatsApp', icon: MessageCircle, color: 'text-emerald-400' },
  telegram: { label: 'Telegram', icon: Bot, color: 'text-cyan-400' },
  sms: { label: 'SMS', icon: MessageSquare, color: 'text-violet-400' },
}

const ESTADOS = {
  pendiente: { label: 'Pendiente de envío', icon: Clock, clase: 'text-amber-400' },
  enviado: { label: 'Enviado', icon: Check, clase: 'text-sky-400' },
  entregado: { label: 'Entregado', icon: CheckCheck, clase: 'text-emerald-400' },
  leido: { label: 'Leído', icon: CheckCheck, clase: 'text-emerald-300' },
  fallido: { label: 'Falló', icon: X, clase: 'text-rose-400' },
}

const fechaHora = (f) =>
  f ? new Date(f).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—'

export default function FichaComunicaciones({ cliente, onError }) {
  const [mensajes, setMensajes] = useState([])
  const [plantillas, setPlantillas] = useState([])
  const [canales, setCanales] = useState({})
  const [cargando, setCargando] = useState(true)

  const [redactando, setRedactando] = useState(null)
  const [enviando, setEnviando] = useState(false)
  const [aviso, setAviso] = useState(null)

  const recargar = useCallback(async () => {
    setCargando(true)

    const [m, p] = await Promise.all([
      supabase
        .from('comunicaciones')
        .select('*')
        .eq('client_id', cliente.id)
        .order('created_at', { ascending: false })
        .limit(100),
      supabase.from('plantillas_mensaje').select('*').eq('activa', true).order('nombre'),
    ])

    if (m.error) onError?.(m.error)
    setMensajes(m.data ?? [])
    setPlantillas(p.data ?? [])
    setCargando(false)

    // Qué canales están configurados hoy. Si el middleware no responde, la
    // pantalla sigue sirviendo para leer el historial.
    try {
      setCanales(await api.comunicaciones.canales())
    } catch {
      setCanales({})
    }
  }, [cliente.id, onError])

  useEffect(() => {
    recargar()
  }, [recargar])

  function abrir(canal) {
    setAviso(null)
    setRedactando({ canal, asunto: '', cuerpo: '', plantilla_id: '' })
  }

  function usarPlantilla(id) {
    const p = plantillas.find((x) => x.id === id)
    setRedactando((r) => ({
      ...r,
      plantilla_id: id,
      asunto: p?.asunto ?? r.asunto,
      cuerpo: p?.cuerpo ?? r.cuerpo,
    }))
  }

  async function enviar(e) {
    e.preventDefault()
    setEnviando(true)
    onError?.(null)

    try {
      const r = await api.comunicaciones.enviar({
        client_id: cliente.id,
        canal: redactando.canal,
        asunto: redactando.asunto?.trim() || null,
        cuerpo: redactando.cuerpo,
        plantilla_id: redactando.plantilla_id || null,
      })

      // WhatsApp sin API: el sistema preparó el texto, lo manda una persona.
      if (r.enlace) {
        window.open(r.enlace, '_blank', 'noopener')
        setAviso(
          'Se abrió WhatsApp con el mensaje listo. Cuando lo mandes, marcalo como enviado en el historial.',
        )
      } else {
        setAviso('Mensaje enviado.')
      }

      setRedactando(null)
      await recargar()
    } catch (err) {
      onError?.(err)
      // Aunque falle, el intento quedó escrito: recargar lo muestra.
      await recargar()
    } finally {
      setEnviando(false)
    }
  }

  async function marcarEnviado(m) {
    try {
      await api.comunicaciones.marcarEnviado(m.id)
      await recargar()
    } catch (err) {
      onError?.(err)
    }
  }

  const disponibles = Object.entries(CANALES)

  return (
    <div className="space-y-4">
      <Card title="Centro de envíos" icon={Send}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {disponibles.map(([clave, c]) => {
            const estado = canales[clave]
            const Icon = c.icon
            return (
              <button
                key={clave}
                type="button"
                onClick={() => abrir(clave)}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-slate-700 p-3 text-xs text-slate-300 transition hover:border-sky-500/60 hover:text-sky-300"
              >
                <Icon size={20} className={c.color} />
                {c.label}
                {estado && (
                  <span
                    className={`text-[10px] ${
                      estado.listo ? 'text-emerald-400' : estado.manual ? 'text-amber-400' : 'text-slate-500'
                    }`}
                  >
                    {estado.listo ? 'listo' : estado.manual ? 'manual' : 'sin configurar'}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {aviso && (
          <div className="mt-3">
            <Aviso>{aviso}</Aviso>
          </div>
        )}

        {plantillas.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">
              Plantillas rápidas
            </p>
            <div className="flex flex-wrap gap-2">
              {plantillas.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    const canal = p.canal === 'cualquiera' ? cliente.canal_preferido || 'whatsapp' : p.canal
                    setRedactando({
                      canal,
                      asunto: p.asunto ?? '',
                      cuerpo: p.cuerpo,
                      plantilla_id: p.id,
                    })
                  }}
                  className="flex items-center gap-1.5 rounded-full border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-sky-500/60 hover:text-sky-300"
                >
                  <Zap size={12} />
                  {p.nombre}
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card
        title="Historial"
        subtitle={
          mensajes.length
            ? `${mensajes.length} ${mensajes.length === 1 ? 'mensaje' : 'mensajes'}`
            : 'Todavía no se le escribió'
        }
      >
        {cargando ? (
          <p className="text-sm text-slate-500">Cargando…</p>
        ) : !mensajes.length ? (
          <p className="py-6 text-center text-sm text-slate-500">
            No hay mensajes registrados para este abonado.
          </p>
        ) : (
          <ol className="space-y-3">
            {mensajes.map((m) => {
              const canal = CANALES[m.canal] ?? CANALES.email
              const estado = ESTADOS[m.estado] ?? ESTADOS.pendiente
              const Icon = canal.icon
              const IconEstado = estado.icon

              return (
                <li
                  key={m.id}
                  className="rounded-lg border border-slate-800 bg-slate-900/40 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Icon size={14} className={canal.color} />
                    <b className="text-slate-300">{canal.label}</b>
                    {m.automatico && (
                      <span className="rounded-full border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-500">
                        automático
                      </span>
                    )}
                    <span className="text-slate-500">→ {m.destino ?? 'sin destino'}</span>
                    <span className="ml-auto flex items-center gap-1 text-slate-500">
                      <IconEstado size={13} className={estado.clase} />
                      <span className={estado.clase}>{estado.label}</span>
                    </span>
                  </div>

                  {m.asunto && <p className="mt-2 text-sm font-medium text-slate-200">{m.asunto}</p>}
                  <p className="mt-1 whitespace-pre-wrap text-sm text-slate-300">{m.cuerpo}</p>

                  {m.error && (
                    <p className="mt-2 rounded bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300">
                      {m.error}
                    </p>
                  )}

                  <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                    <span>{fechaHora(m.created_at)}</span>
                    {m.enviado_at && <span>enviado {fechaHora(m.enviado_at)}</span>}
                    {m.entregado_at && <span>entregado {fechaHora(m.entregado_at)}</span>}

                    {m.estado === 'pendiente' && (
                      <button
                        type="button"
                        onClick={() => marcarEnviado(m)}
                        className="ml-auto text-sky-400 underline"
                      >
                        Ya lo mandé
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </Card>

      {/* ---------------------------------------------------- Redactar */}
      <Modal
        abierto={Boolean(redactando)}
        titulo={redactando ? `Nuevo ${CANALES[redactando.canal]?.label}` : ''}
        onCerrar={() => setRedactando(null)}
        ancho="max-w-xl"
      >
        {redactando && (
          <form onSubmit={enviar} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Canal">
                <Select
                  value={redactando.canal}
                  onChange={(e) => setRedactando((r) => ({ ...r, canal: e.target.value }))}
                >
                  {disponibles.map(([clave, c]) => (
                    <option key={clave} value={clave}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Plantilla">
                <Select
                  value={redactando.plantilla_id}
                  onChange={(e) => usarPlantilla(e.target.value)}
                >
                  <option value="">— escribir a mano —</option>
                  {plantillas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nombre}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {canales[redactando.canal] && !canales[redactando.canal].listo && (
              <Aviso tipo="alerta">{canales[redactando.canal].nota}</Aviso>
            )}

            {redactando.canal === 'email' && (
              <Field label="Asunto">
                <Input
                  value={redactando.asunto}
                  onChange={(e) => setRedactando((r) => ({ ...r, asunto: e.target.value }))}
                />
              </Field>
            )}

            <Field
              label="Mensaje"
              hint="Acepta {{nombre}}, {{primer_nombre}}, {{saldo}}, {{plan}}, {{fecha}}"
            >
              <Textarea
                rows={6}
                value={redactando.cuerpo}
                onChange={(e) => setRedactando((r) => ({ ...r, cuerpo: e.target.value }))}
                required
              />
            </Field>

            <p className="text-[11px] text-slate-500">
              Va a <b>{destinoVisible(redactando.canal, cliente)}</b>
            </p>

            <div className="flex justify-end gap-2">
              <Button variante="fantasma" type="button" onClick={() => setRedactando(null)}>
                Cancelar
              </Button>
              <Button
                variante="primario"
                type="submit"
                icon={Send}
                cargando={enviando}
                disabled={!redactando.cuerpo?.trim()}
              >
                Enviar
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}

/** A dónde va el mensaje según el canal, para decirlo antes de mandarlo. */
function destinoVisible(canal, cliente) {
  if (canal === 'email') return cliente.email || 'sin correo cargado'
  if (canal === 'telegram') return cliente.telegram_chat_id || 'sin chat de Telegram'
  return cliente.telefono_movil || cliente.telefono || 'sin teléfono cargado'
}
