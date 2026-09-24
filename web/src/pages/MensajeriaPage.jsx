import { useEffect, useState } from 'react'
import { ArrowLeft, Clock, Mail, MessageCircle, Send, Smartphone } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../lib/apiNetwork'
import { Aviso, Button, Card, Cargando, ErrorBanner, Field, Input, Select } from '../components/ui'

/**
 * Los canales por los que el sistema le escribe al abonado.
 *
 * Acá van las CREDENCIALES —qué bot, qué número, qué cuenta—, no los textos.
 * Los textos de los avisos son otra pantalla: mezclar "token de WhatsApp" con
 * "estimado cliente, su factura vence" hace una pantalla que nadie encuentra
 * cuando busca una de las dos.
 *
 * Ningún token se muestra: se dice si hay uno cargado y de dónde salió. Un
 * token en pantalla queda en el historial del navegador y en cualquier captura
 * que alguien mande por WhatsApp pidiendo ayuda.
 */
export default function MensajeriaPage() {
  const [cfg, setCfg] = useState(null)
  const [canales, setCanales] = useState(null)
  const [form, setForm] = useState({})
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado] = useState(false)
  const [error, setError] = useState(null)

  const recargar = () =>
    Promise.all([api.comunicaciones.config(), api.comunicaciones.canales()])
      .then(([c, ch]) => {
        setCfg(c)
        setCanales(ch)
        setForm({
          avisos_desde: c.avisos_desde ?? '08:00',
          avisos_hasta: c.avisos_hasta ?? '20:00',
          telegram_bot_usuario: c.telegram.bot_usuario ?? '',
          whatsapp_via: c.whatsapp.via ?? 'manual',
          whatsapp_phone_id: c.whatsapp.phone_id ?? '',
          whatsapp_verify_token: c.whatsapp.verify_token ?? '',
          whatsapp_crm_nombre: c.whatsapp.crm_nombre ?? '',
          whatsapp_crm_url: c.whatsapp.crm_url ?? '',
          whatsapp_crm_header: c.whatsapp.crm_header ?? 'X-API-Key',
          whatsapp_desde: c.whatsapp.desde ?? '',
          whatsapp_evolution_url: c.whatsapp.evolution_url ?? '',
          whatsapp_evolution_instancia: c.whatsapp.evolution_instancia ?? '',
          twilio_sid: c.sms.sid ?? '',
          twilio_desde: c.sms.desde ?? '',
          nms_canal: c.nms.canal ?? 'telegram',
          nms_destino: c.nms.destino ?? '',
        })
      })
      .catch(setError)

  useEffect(() => {
    recargar().finally(() => setCargando(false))
  }, [])

  const set = (campo) => (e) => {
    setGuardado(false)
    setForm((f) => ({ ...f, [campo]: e.target.value }))
  }

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setGuardado(false)
    setError(null)
    try {
      await api.comunicaciones.guardarConfig(form)
      // Los secretos se limpian del formulario: ya están guardados y dejarlos
      // escritos los volvería a mandar en el próximo guardado.
      setForm((f) => ({
        ...f,
        telegram_token: '',
        whatsapp_token: '',
        whatsapp_evolution_key: '',
        whatsapp_app_secret: '',
        whatsapp_crm_key: '',
        twilio_token: '',
      }))
      await recargar()
      setGuardado(true)
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  if (cargando) return <Cargando />

  return (
    <div className="space-y-4">
      <Link to="/ajustes" className="inline-flex items-center gap-1 text-sm text-slate-400">
        <ArrowLeft size={15} /> Volver a Ajustes
      </Link>

      <div>
        <h1 className="t-titulo text-lg font-bold text-slate-100">Mensajería</h1>
        <p className="mt-0.5 max-w-3xl text-xs leading-snug text-slate-500">
          Por dónde le escribe el sistema al abonado: avisos de vencimiento, de corte y de
          reconexión. Acá van las cuentas y los tokens; los textos de cada aviso se editan en sus
          propias plantillas.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <form onSubmit={guardar} className="space-y-4">
        {/*
          Va primero porque manda sobre todos los canales, y porque es lo que
          más se toca: es la respuesta a un reclamo real.

          La facturación corre a la 01:30 y el corte a las 05:00 —las horas en
          que la red está tranquila— y hasta ahora el aviso salía en ese mismo
          momento. Una abonada pidió el retiro del servicio por eso: no por la
          deuda, por el susto de un mensaje a esa hora.
        */}
        <Card title="Horario de los avisos" icon={Clock}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Desde"
              hint="Antes de esta hora no se le escribe a ningún abonado."
            >
              <Input
                type="time"
                value={form.avisos_desde ?? '08:00'}
                onChange={(e) => setForm((f) => ({ ...f, avisos_desde: e.target.value }))}
              />
            </Field>
            <Field label="Hasta" hint="Lo que se genere después sale a la mañana siguiente.">
              <Input
                type="time"
                value={form.avisos_hasta ?? '20:00'}
                onChange={(e) => setForm((f) => ({ ...f, avisos_hasta: e.target.value }))}
              />
            </Field>
          </div>
          <p className="mt-3 text-xs leading-snug text-slate-500">
            Vale para la factura nueva, el corte y los recordatorios de pago: lo que el sistema
            decide por su cuenta. <b>No</b> para el comprobante de un pago ni la respuesta a un
            ticket — quien paga a las once de la noche está esperando su confirmación.
          </p>
        </Card>

        {/* El correo no se configura acá: ya tiene su pantalla, y duplicar los
            campos garantiza que un día queden distintos. */}
        <Card title="Correo" icon={Mail}>
          <div className="flex flex-wrap items-center gap-3">
            <Estado canal={canales?.email} />
            <Link to="/ajustes/correo" className="text-sm text-sky-400 hover:text-sky-300">
              Configurar el servidor de correo →
            </Link>
          </div>
        </Card>

        <Card title="Telegram" icon={MessageCircle}>
          <div className="space-y-4">
            <Estado canal={canales?.telegram} origen={cfg?.telegram.origen} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Token del bot"
                hint={
                  cfg?.telegram.tiene_token
                    ? 'Ya hay uno guardado: dejalo vacío para no cambiarlo.'
                    : 'Te lo da @BotFather al crear el bot.'
                }
              >
                <Input
                  type="password"
                  value={form.telegram_token ?? ''}
                  onChange={set('telegram_token')}
                  placeholder={cfg?.telegram.tiene_token ? '••••••••' : '123456:ABC-DEF…'}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Usuario del bot" hint="Para poder decirle al abonado a quién escribirle">
                <Input
                  value={form.telegram_bot_usuario ?? ''}
                  onChange={set('telegram_bot_usuario')}
                  placeholder="@MiIspBot"
                />
              </Field>
            </div>
            <Aviso>
              El bot no puede escribir primero: es una regla de Telegram. El abonado tiene que
              mandarle <code>/start</code>, y recién ahí queda su chat guardado en su ficha.
            </Aviso>
          </div>
        </Card>

        <Card title="WhatsApp" icon={MessageCircle}>
          <div className="space-y-4">
            <Estado canal={canales?.whatsapp} origen={cfg?.whatsapp.origen} />

            {/* ── Las cinco vías ──

                Dos gratuitas y dos pagas, más la manual. La diferencia que
                importa no es el precio: es que la manual NO envía sola, y con
                ella elegida las alertas de madrugada no salen. Por eso lo dice
                la opción y lo repite el aviso de abajo. */}
            <Field label="Por dónde sale" hint="Todas menos la manual envían solas">
              <Select value={form.whatsapp_via ?? 'manual'} onChange={set('whatsapp_via')}>
                <option value="manual">Manual — se prepara el mensaje y lo manda una persona</option>
                <option value="evolution">Evolution API — gratis, con tu propio número</option>
                <option value="baileys">Baileys — gratis, adentro del middleware</option>
                <option value="meta">API de WhatsApp Business (Meta) — oficial, pago</option>
                <option value="twilio">Twilio — oficial, pago</option>
                {/*
                  La entrega la hace un CRM que ya le habla al cliente. Va última
                  porque es la única que no manda el sistema por su cuenta: acá
                  decide QUÉ avisar y CUÁNDO, y otro lo entrega.
                */}
                <option value="crm">CRM externo — sale por el número que ya usa tu bot</option>
              </Select>
            </Field>

            {form.whatsapp_via === 'evolution' && (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="URL del servidor"
                    hint="Sin barra al final. Por ejemplo http://localhost:8080"
                  >
                    <Input
                      value={form.whatsapp_evolution_url ?? ''}
                      onChange={set('whatsapp_evolution_url')}
                      placeholder="http://localhost:8080"
                    />
                  </Field>
                  <Field label="Instancia" hint="El nombre con el que la creaste en Evolution">
                    <Input
                      value={form.whatsapp_evolution_instancia ?? ''}
                      onChange={set('whatsapp_evolution_instancia')}
                      placeholder="hlfibra"
                    />
                  </Field>
                </div>
                <Field
                  label="API key"
                  hint={
                    cfg?.whatsapp.tiene_evolution_key
                      ? 'Ya hay una guardada.'
                      : 'La AUTHENTICATION_API_KEY de tu Evolution'
                  }
                >
                  <Input
                    type="password"
                    value={form.whatsapp_evolution_key ?? ''}
                    onChange={set('whatsapp_evolution_key')}
                    placeholder={cfg?.whatsapp.tiene_evolution_key ? '••••••••' : ''}
                    autoComplete="new-password"
                  />
                </Field>
                <Aviso>
                  El QR para vincular el número se escanea desde el panel de Evolution, no desde
                  acá: la sesión de WhatsApp vive en ese servicio, que es justamente lo que hace que
                  un reinicio del middleware no la corte.
                  <br />
                  No es una API oficial. Conviene usar un número distinto al que atiende clientes:
                  si Meta lo bloquea, no se cae la atención.
                </Aviso>
              </div>
            )}

            {form.whatsapp_via === 'baileys' && (
              <Aviso tipo="alerta">
                Baileys embebido todavía <b>no está implementado</b>. Es la misma librería que usa
                Evolution API por debajo, pero corriendo dentro del middleware: hay que sostener la
                sesión, el QR y las reconexiones acá adentro, y cada reinicio del servidor la
                cortaría. Elegí <b>Evolution API</b>, que es lo mismo resuelto y también es gratis.
              </Aviso>
            )}

            {/* Solo se muestran los campos de la vía elegida. Seis campos donde
                hay que adivinar cuáles llenar es la forma más fácil de que
                queden a medias y nadie sepa por qué no sale. */}
            {form.whatsapp_via === 'meta' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Token permanente"
                  hint={cfg?.whatsapp.tiene_token ? 'Ya hay uno guardado.' : 'Del panel de Meta for Developers'}
                >
                  <Input
                    type="password"
                    value={form.whatsapp_token ?? ''}
                    onChange={set('whatsapp_token')}
                    placeholder={cfg?.whatsapp.tiene_token ? '••••••••' : ''}
                    autoComplete="new-password"
                  />
                </Field>
                <Field label="Phone Number ID" hint="El número largo, no el teléfono">
                  <Input value={form.whatsapp_phone_id ?? ''} onChange={set('whatsapp_phone_id')} />
                </Field>

                {/*
                  Lo que hace falta para RECIBIR. Sin esto no llegan los acuses de
                  entrega, no se sabe si la ventana de 24 h está abierta, y las
                  bajas que el abonado pide por chat no se aplican.
                */}
                <Field
                  label="Token de verificación del webhook"
                  hint="Inventalo: cualquier cadena larga. Va igual acá y en el panel de Meta."
                >
                  <Input
                    value={form.whatsapp_verify_token ?? ''}
                    onChange={set('whatsapp_verify_token')}
                    placeholder="una-frase-larga-y-propia"
                  />
                </Field>
                <Field
                  label="App Secret"
                  hint={
                    cfg?.whatsapp.tiene_app_secret
                      ? 'Ya hay uno guardado. Con él se verifica la firma de cada webhook.'
                      : 'De tu app en Meta → Configuración → Básica. Sin esto, las bajas por chat no se aplican.'
                  }
                >
                  <Input
                    type="password"
                    value={form.whatsapp_app_secret ?? ''}
                    onChange={set('whatsapp_app_secret')}
                    placeholder={cfg?.whatsapp.tiene_app_secret ? '••••••••' : ''}
                    autoComplete="new-password"
                  />
                </Field>

                <div className="sm:col-span-2">
                  <Aviso>
                    En Meta → WhatsApp → Configuración → Webhooks, poné la URL{' '}
                    <code className="font-mono text-[11px]">
                      {(import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(/\/$/, '')}
                      /api/webhooks/whatsapp
                    </code>{' '}
                    con ese token, y suscribite al campo <b>messages</b>. Es lo que trae los acuses
                    de entrega y abre la ventana de 24 h en la que se puede escribir texto libre.
                  </Aviso>
                </div>
              </div>
            )}

            {form.whatsapp_via === 'twilio' && (
              <div className="space-y-3">
                <Field label="Número emisor de WhatsApp" hint="El que habilitaste en Twilio, con código de país">
                  <Input
                    value={form.whatsapp_desde ?? ''}
                    onChange={set('whatsapp_desde')}
                    placeholder="+14155238886"
                  />
                </Field>
                <Aviso>Las credenciales de Twilio se cargan una sola vez, abajo en SMS.</Aviso>
              </div>
            )}

            {form.whatsapp_via === 'crm' && (
              <div className="space-y-4">
                <Aviso>
                  Los avisos salen por el <b>mismo número</b> que ya usa tu CRM para hablar con los
                  clientes. El sistema decide qué avisar y cuándo; el CRM lo entrega con sus
                  plantillas aprobadas.
                </Aviso>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Nombre del CRM" hint="Solo para que los errores digan de quién hablan.">
                    <Input
                      value={form.whatsapp_crm_nombre ?? ''}
                      onChange={set('whatsapp_crm_nombre')}
                      placeholder="Mi CRM de WhatsApp"
                    />
                  </Field>
                  <Field label="Cabecera de autenticación">
                    <Select
                      value={form.whatsapp_crm_header ?? 'X-API-Key'}
                      onChange={set('whatsapp_crm_header')}
                    >
                      <option value="X-API-Key">X-API-Key</option>
                      <option value="Authorization">Authorization (Bearer)</option>
                    </Select>
                  </Field>
                </div>

                <Field label="URL del endpoint" hint="A dónde se le entregan los avisos. Te la da el proveedor.">
                  <Input
                    value={form.whatsapp_crm_url ?? ''}
                    onChange={set('whatsapp_crm_url')}
                    placeholder="https://tu-crm/api/notificar"
                  />
                </Field>

                <Field
                  label="Llave"
                  hint={
                    cfg?.whatsapp.tiene_crm_key
                      ? 'Ya hay una guardada. Se cifra y no se vuelve a ver.'
                      : 'La que generó el CRM para tu ISP.'
                  }
                >
                  <Input
                    type="password"
                    value={form.whatsapp_crm_key ?? ''}
                    onChange={set('whatsapp_crm_key')}
                    placeholder={cfg?.whatsapp.tiene_crm_key ? '••••••••' : ''}
                    autoComplete="new-password"
                  />
                </Field>

                <Aviso tipo="alerta">
                  Falta un paso más: en <b>Ajustes → Plantillas de WhatsApp</b>, cargá cómo se llama
                  cada aviso del lado del CRM. Un aviso sin ese nombre no sale por acá — se cae al
                  SMS o al correo.
                </Aviso>
              </div>
            )}

            {form.whatsapp_via === 'manual' && (
              <Aviso>
                Sin proveedor, cada mensaje queda preparado con su enlace y lo manda una persona
                desde su WhatsApp. Para un ISP chico suele alcanzar, y no cuesta nada.
              </Aviso>
            )}
          </div>
        </Card>

        <Card title="SMS" subtitle="Por Twilio" icon={Smartphone}>
          <div className="space-y-4">
            <Estado canal={canales?.sms} origen={cfg?.sms.origen} />
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Account SID">
                <Input value={form.twilio_sid ?? ''} onChange={set('twilio_sid')} placeholder="AC…" />
              </Field>
              <Field
                label="Auth Token"
                hint={cfg?.sms.tiene_token ? 'Ya hay uno guardado.' : undefined}
              >
                <Input
                  type="password"
                  value={form.twilio_token ?? ''}
                  onChange={set('twilio_token')}
                  placeholder={cfg?.sms.tiene_token ? '••••••••' : ''}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Número emisor">
                <Input value={form.twilio_desde ?? ''} onChange={set('twilio_desde')} placeholder="+1…" />
              </Field>
            </div>
          </div>
        </Card>

        <Card
          title="Avisos de red"
          subtitle="A quién avisarle cuando se cae un nodo que no tiene técnico asignado"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Canal">
              <Select value={form.nms_canal ?? 'telegram'} onChange={set('nms_canal')}>
                <option value="telegram">Telegram</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="email">Correo</option>
                <option value="sms">SMS</option>
              </Select>
            </Field>
            <Field
              label="Destino"
              hint="Correo, celular o chat de Telegram, según el canal elegido"
            >
              <Input value={form.nms_destino ?? ''} onChange={set('nms_destino')} />
            </Field>
          </div>
        </Card>

        {guardado && <Aviso>Configuración guardada.</Aviso>}

        <div className="flex justify-end">
          <Button type="submit" variante="primario" cargando={guardando}>
            Guardar
          </Button>
        </div>
      </form>

      <Probador canales={canales} />
    </div>
  )
}

/**
 * El estado de un canal, con de dónde salieron sus credenciales.
 *
 * "archivo" significa que todavía están en el .env del servidor. Vale la pena
 * decirlo: es lo que explica por qué un canal funciona aunque la pantalla se
 * vea vacía, y lo que hay que migrar antes de entregarle el sistema a alguien.
 */
function Estado({ canal, origen }) {
  if (!canal) return null

  const color = canal.listo
    ? 'bg-emerald-500/15 text-emerald-300'
    : canal.manual
      ? 'bg-sky-500/15 text-sky-300'
      : 'bg-amber-500/15 text-amber-300'

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${color}`}>
        {canal.listo ? 'Listo' : canal.manual ? 'Manual' : 'Falta configurar'}
      </span>
      <span className="text-xs text-slate-500">{canal.nota}</span>
      {origen === 'archivo' && (
        <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">
          viene del .env del servidor
        </span>
      )}
    </div>
  )
}

/**
 * La prueba de envío.
 *
 * Manda un mensaje de verdad. Validar las credenciales no alcanza: que el
 * proveedor acepte el token es una cosa y que el mensaje llegue es otra —
 * número no habilitado, plantilla sin aprobar, el abonado que nunca le escribió
 * al bot—, y esa segunda solo se ve enviando.
 */
function Probador({ canales }) {
  const [canal, setCanal] = useState('telegram')
  const [destino, setDestino] = useState('')
  const [resultado, setResultado] = useState(null)
  const [error, setError] = useState(null)
  const [enviando, setEnviando] = useState(false)

  async function probar() {
    setEnviando(true)
    setError(null)
    setResultado(null)
    try {
      setResultado(await api.comunicaciones.probar(canal, destino.trim()))
    } catch (err) {
      setError(err)
    } finally {
      setEnviando(false)
    }
  }

  const pista = {
    telegram: 'El chat_id, no el número. Escribile /start al bot para obtenerlo.',
    whatsapp: 'Celular con código de país, ej. 0991234567',
    email: 'Una casilla a la que tengas acceso',
    sms: 'Celular con código de país',
  }[canal]

  return (
    <Card title="Probar un canal" icon={Send}>
      <div className="space-y-3">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        <div className="flex flex-wrap items-end gap-3">
          <Field label="Canal" className="w-44">
            <Select value={canal} onChange={(e) => setCanal(e.target.value)}>
              <option value="telegram">Telegram</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="email">Correo</option>
              <option value="sms">SMS</option>
            </Select>
          </Field>
          <Field label="Enviar a" hint={pista} className="min-w-56 flex-1">
            <Input value={destino} onChange={(e) => setDestino(e.target.value)} />
          </Field>
          <Button
            type="button"
            variante="secundario"
            icon={Send}
            cargando={enviando}
            disabled={!destino.trim() || canales?.[canal]?.listo === false && !canales?.[canal]?.manual}
            onClick={probar}
          >
            Enviar prueba
          </Button>
        </div>

        {resultado?.manual && (
          <Aviso>
            Sin proveedor, el mensaje no se envió: quedó preparado.{' '}
            <a
              href={resultado.enlace}
              target="_blank"
              rel="noreferrer"
              className="text-sky-400 hover:text-sky-300"
            >
              Abrir en WhatsApp
            </a>
          </Aviso>
        )}

        {resultado && !resultado.manual && (
          <Aviso>
            {resultado.entregado
              ? 'Entregado. El proveedor confirmó que llegó al dispositivo.'
              : 'Enviado. El proveedor lo aceptó — revisá que haya llegado de verdad.'}
          </Aviso>
        )}
      </div>
    </Card>
  )
}
