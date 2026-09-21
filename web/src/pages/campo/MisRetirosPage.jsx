import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  MapPin,
  MessageCircle,
  FileText,
  PackageX,
  Phone,
  Send,
  XCircle,
} from 'lucide-react'
import { carteraApi, RESULTADOS_INTENTO } from '../../lib/cartera'
import { PLANTILLAS } from '../../lib/mensajesRetiro'
import FirmaDigital from '../../components/soporte/FirmaDigital'
import HistorialVisitas from '../../components/cartera/HistorialVisitas'
import { abrirPdf } from '../../lib/pdf'
import { enlaceWhatsApp } from '../../lib/telefono'
import { useMarca } from '../../lib/useMarca'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, Card, Cargando, ErrorBanner, Input, Modal, Select, Textarea } from '../../components/ui'

/**
 * Los equipos que tengo que ir a buscar.
 *
 * ── Por qué esta pantalla existe ──
 *
 * Porque durante un tiempo no existió, y eso fue un error con consecuencias: la
 * orden de retiro se asignaba a una persona, la base la dejaba verla y las
 * funciones la dejaban trabajarla, pero no había ninguna pantalla donde
 * apareciera. Se le daba trabajo a alguien que no tenía forma de enterarse.
 *
 * ── Para quién ──
 *
 * Para quien tiene la orden asignada, sea técnico o no. La lista no filtra por
 * persona: la política de RLS ya devuelve solo las propias, y volver a filtrar
 * acá sería poner la seguridad en el lugar donde no se puede garantizar.
 *
 * ── Qué se puede hacer ──
 *
 * Las tres cosas que pasan en la puerta de una casa: anotar la cita que pide el
 * abonado, registrar que se fue y qué contestó, y cerrar cuando se resuelve.
 */

const fechaHora = (f) => {
  if (!f) return null
  const d = new Date(f)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('es-EC', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const dd = (n) => String(n).padStart(2, '0')

/** El día en el formato que quiere `<input type="date">`. */
const soloDia = (d) => `${d.getFullYear()}-${dd(d.getMonth() + 1)}-${dd(d.getDate())}`

/** Y la hora para `<input type="time">`. */
const soloHora = (d) => `${dd(d.getHours())}:${dd(d.getMinutes())}`

/**
 * Abre el selector del navegador al tocar el campo.
 *
 * Sin esto hay que acertarle al iconito de la derecha, que en un teléfono con
 * una mano ocupada es una pelea. `showPicker` no existe en todos los
 * navegadores, y donde no está el campo sigue funcionando como siempre.
 */
const abrirSelector = (e) => {
  try {
    e.currentTarget.showPicker?.()
  } catch {
    // Firefox lo rechaza si el foco no vino de un gesto: no pasa nada.
  }
}

export default function MisRetirosPage() {
  const [ordenes, setOrdenes] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [agendando, setAgendando] = useState(null)
  const [visitando, setVisitando] = useState(null)
  const [cerrando, setCerrando] = useState(null)

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      setOrdenes(await carteraApi.misRetiros())
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-3">
      <div className="flex items-center gap-2">
        <Link to="/campo" className="rounded-lg p-2 text-slate-400 hover:bg-slate-800">
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h1 className="flex items-center gap-2 text-base font-semibold text-slate-100">
            <PackageX size={18} className="text-amber-400" />
            Equipos por retirar
          </h1>
          <p className="text-xs text-slate-500">
            {ordenes.length === 0 ? 'Nada asignado' : `${ordenes.length} pendientes`}
          </p>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {cargando ? (
        <Cargando />
      ) : ordenes.length === 0 ? (
        <Aviso>No tenés equipos por retirar. Cuando te asignen uno, aparece acá.</Aviso>
      ) : (
        ordenes.map((o) => (
          <Orden
            key={o.id}
            o={o}
            onAgendar={() => setAgendando(o)}
            onVisitar={() => setVisitando(o)}
            onCerrar={() => setCerrando(o)}
            onError={setError}
          />
        ))
      )}

      <Agendar orden={agendando} onCerrar={() => setAgendando(null)} onListo={recargar} onError={setError} />
      <Visita orden={visitando} onCerrar={() => setVisitando(null)} onListo={recargar} onError={setError} />
      <Cierre orden={cerrando} onCerrar={() => setCerrando(null)} onListo={recargar} onError={setError} />
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * Los tres botones para hablar con el abonado.
 *
 * ── Por qué WhatsApp abre la app y Telegram no ──
 *
 * Porque son dos caminos distintos y conviene que se note. WhatsApp arma un
 * enlace `wa.me` con el texto listo: se abre la conversación, el técnico lo lee
 * antes de mandarlo y puede cambiarlo. No hace falta configurar nada.
 *
 * Telegram sale por el bot del sistema, así que el mensaje se manda de verdad
 * al tocar el botón —queda en el historial del abonado— y solo funciona si él
 * tiene el chat vinculado. Si no lo tiene, el botón no aparece: mostrarlo
 * apagado invita a preguntar por qué no anda.
 *
 * ── Y por qué el texto no se manda solo por WhatsApp ──
 *
 * Porque el mensaje se escribe en la puerta de una casa, y el que está ahí
 * sabe cosas que el sistema no: que el perro ladra, que el hijo atiende, que
 * ayer quedó en algo. Dejarlo revisar el texto antes de enviarlo no es una
 * limitación técnica, es lo correcto.
 */
function Contacto({ o, onError }) {
  const marca = useMarca()
  const [plantilla, setPlantilla] = useState('coordinar')
  const [enviando, setEnviando] = useState(false)
  const [enviado, setEnviado] = useState(false)

  const datos = { cliente: o.cliente, empresa: marca?.nombre_sistema, agendadoPara: o.agendado_para }
  const texto = (PLANTILLAS.find((p) => p.clave === plantilla) ?? PLANTILLAS[0]).arma(datos)
  const wa = enlaceWhatsApp(o.telefono, texto)

  async function porTelegram() {
    setEnviando(true)
    try {
      await api.comunicaciones.enviar({ client_id: o.cliente_id, canal: 'telegram', cuerpo: texto })
      setEnviado(true)
      setTimeout(() => setEnviado(false), 3000)
    } catch (err) {
      onError(err)
    } finally {
      setEnviando(false)
    }
  }

  return (
    <div className="space-y-1.5 rounded-lg border border-slate-800 bg-slate-950/40 p-2">
      <select
        value={plantilla}
        onChange={(e) => setPlantilla(e.target.value)}
        className="w-full rounded border border-slate-700 bg-slate-950/60 px-2 py-1 text-[11px] text-slate-200"
      >
        {PLANTILLAS.map((p) => (
          <option key={p.clave} value={p.clave}>
            {p.label}
          </option>
        ))}
      </select>

      <p className="text-[11px] leading-snug text-slate-500">{texto}</p>

      <div className="flex flex-wrap gap-1.5">
        {o.telefono ? (
          <a
            href={`tel:${o.telefono}`}
            className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-2.5 py-1.5 text-[11px] text-slate-200 hover:bg-slate-700"
          >
            <Phone size={13} />
            Llamar
          </a>
        ) : (
          <span className="rounded-lg px-2.5 py-1.5 text-[11px] text-slate-600">Sin teléfono</span>
        )}

        {wa && (
          <a
            href={wa}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600/20 px-2.5 py-1.5 text-[11px] text-emerald-300 hover:bg-emerald-600/30"
          >
            <MessageCircle size={13} />
            WhatsApp
          </a>
        )}

        {o.telegram_chat_id && (
          <button
            type="button"
            onClick={porTelegram}
            disabled={enviando}
            className="flex items-center gap-1.5 rounded-lg bg-sky-600/20 px-2.5 py-1.5 text-[11px] text-sky-300 hover:bg-sky-600/30 disabled:opacity-50"
          >
            <Send size={13} />
            {enviado ? 'Enviado' : enviando ? 'Enviando…' : 'Telegram'}
          </button>
        )}
      </div>
    </div>
  )
}

/** Abre el mapa en la dirección o en las coordenadas, si las hay. */
const enlaceMapa = (o) =>
  o.latitud && o.longitud
    ? `https://www.google.com/maps/search/?api=1&query=${o.latitud},${o.longitud}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.direccion ?? '')}`

function Orden({ o, onAgendar, onVisitar, onCerrar, onError }) {
  const cita = fechaHora(o.agendado_para)
  const vencida = o.agendado_para && new Date(o.agendado_para) < new Date()

  return (
    <Card>
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium text-slate-100">{o.cliente}</div>
            <div className="text-xs text-slate-500">
              {[o.modelo, o.serie].filter(Boolean).join(' · ') || 'Equipo sin ficha'}
            </div>
          </div>
          <Badge color={o.estado === 'asignado' ? 'azul' : 'ambar'}>{o.estado}</Badge>
        </div>

        {/* La cita, arriba de todo cuando existe: es lo que decide a qué hora
            sale la camioneta. En rojo si ya pasó. */}
        {cita && (
          <div
            className={`rounded-lg border px-3 py-2 text-xs ${
              vencida
                ? 'border-red-500/30 bg-red-500/10 text-red-300'
                : 'border-sky-500/30 bg-sky-500/10 text-sky-300'
            }`}
          >
            <div className="flex items-center gap-1.5 font-medium">
              <CalendarClock size={13} />
              {vencida ? 'Se pasó la hora:' : 'Quedó para'} {cita}
            </div>
            {o.agenda_nota && <div className="mt-0.5 text-[11px] opacity-80">{o.agenda_nota}</div>}
          </div>
        )}

        <div className="grid gap-1 text-xs text-slate-400">
          {o.direccion && (
            <a
              href={enlaceMapa(o)}
              target="_blank"
              rel="noreferrer"
              className="flex items-start gap-1.5 hover:text-slate-200"
            >
              <MapPin size={13} className="mt-0.5 shrink-0 text-slate-600" />
              {o.direccion}
              {o.zona && <span className="text-slate-600">· {o.zona}</span>}
            </a>
          )}
          <div className="text-slate-500">
            {o.meses_sin_pago} meses sin pagar · abierta hace {o.dias_abierta} días
          </div>
        </div>

        {/* Lo que pasó las veces anteriores. Va antes de los botones a
            propósito: el técnico que vuelve a esa casa tiene que saber que la
            vez pasada le dijeron que el señor se mudó, ANTES de tocar la
            puerta. */}
        <HistorialVisitas retiroId={o.id} intentos={o.intentos ?? 0} />

        <Contacto o={o} onError={onError} />

        <div className="flex flex-wrap gap-1.5">
          <Button icon={CalendarClock} onClick={onAgendar} className="py-1.5 text-xs">
            {cita ? 'Cambiar la cita' : 'Agendar'}
          </Button>
          <Button icon={XCircle} onClick={onVisitar} className="py-1.5 text-xs">
            Registrar visita
          </Button>
          <Button variante="primario" icon={CheckCircle2} onClick={onCerrar} className="py-1.5 text-xs">
            Cerrar
          </Button>
          {/* El acta se puede sacar antes de cerrar: sirve para llevarla
              impresa y que el abonado firme en papel si no quiere hacerlo en
              la pantalla. */}
          <Button
            icon={FileText}
            onClick={() => abrirPdf(() => api.actas.retiro(o.id))}
            className="py-1.5 text-xs"
          >
            Acta
          </Button>
        </div>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------

/** Los días que se piden de verdad. Nadie agenda un retiro para dentro de un mes. */
const DIAS_RAPIDOS = [
  { label: 'Hoy', suma: 0 },
  { label: 'Mañana', suma: 1 },
  { label: 'Pasado', suma: 2 },
]

/** Y las horas en que se sale a la calle. */
const HORAS_RAPIDAS = ['09:00', '11:00', '15:00', '18:00']

function Agendar({ orden, onCerrar, onListo, onError }) {
  const [dia, setDia] = useState('')
  const [hora, setHora] = useState('')
  const [nota, setNota] = useState('')
  const [guardando, setGuardando] = useState(false)

  useEffect(() => {
    if (!orden) return
    const d = orden.agendado_para ? new Date(orden.agendado_para) : null
    const valida = d && !Number.isNaN(d.getTime())
    setDia(valida ? soloDia(d) : soloDia(new Date()))
    setHora(valida ? soloHora(d) : '')
    setNota(orden.agenda_nota ?? '')
  }, [orden])

  const enDias = (n) => {
    const d = new Date()
    d.setDate(d.getDate() + n)
    setDia(soloDia(d))
  }

  async function guardar() {
    setGuardando(true)
    try {
      // Se arma con el constructor y no con `new Date('...')` sobre el texto:
      // así la hora es la LOCAL de quien la escribe, que es la que le dijo el
      // abonado. Interpretarla como UTC la correría cinco horas.
      const [a, m, d] = dia.split('-').map(Number)
      const [h, min] = hora.split(':').map(Number)
      const cuando = new Date(a, m - 1, d, h, min)

      await carteraApi.agendar(orden.id, { cuando: cuando.toISOString(), nota })
      onCerrar()
      await onListo()
    } catch (err) {
      onError(err)
    } finally {
      setGuardando(false)
    }
  }

  const listo = Boolean(dia && hora)

  return (
    <Modal abierto={Boolean(orden)} titulo="Cuándo pidió que lo pasen a buscar" onCerrar={onCerrar}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs text-slate-400">
            Día
            <Input
              type="date"
              value={dia}
              onChange={(e) => setDia(e.target.value)}
              onFocus={abrirSelector}
              onClick={abrirSelector}
              className="mt-1"
            />
            <div className="mt-1.5 flex gap-1">
              {DIAS_RAPIDOS.map((d) => (
                <Chip key={d.label} onClick={() => enDias(d.suma)}>
                  {d.label}
                </Chip>
              ))}
            </div>
          </label>

          <label className="block text-xs text-slate-400">
            Hora
            <Input
              type="time"
              value={hora}
              onChange={(e) => setHora(e.target.value)}
              onFocus={abrirSelector}
              onClick={abrirSelector}
              className="mt-1"
            />
            <div className="mt-1.5 flex flex-wrap gap-1">
              {HORAS_RAPIDAS.map((h) => (
                <Chip key={h} activo={hora === h} onClick={() => setHora(h)}>
                  {h}
                </Chip>
              ))}
            </div>
          </label>
        </div>

        <label className="block text-xs text-slate-400">
          Lo que dijo
          <Textarea
            rows={2}
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            placeholder="Después de las 6 que llega del trabajo…"
            className="mt-1"
          />
        </label>

        <Aviso>
          Con la hora puesta, el sistema te la recuerda ese día. Y si se pasa sin cerrarse, te avisa
          todos los días hasta que la resuelvas.
        </Aviso>

        <div className="flex items-center justify-end gap-2">
          {!listo && (
            <span className="mr-auto text-[11px] text-amber-400">
              Falta {dia ? 'la hora' : 'el día'}.
            </span>
          )}
          <Button variante="secundario" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button variante="primario" onClick={guardar} cargando={guardando} disabled={!listo}>
            Guardar la cita
          </Button>
        </div>
      </div>
    </Modal>
  )
}

const Chip = ({ activo, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    className={`rounded-md px-2 py-0.5 text-[11px] transition ${
      activo
        ? 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30'
        : 'bg-slate-800 text-slate-400 hover:text-slate-200'
    }`}
  >
    {children}
  </button>
)

// ---------------------------------------------------------------------------

function Visita({ orden, onCerrar, onListo, onError }) {
  const [resultado, setResultado] = useState('no_estaba')
  const [observacion, setObservacion] = useState('')
  const [guardando, setGuardando] = useState(false)

  async function guardar() {
    setGuardando(true)
    try {
      await carteraApi.registrarIntento(orden.id, { resultado, observacion })
      setObservacion('')
      onCerrar()
      await onListo()
    } catch (err) {
      onError(err)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <Modal abierto={Boolean(orden)} titulo="Qué pasó en la visita" onCerrar={onCerrar}>
      <div className="space-y-3">
        <label className="block text-xs text-slate-400">
          Resultado
          <Select value={resultado} onChange={(e) => setResultado(e.target.value)} className="mt-1">
            {RESULTADOS_INTENTO.map((r) => (
              <option key={r.clave} value={r.clave}>
                {r.label}
              </option>
            ))}
          </Select>
        </label>

        <label className="block text-xs text-slate-400">
          Qué dijo el abonado
          <Textarea
            rows={3}
            value={observacion}
            onChange={(e) => setObservacion(e.target.value)}
            placeholder="Dijo que lo devuelve el sábado…"
            className="mt-1"
          />
        </label>

        <p className="text-[11px] text-slate-500">
          Anotar la visita no cierra la orden, ni siquiera si el equipo se recuperó: cerrar mueve el
          inventario y necesita saber a qué almacén entra. Son dos pasos a propósito — si el segundo
          falla, este ya quedó registrado.
        </p>

        <div className="flex justify-end gap-2">
          <Button variante="secundario" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button variante="primario" onClick={guardar} cargando={guardando}>
            Guardar la visita
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------

/**
 * Cerrar la orden: recuperado con firma, o no recuperado con categoría.
 *
 * ── Por qué la firma es obligatoria de un lado ──
 *
 * Porque es el único momento del circuito donde el equipo cambia de manos sin
 * testigos. Después vendrá el acta con la oficina, que también se firma; sin
 * esta, el tramo entre la casa del abonado y la camioneta no tiene respaldo, y
 * el día que alguien diga "yo se la entregué" no hay contra qué mirar.
 *
 * ── Y por qué la categoría del otro ──
 *
 * Porque "no se pudo" no se puede analizar. Separar al que se mudó del que se
 * niega y del que nadie fue a buscar es lo que después permite decidir si el
 * problema es el abonado, la zona o el proceso.
 */
function Cierre({ orden, onCerrar, onListo, onError }) {
  const [recuperado, setRecuperado] = useState(true)
  const [categorias, setCategorias] = useState([])
  const [categoria, setCategoria] = useState('')
  const [observacion, setObservacion] = useState('')
  const [serie, setSerie] = useState('')
  const [firma, setFirma] = useState(null)
  const [firmante, setFirmante] = useState('')
  const [guardando, setGuardando] = useState(false)

  useEffect(() => {
    if (!orden) return
    setFirma(null)
    setFirmante('')
    setObservacion('')
    setSerie('')
    carteraApi
      .categorias()
      .then((c) => {
        setCategorias(c)
        setCategoria((v) => v || c[0]?.clave || '')
      })
      .catch(onError)
  }, [orden, onError])

  async function guardar() {
    setGuardando(true)
    try {
      await carteraApi.cerrar(orden.id, {
        recuperado,
        motivo: recuperado ? null : categoria,
        observacion,
        serie,
        firma: recuperado ? firma : null,
        firmante: recuperado ? firmante : null,
      })
      onCerrar()
      await onListo()
    } catch (err) {
      onError(err)
    } finally {
      setGuardando(false)
    }
  }

  const elegida = categorias.find((c) => c.clave === categoria)
  const listo = recuperado ? Boolean(firma) : Boolean(categoria)

  return (
    <Modal abierto={Boolean(orden)} titulo="Cerrar la orden" onCerrar={onCerrar} ancho="max-w-lg">
      <div className="space-y-3">
        <div className="flex gap-1.5">
          {[
            { v: true, label: 'Recuperé el equipo' },
            { v: false, label: 'No se pudo' },
          ].map((op) => (
            <button
              key={String(op.v)}
              type="button"
              onClick={() => setRecuperado(op.v)}
              className={`flex-1 rounded-lg px-3 py-2 text-xs transition ${
                recuperado === op.v
                  ? 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30'
                  : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              {op.label}
            </button>
          ))}
        </div>

        {recuperado ? (
          <>
            <label className="block text-xs text-slate-400">
              Serie del equipo que traés
              <Input
                value={serie}
                onChange={(e) => setSerie(e.target.value)}
                placeholder={orden?.serie ?? 'Si es distinta a la de la orden'}
                className="mt-1"
              />
            </label>

            <label className="block text-xs text-slate-400">
              Quién entrega
              <Input
                value={firmante}
                onChange={(e) => setFirmante(e.target.value)}
                placeholder="Nombre de quien te lo dio"
                className="mt-1"
              />
              <span className="mt-1 block text-[11px] text-slate-500">
                Casi nunca es el titular: firma el hijo, la esposa, el inquilino. Anotá quién fue.
              </span>
            </label>

            <div>
              <p className="mb-1 text-xs text-slate-400">Firma de quien entrega el equipo</p>
              <FirmaDigital valor={firma} onCambio={setFirma} alto={150} />
            </div>
          </>
        ) : (
          <>
            <label className="block text-xs text-slate-400">
              Por qué no se pudo
              <Select
                value={categoria}
                onChange={(e) => setCategoria(e.target.value)}
                className="mt-1"
              >
                {categorias.map((c) => (
                  <option key={c.clave} value={c.clave}>
                    {c.nombre}
                  </option>
                ))}
              </Select>
            </label>

            {elegida?.descripcion && (
              <p className="text-[11px] leading-snug text-slate-500">{elegida.descripcion}</p>
            )}

            {elegida?.reclamable && (
              <Aviso>
                Este caso queda marcado como <b>reclamable</b>: el abonado está localizable y el
                equipo se le puede seguir pidiendo.
              </Aviso>
            )}
          </>
        )}

        <label className="block text-xs text-slate-400">
          Observación
          <Textarea
            rows={2}
            value={observacion}
            onChange={(e) => setObservacion(e.target.value)}
            placeholder={recuperado ? 'Estado del equipo…' : 'Qué encontraste en el domicilio…'}
            className="mt-1"
          />
        </label>

        <p className="text-[11px] text-slate-500">
          {recuperado
            ? 'El equipo entra a TU almacén, no a la bodega: sigue siendo tu responsabilidad hasta que lo entregues en la oficina y te firmen el acta.'
            : elegida?.es_perdida === false
              ? 'Esta categoría no cuenta como pérdida de recuperación.'
              : 'El equipo queda en baja: ni en un almacén ni instalado. Es la forma honesta de decir que se sabe dónde está y no se tiene.'}
        </p>

        <div className="flex items-center justify-end gap-2">
          {!listo && (
            <span className="mr-auto text-[11px] text-amber-400">
              {recuperado ? 'Falta la firma.' : 'Elegí una categoría.'}
            </span>
          )}
          <Button variante="secundario" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button variante="primario" onClick={guardar} cargando={guardando} disabled={!listo}>
            Cerrar la orden
          </Button>
        </div>
      </div>
    </Modal>
  )
}
